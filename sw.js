// Разберёмся — Service Worker v1.0
const CACHE = 'razberemsia-v1';
const ASSETS = [
  '/razberemsia/razberemsia_v03.html',
  '/razberemsia/manifest.json'
];

// ── Установка — кешируем основные файлы ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ── Активация — удаляем старый кеш ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Запросы — сначала сеть, при ошибке кеш ──
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ── Push-уведомления от сервера (будущее) ──
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'Разберёмся';
  const body  = data.body  || 'Новое напоминание';
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/razberemsia/icon-192.png',
      badge: '/razberemsia/icon-192.png',
      vibrate: [200, 100, 200],
      tag: data.tag || 'razberemsia',
      renotify: true,
      data: { url: data.url || '/razberemsia/razberemsia_v03.html' }
    })
  );
});

// ── Клик по уведомлению — открываем приложение ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/razberemsia/razberemsia_v03.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('razberemsia') && 'focus' in client)
          return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// ── Локальные уведомления (расписание из основного потока) ──
self.addEventListener('message', e => {
  if (e.data?.type === 'SCHEDULE') {
    const { notes } = e.data;
    scheduleNotifications(notes);
  }
});

function scheduleNotifications(notes) {
  notes.forEach(n => {
    if (!n.reminder) return;
    const delay = new Date(n.reminder) - Date.now();
    if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) {
      setTimeout(() => {
        self.registration.showNotification('Разберёмся', {
          body: n.title,
          icon: '/razberemsia/icon-192.png',
          vibrate: [200, 100, 200],
          tag: 'reminder-' + n.title,
          data: { url: '/razberemsia/razberemsia_v03.html?action=notes' }
        });
      }, delay);
    }
  });
}
