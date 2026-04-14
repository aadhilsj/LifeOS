self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', () => {
  console.log('Service Worker Activated');
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
