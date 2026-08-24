const CACHE = 'eileen-lifestyle-v35';
const FILES = ['./', './index.html', './styles.css', './zoho-migration.css', './exercise-catalog.js', './app.js', './zoho-migration.js', './manifest.webmanifest', './icon.svg', './icon-maskable.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon-32.png', './favicon.ico', './assets/eleen-training.jpg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))),
  self.clients.claim()
])));
self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(saved => saved || fetch(event.request))));
self.addEventListener('push', event => {
  let payload = { title: 'Eileen Lifestyle', body: 'Tienes un nuevo recordatorio.', url: './' };
  try { payload = { ...payload, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: './icon-192.png',
    badge: './favicon-32.png',
    data: { url: payload.url }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => 'focus' in client);
    if (existing) {
      if ('navigate' in existing) return existing.navigate(targetUrl).then(() => existing.focus());
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  }));
});
