import { store } from './store.js';
import { createEmitter, isNative } from './util.js';

const bus = createEmitter();
let listening = false;
let online = navigator.onLine !== false;

function networkChanged() {
  online = navigator.onLine !== false;
  document.documentElement.dataset.online = String(online);
  bus.emit('network', { online });
}

export function installOffline() {
  if (listening) return;
  listening = true;
  window.addEventListener('online', networkChanged);
  window.addEventListener('offline', networkChanged);
  networkChanged();
}

async function inspectAssets() {
  // EXE, DMG y APK incluyen el código, clicks, guías y pads dentro del instalador.
  // Sus canciones permanecen en IndexedDB, igual que en el navegador.
  if (isNative()) return { ready: true, bundled: true, missing: [], languages: ['en', 'pt', 'fr'] };
  if (!('serviceWorker' in navigator)) return { ready: false, bundled: false, missing: [], error: 'Este navegador no permite preparar la aplicación sin internet.' };
  const registration = await navigator.serviceWorker.getRegistration(new URL('./', document.baseURI).href);
  const worker = navigator.serviceWorker.controller || registration?.active;
  if (!worker) return { ready: false, bundled: false, missing: [], error: 'La aplicación aún está preparando sus archivos para funcionar sin internet. Mantén esta página abierta con conexión.' };
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (result) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve({ bundled: false, ...result });
    };
    const timer = setTimeout(() => finish({ ready: false, missing: [], error: 'No se pudo comprobar la copia de la aplicación. Actualiza Escena con conexión y repite la comprobación.' }), 8000);
    channel.port1.onmessage = (event) => finish(event.data);
    try { worker.postMessage({ type: 'offline:status' }, [channel.port2]); }
    catch (error) { finish({ ready: false, missing: [], error: error.message }); }
  });
}

// Lee los archivos guardados; no descarga ni decodifica el audio. «Completa» significa
// que puede cargarse sin red. «Preparada» significa que ya está decodificada en RAM.
export async function inspectOffline({ songs = [], isReady = () => false } = {}) {
  const [assets, persistent, usage] = await Promise.all([
    inspectAssets().catch((error) => ({ ready: false, missing: [], error: error.message })),
    store.isPersistent(),
    store.usage().catch(() => ({ used: 0, quota: 0 })),
  ]);
  const result = [];
  let bytes = 0;
  const counted = new Set();
  for (const song of songs) {
    const tracks = song.tracks || [];
    const files = await store.getMany('files', tracks.map((track) => track.fileId));
    const missing = [];
    tracks.forEach((track, index) => {
      const file = files[index];
      if (!file?.blob || file.blob.size < 1 || (file.size > 0 && file.blob.size !== file.size)) {
        missing.push({ id: track.id, name: track.name || 'Pista', fileId: track.fileId });
      } else if (!counted.has(track.fileId)) {
        counted.add(track.fileId);
        bytes += file.blob.size;
      }
    });
    result.push({ id: song.id, title: song.title, complete: missing.length === 0, prepared: missing.length === 0 && Boolean(isReady(song.id)), tracks: tracks.length, missing });
  }
  const complete = result.filter((song) => song.complete).length;
  const report = {
    online: navigator.onLine !== false,
    native: isNative(),
    ready: assets.ready && complete === result.length,
    assets,
    songs: result,
    total: result.length,
    complete,
    prepared: result.filter((song) => song.prepared).length,
    bytes,
    persistent,
    usage,
  };
  bus.emit('check', report);
  return report;
}

export const offline = {
  on: bus.on,
  get online() { return online; },
  inspect: inspectOffline,
};
