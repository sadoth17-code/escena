/* La pantalla Nube real (www/js/ui/cloud-view.js) en Chromium, con el resto de módulos
 * sustituidos por piezas mínimas. Comprueba el botón «Eliminar de la nube»: quién lo ve,
 * qué dice la confirmación y que solo borra si se acepta. Sin servicios externos.
 * Ejecuta: node tests/browser-cloud-view.cjs (necesita Playwright y un navegador;
 * ESCENA_CHROMIUM permite indicar su ejecutable). */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');

const root = path.resolve(__dirname, '../www');
const results = [], problems = [];

const stubs = {
  '/js/util.js': `
    export const fmtBytes = bytes => (bytes / 1e9).toFixed(2) + ' GB';
    export function h(tag, props = {}, ...children) {
      const el = document.createElement(tag);
      for (const [name, value] of Object.entries(props || {})) {
        if (value == null || value === false) continue;
        if (name === 'class') el.className = value;
        else if (name === 'text') el.textContent = value;
        else if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2).toLowerCase(), value);
        else if (name === 'disabled' || name === 'value') el[name] = value;
        else el.setAttribute(name, value === true ? '' : value);
      }
      for (const child of children.flat(Infinity)) { if (child == null || child === false) continue; el.append(child.nodeType ? child : document.createTextNode(String(child))); }
      return el;
    }`,
  '/js/ui/kit.js': `
    export const icon = () => document.createElement('span');
    export const field = (label, input) => { const row = document.createElement('div'); row.append(label, input); return row; };
    export const openModal = () => ({ close() {}, setActions() {} });
    window.__confirms = []; window.__confirmAnswer = false;
    export const confirmDialog = async options => { window.__confirms.push(options); return window.__confirmAnswer; };`,
  '/js/ui/users.js': 'export const openUsers = () => {};',
  '/js/cloud-config.js': "export const CLOUD_API_URL = 'https://escena.test';",
  '/js/app.js': `
    export const app = { songs: new Map(), toast() {}, songList: () => [], on() {}, loadSong() {}, addToSetlist() {}, deleteSong: async () => {} };`,
  '/js/access.js': `
    export const access = { canEdit: true, on() {} };
    window.__access = access;`,
  '/js/cloud.js': `
    const listeners = new Set();
    export const cloud = {
      ready: true, connected: true, canAccess: true, identity: { name: 'Gvelarde', role: 'owner' }, role: 'master', cloudRole: 'master',
      canPublish: true, canDelete: true, canManageUsers: true, active: null, progress: null, retry: null, loading: false, offline: false,
      catalog: [
        { id: 'songone01', revision: 'revision01', title: 'Enamorados - Tercer Cielo', artist: '', tracks: 11, size: 1080000000, bpm: 98, updatedAt: Date.UTC(2026, 9, 12, 19, 30) },
        { id: 'songtwo02', revision: 'revision02', title: 'Enamorados - Tercer Cielo', artist: '', tracks: 11, size: 1080000000, bpm: 98 },
      ],
      deleted: [],
      async init() {}, on(name, fn) { listeners.add(fn); return () => listeners.delete(fn); }, emit() { for (const fn of listeners) fn(); },
      async pending() { return []; },
      local(id) { return id === 'songtwo02' ? { id: 'local-2', title: 'Enamorados - Tercer Cielo', cloud: { revision: 'revision02' } } : undefined; },
      async localHasChanges() { return false; }, async refresh() {}, async disconnect() {},
      async deleteSong(remote) { this.deleted.push(remote.id); },
    };
    window.__cloud = cloud;`,
};

const page = `<!doctype html><html lang="es"><body><div id="host"></div>
<script type="module">
  import { createCloudView } from '/js/ui/cloud-view.js';
  const view = createCloudView();
  document.getElementById('host').append(view.el);
  window.__ready = view.show().then(() => true);
</script></body></html>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/__view.html') { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end(page); }
  if (stubs[url.pathname]) { response.writeHead(200, { 'Content-Type': 'text/javascript' }); return response.end(stubs[url.pathname]); }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (file !== path.join(root, 'js/ui/cloud-view.js')) { response.writeHead(404).end(); return; }
  fs.readFile(file, (error, bytes) => { if (error) response.writeHead(404).end(); else { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(bytes); } });
});

async function check(name, fn) {
  try { await fn(); results.push(`ok - ${name}`); }
  catch (error) { results.push(`not ok - ${name}\n    ${error.message}`); problems.push(name); }
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.ESCENA_CHROMIUM || undefined, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ locale: 'es-PE' });
  const tab = await context.newPage();
  const pageErrors = [];
  tab.on('pageerror', error => pageErrors.push(error.message));
  tab.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
  await tab.goto(`${origin}/__view.html`);
  await tab.evaluate(() => window.__ready);
  const settle = () => tab.evaluate(() => new Promise(resolve => setTimeout(resolve, 60)));
  const set = values => tab.evaluate(values => { Object.assign(window.__cloud, values.cloud || {}); Object.assign(window.__access, values.access || {}); window.__cloud.emit(); }, values).then(settle);
  const buttons = () => tab.$$eval('.cloud-card', cards => cards.map(card => [...card.querySelectorAll('button')].map(button => ({ text: button.textContent, disabled: button.disabled }))));

  await check('the owner sees both cards and an «Eliminar de la nube» button on each', async () => {
    await tab.waitForSelector('.cloud-card');
    const cards = await buttons();
    assert.equal(cards.length, 2);
    for (const card of cards) assert.ok(card.some(button => button.text === 'Eliminar de la nube' && !button.disabled), JSON.stringify(card));
    assert.ok(cards[0].some(button => button.text === 'Descargar'), 'the cloud-only card still downloads');
    assert.ok(cards[1].some(button => button.text === 'Abrir'), 'the card on this device still opens');
  });

  await check('the card shows when the song was published, to tell duplicates apart', async () => {
    const texts = await tab.$$eval('.cloud-card .field-hint', nodes => nodes.map(node => node.textContent));
    assert.ok(texts.some(text => /11 pistas/.test(text) && /98 BPM/.test(text) && /2026|26/.test(text) && /\d/.test(text.split('BPM')[1] || '')), texts.join(' | '));
    assert.ok(texts.some(text => /11 pistas/.test(text) && !/BPM ·/.test(text)), 'a song without a date still renders');
  });

  await check('cancelling the confirmation deletes nothing; it names the song, size and date', async () => {
    await tab.evaluate(() => { window.__confirmAnswer = false; window.__confirms.length = 0; });
    await tab.locator('.cloud-card').nth(0).getByRole('button', { name: 'Eliminar de la nube' }).click();
    await settle();
    const { confirms, deleted } = await tab.evaluate(() => ({ confirms: window.__confirms, deleted: window.__cloud.deleted }));
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].danger, true);
    for (const part of ['Enamorados - Tercer Cielo', '11 pistas', '1.08 GB', 'publicada el', 'no se puede deshacer']) assert.ok(confirms[0].message.includes(part), `${part}: ${confirms[0].message}`);
    assert.deepEqual(deleted, []);
  });

  await check('accepting the confirmation deletes exactly the song of that card', async () => {
    await tab.evaluate(() => { window.__confirmAnswer = true; window.__confirms.length = 0; });
    await tab.locator('.cloud-card').nth(1).getByRole('button', { name: 'Eliminar de la nube' }).click();
    await settle();
    const { confirms, deleted } = await tab.evaluate(() => ({ confirms: window.__confirms, deleted: window.__cloud.deleted }));
    assert.deepEqual(deleted, ['songtwo02']);
    assert.ok(!/publicada el/.test(confirms[0].message), 'no date is invented when the list has none');
  });

  await check('editors and musicians never see the button', async () => {
    await set({ cloud: { canDelete: false, identity: { name: 'Editor', role: 'editor' } } });
    for (const card of await buttons()) assert.ok(!card.some(button => button.text === 'Eliminar de la nube'));
    await set({ cloud: { canDelete: false, canPublish: false, role: 'player', identity: { name: 'Músico', role: 'player' } }, access: { canEdit: false } });
    const cards = await buttons();
    assert.equal(cards.length, 2);
    for (const card of cards) assert.ok(!card.some(button => button.text === 'Eliminar de la nube' || button.text === 'Publicar cambios'));
  });

  await check('an owner whose device is locked for editing cannot delete either', async () => {
    await set({ cloud: { canDelete: true, canPublish: true, role: 'master', identity: { name: 'Gvelarde', role: 'owner' } }, access: { canEdit: false } });
    for (const card of await buttons()) assert.ok(!card.some(button => button.text === 'Eliminar de la nube'));
    await set({ access: { canEdit: true } });
    for (const card of await buttons()) assert.ok(card.some(button => button.text === 'Eliminar de la nube'));
  });

  await check('the button is disabled during a transfer and when the device is offline', async () => {
    await set({ cloud: { active: { id: 'x' } } });
    for (const card of await buttons()) assert.ok(card.some(button => button.text === 'Eliminar de la nube' && button.disabled));
    await set({ cloud: { active: null } });
    await context.setOffline(true); await settle();
    await tab.evaluate(() => window.dispatchEvent(new Event('offline'))); await settle();
    for (const card of await buttons()) assert.ok(card.some(button => button.text === 'Eliminar de la nube' && button.disabled));
    await context.setOffline(false);
  });

  await check('the screen rendered without page errors', async () => { assert.deepEqual(pageErrors, []); });

  await browser.close(); server.close();
  console.log(results.join('\n'));
  console.log(`# ${results.length - problems.length}/${results.length} pasan`);
  process.exit(problems.length ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
