const CACHE = 'kairo-v4';

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
];

// Install — cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// Activate — delete old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    const clone = response.clone();
    caches.open(CACHE).then(c => c.put(request, clone));
  }
  return response;
}

async function networkFirstPage() {
  try {
    const response = await fetch('/index.html', { cache: 'no-store' });
    if (response && response.ok) {
      const clone = response.clone();
      caches.open(CACHE).then(c => c.put('/index.html', clone));
    }
    return response;
  } catch (error) {
    return (await caches.match('/index.html')) || (await caches.match('/'));
  }
}

async function networkThenCache(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok && request.method === 'GET') {
      const clone = response.clone();
      caches.open(CACHE).then(c => c.put(request, clone));
    }
    return response;
  } catch (error) {
    return caches.match(request);
  }
}

// Fetch — fresh HTML shell, cached static assets
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  const accept = e.request.headers.get('accept') || '';
  const isNavigation = e.request.mode === 'navigate' || accept.includes('text/html');
  if (isNavigation) {
    e.respondWith(networkFirstPage());
    return;
  }

  const isCoreAsset = PRECACHE.includes(url.pathname);
  if (isCoreAsset) {
    e.respondWith(cacheFirst(e.request));
    return;
  }

  e.respondWith(networkThenCache(e.request));
});
