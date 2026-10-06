import { createEmitter, debounce, isIOS, clamp } from './util.js';
import { store } from './store.js';
import { Engine, DEFAULT_OUTPUT, normalizeRoutes } from './engine.js';
import { normalizeSong, serializableSong, createSong, createTrackDef, createSetlist } from './library.js';
import { normalizeTempoEntries, detectTempoFromBuffer } from './tempo.js';
import { renderPreview, isSampleSound } from './synth.js';
import { DEFAULT_GUIDE_LANG, isGuideLanguage, guideLanguageName } from './voices.js';

const MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || isIOS();

const GB = 1024 ** 3;
// Cuántos audios se decodifican a la vez. Con una canción esperando en pantalla se usan casi todos los
// núcleos; en segundo plano (precarga mientras suena otra canción) solo dos, para no molestar al audio.
const FOREGROUND_DECODERS = MOBILE ? 1 : clamp((Number(navigator.hardwareConcurrency) || 4) - 1, 2, 4);
const BACKGROUND_DECODERS = MOBILE ? 1 : 2;
// Además de la que sigue, se guarda lista en memoria como mucho una canción que se acaba de dejar,
// por si hay que volver a ella (siempre que quepa en el presupuesto de memoria).
const KEPT_BEHIND = 1;

class Cancelled extends Error {
  constructor() {
    super('Carga cancelada');
    this.cancelled = true;
  }
}

// Lo que obliga a decodificar de nuevo: las pistas, sus archivos y si se mezclan a mono.
const decodeSignature = (song) => song.tracks.map((track) => `${track.id}:${track.fileId}:${track.mono ? 1 : 0}`).join('|');

export const DEFAULT_SETTINGS = {
  output: { ...DEFAULT_OUTPUT },
  jumpMode: 'bar',
  liveControlsVersion: 1,
  afterSong: 'stop',
  gapSeconds: 0,
  preloadNext: !MOBILE,
  autoCountIn: true,
  keepAwake: true,
  sinkId: '',
  sinkLabel: '',
  midiProgramChange: true,
  midiEnabled: false,
  bindings: null,
  guideLang: DEFAULT_GUIDE_LANG,
};

function mergeSettings(saved) {
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  if (!isGuideLanguage(merged.guideLang)) merged.guideLang = DEFAULT_GUIDE_LANG;
  // This live-performance update starts every device in bar mode once.
  // Later, deliberate changes in Ajustes are retained.
  if (!saved || saved.liveControlsVersion !== 1 || !['bar', 'beat', 'now'].includes(merged.jumpMode)) merged.jumpMode = 'bar';
  merged.liveControlsVersion = 1;
  const savedOutput = saved && saved.output ? saved.output : {};
  merged.output = { ...DEFAULT_OUTPUT, ...savedOutput, routes: normalizeRoutes(savedOutput.routes) };
  return merged;
}

class App {
  constructor() {
    this.bus = createEmitter();
    this.settings = mergeSettings({});
    this.songs = new Map();
    this.setlists = [];
    this.activeSetlistId = null;
    this.current = null;
    // Canciones ya decodificadas y listas para sonar al instante (la más antigua primero) y
    // decodificaciones en curso, ambas por id de canción.
    this.warm = new Map();
    this.jobs = new Map();
    // Canciones que no se pudieron leer en segundo plano (id → firma): no se reintentan en bucle.
    this.failed = new Map();
    // Combinaciones «frecuencia de las pistas > frecuencia de la salida» que ya se explicaron en esta sesión.
    this.conversionNotes = new Set();
    this.advancing = null;
    this.loading = null;
    this.loadToken = 0;
    this.wantedId = null;
    this.loopMode = false;
    this.engine = null;
    this.ready = false;
    this.stageLocked = false;
    this.sinkState = 'default';
    this.reviewing = Promise.resolve();
    this.saveSettings = debounce(() => store.setMeta('settings', this.settings).catch(() => {}), 300);
    this.persistSongSoon = debounce((song) => this.saveSong(song, true).catch((error) => this.toast(error.message, 'error')), 400);
  }

  on(name, fn) {
    return this.bus.on(name, fn);
  }

  emit(name, ...args) {
    this.bus.emit(name, ...args);
  }

  toast(message, kind = 'info', duration) {
    this.emit('toast', { message, kind, duration });
  }

  async init() {
    this.settings = mergeSettings(await store.getMeta('settings', {}));
    await store.setMeta('settings', this.settings);
    for (const raw of await store.all('songs')) this.songs.set(raw.id, normalizeSong(raw));
    this.setlists = (await store.all('setlists')).sort((a, b) => a.createdAt - b.createdAt);
    if (!this.setlists.length) {
      const first = createSetlist('Setlist 1');
      this.setlists.push(first);
      await store.put('setlists', first);
    }
    const active = await store.getMeta('activeSetlist', this.setlists[0].id);
    this.activeSetlistId = this.setlists.some((setlist) => setlist.id === active) ? active : this.setlists[0].id;
    this.engine = new Engine();
    this.engine.output = this.settings.output;
    this.engine.applyOutput(true);
    this.startTicker();
    this.ready = true;
    this.emit('ready');
  }

  get player() {
    return this.current ? this.current.player : null;
  }

  // La canción que sigue en el setlist, si ya está lista para sonar.
  get next() {
    const id = this.nextSongId();
    return id ? this.warm.get(id) || null : null;
  }

  // ¿Se puede poner esta canción ya mismo? Es la actual o está decodificada en memoria.
  isReady(id) {
    return Boolean(this.current && this.current.song.id === id) || this.warm.has(id);
  }

  isWarming(id) {
    return this.jobs.has(id);
  }

  setSetting(key, value) {
    this.settings[key] = value;
    this.saveSettings();
    this.emit('settings', key);
  }

  resetSettings() {
    const guideBefore = this.settings.guideLang;
    this.settings = mergeSettings({});
    if (guideBefore !== this.settings.guideLang) this.setGuideLanguage(this.settings.guideLang).catch(() => {});
    this.engine.output = this.settings.output;
    this.engine.applyOutput(false);
    this.saveSettings();
    this.sinkState = 'default';
    this.engine.setSinkId('').catch(() => {});
    this.emit('settings', 'bindings');
    this.emit('settings', 'output');
    this.emit('outputs');
  }

  setOutput(patch) {
    Object.assign(this.settings.output, patch);
    this.engine.applyOutput(false);
    this.saveSettings();
    this.emit('settings', 'output');
  }

  get canPickDevice() {
    return Boolean(this.engine) && typeof this.engine.ctx.setSinkId === 'function';
  }

  async outputDevices() {
    const media = navigator.mediaDevices;
    if (!media || typeof media.enumerateDevices !== 'function') return [];
    try {
      return (await media.enumerateDevices()).filter((device) => device.kind === 'audiooutput' && device.deviceId);
    } catch (error) {
      return [];
    }
  }

  async chooseSink(id, label = '') {
    this.settings.sinkId = id;
    this.settings.sinkLabel = id ? label : '';
    this.saveSettings();
    try {
      await this.engine.setSinkId(id);
      this.sinkState = id ? 'ok' : 'default';
    } catch (error) {
      this.settings.sinkId = '';
      this.settings.sinkLabel = '';
      this.sinkState = 'default';
      this.engine.setSinkId('').catch(() => {});
      this.toast('No se pudo usar ese dispositivo. Suena por la salida del sistema', 'error');
    }
    this.saveSettings();
    this.emit('settings', 'sinkId');
    this.emit('outputs');
  }

  async connectSink({ startup = false } = {}) {
    const id = this.settings.sinkId;
    if (!id || !this.canPickDevice) {
      this.sinkState = 'default';
      this.emit('outputs');
      return;
    }
    const before = this.sinkState;
    try {
      await this.engine.setSinkId(id);
      this.sinkState = 'ok';
      if (before === 'missing') this.toast(`Salida conectada: ${this.settings.sinkLabel || 'dispositivo de audio'}`);
    } catch (error) {
      this.sinkState = 'missing';
      if (startup) this.toast(`${this.settings.sinkLabel || 'La salida de audio guardada'} no está conectada. Suena por la salida del sistema`, 'error');
    }
    this.emit('outputs');
  }

  startDevices() {
    if (!this.engine) return;
    const media = navigator.mediaDevices;
    if (media && typeof media.addEventListener === 'function') {
      let timer = 0;
      media.addEventListener('devicechange', () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.queueReview(), 400);
      });
    }
    this.engine.ctx.addEventListener('sinkchange', () => {
      this.engine.applyOutput(true);
      this.emit('outputs');
    });
    if (this.settings.sinkId) this.connectSink({ startup: true });
    else this.emit('outputs');
  }

  queueReview() {
    this.reviewing = this.reviewing.then(() => this.reviewDevices()).catch(() => {});
    return this.reviewing;
  }

  async reviewDevices() {
    const id = this.settings.sinkId;
    if (id && this.canPickDevice) {
      const list = await this.outputDevices();
      const trusted = list.some((device) => device.label);
      const present = list.some((device) => device.deviceId === id);
      if (this.sinkState === 'ok' && trusted && !present) {
        this.sinkState = 'missing';
        try {
          await this.engine.setSinkId('');
        } catch (error) {
          void error;
        }
        this.toast(`Se desconectó ${this.settings.sinkLabel || 'la salida de audio'}. Ahora suena por la salida del sistema`, 'error');
      } else if (this.sinkState === 'missing' && (present || !trusted)) {
        await this.connectSink();
        return;
      }
    }
    this.engine.applyOutput(true);
    this.emit('outputs');
  }

  songList() {
    return Array.from(this.songs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  activeSetlist() {
    return this.setlists.find((setlist) => setlist.id === this.activeSetlistId) || this.setlists[0];
  }

  setlistSongs(setlist = this.activeSetlist()) {
    return setlist.songIds.map((id) => this.songs.get(id)).filter(Boolean);
  }

  async saveSong(song, silent = false) {
    song.updatedAt = Date.now();
    this.songs.set(song.id, song);
    await store.put('songs', serializableSong(song));
    if (!silent) this.emit('songs');
  }

  async importSong(title, drafts, onProgress, extra = {}) {
    const chosen = drafts.filter((draft) => draft.keep);
    const stored = [];
    const defs = [];
    try {
      for (let i = 0; i < chosen.length; i++) {
        const draft = chosen[i];
        const fileId = `${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 7)}`;
        await store.put('files', { id: fileId, name: draft.item.name, size: draft.item.blob.size, type: draft.item.blob.type, blob: draft.item.blob });
        stored.push(fileId);
        defs.push(createTrackDef(draft, fileId, i));
        if (onProgress) onProgress(i + 1, chosen.length, draft.name);
      }
    } catch (error) {
      for (const id of stored) await store.remove('files', id).catch(() => {});
      throw new Error(error && error.name === 'QuotaExceededError' ? 'No hay espacio suficiente en el dispositivo' : error.message || 'No se pudo guardar');
    }
    const song = createSong(title, defs);
    if (chosen.some((draft) => draft.click)) song.click.mute = true;
    if (chosen.some((draft) => draft.guide)) song.guide.mute = true;
    if (extra.tempo) {
      song.tempoMap = normalizeTempoEntries([{ bar: 1, bpm: extra.tempo.bpm, num: extra.tempo.num || 4, den: extra.tempo.den || 4 }]);
      song.offsetMs = Number(extra.tempo.offsetMs) || 0;
    }
    if (extra.markers) song.markers = extra.markers;
    if (extra.click) Object.assign(song.click, extra.click);
    const normalized = normalizeSong(song);
    await this.saveSong(normalized);
    return normalized;
  }

  async addTracks(song, drafts, onProgress) {
    const chosen = drafts.filter((draft) => draft.keep);
    const stored = [];
    const defs = [];
    try {
      for (let i = 0; i < chosen.length; i++) {
        const draft = chosen[i];
        const fileId = `${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 7)}`;
        await store.put('files', { id: fileId, name: draft.item.name, size: draft.item.blob.size, type: draft.item.blob.type, blob: draft.item.blob });
        stored.push(fileId);
        defs.push(createTrackDef(draft, fileId, song.tracks.length + i));
        if (onProgress) onProgress(i + 1, chosen.length, draft.name);
      }
    } catch (error) {
      for (const id of stored) await store.remove('files', id).catch(() => {});
      throw error;
    }
    song.tracks.push(...defs);
    await this.saveSong(song);
    await this.reloadIfCurrent(song.id);
  }

  async updateSong(song, kind = 'meta') {
    const entry = this.current && this.current.song === song ? this.current : null;
    if (entry) {
      const player = entry.player;
      if (kind === 'tempo') player.refreshAll();
      else if (kind === 'markers' || kind === 'guide') player.refreshGuide();
      else if (kind === 'click') player.refreshClick();
      else if (kind === 'routing') {
        for (const track of player.allTracks()) track.route();
        player.refreshSolo();
      }
      if (kind === 'tempo' || kind === 'markers' || kind === 'guide' || kind === 'click') player.resync();
      this.emit('transport', entry);
    }
    this.persistSongSoon(song);
    this.emit('song:updated', song, kind);
  }

  async analyzeTrack(song, trackId) {
    let buffer = null;
    if (this.current && this.current.song === song) {
      const node = this.current.player.fileTracks.find((item) => item.def.id === trackId);
      if (node) buffer = node.buffer;
    }
    if (!buffer) {
      const track = song.tracks.find((item) => item.id === trackId);
      const file = track ? await store.get('files', track.fileId) : null;
      if (!file) throw new Error('No se encontró el archivo de la pista');
      buffer = await this.engine.decode(file.blob);
    }
    return detectTempoFromBuffer(buffer);
  }

  async analyzeBlob(blob) {
    const buffer = await this.engine.decode(blob);
    return detectTempoFromBuffer(buffer);
  }

  async previewVoice(key) {
    const voices = await this.engine.loadVoices(this.settings.guideLang);
    const data = voices.get(key);
    if (!data) return;
    const ctx = this.engine.ctx;
    const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buffer.copyToChannel(data, 0);
    await this.engine.previewBuffer(buffer, 'cue');
  }

  async previewSound(sound) {
    await this.ensureClickSound(sound);
    await this.engine.previewBuffer(renderPreview(this.engine.ctx, sound, this.engine.clickBank), 'cue');
  }

  // Los sonidos de click de muestra se descargan la primera vez que se usan. Si no se pueden
  // leer, el click suena como Madera en vez de quedar mudo.
  async ensureClickSound(sound) {
    if (!isSampleSound(sound)) return true;
    try {
      await this.engine.loadClickBank();
      return true;
    } catch (error) {
      this.toast('No se pudo cargar ese sonido de click. Suena Madera mientras tanto', 'error');
      return false;
    }
  }

  // Banco de voces del idioma elegido, si ya se cargó (el editor lo usa para avisar qué voces faltan).
  get guideVoices() {
    const engine = this.engine;
    if (!engine) return null;
    return engine.voiceBanks.get(this.settings.guideLang) || engine.voiceBank || null;
  }

  voiceAvailable(key) {
    const bank = this.guideVoices;
    return !bank || bank.has(key);
  }

  // Cambia el idioma de las guías de voz. Se aplica de inmediato a la canción cargada y a la
  // siguiente del setlist, sin detener la reproducción.
  async setGuideLanguage(lang) {
    if (!isGuideLanguage(lang)) return;
    const token = (this.guideToken = (this.guideToken || 0) + 1);
    this.setSetting('guideLang', lang);
    let bank;
    try {
      bank = await this.engine.loadVoices(lang);
    } catch (error) {
      if (token === this.guideToken) this.toast('No se pudieron cargar las voces de guía', 'error');
      return;
    }
    if (token !== this.guideToken) return;
    if (bank.lang !== bank.requested) {
      this.toast(`No se pudo cargar la guía en ${guideLanguageName(lang)}: suena la voz original. Conéctate a internet una vez para descargarla`, 'error');
    }
    for (const entry of [this.current, ...this.warm.values()]) if (entry) entry.player.setVoices(bank);
  }

  setTrackDest(node, dest) {
    node.def.dest = dest;
    node.route();
    this.player.refreshSolo();
    this.persistSongSoon(this.current.song);
    this.emit('track', node);
  }

  setTrackLevel(node, value) {
    node.def.vol = value;
    node.applyGain();
    this.persistSongSoon(this.current.song);
  }

  setTrackPan(node, value) {
    node.def.pan = value;
    node.applyPan();
    this.persistSongSoon(this.current.song);
  }

  async removeTrack(song, trackId) {
    const track = song.tracks.find((item) => item.id === trackId);
    if (!track) return;
    song.tracks = song.tracks.filter((item) => item.id !== trackId);
    await store.remove('files', track.fileId).catch(() => {});
    await this.saveSong(song);
    await this.reloadIfCurrent(song.id);
  }

  async deleteSong(id) {
    const song = this.songs.get(id);
    if (!song) return;
    if (this.current && this.current.song.id === id) this.unloadCurrent();
    this.invalidateSong(id);
    for (const track of song.tracks) await store.remove('files', track.fileId).catch(() => {});
    await store.remove('songs', id);
    this.songs.delete(id);
    for (const setlist of this.setlists) {
      if (setlist.songIds.includes(id)) {
        setlist.songIds = setlist.songIds.filter((songId) => songId !== id);
        await store.put('setlists', setlist);
      }
    }
    this.emit('songs');
    this.emit('setlists');
    this.warmUp();
  }

  async createSetlist(name) {
    const setlist = createSetlist(name);
    this.setlists.push(setlist);
    await store.put('setlists', setlist);
    await this.setActiveSetlist(setlist.id);
    this.emit('setlists');
    return setlist;
  }

  async renameSetlist(id, name) {
    const setlist = this.setlists.find((item) => item.id === id);
    if (!setlist) return;
    setlist.name = name || setlist.name;
    await store.put('setlists', setlist);
    this.emit('setlists');
  }

  async deleteSetlist(id) {
    if (this.setlists.length <= 1) return;
    this.setlists = this.setlists.filter((item) => item.id !== id);
    await store.remove('setlists', id);
    if (this.activeSetlistId === id) await this.setActiveSetlist(this.setlists[0].id);
    this.emit('setlists');
  }

  async setActiveSetlist(id) {
    this.activeSetlistId = id;
    await store.setMeta('activeSetlist', id);
    this.emit('setlists');
    this.warmUp();
  }

  async saveSetlist(setlist) {
    await store.put('setlists', setlist);
    this.emit('setlists');
    this.warmUp();
  }

  async addToSetlist(songIds, setlist = this.activeSetlist()) {
    for (const id of songIds) if (!setlist.songIds.includes(id)) setlist.songIds.push(id);
    await this.saveSetlist(setlist);
  }

  async removeFromSetlist(index, setlist = this.activeSetlist()) {
    setlist.songIds.splice(index, 1);
    await this.saveSetlist(setlist);
  }

  async moveInSetlist(from, to, setlist = this.activeSetlist()) {
    if (to < 0 || to >= setlist.songIds.length) return;
    const [id] = setlist.songIds.splice(from, 1);
    setlist.songIds.splice(to, 0, id);
    await this.saveSetlist(setlist);
  }

  nextSongId() {
    if (!this.current) return null;
    const ids = this.activeSetlist().songIds.filter((id) => this.songs.has(id));
    const index = ids.indexOf(this.current.song.id);
    return index >= 0 && index + 1 < ids.length ? ids[index + 1] : null;
  }

  previousSongId() {
    if (!this.current) return null;
    const ids = this.activeSetlist().songIds.filter((id) => this.songs.has(id));
    const index = ids.indexOf(this.current.song.id);
    return index > 0 ? ids[index - 1] : null;
  }

  // Decodifica todas las pistas de una canción y deja un reproductor listo para sonar. `job` (opcional)
  // permite cancelar la preparación, subirle la prioridad y seguir su avance.
  async prepare(song, job = null) {
    const engine = this.engine;
    const signature = decodeSignature(song);
    const stopped = () => Boolean(job && job.cancelled);
    const [voices] = await Promise.all([
      engine.loadVoices(this.settings.guideLang).catch(() => new Map()),
      this.ensureClickSound(song.click.sound),
    ]);
    if (stopped()) throw new Cancelled();
    const files = await store.getMany('files', song.tracks.map((track) => track.fileId));
    if (stopped()) throw new Cancelled();
    const buffers = new Map();
    const failed = [];
    // Frecuencias de las pistas que no se pudieron leer directo por no coincidir con la de la salida de audio.
    const converted = new Map();
    const queue = song.tracks.map((track, index) => ({ track, file: files[index] }));
    const total = queue.length;
    let done = 0;
    if (job) job.total = total;
    const worker = async () => {
      while (queue.length && !stopped()) {
        const item = queue.shift();
        try {
          if (!item.file) throw new Error('archivo no encontrado');
          const notes = {};
          let buffer = await engine.decode(item.file.blob, { cancelled: stopped, notes });
          if (notes.rate) converted.set(notes.rate, (converted.get(notes.rate) || 0) + 1);
          if (item.track.mono && buffer.numberOfChannels > 1) buffer = engine.monoDownmix(buffer);
          buffers.set(item.track.id, buffer);
          item.track.duration = buffer.duration;
        } catch (error) {
          failed.push(item.track.name);
        }
        done++;
        if (job) {
          job.done = done;
          job.label = item.track.name;
          try {
            if (job.onProgress) job.onProgress(done, total, item.track.name);
          } catch (error) {
            console.error(error);
          }
        }
      }
    };
    // Los trabajadores se reparten la cola. Si alguien se queda esperando esta canción, `boost` suma más.
    const pool = new Set();
    const launch = () => {
      const limit = Math.min(job ? job.decoders : BACKGROUND_DECODERS, total);
      while (pool.size < limit && queue.length && !stopped()) {
        const running = worker().finally(() => pool.delete(running));
        pool.add(running);
      }
    };
    if (job) job.boost = launch;
    launch();
    while (pool.size) await Promise.all(Array.from(pool));
    if (job) job.boost = null;
    if (stopped()) throw new Cancelled();
    if (!buffers.size) throw new Error('No se pudo leer ninguna pista de esta canción. Revisa el formato de los archivos');
    this.saveSong(song, true).catch(() => {});
    for (const track of song.tracks) track.solo = false;
    song.click.solo = false;
    song.guide.solo = false;
    const player = engine.createPlayer(song, buffers, voices);
    // De la más frecuente a la menos: { from: [[Hz, pistas], …], to: Hz de la salida } o null si todo se leyó directo.
    const resampled = converted.size ? { from: Array.from(converted).sort((a, b) => b[1] - a[1]), to: engine.ctx.sampleRate } : null;
    const entry = { song, player, failed, signature, bytes: player.memoryBytes(), resampled };
    player.on('state', () => this.emit('transport', entry));
    player.on('loop', () => this.emit('transport', entry));
    player.on('ended', () => this.handleEnded(entry));
    // El dibujo de la onda queda calculado aquí, en segundo plano, y no al cambiar de canción.
    try {
      player.peaks();
    } catch (error) {
      void error;
    }
    return entry;
  }

  // Cambia de canción. Si ya está decodificada en memoria (la siguiente del setlist, o la que se acaba de dejar)
  // el cambio es inmediato: no hay pantalla de carga, no se cierra el modo escenario y no se espera a nada.
  // Si no, se decodifica con el avance a la vista y con todos los núcleos disponibles.
  async loadSong(id, { autoplay = false, force = false } = {}) {
    const song = this.songs.get(id);
    if (!song) return;
    if (!force && this.current && this.current.song.id === id) {
      if (autoplay) await this.play();
      return;
    }
    const token = ++this.loadToken;
    this.wantedId = id;
    try {
      this.cancelAdvance();
      if (force) this.invalidateSong(id);
      // Lo que se preparaba para otra canción deja de importar: toda la máquina se dedica a esta.
      for (const job of Array.from(this.jobs.values())) if (job.id !== id) this.cancelJob(job);
      let entry = this.takeReady(id);
      const waited = !entry;
      if (!entry) entry = await this.loadCold(song, token);
      if (!entry) return;
      // Un click de muestra que se eligió en el editor después de preparar la canción: se espera a que cargue.
      if (isSampleSound(song.click.sound) && !this.engine.clickBank) {
        await this.ensureClickSound(song.click.sound);
        if (token !== this.loadToken) {
          this.addWarm(entry);
          return;
        }
      }
      this.settle(entry);
      this.becomeCurrent(entry);
      this.endLoading();
      if (entry.failed.length) this.toast(`No se pudieron leer: ${entry.failed.join(', ')}`, 'error');
      if (waited) this.explainConversion(entry);
      this.warmUp();
      if (autoplay) await this.play();
    } finally {
      if (token === this.loadToken) this.wantedId = null;
    }
  }

  // Camino lento: la canción no está lista en memoria. Se muestra el avance y se espera a que termine su
  // decodificación; si ya estaba en marcha como precarga se aprovecha lo avanzado y se acelera.
  async loadCold(song, token) {
    const id = song.id;
    const old = this.current;
    // Lo que sonaba se deja guardado en memoria solo si cabe junto con la canción que se va a cargar.
    const need = this.estimateBytes(song) || (old ? old.bytes : 0);
    const keep = Boolean(old) && old.song.id !== id && this.settings.preloadNext && old.bytes + need <= this.warmBudget();
    this.loading = { song, done: 0, total: song.tracks.length, label: '' };
    this.unloadCurrent({ keep, loading: true });
    this.makeRoom(need);
    this.emit('loading', this.loading);
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = this.jobs.get(id) || this.startJob(song, { foreground: true });
      job.claimed = true;
      job.decoders = FOREGROUND_DECODERS;
      job.onProgress = (done, total, label) => {
        if (token !== this.loadToken) return;
        this.loading = { song, done, total, label };
        this.emit('loading', this.loading);
      };
      if (job.done > 0) job.onProgress(job.done, job.total, job.label);
      if (job.boost) job.boost();
      try {
        await job.promise;
      } catch (error) {
        if (token !== this.loadToken) return null;
        // La canción cambió mientras se decodificaba: lo decodificado ya no vale, se empieza de nuevo.
        if (error && error.cancelled) continue;
        this.endLoading();
        this.toast(error.message, 'error');
        return null;
      }
      if (token !== this.loadToken) return null;
      const entry = this.takeReady(id);
      if (entry) return entry;
    }
    if (token === this.loadToken) {
      this.endLoading();
      this.toast('No se pudo preparar la canción. Inténtalo de nuevo', 'error');
    }
    return null;
  }

  // Un WAV a la misma frecuencia que la salida de audio se lee directo (ver wav.js); a otra frecuencia lo remuestrea
  // decodeAudioData, que tarda más y además convierte el audio. Cuando alguien tuvo que esperar por eso se explica,
  // una sola vez por combinación de frecuencias y sesión. En el móvil no se avisa: allí la salida no se puede cambiar.
  explainConversion(entry) {
    const info = entry.resampled;
    if (!info || MOBILE) return;
    const [rate] = info.from[0];
    const key = `${rate}>${info.to}`;
    if (this.conversionNotes.has(key)) return;
    this.conversionNotes.add(key);
    this.toast(
      `Las pistas de «${entry.song.title}» están a ${rate} Hz y la salida de audio de este equipo trabaja a ${info.to} Hz, así que se convierten al cargar y tarda más. Con la salida del equipo en ${rate} Hz (y abriendo Escena de nuevo) se leen directo.`,
      'info',
      14000
    );
  }

  endLoading() {
    if (!this.loading) return;
    this.loading = null;
    this.emit('loading', null);
  }

  // Pasa a ser la canción actual. Lo que sonaba se guarda listo en memoria si cabe, o se libera.
  becomeCurrent(entry) {
    this.warm.delete(entry.song.id);
    const old = this.current;
    this.current = entry;
    this.loopMode = false;
    if (old && old !== entry) this.retire(old);
    store.setMeta('last', { songId: entry.song.id }).catch(() => {});
    this.emit('song:loaded', entry);
  }

  // Pone al día una canción que esperaba lista en memoria: empieza sin solos y recoge lo que se haya
  // editado mientras tanto (tempo, marcadores, click, volúmenes, idioma de la guía).
  settle(entry) {
    const song = entry.song;
    for (const track of song.tracks) track.solo = false;
    song.click.solo = false;
    song.guide.solo = false;
    entry.player.syncWithSong(this.guideVoices);
  }

  // La canción que se deja: si puede hacer falta de nuevo (volver atrás) queda lista en memoria; si no, se libera.
  retire(entry) {
    entry.player.rewind();
    if (this.settings.preloadNext && this.songs.get(entry.song.id) === entry.song) this.addWarm(entry);
    else entry.player.dispose();
  }

  unloadCurrent({ keep = false, loading = false } = {}) {
    const entry = this.current;
    if (!entry) return;
    this.current = null;
    if (keep) this.retire(entry);
    else entry.player.dispose();
    this.emit('song:unloaded', { loading });
  }

  async reloadIfCurrent(id) {
    // Lo que hubiera decodificado de esa canción (aunque esté en espera) ya no corresponde a sus pistas.
    this.invalidateSong(id);
    if (!this.current || this.current.song.id !== id) {
      this.warmUp();
      return;
    }
    const before = this.current.player;
    const resume = { time: before.position(), playing: before.state === 'playing' };
    await this.loadSong(id, { force: true });
    const after = this.current && this.current.song.id === id ? this.current.player : null;
    if (!after) return;
    if (resume.time > 0.05) after.seek(resume.time, 'now');
    if (resume.playing) await after.play({ countIn: false });
  }

  // --- Canciones listas en memoria ---------------------------------------------------------------
  //
  // Decodificar todas las pistas de una canción lleva segundos, y con ella en pantalla esperando eso es
  // justo lo que no se puede permitir en vivo. Por eso la canción que sigue en el setlist se prepara en
  // segundo plano mientras suena la actual, y la que se acaba de dejar se conserva por si hay que volver.
  // Todo cabe en un presupuesto de memoria; la que sigue nunca se descarta.

  warmBudget() {
    const override = Number(this.settings.warmBudgetMB);
    if (override > 0) return override * 1048576;
    if (MOBILE) return 0;
    return clamp((Number(navigator.deviceMemory) || 4) * 0.45, 1, 4) * GB;
  }

  // Memoria que ocupará la canción una vez decodificada (0 si aún no se sabe cuánto duran sus pistas).
  estimateBytes(song) {
    const rate = this.engine.ctx.sampleRate || 48000;
    let total = 0;
    for (const track of song.tracks) total += (track.duration || 0) * rate * (track.mono ? 1 : 2) * 4;
    return total;
  }

  // Las canciones que no se pueden descartar: la que sigue y la que se está cargando.
  pinnedIds() {
    return new Set([this.nextSongId(), this.wantedId].filter(Boolean));
  }

  // ¿Sigue valiendo lo decodificado? No si la canción se editó (pistas, archivos, mono) o se reemplazó.
  isFresh(entry) {
    const song = this.songs.get(entry.song.id);
    return Boolean(song) && song === entry.song && !entry.player.disposed && decodeSignature(song) === entry.signature;
  }

  // Saca de la memoria en espera la canción pedida, si está y sigue valiendo.
  takeReady(id) {
    const entry = this.warm.get(id);
    if (!entry) return null;
    this.warm.delete(id);
    if (!this.isFresh(entry)) {
      entry.player.dispose();
      this.emit('warm');
      return null;
    }
    this.emit('warm');
    return entry;
  }

  addWarm(entry) {
    const id = entry.song.id;
    const old = this.warm.get(id);
    if (old && old !== entry) old.player.dispose();
    this.warm.delete(id);
    this.warm.set(id, entry);
    this.enforceBudget();
    this.emit('warm');
  }

  dropWarm(id) {
    const entry = this.warm.get(id);
    if (!entry) return;
    this.warm.delete(id);
    entry.player.dispose();
    this.emit('warm');
  }

  // Libera lo que sobre (primero lo más antiguo, sin tocar lo fijado) para que quepan `extra` bytes más.
  makeRoom(extra = 0) {
    const budget = this.warmBudget();
    const pinned = this.pinnedIds();
    let used = this.current ? this.current.bytes : 0;
    for (const entry of this.warm.values()) used += entry.bytes;
    for (const id of Array.from(this.warm.keys())) {
      if (used + extra <= budget) break;
      if (pinned.has(id)) continue;
      used -= this.warm.get(id).bytes;
      this.dropWarm(id);
    }
  }

  // De lo que no está fijado se conserva a lo sumo KEPT_BEHIND canciones, y solo si caben en el presupuesto.
  enforceBudget() {
    if (!this.settings.preloadNext) {
      for (const id of Array.from(this.warm.keys())) if (id !== this.wantedId) this.dropWarm(id);
      return;
    }
    const pinned = this.pinnedIds();
    const spare = Array.from(this.warm.keys()).filter((id) => !pinned.has(id));
    while (spare.length > KEPT_BEHIND) this.dropWarm(spare.shift());
    this.makeRoom(0);
  }

  startJob(song, { foreground = false } = {}) {
    const id = song.id;
    const job = {
      id,
      song,
      signature: decodeSignature(song),
      cancelled: false,
      claimed: foreground,
      decoders: foreground ? FOREGROUND_DECODERS : BACKGROUND_DECODERS,
      done: 0,
      total: song.tracks.length,
      label: '',
      onProgress: null,
      boost: null,
      promise: null,
    };
    this.jobs.set(id, job);
    job.promise = this.prepare(song, job).then(
      (entry) => {
        if (this.jobs.get(id) === job) this.jobs.delete(id);
        if (job.cancelled || !this.songs.has(id) || this.songs.get(id) !== song || decodeSignature(song) !== entry.signature) {
          entry.player.dispose();
          this.emit('warm');
          throw new Cancelled();
        }
        this.failed.delete(id);
        this.addWarm(entry);
        return entry;
      },
      (error) => {
        if (this.jobs.get(id) === job) this.jobs.delete(id);
        if (!(error && error.cancelled) && !job.claimed) this.failed.set(id, job.signature);
        this.emit('warm');
        throw error;
      }
    );
    // Una precarga que nadie espera no debe dejar un error sin atender si falla o se cancela.
    job.promise.catch(() => {});
    this.emit('warm');
    return job;
  }

  cancelJob(job) {
    job.cancelled = true;
    if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    this.emit('warm');
  }

  // Lo decodificado de esta canción ya no vale (pistas nuevas o quitadas, archivos reemplazados, canción
  // actualizada desde la nube): se descarta, también lo que estuviera a medias.
  invalidateSong(id) {
    this.failed.delete(id);
    this.dropWarm(id);
    const job = this.jobs.get(id);
    if (job) this.cancelJob(job);
  }

  // Descarta todo lo que esperaba en memoria y cancela las precargas que nadie espera.
  discardWarm() {
    for (const job of Array.from(this.jobs.values())) if (!job.claimed) this.cancelJob(job);
    for (const id of Array.from(this.warm.keys())) if (id !== this.wantedId) this.dropWarm(id);
  }

  // Mantiene lista la canción que sigue en el setlist para que el cambio sea inmediato.
  warmUp() {
    if (!this.settings.preloadNext) {
      this.discardWarm();
      return;
    }
    if (!this.current) return;
    const id = this.nextSongId();
    for (const job of Array.from(this.jobs.values())) if (!job.claimed && job.id !== id) this.cancelJob(job);
    this.enforceBudget();
    if (!id) return;
    const song = this.songs.get(id);
    const ready = this.warm.get(id);
    if (ready) {
      if (this.isFresh(ready)) return;
      this.dropWarm(id);
    }
    if (this.jobs.has(id) || this.failed.get(id) === decodeSignature(song)) return;
    this.startJob(song, { foreground: false });
  }

  // Nombres anteriores de estas dos operaciones.
  discardNext() {
    this.discardWarm();
  }

  preloadNext() {
    this.warmUp();
  }

  // Anula el arranque ya programado de la canción siguiente (Pausa, Detener o cambio manual de canción
  // en los últimos segundos de la actual).
  cancelAdvance() {
    const pending = this.advancing;
    if (!pending) return;
    this.advancing = null;
    pending.entry.player.rewind();
  }

  activate(entry) {
    this.becomeCurrent(entry);
    this.warmUp();
  }

  handleEnded(entry) {
    if (this.advancing && this.advancing.from === entry) return;
    if (this.current !== entry) return;
    this.emit('transport', entry);
    if (this.settings.afterSong === 'next') {
      const id = this.nextSongId();
      if (id) this.loadSong(id, { autoplay: true });
    }
  }

  startTicker() {
    try {
      const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 100)'], { type: 'text/javascript' }));
      this.ticker = new Worker(url);
      this.ticker.onmessage = () => this.tick();
    } catch (error) {
      this.timer = setInterval(() => this.tick(), 100);
    }
  }

  tick() {
    const entry = this.current;
    if (!entry) return;
    const player = entry.player;
    player.poll();
    const now = this.engine.ctx.currentTime;
    if (this.advancing && now >= this.advancing.when - 0.002) {
      const target = this.advancing.entry;
      this.advancing = null;
      this.activate(target);
      return;
    }
    if (!this.advancing && player.state === 'playing' && this.settings.afterSong === 'next' && player.timeToEnd(now) < 1.5) {
      const next = this.next;
      if (!next) return;
      if (!this.isFresh(next)) {
        // Se editó mientras esperaba: ya no sirve. Al terminar esta canción se decodifica de nuevo.
        this.dropWarm(next.song.id);
        this.warmUp();
        return;
      }
      this.settle(next);
      const when = player.endContextTime() + Math.max(0, Number(this.settings.gapSeconds) || 0);
      next.player.playAt(when);
      this.advancing = { entry: next, when, from: entry };
    }
  }

  async play() {
    const player = this.player;
    if (!player) return;
    try {
      await player.play({ countIn: this.settings.autoCountIn && player.state === 'stopped' });
    } catch (error) {
      this.toast(error.message || 'No se pudo activar el audio. Toca Reproducir de nuevo.', 'error');
    }
  }

  pause() {
    this.cancelAdvance();
    if (this.player) this.player.pause();
  }

  async togglePlay() {
    const player = this.player;
    if (!player) return;
    if (player.state === 'playing') {
      this.cancelAdvance();
      player.pause();
    } else await this.play();
  }

  stop() {
    this.cancelAdvance();
    if (this.player) this.player.stop();
  }

  sectionRange(section) {
    return { a: section.start, b: section.end };
  }

  jumpToSection(index) {
    const player = this.player;
    if (!player) return;
    const section = player.sections()[index];
    if (!section) return;
    if (this.loopMode) player.armLoop(this.sectionRange(section));
    player.seekToSection(index, this.settings.jumpMode);
  }

  nextSection() {
    const player = this.player;
    if (!player) return;
    const section = player.sectionAt(player.position());
    if (section.index + 1 < player.sections().length) this.jumpToSection(section.index + 1);
  }

  previousSection() {
    const player = this.player;
    if (!player) return;
    const position = player.position();
    const section = player.sectionAt(position);
    if (position - section.start > 1.5 || section.index === 0) this.jumpToSection(section.index);
    else this.jumpToSection(section.index - 1);
  }

  seekTo(time) {
    const player = this.player;
    if (!player) return;
    const target = player.tempo.nearestBarStart(time - player.offset) + player.offset;
    const section = player.sectionAt(clamp(target, 0, player.duration));
    if (this.loopMode && section) player.armLoop(this.sectionRange(section));
    player.seek(clamp(target, 0, player.duration), this.settings.jumpMode);
  }

  seekExact(time) {
    const player = this.player;
    if (!player) return;
    const target = clamp(time, 0, player.duration);
    const section = player.sectionAt(target);
    if (this.loopMode && section) player.armLoop(this.sectionRange(section));
    player.seek(target, 'now');
  }

  toggleLoop() {
    const player = this.player;
    if (!player) return;
    this.loopMode = !this.loopMode;
    if (this.loopMode) {
      const section = player.sectionAt(player.position());
      if (player.state === 'playing') player.setLoop(this.sectionRange(section));
      else player.armLoop(this.sectionRange(section));
    } else {
      player.setLoop(null);
    }
    this.emit('transport', this.current);
  }

  toggleTrackFlag(trackNode, flag) {
    trackNode.def[flag] = !trackNode.def[flag];
    if (flag === 'solo') this.player.refreshSolo();
    else trackNode.applyGain();
    this.persistSongSoon(this.current.song);
    this.emit('track', trackNode);
  }

  toggleClick() {
    if (this.player) this.toggleTrackFlag(this.player.click, 'mute');
  }

  toggleGuide() {
    if (this.player) this.toggleTrackFlag(this.player.guide, 'mute');
  }

  async nextSong() {
    const id = this.nextSongId() || (this.current ? null : this.activeSetlist().songIds.find((songId) => this.songs.has(songId)));
    if (id) await this.loadSong(id, { autoplay: this.player ? this.player.state === 'playing' : false });
  }

  async previousSong() {
    const id = this.previousSongId();
    if (id) await this.loadSong(id, { autoplay: this.player ? this.player.state === 'playing' : false });
  }

  async goToSetlistIndex(index) {
    const ids = this.activeSetlist().songIds.filter((id) => this.songs.has(id));
    if (ids[index]) await this.loadSong(ids[index], { autoplay: false });
  }

  snapshot() {
    const player = this.player;
    if (!player) return null;
    const time = player.position();
    const grid = time - player.offset;
    const position = player.tempo.position(grid);
    const sections = player.sections();
    const section = player.sectionAt(time);
    const next = sections[section.index + 1] || null;
    const barsToNext = next ? Math.max(0, next.bar - position.bar) : null;
    return {
      time,
      duration: player.duration,
      bar: position.bar,
      beat: position.beat,
      bpm: position.segment.bpm,
      signature: `${position.segment.num}/${position.segment.den}`,
      beats: position.segment.num,
      section,
      next,
      barsToNext,
      state: player.state,
      counting: player.isCountingIn(),
      loop: player.loop,
      beatFraction: position.fraction,
      countIn: player.countIn(),
      jump: player.jumpTarget() === null ? null : player.sectionAt(player.jumpTarget()).index,
    };
  }

  runAction(id) {
    const sectionPrefix = this.current && `section:${this.current.song.id}:`;
    if (sectionPrefix && id.startsWith(sectionPrefix)) {
      const markerId = id.slice(sectionPrefix.length);
      const index = this.player.sections().findIndex((section) => section.id === markerId);
      if (index >= 0) return this.jumpToSection(index);
      return;
    }
    switch (id) {
      case 'playPause':
        return this.togglePlay();
      case 'play':
        return this.play();
      case 'pause':
        return this.pause();
      case 'stop':
        return this.stop();
      case 'nextSection':
        return this.nextSection();
      case 'prevSection':
        return this.previousSection();
      case 'nextSong':
        return this.nextSong();
      case 'prevSong':
        return this.previousSong();
      case 'toggleClick':
        return this.toggleClick();
      case 'toggleGuide':
        return this.toggleGuide();
      case 'toggleLoop':
        return this.toggleLoop();
      default:
        return undefined;
    }
  }
}

export const app = new App();
