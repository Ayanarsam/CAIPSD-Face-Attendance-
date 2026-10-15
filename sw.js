/* CAIPSD Rollcall service worker: keeps the face models and engines on the device,
   so the app starts fast and still opens when the internet is down. */
const CACHE = 'rollcall-assets-v1';
const PAGE_CACHE = 'rollcall-page-v4';

// Versioned files that never change at the same URL: serve from the device first.
const ASSET_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com', 'fonts.gstatic.com'];

// On install, save the page and its app code together, so the app opens offline straight away.
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const page = new URL(self.registration.scope);
    const res = await fetch(page, { cache: 'no-store', credentials: 'same-origin' });
    if (res.ok && res.type === 'basic') await savePage(await caches.open(PAGE_CACHE), page, res);
  })().catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE, PAGE_CACHE]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The app's own files: the page and its code (app.js).
const isAppCode = (url) => url.origin === self.location.origin && /\.js$/.test(url.pathname) && !/\/sw\.js$/.test(url.pathname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // check-ins (POST) always go straight to the network
  const url = new URL(req.url);

  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    e.respondWith(savedFirst(e, url.pathname, true));
  } else if (isAppCode(url)) {
    e.respondWith(savedFirst(e, url.pathname + url.search, false));
  } else if (url.origin === self.location.origin && url.pathname.includes('/assets/')) {
    e.respondWith(deviceFirst(req, true));                  // office photos for the background check: saved, refreshed quietly
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

// The page and its code: open the saved copy instantly, fetch the newest version in the background,
// and tell the app when a newer version has arrived (it reloads itself when nobody is at the camera).
// The worker also remembers which version is on screen ("shown"), so an update is never missed.
async function savedFirst(e, path, isPage) {
  const cache = await caches.open(PAGE_CACHE);
  const key = new Request(path);
  const hit = await cache.match(key);
  const oldText = hit ? await hit.clone().text() : null;
  const net = fetch(e.request.url, { cache: 'no-store', credentials: 'same-origin' }).then(async res => {
    if (res.ok && res.type === 'basic') {
      const fresh = await res.clone().text();
      if (isPage) await savePage(cache, new URL(e.request.url), res.clone(), fresh).catch(() => {});
      else await cache.put(key, res.clone());
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

// Save a page only after the code it loads is saved too, so the device never holds a page without its code.
async function savePage(cache, pageUrl, res, text) {
  if (text === undefined) text = await res.clone().text();
  for (const m of text.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
    const u = new URL(m[1], pageUrl);
    if (!isAppCode(u)) continue;
    const k = new Request(u.pathname + u.search);
    if (await cache.match(k)) continue;
    const r = await fetch(u, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok || r.type !== 'basic') throw new Error('app code not saved: ' + u.pathname);
    await cache.put(k, r);
  }
  await cache.put(new Request(pageUrl.pathname), res);
  await pruneOldCode(cache);
}

// Keep only the 3 newest versions of the app code on the device (each update adds one).
async function pruneOldCode(cache) {
  const code = (await cache.keys()).filter(r => isAppCode(new URL(r.url)));
  for (const r of code.slice(0, Math.max(0, code.length - 3))) {
    const u = new URL(r.url);
    await cache.delete(r); await cache.delete(shownKey(u.pathname + u.search));
  }
}

const shownKey = (path) => new Request(path + '?shown');
const markShown = (cache, path, text) => cache.put(shownKey(path), new Response(text, { headers: { 'Content-Type': 'text/plain' } }));

async function notifyUpdate() {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'page-updated' });
}

// The office device stays open all day, so the app asks every 15 minutes: is there a newer version on GitHub?
// It sends the files on screen (the page and its code). If any differs from the newest copy, the newest is saved
// on the device and the app is told to reload (it does so when nobody is at the camera).
// If that message is missed, the next check sends it again.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'check-update' && e.source && e.source.url) {
    const files = Array.isArray(e.data.files) && e.data.files.length ? e.data.files : [new URL(e.source.url).pathname];
    e.waitUntil(checkForUpdate(files.filter(f => typeof f === 'string' && f.startsWith('/')).slice(0, 4)).catch(() => {}));
  }
});
async function checkForUpdate(files) {
  const cache = await caches.open(PAGE_CACHE);
  let changed = false;
  for (const path of files) {
    const url = new URL(path, self.location.origin);
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok || res.type !== 'basic') continue;
    const fresh = await res.clone().text();
    const key = new Request(path);
    const saved = await cache.match(key);
    if (!saved || (await saved.text()) !== fresh) {
      if (isAppCode(url)) await cache.put(key, res); else await savePage(cache, url, res, fresh);
    }
    const shown = await cache.match(shownKey(path));
    if (shown && (await shown.text()) !== fresh) changed = true;
  }
  if (changed) notifyUpdate();
}
