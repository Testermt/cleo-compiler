// Service worker: app files are NETWORK-FIRST (a new deploy shows up on the next load, no cache/site-data clearing),
// cached copies are used only when offline or when the network is very slow.
const CACHE_NAME = 'cleo-compiler-pwa-v3';
const ENGINE_CACHE = 'cleo-offline-engine-v1';       // offline engine (sannycore WASM + data pack); never auto-deleted
const KEEP_PREFIX = 'cleo-offline-';
const NETWORK_TIMEOUT_MS = 4000;                     // slow network + cached copy available -> use the cached copy
const ASSETS_TO_CACHE = [
  '/', '/index.html', '/community.html', '/documentation.html', '/manifest.json',
  '/icon-192.png', '/icon-512.png', '/offline/offline-mode.js', '/offline/offline-engine.js'
];
// Versioned CDN files (Tailwind, Monaco, fonts): immutable -> cache first
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS_TO_CACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})))
    )
  );
  self.skipWaiting();                                 // new version takes over immediately
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE_NAME && !k.startsWith(KEEP_PREFIX)) ? caches.delete(k) : null))
    ).then(() => self.clients.claim())
  );
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = (await cache.match(req)) || (await caches.match(req));
  // always revalidate with the server (304 = cheap); navigations keep the browser's own revalidation
  const netReq = req.mode === 'navigate' ? req : new Request(req, { cache: 'no-cache' });
  const net = fetch(netReq).then((res) => {
    if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) cache.put(req, res.clone());
    return res;
  });
  if (!cached) return net;
  return Promise.race([
    net.catch(() => cached),
    new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS)),
  ]);
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/api/')) return;          // backend requests: network only

  if (url.origin === location.origin) {
    const cacheName = url.pathname.includes('/offline/') ? ENGINE_CACHE : CACHE_NAME;
    event.respondWith(
      networkFirst(req, cacheName).catch(() =>
        req.mode === 'navigate' ? caches.match('/index.html') : Response.error()
      )
    );
    return;
  }
  if (CDN_HOSTS.includes(url.hostname)) { event.respondWith(cacheFirst(req)); return; }
  // ads, analytics ...: untouched
});
