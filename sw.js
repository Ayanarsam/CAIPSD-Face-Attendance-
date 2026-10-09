/* CAIPSD Rollcall service worker: keeps the face models and engines on the device,
   so the app starts fast and still opens when the internet is down. */
const CACHE = 'rollcall-assets-v1';
const PAGE_CACHE = 'rollcall-page-v3';
const APP_CACHE = 'rollcall-app-v1';   // this site's own files (scripts, styles, icons), stored per version

// Versioned files that never change at the same URL: serve from the device first.
const ASSET_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE, PAGE_CACHE, APP_CACHE]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // check-ins (POST) always go straight to the network
  const url = new URL(req.url);

  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    e.respondWith(pageFirst(e));
  } else if (url.origin === self.location.origin && /\.(js|css|png|webmanifest)$/.test(url.pathname) && !url.pathname.endsWith('/sw.js')) {
    e.respondWith(deviceFirst(req, false, APP_CACHE));   // versioned with ?v=, so a saved copy is always the right one
  } else if (ASSET_HOSTS.includes(url.hostname)) {
    e.respondWith(deviceFirst(req));
  } else if (url.hostname === 'fonts.googleapis.com') {
    e.respondWith(deviceFirst(req, true));
  }
});

// Use the copy on the device; fetch and store it the first time only.
async function deviceFirst(req, refresh, cacheName = CACHE) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) {
    if (refresh) fetch(req).then(r => { if (r.ok) cache.put(req, r); }).catch(() => {});
    return hit;
  }
  const res = await fetch(req);
  if (res.ok && res.type !== 'opaque') cache.put(req, res.clone());
  return res;
}

// The page itself: open the saved copy instantly, fetch the newest version in the background,
// and tell the app when a newer version has arrived (it reloads itself when nobody is at the camera).
async function pageFirst(e) {
  const cache = await caches.open(PAGE_CACHE);
  const key = new Request(new URL(e.request.url).pathname);
  const hit = await cache.match(key);
  const oldText = hit ? await hit.clone().text() : null;
  const net = fetch(e.request.url, { cache: 'no-store', credentials: 'same-origin' }).then(async res => {
    if (res.ok && res.type === 'basic') {
      const fresh = await res.clone().text();
      await cache.put(key, res.clone());
      if (oldText !== null && oldText !== fresh) notifyUpdate();
      pruneAppFiles(fresh);
    }
    return res;
  });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }   // instant open; the download only refreshes the saved copy
  return net;                                                  // first visit: nothing saved yet
}

async function notifyUpdate() {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'page-updated' });
}

// keep only the app files the current page uses (older versions are removed)
async function pruneAppFiles(html) {
  const m = /config\.js\?v=([\w.-]+)/.exec(html); if (!m) return;   // the release version of the code files
  const cache = await caches.open(APP_CACHE);
  for (const req of await cache.keys()) {
    const u = new URL(req.url), v = u.searchParams.get('v');
    if (/\.(js|css)$/.test(u.pathname) && v && v !== m[1]) await cache.delete(req);   // icons/manifest have their own versions
  }
}
