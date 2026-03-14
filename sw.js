// ============================================================
// sw.js — Notes AI Service Worker
// Strategy: Cache-first for app shell, network-first for API
// ============================================================

const CACHE_NAME = 'notesai-v3';
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// App shell files to cache on install
const SHELL_FILES = [
  '/',
  '/index.html',
  '/app.html',
  '/auth.html',
  '/app-modals.js',
  '/app-ai.js',
  '/app-offline.js',
  '/app-friends.js',
  '/manifest.json',
];

// ── Install: cache app shell ─────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache files individually — don't fail install if one is missing
      return Promise.allSettled(
        SHELL_FILES.map(url =>
          cache.add(url).catch(e => console.warn('SW cache miss:', url, e.message))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ───────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: smart routing ─────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ── Skip non-GET and non-same-origin ──────────────────────
  if (event.request.method !== 'GET') return;
  if (url.origin !== location.origin &&
      !url.hostname.includes('fonts.googleapis.com') &&
      !url.hostname.includes('fonts.gstatic.com') &&
      !url.hostname.includes('gstatic.com')) return;

  // ── API calls: network-only, no caching ───────────────────
  if (url.pathname.startsWith('/api/')) return;

  // ── Firebase SDK: cache with long TTL ────────────────────
  if (url.hostname.includes('gstatic.com') || url.hostname.includes('googleapis.com')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const res = await fetch(event.request);
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // ── App shell: network-first with cache fallback ──────────
  event.respondWith(
    fetch(event.request)
      .then(res => {
        // Cache successful responses
        if (res.ok && res.status < 400) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(async () => {
        // Network failed — serve from cache
        const cached = await caches.match(event.request);
        if (cached) return cached;

        // For navigation requests, serve app.html as fallback
        if (event.request.mode === 'navigate') {
          const appShell = await caches.match('/app.html');
          if (appShell) return appShell;
        }

        // Last resort 404
        return new Response('Offline — cached version unavailable', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      })
  );
});

// ── Background sync (if supported) ───────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-notes') {
    event.waitUntil(
      // Notify all clients to attempt sync
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SYNC_NOTES' }));
      })
    );
  }
});

// ── Message from client ───────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});