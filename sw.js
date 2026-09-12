/* SpellCoco service worker — v62: turn notifications (Web Push). v68: safer click handling.
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
    // v68: prefer a tab already on the game URL; only navigate a controlled
    // tab that is elsewhere, and never let a failed navigate() break the focus.
    const target = new URL(url, self.location.href).href;
    const same = list.find((c) => c.url === target) || list[0];
    if (same && 'focus' in same) {
      if (same.url !== target && same.navigate) {
        return same.navigate(target).then((cl) => (cl || same).focus()).catch(() => same.focus());
      }
      return same.focus();
    }
    return clients.openWindow(url);
  }));
});
