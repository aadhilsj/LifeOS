// Cache version — update this timestamp on every deploy to bust old caches automatically
const CACHE_VERSION = 'kairo-__DEPLOY_TIME__';
const CACHE = `kairo-${Date.now()}`;

// Static assets that are safe to cache long-term (icons, manifest)
const STATIC_PRECACHE = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  // Skip waiting immediately — don't let old SW block the new one
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC_PRECACHE))
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Don't intercept cross-origin requests (Supabase, Google, fonts, CDN)
  if (url.origin !== location.origin) return;

  const isNavigation = e.request.mode === 'navigate' ||
    (e.request.headers.get('accept') || '').includes('text/html');

  // HTML/navigation: always network-first, fall back to cache only if offline
  // This means a fresh deploy is always picked up immediately
  if (isNavigation) {
    e.respondWith(networkFirstHTML(e.request));
    return;
  }

  // Static icons/manifest: cache-first (these rarely change)
  if (STATIC_PRECACHE.includes(url.pathname)) {
    e.respondWith(cacheFirst(e.request));
    return;
  }

  // Everything else: network-first with cache fallback
  e.respondWith(networkFirst(e.request));
});

// ── Strategies ────────────────────────────────────────────────────────────────

// Network-first for HTML — always tries network, caches result, falls back if offline
async function networkFirstHTML(request) {
  try {
    const response = await fetch('/index.html', {
      cache: 'no-store', // bypass browser HTTP cache too
    });
    if (response && response.ok) {
      const clone = response.clone();
      caches.open(CACHE).then(c => c.put('/index.html', clone));
    }
    return response;
  } catch {
    // Offline fallback
    const cached = await caches.match('/index.html') || await caches.match('/');
    if (cached) return cached;
    return new Response('<h2>Kairo is offline</h2><p>Connect to the internet to load the app.</p>', {
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

// Network-first for other assets
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const clone = response.clone();
      caches.open(CACHE).then(c => c.put(request, clone));
    }
    return response;
  } catch {
    return caches.match(request);
  }
}

// Cache-first for static assets
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const clone = response.clone();
      caches.open(CACHE).then(c => c.put(request, clone));
    }
    return response;
  } catch {
    return new Response('', { status: 404 });
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
// Allows the app to force a cache clear programmatically if ever needed
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});
