// Controlador de la pestaña DJ: biblioteca de canciones, programas (boda, desfile…), mezcla y control MIDI.
//
// Une el motor de audio (dj-engine.js), el guardado (dj-store.js) y los controles (dj-midi.js).
// No toca el DOM: la pantalla (ui/dj-view.js) solo lee `dj.state` y llama a estas funciones.

import { createEmitter, uid, naturalCompare, clamp, FADER_DEFAULT, faderToGain } from './util.js';
import { DEFAULT_FADE, START_FADE, PAUSE_FADE, PANIC_FADE, fadeSeconds, itemEnd, remainingSeconds, resolveNextItem, resolvePrevItem, moveItem, softTakeover, newTakeover, indexOfItem } from './dj-math.js';
import { createMemoryDjStore } from './dj-store.js';
import { ACTIONS, CONTINUOUS, DEFAULT_BINDINGS, MAX_SLOTS, actionName, assignBinding, clearSlots, createMidiPorts, createRouter, midiPermission, midiSupported, removeBinding, replaceMidiBinding, slotAction, slotNumber } from './dj-midi.js';

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
    importing: null,
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
  const itemTitle = (item) => item.label || (trackOf(item.trackId) ? trackOf(item.trackId).name : 'Canción borrada');

  function viewItems() {
    return itemsRaw().map((item, index) => {
      const track = trackOf(item.trackId);
      return {
        ...item,
        index,
        number: index + 1,
        track,
        title: itemTitle(item),
        trackName: track ? track.name : 'Falta el archivo',
        trackDuration: track ? track.duration : 0,
        missing: !track,
        slot: index < MAX_SLOTS ? slotAction(index + 1) : null,
      };
    });
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
    if (!track) throw new Error(`“${itemTitle(item)}”: el archivo ya no está en la biblioteca`);
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
    const first = nextItem();
    const second = first ? items[items.indexOf(first) + 1] : null;
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
    return startItem(target);
  }

  function prev() {
    const target = resolvePrevItem(itemsRaw(), state.nowId);
    if (!target) {
      toast('Es la primera canción del programa');
      return Promise.resolve(false);
    }
    return startItem(target);
  }

  function jump(itemId) {
    const target = itemsRaw().find((item) => item.id === itemId);
    return target ? startItem(target) : Promise.resolve(false);
  }

  function cue(itemId) {
    if (!itemsRaw().some((item) => item.id === itemId) || itemId === state.nowId) return;
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
    const target = cueItem() || nowItem() || itemsRaw()[0];
    if (!target) {
      toast('El programa está vacío. Añade canciones primero.');
      return false;
    }
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
    const target = nextItem();
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
      const target = nextItem();
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
        if (addToProgram) {
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
    if (added.length) toast(added.length === 1 ? 'Canción añadida' : `${added.length} canciones añadidas`);
    if (failed.length) toast(failed.length === 1 ? failed[0] : `${failed.length} archivos no se pudieron añadir. Primero: ${failed[0]}`, 'error');
    prefetch();
    preload();
    return added;
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
    removeTrack,
    createProgram,
    selectProgram,
    renameProgram,
    deleteProgram,
    addItem,
    removeItem,
    moveItemBy,
    updateItem,
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
