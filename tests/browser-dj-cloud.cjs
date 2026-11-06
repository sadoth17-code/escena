/* Prueba de navegador de los programas del DJ en la nube (pestaña DJ → «Llevar a otra PC» → «Con tu nube»).
   Cada "dispositivo" es un contexto de navegador nuevo (su propia base de datos, nada en común salvo la nube).
   La nube es el Worker REAL (server/worker.mjs) con un R2 simulado en memoria, servido desde este mismo proceso:
   nada sale de la máquina y todas las claves son de prueba. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');

const root = path.resolve(__dirname, '../www');
const qa = process.env.ESCENA_QA_DIR || path.resolve(__dirname, '../../qa');
const failures = [];
const results = [];
const notes = [];
let browser;
let world;
let worker;
let MASTER;

// ---------------------------------------------------------------- canciones de prueba (tonos puros)

function wavBytes({ freq, seconds, amp = 0.3, rate = 22050 }) {
  const samples = Math.floor(rate * seconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767), 44 + i * 2);
  return buffer;
}

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'escena-dj-nube-'));
const songDir = path.join(workDir, 'canciones');
fs.mkdirSync(songDir);
const makeSong = ({ name, freq, seconds }) => {
  const file = path.join(songDir, `${name}.wav`);
  fs.writeFileSync(file, wavBytes({ freq, seconds }));
  return { name, freq, file, sha: sha(fs.readFileSync(file)), size: fs.statSync(file).size };
};
// La 4.ª pasa de 8 MiB: en la nube viaja en dos partes.
const ANA = makeSong({ name: '01 Ana', freq: 400, seconds: 10 });
const BETO = makeSong({ name: '02 Beto', freq: 570, seconds: 10 });
const CARLA = makeSong({ name: '03 Carla', freq: 740, seconds: 10 });
const DIEGO = makeSong({ name: '04 Diego largo', freq: 910, seconds: 192 });
const DESFILE = makeSong({ name: '05 Desfile largo', freq: 1200, seconds: 192 });
const SOLO_EDITOR = makeSong({ name: '06 Solo editor', freq: 1000, seconds: 6 });
const SOLO_TELEFONO = makeSong({ name: '07 Solo telefono', freq: 1300, seconds: 6 });
const BODA = [ANA, BETO, CARLA, DIEGO];
const BODA_TITLES = ['Entrada de los novios', 'Madrina Rosa', '03 Carla', '04 Diego largo'];

// ---------------------------------------------------------------- servidor: la app + el Worker real

const hooks = { before: null, oldWorker: false, log: [] };
let server;

async function bridge(request, response, url) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  if (hooks.before) await hooks.before(request.method, url.pathname);
  let result;
  if (hooks.oldWorker && url.pathname.startsWith('/v1/dj/')) {
    result = new Response(JSON.stringify({ error: 'Ruta no encontrada' }), { status: 404, headers: { 'content-type': 'application/json' } });
  } else {
    const init = { method: request.method, headers };
    if (!['GET', 'HEAD'].includes(request.method)) init.body = Buffer.concat(chunks);
    result = await worker.fetch(new Request(`http://worker.test${request.url}`, init), world.env);
  }
  let payload = Buffer.from(await result.arrayBuffer());
  if (hooks.oldWorker && url.pathname === '/v1/ping' && result.ok) {
    const data = JSON.parse(payload.toString('utf8'));
    if (data.features) delete data.features.dj; // un Worker anterior no conoce lo del DJ
    payload = Buffer.from(JSON.stringify(data));
  }
  hooks.log.push({ method: request.method, path: url.pathname, status: result.status });
  const out = {};
  result.headers.forEach((value, name) => {
    if (!['content-length', 'transfer-encoding', 'connection'].includes(name)) out[name] = value;
  });
  response.on('error', () => {});
  response.writeHead(result.status, out);
  response.end(payload);
}

function startServer() {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/js/cloud-config.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(`export const CLOUD_API_URL = ${JSON.stringify(`http://127.0.0.1:${server.address().port}`)};`);
      return;
    }
    if (url.pathname.startsWith('/v1/')) {
      bridge(request, response, url).catch((error) => {
        try { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: String(error && error.message || error) })); } catch { /* ya cerrada */ }
      });
      return;
    }
    let relative;
    try { relative = decodeURIComponent(url.pathname); } catch { response.writeHead(400).end(); return; }
    const file = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
    if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };
    fs.readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404).end('not found'); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      if (file === path.join(root, 'js', 'dj-engine.js')) {
        response.end(bytes.toString('utf8') + '\nconst __djEnsure = DjEngine.prototype.ensure;\nDjEngine.prototype.ensure = function (...args) { window.__djEngine = this; return __djEnsure.apply(this, args); };\n');
        return;
      }
      if (file === path.join(root, 'js', 'dj-mount.js')) {
        response.end(bytes.toString('utf8').replace('export async function mountDj(', 'async function __mountDj(') + '\nexport async function mountDj(...args) { const mounted = await __mountDj(...args); window.__dj = mounted; return mounted; }\n');
        return;
      }
      response.end(bytes);
    });
  });
}

const openDevices = [];
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) {
    failures.push({ name, error: error.stack });
    results.push({ name, passed: false });
    console.log(`FAIL ${name}: ${String(error.message).split('\n').slice(0, 6).join('\n')}`);
    hooks.before = null;
    hooks.oldWorker = false;
    for (const device of openDevices) {
      for (let i = 0; i < 3; i++) await device.page.keyboard.press('Escape').catch(() => {});
    }
  }
}

const note = (text) => { notes.push(text); console.log(`NOTE ${text}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = () => hooks.log.length;
const since = (from, method, pathname) => hooks.log.slice(from).filter((item) => item.method === method && item.path === pathname);
const cloudKeys = (prefix) => [...world.bucket.rows.keys()].filter((key) => key.startsWith(prefix)).sort();
const openUploads = () => [...world.bucket.uploads.values()].filter((upload) => !world.bucket.rows.has(upload.key));
const cloudProgram = (id) => JSON.parse(Buffer.from(world.bucket.rows.get(`dj/programs/${id}.json`).bytes).toString('utf8'));

// ---------------------------------------------------------------- dispositivos de prueba

const MIDI_MOCK = () => {
  const input = {
    id: 'mock-in-1', name: 'Controlador de prueba', manufacturer: 'Prueba', state: 'connected', type: 'input', connection: 'closed', onmidimessage: null,
    listeners: new Set(),
    addEventListener(type, fn) { if (type === 'midimessage') this.listeners.add(fn); },
    removeEventListener(type, fn) { this.listeners.delete(fn); },
    open() { this.connection = 'open'; return Promise.resolve(this); },
    close() { this.connection = 'closed'; return Promise.resolve(this); },
  };
  const access = { inputs: new Map([[input.id, input]]), outputs: new Map(), sysexEnabled: false, onstatechange: null, addEventListener() {}, removeEventListener() {} };
  navigator.requestMIDIAccess = async () => access;
  window.__midiSend = (bytes) => {
    const event = { data: new Uint8Array(bytes), target: input, timeStamp: performance.now() };
    for (const fn of Array.from(input.listeners)) fn(event);
    if (input.onmidimessage) input.onmidimessage(event);
  };
};

// Un dispositivo: contexto nuevo y la app. Como la app pide la clave personal antes de mostrar nada, se entra igual que lo haría
// una persona: pegando su clave en la pantalla «Entrar a Escena».
async function openDevice(viewport, origin, { key }) {
  const context = await browser.newContext({
    viewport,
    serviceWorkers: 'block',
    ...(viewport.width < 960 ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36' } : {}),
  });
  const blocked = [];
  await context.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    if (target.origin === origin || ['data:', 'blob:'].includes(target.protocol)) await route.continue();
    else { blocked.push(target.href); await route.abort(); }
  });
  await context.addInitScript(() => {
    window.__errors = [];
    window.__toasts = [];
    window.addEventListener('error', (event) => window.__errors.push(String(event.error || event.message)));
    window.addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
    // Los avisos duran pocos segundos: se anotan todos para poder comprobarlos sin carreras.
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1 && node.classList && node.classList.contains('toast')) window.__toasts.push(node.textContent);
    }).observe(document, { childList: true, subtree: true });
  });
  await context.addInitScript(MIDI_MOCK);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource|net::ERR|favicon/i.test(text)) return;
    consoleErrors.push(text);
  });
  if (process.env.ESCENA_DEBUG) {
    page.on('console', (message) => console.log(`  [consola ${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => console.log(`  [pageerror] ${error.message}`));
    page.on('response', (response) => { if (response.status() >= 400) console.log(`  [http ${response.status()}] ${response.url()}`); });
    page.on('requestfailed', (request) => console.log(`  [falló] ${request.url()} ${request.failure() && request.failure().errorText}`));
  }
  await page.goto(origin);
  await page.waitForSelector('.session-gate input', { timeout: 30000 });
  await page.fill('.session-gate input', key);
  await page.click('.session-gate button[type="submit"]');
  await page.waitForSelector('.session-gate', { state: 'detached', timeout: 30000 });
  await page.waitForSelector('.layout');
  const who = await page.evaluate(async () => {
    const { cloud } = await import('/js/cloud.js');
    return { name: cloud.identity.name, role: cloud.identity.role, canPublish: cloud.canPublish, canDelete: cloud.canDelete };
  });
  await openDjTab(page);
  return { context, page, blocked, consoleErrors, who };
}

async function openDjTab(page) {
  await page.locator('.tabbar .tab', { hasText: 'DJ' }).click();
  await page.waitForSelector('.panel-dj .dj');
  await page.waitForFunction(() => window.__dj && window.__dj.djCloud);
}

async function installTap(page) {
  await page.waitForFunction(() => window.__djEngine, null, { timeout: 15000 });
  await page.evaluate(() => {
    if (window.__tap) return;
    const engine = window.__djEngine;
    const ctx = engine.ctx;
    const tap = ctx.createAnalyser();
    tap.fftSize = 4096;
    tap.smoothingTimeConstant = 0;
    engine.analyser.connect(tap);
    const buffer = new Float32Array(tap.fftSize);
    const amp = (freq) => {
      let re = 0, im = 0;
      const n = buffer.length;
      for (let i = 0; i < n; i++) {
        const x = buffer[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
        const angle = (2 * Math.PI * freq * i) / ctx.sampleRate;
        re += x * Math.cos(angle);
        im -= x * Math.sin(angle);
      }
      return (2 * Math.hypot(re, im)) / (n * 0.5);
    };
    window.__tap = { read(freqs) { tap.getFloatTimeDomainData(buffer); return freqs.map(amp); } };
  });
}

const rows = (page) => page.evaluate(() => window.__dj.dj.items().map((item) => ({ id: item.id, title: item.title, missing: item.missing, number: item.number })));
const press = (page, act) => page.locator(`.dj [data-act="${act}"]`).first().click();
const storedBlobs = (page) => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('escena-dj'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const stored = await new Promise((resolve) => { const request = db.transaction('blobs', 'readonly').objectStore('blobs').getAll(); request.onsuccess = () => resolve(request.result); });
  const out = [];
  for (const row of stored) {
    const digest = await crypto.subtle.digest('SHA-256', await row.blob.arrayBuffer());
    out.push(Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join(''));
  }
  db.close();
  return out.sort();
});

const programOf = (page) => page.evaluate(() => { const program = window.__dj.dj.program(); return { id: program.id, name: program.name, cloud: program.cloud || null, items: program.items.length }; });
const toastsOf = (page) => page.evaluate(() => window.__toasts.slice());
const waitToast = (page, pattern, timeout = 30000) => page.waitForFunction(({ source, flags }) => {
  const at = window.__toasts.findIndex((text) => new RegExp(source, flags).test(text));
  if (at < 0) return false;
  window.__toasts.splice(at, 1);
  return true;
}, { source: pattern.source, flags: pattern.flags }, { timeout });
const hasToast = async (page, pattern) => (await toastsOf(page)).some((text) => pattern.test(text));
const idle = (page, timeout = 90000) => page.waitForFunction(() => !window.__dj.djCloud.state.busy && !window.__dj.dj.state.importing && !window.__dj.dj.state.exporting, null, { timeout });
const cloudLoaded = (page) => page.waitForFunction(() => window.__dj.djCloud.state.loaded && !window.__dj.djCloud.state.loading, null, { timeout: 20000 });

async function openTransfer(page, { tap = false } = {}) {
  const button = page.locator('.dj [data-act="transfer"]').first();
  if (tap) await button.tap(); else await button.click();
  await page.waitForSelector('.dj-transfer');
  await page.waitForSelector('.dj-transfer [data-role="cloud"]');
}
async function closeTransfer(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dj-transfer', { state: 'detached' });
}
const cloudText = (page) => page.locator('.dj-transfer [data-role="cloud"]').innerText();
const cloudRow = (page, id) => page.locator(`.dj-cloudrow[data-id="${id}"]`);

// Anota los avisos de la nube que se ven mientras se sube o se trae.
const watchBanners = (page) => page.evaluate(() => {
  window.__banners = new Set();
  window.__cancelSeen = false;
  clearInterval(window.__bannerTimer);
  window.__bannerTimer = setInterval(() => {
    const banner = document.querySelector('[data-banner="cloud"]');
    if (!banner) return;
    window.__banners.add(banner.innerText.replace(/\s+/g, ' ').trim());
    if (banner.querySelector('[data-act="cloud-cancel"]')) window.__cancelSeen = true;
  }, 10);
});
const bannersOf = (page) => page.evaluate(() => ({ texts: Array.from(window.__banners), cancel: window.__cancelSeen }));

const fits = (page, selector) => page.evaluate((selector) => {
  const el = document.querySelector(selector);
  const box = el.getBoundingClientRect();
  return { page: document.documentElement.scrollWidth <= window.innerWidth, inner: el.scrollWidth <= el.clientWidth + 1, left: box.left >= -0.5, right: box.right <= window.innerWidth + 0.5 };
}, selector);

// ---------------------------------------------------------------- pruebas

async function main() {
  fs.mkdirSync(qa, { recursive: true });
  const helper = await import(pathToFileURL(path.resolve(__dirname, 'helpers/cloud-world.mjs')).href);
  worker = (await import(pathToFileURL(path.resolve(__dirname, '../server/worker.mjs')).href)).default;
  world = helper.world();
  MASTER = helper.MASTER;
  const editorKey = await world.createUser('Elena (editora)', 'editor');
  const playerKey = await world.createUser('Pablo (músico)', 'player');
  startServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  world.env.ALLOWED_ORIGINS = origin;
  browser = await chromium.launch({
    executablePath: process.env.ESCENA_CHROMIUM || (fs.existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined),
    headless: true,
    args: ['--no-sandbox', ...(process.env.ESCENA_STRICT_AUTOPLAY ? [] : ['--autoplay-policy=no-user-gesture-required'])],
  });

  const devices = [];
  const open = async (...args) => { const device = await openDevice(...args); devices.push(device); openDevices.push(device); return device; };

  // ---- Dispositivo A (propietario): arma el programa
  const A = await open({ width: 1440, height: 900 }, origin, { key: MASTER });
  const a = A.page;
  let cloudId = null;

  await check('Equipo A (propietario): arma el programa de la boda con 4 canciones, una de más de 8 MiB', async () => {
    assert.deepEqual(A.who, { name: 'Propietario', role: 'owner', canPublish: true, canDelete: true });
    assert(DIEGO.size > 8 * 1024 * 1024, 'la canción larga pasa de 8 MiB');
    await a.setInputFiles('.dj input.dj-file', BODA.map((song) => song.file));
    await a.waitForFunction(() => document.querySelectorAll('.dj-row').length === 4, null, { timeout: 40000 });
    await a.evaluate(() => {
      const dj = window.__dj.dj;
      const [first, second] = dj.items();
      dj.updateItem(first.id, { label: 'Entrada de los novios', start: 2, maxDur: 8, gainDb: -3 });
      dj.updateItem(second.id, { label: 'Madrina Rosa' });
      dj.renameProgram(dj.program().id, 'Boda Prueba');
      dj.setFade(3);
    });
    await a.evaluate(() => window.__dj.dj.enableMidi());
    const learning = a.evaluate(() => window.__dj.dj.learn('slot:1', { replace: true }));
    await sleep(150);
    await a.evaluate(() => window.__midiSend([0x90, 36, 100]));
    await learning;
    await a.waitForFunction(() => document.querySelector('.dj-row .dj-badge'), null, { timeout: 5000 });
    assert.deepEqual((await rows(a)).map((row) => row.title), BODA_TITLES);
  });

  await check('«Con tu nube»: con la nube conectada y vacía, ofrece subir el programa y dice cuánto pesa', async () => {
    await openTransfer(a);
    await a.waitForSelector('[data-role="cloud-empty"]', { timeout: 20000 });
    const text = await cloudText(a);
    assert.match(text, /con tu nube/i);
    assert.match(text, /Subir «Boda Prueba» a la nube/);
    assert.match(text, /4 participantes, 4 canciones: unos \d+(\.\d)? MB\. Las canciones que ya estén en tu nube no se vuelven a subir\./);
    assert.match(text, /Todavía no hay programas del DJ en tu nube\./);
    assert(!(await a.locator('.dj-choice[data-act="cloud-upload"]').isDisabled()));
    assert.equal(await a.locator('[data-act="cloud-upload-new"]').count(), 0, 'todavía no hay nada que actualizar');
    assert.match(await a.locator('.dj-transfer').innerText(), /Paquete completo \(\.zip\)/, 'lo de llevar un archivo sigue ahí');
    await a.screenshot({ path: path.join(qa, 'nube-1-vacia.png') });
    await closeTransfer(a);
  });

  await check('Subir: se ve el avance con «Cancelar», las canciones llegan idénticas a la nube y el programa queda vinculado', async () => {
    hooks.before = async (method, pathname) => { if (pathname === '/v1/dj/uploads/part') await sleep(150); };
    await watchBanners(a);
    await openTransfer(a);
    await a.waitForSelector('[data-role="cloud-empty"]');
    const from = mark();
    await a.locator('.dj-choice[data-act="cloud-upload"]').click();
    await a.waitForSelector('.dj-transfer', { state: 'detached' });
    await a.waitForSelector('[data-banner="cloud"]');
    await waitToast(a, /«Boda Prueba» está en tu nube: 4 canciones \(4 subidas ahora\)\./);
    hooks.before = null;
    await idle(a);
    const banners = await bannersOf(a);
    assert(banners.texts.some((text) => /Subiendo «Boda Prueba» a tu nube… \d+%/.test(text)), `avisos: ${banners.texts.join(' | ')}`);
    assert(banners.texts.some((text) => /Subiendo «Boda Prueba» a tu nube… (?!0%)\d+%/.test(text)), 'el porcentaje avanza');
    assert(banners.cancel, 'mientras sube se puede cancelar');
    assert.equal(since(from, 'POST', '/v1/dj/uploads/start').length, 4);
    assert.equal(since(from, 'PUT', '/v1/dj/uploads/part').length, 5, 'tres canciones en una parte y la larga en dos');
    assert.equal(since(from, 'POST', '/v1/dj/uploads/complete').length, 4);
    // lo que quedó en la nube: 1 programa y 4 canciones idénticas a las originales, byte por byte
    const programs = cloudKeys('dj/programs/');
    assert.equal(programs.length, 1);
    const audio = cloudKeys('dj/audio/');
    assert.equal(audio.length, 4);
    assert.deepEqual(audio.map((key) => sha(Buffer.from(world.bucket.rows.get(key).bytes))).sort(), BODA.map((song) => song.sha).sort());
    assert.equal(openUploads().length, 0, 'no quedan subidas a medias');
    const program = await programOf(a);
    assert(program.cloud && program.cloud.id && program.cloud.revision, 'el programa quedó vinculado a la nube');
    assert.equal(programs[0], `dj/programs/${program.cloud.id}.json`);
    cloudId = program.cloud.id;
    const stored = cloudProgram(cloudId);
    assert.equal(stored.revision, program.cloud.revision);
    assert.equal(stored.package.programs[0].name, 'Boda Prueba');
    assert.equal(stored.files.length, 4);
    await a.screenshot({ path: path.join(qa, 'nube-2-subido.png') });
  });

  await check('Después de subir: «al día», aparece en la lista de la nube y ofrece subir los cambios o un programa nuevo', async () => {
    await openTransfer(a);
    await cloudLoaded(a);
    await a.waitForSelector('[data-role="cloud-list"]');
    const text = await cloudText(a);
    assert.match(await a.locator('[data-role="cloud-status"]').innerText(), /Este programa está en tu nube y al día \(subido por Propietario, hace un momento\)\./);
    assert.match(text, /Subir los cambios de «Boda Prueba»/);
    assert.equal(await a.locator('[data-act="cloud-upload-new"]').count(), 1);
    const row = cloudRow(a, cloudId);
    assert.equal(await row.count(), 1);
    assert.match(await row.innerText(), /Boda Prueba[\s\S]*4 participantes · 4 canciones · \d+(\.\d)? MB · Propietario · hace un momento/);
    assert(await row.evaluate((el) => el.classList.contains('is-mine')), 'marca el que ya está en este equipo');
    assert.equal(await row.locator('[data-act="cloud-get"]').count(), 1);
    assert.equal(await row.locator('[data-act="cloud-delete"]').count(), 1, 'el propietario puede eliminar');
    await a.screenshot({ path: path.join(qa, 'nube-3-lista.png') });
    await closeTransfer(a);
  });

  // ---- Dispositivo B (otro equipo, otro navegador): trae el programa
  const B = await open({ width: 1440, height: 900 }, origin, { key: MASTER });
  const b = B.page;

  await check('Equipo B: ve el programa en la nube, lo trae y quedan programa, canciones idénticas, pad y mezcla', async () => {
    assert.equal((await rows(b)).length, 0, 'el equipo B parte sin nada');
    await openTransfer(b);
    await cloudLoaded(b);
    await b.waitForSelector(`.dj-cloudrow[data-id="${cloudId}"]`);
    assert.equal(await b.locator('.dj-cloudrow.is-mine').count(), 0, 'aquí todavía no lo tiene');
    await cloudRow(b, cloudId).locator('[data-act="cloud-get"]').click();
    await b.waitForSelector('.dj-import');
    const text = await b.locator('.dj-import').innerText();
    assert.match(await b.locator('.dj-import-modal .modal-head h2').innerText(), /Traer un programa de la nube/);
    assert.match(text, /Boda Prueba · en tu nube · subido por Propietario · hace un momento/);
    assert.match(text, /Boda Prueba · 4 participantes/);
    assert.match(text, /4 canciones nuevas con audio · \d+(\.\d)? MB · se guardan en este dispositivo/);
    assert.equal(await b.locator('[data-role="import-linked"]').count(), 0);
    assert(await b.locator('[data-role="import-settings"]').isVisible());
    assert.match(text, /Usar también la mezcla y los pads de la nube/);
    assert.match(text, /Los pads y las teclas quedan asignados igual que en el equipo que lo subió\./);
    await b.screenshot({ path: path.join(qa, 'nube-4-traer.png') });
    await watchBanners(b);
    hooks.before = async (method, pathname) => { if (pathname.startsWith('/v1/dj/audio/')) await sleep(120); };
    await b.locator('.modal-foot .btn.primary', { hasText: 'Traer el programa' }).click();
    await b.waitForSelector('[data-banner="cloud"]');
    await b.waitForFunction(() => document.querySelectorAll('.dj-row').length === 4, null, { timeout: 60000 });
    await idle(b);
    hooks.before = null;
    assert.deepEqual((await rows(b)).map((row) => row.title), BODA_TITLES);
    assert((await rows(b)).every((row) => !row.missing));
    const banners = await bannersOf(b);
    assert(banners.texts.some((text) => /Trayendo «Boda Prueba» de tu nube… \d+ de 4/.test(text)), `avisos: ${banners.texts.join(' | ')}`);
    assert(banners.cancel, 'mientras baja se puede cancelar');
    assert.deepEqual(await storedBlobs(b), BODA.map((song) => song.sha).sort(), 'las 4 canciones están guardadas y son idénticas a las originales');
    assert.match(await b.locator('.dj-row').first().locator('.dj-row-sub').textContent(), /0:10 · desde 0:02 · máx\. 0:08 · -3 dB/);
    assert.match(await b.locator('.dj-row').first().locator('.dj-badge').textContent(), /Nota 36/, 'el pad viajó con el programa');
    assert.equal(await b.evaluate(() => window.__dj.dj.state.settings.fade), 3);
    assert.equal(await b.locator('.dj-program-select option:checked').textContent(), 'Boda Prueba');
    const program = await programOf(b);
    assert.equal(program.cloud.id, cloudId, 'queda vinculado al mismo programa de la nube');
    assert.equal(program.cloud.revision, cloudProgram(cloudId).revision);
    assert(await hasToast(b, /Programa «Boda Prueba» traído/));
  });

  await check('Equipo B: las canciones que bajaron de la nube suenan de verdad (se mide la salida)', async () => {
    await b.waitForFunction(() => document.querySelector('.dj-next .dj-dot.ready'), null, { timeout: 20000 });
    await press(b, 'next');
    await b.waitForFunction(() => window.__djEngine && window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing', null, { timeout: 10000 });
    await installTap(b);
    await sleep(900);
    const [tone] = await b.evaluate((freqs) => window.__tap.read(freqs), [ANA.freq]);
    assert(tone > 0.15 && tone < 0.35, `suena la canción 1 (400 Hz) a su nivel: ${tone.toFixed(3)}`);
    await press(b, 'panic');
    await b.waitForFunction(() => window.__dj.dj.state.transport === 'idle');
  });

  await check('Equipo B: el mismo programa ya está al día en B (no se ofrece nada por actualizar)', async () => {
    await openTransfer(b);
    await cloudLoaded(b);
    assert.match(await b.locator('[data-role="cloud-status"]').innerText(), /Este programa está en tu nube y al día/);
    assert(await cloudRow(b, cloudId).evaluate((el) => el.classList.contains('is-mine')));
    await closeTransfer(b);
  });

  await check('Actualizar: A cambia el programa y sube solo los cambios (sin repetir canciones); B lo actualiza en su sitio', async () => {
    await a.evaluate(() => {
      const dj = window.__dj.dj;
      dj.updateItem(dj.items()[1].id, { label: 'Madrina Rosa y Pedro' });
    });
    await openTransfer(a);
    await cloudLoaded(a);
    assert.match(await a.locator('[data-role="cloud-status"]').innerText(), /Tienes cambios en este programa que todavía no están en la nube\./);
    const before = (await programOf(a)).cloud;
    const from = mark();
    await a.locator('.dj-choice[data-act="cloud-upload"]').click();
    await waitToast(a, /«Boda Prueba» está en tu nube: 4 canciones \(ya estaban todas\)\./);
    await idle(a);
    assert.equal(since(from, 'PUT', '/v1/dj/uploads/part').length, 0, 'no se volvió a subir ninguna canción');
    assert.equal(since(from, 'POST', '/v1/dj/uploads/start').length, 4, 'se preguntó por las 4 y la nube ya las tenía');
    assert.equal(cloudKeys('dj/programs/').length, 1, 'sigue siendo el mismo programa de la nube');
    const after = (await programOf(a)).cloud;
    assert.equal(after.id, before.id);
    assert.notEqual(after.revision, before.revision, 'la nube tiene una versión nueva');
    // B se entera y lo trae encima del suyo
    await openTransfer(b);
    await cloudLoaded(b);
    assert.match(await b.locator('[data-role="cloud-status"]').innerText(), /La nube tiene una versión más nueva de este programa, subida por Propietario\. Tráela para ponerlo al día\./);
    await cloudRow(b, cloudId).locator('[data-act="cloud-get"]').click();
    await b.waitForSelector('.dj-import');
    assert.match(await b.locator('[data-role="import-linked"]').innerText(), /Ya tienes «Boda Prueba» en este dispositivo, vinculado a este programa de la nube\./);
    assert.match(await b.locator('[data-role="import-mode"]').innerText(), /Se reemplazan los participantes de «Boda Prueba» por los de la nube\./);
    assert.equal(await b.locator('.dj-import .seg[aria-checked="true"]').innerText(), 'Actualizar mi programa');
    assert(await b.locator('.modal-foot .btn.primary', { hasText: 'Actualizar el programa' }).isVisible());
    await b.screenshot({ path: path.join(qa, 'nube-5-actualizar.png') });
    // al cambiar a «programa nuevo» el texto y el botón lo reflejan; se cancela sin cambiar nada
    await b.locator('.dj-import .seg', { hasText: 'Traer como programa nuevo' }).click();
    assert.match(await b.locator('[data-role="import-mode"]').innerText(), /Se crea un programa nuevo y «Boda Prueba» no cambia\./);
    assert(await b.locator('.modal-foot .btn.primary', { hasText: 'Traer el programa' }).isVisible());
    await b.locator('.dj-import .seg', { hasText: 'Actualizar mi programa' }).click();
    const programBefore = await programOf(b);
    const programCount = await b.evaluate(() => window.__dj.dj.state.programs.length);
    await b.locator('.modal-foot .btn.primary', { hasText: 'Actualizar el programa' }).click();
    await b.waitForFunction((revision) => window.__dj.dj.program().cloud && window.__dj.dj.program().cloud.revision === revision, after.revision, { timeout: 60000 });
    await idle(b);
    const programAfter = await programOf(b);
    assert.equal(programAfter.id, programBefore.id, 'es el mismo programa de B, actualizado en su sitio');
    assert.equal(await b.evaluate(() => window.__dj.dj.state.programs.length), programCount, 'no se duplicó');
    assert.deepEqual((await rows(b)).map((row) => row.title), ['Entrada de los novios', 'Madrina Rosa y Pedro', '03 Carla', '04 Diego largo']);
    assert.equal((await storedBlobs(b)).length, 4, 'no se bajó ninguna canción otra vez');
    await openTransfer(b);
    await cloudLoaded(b);
    assert.match(await b.locator('[data-role="cloud-status"]').innerText(), /Este programa está en tu nube y al día/);
    await closeTransfer(b);
  });

  await check('Conflicto: si dos equipos cambian el programa, el segundo no pisa al primero; puede subir el suyo como programa nuevo', async () => {
    await a.evaluate(() => { const dj = window.__dj.dj; dj.updateItem(dj.items()[0].id, { label: 'Entrada (versión de A)' }); });
    await openTransfer(a);
    await cloudLoaded(a);
    await a.locator('.dj-choice[data-act="cloud-upload"]').click();
    await waitToast(a, /«Boda Prueba» está en tu nube/);
    await idle(a);
    const revisionA = (await programOf(a)).cloud.revision;
    // B todavía tiene la versión anterior y también hizo cambios
    await b.evaluate(() => { const dj = window.__dj.dj; dj.updateItem(dj.items()[2].id, { label: 'Carla (versión de B)' }); });
    await openTransfer(b);
    await cloudLoaded(b);
    const note = await b.locator('[data-role="cloud-status"]').innerText();
    assert.match(note, /La nube tiene una versión más nueva de este programa/);
    assert.match(note, /Tienes cambios en este programa que todavía no están en la nube\./);
    await b.locator('.dj-choice[data-act="cloud-upload"]').click();
    await waitToast(b, /La nube tiene otra versión de este programa \(se subió desde otro equipo\)\. Tráela primero con «Traer», o súbelo como programa nuevo\./);
    await idle(b);
    assert.equal(cloudProgram(cloudId).revision, revisionA, 'la nube sigue con la versión de A');
    assert.equal(cloudKeys('dj/programs/').length, 1);
    // B sube lo suyo como programa nuevo (las canciones ya estaban: no se repiten)
    await openTransfer(b);
    await cloudLoaded(b);
    const from = mark();
    await b.locator('[data-act="cloud-upload-new"]').click();
    await waitToast(b, /«Boda Prueba» está en tu nube: 4 canciones \(ya estaban todas\)\./);
    await idle(b);
    assert.equal(since(from, 'PUT', '/v1/dj/uploads/part').length, 0);
    assert.equal(cloudKeys('dj/programs/').length, 2, 'ahora hay dos programas en la nube');
    assert.equal(cloudKeys('dj/audio/').length, 4, 'las mismas 4 canciones, guardadas una sola vez');
    assert.equal(cloudProgram(cloudId).revision, revisionA, 'el de A no se tocó');
    const link = (await programOf(b)).cloud;
    assert.notEqual(link.id, cloudId, 'el programa de B pasa a seguir al nuevo');
    assert.equal(link.id.length >= 8, true);
  });

  await check('Cancelar una subida: el aviso desaparece, no queda nada a medias en la nube y se puede repetir', async () => {
    await a.evaluate(async () => { const dj = window.__dj.dj; await dj.createProgram('Desfile'); });
    await a.setInputFiles('.dj input.dj-file', [DESFILE.file]);
    await a.waitForFunction(() => document.querySelectorAll('.dj-row').length === 1 && !window.__dj.dj.state.importing, null, { timeout: 40000 });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let waiting = 0;
    hooks.before = async (method, pathname) => { if (pathname === '/v1/dj/uploads/part') { waiting++; await gate; } };
    const programs = cloudKeys('dj/programs/').length;
    await openTransfer(a);
    await cloudLoaded(a);
    assert.match(await cloudText(a), /Subir «Desfile» a la nube/);
    await a.locator('.dj-choice[data-act="cloud-upload"]').click();
    for (let i = 0; i < 200 && !waiting; i++) await sleep(50);
    assert(waiting >= 1, 'la subida llegó a mandar una parte');
    await a.waitForSelector('[data-banner="cloud"][data-phase="upload"] [data-act="cloud-cancel"]');
    await a.screenshot({ path: path.join(qa, 'nube-6-cancelar.png') });
    await a.locator('[data-banner="cloud"] [data-act="cloud-cancel"]').click();
    await waitToast(a, /Subida cancelada\. Lo que ya se subió se aprovecha si la repites\./);
    await idle(a);
    release();
    hooks.before = null;
    await sleep(300);
    assert.equal(await a.locator('[data-banner="cloud"]').count(), 0);
    assert.equal(cloudKeys('dj/programs/').length, programs, 'el programa no llegó a publicarse');
    assert.equal(openUploads().length, 0, 'la subida por partes se descartó');
    assert.equal(cloudKeys('dj/audio/').length, 4, 'la canción a medias no quedó guardada');
    assert.equal((await programOf(a)).cloud, null, 'el programa no quedó vinculado');
    // se repite y funciona
    await openTransfer(a);
    await cloudLoaded(a);
    await a.locator('.dj-choice[data-act="cloud-upload"]').click();
    await waitToast(a, /«Desfile» está en tu nube: 1 canción \(1 subida ahora\)\./);
    await idle(a);
    assert.equal(cloudKeys('dj/programs/').length, programs + 1);
    assert.equal(cloudKeys('dj/audio/').length, 5);
    assert.equal(openUploads().length, 0);
  });

  await check('Eliminar (solo el propietario): se pide confirmación, se borra para todos y la canción exclusiva se limpia', async () => {
    await openTransfer(b);
    await cloudLoaded(b);
    const desfile = (await a.evaluate(() => window.__dj.dj.program().cloud)).id;
    await b.waitForSelector(`.dj-cloudrow[data-id="${desfile}"]`);
    assert.equal(await b.locator('.dj-cloudrow').count(), 3);
    // cancelar la confirmación no borra nada
    await cloudRow(b, desfile).locator('[data-act="cloud-delete"]').click();
    await b.waitForSelector('.modal-foot .btn.danger');
    assert.match(await b.locator('.modal-text').innerText(), /¿Eliminar «Desfile» de tu nube\? Se borra para todos los equipos conectados; los que ya lo trajeron conservan su copia\./);
    await sleep(500); // que termine la animación de la ventana
    await b.screenshot({ path: path.join(qa, 'nube-7-eliminar.png') });
    await b.locator('.modal-foot .btn', { hasText: 'Cancelar' }).last().click();
    await sleep(200);
    assert.equal(cloudKeys('dj/programs/').length, 3);
    // y ahora sí
    await cloudRow(b, desfile).locator('[data-act="cloud-delete"]').click();
    await b.locator('.modal-foot .btn.danger').click();
    await waitToast(b, /«Desfile» se eliminó de la nube\. Los equipos que ya lo trajeron conservan su copia\./);
    await idle(b);
    await b.waitForFunction((id) => !document.querySelector(`.dj-cloudrow[data-id="${id}"]`), desfile);
    assert.equal(cloudKeys('dj/programs/').length, 2);
    assert.equal(cloudKeys('dj/audio/').length, 4, 'la canción que solo usaba «Desfile» se borró; las de la boda siguen');
    assert.deepEqual(cloudKeys('dj/audio/').map((key) => sha(Buffer.from(world.bucket.rows.get(key).bytes))).sort(), BODA.map((song) => song.sha).sort());
    await closeTransfer(b);
    // A: su programa ya no está en la nube y lo dice; su copia local sigue ahí
    await openTransfer(a);
    await cloudLoaded(a);
    assert.match(await a.locator('[data-role="cloud-status"]').innerText(), /Este programa estuvo en tu nube, pero ya no está: al subirlo se vuelve a crear\./);
    assert.equal((await rows(a)).length, 1, 'la copia de este equipo no se toca');
    await closeTransfer(a);
  });

  await check('Un programa eliminado de la nube se puede volver a subir desde el equipo que lo tiene (se crea de nuevo)', async () => {
    await openTransfer(a);
    await cloudLoaded(a);
    const from = mark();
    await a.locator('.dj-choice[data-act="cloud-upload"]').click();
    await waitToast(a, /«Desfile» está en tu nube: 1 canción \(1 subida ahora\)\./);
    await idle(a);
    assert.equal(cloudKeys('dj/programs/').length, 3);
    assert.equal(since(from, 'PUT', '/v1/dj/uploads/part').length, 2, 'la canción larga volvió a subirse (2 partes) porque se había limpiado');
  });

  // ---- Roles
  const E = await open({ width: 1440, height: 900 }, origin, { key: editorKey });
  const e = E.page;

  await check('Editor: puede subir su programa (con su nombre) pero no ve el botón de eliminar; músico: solo trae', async () => {
    assert.deepEqual(E.who, { name: 'Elena (editora)', role: 'editor', canPublish: true, canDelete: false });
    await e.setInputFiles('.dj input.dj-file', [SOLO_EDITOR.file]);
    await e.waitForFunction(() => document.querySelectorAll('.dj-row').length === 1 && !window.__dj.dj.state.importing, null, { timeout: 30000 });
    await openTransfer(e);
    await cloudLoaded(e);
    assert.equal(await e.locator('.dj-cloudrow').count(), 3, 've lo que subieron los demás');
    assert.equal(await e.locator('[data-act="cloud-delete"]').count(), 0, 'sin botón de eliminar');
    assert(!(await e.locator('.dj-choice[data-act="cloud-upload"]').isDisabled()));
    await e.locator('.dj-choice[data-act="cloud-upload"]').click();
    await waitToast(e, /está en tu nube: 1 canción \(1 subida ahora\)\./);
    await idle(e);
    assert.equal(cloudKeys('dj/programs/').length, 4);
    const mine = (await programOf(e)).cloud;
    assert.equal(cloudProgram(mine.id).package.programs[0].name, 'Programa 1');
    await openTransfer(e);
    await cloudLoaded(e);
    assert.match(await cloudRow(e, mine.id).innerText(), /Elena \(editora\)/);
    await closeTransfer(e);
  });

  const P = await open({ width: 1440, height: 900 }, origin, { key: playerKey });
  const p = P.page;

  await check('Músico (solo reproducir): ve la lista y puede traer programas, pero no subir ni eliminar', async () => {
    assert.deepEqual(P.who, { name: 'Pablo (músico)', role: 'player', canPublish: false, canDelete: false });
    await openTransfer(p);
    await cloudLoaded(p);
    assert.equal(await p.locator('.dj-cloudrow').count(), 4);
    assert.equal(await p.locator('[data-act="cloud-delete"]').count(), 0);
    assert(await p.locator('.dj-choice[data-act="cloud-upload"]').isDisabled());
    assert.match(await cloudText(p), /Tu cuenta solo puede traer programas de la nube\. El propietario puede darte permiso de editor para subirlos\./);
    await cloudRow(p, cloudId).locator('[data-act="cloud-get"]').click();
    await p.waitForSelector('.dj-import');
    await p.locator('.modal-foot .btn.primary', { hasText: 'Traer el programa' }).click();
    await p.waitForFunction(() => document.querySelectorAll('.dj-row').length === 4, null, { timeout: 60000 });
    await idle(p);
    assert.deepEqual(await storedBlobs(p), BODA.map((song) => song.sha).sort());
    assert.deepEqual((await rows(p)).map((row) => row.title), ['Entrada (versión de A)', 'Madrina Rosa y Pedro', '03 Carla', '04 Diego largo']);
  });

  // ---- Sin nube conectada y con un Worker anterior
  const N = await open({ width: 1440, height: 900 }, origin, { key: MASTER });
  const n = N.page;

  await check('Sin nube conectada (si la conexión se pierde con la ventana abierta): lo dice al instante y no ofrece subir; llevar un archivo sigue funcionando', async () => {
    await openTransfer(n);
    await cloudLoaded(n);
    assert.equal(await n.locator('[data-role="cloud-list"], [data-role="cloud-empty"]').count(), 1, 'con la nube conectada se ve la lista');
    await n.evaluate(async () => {
      const { cloud } = await import('/js/cloud.js');
      Object.defineProperty(window.__dj.djCloud, 'connected', { configurable: true, get: () => false });
      cloud.emit();
    });
    await n.waitForSelector('[data-role="cloud-off"]');
    assert.match(await n.locator('[data-role="cloud-off"]').innerText(), /Conecta tu nube en la pestaña Nube para subir tus programas y traerlos en cualquier otro dispositivo\./);
    assert.equal(await n.locator('[data-act="cloud-upload"]').count(), 0);
    assert.equal(await n.locator('.dj-cloudrow').count(), 0);
    assert.equal(await n.locator('.dj-choice[data-act="import-pick"]').count(), 1);
    await n.screenshot({ path: path.join(qa, 'nube-11-sin-conexion.png') });
    await closeTransfer(n);
  });

  await check('Worker anterior (sin lo del DJ): avisa que hay que publicar el Worker nuevo y no intenta subir nada', async () => {
    hooks.oldWorker = true;
    await openTransfer(a);
    await a.locator('[data-act="cloud-refresh"]').click();
    await a.waitForSelector('[data-role="cloud-error"]');
    assert.match(await a.locator('[data-role="cloud-error"]').innerText(), /Tu nube todavía no guarda programas del DJ\. Publica primero el Worker nuevo \(server\/worker\.mjs\) y vuelve a intentarlo\./);
    const from = mark();
    await a.locator('.dj-choice[data-act="cloud-upload"]').click();
    await waitToast(a, /Tu nube todavía no guarda programas del DJ\./);
    await idle(a);
    assert.equal(since(from, 'POST', '/v1/dj/uploads/start').length, 0, 'no empezó ninguna subida');
    hooks.oldWorker = false;
    await openTransfer(a);
    await a.locator('[data-act="cloud-refresh"]').click();
    await cloudLoaded(a);
    await a.waitForSelector('[data-role="cloud-list"]');
    assert.equal(await a.locator('[data-role="cloud-error"]').count(), 0, 'con el Worker nuevo vuelve a funcionar');
    await closeTransfer(a);
  });

  await check('Sin internet (en la sala del evento): no ofrece subir, explica qué hacer, no se cuelga y todo vuelve al recuperar la conexión', async () => {
    await A.context.setOffline(true);
    await a.waitForFunction(() => navigator.onLine === false);
    await openTransfer(a);
    await a.waitForSelector('[data-role="cloud-error"]', { timeout: 30000 });
    assert.match(await a.locator('[data-role="cloud-error"]').innerText(), /conexi[oó]n|internet|red/i, 'el aviso habla de la conexión');
    assert(await a.locator('.dj-choice[data-act="cloud-upload"]').isDisabled());
    assert.match(await cloudText(a), /Verifica tu acceso con internet \(pestaña Nube\) para subir programas\./);
    assert.equal(await a.locator('.dj-choice[data-act="export-full"]').count(), 1, 'llevar un archivo no necesita internet');
    await a.screenshot({ path: path.join(qa, 'nube-12-sin-internet.png') });
    await closeTransfer(a);
    await A.context.setOffline(false);
    await a.waitForFunction(() => navigator.onLine === true);
    await a.evaluate(async () => { const { cloud } = await import('/js/cloud.js'); await cloud.checkAccess(); });
    await openTransfer(a);
    await a.locator('[data-act="cloud-refresh"]').click();
    await cloudLoaded(a);
    await a.waitForSelector('[data-role="cloud-list"]');
    assert.equal(await a.locator('[data-role="cloud-error"]').count(), 0);
    assert(!(await a.locator('.dj-choice[data-act="cloud-upload"]').isDisabled()));
    await closeTransfer(a);
  });

  // ---- Teléfono
  const T = await open({ width: 390, height: 844 }, origin, { key: MASTER });
  const t = T.page;

  await check('Teléfono de 390 px: la sección de la nube, la lista, el aviso de avance y la ventana de traer caben sin desplazarse de lado', async () => {
    await t.setInputFiles('.dj input.dj-file', [SOLO_TELEFONO.file]);
    await t.waitForFunction(() => document.querySelectorAll('.dj-row').length === 1 && !window.__dj.dj.state.importing, null, { timeout: 30000 });
    await openTransfer(t, { tap: true });
    await cloudLoaded(t);
    await t.waitForSelector('[data-role="cloud-list"]');
    assert.deepEqual(await fits(t, '.dj-transfer'), { page: true, inner: true, left: true, right: true });
    const upload = await t.locator('.dj-choice[data-act="cloud-upload"]').boundingBox();
    assert(upload.x >= 0 && upload.x + upload.width <= 390.5 && upload.height >= 48, `subir se puede tocar: ${JSON.stringify(upload)}`);
    const count = await t.locator('.dj-cloudrow').count();
    assert(count >= 3);
    for (let i = 0; i < count; i++) {
      const row = await t.locator('.dj-cloudrow').nth(i).boundingBox();
      assert(row.x >= 0 && row.x + row.width <= 390.5, `fila ${i}: ${JSON.stringify(row)}`);
      for (const act of ['cloud-get', 'cloud-delete']) {
        const box = await t.locator('.dj-cloudrow').nth(i).locator(`[data-act="${act}"]`).boundingBox();
        assert(box.x >= 0 && box.x + box.width <= 390.5 && box.height >= 36 && box.width >= 36, `${act} de la fila ${i} se puede tocar: ${JSON.stringify(box)}`);
      }
    }
    await t.screenshot({ path: path.join(qa, 'nube-8-telefono.png') });
    // subir: el aviso de avance cabe y «Cancelar» se puede tocar
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let waiting = 0;
    hooks.before = async (method, pathname) => { if (pathname === '/v1/dj/uploads/part') { waiting++; await gate; } };
    await t.locator('.dj-choice[data-act="cloud-upload"]').tap();
    for (let i = 0; i < 200 && !waiting; i++) await sleep(50);
    await t.waitForSelector('[data-banner="cloud"] [data-act="cloud-cancel"]');
    const banner = await t.locator('[data-banner="cloud"]').boundingBox();
    assert(banner.x >= 0 && banner.x + banner.width <= 390.5, `el aviso cabe: ${JSON.stringify(banner)}`);
    const cancel = await t.locator('[data-banner="cloud"] [data-act="cloud-cancel"]').boundingBox();
    assert(cancel.x >= 0 && cancel.x + cancel.width <= 390.5 && cancel.height >= 32, `cancelar se puede tocar: ${JSON.stringify(cancel)}`);
    assert.equal((await fits(t, '.dj')).page, true);
    await sleep(300);
    await t.screenshot({ path: path.join(qa, 'nube-9-telefono-aviso.png') });
    await t.locator('[data-banner="cloud"] [data-act="cloud-cancel"]').tap();
    await waitToast(t, /Subida cancelada/);
    await idle(t);
    release();
    hooks.before = null;
    await sleep(200);
    // traer: la ventana (con la opción de actualizar o crear uno nuevo) también cabe
    await openTransfer(t, { tap: true });
    await cloudLoaded(t);
    await cloudRow(t, cloudId).locator('[data-act="cloud-get"]').tap();
    await t.waitForSelector('.dj-import');
    const modal = await t.locator('.dj-import').boundingBox();
    assert(modal.x >= 0 && modal.x + modal.width <= 390.5, `la ventana cabe: ${JSON.stringify(modal)}`);
    assert.equal((await fits(t, '.dj-import')).page, true);
    await t.screenshot({ path: path.join(qa, 'nube-10-telefono-traer.png') });
    await t.keyboard.press('Escape');
    await t.waitForSelector('.dj-import', { state: 'detached' });
  });

  await check('Sin errores en la consola ni en la página, y sin pedir nada fuera del servidor local', async () => {
    const names = ['A', 'B', 'editor', 'músico', 'sin nube', 'teléfono'];
    for (const [index, device] of devices.entries()) {
      assert.deepEqual(device.consoleErrors, [], `consola de ${names[index]}`);
      assert.deepEqual(await device.page.evaluate(() => window.__errors), [], `errores de ${names[index]}`);
      assert.deepEqual(device.blocked, [], `peticiones externas de ${names[index]}`);
    }
  });

  note(`Peticiones al Worker durante toda la prueba: ${hooks.log.length}.`);
  for (const device of devices) await device.context.close();
  await browser.close();
  server.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(qa, 'dj-nube-resultados.json'), JSON.stringify({ results, notes }, null, 2));
  if (failures.length) {
    console.error('\n' + failures.map((failure) => `FALLO ${failure.name}\n${failure.error}`).join('\n\n'));
    process.exit(1);
  }
  console.log(`\n${results.length} comprobaciones de los programas del DJ en la nube pasaron.`);
}

main().catch(async (error) => {
  console.error(error);
  try { await browser.close(); } catch { /* ya cerrado */ }
  try { server.close(); } catch { /* ya cerrado */ }
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
});
