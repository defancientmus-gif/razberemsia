const CACHE = 'rz-v91';
const ASSETS = [
  './',
  'index.html',
  'js/app.js',
  'manifest.json',
  'pwa-feather-180.png',
  'pwa-feather-192.png',
  'pwa-feather-512.png',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => {
      if (e.request.mode === 'navigate') {
        return caches.match('./').then(home => home || caches.match('index.html'));
      }
      return caches.match('index.html');
    }))
  );
});

// ── Уведомления через SW (один источник, без дублей) ──
// SW — единственный источник системных уведомлений.
// Страница (app.js) показывает только внутренний баннер, чтобы не было дублей.
let scheduled = [];

self.addEventListener('message', e => {
  if (e.data?.type !== 'SCHEDULE') return;
  scheduled.forEach(t => clearTimeout(t));
  scheduled = [];
  const notes = e.data.notes || [];
  const now = Date.now();
  notes.forEach(n => {
    if (!n.reminder) return;
    const dt = new Date(n.reminder).getTime();
    const delay = dt - now;
    if (delay <= 0 || delay > 7 * 24 * 3600 * 1000) return;
    const tid = setTimeout(() => {
      self.registration.showNotification('Разберёмся', {
        body: n.title || n.body?.slice(0, 80) || 'Напоминание',
        icon: 'pwa-feather-192.png',
        badge: 'pwa-feather-192.png',
        tag: n.id || String(dt), // tag prevents duplicates
      });
    }, delay);
    scheduled.push(tid);
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length) return clients[0].focus();
      return self.clients.openWindow('./');
    })
  );
});
