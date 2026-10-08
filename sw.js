/* CAIPSD Rollcall service worker: keeps the face models and engines on the device,
   so the app starts fast and still opens when the internet is down. */
const CACHE = 'rollcall-assets-v1';
const PAGE_CACHE = 'rollcall-page-v2';

// Versioned files that never change at the same URL: serve from the device first.
const ASSET_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE, PAGE_CACHE]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // check-ins (POST) always go straight to the network
  const url = new URL(req.url);

  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    e.respondWith(pageFirst(req));
  } else if (ASSET_HOSTS.includes(url.hostname)) {
    e.respondWith(deviceFirst(req));
  } else if (url.hostname === 'fonts.googleapis.com') {
    e.respondWith(deviceFirst(req, true));
  }
});

// Use the copy on the device; fetch and store it the first time only.
async function deviceFirst(req, refresh) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) {
    if (refresh) fetch(req).then(r => { if (r.ok) cache.put(req, r); }).catch(() => {});
    return hit;
  }
  const res = await fetch(req);
  if (res.ok && res.type !== 'opaque') cache.put(req, res.clone());
  return res;
}

// The page itself: get the latest version, but fall back to the saved copy if the network is slow or down.
async function pageFirst(req) {
  const cache = await caches.open(PAGE_CACHE);
  const net = fetch(req.url, { cache: 'no-store', credentials: 'same-origin' }).then(   // always ask GitHub for the newest page, never the browser's old copy
    res => { if (res.ok) cache.put(req, res.clone()); return res; });
  try {
    return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow network')), 3000))]);
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || net;   // nothing saved yet: keep waiting for the network
  }
}
