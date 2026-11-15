/* Haba Messenger service worker — caches the app shell, fonts and Firebase modules so the app opens offline.
   User data lives in the app's IndexedDB cache, not here. API calls (database, auth, storage) are never touched. */
const V = 'hm-shell-v1';
const HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(['./', './index.html']).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const u = new URL(req.url), same = u.origin === location.origin;
  const ok = same || (HOSTS.includes(u.hostname) && (u.hostname !== 'www.gstatic.com' || u.pathname.startsWith('/firebasejs/')));
  if (!ok) return;
  if (req.mode === 'navigate') {   // network first so updates arrive; cached shell when offline
    e.respondWith(fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(V).then(x => x.put('./index.html', c)); } return r; })
      .catch(() => caches.match('./index.html').then(r => r || caches.match('./') || Response.error())));
    return;
  }
  e.respondWith(caches.open(V).then(async c => {   // stale-while-revalidate
    const hit = await c.match(req);
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || Response.error();
  }));
});
