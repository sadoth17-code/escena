const VERSION = 'nube-v5-sadoth17';
const ASSETS = ["./","audio/voces.wav","css/app.css","icons/apple-touch-icon.png","icons/favicon.svg","icons/icon-192.png","icons/icon-512.png","icons/maskable-512.png","index.html","js/app.js","js/cloud-config.js","js/cloud.js","js/controls.js","js/demo.js","js/engine.js","js/library.js","js/main.js","js/platform.js","js/player.js","js/store.js","js/synth.js","js/tempo.js","js/ui/cloud-view.js","js/ui/editor.js","js/ui/import.js","js/ui/kit.js","js/ui/library-view.js","js/ui/mixer.js","js/ui/player-view.js","js/ui/section-map.js","js/ui/settings.js","js/ui/shell.js","js/ui/stage.js","js/ui/timeline.js","js/util.js","js/voices.js","js/zip.js","manifest.webmanifest"];
const CACHE = `escena-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const requests = ASSETS.map((path) => new Request(new URL(path, self.registration.scope).href, { cache: 'reload' }));
      await cache.addAll(requests);
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith('escena-') && name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip') self.skipWaiting();
});

async function answer(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') cache.put(request, response.clone()).catch(() => {});
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
  if (!ASSETS.length || request.method !== 'GET' || request.headers.has('authorization') || request.cache === 'no-store') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(answer(request));
});
