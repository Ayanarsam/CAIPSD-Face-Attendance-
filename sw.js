/* CAIPSD Rollcall service worker: keeps the face models and engines on the device,
   so the app starts fast and still opens when the internet is down. */
const CACHE = 'rollcall-assets-v1';
const PAGE_CACHE = 'rollcall-page-v3';

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
    e.respondWith(pageFirst(e));
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

// The page itself: open the saved copy instantly, fetch the newest version in the background,
// and tell the app when a newer version has arrived (it reloads itself when nobody is at the camera).
// The worker also remembers which version is on screen ("shown"), so an update is never missed.
async function pageFirst(e) {
  const cache = await caches.open(PAGE_CACHE);
  const path = new URL(e.request.url).pathname;
  const key = new Request(path);
  const hit = await cache.match(key);
  const oldText = hit ? await hit.clone().text() : null;
  const net = fetch(e.request.url, { cache: 'no-store', credentials: 'same-origin' }).then(async res => {
    if (res.ok && res.type === 'basic') {
      const fresh = await res.clone().text();
      await cache.put(key, res.clone());
      if (oldText === null) await markShown(cache, path, fresh);   // first visit: this download is what's on screen
      else if (oldText !== fresh) notifyUpdate();
    }
    return res;
  });
  if (hit) {                                                     // instant open; the download only refreshes the saved copy
    e.waitUntil(markShown(cache, path, oldText).then(() => net).catch(() => {}));
    return hit;
  }
  return net;                                                    // first visit: nothing saved yet
}

const shownKey = (path) => new Request(path + '?shown');
const markShown = (cache, path, text) => cache.put(shownKey(path), new Response(text, { headers: { 'Content-Type': 'text/plain' } }));

async function notifyUpdate() {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'page-updated' });
}

// The office device stays open all day, so the app asks every 15 minutes: is there a newer page on GitHub?
// If the newest page differs from the one on screen, it is saved on the device and the app is told to reload
// (it does so when nobody is at the camera). If that message is missed, the next check sends it again.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'check-update' && e.source && e.source.url) {
    e.waitUntil(checkForUpdate(new URL(e.source.url).pathname).catch(() => {}));
  }
});
async function checkForUpdate(path) {
  const cache = await caches.open(PAGE_CACHE);
  const key = new Request(path);
  const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok || res.type !== 'basic') return;
  const fresh = await res.clone().text();
  const saved = await cache.match(key);
  if (!saved || (await saved.text()) !== fresh) await cache.put(key, res);
  const shown = await cache.match(shownKey(path));
  if (shown && (await shown.text()) !== fresh) notifyUpdate();
}
