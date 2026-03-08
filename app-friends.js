// ============================================================
// app-friends.js — Friend System + Note Sharing
// Firebase structure:
//   /users/{uid}                          → { displayName, email, uid }
//   /friend_requests/{uid}/received/{fromUid} → { fromUid, displayName, status:'pending' }
//   /friends/{uid}/{friendUid}            → { uid, displayName }
//   /notes/{fbKey}/sharedWith/{uid}       → true
// ============================================================

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
window.myFriends        = {};   // { uid: { uid, displayName } }
window.pendingRequests  = {};   // { fromUid: { fromUid, displayName, status } }
window.sentRequests     = {};   // { toUid: true }

// ─────────────────────────────────────────────────────────────
// INIT — called after Firebase ready
// ─────────────────────────────────────────────────────────────
function initFriendSystem() {
  var user = window._currentUser;
  if (!user || !window._db) return;

  var uid = user.uid;

  // Register self in /users
  window._update(window._ref(window._db, 'users/' + uid), {
    uid: uid,
    displayName: user.displayName || user.email.split('@')[0],
    email: user.email,
    updatedAt: Date.now(),
  }).catch(function(e){ console.warn('User register failed:', e.message); });

  // Listen: my friends
  window._onValue(window._ref(window._db, 'friends/' + uid), function(snap) {
    window.myFriends = snap.val() || {};
    renderFriendsUI();
    updateFriendBadge();
  });

  // Listen: incoming requests
  window._onValue(window._ref(window._db, 'friend_requests/' + uid + '/received'), function(snap) {
    window.pendingRequests = snap.val() || {};
    updateFriendBadge();
    renderFriendsUI();
  });

  // Listen: sent requests (to know which buttons to disable)
  window._onValue(window._ref(window._db, 'friend_requests/' + uid + '/sent'), function(snap) {
    window.sentRequests = snap.val() || {};
    renderFriendsUI();
  });
}

// ─────────────────────────────────────────────────────────────
// FRIEND BADGE on nav
// ─────────────────────────────────────────────────────────────
function updateFriendBadge() {
  var count = Object.keys(window.pendingRequests || {}).filter(function(k) {
    return (window.pendingRequests[k].status === 'pending');
  }).length;
  var badge = document.getElementById('friend-notif-badge');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
}

// ─────────────────────────────────────────────────────────────
// SEARCH USERS
// ─────────────────────────────────────────────────────────────
async function searchUsers(query) {
  if (!query || query.length < 2) return [];
  query = query.toLowerCase().trim();
  var meUid = window._currentUser.uid;

  try {
    var snap = await window._get(window._ref(window._db, 'users'));
    if (!snap.exists()) return [];
    var all = snap.val();
    return Object.values(all).filter(function(u) {
      if (u.uid === meUid) return false;
      var name = (u.displayName || '').toLowerCase();
      var email = (u.email || '').toLowerCase();
      return name.includes(query) || email.includes(query);
    }).slice(0, 8);
  } catch(e) {
    console.error('Search failed:', e);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// SEND FRIEND REQUEST
// ─────────────────────────────────────────────────────────────
async function sendFriendRequest(toUid, toDisplayName) {
  var me = window._currentUser;
  var myName = me.displayName || me.email.split('@')[0];

  try {
    var updates = {};
    // Their received
    updates['friend_requests/' + toUid + '/received/' + me.uid] = {
      fromUid: me.uid,
      displayName: myName,
      status: 'pending',
      sentAt: Date.now(),
    };
    // My sent
    updates['friend_requests/' + me.uid + '/sent/' + toUid] = {
      toUid: toUid,
      displayName: toDisplayName,
      sentAt: Date.now(),
    };
    await window._update(window._ref(window._db, '/'), updates);
    showToast('📨 Request sent to ' + toDisplayName + '!');
  } catch(e) {
    showToast('⚠️ Failed: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// ACCEPT FRIEND REQUEST
// ─────────────────────────────────────────────────────────────
async function acceptFriendRequest(fromUid) {
  var me = window._currentUser;
  var myName = me.displayName || me.email.split('@')[0];
  var req = window.pendingRequests[fromUid];
  if (!req) return;

  try {
    var updates = {};
    // Add to each other's friends list
    updates['friends/' + me.uid + '/' + fromUid] = { uid: fromUid, displayName: req.displayName };
    updates['friends/' + fromUid + '/' + me.uid] = { uid: me.uid, displayName: myName };
    // Remove requests
    updates['friend_requests/' + me.uid + '/received/' + fromUid] = null;
    updates['friend_requests/' + fromUid + '/sent/' + me.uid] = null;
    await window._update(window._ref(window._db, '/'), updates);
    showToast('🎉 Now friends with ' + req.displayName + '!');
  } catch(e) {
    showToast('⚠️ Failed: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// DECLINE / REMOVE FRIEND
// ─────────────────────────────────────────────────────────────
async function declineFriendRequest(fromUid) {
  var me = window._currentUser;
  try {
    var updates = {};
    updates['friend_requests/' + me.uid + '/received/' + fromUid] = null;
    updates['friend_requests/' + fromUid + '/sent/' + me.uid] = null;
    await window._update(window._ref(window._db, '/'), updates);
    showToast('Request declined.');
  } catch(e) {
    showToast('⚠️ ' + e.message);
  }
}

async function removeFriend(friendUid) {
  var me = window._currentUser;
  if (!confirm('Remove this friend?')) return;
  try {
    var updates = {};
    updates['friends/' + me.uid + '/' + friendUid] = null;
    updates['friends/' + friendUid + '/' + me.uid] = null;
    await window._update(window._ref(window._db, '/'), updates);
    showToast('Friend removed.');
  } catch(e) {
    showToast('⚠️ ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// SHARE NOTE with friends
// ─────────────────────────────────────────────────────────────
async function shareNoteWith(fbKey, selectedUids) {
  if (!fbKey || !selectedUids.length) return;
  try {
    var updates = {};
    selectedUids.forEach(function(uid) {
      updates['notes/' + fbKey + '/sharedWith/' + uid] = true;
    });
    await window._update(window._ref(window._db, '/'), updates);
    showToast('✅ Shared with ' + selectedUids.length + ' friend' + (selectedUids.length > 1 ? 's' : '') + '!');
  } catch(e) {
    showToast('⚠️ Share failed: ' + e.message);
  }
}

async function unshareNoteWith(fbKey, uid) {
  try {
    await window._update(window._ref(window._db, '/'), {
      ['notes/' + fbKey + '/sharedWith/' + uid]: null
    });
    showToast('Unshared.');
  } catch(e) {
    showToast('⚠️ ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// SHARE MODAL — opens from note card/view
// ─────────────────────────────────────────────────────────────
function openShareModal(fbKey) {
  injectFriendStyles();
  var existing = document.getElementById('share-modal-overlay');
  if (existing) existing.remove();

  // Always read fresh from allNotes (realtime-updated by Firebase onValue)
  var note = (window.allNotes || []).find(function(n){ return n.fbKey === fbKey; });
  if (!note) return;

  var friends = Object.values(window.myFriends || {});
  var sharedWith = note.sharedWith || {};

  var overlay = document.createElement('div');
  overlay.className = 'friend-overlay'; overlay.id = 'share-modal-overlay';
  overlay.addEventListener('click', function(e){ if(e.target===overlay) overlay.remove(); });

  var box = document.createElement('div'); box.className = 'friend-modal';

  // Header
  var head = document.createElement('div'); head.className = 'friend-modal-head';
  head.innerHTML = '<div class="friend-modal-title">🔗 Share Note</div>';
  var closeBtn = document.createElement('button'); closeBtn.className = 'friend-modal-close'; closeBtn.innerHTML = '✕';
  closeBtn.addEventListener('click', function(){ overlay.remove(); });
  head.appendChild(closeBtn); box.appendChild(head);

  // Note preview
  var preview = document.createElement('div'); preview.className = 'share-note-preview';
  preview.innerHTML = '<span class="share-note-cat">' + (note.category||'NOTE') + '</span>'
    + '<span class="share-note-title">' + esc2(note.title||'Untitled') + '</span>';
  box.appendChild(preview);

  var body = document.createElement('div'); body.className = 'friend-modal-body';

  if (!friends.length) {
    body.innerHTML = '<div class="friend-empty">Wala ka pang friends!<br><span>Mag-add muna ng friends sa Friends tab</span></div>';
  } else {
    // Selected UIDs tracker
    var selected = {};
    Object.keys(sharedWith).forEach(function(uid){ selected[uid] = true; });

    var lbl = document.createElement('div'); lbl.className = 'friend-sec-label';
    lbl.textContent = 'SELECT FRIENDS TO SHARE WITH';
    body.appendChild(lbl);

    friends.forEach(function(f) {
      var row = document.createElement('div'); row.className = 'share-friend-row';
      var isChecked = !!selected[f.uid];

      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'share-cb';
      cb.checked = isChecked; cb.id = 'scb-' + f.uid;
      cb.addEventListener('change', function(){
        if (cb.checked) selected[f.uid] = true;
        else delete selected[f.uid];
      });

      var lbRow = document.createElement('label'); lbRow.htmlFor = 'scb-' + f.uid;
      lbRow.className = 'share-friend-label';

      var av = document.createElement('div'); av.className = 'friend-avatar';
      av.textContent = (f.displayName||'?')[0].toUpperCase();

      var name = document.createElement('div'); name.className = 'share-friend-name';
      name.textContent = f.displayName || f.uid;

      var alreadyTag = '';
      if (sharedWith[f.uid]) {
        var tag = document.createElement('span'); tag.className = 'share-already-tag';
        tag.textContent = 'shared';
        name.appendChild(tag);
      }

      lbRow.appendChild(av); lbRow.appendChild(name);
      row.appendChild(cb); row.appendChild(lbRow);

      // Unshare button if already shared
      if (sharedWith[f.uid]) {
        var unBtn = document.createElement('button'); unBtn.className = 'share-unshare-btn';
        unBtn.textContent = '✕ Remove';
        unBtn.addEventListener('click', async function(){
          await unshareNoteWith(fbKey, f.uid);
          overlay.remove();
          // Refresh note data
          if (typeof openView === 'function') { closeView && closeView(); }
        });
        row.appendChild(unBtn);
      }

      body.appendChild(row);
    });

    // Share button
    var foot = document.createElement('div'); foot.className = 'friend-modal-foot';
    var shareBtn = document.createElement('button'); shareBtn.className = 'friend-action-btn';
    shareBtn.innerHTML = '🔗 Share';
    shareBtn.addEventListener('click', async function(){
      var newUids = Object.keys(selected).filter(function(uid){ return !sharedWith[uid]; });
      if (!newUids.length) { overlay.remove(); return; }
      shareBtn.disabled = true; shareBtn.textContent = 'Sharing...';
      await shareNoteWith(fbKey, newUids);
      overlay.remove();
    });
    foot.appendChild(shareBtn);
    box.appendChild(body);
    box.appendChild(foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return;
  }

  box.appendChild(body);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// ─────────────────────────────────────────────────────────────
// FRIENDS PANEL MODAL
// ─────────────────────────────────────────────────────────────
function openFriendsPanel() {
  injectFriendStyles();
  var existing = document.getElementById('friends-panel-overlay');
  if (existing) { existing.remove(); return; }

  var overlay = document.createElement('div');
  overlay.className = 'friend-overlay'; overlay.id = 'friends-panel-overlay';
  overlay.addEventListener('click', function(e){ if(e.target===overlay) cleanup(); });

  var box = document.createElement('div'); box.className = 'friend-modal friend-panel-wide';

  // Header
  var head = document.createElement('div'); head.className = 'friend-modal-head';
  head.innerHTML = '<div class="friend-modal-title">👥 Friends</div>';
  var closeBtn = document.createElement('button'); closeBtn.className = 'friend-modal-close'; closeBtn.innerHTML = '✕';
  closeBtn.addEventListener('click', cleanup);
  head.appendChild(closeBtn); box.appendChild(head);

  // Tabs
  var tabs = document.createElement('div'); tabs.className = 'friend-tabs';

  var pendingCount = Object.keys(window.pendingRequests||{}).filter(function(k){return window.pendingRequests[k].status==='pending';}).length;

  var tabDefs = [
    { id:'friends',   label:'Friends (' + Object.keys(window.myFriends||{}).length + ')' },
    { id:'requests',  label:'Requests' + (pendingCount > 0 ? ' 🔴' : '') },
    { id:'search',    label:'+ Add Friend' },
  ];

  var bodies = {};
  var activeTab = 'friends';

  tabDefs.forEach(function(t, i){
    var btn = document.createElement('button'); btn.className = 'friend-tab' + (i===0?' active':'');
    btn.textContent = t.label; btn.dataset.tab = t.id; btn.id = 'ftab-btn-' + t.id;
    btn.addEventListener('click', function(){
      tabs.querySelectorAll('.friend-tab').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      activeTab = t.id;
      Object.keys(bodies).forEach(function(k){ bodies[k].style.display = 'none'; });
      bodies[t.id].style.display = 'flex';
      // Re-render on tab switch to reflect latest data
      refreshTab(t.id);
    });
    tabs.appendChild(btn);
  });
  box.appendChild(tabs);

  var bodyWrap = document.createElement('div'); bodyWrap.className = 'friend-modal-body';

  // ── FRIENDS LIST ──
  var fBody = document.createElement('div'); fBody.className = 'friend-tab-body'; fBody.id = 'ftab-friends';
  bodies['friends'] = fBody;
  renderFriendsList(fBody);

  // ── REQUESTS ──
  var rBody = document.createElement('div'); rBody.className = 'friend-tab-body'; rBody.id = 'ftab-requests';
  rBody.style.display = 'none';
  bodies['requests'] = rBody;
  renderRequestsList(rBody);

  // ── SEARCH / ADD ──
  var sBody = document.createElement('div'); sBody.className = 'friend-tab-body'; sBody.id = 'ftab-search';
  sBody.style.display = 'none';
  bodies['search'] = sBody;
  renderSearchPanel(sBody);

  bodyWrap.appendChild(fBody);
  bodyWrap.appendChild(rBody);
  bodyWrap.appendChild(sBody);
  box.appendChild(bodyWrap);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // ── REALTIME: re-render active tab when data changes ──
  function refreshTab(tab) {
    if (tab === 'friends') renderFriendsList(bodies['friends']);
    else if (tab === 'requests') renderRequestsList(bodies['requests']);
    updateTabLabels();
  }

  function updateTabLabels() {
    var pc = Object.keys(window.pendingRequests||{}).filter(function(k){return window.pendingRequests[k].status==='pending';}).length;
    var fb = document.getElementById('ftab-btn-friends'); if(fb) fb.textContent = 'Friends (' + Object.keys(window.myFriends||{}).length + ')';
    var rb = document.getElementById('ftab-btn-requests'); if(rb) rb.textContent = 'Requests' + (pc > 0 ? ' 🔴' : '');
  }

  // Poll-free: hook into existing onValue streams via a watcher interval
  // (onValue listeners already update window.myFriends / pendingRequests / allNotes)
  var liveInterval = setInterval(function() {
    if (!document.getElementById('friends-panel-overlay')) { clearInterval(liveInterval); return; }
    refreshTab(activeTab);
  }, 1500);

  function cleanup() {
    clearInterval(liveInterval);
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  }

  var escHandler = function(e){ if(e.key==='Escape') cleanup(); };
  document.addEventListener('keydown', escHandler);
}

function renderFriendsList(container) {
  container.innerHTML = '';
  var friends = Object.values(window.myFriends || {});
  if (!friends.length) {
    container.innerHTML = '<div class="friend-empty">Wala ka pang friends.<br><span>I-search sila sa "+ Add Friend" tab 👆</span></div>';
    return;
  }
  friends.forEach(function(f) {
    var row = document.createElement('div'); row.className = 'friend-row';
    var av = document.createElement('div'); av.className = 'friend-avatar';
    av.textContent = (f.displayName||'?')[0].toUpperCase();
    var info = document.createElement('div'); info.className = 'friend-info';
    info.innerHTML = '<div class="friend-name">' + esc2(f.displayName||'Unknown') + '</div>';
    var rmBtn = document.createElement('button'); rmBtn.className = 'friend-remove-btn';
    rmBtn.textContent = 'Remove';
    rmBtn.addEventListener('click', function(){ removeFriend(f.uid); });
    row.appendChild(av); row.appendChild(info); row.appendChild(rmBtn);
    container.appendChild(row);
  });
}

function renderRequestsList(container) {
  container.innerHTML = '';
  var reqs = Object.values(window.pendingRequests || {}).filter(function(r){ return r.status === 'pending'; });
  var sent = Object.values(window.sentRequests || {});

  if (!reqs.length && !sent.length) {
    container.innerHTML = '<div class="friend-empty">Walang pending requests.</div>';
    return;
  }

  if (reqs.length) {
    var lbl = document.createElement('div'); lbl.className = 'friend-sec-label';
    lbl.textContent = 'INCOMING (' + reqs.length + ')';
    container.appendChild(lbl);
    reqs.forEach(function(r) {
      var row = document.createElement('div'); row.className = 'friend-row';
      var av = document.createElement('div'); av.className = 'friend-avatar';
      av.textContent = (r.displayName||'?')[0].toUpperCase();
      var info = document.createElement('div'); info.className = 'friend-info';
      info.innerHTML = '<div class="friend-name">' + esc2(r.displayName) + '</div><div class="friend-sub">Wants to be your friend</div>';
      var btns = document.createElement('div'); btns.className = 'req-btns';
      var acc = document.createElement('button'); acc.className = 'req-accept'; acc.textContent = '✓ Accept';
      var dec = document.createElement('button'); dec.className = 'req-decline'; dec.textContent = '✕';
      acc.addEventListener('click', function(){ acceptFriendRequest(r.fromUid); row.remove(); });
      dec.addEventListener('click', function(){ declineFriendRequest(r.fromUid); row.remove(); });
      btns.appendChild(acc); btns.appendChild(dec);
      row.appendChild(av); row.appendChild(info); row.appendChild(btns);
      container.appendChild(row);
    });
  }

  if (sent.length) {
    var lbl2 = document.createElement('div'); lbl2.className = 'friend-sec-label';
    lbl2.style.marginTop = '12px';
    lbl2.textContent = 'SENT (' + sent.length + ')';
    container.appendChild(lbl2);
    sent.forEach(function(s) {
      var row = document.createElement('div'); row.className = 'friend-row';
      var av = document.createElement('div'); av.className = 'friend-avatar friend-avatar-dim';
      av.textContent = (s.displayName||'?')[0].toUpperCase();
      var info = document.createElement('div'); info.className = 'friend-info';
      info.innerHTML = '<div class="friend-name">' + esc2(s.displayName||'?') + '</div><div class="friend-sub">Pending...</div>';
      row.appendChild(av); row.appendChild(info);
      container.appendChild(row);
    });
  }
}

function renderSharedByMe(container) {
  container.innerHTML = '';
  var mySharedNotes = (window.allNotes || []).filter(function(n) {
    return isMyNote(n) && n.sharedWith && Object.keys(n.sharedWith).length > 0;
  });

  if (!mySharedNotes.length) {
    container.innerHTML = '<div class="friend-empty">Wala ka pang shared notes.<br><span>I-share ang note mo gamit ang 🔗 button sa note card</span></div>';
    return;
  }

  mySharedNotes.forEach(function(n) {
    var sharedUids = Object.keys(n.sharedWith || {});
    var card = document.createElement('div'); card.className = 'shared-by-me-card';

    // Note info
    var noteInfo = document.createElement('div'); noteInfo.className = 'sbm-note-info';
    var catSpan = document.createElement('span'); catSpan.className = 'sbm-cat';
    catSpan.textContent = (typeof getCatEmoji === 'function' ? getCatEmoji(n.category) : '📌') + ' ' + (n.category || 'NOTE');
    var titleEl = document.createElement('div'); titleEl.className = 'sbm-title';
    titleEl.textContent = n.title || 'Untitled';
    noteInfo.appendChild(catSpan); noteInfo.appendChild(titleEl);
    card.appendChild(noteInfo);

    // Shared with list
    var sharedLbl = document.createElement('div'); sharedLbl.className = 'sbm-shared-lbl';
    sharedLbl.textContent = 'Shared with:';
    card.appendChild(sharedLbl);

    var chips = document.createElement('div'); chips.className = 'sbm-chips';
    sharedUids.forEach(function(uid) {
      // Try to get display name from friends list
      var friend = window.myFriends[uid];
      var dname = friend ? friend.displayName : uid.slice(0, 8) + '...';

      var chip = document.createElement('div'); chip.className = 'sbm-chip';
      var av = document.createElement('span'); av.className = 'sbm-chip-av';
      av.textContent = dname[0].toUpperCase();
      var nm = document.createElement('span'); nm.className = 'sbm-chip-name';
      nm.textContent = dname;
      var rmX = document.createElement('button'); rmX.className = 'sbm-chip-rm'; rmX.title = 'Unshare';
      rmX.innerHTML = '✕';
      rmX.addEventListener('click', async function() {
        rmX.disabled = true;
        await unshareNoteWith(n.fbKey, uid);
        chip.remove();
        // If no more shares, remove card
        if (!chips.children.length) card.remove();
      });
      chip.appendChild(av); chip.appendChild(nm); chip.appendChild(rmX);
      chips.appendChild(chip);
    });
    card.appendChild(chips);

    // Manage share button
    var manageBtn = document.createElement('button'); manageBtn.className = 'sbm-manage-btn';
    manageBtn.textContent = '🔗 Manage Sharing';
    manageBtn.addEventListener('click', function() {
      openShareModal(n.fbKey);
    });
    card.appendChild(manageBtn);

    container.appendChild(card);
  });
}

function renderSearchPanel(container) {
  container.innerHTML = '';
  var sw = document.createElement('div'); sw.className = 'friend-search-wrap';
  sw.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
  var si = document.createElement('input'); si.className = 'friend-search-input';
  si.placeholder = 'Search by name or email...'; si.autocomplete = 'off';
  sw.appendChild(si);
  container.appendChild(sw);

  var results = document.createElement('div'); results.className = 'friend-search-results';
  container.appendChild(results);

  var debounce;
  si.addEventListener('input', function(){
    clearTimeout(debounce);
    var q = si.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    results.innerHTML = '<div class="friend-searching">Searching...</div>';
    debounce = setTimeout(async function(){
      var found = await searchUsers(q);
      results.innerHTML = '';
      if (!found.length) {
        results.innerHTML = '<div class="friend-empty" style="padding:16px">Walang nahanap para sa "' + esc2(q) + '"</div>';
        return;
      }
      found.forEach(function(u) {
        var isFriend = !!window.myFriends[u.uid];
        var sentAlready = !!window.sentRequests[u.uid];
        var row = document.createElement('div'); row.className = 'friend-row';
        var av = document.createElement('div'); av.className = 'friend-avatar';
        av.textContent = (u.displayName||'?')[0].toUpperCase();
        var info = document.createElement('div'); info.className = 'friend-info';
        info.innerHTML = '<div class="friend-name">' + esc2(u.displayName||'?') + '</div>'
          + '<div class="friend-sub">' + esc2(u.email||'') + '</div>';
        row.appendChild(av); row.appendChild(info);

        if (isFriend) {
          var tag = document.createElement('span'); tag.className = 'friend-already-tag'; tag.textContent = '✓ Friends';
          row.appendChild(tag);
        } else if (sentAlready) {
          var tag2 = document.createElement('span'); tag2.className = 'friend-pending-tag'; tag2.textContent = 'Pending';
          row.appendChild(tag2);
        } else {
          var addBtn = document.createElement('button'); addBtn.className = 'friend-add-btn'; addBtn.textContent = '+ Add';
          addBtn.addEventListener('click', async function(){
            addBtn.disabled = true; addBtn.textContent = 'Sending...';
            await sendFriendRequest(u.uid, u.displayName || u.email);
            addBtn.textContent = 'Sent ✓';
          });
          row.appendChild(addBtn);
        }
        results.appendChild(row);
      });
    }, 400);
  });
  setTimeout(function(){ si.focus(); }, 100);
}

// ─────────────────────────────────────────────────────────────
// SHARED WITH ME TAB — render notes shared to me
// ─────────────────────────────────────────────────────────────
function renderSharedWithMe() {
  var me = window._currentUser;
  if (!me) return;
  var uid = me.uid;

  var sharedNotes = (window.allNotes || []).filter(function(n){
    return n.sharedWith && n.sharedWith[uid] && !isMyNote(n);
  });

  var container = document.getElementById('sec-shared');
  if (!container) return;

  if (!sharedNotes.length) {
    container.innerHTML = '<div class="empty"><div class="empty-ico">🔗</div>'
      + '<div class="empty-t">Walang shared notes pa</div>'
      + '<div class="empty-s">Kapag nag-share ng note ang friend mo, makikita mo dito</div></div>';
    return;
  }

  container.innerHTML = '<div class="app-grid">'
    + sharedNotes.map(function(n){ return buildSharedCard(n); }).join('')
    + '</div>';
}

function buildSharedCard(n) {
  var stripe = (typeof getCatStripe === 'function') ? getCatStripe(n.category) : '#3b82f6';
  var pillHtml = (typeof getCatPill === 'function') ? getCatPill(n.category) : 'class="cpill"';
  var emoji = (typeof getCatEmoji === 'function') ? getCatEmoji(n.category) : '📌';
  return '<div class="anc community" onclick="openView(\'' + (n.fbKey||n.id) + '\')">'
    + '<div class="nc-stripe" style="background:' + stripe + '"></div>'
    + '<div class="nc-top">'
    +   '<span ' + pillHtml + '>' + emoji + ' ' + esc2(n.category||'NOTE') + '</span>'
    +   '<span class="nc-date">' + esc2(n.date||'') + '</span>'
    +   '<span class="vis-badge pub">🔗 Shared</span>'
    + '</div>'
    + '<div class="nc-title">' + esc2(n.title||'Untitled') + '</div>'
    + '<div class="nc-summary">' + esc2(n.summary||'') + '</div>'
    + '<div class="anc-foot">'
    +   '<div class="anc-src">📄 ' + esc2(n.author||'') + '</div>'
    + '</div>'
    + '</div>';
}

// ─────────────────────────────────────────────────────────────
// FRIENDS UI in existing renderApp cycle
// ─────────────────────────────────────────────────────────────
function renderFriendsUI() {
  var me = window._currentUser;
  if (!me) return;
  var uid = me.uid;

  // Shared With Me count
  var sharedWithMeCount = (window.allNotes || []).filter(function(n){
    return n.sharedWith && n.sharedWith[uid] && !isMyNote(n);
  }).length;
  var sharedCnt = document.getElementById('mtab-shared-cnt');
  if (sharedCnt) sharedCnt.textContent = sharedWithMeCount || '';

  // Shared by Me count
  var sharedByMeCount = (window.allNotes || []).filter(function(n){
    return isMyNote(n) && n.sharedWith && Object.keys(n.sharedWith).length > 0;
  }).length;
  var sharedMeCnt = document.getElementById('mtab-sharedme-cnt');
  if (sharedMeCnt) sharedMeCnt.textContent = sharedByMeCount || '';

  renderSharedWithMe();

  // Render Shared by Me main tab
  var secSharedMe = document.getElementById('sec-sharedme');
  if (secSharedMe) renderSharedByMe(secSharedMe);
}

// ─────────────────────────────────────────────────────────────
// INJECT SHARE BUTTON into note cards (called from renderApp patch)
// ─────────────────────────────────────────────────────────────
function buildShareBtn(fbKey) {
  return '<button class="anc-btn share-b" onclick="event.stopPropagation();openShareModal(\''
    + fbKey + '\')" title="Share with friends">🔗</button>';
}

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────
function injectFriendStyles() {
  if (document.getElementById('friend-styles')) return;
  var s = document.createElement('style'); s.id = 'friend-styles';
  s.textContent = `
/* ── Overlay & Modal ── */
.friend-overlay{position:fixed;inset:0;z-index:500;background:rgba(0,0,0,0.82);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;padding:16px;animation:fmo-in 0.2s ease}
@keyframes fmo-in{from{opacity:0}to{opacity:1}}
.friend-modal{background:var(--surface);border:1px solid var(--border-h);border-radius:20px;width:100%;max-width:480px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 28px 90px rgba(0,0,0,0.65);animation:fmo-slide 0.25s cubic-bezier(0.34,1.56,0.64,1);overflow:hidden}
.friend-panel-wide{max-width:540px}
@keyframes fmo-slide{from{opacity:0;transform:translateY(20px) scale(0.97)}to{opacity:1;transform:none}}
.friend-modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--border);flex-shrink:0}
.friend-modal-title{font-size:15px;font-weight:800;color:var(--text-b)}
.friend-modal-close{width:30px;height:30px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;color:var(--text-m);transition:all 0.2s}
.friend-modal-close:hover{border-color:var(--red);color:var(--red)}
.friend-modal-body{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-height:0}
.friend-modal-body::-webkit-scrollbar{width:4px}
.friend-modal-body::-webkit-scrollbar-thumb{background:var(--border-h);border-radius:2px}
.friend-modal-foot{padding:14px 20px;border-top:1px solid var(--border);flex-shrink:0}

/* ── Tabs ── */
.friend-tabs{display:flex;border-bottom:1px solid var(--border);flex-shrink:0}
.friend-tab{flex:1;padding:11px 8px;font-size:12px;font-weight:700;font-family:'Outfit',sans-serif;cursor:pointer;color:var(--text-m);background:none;border:none;border-bottom:2px solid transparent;transition:all 0.2s}
.friend-tab.active{color:var(--a2);border-bottom-color:var(--a2)}
.friend-tab:hover:not(.active){color:var(--text-b)}
.friend-tab-body{display:flex;flex-direction:column;gap:8px;padding:14px 16px;flex:1;overflow-y:auto;min-height:200px}

/* ── Friend rows ── */
.friend-row{display:flex;align-items:center;gap:12px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:11px 14px;transition:border-color 0.2s}
.friend-row:hover{border-color:var(--border-h)}
.friend-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#22d3ee);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;flex-shrink:0}
.friend-avatar-dim{opacity:0.5}
.friend-info{flex:1;min-width:0}
.friend-name{font-size:13px;font-weight:700;color:var(--text-b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.friend-sub{font-size:11px;color:var(--text-m);margin-top:1px}
.friend-sec-label{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--a2);font-family:'JetBrains Mono',monospace;padding:2px 0}
.friend-empty{text-align:center;padding:28px 16px;color:var(--text-m);font-size:13px;line-height:1.7}
.friend-empty span{font-size:11px;opacity:0.6;display:block;margin-top:4px}

/* ── Action buttons ── */
.friend-add-btn{padding:6px 14px;border-radius:8px;background:var(--ag);border:1px solid var(--border-h);color:var(--a2);font-size:12px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;transition:all 0.2s;white-space:nowrap}
.friend-add-btn:hover{background:rgba(59,130,246,0.2);border-color:var(--a)}
.friend-add-btn:disabled{opacity:0.5;cursor:not-allowed}
.friend-remove-btn{padding:5px 11px;border-radius:8px;background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.25);color:#f87171;font-size:11px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;transition:all 0.2s;white-space:nowrap}
.friend-remove-btn:hover{background:rgba(248,113,113,0.15);border-color:#f87171}
.friend-already-tag{padding:4px 10px;border-radius:20px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.25);color:#4ade80;font-size:11px;font-weight:700;white-space:nowrap}
.friend-pending-tag{padding:4px 10px;border-radius:20px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);color:#fbbf24;font-size:11px;font-weight:700;white-space:nowrap}
.req-btns{display:flex;gap:5px}
.req-accept{padding:6px 12px;border-radius:8px;background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.3);color:#4ade80;font-size:12px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;transition:all 0.2s}
.req-accept:hover{background:rgba(74,222,128,0.22);border-color:#4ade80}
.req-decline{padding:6px 10px;border-radius:8px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);color:#f87171;font-size:12px;cursor:pointer;transition:all 0.2s}
.req-decline:hover{background:rgba(248,113,113,0.16);border-color:#f87171}

/* ── Search ── */
.friend-search-wrap{display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:9px 13px;margin-bottom:4px;transition:all 0.2s;flex-shrink:0}
.friend-search-wrap:focus-within{border-color:var(--a);box-shadow:0 0 0 3px var(--ag)}
.friend-search-input{background:none;border:none;outline:none;color:var(--text-b);font-family:'Outfit',sans-serif;font-size:13px;flex:1}
.friend-search-input::placeholder{color:var(--text-m)}
.friend-search-results{display:flex;flex-direction:column;gap:7px;flex:1;overflow-y:auto}
.friend-searching{text-align:center;padding:20px;color:var(--text-m);font-size:13px;animation:blk 1s ease-in-out infinite alternate}
@keyframes blk{from{opacity:0.4}to{opacity:1}}

/* ── Share modal ── */
.share-note-preview{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--border);background:var(--surface2);flex-shrink:0}
.share-note-cat{font-size:10px;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:1px;background:var(--ag);color:var(--a2);padding:3px 8px;border-radius:6px;flex-shrink:0}
.share-note-title{font-size:13px;font-weight:700;color:var(--text-b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.share-friend-row{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;cursor:pointer;transition:all 0.2s}
.share-friend-row:hover{border-color:var(--border-h)}
.share-cb{width:17px;height:17px;accent-color:var(--a);cursor:pointer;flex-shrink:0}
.share-friend-label{display:flex;align-items:center;gap:10px;flex:1;cursor:pointer}
.share-friend-name{font-size:13px;font-weight:700;color:var(--text-b);display:flex;align-items:center;gap:7px}
.share-already-tag{font-size:10px;font-weight:700;background:rgba(74,222,128,0.1);color:#4ade80;border:1px solid rgba(74,222,128,0.25);padding:2px 7px;border-radius:10px}
.share-unshare-btn{padding:4px 10px;border-radius:7px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);color:#f87171;font-size:11px;cursor:pointer;font-family:'Outfit',sans-serif;transition:all 0.2s;flex-shrink:0;white-space:nowrap}
.share-unshare-btn:hover{background:rgba(248,113,113,0.18);border-color:#f87171}
.friend-action-btn{width:100%;padding:12px;border:none;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;font-family:'Outfit',sans-serif;font-size:14px;font-weight:800;cursor:pointer;transition:all 0.25s;box-shadow:0 4px 16px rgba(59,130,246,0.3)}
.friend-action-btn:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(59,130,246,0.45)}
.friend-action-btn:disabled{opacity:0.4;cursor:not-allowed;transform:none}

/* ── Shared by Me ── */
.shared-by-me-card{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:13px 14px;display:flex;flex-direction:column;gap:8px;transition:border-color 0.2s}
.shared-by-me-card:hover{border-color:var(--border-h)}
.sbm-note-info{display:flex;flex-direction:column;gap:3px}
.sbm-cat{font-size:10px;font-weight:700;letter-spacing:1px;color:var(--a2);font-family:'JetBrains Mono',monospace}
.sbm-title{font-size:13px;font-weight:700;color:var(--text-b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sbm-shared-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-m)}
.sbm-chips{display:flex;flex-wrap:wrap;gap:6px}
.sbm-chip{display:inline-flex;align-items:center;gap:6px;background:var(--surface3);border:1px solid var(--border-h);border-radius:20px;padding:4px 10px 4px 6px;font-size:12px;color:var(--text-b)}
.sbm-chip-av{width:20px;height:20px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#22d3ee);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;flex-shrink:0}
.sbm-chip-name{font-weight:600;font-size:12px}
.sbm-chip-rm{background:none;border:none;color:var(--text-m);cursor:pointer;font-size:11px;padding:0;line-height:1;transition:color 0.15s;display:flex;align-items:center}
.sbm-chip-rm:hover{color:#f87171}
.sbm-manage-btn{align-self:flex-start;padding:5px 12px;border-radius:8px;background:var(--ag);border:1px solid var(--border-h);color:var(--a2);font-size:11px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;transition:all 0.2s}
.sbm-manage-btn:hover{background:rgba(59,130,246,0.18);border-color:var(--a)}
.friend-nav-btn{position:relative;display:flex;align-items:center;justify-content:center;width:36px;height:36px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:all 0.2s;color:var(--text-m);flex-shrink:0}
.friend-nav-btn:hover{border-color:var(--border-h);color:var(--text-b)}
#friend-notif-badge{position:absolute;top:-5px;right:-5px;width:17px;height:17px;background:#f87171;border-radius:50%;font-size:9px;font-weight:800;color:#fff;display:none;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;border:2px solid var(--bg)}

/* ── Share btn on note card ── */
.anc-btn.share-b:hover{border-color:rgba(96,165,250,0.4);color:var(--a2)}
`;
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function esc2(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }