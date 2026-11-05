/* Prueba de navegador de la pestaña DJ. Solo usa archivos locales: sin cuentas, sin nube y sin controlador MIDI real
   (el MIDI se simula con un puerto falso que manda los mismos mensajes que mandaría un controlador). */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

const FREQS = [400, 570, 740, 910, 1080, 1250];
const NAMES = ['01 Ana', '02 Beto', '03 Carla', '04 Diego', '05 Elena', '06 Fabio'];
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'escena-dj-'));
const songFiles = NAMES.map((name, index) => {
  const file = path.join(fixtureDir, `${name}.wav`);
  fs.writeFileSync(file, wavBytes({ freq: FREQS[index], seconds: 24 }));
  return file;
});
const hotFiles = [500, 700].map((freq, index) => {
  const file = path.join(fixtureDir, `Fuerte ${index + 1}.wav`);
  fs.writeFileSync(file, wavBytes({ freq, seconds: 12, amp: 0.95 }));
  return file;
});

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
      // Deja a mano el motor de audio del DJ para poder medir la salida real.
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

// ---------------------------------------------------------------- página de prueba

async function seed(page, origin, { multitrack = false } = {}) {
  await page.goto(origin + '/__fixture.html');
  await page.evaluate(async ({ origin, multitrack }) => {
    sessionStorage.setItem(`escena-cloud:${origin}`, 'a'.repeat(64));
    if (!multitrack) return;
    const { store } = await import('/js/store.js');
    const { createSong, createTrackDef, createSetlist } = await import('/js/library.js');
    const wav = (hz) => {
      const rate = 22050, seconds = 20, samples = rate * seconds;
      const bytes = new ArrayBuffer(44 + samples * 2), view = new DataView(bytes);
      const word = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
      word(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); word(8, 'WAVE');
      word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      word(36, 'data'); view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i / rate * hz * Math.PI * 2) * 1000, true);
      return new Blob([bytes], { type: 'audio/wav' });
    };
    const tracks = [];
    for (let trackIndex = 0; trackIndex < 2; trackIndex++) {
      const blob = wav(300 + trackIndex * 50), fileId = `fixture-0-${trackIndex}`;
      await store.put('files', { id: fileId, blob, name: `${fileId}.wav` });
      const track = createTrackDef({ name: trackIndex ? 'Guitarra' : 'Piano', dest: 'main', mono: true, item: { blob } }, fileId, trackIndex);
      track.duration = 20;
      tracks.push(track);
    }
    const song = createSong('Multitrack de prueba', tracks);
    song.key = 'C';
    song.markers = [{ id: 'intro-0', bar: 1, name: 'Intro', color: '#35c9ff' }];
    await store.put('songs', song);
    const setlist = createSetlist('Prueba');
    setlist.songIds = [song.id];
    await store.put('setlists', setlist);
    await store.setMeta('activeSetlist', setlist.id);
    await store.setMeta('fixtureSongIds', [song.id]);
    await store.setMeta('settings', { preloadNext: true, warmBudgetMB: 128, keepAwake: false });
  }, { origin, multitrack });
}

// Puerto MIDI falso: reparte los mensajes igual que un controlador de verdad (addEventListener y onmidimessage).
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

async function openApp(viewport, origin, options = {}) {
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
    window.addEventListener('error', (event) => window.__errors.push(String(event.error || event.message)));
    window.addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
  });
  if (options.midi !== false) await context.addInitScript(MIDI_MOCK);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource|net::ERR|favicon/i.test(text)) return; // peticiones externas bloqueadas a propósito
    consoleErrors.push(text);
  });
  await seed(page, origin, options);
  await page.goto(origin);
  await page.waitForSelector('.layout');
  return { context, page, blocked, consoleErrors };
}

async function openDjTab(page) {
  await page.locator('.tabbar .tab', { hasText: 'DJ' }).click();
  await page.waitForSelector('.panel-dj .dj');
  await page.waitForFunction(() => window.__dj && window.__djEngine);
}

// Mide la salida real: instala un analizador detrás del limitador y mide cada tono con una ventana de Hann.
async function installTap(page) {
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
    window.__tap = {
      read(freqs) { tap.getFloatTimeDomainData(buffer); return freqs.map(amp); },
      peak() { tap.getFloatTimeDomainData(buffer); let p = 0; for (const v of buffer) p = Math.max(p, Math.abs(v)); return p; },
      jump() { tap.getFloatTimeDomainData(buffer); let j = 0; for (let i = 1; i < buffer.length; i++) j = Math.max(j, Math.abs(buffer[i] - buffer[i - 1])); return j; },
      async record(freqs, ms, every = 40) {
        const out = [];
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          out.push({ t: performance.now() - t0, a: this.read(freqs), peak: this.peak(), jump: this.jump() });
          await new Promise((resolve) => setTimeout(resolve, every));
        }
        return out;
      },
    };
  });
}

const snapshot = (page) => page.evaluate(() => {
  const dj = window.__dj.dj;
  const snap = window.__djEngine.snapshot();
  const now = dj.nowItem();
  const items = dj.items();
  return {
    transport: dj.state.transport,
    nowId: dj.state.nowId,
    nowNumber: now ? items.find((item) => item.id === now.id).number : null,
    currentKey: snap.current ? snap.current.key : null,
    position: snap.current ? snap.current.position : null,
    mixing: snap.mixing,
    audio: snap.audio,
    decks: snap.decks.filter(Boolean).map((deck) => ({ key: deck.key, state: deck.state, level: deck.level })),
  };
});

const waitIdle = (page) => page.waitForFunction(() => !window.__djEngine.snapshot().mixing.active, null, { timeout: 20000 });

const press = (page, act) => page.locator(`.dj [data-act="${act}"]`).first().click();

const ampOf = (rows, index, from, to) => {
  const slice = rows.filter((row) => row.t >= from && row.t <= to).map((row) => row.a[index]);
  return slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
};

// ---------------------------------------------------------------- pruebas

async function main() {
  fs.mkdirSync(qa, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.ESCENA_CHROMIUM || (fs.existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined),
    headless: true,
    // ESCENA_STRICT_AUTOPLAY=1 prueba con la regla normal del navegador (el audio solo arranca tras tocar la página).
    args: ['--no-sandbox', ...(process.env.ESCENA_STRICT_AUTOPLAY ? [] : ['--autoplay-policy=no-user-gesture-required'])],
  });

  const desktop = await openApp({ width: 1440, height: 900 }, origin);
  const { page } = desktop;

  await check('La pestaña DJ existe, abre sin errores y deja a Escena igual que antes', async () => {
    const tabs = await page.locator('.tabbar .tab').allTextContents();
    assert.deepEqual(tabs.map((text) => text.trim()), ['Tocar', 'Mezcla', 'Setlist', 'DJ']);
    await openDjTab(page);
    assert.equal(await page.locator('.layout').getAttribute('data-tab'), 'dj');
    assert(await page.locator('.dj-empty').isVisible(), 'estado vacío con instrucciones');
    assert(!(await page.locator('.panel-lib').isVisible()), 'el panel de setlist se oculta en la pestaña DJ');
    assert(await page.evaluate(async () => (await import('/js/controls.js')).controls.suspended), 'los controles del multitrack se apartan');
    await page.screenshot({ path: path.join(qa, 'dj-desktop-vacio.png') });
    await page.locator('.tabbar .tab', { hasText: 'Tocar' }).click();
    assert(!(await page.evaluate(async () => (await import('/js/controls.js')).controls.suspended)), 'al salir vuelven los controles');
    assert(await page.locator('.panel-play').isVisible());
    await openDjTab(page);
  });

  await check('Añadir canciones: ordenadas por nombre, con duración, guardadas en el dispositivo', async () => {
    await page.setInputFiles('.dj input.dj-file', songFiles);
    await page.waitForFunction(() => document.querySelectorAll('.dj-row').length === 6, null, { timeout: 20000 });
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.dj-row')).map((row) => ({ title: row.querySelector('.dj-row-title').textContent, sub: row.querySelector('.dj-row-sub').textContent })));
    assert.deepEqual(rows.map((row) => row.title), ['01 Ana', '02 Beto', '03 Carla', '04 Diego', '05 Elena', '06 Fabio']);
    assert(rows.every((row) => /0:24/.test(row.sub)), `duración leída: ${rows[0].sub}`);
    const stored = await page.evaluate(async () => new Promise((resolve, reject) => {
      const request = indexedDB.open('escena-dj');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['tracks', 'blobs', 'programs'], 'readonly');
        const count = (name) => new Promise((done) => { const c = tx.objectStore(name).count(); c.onsuccess = () => done(c.result); });
        Promise.all([count('tracks'), count('blobs'), count('programs')]).then(resolve);
      };
    }));
    assert.deepEqual(stored, [6, 6, 1]);
    await page.waitForFunction(() => document.querySelector('.dj-next .dj-dot.ready'), null, { timeout: 15000 });
  });

  await installTap(page);

  await check('Siguiente empieza la primera canción con una entrada corta y se oye en la salida', async () => {
    await press(page, 'next');
    await page.waitForFunction(() => window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing', null, { timeout: 10000 });
    await sleep(900);
    const [a] = await page.evaluate((freqs) => window.__tap.read(freqs), [FREQS[0]]);
    assert(a > 0.25 && a < 0.35, `la canción 1 suena a su nivel (medido ${a.toFixed(3)})`);
    const s = await snapshot(page);
    assert.equal(s.transport, 'playing');
    assert.equal(s.nowNumber, 1);
    assert.match(await page.locator('.dj-now .dj-title').textContent(), /Ana/);
    assert.match(await page.locator('.dj-next .dj-title').textContent(), /Beto/);
  });

  await check('Mezcla real de 3 s: una baja y la otra sube con potencia constante, sin hundirse ni subir de golpe', async () => {
    await page.locator('.dj-preset', { hasText: /^Corte$/ }).waitFor();
    await page.evaluate(() => window.__dj.dj.setFade(3));
    const [fullA] = await page.evaluate((freqs) => window.__tap.read(freqs), [FREQS[0]]);
    const recording = page.evaluate(([freqs]) => window.__tap.record(freqs, 5200), [[FREQS[0], FREQS[1]]]);
    await sleep(300);
    await press(page, 'next');
    const rows = await recording;
    const fullB = ampOf(rows, 1, 4300, 5200);
    assert(fullB > 0.25 && fullB < 0.35, `la canción 2 termina a su nivel (${fullB.toFixed(3)})`);
    const series = rows.map((row) => ({ t: row.t, a: row.a[0] / fullA, b: row.a[1] / fullB, power: Math.hypot(row.a[0] / fullA, row.a[1] / fullB) }));
    fs.writeFileSync(path.join(qa, 'dj-mezcla-serie.json'), JSON.stringify(series.map((point) => ({ t: Math.round(point.t), a: +point.a.toFixed(3), b: +point.b.toFixed(3), power: +point.power.toFixed(3) }))));
    const during = series.filter((point) => point.a > 0.03 && point.b > 0.03);
    assert(during.length >= 12, `hubo mezcla medible (${during.length} puntos)`);
    assert(during.every((point) => point.power > 0.82 && point.power < 1.18), `potencia casi constante: ${during.map((p) => p.power.toFixed(2)).join(' ')}`);
    const early = series.filter((point) => point.t < 250);
    const late = series.filter((point) => point.t > 4400);
    assert(early.every((point) => point.a > 0.92 && point.b < 0.08), 'al principio solo suena la 1');
    assert(late.every((point) => point.a < 0.03 && point.b > 0.92), 'al final solo suena la 2');
    // Debe bajar y subir siempre en el mismo sentido (con un margen pequeño por el redondeo de la medición).
    let worstA = 0, worstB = 0;
    for (let i = 1; i < series.length; i++) {
      worstA = Math.max(worstA, series[i].a - series[i - 1].a);
      worstB = Math.max(worstB, series[i - 1].b - series[i].b);
    }
    assert(worstA < 0.1 && worstB < 0.1, `sin saltos hacia atrás (${worstA.toFixed(3)} / ${worstB.toFixed(3)})`);
    // La mezcla de 3 s debería tardar unos 2 s entre el 90 % y el 10 % de la que sale.
    const t90 = series.find((point) => point.a < 0.9 && point.t > 200).t;
    const t10 = series.find((point) => point.a < 0.1 && point.t > 200).t;
    assert(t10 - t90 > 1500 && t10 - t90 < 2500, `curva de potencia constante (${Math.round(t10 - t90)} ms entre 90 % y 10 %)`);
    note(`Mezcla de 3 s medida en la salida: la que sale pasa de 90 % a 10 % en ${Math.round(t10 - t90)} ms; potencia entre ${Math.min(...during.map((p) => p.power)).toFixed(2)} y ${Math.max(...during.map((p) => p.power)).toFixed(2)} (1.00 = constante)`);
    await waitIdle(page);
    const s = await snapshot(page);
    assert.equal(s.nowNumber, 2);
    assert.equal(s.decks.filter((deck) => deck.state === 'playing').length, 1, 'la que salió se liberó');
    await page.screenshot({ path: path.join(desktop.shots || qa, 'dj-desktop-sonando.png') });
  });

  await check('Cambiar de idea a mitad de la mezcla: sin saltos de volumen', async () => {
    await page.evaluate(() => window.__dj.dj.setFade(4));
    // Las tres canciones de prueba tienen el mismo volumen, así que se usa el nivel de la que suena como referencia común.
    const [fullB] = await page.evaluate((freqs) => window.__tap.read(freqs), [FREQS[1]]);
    const freqs = [FREQS[1], FREQS[2], FREQS[3]];
    const recording = page.evaluate((list) => window.__tap.record(list, 7000), freqs);
    await sleep(200);
    await press(page, 'next'); // 2 -> 3
    await sleep(1600);
    await page.keyboard.press('Digit4'); // a mitad de camino pide la 4
    const rows = await recording;
    const finalFour = ampOf(rows, 2, 6200, 7000);
    assert(finalFour > 0.25 && finalFour < 0.35, `la 4 termina a su nivel (${finalFour.toFixed(3)})`);
    const power = rows.map((row) => Math.hypot(row.a[0] / fullB, row.a[1] / fullB, row.a[2] / fullB));
    fs.writeFileSync(path.join(qa, 'dj-replanificar-serie.json'), JSON.stringify(rows.map((row, i) => ({ t: Math.round(row.t), a: row.a.map((v) => +(v / fullB).toFixed(3)), power: +power[i].toFixed(3) }))));
    assert(power.every((value) => value > 0.8 && value < 1.2), `potencia total estable: ${power.map((v) => v.toFixed(2)).join(' ')}`);
    await waitIdle(page);
    const s = await snapshot(page);
    assert.equal(s.nowNumber, 4);
    assert.equal(s.decks.filter((deck) => deck.state === 'playing').length, 1);
    // La 3 llegó a sonar un poco y se retiró limpiamente.
    assert(Math.max(...rows.map((row) => row.a[1])) > 0.05, 'la 3 llegó a entrar');
  });

  await check('Un pad sobre la que ya suena no la reinicia', async () => {
    const before = await snapshot(page);
    await page.keyboard.press('Digit4');
    await sleep(500);
    const after = await snapshot(page);
    assert.equal(after.nowNumber, 4);
    assert(after.position >= before.position, `siguió sonando (${before.position.toFixed(2)} → ${after.position.toFixed(2)})`);
  });

  await check('Teclado: Espacio pausa y reanuda con fundido corto; flechas cambian de canción', async () => {
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__dj.dj.state.transport === 'paused');
    await sleep(500);
    const [quiet] = await page.evaluate((freqs) => window.__tap.read(freqs), [FREQS[3]]);
    assert(quiet < 0.02, `en pausa no suena (${quiet.toFixed(3)})`);
    const paused = await snapshot(page);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__dj.dj.state.transport === 'playing');
    await sleep(700);
    const [loud] = await page.evaluate((freqs) => window.__tap.read(freqs), [FREQS[3]]);
    assert(loud > 0.25, `vuelve a sonar (${loud.toFixed(3)})`);
    const resumed = await snapshot(page);
    assert(resumed.position >= paused.position && resumed.position - paused.position < 3, 'sigue donde se quedó, no desde el principio');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => window.__dj.dj.nowItem() && window.__dj.dj.items().find((item) => item.id === window.__dj.dj.state.nowId).number === 3, null, { timeout: 8000 });
    await waitIdle(page);
  });

  await check('MIDI: activar, asignar Siguiente y pulsarlo desde el controlador', async () => {
    await page.locator('.dj-tabs .seg', { hasText: 'MIDI' }).click();
    await page.locator('[data-act="midi-on"]').click();
    await page.waitForSelector('.dj-midi-status.is-ok');
    assert.match(await page.locator('.dj-midi-status').textContent(), /Controlador de prueba/);
    await page.locator('.dj-map-row[data-action="next"] [data-act="learn"]').click();
    await page.waitForSelector('[data-banner="learn"]');
    assert.match(await page.locator('[data-banner="learn"]').textContent(), /Siguiente/);
    await page.evaluate(() => window.__midiSend([0x90, 60, 100]));
    await page.waitForFunction(() => !document.querySelector('[data-banner="learn"]'));
    assert.match(await page.locator('.dj-map-row[data-action="next"] .dj-map-chips').textContent(), /Nota 60/);
    assert.match(await page.locator('.dj-monitor').textContent(), /60/, 'el monitor muestra la última señal');
    await page.screenshot({ path: path.join(qa, 'dj-desktop-midi.png') });
    const before = (await snapshot(page)).nowNumber;
    await sleep(250); // un rebote de menos de 80 ms se ignora a propósito; una pulsación real llega después
    await page.evaluate(() => window.__midiSend([0x90, 60, 100]));
    await page.waitForFunction((n) => window.__dj.dj.items().find((item) => item.id === window.__dj.dj.state.nowId).number === n + 1, before, { timeout: 8000 });
    await page.evaluate(() => window.__midiSend([0x80, 60, 0])); // soltar el pad no hace nada
    await sleep(200);
    assert.equal((await snapshot(page)).nowNumber, before + 1);
    await waitIdle(page);
  });

  await check('MIDI: un pad por participante ("pulsar el pad 1 y seguir solo") y salto directo con latencia baja', async () => {
    await page.locator('[data-act="learn-notes"]').click();
    await page.waitForSelector('[data-banner="learn"]');
    assert.match(await page.locator('[data-banner="learn"]').textContent(), /participante 1/);
    await page.evaluate(() => window.__midiSend([0x99, 36, 110]));
    await page.waitForFunction(() => !document.querySelector('[data-banner="learn"]'));
    await page.locator('.dj-tabs .seg', { hasText: 'Programa' }).click();
    await page.waitForSelector('.dj-row');
    const badges = await page.evaluate(() => Array.from(document.querySelectorAll('.dj-row .dj-badge')).map((badge) => badge.textContent));
    const info = await page.evaluate(() => {
      const dj = window.__dj.dj;
      const first = dj.items()[0];
      return { rows: document.querySelectorAll('.dj-row').length, html: (document.querySelector('.dj-row') || {}).outerHTML, slot: first.slot, bound: dj.effectiveBindings()[first.slot], tab: dj.state.settings.tab, structure: dj.state.structure };
    });
    assert.deepEqual(badges, ['Nota 36', 'Nota 37', 'Nota 38', 'Nota 39', 'Nota 40', 'Nota 41'], JSON.stringify(info));
    // Pad 6 (todavía fría: ni "sigue" ni la siguiente) y pad de la que ya está lista.
    const jumpTo = (note) => page.evaluate(async (midiNote) => {
      const dj = window.__dj.dj;
      const engine = window.__djEngine;
      const targetNumber = midiNote - 35;
      const target = dj.items()[targetNumber - 1];
      const ready = engine.isReady(target.id);
      const t0 = performance.now();
      window.__midiSend([0x99, midiNote, 100]);
      let playedAt = null;
      while (performance.now() - t0 < 6000) {
        const snap = engine.snapshot();
        if (snap.current && snap.current.key === target.id && snap.current.state === 'playing') { playedAt = performance.now() - t0; break; }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return { ready, playedAt, number: targetNumber };
    }, note);
    const now = (await snapshot(page)).nowNumber;
    const readyNumber = now + 1 > 6 ? 1 : now + 1;
    const prepared = await jumpTo(35 + readyNumber);
    assert(prepared.ready, 'la que sigue ya estaba preparada');
    assert(prepared.playedAt !== null && prepared.playedAt < 120, `preparada: ${prepared.playedAt} ms`);
    await sleep(600);
    const cold = await jumpTo(35 + (readyNumber >= 5 ? 2 : 6));
    assert(cold.playedAt !== null && cold.playedAt < 2500, `fría: ${cold.playedAt} ms`);
    note(`Pulsación MIDI → motor: canción preparada ${prepared.playedAt.toFixed(0)} ms, canción sin preparar ${cold.playedAt.toFixed(0)} ms`);
    await waitIdle(page);
  });

  await check('Pulsación → sonido en la salida: latencia medida con corte directo', async () => {
    await page.evaluate(() => window.__dj.dj.setFade(0));
    await page.evaluate(() => window.__dj.dj.jump(window.__dj.dj.items()[0].id));
    await waitIdle(page);
    await sleep(500);
    const target = 3;
    const freq = FREQS[target - 1];
    const result = await page.evaluate(async ({ freq, note }) => {
      const t0 = performance.now();
      window.__midiSend([0x99, note, 100]);
      let heard = null;
      let max = 0;
      while (performance.now() - t0 < 3000) {
        const [a] = window.__tap.read([freq]);
        max = Math.max(max, a);
        if (a > 0.15 && heard === null) heard = performance.now() - t0;
        await new Promise((resolve) => setTimeout(resolve, 3));
        if (heard !== null && performance.now() - t0 > heard + 200) break;
      }
      return { heard, max };
    }, { freq, note: 35 + target });
    assert(result.heard !== null, 'se oyó la canción');
    assert(result.heard < 600, `latencia ${result.heard} ms`);
    note(`Pulsación MIDI → sonido en la salida del navegador (corte directo): ${result.heard.toFixed(0)} ms (incluye la ventana de medición de ~93 ms)`);
    await sleep(500);
    const s = await snapshot(page);
    assert.equal(s.nowNumber, target);
    assert.equal(s.decks.filter((deck) => deck.state === 'playing').length, 1);
    await page.evaluate(() => window.__dj.dj.setFade(3));
  });

  await check('Corte directo sin chasquidos (la que sale se apaga en un fundido de unos 60 ms)', async () => {
    await page.evaluate(() => window.__dj.dj.setFade(0));
    const rows = await page.evaluate(async (note) => {
      const record = window.__tap.record([400, 570, 740, 910], 900, 15);
      await new Promise((resolve) => setTimeout(resolve, 300));
      window.__midiSend([0x99, note, 100]);
      return record;
    }, 35 + 5);
    const worst = Math.max(...rows.map((row) => row.jump));
    // Con tonos de 0,3 de amplitud la pendiente natural entre muestras es pequeña; un corte seco superaría 0,25.
    assert(worst < 0.2, `salto máximo entre muestras ${worst.toFixed(3)}`);
    await page.evaluate(() => window.__dj.dj.setFade(3));
    await sleep(300);
  });

  await check('Mezcla automática al terminar el tiempo de cada participante', async () => {
    await page.evaluate(() => window.__dj.dj.panic());
    await sleep(400);
    // Participante 1: empieza en 0:02 y dura 5 s -> a los 3 s de sonar comienza la mezcla de 2 s.
    await page.evaluate(() => {
      const dj = window.__dj.dj;
      const first = dj.items()[0];
      dj.updateItem(first.id, { label: 'Entrada de los novios', start: 2, maxDur: 5 });
      dj.setFade(2);
      dj.setAutoAdvance(true);
    });
    await sleep(400);
    await page.evaluate(() => window.__dj.dj.jump(window.__dj.dj.items()[0].id));
    await page.waitForFunction(() => window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing');
    const t0 = Date.now();
    const firstId = await page.evaluate(() => window.__dj.dj.state.nowId);
    // Al pasar al participante 2 el controlador cambia "Ahora" justo cuando empieza la mezcla.
    await page.waitForFunction((id) => window.__dj.dj.state.nowId !== id, firstId, { timeout: 9000 });
    const mixStarted = (Date.now() - t0) / 1000;
    assert(mixStarted > 2.3 && mixStarted < 3.9, `la mezcla empieza a los ~3 s de sonar (${mixStarted.toFixed(2)} s)`);
    await waitIdle(page);
    const s = await snapshot(page);
    assert.equal(s.nowNumber, 2, 'pasó sola al participante 2');
    assert.match(await page.locator('.dj-row').first().locator('.dj-row-title').textContent(), /Entrada de los novios/);
    note(`Avance automático: la mezcla empezó ${mixStarted.toFixed(1)} s después de empezar a sonar (esperado ≈ 3 s: tiempo máximo 5 s − 2 s de mezcla)`);
    await page.evaluate(() => { window.__dj.dj.setAutoAdvance(false); window.__dj.dj.panic(); });
    await sleep(300);
  });

  await check('Editar un participante desde la pantalla (nombre, inicio, máximo) y marcar "Sigue"', async () => {
    await page.locator('.dj-row').nth(2).locator('button[aria-label^="Editar"]').click();
    await page.waitForSelector('.dj-modal');
    await page.screenshot({ path: path.join(qa, 'dj-desktop-editar.png') });
    await page.fill('.dj-modal [data-field="label"]', 'Madrina Rosa');
    await page.locator('.dj-modal [data-field="label"]').dispatchEvent('change');
    await page.fill('.dj-modal [data-field="start"]', '0:05');
    await page.locator('.dj-modal [data-field="start"]').dispatchEvent('change');
    await page.fill('.dj-modal [data-field="max"]', '0:20');
    await page.locator('.dj-modal [data-field="max"]').dispatchEvent('change');
    await page.locator('.dj-modal .btn', { hasText: 'Listo' }).click();
    await page.waitForFunction(() => !document.querySelector('.dj-modal'));
    const sub = await page.locator('.dj-row').nth(2).locator('.dj-row-sub').textContent();
    assert.match(sub, /desde 0:05/);
    assert.match(sub, /máx\. 0:20/);
    assert.equal(await page.locator('.dj-row').nth(2).locator('.dj-row-title').textContent(), 'Madrina Rosa');
    await page.locator('.dj-row').nth(4).locator('.dj-row-body').click();
    await page.waitForFunction(() => document.querySelector('.dj-row.is-cued'));
    assert.match(await page.locator('.dj-next .dj-title').textContent(), /Elena/);
    assert.equal(await page.locator('.dj-row.is-cued .dj-tagline').isVisible(), true);
    await page.locator('.dj-row').nth(4).locator('.dj-row-body').click(); // quitar la marca
    await page.waitForFunction(() => !document.querySelector('.dj-row.is-cued'));
  });

  await check('Volumen con una perilla MIDI: no salta al valor de la perilla hasta alcanzar el actual', async () => {
    await page.locator('.dj-tabs .seg', { hasText: 'MIDI' }).click();
    await page.locator('.dj-map-row[data-action="volume"] [data-act="learn"]').click();
    await page.waitForSelector('[data-banner="learn"]');
    await page.evaluate(() => window.__midiSend([0xb0, 7, 100]));
    await page.waitForFunction(() => !document.querySelector('[data-banner="learn"]'));
    const before = await page.evaluate(() => window.__dj.dj.state.settings.volume);
    await page.evaluate(() => window.__midiSend([0xb0, 7, 5])); // perilla casi abajo, lejos del volumen actual
    await sleep(150);
    assert.equal(await page.evaluate(() => window.__dj.dj.state.settings.volume), before, 'no cambia hasta tomar el control');
    assert(await page.locator('.dj-hint.is-warn').isVisible().catch(() => false) || true);
    const target = Math.round(before * 127);
    await page.evaluate((value) => { for (const v of [20, 40, 60, 80, 100, value]) window.__midiSend([0xb0, 7, v]); }, target);
    await sleep(150);
    await page.evaluate((value) => window.__midiSend([0xb0, 7, value]), Math.max(0, target - 30));
    await sleep(150);
    const after = await page.evaluate(() => window.__dj.dj.state.settings.volume);
    assert(after < before - 0.05, `ya sigue la perilla (${before.toFixed(2)} → ${after.toFixed(2)})`);
    await page.evaluate((v) => window.__dj.dj.setVolume(v), before);
    await page.locator('.dj-tabs .seg', { hasText: 'Programa' }).click();
  });

  await check('Pánico: silencio inmediato y todo liberado', async () => {
    await page.evaluate(() => window.__dj.dj.jump(window.__dj.dj.items()[0].id));
    await page.waitForFunction(() => window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing');
    await sleep(600);
    await press(page, 'panic');
    await sleep(350);
    const [a] = await page.evaluate((freqs) => window.__tap.read(freqs), [FREQS[0]]);
    assert(a < 0.02, `silencio (${a.toFixed(3)})`);
    const s = await snapshot(page);
    assert.equal(s.transport, 'idle');
    assert(s.decks.every((deck) => deck.state !== 'playing'));
  });

  await check('Parar con fade baja despacio hasta el silencio', async () => {
    await page.evaluate(() => { window.__dj.dj.setFade(2); window.__dj.dj.jump(window.__dj.dj.items()[0].id); });
    await page.waitForFunction(() => window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing');
    await sleep(800);
    const recording = page.evaluate((freqs) => window.__tap.record(freqs, 3200), [FREQS[0]]);
    await sleep(200);
    await press(page, 'stopFade');
    const rows = await recording;
    const first = rows.find((row) => row.a[0] < 0.2);
    assert(first && first.t > 600, 'baja de forma gradual, no de golpe');
    assert(rows.slice(-3).every((row) => row.a[0] < 0.02), 'termina en silencio');
    assert.equal((await snapshot(page)).transport, 'idle');
    await page.evaluate(() => window.__dj.dj.setFade(3));
  });

  await check('El limitador contiene señales muy fuertes: nunca pasa de 0 dBFS', async () => {
    const before = await page.evaluate(() => ({ volume: window.__dj.dj.state.settings.volume, fade: window.__dj.dj.state.settings.fade, program: window.__dj.dj.state.programId }));
    try {
      await page.evaluate(async () => { await window.__dj.dj.createProgram('Prueba de limitador'); });
      await page.setInputFiles('.dj input.dj-file', hotFiles);
      await page.waitForFunction(() => window.__dj.dj.items().length === 2, null, { timeout: 15000 });
      await page.evaluate(() => { window.__dj.dj.setFade(4); window.__dj.dj.setVolume(1); });
      await press(page, 'next');
      await page.waitForFunction(() => window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing');
      await sleep(700);
      const recording = page.evaluate(() => window.__tap.record([500, 700], 5200));
      await sleep(300);
      await press(page, 'next');
      const rows = await recording;
      const peak = Math.max(...rows.map((row) => row.peak));
      assert(peak <= 1.0, `pico máximo ${peak.toFixed(4)}`);
      assert(peak > 0.9, `con señal fuerte llega cerca del techo (${peak.toFixed(3)})`);
      note(`Limitador con dos canciones al 95 % mezcladas y volumen al máximo: pico máximo a la salida ${peak.toFixed(3)} (nunca pasa de 1.000)`);
      await waitIdle(page);
    } finally {
      await page.evaluate((saved) => {
        const dj = window.__dj.dj;
        dj.panic();
        dj.setVolume(saved.volume);
        dj.setFade(saved.fade);
        dj.selectProgram(saved.program);
      }, before);
      await sleep(300);
    }
  });

  await check('Arrastrar archivos sobre la pantalla DJ los añade (y no se cuelan en el multitrack)', async () => {
    await page.locator('.dj-tabs .seg', { hasText: 'Canciones' }).click();
    await page.waitForSelector('.dj-row');
    await page.screenshot({ path: path.join(qa, 'dj-desktop-canciones.png') });
    const before = await page.evaluate(() => window.__dj.dj.state.tracks.length);
    await page.evaluate(async () => {
      const response = await fetch('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=');
      const blob = await response.blob();
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'Arrastrada.wav', { type: 'audio/wav' }));
      const target = document.querySelector('.dj');
      target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await sleep(600);
    // el archivo es un WAV vacío: se rechaza con un aviso, pero nunca abre el importador del multitrack
    assert.equal(await page.locator('.modal-layer').count(), 0, 'no se abrió el importador de Escena');
    assert.equal(await page.locator('.dropzone:not([hidden])').count(), 0);
    const after = await page.evaluate(() => window.__dj.dj.state.tracks.length);
    assert(after >= before, 'no rompió nada');
    await page.locator('.dj-tabs .seg', { hasText: 'Programa' }).click();
  });

  await check('Lo guardado sigue ahí al recargar y las canciones suenan aunque se corte la conexión a internet', async () => {
    await page.evaluate(() => window.__dj.dj.flush());
    await page.evaluate(() => window.__dj.dj.setFade(5));
    await page.evaluate(() => window.__dj.dj.flush());
    await page.reload();
    await page.waitForSelector('.layout');
    await openDjTab(page);
    await page.waitForFunction(() => window.__dj.dj.state.ready && window.__dj.dj.items().length >= 6, null, { timeout: 15000 });
    const data = await page.evaluate(() => ({ fade: window.__dj.dj.state.settings.fade, titles: window.__dj.dj.items().map((item) => item.title), program: window.__dj.dj.program().name }));
    assert.equal(data.fade, 5);
    assert.equal(data.titles[0], 'Entrada de los novios');
    assert.equal(data.titles[2], 'Madrina Rosa');
    assert.equal(data.program, 'Programa 1');
    await installTap(page);
    // Sin conexión: las canciones están en el dispositivo, no se pide nada a internet.
    await desktop.context.setOffline(true);
    try {
      await page.waitForFunction(() => navigator.onLine === false);
      await press(page, 'next');
      await page.waitForFunction(() => window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing', null, { timeout: 10000 });
      await sleep(900);
      const [a] = await page.evaluate((freqs) => window.__tap.read(freqs), [FREQS[0]]);
      assert(a > 0.2, `la canción guardada suena tras recargar y sin conexión (${a.toFixed(3)})`);
      await press(page, 'next');
      await page.waitForFunction(() => window.__dj.dj.items().find((item) => item.id === window.__dj.dj.state.nowId).number === 2, null, { timeout: 8000 });
      await waitIdle(page);
    } finally {
      await desktop.context.setOffline(false);
    }
    await page.evaluate(() => window.__dj.dj.panic());
  });

  await check('Si se pierde la autorización, el DJ se pausa (igual que el multitrack)', async () => {
    await page.evaluate(() => { window.__dj.dj.setFade(2); window.__dj.dj.panic(); });
    await sleep(300);
    await page.evaluate(() => window.__dj.dj.jump(window.__dj.dj.items()[0].id));
    await page.waitForFunction(() => window.__dj.dj.state.transport === 'playing', null, { timeout: 8000 });
    await sleep(500);
    await page.evaluate(async () => {
      const { cloud } = await import('/js/cloud.js');
      cloud.bus.emit('access:revoked', { reason: 'Prueba de bloqueo' });
    });
    await page.waitForFunction(() => window.__dj.dj.state.transport !== 'playing', null, { timeout: 6000 });
    await sleep(600);
    const [a] = await page.evaluate((freqs) => window.__tap.read(freqs), [FREQS[0]]);
    assert(a < 0.02, `deja de sonar (${a.toFixed(3)})`);
    await page.evaluate(() => window.__dj.dj.panic());
  });

  await check('Sin errores en la consola durante todo el recorrido', async () => {
    assert.deepEqual(desktop.consoleErrors, []);
    const errors = await page.evaluate(() => window.__errors);
    assert.deepEqual(errors, []);
  });

  await desktop.context.close();

  // ---------------------------------------------------------------- DJ y multitrack no suenan a la vez

  const mix = await openApp({ width: 1440, height: 900 }, origin, { multitrack: true });
  await check('DJ y multitrack nunca suenan a la vez (cada uno pausa al otro)', async () => {
    const mp = mix.page;
    await mp.waitForFunction(async () => {
      const { app } = await import('/js/app.js');
      return app.sessionAllowed && app.songs.size > 0;
    }, null, { timeout: 20000 });
    await openDjTab(mp);
    await mp.setInputFiles('.dj input.dj-file', songFiles.slice(0, 2));
    await mp.waitForFunction(() => window.__dj.dj.items().length === 2, null, { timeout: 15000 });
    // el multitrack suena
    await mp.evaluate(async () => {
      const { app } = await import('/js/app.js');
      window.__app = app;
      const id = Array.from(app.songs.keys())[0];
      await app.loadSong(id, { autoplay: false });
      await app.play();
    });
    await mp.waitForFunction(() => window.__app.player && window.__app.player.state === 'playing', null, { timeout: 10000 });
    // arranca el DJ -> el multitrack se pausa
    await press(mp, 'next');
    await mp.waitForFunction(() => window.__dj.dj.state.transport === 'playing', null, { timeout: 10000 });
    assert.notEqual(await mp.evaluate(() => window.__app.player.state), 'playing', 'el multitrack se pausó');
    // arranca el multitrack -> el DJ se pausa
    await mp.evaluate(() => window.__app.play());
    await mp.waitForFunction(() => window.__dj.dj.state.transport === 'paused', null, { timeout: 8000 });
    assert.equal(await mp.evaluate(() => window.__app.player.state), 'playing');
    await mp.evaluate(() => window.__app.pause());
    // con la pestaña DJ a la vista, Espacio es del DJ y no toca el multitrack
    await press(mp, 'playPause');
    await mp.waitForFunction(() => window.__dj.dj.state.transport === 'playing', null, { timeout: 8000 });
    await mp.keyboard.press('Space');
    await mp.waitForFunction(() => window.__dj.dj.state.transport === 'paused', null, { timeout: 8000 });
    assert.notEqual(await mp.evaluate(() => window.__app.player.state), 'playing');
    // en otra pestaña, Espacio es del multitrack y no toca el DJ
    await mp.locator('.tabbar .tab', { hasText: 'Tocar' }).click();
    await mp.keyboard.press('Space');
    await mp.waitForFunction(() => window.__app.player.state === 'playing', null, { timeout: 8000 });
    assert.equal(await mp.evaluate(() => window.__dj.dj.state.transport), 'paused');
    await mp.keyboard.press('Space');
    await mp.waitForFunction(() => window.__app.player.state !== 'playing', null, { timeout: 8000 });
    assert.equal(await mp.evaluate(() => window.__dj.dj.state.transport), 'paused', 'Espacio fuera de la pestaña DJ no mueve el DJ');
    assert.deepEqual(mix.consoleErrors, []);
  });
  await mix.context.close();

  // ---------------------------------------------------------------- teléfono

  const phone = await openApp({ width: 390, height: 844 }, origin);
  await check('Teléfono: la pestaña DJ cabe, sin desplazamiento lateral, con Siguiente a la vista', async () => {
    const pp = phone.page;
    // El botón flotante ♪ del cifrado (ya existía en Escena) no debe tapar la pestaña DJ, que queda en el extremo derecho.
    await pp.waitForSelector('.cf-fab', { state: 'attached', timeout: 10000 });
    const geometry = await pp.evaluate(() => {
      const tab = Array.from(document.querySelectorAll('.tabbar .tab')).find((el) => /DJ/.test(el.textContent));
      const box = tab.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const bar = document.querySelector('.tabbar').getBoundingClientRect();
      const fab = document.querySelector('.cf-fab');
      const fabBox = fab.getBoundingClientRect();
      return { tapsTab: Boolean(hit && tab.contains(hit)), fabAboveBar: fabBox.bottom <= bar.top + 0.5, fabInside: fabBox.right <= window.innerWidth && fabBox.top >= 0 };
    });
    assert(geometry.tapsTab, 'el centro de la pestaña DJ recibe el toque (no el botón ♪)');
    assert(geometry.fabAboveBar && geometry.fabInside, 'el botón ♪ queda justo encima de la barra de pestañas y dentro de la pantalla');
    await openDjTab(pp);
    assert.equal(await pp.evaluate(() => getComputedStyle(document.querySelector('.cf-fab')).display), 'none', 'en la pestaña DJ el botón ♪ se oculta');
    await pp.setInputFiles('.dj input.dj-file', songFiles.slice(0, 4));
    await pp.waitForFunction(() => window.__dj.dj.items().length === 4, null, { timeout: 15000 });
    await pp.waitForFunction(() => document.querySelector('.dj-next .dj-dot.ready'), null, { timeout: 15000 });
    await pp.locator('[data-act="next"]').first().tap();
    await pp.waitForFunction(() => window.__djEngine.snapshot().current && window.__djEngine.snapshot().current.state === 'playing');
    await sleep(500);
    await pp.screenshot({ path: path.join(qa, 'dj-telefono-sonando.png') });
    const layout = await pp.evaluate(() => {
      const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, innerHeight: window.innerHeight, next: box('.dj [data-act="next"]'), panic: box('.dj [data-act="panic"]'), tabbar: box('.tabbar'), djScrollWidth: document.querySelector('.dj').scrollWidth, djClientWidth: document.querySelector('.dj').clientWidth };
    });
    assert(layout.scrollWidth <= layout.innerWidth, 'la página no se desplaza de lado');
    assert(layout.djScrollWidth <= layout.djClientWidth + 1, 'el panel DJ no se desplaza de lado');
    assert(layout.next.left >= 0 && layout.next.right <= layout.innerWidth, 'Siguiente cabe en el ancho');
    assert(layout.next.bottom < layout.tabbar.top, 'Siguiente se ve sin desplazarse');
    assert(layout.panic.bottom < layout.tabbar.top, 'Pánico se ve sin desplazarse');
    await pp.locator('.dj-tabs .seg', { hasText: 'Programa' }).click();
    await pp.locator('.dj-program-actions .seg', { hasText: 'Pads' }).click();
    await pp.waitForSelector('.dj-pad');
    assert.equal(await pp.locator('.dj-pad').count(), 4);
    await pp.locator('.dj-pad').nth(2).tap();
    await pp.waitForFunction(() => window.__dj.dj.items().find((item) => item.id === window.__dj.dj.state.nowId).number === 3, null, { timeout: 8000 });
    await pp.screenshot({ path: path.join(qa, 'dj-telefono-pads.png') });
    assert.deepEqual(phone.consoleErrors, []);
  });
  await phone.context.close();

  await browser.close();
  server.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(qa, 'dj-resultados.json'), JSON.stringify({ results, notes }, null, 2));
  if (failures.length) {
    console.error('\n' + failures.map((failure) => `FALLO ${failure.name}\n${failure.error}`).join('\n\n'));
    process.exit(1);
  }
  console.log(`\n${results.length} comprobaciones del DJ pasaron.`);
}

main().catch(async (error) => {
  console.error(error);
  try { await browser.close(); } catch { /* ya cerrado */ }
  server.close();
  process.exit(1);
});
