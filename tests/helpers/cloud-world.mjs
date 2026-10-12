// Equipo(s) con la app real conectados al Worker real, con R2 en memoria.
// Nada sale de este proceso y todas las claves son de prueba.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import worker, { CHUNK } from '../../server/worker.mjs';

export { CHUNK };
if (!globalThis.crypto) globalThis.crypto = webcrypto;

export const API = 'https://escena.test';
export const MASTER = '1'.repeat(64);
const source = await readFile(new URL('../../www/js/cloud.js', import.meta.url), 'utf8');
const encoder = new TextEncoder();
export const COVER_1 = 'data:image/png;base64,AAAA', COVER_2 = 'data:image/png;base64,BBBB', COVER_3 = 'data:image/png;base64,CCCC';
export const A_SIZE = CHUNK + 1000, B_SIZE = 1000; // la pista A ocupa dos partes; la B, una

export const fill = (length, seed) => { const out = new Uint8Array(length); for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 255; return out; };
export const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// R2 en memoria con lecturas por rango, escrituras condicionales y subidas por partes.
class Bucket {
  constructor() { this.rows = new Map(); this.uploads = new Map(); this.serial = 0; }
  object(row, range) {
    const bytes = range ? row.bytes.slice(range.offset, range.offset + range.length) : row.bytes.slice();
    return { key: row.key, size: row.bytes.length, etag: row.etag, httpEtag: `"${row.etag}"`, customMetadata: { ...row.customMetadata },
      body: new Blob([bytes]).stream(), async json() { return JSON.parse(new TextDecoder().decode(bytes)); } };
  }
  async get(key, options = {}) { const row = this.rows.get(key); return row ? this.object(row, options.range) : null; }
  async head(key) { return this.get(key); }
  async put(key, value, options = {}) {
    const previous = this.rows.get(key);
    const conditions = options.onlyIf instanceof Headers ? options.onlyIf : new Headers();
    if (conditions.get('if-none-match') === '*' && previous) return null;
    if (conditions.has('if-match') && (!previous || conditions.get('if-match') !== `"${previous.etag}"`)) return null;
    const bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value).slice();
    const row = { key, bytes, etag: `etag-${++this.serial}`, customMetadata: options.customMetadata || {} };
    this.rows.set(key, row);
    return this.object(row);
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.rows.delete(key); }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const all = [...this.rows.values()].filter(row => row.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
    const offset = Number(cursor || 0), rows = all.slice(offset, offset + limit), truncated = offset + rows.length < all.length;
    return { objects: rows.map(row => this.object(row)), truncated, cursor: truncated ? String(offset + rows.length) : undefined };
  }
  async createMultipartUpload(key, options) { const uploadId = `upload-${++this.serial}`; this.uploads.set(uploadId, { key, options, parts: new Map() }); return { uploadId }; }
  resumeMultipartUpload(key, uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new Error('Unknown multipart upload');
    return {
      uploadPart: async (partNumber, bytes) => { upload.parts.set(partNumber, new Uint8Array(bytes).slice()); return { partNumber, etag: `part-${partNumber}` }; },
      complete: async parts => {
        const chunks = parts.map(part => upload.parts.get(part.partNumber));
        const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
        let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return this.put(key, bytes, upload.options);
      },
      abort: async () => { this.uploads.delete(uploadId); },
    };
  }
}

// Un servicio (Worker + bucket) y los equipos que se conectan a él.
export function world() {
  const bucket = new Bucket();
  const env = { ESCENA_BUCKET: bucket, ESCENA_KEY: MASTER, ALLOWED_ORIGINS: 'https://app.example.test' };
  const requests = [], toasts = [];
  const w = {
    bucket, requests, toasts, hideFeatures: false, hideDelete: false,
    count: (from, path) => requests.slice(from).filter(item => item.path === path).length,
    async request(path, key = MASTER, { method = 'GET', body, headers = {} } = {}) {
      const h = new Headers(headers);
      h.set('authorization', `Bearer ${key}`);
      let payload = body;
      if (body !== undefined && !(body instanceof Uint8Array)) { payload = JSON.stringify(body); h.set('content-type', 'application/json'); }
      return worker.fetch(new Request(`https://worker.example.test${path}`, { method, headers: h, body: payload }), env);
    },
    async manifest(songId) { return (await w.request(`/v1/songs/${songId}`)).json(); },
    async readAll(songId, revision, trackId, size) {
      const out = new Uint8Array(size);
      for (let start = 0; start < size; start += CHUNK) {
        const response = await w.request(`/v1/audio/${songId}/${revision}/${trackId}`, MASTER, { headers: { range: `bytes=${start}-${Math.min(size, start + CHUNK) - 1}` } });
        assert.equal(response.status, 206);
        out.set(new Uint8Array(await response.arrayBuffer()), start);
      }
      return out;
    },
    async createUser(name = 'Músico', role = 'player') {
      const response = await w.request('/v1/users', MASTER, { method: 'POST', body: { name, role, offlineHours: 24 } });
      assert.equal(response.status, 201);
      return (await response.json()).key;
    },
    createPlayer(name = 'Músico') { return w.createUser(name, 'player'); },
    // Equipo con la app real conectada al servicio.
    async device(key) {
      const metadata = new Map(), session = new Map(), tables = new Map(), commits = [], songs = new Map();
      const table = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
      const store = {
        async getMeta(name, fallback) { return structuredClone(metadata.has(name) ? metadata.get(name) : fallback); },
        async setMeta(name, value) { metadata.set(name, structuredClone(value)); },
        async get(name, id) { return table(name).get(id); },
        async put(name, row) { table(name).set(row.id, row); },
        async remove(name, id) { table(name).delete(id); },
        async all(name) { return [...table(name).values()]; },
        async clearPrefix(name, prefix) { for (const id of [...table(name).keys()]) if (String(id).startsWith(prefix)) table(name).delete(id); },
        async usage() { return { quota: 0, used: 0 }; },
        async commitCloudSong(song, oldFileIds, jobId) {
          commits.push({ oldFileIds: [...oldFileIds], jobId });
          table('songs').set(song.id, song);
          for (const id of oldFileIds) table('files').delete(id);
          table('cloudTransfers').delete(jobId);
        },
      };
      const app = {
        songs, current: null, player: null, songList: () => [...songs.values()],
        persistSongSoon: { flushPending: async () => {} },
        async saveSong(song) { songs.set(song.id, song); table('songs').set(song.id, song); },
        toast: message => toasts.push(message), unloadCurrent() {}, invalidateSong() {}, warmUp() {}, emit() {},
      };
      const stubs = {
        './app.js': { app }, './store.js': { store },
        './library.js': { normalizeSong: song => structuredClone(song), serializableSong: song => structuredClone(song) },
        './util.js': {
          fmtBytes: bytes => `${bytes}`,
          createEmitter() {
            const listeners = new Map();
            return { on(name, fn) { const fns = listeners.get(name) || new Set(); listeners.set(name, fns); fns.add(fn); return () => fns.delete(fn); },
              emit(name, ...args) { for (const fn of listeners.get(name) || []) fn(...args); } };
          },
        },
        './cloud-config.js': { CLOUD_API_URL: API },
        './cloud-song-state.js': { cloudSongHash: async song => createHash('sha256').update(JSON.stringify({ ...song, cloud: undefined })).digest('hex') },
        './access.js': { access: { assertEdit() {} } },
        './cloud-request.js': {
          TRANSFER_ATTEMPTS: 12,
          async cloudRequest(url, { method = 'GET', data, bytes, headers = {}, binary = false }) {
            const target = new URL(url), h = new Headers(headers);
            if (w.hideDelete && target.pathname.endsWith('/delete')) { // Worker anterior: no conoce la ruta
              requests.push({ method, path: target.pathname, status: 404 });
              throw Object.assign(new Error('Ruta no encontrada'), { status: 404 });
            }
            let body;
            if (bytes) body = new Uint8Array(bytes);
            else if (data !== undefined) { body = JSON.stringify(data); h.set('content-type', 'application/json'); }
            const response = await worker.fetch(new Request(`https://worker.example.test${target.pathname}${target.search}`, { method, headers: h, body }), env);
            requests.push({ method, path: target.pathname, status: response.status });
            if (!response.ok) throw Object.assign(new Error((await response.json().catch(() => ({}))).error || 'Error del servicio'), { status: response.status });
            if (binary) return { status: response.status, range: response.headers.get('content-range'), bytes: await response.arrayBuffer() };
            const result = await response.json();
            if (target.pathname === '/v1/ping' && w.hideFeatures) delete result.features;
            return result;
          },
        },
      };
      const context = vm.createContext({ navigator: { onLine: true }, sessionStorage: { getItem: name => session.get(name) || null, setItem: (name, value) => session.set(name, value), removeItem: name => session.delete(name) },
        crypto: webcrypto, TextEncoder, URL, URLSearchParams, DOMException, AbortController, Blob, Date, setTimeout, clearTimeout });
      const module = new vm.SourceTextModule(source, { context, identifier: 'cloud.js' });
      await module.link(specifier => {
        assert.ok(stubs[specifier], `Unexpected dependency: ${specifier}`);
        const values = stubs[specifier];
        return new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context });
      });
      await module.evaluate();
      const cloud = module.namespace.cloud;
      await cloud.init();
      await cloud.connect(API, key);
      return {
        cloud, app, commits, table,
        setFile(id, bytes) { table('files').set(id, { id, name: `${id}.wav`, size: bytes.length, type: 'audio/wav', blob: new Blob([bytes]) }); },
        async fileBytes(id) { return new Uint8Array(await table('files').get(id).blob.arrayBuffer()); },
      };
    },
  };
  return w;
}

// Canción del maestro con dos pistas: A (dos partes) y B (una).
export function newSong(device, bytesA = fill(A_SIZE, 1), bytesB = fill(B_SIZE, 2)) {
  device.setFile('file-a', bytesA); device.setFile('file-b', bytesB);
  const song = { id: 'local-song-1', title: 'Enamorados', artist: 'Tercer Cielo', cover: COVER_1, tempoMap: [{ bpm: 98 }], markers: [],
    tracks: [{ id: 'trackaaa1', name: 'Pista A', fileId: 'file-a' }, { id: 'trackbbb1', name: 'Pista B', fileId: 'file-b' }] };
  device.app.songs.set(song.id, song);
  return song;
}
