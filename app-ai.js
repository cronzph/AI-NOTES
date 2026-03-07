// ============================================================
// app-ai.js  —  AI Instructor  (full rewrite)
// ============================================================

const AI_CHAT_HISTORY = [];
let aiChatOpen        = false;
let _pendingAction    = null;
let _quickPromptsVisible = true;

// ─────────────────────────────────────────────────────────────
// BEHAVIOR RULES ENGINE
// All user instructions are stored in aiMemory under category
// "BEHAVIOR".  These are enforced here in JS AND injected into
// every AI system-prompt so the AI itself also obeys them.
// ─────────────────────────────────────────────────────────────

/** Return all saved behavior rules as an array of strings. */
function getBehaviorRules() {
  return Object.values(aiMemory || {})
    .filter(function(v){ return v.category === 'BEHAVIOR' || v.behaviorRule; })
    .map(function(v){ return String(v.behaviorRule || v.summary || ''); })
    .filter(Boolean);
}

/**
 * Ask the AI to decide — given the current behavior rules —
 * whether a note should be saved to memory.
 * Returns: { skip: bool, reason: string }
 * Pure JS fallback included so this never throws.
 */
async function shouldSkipMemorySave(note) {
  // --- JS-level fast checks (always run first) ---
  var title   = String(note.title   || '').toLowerCase().trim();
  var raw     = String(note.rawNote || note.organizedContent || '').toLowerCase();
  var summary = String(note.summary || '').toLowerCase();

  // 1. Built-in: "walang mahalagang impormasyon" in summary
  if (/walang mahalagang impormasyon/.test(summary)) return { skip:true, reason:'walang laman' };

  // 2. Built-in: title is literally just "test","testing","try","sample","pantest"
  if (/^(test|testing|try+|sample|pantest|dummy|placeholder)(\s+(note|notes|lang|ito|nito|only|cmd|command))?$/.test(title)) {
    return { skip:true, reason:'test/try title' };
  }

  // 3. User behavior rules — parse keywords dynamically
  var rules = getBehaviorRules();
  for (var ri = 0; ri < rules.length; ri++) {
    var ruleText = rules[ri].toLowerCase();

    // What is the rule saying to SKIP?
    // Pattern: "huwag ... save ... [keyword]" or "kapag [keyword] lang ... huwag"
    // Extract the subject keywords from the rule
    var skipKeywords = extractSkipKeywords(ruleText);
    for (var ki = 0; ki < skipKeywords.length; ki++) {
      var kw = skipKeywords[ki];
      // Match keyword anywhere in the title (word boundary)
      if (new RegExp('(^|\\s|_)' + escapeRegex(kw) + '(\\s|_|$)').test(title)) {
        return { skip:true, reason:'user rule: ' + rules[ri].slice(0,60) };
      }
    }
  }

  return { skip:false, reason:'' };
}

/** Extract the "things to skip" from a rule sentence. */
function extractSkipKeywords(ruleText) {
  var keywords = [];

  // Known skip-trigger words
  var knownSkip = ['test','testing','try','sample','pantest','dummy','placeholder',
                   'blank','empty','blangko','walang laman','temp','temporary'];
  knownSkip.forEach(function(k){
    if (ruleText.indexOf(k) !== -1) keywords.push(k);
  });

  // Also extract words that come AFTER "kapag" and BEFORE "lang/huwag/di"
  // e.g. "kapag try lang" → "try"
  var m = ruleText.match(/kapag\s+(\w+)\s+(lang|huwag|di|hindi)/);
  if (m && m[1] && keywords.indexOf(m[1]) === -1) keywords.push(m[1]);

  // Words after "ng" that precede "notes/note"
  // e.g. "huwag mag-save ng testing notes" → "testing"
  var m2 = ruleText.match(/\bng\s+(\w+)\s+notes?\b/);
  if (m2 && m2[1] && keywords.indexOf(m2[1]) === -1) keywords.push(m2[1]);

  return keywords;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

// ─────────────────────────────────────────────────────────────
// OVERRIDE window.updateAIMemory
// Install as early as possible — if the function isn't defined
// yet, we poll until it is (max 3s).
// ─────────────────────────────────────────────────────────────
(function installMemoryOverride() {
  var attempts = 0;
  function tryInstall() {
    if (typeof window.updateAIMemory === 'function' && !window._aiMemoryOverrideInstalled) {
      var _orig = window.updateAIMemory;
      window.updateAIMemory = async function(note) {
        var check = await shouldSkipMemorySave(note);
        if (check.skip) {
          console.log('[AI Memory] SKIP "' + (note.title||'?') + '" — ' + check.reason);
          return;
        }
        return _orig.apply(this, arguments);
      };
      window._aiMemoryOverrideInstalled = true;
      console.log('[app-ai.js] updateAIMemory override installed ✓');
      return;
    }
    if (attempts++ < 30) setTimeout(tryInstall, 100); // retry up to 3s
  }
  // Try immediately (in case script loads after app.html defines it)
  // and also on DOMContentLoaded
  tryInstall();
  document.addEventListener('DOMContentLoaded', tryInstall);
})();

// ─────────────────────────────────────────────────────────────
// AUTO-CLEAN JUNK MEMORY ON PANEL OPEN
// ─────────────────────────────────────────────────────────────
async function cleanJunkMemoryEntries() {
  var keys = Object.keys(aiMemory || {});
  var cleaned = [];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = aiMemory[k];
    if (v.category === 'BEHAVIOR') continue; // never delete behavior rules
    var check = await shouldSkipMemorySave(Object.assign({ title: v.title }, v));
    if (check.skip) {
      try {
        if (window._db && window._update && window._ref)
          await window._update(window._ref(window._db, 'ai_memory'), { [k]: null });
        delete aiMemory[k];
        cleaned.push(v.title || k);
      } catch(e) { console.warn('Cleanup failed:', k, e.message); }
    }
  }
  if (cleaned.length) updateMemoryBadge();
  return cleaned;
}

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT  —  full context, full authority
// ─────────────────────────────────────────────────────────────
function buildAIInstructorPrompt() {
  var myNotes = (window.allNotes || []).filter(function(n){ return isMyNote(n); });

  var notesBlock = myNotes.length
    ? myNotes.map(function(n, i) {
        var t = String(n.title||'').replace(/"/g,"'").slice(0,60);
        var r = String(n.rawNote||'').replace(/\n/g,' ').replace(/"/g,"'").slice(0,100);
        return '['+i+'] fbKey="'+n.fbKey
          +'" | title="'+t
          +'" | cat="'+n.category
          +'" | public='+(n.isPublic===true)
          +(r?' | raw="'+r+'"':'')
          +(n.imageData?' | hasImage=true':'');
      }).join('\n')
    : '(wala pang notes)';

  var memEntries = Object.entries(aiMemory || {});
  var memBlock = memEntries.length
    ? memEntries.map(function(kv) {
        var k=kv[0], v=kv[1];
        var s=String(v.summary||'').slice(0,80).replace(/"/g,"'");
        var extras = (v.categoryRule ? ' | RULE:"'+v.categoryRule+'"' : '')
                   + (v.behaviorRule ? ' | BEHAVIOR:"'+v.behaviorRule+'"' : '');
        return 'key="'+k+'" | cat="'+(v.category||'')+'" | title="'+(v.title||'')+'" | summary="'+s+'"'+extras;
      }).join('\n')
    : '(walang entries)';

  var behaviorRules = getBehaviorRules();
  var behaviorBlock = behaviorRules.length
    ? behaviorRules.map(function(r,i){ return (i+1)+'. '+r; }).join('\n')
    : '(wala)';

  return [
'================================================================',
'IKAW: AI Instructor ng Notes AI app ni '+((window._currentUser&&window._currentUser.displayName)||'User')+'.',
'AWTORIDAD: Mayroon kang FULL POWER sa notes at memory ng user.',
'           Maaari kang mag-read, mag-fix, mag-organize, mag-delete ng memory entries.',
'           Maaari kang sumunosig at gumawa ng desisyon nang mag-isa.',
'================================================================',
'',
'════════════════════ BEHAVIOR RULES ════════════════════════════',
'Ito ang mga UTOS NG USER na DAPAT MONG SUNDIN PALAGI:',
behaviorBlock,
'',
'⚠️  ENFORCEMENT: Bago ka mag-add_memory ng kahit anong note,',
'    i-check mo muna kung lumalabas ito sa behavior rules sa itaas.',
'    Kung ang note ay "test/testing/try/sample/pantest" o kahit',
'    anong ibinigay na skip-keyword ng user — HUWAG I-SAVE sa memory.',
'════════════════════════════════════════════════════════════════',
'',
'CORE RULES:',
'1. NOTES ≠ MEMORY. fix_note/bulk_fix = NOTES. add/remove_memory = MEMORY.',
'2. Kapag "tanggalin sa memory" → remove_memory action. HINDI bulk_fix.',
'3. fbKey sa fix_note/bulk_fix = KOPYA NANG EKSAKTO mula sa NOTES LIST.',
'4. Notes actions (fix_note, bulk_fix): kailangan ng "DAPAT I-CONFIRM:" + [ACTION].',
'5. Memory actions (add/update/remove/clear): direkta ang [ACTION], walang confirm.',
'6. Kapag may tatanggalin/baguhin → gawin mo, huwag magtanong ng sobra.',
'7. Sagot: maikli, malinaw, Filipino/English.',
'',
'ACTION FORMATS (gamitin lang ang kailangan):',
'fix_note:          {"type":"fix_note","fbKey":"EXACT_FBKEY","updates":{"category":"CAT","title":"..."},"reOrganize":true}',
'bulk_fix:          {"type":"bulk_fix","targets":[{"fbKey":"EXACT","updates":{"category":"CAT"}}],"reason":"...","reOrganize":true}',
'add_memory:        {"type":"add_memory","data":{"key":"slug","title":"...","category":"CAT","summary":"...","categoryRule":"...","behaviorRule":"..."}}',
'update_memory:     {"type":"update_memory","data":{"key":"EXACT_KEY","title":"...","summary":"...","behaviorRule":"..."}}',
'remove_memory:     {"type":"remove_memory","data":{"key":"EXACT_KEY"}}',
'bulk_remove_memory:{"type":"bulk_remove_memory","keys":["key1","key2"]}',
'clear_all_memory:  {"type":"clear_all_memory"}',
'save_behavior_rule:{"type":"save_behavior_rule","data":{"key":"behavior_slug","title":"Short title","behaviorRule":"The exact rule"}}',
'',
'TAG: [ACTION]{...}[/ACTION] — ilagay sa DULO ng message.',
'',
'================================================================',
'USER NOTES ('+myNotes.length+'):',
'================================================================',
notesBlock,
'',
'================================================================',
'AI MEMORY ('+memEntries.length+'):',
'================================================================',
memBlock,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// EXECUTE ACTION
// ─────────────────────────────────────────────────────────────
async function executeAIAction(actionObj) {
  var type = actionObj.type;

  // ── save_behavior_rule ─────────────────────────────────────
  if (type === 'save_behavior_rule') {
    var d = actionObj.data || {};
    if (!d.behaviorRule) return 'Missing behaviorRule.';
    var bkey = (d.key || 'behavior_'+Date.now()).toLowerCase().replace(/[^a-z0-9_]/g,'_').slice(0,60);
    var entry = {
      title: d.title || 'Behavior Rule',
      category: 'BEHAVIOR',
      summary: d.behaviorRule,
      behaviorRule: d.behaviorRule,
      keyPoints: [],
      updated: Date.now()
    };
    try {
      if (window._db&&window._update&&window._ref)
        await window._update(window._ref(window._db,'ai_memory'),{[bkey]:entry});
      aiMemory[bkey] = entry;
      updateMemoryBadge();
      return 'Behavior rule saved: "'+d.behaviorRule+'"';
    } catch(e) { return 'Save failed: '+e.message; }
  }

  // ── fix_note ───────────────────────────────────────────────
  if (type === 'fix_note') {
    var fbKey=actionObj.fbKey, updates=actionObj.updates, reOrganize=actionObj.reOrganize;
    if (!fbKey||!updates) return 'Missing fbKey or updates.';
    var n=window.allNotes.find(function(x){return x.fbKey===fbKey;});
    if (!n) return 'Note not found (fbKey: '+fbKey+')';
    if (!isMyNote(n)) return 'Hindi mo note ito: "'+n.title+'"';
    if (updates.category) updates.category=updates.category.toUpperCase().replace(/\s+/g,'_');
    var finalUpdates=Object.assign({},updates);
    if (reOrganize!==false&&(n.rawNote||n.organizedContent)) {
      try {
        var hint=updates.category?'\n\nIMPORTANT: Tamang category ay "'+updates.category+'". Gamitin ito.':'';
        var content=n.rawNote&&n.rawNote!=='[image]'?n.rawNote:n.organizedContent||n.title;
        var res=await fetch(GROQ_URL,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:1800,messages:[
            {role:'system',content:buildSysPrompt()+hint},
            {role:'user',content:'I-re-organize:\n\n'+content}
          ]})});
        var rdata=await res.json();
        if (!rdata.error) {
          var rraw=(rdata.choices[0].message.content||'').replace(/```json|```/g,'').trim();
          var rsi=rraw.indexOf('{'),rei=rraw.lastIndexOf('}');
          var rp=JSON.parse(rsi!==-1&&rei!==-1?rraw.slice(rsi,rei+1):rraw);
          function es(v){return v==null?'':typeof v==='string'?v:Array.isArray(v)?v.join('\n'):String(v);}
          function ea(v){return Array.isArray(v)?v.map(es).filter(Boolean):typeof v==='string'&&v?[v]:[];}
          finalUpdates={
            title:updates.title||es(rp.title)||n.title,
            category:updates.category||es(rp.category).toUpperCase().replace(/\s+/g,'_')||n.category,
            summary:es(rp.summary),keyPoints:ea(rp.keyPoints),organizedContent:es(rp.organizedContent)
          };
          if (updates.isPublic!==undefined) finalUpdates.isPublic=updates.isPublic;
        }
      } catch(re){console.warn('Re-org failed:',re.message);}
    }
    try {
      if (window._db&&window._update&&window._ref) {
        await window._update(window._ref(window._db,'notes/'+fbKey),finalUpdates);
        await window.updateAIMemory(Object.assign({},n,finalUpdates)); // override handles skip
      } else {Object.assign(n,finalUpdates);renderApp();}
      return 'Fixed: "'+n.title+'"';
    } catch(e){return 'Fix failed: '+e.message;}
  }

  // ── bulk_fix ───────────────────────────────────────────────
  if (type === 'bulk_fix') {
    var targets=actionObj.targets,reason=actionObj.reason,reOrg=actionObj.reOrganize;
    if (!targets||!targets.length) return 'Walang targets.';
    var results=[];
    for (var ti=0;ti<targets.length;ti++) {
      var tgt=targets[ti],tfbKey=tgt.fbKey,tupdates=tgt.updates;
      var tn=window.allNotes.find(function(x){return x.fbKey===tfbKey;});
      if (!tn||!isMyNote(tn)){results.push('Skip: '+tfbKey);continue;}
      if (tupdates.category) tupdates.category=tupdates.category.toUpperCase().replace(/\s+/g,'_');
      var tFinal=Object.assign({},tupdates);
      if (reOrg!==false&&tupdates.category&&(tn.rawNote||tn.organizedContent)) {
        try {
          var tc2=tn.rawNote&&tn.rawNote!=='[image]'?tn.rawNote:tn.organizedContent||tn.title;
          var th2='\n\nIMPORTANT: Tamang category ay "'+tupdates.category+'". Gamitin ito.';
          var tres=await fetch(GROQ_URL,{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:1800,messages:[
              {role:'system',content:buildSysPrompt()+th2},
              {role:'user',content:'I-re-organize:\n\n'+tc2}
            ]})});
          var tdata=await tres.json();
          if (!tdata.error) {
            var traw=(tdata.choices[0].message.content||'').replace(/```json|```/g,'').trim();
            var tsi2=traw.indexOf('{'),tei2=traw.lastIndexOf('}');
            var tp2=JSON.parse(tsi2!==-1&&tei2!==-1?traw.slice(tsi2,tei2+1):traw);
            function tes(v){return v==null?'':typeof v==='string'?v:Array.isArray(v)?v.join('\n'):String(v);}
            function tea(v){return Array.isArray(v)?v.map(tes).filter(Boolean):typeof v==='string'&&v?[v]:[];}
            tFinal={category:tupdates.category,title:tupdates.title||tes(tp2.title)||tn.title,
              summary:tes(tp2.summary),keyPoints:tea(tp2.keyPoints),organizedContent:tes(tp2.organizedContent)};
          }
        } catch(re2){console.warn('Bulk re-org fail:',tn.title,re2.message);}
      }
      try {
        if (window._db&&window._update&&window._ref) {
          await window._update(window._ref(window._db,'notes/'+tfbKey),tFinal);
          await window.updateAIMemory(Object.assign({},tn,tFinal));
        } else {Object.assign(tn,tFinal);}
        results.push('"'+tn.title+'" → ['+tFinal.category+']');
      } catch(e2){results.push('"'+tn.title+'": '+e2.message);}
    }
    renderApp();
    return 'Bulk fix done! ('+results.length+')\n'+results.join('\n')+(reason?'\n\nReason: '+reason:'');
  }

  // ── add_memory / update_memory ─────────────────────────────
  if (type==='add_memory'||type==='update_memory') {
    var d2=actionObj.data||{};
    if (!d2.key&&!d2.title) return 'Need key or title.';
    var mk=(d2.key||((d2.category||'other')+'_'+d2.title)).toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,60);
    var ent={title:d2.title||d2.key,category:d2.category||'OTHER',summary:d2.summary||'',
      keyPoints:d2.keyPoints||[],updated:Date.now()};
    if (d2.categoryRule) ent.categoryRule=d2.categoryRule;
    if (d2.behaviorRule) ent.behaviorRule=d2.behaviorRule;
    // Enforce: don't save junk even via add_memory
    var chk = await shouldSkipMemorySave(ent);
    if (chk.skip) return 'Hindi na-save — lumalabas sa behavior rules: '+chk.reason;
    try {
      if (window._db&&window._update&&window._ref)
        await window._update(window._ref(window._db,'ai_memory'),{[mk]:ent});
      aiMemory[mk]=ent; updateMemoryBadge();
      return 'Memory '+(type==='add_memory'?'added':'updated')+': "'+(d2.title||d2.key)+'"'
        +(d2.categoryRule?'\nRule: "'+d2.categoryRule+'"':'')
        +(d2.behaviorRule?'\nBehavior: "'+d2.behaviorRule+'"':'');
    } catch(e){return 'Memory save failed: '+e.message;}
  }

  // ── remove_memory ──────────────────────────────────────────
  if (type==='remove_memory') {
    var rk=actionObj.data&&actionObj.data.key;
    var rm=Object.keys(aiMemory).find(function(k){
      return k===rk||aiMemory[k].title===rk||k.includes(String(rk));
    });
    if (!rm) return 'Hindi makita: "'+rk+'"';
    try {
      if (window._db&&window._update&&window._ref)
        await window._update(window._ref(window._db,'ai_memory'),{[rm]:null});
      var rtitle=aiMemory[rm].title||rm;
      delete aiMemory[rm]; updateMemoryBadge();
      return 'Tinanggal: "'+rtitle+'"';
    } catch(e){return 'Failed: '+e.message;}
  }

  // ── bulk_remove_memory ─────────────────────────────────────
  if (type==='bulk_remove_memory') {
    var bkeys=actionObj.keys||[];
    if (!bkeys.length) return 'Walang keys.';
    var bremoved=[],bfailed=[];
    for (var bi=0;bi<bkeys.length;bi++) {
      var bk=bkeys[bi];
      var bm=Object.keys(aiMemory).find(function(k){
        return k===bk||aiMemory[k].title===bk||k.includes(String(bk));
      });
      if (!bm){bfailed.push(bk);continue;}
      try {
        if (window._db&&window._update&&window._ref)
          await window._update(window._ref(window._db,'ai_memory'),{[bm]:null});
        bremoved.push(aiMemory[bm].title||bm);
        delete aiMemory[bm];
      } catch(be){bfailed.push(bk+' ('+be.message+')');}
    }
    updateMemoryBadge();
    return (bremoved.length?'Tinanggal ('+bremoved.length+'):\n'+bremoved.map(function(r){return'- '+r;}).join('\n'):'')
          +(bfailed.length?'\nHindi mahanap:\n'+bfailed.map(function(f){return'- '+f;}).join('\n'):'');
  }

  // ── clear_all_memory ───────────────────────────────────────
  if (type==='clear_all_memory') {
    try {
      if (window._db&&window._update&&window._ref) {
        var nulls={};
        Object.keys(aiMemory).forEach(function(k){nulls[k]=null;});
        if (Object.keys(nulls).length) await window._update(window._ref(window._db,'ai_memory'),nulls);
      }
      aiMemory={}; updateMemoryBadge();
      return 'Memory cleared.';
    } catch(e){return 'Failed: '+e.message;}
  }

  return 'Unknown action type: '+type;
}

// ─────────────────────────────────────────────────────────────
// DIRECT HANDLERS  — JS intercepts before hitting AI
// These run first for reliability (no AI hallucination possible)
// ─────────────────────────────────────────────────────────────

/** Handle "tanggalin/delete sa memory ..." directly. Returns true if handled. */
async function tryDirectMemoryDelete(msg) {
  var lower = msg.toLowerCase();
  if (!/tanggal|delete|remove|bura|alisin|i-delete|itanggal/.test(lower)) return false;
  if (!/memory|memorya/.test(lower)) return false;

  var memKeys = Object.keys(aiMemory || {});
  if (!memKeys.length) { appendChatMsg('ai','Wala nang laman ang AI memory.'); return true; }

  // Strip "action + memory" noise words to get subject terms
  var subject = lower
    .replace(/\b(tanggal|delete|remove|bura|alisin|i-delete|itanggal|sa|ng|ang|yung|mo|na|lahat|memory|memorya|naman|na|nito|ito)\b/g,' ')
    .replace(/\s+/g,' ').trim();
  var subjWords = subject.split(' ').map(function(w){return w.replace(/[^a-z0-9]/g,'');}).filter(function(w){return w.length>1;});

  var toDelete = [];
  var seen = {};
  memKeys.forEach(function(k) {
    if (seen[k]) return;
    var v = aiMemory[k];
    var tl = String(v.title||'').toLowerCase();
    var kl = k.toLowerCase();
    // Exact key in message
    if (lower.includes(kl)) { toDelete.push(k); seen[k]=true; return; }
    // Exact title in message
    if (tl.length>2 && lower.includes(tl)) { toDelete.push(k); seen[k]=true; return; }
    // Any subject word matches any word in key or title
    if (subjWords.length) {
      var kwords = kl.replace(/_/g,' ').split(' ').filter(function(w){return w.length>1;});
      var twords = tl.split(/\s+/).filter(function(w){return w.length>1;});
      var allWords = kwords.concat(twords);
      var hit = subjWords.some(function(sw){
        return allWords.some(function(aw){ return aw===sw||aw.startsWith(sw)||sw.startsWith(aw); });
      });
      if (hit) { toDelete.push(k); seen[k]=true; }
    }
  });

  if (!toDelete.length) {
    var list = memKeys.filter(function(k){return aiMemory[k].category!=='BEHAVIOR';})
      .map(function(k,i){return (i+1)+'. ['+aiMemory[k].category+'] '+aiMemory[k].title+' (key: '+k+')';}).join('\n');
    appendChatMsg('ai','Alin sa memory entries ang gusto mong tanggalin?\n\n'+list+'\n\nSabihin ang exact title o key.');
    return true;
  }

  var results=[];
  for (var i=0;i<toDelete.length;i++) {
    var dk=toDelete[i];
    try {
      if (window._db&&window._update&&window._ref)
        await window._update(window._ref(window._db,'ai_memory'),{[dk]:null});
      results.push('Tinanggal: "'+( aiMemory[dk].title||dk)+'"');
      delete aiMemory[dk];
    } catch(de){results.push('Failed "'+dk+'": '+de.message);}
  }
  updateMemoryBadge();
  appendChatMsg('ai',results.join('\n'));
  return true;
}

/** Detect and save a user behavior instruction. Returns true if handled. */
async function tryDirectBehaviorSave(msg) {
  var lower = msg.toLowerCase();
  // Must sound like an instruction (huwag/wag/palagi/always/never/dapat)
  var isInstruction = /\b(huwag|wag|don.t|never|hindi|palagi|lagi|always|dapat|tandaan|remember|i-remember|mag-save|maglagay|ilagay|huwag)\b/.test(lower);
  // Must mention something about memory or saving behavior
  var aboutMemory = /\b(save|lagay|ilagay|store|memory|memorya|mag-lagay|maglagay|i-save|isave)\b/.test(lower);
  if (!isInstruction || !aboutMemory) return false;

  // Don't fire if there's also a delete intent (handled separately)
  if (/\b(tanggal|delete|remove|bura|alisin)\b/.test(lower)) return false;

  // Build a clean rule — use the message as-is (the user said it clearly)
  var rule = msg.trim();
  var words = lower.replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(function(w){return w.length>2;}).slice(0,6);
  var key = 'behavior_'+words.join('_').slice(0,55)+'_'+Date.now().toString(36);
  var title = 'Rule: '+rule.slice(0,55)+(rule.length>55?'...':'');

  var entry = {title:title,category:'BEHAVIOR',summary:rule,behaviorRule:rule,keyPoints:[],updated:Date.now()};
  try {
    if (window._db&&window._update&&window._ref)
      await window._update(window._ref(window._db,'ai_memory'),{[key]:entry});
    aiMemory[key]=entry;
    updateMemoryBadge();
    appendChatMsg('ai',
      'Nai-save ang instruction mo sa memory:\n\n'+
      '"'+rule+'"\n\n'+
      'Ito ay isasama ko sa lahat ng desisyon ko mula ngayon.\n'+
      'Mahahanap mo ito sa View Memory → BEHAVIOR RULES.\n\n'+
      'Key: '+key
    );
    return true;
  } catch(e) {
    console.warn('Behavior save failed:',e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN SEND
// ─────────────────────────────────────────────────────────────
async function sendAIChat() {
  var input=document.getElementById('ai-chat-input');
  var msg=input&&input.value&&input.value.trim();
  if (!msg) return;
  input.value=''; input.style.height='';
  appendChatMsg('user',msg);

  // ── Pending confirmation ─────────────────────────────────
  if (_pendingAction) {
    var lower0=msg.toLowerCase();
    var yes=/^(oo|yes|yep|confirm|go|sige|ok|tara|push|1\b|paki|gawin|proceed|ayan|yup|sure)/i.test(lower0);
    var no=/^(hindi|no|nope|cancel|ayaw|stop|huwag|wag|2\b|di na)/i.test(lower0);
    if (yes) {
      var pa=_pendingAction; _pendingAction=null;
      AI_CHAT_HISTORY.push({role:'user',content:msg});
      var pt=appendChatTyping();
      var pr=await executeAIAction(pa);
      removeTyping(pt);
      AI_CHAT_HISTORY.push({role:'assistant',content:pr});
      appendChatMsg('ai',pr);
      scrollChatToBottom(); return;
    }
    if (no) {
      _pendingAction=null;
      AI_CHAT_HISTORY.push({role:'user',content:msg});
      var r0='Sige, cancelled.';
      AI_CHAT_HISTORY.push({role:'assistant',content:r0});
      appendChatMsg('ai',r0);
      scrollChatToBottom(); return;
    }
    _pendingAction=null;
  }

  // ── Direct JS handlers (fast, zero hallucination) ────────
  // Both can fire on the same message
  var didDelete   = await tryDirectMemoryDelete(msg);
  var didBehavior = await tryDirectBehaviorSave(msg);
  if (didDelete||didBehavior) {
    AI_CHAT_HISTORY.push({role:'user',content:msg});
    AI_CHAT_HISTORY.push({role:'assistant',content:'(handled directly)'});
    scrollChatToBottom(); return;
  }

  // ── Normal AI call ───────────────────────────────────────
  AI_CHAT_HISTORY.push({role:'user',content:msg});
  var tid=appendChatTyping();
  setSendBtn(true);

  try {
    var res=await fetch(GROQ_URL,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'llama-3.3-70b-versatile',max_tokens:1000,
        messages:[{role:'system',content:buildAIInstructorPrompt()}].concat(AI_CHAT_HISTORY.slice(-16))
      })
    });
    var data=await res.json();
    if (data.error) throw new Error(data.error.message||'API error');
    var reply=(data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content)||'';
    var actionMatch=reply.match(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/);
    var cleanReply=reply.replace(/\[ACTION\][\s\S]*?\[\/ACTION\]/g,'').trim();
    removeTyping(tid);
    AI_CHAT_HISTORY.push({role:'assistant',content:reply});

    if (actionMatch) {
      var actionObj;
      try {
        var araw=actionMatch[1].trim();
        var asi=araw.indexOf('{'),aei=araw.lastIndexOf('}');
        actionObj=JSON.parse(asi!==-1&&aei!==-1?araw.slice(asi,aei+1):araw);
      } catch(pe) {
        appendChatMsg('ai',cleanReply||'Error parsing action.'); setSendBtn(false); scrollChatToBottom(); return;
      }

      // Memory actions execute immediately — no confirm needed
      var isMemAction = ['add_memory','update_memory','remove_memory',
                         'bulk_remove_memory','clear_all_memory','save_behavior_rule'].indexOf(actionObj.type)!==-1;
      var isNoteAction = ['fix_note','bulk_fix'].indexOf(actionObj.type)!==-1;

      if (isMemAction) {
        var mr=await executeAIAction(actionObj);
        if (mr) cleanReply=cleanReply?cleanReply+'\n\n'+mr:mr;
        appendChatMsg('ai',cleanReply||mr);
      } else if (isNoteAction) {
        // Always confirm before touching notes
        _pendingAction=actionObj;
        var preview=cleanReply.replace(/DAPAT I-CONFIRM:?/gi,'').trim();
        if (actionObj.type==='bulk_fix'&&actionObj.targets) {
          var lines=actionObj.targets.map(function(t){
            var n=window.allNotes.find(function(x){return x.fbKey===t.fbKey;});
            var ch=Object.entries(t.updates||{}).map(function(kv){return kv[0]+'="'+kv[1]+'"';}).join(', ');
            return n?'- "'+n.title+'" → '+ch:'- fbKey:'+t.fbKey+' → '+ch;
          });
          preview+='\n\nMaaapektuhan ('+lines.length+' notes):\n'+lines.slice(0,10).join('\n')+(lines.length>10?'\n...+'+(lines.length-10)+' pa':'');
        } else if (actionObj.type==='fix_note') {
          var fn=window.allNotes.find(function(x){return x.fbKey===actionObj.fbKey;});
          var fch=Object.entries(actionObj.updates||{}).map(function(kv){return kv[0]+'="'+kv[1]+'"';}).join(', ');
          if (fn) preview+='\n\nNote: "'+fn.title+'"\nChanges: '+fch;
        }
        appendChatMsg('ai',(preview||cleanReply)+'\n\nI-confirm? ("oo" / "hindi")');
        setSendBtn(false); scrollChatToBottom(); return;
      } else {
        appendChatMsg('ai',cleanReply);
      }
    } else {
      appendChatMsg('ai',cleanReply);
    }
  } catch(err) {
    removeTyping(tid);
    appendChatMsg('ai','Error: '+err.message);
  }

  setSendBtn(false);
  scrollChatToBottom();
}

function setSendBtn(disabled){ var s=document.getElementById('ai-chat-send'); if(s) s.disabled=!!disabled; }

// ─────────────────────────────────────────────────────────────
// MEMORY BADGE
// ─────────────────────────────────────────────────────────────
function updateMemoryBadge() {
  var c=Object.keys(aiMemory||{}).length;
  var bar=document.getElementById('aiMemBar'), txt=document.getElementById('aiMemTxt');
  if (!bar||!txt) return;
  if (c>0){bar.classList.add('show');txt.textContent='AI memory: '+c+' topic'+(c>1?'s':'')+' learned';}
  else bar.classList.remove('show');
}

// ─────────────────────────────────────────────────────────────
// CHAT UI HELPERS
// ─────────────────────────────────────────────────────────────
var _typingCounter=0;
function appendChatMsg(role,text){
  var feed=document.getElementById('ai-chat-feed'); if(!feed) return;
  var div=document.createElement('div'); div.className='aicm aicm-'+role;
  div.innerHTML='<div class="aicm-bubble">'+escChat(text)
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/\n/g,'<br>')+'</div>';
  feed.appendChild(div); scrollChatToBottom();
}
function appendChatTyping(){
  var id='ty-'+(++_typingCounter);
  var feed=document.getElementById('ai-chat-feed'); if(!feed) return id;
  var div=document.createElement('div'); div.className='aicm aicm-ai'; div.id=id;
  div.innerHTML='<div class="aicm-bubble aicm-typing"><span></span><span></span><span></span></div>';
  feed.appendChild(div); scrollChatToBottom(); return id;
}
function removeTyping(id){var el=document.getElementById(id);if(el)el.remove();}
function scrollChatToBottom(){
  var f=document.getElementById('ai-chat-feed');
  if(f) requestAnimationFrame(function(){f.scrollTop=f.scrollHeight;});
}
function escChat(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ─────────────────────────────────────────────────────────────
// SHOW / EDIT MEMORY (direct, no AI)
// ─────────────────────────────────────────────────────────────
function showMemoryDirect(){
  var entries=Object.entries(aiMemory||{});
  if (!entries.length){
    appendChatMsg('ai','AI Memory ay EMPTY.\n\nMag-type ng instruction para mag-save ng behavior rule.'); return;
  }
  var behaviors=entries.filter(function(e){return e[1].category==='BEHAVIOR'||e[1].behaviorRule;});
  var rules    =entries.filter(function(e){return e[1].categoryRule;});
  var topics   =entries.filter(function(e){return !e[1].behaviorRule&&!e[1].categoryRule&&e[1].category!=='BEHAVIOR';});

  var msg='AI Memory — '+entries.length+' entr'+(entries.length!==1?'ies':'y')+'\n'+'='.repeat(36)+'\n\n';
  if (behaviors.length){
    msg+='BEHAVIOR RULES ('+behaviors.length+') — instructions na sinusunod ko:\n';
    behaviors.forEach(function(kv){
      msg+='• '+kv[1].title+'\n  "'+( kv[1].behaviorRule||kv[1].summary)+'"\n  key: '+kv[0]+'\n\n';
    });
  }
  if (rules.length){
    msg+='CATEGORY RULES ('+rules.length+'):\n';
    rules.forEach(function(kv){
      msg+='• ['+kv[1].category+'] '+kv[1].title+'\n  Rule: "'+kv[1].categoryRule+'"\n  key: '+kv[0]+'\n\n';
    });
  }
  if (topics.length){
    msg+='LEARNED TOPICS ('+topics.length+'):\n';
    topics.forEach(function(kv){
      var s=String(kv[1].summary||'').slice(0,80)+(String(kv[1].summary||'').length>80?'...':'');
      msg+='• ['+kv[1].category+'] '+kv[1].title+'\n  '+s+'\n  key: '+kv[0]+'\n\n';
    });
  }
  msg+='Para mag-delete: "tanggalin sa memory [key o title]"';
  appendChatMsg('ai',msg);
}

function editMemoryDirect(){
  var entries=Object.entries(aiMemory||{});
  if (!entries.length){appendChatMsg('ai','Walang memory entries pa.');return;}
  var msg='Edit Memory — '+entries.length+' entr'+(entries.length!==1?'ies':'y')+':\n\n';
  entries.forEach(function(kv,i){
    var extra=kv[1].categoryRule?'\n  Rule: "'+kv[1].categoryRule+'"'
             :kv[1].behaviorRule?'\n  Behavior: "'+kv[1].behaviorRule+'"':'';
    msg+=(i+1)+'. ['+kv[1].category+'] '+kv[1].title+extra+'\n  key: '+kv[0]+'\n\n';
  });
  msg+='Para mag-delete: "tanggalin sa memory [key]"\nPara mag-edit: "baguhin ang [key]"';
  appendChatMsg('ai',msg);
}

// ─────────────────────────────────────────────────────────────
// QUICK PROMPTS  (collapsible)
// ─────────────────────────────────────────────────────────────
var AI_QUICK_PROMPTS=[
  {label:'Scan for errors', text:'I-scan mo ang lahat ng notes ko at sabihin mo kung alin ang posibleng mali ang category, title, o content. Ipakita bilang numbered list.'},
  {label:'Fix one note',    text:'Gusto kong ayusin ang isang specific na note. Itanong mo sa akin kung alin.'},
  {label:'Bulk fix',        text:'Gusto kong i-bulk fix ang category ng maraming notes. Itanong mo kung anong category ang papalitan at ano ang tamang category.'},
  {label:'Add rule',        text:'Gusto ko magdagdag ng category rule sa memory. Itanong mo sa akin ang details.'},
  {label:'View memory',     action:'showMemoryDirect'},
  {label:'Notes overview',  text:'I-breakdown mo ang lahat ng notes ko per category. Ilang notes per category?'},
  {label:'Edit memory',     action:'editMemoryDirect'},
  {label:'Clear memory',    text:'Gusto kong i-clear ang lahat ng AI memory. Kumpirmahin mo muna.'},
];

function renderQuickPrompts(){
  var wrap=document.getElementById('ai-quick-prompts'); if(!wrap) return;
  wrap.innerHTML='';

  var bar=document.createElement('div');
  bar.style.cssText='display:flex;align-items:center;justify-content:space-between;width:100%;padding:0 2px 5px;';
  var lbl=document.createElement('span');
  lbl.style.cssText='font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text-m);font-family:"JetBrains Mono",monospace;';
  lbl.textContent='QUICK ACTIONS';
  var tog=document.createElement('button');
  tog.id='qp-toggle-btn';
  tog.style.cssText='background:transparent;border:1px solid var(--border);border-radius:5px;color:var(--text-m);font-size:10px;padding:2px 7px;cursor:pointer;transition:all 0.15s;';
  tog.textContent=_quickPromptsVisible?'Hide':'Show';
  tog.addEventListener('click',function(){
    _quickPromptsVisible=!_quickPromptsVisible;
    var chips=document.getElementById('qp-chips');
    if(chips) chips.style.display=_quickPromptsVisible?'flex':'none';
    tog.textContent=_quickPromptsVisible?'Hide':'Show';
  });
  bar.appendChild(lbl); bar.appendChild(tog); wrap.appendChild(bar);

  var chips=document.createElement('div');
  chips.id='qp-chips';
  chips.style.cssText='display:'+(_quickPromptsVisible?'flex':'none')+';flex-wrap:wrap;gap:5px;width:100%;';
  AI_QUICK_PROMPTS.forEach(function(p){
    var btn=document.createElement('button'); btn.className='ai-qp'; btn.textContent=p.label;
    btn.addEventListener('click',function(){
      if(p.action==='showMemoryDirect'){showMemoryDirect();return;}
      if(p.action==='editMemoryDirect'){editMemoryDirect();return;}
      var inp=document.getElementById('ai-chat-input');
      if(inp){inp.value=p.text;sendAIChat();}
    });
    chips.appendChild(btn);
  });
  wrap.appendChild(chips);
}

// ─────────────────────────────────────────────────────────────
// EXPAND / FULLSCREEN PANEL
// ─────────────────────────────────────────────────────────────
var aiPanelExpanded=false;

function injectAIPanelStyles(){
  if(document.getElementById('ai-panel-expand-styles')) return;
  var s=document.createElement('style'); s.id='ai-panel-expand-styles';
  s.textContent=
    '.ai-panel-expand{width:26px;height:26px;background:var(--surface2);border:1px solid var(--border);'+
    'border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;'+
    'color:var(--text-m);transition:all 0.2s;flex-shrink:0;}'+
    '.ai-panel-expand:hover{border-color:var(--a);color:var(--a2);background:var(--ag);}'+
    '.ai-panel-head-btns{display:flex;align-items:center;gap:6px;}'+
    'body.ai-expanded #ai-fab{display:none!important;}'+
    '.ai-panel.expanded{bottom:0!important;right:0!important;width:100vw!important;max-width:100vw!important;'+
    'height:100vh!important;max-height:100vh!important;border-radius:0!important;'+
    'transition:all 0.28s cubic-bezier(0.4,0,0.2,1)!important;}'+
    '@media(min-width:769px){.ai-panel.expanded{top:56px!important;bottom:0!important;right:0!important;'+
    'width:480px!important;max-width:480px!important;height:calc(100vh - 56px)!important;'+
    'max-height:calc(100vh - 56px)!important;border-radius:0!important;'+
    'border-right:none!important;border-top:none!important;border-bottom:none!important;}}'+
    '#ai-quick-prompts{padding:6px 12px 8px;border-top:1px solid var(--border);flex-shrink:0;}';
  document.head.appendChild(s);
}

function toggleAIPanelExpand(){
  var panel=document.getElementById('ai-chat-panel');
  var btn=document.getElementById('ai-expand-btn');
  if(!panel||!btn) return;
  aiPanelExpanded=!aiPanelExpanded;
  panel.classList.toggle('expanded',aiPanelExpanded);
  document.body.classList.toggle('ai-expanded',aiPanelExpanded);
  btn.innerHTML=aiPanelExpanded
    ?'<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>'
    :'<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
  btn.title=aiPanelExpanded?'Paliitin':'Palakihin';
  scrollChatToBottom();
}

function patchAIPanelHeader(){
  if(document.getElementById('ai-expand-btn')) return;
  var head=document.querySelector('.ai-panel-head'); if(!head) return;
  var closeBtn=head.querySelector('.ai-panel-close'); if(!closeBtn) return;
  var expandBtn=document.createElement('button');
  expandBtn.className='ai-panel-expand'; expandBtn.id='ai-expand-btn'; expandBtn.title='Palakihin';
  expandBtn.innerHTML='<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
  expandBtn.addEventListener('click',toggleAIPanelExpand);
  var group=document.createElement('div'); group.className='ai-panel-head-btns';
  closeBtn.parentNode.insertBefore(group,closeBtn);
  group.appendChild(expandBtn); group.appendChild(closeBtn);
}

// ─────────────────────────────────────────────────────────────
// PANEL OPEN / CLOSE
// ─────────────────────────────────────────────────────────────
function openAIChat(){
  injectAIPanelStyles(); patchAIPanelHeader();
  aiChatOpen=true;
  var panel=document.getElementById('ai-chat-panel');
  var fab=document.getElementById('ai-fab');
  if(panel) panel.classList.add('open');
  if(fab) fab.classList.add('active');
  var feed=document.getElementById('ai-chat-feed');
  if(feed&&feed.children.length===0){
    cleanJunkMemoryEntries().then(function(cleaned){
      var myNc=(window.allNotes||[]).filter(function(n){return isMyNote(n);}).length;
      var mc=Object.keys(aiMemory||{}).length;
      var br=getBehaviorRules().length;
      appendChatMsg('ai',
        'Hoy! AI Instructor ako.\n\n'+
        'Notes mo: '+myNc+' | Memory: '+mc+' entr'+(mc!==1?'ies':'y')+
        (br?' | '+br+' behavior rule'+(br>1?'s':'')+' active ✓':'')+
        (cleaned.length?'\nAuto-cleaned: '+cleaned.length+' junk entr'+(cleaned.length>1?'ies':'y'):'')+'\n\n'+
        'Lahat ng instructions mo sa memory ay sinusunod ko sa bawat action.\n'+
        'Mag-type ng "huwag mag-save ng [keyword]" para mag-add ng rule.'
      );
      renderQuickPrompts();
    });
  }
  setTimeout(function(){var inp=document.getElementById('ai-chat-input');if(inp)inp.focus();},200);
}

function closeAIChat(){
  aiChatOpen=false; aiPanelExpanded=false;
  document.body.classList.remove('ai-expanded');
  var panel=document.getElementById('ai-chat-panel');
  if(panel) panel.classList.remove('open','expanded');
  var fab=document.getElementById('ai-fab');
  if(fab) fab.classList.remove('active');
  var exbtn=document.getElementById('ai-expand-btn');
  if(exbtn){
    exbtn.innerHTML='<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
    exbtn.title='Palakihin';
  }
  setSendBtn(false);
}

function toggleAIChat(){if(aiChatOpen)closeAIChat();else openAIChat();}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',function(){
  var input=document.getElementById('ai-chat-input'); if(!input) return;
  input.addEventListener('keydown',function(e){
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendAIChat();}
  });
  input.addEventListener('input',function(){
    this.style.height='auto';
    this.style.height=Math.min(this.scrollHeight,120)+'px';
  });
});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){
    if(aiPanelExpanded){toggleAIPanelExpand();return;}
    if(aiChatOpen) closeAIChat();
  }
});