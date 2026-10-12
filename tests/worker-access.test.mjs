import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, { CHUNK, digest } from '../server/worker.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const MASTER = '1'.repeat(64);
const LEGACY = '2'.repeat(64);
const encoder = new TextEncoder();

// Fake R2 implements atomic conditional writes, ranged reads and multipart
// uploads. No request is sent to Cloudflare and all credentials are test data.
class Bucket {
  constructor() { this.rows = new Map(); this.uploads = new Map(); this.serial = 0; this.beforePut = null; this.beforeAbort = null; this.failDelete = null; }
  object(row, range) {
    const bytes = range ? row.bytes.slice(range.offset, range.offset + range.length) : row.bytes.slice();
    return { key: row.key, size: row.bytes.length, etag: row.etag, httpEtag: `"${row.etag}"`,
      customMetadata: { ...row.customMetadata }, body: new Blob([bytes]).stream(),
      async json() { return JSON.parse(new TextDecoder().decode(bytes)); } };
  }
  async get(key, options = {}) { const row = this.rows.get(key); return row ? this.object(row, options.range) : null; }
  async head(key) { return this.get(key); }
  async put(key, value, options = {}) {
    await this.beforePut?.(key, value, options);
    const previous = this.rows.get(key);
    const conditions = options.onlyIf instanceof Headers ? options.onlyIf : new Headers();
    if (conditions.get('if-none-match') === '*' && previous) return null;
    if (conditions.has('if-match') && (!previous || conditions.get('if-match') !== `"${previous.etag}"`)) return null;
    const bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value).slice();
    const row = { key, bytes, etag: `etag-${++this.serial}`, customMetadata: options.customMetadata || {} };
    this.rows.set(key, row);
    return this.object(row);
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.failDelete?.(key)) throw new Error('Simulated interrupted cleanup');
      this.rows.delete(key);
    }
  }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const all = [...this.rows.values()].filter(row => row.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
    const offset = Number(cursor || 0), rows = all.slice(offset, offset + limit), truncated = offset + rows.length < all.length;
    return { objects: rows.map(row => this.object(row)), truncated, cursor: truncated ? String(offset + rows.length) : undefined };
  }
  async createMultipartUpload(key, options) {
    const uploadId = `upload-${++this.serial}`;
    this.uploads.set(uploadId, { key, options, parts: new Map() });
    return { uploadId };
  }
  resumeMultipartUpload(key, uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new Error('Unknown multipart upload');
    return {
      uploadPart: async (partNumber, bytes) => {
        upload.parts.set(partNumber, new Uint8Array(bytes).slice());
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async parts => {
        const chunks = parts.map(part => upload.parts.get(part.partNumber));
        if (chunks.some(chunk => !chunk)) throw new Error('Missing multipart part');
        const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return this.put(key, bytes, upload.options);
      },
      abort: async () => { await this.beforeAbort?.(key, uploadId); this.uploads.delete(uploadId); },
    };
  }
}

function fixture() {
  const bucket = new Bucket();
  const env = { ESCENA_BUCKET: bucket, ESCENA_KEY: MASTER, ESCENA_PLAYER_KEY: LEGACY, ALLOWED_ORIGINS: 'https://app.example.test' };
  const request = (path, key = MASTER, { method = 'GET', body, headers = {} } = {}) => {
    const h = new Headers(headers);
    if (key) h.set('authorization', `Bearer ${key}`);
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array)) { payload = JSON.stringify(body); h.set('content-type', 'application/json'); }
    return worker.fetch(new Request(`https://worker.example.test${path}`, { method, headers: h, body: payload }), env);
  };
  const create = async (name = 'Músico', role = 'player', offlineHours = 24) => {
    const response = await request('/v1/users', MASTER, { method: 'POST', body: { name, role, offlineHours } });
    assert.equal(response.status, 201);
    return response.json();
  };
  return { bucket, env, request, create };
}

test('owner creates individual users; keys appear once and no plaintext credentials persist or leak in lists', async () => {
  const f = fixture();
  const player = await f.create(' Ana ', 'player', 0);
  const editor = await f.create('Editor', 'editor', 168);
  assert.match(player.key, /^[a-f0-9]{64}$/);
  assert.notEqual(player.key, editor.key);
  assert.equal(player.user.name, 'Ana');
  assert.equal(player.user.version, 1);
  const serialized = [...f.bucket.rows.values()].map(row => new TextDecoder().decode(row.bytes)).join('');
  assert.equal(serialized.includes(player.key), false);
  assert.equal(serialized.includes(editor.key), false);
  assert.ok(f.bucket.rows.has(`auth/keys/${await digest(encoder.encode(player.key))}.json`));
  const response = await f.request('/v1/users');
  const list = await response.json();
  assert.equal(list.users.length, 2);
  assert.equal(JSON.stringify(list).includes('credentialHash'), false);
  assert.equal(JSON.stringify(list).includes(player.key), false);
  for (const [key, role, publish, manageUsers, hours] of [[MASTER, 'owner', true, true, 24], [editor.key, 'editor', true, false, 168], [player.key, 'player', false, false, 0]]) {
    const ping = await (await f.request('/v1/ping', key)).json();
    assert.equal(ping.schema, 1);
    assert.equal(ping.chunkSize, 8 * 1024 * 1024);
    assert.equal(ping.accessVersion, 2);
    assert.equal(ping.user.role, role);
    assert.equal(ping.role, role === 'player' ? 'player' : 'master');
    assert.deepEqual(ping.permissions, { publish, manageUsers });
    assert.equal(ping.offlineUntil - ping.serverTime, hours * 3600000);
  }
});

test('direct requests cannot promote a player or let an editor administer users', async () => {
  const f = fixture(), player = await f.create(), editor = await f.create('Editor', 'editor');
  for (const key of [player.key, editor.key]) {
    for (const [path, method, body] of [
      ['/v1/users', 'GET'], ['/v1/users', 'POST', { name: 'Injected', role: 'editor' }],
      [`/v1/users/${player.user.id}`, 'PUT', { version: 1, role: 'editor' }],
      [`/v1/users/${player.user.id}/rotate`, 'POST', { version: 1 }],
    ]) assert.equal((await f.request(path, key, { method, body, headers: { 'x-role': 'owner' } })).status, 403);
  }
  for (const [path, method] of [['/v1/uploads/start', 'POST'], ['/v1/uploads/part', 'PUT'], ['/v1/uploads/complete', 'POST'], ['/v1/uploads/discard', 'POST'], ['/v1/songs/song0001/publish', 'POST']]) {
    assert.equal((await f.request(path, player.key, { method, body: {} })).status, 403);
  }
  assert.equal((await f.request('/v1/ping', 'f'.repeat(64))).status, 401);
  assert.equal((await f.request('/v1/ping', null)).status, 401);
});

test('validation rejects unsupported privileges and leases; updates require current version', async () => {
  const f = fixture(), created = await f.create();
  for (const body of [{ name: '', role: 'player' }, { name: 'User', role: 'owner' }, { name: 'User', role: 'player', offlineHours: -1 }, { name: 'User', role: 'player', offlineHours: 169 }, { name: 'User', role: 'player', offlineHours: 1.5 }, { name: 'User', role: 'player', active: 'true' }]) {
    assert.equal((await f.request('/v1/users', MASTER, { method: 'POST', body })).status, 400);
  }
  assert.equal((await f.request(`/v1/users/${created.user.id}`, MASTER, { method: 'PUT', body: { name: 'New name' } })).status, 400);
  const changed = await (await f.request(`/v1/users/${created.user.id}`, MASTER, { method: 'PUT', body: { version: 1, name: 'Actualizado' } })).json();
  assert.equal(changed.user.version, 2);
  assert.equal((await f.request(`/v1/users/${created.user.id}`, MASTER, { method: 'PUT', body: { version: 1, role: 'editor' } })).status, 409);
  assert.equal((await f.request(`/v1/users/${created.user.id}/rotate`, MASTER, { method: 'POST', body: { version: 1 } })).status, 409);
});

test('blocking and role changes are enforced on the next request rather than cached credentials', async () => {
  const f = fixture(), created = await f.create();
  assert.equal((await f.request('/v1/ping', created.key)).status, 200);
  let changed = await (await f.request(`/v1/users/${created.user.id}`, MASTER, { method: 'PUT', body: { version: 1, role: 'editor' } })).json();
  assert.equal((await (await f.request('/v1/ping', created.key)).json()).permissions.publish, true);
  changed = await (await f.request(`/v1/users/${created.user.id}`, MASTER, { method: 'PUT', body: { version: changed.user.version, active: false } })).json();
  assert.equal((await f.request('/v1/ping', created.key)).status, 401);
  assert.equal((await f.request('/v1/songs', created.key)).status, 401);
  await f.request(`/v1/users/${created.user.id}`, MASTER, { method: 'PUT', body: { version: changed.user.version, active: true, role: 'player' } });
  assert.equal((await f.request('/v1/uploads/start', created.key, { method: 'POST', body: {} })).status, 403);
});

test('rotation revokes the old key even if stale-index deletion fails; dangling indexes cannot authenticate', async () => {
  const f = fixture(), created = await f.create();
  const oldHash = await digest(encoder.encode(created.key));
  f.bucket.failDelete = key => key === `auth/keys/${oldHash}.json`;
  const response = await f.request(`/v1/users/${created.user.id}/rotate`, MASTER, { method: 'POST', body: { version: 1 } });
  assert.equal(response.status, 200);
  const rotated = await response.json();
  assert.equal(rotated.user.version, 2);
  assert.equal((await f.request('/v1/ping', created.key)).status, 401);
  assert.equal((await f.request('/v1/ping', rotated.key)).status, 200);
  assert.ok(f.bucket.rows.has(`auth/keys/${oldHash}.json`));
  const orphan = 'a'.repeat(64), orphanHash = await digest(encoder.encode(orphan));
  await f.bucket.put(`auth/keys/${orphanHash}.json`, JSON.stringify({ userId: created.user.id }));
  assert.equal((await f.request('/v1/ping', orphan)).status, 401);
  await f.bucket.put(`auth/keys/${orphanHash}.json`, JSON.stringify({ userId: 'missing-user' }));
  assert.equal((await f.request('/v1/ping', orphan)).status, 401);
});

test('simultaneous version-matched updates use atomic R2 conditions; only one succeeds', async () => {
  const f = fixture(), created = await f.create();
  let entered = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.bucket.beforePut = async key => {
    if (key !== `auth/users/${created.user.id}.json`) return;
    if (++entered === 2) release();
    await barrier;
  };
  const results = await Promise.all([
    f.request(`/v1/users/${created.user.id}`, MASTER, { method: 'PUT', body: { version: 1, name: 'Primero' } }),
    f.request(`/v1/users/${created.user.id}`, MASTER, { method: 'PUT', body: { version: 1, name: 'Segundo' } }),
  ]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const record = await (await f.bucket.get(`auth/users/${created.user.id}.json`)).json();
  assert.equal(record.version, 2);
});

test('failed rotation keeps the old credential valid and does not leave an authorizing new index', async () => {
  const f = fixture(), created = await f.create();
  const initialKeys = [...f.bucket.rows.keys()].filter(key => key.startsWith('auth/keys/'));
  f.bucket.beforePut = async key => { if (key === `auth/users/${created.user.id}.json`) throw new Error('Simulated failed conditional write'); };
  assert.equal((await f.request(`/v1/users/${created.user.id}/rotate`, MASTER, { method: 'POST', body: { version: 1 } })).status, 500);
  assert.deepEqual([...f.bucket.rows.keys()].filter(key => key.startsWith('auth/keys/')), initialKeys);
  assert.equal((await f.request('/v1/ping', created.key)).status, 200);
});

test('legacy shared player credential is disabled by default and only enabled explicitly', async () => {
  const f = fixture();
  assert.equal((await f.request('/v1/ping', LEGACY)).status, 401);
  f.env.ALLOW_LEGACY_PLAYER = 'false';
  assert.equal((await f.request('/v1/ping', LEGACY)).status, 401);
  f.env.ALLOW_LEGACY_PLAYER = 'true';
  const ping = await (await f.request('/v1/ping', LEGACY)).json();
  assert.equal(ping.user.role, 'player');
  assert.equal(ping.permissions.manageUsers, false);
  assert.equal((await f.request('/v1/users', LEGACY)).status, 403);
});

test('editor uploads and publishes with the existing 8 MiB manifest protocol; non-owners read only current listed audio', async () => {
  const f = fixture(), editor = await f.create('Editor', 'editor'), player = await f.create();
  const bytes = Uint8Array.of(11, 22, 33, 44), songId = 'song0001', revision = 'revision01', trackId = 'track0001';
  const data = { songId, revision, trackId, size: bytes.length };
  const started = await (await f.request('/v1/uploads/start', editor.key, { method: 'POST', body: data })).json();
  assert.ok(started.uploadId);
  const conflictingBytes = Uint8Array.of(91, 92, 93, 94, 95);
  const conflictingData = { ...data, size: conflictingBytes.length };
  const secondUpload = await (await f.request('/v1/uploads/start', editor.key, { method: 'POST', body: conflictingData })).json();
  const secondQuery = new URLSearchParams({ ...conflictingData, uploadId: secondUpload.uploadId, part: '1' });
  const secondPart = await (await f.request(`/v1/uploads/part?${secondQuery}`, editor.key, { method: 'PUT', body: conflictingBytes, headers: { 'x-chunk-sha256': await digest(conflictingBytes) } })).json();
  const query = new URLSearchParams({ ...data, uploadId: started.uploadId, part: '1' });
  const partResponse = await f.request(`/v1/uploads/part?${query}`, editor.key, { method: 'PUT', body: bytes, headers: { 'x-chunk-sha256': await digest(bytes) } });
  assert.equal(partResponse.status, 200);
  const part = await partResponse.json();
  assert.equal((await f.request('/v1/uploads/complete', editor.key, { method: 'POST', body: { ...data, uploadId: started.uploadId, parts: [part] } })).status, 200);
  const path = `/v1/audio/${songId}/${revision}/${trackId}`, headers = { range: 'bytes=0-3' };
  assert.equal((await f.request(path, editor.key, { headers })).status, 403);
  assert.equal((await f.request(path, player.key, { headers })).status, 403);
  assert.equal((await f.request(path, MASTER, { headers })).status, 206);
  const manifest = { schema: 1, id: songId, revision, chunkSize: CHUNK,
    song: { title: 'Canción de prueba', tracks: [{ id: trackId }], tempoMap: [{ bpm: 120 }], markers: [] },
    files: [{ id: trackId, name: 'Pista.wav', type: 'audio/wav', size: bytes.length, hashes: [await digest(bytes)] }] };
  assert.equal((await f.request(`/v1/songs/${songId}/publish`, editor.key, { method: 'POST', body: { manifest, expectedRevision: null } })).status, 200);
  assert.equal((await f.request('/v1/uploads/complete', editor.key, { method: 'POST', body: { ...conflictingData, uploadId: secondUpload.uploadId, parts: [secondPart] } })).status, 409);
  assert.equal((await (await f.request('/v1/songs', player.key)).json()).songs.length, 1);
  assert.equal((await (await f.request(`/v1/songs/${songId}`, player.key)).json()).revision, revision);
  for (const key of [editor.key, player.key]) {
    const response = await f.request(path, key, { headers });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-3/4');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal((await f.request(`/v1/audio/${songId}/revision02/${trackId}`, key, { headers })).status, 403);
  }
  await f.bucket.put(`audio/${songId}/${revision}/unlisted1`, bytes);
  assert.equal((await f.request(`/v1/audio/${songId}/${revision}/unlisted1`, player.key, { headers })).status, 403);
  assert.equal((await f.request(path, player.key, { headers: { range: `bytes=0-${CHUNK}` } })).status, 416);
  assert.equal((await f.request(path, player.key, { headers: { range: 'bytes=0-4' } })).status, 416);
  const next = { ...manifest, revision: 'revision02' };
  await f.bucket.put(`catalog/${songId}.json`, JSON.stringify(next));
  assert.equal((await f.request(path, player.key, { headers })).status, 403);
});

test('an 8 MiB part plus a final short part retain the existing upload and ranged-download protocol', async () => {
  const f = fixture(), editor = await f.create('Editor', 'editor'), player = await f.create();
  const chunks = [new Uint8Array(CHUNK).fill(0x31), Uint8Array.of(41, 42, 43, 44, 45)];
  const data = { songId: 'song0003', revision: 'revision03', trackId: 'track0003', size: CHUNK + 5 };
  const start = await (await f.request('/v1/uploads/start', editor.key, { method: 'POST', body: data })).json();
  const parts = [], hashes = [];
  for (let index = 0; index < chunks.length; index++) {
    const query = new URLSearchParams({ ...data, uploadId: start.uploadId, part: String(index + 1) });
    const hash = await digest(chunks[index]); hashes.push(hash);
    const response = await f.request(`/v1/uploads/part?${query}`, editor.key, { method: 'PUT', body: chunks[index], headers: { 'x-chunk-sha256': hash } });
    assert.equal(response.status, 200);
    parts.push(await response.json());
  }
  assert.equal((await f.request('/v1/uploads/complete', editor.key, { method: 'POST', body: { ...data, uploadId: start.uploadId, parts } })).status, 200);
  const manifest = { schema: 1, id: data.songId, revision: data.revision, chunkSize: CHUNK,
    song: { title: 'Dos partes', tracks: [{ id: data.trackId }], tempoMap: [{ bpm: 120 }], markers: [] },
    files: [{ id: data.trackId, name: 'Pista.wav', type: 'audio/wav', size: data.size, hashes }] };
  assert.equal((await f.request(`/v1/songs/${data.songId}/publish`, editor.key, { method: 'POST', body: { manifest, expectedRevision: null } })).status, 200);
  const path = `/v1/audio/${data.songId}/${data.revision}/${data.trackId}`;
  const tail = await f.request(path, player.key, { headers: { range: `bytes=${CHUNK}-${CHUNK + 4}` } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), `bytes ${CHUNK}-${CHUNK + 4}/${data.size}`);
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), chunks[1]);
  const first = await f.request(path, player.key, { headers: { range: `bytes=0-${CHUNK - 1}` } });
  assert.equal(first.status, 206);
  assert.equal(await digest(await first.arrayBuffer()), hashes[0]);
});

test('discard preserves complete audio when publication interleaves after its catalog check', async () => {
  const f = fixture(), editor = await f.create('Editor', 'editor'), player = await f.create();
  const bytes = Uint8Array.of(21, 22, 23, 24);
  const songId = 'song0004', revision = 'revision04', trackId = 'track0004';
  const key = `audio/${songId}/${revision}/${trackId}`;
  await f.bucket.put(key, bytes);
  const pending = await f.bucket.createMultipartUpload(key, {});
  const manifest = { schema: 1, id: songId, revision, chunkSize: CHUNK,
    song: { title: 'Publicación concurrente', tracks: [{ id: trackId }], tempoMap: [{ bpm: 120 }], markers: [] },
    files: [{ id: trackId, name: 'Pista.wav', type: 'audio/wav', size: bytes.length, hashes: [await digest(bytes)] }] };
  let publishedDuringAbort = false;
  f.bucket.beforeAbort = async () => {
    // discard has already read an absent catalog. Publish now, before it
    // aborts the multipart and before the previous implementation's deletion.
    assert.equal((await f.request(`/v1/songs/${songId}/publish`, editor.key, { method: 'POST', body: { manifest, expectedRevision: null } })).status, 200);
    publishedDuringAbort = true;
  };
  const discarded = await f.request('/v1/uploads/discard', editor.key, { method: 'POST', body: { songId, revision, files: [{ id: trackId, uploadId: pending.uploadId }] } });
  assert.equal(discarded.status, 200);
  assert.deepEqual(await discarded.json(), { discarded: true, cleanupDeferred: true });
  assert.equal(publishedDuringAbort, true);
  assert.equal(f.bucket.uploads.has(pending.uploadId), false);
  const response = await f.request(`/v1/audio/${songId}/${revision}/${trackId}`, player.key, { headers: { range: 'bytes=0-3' } });
  assert.equal(response.status, 206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal((await f.request('/v1/uploads/discard', MASTER, { method: 'POST', body: { songId, revision, files: [] } })).status, 409);
  assert.ok(await f.bucket.head(key));
});

test('CORS, no-store and preflight remain enforced for successful and denied requests', async () => {
  const f = fixture();
  const allowed = await f.request('/v1/ping', MASTER, { headers: { origin: 'https://app.example.test' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.test');
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.equal(allowed.headers.get('vary'), 'Origin');
  const denied = await f.request('/v1/ping', MASTER, { headers: { origin: 'https://unknown.example.test' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.equal(denied.headers.has('access-control-allow-origin'), false);
  const unauthorized = await f.request('/v1/ping', null);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('cache-control'), 'no-store');
  const preflight = await f.request('/v1/users', null, { method: 'OPTIONS', headers: { origin: 'https://app.example.test' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
});
