// ============================================================
// app-offline.js  —  Offline-first Notes AI
//
// FLOW:
//  ONLINE  → process() → AI → Firebase  (normal)
//  OFFLINE → process() → save raw to queue → show in UI
//  BACK ONLINE → sync: AI-process each queued item → Firebase
//
// Lazy patching: all window.* wraps happen at DOMContentLoaded
// ============================================================

const QUEUE_KEY = 'notesai_queue_v2';
const CACHE_KEY = 'notesai_cache_v2';

let _online   = navigator.onLine;
let _syncing  = false;
let _patched  = false;

// ── Queue ─────────────────────────────────────────────────────
function getQueue()      { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]'); } catch(e) { return []; } }
function setQueue(q)     { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch(e) {} }
function addToQueue(item){ const q=getQueue(); q.push(item); setQueue(q); _badge(); }
function removeFromQueue(qid){ setQueue(getQueue().filter(i=>i.qid!==qid)); _badge(); }

// ── Notes cache ───────────────────────────────────────────────
function cacheNotes(notes) {
  try {
    const slim = (notes||[]).map(n=>({
      fbKey:n.fbKey||'', id:n.id, title:n.title, category:n.category,
      summary:n.summary, keyPoints:n.keyPoints, organizedContent:n.organizedContent,
      rawNote:(n.rawNote||'').slice(0,400), source:n.source,
      isPublic:n.isPublic, date:n.date, time:n.time||'', author:n.author,
      imageData:(n.imageData||'').length<60000?(n.imageData||''):'',
      _offline:n._offline||false
    }));
    localStorage.setItem(CACHE_KEY, JSON.stringify(slim));
    // Also cache AI memory
    if(window.aiMemory && Object.keys(window.aiMemory).length > 0){
      localStorage.setItem('notesai_memory_cache', JSON.stringify(window.aiMemory));
    }
    // Cache user info
    if(window._currentUser){
      localStorage.setItem('notesai_user_cache', JSON.stringify({
        uid: window._currentUser.uid,
        displayName: window._currentUser.displayName,
        email: window._currentUser.email,
      }));
    }
  } catch(e) {
    try {
      const min=(notes||[]).map(n=>({
        fbKey:n.fbKey||'',id:n.id,title:n.title,category:n.category,
        summary:n.summary,source:n.source,isPublic:n.isPublic,
        date:n.date,time:n.time||'',author:n.author,rawNote:'',imageData:''
      }));
      localStorage.setItem(CACHE_KEY, JSON.stringify(min));
    } catch(e2){}
  }
}
function getCached() { try { return JSON.parse(localStorage.getItem(CACHE_KEY)||'[]'); } catch(e){ return []; } }

// ── Offline bar ───────────────────────────────────────────────
function _bar(show) {
  let el = document.getElementById('_offbar');
  if (!el) {
    el = document.createElement('div');
    el.id = '_offbar';
    el.style.cssText = [
      'position:fixed;top:0;left:0;right:0;z-index:9999',
      'background:linear-gradient(90deg,#78350f,#92400e)',
      'border-bottom:1px solid rgba(251,191,36,0.3)',
      'display:flex;align-items:center;justify-content:center;gap:8px',
      'font-size:12px;font-weight:700;color:#fde68a',
      "font-family:'Outfit',sans-serif",
      'height:0;overflow:hidden;transition:height .3s ease,opacity .3s ease;opacity:0'
    ].join(';');
    el.innerHTML = `
      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <line x1="1" y1="1" x2="23" y2="23"/>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
        <line x1="12" y1="20" x2="12.01" y2="20"/>
      </svg>
      <span>📴 Offline — notes mo ay naka-queue, AI + sync pag may internet</span>`;
    document.body.insertBefore(el, document.body.firstChild);
  }
  if (show) {
    el.style.height = '34px'; el.style.opacity = '1';
    const nav = document.querySelector('.app-nav');
    if (nav) nav.style.marginTop = '34px';
  } else {
    el.style.height = '0'; el.style.opacity = '0';
    const nav = document.querySelector('.app-nav');
    if (nav) nav.style.marginTop = '';
  }
}

// ── Sync badge ────────────────────────────────────────────────
function _badge() {
  let el = document.getElementById('_syncbadge');
  const q = getQueue();

  if (q.length === 0) { if (el) el.remove(); return; }

  if (!el) {
    el = document.createElement('div');
    el.id = '_syncbadge';
    el.style.cssText = [
      'position:fixed;bottom:90px;right:24px;z-index:450',
      'border:none;border-radius:12px;padding:8px 14px',
      'color:#fef3c7;font-size:12px;font-weight:700',
      "font-family:'Outfit',sans-serif",
      'display:flex;align-items:center;gap:7px',
      'box-shadow:0 4px 20px rgba(0,0,0,0.4)',
      'cursor:default;transition:background .3s'
    ].join(';');
    document.body.appendChild(el);
  }

  const pending = q.filter(i => i.status !== 'syncing').length;
  const syncing = q.filter(i => i.status === 'syncing').length;

  if (syncing > 0) {
    el.style.background = 'linear-gradient(135deg,#2563eb,#1d4ed8)';
    el.style.color = '#dbeafe';
    el.innerHTML = `<span style="display:inline-block;animation:_spin 1s linear infinite">⟳</span> AI processing ${syncing}...`;
  } else {
    el.style.background = 'linear-gradient(135deg,#d97706,#b45309)';
    el.style.color = '#fef3c7';
    el.innerHTML = `
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
      </svg>
      ${pending} note${pending>1?'s':''} queued — waiting for AI`;
  }
}

// ── Add spin keyframe once ────────────────────────────────────
(function(){
  if (document.getElementById('_offstyle')) return;
  const s = document.createElement('style');
  s.id = '_offstyle';
  s.textContent = '@keyframes _spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
  document.head.appendChild(s);
})();

// ── Offline process: queue the raw input ─────────────────────
function _processOffline() {
  const textArea = document.getElementById('txtArea');
  const text = textArea ? textArea.value.trim() : '';
  const hasImg = !!window.b64;

  if (!text && !hasImg) {
    showToast('⚠️ Mag-sulat ng notes o mag-attach ng image!');
    return;
  }

  // Build queue item with everything needed for AI processing later
  const item = {
    qid: Date.now() + '_' + Math.random().toString(36).slice(2),
    status: 'pending',   // pending → syncing → done
    type: hasImg ? 'vision' : 'text',
    text: text,
    imgB64: hasImg ? window.b64 : null,
    visibility: window.noteVisibility || 'public',
    author: window._currentUser?.displayName || window._currentUser?.email || 'Anonymous',
    date: new Date().toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'}),
    savedAt: Date.now()
  };

  // Show immediately in UI as pending card
  const preview = {
    id: item.savedAt,
    title: text ? text.split('\n')[0].slice(0,60)||'Offline Note' : '📷 Image Note',
    category: 'PENDING',
    summary: text ? text.slice(0,100) : 'Image — waiting for AI to process',
    keyPoints: [],
    organizedContent: text,
    rawNote: text || '[image]',
    source: hasImg ? 'img' : 'text',
    isPublic: item.visibility === 'public',
    date: item.date,
    author: item.author,
    imageData: hasImg ? window.b64 : '',
    _offline: true,
    _qid: item.qid
  };

  if (!window.allNotes) window.allNotes = [];
  window.allNotes.unshift(preview);
  if (typeof renderApp === 'function') renderApp();
  cacheNotes(window.allNotes);

  addToQueue(item);

  // Clear composer
  if (textArea) { textArea.value=''; textArea.style.height=''; }
  if (typeof clearImg === 'function') clearImg();

  showToast('📴 Queued! AI mag-o-organize pag online na');
}

// ── Sync: AI-process each queued item → Firebase ─────────────
async function syncQueue() {
  if (_syncing) return;
  const q = getQueue();
  if (!q.length) return;
  if (!window._db || !window._push || !window._ref) {
    console.warn('Firebase not ready for sync');
    return;
  }

  _syncing = true;
  let synced = 0, failed = 0;

  for (const item of q) {
    if (item.status === 'done') { removeFromQueue(item.qid); continue; }

    // Mark as syncing in badge
    const qNow = getQueue();
    const idx = qNow.findIndex(i => i.qid === item.qid);
    if (idx !== -1) { qNow[idx].status = 'syncing'; setQueue(qNow); _badge(); }

    try {
      let parsed;

      // ── Step 1: AI process ───────────────────────────────
      if (item.type === 'vision' && item.imgB64) {
        const textBlock = item.text
          ? `${buildSysPrompt()}\n\nBasahin at i-organize. May text context:\n\n${item.text}`
          : `${buildSysPrompt()}\n\nBasahin at i-organize ang notes sa image. PURE JSON only.`;

        const res = await fetch(GROQ_URL, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            model:'meta-llama/llama-4-scout-17b-16e-instruct',
            max_tokens:1800,
            messages:[{role:'user',content:[
              {type:'text',text:textBlock},
              {type:'image_url',image_url:{url:`data:image/jpeg;base64,${item.imgB64}`}}
            ]}]
          })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || 'Vision API error');
        parsed = _parseAI(data.choices?.[0]?.message?.content);

      } else {
        const res = await fetch(GROQ_URL, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            model:'llama-3.3-70b-versatile', max_tokens:1800,
            messages:[
              {role:'system', content:buildSysPrompt()},
              {role:'user', content:'I-organize ang notes na ito:\n\n'+item.text}
            ]
          })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || 'Text API error');
        parsed = _parseAI(data.choices?.[0]?.message?.content);
      }

      // ── Step 2: Build note object ────────────────────────
      const es = v => v==null?'':typeof v==='string'?v:Array.isArray(v)?v.join('\n'):String(v);
      const ea = v => Array.isArray(v)?v.map(es).filter(Boolean):typeof v==='string'&&v?[v]:[];

      const note = {
        id: item.savedAt || Date.now(),
        title: es(parsed.title) || 'Untitled',
        category: (es(parsed.category)||'OTHER').toUpperCase().replace(/\s+/g,'_'),
        summary: es(parsed.summary),
        keyPoints: ea(parsed.keyPoints),
        organizedContent: es(parsed.organizedContent),
        rawNote: item.text || '[image]',
        source: item.type === 'vision' ? 'img' : 'text',
        isPublic: item.visibility === 'public',
        date: item.date,
        author: item.author,
        imageData: item.type === 'vision' ? (item.imgB64||'') : ''
      };

      // ── Step 3: Push to Firebase ─────────────────────────
      await window._push(window._ref(window._db,'notes'), note);

      // Update AI memory
      if (typeof updateAIMemory === 'function') await updateAIMemory(note);

      // Remove from queue
      removeFromQueue(item.qid);

      // Remove preview card from allNotes (Firebase onValue will add the real one)
      if (window.allNotes) {
        window.allNotes = window.allNotes.filter(n => n._qid !== item.qid);
      }

      synced++;

    } catch(e) {
      console.error('Sync failed for', item.qid, ':', e.message);
      // Mark as pending again
      const qNow = getQueue();
      const idx = qNow.findIndex(i => i.qid === item.qid);
      if (idx !== -1) { qNow[idx].status = 'pending'; setQueue(qNow); }
      failed++;
    }
  }

  _syncing = false;

  if (typeof renderApp === 'function') renderApp();
  cacheNotes(window.allNotes || []);
  _badge();

  if (synced > 0) showToast(`✅ ${synced} note${synced>1?'s':''} na-organize at na-sync!`);
  if (failed > 0) showToast(`⚠️ ${failed} failed — mag-re-retry sa 30s`);
}

// ── AI response parser ────────────────────────────────────────
function _parseAI(content) {
  if (!content) throw new Error('Empty AI response');
  let raw = content.replace(/```json|```/g,'').trim();
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s !== -1 && e !== -1) raw = raw.slice(s, e+1);
  return JSON.parse(raw);
}

// ── Patch process() ───────────────────────────────────────────
function _patchProcess() {
  if (window._processPatched || !window.process) return;
  window._processPatched = true;
  const orig = window.process;
  window.process = async function() {
    if (!_online) {
      _processOffline();
      return;
    }
    return orig.apply(this, arguments);
  };
}

// ── Patch renderApp to auto-cache ────────────────────────────
function _patchRender() {
  if (window._renderPatched || !window.renderApp) return;
  window._renderPatched = true;
  const orig = window.renderApp;
  window.renderApp = function() {
    orig.apply(this, arguments);
    if (_online && window.allNotes?.length > 0) {
      clearTimeout(window._cacheDebounce);
      window._cacheDebounce = setTimeout(() => cacheNotes(window.allNotes), 2000);
    }
  };
}

// Add PENDING category styling
function _addPendingCat() {
  if (document.getElementById('_pendingcatstyle')) return;
  const s = document.createElement('style');
  s.id = '_pendingcatstyle';
  s.textContent = `
    .cPENDING{background:rgba(217,119,6,0.12);color:#fbbf24}
    .anc._offline-card{border:1px dashed rgba(251,191,36,0.35)!important}
    .anc._offline-card .nc-stripe{background:linear-gradient(90deg,#d97706,#fbbf24)!important}
    .offline-pill{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;
      font-family:'JetBrains Mono',monospace;background:rgba(217,119,6,0.12);color:#fbbf24;
      border:1px solid rgba(251,191,36,0.25);padding:2px 7px;border-radius:5px;
      animation:_pulse 1.5s ease-in-out infinite}
    @keyframes _pulse{0%,100%{opacity:1}50%{opacity:0.5}}
  `;
  document.head.appendChild(s);
}

// ── Online / offline events ───────────────────────────────────
window.addEventListener('online', () => {
  _online = true;
  _bar(false);
  showToast('🌐 Online na! AI processing queued notes...');
  if (typeof window._goOnline === 'function') window._goOnline();
  setTimeout(syncQueue, 1500);
});

window.addEventListener('offline', () => {
  _online = false;
  _bar(true);
  showToast('📴 Offline — mag-save pa rin, AI later');
  if (typeof window._goOffline === 'function') window._goOffline();
});

// ── Init on DOM ready ─────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  _addPendingCat();
  _patchProcess();
  _patchRender();
  _badge();

  if (!_online) {
    _bar(true);
    setTimeout(() => {
      if (!window.allNotes || window.allNotes.length === 0) {
        const cached = getCached();
        if (cached.length > 0) {
          window.allNotes = cached;
          if (typeof renderApp === 'function') renderApp();
          showToast(`📦 ${cached.length} cached notes loaded`);
        } else {
          showToast('📴 Offline — walang cached notes pa');
        }
      }
      // Restore AI memory from cache if empty
      if(!window.aiMemory || Object.keys(window.aiMemory).length === 0){
        try{
          var memCache = localStorage.getItem('notesai_memory_cache');
          if(memCache){
            window.aiMemory = JSON.parse(memCache);
            if(typeof updateMemoryBadge === 'function') updateMemoryBadge();
          }
        }catch(e){}
      }
    }, 1500);
  } else {
    // Online — cache notes after load
    setTimeout(function(){
      if(window.allNotes && window.allNotes.length > 0){
        cacheNotes(window.allNotes);
      }
    }, 3000);
  }
});

window.addEventListener('load', () => {
  _patchProcess();
  _patchRender();
});

// ── Retry every 30s ──────────────────────────────────────────
setInterval(() => {
  if (_online && getQueue().length > 0 && !_syncing) syncQueue();
}, 30000);

// ── Expose ───────────────────────────────────────────────────
window._syncQueue  = syncQueue;
window._cacheNotes = cacheNotes;
window._isOffline  = () => !_online;