// Cache version — bump this string when you change fetch behavior or static assets
const CACHE_VERSION = 'kairo-v3';
const CACHE = CACHE_VERSION;

// Only cache truly static assets — never HTML
const STATIC_PRECACHE = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC_PRECACHE))
  );
  // Note: skipWaiting() is NOT called here — it only fires via the message
  // handler when the user explicitly clicks "Reload now" in the update banner.
  // Calling it here caused controllerchange → auto-reload → blank screen.
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

  // Don't intercept cross-origin requests
  if (url.origin !== location.origin) return;

  // API routes must always hit the network so redirects and JSON responses work.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  const isNavigation = e.request.mode === 'navigate' ||
    (e.request.headers.get('accept') || '').includes('text/html');

  // HTML: ALWAYS go to network, NEVER serve from cache, NEVER cache the response
  // This guarantees the browser always gets fresh HTML regardless of URL hash
  if (isNavigation) {
    e.respondWith(networkOnlyHTML());
    return;
  }

  // Static icons/manifest: cache-first
  if (STATIC_PRECACHE.includes(url.pathname)) {
    e.respondWith(cacheFirst(e.request));
    return;
  }

  // Everything else: network-first with cache fallback
  e.respondWith(networkFirst(e.request));
});

// ── Strategies ────────────────────────────────────────────────────────────────

// HTML is NEVER cached — always fetched fresh from network
async function networkOnlyHTML() {
  try {
    return await fetch('/index.html', { cache: 'no-store' });
  } catch {
    // Only fall back to cache if truly offline
    const cached = await caches.match('/index.html') || await caches.match('/');
    if (cached) return cached;
    return new Response('<h2>Kairo is offline</h2><p>Connect to the internet to load the app.</p>', {
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

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
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});
