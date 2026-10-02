const { app, BrowserWindow, Menu, powerSaveBlocker, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'www');
const ORIGIN = 'app://escena';
const ALLOWED_PERMISSIONS = new Set(['midi', 'midiSysex', 'fullscreen', 'media']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let mainWindow = null;
let blockerId = null;

async function serve(request) {
  const url = new URL(request.url);
  let name = decodeURIComponent(url.pathname);
  if (name.endsWith('/')) name += 'index.html';
  const file = path.normalize(path.join(ROOT, name));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return new Response('Prohibido', { status: 403 });
  try {
    const data = await fs.promises.readFile(file);
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return new Response(data, { status: 200, headers: { 'content-type': type, 'cache-control': 'no-cache' } });
  } catch (error) {
    return new Response('No encontrado', { status: 404 });
  }
}

function allowPermission(permission, details) {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  if (permission !== 'media') return true;
  const types = details && (details.mediaTypes || (details.mediaType ? [details.mediaType] : []));
  return !types || types.every((type) => type === 'audio' || type === 'unknown');
}

function buildMenu() {
  if (process.platform !== 'darwin') return null;
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'Visualización', submenu: [{ role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Escena',
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });
  mainWindow.loadURL(`${ORIGIN}/index.html`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    protocol.handle('app', serve);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowPermission(permission, details)));
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => allowPermission(permission, details));
    blockerId = powerSaveBlocker.start('prevent-display-sleep');
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    app.quit();
  });
}
