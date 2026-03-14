// ============================================================
// sw.js — Notes AI Service Worker v5
// Bulletproof offline: cache-first, ignores query strings,
// serves app.html for ALL navigation requests when offline
// ============================================================

const CACHE = 'notesai-v5';

const SHELL = [
  '/app.html',
  '/index.html',
  '/auth.html',
  '/app-modals.js',
  '/app-ai.js',
  '/app-offline.js',
  '/app-friends.js',
  '/manifest.json',
];

// ── INSTALL ───────────────────────────────────────────────────
self.addEventListener('install', e => {
  console.log('[SW v5] Installing...');
  self.skipWaiting(); // activate immediately, don't wait for old SW to die

  e.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(
        SHELL.map(url =>
          cache.add(url).catch(err =>
            console.warn('[SW] Failed to cache:', url, err.message)
          )
        )
      )
    )
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────
self.addEventListener('activate', e => {
  console.log('[SW v5] Activating...');
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => {
        console.log('[SW v5] Now controlling all clients');
        return self.clients.claim(); // take control of ALL open tabs immediately
      })
  );
});

// ── FETCH ─────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Skip non-GET
  if (req.method !== 'GET') return;

  // Skip API calls entirely — let them fail naturally offline
  // app-offline.js handles the offline UX for these
  if (url.pathname.startsWith('/api/')) return;

  // ── External resources (Firebase SDK, Fonts) ─────────────
  if (url.origin !== self.location.origin) {
    // Only cache known CDNs
    const isCacheable = (
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')
    );
    if (isCacheable) {
      e.respondWith(cacheFirst(req));
    }
    // Everything else external: skip (let browser handle)
    return;
  }

  // ── Same-origin: ALL requests use cache-first ─────────────
  e.respondWith(handleSameOrigin(req));
});

// ── Same-origin handler ───────────────────────────────────────
async function handleSameOrigin(req) {
  const cache = await caches.open(CACHE);

  // Try cache first — ignore query strings for matching
  const cached = await cache.match(req, { ignoreSearch: true });

  if (cached) {
    // Update cache in background (stale-while-revalidate)
    fetchAndCache(req, cache);
    return cached;
  }

  // Nothing in cache — try network
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    // Network failed and nothing in cache
    // For page navigations, serve app.html as fallback
    if (req.mode === 'navigate') {
      const fallback = await cache.match('/app.html', { ignoreSearch: true });
      if (fallback) {
        console.log('[SW] Offline navigation — serving cached app.html');
        return fallback;
      }
    }

    // Return offline page
    return new Response(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Offline — Notes AI</title>
        <style>
          body{margin:0;background:#050810;color:#7a9ac7;font-family:'Outfit',sans-serif;
            display:flex;flex-direction:column;align-items:center;justify-content:center;
            min-height:100vh;text-align:center;padding:20px}
          h1{color:#ddeeff;font-size:28px;font-weight:900;margin-bottom:12px}
          p{font-size:14px;line-height:1.7;max-width:300px;margin-bottom:24px}
          button{background:linear-gradient(135deg,#3b82f6,#1d4ed8);border:none;
            border-radius:12px;color:#fff;font-size:14px;font-weight:700;
            padding:12px 28px;cursor:pointer;font-family:'Outfit',sans-serif}
        </style>
      </head>
      <body>
        <div style="font-size:48px;margin-bottom:16px">📴</div>
        <h1>You're Offline</h1>
        <p>Open the app while connected to the internet first para ma-enable ang offline mode.</p>
        <button onclick="location.reload()">Try Again</button>
      </body>
      </html>
    `, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

// ── Cache-first for external CDN resources ────────────────────
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch(e) {
    return new Response('', { status: 503 });
  }
}

// ── Background cache update (non-blocking) ────────────────────
function fetchAndCache(req, cache) {
  fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
  }).catch(() => {}); // silent fail — we already served from cache
}

// ── Messages ──────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'CLEAR_CACHE') {
    caches.delete(CACHE).then(() => console.log('[SW] Cache cleared'));
  }
});

// ── Background sync ───────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sync-notes') {
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'SYNC_NOTES' }))
      )
    );
  }
});