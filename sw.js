const CACHE = 'eleen-lifestyle-v6';
const FILES = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon.svg', './assets/eleen-training.jpg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(saved => saved || fetch(event.request))));
