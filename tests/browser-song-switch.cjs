/* Local browser integration test. No credentials or real cloud service are used. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');

const root = path.resolve(__dirname, '../www');
const qa = process.env.ESCENA_QA_DIR || path.resolve(__dirname, '../../qa');
const failures = [];
const results = [];
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
    if (file === path.join(root, 'js', 'engine.js')) {
      // Count every stem decode, including the PCM WAV reader that bypasses decodeAudioData.
      response.end(bytes.toString('utf8') + '\nconst __fixtureDecode = Engine.prototype.decode;\nEngine.prototype.decode = function (...args) { window.__counts.decodes++; return __fixtureDecode.apply(this, args); };\n');
      return;
    }
    response.end(bytes);
  });
});

async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error: error.stack }); results.push({ name, passed: false }); console.log(`FAIL ${name}: ${error.message}`); }
}

async function seed(page, origin) {
  await page.goto(origin + '/__fixture.html');
  await page.evaluate(async origin => {
    const { store } = await import('/js/store.js');
    const { createSong, createTrackDef, createSetlist } = await import('/js/library.js');
    const wav = (hz) => {
      const rate = 22050, seconds = 12, samples = rate * seconds;
      const bytes = new ArrayBuffer(44 + samples * 2), view = new DataView(bytes);
      const word = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
      word(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); word(8, 'WAVE');
      word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      word(36, 'data'); view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i / rate * hz * Math.PI * 2) * 1000, true);
      return new Blob([bytes], { type: 'audio/wav' });
    };
    const songs = [];
    for (let songIndex = 0; songIndex < 7; songIndex++) {
      const tracks = [];
      for (let trackIndex = 0; trackIndex < 2; trackIndex++) {
        const blob = wav(220 + songIndex * 40 + trackIndex * 10), fileId = `fixture-${songIndex}-${trackIndex}`;
        await store.put('files', { id: fileId, blob, name: `${fileId}.wav` });
        const track = createTrackDef({ name: trackIndex ? 'Guitarra' : 'Piano', dest: 'main', mono: true, item: { blob } }, fileId, trackIndex);
        track.duration = 12;
        tracks.push(track);
      }
      const song = createSong(`Prueba ${songIndex + 1}`, tracks);
      song.key = 'C';
      song.markers = [{ id: `intro-${songIndex}`, bar: 1, name: 'Intro', color: '#35c9ff' }];
      await store.put('songs', song);
      songs.push(song.id);
    }
    const setlist = createSetlist('Prueba de cinco canciones');
    setlist.songIds = songs.slice(0, 5);
    await store.put('setlists', setlist);
    await store.setMeta('activeSetlist', setlist.id);
    await store.setMeta('fixtureSongIds', songs);
    await store.setMeta('settings', { preloadNext: true, warmBudgetMB: 128, keepAwake: false });
    sessionStorage.setItem(`escena-cloud:${origin}`, 'a'.repeat(64));
  }, origin);
}

async function contextFor(viewport, origin) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...(viewport.width < 960 ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36' } : {}) });
  const blocked = [];
  await context.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (target.origin === origin || ['data:', 'blob:'].includes(target.protocol)) await route.continue();
    else { blocked.push(target.href); await route.abort(); }
  });
  await context.addInitScript(() => {
    window.__counts = { fileReads: 0, decodes: 0, nativeDecodes: 0 };
    window.__errors = [];
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) {
      if (this.name === 'files') window.__counts.fileReads++;
      return get.apply(this, args);
    };
    const ctx = window.AudioContext || window.webkitAudioContext;
    if (ctx) {
      const decode = ctx.prototype.decodeAudioData;
      ctx.prototype.decodeAudioData = function (...args) { window.__counts.nativeDecodes++; return decode.apply(this, args); };
    }
    window.addEventListener('error', event => window.__errors.push(String(event.error || event.message)));
    window.addEventListener('unhandledrejection', event => window.__errors.push(String(event.reason)));
  });
  const page = await context.newPage();
  await seed(page, origin);
  await page.goto(origin);
  await page.waitForSelector('.layout');
  await page.evaluate(async () => {
    const { app } = await import('/js/app.js');
    const { store } = await import('/js/store.js');
    window.__app = app;
    window.__ids = await store.getMeta('fixtureSongIds');
    window.__events = { loading: [], unloaded: 0, loaded: [] };
    app.on('loading', state => window.__events.loading.push(state ? { id: state.song.id, switching: state.switching } : null));
    app.on('song:unloaded', () => window.__events.unloaded++);
    app.on('song:loaded', entry => window.__events.loaded.push(entry.song.id));
  });
  await page.waitForFunction(() => window.__ids.every(id => window.__app.isReady(id)) && !window.__app.jobs.size && !window.__app.inspection);
  return { context, page, blocked };
}

async function main() {
  fs.mkdirSync(qa, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.ESCENA_CHROMIUM || (fs.existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined),
    headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const desktop = await contextFor({ width: 1440, height: 1000 }, origin);
  const { page } = desktop;

  await check('Automatic preparation: setlist and other downloaded library songs are ready', async () => {
    const state = await page.evaluate(() => ({ prepared: window.__app.preparationStatus(), ready: window.__ids.map(id => window.__app.isReady(id)), counts: window.__counts }));
    assert(state.ready.every(Boolean));
    assert.equal(state.prepared.ready, 5);
    assert.equal(state.prepared.total, 5);
    assert.equal(state.counts.decodes, 14);
    assert(state.counts.fileReads >= 14);
  });

  await check('Prepared arbitrary switches preserve player and stage with zero reads or decodes', async () => {
    await page.evaluate(() => window.__app.loadSong(window.__ids[0]));
    await page.locator('[aria-label="Modo escenario"]').first().click();
    await page.waitForSelector('.stage:not([hidden])');
    const state = await page.evaluate(async () => {
      const before = { ...window.__counts }, loadedBefore = window.__events.loaded.length;
      const title = document.querySelector('.pv-title'), transport = document.querySelector('.transport'), stage = document.querySelector('.stage');
      window.__events.loading = [];
      // Songs 6 and 7 are downloaded library songs outside the five-song setlist.
      for (const index of [4, 1, 5, 3, 6, 0, 2, 5, 4, 6, 0]) {
        const promise = window.__app.loadSong(window.__ids[index]);
        if (window.__app.current.song.id !== window.__ids[index]) throw new Error('Prepared selection was not applied synchronously');
        await promise;
        if (stage.hidden) throw new Error('Stage closed');
        if (document.querySelector('.pv-title') !== title || document.querySelector('.transport') !== transport) throw new Error('Player controls replaced');
      }
      return { before, after: { ...window.__counts }, unloaded: window.__events.unloaded, loading: window.__events.loading, loaded: window.__events.loaded.length - loadedBefore, stageTitle: document.querySelector('.stage-title').textContent };
    });
    assert.deepEqual(state.before, state.after);
    assert.equal(state.unloaded, 0);
    assert.equal(state.loading.length, 0);
    assert.equal(state.loaded, 11);
    assert.equal(state.stageTitle, 'Prueba 1');
    await page.screenshot({ path: path.join(qa, 'desktop-stage-prepared.png'), fullPage: true });
    await page.locator('[aria-label="Salir del modo escenario"]').click();
  });

  await check('Prepare setlist buttons do not throw TypeError or unhandled rejection', async () => {
    // Once all songs are ready the buttons deliberately disable themselves.
    // Clear only the prepared cache to exercise each real enabled click handler.
    await page.evaluate(() => { window.__app.setSetting('preloadNext', false); window.__app.warmUp(); });
    await page.locator('.panel-lib button').filter({ hasText: 'Preparar setlist' }).click();
    await page.waitForFunction(() => window.__ids.every(id => window.__app.isReady(id)) && !window.__app.jobs.size && !window.__app.inspection);
    await page.evaluate(() => { window.__app.setSetting('preloadNext', false); window.__app.warmUp(); });
    await page.locator('.panel-play button').filter({ hasText: 'Preparar setlist' }).click();
    await page.waitForFunction(() => window.__ids.every(id => window.__app.isReady(id)) && !window.__app.jobs.size && !window.__app.inspection);
    assert.deepEqual(await page.evaluate(() => window.__errors), []);
  });

  await check('Cold switch retains current title and controls under a compact progress indicator', async () => {
    await page.evaluate(() => {
      const app = window.__app;
      app.setSetting('preloadNext', false);
      app.warmUp();
      const decode = app.engine.decode.bind(app.engine);
      window.__realDecode = decode;
      window.__decodeGates = [];
      app.engine.decode = async blob => { await new Promise(resolve => window.__decodeGates.push(resolve)); return decode(blob); };
      window.__coldPromise = app.loadSong(window.__ids[5]);
    });
    await page.waitForFunction(() => window.__decodeGates.length > 0);
    const state = await page.evaluate(() => {
      const live = document.querySelector('.pv-live'), progress = document.querySelector('.pv-loading');
      return { current: window.__app.current?.song.id, expected: window.__ids[0], title: document.querySelector('.pv-title').textContent, live: !live.hidden, controls: !document.querySelector('.transport').hidden, switching: progress.classList.contains('is-switching'), indicatorHeight: progress.getBoundingClientRect().height, unloaded: window.__events.unloaded };
    });
    assert.equal(state.current, state.expected);
    assert.equal(state.title, 'Prueba 1');
    assert(state.live && state.controls && state.switching);
    assert(state.indicatorHeight > 0 && state.indicatorHeight < 150, `indicator height ${state.indicatorHeight}`);
    assert.equal(state.unloaded, 0);
    await page.screenshot({ path: path.join(qa, 'desktop-cold-progress.png'), fullPage: true });
    await page.evaluate(() => window.__decodeGates.splice(0).forEach(resolve => resolve()));
    await page.evaluate(() => window.__coldPromise);
    assert.equal(await page.locator('.pv-title').textContent(), 'Prueba 6');
  });

  await check('Most recent selection wins while cold preparation is pending; stage stays open', async () => {
    await page.locator('[aria-label="Modo escenario"]').first().click();
    await page.evaluate(() => { window.__firstPromise = window.__app.loadSong(window.__ids[1]); });
    await page.waitForFunction(() => window.__decodeGates.length > 0);
    await page.evaluate(() => { window.__secondPromise = window.__app.loadSong(window.__ids[6]); });
    await page.waitForFunction(() => window.__decodeGates.length >= 4);
    const pending = await page.evaluate(() => ({ open: !document.querySelector('.stage').hidden, title: document.querySelector('.stage-title').textContent, current: window.__app.current.song.id, expected: window.__ids[5], switching: document.querySelector('.stage-loading').classList.contains('is-switching'), progress: document.querySelector('.stage-loading').getBoundingClientRect().height }));
    assert(pending.open && pending.switching);
    assert.equal(pending.current, pending.expected);
    assert.equal(pending.title, 'Prueba 6');
    assert(pending.progress > 0 && pending.progress < 160);
    await page.screenshot({ path: path.join(qa, 'desktop-stage-cold-progress.png'), fullPage: true });
    await page.evaluate(() => window.__decodeGates.splice(0).forEach(resolve => resolve()));
    await page.evaluate(() => Promise.all([window.__firstPromise, window.__secondPromise]));
    assert.equal(await page.locator('.stage-title').textContent(), 'Prueba 7');
    assert(await page.locator('.stage').isVisible());
    assert.equal(await page.evaluate(() => window.__app.current.song.id === window.__ids[6]), true);
    await page.evaluate(() => { window.__app.engine.decode = window.__realDecode; });
    await page.locator('[aria-label="Salir del modo escenario"]').click();
  });

  const mobile = await contextFor({ width: 390, height: 844 }, origin);
  await check('Mobile Setlist tab stays selected during arbitrary prepared song changes', async () => {
    const mobilePage = mobile.page;
    await mobilePage.getByRole('tab', { name: 'Setlist', exact: true }).click();
    await mobilePage.locator(`.song-row[data-id="${await mobilePage.evaluate(() => window.__ids[0])}"] .song-title`).click();
    // An initial selection may take the user to Tocar; subsequent selections preserve their tab.
    await mobilePage.getByRole('tab', { name: 'Setlist', exact: true }).click();
    const before = await mobilePage.evaluate(() => ({ ...window.__counts }));
    for (const index of [4, 1, 3, 0]) {
      const id = await mobilePage.evaluate(i => window.__ids[i], index);
      await mobilePage.locator(`.song-row[data-id="${id}"] .song-title`).click();
      assert.equal(await mobilePage.locator('.layout').getAttribute('data-tab'), 'lib');
      assert.equal(await mobilePage.evaluate(() => window.__app.current.song.id), id);
    }
    assert.deepEqual(await mobilePage.evaluate(() => window.__counts), before);
    assert.deepEqual(await mobilePage.evaluate(() => window.__errors), []);
    await mobilePage.screenshot({ path: path.join(qa, 'mobile-setlist-prepared.png'), fullPage: true });
  });

  const summary = { results, failures, desktopErrors: await page.evaluate(() => window.__errors), externalRequestsBlocked: [...desktop.blocked, ...mobile.blocked], note: 'Synthetic local WAVs decoded by Chromium. This test does not evaluate physical audio hardware or subjective sound.' };
  fs.writeFileSync(path.join(qa, 'browser-song-switch-results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length || summary.desktopErrors.length) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.close();
});
