/* Integration: real main/session/cloud modules and real Worker, with local R2.
 * Run: node tests/browser-access.cjs. No external service or real credentials. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { webcrypto } = require('node:crypto');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const root = path.resolve(__dirname, '../www');
const qa = process.env.ESCENA_QA_DIR || path.resolve(__dirname, '../../qa');
const OWNER = '1'.repeat(64), WRONG = 'f'.repeat(64);
const results = [], errors = [], blocked = [], requests = [];
const encoder = new TextEncoder();
let worker, browser, origin, env;
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };

// Only operations needed for ping, user administration and an empty catalog.
// R2 etag conditions are implemented; the actual Worker handles authentication.
class Bucket {
  constructor() { this.rows = new Map(); this.serial = 0; }
  object(row) {
    const bytes = row.bytes.slice();
    return { key: row.key, size: bytes.length, etag: row.etag, httpEtag: `"${row.etag}"`, customMetadata: { ...row.customMetadata }, body: new Blob([bytes]).stream(),
      async json() { return JSON.parse(new TextDecoder().decode(bytes)); } };
  }
  async get(key) { const row = this.rows.get(key); return row ? this.object(row) : null; }
  async head(key) { return this.get(key); }
  async put(key, value, options = {}) {
    const previous = this.rows.get(key), conditions = options.onlyIf instanceof Headers ? options.onlyIf : new Headers();
    if (conditions.get('if-none-match') === '*' && previous) return null;
    if (conditions.has('if-match') && (!previous || conditions.get('if-match') !== `"${previous.etag}"`)) return null;
    const bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value).slice();
    const row = { key, bytes, etag: `etag-${++this.serial}`, customMetadata: options.customMetadata || {} };
    this.rows.set(key, row); return this.object(row);
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.rows.delete(key); }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const all = [...this.rows.values()].filter(row => row.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
    const offset = Number(cursor || 0), rows = all.slice(offset, offset + limit), truncated = offset + rows.length < all.length;
    return { objects: rows.map(row => this.object(row)), truncated, cursor: truncated ? String(offset + rows.length) : undefined };
  }
}

function staticResponse(url) {
  if (url.pathname === '/js/cloud-config.js') return { status: 200, contentType: 'text/javascript', body: `export const CLOUD_API_URL = ${JSON.stringify(origin)};` };
  const file = path.resolve(root, '.' + (decodeURIComponent(url.pathname) === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep)) return { status: 403, body: '' };
  try { return { status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) }; }
  catch { return { status: 404, body: 'not found' }; }
}
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/v1/')) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const answer = await worker.fetch(new Request(url, { method: request.method, headers: request.headers, ...(body.length ? { body } : {}) }), env);
      requests.push({ path: url.pathname, method: request.method, status: answer.status });
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer())); return;
    }
    const answer = staticResponse(url);
    response.writeHead(answer.status, { 'Content-Type': answer.contentType || 'text/plain', 'Cache-Control': 'no-store' }); response.end(answer.body);
  } catch (error) { errors.push(`HTTP fixture: ${error.message}`); response.writeHead(500).end('fixture error'); }
});
async function api(url, key, method = 'GET', data) {
  const response = await worker.fetch(new Request(origin + url, { method, headers: { authorization: `Bearer ${key}`, ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
}
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); console.log(`FAIL ${name}: ${error.message}`); }
}
async function contextFor(viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...(viewport.width < 960 ? { isMobile: true, hasTouch: true } : {}) });
  const state = { offlineAssets: false };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { blocked.push(url.href); return route.abort(); }
    // During offline cases, fulfill only static files to model assets cached by
    // the PWA. API requests still use the browser's real offline network state.
    if (state.offlineAssets && !url.pathname.startsWith('/v1/')) return route.fulfill(staticResponse(url));
    return route.continue();
  });
  await context.addInitScript(() => {
    window.__audioContexts = 0; window.__sourceStarts = 0;
    const Native = window.AudioContext || window.webkitAudioContext;
    if (Native) window.AudioContext = new Proxy(Native, { construct(target, args) { window.__audioContexts++; return Reflect.construct(target, args); } });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) { window.__sourceStarts++; return start.apply(this, args); };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, state };
}
async function login(page, key) {
  await page.getByRole('dialog', { name: 'Entrar a Escena' }).waitFor();
  await page.getByLabel('Clave personal', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.evaluate(async () => { window.__app = (await import('/js/app.js')).app; });
  await page.waitForFunction(() => document.body.dataset.session === 'active' && window.__app.ready && window.__app.sessionAllowed);
}
async function stateOf(page) {
  return page.evaluate(async () => {
    const { app } = await import('/js/app.js'), { cloud } = await import('/js/cloud.js'), { access } = await import('/js/access.js');
    window.__app = app;
    return { allowed: app.sessionAllowed, ready: app.ready, engine: Boolean(app.engine), current: Boolean(app.current), jobs: app.jobs.size, warm: app.warm.size,
      edit: access.canEdit, canAccess: cloud.canAccess, role: cloud.identity?.role, canManage: cloud.canManageUsers, starts: window.__sourceStarts, audioContexts: window.__audioContexts };
  });
}
async function seedSong(page) {
  return page.evaluate(async () => {
    const { store } = await import('/js/store.js'), { app } = await import('/js/app.js'), { createSong, createTrackDef } = await import('/js/library.js');
    const rate = 22050, samples = rate * 5, bytes = new ArrayBuffer(44 + samples * 2), view = new DataView(bytes);
    const word = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    word(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i / rate * 220 * Math.PI * 2) * 1000, true);
    const blob = new Blob([bytes], { type: 'audio/wav' }), fileId = 'access-fixture-wav';
    await store.put('files', { id: fileId, blob, name: 'Prueba.wav' });
    const track = createTrackDef({ name: 'Piano', dest: 'main', mono: true, item: { blob } }, fileId, 0); track.duration = 5;
    const song = createSong('Audio local de prueba', [track]); song.click.mute = true; song.guide.mute = true;
    await app.saveSong(song); await app.addToSetlist([song.id]);
    app.setSetting('autoCountIn', false); app.setSetting('keepAwake', false);
    return song.id;
  });
}
async function main() {
  worker = (await import(pathToFileURL(path.resolve(__dirname, '../server/worker.mjs')))).default;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  env = { ESCENA_BUCKET: new Bucket(), ESCENA_KEY: OWNER, ALLOWED_ORIGINS: origin };
  fs.mkdirSync(qa, { recursive: true });
  const executablePath = process.env.ESCENA_CHROMIUM || (fs.existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined);
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const desktop = await contextFor({ width: 1280, height: 900 }), { page } = desktop;
  let musician, offlineMusician, songId;
  await check('Fresh visit stays gated without app initialization or audio; wrong key cannot enter', async () => {
    await page.goto(origin); await page.getByRole('dialog', { name: 'Entrar a Escena' }).waitFor();
    const before = await stateOf(page); assert.equal(before.allowed, false); assert.equal(before.ready, false); assert.equal(before.engine, false); assert.equal(before.audioContexts, 0);
    assert.equal(await page.locator('#app').evaluate(el => el.inert), true);
    await page.screenshot({ path: path.join(qa, 'access-login-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.getByLabel('Clave personal', { exact: true }).fill(WRONG); await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.locator('.session-error').filter({ hasText: /clave|acceso|autorizad/i }).waitFor();
    assert.equal((await stateOf(page)).ready, false); assert.equal((await stateOf(page)).audioContexts, 0);
    assert(requests.some(row => row.path === '/v1/ping' && row.status === 401));
  });
  await check('Owner login authorizes main and real Worker creates personal musicians; logout returns to gate', async () => {
    await login(page, OWNER); const ownerState = await stateOf(page); assert.equal(ownerState.role, 'owner', JSON.stringify(ownerState)); assert.equal(ownerState.canManage, true);
    musician = await page.evaluate(async () => (await import('/js/cloud.js')).cloud.createUser({ name: 'Músico de prueba', role: 'player', offlineHours: 24 }));
    offlineMusician = await page.evaluate(async () => (await import('/js/cloud.js')).cloud.createUser({ name: 'Músico sin conexión', role: 'player', offlineHours: 24 }));
    songId = await seedSong(page);
    await page.evaluate(async () => (await import('/js/cloud.js')).cloud.disconnect());
    await page.getByRole('dialog', { name: 'Entrar a Escena' }).waitFor();
    assert.equal((await stateOf(page)).allowed, false); assert.equal((await stateOf(page)).jobs, 0);
  });
  await check('Personal musician plays cached WAV while edit and user administration remain unavailable', async () => {
    await login(page, musician.key);
    const state = await stateOf(page); assert.equal(state.role, 'player'); assert.equal(state.edit, false); assert.equal(state.canManage, false);
    assert.equal(await page.getByRole('button', { name: 'Usuarios', exact: true }).count(), 0);
    assert.equal(await page.locator('[data-master-only]:visible').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Editar canción', exact: true }).count(), 0);
    await page.evaluate(async songId => { const { app } = await import('/js/app.js'); await app.loadSong(songId); await app.play(); }, songId);
    await page.waitForFunction(() => window.__app.player?.state === 'playing');
    await page.evaluate(() => { window.__playedPlayer = window.__app.player; });
    assert((await stateOf(page)).starts > 0);
  });
  await check('Real Worker revocation closes session and audio; keyboard and action routes cannot restart it', async () => {
    await api(`/v1/users/${musician.user.id}`, OWNER, 'PUT', { version: musician.user.version, active: false });
    const outcome = await page.evaluate(async () => { try { await (await import('/js/cloud.js')).cloud.checkAccess(); return 'allowed'; } catch (error) { return error.status; } });
    assert.equal(outcome, 401);
    await page.getByRole('dialog', { name: 'Entrar a Escena' }).waitFor();
    const before = await stateOf(page); assert.equal(before.allowed, false); assert.equal(before.current, false); assert.equal(before.jobs, 0); assert.equal(before.warm, 0);
    await page.keyboard.press('Space');
    await page.evaluate(async songId => {
      const { app } = await import('/js/app.js');
      for (const id of ['play', 'playPause', 'nextSong', 'toggleClick']) await app.runAction(id);
      await app.loadSong(songId, { autoplay: true }); await app.play(); await app.togglePad(); app.warmUp();
    }, songId);
    const after = await stateOf(page); assert.equal(after.current, false); assert.equal(after.jobs, 0); assert.equal(after.starts, before.starts);
    assert.equal(await page.evaluate(async () => (await import('/js/app.js')).app.pad.active), false);
    assert.equal(await page.evaluate(() => window.__playedPlayer.disposed), true);
  });
  await check('Known offline authorization permits cached playback and expires through the main session timer', async () => {
    await login(page, offlineMusician.key);
    await page.clock.install({ time: new Date() });
    desktop.state.offlineAssets = true; await desktop.context.setOffline(true);
    await page.reload();
    await page.evaluate(async () => { window.__app = (await import('/js/app.js')).app; });
    await page.waitForFunction(() => window.__app.ready && document.body.dataset.session === 'active');
    assert.equal((await stateOf(page)).canAccess, true);
    await page.evaluate(async songId => { const { app } = await import('/js/app.js'); await app.loadSong(songId); await app.play(); }, songId);
    await page.waitForFunction(() => window.__app.player?.state === 'playing');
    const remaining = await page.evaluate(async () => { const { cloud } = await import('/js/cloud.js'); return cloud.accessProfile.verifiedAt + cloud.offlineUntil - cloud.accessProfile.serverTime - Date.now(); });
    assert(remaining > 0); await page.clock.fastForward(Math.max(0, remaining - 100));
    assert.equal((await stateOf(page)).allowed, true);
    await page.clock.fastForward(1100);
    await page.getByRole('dialog', { name: 'Entrar a Escena' }).waitFor();
    const expired = await stateOf(page); assert.equal(expired.allowed, false); assert.equal(expired.canAccess, false); assert.equal(expired.current, false); assert.equal(expired.jobs, 0);
  });
  await check('Mobile login fits screen; an unknown key remains gated offline with no audio initialization', async () => {
    const mobile = await contextFor({ width: 390, height: 844 });
    await mobile.page.goto(origin); await mobile.page.getByRole('dialog', { name: 'Entrar a Escena' }).waitFor();
    await mobile.page.screenshot({ path: path.join(qa, 'access-login-mobile.png'), fullPage: true, animations: 'disabled' });
    const rect = await mobile.page.getByRole('dialog', { name: 'Entrar a Escena' }).boundingBox(); assert(rect.x >= 0); assert(rect.width <= 390);
    mobile.state.offlineAssets = true; await mobile.context.setOffline(true);
    await mobile.page.getByLabel('Clave personal', { exact: true }).fill(WRONG); await mobile.page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await mobile.page.locator('.session-error').filter({ hasText: /internet|conexión/i }).waitFor();
    const state = await stateOf(mobile.page); assert.equal(state.ready, false); assert.equal(state.audioContexts, 0); assert.equal(state.canAccess, false);
    await mobile.context.close();
  });
  const summary = { results, errors, blockedExternalRequests: blocked, protectedRequests: requests,
    note: 'Real www main/cloud/session plus real Worker. Local fake R2, synthetic WAV and test credentials. Offline static fulfillment models cached PWA assets; no actual deployment.' };
  fs.writeFileSync(path.join(qa, 'browser-access-results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ results, errors, blockedExternalRequests: blocked, requestCount: requests.length }, null, 2));
  if (results.some(result => !result.passed) || errors.length || blocked.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
