// bastion-notifications.js
//
// Shared notification bell behavior, included on every page that has
// the notif-bell/notif-dropdown markup with a single line:
//   <script src="bastion-notifications.js"></script>
// Requires a global `supabaseClient` (already true on every app page).
(function initNotifications(){
  const bellBtn = document.getElementById('notifBellBtn');
  if(!bellBtn) return;

  function escNotif(str){
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  async function loadNotifications(){
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const session = sessionData && sessionData.session;
    if(!session) return;
    const uid = session.user.id;

    const { data, error } = await supabaseClient
      .from('notifications')
      .select('*')
      .eq('user_id', uid)
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

  bellBtn.addEventListener('click', function(e){
    e.stopPropagation();
    const dropdown = document.getElementById('notifDropdown');
    const isOpen = dropdown.style.display === 'block';
    dropdown.style.display = isOpen ? 'none' : 'block';
    if(!isOpen) loadNotifications();
  });

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

  // Check for new activity automatically every 30 seconds while the page
  // is open, so the badge updates without needing a manual refresh.
  setInterval(loadNotifications, 30000);
})();
