// ============================================================
// sw.js — Notes AI Service Worker  v4
// Strategy: CACHE-FIRST for app shell (works fully offline)
//           NETWORK-ONLY for /api/ calls
//           CACHE-FIRST for external fonts/SDK
// ============================================================

const CACHE = 'notesai-v4';

// Everything the app needs to run offline
const SHELL = [
  '/app.html',
  '/app-modals.js',
  '/app-ai.js',
  '/app-offline.js',
  '/app-friends.js',
  '/manifest.json',
  // Google Fonts — cache at runtime on first visit
];

// ── INSTALL: pre-cache app shell ─────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      // addAll fails if ANY file 404s — use individual add with catch
      Promise.allSettled(
        SHELL.map(url => cache.add(url).catch(err =>
          console.warn('[SW] cache miss on install:', url, err.message)
        ))
      )
    ).then(() => {
      console.log('[SW] Shell cached, skipping wait');
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE: wipe old caches ─────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Only handle GET
  if (req.method !== 'GET') return;

  // ── /api/* — NEVER cache, always network ─────────────────
  if (url.pathname.startsWith('/api/')) return; // let browser handle (will fail offline — that's ok)

  // ── Firebase / Groq SDK JS — cache-first ─────────────────
  if (
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseapp.com')
  ) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // ── Google Fonts CSS — cache-first ───────────────────────
  if (url.hostname === 'fonts.googleapis.com') {
    e.respondWith(cacheFirst(req));
    return;
  }

  // ── Non-same-origin: skip ────────────────────────────────
  if (url.origin !== self.location.origin) return;

  // ── App shell files — CACHE-FIRST ────────────────────────
  // This is the key: serve from cache immediately, update in background
  e.respondWith(cacheFirstWithUpdate(req));
});

// ── Cache-first (pure) ────────────────────────────────────────
// Return cache if exists, else fetch+cache, else error
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch(e) {
    return new Response('Offline', { status: 503, headers: {'Content-Type':'text/plain'} });
  }
}

// ── Cache-first + background update (stale-while-revalidate) ──
// 1. Serve from cache immediately (fast + works offline)
// 2. Fetch new version in background and update cache
async function cacheFirstWithUpdate(req) {
  const cache  = await caches.open(CACHE);
  const cached = await cache.match(req);

  // Kick off background fetch regardless
  const fetchPromise = fetch(req).then(res => {
    if (res.ok && res.status < 400) {
      cache.put(req, res.clone());
    }
    return res;
  }).catch(() => null); // silently fail if offline

  // Return cache immediately if we have it
  if (cached) return cached;

  // No cache yet — wait for network
  try {
    const res = await fetchPromise;
    if (res) return res;
  } catch(e) {}

  // Both cache and network failed — serve app.html for navigation
  if (req.mode === 'navigate') {
    const fallback = await cache.match('/app.html');
    if (fallback) return fallback;
  }

  return new Response('Offline — open the app while online first to enable offline access.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' }
  });
}

// ── Background sync trigger ───────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sync-notes') {
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'SYNC_NOTES' }))
      )
    );
  }
});

// ── Message handler ───────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  // Client can force cache refresh
  if (e.data?.type === 'CLEAR_CACHE') {
    caches.delete(CACHE).then(() => console.log('[SW] Cache cleared'));
  }
});