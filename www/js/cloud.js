import { app } from './app.js';
import { store } from './store.js';
import { normalizeSong, serializableSong } from './library.js';
import { createEmitter, fmtBytes } from './util.js';
import { CLOUD_API_URL } from './cloud-config.js';
import { cloudRequest, TRANSFER_ATTEMPTS } from './cloud-request.js';

const CHUNK = 8 * 1024 * 1024;
const newId = () => crypto.randomUUID();
const stopError = () => new DOMException('Transferencia pausada', 'AbortError');
const hash = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
function normalizeUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Usa una dirección HTTPS válida para tu nube');
  if (url.pathname !== '/') throw new Error('La dirección debe terminar en el dominio, sin rutas');
  return url.origin;
}
function validateDownload(m) {
  const id = /^[a-zA-Z0-9_-]{8,80}$/;
  if (m?.schema !== 1 || m.chunkSize !== CHUNK || !id.test(m.id) || !id.test(m.revision) || !Array.isArray(m.files) || !m.files.length || m.files.length > 128 || !Array.isArray(m.song?.tracks) || m.song.tracks.length !== m.files.length) throw new Error('La canción en la nube tiene un formato no compatible');
  const ids = new Set();
  for (const file of m.files) {
    if (!id.test(file.id) || ids.has(file.id) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 5 * 1024 ** 3 || !Array.isArray(file.hashes) || file.hashes.length !== Math.ceil(file.size / CHUNK) || file.hashes.some(h => !/^[a-f0-9]{64}$/.test(h))) throw new Error('La canción en la nube está incompleta');
    ids.add(file.id);
  }
  if (m.song.tracks.some(track => !ids.has(track.id)) || new Set(m.song.tracks.map(t => t.id)).size !== ids.size) throw new Error('Las pistas de la canción no coinciden');
  return m;
}

class Cloud {
  constructor() {
    this.bus = createEmitter(); this.api = ''; this.key = ''; this.ready = false;
    this.catalog = []; this.active = null; this.progress = null; this.retry = null; this.loading = false;
    this.initPromise = null;
  }
  on(name, fn) { return this.bus.on(name, fn); }
  emit() { this.bus.emit('change'); }
  init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.api = CLOUD_API_URL.trim() || await store.getMeta('cloudApi', '');
      if (this.api) this.api = normalizeUrl(this.api);
      try { this.key = sessionStorage.getItem(`escena-cloud:${this.api}`) || ''; } catch { /* solo memoria */ }
      this.catalog = await store.getMeta(`cloudCatalog:${this.api}`, []);
      this.ready = true; this.emit();
    })();
    return this.initPromise;
  }
  get connected() { return Boolean(this.api && this.key); }
  async connect(api, key) {
    if (this.active) throw new Error('Pausa la transferencia antes de cambiar de nube');
    const target = normalizeUrl(api.trim()), secret = key.trim();
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('La clave debe tener 64 caracteres. Usa la generada durante la configuración.');
    const old = { api: this.api, key: this.key };
    this.api = target; this.key = secret;
    try { await this.request('/v1/ping'); }
    catch (error) { Object.assign(this, old); throw error; }
    await store.setMeta('cloudApi', target);
    try { if (old.api !== target) sessionStorage.removeItem(`escena-cloud:${old.api}`); sessionStorage.setItem(`escena-cloud:${target}`, secret); } catch { /* solo memoria */ }
    this.catalog = await store.getMeta(`cloudCatalog:${target}`, []);
    this.emit();
    await this.refresh();
  }
  disconnect() {
    this.pause();
    try { sessionStorage.removeItem(`escena-cloud:${this.api}`); } catch { /* solo memoria */ }
    this.key = ''; this.emit();
  }
  async request(path, { method = 'GET', data, bytes, headers = {}, signal, binary = false } = {}) {
    if (!this.connected) throw new Error('Conecta tu nube para continuar');
    const transferring = Boolean(signal && this.active?.controller.signal === signal);
    return cloudRequest(this.api + path, {
      method, data, bytes, headers: { Authorization: `Bearer ${this.key}`, ...headers }, signal, binary,
      maxAttempts: transferring ? TRANSFER_ATTEMPTS : 3,
      onRetry: transferring ? retry => { this.retry = retry; this.emit(); } : undefined,
    });
  }
  async refresh() {
    if (!this.connected) return;
    this.loading = true; this.emit();
    try {
      const songs = []; let cursor;
      do {
        const page = await this.request('/v1/songs' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
        songs.push(...page.songs); cursor = page.cursor;
      } while (cursor);
      this.catalog = songs.sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }));
      await store.setMeta(`cloudCatalog:${this.api}`, this.catalog);
    } finally { this.loading = false; this.emit(); }
  }
  local(id) { return app.songList().find(song => song.cloud?.endpoint === this.api && song.cloud?.id === id); }
  async pending() { return (await store.all('cloudTransfers')).filter(job => job.endpoint === this.api); }
  pause() { this.active?.controller.abort(); }
  async exclusive(operation) {
    if (this.reserved || this.active) throw new Error('Ya hay una transferencia en curso');
    this.reserved = true;
    try {
      if (navigator.locks) return await navigator.locks.request('escena-cloud-transfer', { ifAvailable: true }, lock => {
        if (!lock) throw new Error('Hay una transferencia abierta en otra pestaña de Escena');
        return operation();
      });
      return await operation();
    } finally { this.reserved = false; }
  }
  completedBytes(job) {
    const done = job.kind === 'upload' ? job.files.reduce((sum, file) => sum + (file.done ? file.size : Math.min(file.size, file.parts.length * CHUNK)), 0)
      : job.manifest.files.reduce((sum, file) => sum + Math.min(file.size, (job.counts[file.id] || 0) * CHUNK), 0);
    return done;
  }
  notify(job, label) {
    const done = this.completedBytes(job);
    this.progress = { id: job.id, kind: job.kind, title: job.title, total: job.total, done, label };
    this.emit();
  }
  async run(job, operation) {
    if (this.active) throw new Error('Ya hay una transferencia. Espera o páusala.');
    if (!this.connected) throw new Error('Conecta tu nube para continuar');
    const controller = new AbortController(); this.active = { id: job.id, controller };
    let wake;
    try {
      delete job.lastError;
      await store.put('cloudTransfers', job);
      wake = await navigator.wakeLock?.request('screen').catch(() => null);
      await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) app.toast('Transferencia pausada. Puedes reanudarla desde Nube.');
      else {
        if (error.name === 'QuotaExceededError') error = new Error('No hay espacio suficiente en este dispositivo. Libera espacio y reanuda la transferencia.');
        const detail = { message: error.message || 'No se pudo completar la transferencia.', status: error.status || null, code: error.code || null, attempts: error.attempts || 1, label: this.progress?.label || '', at: Date.now() };
        // No recrear una transferencia ya completada si falla la actualización del catálogo.
        const saved = await store.get('cloudTransfers', job.id).catch(() => null);
        if (saved) { saved.lastError = detail; await store.put('cloudTransfers', saved).catch(() => {}); }
        throw error;
      }
    } finally {
      await wake?.release().catch(() => {});
      this.active = null; this.progress = null; this.retry = null; this.emit();
    }
  }
  upload(song, options = {}) { return this.exclusive(() => this.performUpload(song, options)); }
  async performUpload(song, { asNew = false } = {}) {
    await this.init();
    if (!this.connected) throw new Error('Conecta tu nube antes de subir');
    const jobId = `up:${this.api}:${song.id}`;
    let job = await store.get('cloudTransfers', jobId);
    if (!job) {
      const linked = !asNew && song.cloud?.endpoint === this.api;
      const snapshot = serializableSong(song); delete snapshot.cloud;
      job = { id: jobId, kind: 'upload', endpoint: this.api, localId: song.id, title: song.title, songId: linked ? song.cloud.id : newId(), revision: newId(), expectedRevision: linked ? song.cloud.revision : null, song: snapshot, files: [], total: 0 };
      for (const track of snapshot.tracks) {
        const file = await store.get('files', track.fileId);
        if (!file?.blob || !file.blob.size) throw new Error(`No se encontró el audio de «${track.name}»`);
        if (file.blob.size > 5 * 1024 ** 3) throw new Error('Cada pista debe ocupar como máximo 5 GiB');
        job.files.push({ id: track.id, localFileId: track.fileId, name: file.name, type: file.type || 'application/octet-stream', size: file.blob.size, parts: [], hashes: [], done: false });
        job.total += file.blob.size;
      }
      if (!job.files.length || job.files.length > 128) throw new Error('La canción debe tener de 1 a 128 pistas');
      if (linked) {
        const remote = await this.request(`/v1/songs/${job.songId}`);
        if (remote.revision !== job.expectedRevision) throw new Error('La nube tiene otra versión. Actualiza tu copia o usa «Subir como nueva».');
      }
      await store.put('cloudTransfers', job);
    }
    return this.run(job, async signal => {
      for (const file of job.files) {
        if (signal.aborted) throw stopError();
        this.notify(job, file.name);
        if (file.done) continue;
        const local = await store.get('files', file.localFileId);
        if (!local?.blob || local.blob.size !== file.size) throw new Error('Cambió el archivo local. Descarta la subida pendiente y vuelve a subir la canción.');
        const data = { songId: job.songId, revision: job.revision, trackId: file.id, size: file.size };
        if (!file.uploadId) {
          const start = await this.request('/v1/uploads/start', { method: 'POST', data, signal });
          if (start.complete) { file.done = true; await store.put('cloudTransfers', job); continue; }
          file.uploadId = start.uploadId; await store.put('cloudTransfers', job);
        }
        for (let part = file.parts.length; part < Math.ceil(file.size / CHUNK); part++) {
          if (signal.aborted) throw stopError();
          const bytes = await local.blob.slice(part * CHUNK, Math.min(file.size, (part + 1) * CHUNK)).arrayBuffer();
          const checksum = await hash(bytes);
          const query = new URLSearchParams({ ...data, uploadId: file.uploadId, part: String(part + 1) });
          const result = await this.request(`/v1/uploads/part?${query}`, { method: 'PUT', bytes, signal, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': checksum } });
          file.parts.push(result); file.hashes.push(checksum);
          await store.put('cloudTransfers', job); this.notify(job, file.name);
        }
        await this.request('/v1/uploads/complete', { method: 'POST', data: { ...data, uploadId: file.uploadId, parts: file.parts }, signal });
        file.done = true; await store.put('cloudTransfers', job);
      }
      const manifest = { schema: 1, chunkSize: CHUNK, id: job.songId, revision: job.revision, song: job.song, files: job.files.map(({ id, name, type, size, hashes }) => ({ id, name, type, size, hashes })) };
      this.notify(job, 'Publicando canción…');
      await this.request(`/v1/songs/${job.songId}/publish`, { method: 'POST', data: { manifest, expectedRevision: job.expectedRevision }, signal });
      const current = app.songs.get(job.localId);
      if (current) { current.cloud = { endpoint: this.api, id: job.songId, revision: job.revision }; await app.saveSong(current); }
      await store.remove('cloudTransfers', job.id);
      app.toast('Canción guardada en tu nube');
      await this.refresh();
    });
  }
  download(id, resumeJob = null) { return this.exclusive(() => this.performDownload(id, resumeJob)); }
  async performDownload(id, resumeJob = null) {
    await this.init();
    let job = resumeJob;
    if (!job) {
      const manifest = validateDownload(await this.request(`/v1/songs/${id}`));
      const jobId = `down:${this.api}:${id}:${manifest.revision}`;
      job = await store.get('cloudTransfers', jobId);
      if (!job) {
        const existing = this.local(id);
        const token = newId();
        job = { id: jobId, token, kind: 'download', endpoint: this.api, title: manifest.song.title, manifest, localId: existing?.id || newId(), counts: {}, completed: {}, total: manifest.files.reduce((sum, file) => sum + file.size, 0) };
        await store.put('cloudTransfers', job);
      }
    }
    validateDownload(job.manifest);
    if (app.current?.song.id === job.localId && app.player?.state === 'playing') throw new Error('Detén la canción antes de actualizarla');
    return this.run(job, async signal => {
      const manifest = job.manifest;
      const left = manifest.files.reduce((sum, file) => sum + Math.max(0, file.size - (job.counts[file.id] || 0) * CHUNK), 0);
      const largest = Math.max(...manifest.files.filter(file => !job.completed[file.id]).map(file => file.size), 0);
      const usage = await store.usage();
      const needed = left + largest + 32 * 1024 ** 2;
      if (usage.quota && usage.quota - usage.used < needed) throw new Error(`Necesitas aproximadamente ${fmtBytes(needed)} libres para completar esta descarga y sus archivos temporales.`);
      for (const file of manifest.files) {
        if (signal.aborted) throw stopError();
        this.notify(job, file.name);
        const localFileId = `cloud-${job.token}-${file.id}`;
        if (job.completed[file.id]) continue;
        const saved = await store.get('files', localFileId);
        if (saved?.blob?.size === file.size) {
          job.completed[file.id] = localFileId; job.counts[file.id] = file.hashes.length;
          await store.put('cloudTransfers', job); await store.clearPrefix('cloudChunks', `${job.token}:${file.id}:`); continue;
        }
        for (let part = job.counts[file.id] || 0; part < file.hashes.length; part++) {
          if (signal.aborted) throw stopError();
          const start = part * CHUNK, end = Math.min(file.size, start + CHUNK) - 1;
          const response = await this.request(`/v1/audio/${manifest.id}/${manifest.revision}/${file.id}`, { binary: true, signal, headers: { Range: `bytes=${start}-${end}` } });
          if (response.status !== 206 || response.range !== `bytes ${start}-${end}/${file.size}` || response.bytes.byteLength !== end - start + 1 || await hash(response.bytes) !== file.hashes[part]) throw new Error(`La pista «${file.name}» no pasó la verificación. Reanuda para reintentar esta parte.`);
          await store.put('cloudChunks', { id: `${job.token}:${file.id}:${part}`, blob: new Blob([response.bytes]) });
          job.counts[file.id] = part + 1;
          await store.put('cloudTransfers', job); this.notify(job, file.name);
        }
        this.notify(job, `Guardando ${file.name}…`);
        const blobs = [];
        for (let part = 0; part < file.hashes.length; part++) {
          const row = await store.get('cloudChunks', `${job.token}:${file.id}:${part}`);
          if (!row) { job.counts[file.id] = part; await store.put('cloudTransfers', job); throw new Error('Falta una parte guardada. Reanuda para recuperarla.'); }
          blobs.push(row.blob);
        }
        const blob = new Blob(blobs, { type: file.type });
        if (blob.size !== file.size) throw new Error('El tamaño de la pista no coincide');
        await store.put('files', { id: localFileId, name: file.name, size: file.size, type: file.type, blob });
        job.completed[file.id] = localFileId;
        await store.put('cloudTransfers', job);
        await store.clearPrefix('cloudChunks', `${job.token}:${file.id}:`);
      }
      if (signal.aborted) throw stopError();
      if (app.current?.song.id === job.localId && app.player?.state === 'playing') throw new Error('La descarga está completa. Detén la canción y reanuda para aplicar la actualización.');
      const old = app.songs.get(job.localId);
      const song = normalizeSong({ ...manifest.song, id: job.localId, tracks: manifest.song.tracks.map(track => ({ ...track, fileId: job.completed[track.id] })), cloud: { endpoint: this.api, id: manifest.id, revision: manifest.revision } });
      // Evita que un guardado pendiente del editor sobrescriba la versión recibida.
      await app.persistSongSoon.flushPending?.();
      await store.commitCloudSong(serializableSong(song), old?.tracks.map(track => track.fileId) || [], job.id);
      if (app.current?.song.id === song.id) app.unloadCurrent();
      // Lo que hubiera decodificado de la versión anterior ya no sirve.
      app.invalidateSong(song.id);
      app.songs.set(song.id, song); app.emit('songs'); app.emit('setlists');
      app.warmUp();
      app.toast('Canción descargada. Ya está en tu biblioteca.');
    });
  }
  async resume(job) {
    if (job.kind === 'download') return this.download(job.manifest.id, job);
    const song = app.songs.get(job.localId);
    if (!song) throw new Error('La canción local ya no existe. Descarta esta subida.');
    return this.upload(song);
  }
  discard(job) { return this.exclusive(() => this.performDiscard(job)); }
  async performDiscard(job) {
    if (this.active) throw new Error('Pausa la transferencia antes de descartarla');
    if (job.kind === 'upload') await this.request('/v1/uploads/discard', { method: 'POST', data: { songId: job.songId, revision: job.revision, files: job.files.map(file => ({ id: file.id, uploadId: file.uploadId })) } });
    else {
      await store.clearPrefix('cloudChunks', `${job.token}:`);
      for (const file of job.manifest.files) await store.remove('files', `cloud-${job.token}-${file.id}`);
    }
    await store.remove('cloudTransfers', job.id); this.emit();
  }
}
export const cloud = new Cloud();
