// ============================================================
// app-ai.js — AI Instructor FAB + Chat Panel
// Powers: memory mgmt, fix/patch notes, bulk category fixes,
//         category rules, interactive confirmation flow.
// ============================================================

const AI_CHAT_HISTORY = [];
let aiChatOpen = false;
let _pendingAction = null;

function buildNotesContext() {
  const notes = (window.allNotes || []).slice(0, 40);
  if (!notes.length) return 'Wala pang notes.';
  return notes.map((n, i) =>
    `[${i}] fbKey="${n.fbKey||''}" title="${n.title}" category="${n.category}" ` +
    `public=${n.isPublic} author="${n.author||''}" ` +
    `rawNote="${String(n.rawNote||'').slice(0,80).replace(/\n/g,' ')}"` +
    (n.imageData?' hasImage=true':'')
  ).join('\n');
}

function buildMemCtx() {
  const entries = Object.entries(aiMemory || {});
  if (!entries.length) return 'Wala pa.';
  return entries.slice(0,30).map(([k,v]) =>
    `[${k}] cat="${v.category}" title="${v.title}" summary="${v.summary||''}"` +
    (v.categoryRule ? ` RULE:"${v.categoryRule}"` : '')
  ).join('\n');
}

function buildAIInstructorPrompt() {
  return `Ikaw ay ang AI Instructor ng Notes AI app. INSTRUCTOR MODE KA LANG.

RULES:
1. LAGING magtanong o mag-confirm bago gumawa ng kahit anong action sa notes.
2. Bago mag-fix ng notes, ipakita kung ano-ano ang maaapektuhan, tanungin ang user.
3. Mag-number ng options (1,2,3) para sa choices.
4. Kung mali ang category, itanong kung anong tama — huwag mag-assume.
5. Para sa category rules: i-save sa memory para hindi na maulit ang pagkakamali.
6. Maikli at malinaw ang sagot. Filipino/English. Max 6 sentences.
7. Para sa actions, gamitin ang [ACTION]{...}[/ACTION] tag sa DULO ng message.

KAYA MONG GAWIN:
- Fix/patch notes: baguhin ang category, title, summary, keyPoints, visibility ng specific notes
- Bulk-fix: ayusin ang maraming notes sabay-sabay base sa pattern
- Category rules: mag-save sa memory ng rule tulad ng "kapag may keyword X, category dapat Y"
- Memory management: add/edit/remove/clear memory entries
- Notes overview: i-analyze ang lahat ng notes at sabihin kung may mali

ACTION JSON FORMATS:
fix_note: {"type":"fix_note","fbKey":"EXACT_fbKey_from_notes_list","updates":{"category":"NEW_CAT"},"reOrganize":true}
  reOrganize:true = AI re-processes the note content with correct category context (ALWAYS use this when fixing category)
  reOrganize:false = just patch the field, no content re-org (only for title/visibility changes)

bulk_fix: {"type":"bulk_fix","targets":[{"fbKey":"exact_key","updates":{"category":"CORRECT_CAT"}},...],"reason":"bakit mali ang dati","reOrganize":true}
  reOrganize:true = each note gets AI re-organized with its correct category (use this for category fixes)

add_memory: {"type":"add_memory","data":{"key":"unique_key","title":"Short name","category":"CAT","summary":"...","categoryRule":"Kapag may X content, category dapat Y"}}
update_memory: {"type":"update_memory","data":{"key":"existing_key","title":"...","category":"...","categoryRule":"..."}}
remove_memory: {"type":"remove_memory","data":{"key":"memory_key"}}
clear_all_memory: {"type":"clear_all_memory"}

categoryRule examples: "Kapag may code/programming/debugging — IT", "Kapag may client/freelance/deadline — FREELANCE"
Rules ay AUTOMATIC na gagamitin ng AI organizer sa lahat ng susunod na notes.

IMPORTANT: Kapag fix_note o bulk_fix, ilagay muna ang "DAPAT I-CONFIRM:" sa sagot bago ang [ACTION] tag.
Para sa memory-only actions (add/update/remove), pwede direkta ang [ACTION] — walang confirm needed.`;
}

// ── Execute action ───────────────────────────────────────────
async function executeAIAction(actionObj) {
  const type = actionObj.type;

  if (type === 'fix_note') {
    const { fbKey, updates, reOrganize } = actionObj;
    if (!fbKey || !updates) return '⚠️ Missing fbKey or updates.';
    const n = window.allNotes.find(x => x.fbKey === fbKey);
    if (!n) return `⚠️ Note not found (fbKey: ${fbKey})`;
    if (!isMyNote(n)) return `⚠️ Hindi mo to note: "${n.title}"`;
    if (updates.category) updates.category = updates.category.toUpperCase().replace(/\s+/g,'_');

    let finalUpdates = {...updates};
    if (reOrganize !== false && (n.rawNote || n.organizedContent)) {
      try {
        const hint = updates.category ? `\n\nIMPORTANT: Ang tamang category ng notes na ito ay "${updates.category}". Gamitin ito.` : '';
        const noteContent = n.rawNote && n.rawNote !== '[image]' ? n.rawNote : n.organizedContent || n.title;
        const res = await fetch(GROQ_URL, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            model:'llama-3.3-70b-versatile', max_tokens:1800,
            messages:[
              {role:'system', content: buildSysPrompt() + hint},
              {role:'user', content:'I-re-organize ang notes na ito:\n\n' + noteContent}
            ]
          })
        });
        const data = await res.json();
        if (!data.error) {
          const raw = (data.choices?.[0]?.message?.content||'').replace(/```json|```/g,'').trim();
          const s=raw.indexOf('{'), e=raw.lastIndexOf('}');
          const p = JSON.parse(s!==-1&&e!==-1 ? raw.slice(s,e+1) : raw);
          function es(v){if(v==null)return'';if(typeof v==='string')return v;if(Array.isArray(v))return v.join('\n');return String(v);}
          function ea(v){if(Array.isArray(v))return v.map(es).filter(Boolean);if(typeof v==='string'&&v)return[v];return[];}
          finalUpdates = {
            title: updates.title || es(p.title) || n.title,
            category: updates.category || es(p.category).toUpperCase().replace(/\s+/g,'_') || n.category,
            summary: es(p.summary),
            keyPoints: ea(p.keyPoints),
            organizedContent: es(p.organizedContent),
            ...( updates.isPublic !== undefined ? {isPublic: updates.isPublic} : {} )
          };
        }
      } catch(re) { console.warn('Re-org failed, patching only:', re.message); }
    }

    try {
      if (window._db && window._update && window._ref && fbKey) {
        await window._update(window._ref(window._db, `notes/${fbKey}`), finalUpdates);
        await updateAIMemory({...n,...finalUpdates});
      } else { Object.assign(n, finalUpdates); renderApp(); }
      const changed = Object.keys(finalUpdates).filter(k=>k!=='organizedContent'&&k!=='summary'&&k!=='keyPoints').join(', ');
      return `✅ Fixed & re-organized: "${n.title}"\n→ ${changed ? 'Updated: '+changed : 'Content re-organized with correct context'}`;
    } catch(e) { return `⚠️ Fix failed: ${e.message}`; }
  }

  if (type === 'bulk_fix') {
    const { targets, reason, reOrganize } = actionObj;
    if (!targets?.length) return '⚠️ Walang targets.';
    const results = [];
    const shouldReOrg = reOrganize !== false;

    for (const t of targets) {
      const { fbKey, updates } = t;
      const n = window.allNotes.find(x => x.fbKey === fbKey);
      if (!n || !isMyNote(n)) { results.push(`⚠️ Skip "${fbKey}"`); continue; }
      if (updates.category) updates.category = updates.category.toUpperCase().replace(/\s+/g,'_');

      let finalUpdates = {...updates};

      if (shouldReOrg && updates.category && (n.rawNote || n.organizedContent)) {
        try {
          const noteContent = n.rawNote && n.rawNote !== '[image]' ? n.rawNote : n.organizedContent || n.title;
          const hint = `\n\nIMPORTANT: Ang tamang category ng notes na ito ay "${updates.category}". Gamitin ito.`;
          const res = await fetch(GROQ_URL, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
              model:'llama-3.3-70b-versatile', max_tokens:1800,
              messages:[
                {role:'system', content: buildSysPrompt() + hint},
                {role:'user', content:'I-re-organize:\n\n' + noteContent}
              ]
            })
          });
          const data = await res.json();
          if (!data.error) {
            const raw = (data.choices?.[0]?.message?.content||'').replace(/```json|```/g,'').trim();
            const s=raw.indexOf('{'), e=raw.lastIndexOf('}');
            const p = JSON.parse(s!==-1&&e!==-1 ? raw.slice(s,e+1) : raw);
            function es(v){if(v==null)return'';if(typeof v==='string')return v;if(Array.isArray(v))return v.join('\n');return String(v);}
            function ea(v){if(Array.isArray(v))return v.map(es).filter(Boolean);if(typeof v==='string'&&v)return[v];return[];}
            finalUpdates = {
              category: updates.category,
              title: updates.title || es(p.title) || n.title,
              summary: es(p.summary),
              keyPoints: ea(p.keyPoints),
              organizedContent: es(p.organizedContent),
            };
          }
        } catch(re) { console.warn('Bulk re-org failed for', n.title, re.message); }
      }

      try {
        if (window._db && window._update && window._ref) {
          await window._update(window._ref(window._db, `notes/${fbKey}`), finalUpdates);
          await updateAIMemory({...n,...finalUpdates});
        } else { Object.assign(n, finalUpdates); }
        results.push(`✅ "${n.title}" → [${finalUpdates.category}]`);
      } catch(e) { results.push(`⚠️ "${n.title}": ${e.message}`); }
    }
    renderApp();
    return `Bulk fix + re-organize tapos na! (${results.length} notes)\n${results.join('\n')}` + (reason?`\n\nReason: ${reason}`:'');
  }

  if (type === 'add_memory' || type === 'update_memory') {
    const d = actionObj.data || {};
    if (!d.key && !d.title) return '⚠️ Need key or title.';
    const k = (d.key||(d.category+'_'+d.title)).toLowerCase().replace(/[^a-z0-9]/g,'_').substring(0,60);
    const entry = { title:d.title||d.key, category:d.category||'OTHER', summary:d.summary||'', keyPoints:d.keyPoints||[], updated:Date.now(), ...(d.categoryRule?{categoryRule:d.categoryRule}:{}) };
    try {
      if (window._db && window._update && window._ref) await window._update(window._ref(window._db,'ai_memory'),{[k]:entry});
      aiMemory[k] = entry; updateMemoryBadge();
      return `✅ Memory ${type==='add_memory'?'added':'updated'}: "${d.title||d.key}"` + (d.categoryRule?`\nRule: "${d.categoryRule}"`:'');
    } catch(e) { return `⚠️ Memory save failed: ${e.message}`; }
  }

  if (type === 'remove_memory') {
    const k = actionObj.data?.key;
    const match = Object.keys(aiMemory).find(mk => mk===k || aiMemory[mk].title===k);
    if (!match) return `⚠️ Not found: "${k}"`;
    try {
      if (window._db && window._update && window._ref) await window._update(window._ref(window._db,'ai_memory'),{[match]:null});
      delete aiMemory[match]; updateMemoryBadge();
      return `🗑️ Removed: "${k}"`;
    } catch(e) { return `⚠️ Failed: ${e.message}`; }
  }

  if (type === 'clear_all_memory') {
    try {
      if (window._db && window._update && window._ref) {
        const nulls = {}; Object.keys(aiMemory).forEach(k=>{nulls[k]=null;});
        if (Object.keys(nulls).length) await window._update(window._ref(window._db,'ai_memory'),nulls);
      }
      aiMemory = {}; updateMemoryBadge();
      return '🧹 AI memory cleared.';
    } catch(e) { return `⚠️ Failed: ${e.message}`; }
  }

  return `⚠️ Unknown type: ${type}`;
}

// ── Main send ────────────────────────────────────────────────
async function sendAIChat() {
  const input = document.getElementById('ai-chat-input');
  const msg = input?.value?.trim();
  if (!msg) return;
  input.value = ''; input.style.height = '';
  appendChatMsg('user', msg);

  // Handle pending confirmation
  if (_pendingAction) {
    const lower = msg.toLowerCase();
    const yes = /^(oo|yes|yep|confirm|go|sige|ok|tara|push|1\b|paki|gawin|proceed|ayan|yup|sure)/i.test(lower);
    const no  = /^(hindi|no|nope|cancel|ayaw|stop|huwag|wag|2\b|di na)/i.test(lower);
    if (yes) {
      const action = _pendingAction; _pendingAction = null;
      AI_CHAT_HISTORY.push({role:'user',content:msg});
      const tid = appendChatTyping();
      const result = await executeAIAction(action);
      removeTyping(tid);
      AI_CHAT_HISTORY.push({role:'assistant',content:result});
      appendChatMsg('ai', result);
      scrollChatToBottom(); return;
    }
    if (no) {
      _pendingAction = null;
      AI_CHAT_HISTORY.push({role:'user',content:msg});
      const r = 'Sige, cancelled. Ano pa ang gusto mong gawin?';
      AI_CHAT_HISTORY.push({role:'assistant',content:r});
      appendChatMsg('ai', r);
      scrollChatToBottom(); return;
    }
    _pendingAction = null; // unclear — fall through
  }

  AI_CHAT_HISTORY.push({role:'user',content:msg});
  const tid = appendChatTyping();
  const btn = document.getElementById('ai-chat-send');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(GROQ_URL, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        model:'llama-3.3-70b-versatile', max_tokens:900,
        messages:[
          {role:'system', content:buildAIInstructorPrompt()},
          ...AI_CHAT_HISTORY.slice(-14)
        ]
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message||'API error');
    const reply = data.choices?.[0]?.message?.content || '';

    const actionMatch = reply.match(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/);
    let cleanReply = reply.replace(/\[ACTION\][\s\S]*?\[\/ACTION\]/g,'').trim();

    removeTyping(tid);
    AI_CHAT_HISTORY.push({role:'assistant',content:reply});

    if (actionMatch) {
      let actionObj;
      try {
        const raw = actionMatch[1].trim();
        const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
        actionObj = JSON.parse(s!==-1&&e!==-1 ? raw.slice(s,e+1) : raw);
      } catch(pe) {
        console.error('Action parse:', pe);
        appendChatMsg('ai', cleanReply || '⚠️ Error parsing action.');
        scrollChatToBottom(); return;
      }

      const isDestructive = ['fix_note','bulk_fix','clear_all_memory'].includes(actionObj.type);
      const hasConfirmMarker = cleanReply.toUpperCase().includes('DAPAT I-CONFIRM') || cleanReply.toUpperCase().includes('CONFIRM');

      if (isDestructive || hasConfirmMarker) {
        _pendingAction = actionObj;
        let preview = cleanReply.replace(/DAPAT I-CONFIRM:?/gi,'').trim();
        if (actionObj.type === 'bulk_fix' && actionObj.targets) {
          const names = actionObj.targets.map(t => {
            const n = window.allNotes.find(x => x.fbKey === t.fbKey);
            const changes = Object.entries(t.updates||{}).map(([k,v])=>`${k}="${v}"`).join(', ');
            return n ? `• "${n.title}" — ${changes}` : `• fbKey:${t.fbKey} — ${changes}`;
          });
          preview += `\n\nMga notes na maaapektuhan (${names.length}):\n${names.slice(0,10).join('\n')}` + (names.length>10?`\n...+${names.length-10} pa`:'');
        } else if (actionObj.type === 'fix_note') {
          const n = window.allNotes.find(x => x.fbKey === actionObj.fbKey);
          const changes = Object.entries(actionObj.updates||{}).map(([k,v])=>`${k}="${v}"`).join(', ');
          if (n) preview += `\n\nNote: "${n.title}"\nChanges: ${changes}`;
        }
        appendChatMsg('ai', preview + '\n\nI-confirm ba? Mag-type ng "oo" o "hindi".');
      } else {
        // Direct execute (memory ops)
        const result = await executeAIAction(actionObj);
        if (result) cleanReply = cleanReply ? cleanReply+'\n\n'+result : result;
        appendChatMsg('ai', cleanReply);
      }
    } else {
      appendChatMsg('ai', cleanReply);
    }
  } catch(err) {
    removeTyping(tid);
    appendChatMsg('ai', `⚠️ Error: ${err.message}`);
  }

  if (btn) btn.disabled = false;
  scrollChatToBottom();
}

// ── Memory badge ─────────────────────────────────────────────
function updateMemoryBadge() {
  const c = Object.keys(aiMemory||{}).length;
  const bar = document.getElementById('aiMemBar');
  const txt = document.getElementById('aiMemTxt');
  if (!bar||!txt) return;
  if (c>0) { bar.classList.add('show'); txt.textContent=`AI memory: ${c} entr${c>1?'ies':'y'}`; }
  else bar.classList.remove('show');
}

// ── UI helpers ───────────────────────────────────────────────
let _typingCounter = 0;

function appendChatMsg(role, text) {
  const feed = document.getElementById('ai-chat-feed');
  if (!feed) return;
  const div = document.createElement('div');
  div.className = `aicm aicm-${role}`;
  const html = escChat(text)
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/\n/g,'<br>');
  div.innerHTML = `<div class="aicm-bubble">${html}</div>`;
  feed.appendChild(div);
  scrollChatToBottom();
}

function appendChatTyping() {
  const id = 'ty-'+(++_typingCounter);
  const feed = document.getElementById('ai-chat-feed');
  if (!feed) return id;
  const div = document.createElement('div');
  div.className='aicm aicm-ai'; div.id=id;
  div.innerHTML=`<div class="aicm-bubble aicm-typing"><span></span><span></span><span></span></div>`;
  feed.appendChild(div); scrollChatToBottom(); return id;
}
function removeTyping(id) { document.getElementById(id)?.remove(); }
function scrollChatToBottom() {
  const feed = document.getElementById('ai-chat-feed');
  if (feed) requestAnimationFrame(()=>{ feed.scrollTop=feed.scrollHeight; });
}
function escChat(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Quick prompts ────────────────────────────────────────────
const AI_QUICK_PROMPTS = [
  { label: '🔍 Scan for errors',    text: 'I-scan mo ang lahat ng notes ko at sabihin mo kung alin ang posibleng mali ang category, title, o content. Ipakita mo bilang numbered list.' },
  { label: '🔧 Fix one note',        text: 'Gusto kong ayusin ang isang specific na note. Itanong mo sa akin kung alin.' },
  { label: '🔁 Bulk fix category',   text: 'Gusto kong i-bulk fix ang category ng maraming notes sabay-sabay. Itanong mo kung anong category ang papalitan at ano ang tamang category.' },
  { label: '📏 Add category rule',   text: 'Gusto ko magdagdag ng category rule sa memory. Halimbawa: kapag may ganitong content, dapat ganito ang category. Itanong mo sa akin ang details.' },
  { label: '🧠 View memory + rules', text: 'Ipakita mo lahat ng nasa AI memory ko pati ang mga category rules na na-save.' },
  { label: '📊 Notes overview',      text: 'I-breakdown mo ang lahat ng notes ko per category. Ilang notes per category at may maling nakita ka ba?' },
  { label: '✏️ Edit memory',         text: 'Gusto kong mag-edit ng memory entry o category rule. Ipakita mo muna ang lahat ng entries.' },
  { label: '🧹 Clear memory',        text: 'Gusto kong i-clear ang lahat ng AI memory. Kumpirmahin mo muna bago gawin.' },
];

function renderQuickPrompts() {
  const wrap = document.getElementById('ai-quick-prompts');
  if (!wrap) return;
  wrap.innerHTML = '';
  AI_QUICK_PROMPTS.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'ai-qp';
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      const input = document.getElementById('ai-chat-input');
      if (input) {
        input.value = p.text;
        sendAIChat();
      }
    });
    wrap.appendChild(btn);
  });
}

// ── Panel open/close ─────────────────────────────────────────
function openAIChat() {
  aiChatOpen = true;
  document.getElementById('ai-chat-panel')?.classList.add('open');
  document.getElementById('ai-fab')?.classList.add('active');
  const feed = document.getElementById('ai-chat-feed');
  if (feed && feed.children.length === 0) {
    // FIX: get accurate counts at open time, after data is loaded
    const myNotes = (window.allNotes || []).filter(n => isMyNote(n));
    const myNc = myNotes.length;
    const mc = Object.keys(aiMemory || {}).length;

    appendChatMsg('ai',
      `Hoy! AI Instructor ako. 👋\n\nNakita ko: ${myNc} notes mo, ${mc} memory entr${mc !== 1 ? 'ies' : 'y'}.\n\nKaya ko:\n• I-scan ang notes para sa maling category/content\n• Mag-fix ng note — re-organize content + tamang category\n• Bulk-fix ng maraming notes sabay-sabay\n• Mag-save ng category rules (para hindi na maulit)\n• Mag-manage ng AI memory\n\nGusto mo bang i-scan ko muna ang notes mo para tingnan kung may mali?`
    );
    renderQuickPrompts();
  }
  setTimeout(()=>document.getElementById('ai-chat-input')?.focus(), 200);
}

function closeAIChat() {
  aiChatOpen = false;
  document.getElementById('ai-chat-panel')?.classList.remove('open');
  document.getElementById('ai-fab')?.classList.remove('active');
}

function toggleAIChat() { if (aiChatOpen) closeAIChat(); else openAIChat(); }

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('ai-chat-input');
  if (!input) return;
  input.addEventListener('keydown', e => {
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendAIChat(); }
  });
  input.addEventListener('input', function() {
    this.style.height='auto';
    this.style.height=Math.min(this.scrollHeight,120)+'px';
  });
});
document.addEventListener('keydown', e => { if (e.key==='Escape'&&aiChatOpen) closeAIChat(); });