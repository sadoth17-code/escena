/* Local browser integration test: nombres de las salidas de audio en Ajustes. No credentials or real cloud service are used.
 * Run: node tests/browser-output-devices.cjs
 * Los dispositivos de audio se simulan (enumerateDevices, getUserMedia, selectAudioOutput y AudioContext.setSinkId):
 * lo que se comprueba es lo que Escena enseña y hace con cada respuesta del navegador. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');

const root = path.resolve(__dirname, '../www');
const qa = process.env.ESCENA_QA_DIR || path.resolve(__dirname, '../../qa');
const failures = [];
let browser;

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
    response.end(bytes);
  });
});

const out = (kind, deviceId, label) => ({ kind, deviceId, label, groupId: deviceId });
const REALTEK = [
  out('audiooutput', 'default', 'Default - Altavoces (Realtek(R) Audio)'),
  out('audiooutput', 'communications', 'Communications - Altavoces (Realtek(R) Audio)'),
  out('audiooutput', 'dev-realtek', 'Altavoces (Realtek(R) Audio)'),
];
const FOCUSRITE = out('audiooutput', 'dev-focusrite', 'Salida 1-2 (Focusrite USB Audio)');

// Lo que hace Chrome la primera vez: una entrada vacía por tipo (medido en Chromium 141).
const HIDDEN = [out('audioinput', '', ''), out('videoinput', '', ''), out('audiooutput', '', '')].map((device) => ({ ...device, groupId: '' }));

function stubDevices(config) {
  const state = { mode: config.start, gum: config.gum || 'ok', devices: config.devices, calls: { gum: 0, stopped: 0, select: 0, sinks: [] } };
  window.__dev = state;
  const media = navigator.mediaDevices;
  media.enumerateDevices = async () => (state.mode === 'hidden' ? config.hidden : state.devices);
  media.getUserMedia = async () => {
    state.calls.gum++;
    if (state.gum !== 'ok') { const error = new Error('stub'); error.name = state.gum; throw error; }
    state.mode = 'named';
    return { getTracks: () => [{ stop() { state.calls.stopped++; } }] };
  };
  if (config.select || config.selectError) {
    media.selectAudioOutput = async () => {
      state.calls.select++;
      if (config.selectError) { const error = new Error('stub'); error.name = config.selectError; throw error; }
      state.mode = 'named';
      return config.select;
    };
  }
  const proto = (window.AudioContext || window.webkitAudioContext).prototype;
  proto.setSinkId = async function setSinkId(id) { state.calls.sinks.push(typeof id === 'string' ? id : JSON.stringify(id)); };
}

async function openSettings(config, { phone = false } = {}) {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    serviceWorkers: 'block',
    ...(phone ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36' } : {}),
  });
  await context.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    if (target.origin === origin || ['data:', 'blob:'].includes(target.protocol)) await route.continue();
    else await route.abort();
  });
  await context.addInitScript(stubDevices, config);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(origin + '/__fixture.html');
  await page.evaluate((base) => sessionStorage.setItem(`escena-cloud:${base}`, 'a'.repeat(64)), origin);
  await page.goto(origin);
  await page.waitForSelector('.layout');
  await page.evaluate(async () => {
    const { app } = await import('/js/app.js');
    window.__app = app;
    const { openSettings: open } = await import('/js/ui/settings.js');
    open();
  });
  await page.waitForFunction(() => document.querySelector('.settings .field-label') !== null);
  return { context, page, errors };
}

const select = (page) => page.locator('select[aria-label="Dispositivo de salida"]');
const namesButton = (page) => page.getByRole('button', { name: 'Mostrar nombres de los dispositivos' });
const optionTexts = (page) => select(page).locator('option').allTextContents();
const dev = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__dev.calls)));
const settled = (page) => page.waitForFunction(() => document.querySelector('select[aria-label="Dispositivo de salida"]')?.options.length > 0);

async function scenario(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error: error.stack }); console.log(`FAIL ${name}: ${error.message.split('\n')[0]}`); }
}

async function main() {
  fs.mkdirSync(qa, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch();

  await scenario('Chrome sin permiso: ofrece mostrar los nombres, los muestra y deja elegir la interfaz', async () => {
    const { context, page, errors } = await openSettings({ start: 'hidden', hidden: HIDDEN, devices: [...REALTEK, FOCUSRITE] });
    await settled(page);
    assert.deepEqual(await optionTexts(page), ['Predeterminado del sistema'], 'sin permiso solo está la salida del sistema');
    await namesButton(page).waitFor({ timeout: 3000 });
    await page.screenshot({ path: path.join(qa, 'salidas-1-sin-permiso.png') });
    await namesButton(page).click();
    await page.locator('select[aria-label="Dispositivo de salida"] option', { hasText: 'Focusrite' }).waitFor({ state: 'attached', timeout: 3000 });
    assert.equal(await namesButton(page).count(), 0, 'con los nombres a la vista el botón desaparece');
    assert.deepEqual(await optionTexts(page), [
      'Predeterminado del sistema (Altavoces (Realtek(R) Audio))',
      'Altavoces (Realtek(R) Audio)',
      'Salida 1-2 (Focusrite USB Audio)',
    ]);
    const calls = await dev(page);
    assert.equal(calls.gum, 1);
    assert.equal(calls.stopped, 1, 'el micrófono se suelta enseguida');
    await select(page).selectOption('dev-focusrite');
    await page.waitForFunction(() => window.__app.sinkState === 'ok');
    const saved = await page.evaluate(() => ({ id: window.__app.settings.sinkId, label: window.__app.settings.sinkLabel }));
    assert.deepEqual(saved, { id: 'dev-focusrite', label: 'Salida 1-2 (Focusrite USB Audio)' });
    assert.ok((await dev(page)).sinks.includes('dev-focusrite'));
    const note = await page.locator('.device-box .field-hint').first().textContent();
    assert.match(note, /^Salida 1-2 \(Focusrite USB Audio\) · /, `la nota dice cuál es la salida: ${note}`);
    await page.screenshot({ path: path.join(qa, 'salidas-2-con-nombres.png') });
    assert.deepEqual(errors, []);
    await context.close();
  });

  await scenario('Permiso del micrófono bloqueado: explica qué hacer y mantiene el botón', async () => {
    const { context, page } = await openSettings({ start: 'hidden', hidden: HIDDEN, devices: REALTEK, gum: 'NotAllowedError' });
    await settled(page);
    await namesButton(page).click();
    await page.getByRole('status').filter({ hasText: 'bloqueado' }).waitFor({ timeout: 3000 });
    assert.equal(await namesButton(page).count(), 1);
    assert.deepEqual(await optionTexts(page), ['Predeterminado del sistema']);
    await page.screenshot({ path: path.join(qa, 'salidas-3-bloqueado.png') });
    await context.close();
  });

  await scenario('Sin micrófono en el equipo: lo dice con claridad', async () => {
    const { context, page } = await openSettings({ start: 'hidden', hidden: HIDDEN, devices: REALTEK, gum: 'NotFoundError' });
    await settled(page);
    await namesButton(page).click();
    await page.getByRole('status').filter({ hasText: 'ningún micrófono' }).waitFor({ timeout: 3000 });
    await context.close();
  });

  await scenario('Con permiso ya concedido: al conectar la interfaz aparece sola con su nombre', async () => {
    const { context, page } = await openSettings({ start: 'named', hidden: HIDDEN, devices: REALTEK });
    await settled(page);
    assert.equal(await namesButton(page).count(), 0, 'con nombres no se pide nada');
    assert.deepEqual(await optionTexts(page), ['Predeterminado del sistema (Altavoces (Realtek(R) Audio))', 'Altavoces (Realtek(R) Audio)']);
    await page.evaluate(() => {
      window.__dev.devices = [...window.__dev.devices, { kind: 'audiooutput', deviceId: 'dev-focusrite', label: 'Salida 1-2 (Focusrite USB Audio)', groupId: 'g' }];
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    });
    await page.locator('select[aria-label="Dispositivo de salida"] option', { hasText: 'Focusrite' }).waitFor({ state: 'attached', timeout: 4000 });
    await context.close();
  });

  await scenario('Navegador con selector propio: elige la interfaz sin pedir el micrófono', async () => {
    const { context, page } = await openSettings({
      start: 'hidden', hidden: HIDDEN, devices: [...REALTEK, FOCUSRITE], select: { kind: 'audiooutput', deviceId: 'dev-focusrite', label: 'Salida 1-2 (Focusrite USB Audio)' },
    });
    await settled(page);
    await page.getByRole('button', { name: 'Elegir salida…' }).click();
    await page.waitForFunction(() => window.__app.settings.sinkId === 'dev-focusrite' && window.__app.sinkState === 'ok');
    const calls = await dev(page);
    assert.equal(calls.select, 1);
    assert.equal(calls.gum, 0, 'no se pidió el micrófono');
    assert.ok(calls.sinks.includes('dev-focusrite'));
    await page.waitForFunction(() => {
      const element = document.querySelector('select[aria-label="Dispositivo de salida"]');
      return element.value === 'dev-focusrite' && element.selectedOptions[0].textContent === 'Salida 1-2 (Focusrite USB Audio)';
    });
    await context.close();
  });

  await scenario('Cerrar el selector del navegador sin elegir no cambia nada ni muestra error', async () => {
    const { context, page } = await openSettings({ start: 'hidden', hidden: HIDDEN, devices: REALTEK, selectError: 'NotAllowedError' });
    await settled(page);
    await page.getByRole('button', { name: 'Elegir salida…' }).click();
    await page.waitForFunction(() => window.__dev.calls.select === 1);
    assert.equal(await page.evaluate(() => window.__app.settings.sinkId), '');
    assert.equal((await page.locator('.names-box [role="status"]').textContent()).trim(), '', 'cerrar sin elegir no es un error');
    await context.close();
  });

  await scenario('Teléfono o tablet: sigue usando la salida del sistema, sin lista', async () => {
    const { context, page } = await openSettings({ start: 'hidden', hidden: HIDDEN, devices: REALTEK }, { phone: true });
    await page.getByText('Este dispositivo usa la salida de audio que elijas en el sistema').waitFor({ timeout: 3000 });
    assert.equal(await select(page).count(), 0);
    assert.equal(await namesButton(page).count(), 0);
    await context.close();
  });

  await browser.close();
  server.close();
  if (failures.length) {
    for (const failure of failures) console.error(`\n--- ${failure.name}\n${failure.error}`);
    process.exit(1);
  }
  console.log('\nTodas las comprobaciones pasaron.');
}

main().catch((error) => { console.error(error); process.exit(1); });
