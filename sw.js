/* SpellCoco service worker — v62: turn notifications (Web Push).
   Deliberately NO fetch handler: the game stays fully network-served
   (GitHub Pages), this worker only exists so pushes can be shown. */
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
    for (const c of list) {
      if ('focus' in c) { if (c.navigate) c.navigate(url); return c.focus(); }
    }
    return clients.openWindow(url);
  }));
});
