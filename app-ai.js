// ============================================================
// app-ai.js — AI Instructor FAB + Chat Panel
// ============================================================

const AI_CHAT_HISTORY = [];
let aiChatOpen = false;
let _pendingAction = null;

// ── Build live system prompt with REAL fbKeys + memory ───────
function buildAIInstructorPrompt() {
  const myNotes = (window.allNotes || []).filter(n => isMyNote(n));
  const notesBlock = myNotes.length
    ? myNotes.map((n, i) => {
        const t = String(n.title||'').replace(/"/g,"'").slice(0,60);
        const r = String(n.rawNote||'').replace(/\n/g,' ').replace(/"/g,"'").slice(0,100);
        return '[' + i + '] fbKey="' + n.fbKey + '" | title="' + t + '" | cat="' + n.category + '" | public=' + (n.isPublic===true) + (r?' | raw="'+r+'"':'') + (n.imageData?' | hasImage=true':'');
      }).join('\n')
    : '(wala pang notes)';

  const memEntries = Object.entries(aiMemory || {});
  const memBlock = memEntries.length
    ? memEntries.map(([k,v]) => {
        const s = String(v.summary||'').slice(0,80).replace(/"/g,"'");
        const rule = v.categoryRule ? ' | RULE: "' + v.categoryRule + '"' : '';
        return 'key="' + k + '" | title="' + (v.title||'') + '" | cat="' + (v.category||'') + '" | summary="' + s + '"' + rule;
      }).join('\n')
    : '(walang memory entries)';

  return 'Ikaw ay ang AI Instructor ng Notes AI app. INSTRUCTOR MODE KA LANG.\n\n' +
'PINAKA-IMPORTANTENG RULE: Ang fbKey sa ACTION JSON ay DAPAT KOPYA NANG EKSAKTO mula sa listahan ng notes sa ibaba. Huwag mag-imbento ng fbKey.\n\n' +
'RULES:\n' +
'1. LAGING magtanong o mag-confirm bago gumawa ng kahit anong action sa notes.\n' +
'2. Bago mag-fix ng notes, ipakita kung ano-ano ang maaapektuhan, tanungin ang user.\n' +
'3. Kung mali ang category, itanong kung anong tama - huwag mag-assume.\n' +
'4. Para sa category rules: i-save sa memory para hindi na maulit ang pagkakamali.\n' +
'5. Maikli at malinaw ang sagot. Filipino/English. Max 6 sentences.\n' +
'6. Para sa actions, gamitin ang [ACTION]{...}[/ACTION] tag sa DULO ng message.\n\n' +
'ACTION FORMATS (gamitin EXACT fbKey/key mula sa listahan):\n' +
'fix_note:      {"type":"fix_note","fbKey":"EXACT","updates":{"category":"NEW_CAT"},"reOrganize":true}\n' +
'bulk_fix:      {"type":"bulk_fix","targets":[{"fbKey":"EXACT","updates":{"category":"CAT"}}...],"reason":"...","reOrganize":true}\n' +
'add_memory:    {"type":"add_memory","data":{"key":"unique_key","title":"...","category":"CAT","summary":"...","categoryRule":"..."}}\n' +
'update_memory: {"type":"update_memory","data":{"key":"EXACT_MEMORY_KEY","title":"...","category":"...","categoryRule":"..."}}\n' +
'remove_memory: {"type":"remove_memory","data":{"key":"EXACT_MEMORY_KEY"}}\n' +
'clear_all_memory: {"type":"clear_all_memory"}\n\n' +
'- fix_note / bulk_fix: ilagay "DAPAT I-CONFIRM:" bago ang [ACTION] tag.\n' +
'- memory-only actions: pwede direkta ang [ACTION] - walang confirm needed.\n' +
'- reOrganize:true = PALAGI para sa category fixes.\n\n' +
'======================================\n' +
'USER NOTES (' + myNotes.length + ') - EXACT fbKey DITO:\n' +
'======================================\n' +
notesBlock + '\n\n' +
'======================================\n' +
'AI MEMORY (' + memEntries.length + ') - EXACT key DITO:\n' +
'======================================\n' +
memBlock;
}

// ── Execute action ────────────────────────────────────────────
async function executeAIAction(actionObj) {
  var type = actionObj.type;

  if (type === 'fix_note') {
    var fbKey = actionObj.fbKey, updates = actionObj.updates, reOrganize = actionObj.reOrganize;
    if (!fbKey || !updates) return 'Missing fbKey or updates.';
    var n = window.allNotes.find(function(x){ return x.fbKey === fbKey; });
    if (!n) return 'Note not found (fbKey: ' + fbKey + ')';
    if (!isMyNote(n)) return 'Hindi mo to note: "' + n.title + '"';
    if (updates.category) updates.category = updates.category.toUpperCase().replace(/\s+/g,'_');

    var finalUpdates = Object.assign({}, updates);
    if (reOrganize !== false && (n.rawNote || n.organizedContent)) {
      try {
        var hint = updates.category ? '\n\nIMPORTANT: Tamang category ay "' + updates.category + '". Gamitin ito.' : '';
        var content = n.rawNote && n.rawNote !== '[image]' ? n.rawNote : n.organizedContent || n.title;
        var res = await fetch(GROQ_URL, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:1800, messages:[
            {role:'system', content: buildSysPrompt() + hint},
            {role:'user', content:'I-re-organize:\n\n' + content}
          ]})
        });
        var data = await res.json();
        if (!data.error) {
          var raw = (data.choices[0].message.content||'').replace(/```json|```/g,'').trim();
          var si=raw.indexOf('{'), ei=raw.lastIndexOf('}');
          var p = JSON.parse(si!==-1&&ei!==-1 ? raw.slice(si,ei+1) : raw);
          function es(v){return v==null?'':typeof v==='string'?v:Array.isArray(v)?v.join('\n'):String(v);}
          function ea(v){return Array.isArray(v)?v.map(es).filter(Boolean):typeof v==='string'&&v?[v]:[];}
          finalUpdates = {
            title: updates.title || es(p.title) || n.title,
            category: updates.category || es(p.category).toUpperCase().replace(/\s+/g,'_') || n.category,
            summary: es(p.summary), keyPoints: ea(p.keyPoints), organizedContent: es(p.organizedContent)
          };
          if (updates.isPublic !== undefined) finalUpdates.isPublic = updates.isPublic;
        }
      } catch(re) { console.warn('Re-org failed:', re.message); }
    }
    try {
      if (window._db && window._update && window._ref) {
        await window._update(window._ref(window._db, 'notes/' + fbKey), finalUpdates);
        await updateAIMemory(Object.assign({}, n, finalUpdates));
      } else { Object.assign(n, finalUpdates); renderApp(); }
      return 'Fixed & re-organized: "' + n.title + '"';
    } catch(e) { return 'Fix failed: ' + e.message; }
  }

  if (type === 'bulk_fix') {
    var targets = actionObj.targets, reason = actionObj.reason, reOrg = actionObj.reOrganize;
    if (!targets || !targets.length) return 'Walang targets.';
    var results = [];
    for (var ti = 0; ti < targets.length; ti++) {
      var tgt = targets[ti];
      var tfbKey = tgt.fbKey, tupdates = tgt.updates;
      var tn = window.allNotes.find(function(x){ return x.fbKey === tfbKey; });
      if (!tn || !isMyNote(tn)) { results.push('Skip "' + tfbKey + '"'); continue; }
      if (tupdates.category) tupdates.category = tupdates.category.toUpperCase().replace(/\s+/g,'_');
      var tFinal = Object.assign({}, tupdates);
      if (reOrg !== false && tupdates.category && (tn.rawNote || tn.organizedContent)) {
        try {
          var tc = tn.rawNote && tn.rawNote !== '[image]' ? tn.rawNote : tn.organizedContent || tn.title;
          var th = '\n\nIMPORTANT: Tamang category ay "' + tupdates.category + '". Gamitin ito.';
          var tres = await fetch(GROQ_URL, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:1800, messages:[
              {role:'system', content: buildSysPrompt() + th},
              {role:'user', content:'I-re-organize:\n\n' + tc}
            ]})
          });
          var tdata = await tres.json();
          if (!tdata.error) {
            var traw = (tdata.choices[0].message.content||'').replace(/```json|```/g,'').trim();
            var tsi=traw.indexOf('{'), tei=traw.lastIndexOf('}');
            var tp = JSON.parse(tsi!==-1&&tei!==-1 ? traw.slice(tsi,tei+1) : traw);
            function tes(v){return v==null?'':typeof v==='string'?v:Array.isArray(v)?v.join('\n'):String(v);}
            function tea(v){return Array.isArray(v)?v.map(tes).filter(Boolean):typeof v==='string'&&v?[v]:[];}
            tFinal = { category:tupdates.category, title:tupdates.title||tes(tp.title)||tn.title,
              summary:tes(tp.summary), keyPoints:tea(tp.keyPoints), organizedContent:tes(tp.organizedContent) };
          }
        } catch(re2) { console.warn('Bulk re-org fail:', tn.title, re2.message); }
      }
      try {
        if (window._db && window._update && window._ref) {
          await window._update(window._ref(window._db, 'notes/' + tfbKey), tFinal);
          await updateAIMemory(Object.assign({}, tn, tFinal));
        } else { Object.assign(tn, tFinal); }
        results.push('"' + tn.title + '" -> [' + tFinal.category + ']');
      } catch(e2) { results.push('"' + tn.title + '": ' + e2.message); }
    }
    renderApp();
    return 'Bulk fix tapos! (' + results.length + ' notes)\n' + results.join('\n') + (reason ? '\n\nReason: ' + reason : '');
  }

  if (type === 'add_memory' || type === 'update_memory') {
    var d = actionObj.data || {};
    if (!d.key && !d.title) return 'Need key or title.';
    var mk = (d.key||(d.category+'_'+d.title)).toLowerCase().replace(/[^a-z0-9]/g,'_').substring(0,60);
    var entry = { title:d.title||d.key, category:d.category||'OTHER', summary:d.summary||'',
      keyPoints:d.keyPoints||[], updated:Date.now() };
    if (d.categoryRule) entry.categoryRule = d.categoryRule;
    try {
      if (window._db && window._update && window._ref) await window._update(window._ref(window._db,'ai_memory'),{[mk]:entry});
      aiMemory[mk] = entry; updateMemoryBadge();
      return 'Memory ' + (type==='add_memory'?'added':'updated') + ': "' + (d.title||d.key) + '"' + (d.categoryRule ? '\nRule: "' + d.categoryRule + '"' : '');
    } catch(e) { return 'Memory save failed: ' + e.message; }
  }

  if (type === 'remove_memory') {
    var rk = actionObj.data && actionObj.data.key;
    var rmatch = Object.keys(aiMemory).find(function(mk2){ return mk2===rk || aiMemory[mk2].title===rk; });
    if (!rmatch) return 'Not found: "' + rk + '"';
    try {
      if (window._db && window._update && window._ref) await window._update(window._ref(window._db,'ai_memory'),{[rmatch]:null});
      delete aiMemory[rmatch]; updateMemoryBadge();
      return 'Removed: "' + rk + '"';
    } catch(e) { return 'Failed: ' + e.message; }
  }

  if (type === 'clear_all_memory') {
    try {
      if (window._db && window._update && window._ref) {
        var nulls = {};
        Object.keys(aiMemory).forEach(function(k){ nulls[k]=null; });
        if (Object.keys(nulls).length) await window._update(window._ref(window._db,'ai_memory'),nulls);
      }
      aiMemory = {}; updateMemoryBadge();
      return 'AI memory cleared.';
    } catch(e) { return 'Failed: ' + e.message; }
  }

  return 'Unknown type: ' + type;
}

// ── Main send ─────────────────────────────────────────────────
async function sendAIChat() {
  var input = document.getElementById('ai-chat-input');
  var msg = input && input.value && input.value.trim();
  if (!msg) return;
  input.value = ''; input.style.height = '';
  appendChatMsg('user', msg);

  if (_pendingAction) {
    var lower = msg.toLowerCase();
    var yes = /^(oo|yes|yep|confirm|go|sige|ok|tara|push|1\b|paki|gawin|proceed|ayan|yup|sure)/i.test(lower);
    var no  = /^(hindi|no|nope|cancel|ayaw|stop|huwag|wag|2\b|di na)/i.test(lower);
    if (yes) {
      var action = _pendingAction; _pendingAction = null;
      AI_CHAT_HISTORY.push({role:'user',content:msg});
      var tid0 = appendChatTyping();
      var result0 = await executeAIAction(action);
      removeTyping(tid0);
      AI_CHAT_HISTORY.push({role:'assistant',content:result0});
      appendChatMsg('ai', result0);
      scrollChatToBottom(); return;
    }
    if (no) {
      _pendingAction = null;
      AI_CHAT_HISTORY.push({role:'user',content:msg});
      var r0 = 'Sige, cancelled. Ano pa ang gusto mong gawin?';
      AI_CHAT_HISTORY.push({role:'assistant',content:r0});
      appendChatMsg('ai', r0);
      scrollChatToBottom(); return;
    }
    _pendingAction = null;
  }

  AI_CHAT_HISTORY.push({role:'user',content:msg});
  var tid = appendChatTyping();
  var sbtn = document.getElementById('ai-chat-send');
  if (sbtn) sbtn.disabled = true;

  try {
    var res2 = await fetch(GROQ_URL, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        model:'llama-3.3-70b-versatile', max_tokens:900,
        messages: [{role:'system', content:buildAIInstructorPrompt()}].concat(AI_CHAT_HISTORY.slice(-14))
      })
    });
    var data2 = await res2.json();
    if (data2.error) throw new Error(data2.error.message||'API error');
    var reply = (data2.choices && data2.choices[0] && data2.choices[0].message && data2.choices[0].message.content) || '';

    var actionMatch = reply.match(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/);
    var cleanReply = reply.replace(/\[ACTION\][\s\S]*?\[\/ACTION\]/g,'').trim();

    removeTyping(tid);
    AI_CHAT_HISTORY.push({role:'assistant',content:reply});

    if (actionMatch) {
      var actionObj;
      try {
        var araw = actionMatch[1].trim();
        var asi = araw.indexOf('{'), aei = araw.lastIndexOf('}');
        actionObj = JSON.parse(asi!==-1&&aei!==-1 ? araw.slice(asi,aei+1) : araw);
      } catch(pe) {
        appendChatMsg('ai', cleanReply || 'Error parsing action.');
        scrollChatToBottom(); return;
      }

      var isDestructive = ['fix_note','bulk_fix','clear_all_memory'].indexOf(actionObj.type) !== -1;
      var hasConfirm = cleanReply.toUpperCase().indexOf('DAPAT I-CONFIRM') !== -1 || cleanReply.toUpperCase().indexOf('CONFIRM') !== -1;

      if (isDestructive || hasConfirm) {
        _pendingAction = actionObj;
        var preview = cleanReply.replace(/DAPAT I-CONFIRM:?/gi,'').trim();
        if (actionObj.type === 'bulk_fix' && actionObj.targets) {
          var lines = actionObj.targets.map(function(t2) {
            var n2 = window.allNotes.find(function(x){ return x.fbKey === t2.fbKey; });
            var ch = Object.entries(t2.updates||{}).map(function(kv){ return kv[0]+'="'+kv[1]+'"'; }).join(', ');
            return n2 ? '- "' + n2.title + '" - ' + ch : '- fbKey:' + t2.fbKey + ' - ' + ch;
          });
          preview += '\n\nMaaapektuhan (' + lines.length + ' notes):\n' + lines.slice(0,10).join('\n') + (lines.length>10 ? '\n...+' + (lines.length-10) + ' pa' : '');
        } else if (actionObj.type === 'fix_note') {
          var fn2 = window.allNotes.find(function(x){ return x.fbKey === actionObj.fbKey; });
          var fch = Object.entries(actionObj.updates||{}).map(function(kv){ return kv[0]+'="'+kv[1]+'"'; }).join(', ');
          if (fn2) preview += '\n\nNote: "' + fn2.title + '"\nChanges: ' + fch;
        }
        appendChatMsg('ai', preview + '\n\nI-confirm ba? Mag-type ng "oo" o "hindi".');
      } else {
        var result2 = await executeAIAction(actionObj);
        if (result2) cleanReply = cleanReply ? cleanReply + '\n\n' + result2 : result2;
        appendChatMsg('ai', cleanReply);
      }
    } else {
      appendChatMsg('ai', cleanReply);
    }
  } catch(err) {
    removeTyping(tid);
    appendChatMsg('ai', 'Error: ' + err.message);
  }

  if (sbtn) sbtn.disabled = false;
  scrollChatToBottom();
}

// ── Memory badge ──────────────────────────────────────────────
function updateMemoryBadge() {
  var c = Object.keys(aiMemory||{}).length;
  var bar = document.getElementById('aiMemBar');
  var txt = document.getElementById('aiMemTxt');
  if (!bar||!txt) return;
  if (c>0) { bar.classList.add('show'); txt.textContent = 'AI memory: ' + c + ' topic' + (c>1?'s':'') + ' learned'; }
  else bar.classList.remove('show');
}

// ── UI helpers ────────────────────────────────────────────────
var _typingCounter = 0;

function appendChatMsg(role, text) {
  var feed = document.getElementById('ai-chat-feed');
  if (!feed) return;
  var div = document.createElement('div');
  div.className = 'aicm aicm-' + role;
  div.innerHTML = '<div class="aicm-bubble">' + escChat(text).replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>') + '</div>';
  feed.appendChild(div);
  scrollChatToBottom();
}

function appendChatTyping() {
  var id = 'ty-'+(++_typingCounter);
  var feed = document.getElementById('ai-chat-feed');
  if (!feed) return id;
  var div = document.createElement('div');
  div.className='aicm aicm-ai'; div.id=id;
  div.innerHTML='<div class="aicm-bubble aicm-typing"><span></span><span></span><span></span></div>';
  feed.appendChild(div); scrollChatToBottom(); return id;
}
function removeTyping(id) { var el = document.getElementById(id); if (el) el.remove(); }
function scrollChatToBottom() {
  var feed = document.getElementById('ai-chat-feed');
  if (feed) requestAnimationFrame(function(){ feed.scrollTop=feed.scrollHeight; });
}
function escChat(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Show memory DIRECTLY from live Firebase data ──────────────
// Bypasses AI entirely — no hallucination possible
function showMemoryDirect() {
  var entries = Object.entries(aiMemory || {});
  if (!entries.length) {
    appendChatMsg('ai',
      'AI Memory mo ay EMPTY ngayon.\n\nWala pang na-save na topics o category rules.\n\n' +
      'Mag-organize ng notes para mabuild ang memory, o gumamit ng "Add category rule" para mag-manually add ng rule.'
    );
    return;
  }

  var rules  = entries.filter(function(e){ return e[1].categoryRule; });
  var topics = entries.filter(function(e){ return !e[1].categoryRule; });

  var msg = 'AI Memory - ' + entries.length + ' entr' + (entries.length !== 1 ? 'ies' : 'y') + ' total\n';
  msg += '====================================\n\n';

  if (rules.length) {
    msg += 'CATEGORY RULES (' + rules.length + '):\n';
    rules.forEach(function(kv) {
      var k = kv[0], v = kv[1];
      msg += '[' + v.category + '] ' + v.title + '\n  Rule: "' + v.categoryRule + '"\n  key: ' + k + '\n\n';
    });
  }

  if (topics.length) {
    msg += 'LEARNED TOPICS (' + topics.length + '):\n';
    topics.forEach(function(kv) {
      var k = kv[0], v = kv[1];
      var sum = v.summary ? String(v.summary).slice(0,90) + (String(v.summary).length > 90 ? '...' : '') : '-';
      msg += '[' + v.category + '] ' + v.title + '\n  ' + sum + '\n  key: ' + k + '\n\n';
    });
  }

  msg += 'Gusto mo bang mag-edit o mag-delete ng isang entry? Sabihin mo lang ang key.';
  appendChatMsg('ai', msg);
}

// ── Edit memory — show live entries, guide user ───────────────
function editMemoryDirect() {
  var entries = Object.entries(aiMemory || {});
  if (!entries.length) {
    appendChatMsg('ai',
      'Walang memory entries pa. Wala ring ie-edit.\n\n' +
      'Gumamit ng "Add category rule" para mag-add ng bago.'
    );
    return;
  }

  var msg = 'Edit AI Memory - ' + entries.length + ' entr' + (entries.length !== 1 ? 'ies' : 'y') + ':\n\n';
  entries.forEach(function(kv, i) {
    var k = kv[0], v = kv[1];
    var ruleStr = v.categoryRule ? '\n  Rule: "' + v.categoryRule + '"' : '';
    msg += (i + 1) + '. [' + v.category + '] ' + v.title + ruleStr + '\n  key: ' + k + '\n\n';
  });
  msg += 'Sabihin mo kung anong key ang gusto mong i-edit o i-delete.\nHalimbawa:\n"i-delete ang key it_react_hooks"\n"baguhin ang rule ng key freelance_client_meeting"';
  appendChatMsg('ai', msg);
}

// ── Quick prompts ─────────────────────────────────────────────
var AI_QUICK_PROMPTS = [
  { label: 'Scan for errors',   text: 'I-scan mo ang lahat ng notes ko at sabihin mo kung alin ang posibleng mali ang category, title, o content. Ipakita mo bilang numbered list.' },
  { label: 'Fix one note',      text: 'Gusto kong ayusin ang isang specific na note. Itanong mo sa akin kung alin.' },
  { label: 'Bulk fix category', text: 'Gusto kong i-bulk fix ang category ng maraming notes sabay-sabay. Itanong mo kung anong category ang papalitan at ano ang tamang category.' },
  { label: 'Add category rule', text: 'Gusto ko magdagdag ng category rule sa memory. Halimbawa: kapag may ganitong content, dapat ganito ang category. Itanong mo sa akin ang details.' },
  { label: 'View memory',       action: 'showMemoryDirect' },
  { label: 'Notes overview',    text: 'I-breakdown mo ang lahat ng notes ko per category. Ilang notes per category at may maling nakita ka ba?' },
  { label: 'Edit memory',       action: 'editMemoryDirect' },
  { label: 'Clear memory',      text: 'Gusto kong i-clear ang lahat ng AI memory. Kumpirmahin mo muna bago gawin.' },
];

function renderQuickPrompts() {
  var wrap = document.getElementById('ai-quick-prompts');
  if (!wrap) return;
  wrap.innerHTML = '';
  AI_QUICK_PROMPTS.forEach(function(p) {
    var btn = document.createElement('button');
    btn.className = 'ai-qp';
    btn.textContent = p.label;
    btn.addEventListener('click', function() {
      if (p.action === 'showMemoryDirect') { showMemoryDirect(); return; }
      if (p.action === 'editMemoryDirect') { editMemoryDirect(); return; }
      var input = document.getElementById('ai-chat-input');
      if (input) { input.value = p.text; sendAIChat(); }
    });
    wrap.appendChild(btn);
  });
}

// ── Expand / fullscreen ───────────────────────────────────────
var aiPanelExpanded = false;

function injectAIPanelStyles() {
  if (document.getElementById('ai-panel-expand-styles')) return;
  var style = document.createElement('style');
  style.id = 'ai-panel-expand-styles';
  style.textContent =
    '.ai-panel-expand{width:26px;height:26px;background:var(--surface2);border:1px solid var(--border);' +
    'border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
    'color:var(--text-m);transition:all 0.2s;flex-shrink:0;}' +
    '.ai-panel-expand:hover{border-color:var(--a);color:var(--a2);background:var(--ag);}' +
    '.ai-panel.expanded{bottom:0!important;right:0!important;width:100vw!important;max-width:100vw!important;' +
    'height:100vh!important;max-height:100vh!important;border-radius:0!important;' +
    'transition:all 0.28s cubic-bezier(0.4,0,0.2,1)!important;}' +
    '@media(min-width:769px){.ai-panel.expanded{top:56px!important;bottom:0!important;right:0!important;' +
    'width:480px!important;max-width:480px!important;height:calc(100vh - 56px)!important;' +
    'max-height:calc(100vh - 56px)!important;border-radius:0!important;' +
    'border-right:none!important;border-top:none!important;border-bottom:none!important;}}' +
    '.ai-panel-head-btns{display:flex;align-items:center;gap:6px;}';
  document.head.appendChild(style);
}

function toggleAIPanelExpand() {
  var panel = document.getElementById('ai-chat-panel');
  var btn = document.getElementById('ai-expand-btn');
  if (!panel || !btn) return;
  aiPanelExpanded = !aiPanelExpanded;
  panel.classList.toggle('expanded', aiPanelExpanded);
  btn.innerHTML = aiPanelExpanded
    ? '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>'
    : '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
  btn.title = aiPanelExpanded ? 'Paliitin' : 'Palakihin';
  scrollChatToBottom();
}

function patchAIPanelHeader() {
  if (document.getElementById('ai-expand-btn')) return;
  var head = document.querySelector('.ai-panel-head');
  if (!head) return;
  var closeBtn = head.querySelector('.ai-panel-close');
  if (!closeBtn) return;
  var expandBtn = document.createElement('button');
  expandBtn.className = 'ai-panel-expand';
  expandBtn.id = 'ai-expand-btn';
  expandBtn.title = 'Palakihin';
  expandBtn.innerHTML = '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
  expandBtn.addEventListener('click', toggleAIPanelExpand);
  var group = document.createElement('div');
  group.className = 'ai-panel-head-btns';
  closeBtn.parentNode.insertBefore(group, closeBtn);
  group.appendChild(expandBtn);
  group.appendChild(closeBtn);
}

// ── Panel open/close ──────────────────────────────────────────
function openAIChat() {
  injectAIPanelStyles();
  patchAIPanelHeader();
  aiChatOpen = true;
  document.getElementById('ai-chat-panel') && document.getElementById('ai-chat-panel').classList.add('open');
  document.getElementById('ai-fab') && document.getElementById('ai-fab').classList.add('active');
  var feed = document.getElementById('ai-chat-feed');
  if (feed && feed.children.length === 0) {
    var myNc = (window.allNotes || []).filter(function(n){ return isMyNote(n); }).length;
    var mc = Object.keys(aiMemory || {}).length;
    appendChatMsg('ai',
      'Hoy! AI Instructor ako.\n\nNakita ko: ' + myNc + ' notes mo, ' + mc + ' memory entr' + (mc !== 1 ? 'ies' : 'y') + '.\n\n' +
      'Kaya ko:\n- I-scan ang notes para sa maling category/content\n- Mag-fix ng note - re-organize + tamang category\n' +
      '- Bulk-fix ng maraming notes sabay-sabay\n- Mag-save ng category rules\n- Mag-manage ng AI memory\n\n' +
      'Gusto mo bang i-scan ko muna ang notes mo?'
    );
    renderQuickPrompts();
  }
  setTimeout(function(){ var inp = document.getElementById('ai-chat-input'); if(inp) inp.focus(); }, 200);
}

function closeAIChat() {
  aiChatOpen = false;
  aiPanelExpanded = false;
  var panel = document.getElementById('ai-chat-panel');
  if (panel) panel.classList.remove('open', 'expanded');
  var fab = document.getElementById('ai-fab');
  if (fab) fab.classList.remove('active');
  var exbtn = document.getElementById('ai-expand-btn');
  if (exbtn) {
    exbtn.innerHTML = '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
    exbtn.title = 'Palakihin';
  }
}

function toggleAIChat() { if (aiChatOpen) closeAIChat(); else openAIChat(); }

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  var input = document.getElementById('ai-chat-input');
  if (!input) return;
  input.addEventListener('keydown', function(e) {
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendAIChat(); }
  });
  input.addEventListener('input', function() {
    this.style.height='auto';
    this.style.height=Math.min(this.scrollHeight,120)+'px';
  });
});
document.addEventListener('keydown', function(e) {
  if (e.key==='Escape') {
    if (aiPanelExpanded) { toggleAIPanelExpand(); return; }
    if (aiChatOpen) closeAIChat();
  }
});