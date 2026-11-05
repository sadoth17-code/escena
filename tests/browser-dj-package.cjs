/* Prueba de navegador de «Llevar a otra PC» (pestaña DJ): sacar un paquete en una PC y abrirlo en otra.
   Cada "PC" es un contexto de navegador nuevo (su propio IndexedDB, sin nada en común). Solo usa archivos locales:
   sin cuentas, sin nube y sin controlador MIDI real (el MIDI se simula con un puerto falso). */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');

const root = path.resolve(__dirname, '../www');
const qa = process.env.ESCENA_QA_DIR || path.resolve(__dirname, '../../qa');
const failures = [];
const results = [];
const notes = [];
let browser;

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

const FREQS = [400, 570, 740, 910];
const NAMES = ['01 Ana', '02 Beto', '03 Carla', '04 Diego'];
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'escena-dj-paquete-'));
const songDir = path.join(workDir, 'canciones');
const outDir = path.join(workDir, 'descargas');
fs.mkdirSync(songDir);
fs.mkdirSync(outDir);
const songFiles = NAMES.map((name, index) => {
  const file = path.join(songDir, `${name}.wav`);
  fs.writeFileSync(file, wavBytes({ freq: FREQS[index], seconds: 24 }));
  return file;
});
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const songHashes = songFiles.map((file) => sha(fs.readFileSync(file)));

// ---------------------------------------------------------------- servidor local

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/js/cloud-config.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(`export const CLOUD_API_URL = ${JSON.stringify(`http://127.0.0.1:${server.address().port}`)};`);
    return;
  }
  if (url.pathname === '/v1/ping' || url.pathname === '/v1/songs') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const time = Date.now();
    response.end(JSON.stringify(url.pathname === '/v1/songs' ? { songs: [] } : {
      accessVersion: 2, role: 'master', user: { id: 'fixture-owner', name: 'Propietario de prueba', role: 'owner', offlineHours: 24 },
      permissions: { publish: true, manageUsers: true }, serverTime: time, offlineUntil: time + 86400000,
    }));
    return;
  }
  if (url.pathname === '/__fixture.html') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><meta charset="utf-8"><title>Local test fixture</title>');
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

async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error: error.stack }); results.push({ name, passed: false }); console.log(`FAIL ${name}: ${error.message}`); }
}

const note = (text) => { notes.push(text); console.log(`NOTE ${text}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- páginas de prueba

async function seed(page, origin) {
  await page.goto(origin + '/__fixture.html');
  await page.evaluate((origin) => sessionStorage.setItem(`escena-cloud:${origin}`, 'a'.repeat(64)), origin);
}

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

// Una "PC": un contexto de navegador nuevo (su propia base de datos, sin nada en común con las demás).
async function openPc(viewport, origin) {
  const context = await browser.newContext({
    viewport,
    serviceWorkers: 'block',
    acceptDownloads: true,
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
    window.addEventListener('error', (event) => window.__errors.push(String(event.error || event.message)));
    window.addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
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
  await seed(page, origin);
  await page.goto(origin);
  await page.waitForSelector('.layout');
  await openDjTab(page);
  return { context, page, blocked, consoleErrors };
}

async function openDjTab(page) {
  await page.locator('.tabbar .tab', { hasText: 'DJ' }).click();
  await page.waitForSelector('.panel-dj .dj');
  await page.waitForFunction(() => window.__dj);
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

const ids = (page) => page.evaluate(() => window.__dj.dj.items().map((item) => ({ id: item.id, title: item.title, sub: item.trackName, missing: item.missing, number: item.number })));
const press = (page, act) => page.locator(`.dj [data-act="${act}"]`).first().click();
const storedBlobs = (page) => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('escena-dj'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const rows = await new Promise((resolve) => { const request = db.transaction('blobs', 'readonly').objectStore('blobs').getAll(); request.onsuccess = () => resolve(request.result); });
  const out = [];
  for (const row of rows) {
    const digest = await crypto.subtle.digest('SHA-256', await row.blob.arrayBuffer());
    out.push(Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join(''));
  }
  db.close();
  return out.sort();
});

async function openTransfer(page) {
  await page.locator('.dj [data-act="transfer"]').first().click();
  await page.waitForSelector('.dj-transfer');
}

async function downloadFrom(page, act) {
  await openTransfer(page);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.locator(`.dj-choice[data-act="${act}"]`).click()]);
  const file = path.join(outDir, `${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(file);
  return { file, name: download.suggestedFilename() };
}

async function chooseFile(page, file) {
  await openTransfer(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.dj-choice[data-act="import-pick"]').click()]);
  await chooser.setFiles(file);
  await page.waitForSelector('.dj-import');
}

// ---------------------------------------------------------------- pruebas

async function main() {
  fs.mkdirSync(qa, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.ESCENA_CHROMIUM || (fs.existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined),
    headless: true,
    args: ['--no-sandbox', ...(process.env.ESCENA_STRICT_AUTOPLAY ? [] : ['--autoplay-policy=no-user-gesture-required'])],
  });

  // ---- PC de origen: arma la boda y saca los paquetes
  const pcA = await openPc({ width: 1440, height: 900 }, origin);
  const a = pcA.page;
  let zipFile = null;
  let jsonFile = null;

  await check('PC de origen: se arma el programa (nombres, tiempos, mezcla y un pad) y el botón «Llevar a otra PC» está a la vista', async () => {
    await a.setInputFiles('.dj input.dj-file', songFiles);
    await a.waitForFunction(() => document.querySelectorAll('.dj-row').length === 4, null, { timeout: 20000 });
    await a.evaluate(() => {
      const dj = window.__dj.dj;
      const [first, second] = dj.items();
      dj.updateItem(first.id, { label: 'Entrada de los novios', start: 2, maxDur: 20, gainDb: -3 });
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
    assert(await a.locator('.dj [data-act="transfer"]').first().isVisible(), 'el botón se ve en la pestaña Programa');
    await a.locator('.dj-tabs .seg', { hasText: 'Canciones' }).click();
    assert(await a.locator('.dj [data-act="transfer"]').first().isVisible(), 'y también en Canciones');
    await a.locator('.dj-tabs .seg', { hasText: 'Programa' }).click();
    await a.waitForSelector('.dj-row');
  });

  await check('«Llevar a otra PC»: la ventana explica que nada se sube a internet y muestra qué pesa el paquete', async () => {
    await openTransfer(a);
    const text = await a.locator('.dj-transfer').innerText();
    assert.match(text, /no se suben a internet/);
    assert.match(text, /Paquete completo \(\.zip\)/);
    assert.match(text, /Solo el programa \(\.json\)/);
    assert.match(text, /4 participantes, 4 canciones, unos \d+(\.\d)? MB/);
    assert(!(await a.locator('.dj-choice[data-act="export-full"]').isDisabled()));
    assert.equal(await a.locator('.dj-scope').count(), 0, 'con un solo programa no pregunta cuál llevar');
    await a.screenshot({ path: path.join(qa, 'paquete-1-llevar.png') });
    await a.keyboard.press('Escape');
    await a.waitForSelector('.dj-transfer', { state: 'detached' });
  });

  await check('Paquete completo: se descarga un ZIP válido con el programa y las 4 canciones sin tocar', async () => {
    const got = await downloadFrom(a, 'export-full');
    zipFile = got.file;
    assert.equal(got.name, 'Escena DJ - Boda Prueba.zip');
    const wavTotal = songFiles.reduce((total, file) => total + fs.statSync(file).size, 0);
    const size = fs.statSync(zipFile).size;
    assert(size > wavTotal && size < wavTotal + 6000, `peso ${size} vs canciones ${wavTotal}`);
    const unzip = spawnSync('unzip', ['-t', zipFile], { encoding: 'utf8' });
    assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
    assert.match(unzip.stdout, /No errors detected/);
    const listing = spawnSync('unzip', ['-Z1', zipFile], { encoding: 'utf8' }).stdout.trim().split('\n');
    assert.deepEqual(listing, ['escena-dj.json', 'LEEME.txt', 'audio/001-01 Ana.wav', 'audio/002-02 Beto.wav', 'audio/003-03 Carla.wav', 'audio/004-04 Diego.wav']);
    const manifest = JSON.parse(spawnSync('unzip', ['-p', zipFile, 'escena-dj.json'], { encoding: 'utf8' }).stdout);
    assert.equal(manifest.programs[0].name, 'Boda Prueba');
    assert.deepEqual(manifest.programs[0].items.slice(0, 2).map((item) => item.label), ['Entrada de los novios', 'Madrina Rosa']);
    assert.deepEqual([manifest.programs[0].items[0].start, manifest.programs[0].items[0].maxDur, manifest.programs[0].items[0].gainDb], [2, 20, -3]);
    assert.equal(manifest.settings.fade, 3);
    assert(manifest.settings.bindings['slot:1'].includes('n:1:36'));
    // el audio del paquete es idéntico, byte por byte, al de las canciones originales
    const inside = [1, 2, 3, 4].map((n) => sha(spawnSync('unzip', ['-p', zipFile, listing[n + 1]], { maxBuffer: 1 << 28 }).stdout));
    assert.deepEqual(inside, songHashes);
    assert.equal(await a.locator('.toast').filter({ hasText: 'Listo: «Escena DJ - Boda Prueba.zip»' }).count(), 1, 'avisa que está listo');
  });

  await check('Solo el programa: un JSON liviano, sin audio, con lo que hay que añadir en la otra PC', async () => {
    const got = await downloadFrom(a, 'export-light');
    jsonFile = got.file;
    assert.equal(got.name, 'Escena DJ - Boda Prueba (solo programa).json');
    assert(fs.statSync(jsonFile).size < 4000);
    const manifest = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    assert.equal(manifest.audio, false);
    assert.deepEqual(manifest.tracks.map((track) => track.file), NAMES.map((name) => `${name}.wav`));
    assert(manifest.tracks.every((track) => track.entry === ''));
  });

  // ---- otra PC: abre el paquete completo
  const pcB = await openPc({ width: 1440, height: 900 }, origin);
  const b = pcB.page;

  await check('Otra PC: se elige el ZIP, la ventana dice qué trae y al aceptar quedan programa, canciones, pads y mezcla', async () => {
    await chooseFile(b, zipFile);
    const text = await b.locator('.dj-import').innerText();
    assert.match(text, /Escena DJ - Boda Prueba\.zip/);
    assert.match(text, /Boda Prueba · 4 participantes/);
    assert.match(text, /4 canciones nuevas con audio/);
    assert.match(text, /se guardan en este dispositivo/);
    assert(await b.locator('[data-role="import-settings"]').isVisible(), 'ofrece usar la mezcla y los pads');
    assert.equal(await b.locator('[data-role="import-settings"] .switch').getAttribute('aria-checked'), 'true', 'en una PC sin pads propios viene activado');
    await b.screenshot({ path: path.join(qa, 'paquete-2-traer.png') });
    await b.locator('.modal-foot .btn.primary', { hasText: 'Traer el programa' }).click();
    await b.waitForFunction(() => document.querySelectorAll('.dj-row').length === 4 && !window.__dj.dj.state.importing, null, { timeout: 30000 });
    const rows = await ids(b);
    assert.deepEqual(rows.map((row) => row.title), ['Entrada de los novios', 'Madrina Rosa', '03 Carla', '04 Diego']);
    assert(rows.every((row) => !row.missing));
    assert.equal(await b.locator('.dj-program-select option:checked').textContent(), 'Boda Prueba', 'queda abierto el programa que llegó');
    assert.equal(await b.locator('[data-banner="missing"]').count(), 0);
    assert.match(await b.locator('.dj-row').first().locator('.dj-row-sub').textContent(), /0:24 · desde 0:02 · máx\. 0:20 · -3 dB/);
    assert.match(await b.locator('.dj-row').first().locator('.dj-badge').textContent(), /Nota 36/, 'el pad viajó con el programa');
    assert.equal(await b.evaluate(() => window.__dj.dj.state.settings.fade), 3);
    assert.equal(await b.locator('.toast').filter({ hasText: 'Programa «Boda Prueba» traído' }).count(), 1);
    assert.deepEqual(await storedBlobs(b), [...songHashes].sort(), 'las 4 canciones están guardadas y son idénticas a las originales');
  });

  await check('Otra PC: las canciones traídas suenan de verdad (se mide la salida) y el pad del paquete las dispara', async () => {
    await b.evaluate(() => window.__dj.dj.enableMidi());
    await b.waitForFunction(() => document.querySelector('.dj-next .dj-dot.ready'), null, { timeout: 15000 });
    await b.evaluate(() => window.__midiSend([0x90, 36, 100]));
    await b.waitForFunction(() => window.__djEngine && window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing', null, { timeout: 10000 });
    await installTap(b);
    await sleep(900);
    const [tone] = await b.evaluate((freqs) => window.__tap.read(freqs), [FREQS[0]]);
    assert(tone > 0.15 && tone < 0.35, `suena la canción 1 (400 Hz) a su nivel: ${tone.toFixed(3)}`);
    const state = await b.evaluate(() => ({ transport: window.__dj.dj.state.transport, now: window.__dj.dj.nowItem().label }));
    assert.deepEqual(state, { transport: 'playing', now: 'Entrada de los novios' });
    await press(b, 'next');
    await b.waitForFunction(() => window.__dj.dj.nowItem() && window.__dj.dj.items().find((item) => item.id === window.__dj.dj.state.nowId).number === 2, null, { timeout: 8000 });
    await b.waitForFunction(() => !window.__djEngine.snapshot().mixing.active, null, { timeout: 15000 });
    await sleep(500);
    const [second] = await b.evaluate((freqs) => window.__tap.read(freqs), [FREQS[1]]);
    assert(second > 0.2 && second < 0.35, `y la 2 (570 Hz): ${second.toFixed(3)}`);
  });

  await check('No se trae un programa mientras suena la música: la ventana lo avisa y el botón queda apagado', async () => {
    assert.equal(await b.evaluate(() => window.__dj.dj.state.transport), 'playing');
    await chooseFile(b, zipFile);
    assert.match(await b.locator('.dj-import').innerText(), /Hay música sonando/);
    assert(await b.locator('.modal-foot .btn.primary', { hasText: 'Traer el programa' }).isDisabled());
    assert.match(await b.locator('.dj-import').innerText(), /4 ya estaban en esta PC/, 'y avisa que esas canciones ya están y no se repiten');
    await b.screenshot({ path: path.join(qa, 'paquete-3-sonando.png') });
    await b.keyboard.press('Escape');
    await b.waitForSelector('.dj-import', { state: 'detached' });
    await press(b, 'panic');
    await b.waitForFunction(() => window.__dj.dj.state.transport === 'idle');
  });

  await check('Traer el mismo paquete otra vez: no se duplican canciones, el programa llega como «(2)»', async () => {
    await chooseFile(b, zipFile);
    await b.locator('.modal-foot .btn.primary', { hasText: 'Traer el programa' }).click();
    await b.waitForFunction(() => window.__dj.dj.state.programs.length === 3 && !window.__dj.dj.state.importing, null, { timeout: 30000 });
    const names = await b.evaluate(() => window.__dj.dj.state.programs.map((program) => program.name));
    assert.deepEqual(names.slice(-2), ['Boda Prueba', 'Boda Prueba (2)']);
    assert.equal((await storedBlobs(b)).length, 4, 'las canciones siguen siendo 4 en el dispositivo');
    assert.equal(await b.evaluate(() => window.__dj.dj.state.tracks.length), 4);
  });

  await check('Lo traído queda guardado: al recargar la página, el programa y las canciones siguen y suenan', async () => {
    await b.reload();
    await b.waitForSelector('.layout');
    await openDjTab(b);
    await b.waitForFunction(() => document.querySelectorAll('.dj-row').length === 4, null, { timeout: 15000 });
    assert.deepEqual((await ids(b)).map((row) => row.title), ['Entrada de los novios', 'Madrina Rosa', '03 Carla', '04 Diego']);
    await b.waitForFunction(() => document.querySelector('.dj-next .dj-dot.ready'), null, { timeout: 15000 });
    await press(b, 'next');
    await b.waitForFunction(() => window.__djEngine && window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing', null, { timeout: 10000 });
    await press(b, 'panic');
  });

  // ---- otra PC más: solo el programa, sin audio
  const pcC = await openPc({ width: 1440, height: 900 }, origin);
  const c = pcC.page;

  await check('Solo el programa: llega esperando los archivos, se ve cuáles faltan y nada se traba', async () => {
    await chooseFile(c, jsonFile);
    const text = await c.locator('.dj-import').innerText();
    assert.match(text, /solo el programa, sin audio/);
    assert.match(text, /4 sin audio · quedan esperando su archivo/);
    await c.locator('.modal-foot .btn.primary', { hasText: 'Traer el programa' }).click();
    await c.waitForFunction(() => document.querySelectorAll('.dj-row').length === 4, null, { timeout: 15000 });
    const rows = await ids(c);
    assert.deepEqual(rows.map((row) => row.title), ['Entrada de los novios', 'Madrina Rosa', '03 Carla', '04 Diego']);
    assert(rows.every((row) => row.missing));
    assert.deepEqual(rows.map((row) => row.sub), NAMES.map((name) => `Falta «${name}.wav»`));
    assert.equal(await c.locator('.dj-row.is-missing').count(), 4);
    assert.match(await c.locator('[data-banner="missing"]').innerText(), /A 4 participantes les falta su archivo/);
    assert(await c.locator('.dj [data-act="next"]').first().isDisabled(), '«Siguiente» no intenta tocar lo que no existe');
    assert.match(await c.locator('.dj-next-sub').textContent(), /les falta el archivo/);
    await c.screenshot({ path: path.join(qa, 'paquete-4-faltan.png') });
    await c.locator('.dj-row-body').nth(1).click();
    assert.equal(await c.evaluate(() => window.__dj.dj.state.cueId), null, 'un participante sin archivo no se marca como «Sigue»');
    await c.locator('.dj-row [data-act="jump"]').nth(2).click();
    assert.equal(await c.evaluate(() => window.__dj.dj.state.transport), 'idle');
    assert.equal(await c.locator('.toast').filter({ hasText: 'falta el archivo «03 Carla.wav»' }).count(), 1, 'avisa cuál archivo hay que añadir');
  });

  await check('Al añadir las canciones (desordenadas, con otras mayúsculas y una de más) se vinculan solas por el nombre', async () => {
    const renamed = path.join(workDir, 'otra-carpeta');
    fs.mkdirSync(renamed);
    const upper = path.join(renamed, '04 DIEGO.WAV');
    fs.copyFileSync(songFiles[3], upper);
    const extra = path.join(renamed, 'Extra aparte.wav');
    fs.writeFileSync(extra, wavBytes({ freq: 1500, seconds: 6 }));
    await c.locator('[data-banner="missing"] [data-act="add-missing"]').waitFor();
    await c.setInputFiles('.dj input.dj-file', [songFiles[2], upper, extra, songFiles[0], songFiles[1]]);
    await c.waitForFunction(() => window.__dj.dj.state.tracks.length === 5 && !window.__dj.dj.state.importing, null, { timeout: 20000 });
    const rows = await ids(c);
    assert.equal(rows.length, 5, 'solo la canción que nadie esperaba se agrega como participante nuevo');
    assert.deepEqual(rows.map((row) => row.title), ['Entrada de los novios', 'Madrina Rosa', '03 Carla', '04 DIEGO', 'Extra aparte']);
    assert(rows.every((row) => !row.missing));
    assert.equal(await c.locator('[data-banner="missing"]').count(), 0, 'desaparece el aviso de lo que faltaba');
    assert.equal(await c.locator('.dj-row.is-missing').count(), 0);
    assert.equal(await c.locator('.toast').filter({ hasText: '4 participantes recuperaron su canción' }).count(), 1);
    const first = await c.evaluate(() => { const item = window.__dj.dj.items()[0]; return [item.start, item.maxDur, item.gainDb]; });
    assert.deepEqual(first, [2, 20, -3], 'los tiempos del programa se conservan');
    await c.waitForFunction(() => document.querySelector('.dj-next .dj-dot.ready'), null, { timeout: 15000 });
    await press(c, 'next');
    await c.waitForFunction(() => window.__djEngine && window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing', null, { timeout: 10000 });
    await installTap(c);
    await sleep(900);
    const [tone] = await c.evaluate((freqs) => window.__tap.read(freqs), [FREQS[0]]);
    assert(tone > 0.15 && tone < 0.35, `suena la canción vinculada: ${tone.toFixed(3)}`);
    await press(c, 'panic');
  });

  await check('Arrastrar un paquete a la pantalla lo abre como paquete (y no lo toma por una canción)', async () => {
    await c.evaluate((jsonText) => {
      const file = new File([jsonText], 'Escena DJ - Boda Prueba (solo programa).json', { type: 'application/json' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const target = document.querySelector('.dj');
      target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, fs.readFileSync(jsonFile, 'utf8'));
    await c.waitForSelector('.dj-import');
    try {
      const text = await c.locator('.dj-import').innerText();
      assert.match(text, /Boda Prueba · 4 participantes/);
      assert.match(text, /4 sin audio en el paquete, pero ya tienes archivos con esos nombres · se vinculan solas/, 'reconoce las canciones que ya tiene por el nombre');
      // esta PC ya tiene pads propios (los del primer paquete): para no pisarlos, la opción viene apagada y lo dice
      assert.equal(await c.locator('[data-role="import-settings"] .switch').getAttribute('aria-checked'), 'false');
      assert.match(text, /Reemplaza los pads y las teclas que tienes asignados en este equipo/);
    } finally {
      await c.keyboard.press('Escape');
      await c.waitForSelector('.dj-import', { state: 'detached' });
    }
  });

  await check('Archivos que no son un paquete se rechazan con un aviso claro y no cambian nada', async () => {
    const before = await c.evaluate(() => [window.__dj.dj.state.tracks.length, window.__dj.dj.state.programs.length]);
    const bad = path.join(workDir, 'nota.json');
    fs.writeFileSync(bad, JSON.stringify({ format: 'otra-cosa' }));
    await openTransfer(c);
    const [chooser] = await Promise.all([c.waitForEvent('filechooser'), c.locator('.dj-choice[data-act="import-pick"]').click()]);
    await chooser.setFiles(bad);
    await c.locator('.toast').filter({ hasText: 'no es un paquete de Escena DJ' }).waitFor();
    assert.equal(await c.locator('.dj-import').count(), 0);
    assert.deepEqual(await c.evaluate(() => [window.__dj.dj.state.tracks.length, window.__dj.dj.state.programs.length]), before);
  });

  // ---- teléfono (la pestaña y las ventanas deben caber y poder tocarse)
  const phone = await openPc({ width: 390, height: 844 }, origin);
  const p = phone.page;

  await check('Teléfono de 390 px: el botón, la ventana de «Llevar a otra PC» y la de traer un paquete caben sin desplazarse de lado', async () => {
    await p.setInputFiles('.dj input.dj-file', songFiles);
    await p.waitForFunction(() => document.querySelectorAll('.dj-row').length === 4, null, { timeout: 20000 });
    const fits = () => p.evaluate(() => ({ page: document.documentElement.scrollWidth <= window.innerWidth, dj: document.querySelector('.dj').scrollWidth <= document.querySelector('.dj').clientWidth + 1 }));
    assert.deepEqual(await fits(), { page: true, dj: true });
    const actions = await p.locator('.dj-program-actions').first().boundingBox();
    assert(actions.x >= 0 && actions.x + actions.width <= 390, 'la fila de botones cabe en el ancho');
    await p.locator('.dj [data-act="transfer"]').first().tap();
    await p.waitForSelector('.dj-transfer');
    const modal = await p.locator('.dj-transfer').boundingBox();
    assert(modal.x >= 0 && modal.x + modal.width <= 390 + 0.5, `la ventana cabe: x=${modal.x} ancho=${modal.width}`);
    for (const act of ['export-full', 'export-light', 'import-pick']) {
      const box = await p.locator(`.dj-choice[data-act="${act}"]`).boundingBox();
      assert(box.x >= 0 && box.x + box.width <= 390.5 && box.height >= 48, `${act} se puede tocar: ${JSON.stringify(box)}`);
    }
    await p.screenshot({ path: path.join(qa, 'paquete-5-telefono.png') });
    const [download] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), p.locator('.dj-choice[data-act="export-light"]').tap()]);
    assert.match(download.suggestedFilename(), /solo programa\)\.json$/);
    const saved = path.join(outDir, `telefono-${download.suggestedFilename()}`);
    await download.saveAs(saved);
    assert(JSON.parse(fs.readFileSync(saved, 'utf8')).programs[0].items.length === 4);
    assert.deepEqual(await fits(), { page: true, dj: true });
    await chooseFile(p, saved);
    const box = await p.locator('.dj-import').boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 390.5);
    assert.deepEqual(await fits(), { page: true, dj: true });
    await p.screenshot({ path: path.join(qa, 'paquete-6-telefono-traer.png') });
    await p.keyboard.press('Escape');
  });

  // ---- paquete grande: rendimiento y que la pantalla no se congele
  const bigDir = path.join(workDir, 'grandes');
  fs.mkdirSync(bigDir);
  const BIG_COUNT = 24;
  const bigFiles = Array.from({ length: BIG_COUNT }, (_, index) => {
    const file = path.join(bigDir, `${String(index + 1).padStart(2, '0')} Participante ${index + 1}.wav`);
    fs.writeFileSync(file, wavBytes({ freq: 300 + index * 40, seconds: 113 }));
    return file;
  });
  const bigBytes = bigFiles.reduce((total, file) => total + fs.statSync(file).size, 0);
  let bigZip = null;

  await check(`Paquete grande (${BIG_COUNT} canciones, ${(bigBytes / 1048576).toFixed(0)} MB): se arma sin congelar la pantalla y el ZIP resulta íntegro`, async () => {
    const pcD = await openPc({ width: 1440, height: 900 }, origin);
    const d = pcD.page;
    await d.setInputFiles('.dj input.dj-file', bigFiles);
    await d.waitForFunction((count) => document.querySelectorAll('.dj-row').length === count && !window.__dj.dj.state.importing, BIG_COUNT, { timeout: 120000 });
    await d.evaluate(() => {
      window.__gaps = { max: 0, last: performance.now(), stop: false, banner: false };
      const loop = (time) => {
        window.__gaps.max = Math.max(window.__gaps.max, time - window.__gaps.last);
        window.__gaps.last = time;
        if (document.querySelector('[data-banner="export"]')) window.__gaps.banner = true;
        if (!window.__gaps.stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const started = Date.now();
    const got = await downloadFrom(d, 'export-full');
    const seconds = (Date.now() - started) / 1000;
    bigZip = got.file;
    const gaps = await d.evaluate(() => { window.__gaps.stop = true; return window.__gaps; });
    note(`Paquete de ${(bigBytes / 1048576).toFixed(0)} MB: armado y descargado en ${seconds.toFixed(1)} s; el mayor atasco de la pantalla fue de ${Math.round(gaps.max)} ms.`);
    assert(gaps.banner, 'mientras se prepara se ve el aviso de progreso');
    assert(gaps.max < 1500, `la pantalla no se congela (atasco máximo ${Math.round(gaps.max)} ms)`);
    const unzip = spawnSync('unzip', ['-tq', bigZip], { encoding: 'utf8' });
    assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
    assert.match(unzip.stdout, /No errors detected/);
    assert(fs.statSync(bigZip).size > bigBytes && fs.statSync(bigZip).size < bigBytes + 20000);
    assert.deepEqual(pcD.consoleErrors, []);
    await pcD.context.close();
  });

  await check('Paquete grande: la otra PC lo trae completo, con las canciones idénticas, y la pantalla sigue respondiendo', async () => {
    const pcE = await openPc({ width: 1440, height: 900 }, origin);
    const e = pcE.page;
    await chooseFile(e, bigZip);
    assert.match(await e.locator('.dj-import').innerText(), new RegExp(`${BIG_COUNT} canciones nuevas con audio`));
    await e.evaluate(() => {
      window.__gaps = { max: 0, last: performance.now(), stop: false, banner: false };
      const loop = (time) => {
        window.__gaps.max = Math.max(window.__gaps.max, time - window.__gaps.last);
        window.__gaps.last = time;
        if (document.querySelector('.dj-banner.is-info')) window.__gaps.banner = true;
        if (!window.__gaps.stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const started = Date.now();
    await e.locator('.modal-foot .btn.primary', { hasText: 'Traer el programa' }).click();
    await e.waitForFunction((count) => document.querySelectorAll('.dj-row').length === count && !window.__dj.dj.state.importing, BIG_COUNT, { timeout: 180000 });
    const seconds = (Date.now() - started) / 1000;
    const gaps = await e.evaluate(() => { window.__gaps.stop = true; return window.__gaps; });
    note(`Paquete de ${(bigBytes / 1048576).toFixed(0)} MB: traído y guardado en ${seconds.toFixed(1)} s; el mayor atasco de la pantalla fue de ${Math.round(gaps.max)} ms.`);
    assert(gaps.banner, 'se ve el aviso de progreso');
    assert(gaps.max < 1500, `la pantalla no se congela (atasco máximo ${Math.round(gaps.max)} ms)`);
    const hashes = bigFiles.map((file) => sha(fs.readFileSync(file))).sort();
    assert.deepEqual(await storedBlobs(e), hashes, 'todas las canciones quedaron guardadas, idénticas a las originales');
    await e.waitForFunction(() => document.querySelector('.dj-next .dj-dot.ready'), null, { timeout: 20000 });
    await press(e, 'next');
    await e.waitForFunction(() => window.__djEngine && window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing', null, { timeout: 10000 });
    assert.deepEqual(pcE.consoleErrors, []);
    await pcE.context.close();
  });

  await check('Un paquete con una canción dañada no se cuela: se guarda lo sano y la dañada queda esperando', async () => {
    const bytes = fs.readFileSync(zipFile);
    const entry = spawnSync('unzip', ['-Z', zipFile], { encoding: 'utf8' }).stdout;
    assert.match(entry, /audio\/002-02 Beto\.wav/);
    // se cambia un byte dentro de la canción 2 (sin tocar el resto)
    // (el nombre aparece 3 veces: en el programa, en la cabecera de la canción y en el directorio final; la 2.ª es la cabecera)
    const marker = Buffer.from('audio/002-02 Beto.wav');
    const first = bytes.indexOf(marker);
    const header = bytes.indexOf(marker, first + marker.length);
    assert(first > 0 && header > first, 'se encontró la cabecera de la canción 2');
    const at = header + marker.length + 5000;
    const broken = Buffer.from(bytes);
    broken[at] ^= 0xff;
    const brokenFile = path.join(workDir, 'Paquete copiado a medias.zip');
    fs.writeFileSync(brokenFile, broken);
    const outside = spawnSync('unzip', ['-t', brokenFile], { encoding: 'utf8' });
    assert.notEqual(outside.status, 0, 'el ZIP dañado se nota también fuera de Escena');
    assert.match(outside.stdout + outside.stderr, /002-02 Beto\.wav/, 'y señala la canción 2');
    const pcF = await openPc({ width: 1440, height: 900 }, origin);
    const f = pcF.page;
    await chooseFile(f, brokenFile);
    await f.locator('.modal-foot .btn.primary', { hasText: 'Traer el programa' }).click();
    await f.waitForFunction(() => document.querySelectorAll('.dj-row').length === 4 && !window.__dj.dj.state.importing, null, { timeout: 30000 });
    const rows = await ids(f);
    assert.deepEqual(rows.map((row) => row.missing), [false, true, false, false]);
    assert.equal(await f.locator('.toast').filter({ hasText: 'llegó dañada en el paquete' }).count(), 1);
    assert.equal((await storedBlobs(f)).length, 3);
    // y se arregla añadiendo el archivo bueno
    await f.setInputFiles('.dj input.dj-file', [songFiles[1]]);
    await f.waitForFunction(() => window.__dj.dj.items().every((item) => !item.missing), null, { timeout: 15000 });
    assert.equal((await ids(f)).length, 4);
    assert.deepEqual(pcF.consoleErrors, []);
    await pcF.context.close();
  });

  await check('Sin errores en la consola ni en la página, y sin pedir nada fuera del servidor local', async () => {
    for (const [name, pc] of [['origen', pcA], ['otra PC', pcB], ['solo programa', pcC], ['teléfono', phone]]) {
      assert.deepEqual(pc.consoleErrors, [], `consola de ${name}`);
      assert.deepEqual(await pc.page.evaluate(() => window.__errors), [], `errores de ${name}`);
      assert.deepEqual(pc.blocked, [], `peticiones externas de ${name}`);
    }
  });

  await pcA.context.close();
  await pcB.context.close();
  await pcC.context.close();
  await phone.context.close();
  await browser.close();
  server.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(qa, 'dj-paquete-resultados.json'), JSON.stringify({ results, notes }, null, 2));
  if (failures.length) {
    console.error('\n' + failures.map((failure) => `FALLO ${failure.name}\n${failure.error}`).join('\n\n'));
    process.exit(1);
  }
  console.log(`\n${results.length} comprobaciones de «Llevar a otra PC» pasaron.`);
}

main().catch(async (error) => {
  console.error(error);
  try { await browser.close(); } catch { /* ya cerrado */ }
  server.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
});
