// sw.js — Notes AI v6
const CACHE = 'notesai-v9';

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
const NEVER_CACHE = [
  '/api/config',
  '/api/groq',
];

// ── INSTALL ───────────────────────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(
        SHELL.map(url => cache.add(url).catch(err =>
          console.warn('[SW] cache miss:', url, err.message)
        ))
      )
    )
  );
});

// ── ACTIVATE ──────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // ── Let these pass through untouched (no respondWith) ────
  // 1. Non-GET requests (POST, etc.)
  if (e.request.method !== 'GET') return;

  // Never cache these paths
  if (NEVER_CACHE.some(p => url.pathname.startsWith(p))) {
    e.respondWith(
      fetch(e.request, {cache:'no-store'}).catch(function(){
        return new Response(JSON.stringify({error:'offline'}),{
          status:503,
          headers:{'Content-Type':'application/json'}
        });
      })
    );
    return;
  }

  // 2. API calls — must go to network, never cache
  //    Return a proper network fetch so SW doesn't interfere
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request, {cache: 'no-store'}).catch(function(){
        return new Response(JSON.stringify({error:'offline'}),{
          status:503,
          headers:{'Content-Type':'application/json'}
        });
      })
    );
    return;
  }

  // 3. Firebase realtime DB connections (WebSocket / long-poll)
  if (url.hostname.includes('firebaseio.com')) return;

  // 4. Non-cacheable external origins
  const isCacheableExternal = (
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('gstatic.com')
  );
  if (url.origin !== self.location.origin && !isCacheableExternal) return;

  // ── Everything else: cache-first ─────────────────────────
  e.respondWith(cacheFirst(e.request));
});

// ── Cache-first with background update ───────────────────────
async function cacheFirst(req) {
  const cache  = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });

  // Background refresh
  const netFetch = fetch(req)
    .then(res => {
      if (res && res.ok && res.status < 400) {
        cache.put(req, res.clone());
      }
      return res;
    })
    .catch(() => null);

  // Serve cache immediately if available
  if (cached) return cached;

  // Wait for network if nothing cached
  try {
    const res = await netFetch;
    if (res) return res;
  } catch(e) {}

  // Offline fallback for page navigations
  if (req.mode === 'navigate') {
    const fallback = await cache.match('/app.html', { ignoreSearch: true });
    if (fallback) return fallback;
    // Serve inline offline page if even app.html isn't cached yet
    return offlinePage();
  }

  return new Response('', { status: 503 });
}

function offlinePage() {
  return new Response(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline — Notes AI</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#050810;color:#7a9ac7;font-family:sans-serif;
    display:flex;flex-direction:column;align-items:center;
    justify-content:center;min-height:100vh;text-align:center;padding:24px}
  h1{color:#ddeeff;font-size:24px;font-weight:900;margin:16px 0 10px}
  p{font-size:14px;line-height:1.7;max-width:280px;margin-bottom:24px}
  button{background:linear-gradient(135deg,#3b82f6,#1d4ed8);border:none;
    border-radius:12px;color:#fff;font-size:14px;font-weight:700;
    padding:12px 28px;cursor:pointer}
</style></head>
<body>
  <div style="font-size:52px">📴</div>
  <h1>You're Offline</h1>
  <p>Buksan muna ang app habang may internet para ma-enable ang offline mode.</p>
  <button onclick="location.reload()">🔄 Try Again</button>
</body></html>`,
  { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Messages ──────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('sync', e => {
  if (e.tag === 'sync-notes') {
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'SYNC_NOTES' }))
      )
    );
  }
});