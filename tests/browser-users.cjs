/* Users UI integration against a local in-memory API. No real cloud credentials. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright') : 'playwright');
const root = path.resolve(__dirname, '../www');
const qa = process.env.ESCENA_QA_DIR || path.resolve(__dirname, '../../qa');
const requests = [], results = [];
let users = [{ id: 'user-initial', name: 'Músico de prueba', role: 'player', active: true, offlineHours: 24, version: 1 }];
let createdKey = 'b'.repeat(64), rotatedKey = 'c'.repeat(64), browser;
const reply = (response, status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/v1/users')) {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const data = raw ? JSON.parse(raw) : null;
    requests.push({ method: request.method, path: url.pathname, data });
    if (url.pathname === '/v1/users' && request.method === 'GET') return reply(response, 200, { users });
    if (url.pathname === '/v1/users' && request.method === 'POST') {
      const user = { id: `user-${users.length + 1}`, ...data, active: true, version: 1 };
      users.push(user); return reply(response, 201, { user, key: createdKey });
    }
    const id = url.pathname.split('/')[3], user = users.find(row => row.id === id);
    if (!user) return reply(response, 404, { error: 'Usuario no encontrado' });
    if (data.version !== user.version) return reply(response, 409, { error: 'El usuario cambió. Actualiza la lista.' });
    if (request.method === 'PUT') { Object.assign(user, data, { version: user.version + 1 }); return reply(response, 200, { user }); }
    if (request.method === 'POST' && url.pathname.endsWith('/rotate')) { user.version++; return reply(response, 200, { user, key: rotatedKey }); }
    return reply(response, 400, { error: 'Operación no válida' });
  }
  if (url.pathname === '/__users.html') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/app.css"><body><div id="fixture"></div></body></html>'); return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  fs.readFile(file, (error, bytes) => { if (error) response.writeHead(404).end(); else { response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); response.end(bytes); } });
});
async function check(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); console.log(`FAIL ${name}: ${error.message}`); }
}
async function main() {
  fs.mkdirSync(qa, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.ESCENA_CHROMIUM || (fs.existsSync('/tmp/chromium') ? '/tmp/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const blocked = [], errors = [];
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push(route.request().url()), route.abort()));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/__users.html');
  await page.evaluate(async origin => {
    const { cloud } = await import('/js/cloud.js');
    const { createCloudView } = await import('/js/ui/cloud-view.js');
    const { openUsers } = await import('/js/ui/users.js');
    window.__cloud = cloud; window.__openUsers = openUsers;
    cloud.api = origin; cloud.key = 'a'.repeat(64); cloud.ready = true; cloud.initPromise = Promise.resolve();
    const time = Date.now();
    await cloud.rememberAccess({ accessVersion: 2, user: { id: 'owner', name: 'Propietario de prueba', role: 'owner', offlineHours: 24 }, role: 'master', permissions: { publish: true, manageUsers: true }, offlineUntil: time + 86400000, serverTime: time });
    window.__copies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copies.push(text); } } });
    document.getElementById('fixture').append(createCloudView().el);
  }, origin);
  const dialog = title => page.getByRole('dialog', { name: title, exact: true });
  await check('Only owner sees Users button', async () => {
    await page.getByRole('button', { name: 'Usuarios', exact: true }).waitFor();
    for (const role of ['editor', 'player']) {
      await page.evaluate(role => { window.__cloud.identity = { id: 'test', name: 'Prueba', role, offlineHours: 24 }; window.__cloud.emit(); }, role);
      assert.equal(await page.getByRole('button', { name: 'Usuarios', exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => { try { window.__openUsers(); return false; } catch { return true; } }), true);
    }
    await page.evaluate(() => { window.__cloud.identity = { id: 'owner', name: 'Propietario de prueba', role: 'owner', offlineHours: 24 }; window.__cloud.emit(); });
    await page.getByRole('button', { name: 'Usuarios', exact: true }).click();
    await dialog('Usuarios').locator('[data-user-id="user-initial"]').waitFor();
    await page.screenshot({ path: path.join(qa, 'users-desktop-list.png'), fullPage: true, animations: 'disabled' });
  });
  await check('Approve personal editor, key hidden and no automatic clipboard or persistence', async () => {
    await dialog('Usuarios').getByRole('button', { name: 'Aprobar usuario' }).click();
    const form = dialog('Aprobar nuevo usuario');
    await form.getByLabel('Nombre del usuario').fill('Editor de ensayo');
    await form.getByLabel('Permiso del usuario').selectOption('editor');
    await form.getByLabel('Uso sin internet').selectOption('72');
    await form.getByRole('button', { name: 'Aprobar y crear clave' }).click();
    const keyDialog = dialog('Usuario aprobado');
    await keyDialog.waitFor();
    assert.equal(await keyDialog.getByLabel('Clave personal').getAttribute('type'), 'password');
    assert.equal(await keyDialog.getByLabel('Clave personal').inputValue(), createdKey);
    assert.equal(await page.evaluate(() => window.__copies.length), 0);
    assert.deepEqual(requests.find(request => request.method === 'POST').data, { name: 'Editor de ensayo', role: 'editor', offlineHours: 72 });
    assert.equal(await page.evaluate(async value => {
      const { store } = await import('/js/store.js');
      return JSON.stringify([...Object.values(localStorage), ...Object.values(sessionStorage), await store.all('meta')]).includes(value);
    }, createdKey), false);
    await page.keyboard.press('Escape');
    assert(await keyDialog.isVisible());
    await page.screenshot({ path: path.join(qa, 'users-desktop-new-key.png'), fullPage: true, animations: 'disabled' });
    await keyDialog.getByRole('button', { name: 'Mostrar clave' }).click();
    assert.equal(await keyDialog.getByLabel('Clave personal').getAttribute('type'), 'text');
    await keyDialog.getByRole('button', { name: 'Copiar clave' }).click();
    assert.equal(await page.evaluate(() => window.__copies.length), 1);
    await keyDialog.getByRole('button', { name: 'Ya guardé la clave' }).click();
    assert.equal(await page.locator('[aria-label="Clave personal"]').count(), 0);
  });
  await check('Edit permissions, block, unblock and rotate use current versions with confirmations', async () => {
    const card = dialog('Usuarios').locator('[data-user-id="user-2"]');
    await card.getByRole('button', { name: 'Editar permisos' }).click();
    const edit = dialog('Editar usuario');
    await edit.getByLabel('Nombre del usuario').fill('Músico de ensayo');
    await edit.getByLabel('Permiso del usuario').selectOption('player');
    await edit.getByLabel('Uso sin internet').selectOption('0');
    await edit.getByRole('button', { name: 'Guardar cambios' }).click();
    await card.getByText('Músico de ensayo', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Bloquear', exact: true }).click();
    await dialog('Bloquear usuario').getByRole('button', { name: 'Cancelar', exact: true }).click();
    assert.equal(users.find(user => user.id === 'user-2').active, true);
    await card.getByRole('button', { name: 'Bloquear', exact: true }).click();
    await dialog('Bloquear usuario').getByRole('button', { name: 'Bloquear', exact: true }).click();
    await card.getByText('Bloqueado', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Habilitar', exact: true }).click();
    await dialog('Habilitar usuario').getByRole('button', { name: 'Habilitar', exact: true }).click();
    await card.getByText('Aprobado · Activo', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Renovar clave' }).click();
    await dialog('Renovar clave personal').getByRole('button', { name: 'Renovar clave', exact: true }).click();
    await dialog('Clave personal renovada').waitFor();
    assert.equal(await dialog('Clave personal renovada').getByLabel('Clave personal').inputValue(), rotatedKey);
    assert.equal(await page.evaluate(() => window.__copies.length), 1);
    await dialog('Clave personal renovada').getByRole('button', { name: 'Ya guardé la clave' }).click();
    assert.deepEqual(requests.filter(request => request.path.startsWith('/v1/users/user-2')).map(request => request.data.version), [1, 2, 3, 4]);
    assert.equal(users.find(user => user.id === 'user-2').version, 5);
  });
  await check('Mobile users dialog fits screen and closes when owner access is lost', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(qa, 'users-mobile-list.png'), fullPage: true, animations: 'disabled' });
    const rect = await dialog('Usuarios').boundingBox();
    assert(rect.width <= 390);
    assert(rect.x >= 0);
    await dialog('Usuarios').getByRole('button', { name: 'Aprobar usuario' }).click();
    await dialog('Aprobar nuevo usuario').getByLabel('Nombre del usuario').fill('Prueba de cierre seguro');
    await dialog('Aprobar nuevo usuario').getByRole('button', { name: 'Aprobar y crear clave' }).click();
    await dialog('Usuario aprobado').waitFor();
    await page.evaluate(() => { window.__cloud.identity.role = 'player'; window.__cloud.emit(); });
    assert.equal(await dialog('Usuarios').count(), 0);
    assert.equal(await dialog('Usuario aprobado').count(), 0);
    assert.equal(await page.locator('[aria-label="Clave personal"]').count(), 0);
  });
  const summary = { results, errors, blockedExternalRequests: blocked, requestCount: requests.length, note: 'Local in-memory user API only; no real credentials or deployment.' };
  fs.writeFileSync(path.join(qa, 'browser-users-results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (results.some(result => !result.passed) || errors.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
