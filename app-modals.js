// ============================================================
// app-modals.js — View Modal, Edit Modal, Lightbox
// Depends on: app.html globals (allNotes, GROQ_URL, aiMemory,
//   isMyNote, getCatPill, getCatEmoji, displayTitle, str, esc,
//   toggleNoteVisibility, delNote, buildSysPrompt, updateAIMemory,
//   showToast, openLightbox, closeLightbox)
// ============================================================

// ── shared state for modals ──────────────────────────────────
let currentViewKey=null,currentViewNote=null,currentViewTab='notes';
let editingKey=null,editB64=null;

// ============================================================
// LIGHTBOX
// ============================================================
function openLightbox(src){
  document.getElementById('lightbox-img').src=src||'';
  document.getElementById('lightbox').classList.add('on');
}
function closeLightbox(){
  document.getElementById('lightbox').classList.remove('on');
}

// ============================================================
// VIEW MODAL
// ============================================================
function switchViewTab(t){
  currentViewTab=t;
  document.getElementById('mvt-notes').classList.toggle('on',t==='notes');
  document.getElementById('mvt-summary').classList.toggle('on',t==='summary');
  renderViewBody();
}

function renderViewBody(){
  const n=currentViewNote; if(!n)return;
  const body=document.getElementById('mv-body');

  if(currentViewTab==='notes'){
    const imgHtml=n.imageData
      ?`<div style="margin-bottom:14px;border-radius:10px;overflow:hidden;border:1px solid var(--border);cursor:zoom-in"
           onclick="openLightbox('data:image/jpeg;base64,${n.imageData}')" title="Click to enlarge">
          <img src="data:image/jpeg;base64,${n.imageData}"
               style="width:100%;display:block;max-height:260px;object-fit:contain;background:var(--surface2)">
          <div style="padding:5px 10px;background:var(--surface3);font-size:10px;color:var(--text-m);
                      font-family:'JetBrains Mono',monospace;display:flex;align-items:center;gap:5px">
            <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
            </svg>Tap to enlarge
          </div>
        </div>`
      :'';
    const display=str(n.rawNote)||str(n.organizedContent);
    const isEmpty=!display.trim()||display==='[image]';
    const copyBtn=`<div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button onclick="copyNotes()" style="display:flex;align-items:center;gap:6px;background:var(--ag);
        border:1px solid var(--border-h);border-radius:8px;color:var(--a2);font-size:12px;font-weight:600;
        padding:6px 13px;cursor:pointer;font-family:'Outfit',sans-serif">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>Copy
      </button></div>`;
    const noteBox=isEmpty
      ?`<div style="color:var(--text-m);font-style:italic;font-size:13px;text-align:center;padding:30px 0">
           Walang text — image note ito.</div>`
      :`<div style="white-space:pre-wrap;font-family:'JetBrains Mono',monospace;font-size:13px;
                   line-height:1.85;color:var(--text-b);background:var(--surface2);
                   border:1px solid var(--border);border-radius:12px;padding:16px">${esc(display)}</div>`;
    body.innerHTML=imgHtml+copyBtn+noteBox;

  }else{
    let kps=[];
    if(Array.isArray(n.keyPoints))kps=n.keyPoints.map(k=>str(k)).filter(k=>k.trim());
    else if(n.keyPoints&&typeof n.keyPoints==='object')kps=Object.values(n.keyPoints).map(str).filter(k=>k.trim());
    else if(typeof n.keyPoints==='string'&&n.keyPoints.trim())kps=[n.keyPoints];
    const sText=str(n.summary).trim();
    const badS=['','walang mahalagang impormasyon','walang laman','no summary','n/a'];
    const sumHtml=badS.includes(sText.toLowerCase())
      ?`<span style="color:var(--text-m);font-style:italic;font-size:13px">Walang summary.</span>`
      :esc(sText);
    const kpHtml=kps.length
      ?`<div class="vs"><div class="vs-l">🔑 Key Points</div>
           <div class="kp-list">${kps.map(p=>`<div class="kp-item"><span class="kp-arrow">→</span><span>${esc(p)}</span></div>`).join('')}</div></div>`
      :`<div class="vs"><div class="vs-l">🔑 Key Points</div>
           <div style="color:var(--text-m);font-style:italic;font-size:13px">Wala.</div></div>`;
    body.innerHTML=`<div class="vs"><div class="vs-l">💡 Summary</div><div class="vs-box">${sumHtml}</div></div>${kpHtml}`;
  }
}

function copyNotes(){
  const n=currentViewNote; if(!n)return;
  const text=str(n.rawNote)||str(n.organizedContent);
  navigator.clipboard.writeText(text).then(()=>showToast('Copied!')).catch(()=>{
    const ta=document.createElement('textarea');
    ta.value=text;ta.style.cssText='position:fixed;opacity:0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');
    document.body.removeChild(ta);showToast('Copied!');
  });
}

function openView(key){
  const n=window.allNotes.find(x=>(x.fbKey===key||String(x.id)===String(key)));
  if(!n)return;
  currentViewKey=key; currentViewNote=n; currentViewTab='notes';
  const isPub=n.isPublic===true;
  const mine=isMyNote(n);
  document.getElementById('mv-meta').innerHTML=`
    <span ${getCatPill(n.category)} style="font-size:11px">${getCatEmoji(n.category)} ${n.category}</span>
    <span style="font-size:11px;color:var(--text-m);font-family:'JetBrains Mono',monospace">${n.date||''}${n.time ? ' · ' + n.time : ''}</span>
    ${n.author?`<span style="font-size:11px;color:var(--text-m)">· ${esc(n.author)}</span>`:''}`;
  document.getElementById('mv-title').textContent=displayTitle(n);
  document.getElementById('mv-vis-area').innerHTML=mine
    ?`<span class="vis-badge ${isPub?'pub':'priv'} toggle" style="cursor:pointer;font-size:11px"
         onclick="toggleNoteVisibility('${n.fbKey||''}',${isPub},event)">
         ${isPub?'🌐 Public':'🔒 Private'}
         <span style="opacity:0.4;font-size:9px;margin-left:4px">· toggle</span></span>`
    :`<span class="vis-badge pub" style="font-size:11px">🌐 Public</span>`;
  document.getElementById('mv-foot-r').innerHTML=mine
    ?`<button class="mfbtn edit" onclick="openEdit('${key}')">✏️ Edit</button>
       <button class="mfbtn del" onclick="delNote('${n.fbKey||''}',${n.id},null)">🗑️ Delete</button>`
    :'';
  document.getElementById('mvt-notes').classList.add('on');
  document.getElementById('mvt-summary').classList.remove('on');
  renderViewBody();
  document.getElementById('ov-view').classList.add('on');
}

function closeView(){
  document.getElementById('ov-view').classList.remove('on');
  currentViewKey=null; currentViewNote=null;
}

// ============================================================
// EDIT MODAL — image attach / replace / remove support
// ============================================================
function onEditFile(e){
  const f=e.target.files[0]; if(!f)return;
  const r=new FileReader();
  r.onload=ev=>{
    editB64=ev.target.result.split(',')[1];
    const chip=document.getElementById('ef-img-chip-img');
    const strip=document.getElementById('ef-img-strip');
    const noimg=document.getElementById('ef-noimg');
    if(chip)chip.src=ev.target.result;
    if(strip)strip.style.display='flex';
    if(noimg)noimg.style.display='none';
    showToast('🖼️ Image updated!');
  };
  r.readAsDataURL(f);
}

function removeEditImg(){
  editB64='__REMOVE__';
  const strip=document.getElementById('ef-img-strip');
  const noimg=document.getElementById('ef-noimg');
  if(strip)strip.style.display='none';
  if(noimg)noimg.style.display='flex';
}

function openEdit(key){
  const n=window.allNotes.find(x=>(x.fbKey===key||String(x.id)===String(key)));
  if(!n)return;
  if(!isMyNote(n)){showToast('⚠️ Hindi mo ma-edit ang notes ng iba.');return;}
  editingKey=key;
  editB64=null;
  document.getElementById('ef-fi').value='';
  const rawVal=str(n.rawNote)||str(n.organizedContent);
  const hasImg=!!(n.imageData);
  const imgSrc=hasImg?`data:image/jpeg;base64,${n.imageData}`:'';

  document.getElementById('me-body').innerHTML=`
    <div class="ef">
      <div class="ef-l">Image ${hasImg?'':'(optional)'}</div>
      <div id="ef-img-strip" style="display:${hasImg?'flex':'none'};align-items:flex-start;gap:10px;margin-bottom:4px">
        <div class="ef-img-chip" onclick="openLightbox('${imgSrc}')" title="Click to enlarge">
          <img id="ef-img-chip-img" src="${imgSrc}" alt="image">
        </div>
        <div class="ef-img-actions">
          <button type="button" class="ef-img-btn" onclick="document.getElementById('ef-fi').click()">🔄 Replace</button>
          <button type="button" class="ef-img-btn" style="color:var(--red);border-color:rgba(248,113,113,0.3)"
                  onclick="removeEditImg()">🗑️ Remove</button>
        </div>
      </div>
      <div id="ef-noimg" style="display:${hasImg?'none':'flex'};align-items:center;gap:8px">
        <button type="button" class="ef-img-btn" onclick="document.getElementById('ef-fi').click()">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>Attach Image
        </button>
        <span style="font-size:11px;color:var(--text-m)">or paste Ctrl+V</span>
      </div>
    </div>
    <div class="ef">
      <div class="ef-l">Title</div>
      <input class="ef-in" id="ef-title" value="${esc(n.title)}">
    </div>
    <div class="ef-row">
      <div class="ef">
        <div class="ef-l">Category</div>
        <input class="ef-in" id="ef-cat" value="${esc(n.category)}" placeholder="IT, STUDY, CRYPTO...">
      </div>
      <div class="ef">
        <div class="ef-l">Visibility</div>
        <select class="ef-in" id="ef-vis">
          <option value="public" ${n.isPublic!==false?'selected':''}>🌐 Public</option>
          <option value="private" ${n.isPublic===false?'selected':''}>🔒 Private</option>
        </select>
      </div>
    </div>
    <div class="ef" style="display:flex;flex-direction:column">
      <div class="ef-l">Text Notes</div>
      <textarea class="ef-in ef-ta tall" id="ef-rawnote"
                style="min-height:180px">${esc(rawVal==='[image]'?'':rawVal)}</textarea>
    </div>
    <div style="background:var(--ag2);border:1px solid var(--border);border-radius:8px;padding:9px 13px;
                font-size:12px;color:var(--text-m);display:flex;align-items:center;gap:8px;margin-top:4px">
      <span>🤖</span><span>I-save — mag-re-organize si AI.</span>
    </div>`;

  // Allow paste into edit modal body
  document.getElementById('me-body').onpaste=function(e){
    for(const item of e.clipboardData?.items||[]){
      if(item.type.startsWith('image/')){
        const f=item.getAsFile(); if(!f)return;
        const r2=new FileReader();
        r2.onload=ev2=>{
          editB64=ev2.target.result.split(',')[1];
          const chip=document.getElementById('ef-img-chip-img');
          const strip=document.getElementById('ef-img-strip');
          const noimg=document.getElementById('ef-noimg');
          if(chip){
            chip.src=ev2.target.result;
            chip.parentElement.onclick=()=>openLightbox(ev2.target.result);
          }else{
            strip.innerHTML=`
              <div class="ef-img-chip" onclick="openLightbox('${ev2.target.result}')" title="Click to enlarge">
                <img id="ef-img-chip-img" src="${ev2.target.result}" alt="image">
              </div>
              <div class="ef-img-actions">
                <button type="button" class="ef-img-btn" onclick="document.getElementById('ef-fi').click()">🔄 Replace</button>
                <button type="button" class="ef-img-btn" style="color:var(--red);border-color:rgba(248,113,113,0.3)"
                        onclick="removeEditImg()">🗑️ Remove</button>
              </div>`;
          }
          if(strip)strip.style.display='flex';
          if(noimg)noimg.style.display='none';
          showToast('📋 Image pasted!');
        };
        r2.readAsDataURL(f); break;
      }
    }
  };

  closeView();
  document.getElementById('ov-edit').classList.add('on');
}

function closeEdit(){
  document.getElementById('ov-edit').classList.remove('on');
  editingKey=null; editB64=null;
}

async function saveEdit(){
  if(!editingKey)return;
  const n=window.allNotes.find(x=>(x.fbKey===editingKey||String(x.id)===String(editingKey)));
  if(!n)return;
  if(!isMyNote(n)){showToast('⚠️ Hindi mo ma-edit ang notes ng iba.');closeEdit();return;}

  const title=document.getElementById('ef-title').value.trim()||n.title;
  const category=(document.getElementById('ef-cat').value.trim()||n.category).toUpperCase().replace(/\s+/g,'_');
  const isPublic=document.getElementById('ef-vis').value==='public';
  const rawNote=document.getElementById('ef-rawnote').value.trim();

  let imageData=n.imageData||'';
  if(editB64==='__REMOVE__')imageData='';
  else if(editB64)imageData=editB64;

  const btn=document.getElementById('save-btn');
  btn.disabled=true;
  btn.innerHTML='<span style="animation:blk 1s infinite alternate;display:inline-block">🤖 Re-organizing...</span>';

  try{
    function ensureStr(v){if(v==null)return'';if(typeof v==='string')return v;if(typeof v==='object')return Object.entries(v).map(([k,vv])=>k+': '+vv).join('\n');return String(v);}
    function ensureArr(v){if(Array.isArray(v))return v.map(ensureStr).filter(Boolean);if(typeof v==='string'&&v)return[v];return[];}
    function parseAI(raw){
      raw=raw.replace(/```json|```/g,'').trim();
      const s=raw.indexOf('{'),e=raw.lastIndexOf('}');
      if(s!==-1&&e!==-1)raw=raw.slice(s,e+1);
      return JSON.parse(raw);
    }

    const newSource=imageData?'img':'text';
    let updates={title,category,isPublic,rawNote,imageData,source:newSource};

    if(imageData&&rawNote){
      try{
        const textBlock=`${buildSysPrompt()}\n\nBasahin at i-organize. May dagdag na text context:\n\n${rawNote}`;
        const res=await fetch(GROQ_URL,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({model:'meta-llama/llama-4-scout-17b-16e-instruct',max_tokens:1800,
            messages:[{role:'user',content:[{type:'text',text:textBlock},{type:'image_url',image_url:{url:`data:image/jpeg;base64,${imageData}`}}]}]})});
        const data=await res.json();
        if(!data.error){
          const p=parseAI(data.choices[0].message.content);
          updates={...updates,
            title:title||(ensureStr(p.title)||'Untitled'),
            category:category!==n.category?category:(ensureStr(p.category)||'OTHER').toUpperCase().replace(/\s+/g,'_'),
            summary:ensureStr(p.summary),keyPoints:ensureArr(p.keyPoints),organizedContent:ensureStr(p.organizedContent)};
        }
      }catch(e){console.error('Vision+text re-org:',e);}

    }else if(imageData){
      try{
        const res=await fetch(GROQ_URL,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({model:'meta-llama/llama-4-scout-17b-16e-instruct',max_tokens:1800,
            messages:[{role:'user',content:[
              {type:'text',text:buildSysPrompt()+'\n\nBasahin at i-organize ang notes sa image. Return PURE JSON only.'},
              {type:'image_url',image_url:{url:`data:image/jpeg;base64,${imageData}`}}]}]})});
        const data=await res.json();
        if(!data.error){
          const p=parseAI(data.choices[0].message.content);
          updates={...updates,
            title:title||(ensureStr(p.title)||'Untitled'),
            category:category!==n.category?category:(ensureStr(p.category)||'OTHER').toUpperCase().replace(/\s+/g,'_'),
            summary:ensureStr(p.summary),keyPoints:ensureArr(p.keyPoints),organizedContent:ensureStr(p.organizedContent)};
        }
      }catch(e){console.error('Vision re-org:',e);}

    }else if(rawNote){
      try{
        const res=await fetch(GROQ_URL,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:1800,
            messages:[{role:'system',content:buildSysPrompt()},{role:'user',content:'I-organize:\n\n'+rawNote}]})});
        const data=await res.json();
        if(!data.error){
          const p=parseAI(data.choices[0].message.content);
          updates={...updates,
            title:title||(ensureStr(p.title)||'Untitled'),
            category:category!==n.category?category:(ensureStr(p.category)||'OTHER').toUpperCase().replace(/\s+/g,'_'),
            summary:ensureStr(p.summary),keyPoints:ensureArr(p.keyPoints),organizedContent:ensureStr(p.organizedContent)};
        }
      }catch(e){console.error('Text re-org:',e);}
    }

    if(window._db&&window._update&&window._ref&&n.fbKey){
      await window._update(window._ref(window._db,`notes/${n.fbKey}`),updates);
      await updateAIMemory({...n,...updates});
    }else{
      Object.assign(n,updates);
      renderApp();
      await updateAIMemory({...n,...updates});
    }
    showToast('✅ Updated & re-organized!');
    closeEdit();

  }catch(err){
    console.error(err);
    showToast('⚠️ Failed: '+err.message);
  }

  btn.disabled=false;
  btn.innerHTML='<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Changes';
}

// Close all modals on Escape
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeView();closeEdit();closeLightbox();}
});