const CACHE = 'rz-v391';
const ASSETS = [
  './',
  'index.html',
  'js/app.js',
  'js/vendor/supabase.js',
  'manifest.json',
  'logo-mark.png',
  'pwa-logo-180.png',
  'pwa-logo-192.png',
  'pwa-logo-512.png',
  'fonts/playfair-cyrillic.woff2',
  'fonts/playfair-latin.woff2',
];

self.addEventListener('install', e => {
  // skipWaiting только после того как кэш собран.
  // Раньше: .catch(()=>{}) глушил ошибки → старый кэш удалялся → новый пустой → офлайн ломался.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(
        ASSETS.map(url =>
          c.add(url).catch(() => {}) // каждый файл отдельно — один 404 не ломает всё
        )
      ))
      .then(() => self.skipWaiting())
  );
});

// Все ассеты (включая supabase-js и шрифты) — локальные, живут в основном кэше.
// rz-fonts-v1 / rz-lib-v1 удалены: Google Fonts больше нет, библиотека вендорится.
const KEEP_CACHES = [CACHE];

self.addEventListener('activate', e => {
  // Не вызываем clients.claim() — он захватывает страницу посреди загрузки,
  // что ломает первый запуск PWA. Новый SW берёт управление при следующем запуске.
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !KEEP_CACHES.includes(k)).map(k => caches.delete(k)))
    )
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = e.request.url;

  // Кросс-доменные запросы (Supabase API и т.д.) — не перехватываем.
  // SW не должен мешать API-запросам возвращать их ошибки напрямую клиенту.
  if (!url.startsWith(self.location.origin)) return;

  // Только наши статичные ресурсы: cache-first, fallback → index.html для навигации
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => {
      if (e.request.mode === 'navigate') {
        return caches.match('./').then(home => home || caches.match('index.html'));
      }
      return new Response('', { status: 503 });
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
      // Используем содержимое как title — iOS сам показывает имя приложения
      const notifTitle = n.title || n.body?.slice(0, 80) || 'Напоминание';
      self.registration.showNotification(notifTitle, {
        body: '',
        icon: 'pwa-logo-192.png',
        badge: 'pwa-logo-192.png',
        tag: n.id || String(dt), // tag prevents duplicates
      });
    }, delay);
    scheduled.push(tid);
  });
});

// ── VAPID Web Push — серверный пуш (работает когда приложение закрыто) ──
self.addEventListener('push', e => {
  let data = { title: 'Напоминание', body: '' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:  data.body,
      icon:  'pwa-logo-192.png',
      badge: 'pwa-logo-192.png',
      tag:   data.tag || 'rz-push',
      renotify: false,
      data:  { url: './' },
    })
  );
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
