// Controlador de la pestaña DJ: biblioteca de canciones, programas (boda, desfile…), mezcla y control MIDI.
//
// Une el motor de audio (dj-engine.js), el guardado (dj-store.js) y los controles (dj-midi.js).
// No toca el DOM: la pantalla (ui/dj-view.js) solo lee `dj.state` y llama a estas funciones.

import { createEmitter, uid, naturalCompare, clamp, FADER_DEFAULT, faderToGain } from './util.js';
import { DEFAULT_FADE, START_FADE, PAUSE_FADE, PANIC_FADE, fadeSeconds, itemEnd, remainingSeconds, resolveNextItem, resolvePrevItem, moveItem, softTakeover, newTakeover, indexOfItem } from './dj-math.js';
import { createMemoryDjStore } from './dj-store.js';
import { ACTIONS, CONTINUOUS, DEFAULT_BINDINGS, MAX_SLOTS, actionName, assignBinding, clearSlots, createMidiPorts, createRouter, midiPermission, midiSupported, removeBinding, replaceMidiBinding, slotAction, slotNumber } from './dj-midi.js';
import { MANIFEST_NAME, ZIP_MAX_BYTES, buildManifest, buildZip, entryNameFor, estimatePackageBytes, guessAudioType, packageFileName, readPackage, readmeText, relinkKey, serializeManifest } from './dj-package.js';

const AUDIO_EXTENSIONS = /\.(mp3|wav|wave|m4a|aac|flac|ogg|oga|opus|weba|webm|mp4|aif|aiff|caf)$/i;
const MAX_PREFETCH = 40;

export function isAudioFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('audio/')) return true;
  return AUDIO_EXTENSIONS.test(file.name || '');
}

export function cleanName(fileName) {
  return (
    String(fileName || '')
      .replace(/\.[A-Za-z0-9]{2,5}$/, '')
      .replace(/_+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Canción'
  );
}

export function createDj({ store, engine, host = {}, probe = async () => ({ duration: 0 }), ports: portsFactory = createMidiPorts, now = () => Date.now() } = {}) {
  const bus = createEmitter();
  const toast = (message, kind) => {
    if (host.toast) host.toast(message, kind);
  };

  const state = {
    ready: false,
    storage: store.kind,
    tracks: [],
    programs: [],
    programId: null,
    settings: { fade: DEFAULT_FADE, autoAdvance: false, volume: FADER_DEFAULT, midiEnabled: false, bindings: null, layout: 'list', tab: 'program' },
    nowId: null,
    cueId: null,
    transport: 'idle', // idle | playing | paused
    busy: new Set(),
    importing: null, // { done, total, name, label? } mientras se añaden canciones o se trae un paquete
    exporting: null, // { done, total, name } mientras se prepara un paquete para llevar a otra PC
    learning: null,
    audioBlocked: false,
    active: false,
    midi: { status: 'off', inputs: [], last: '', pickup: null, supported: midiSupported() },
    structure: 0, // sube cuando cambian las listas (la pantalla las vuelve a dibujar)
  };

  let seq = 0; // la última orden de "poner esta canción" gana
  let runId = 0; // cambia cada vez que arranca una canción (para el avance automático)
  let autoRun = -1;
  let pending = null;
  let notifyQueued = false;
  let ticker = 0;
  let prefetchRun = 0;
  let preloadRun = 0;
  let wakeLock = null;
  let destroyed = false;
  const takeover = newTakeover();
  const timers = new Map();
  const blobs = new Map();
  let blobBytes = 0;
  const memoryGB = host.memoryGB || (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4;
  const blobBudget = clamp(memoryGB * 48, 64, 512) * 1024 * 1024;

  // ---------------------------------------------------------- avisos a la pantalla

  const emit = (structure = false) => {
    if (structure) state.structure++;
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      if (!destroyed) bus.emit('change');
    });
  };

  const later = (name, fn, wait = 250) => {
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => {
      timers.delete(name);
      fn();
    }, wait));
  };

  const fail = (error) => {
    if (error && error.name === 'AbortError') return;
    toast((error && error.message) || 'Algo salió mal', 'error');
  };

  // ---------------------------------------------------------- consultas

  const trackOf = (id) => state.tracks.find((track) => track.id === id) || null;
  const program = () => state.programs.find((item) => item.id === state.programId) || null;
  const itemsRaw = () => (program() ? program().items : []);
  const nowItem = () => itemsRaw().find((item) => item.id === state.nowId) || null;
  const cueItem = () => itemsRaw().find((item) => item.id === state.cueId) || null;
  const nextItem = () => resolveNextItem(itemsRaw(), state.nowId, state.cueId);
  // Un participante que llegó en un paquete sin audio ("want") espera un archivo con ese nombre.
  const itemTitle = (item) => item.label || (trackOf(item.trackId) ? trackOf(item.trackId).name : (item.want && item.want.name) || 'Canción borrada');
  const isPlayable = (item) => Boolean(item && trackOf(item.trackId));

  function viewItems() {
    return itemsRaw().map((item, index) => {
      const track = trackOf(item.trackId);
      const want = !track && item.want ? item.want : null;
      return {
        ...item,
        index,
        number: index + 1,
        track,
        title: itemTitle(item),
        trackName: track ? track.name : want && want.file ? `Falta «${want.file}»` : 'Falta el archivo',
        trackDuration: track ? track.duration : want ? want.duration || 0 : 0,
        missing: !track,
        slot: index < MAX_SLOTS ? slotAction(index + 1) : null,
      };
    });
  }

  // La primera canción con archivo desde `item` (incluida) en el sentido pedido. Así un participante sin archivo no
  // detiene el programa: "Siguiente" y el avance automático lo saltan.
  function playableFrom(item, step = 1) {
    const items = itemsRaw();
    for (let index = item ? items.indexOf(item) : -1; index >= 0 && index < items.length; index += step) {
      if (isPlayable(items[index])) return items[index];
    }
    return null;
  }

  function playableNext() {
    const target = nextItem();
    return target ? playableFrom(target, 1) : null;
  }

  // `from` era el destino pedido y `to` el que de verdad se toca: los participantes que quedan en medio no tienen archivo.
  function toastSkipped(from, to) {
    const items = itemsRaw();
    const a = items.indexOf(from);
    const b = items.indexOf(to);
    if (a < 0 || b < 0 || a === b) return;
    const skipped = items.slice(Math.min(a, b), Math.max(a, b) + 1).filter((entry) => entry !== to && !isPlayable(entry));
    if (!skipped.length) return;
    toast(skipped.length === 1 ? `Se saltó «${itemTitle(skipped[0])}»: falta su archivo.` : `Se saltaron ${skipped.length} participantes sin archivo.`);
  }

  function itemStatus(item) {
    if (!item) return 'none';
    if (!trackOf(item.trackId)) return 'missing';
    if (engine.isReady(item.id)) return 'ready';
    if (state.busy.has(item.id) || engine.isLoading(item.id)) return 'loading';
    return 'cold';
  }

  // ---------------------------------------------------------- guardado

  async function saveSettings() {
    try {
      await store.setMeta('settings', state.settings);
    } catch (error) {
      fail(error);
    }
  }
  const saveSettingsSoon = () => later('settings', saveSettings);

  async function saveProgram(item) {
    try {
      await store.put('programs', item);
    } catch (error) {
      fail(error);
    }
  }
  function touchProgram(item = program(), structure = true) {
    if (!item) return;
    item.updated = now();
    emit(structure);
    later(`program:${item.id}`, () => saveProgram(item));
  }

  async function flush() {
    for (const [name, timer] of Array.from(timers)) {
      clearTimeout(timer);
      timers.delete(name);
    }
    try {
      await store.setMeta('settings', state.settings);
      await store.setMeta('programId', state.programId);
      for (const item of state.programs) await store.put('programs', item);
    } catch {
      // sin espacio o sin permiso: ya se avisó al guardar
    }
  }

  // ---------------------------------------------------------- audio de las canciones

  function remember(id, blob) {
    if (blobs.has(id)) {
      blobBytes -= blobs.get(id).size;
      blobs.delete(id);
    }
    blobs.set(id, blob);
    blobBytes += blob.size;
    while (blobBytes > blobBudget && blobs.size > 1) {
      const [oldest, value] = blobs.entries().next().value;
      blobs.delete(oldest);
      blobBytes -= value.size;
    }
  }

  async function blobFor(trackId) {
    const hit = blobs.get(trackId);
    if (hit) {
      remember(trackId, hit);
      return hit;
    }
    const row = await store.get('blobs', trackId);
    if (!row || !row.blob) return null;
    remember(trackId, row.blob);
    return row.blob;
  }

  async function prepareItem(item, { force = false } = {}) {
    const track = trackOf(item.trackId);
    if (!track) {
      throw new Error(item.want ? `“${itemTitle(item)}”: falta el archivo «${item.want.file}». Añádelo con «Añadir canciones» y se vincula solo.` : `“${itemTitle(item)}”: el archivo ya no está en la biblioteca`);
    }
    const blob = await blobFor(track.id);
    if (!blob) throw new Error(`No se encontró el archivo de “${track.name}”. Vuelve a añadirlo.`);
    const deck = await engine.load(item.id, blob, { sourceId: track.id, start: item.start, gainDb: item.gainDb, force });
    if (!track.duration && deck && deck.duration) {
      track.duration = deck.duration;
      store.put('tracks', track).catch(() => {});
      emit(true);
    }
    return deck;
  }

  // Deja preparada (cargada y colocada en su segundo de inicio) la que sigue y la siguiente de esa.
  async function preload() {
    const run = ++preloadRun;
    const items = itemsRaw();
    const first = playableNext();
    const second = first ? playableFrom(items[items.indexOf(first) + 1], 1) : null;
    const list = [first, second].filter((item) => item && item.id !== state.nowId);
    engine.setWanted(list.map((item) => item.id));
    for (const item of list) {
      if (run !== preloadRun || destroyed) return;
      try {
        await prepareItem(item);
      } catch {
        // sin bandeja libre o archivo con problema: se vuelve a intentar al pulsar
      }
    }
    emit();
  }

  // Trae a memoria los archivos del programa (en orden) para que al saltar a cualquiera entre sin esperar a leer el disco.
  async function prefetch() {
    const run = ++prefetchRun;
    const items = itemsRaw().slice(0, MAX_PREFETCH);
    for (const item of items) {
      if (run !== prefetchRun || destroyed) return;
      if (!trackOf(item.trackId) || blobs.has(item.trackId)) continue;
      try {
        await blobFor(item.trackId);
      } catch {
        // se intentará de nuevo al pulsar
      }
    }
  }

  // ---------------------------------------------------------- audio desbloqueado

  async function unlockAudio() {
    let ok = false;
    try {
      ok = await engine.unlock();
    } catch (error) {
      fail(error);
    }
    if (state.audioBlocked === ok) {
      state.audioBlocked = !ok;
      emit();
    }
    return ok;
  }

  // ---------------------------------------------------------- reproducción

  async function startItem(item, { fade } = {}) {
    if (!item) return false;
    const run = ++seq;
    if (!(await unlockAudio())) {
      pending = { fn: () => startItem(item, { fade }), at: now() };
      return false;
    }
    if (run !== seq) return false;
    state.busy.add(item.id);
    emit();
    let ok = false;
    try {
      await prepareItem(item, { force: true });
      if (run !== seq) return false;
      const seconds = state.transport === 'playing' ? (fade ?? state.settings.fade) : START_FADE;
      ok = engine.mixTo(item.id, { duration: seconds });
      if (!ok) throw new Error('No se pudo iniciar esa canción');
      state.nowId = item.id;
      if (state.cueId === item.id) state.cueId = null;
      state.transport = 'playing';
      runId++;
      if (host.pauseMultitrack) host.pauseMultitrack();
      syncWake();
    } catch (error) {
      fail(error);
    } finally {
      state.busy.delete(item.id);
    }
    if (ok) preload();
    emit();
    return ok;
  }

  function next() {
    const target = nextItem();
    if (!target) {
      toast(itemsRaw().length ? 'Es la última canción del programa' : 'El programa está vacío. Añade canciones primero.');
      return Promise.resolve(false);
    }
    const playable = playableFrom(target, 1);
    if (!playable) {
      toast('A los participantes que siguen les falta el archivo. Añádelos con «Añadir canciones».', 'error');
      return Promise.resolve(false);
    }
    if (playable !== target) toastSkipped(target, playable);
    return startItem(playable);
  }

  function prev() {
    const target = resolvePrevItem(itemsRaw(), state.nowId);
    if (!target) {
      toast('Es la primera canción del programa');
      return Promise.resolve(false);
    }
    const playable = playableFrom(target, -1);
    if (!playable) {
      toast('A los participantes anteriores les falta el archivo.', 'error');
      return Promise.resolve(false);
    }
    if (playable !== target) toastSkipped(target, playable);
    return startItem(playable);
  }

  function jump(itemId) {
    const target = itemsRaw().find((item) => item.id === itemId);
    return target ? startItem(target) : Promise.resolve(false);
  }

  function cue(itemId) {
    const found = itemsRaw().find((item) => item.id === itemId);
    if (!found || itemId === state.nowId) return;
    if (!isPlayable(found)) {
      toast(found.want ? `Falta el archivo «${found.want.file}». Añádelo con «Añadir canciones» y se vincula solo.` : 'Esa canción ya no está en la biblioteca.', 'error');
      return;
    }
    state.cueId = state.cueId === itemId ? null : itemId;
    emit();
    preload();
  }

  async function pause() {
    if (state.transport !== 'playing') return;
    engine.pause(PAUSE_FADE);
    state.transport = 'paused';
    syncWake();
    emit();
  }

  async function resume() {
    if (state.transport !== 'paused') return;
    if (!(await unlockAudio())) return;
    if (!engine.resume(PAUSE_FADE)) {
      const item = nowItem();
      if (item) await startItem(item);
      return;
    }
    state.transport = 'playing';
    if (host.pauseMultitrack) host.pauseMultitrack();
    syncWake();
    emit();
  }

  async function playPause() {
    if (state.transport === 'playing') return pause();
    if (state.transport === 'paused') return resume();
    const first = cueItem() || nowItem() || itemsRaw()[0];
    if (!first) {
      toast('El programa está vacío. Añade canciones primero.');
      return false;
    }
    const target = playableFrom(first, 1);
    if (!target) {
      toast('A ningún participante le queda un archivo para sonar. Añade las canciones con «Añadir canciones».', 'error');
      return false;
    }
    if (target !== first) toastSkipped(first, target);
    return startItem(target);
  }

  function stopFade() {
    seq++;
    autoRun = runId;
    if (state.transport === 'idle' && !engine.playing) return;
    engine.stopAll({ duration: state.settings.fade });
    state.transport = 'idle';
    syncWake();
    emit();
  }

  function panic() {
    seq++;
    autoRun = runId;
    engine.stopAll({ duration: PANIC_FADE });
    state.transport = 'idle';
    pending = null;
    syncWake();
    emit();
  }

  // Si el audio estaba bloqueado, el primer toque lo activa y repite lo último que se pidió (si fue hace poco).
  async function activateAudio() {
    const ok = await unlockAudio();
    const retry = pending;
    pending = null;
    if (ok && retry && now() - retry.at < 8000) retry.fn();
    return ok;
  }

  function setFade(seconds) {
    state.settings.fade = Number(seconds) <= 0 ? 0 : fadeSeconds(seconds);
    saveSettingsSoon();
    emit();
  }

  function setAutoAdvance(on) {
    state.settings.autoAdvance = Boolean(on);
    saveSettingsSoon();
    emit();
  }

  function setVolume(position, { fromMidi = false } = {}) {
    state.settings.volume = clamp(Number(position) || 0, 0, 1);
    engine.setVolume(faderToGain(state.settings.volume));
    if (!fromMidi) {
      takeover.engaged = false;
      takeover.last = null;
    }
    saveSettingsSoon();
    emit();
  }

  // ---------------------------------------------------------- vigilancia (avance automático y fin de canción)

  function tick() {
    if (destroyed || state.transport !== 'playing') return;
    const snap = engine.snapshot();
    const current = snap.current;
    const item = nowItem();
    if (!current || !item || current.key !== item.id) return;
    if (!state.settings.autoAdvance || autoRun === runId || snap.mixing.active) return;
    const track = trackOf(item.trackId);
    const end = itemEnd(item, current.duration || (track && track.duration) || 0);
    if (!end) return;
    const remaining = end - current.position;
    const fade = state.settings.fade;
    if (remaining > Math.max(fade, 0) + 0.03) return;
    autoRun = runId;
    const target = playableNext();
    if (target) startItem(target, { fade: Math.max(0.3, Math.min(fade || 0.3, remaining)) });
    else if (item.maxDur > 0) {
      engine.stopAll({ duration: Math.max(0.3, remaining) });
      state.transport = 'idle';
      syncWake();
      toast('Fin del programa');
      emit();
    }
  }

  engine.on('ended', ({ key, current }) => {
    if (!current || key !== state.nowId) return;
    state.transport = 'idle';
    syncWake();
    if (state.settings.autoAdvance && autoRun !== runId) {
      autoRun = runId;
      const target = playableNext();
      if (target) startItem(target, { fade: START_FADE });
    }
    emit();
  });

  engine.on('change', () => emit());

  engine.on('error', ({ key, error, blocked }) => {
    if (blocked) {
      state.audioBlocked = true;
    } else {
      fail(error);
    }
    if (key === state.nowId) state.transport = 'idle';
    emit();
  });

  engine.on('audio', (audio) => {
    const blocked = audio === 'suspended' || audio === 'interrupted';
    if (audio === 'running') state.audioBlocked = false;
    else if (state.active && blocked && state.transport === 'playing') state.audioBlocked = true;
    emit();
  });

  // ---------------------------------------------------------- pantalla encendida

  function syncWake() {
    const wanted = state.active || state.transport === 'playing';
    if (!wanted) {
      if (wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        lock.release().catch(() => {});
      }
      return;
    }
    if (wakeLock || typeof navigator === 'undefined' || !navigator.wakeLock || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    navigator.wakeLock
      .request('screen')
      .then((lock) => {
        wakeLock = lock;
        lock.addEventListener('release', () => {
          if (wakeLock === lock) wakeLock = null;
        });
      })
      .catch(() => {});
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') syncWake();
  };

  // ---------------------------------------------------------- biblioteca

  // Participantes de un paquete sin audio que esperan un archivo con este nombre: se vinculan solos al añadirlo.
  function claimWaiting(track, fileName) {
    const key = relinkKey(fileName);
    let count = 0;
    for (const entry of state.programs) {
      let touched = false;
      for (const item of entry.items) {
        if (!item.want || isPlayable(item) || relinkKey(item.want.file) !== key) continue;
        item.trackId = track.id;
        delete item.want;
        if (track.duration) item.start = clamp(item.start, 0, Math.max(0, track.duration - 1));
        touched = true;
        count++;
      }
      if (touched) {
        entry.updated = now();
        later(`program:${entry.id}`, () => saveProgram(entry));
      }
    }
    return count;
  }

  async function importFiles(fileList, { addToProgram = true } = {}) {
    const all = Array.from(fileList || []);
    const files = all.filter(isAudioFile).sort((a, b) => naturalCompare(a.name, b.name));
    if (!files.length) {
      toast(all.length ? 'Esos archivos no son de audio' : 'No se eligió ningún archivo', 'error');
      return [];
    }
    if (state.importing) {
      toast('Espera a que termine de añadir las canciones anteriores');
      return [];
    }
    const added = [];
    const failed = [];
    let relinked = 0;
    state.importing = { done: 0, total: files.length, name: '' };
    emit();
    for (const file of files) {
      state.importing.name = file.name;
      emit();
      try {
        const info = await probe(file);
        const track = { id: uid(), name: cleanName(file.name), file: file.name, type: file.type || '', size: file.size, duration: info.duration || 0, added: now() };
        await store.put('blobs', { id: track.id, blob: file });
        await store.put('tracks', track);
        state.tracks.push(track);
        remember(track.id, file);
        added.push(track);
        // Si un programa traído de otra PC esperaba este archivo, se vincula a su participante y no se agrega otro.
        const claimed = claimWaiting(track, file.name);
        relinked += claimed;
        if (addToProgram && !claimed) {
          if (!program()) await createProgram('Programa 1');
          program().items.push({ id: uid(), trackId: track.id, label: '', start: 0, maxDur: 0, gainDb: 0 });
        }
      } catch (error) {
        failed.push(`${file.name}: ${error.message || 'no se pudo añadir'}`);
      }
      state.importing.done++;
    }
    state.importing = null;
    if (addToProgram && added.length) touchProgram();
    emit(true);
    if (added.length) {
      const base = added.length === 1 ? 'Canción añadida' : `${added.length} canciones añadidas`;
      toast(relinked ? `${base} · ${relinked === 1 ? '1 participante recuperó su canción' : `${relinked} participantes recuperaron su canción`}` : base);
    }
    if (failed.length) toast(failed.length === 1 ? failed[0] : `${failed.length} archivos no se pudieron añadir. Primero: ${failed[0]}`, 'error');
    prefetch();
    preload();
    return added;
  }

  // ---------------------------------------------------------- llevar el programa a otra PC (paquete)

  // ¿Esta canción ya está en la biblioteca? Mismo nombre de archivo (y mismo tamaño si `strict`).
  function findLibraryTrack(fileName, size = 0, strict = false) {
    const key = relinkKey(fileName);
    const same = state.tracks.filter((track) => relinkKey(track.file || track.name) === key);
    if (!same.length) return null;
    const exact = size ? same.find((track) => track.size === size) : null;
    if (exact) return exact;
    return strict ? null : same[0];
  }

  // Lee el audio sin dejarlo en la memoria de reserva: un paquete grande no debe desalojar lo que ya está preparado.
  async function readBlob(trackId) {
    const hit = blobs.get(trackId);
    if (hit) return hit;
    const row = await store.get('blobs', trackId);
    return row && row.blob ? row.blob : null;
  }

  // Cuánto pesaría y qué llevaría el paquete, para mostrarlo antes de generarlo.
  function previewPackage(scope = 'current') {
    const chosen = scope === 'all' ? state.programs : program() ? [program()] : [];
    const songs = new Map();
    const waiting = new Set();
    let participants = 0;
    let skipped = 0;
    for (const entry of chosen) {
      for (const item of entry.items) {
        const track = trackOf(item.trackId);
        if (track) {
          participants++;
          songs.set(track.id, track.size || 0);
        } else if (item.want) {
          participants++;
          waiting.add(`${relinkKey(item.want.file)}|${item.want.size || 0}`);
        } else skipped++;
      }
    }
    const bytes = estimatePackageBytes(Array.from(songs.values()));
    return { programs: chosen.length, participants, songs: songs.size + waiting.size, withAudio: songs.size, waiting: waiting.size, skipped, bytes, tooBig: bytes > ZIP_MAX_BYTES };
  }

  // Arma el archivo para llevarse el programa: { blob, fileName, ... }. No lo descarga (eso lo hace la pantalla).
  //   scope 'current' = el programa abierto · 'all' = todos      audio true = ZIP con canciones · false = solo el programa
  async function exportPackage({ scope = 'current', audio = true } = {}) {
    if (state.exporting) {
      toast('Ya se está preparando un paquete. Espera a que termine.');
      return null;
    }
    const chosen = scope === 'all' ? state.programs.slice() : program() ? [program()] : [];
    if (!chosen.length) {
      toast('No hay ningún programa para llevar', 'error');
      return null;
    }
    state.exporting = { done: 0, total: 1, name: '' };
    emit();
    try {
      const refs = new Map(); // canción de la biblioteca -> referencia dentro del paquete
      const waiting = new Map(); // canciones que ya esperaban su archivo -> referencia
      const list = [];
      let skipped = 0;
      const programs = chosen.map((entry) => {
        const items = [];
        for (const item of entry.items) {
          const track = trackOf(item.trackId);
          let ref = null;
          if (track) {
            ref = refs.get(track.id);
            if (!ref) {
              ref = `t${list.length + 1}`;
              refs.set(track.id, ref);
              list.push({ ref, track });
            }
          } else if (item.want) {
            const key = `${relinkKey(item.want.file)}|${item.want.size || 0}`;
            ref = waiting.get(key);
            if (!ref) {
              ref = `t${list.length + 1}`;
              waiting.set(key, ref);
              list.push({ ref, want: item.want });
            }
          } else {
            skipped++; // su canción ya no existe y no se sabe cuál era
            continue;
          }
          items.push({ track: ref, label: item.label, start: item.start, maxDur: item.maxDur, gainDb: item.gainDb });
        }
        return { name: entry.name, items };
      });

      const tracks = [];
      const files = [];
      const shown = new Map();
      for (const entry of list) {
        const source = entry.track || entry.want;
        const row = {
          ref: entry.ref,
          name: entry.track ? entry.track.name : entry.want.name || cleanName(entry.want.file),
          file: entry.track ? entry.track.file || entry.track.name : entry.want.file,
          type: entry.track ? entry.track.type || '' : '',
          size: source.size || 0,
          duration: source.duration || 0,
          entry: '',
        };
        if (audio && entry.track) {
          const blob = await readBlob(entry.track.id);
          if (!blob) throw new Error(`No se encontró en este dispositivo el archivo de «${entry.track.name}». Bórrala de la biblioteca y vuelve a añadirla.`);
          row.entry = entryNameFor(files.length, row.file);
          row.size = blob.size;
          files.push({ name: row.entry, blob });
          shown.set(row.entry, row.file);
        }
        tracks.push(row);
      }
      if (audio && estimatePackageBytes(files.map((file) => file.blob.size)) > ZIP_MAX_BYTES) {
        throw new Error('Estas canciones pesan más de 4 GB juntas y no caben en un solo paquete. Lleva un programa a la vez, o usa «Solo el programa» y copia las canciones aparte.');
      }

      const manifest = buildManifest({
        audio,
        created: new Date(now()),
        programs,
        tracks,
        settings: { fade: state.settings.fade, autoAdvance: state.settings.autoAdvance, bindings: effectiveBindings() },
      });
      const manifestText = serializeManifest(manifest);
      const fileName = packageFileName(programs.map((entry) => entry.name), { audio });
      let blob;
      if (audio) {
        const encoder = new TextEncoder();
        state.exporting = { done: 0, total: files.length, name: '' };
        emit();
        blob = await buildZip([{ name: MANIFEST_NAME, bytes: encoder.encode(manifestText) }, { name: 'LEEME.txt', bytes: encoder.encode(readmeText()) }, ...files], {
          onProgress: ({ index, name }) => {
            if (!state.exporting) return;
            state.exporting.done = Math.max(0, index - 2); // las dos primeras entradas son el programa y el LEEME
            state.exporting.name = shown.get(name) || '';
            emit();
          },
        });
      } else {
        blob = new Blob([manifestText], { type: 'application/json' });
      }
      return {
        blob,
        fileName,
        bytes: blob.size,
        programs: programs.length,
        participants: programs.reduce((total, entry) => total + entry.items.length, 0),
        songs: tracks.length,
        withAudio: files.length,
        waiting: audio ? tracks.length - files.length : 0,
        skipped,
      };
    } catch (error) {
      fail(error);
      return null;
    } finally {
      state.exporting = null;
      emit();
    }
  }

  // Qué trae un paquete y qué pasaría al abrirlo, sin cambiar nada todavía.
  function summarizePackage(opened) {
    const manifest = opened.manifest;
    const used = new Set(manifest.programs.flatMap((entry) => entry.items.map((item) => item.track)));
    const defs = manifest.tracks.filter((track) => used.has(track.ref));
    let withAudio = 0;
    let audioBytes = 0;
    let reused = 0;
    let linked = 0;
    let waiting = 0;
    for (const def of defs) {
      const size = opened.audioSize(def);
      if (size !== null) {
        if (findLibraryTrack(def.file, size, true)) reused++;
        else {
          withAudio++;
          audioBytes += size;
        }
      } else if (findLibraryTrack(def.file, def.size, false)) linked++;
      else waiting++;
    }
    return {
      kind: opened.kind,
      fileName: opened.fileName,
      programs: manifest.programs.map((entry) => ({ name: entry.name, participants: entry.items.length })),
      participants: manifest.programs.reduce((total, entry) => total + entry.items.length, 0),
      songs: defs.length,
      withAudio,
      audioBytes,
      reused,
      linked,
      waiting,
      dropped: manifest.dropped,
      created: manifest.created,
      hasSettings: Boolean(manifest.settings),
      hasBindings: Boolean(manifest.settings && manifest.settings.bindings),
      customBindings: Boolean(state.settings.bindings),
    };
  }

  // Abre el archivo elegido (ZIP o JSON) y dice qué trae. Devuelve { opened, summary } o null si no sirve.
  async function openPackage(file) {
    try {
      const opened = await readPackage(file);
      return { opened, summary: summarizePackage(opened) };
    } catch (error) {
      fail(error);
      return null;
    }
  }

  function uniqueProgramName(base, taken) {
    let name = base;
    let count = 2;
    while (taken.has(name.toLowerCase())) name = `${base.slice(0, 54)} (${count++})`;
    taken.add(name.toLowerCase());
    return name;
  }

  // Trae a este dispositivo lo que trae el paquete: guarda las canciones, crea los programas y, si se pide, usa también
  // los pads y la mezcla del paquete. Lo que ya está en la biblioteca no se duplica; lo que no trae audio queda esperando
  // su archivo (se vincula por nombre al añadirlo). No interrumpe la música que esté en pausa y no corre mientras suena.
  async function importPackage(opened, { applySettings = false } = {}) {
    if (destroyed || !opened || !opened.manifest) return null;
    if (state.importing || state.exporting) {
      toast('Espera a que termine lo anterior.');
      return null;
    }
    if (state.transport === 'playing') {
      toast('Detén la música antes de traer un programa.', 'error');
      return null;
    }
    const manifest = opened.manifest;
    const used = new Set(manifest.programs.flatMap((entry) => entry.items.map((item) => item.track)));
    const defs = manifest.tracks.filter((track) => used.has(track.ref));
    const report = { programs: 0, participants: 0, saved: 0, reused: 0, linked: 0, waiting: 0, damaged: [], failed: [], programIds: [], selected: false };
    const resolved = new Map();
    state.importing = { done: 0, total: defs.length, name: '', label: 'Trayendo el programa…' };
    emit();
    try {
      for (const def of defs) {
        state.importing.name = def.file;
        emit();
        let storedId = null;
        try {
          const size = opened.audioSize(def);
          if (size !== null) {
            const same = findLibraryTrack(def.file, size, true);
            if (same) {
              resolved.set(def.ref, same.id);
              report.reused++;
            } else {
              const data = await opened.readAudio(def);
              const type = def.type || data.type || guessAudioType(def.file);
              const typed = data.type === type ? data : data.slice(0, data.size, type);
              let duration = def.duration;
              if (!duration) {
                try {
                  duration = (await probe(new File([typed], def.file, { type }))).duration || 0;
                } catch {
                  duration = 0;
                }
              }
              const track = { id: uid(), name: def.name, file: def.file, type, size: typed.size, duration, added: now() };
              storedId = track.id;
              await store.put('blobs', { id: track.id, blob: typed });
              await store.put('tracks', track);
              state.tracks.push(track);
              resolved.set(def.ref, track.id);
              report.saved++;
            }
          } else {
            const same = findLibraryTrack(def.file, def.size, false);
            if (same) {
              resolved.set(def.ref, same.id);
              report.linked++;
            } else report.waiting++;
          }
        } catch (error) {
          if (storedId) store.remove('blobs', storedId).catch(() => {});
          if (error && error.code === 'damaged') report.damaged.push(def.file);
          else report.failed.push(`${def.file}: ${(error && error.message) || 'no se pudo guardar'}`);
          report.waiting++;
        }
        state.importing.done++;
      }

      const taken = new Set(state.programs.map((entry) => entry.name.toLowerCase()));
      const defsByRef = new Map(defs.map((def) => [def.ref, def]));
      const created = manifest.programs.map((spec) => {
        const items = spec.items.map((entry) => {
          const def = defsByRef.get(entry.track);
          const trackId = resolved.get(entry.track) || '';
          const track = trackOf(trackId);
          const item = { id: uid(), trackId, label: entry.label, start: entry.start, maxDur: entry.maxDur, gainDb: entry.gainDb };
          if (track) {
            if (track.duration) item.start = clamp(item.start, 0, Math.max(0, track.duration - 1));
          } else {
            item.want = { name: def.name, file: def.file, size: def.size, duration: def.duration };
          }
          return item;
        });
        return { id: uid(), name: uniqueProgramName(spec.name, taken), items, created: now(), updated: now() };
      });
      for (const entry of created) {
        state.programs.push(entry);
        await saveProgram(entry);
        report.programs++;
        report.participants += entry.items.length;
        report.programIds.push(entry.id);
      }

      if (applySettings && manifest.settings) {
        const incoming = manifest.settings;
        if ('fade' in incoming) state.settings.fade = incoming.fade;
        if ('autoAdvance' in incoming) state.settings.autoAdvance = incoming.autoAdvance;
        if (incoming.bindings) state.settings.bindings = incoming.bindings;
        saveSettingsSoon();
      }
    } catch (error) {
      fail(error);
    } finally {
      state.importing = null;
    }
    // Con la música detenida se abre de una vez el programa que llegó; si está en pausa se deja donde estaba.
    if (report.programIds.length && state.transport === 'idle') {
      selectProgram(report.programIds[0]);
      report.selected = state.programId === report.programIds[0];
    }
    emit(true);
    if (report.programs) {
      const first = state.programs.find((entry) => entry.id === report.programIds[0]);
      const saved = report.saved ? ` · ${report.saved === 1 ? '1 canción guardada' : `${report.saved} canciones guardadas`}` : '';
      const where = report.selected ? '' : ' Elígelo en la lista de programas.';
      toast(report.programs === 1 ? `Programa «${first.name}» traído: ${report.participants} participantes${saved}.${where}` : `${report.programs} programas traídos: ${report.participants} participantes${saved}.${where}`);
    }
    if (report.waiting) toast(report.waiting === 1 ? 'Falta 1 canción. Añádela con «Añadir canciones»: se vincula sola por el nombre del archivo.' : `Faltan ${report.waiting} canciones. Añádelas con «Añadir canciones»: se vinculan solas por el nombre del archivo.`);
    if (report.damaged.length) toast(report.damaged.length === 1 ? `«${report.damaged[0]}» llegó dañada en el paquete. Vuelve a copiar el paquete.` : `${report.damaged.length} canciones llegaron dañadas en el paquete. Vuelve a copiar el paquete.`, 'error');
    if (report.failed.length) toast(report.failed.length === 1 ? report.failed[0] : `${report.failed.length} canciones no se pudieron guardar. Primera: ${report.failed[0]}`, 'error');
    prefetch();
    preload();
    return report;
  }

  async function removeTrack(trackId) {
    const used = state.programs.flatMap((item) => item.items.filter((entry) => entry.trackId === trackId));
    if (used.some((entry) => entry.id === state.nowId) && state.transport !== 'idle') {
      toast('Esa canción está sonando. Detén la música o mezcla a otra primero.', 'error');
      return false;
    }
    for (const item of state.programs) {
      const before = item.items.length;
      item.items = item.items.filter((entry) => entry.trackId !== trackId);
      if (item.items.length !== before) later(`program:${item.id}`, () => saveProgram(item));
    }
    for (const entry of used) engine.drop(entry.id);
    if (used.some((entry) => entry.id === state.nowId)) state.nowId = null;
    if (used.some((entry) => entry.id === state.cueId)) state.cueId = null;
    state.tracks = state.tracks.filter((track) => track.id !== trackId);
    if (blobs.has(trackId)) {
      blobBytes -= blobs.get(trackId).size;
      blobs.delete(trackId);
    }
    try {
      await store.remove('tracks', trackId);
      await store.remove('blobs', trackId);
    } catch (error) {
      fail(error);
    }
    emit(true);
    preload();
    return true;
  }

  // ---------------------------------------------------------- programas

  async function createProgram(name = '') {
    const item = { id: uid(), name: String(name).trim().slice(0, 60) || `Programa ${state.programs.length + 1}`, items: [], created: now(), updated: now() };
    state.programs.push(item);
    state.programId = item.id;
    state.nowId = null;
    state.cueId = null;
    store.setMeta('programId', item.id).catch(() => {});
    later(`program:${item.id}`, () => saveProgram(item));
    emit(true);
    return item;
  }

  function selectProgram(id) {
    if (!state.programs.some((item) => item.id === id) || id === state.programId) return;
    if (state.transport !== 'idle') {
      toast('Detén la música antes de cambiar de programa', 'error');
      emit(true);
      return;
    }
    state.programId = id;
    state.cueId = null;
    state.nowId = null;
    store.setMeta('programId', id).catch(() => {});
    emit(true);
    prefetch();
    preload();
  }

  function renameProgram(id, name) {
    const item = state.programs.find((entry) => entry.id === id);
    const clean = String(name || '').trim().slice(0, 60);
    if (!item || !clean) return;
    item.name = clean;
    touchProgram(item);
  }

  async function deleteProgram(id) {
    const item = state.programs.find((entry) => entry.id === id);
    if (!item) return;
    if (item.id === state.programId && item.items.some((entry) => entry.id === state.nowId) && state.transport !== 'idle') {
      toast('Este programa está sonando. Detén la música primero.', 'error');
      return;
    }
    state.programs = state.programs.filter((entry) => entry.id !== id);
    for (const entry of item.items) engine.drop(entry.id);
    clearTimeout(timers.get(`program:${id}`));
    timers.delete(`program:${id}`);
    try {
      await store.remove('programs', id);
    } catch (error) {
      fail(error);
    }
    if (!state.programs.length) await createProgram('Programa 1');
    else if (state.programId === id) selectProgram(state.programs[0].id);
    emit(true);
  }

  function addItem(trackId, patch = {}) {
    const target = program();
    if (!target || !trackOf(trackId)) return null;
    const item = { id: uid(), trackId, label: '', start: 0, maxDur: 0, gainDb: 0, ...patch };
    target.items.push(item);
    touchProgram();
    preload();
    return item;
  }

  function removeItem(itemId) {
    const target = program();
    if (!target) return false;
    if (itemId === state.nowId && state.transport !== 'idle') {
      toast('Está sonando ahora. Mezcla a otra o detén la música antes de quitarla.', 'error');
      return false;
    }
    target.items = target.items.filter((item) => item.id !== itemId);
    engine.drop(itemId);
    if (state.cueId === itemId) state.cueId = null;
    if (state.nowId === itemId) state.nowId = null;
    touchProgram();
    preload();
    return true;
  }

  function moveItemBy(itemId, delta) {
    const target = program();
    if (!target) return;
    const index = indexOfItem(target.items, itemId);
    if (index < 0) return;
    target.items = moveItem(target.items, index, delta);
    touchProgram();
    preload();
  }

  function updateItem(itemId, patch) {
    const item = itemsRaw().find((entry) => entry.id === itemId);
    if (!item) return;
    const track = trackOf(item.trackId);
    if ('label' in patch) item.label = String(patch.label || '').trim().slice(0, 80);
    if ('start' in patch) {
      const limit = track && track.duration ? Math.max(0, track.duration - 1) : Infinity;
      item.start = clamp(Number(patch.start) || 0, 0, limit);
    }
    if ('maxDur' in patch) item.maxDur = Math.max(0, Number(patch.maxDur) || 0);
    if ('gainDb' in patch) item.gainDb = clamp(Number(patch.gainDb) || 0, -24, 12);
    touchProgram();
    if (engine.isReady(item.id)) prepareItem(item).catch(() => {});
  }

  // ---------------------------------------------------------- control: teclado y MIDI

  function runAction(action) {
    if (destroyed) return undefined;
    if (action === 'next') return next();
    if (action === 'prev') return prev();
    if (action === 'playPause') return playPause();
    if (action === 'stopFade') return stopFade();
    if (action === 'panic') return panic();
    const slot = slotNumber(action);
    if (slot) {
      const item = itemsRaw()[slot - 1];
      if (!item) {
        toast(`No hay participante ${slot} en este programa`);
        return undefined;
      }
      return startItem(item);
    }
    return undefined;
  }

  const router = createRouter({
    now,
    getBindings: () => state.settings.bindings || DEFAULT_BINDINGS,
    onAction: (action) => {
      const result = runAction(action);
      if (result && result.catch) result.catch(fail);
    },
    onValue: (action, position) => {
      if (action !== 'volume') return;
      if (!softTakeover(takeover, position, state.settings.volume)) {
        state.midi.pickup = position;
        bus.emit('signal');
        return;
      }
      state.midi.pickup = null;
      setVolume(position, { fromMidi: true });
    },
    onSignal: ({ text }) => {
      state.midi.last = text;
      bus.emit('signal');
    },
  });

  const ports = portsFactory({
    onMessage: (data, source) => router.handleMessage(data, source),
    onChange: () => {
      state.midi.status = ports.status;
      state.midi.inputs = ports.inputs;
      emit();
    },
  });

  async function enableMidi() {
    const ok = await ports.enable();
    state.settings.midiEnabled = ok;
    saveSettingsSoon();
    emit();
    return ok;
  }

  function disableMidi() {
    ports.disable();
    state.settings.midiEnabled = false;
    saveSettingsSoon();
    emit();
  }

  function effectiveBindings() {
    return state.settings.bindings || DEFAULT_BINDINGS;
  }

  function setBindings(next) {
    state.settings.bindings = next;
    saveSettingsSoon();
    emit(true);
  }

  // Espera el siguiente botón, pad o tecla y se lo asigna a la acción. Devuelve el disparador (o null si se canceló).
  async function learn(action, { replace = false } = {}) {
    if (state.learning) router.cancelLearn();
    // Con el teclado se puede asignar sin MIDI; para un controlador hay que haber dado el permiso.
    if (state.midi.supported && state.midi.status === 'off') await enableMidi();
    state.learning = { action, label: learnLabel(action) };
    emit();
    const trigger = await router.learn({ continuous: CONTINUOUS.has(action) });
    if (state.learning && state.learning.action === action) state.learning = null;
    if (!trigger) {
      emit();
      return null;
    }
    // Una perilla (volumen) y los pads por participante reemplazan al control anterior; el resto suma controles.
    setBindings((replace || CONTINUOUS.has(action) ? replaceMidiBinding : assignBinding)(effectiveBindings(), action, trigger));
    return trigger;
  }

  function learnLabel(action) {
    const slot = slotNumber(action);
    if (slot) {
      const item = itemsRaw()[slot - 1];
      return `Pulsa el pad o la tecla del participante ${slot}${item ? `: ${itemTitle(item)}` : ''}`;
    }
    return CONTINUOUS.has(action) ? `Mueve la perilla o el fader para «${actionName(action)}»` : `Pulsa el botón o la tecla para «${actionName(action)}»`;
  }

  function cancelLearn() {
    router.cancelLearn();
    if (state.learning) {
      state.learning = null;
      emit();
    }
  }

  // Un pad tras otro: participante 1, 2, 3…
  async function learnSlots(from = 1) {
    const total = Math.min(itemsRaw().length, MAX_SLOTS);
    for (let number = from; number <= total; number++) {
      const trigger = await learn(slotAction(number), { replace: true });
      if (!trigger) return number - from;
    }
    return total - from + 1;
  }

  // Se pulsa el primer pad y los demás participantes toman las notas siguientes (36, 37, 38…).
  async function learnSlotsByNote() {
    const total = Math.min(itemsRaw().length, MAX_SLOTS);
    if (!total) return 0;
    const first = await learn(slotAction(1), { replace: true });
    const match = first && /^n:(\d+):(\d+)$/.exec(first);
    if (!first) return 0;
    if (!match) {
      toast('Para repartir los pads solos, pulsa un pad (no un botón de control ni una tecla)', 'error');
      return 1;
    }
    let bindings = effectiveBindings();
    let count = 1;
    for (let number = 2; number <= total; number++) {
      const note = Number(match[2]) + number - 1;
      if (note > 127) break;
      bindings = replaceMidiBinding(bindings, slotAction(number), `n:${match[1]}:${note}`);
      count++;
    }
    setBindings(bindings);
    return count;
  }

  function unassign(action, trigger) {
    setBindings(removeBinding(effectiveBindings(), action, trigger));
  }

  function clearPads() {
    setBindings(clearSlots(effectiveBindings()));
  }

  function resetBindings() {
    setBindings(null);
  }

  // ---------------------------------------------------------- pestaña activa

  function setActive(on) {
    state.active = Boolean(on);
    router.setActive(state.active);
    if (!state.active) cancelLearn();
    if (state.active) unlockAudio();
    syncWake();
    emit();
  }

  function setTab(name) {
    state.settings.tab = name;
    saveSettingsSoon();
    emit();
  }

  function setLayout(name) {
    state.settings.layout = name === 'pads' ? 'pads' : 'list';
    saveSettingsSoon();
    emit();
  }

  // ---------------------------------------------------------- estado en vivo para la pantalla

  function live() {
    const snap = engine.snapshot();
    const item = nowItem();
    const current = snap.current && item && snap.current.key === item.id ? snap.current : null;
    let elapsed = 0;
    let remaining = null;
    let progress = 0;
    let duration = 0;
    if (current) {
      const track = trackOf(item.trackId);
      duration = current.duration || (track && track.duration) || 0;
      const end = itemEnd(item, duration);
      elapsed = Math.max(0, current.position - item.start);
      remaining = remainingSeconds(item, current.position, duration);
      progress = end > item.start ? clamp((current.position - item.start) / (end - item.start), 0, 1) : 0;
    }
    return { audio: snap.audio, mixing: snap.mixing, transport: state.transport, itemId: item ? item.id : null, elapsed, remaining, progress, duration, level: engine.peak() };
  }

  // ---------------------------------------------------------- arranque

  async function init() {
    let loadError = null;
    try {
      await store.open();
    } catch (error) {
      loadError = error;
    }
    if (loadError) {
      // Sin IndexedDB (ventana privada, por ejemplo): se trabaja en memoria mientras la ventana siga abierta.
      store = createMemoryDjStore();
      state.storage = store.kind;
      toast('Este navegador no deja guardar las canciones. Durarán mientras no cierres la ventana.', 'error');
    }
    try {
      state.tracks = (await store.all('tracks')).sort((a, b) => (a.added || 0) - (b.added || 0));
      state.programs = (await store.all('programs')).sort((a, b) => (a.created || 0) - (b.created || 0));
      const saved = await store.getMeta('settings', null);
      if (saved && typeof saved === 'object') {
        const settings = { ...state.settings, ...saved };
        settings.fade = settings.fade <= 0 ? 0 : fadeSeconds(settings.fade);
        settings.volume = clamp(Number(settings.volume) || 0, 0, 1);
        state.settings = settings;
      }
      state.programId = await store.getMeta('programId', null);
    } catch (error) {
      fail(error);
    }
    if (!state.programs.length) await createProgram('Programa 1');
    if (!program()) state.programId = state.programs[0].id;
    engine.setVolume(faderToGain(state.settings.volume));
    if (host.getSinkId) engine.setSink(host.getSinkId()).catch(() => {});
    if (host.onSinkChange) host.onSinkChange((id) => engine.setSink(id).catch((error) => fail(error)));
    state.ready = true;
    ticker = setInterval(tick, 100);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    emit(true);
    prefetch();
    preload();
    if (state.settings.midiEnabled && midiSupported() && (await midiPermission()) === 'granted') enableMidi();
  }

  function destroy() {
    destroyed = true;
    clearInterval(ticker);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    router.cancelLearn();
    ports.disable();
    engine.destroy();
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  return {
    on: bus.on,
    state,
    router,
    ACTIONS,
    init,
    flush,
    destroy,
    setActive,
    setTab,
    setLayout,
    live,
    notify: toast,
    // consultas
    program,
    items: viewItems,
    trackOf,
    nowItem,
    nextItem,
    cueItem,
    itemStatus,
    // transporte
    next,
    prev,
    jump,
    cue,
    playPause,
    stopFade,
    panic,
    pause,
    resume,
    activateAudio,
    runAction,
    // ajustes
    setFade,
    setAutoAdvance,
    setVolume,
    // biblioteca y programas
    importFiles,
    playableNext,
    removeTrack,
    createProgram,
    selectProgram,
    renameProgram,
    deleteProgram,
    addItem,
    removeItem,
    moveItemBy,
    updateItem,
    // llevar el programa a otra PC
    previewPackage,
    exportPackage,
    openPackage,
    importPackage,
    // MIDI y teclado
    enableMidi,
    disableMidi,
    effectiveBindings,
    learn,
    cancelLearn,
    learnSlots,
    learnSlotsByNote,
    unassign,
    clearPads,
    resetBindings,
    estimate: () => store.estimate(),
  };
}
