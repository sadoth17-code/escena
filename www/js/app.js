import { createEmitter, debounce, isIOS, clamp } from './util.js';
import { store } from './store.js';
import { Engine, DEFAULT_OUTPUT, normalizeRoutes } from './engine.js';
import { normalizeSong, serializableSong, createSong, createTrackDef, createSetlist } from './library.js';
import { normalizeTempoEntries, detectTempoFromBuffer } from './tempo.js';
import { renderPreview } from './synth.js';

const MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || isIOS();

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
};

function mergeSettings(saved) {
  const merged = { ...DEFAULT_SETTINGS, ...saved };
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
    this.next = null;
    this.advancing = null;
    this.preloading = null;
    this.loading = null;
    this.loadToken = 0;
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

  toast(message, kind = 'info') {
    this.emit('toast', { message, kind });
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

  setSetting(key, value) {
    this.settings[key] = value;
    this.saveSettings();
    this.emit('settings', key);
  }

  resetSettings() {
    this.settings = mergeSettings({});
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
    const voices = await this.engine.loadVoices();
    const data = voices.get(key);
    if (!data) return;
    const ctx = this.engine.ctx;
    const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buffer.copyToChannel(data, 0);
    await this.engine.previewBuffer(buffer, 'cue');
  }

  async previewSound(sound) {
    await this.engine.previewBuffer(renderPreview(this.engine.ctx, sound), 'cue');
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
    if (this.next && this.next.song.id === id) this.discardNext();
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
    this.discardNext();
    this.emit('setlists');
    this.preloadNext();
  }

  async saveSetlist(setlist) {
    await store.put('setlists', setlist);
    this.emit('setlists');
    this.discardNext();
    this.preloadNext();
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

  async prepare(song, onProgress) {
    const engine = this.engine;
    const voices = await engine.loadVoices().catch(() => new Map());
    const files = await store.getMany('files', song.tracks.map((track) => track.fileId));
    const buffers = new Map();
    const failed = [];
    const queue = song.tracks.map((track, index) => ({ track, file: files[index] }));
    const total = queue.length;
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const job = queue.shift();
        try {
          if (!job.file) throw new Error('archivo no encontrado');
          let buffer = await engine.decode(job.file.blob);
          if (job.track.mono && buffer.numberOfChannels > 1) buffer = engine.monoDownmix(buffer);
          buffers.set(job.track.id, buffer);
          job.track.duration = buffer.duration;
        } catch (error) {
          failed.push(job.track.name);
        }
        done++;
        if (onProgress) onProgress(done, total, job.track.name);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MOBILE ? 1 : 2, total) }, worker));
    if (!buffers.size) throw new Error('No se pudo leer ninguna pista de esta canción. Revisa el formato de los archivos');
    this.saveSong(song, true).catch(() => {});
    for (const track of song.tracks) track.solo = false;
    song.click.solo = false;
    song.guide.solo = false;
    const player = engine.createPlayer(song, buffers, voices);
    const entry = { song, player, failed };
    player.on('state', () => this.emit('transport', entry));
    player.on('loop', () => this.emit('transport', entry));
    player.on('ended', () => this.handleEnded(entry));
    return entry;
  }

  async loadSong(id, { autoplay = false, force = false } = {}) {
    const song = this.songs.get(id);
    if (!song) return;
    if (!force && this.current && this.current.song.id === id) {
      if (autoplay) await this.play();
      return;
    }
    const token = ++this.loadToken;
    this.advancing = null;
    this.unloadCurrent();
    let entry;
    if (this.next && this.next.song.id === id) {
      entry = this.next;
      this.next = null;
    } else {
      this.loading = { song, done: 0, total: song.tracks.length, label: '' };
      this.emit('loading', this.loading);
      try {
        entry = await this.prepare(song, (done, total, label) => {
          if (token !== this.loadToken) return;
          this.loading = { song, done, total, label };
          this.emit('loading', this.loading);
        });
      } catch (error) {
        if (token === this.loadToken) {
          this.loading = null;
          this.emit('loading', null);
          this.toast(error.message, 'error');
        }
        return;
      }
      if (token !== this.loadToken) {
        entry.player.dispose();
        return;
      }
    }
    this.loading = null;
    this.emit('loading', null);
    this.current = entry;
    this.loopMode = false;
    if (entry.failed.length) this.toast(`No se pudieron leer: ${entry.failed.join(', ')}`, 'error');
    store.setMeta('last', { songId: id }).catch(() => {});
    this.emit('song:loaded', entry);
    this.preloadNext();
    if (autoplay) await this.play();
  }

  unloadCurrent() {
    if (!this.current) return;
    this.current.player.dispose();
    this.current = null;
    this.emit('song:unloaded');
  }

  async reloadIfCurrent(id) {
    if (!this.current || this.current.song.id !== id) return;
    const before = this.current.player;
    const resume = { time: before.position(), playing: before.state === 'playing' };
    await this.loadSong(id, { force: true });
    const after = this.current && this.current.song.id === id ? this.current.player : null;
    if (!after) return;
    if (resume.time > 0.05) after.seek(resume.time, 'now');
    if (resume.playing) await after.play({ countIn: false });
  }

  discardNext() {
    if (this.next) {
      this.next.player.dispose();
      this.next = null;
    }
    this.preloading = null;
  }

  async preloadNext() {
    if (!this.settings.preloadNext || !this.current) return;
    const id = this.nextSongId();
    if (!id || (this.next && this.next.song.id === id) || this.preloading === id) return;
    this.discardNext();
    this.preloading = id;
    try {
      const entry = await this.prepare(this.songs.get(id));
      if (this.preloading !== id || this.nextSongId() !== id) {
        entry.player.dispose();
        return;
      }
      this.next = entry;
    } catch (error) {
      console.warn(error);
    } finally {
      if (this.preloading === id) this.preloading = null;
    }
  }

  activate(entry) {
    const old = this.current;
    this.current = entry;
    this.next = null;
    this.loopMode = false;
    if (old && old !== entry) old.player.dispose();
    store.setMeta('last', { songId: entry.song.id }).catch(() => {});
    this.emit('song:loaded', entry);
    this.preloadNext();
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
    if (!this.advancing && player.state === 'playing' && this.settings.afterSong === 'next' && this.next) {
      if (player.timeToEnd(now) < 1.5 && this.next.song.id === this.nextSongId()) {
        const when = player.endContextTime() + Math.max(0, Number(this.settings.gapSeconds) || 0);
        this.next.player.playAt(when);
        this.advancing = { entry: this.next, when, from: entry };
      }
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
    if (this.player) this.player.pause();
  }

  async togglePlay() {
    const player = this.player;
    if (!player) return;
    if (player.state === 'playing') player.pause();
    else await this.play();
  }

  stop() {
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
