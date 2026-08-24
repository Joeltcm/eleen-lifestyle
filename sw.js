const CACHE = 'eileen-lifestyle-v25';
const FILES = ['./', './index.html', './styles.css', './zoho-migration.css', './exercise-catalog.js', './app.js', './zoho-migration.js', './manifest.webmanifest', './icon.svg', './icon-maskable.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon-32.png', './favicon.ico', './assets/eleen-training.jpg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(Promise.all([
  caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))),
  self.clients.claim()
])));
self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(saved => saved || fetch(event.request))));
