/* SpellCoco service worker — v62: turn notifications (Web Push). v68: safer click handling.
   v73: caching. Before this the worker had no fetch handler, so the 2 MB word
   list was downloaded on every launch and nothing worked offline.
   - dictionary.txt: stale-while-revalidate. The cached copy answers at once
     and a background request (usually a cheap 304) refreshes it for next time.
   - every other same-origin GET (the page, engine.js, custom_words.txt, icons):
     network first, so an online player always gets the current build; the
     cached copy is only used when the network fails (offline local/solo play).
   Cross-origin requests (the relay, PeerJS, Wiktionary) are never touched. */
const CACHE = 'spellcoco-rt-1';

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('spellcoco-') && k !== CACHE).map((k) => caches.delete(k))))
    .catch(() => {})
    .then(() => self.clients.claim())
));

// One entry per path: a navigation is stored without its query (?join=CODE),
// and a new engine.js?v=… replaces the previous build's copy.
function cacheKey(req) {
  const u = new URL(req.url);
  if (req.mode === 'navigate') u.search = '';
  u.hash = '';
  return u.href;
}
function keep(req, res) {
  if (!res || !res.ok || res.type !== 'basic') return Promise.resolve();
  const copy = res.clone(), key = cacheKey(req), path = new URL(key).pathname;
  return caches.open(CACHE).then((c) => c.put(key, copy)
    .then(() => c.keys())
    .then((reqs) => Promise.all(reqs.filter((r) => { const u = new URL(r.url); return u.pathname === path && r.url !== key; }).map((r) => c.delete(r)))))
    .catch(() => {});
}
function fromNetwork(req, e) {
  return fetch(req).then((res) => { e.waitUntil(keep(req, res)); return res; });
}
const cached = (req) => caches.match(cacheKey(req));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin || req.headers.has('range')) return;
  if (url.pathname.endsWith('/sw.js')) return;
  if (url.pathname.endsWith('/dictionary.txt')) {
    e.respondWith(cached(req).then((hit) => {
      const fresh = fromNetwork(req, e);
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh;
    }));
    return;
  }
  e.respondWith(fromNetwork(req, e).catch(() => cached(req).then((hit) => {
    if (hit || req.mode !== 'navigate') return hit;
    // Offline navigation to a path we never cached (…/index.html vs …/): the app shell.
    return caches.match(new URL('./', self.location.href).href).then((h) => h || caches.match(new URL('index.html', self.location.href).href));
  }).then((r) => r || Response.error())));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (err) { d = { body: e.data && e.data.text() }; }
  const title = d.title || 'SpellCoco 🐾';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || 'Your move!',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag || 'spellcoco-turn',
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    // v68: prefer a tab already on the game URL; only navigate a controlled
    // tab that is elsewhere, and never let a failed navigate() break the focus.
    let target = null;
    try { target = new URL(url, self.location.href).href; } catch (e) {}   // v69.1: a bad stored URL must not swallow the click
    const same = (target && list.find((c) => c.url === target)) || list[0];
    if (same && 'focus' in same) {
      if (target && same.url !== target && same.navigate) {
        return same.navigate(target).then((cl) => (cl || same).focus()).catch(() => same.focus());
      }
      return same.focus();
    }
    return clients.openWindow(target || './');
  }));
});
