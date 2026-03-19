// ============================================================
// app-ai.js  —  Notes AI Assistant  v2
// ============================================================

const AI_CHAT_HISTORY = [];
let aiChatOpen           = false;
let _pendingAction       = null;
let _quickPromptsVisible = true;
let _chatImgB64          = null;

const AI_SESSION = {
  lastSuggestedFixes : [],
  declinedSuggestions: [],
  confirmedActions   : [],
  openedAt           : Date.now(),
  messageCount       : 0,
};

// ─────────────────────────────────────────────────────────────
// API ENDPOINTS
// Groq handles both text and vision
// ─────────────────────────────────────────────────────────────
const GROQ_URL          = '/api/groq';
const GROQ_TEXT_MODEL   = 'llama-3.3-70b-versatile';
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

/**
 * callLLM — routes to Groq for both text and vision.
 * Returns { choices:[{message:{content:...}}] } shaped object.
 */
async function callLLM(messages, maxTokens, useVision) {
  var model = useVision ? GROQ_VISION_MODEL : GROQ_TEXT_MODEL;
  var r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages })
  });
  return r.json();
}

// ─────────────────────────────────────────────────────────────
// INTENT ENGINE
// ─────────────────────────────────────────────────────────────
const INTENT_PATTERNS = [
  { intent: 'memory_delete_specific',
    patterns: [/\b(bura|tanggal|delete|remove|alisin|i-delete|itanggal)\b.*\b(memory|memorya)\b/,
               /\b(memory|memorya)\b.*\b(bura|tanggal|delete|remove|alisin)\b/] },
  { intent: 'memory_view',
    patterns: [/\b(tingnan|tignan|show|ipakita|view|list|check)\b.*\b(memory|memorya)\b/,
               /\b(memory|memorya)\b.*\b(tingnan|show|view|ano|what)\b/,
               /ano.*\b(memory|memorya)\b/,
               /\bmemory\b.*\?/] },
  { intent: 'memory_clean',
    patterns: [/\b(linis|clean|ayos|check)\b.*\b(memory|memorya)\b/,
               /\b(memory|memorya)\b.*\b(linis|clean|ayos|tanggalin.*lahat)\b/,
               /\b(kung meron|kung may)\b.*\b(tanggal|delete|linis)\b/,
               /\btanggalin\b.*\blahat\b.*\b(memory|memorya)\b/] },
  { intent: 'notes_scan',
    patterns: [/\b(scan|check|suriin|tingnan)\b.*\b(notes|mali|error|wrong|kategor|category)\b/,
               /\b(alin|which)\b.*\b(mali|wrong|error|dapat|should)\b/,
               /\b(i-check|i-scan)\b.*\bnotes\b/] },
  { intent: 'notes_fix_one',
    patterns: [/\b(ayusin|fix|i-fix|baguhin|update|palitan)\b.*\b(note|isang|yung|yong|ito)\b/,
               /\b(note)\b.*\b(ayusin|fix|i-fix|mali|wrong)\b/] },
  { intent: 'notes_bulk_fix',
    patterns: [/\b(bulk|lahat|all|bawat)\b.*\b(fix|ayos|ayusin|update|palitan)\b/,
               /\b(fix|ayos)\b.*\b(lahat|all|bulk)\b/,
               /\b(i-bulk)\b/] },
  { intent: 'behavior_save',
    patterns: [/\b(huwag|wag|never|palagi|always|lagi)\b.*\b(save|i-save|lagay|ilagay|store)\b/,
               /\b(tandaan|remember|i-remember)\b.*\b(rule|batas|dapat)\b/] },
  { intent: 'notes_overview',
    patterns: [/\b(overview|breakdown|summary|buod|ilang|how many)\b.*\bnotes\b/,
               /\bnotes\b.*\b(ilan|ilang|count|lahat|overview)\b/] },
  { intent: 'memory_clear_all',
    patterns: [/\b(clear|burahin|tanggalin)\b.*\b(lahat|all)\b.*\b(memory|memorya)\b/,
               /\b(memory|memorya)\b.*\b(clear all|burahin lahat|tanggalin lahat)\b/] },
  { intent: 'greeting',
    patterns: [/^(hoy|hey|hi|hello|kumusta|sup|uy|oi)[!?.,\s]*$/i,
               /^(kamusta|musta)[!?.,\s]*$/i] },
];

function detectIntent(msg) {
  var lower = msg.toLowerCase().trim();
  for (var i = 0; i < INTENT_PATTERNS.length; i++) {
    var ip = INTENT_PATTERNS[i];
    for (var j = 0; j < ip.patterns.length; j++) {
      if (ip.patterns[j].test(lower)) {
        return { intent: ip.intent, confidence: 'high' };
      }
    }
  }
  if (/\bmemory\b/.test(lower) && /\b(ano|what|show|list)\b/.test(lower))
    return { intent: 'memory_view', confidence: 'medium' };
  if (/\bnotes\b/.test(lower) && /\b(scan|check|mali)\b/.test(lower))
    return { intent: 'notes_scan', confidence: 'medium' };
  return null;
}

function isVagueCleanRequest(lower) {
  return /\b(check|tingnan|tignan|linisin|clean|i-clean|mag-clean|suriin|i-check)\b/.test(lower)
      || /\b(kung meron|kung may|kung mayroon)\b/.test(lower)
      || /\b(lahat|all|everything)\b.*\b(tanggal|delete|remove|clear)\b/.test(lower)
      || /\b(tanggal|delete|remove)\b.*\b(lahat|all|everything)\b/.test(lower);
}

// ─────────────────────────────────────────────────────────────
// BEHAVIOR RULES ENGINE
// ─────────────────────────────────────────────────────────────
function getBehaviorRules() {
  return Object.values(aiMemory || {})
    .filter(function(v){ return v.category === 'BEHAVIOR' || v.behaviorRule; })
    .map(function(v){ return String(v.behaviorRule || v.summary || ''); })
    .filter(Boolean);
}

async function shouldSkipMemorySave(note) {
  var title   = String(note.title   || '').toLowerCase().trim();
  var summary = String(note.summary || '').toLowerCase();

  if (/walang mahalagang impormasyon/.test(summary)) return { skip:true, reason:'walang laman' };
  if (/^(test|testing|try+|sample|pantest|dummy|placeholder)(\s+(note|notes|lang|ito|nito|only|cmd|command))?$/.test(title))
    return { skip:true, reason:'test/try title' };

  var rules = getBehaviorRules();
  for (var ri = 0; ri < rules.length; ri++) {
    var ruleText = rules[ri].toLowerCase();
    var skipKeywords = extractSkipKeywords(ruleText);
    for (var ki = 0; ki < skipKeywords.length; ki++) {
      var kw = skipKeywords[ki];
      if (new RegExp('(^|\\s|_)' + escapeRegex(kw) + '(\\s|_|$)').test(title))
        return { skip:true, reason:'user rule: ' + rules[ri].slice(0,60) };
    }
  }
  return { skip:false, reason:'' };
}

function extractSkipKeywords(ruleText) {
  var keywords = [];
  var knownSkip = ['test','testing','try','sample','pantest','dummy','placeholder',
                   'blank','empty','blangko','walang laman','temp','temporary'];
  knownSkip.forEach(function(k){ if (ruleText.indexOf(k) !== -1) keywords.push(k); });
  var m = ruleText.match(/kapag\s+(\w+)\s+(lang|huwag|di|hindi)/);
  if (m && m[1] && keywords.indexOf(m[1]) === -1) keywords.push(m[1]);
  var m2 = ruleText.match(/\bng\s+(\w+)\s+notes?\b/);
  if (m2 && m2[1] && keywords.indexOf(m2[1]) === -1) keywords.push(m2[1]);
  return keywords;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

// ─────────────────────────────────────────────────────────────
// OVERRIDE window.updateAIMemory
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
      return;
    }
    if (attempts++ < 30) setTimeout(tryInstall, 100);
  }
  tryInstall();
  document.addEventListener('DOMContentLoaded', tryInstall);
})();

// ─────────────────────────────────────────────────────────────
// AUTO-CLEAN JUNK MEMORY
// ─────────────────────────────────────────────────────────────
async function cleanJunkMemoryEntries() {
  var keys = Object.keys(aiMemory || {});
  var cleaned = [];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = aiMemory[k];
    if (v.category === 'BEHAVIOR') continue;
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
// PROACTIVE ANALYSIS
// ─────────────────────────────────────────────────────────────
function analyzeNotesProactively() {
  var myNotes = (window.allNotes || []).filter(function(n){ return isMyNote(n); });
  if (!myNotes.length) return null;

  var issues = [];

  myNotes.forEach(function(n) {
    var titleLower = String(n.title||'').toLowerCase().trim();
    var cat        = String(n.category||'').toUpperCase();
    var raw        = String(n.rawNote||'').toLowerCase().trim();

    if (!n.title || ['untitled','walang laman','no title','n/a'].includes(titleLower))
      issues.push({ type:'bad_title', fbKey:n.fbKey, title:n.title||'(walang title)',
                    msg:'Walang maayos na title' });

    else if (cat === 'OTHER' && raw.length > 30) {
      var hints = {
        IT:       /\b(code|javascript|python|api|server|database|css|html|programming|dev|software|bug|git|react|node)\b/,
        STUDY:    /\b(exam|lesson|lecture|quiz|assignment|review|notes|chapter|topic|study)\b/,
        FREELANCE:/\b(client|project|proposal|freelance|invoice|payment|rate|job|contract)\b/,
        CRYPTO:   /\b(bitcoin|btc|eth|crypto|token|wallet|binance|trading|coin|nft)\b/,
        PERSONAL: /\b(personal|diary|feeling|mood|family|friend|love|health|goal)\b/,
      };
      var detected = null;
      Object.keys(hints).forEach(function(hcat){
        if (hints[hcat].test(raw)) detected = hcat;
      });
      if (detected) issues.push({ type:'wrong_category', fbKey:n.fbKey, title:n.title,
                                   msg:'Maaaring ['+detected+'] tama kaysa [OTHER]',
                                   suggestedCat: detected });
    }
  });

  var titleMap = {};
  myNotes.forEach(function(n){
    var words = String(n.title||'').toLowerCase().split(/\s+/).slice(0,4).join(' ');
    if (words.length < 4) return;
    if (!titleMap[words]) titleMap[words] = [];
    titleMap[words].push(n);
  });
  Object.keys(titleMap).forEach(function(words){
    if (titleMap[words].length >= 2) {
      titleMap[words].forEach(function(n){
        if (!issues.find(function(i){ return i.fbKey===n.fbKey && i.type==='duplicate_title'; }))
          issues.push({ type:'duplicate_title', fbKey:n.fbKey, title:n.title,
                        msg:'Posibleng duplicate ng ibang note' });
      });
    }
  });

  AI_SESSION.lastSuggestedFixes = issues.map(function(i){ return i.fbKey; });
  return issues;
}

function buildProactiveMessage(issues) {
  if (!issues || !issues.length) return null;

  var badTitle = issues.filter(function(i){ return i.type==='bad_title'; });
  var wrongCat = issues.filter(function(i){ return i.type==='wrong_category'; });
  var dupes    = issues.filter(function(i){ return i.type==='duplicate_title'; });

  var lines = ['📊 Na-scan ko ang iyong notes. May nahanap akong pwedeng i-improve:\n'];

  if (badTitle.length) {
    lines.push('⚠️  ' + badTitle.length + ' note' + (badTitle.length>1?'s':'') + ' na walang maayos na title:');
    badTitle.slice(0,3).forEach(function(i){ lines.push('   • "' + i.title + '"'); });
    if (badTitle.length > 3) lines.push('   ... at ' + (badTitle.length-3) + ' pa');
    lines.push('');
  }
  if (wrongCat.length) {
    lines.push('🏷️  ' + wrongCat.length + ' note' + (wrongCat.length>1?'s':'') + ' na maaaring mali ang category:');
    wrongCat.slice(0,3).forEach(function(i){ lines.push('   • "' + i.title + '" → ' + i.msg); });
    if (wrongCat.length > 3) lines.push('   ... at ' + (wrongCat.length-3) + ' pa');
    lines.push('');
  }
  if (dupes.length) {
    lines.push('🔁  ' + dupes.length + ' note' + (dupes.length>1?'s':'') + ' na posibleng duplicate:');
    dupes.slice(0,3).forEach(function(i){ lines.push('   • "' + i.title + '"'); });
    lines.push('');
  }

  lines.push('Gusto mo bang i-fix ko ang mga ito? Sabi mo lang "oo" o "ayusin mo lahat" 😊');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────
function buildAIInstructorPrompt() {
  var myNotes = (window.allNotes || []).filter(function(n){ return isMyNote(n); });

  var notesBlock = myNotes.length
    ? myNotes.map(function(n, i) {
        var t = String(n.title||'').replace(/"/g,"'").slice(0,60);
        var r = String(n.rawNote||'').replace(/\n/g,' ').replace(/"/g,"'").slice(0,100);
        return '['+i+'] fbKey="'+n.fbKey+'" | title="'+t+'" | cat="'+n.category+'" | public='+(n.isPublic===true)
          +(r?' | raw="'+r+'"':'')+(n.imageData?' | hasImage=true':'');
      }).join('\n')
    : '(wala pang notes)';

  var memEntries = Object.entries(aiMemory || {});
  var memBlock = memEntries.length
    ? memEntries.map(function(kv) {
        var k=kv[0], v=kv[1];
        var s=String(v.summary||'').slice(0,80).replace(/"/g,"'");
        var extras = (v.categoryRule?' | RULE:"'+v.categoryRule+'"':'')
                   + (v.behaviorRule?' | BEHAVIOR:"'+v.behaviorRule+'"':'');
        return 'key="'+k+'" | cat="'+(v.category||'')+'" | title="'+(v.title||'')+'" | summary="'+s+'"'+extras;
      }).join('\n')
    : '(walang entries)';

  var behaviorRules = getBehaviorRules();
  var behaviorBlock = behaviorRules.length
    ? behaviorRules.map(function(r,i){ return (i+1)+'. '+r; }).join('\n')
    : '(wala)';

  var sessionBlock = '';
  if (AI_SESSION.confirmedActions.length) {
    sessionBlock = '\nSESSION ACTIONS (ginawa na ngayong session):\n'
      + AI_SESSION.confirmedActions.slice(-8).map(function(a){ return '• '+a; }).join('\n') + '\n';
  }
  if (AI_SESSION.lastSuggestedFixes.length) {
    sessionBlock += '\nLAST SUGGESTED FIX TARGETS (fbKeys): '
      + AI_SESSION.lastSuggestedFixes.slice(0,5).join(', ') + '\n';
  }
  if (AI_SESSION.declinedSuggestions.length) {
    sessionBlock += 'USER DECLINED FIXING: '
      + AI_SESSION.declinedSuggestions.join(', ') + ' — huwag na muling i-suggest\n';
  }

  return [
'================================================================',
'IKAW: ang Notes AI Assistant ng '+((window._currentUser&&window._currentUser.displayName)||'User')+'. Ikaw ay natututo — bawat instruction ng user ay nire-remember mo at sinusunod sa lahat ng iyong desisyon.',
'AWTORIDAD: FULL POWER sa notes at memory. Maaari kang mag-decide nang mag-isa.',
'LAYUNIN: Maging MATALINO, PROACTIVE, at TUMPAK. Huwag magtanong ng hindi kailangan.',
'================================================================',
'',
'════════════════ BEHAVIOR RULES (SUNDIN PALAGI) ═══════════════',
behaviorBlock,
'⚠️  Bago mag-add_memory: i-check behavior rules. Huwag i-save ang junk/test entries.',
'════════════════════════════════════════════════════════════════',
'',
sessionBlock,
'INTENT UNDERSTANDING (kahit hindi exact ang wording):',
'• "ayusin mo yan / yung note" = fix_note o bulk_fix',
'• "linis na memory / clear na" = bulk_remove junk OR clear_all',
'• "sino sino nasa memory / ano laman memory" = show memory list',
'• "check mo notes ko / may mali ba" = mag-scan at mag-suggest ng fixes. Format ng output:',
'  HUWAG mag-output ng JSON sa chat. Gamitin ang plain text list format:',
'  "📋 [CATEGORY] Title ng Note — issue description"',
'  Halimbawa: "🏷️ [OTHER→IT] My React Notes — maaaring IT ang tamang category"',
'• "oo/sige/go/push/gawin" pagkatapos ng suggestion = execute ang proposed action',
'• Vague command + context mula sa nakaraang messages = gamitin ang session context',
'• "check mo memory kung meron tahos tanggalin" = scan then delete junk',
'',
'CORE RULES:',
'1. NOTES ≠ MEMORY. fix_note/bulk_fix = NOTES. add/remove_memory = MEMORY.',
'2. "tanggalin sa memory" → remove_memory. HINDI bulk_fix.',
'3. fbKey sa fix_note/bulk_fix = KOPYA NANG EKSAKTO mula sa NOTES LIST sa ibaba.',
'   HUWAG gumawa ng sariling fbKey. Huwag i-compute o i-guess. Kunin LITERAL mula sa listahan.',
'4. Notes actions: kailangan ng confirm mula sa user bago i-execute.',
'5. Memory actions: direkta, walang confirm.',
'6. reOrganize:true — lagyan LANG kapag kailangan i-rewrite ang organizedContent/summary/keyPoints.',
'   Kung title o category lang ang babaguhin, WALA nang reOrganize.',
'7. rawNote — PWEDE palitan kung EXPLICITLY sinabi ng user na palitan ang content/notes text mismo.',
'   Gamitin ang field "newRawNote":"bagong content" sa loob ng updates para dito.',
'   Halimbawa: user says "palitan mo yung laman ng note na yan ng [bagong text]"',
'   → updates: { "title":"...", "newRawNote":"bagong text na ito" }',
'8. TONE: Makipag-chat lang ng natural, parang kaibigan. Huwag robotic.',
'9. Halimbawa ng magandang tone: "Ay yung note 😄 Mukhang random text yan. Ayusin ko?" — tapos [ACTION].',
'',
'VERIFICATION REMINDER:',
'• Ang executeAIAction() ay mag-veverify kung may ACTUAL na nagbago.',
'• Kung walang magbabago, sasabihin niya ang problema. Huwag mag-assume na okay na.',
'',
'PROACTIVE:',
'• Kung may obvious na mali sa notes → sabihin mo kahit hindi tinatanong.',
'• Mag-suggest ng follow-up actions pagkatapos mag-execute.',
'',
'ACTION FORMATS:',
'fix_note (title/category lang):',
'  {"type":"fix_note","fbKey":"EXACT","updates":{"title":"NEW TITLE","category":"CAT"}}',
'fix_note (palitan ang raw content):',
'  {"type":"fix_note","fbKey":"EXACT","updates":{"title":"NEW","newRawNote":"bagong content"},"reOrganize":true}',
'fix_note (i-rewrite organizedContent):',
'  {"type":"fix_note","fbKey":"EXACT","updates":{"category":"CAT"},"reOrganize":true}',
'bulk_fix:',
'  {"type":"bulk_fix","targets":[{"fbKey":"EXACT","updates":{"category":"CAT"}}],"reason":"...","reOrganize":true}',
'add_memory:',
'  {"type":"add_memory","data":{"key":"slug","title":"...","category":"CAT","summary":"...","categoryRule":"...","behaviorRule":"..."}}',
'update_memory:',
'  {"type":"update_memory","data":{"key":"EXACT_KEY","title":"...","summary":"..."}}',
'remove_memory:',
'  {"type":"remove_memory","data":{"key":"EXACT_KEY"}}',
'bulk_remove_memory:',
'  {"type":"bulk_remove_memory","keys":["key1","key2"]}',
'clear_all_memory:',
'  {"type":"clear_all_memory"}',
'save_behavior_rule:',
'  {"type":"save_behavior_rule","data":{"key":"slug","title":"Short title","behaviorRule":"The exact rule"}}',
'',
'TAG: [ACTION]{...}[/ACTION] — sa DULO ng message.',
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
// RE-ORGANIZER PROMPT
// ─────────────────────────────────────────────────────────────
function buildReOrgPrompt(forcedCategory) {
  var lines = [
    'You are a note organizer. Given raw note content, return ONLY valid JSON with these exact fields:',
    '{',
    '  "title": "short descriptive title based on content",',
    '  "category": "ONE_OF[IT|STUDY|FREELANCE|CRYPTO|PERSONAL|OTHER]",',
    '  "summary": "1-2 sentence summary",',
    '  "keyPoints": ["key point 1", "key point 2"],',
    '  "organizedContent": "well-structured markdown version of the note"',
    '}',
    '',
    'Rules:',
    '- organizedContent: rewrite as clean markdown with headers/bullets where appropriate',
    '- title: max 60 chars, descriptive, based on actual content',
    '- summary: concise, 1-2 sentences only',
    '- keyPoints: array of strings, max 5 items',
    '- DO NOT return rawNote — that field is handled separately',
    forcedCategory ? '- REQUIRED: category MUST be "' + forcedCategory + '". Do not change it.' : '- Pick the most accurate category from the list',
    '',
    'Return ONLY the JSON object. No explanation. No markdown fences. No preamble.',
  ].filter(Boolean);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// EXECUTE ACTION
// ─────────────────────────────────────────────────────────────
async function executeAIAction(actionObj) {
  var type = actionObj.type;

  // ── save_behavior_rule ───────────────────────────────────
  if (type === 'save_behavior_rule') {
    var d = actionObj.data || {};
    if (!d.behaviorRule) return 'Missing behaviorRule.';
    var bkey = (d.key || 'behavior_'+Date.now()).toLowerCase().replace(/[^a-z0-9_]/g,'_').slice(0,60);
    var entry = { title:d.title||'Behavior Rule', category:'BEHAVIOR', summary:d.behaviorRule,
                  behaviorRule:d.behaviorRule, keyPoints:[], updated:Date.now() };
    try {
      if (window._db&&window._update&&window._ref)
        await window._update(window._ref(window._db,'ai_memory'),{[bkey]:entry});
      aiMemory[bkey]=entry; updateMemoryBadge();
      AI_SESSION.confirmedActions.push('Saved behavior rule: "'+d.behaviorRule.slice(0,50)+'"');
      return 'Behavior rule saved: "'+d.behaviorRule+'"';
    } catch(e) { return 'Save failed: '+e.message; }
  }

  // ── fix_note ─────────────────────────────────────────────
  if (type === 'fix_note') {
    var fbKey=actionObj.fbKey, updates=actionObj.updates, reOrganize=actionObj.reOrganize;
    if (!fbKey||!updates) return 'Missing fbKey or updates.';

    var n=window.allNotes.find(function(x){return x.fbKey===fbKey;});
    if (!n) return '⚠️ Hindi mahanap ang note (fbKey: "'+fbKey+'"). Baka nagbago na ang fbKey? Try mo ulit i-scan ang notes.';
    if (!isMyNote(n)) return '⚠️ Hindi mo note ito: "'+n.title+'"';

    if (updates.category) updates.category=updates.category.toUpperCase().replace(/\s+/g,'_');

    var newRawNote = undefined;
    if (updates.newRawNote !== undefined) {
      newRawNote = updates.newRawNote;
      delete updates.newRawNote;
    }

    var finalUpdates = Object.assign({}, updates);

    if (newRawNote !== undefined) {
      finalUpdates.rawNote = newRawNote;
    }

    if (reOrganize === true) {
      try {
        var contentToOrg = newRawNote !== undefined
          ? newRawNote
          : (n.rawNote && n.rawNote !== '[image]' ? n.rawNote : n.organizedContent || n.title);

        var rdata=await callLLM([
          {role:'system',content:buildReOrgPrompt(updates.category||'')},
          {role:'user',content:contentToOrg}
        ], 1800, false);
        if (!rdata.error) {
          var rraw=(rdata.choices[0].message.content||'').replace(/```json|```/g,'').trim();
          var rsi=rraw.indexOf('{'),rei=rraw.lastIndexOf('}');
          var rp=JSON.parse(rsi!==-1&&rei!==-1?rraw.slice(rsi,rei+1):rraw);
          function es(v){return v==null?'':typeof v==='string'?v:Array.isArray(v)?v.join('\n'):String(v);}
          function ea(v){return Array.isArray(v)?v.map(es).filter(Boolean):typeof v==='string'&&v?[v]:[];}
          finalUpdates = Object.assign({
            title:    es(rp.title)||n.title,
            category: es(rp.category).toUpperCase().replace(/\s+/g,'_')||n.category,
            summary:  es(rp.summary),
            keyPoints:ea(rp.keyPoints),
            organizedContent: es(rp.organizedContent)
          }, finalUpdates);
          if (updates.title) finalUpdates.title = updates.title;
          if (updates.category) finalUpdates.category = updates.category;
          if (updates.isPublic !== undefined) finalUpdates.isPublic = updates.isPublic;
        }
      } catch(re){ console.warn('Re-org failed:', re.message); }
    }

    var changed = Object.keys(finalUpdates).filter(function(key) {
      return JSON.stringify(n[key]) !== JSON.stringify(finalUpdates[key]);
    });

    if (!changed.length) {
      return '⚠️ Walang napalitan sa note na "'+n.title+'" — pareho pa rin ang lahat ng values.\n\nPwede mo bang ilarawan nang mas specific kung ano ang gusto mong palitan? Hal: "palitan mo yung laman ng note ng [bagong text]"';
    }

    try {
      if (window._db&&window._update&&window._ref) {
        await window._update(window._ref(window._db,'notes/'+fbKey), finalUpdates);
        await window.updateAIMemory(Object.assign({},n,finalUpdates));
      }
      Object.assign(n, finalUpdates);
      renderApp();
      AI_SESSION.confirmedActions.push('Fixed note: "'+n.title+'"');
      var newTitle = finalUpdates.title || n.title;
      var changedSummary = changed.map(function(k){
        var val = String(finalUpdates[k]).slice(0,50);
        return '  • ' + k + ': "' + val + (String(finalUpdates[k]).length > 50 ? '...' : '') + '"';
      }).join('\n');
      return 'Done na! ✅ Na-update ang "'+newTitle+'":\n'+changedSummary+'\n\nI-refresh ang note para makita ang pagbabago 👀';
    } catch(e){ return '⚠️ Firebase update failed: '+e.message+'\n\nTry mo i-reload ang page at ulit.'; }
  }

  // ── bulk_fix ─────────────────────────────────────────────
  if (type === 'bulk_fix') {
    var targets=actionObj.targets,reason=actionObj.reason,reOrg=actionObj.reOrganize;
    if (!targets||!targets.length) return 'Walang targets.';
    var results=[], skipped=[];
    for (var ti=0;ti<targets.length;ti++) {
      var tgt=targets[ti],tfbKey=tgt.fbKey,tupdates=tgt.updates;
      var tn=window.allNotes.find(function(x){return x.fbKey===tfbKey;});
      if (!tn||!isMyNote(tn)){skipped.push(tfbKey+' (not found/not mine)');continue;}

      if (tupdates.category) tupdates.category=tupdates.category.toUpperCase().replace(/\s+/g,'_');

      var tNewRaw = undefined;
      if (tupdates.newRawNote !== undefined) {
        tNewRaw = tupdates.newRawNote;
        delete tupdates.newRawNote;
      }

      var tFinal = Object.assign({}, tupdates);
      if (tNewRaw !== undefined) tFinal.rawNote = tNewRaw;

      if (reOrg===true) {
        try {
          var tc2 = tNewRaw !== undefined
            ? tNewRaw
            : (tn.rawNote && tn.rawNote !== '[image]' ? tn.rawNote : tn.organizedContent || tn.title);
          var tdata=await callLLM([
            {role:'system',content:buildReOrgPrompt(tupdates.category||'')},
            {role:'user',content:tc2}
          ], 1800, false);
          if (!tdata.error) {
            var traw=(tdata.choices[0].message.content||'').replace(/```json|```/g,'').trim();
            var tsi2=traw.indexOf('{'),tei2=traw.lastIndexOf('}');
            var tp2=JSON.parse(tsi2!==-1&&tei2!==-1?traw.slice(tsi2,tei2+1):traw);
            function tes(v){return v==null?'':typeof v==='string'?v:Array.isArray(v)?v.join('\n'):String(v);}
            function tea(v){return Array.isArray(v)?v.map(tes).filter(Boolean):typeof v==='string'&&v?[v]:[];}
            tFinal = Object.assign({
              category: tupdates.category,
              title:    tupdates.title||tes(tp2.title)||tn.title,
              summary:  tes(tp2.summary),
              keyPoints:tea(tp2.keyPoints),
              organizedContent: tes(tp2.organizedContent)
            }, tFinal);
            if (tupdates.title) tFinal.title = tupdates.title;
            if (tupdates.category) tFinal.category = tupdates.category;
          }
        } catch(re2){console.warn('Bulk re-org fail:',tn.title,re2.message);}
      }

      var tChanged = Object.keys(tFinal).filter(function(key){
        return JSON.stringify(tn[key]) !== JSON.stringify(tFinal[key]);
      });
      if (!tChanged.length) { skipped.push('"'+tn.title+'" (walang pagbabago)'); continue; }

      try {
        if (window._db&&window._update&&window._ref) {
          await window._update(window._ref(window._db,'notes/'+tfbKey),tFinal);
          await window.updateAIMemory(Object.assign({},tn,tFinal));
        }
        Object.assign(tn,tFinal);
        results.push('"'+(tFinal.title||tn.title)+'" → ['+(tFinal.category||tn.category)+']');
      } catch(e2){results.push('"'+tn.title+'": ⚠️ '+e2.message);}
    }
    renderApp();
    AI_SESSION.confirmedActions.push('Bulk fixed '+results.length+' notes');
    var out = '';
    if (results.length) out += 'Tapos na! ✅ '+results.length+' notes na-fix:\n'+results.map(function(r){return'• '+r;}).join('\n');
    if (skipped.length) out += '\n\n⚠️ Skipped ('+skipped.length+'):\n'+skipped.map(function(r){return'• '+r;}).join('\n');
    if (reason) out += '\n\n'+reason;
    out += '\n\nTingnan mo na sa notes list 😊';
    return out;
  }

  // ── add_memory / update_memory ───────────────────────────
  if (type==='add_memory'||type==='update_memory') {
    var d2=actionObj.data||{};
    if (!d2.key&&!d2.title) return 'Need key or title.';
    var mk=(d2.key||((d2.category||'other')+'_'+d2.title)).toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,60);
    var ent={title:d2.title||d2.key,category:d2.category||'OTHER',summary:d2.summary||'',
      keyPoints:d2.keyPoints||[],updated:Date.now()};
    if (d2.categoryRule) ent.categoryRule=d2.categoryRule;
    if (d2.behaviorRule) ent.behaviorRule=d2.behaviorRule;
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

  // ── remove_memory ────────────────────────────────────────
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
      AI_SESSION.confirmedActions.push('Removed memory: "'+rtitle+'"');
      return 'Tinanggal: "'+rtitle+'"';
    } catch(e){return 'Failed: '+e.message;}
  }

  // ── bulk_remove_memory ───────────────────────────────────
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
    AI_SESSION.confirmedActions.push('Bulk removed '+bremoved.length+' memory entries');
    return (bremoved.length?'Tinanggal ('+bremoved.length+'):\n'+bremoved.map(function(r){return'- '+r;}).join('\n'):'')
          +(bfailed.length?'\nHindi mahanap:\n'+bfailed.map(function(f){return'- '+f;}).join('\n'):'');
  }

  // ── clear_all_memory ─────────────────────────────────────
  if (type==='clear_all_memory') {
    try {
      if (window._db&&window._update&&window._ref) {
        var nulls={};
        Object.keys(aiMemory).forEach(function(k){nulls[k]=null;});
        if (Object.keys(nulls).length) await window._update(window._ref(window._db,'ai_memory'),nulls);
      }
      aiMemory={}; updateMemoryBadge();
      AI_SESSION.confirmedActions.push('Cleared all memory');
      return 'Memory cleared.';
    } catch(e){return 'Failed: '+e.message;}
  }

  return 'Unknown action type: '+type;
}

// ─────────────────────────────────────────────────────────────
// DIRECT HANDLERS
// ─────────────────────────────────────────────────────────────
async function tryDirectMemoryDelete(msg) {
  var lower = msg.toLowerCase();
  if (!/tanggal|delete|remove|bura|alisin|i-delete|itanggal/.test(lower)) return false;
  if (!/memory|memorya/.test(lower)) return false;
  if (isVagueCleanRequest(lower)) return false;

  var memKeys = Object.keys(aiMemory || {});
  if (!memKeys.length) { appendChatMsg('ai','Wala nang laman ang AI memory.'); return true; }

  var subject = lower
    .replace(/\b(tanggal|delete|remove|bura|alisin|i-delete|itanggal|sa|ng|ang|yung|mo|na|lahat|memory|memorya|naman|na|nito|ito)\b/g,' ')
    .replace(/\s+/g,' ').trim();
  var subjWords = subject.split(' ').map(function(w){return w.replace(/[^a-z0-9]/g,'');}).filter(function(w){return w.length>1;});

  if (!subjWords.length) return false;

  var toDelete = [];
  var seen = {};
  memKeys.forEach(function(k) {
    if (seen[k]) return;
    var v = aiMemory[k];
    var tl = String(v.title||'').toLowerCase();
    var kl = k.toLowerCase();
    if (lower.includes(kl)) { toDelete.push(k); seen[k]=true; return; }
    if (tl.length>2 && lower.includes(tl)) { toDelete.push(k); seen[k]=true; return; }
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

  if (!toDelete.length) return false;

  var results=[];
  for (var i=0;i<toDelete.length;i++) {
    var dk=toDelete[i];
    try {
      if (window._db&&window._update&&window._ref)
        await window._update(window._ref(window._db,'ai_memory'),{[dk]:null});
      results.push('Tinanggal: "'+(aiMemory[dk].title||dk)+'"');
      delete aiMemory[dk];
    } catch(de){results.push('Failed "'+dk+'": '+de.message);}
  }
  updateMemoryBadge();
  appendChatMsg('ai',results.join('\n'));
  return true;
}

async function tryDirectBehaviorSave(msg) {
  var lower = msg.toLowerCase();
  var isInstruction = /\b(huwag|wag|don.t|never|hindi|palagi|lagi|always|dapat|tandaan|remember|i-remember|mag-save|maglagay|ilagay|huwag)\b/.test(lower);
  var aboutMemory = /\b(save|lagay|ilagay|store|memory|memorya|mag-lagay|maglagay|i-save|isave)\b/.test(lower);
  if (!isInstruction || !aboutMemory) return false;
  if (/\b(tanggal|delete|remove|bura|alisin)\b/.test(lower)) return false;

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
      'Isasama ko ito sa lahat ng desisyon ko mula ngayon ✓\n'+
      'Mahahanap mo ito sa View Memory → BEHAVIOR RULES.'
    );
    return true;
  } catch(e) {
    console.warn('Behavior save failed:',e.message);
    return false;
  }
}

var _pendingProactiveIssues = null;

async function tryProactiveConfirm(msg) {
  if (!_pendingProactiveIssues) return false;
  var lower = msg.toLowerCase().trim();
  var yes = /^(oo|yes|yep|sige|go|ok|tara|push|sure|ayusin|fix|proceed|ayan|yup|gawin|paki|pls|please)/.test(lower);
  var no  = /^(hindi|no|nope|cancel|ayaw|stop|huwag|wag|di na|skip)/.test(lower);

  if (yes) {
    var fixes = _pendingProactiveIssues
      .filter(function(i){ return i.type==='wrong_category' && i.suggestedCat; })
      .map(function(i){ return { fbKey:i.fbKey, updates:{ category:i.suggestedCat } }; });

    if (!fixes.length) {
      appendChatMsg('ai','Wala akong specific na auto-fix para dito. Sabihin mo kung alin ang gusto mong ayusin.');
      _pendingProactiveIssues = null;
      return true;
    }

    _pendingAction = { type:'bulk_fix', targets:fixes, reason:'Proactive category fix', reOrganize:true };
    _pendingProactiveIssues = null;

    var preview = 'Ito ang ifi-fix ko:\n\n';
    fixes.forEach(function(f){
      var n = window.allNotes.find(function(x){ return x.fbKey===f.fbKey; });
      if (n) preview += '• "'+n.title+'" → ['+f.updates.category+']\n';
    });
    preview += '\nI-confirm? ("oo" / "hindi")';
    appendChatMsg('ai', preview);
    return true;
  }

  if (no) {
    (_pendingProactiveIssues||[]).forEach(function(i){
      if (AI_SESSION.declinedSuggestions.indexOf(i.fbKey)===-1)
        AI_SESSION.declinedSuggestions.push(i.fbKey);
    });
    _pendingProactiveIssues = null;
    appendChatMsg('ai','Sige, skip muna. Sabihin mo kung may gusto kang gawin 😊');
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
// CHAT IMAGE ATTACHMENT
// ─────────────────────────────────────────────────────────────
function patchChatInputArea() {
  if (document.getElementById('ai-chat-img-btn')) return;
  var wrap = document.querySelector('.ai-chat-input-wrap');
  if (!wrap) return;

  var fi = document.createElement('input');
  fi.type='file'; fi.accept='image/*'; fi.id='ai-chat-fi';
  fi.style.display='none';
  fi.addEventListener('change', function(e){ var f=e.target.files[0]; if(f) loadChatImg(f); fi.value=''; });
  wrap.parentNode.insertBefore(fi, wrap);

  var strip = document.createElement('div');
  strip.id='ai-chat-img-strip';
  strip.style.cssText='display:none;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--border);background:var(--surface2);flex-shrink:0;';
  strip.innerHTML=
    '<div id="ai-chat-img-thumb" style="position:relative;width:48px;height:48px;border-radius:8px;overflow:hidden;border:1px solid var(--border-h);flex-shrink:0;cursor:zoom-in">'
    +'<img id="ai-chat-img-preview" style="width:100%;height:100%;object-fit:cover;display:block" src="" alt="">'
    +'<button id="ai-chat-img-rm" style="position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:50%;background:rgba(0,0,0,0.75);color:#fff;font-size:9px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0" title="Remove">&#x2715;</button>'
    +'</div>'
    +'<span style="font-size:11px;color:var(--text-m);font-family:\'JetBrains Mono\',monospace">Image attached — AI will analyze it</span>';
  wrap.parentNode.insertBefore(strip, wrap);

  document.getElementById('ai-chat-img-rm').addEventListener('click', function(e){
    e.stopPropagation(); clearChatImg();
  });
  document.getElementById('ai-chat-img-thumb').addEventListener('click', function(){
    var src = document.getElementById('ai-chat-img-preview').src;
    if (src && src !== window.location.href) {
      var lb = document.getElementById('lightbox');
      var lbi = document.getElementById('lightbox-img');
      if (lb && lbi) { lbi.src=src; lb.classList.add('on'); }
    }
  });

  var btn = document.createElement('button');
  btn.id='ai-chat-img-btn';
  btn.style.cssText='width:34px;height:34px;flex-shrink:0;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--text-m);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all 0.18s;';
  btn.title='Attach image';
  btn.innerHTML='<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  btn.addEventListener('mouseenter', function(){ btn.style.borderColor='var(--a)'; btn.style.color='var(--a2)'; });
  btn.addEventListener('mouseleave', function(){ btn.style.borderColor='var(--border)'; btn.style.color='var(--text-m)'; });
  btn.addEventListener('click', function(){ document.getElementById('ai-chat-fi').click(); });
  wrap.insertBefore(btn, wrap.firstChild);

  document.addEventListener('paste', function(e){
    if (!aiChatOpen) return;
    for (var i=0; i<(e.clipboardData&&e.clipboardData.items||[]).length; i++){
      var item = e.clipboardData.items[i];
      if (item.type.startsWith('image/')){
        var f = item.getAsFile(); if (f) { loadChatImg(f); break; }
      }
    }
  });
}

function loadChatImg(file) {
  var r = new FileReader();
  r.onload = function(ev) {
    _chatImgB64 = ev.target.result.split(',')[1];
    var strip = document.getElementById('ai-chat-img-strip');
    var preview = document.getElementById('ai-chat-img-preview');
    if (strip && preview) { preview.src = ev.target.result; strip.style.display='flex'; }
    var btn = document.getElementById('ai-chat-img-btn');
    if (btn) { btn.style.borderColor='var(--a)'; btn.style.color='var(--a2)'; btn.style.background='var(--ag)'; }
    var inp = document.getElementById('ai-chat-input');
    if (inp) inp.focus();
  };
  r.readAsDataURL(file);
}

function clearChatImg() {
  _chatImgB64 = null;
  var strip = document.getElementById('ai-chat-img-strip');
  var preview = document.getElementById('ai-chat-img-preview');
  if (strip) strip.style.display='none';
  if (preview) preview.src='';
  var btn = document.getElementById('ai-chat-img-btn');
  if (btn) { btn.style.borderColor=''; btn.style.color=''; btn.style.background=''; }
}

// ─────────────────────────────────────────────────────────────
// MAIN SEND
// ─────────────────────────────────────────────────────────────
async function sendAIChat() {
  var input = document.getElementById('ai-chat-input');
  var msg = input ? (input.value||'').trim() : '';
  var hasImg = !!_chatImgB64;
  if (!msg && !hasImg) return;
  input.value=''; input.style.height='';
  if (hasImg) {
    appendChatMsgWithImg('user', msg||'🖼️ [image]', _chatImgB64);
  } else {
    appendChatMsg('user', msg);
  }
  AI_SESSION.messageCount++;

  // ── 1. Pending note-action confirmation ─────────────────
  if (_pendingAction) {
    var lower0 = msg.toLowerCase();
    var yes = /^(oo|yes|yep|confirm|go|sige|ok|tara|push|1\b|paki|gawin|proceed|ayan|yup|sure)/i.test(lower0);
    var no  = /^(hindi|no|nope|cancel|ayaw|stop|huwag|wag|2\b|di na)/i.test(lower0);
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
      if (_pendingAction && _pendingAction.targets) {
        _pendingAction.targets.forEach(function(t){
          if (AI_SESSION.declinedSuggestions.indexOf(t.fbKey)===-1)
            AI_SESSION.declinedSuggestions.push(t.fbKey);
        });
      }
      _pendingAction=null;
      AI_CHAT_HISTORY.push({role:'user',content:msg});
      appendChatMsg('ai','Sige, cancelled.');
      AI_CHAT_HISTORY.push({role:'assistant',content:'Cancelled.'});
      scrollChatToBottom(); return;
    }
    _pendingAction=null;
  }

  // ── 2. Proactive suggestion confirm/decline ──────────────
  var handledProactive = await tryProactiveConfirm(msg);
  if (handledProactive) {
    AI_CHAT_HISTORY.push({role:'user',content:msg});
    AI_CHAT_HISTORY.push({role:'assistant',content:'(proactive handled)'});
    scrollChatToBottom(); return;
  }

  // ── 3. Intent detection ──────────────────────────────────
  var intentResult = detectIntent(msg);

  if (intentResult && intentResult.intent === 'memory_view') {
    showMemoryDirect();
    AI_CHAT_HISTORY.push({role:'user',content:msg});
    AI_CHAT_HISTORY.push({role:'assistant',content:'(memory view)'});
    scrollChatToBottom(); return;
  }

  if (intentResult && intentResult.intent === 'notes_overview') {
    showOverviewModal();
    AI_CHAT_HISTORY.push({role:'user',content:msg});
    AI_CHAT_HISTORY.push({role:'assistant',content:'(notes overview)'});
    scrollChatToBottom(); return;
  }

  // ── 4. Direct JS handlers ────────────────────────────────
  var didDelete   = await tryDirectMemoryDelete(msg);
  var didBehavior = !didDelete && await tryDirectBehaviorSave(msg);
  if (didDelete||didBehavior) {
    AI_CHAT_HISTORY.push({role:'user',content:msg});
    AI_CHAT_HISTORY.push({role:'assistant',content:'(handled directly)'});
    scrollChatToBottom(); return;
  }

  // ── 5. Full AI call ──────────────────────────────────────
  var augmentedMsg = intentResult
    ? msg + '\n[DETECTED INTENT: '+intentResult.intent+']'
    : msg;

  var currentImgB64 = _chatImgB64;
  clearChatImg();

  var historyUserContent = currentImgB64
    ? [ {type:'text', text:augmentedMsg||'Analyze this image in context of my notes.'},
        {type:'image_url', image_url:{url:'data:image/jpeg;base64,'+currentImgB64}} ]
    : augmentedMsg;
  AI_CHAT_HISTORY.push({role:'user', content: msg||'[image]'});

  var tid=appendChatTyping();
  setSendBtn(true);

  var historyForAI = AI_CHAT_HISTORY.slice(-20).slice();
  var lastIdx = historyForAI.length - 1;
  historyForAI[lastIdx] = {role:'user', content: historyUserContent};

  var useVision = !!currentImgB64;
  // Vision → Groq vision model (system prompt as first user block, API limitation)
  // Text  → Groq text model
  var apiMessages = useVision
    ? [{role:'user', content:[{type:'text',text:buildAIInstructorPrompt()+'\n\nNow respond to the user:'}]}].concat(historyForAI)
    : [{role:'system', content:buildAIInstructorPrompt()}].concat(historyForAI);

  try {
    var data=await callLLM(apiMessages, 1200, useVision);
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

      var isMemAction=['add_memory','update_memory','remove_memory',
                        'bulk_remove_memory','clear_all_memory','save_behavior_rule'].indexOf(actionObj.type)!==-1;
      var isNoteAction=['fix_note','bulk_fix'].indexOf(actionObj.type)!==-1;

      if (isMemAction) {
        var mr=await executeAIAction(actionObj);
        if (mr) cleanReply=cleanReply?cleanReply+'\n\n'+mr:mr;
        appendChatMsg('ai',cleanReply||mr);
      } else if (isNoteAction) {
        _pendingAction=actionObj;
        var preview=cleanReply.replace(/DAPAT I-CONFIRM:?/gi,'').trim();
        if (actionObj.type==='bulk_fix'&&actionObj.targets) {
          var lines=actionObj.targets.map(function(t){
            var n=window.allNotes.find(function(x){return x.fbKey===t.fbKey;});
            var ch=Object.entries(t.updates||{}).map(function(kv){return kv[0]+'="'+kv[1]+'"';}).join(', ');
            return n?'• "'+n.title+'" → '+ch:'• fbKey:'+t.fbKey+' → '+ch;
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
function cleanAIReply(text) {
  text = text.replace(/\[ACTION\][\s\S]*?\[\/ACTION\]/g, '').trim();
  text = text.replace(/```json[\s\S]*?```/g, '').trim();
  text = text.replace(/```[\s\S]*?```/g, '').trim();
  text = text.replace(/(\n|^)\s*[\[{][\s\S]{0,2000}?[\]}]\s*(\n|$)/gm, '\n').trim();
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

function appendChatMsg(role,text){
  var feed=document.getElementById('ai-chat-feed'); if(!feed) return;
  var display = role === 'ai' ? cleanAIReply(text) : text;
  var div=document.createElement('div'); div.className='aicm aicm-'+role;
  div.innerHTML='<div class="aicm-bubble">'+escChat(display)
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/\n/g,'<br>')+'</div>';
  feed.appendChild(div); scrollChatToBottom();
}
function appendChatMsgWithImg(role, text, imgB64){
  var feed=document.getElementById('ai-chat-feed'); if(!feed) return;
  var div=document.createElement('div'); div.className='aicm aicm-'+role;
  var bubble=document.createElement('div'); bubble.className='aicm-bubble';
  var imgWrap=document.createElement('div');
  imgWrap.style.cssText='margin-bottom:6px;border-radius:10px;overflow:hidden;max-width:180px;border:1px solid rgba(255,255,255,0.1);cursor:zoom-in';
  var img=document.createElement('img');
  img.src='data:image/jpeg;base64,'+imgB64;
  img.style.cssText='width:100%;display:block;max-height:120px;object-fit:cover';
  img.addEventListener('click',function(){
    var lb=document.getElementById('lightbox'),lbi=document.getElementById('lightbox-img');
    if(lb&&lbi){lbi.src=img.src;lb.classList.add('on');}
  });
  imgWrap.appendChild(img); bubble.appendChild(imgWrap);
  if(text&&text!=='🖼️ [image]'){
    var txt=document.createElement('div');
    txt.innerHTML=escChat(text).replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>');
    bubble.appendChild(txt);
  }
  div.appendChild(bubble); feed.appendChild(div); scrollChatToBottom();
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
// AI MODALS
// ─────────────────────────────────────────────────────────────
function injectAIModalStyles(){
  if(document.getElementById('ai-modal-styles')) return;
  var s=document.createElement('style'); s.id='ai-modal-styles';
  s.textContent=`
.ai-modal-overlay{position:fixed;inset:0;z-index:500;background:rgba(0,0,0,0.82);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;padding:16px;animation:aimo-in 0.2s ease}
@keyframes aimo-in{from{opacity:0}to{opacity:1}}
.ai-modal{background:var(--surface);border:1px solid var(--border-h);border-radius:20px;width:100%;max-width:640px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 28px 90px rgba(0,0,0,0.65);animation:aimo-slide 0.25s cubic-bezier(0.34,1.56,0.64,1)}
@keyframes aimo-slide{from{opacity:0;transform:translateY(20px) scale(0.97)}to{opacity:1;transform:none}}
.ai-modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--border);flex-shrink:0}
.ai-modal-title{font-size:15px;font-weight:800;color:var(--text-b);display:flex;align-items:center;gap:8px}
.ai-modal-close{width:30px;height:30px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;color:var(--text-m);transition:all 0.2s}
.ai-modal-close:hover{border-color:var(--red);color:var(--red)}
.ai-modal-tabs{display:flex;gap:0;padding:0 20px;border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto;scrollbar-width:none}
.ai-modal-tabs::-webkit-scrollbar{display:none}
.ai-modal-tab{padding:10px 14px;font-size:12px;font-weight:700;font-family:'Outfit',sans-serif;cursor:pointer;color:var(--text-m);background:none;border:none;border-bottom:2px solid transparent;transition:all 0.2s;white-space:nowrap;flex-shrink:0}
.ai-modal-tab.active{color:var(--a2);border-bottom-color:var(--a2)}
.ai-modal-tab:hover:not(.active){color:var(--text-b)}
.ai-modal-body{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px}
.ai-modal-body::-webkit-scrollbar{width:4px}
.ai-modal-body::-webkit-scrollbar-thumb{background:var(--border-h);border-radius:2px}
.ai-mem-card{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:13px 15px;display:flex;align-items:flex-start;gap:12px;transition:border-color 0.2s}
.ai-mem-card:hover{border-color:var(--border-h)}
.ai-mem-card-ico{font-size:18px;flex-shrink:0;margin-top:1px}
.ai-mem-card-body{flex:1;min-width:0}
.ai-mem-card-title{font-size:13px;font-weight:700;color:var(--text-b);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ai-mem-card-sub{font-size:11.5px;color:var(--text);line-height:1.5}
.ai-mem-card-key{font-size:10px;color:var(--text-m);font-family:'JetBrains Mono',monospace;margin-top:4px}
.ai-mem-card-actions{display:flex;gap:5px;flex-shrink:0;align-items:center}
.ai-mem-card-del{width:30px;height:30px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.35);border-radius:7px;color:#f87171;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;transition:all 0.2s}
.ai-mem-card-del:hover{background:rgba(248,113,113,0.18);border-color:#f87171;transform:scale(1.08)}
.ai-mem-card-edit{width:30px;height:30px;background:rgba(251,146,60,0.08);border:1px solid rgba(251,146,60,0.35);border-radius:7px;color:#fb923c;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;transition:all 0.2s}
.ai-mem-card-edit:hover{background:rgba(251,146,60,0.18);border-color:#fb923c;transform:scale(1.08)}
.ai-mem-edit-modal{position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.85);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;padding:16px}
.ai-mem-edit-box{background:var(--surface);border:1px solid var(--border-h);border-radius:18px;width:100%;max-width:480px;padding:22px;display:flex;flex-direction:column;gap:14px;box-shadow:0 24px 80px rgba(0,0,0,0.6);animation:aimo-slide 0.22s cubic-bezier(0.34,1.56,0.64,1)}
.ai-mem-edit-title{font-size:14px;font-weight:800;color:var(--text-b);display:flex;align-items:center;gap:8px}
.ai-mem-edit-field{display:flex;flex-direction:column;gap:5px}
.ai-mem-edit-label{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--a2);font-family:'JetBrains Mono',monospace}
.ai-mem-edit-input{background:var(--surface2);border:1px solid var(--border);border-radius:9px;color:var(--text-b);font-family:'Outfit',sans-serif;font-size:13px;padding:9px 12px;outline:none;transition:all 0.2s;width:100%}
.ai-mem-edit-input:focus{border-color:var(--a);box-shadow:0 0 0 3px var(--ag)}
.ai-mem-edit-ta{resize:vertical;min-height:80px;line-height:1.6;font-family:'JetBrains Mono',monospace;font-size:12px}
.ai-mem-edit-foot{display:flex;gap:8px;justify-content:flex-end;padding-top:4px}
.ai-mem-edit-save{padding:9px 20px;border:none;border-radius:9px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;font-family:'Outfit',sans-serif;font-size:13px;font-weight:700;cursor:pointer;transition:all 0.2s}
.ai-mem-edit-save:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(59,130,246,0.4)}
.ai-mem-edit-cancel{padding:9px 16px;border:1px solid var(--border);border-radius:9px;background:var(--surface2);color:var(--text-m);font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.2s}
.ai-mem-edit-cancel:hover{border-color:var(--border-h);color:var(--text-b)}
.ai-sec-label{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--a2);font-family:'JetBrains Mono',monospace;padding:4px 0 2px}
.ai-empty-state{text-align:center;padding:32px 20px;color:var(--text-m);font-size:13px}
.ai-empty-state .ico{font-size:32px;display:block;margin-bottom:8px;opacity:0.3}
.ai-overview-row{display:flex;align-items:center;gap:12px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:12px 15px}
.ai-overview-bar-wrap{flex:1;height:6px;background:var(--surface3);border-radius:3px;overflow:hidden}
.ai-overview-bar{height:100%;border-radius:3px;transition:width 0.6s cubic-bezier(0.4,0,0.2,1)}
.ai-overview-count{font-size:12px;font-weight:700;color:var(--text-b);font-family:'JetBrains Mono',monospace;flex-shrink:0;min-width:28px;text-align:right}
.ai-overview-cat{font-size:12px;font-weight:700;min-width:90px;flex-shrink:0}
.ai-notes-list-item{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:11px 14px;cursor:pointer;transition:all 0.18s}
.ai-notes-list-item:hover{border-color:var(--border-h);transform:translateX(3px)}
.ai-notes-list-item-title{font-size:13px;font-weight:700;color:var(--text-b);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ai-notes-list-item-meta{font-size:11px;color:var(--text-m);display:flex;gap:8px}
.ai-search-wrap{display:flex;align-items:center;gap:7px;background:var(--surface2);border:1px solid var(--border);border-radius:9px;padding:7px 11px;margin-bottom:4px;transition:all 0.2s}
.ai-search-wrap:focus-within{border-color:var(--a);box-shadow:0 0 0 3px var(--ag)}
.ai-search-input{background:none;border:none;outline:none;color:var(--text-b);font-family:'Outfit',sans-serif;font-size:13px;width:100%}
.ai-search-input::placeholder{color:var(--text-m)}
`;
  document.head.appendChild(s);
}

function closeAIModal(){
  var ov=document.getElementById('ai-modal-overlay');
  if(ov) ov.remove();
}

function openAIModal(titleHtml, renderFn, tabs){
  injectAIModalStyles();
  closeAIModal();

  var ov=document.createElement('div');
  ov.className='ai-modal-overlay'; ov.id='ai-modal-overlay';
  ov.addEventListener('click',function(e){ if(e.target===ov) closeAIModal(); });

  var modal=document.createElement('div'); modal.className='ai-modal';

  var head=document.createElement('div'); head.className='ai-modal-head';
  var titleEl=document.createElement('div'); titleEl.className='ai-modal-title'; titleEl.innerHTML=titleHtml;
  var closeBtn=document.createElement('button'); closeBtn.className='ai-modal-close'; closeBtn.innerHTML='&#x2715;';
  closeBtn.addEventListener('click', closeAIModal);
  head.appendChild(titleEl); head.appendChild(closeBtn); modal.appendChild(head);

  if(tabs&&tabs.length){
    var tabBar=document.createElement('div'); tabBar.className='ai-modal-tabs';
    tabs.forEach(function(t,i){
      var tb=document.createElement('button'); tb.className='ai-modal-tab'+(i===0?' active':'');
      tb.textContent=t.label;
      tb.addEventListener('click',function(){
        tabBar.querySelectorAll('.ai-modal-tab').forEach(function(b){b.classList.remove('active');});
        tb.classList.add('active');
        body.innerHTML='';
        t.render(body);
      });
      tabBar.appendChild(tb);
    });
    modal.appendChild(tabBar);
  }

  var body=document.createElement('div'); body.className='ai-modal-body';
  renderFn(body);
  modal.appendChild(body);

  ov.appendChild(modal);
  document.body.appendChild(ov);

  var escHandler=function(e){
    if(e.key==='Escape'){ closeAIModal(); document.removeEventListener('keydown',escHandler); }
  };
  document.addEventListener('keydown',escHandler);
}

// ── Show Memory Modal ────────────────────────────────────────
function showMemoryDirect(){
  var entries=Object.entries(aiMemory||{});
  if(!entries.length){
    appendChatMsg('ai','AI Memory ay EMPTY.\n\nSabihin mo lang ang isang instruction at itatanda ko, hal: "huwag mag-save ng testing notes".');
    return;
  }

  var behaviors=entries.filter(function(e){return e[1].category==='BEHAVIOR'||e[1].behaviorRule;});
  var rules    =entries.filter(function(e){return e[1].categoryRule&&!e[1].behaviorRule;});
  var topics   =entries.filter(function(e){return !e[1].behaviorRule&&!e[1].categoryRule&&e[1].category!=='BEHAVIOR';});

  function openMemEditModal(kv) {
    var existing = document.getElementById('ai-mem-edit-modal');
    if (existing) existing.remove();

    var v = kv[1], k = kv[0];
    var overlay = document.createElement('div');
    overlay.className = 'ai-mem-edit-modal'; overlay.id = 'ai-mem-edit-modal';

    var box = document.createElement('div'); box.className = 'ai-mem-edit-box';

    var titleEl = document.createElement('div'); titleEl.className = 'ai-mem-edit-title';
    titleEl.innerHTML = '✏️ Edit Memory Entry';
    box.appendChild(titleEl);

    var fTitle = document.createElement('div'); fTitle.className = 'ai-mem-edit-field';
    var lTitle = document.createElement('div'); lTitle.className = 'ai-mem-edit-label'; lTitle.textContent = 'Title';
    var iTitle = document.createElement('input'); iTitle.className = 'ai-mem-edit-input';
    iTitle.value = v.title || k;
    fTitle.appendChild(lTitle); fTitle.appendChild(iTitle); box.appendChild(fTitle);

    var summaryVal = v.behaviorRule || v.categoryRule || v.summary || '';
    var fSum = document.createElement('div'); fSum.className = 'ai-mem-edit-field';
    var lSum = document.createElement('div'); lSum.className = 'ai-mem-edit-label';
    lSum.textContent = v.behaviorRule ? 'Behavior Rule' : v.categoryRule ? 'Category Rule' : 'Summary';
    var iSum = document.createElement('textarea'); iSum.className = 'ai-mem-edit-input ai-mem-edit-ta';
    iSum.value = summaryVal;
    fSum.appendChild(lSum); fSum.appendChild(iSum); box.appendChild(fSum);

    var fCat = document.createElement('div'); fCat.className = 'ai-mem-edit-field';
    var lCat = document.createElement('div'); lCat.className = 'ai-mem-edit-label'; lCat.textContent = 'Category';
    var iCat = document.createElement('input'); iCat.className = 'ai-mem-edit-input';
    iCat.value = v.category || 'OTHER';
    fCat.appendChild(lCat); fCat.appendChild(iCat); box.appendChild(fCat);

    var foot = document.createElement('div'); foot.className = 'ai-mem-edit-foot';
    var cancelBtn = document.createElement('button'); cancelBtn.className = 'ai-mem-edit-cancel'; cancelBtn.textContent = 'Cancel';
    var saveBtn = document.createElement('button'); saveBtn.className = 'ai-mem-edit-save'; saveBtn.textContent = '💾 Save';

    cancelBtn.addEventListener('click', function(){ overlay.remove(); });
    overlay.addEventListener('click', function(e){ if(e.target===overlay) overlay.remove(); });

    saveBtn.addEventListener('click', async function(){
      saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
      var newTitle   = iTitle.value.trim() || v.title || k;
      var newSummary = iSum.value.trim();
      var newCat     = iCat.value.trim().toUpperCase().replace(/\s+/g,'_') || v.category || 'OTHER';

      var updated = Object.assign({}, v, {
        title:    newTitle,
        category: newCat,
        summary:  newSummary,
        updated:  Date.now(),
      });
      if (v.behaviorRule) updated.behaviorRule = newSummary;
      if (v.categoryRule) updated.categoryRule = newSummary;

      try {
        if (window._db && window._update && window._ref)
          await window._update(window._ref(window._db, 'ai_memory'), { [k]: updated });
        aiMemory[k] = updated;
        updateMemoryBadge();
        appendChatMsg('ai', '✅ Na-update ang memory entry: "' + newTitle + '"');
        overlay.remove();
        closeAIModal();
        setTimeout(showMemoryDirect, 150);
      } catch(e) {
        appendChatMsg('ai', '⚠️ Save failed: ' + e.message);
        saveBtn.disabled = false; saveBtn.textContent = '💾 Save';
      }
    });

    foot.appendChild(cancelBtn); foot.appendChild(saveBtn);
    box.appendChild(foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    setTimeout(function(){ iTitle.focus(); iTitle.select(); }, 80);
  }

  function makeCard(kv, ico, sub){
    var card=document.createElement('div'); card.className='ai-mem-card';
    var icoEl=document.createElement('div'); icoEl.className='ai-mem-card-ico'; icoEl.textContent=ico;
    var bodyEl=document.createElement('div'); bodyEl.className='ai-mem-card-body';
    var titleEl=document.createElement('div'); titleEl.className='ai-mem-card-title'; titleEl.textContent=kv[1].title||kv[0];
    var subEl=document.createElement('div'); subEl.className='ai-mem-card-sub'; subEl.textContent=sub;
    var keyEl=document.createElement('div'); keyEl.className='ai-mem-card-key'; keyEl.textContent='key: '+kv[0];
    bodyEl.appendChild(titleEl); bodyEl.appendChild(subEl); bodyEl.appendChild(keyEl);
    card.appendChild(icoEl); card.appendChild(bodyEl);

    var actions = document.createElement('div'); actions.className = 'ai-mem-card-actions';

    var edit = document.createElement('button'); edit.className = 'ai-mem-card-edit';
    edit.title = 'Edit'; edit.innerHTML = '✏️';
    edit.addEventListener('click', function(){ openMemEditModal(kv); });
    actions.appendChild(edit);

    var del=document.createElement('button'); del.className='ai-mem-card-del';
    del.title='Delete'; del.innerHTML='🗑️';
    del.addEventListener('click',function(){
      if(!confirm('Delete "'+( kv[1].title||kv[0])+'"?')) return;
      executeAIAction({type:'remove_memory',data:{key:kv[0]}}).then(function(r){
        appendChatMsg('ai',r);
        closeAIModal();
        setTimeout(showMemoryDirect,150);
      });
    });
    actions.appendChild(del);

    card.appendChild(actions);
    return card;
  }

  function renderMemory(body){
    if(behaviors.length){
      var lbl=document.createElement('div'); lbl.className='ai-sec-label'; lbl.textContent='BEHAVIOR RULES ('+behaviors.length+')';
      body.appendChild(lbl);
      behaviors.forEach(function(kv){ body.appendChild(makeCard(kv,'🔒',kv[1].behaviorRule||kv[1].summary||'')); });
    }
    if(rules.length){
      var lbl2=document.createElement('div'); lbl2.className='ai-sec-label'; lbl2.textContent='CATEGORY RULES ('+rules.length+')';
      body.appendChild(lbl2);
      rules.forEach(function(kv){ body.appendChild(makeCard(kv,'📋',kv[1].categoryRule||'')); });
    }
    if(topics.length){
      var lbl3=document.createElement('div'); lbl3.className='ai-sec-label'; lbl3.textContent='LEARNED TOPICS ('+topics.length+')';
      body.appendChild(lbl3);
      topics.forEach(function(kv){
        var s=String(kv[1].summary||'').slice(0,90)+(String(kv[1].summary||'').length>90?'...':'');
        body.appendChild(makeCard(kv,'['+kv[1].category+']',s));
      });
    }
  }

  openAIModal(
    '\uD83E\uDDE0 AI Memory \u00A0<span style="font-size:11px;font-weight:600;color:var(--text-m);background:var(--ag);padding:2px 8px;border-radius:10px;">'+entries.length+' entries</span>',
    renderMemory
  );
}

function editMemoryDirect(){ showMemoryDirect(); }

// ── Notes Overview Modal ─────────────────────────────────────
function showOverviewModal(){
  var myNotes=(window.allNotes||[]).filter(function(n){return isMyNote(n);});
  if(!myNotes.length){ appendChatMsg('ai','Wala ka pang notes!'); return; }

  var catColors={IT:'#3b82f6',STUDY:'#22d3ee',FREELANCE:'#fbbf24',CRYPTO:'#fb923c',PERSONAL:'#818cf8',OTHER:'#94a3b8'};
  function getCatColor(c){ return catColors[c]||'#60a5fa'; }

  function renderOverview(body){
    var catMap={};
    myNotes.forEach(function(n){ catMap[n.category]=(catMap[n.category]||0)+1; });
    var cats=Object.entries(catMap).sort(function(a,b){return b[1]-a[1];});
    var max=cats[0][1];

    var lbl=document.createElement('div'); lbl.className='ai-sec-label'; lbl.textContent='PER CATEGORY';
    body.appendChild(lbl);

    cats.forEach(function(kv){
      var row=document.createElement('div'); row.className='ai-overview-row';
      var catEl=document.createElement('div'); catEl.className='ai-overview-cat';
      catEl.style.cssText='font-size:12px;font-weight:700;color:'+getCatColor(kv[0]);
      catEl.textContent=(typeof getCatEmoji==='function'?getCatEmoji(kv[0]):'')+' '+kv[0];
      var barWrap=document.createElement('div'); barWrap.className='ai-overview-bar-wrap';
      var bar=document.createElement('div'); bar.className='ai-overview-bar';
      bar.style.cssText='width:'+(kv[1]/max*100)+'%;background:'+getCatColor(kv[0]);
      barWrap.appendChild(bar);
      var cnt=document.createElement('div'); cnt.className='ai-overview-count'; cnt.textContent=kv[1];
      row.appendChild(catEl); row.appendChild(barWrap); row.appendChild(cnt);
      body.appendChild(row);
    });

    var statsRow=document.createElement('div'); statsRow.style.cssText='display:flex;gap:8px;margin-top:4px';
    var pub=myNotes.filter(function(n){return n.isPublic===true;}).length;
    [[myNotes.length,'📝','Total','var(--a2)'],[pub,'🌐','Public','var(--cyan)'],[myNotes.length-pub,'🔒','Private','var(--purple)']].forEach(function(s){
      var box=document.createElement('div');
      box.style.cssText='flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;text-align:center';
      box.innerHTML='<div style="font-size:18px">'+s[1]+'</div><div style="font-size:18px;font-weight:900;color:'+s[3]+'">'+s[0]+'</div><div style="font-size:10px;color:var(--text-m)">'+s[2]+'</div>';
      statsRow.appendChild(box);
    });
    body.appendChild(statsRow);
  }

  function renderNotesList(body, filterCat){
    var filtered=filterCat?myNotes.filter(function(n){return n.category===filterCat;}):myNotes;
    var sw=document.createElement('div'); sw.className='ai-search-wrap';
    sw.innerHTML='<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
    var si=document.createElement('input'); si.className='ai-search-input'; si.placeholder='Search notes...';
    sw.appendChild(si); body.appendChild(sw);
    var listWrap=document.createElement('div'); listWrap.style.cssText='display:flex;flex-direction:column;gap:6px';
    body.appendChild(listWrap);
    function renderList(notes){
      listWrap.innerHTML='';
      if(!notes.length){ listWrap.innerHTML='<div class="ai-empty-state"><span class="ico">&#128269;</span>Walang nahanap</div>'; return; }
      notes.forEach(function(n){
        var item=document.createElement('div'); item.className='ai-notes-list-item';
        var titleStr=String(n.title||'Untitled').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        item.innerHTML='<div class="ai-notes-list-item-title">'+titleStr+'</div>'
          +'<div class="ai-notes-list-item-meta"><span style="color:'+getCatColor(n.category)+'">'+n.category+'</span>'
          +'<span>'+(n.isPublic?'🌐':'🔒')+'</span><span>'+(n.date||'')+'</span></div>';
        item.addEventListener('click',function(){ closeAIModal(); if(typeof openView==='function') openView(n.fbKey||n.id); });
        listWrap.appendChild(item);
      });
    }
    renderList(filtered);
    si.addEventListener('input',function(){
      var q=si.value.toLowerCase();
      renderList(q?filtered.filter(function(n){return (n.title+n.summary+n.category).toLowerCase().includes(q);}):filtered);
    });
  }

  var catMap2={};
  myNotes.forEach(function(n){ catMap2[n.category]=(catMap2[n.category]||0)+1; });
  var tabs=[
    {label:'📊 Overview', render:renderOverview},
    {label:'📝 All ('+myNotes.length+')', render:function(b){renderNotesList(b,null);}},
  ];
  Object.keys(catMap2).sort().forEach(function(c){
    tabs.push({label:(typeof getCatEmoji==='function'?getCatEmoji(c):'')+' '+c+' ('+catMap2[c]+')', render:function(cc){ return function(b){renderNotesList(b,cc);}; }(c)});
  });

  openAIModal('&#128202; Notes Overview', tabs[0].render, tabs);
}

// ─────────────────────────────────────────────────────────────
// QUICK PROMPTS
// ─────────────────────────────────────────────────────────────
var AI_QUICK_PROMPTS=[
  {label:'🔍 Scan notes',   text:'I-scan mo ang lahat ng notes ko at sabihin mo kung alin ang posibleng mali ang category, title, o content.'},
  {label:'🔧 Fix one note', text:'Gusto kong ayusin ang isang specific na note. Itanong mo sa akin kung alin.'},
  {label:'⚡ Bulk fix',     text:'Gusto kong i-bulk fix ang category ng maraming notes. Itanong mo kung anong category ang papalitan.'},
  {label:'📋 Add rule',     text:'Gusto ko magdagdag ng category rule sa memory. Itanong mo sa akin ang details.'},
  {label:'🧠 View memory',  action:'showMemoryDirect'},
  {label:'📊 Overview',     action:'showOverviewModal'},
  {label:'✏️ Edit memory',  action:'editMemoryDirect'},
  {label:'🗑️ Clear memory', text:'Gusto kong i-clear ang lahat ng AI memory. Kumpirmahin mo muna.'},
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
      if(p.action==='showOverviewModal'){showOverviewModal();return;}
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
  injectAIPanelStyles(); patchAIPanelHeader(); patchChatInputArea();
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
        'Hi! Ako ang iyong Notes AI Assistant 👋\n\n'+
        'Pwede mo akong turuan — sabihin mo lang kung paano mo gusto ko mag-behave at itatanda ko para sa lahat ng susunod na gagawin ko.\n\n'+
        'Halimbawa: "huwag mag-save ng testing notes", "palaging IT ang category ng code notes", "laging private ang personal notes ko" — lahat ng ganyan, natatandaan ko. 💡\n\n'+
        '📝 Notes: '+myNc+' | 🧠 Memory: '+mc+' entr'+(mc!==1?'ies':'y')+
        (br?' | '+br+' rule'+(br>1?'s':'')+' active ✓':'')+
        (cleaned.length?'\n🧹 Auto-cleaned: '+cleaned.length+' junk entr'+(cleaned.length>1?'ies':'y'):'')+'\n\n'+
        'Tanungin mo ako ng kahit ano — kahit "ayusin mo notes ko" o "linis memory" ay gets ko na 😎'
      );

      setTimeout(function(){
        if (myNc > 0) {
          var issues = analyzeNotesProactively();
          var proactiveMsg = buildProactiveMessage(issues);
          if (proactiveMsg) {
            _pendingProactiveIssues = issues;
            appendChatMsg('ai', proactiveMsg);
          }
        }
        renderQuickPrompts();
      }, 800);
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
  setTimeout(function patchOpenView(){
    if(typeof window.openView==='function' && !window._openViewPatched){
      var _origOpenView = window.openView;
      window.openView = function(idOrFbKey){
        _origOpenView.apply(this, arguments);
        setTimeout(function(){
          var mvBody = document.getElementById('mv-body');
          if(!mvBody) return;
          var note = (window.allNotes||[]).find(function(n){ return n.fbKey===idOrFbKey||String(n.id)===String(idOrFbKey); });
          if(!note) return;
          if(!note.organizedContent || note.organizedContent===note.rawNote) return;
          var boxes = mvBody.querySelectorAll('.vs-box');
          if(boxes.length > 0){
            var firstBox = boxes[0];
            var rawText = String(note.rawNote||'').trim();
            var orgText = String(note.organizedContent||'').trim();
            if(firstBox.textContent.trim()===rawText && orgText && orgText!==rawText){
              firstBox.innerHTML = orgText.replace(/\n/g,'<br>');
            }
          }
        }, 80);
      };
      window._openViewPatched = true;
    } else if(!window._openViewPatched) {
      setTimeout(patchOpenView, 200);
    }
  }, 500);

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
