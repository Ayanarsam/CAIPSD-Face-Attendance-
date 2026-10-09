/* CAIPSD Rollcall service worker: keeps the face models and engines on the device,
   so the app starts fast and still opens when the internet is down. */
const CACHE = 'rollcall-assets-v1';
const PAGE_CACHE = 'rollcall-page-v3';
const PREFS = 'rollcall-prefs';                          // the name typed for attendance reminders

// Versioned files that never change at the same URL: serve from the device first.
const ASSET_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE, PAGE_CACHE, PREFS]);
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
    }
    return res;
  });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }   // instant open; the download only refreshes the saved copy
  return net;                                                  // first visit: nothing saved yet
}

async function notifyUpdate() {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'page-updated' });
}

// Attendance reminder: the reminder service sends an empty push at 9:30 on weekdays to people who haven't checked in.
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let name = '';
    try { const r = await (await caches.open(PREFS)).match('/remind-name'); if (r) name = (await r.text()).trim().split(' ')[0]; } catch (err) {}
    await self.registration.showNotification('CAIPSD Attendance', {
      body: (name ? name + ', you' : 'You') + " haven't marked your attendance today. Please check in.",
      icon: 'icon-192.png?v=3', badge: 'icon-192.png?v=3', tag: 'attendance-reminder', renotify: true
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const scope = self.registration.scope;
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) if (c.url.startsWith(scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(scope);
  })());
});
