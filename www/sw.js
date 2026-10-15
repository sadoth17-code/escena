const VERSION = 'escena-04d8def35ffe2c12';
const ASSETS = ["./","audio/clicks.json","audio/clicks.wav","audio/guias/es.json","audio/guias/es.wav","audio/pads/00.mp3","audio/pads/01.mp3","audio/pads/02.mp3","audio/pads/03.mp3","audio/pads/04.mp3","audio/pads/05.mp3","audio/pads/06.mp3","audio/pads/07.mp3","audio/pads/08.mp3","audio/pads/09.mp3","audio/pads/10.mp3","audio/pads/11.mp3","audio/pads/README.txt","audio/samples/clicks.wav","audio/samples/guides-en.wav","audio/samples/guides-es.wav","audio/samples/guides-fr.wav","audio/samples/guides-pt.wav","audio/voces.wav","css/app.css","icons/apple-touch-icon.png","icons/favicon.svg","icons/icon-192.png","icons/icon-512.png","icons/maskable-512.png","index.html","js/access.js","js/align.js","js/app.js","js/audio-info.js","js/audio-session.js","js/cloud-config.js","js/cloud-request.js","js/cloud-song-state.js","js/cloud.js","js/controls.js","js/cover.js","js/demo.js","js/engine.js","js/library.js","js/main.js","js/offline.js","js/pad.js","js/pitch-dsp.js","js/pitch-render.js","js/pitch-utils.js","js/pitch-worker.js","js/platform.js","js/player.js","js/sample-bank.js","js/sample-index.js","js/store.js","js/synth.js","js/tempo.js","js/ui/access.js","js/ui/cloud-view.js","js/ui/cover.js","js/ui/editor.js","js/ui/import.js","js/ui/kit.js","js/ui/library-view.js","js/ui/mixer.js","js/ui/pad-control.js","js/ui/pitch-control.js","js/ui/player-view.js","js/ui/section-map.js","js/ui/session.js","js/ui/settings.js","js/ui/shell.js","js/ui/stage.js","js/ui/timeline.js","js/ui/users.js","js/util.js","js/vendor/signalsmith-stretch/LICENSE.txt","js/vendor/signalsmith-stretch/PROVENANCE.txt","js/vendor/signalsmith-stretch/README.md","js/vendor/signalsmith-stretch/SignalsmithStretchWasm.mjs","js/voices.js","js/wav.js","js/zip.js","manifest.webmanifest"];
const CACHE = `escena-${VERSION}`;
// Guías de voz en otros idiomas: no vienen precargadas. Se guardan al elegirlas por primera vez
// y se conservan entre versiones de la app (si cambian sus audios, se sube el número).
const GUIDES = 'guias-v1';
const scope = new URL(self.registration.scope);
const assetUrls = ASSETS.map((path) => new URL(path, scope).href);
const assetPaths = new Set(assetUrls.map((value) => new URL(value).pathname));
const isGuide = (url) => /^audio\/guias\/(en|pt|fr)\.(wav|json)$/.test(url.pathname.slice(scope.pathname.length));

// Solo recursos públicos incluidos en el paquete. Nunca interceptar la API, el puente de
// nube, URLs firmadas, solicitudes con claves ni otros GET del mismo dominio.
function accepts(request) {
  if (!ASSETS.length || request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('x-escena-key') || request.cache === 'no-store') return false;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || url.username || url.password || !url.pathname.startsWith(scope.pathname)) return false;
  if (url.search && [...url.searchParams.keys()].some((key) => !['v', 'version'].includes(key))) return false;
  return assetPaths.has(url.pathname) || isGuide(url);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const requests = ASSETS.map((path) => new Request(new URL(path, self.registration.scope).href, { cache: 'reload' }));
      try {
        await cache.addAll(requests);
      } catch (error) {
        // Una instalación incompleta no debe aparecer como lista para usar sin internet.
        await caches.delete(CACHE);
        throw error;
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const stale = (name) => (name.startsWith('escena-') && name !== CACHE) || (name.startsWith('guias-') && name !== GUIDES);
      await Promise.all(names.filter(stale).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip') self.skipWaiting();
  if (event.data?.type === 'offline:status' && event.ports?.[0]) {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE);
        const missing = [];
        for (let index = 0; index < assetUrls.length; index++) {
          if (!await cache.match(assetUrls[index])) missing.push(ASSETS[index]);
        }
        const guides = (await caches.keys()).includes(GUIDES) ? await caches.open(GUIDES) : null;
        const languages = [];
        for (const lang of ['en', 'pt', 'fr']) {
          if (guides && await guides.match(new URL(`audio/guias/${lang}.wav`, scope).href) && await guides.match(new URL(`audio/guias/${lang}.json`, scope).href)) languages.push(lang);
        }
        event.ports[0].postMessage({ ready: missing.length === 0, version: VERSION, assets: assetUrls.length, missing, languages });
      } catch (error) {
        event.ports[0].postMessage({ ready: false, error: error.message, missing: [] });
      }
    })());
  }
});

async function withRange(request, response) {
  const range = request.headers.get('range');
  if (!range || !/^bytes=\d*-\d*$/.test(range)) return response;
  const bytes = await response.arrayBuffer();
  const [start, end] = range.slice(6).split('-');
  const first = start ? Number(start) : Math.max(0, bytes.byteLength - Number(end));
  const last = start && end ? Math.min(Number(end), bytes.byteLength - 1) : bytes.byteLength - 1;
  if (first > last || first >= bytes.byteLength) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.byteLength}` } });
  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${first}-${last}/${bytes.byteLength}`);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(last - first + 1));
  return new Response(bytes.slice(first, last + 1), { status: 206, headers });
}

async function answer(request) {
  const cache = await caches.open(CACHE);
  const url = new URL(request.url);
  const guide = isGuide(url);
  const guides = guide ? await caches.open(GUIDES) : null;
  const canonical = new URL(url.pathname, scope.origin).href;
  const hit = (await cache.match(canonical)) || (guides ? await guides.match(canonical) : null);
  if (hit) return withRange(request, hit);
  // Rutas de navegación internas usan la misma página, sin guardar consultas ni nuevas URLs.
  if (request.mode === 'navigate') {
    const shell = await cache.match(new URL('./', scope).href);
    if (shell) return shell;
  }
  try {
    const response = await fetch(request);
    if (response.ok && response.status === 200 && response.type === 'basic' && (guide || assetPaths.has(url.pathname))) await (guides || cache).put(canonical, response.clone()).catch(() => {});
    return response;
  } catch (error) {
    if (request.mode === 'navigate') {
      const shell = await cache.match(new URL('./', self.registration.scope).href);
      if (shell) return shell;
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!accepts(request)) return;
  event.respondWith(answer(request));
});
