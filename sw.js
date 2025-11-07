/*
  Service Worker for the face replacement demo.
  It caches the core assets during installation and serves
  them from cache on subsequent requests. This enables
  offline use once the page has been loaded once over HTTPS.
*/
const CACHE_NAME = 'face-demo-cache-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './main.js',
  './manifest.webmanifest',
  './assets/character_base.png',
  './assets/mask_oval.png',
  './assets/slot.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => key !== CACHE_NAME ? caches.delete(key) : null)
    ))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});