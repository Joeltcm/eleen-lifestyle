const VERSION = '102';
const CACHE = `eileen-lifestyle-v${VERSION}`;
// Las URLs versionadas se arman con VERSION. Estuvieron fijas en ?v=47 mientras
// VERSION seguía subiendo, así que la precarga guardaba direcciones que la
// página ya no pedía: descargaba de más y no le servía a nadie.
const VERSIONED = ['./styles.css', './zoho-migration.css', './exercise-catalog.js', './video-compressor.js', './app.js', './zoho-migration.js', './recurring-billing.js'].map(file => `${file}?v=${VERSION}`);
const FILES = ['./index.html', ...VERSIONED, './manifest.webmanifest', './icon.svg', './icon-maskable.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon-32.png', './favicon.ico', './assets/eleen-training.jpg'];

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await Promise.all(FILES.map(async file => {
    const response = await fetch(file, { cache: 'reload' });
    if (!response.ok) throw new Error(`No se pudo guardar ${file}`);
    await cache.put(file, response);
  }));
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage({ type: 'EILEEN_UPDATE_READY', version: VERSION }));
})()));

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

const networkFirst = async request => {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE);
      await cache.put(request, copy);
    }
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match('./index.html'));
  }
};

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/version.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put('./index.html', response.clone());
        }
        return response;
      } catch {
        return caches.match('./index.html');
      }
    })());
    return;
  }

  if (['document', 'script', 'style'].includes(event.request.destination)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(caches.match(event.request).then(saved => saved || fetch(event.request)));
});
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
