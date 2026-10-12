// Isolated client authorization tests. No requests leave this process.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import vm from 'node:vm';

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const API = 'https://escena.test';
const KEY_A = 'a'.repeat(64), KEY_B = 'b'.repeat(64);
const NOW = 1800000000000;
const HOUR = 3600000;
const fingerprint = key => createHash('sha256').update(key).digest('hex');
const cacheKey = key => `cloudAccess:${API}:${fingerprint(key)}`;
const source = await readFile(new URL('../www/js/cloud.js', import.meta.url), 'utf8');

function ping({ role = 'owner', hours = 24, now = NOW, id = role === 'owner' ? 'owner' : 'user-1', name = role === 'owner' ? 'Propietario' : 'Músico' } = {}) {
  return {
    ok: true, schema: 1, accessVersion: 2, role: role === 'player' ? 'player' : 'master',
    user: { id, name, role, offlineHours: hours },
    permissions: { publish: role !== 'player', manageUsers: role === 'owner' },
    serverTime: now, offlineUntil: hours ? now + hours * HOUR : 0,
  };
}

function profile(key = KEY_A, options = {}) {
  return { ...ping(options), api: API, fingerprint: fingerprint(key), verifiedAt: NOW };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness({ online = true, key = '', cached, crypto = webcrypto, timers } = {}) {
  const metadata = new Map();
  const session = new Map();
  const requests = [];
  const events = [];
  const clock = { now: NOW };
  if (key) session.set(`escena-cloud:${API}`, key);
  if (cached) metadata.set(cacheKey(key || KEY_A), cached);
  const store = {
    async getMeta(key, fallback) { return structuredClone(metadata.has(key) ? metadata.get(key) : fallback); },
    async setMeta(key, value) { metadata.set(key, structuredClone(value)); },
  };
  const local = { songs: new Map([['draft', { id: 'draft', title: 'Edición local pendiente' }]]), songList() { return [...this.songs.values()]; } };
  const access = { assertEdit() {} };
  const network = {
    async handler(url, options) {
      if (url === `${API}/v1/ping`) return ping(options.headers.Authorization === `Bearer ${KEY_B}` ? { role: 'player', id: 'user-b' } : {});
      if (url === `${API}/v1/songs`) return { songs: [] };
      if (url === `${API}/v1/users`) return { users: [] };
      return {};
    },
  };
  const navigator = { onLine: online };
  const sessionStorage = {
    getItem: key => session.get(key) || null,
    setItem: (key, value) => session.set(key, value),
    removeItem: key => session.delete(key),
  };
  class ClockDate extends Date { static now() { return clock.now; } }
  const context = vm.createContext({ navigator, sessionStorage, crypto, TextEncoder, URL, URLSearchParams, DOMException, AbortController, Blob, Date: ClockDate,
    setTimeout: timers?.setTimeout || setTimeout, clearTimeout: timers?.clearTimeout || clearTimeout });
  const stubs = {
    './app.js': { app: local },
    './store.js': { store },
    './library.js': { normalizeSong: song => song, serializableSong: song => song },
    './util.js': {
      fmtBytes: bytes => `${bytes}`,
      createEmitter() {
        const listeners = new Map();
        return {
          on(name, fn) {
            const fns = listeners.get(name) || new Set();
            listeners.set(name, fns); fns.add(fn);
            return () => fns.delete(fn);
          },
          emit(name, ...args) { events.push({ name, args }); for (const fn of listeners.get(name) || []) fn(...args); },
        };
      },
    },
    './cloud-config.js': { CLOUD_API_URL: API },
    './cloud-request.js': { TRANSFER_ATTEMPTS: 12, async cloudRequest(url, options) { requests.push({ url, options }); return network.handler(url, options); } },
    './cloud-song-state.js': { cloudSongHash: async () => 'draft-hash' },
    './access.js': { access },
  };
  const module = new vm.SourceTextModule(source, { context, identifier: 'cloud.js' });
  await module.link(specifier => {
    assert.ok(stubs[specifier], `Unexpected dependency: ${specifier}`);
    const values = stubs[specifier];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return { cloud: module.namespace.cloud, metadata, session, requests, events, store, local, access, navigator, network, clock };
}

async function login(h, key = KEY_A) {
  await h.cloud.init();
  return h.cloud.connect(API, key);
}

test('legacy device/role metadata never authorizes the app', async () => {
  const h = await harness({ key: KEY_A });
  h.metadata.set('cloudDeviceRole', { api: API, role: 'master' });
  h.metadata.set(`cloudRole:${API}:${fingerprint(KEY_A)}`, 'master');
  await h.cloud.init();
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.cloud.role, null);
  assert.equal(h.cloud.canPublish, false);
});

test('online login requires ping v2 and persists only its bound access profile', async () => {
  const h = await harness();
  const identity = await login(h);
  assert.equal(identity.role, 'owner');
  assert.equal(h.cloud.canAccess, true);
  assert.equal(h.cloud.canPublish, true);
  assert.equal(h.cloud.canManageUsers, true);
  const cached = h.metadata.get(cacheKey(KEY_A));
  assert.equal(cached.fingerprint, fingerprint(KEY_A));
  assert.equal(cached.api, API);
  assert.equal(cached.user.id, 'owner');
  assert.ok(!JSON.stringify(cached).includes(KEY_A));
  assert.equal(h.session.get(`escena-cloud:${API}`), KEY_A);
});

test('an approved player can enter and cannot publish or manage users', async () => {
  const h = await harness();
  await login(h, KEY_B);
  assert.equal(h.cloud.canAccess, true);
  assert.equal(h.cloud.identity.role, 'player');
  assert.equal(h.cloud.role, 'player');
  assert.equal(h.cloud.canPublish, false);
  assert.equal(h.cloud.canManageUsers, false);
  await assert.rejects(h.cloud.createUser({ name: 'Otro', role: 'player' }), /propietario/);
});

test('matching session key and unexpired cached lease permit offline use without cloud operations', async () => {
  const h = await harness({ online: false, key: KEY_A, cached: profile() });
  await h.cloud.init();
  assert.equal(h.cloud.canAccess, true);
  assert.equal(h.cloud.credentialsVerified, false);
  assert.equal(h.cloud.canPublish, false);
  assert.equal(h.cloud.canManageUsers, false);
  assert.equal(await h.cloud.checkAccess(), true);
  await assert.rejects(h.cloud.performDownload('song-1'), /internet/);
  assert.equal(h.requests.length, 0);
});

test('cached profiles without a session key cannot authorize startup', async () => {
  const h = await harness({ online: false, cached: profile() });
  await h.cloud.init();
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.cloud.identity, null);
});

test('a different key never inherits the cached identity', async () => {
  const h = await harness({ online: false, key: KEY_B });
  h.metadata.set(cacheKey(KEY_A), profile());
  await h.cloud.init();
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.cloud.identity, null);
});

test('expired offline leases clear the current session and require a new login', async () => {
  const h = await harness({ online: false, key: KEY_A, cached: profile(KEY_A, { hours: 1 }) });
  h.clock.now += 2 * HOUR;
  await h.cloud.init();
  assert.equal(h.cloud.canAccess, false);
  assert.equal(await h.cloud.checkAccess(), false);
  assert.equal(h.cloud.key, '');
  assert.equal(h.session.has(`escena-cloud:${API}`), false);
  assert.equal(h.metadata.get(cacheKey(KEY_A)), null);
});

test('offline login accepts an approved matching lease and rejects an unknown key', async () => {
  const h = await harness({ online: false, cached: profile() });
  await login(h);
  assert.equal(h.cloud.canAccess, true);
  await h.cloud.disconnect();
  await assert.rejects(h.cloud.connect(API, KEY_B), /verificarse con internet/);
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.requests.length, 0);
});

test('zero offline hours permit online use and forbid offline access', async () => {
  const h = await harness();
  h.network.handler = async url => url.endsWith('/ping') ? ping({ hours: 0 }) : { songs: [] };
  await login(h);
  assert.equal(h.cloud.canAccess, true);
  h.navigator.onLine = false;
  assert.equal(h.cloud.offlineLeaseActive, false);
  assert.equal(h.cloud.canAccess, false);
});

test('old Workers cannot complete interactive login', async () => {
  const h = await harness();
  h.network.handler = async () => ({ role: 'master', schema: 1 });
  await assert.rejects(login(h), /Actualiza el Worker/);
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.cloud.key, '');
  assert.equal(h.session.has(`escena-cloud:${API}`), false);
});

test('catalog network errors preserve a successful authenticated login', async () => {
  const h = await harness();
  h.network.handler = async url => {
    if (url.endsWith('/ping')) return ping();
    throw Object.assign(new Error('Catálogo temporalmente inaccesible'), { code: 'NETWORK' });
  };
  await login(h);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.cloud.canAccess, true);
  assert.equal(h.cloud.credentialsVerified, true);
  assert.match(h.cloud.catalogError, /temporalmente/);
});

test('401 revokes identity, session key and cached lease without deleting local drafts', async () => {
  const h = await harness();
  await login(h);
  h.network.handler = async () => { throw Object.assign(new Error('Acceso revocado'), { status: 401 }); };
  await assert.rejects(h.cloud.request('/v1/songs'), error => error.status === 401);
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.cloud.identity, null);
  assert.equal(h.cloud.key, '');
  assert.equal(h.session.has(`escena-cloud:${API}`), false);
  assert.equal(h.metadata.get(cacheKey(KEY_A)), null);
  assert.equal(h.local.songs.get('draft').title, 'Edición local pendiente');
  assert.ok(h.events.some(event => event.name === 'access:revoked' && event.args[0].reason === 'unauthorized'));
});

test('403 rejects the operation without revoking authenticated app access', async () => {
  const h = await harness();
  await login(h);
  h.network.handler = async () => { throw Object.assign(new Error('Operación prohibida'), { status: 403 }); };
  await assert.rejects(h.cloud.request('/v1/songs'), error => error.status === 403);
  assert.equal(h.cloud.canAccess, true);
  assert.equal(h.cloud.key, KEY_A);
  assert.ok(h.metadata.get(cacheKey(KEY_A)));
});

test('transient ping failures preserve a valid lease even when the browser still reports online', async () => {
  const h = await harness();
  await login(h);
  h.network.handler = async () => { throw Object.assign(new Error('Red interrumpida'), { code: 'NETWORK' }); };
  assert.equal(await h.cloud.checkAccess(), true);
  assert.equal(h.navigator.onLine, true);
  assert.equal(h.cloud.offline, true);
  assert.equal(h.cloud.canAccess, true);
  assert.equal(h.cloud.canPublish, false);
  assert.equal(h.cloud.canManageUsers, false);
  await assert.rejects(h.cloud.performDownload('song-1'), /verifica tu acceso/);
  h.network.handler = async () => ping();
  assert.equal(await h.cloud.checkAccess(), true);
  assert.equal(h.cloud.offline, false);
  assert.equal(h.cloud.canPublish, true);
});

test('temporary 503 preserves the existing lease but an unknown key cannot use that fallback', async () => {
  const h = await harness({ key: KEY_A, cached: profile() });
  await h.cloud.init();
  assert.equal(h.cloud.canAccess, false);
  h.network.handler = async () => { throw Object.assign(new Error('Servicio temporalmente caído'), { status: 503 }); };
  assert.equal(await h.cloud.checkAccess(), true);
  assert.equal(h.cloud.canAccess, true);
  const unknown = await harness();
  unknown.network.handler = h.network.handler;
  await assert.rejects(login(unknown, KEY_B), error => error.status === 503);
  assert.equal(unknown.cloud.canAccess, false);
  assert.equal(unknown.metadata.get(cacheKey(KEY_B)) ?? null, null);
});

test('a network failure cannot extend an expired lease or create one for offline-hours zero', async () => {
  for (const hours of [0, 1]) {
    const h = await harness();
    h.network.handler = async url => url.endsWith('/ping') ? ping({ hours }) : { songs: [] };
    await login(h);
    if (hours) h.clock.now += 2 * HOUR;
    h.network.handler = async () => { throw Object.assign(new Error('Tiempo agotado'), { code: 'TIMEOUT' }); };
    await assert.rejects(h.cloud.checkAccess(), /Tiempo agotado/);
    assert.equal(h.cloud.canAccess, false);
    assert.equal(h.cloud.canPublish, false);
  }
});

test('invalid Worker/profile responses revoke access instead of using a cached lease', async () => {
  const h = await harness();
  await login(h);
  h.network.handler = async () => ({ ...ping(), accessVersion: 1 });
  await assert.rejects(h.cloud.checkAccess(), /Actualiza el Worker/);
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.cloud.key, '');
  assert.equal(h.metadata.get(cacheKey(KEY_A)), null);
});

test('a late ping cannot authorize after logout', async () => {
  const h = await harness();
  await login(h);
  const pending = deferred();
  h.network.handler = () => pending.promise;
  const verification = h.cloud.verifyRole();
  await h.cloud.disconnect();
  pending.resolve(ping());
  await assert.rejects(verification, error => error.name === 'AbortError');
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.cloud.identity, null);
  assert.equal(h.metadata.get(cacheKey(KEY_A)), null);
});

test('a late 401 from an old account cannot revoke a newly authenticated account', async () => {
  const h = await harness();
  await login(h);
  const pending = deferred();
  h.network.handler = url => url.endsWith('/pending') ? pending.promise : Promise.resolve(url.endsWith('/ping') ? ping({ role: 'player', id: 'user-b' }) : { songs: [] });
  const oldRequest = h.cloud.request('/v1/pending');
  await h.cloud.connect(API, KEY_B);
  pending.reject(Object.assign(new Error('Clave anterior revocada'), { status: 401 }));
  await assert.rejects(oldRequest, error => error.status === 401);
  assert.equal(h.cloud.key, KEY_B);
  assert.equal(h.cloud.identity.id, 'user-b');
  assert.equal(h.cloud.canAccess, true);
});

test('a late old-account ping cannot overwrite the new identity or its profile binding', async () => {
  const h = await harness();
  await login(h);
  const pending = deferred();
  h.network.handler = (url, options) => url.endsWith('/ping') && options.headers.Authorization === `Bearer ${KEY_A}` ? pending.promise : Promise.resolve(url.endsWith('/ping') ? ping({ role: 'player', id: 'user-b' }) : { songs: [] });
  const oldVerification = h.cloud.verifyRole();
  await h.cloud.connect(API, KEY_B);
  pending.resolve(ping());
  await assert.rejects(oldVerification, error => error.name === 'AbortError');
  assert.equal(h.cloud.identity.id, 'user-b');
  assert.equal(h.cloud.canPublish, false);
  assert.equal(h.metadata.get(cacheKey(KEY_B)).user.id, 'user-b');
});

test('a late cached-profile read cannot restore a disconnected session', async () => {
  const h = await harness();
  await login(h);
  const pending = deferred();
  const previousGet = h.store.getMeta;
  h.store.getMeta = (key, fallback) => key === cacheKey(KEY_A) ? pending.promise : previousGet(key, fallback);
  const restore = h.cloud.restoreAccess();
  await h.cloud.disconnect();
  pending.resolve(profile());
  assert.equal(await restore, false);
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.cloud.identity, null);
});

test('concurrent connection fingerprints cannot bind a new user to an older key', async () => {
  const pendingHash = deferred();
  const crypto = {
    randomUUID: () => webcrypto.randomUUID(),
    subtle: { digest: (algorithm, bytes) => new TextDecoder().decode(bytes) === KEY_A ? pendingHash.promise : webcrypto.subtle.digest(algorithm, bytes) },
  };
  const h = await harness({ crypto });
  await h.cloud.init();
  const first = h.cloud.connect(API, KEY_A);
  await h.cloud.connect(API, KEY_B);
  pendingHash.resolve(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY_A)));
  await assert.rejects(first, error => error.name === 'AbortError');
  assert.equal(h.cloud.key, KEY_B);
  assert.equal(h.cloud.fingerprint, fingerprint(KEY_B));
  assert.equal(h.cloud.identity.id, 'user-b');
  assert.equal(h.metadata.has(cacheKey(KEY_A)), false);
});

test('owner user management uses its own permissions and the exact versioned API without the song-edit PIN', async () => {
  const h = await harness();
  await login(h);
  h.access.assertEdit = () => { throw new Error('PIN local bloqueado'); };
  const user = { id: 'user-1', name: 'Ana', role: 'player', active: true, offlineHours: 24, version: 1 };
  h.network.handler = async (url, options) => options.method === 'GET' ? { users: [user] } : { user, ...(url.endsWith('/rotate') || options.method === 'POST' ? { key: KEY_B } : {}) };
  assert.equal((await h.cloud.listUsers())[0].name, 'Ana');
  assert.equal((await h.cloud.createUser({ name: 'Ana', role: 'player', offlineHours: 24 })).key, KEY_B);
  assert.equal((await h.cloud.updateUser(user.id, { version: 1, active: false })).user.id, user.id);
  assert.equal((await h.cloud.rotateUserKey(user.id, { version: 1 })).key, KEY_B);
  const operations = h.requests.slice(-4);
  assert.deepEqual(operations.map(call => [call.options.method, call.url]), [
    ['GET', `${API}/v1/users`], ['POST', `${API}/v1/users`], ['PUT', `${API}/v1/users/user-1`], ['POST', `${API}/v1/users/user-1/rotate`],
  ]);
  await assert.rejects(h.cloud.request('/v1/songs/song-1/publish', { method: 'POST', data: {} }), /PIN local bloqueado/);
});

test('expired online verification does not remain valid indefinitely', async () => {
  const h = await harness();
  await login(h);
  h.clock.now += 91000;
  assert.equal(h.cloud.onlineAccess, false);
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.cloud.offlineLeaseActive, true);
});

test('changing API or key cannot reuse an in-memory approved profile', async () => {
  const h = await harness();
  await login(h);
  h.cloud.key = KEY_B;
  assert.equal(h.cloud.canAccess, false);
  h.cloud.key = KEY_A;
  h.cloud.api = 'https://another.test';
  assert.equal(h.cloud.canAccess, false);
});

test('authentication pings time out after ten seconds and preserve an approved live lease', async () => {
  const callbacks = new Map();
  let nextTimer = 0;
  const timers = {
    setTimeout(callback, delay) { assert.equal(delay, 10000); const id = ++nextTimer; callbacks.set(id, callback); return id; },
    clearTimeout(id) { callbacks.delete(id); },
  };
  const h = await harness({ timers });
  await login(h);
  assert.equal(callbacks.size, 0);
  h.clock.now += 91000;
  h.network.handler = (_url, options) => new Promise((_resolve, reject) => {
    assert.equal(options.maxAttempts, 1);
    options.signal.addEventListener('abort', () => reject(new DOMException('Solicitud cancelada', 'AbortError')), { once: true });
  });
  const check = h.cloud.checkAccess();
  // Its expired online proof cannot grant cloud writes, but a pending bounded check retains playback.
  assert.equal(h.cloud.canAccess, true);
  assert.equal(h.cloud.canPublish, false);
  assert.equal(h.cloud.canManageUsers, false);
  assert.equal(callbacks.size, 1);
  [...callbacks.values()][0]();
  assert.equal(await check, true);
  assert.equal(h.cloud.offline, true);
  assert.equal(h.cloud.canAccess, true);
  assert.equal(callbacks.size, 0);
});

test('authentication timeout cannot authorize an unknown key', async () => {
  let timeout;
  const h = await harness({ timers: { setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {} } });
  await h.cloud.init();
  const started = deferred();
  h.network.handler = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Cancelada', 'AbortError')), { once: true });
    started.resolve();
  });
  const connection = h.cloud.connect(API, KEY_B);
  await started.promise;
  timeout();
  await assert.rejects(connection, error => error.code === 'TIMEOUT');
  assert.equal(h.cloud.canAccess, false);
  assert.equal(h.cloud.key, '');
});

test('transfer requests retain their twelve attempts while authentication uses one', async () => {
  const h = await harness();
  await login(h);
  assert.equal(h.requests.find(call => call.url.endsWith('/ping')).options.maxAttempts, 1);
  const controller = new AbortController();
  h.cloud.active = { controller };
  await h.cloud.request('/v1/audio/song/revision/track', { signal: controller.signal });
  assert.equal(h.requests.at(-1).options.maxAttempts, 12);
});

test('an approved cached key can reconnect during a real outage even if navigator reports online', async () => {
  const h = await harness({ cached: profile() });
  h.network.handler = async () => { throw Object.assign(new Error('Sin respuesta'), { code: 'NETWORK' }); };
  await login(h);
  assert.equal(h.cloud.canAccess, true);
  assert.equal(h.cloud.offline, true);
  assert.equal(h.cloud.credentialsVerified, false);
  assert.ok(h.metadata.get(cacheKey(KEY_A)));
  assert.equal(h.requests.length, 1);
});

test('login finishes without waiting for the song catalog', async () => {
  const h = await harness();
  const catalog = deferred();
  h.network.handler = async url => url.endsWith('/ping') ? ping() : catalog.promise;
  const identity = await login(h);
  assert.equal(identity.id, 'owner');
  assert.equal(h.cloud.canAccess, true);
  assert.equal(h.cloud.loading, true);
  catalog.resolve({ songs: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.cloud.loading, false);
});

test('a manual catalog refresh detecting an outage preserves playback under the approved lease', async () => {
  const h = await harness();
  await login(h);
  h.clock.now += 91000;
  h.network.handler = async () => { throw Object.assign(new Error('Sin respuesta'), { code: 'NETWORK' }); };
  await assert.rejects(h.cloud.refresh(), /Sin respuesta/);
  assert.equal(h.cloud.canAccess, true);
  assert.equal(h.cloud.offline, true);
  assert.equal(h.cloud.canPublish, false);
  assert.equal(h.cloud.canManageUsers, false);
});
