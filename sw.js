const CACHE_NAME = 'cleo-compiler-pwa-v2';
const ENGINE_CACHE_PREFIX = 'cleo-offline-';          // offline engine cache (sannycore WASM + data pack) is never auto-deleted
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/community.html',
  '/documentation.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/offline/offline-mode.js',
  '/offline/offline-engine.js'
];
// CDNs the page needs to start with no internet (Tailwind, Monaco editor, fonts)
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // add one by one: a missing file must not break the whole install
      Promise.all(ASSETS_TO_CACHE.map((u) => cache.add(u).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => (key !== CACHE_NAME && !key.startsWith(ENGINE_CACHE_PREFIX)) ? caches.delete(key) : null))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Backend compile/decompile/AI requests: network only
  if (url.pathname.includes('/api/')) return;

  // Pages: network first (always fresh when online), cached copy when offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  const isOfflineEngine = url.origin === location.origin && url.pathname.includes('/offline/');
  const isCdn = CDN_HOSTS.includes(url.hostname);
  if (!isOfflineEngine && !isCdn && url.origin !== location.origin) return;   // ads, analytics ...: untouched

  // Static files: cache first, store new ones on the way
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque') && (isCdn || isOfflineEngine || url.origin === location.origin)) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
