import { app } from './app.js';
import { store } from './store.js';
import { normalizeSong, serializableSong } from './library.js';
import { createEmitter, fmtBytes } from './util.js';
import { CLOUD_API_URL } from './cloud-config.js';
import { cloudRequest, TRANSFER_ATTEMPTS } from './cloud-request.js';
import { cloudSongHash } from './cloud-song-state.js';
import { access } from './access.js';

const CHUNK = 8 * 1024 * 1024;
const ONLINE_VERIFICATION_MS = 90000;
const ACCESS_TIMEOUT_MS = 10000;
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

function validateAccess(result) {
  if (result?.accessVersion !== 2) throw Object.assign(new Error('Actualiza el Worker de tu nube para habilitar el control de usuarios antes de iniciar sesión.'), { code: 'ACCESS_VERSION' });
  const user = result.user, permissions = result.permissions;
  if (!user || typeof user.id !== 'string' || !user.id || typeof user.name !== 'string' || !user.name.trim() || !['owner', 'editor', 'player'].includes(user.role) ||
      !Number.isInteger(user.offlineHours) || user.offlineHours < 0 || user.offlineHours > 168 ||
      !permissions || typeof permissions.publish !== 'boolean' || typeof permissions.manageUsers !== 'boolean' ||
      !Number.isSafeInteger(result.serverTime) || result.serverTime <= 0 || !Number.isSafeInteger(result.offlineUntil) || result.offlineUntil < 0 ||
      result.role !== (user.role === 'player' ? 'player' : 'master') ||
      (user.role === 'player' && permissions.publish) || (user.role !== 'owner' && permissions.manageUsers) ||
      result.offlineUntil > result.serverTime + user.offlineHours * 3600000) {
    throw Object.assign(new Error('La nube devolvió un perfil de acceso no válido.'), { code: 'ACCESS_PROFILE' });
  }
  return {
    accessVersion: 2,
    role: result.role,
    user: { id: user.id, name: user.name, role: user.role, offlineHours: user.offlineHours },
    permissions: { publish: permissions.publish, manageUsers: permissions.manageUsers },
    serverTime: result.serverTime,
    offlineUntil: result.offlineUntil,
  };
}
const transientAccessError = error => error.code === 'NETWORK' || error.code === 'TIMEOUT' || (error.status >= 500 && error.status < 600);

class Cloud {
  constructor() {
    this.bus = createEmitter(); this.api = ''; this.key = ''; this.ready = false;
    this.catalog = []; this.active = null; this.progress = null; this.retry = null; this.loading = false;
    this.initPromise = null;
    this._role = null; this.credentialsVerified = false;
    this.identity = null; this.permissions = { publish: false, manageUsers: false };
    this.offlineUntil = 0; this.accessProfile = null; this.fingerprint = ''; this.authEpoch = 0; this.authorizedKey = '';
    this.catalogError = ''; this.offline = false;
    this.verifications = new Set();
  }
  on(name, fn) { return this.bus.on(name, fn); }
  emit() { this.bus.emit('change'); }
  init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.api = CLOUD_API_URL.trim() || await store.getMeta('cloudApi', '');
      if (this.api) this.api = normalizeUrl(this.api);
      try { this.key = sessionStorage.getItem(`escena-cloud:${this.api}`) || ''; } catch { /* solo memoria */ }
      if (/^[a-f0-9]{64}$/.test(this.key)) {
        this.fingerprint = await hash(new TextEncoder().encode(this.key));
        await this.restoreAccess();
      } else {
        this.key = '';
        try { sessionStorage.removeItem(`escena-cloud:${this.api}`); } catch { /* solo memoria */ }
      }
      this.catalog = await store.getMeta(`cloudCatalog:${this.api}`, []);
      this.ready = true; this.emit();
    })();
    return this.initPromise;
  }
  get connected() { return Boolean(this.api && this.key); }
  get role() { return this._role; }
  get onlineAccess() {
    return this.connected && Boolean(this.accessProfile) && this.key === this.authorizedKey && this.accessProfile.api === this.api &&
      this.accessProfile.fingerprint === this.fingerprint && this.credentialsVerified && !this.offline && navigator.onLine !== false &&
      Date.now() - this.accessProfile.verifiedAt < ONLINE_VERIFICATION_MS;
  }
  get offlineLeaseActive() {
    if (!this.connected || !this.accessProfile || this.key !== this.authorizedKey || this.accessProfile.api !== this.api || this.accessProfile.fingerprint !== this.fingerprint) return false;
    // Ajusta la duración concedida por el servidor al reloj local del momento de verificación.
    const expiresAt = this.accessProfile.verifiedAt + Math.max(0, this.offlineUntil - this.accessProfile.serverTime);
    return this.offlineUntil > 0 && expiresAt > Date.now();
  }
  get canAccess() {
    if (!this.connected || !this.accessProfile || !this.identity) return false;
    const verifying = Array.from(this.verifications).some(request => request.epoch === this.authEpoch);
    return this.onlineAccess || ((navigator.onLine === false || this.offline || verifying) && this.offlineLeaseActive);
  }
  get canPublish() { return this.canAccess && this.onlineAccess && this.role === 'master' && this.permissions.publish; }
  get canManageUsers() { return this.canAccess && this.onlineAccess && this.identity?.role === 'owner' && this.permissions.manageUsers; }
  applyAccess(profile, verified = false) {
    this.accessProfile = profile;
    this.authorizedKey = this.key;
    this.identity = profile.user;
    this.permissions = profile.permissions;
    this.offlineUntil = profile.offlineUntil;
    this._role = profile.role;
    this.credentialsVerified = verified;
    this.offline = !verified && navigator.onLine === false;
  }
  async restoreAccess() {
    if (!this.key || !this.fingerprint) return false;
    const api = this.api, key = this.key, fingerprint = this.fingerprint, epoch = this.authEpoch;
    const cached = await store.getMeta(`cloudAccess:${api}:${fingerprint}`, null);
    if (epoch !== this.authEpoch || api !== this.api || key !== this.key || fingerprint !== this.fingerprint) return false;
    if (!cached || cached.api !== api || cached.fingerprint !== fingerprint || !Number.isSafeInteger(cached.verifiedAt) || cached.verifiedAt <= 0) return false;
    try { this.applyAccess({ ...validateAccess(cached), api: cached.api, fingerprint: cached.fingerprint, verifiedAt: cached.verifiedAt }); }
    catch { return false; }
    return this.canAccess;
  }
  async rememberAccess(result, epoch = this.authEpoch) {
    const api = this.api, key = this.key;
    const profile = { ...validateAccess(result), api, fingerprint: this.fingerprint, verifiedAt: Date.now() };
    if (!profile.fingerprint) profile.fingerprint = await hash(new TextEncoder().encode(key));
    if (epoch !== this.authEpoch || api !== this.api || key !== this.key) throw new DOMException('La sesión cambió', 'AbortError');
    await store.setMeta(`cloudAccess:${profile.api}:${profile.fingerprint}`, profile);
    if (epoch !== this.authEpoch || api !== this.api || key !== this.key) throw new DOMException('La sesión cambió', 'AbortError');
    this.fingerprint = profile.fingerprint;
    this.applyAccess(profile, true);
  }
  async verifyRole() {
    const epoch = this.authEpoch;
    const controller = new AbortController();
    const pending = { epoch };
    this.verifications.add(pending);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ACCESS_TIMEOUT_MS);
    try {
      const result = await this.request('/v1/ping', { signal: controller.signal, maxAttempts: 1 });
      await this.rememberAccess(result, epoch); this.emit();
      return result;
    } catch (error) {
      if (epoch !== this.authEpoch) throw error;
      const failure = timedOut ? Object.assign(new Error('La nube no respondió a tiempo para verificar tu acceso.'), { code: 'TIMEOUT' }) : error;
      if (failure.code === 'ACCESS_VERSION' || failure.code === 'ACCESS_PROFILE') await this.clearAccess('invalid-profile');
      else if (transientAccessError(failure)) {
        // También una actualización manual puede detectar la caída antes del sondeo de acceso.
        this.credentialsVerified = false;
        this.offline = this.offlineLeaseActive;
        this.emit();
      }
      throw failure;
    } finally {
      clearTimeout(timer);
      this.verifications.delete(pending);
    }
  }
  async checkAccess() {
    if (!this.connected) return false;
    if (navigator.onLine === false) {
      if (this.canAccess) return true;
      await this.clearAccess('offline-expired');
      return false;
    }
    const epoch = this.authEpoch;
    try { await this.verifyRole(); return this.canAccess; }
    catch (error) {
      if (epoch !== this.authEpoch) throw error;
      this.credentialsVerified = false;
      this.offline = false;
      if (error.code === 'ACCESS_VERSION' || error.code === 'ACCESS_PROFILE') {
        await this.clearAccess('invalid-profile');
        throw error;
      }
      const transient = transientAccessError(error);
      if (transient && this.offlineLeaseActive) this.offline = true;
      this.emit();
      if (transient && this.canAccess) return true;
      throw error;
    }
  }
  requireMaster() {
    access.assertEdit();
    if (!this.canPublish) throw new Error(this.role === 'player' ? 'Tu cuenta permite reproducir. El propietario debe concederte permiso de editor para publicar cambios.' : 'Verifica con internet una cuenta de editor o propietario para publicar cambios.');
  }
  requireUserManager() {
    if (!this.canManageUsers) throw new Error('Solo el propietario puede administrar usuarios.');
  }
  async connect(api, key) {
    if (this.active) throw new Error('Pausa la transferencia antes de cambiar de nube');
    const target = normalizeUrl(api.trim()), secret = key.trim();
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('La clave debe tener 64 caracteres. Usa la generada durante la configuración.');
    const oldApi = this.api;
    try { sessionStorage.removeItem(`escena-cloud:${oldApi}`); } catch { /* solo memoria */ }
    const epoch = ++this.authEpoch;
    this.api = target; this.key = secret; this.credentialsVerified = false;
    this.offline = false; this.catalogError = '';
    this.identity = null; this.permissions = { publish: false, manageUsers: false }; this.accessProfile = null; this._role = null; this.offlineUntil = 0; this.authorizedKey = '';
    const assertCurrent = () => {
      if (epoch !== this.authEpoch || this.api !== target || this.key !== secret) throw new DOMException('La sesión cambió', 'AbortError');
    };
    const fingerprint = await hash(new TextEncoder().encode(secret));
    assertCurrent();
    this.fingerprint = fingerprint;
    try {
      await this.restoreAccess();
      assertCurrent();
      if (navigator.onLine === false) {
        if (!this.offlineLeaseActive) throw new Error('Esta clave necesita verificarse con internet antes de usar la app, o su permiso sin conexión venció.');
      } else {
        try { await this.verifyRole(); }
        catch (error) {
          if (epoch !== this.authEpoch || this.api !== target || this.key !== secret) throw error;
          if (!transientAccessError(error) || !this.offlineLeaseActive) throw error;
          this.credentialsVerified = false; this.offline = true;
        }
      }
    } catch (error) {
      if (epoch === this.authEpoch && this.key === secret && this.api === target) await this.clearAccess(error.status === 401 ? 'unauthorized' : 'login-failed');
      throw error;
    }
    assertCurrent();
    await store.setMeta('cloudApi', target);
    assertCurrent();
    try { sessionStorage.setItem(`escena-cloud:${target}`, secret); } catch { /* solo memoria */ }
    this.catalog = await store.getMeta(`cloudCatalog:${target}`, []);
    assertCurrent();
    this.emit();
    if (this.onlineAccess) {
      this.refresh({ verify: false }).catch(error => {
        // Una lista temporalmente inaccesible no invalida el ping que sí autorizó el acceso.
        // Un 401 revoca desde request(); nunca espera este catálogo el inicio del reproductor.
        if (epoch !== this.authEpoch || error.status === 401) return;
        this.catalogError = error.message || 'No se pudo actualizar la lista de canciones.';
        this.emit();
      });
    }
    assertCurrent();
    return this.identity;
  }
  disconnect() {
    return this.clearAccess('disconnect');
  }
  async clearAccess(reason = 'revoked') {
    const api = this.api, fingerprint = this.fingerprint;
    this.pause();
    this.authEpoch++;
    try { sessionStorage.removeItem(`escena-cloud:${api}`); } catch { /* solo memoria */ }
    this.key = ''; this.credentialsVerified = false; this._role = null;
    this.identity = null; this.permissions = { publish: false, manageUsers: false };
    this.accessProfile = null; this.offlineUntil = 0; this.fingerprint = ''; this.authorizedKey = '';
    this.offline = false;
    this.bus.emit('access:revoked', { reason });
    this.emit();
    if (fingerprint) await store.setMeta(`cloudAccess:${api}:${fingerprint}`, null);
  }
  async request(path, { method = 'GET', data, bytes, headers = {}, signal, binary = false, manageUsers = false, maxAttempts } = {}) {
    if (!this.connected) throw new Error('Conecta tu nube para continuar');
    if (navigator.onLine === false) throw new Error('Sin internet. Puedes reproducir las canciones descargadas mientras tu permiso siga vigente.');
    if (path !== '/v1/ping' && !this.canAccess) throw new Error('Inicia sesión con una clave autorizada para continuar.');
    if (manageUsers) this.requireUserManager();
    else if (!['GET', 'HEAD'].includes(method)) this.requireMaster();
    const transferring = Boolean(signal && this.active?.controller.signal === signal);
    const api = this.api, key = this.key, epoch = this.authEpoch;
    try {
      const result = await cloudRequest(api + path, {
        method, data, bytes, headers: { ...headers, Authorization: `Bearer ${key}` }, signal, binary,
        maxAttempts: maxAttempts ?? (transferring ? TRANSFER_ATTEMPTS : 3),
        onRetry: transferring ? retry => { this.retry = retry; this.emit(); } : undefined,
      });
      if (epoch !== this.authEpoch) throw new DOMException('La sesión cambió', 'AbortError');
      return result;
    } catch (error) {
      if (error.status === 401 && epoch === this.authEpoch && api === this.api && key === this.key) await this.clearAccess('unauthorized');
      throw error;
    }
  }
  async refresh({ verify = true } = {}) {
    if (!this.connected || navigator.onLine === false) return;
    this.loading = true; this.emit();
    try {
      if (verify) await this.verifyRole();
      const songs = []; let cursor;
      do {
        const page = await this.request('/v1/songs' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
        songs.push(...page.songs); cursor = page.cursor;
      } while (cursor);
      this.catalog = songs.sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }));
      this.catalogError = '';
      await store.setMeta(`cloudCatalog:${this.api}`, this.catalog);
    } finally { this.loading = false; this.emit(); }
  }
  async listUsers() {
    this.requireUserManager();
    const result = await this.request('/v1/users', { manageUsers: true });
    if (!Array.isArray(result.users)) throw new Error('La nube devolvió una lista de usuarios no válida.');
    return result.users;
  }
  createUser(data) { return this.request('/v1/users', { method: 'POST', data, manageUsers: true }); }
  updateUser(id, data) { return this.request(`/v1/users/${encodeURIComponent(id)}`, { method: 'PUT', data, manageUsers: true }); }
  rotateUserKey(id, data) { return this.request(`/v1/users/${encodeURIComponent(id)}/rotate`, { method: 'POST', data, manageUsers: true }); }
  local(id) { return app.songList().find(song => song.cloud?.endpoint === this.api && song.cloud?.id === id); }
  async localHasChanges(song) {
    return Boolean(song?.cloud?.syncedHash && await cloudSongHash(song) !== song.cloud.syncedHash);
  }
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
    if (!this.canAccess || !this.onlineAccess) throw new Error('Verifica tu acceso con internet antes de iniciar una transferencia.');
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
    this.requireMaster();
    if (navigator.onLine === false) throw new Error('Sin internet. Los cambios quedan guardados en este equipo; publícalos cuando vuelva la conexión.');
    await app.persistSongSoon.flushPending?.();
    const jobId = `up:${this.api}:${song.id}`;
    let job = await store.get('cloudTransfers', jobId);
    if (!job) {
      const linked = !asNew && song.cloud?.endpoint === this.api;
      const snapshot = serializableSong(song); delete snapshot.cloud;
      job = { id: jobId, kind: 'upload', endpoint: this.api, localId: song.id, title: song.title, songId: linked ? song.cloud.id : newId(), revision: newId(), expectedRevision: linked ? song.cloud.revision : null, song: snapshot, contentHash: await cloudSongHash(snapshot), files: [], total: 0 };
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
    // Una reanudación conserva la foto, secciones y pistas de su instantánea.
    // No publicar esa versión antigua como si incluyera las ediciones más recientes.
    const savedHash = job.contentHash || await cloudSongHash(job.song);
    if (await cloudSongHash(song) !== savedHash) throw new Error('La canción cambió desde la subida pendiente. Descarta esa transferencia y vuelve a publicar para incluir la portada, secciones y pistas actuales.');
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
      if (current) { current.cloud = { endpoint: this.api, id: job.songId, revision: job.revision, syncedHash: savedHash }; await app.saveSong(current); }
      await store.remove('cloudTransfers', job.id);
      app.toast('Canción guardada en tu nube');
      await this.refresh();
    });
  }
  download(id, resumeJob = null) { return this.exclusive(() => this.performDownload(id, resumeJob)); }
  async performDownload(id, resumeJob = null) {
    await this.init();
    if (!this.canAccess || !this.onlineAccess) throw new Error('Conéctate a internet y verifica tu acceso antes de descargar canciones.');
    await app.persistSongSoon.flushPending?.();
    let job = resumeJob;
    if (!job) {
      const manifest = validateDownload(await this.request(`/v1/songs/${id}`));
      const jobId = `down:${this.api}:${id}:${manifest.revision}`;
      job = await store.get('cloudTransfers', jobId);
      if (!job) {
        const existing = this.local(id);
        const savedExisting = existing ? await store.get('songs', existing.id) || existing : null;
        const token = newId();
        job = { id: jobId, token, kind: 'download', endpoint: this.api, title: manifest.song.title, manifest, localId: existing?.id || newId(), localStartHash: savedExisting ? await cloudSongHash(savedExisting) : null, counts: {}, completed: {}, total: manifest.files.reduce((sum, file) => sum + file.size, 0) };
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
      // Termina el guardado anterior antes de comprobar y sustituir la copia.
      await app.persistSongSoon.flushPending?.();
      const old = app.songs.get(job.localId);
      const savedOld = old ? await store.get('songs', job.localId) || old : null;
      // Los cambios momentáneos del músico en modo reproducción no son ediciones
      // del catálogo. Compara la copia guardada, que sí puede haber editado el maestro.
      if (savedOld && job.localStartHash && await cloudSongHash(savedOld) !== job.localStartHash) throw new Error('La copia local cambió durante la descarga. Se conservaron tus cambios. Descarta esta descarga y pulsa «Actualizar» de nuevo cuando hayas guardado lo que necesites.');
      const song = normalizeSong({ ...manifest.song, id: job.localId, tracks: manifest.song.tracks.map(track => ({ ...track, fileId: job.completed[track.id] })), cloud: { endpoint: this.api, id: manifest.id, revision: manifest.revision } });
      song.cloud.syncedHash = await cloudSongHash(song);
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
