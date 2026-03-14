// ============================================================
// app-offline.js — Offline queue + sync + status indicator
// Depends on: window._db, window._push, window._ref, window._update
//             showToast, renderApp (from app.html)
// ============================================================

const QUEUE_KEY = 'notesai_offline_queue';
const CACHE_KEY  = 'notesai_notes_cache';

// ── State ────────────────────────────────────────────────────
let _isOnline = navigator.onLine;
let _isSyncing = false;

// ── Queue helpers ────────────────────────────────────────────
function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch(e) { return []; }
}
function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
  catch(e) { console.warn('Queue save failed:', e.message); }
}
function enqueue(op) {
  const q = getQueue();
  q.push({ ...op, _qid: Date.now() + Math.random().toString(36).slice(2) });
  saveQueue(q);
  updateSyncBadge();
}
function dequeue(qid) {
  const q = getQueue().filter(op => op._qid !== qid);
  saveQueue(q);
  updateSyncBadge();
}

// ── Notes cache (for full offline read) ─────────────────────
function cacheNotes(notes) {
  try {
    // Only cache fields needed for display — skip imageData to save space
    const light = notes.map(n => ({
      fbKey: n.fbKey, id: n.id, title: n.title, category: n.category,
      summary: n.summary, keyPoints: n.keyPoints, organizedContent: n.organizedContent,
      rawNote: (n.rawNote||'').slice(0, 500),
      source: n.source, isPublic: n.isPublic, date: n.date, author: n.author,
      // Keep imageData only if small (<50KB base64 ~= 37.5KB)
      imageData: n.imageData && n.imageData.length < 65000 ? n.imageData : ''
    }));
    localStorage.setItem(CACHE_KEY, JSON.stringify(light));
  } catch(e) {
    // localStorage full — clear imageData and try again
    try {
      const minimal = notes.map(n => ({
        fbKey: n.fbKey, id: n.id, title: n.title, category: n.category,
        summary: n.summary, source: n.source, isPublic: n.isPublic,
        date: n.date, author: n.author, rawNote: '', imageData: ''
      }));
      localStorage.setItem(CACHE_KEY, JSON.stringify(minimal));
    } catch(e2) { console.warn('Notes cache failed:', e2.message); }
  }
}
function getCachedNotes() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); }
  catch(e) { return []; }
}

// ── UI helpers ───────────────────────────────────────────────
function showOfflineBar(on) {
  const bar = document.getElementById('offline-bar');
  if (!bar) return;
  if (on) bar.classList.add('show');
  else bar.classList.remove('show');
  // Push app nav down when bar is showing
  const nav = document.querySelector('.app-nav');
  if (nav) nav.style.marginTop = on ? '36px' : '';
}

function updateSyncBadge() {
  const badge = document.getElementById('sync-badge');
  const txt   = document.getElementById('sync-badge-txt');
  if (!badge || !txt) return;
  const q = getQueue();
  if (q.length === 0) {
    badge.classList.remove('show', 'syncing');
    return;
  }
  badge.classList.add('show');
  badge.classList.remove('syncing');
  txt.innerHTML = `${q.length} note${q.length > 1 ? 's' : ''} pending sync`;
}

function showSyncingBadge(count) {
  const badge = document.getElementById('sync-badge');
  const txt   = document.getElementById('sync-badge-txt');
  if (!badge || !txt) return;
  badge.classList.add('show', 'syncing');
  txt.innerHTML = `<span class="sync-spin">⟳</span> Syncing ${count}...`;
}

// ── Intercept saveNote for offline ──────────────────────────
// We wrap the original saveNote so offline writes go to queue
const _origSaveNote = window.saveNote;

window.saveNote = async function(p, source, rawNote) {
  if (_isOnline) {
    // Online — run normally, then cache result
    await _origSaveNote(p, source, rawNote);
    cacheNotes(window.allNotes || []);
    return;
  }

  // ── OFFLINE path ─────────────────────────────────────────
  function ensureStr(v) { if(v==null)return''; if(typeof v==='string')return v; if(typeof v==='object')return Object.entries(v).map(([k,vv])=>k+': '+vv).join('\n'); return String(v); }
  function ensureArr(v) { if(Array.isArray(v))return v.map(ensureStr).filter(Boolean); if(typeof v==='string'&&v)return[v]; return[]; }

  const note = {
    id: Date.now(),
    title: ensureStr(p.title) || 'Untitled',
    category: (ensureStr(p.category) || 'OTHER').toUpperCase().replace(/\s+/g,'_'),
    summary: ensureStr(p.summary),
    keyPoints: ensureArr(p.keyPoints),
    organizedContent: ensureStr(p.organizedContent),
    rawNote: rawNote || '',
    source,
    isPublic: (window.noteVisibility || 'public') === 'public',
    date: new Date().toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' }),
    author: window._currentUser?.displayName || window._currentUser?.email || 'Anonymous',
    imageData: source === 'img' ? (window._pendingImgB64 || '') : '',
    _offline: true // flag for UI
  };

  // Add to local allNotes immediately so UI updates
  if (!window.allNotes) window.allNotes = [];
  window.allNotes.unshift(note);
  renderApp();

  // Cache updated notes
  cacheNotes(window.allNotes);

  // Enqueue for sync
  enqueue({ type: 'push_note', note });

  showToast('📴 Saved offline — mag-sync pag may internet');
};

// ── Sync queue to Firebase ───────────────────────────────────
async function syncQueue() {
  if (_isSyncing) return;
  const q = getQueue();
  if (!q.length) return;
  if (!window._db || !window._push || !window._ref) return;

  _isSyncing = true;
  showSyncingBadge(q.length);

  let synced = 0;
  let failed = 0;

  for (const op of q) {
    try {
      if (op.type === 'push_note') {
        const { _qid, type, ...noteData } = op;
        const { _offline, ...cleanNote } = noteData.note;
        await window._push(window._ref(window._db, 'notes'), cleanNote);
        dequeue(op._qid);
        synced++;
      }
    } catch(e) {
      console.error('Sync failed for op:', op._qid, e.message);
      failed++;
    }
  }

  _isSyncing = false;

  if (synced > 0) {
    showToast(`✅ Synced ${synced} note${synced > 1 ? 's' : ''}!`);
    // Remove _offline flagged notes from allNotes — Firebase will re-add via onValue
    if (window.allNotes) {
      window.allNotes = window.allNotes.filter(n => !n._offline);
    }
  }
  if (failed > 0) {
    showToast(`⚠️ ${failed} note${failed > 1 ? 's' : ''} failed to sync — will retry`);
  }

  updateSyncBadge();
}

// ── Online / Offline event listeners ────────────────────────
window.addEventListener('online', async () => {
  _isOnline = true;
  showOfflineBar(false);
  showToast('🌐 Back online! Syncing...');

  // Reconnect Firebase
  if (typeof window._goOnline === 'function') window._goOnline();

  // Give Firebase a moment to reconnect before syncing
  setTimeout(syncQueue, 1500);
});

window.addEventListener('offline', () => {
  _isOnline = false;
  showOfflineBar(true);
  showToast('📴 Offline — notes mo ay mase-save locally');

  // Tell Firebase we're offline
  if (typeof window._goOffline === 'function') window._goOffline();
});

// ── Initial state check ──────────────────────────────────────
(function init() {
  if (!navigator.onLine) {
    _isOnline = false;
    showOfflineBar(true);

    // Load cached notes if Firebase hasn't loaded yet
    setTimeout(() => {
      if (!window.allNotes || window.allNotes.length === 0) {
        const cached = getCachedNotes();
        if (cached.length > 0) {
          window.allNotes = cached;
          if (typeof renderApp === 'function') renderApp();
          showToast(`📦 Showing ${cached.length} cached notes`);
        }
      }
    }, 1200);
  }

  updateSyncBadge();

  // Expose for other modules
  window._offlineEnqueue = enqueue;
  window._cacheNotes = cacheNotes;
  window._getCachedNotes = getCachedNotes;
  window._syncQueue = syncQueue;
})();

// ── Auto-cache when Firebase notes update ───────────────────
// Hook into the existing onValue — cache notes after every update
const _origRenderApp = window.renderApp;
if (typeof _origRenderApp === 'function') {
  window.renderApp = function() {
    _origRenderApp.apply(this, arguments);
    if (_isOnline && window.allNotes && window.allNotes.length > 0) {
      // Debounce cache writes
      clearTimeout(window._cacheDebouce);
      window._cacheDebouce = setTimeout(() => cacheNotes(window.allNotes), 2000);
    }
  };
}

// ── Retry sync periodically when online ─────────────────────
setInterval(() => {
  if (_isOnline && getQueue().length > 0) syncQueue();
}, 30000); // retry every 30s if there are pending items