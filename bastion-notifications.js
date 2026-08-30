/* ============================================================
   Bastion Notifications — shared bell, real-time updates,
   notification sound, and native browser alerts.
   Included on every logged-in page with:
     <script src="bastion-notifications.js"></script>
   Requires the page to already define `supabaseClient` and the
   standard notif-bell / notif-dropdown / notif-count / notif-list
   markup (already present on every app page).
   ============================================================ */
(function(){
  const bellBtn = document.getElementById('notifBellBtn');
  if(!bellBtn) return;

  let currentUserId = null;
  let audioCtx = null;
  let permissionAsked = false;

  function escNotif(str){
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ---- Sound: a short two-tone chime synthesized on the fly, so no
  // audio file needs to be hosted. Browsers require a real user gesture
  // before audio can play, so this listens for several different kinds
  // of interaction (not just a mouse click — touch and keyboard too),
  // and also makes one more attempt right before actually playing, so a
  // notification arriving before any interaction still has the best
  // possible chance of being heard rather than silently doing nothing.
  function ensureAudioContext(){
    if(!audioCtx){
      try{ audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch(e){ audioCtx = null; }
    }
    if(audioCtx && audioCtx.state === 'suspended'){
      audioCtx.resume().catch(function(){});
    }
  }
  ['click', 'touchstart', 'keydown'].forEach(function(evt){
    document.addEventListener(evt, ensureAudioContext, { once: true, passive: true });
  });

  function playChime(){
    ensureAudioContext();
    if(!audioCtx || audioCtx.state !== 'running') return;
    const now = audioCtx.currentTime;
    [880, 1320].forEach(function(freq, i){
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    });
  }

  // ---- Native browser notification (shows while this tab/window is
  // open; true background push when the site is closed is a separate,
  // larger feature this does not attempt).
  function maybeAskPermission(){
    if(permissionAsked) return;
    permissionAsked = true;
    if('Notification' in window && Notification.permission === 'default'){
      Notification.requestPermission().catch(function(){});
    }
  }

  function showBrowserNotification(n){
    if(!('Notification' in window) || Notification.permission !== 'granted') return;
    try{
      const note = new Notification(n.title || 'Bastion', {
        body: n.body || '',
        icon: '/icon-192.png',
        tag: n.id
      });
      note.onclick = function(){
        window.focus();
        if(n.link) window.location.href = n.link;
        note.close();
      };
    } catch(e){ /* ignore */ }
  }

  async function loadNotifications(){
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const session = sessionData && sessionData.session;
    if(!session) return;
    currentUserId = session.user.id;

    const { data, error } = await supabaseClient
      .from('notifications')
      .select('*')
      .eq('user_id', currentUserId)
      .order('created_at', { ascending: false })
      .limit(30);

    if(error || !data) return;

    const unreadCount = data.filter(function(n){ return !n.is_read; }).length;
    const countEl = document.getElementById('notifCount');
    if(unreadCount > 0){
      countEl.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
      countEl.style.display = 'flex';
    } else {
      countEl.style.display = 'none';
    }

    const list = document.getElementById('notifList');
    if(data.length === 0){
      list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
      return;
    }

    list.innerHTML = data.map(function(n){
      const time = n.created_at ? new Date(n.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
      return '<div class="notif-item' + (n.is_read ? '' : ' unread') + '" data-id="' + escNotif(n.id) + '" data-link="' + escNotif(n.link || '') + '">' +
        '<div class="notif-item-title">' + escNotif(n.title || 'Notification') + '</div>' +
        (n.body ? '<div class="notif-item-body">' + escNotif(n.body) + '</div>' : '') +
        '<div class="notif-item-time">' + time + '</div>' +
      '</div>';
    }).join('');
  }

  async function markNotificationRead(id){
    await supabaseClient.from('notifications').update({ is_read: true }).eq('id', id);
  }

  async function clearAllNotifications(){
    if(!currentUserId) return;
    await supabaseClient.from('notifications').update({ is_read: true }).eq('user_id', currentUserId).eq('is_read', false);
    loadNotifications();
  }

  bellBtn.addEventListener('click', function(e){
    e.stopPropagation();
    maybeAskPermission();
    const dropdown = document.getElementById('notifDropdown');
    const isOpen = dropdown.style.display === 'block';
    dropdown.style.display = isOpen ? 'none' : 'block';
    if(!isOpen) loadNotifications();
  });

  const clearBtn = document.getElementById('notifClearBtn');
  if(clearBtn){
    clearBtn.addEventListener('click', function(e){
      e.stopPropagation();
      clearAllNotifications();
    });
  }

  const logoutBtn = document.getElementById('navLogoutBtn');
  if(logoutBtn){
    logoutBtn.addEventListener('click', async function(){
      const original = this.innerHTML;
      this.disabled = true;
      try{
        const res = await supabaseClient.auth.signOut();
        if(res.error){
          alert('Could not log out: ' + res.error.message);
          this.disabled = false;
          this.innerHTML = original;
          return;
        }
        window.location.href = 'bastion-auth.html';
      } catch(err){
        alert('Could not log out: ' + (err.message || String(err)));
        this.disabled = false;
        this.innerHTML = original;
      }
    });
  }

  document.getElementById('notifList').addEventListener('click', function(e){
    const item = e.target.closest('.notif-item');
    if(!item) return;
    const id = item.dataset.id;
    const link = item.dataset.link;
    item.classList.remove('unread');
    markNotificationRead(id);
    if(link) window.location.href = link;
  });

  document.addEventListener('click', function(e){
    const dropdown = document.getElementById('notifDropdown');
    if(dropdown.style.display === 'block' && !dropdown.contains(e.target) && e.target !== bellBtn && !bellBtn.contains(e.target)){
      dropdown.style.display = 'none';
    }
  });

  loadNotifications();

  // Fallback poll in case the realtime connection ever drops —
  // realtime below is what makes the bell update instantly.
  setInterval(loadNotifications, 30000);

  // ---- Real-time: the moment a new notification row is inserted for
  // this user, update the bell, chime, and show a native alert.
  supabaseClient.auth.getSession().then(function(res){
    const session = res.data && res.data.session;
    if(!session) return;
    currentUserId = session.user.id;

    supabaseClient
      .channel('notifications-' + currentUserId)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: 'user_id=eq.' + currentUserId
      }, function(payload){
        loadNotifications();
        playChime();
        showBrowserNotification(payload.new);
      })
      .subscribe();
  });
})();
