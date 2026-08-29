/* ============================================================
   Bastion Account Skirt — shared retractable side panel
   Included on every logged-in page with a single line:
     <script src="bastion-account-skirt.js"></script>
   Requires the page to already define the same CSS custom
   properties (--brass, --ink-soft, etc.) and a global
   `supabaseClient` (both already true on every app page).
   ============================================================ */
(function(){
  if(document.getElementById('accountSkirtRoot')) return; // avoid double-injection

  var css = '' +
    '.skirt-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.18);opacity:0;pointer-events:none;transition:opacity .35s ease;z-index:998;border:none;padding:0;cursor:default;}' +
    '.skirt-overlay.visible{opacity:1;pointer-events:auto;}' +
    '.account-skirt{position:fixed;top:0;right:0;height:100vh;width:min(300px,78vw);z-index:999;transform:translateX(100%);transition:transform .45s cubic-bezier(.22,1,.36,1);}' +
    '.account-skirt.open{transform:translateX(0);}' +
    '.skirt-handle{position:absolute;top:50%;left:-34px;transform:translateY(-50%);width:68px;height:68px;border-radius:50%;background:rgba(15,13,11,.68);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border:1px solid rgba(199,162,104,.4);box-shadow:0 8px 28px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:border-color .25s ease,box-shadow .25s ease;}' +
    '.skirt-handle:hover{border-color:rgba(199,162,104,.75);box-shadow:0 8px 32px rgba(199,162,104,.18);}' +
    '.skirt-handle-mark{width:44px;height:44px;color:var(--brass);opacity:.55;transition:opacity .25s ease;}' +
    '.skirt-handle:hover .skirt-handle-mark,.account-skirt.open .skirt-handle-mark{opacity:.95;}' +
    '.skirt-panel{height:100%;overflow-y:auto;background:rgba(14,12,10,.32);-webkit-backdrop-filter:blur(22px) saturate(160%);backdrop-filter:blur(22px) saturate(160%);border-left:1px solid rgba(199,162,104,.28);box-shadow:-30px 0 60px rgba(0,0,0,.25);padding:64px 20px 40px;}' +
    '.skirt-panel-title{font-family:"Fraunces",serif;font-style:italic;font-weight:450;font-size:18px;color:var(--ivory);margin-bottom:18px;text-shadow:0 1px 12px rgba(0,0,0,.6);}' +
    '.skirt-search{position:relative;margin-bottom:6px;}' +
    '.skirt-search input{width:100%;background:rgba(0,0,0,.22);border:1px solid rgba(199,162,104,.3);border-radius:20px;color:var(--ivory);padding:9px 14px 9px 34px;font-family:"Inter",sans-serif;font-size:12.5px;outline:none;transition:border-color .2s ease,background .2s ease;}' +
    '.skirt-search input::placeholder{color:var(--stone-dim);}' +
    '.skirt-search input:focus{border-color:var(--brass);background:rgba(0,0,0,.32);}' +
    '.skirt-search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:13px;height:13px;color:var(--stone-dim);pointer-events:none;}' +
    '.skirt-nav{margin:14px 0 8px;}' +
    '.skirt-nav-link{position:relative;display:flex;align-items:center;gap:12px;padding:12px 4px;text-decoration:none;transition:background .2s ease;border-radius:6px;}' +
    '.skirt-nav-link:hover{background:rgba(199,162,104,.08);}' +
    '.skirt-nav-icon{width:30px;height:30px;flex-shrink:0;border-radius:50%;border:1px solid rgba(199,162,104,.35);display:flex;align-items:center;justify-content:center;color:var(--brass);background:rgba(0,0,0,.15);transition:border-color .2s ease;}' +
    '.skirt-nav-link:hover .skirt-nav-icon{border-color:var(--brass);}' +
    '.skirt-nav-icon svg{width:14px;height:14px;}' +
    '.skirt-nav-label{font-family:"Fraunces",serif;font-size:14.5px;color:var(--ivory);text-shadow:0 1px 10px rgba(0,0,0,.55);}' +
    '.skirt-nav-arrow{margin-left:auto;color:var(--stone-dim);font-size:13px;transition:transform .2s ease,color .2s ease;}' +
    '.skirt-nav-link:hover .skirt-nav-arrow{color:var(--brass);transform:translateX(3px);}' +
    '.skirt-divider{height:1px;background:rgba(199,162,104,.22);margin:16px 0 4px;}' +
    '.skirt-accordion.search-hidden{display:none;}' +
    '.skirt-search-empty{font-size:12.5px;color:var(--stone-dim);padding:16px 4px 22px;text-align:center;text-shadow:0 1px 8px rgba(0,0,0,.5);}' +
    '.skirt-logout-section{margin-top:14px;padding-top:20px;border-top:1px solid rgba(199,162,104,.22);}' +
    '.skirt-logout-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:9px;background:rgba(181,69,61,.08);border:1px solid rgba(181,69,61,.35);color:#E0958D;border-radius:999px;padding:12px;font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:background .2s ease,border-color .2s ease;}' +
    '.skirt-logout-btn svg{width:15px;height:15px;flex-shrink:0;}' +
    '.skirt-logout-btn:hover{background:rgba(181,69,61,.16);border-color:rgba(181,69,61,.6);}' +
    '.skirt-accordion{border-top:1px solid rgba(199,162,104,.22);}' +
    '.skirt-accordion:last-child{border-bottom:1px solid rgba(199,162,104,.22);}' +
    '.skirt-accordion-header{width:100%;display:flex;justify-content:space-between;align-items:center;background:none;border:none;padding:18px 2px;cursor:pointer;text-align:left;font-family:"Fraunces",serif;font-size:15px;color:var(--ivory);text-shadow:0 1px 10px rgba(0,0,0,.55);}' +
    '.skirt-accordion-header:hover{color:var(--brass);}' +
    '.skirt-accordion-chevron{font-size:13px;color:var(--brass-dim);transition:transform .3s ease;flex-shrink:0;margin-left:12px;}' +
    '.skirt-accordion-header[aria-expanded="true"] .skirt-accordion-chevron{transform:rotate(180deg);color:var(--brass);}' +
    '.skirt-accordion-body{max-height:0;overflow:hidden;transition:max-height .35s ease;}' +
    '.skirt-accordion-body-inner{padding:0 2px 22px;}' +
    '.skirt-copy{font-size:12.5px;color:var(--stone);line-height:1.6;margin-bottom:14px;text-shadow:0 1px 8px rgba(0,0,0,.55);}' +
    '.skirt-status{font-size:11.5px;color:var(--stone);margin-top:10px;min-height:14px;text-shadow:0 1px 8px rgba(0,0,0,.55);}' +
    '.skirt-btn-gold{background:var(--brass);color:var(--brass-ink);border:none;border-radius:var(--radius-pill, 999px);font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding:11px 20px;cursor:pointer;transition:background .2s ease;}' +
    '.skirt-btn-gold:hover{background:#D4B27E;}' +
    '.skirt-btn-outline{background:none;color:var(--ivory);border:1px solid var(--field-border);border-radius:var(--radius-pill, 999px);font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding:11px 20px;cursor:pointer;transition:border-color .2s ease;}' +
    '.skirt-btn-outline:hover{border-color:var(--brass);}' +
    '.skirt-trust-tabs{border:1px solid rgba(199,162,104,.18);}' +
    '.skirt-trust-tab{position:relative;display:flex;align-items:center;gap:12px;padding:14px 4px 14px 14px;text-decoration:none;border-bottom:1px solid rgba(199,162,104,.18);transition:background .2s ease;}' +
    '.skirt-trust-tab:last-child{border-bottom:none;}' +
    '.skirt-trust-tab:hover{background:rgba(199,162,104,.07);}' +
    '.skirt-trust-tab-bar{position:absolute;left:0;top:0;bottom:0;width:2px;background:transparent;transition:background .2s ease;}' +
    '.skirt-trust-tab:hover .skirt-trust-tab-bar{background:var(--brass);}' +
    '.skirt-trust-tab-icon{width:28px;height:28px;flex-shrink:0;border-radius:50%;border:1px solid var(--field-border);display:flex;align-items:center;justify-content:center;color:var(--brass-dim);transition:border-color .2s ease,color .2s ease;}' +
    '.skirt-trust-tab:hover .skirt-trust-tab-icon{border-color:var(--brass);color:var(--brass);}' +
    '.skirt-trust-tab-icon svg{width:13px;height:13px;}' +
    '.skirt-trust-tab-title{font-size:13px;color:var(--ivory);font-family:"Fraunces",serif;text-shadow:0 1px 8px rgba(0,0,0,.55);}' +
    '.skirt-trust-tab-arrow{margin-left:auto;color:var(--stone-dim);font-size:13px;transition:transform .2s ease,color .2s ease;}' +
    '.skirt-trust-tab:hover .skirt-trust-tab-arrow{color:var(--brass);transform:translateX(3px);}' +
    '@media(max-width:520px){.skirt-panel{padding:56px 16px 40px;}.skirt-handle{width:56px;height:56px;left:-28px;}.skirt-handle-mark{width:36px;height:36px;}}';

  var styleTag = document.createElement('style');
  styleTag.id = 'accountSkirtStyles';
  styleTag.textContent = css;
  document.head.appendChild(styleTag);

  var html = '' +
    '<button class="skirt-overlay" id="skirtOverlay" aria-hidden="true" tabindex="-1"></button>' +
    '<aside class="account-skirt" id="accountSkirtRoot">' +
      '<button class="skirt-handle" id="skirtHandle" aria-label="Open account panel" aria-expanded="false" type="button">' +
        '<svg class="skirt-handle-mark" viewBox="0 0 100 100" aria-hidden="true">' +
          '<circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" stroke-width="1"/>' +
          '<circle cx="50" cy="50" r="35" fill="none" stroke="currentColor" stroke-width="1"/>' +
          '<g stroke="currentColor" stroke-width="1.4">' +
            '<line x1="50" y1="3" x2="50" y2="10"/><line x1="50" y1="90" x2="50" y2="97"/>' +
            '<line x1="3" y1="50" x2="10" y2="50"/><line x1="90" y1="50" x2="97" y2="50"/>' +
            '<line x1="18.7" y1="18.7" x2="23.6" y2="23.6"/><line x1="76.4" y1="76.4" x2="81.3" y2="81.3"/>' +
            '<line x1="18.7" y1="81.3" x2="23.6" y2="76.4"/><line x1="76.4" y1="23.6" x2="81.3" y2="18.7"/>' +
          '</g>' +
          '<text x="50" y="63" text-anchor="middle" font-family="Fraunces, serif" font-size="38" fill="currentColor">B</text>' +
        '</svg>' +
      '</button>' +
      '<div class="skirt-panel">' +
        '<div class="skirt-search">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
          '<input type="text" id="skirtSearchInput" placeholder="Search your account…" autocomplete="off">' +
        '</div>' +
        '<div class="skirt-nav">' +
          '<a class="skirt-nav-link" href="/bastion-my-account.html">' +
            '<span class="skirt-nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6"/></svg></span>' +
            '<span class="skirt-nav-label">My Account</span><span class="skirt-nav-arrow">→</span>' +
          '</a>' +
          '<a class="skirt-nav-link" href="/bastion-marketplace.html">' +
            '<span class="skirt-nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9l1-5h14l1 5"/><path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9z"/><path d="M9 21v-6h6v6"/></svg></span>' +
            '<span class="skirt-nav-label">Marketplace</span><span class="skirt-nav-arrow">→</span>' +
          '</a>' +
        '</div>' +
        '<div class="skirt-divider"></div>' +
        '<div id="skirtSettings">' +
          '<div class="skirt-accordion" data-search="your data download export json file profile listings transactions reviews messages backup">' +
            '<button class="skirt-accordion-header" aria-expanded="false" type="button"><span>Your Data</span><span class="skirt-accordion-chevron">⌄</span></button>' +
            '<div class="skirt-accordion-body"><div class="skirt-accordion-body-inner">' +
              '<p class="skirt-copy">Download a copy of your Bastion data — profile, listings, transactions, reviews, messages, and more — as a JSON file.</p>' +
              '<button id="downloadDataBtn" class="skirt-btn-gold">Download my data</button>' +
              '<div id="downloadDataStatus" class="skirt-status"></div>' +
            '</div></div>' +
          '</div>' +
          '<div class="skirt-accordion" data-search="security logout log out sign out devices everywhere password">' +
            '<button class="skirt-accordion-header" aria-expanded="false" type="button"><span>Security</span><span class="skirt-accordion-chevron">⌄</span></button>' +
            '<div class="skirt-accordion-body"><div class="skirt-accordion-body-inner">' +
              '<p class="skirt-copy">Sign out of Bastion everywhere — this phone, other browsers, any device currently signed in.</p>' +
              '<button id="logoutAllBtn" class="skirt-btn-outline">Log out of all devices</button>' +
              '<div id="logoutAllStatus" class="skirt-status"></div>' +
            '</div></div>' +
          '</div>' +
          '<div class="skirt-accordion" data-search="trust safety faq questions about built on trust safety center meeting meetup help support">' +
            '<button class="skirt-accordion-header" aria-expanded="false" type="button"><span>Trust &amp; Safety</span><span class="skirt-accordion-chevron">⌄</span></button>' +
            '<div class="skirt-accordion-body"><div class="skirt-accordion-body-inner">' +
              '<div class="skirt-trust-tabs">' +
                '<a class="skirt-trust-tab" href="/bastion-about.html"><span class="skirt-trust-tab-bar"></span><span class="skirt-trust-tab-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l7 4v6c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/></svg></span><span class="skirt-trust-tab-title">Built on Trust</span><span class="skirt-trust-tab-arrow">→</span></a>' +
                '<a class="skirt-trust-tab" href="/bastion-faq.html"><span class="skirt-trust-tab-bar"></span><span class="skirt-trust-tab-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2-2.4 3.5"/><path d="M12 17h.01"/></svg></span><span class="skirt-trust-tab-title">FAQ</span><span class="skirt-trust-tab-arrow">→</span></a>' +
                '<a class="skirt-trust-tab" href="/bastion-safety.html"><span class="skirt-trust-tab-bar"></span><span class="skirt-trust-tab-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="10" width="18" height="10" rx="1.5"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/></svg></span><span class="skirt-trust-tab-title">Safety Center</span><span class="skirt-trust-tab-arrow">→</span></a>' +
                '<a class="skirt-trust-tab" href="/bastion-support.html"><span class="skirt-trust-tab-bar"></span><span class="skirt-trust-tab-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 18h.01"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5"/><circle cx="12" cy="12" r="9"/></svg></span><span class="skirt-trust-tab-title">Contact Support</span><span class="skirt-trust-tab-arrow">→</span></a>' +
              '</div>' +
            '</div></div>' +
          '</div>' +
          '<div class="skirt-search-empty hidden" id="skirtSearchEmpty">No settings match "<span id="skirtSearchEmptyTerm"></span>".</div>' +
        '</div>' +
        '<div class="skirt-logout-section">' +
          '<button class="skirt-logout-btn" id="skirtLogoutBottom" type="button">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>' +
            '<span>Log Out</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
    '</aside>';

  document.body.insertAdjacentHTML('beforeend', html);

  // ---- Behavior ----
  var skirt = document.getElementById('accountSkirtRoot');
  var handle = document.getElementById('skirtHandle');
  var overlay = document.getElementById('skirtOverlay');

  function openSkirt(){
    skirt.classList.add('open');
    overlay.classList.add('visible');
    handle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeSkirt(){
    skirt.classList.remove('open');
    overlay.classList.remove('visible');
    handle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }
  handle.addEventListener('click', function(){
    if(skirt.classList.contains('open')) closeSkirt(); else openSkirt();
  });
  overlay.addEventListener('click', closeSkirt);
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && skirt.classList.contains('open')) closeSkirt();
  });

  // Accordions
  document.querySelectorAll('.skirt-accordion-header').forEach(function(header){
    var body = header.nextElementSibling;
    header.addEventListener('click', function(){
      var isOpen = header.getAttribute('aria-expanded') === 'true';
      if(isOpen){
        body.style.maxHeight = body.scrollHeight + 'px';
        requestAnimationFrame(function(){
          requestAnimationFrame(function(){ body.style.maxHeight = '0px'; });
        });
        header.setAttribute('aria-expanded', 'false');
      } else {
        header.setAttribute('aria-expanded', 'true');
        body.style.maxHeight = body.scrollHeight + 'px';
      }
    });
    body.addEventListener('transitionend', function(){
      if(header.getAttribute('aria-expanded') === 'true') body.style.maxHeight = 'none';
    });
  });

  var skirtResizeObserver = new MutationObserver(function(mutations){
    mutations.forEach(function(m){
      var body = m.target.closest('.skirt-accordion-body');
      if(!body) return;
      var header = body.previousElementSibling;
      if(header && header.getAttribute('aria-expanded') === 'true'){
        body.style.maxHeight = 'none';
        void body.offsetHeight;
        body.style.maxHeight = body.scrollHeight + 'px';
      }
    });
  });
  document.querySelectorAll('.skirt-accordion-body').forEach(function(body){
    skirtResizeObserver.observe(body, { childList:true, subtree:true, characterData:true });
  });

  // Settings search filter
  var searchInput = document.getElementById('skirtSearchInput');
  var accordions = Array.prototype.slice.call(document.querySelectorAll('#skirtSettings .skirt-accordion'));
  var emptyMsg = document.getElementById('skirtSearchEmpty');
  var emptyTerm = document.getElementById('skirtSearchEmptyTerm');

  searchInput.addEventListener('input', function(){
    var q = this.value.trim().toLowerCase();
    if(!q){
      accordions.forEach(function(acc){ acc.classList.remove('search-hidden'); });
      emptyMsg.classList.add('hidden');
      return;
    }
    var anyMatch = false;
    accordions.forEach(function(acc){
      var haystack = ((acc.getAttribute('data-search') || '') + ' ' + acc.textContent).toLowerCase();
      var matches = haystack.includes(q);
      acc.classList.toggle('search-hidden', !matches);
      if(matches){
        anyMatch = true;
        var header = acc.querySelector('.skirt-accordion-header');
        var body = acc.querySelector('.skirt-accordion-body');
        if(header.getAttribute('aria-expanded') !== 'true'){
          header.setAttribute('aria-expanded', 'true');
          body.style.maxHeight = body.scrollHeight + 'px';
        }
      }
    });
    emptyTerm.textContent = this.value.trim();
    emptyMsg.classList.toggle('hidden', anyMatch);
  });

  // Download my data / Log out of all devices — use whichever supabaseClient
  // the host page has already created (every app page defines this the same way).
  document.getElementById('downloadDataBtn').addEventListener('click', async function(){
    var btn = this;
    var statusEl = document.getElementById('downloadDataStatus');
    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'PREPARING…';
    statusEl.textContent = '';
    try{
      var res = await supabaseClient.rpc('get_my_data');
      if(res.error){
        statusEl.textContent = 'Could not download your data: ' + res.error.message;
        btn.disabled = false; btn.textContent = originalText;
        return;
      }
      var json = JSON.stringify(res.data, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var dateStr = new Date().toISOString().slice(0, 10);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'bastion-my-data-' + dateStr + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      statusEl.textContent = 'Downloaded.';
    } catch(err){
      statusEl.textContent = 'Could not download your data: ' + (err.message || String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // Easy, single-click sign out (this device only) — available from two spots
  // in the panel since the nuclear "log out everywhere" option lives inside
  // the Security accordion and shouldn't be the only way to just log out.
  async function easyLogout(btn){
    var original = btn.innerHTML;
    btn.disabled = true;
    try{
      var res = await supabaseClient.auth.signOut();
      if(res.error){
        alert('Could not log out: ' + res.error.message);
        btn.disabled = false;
        btn.innerHTML = original;
        return;
      }
      window.location.href = 'bastion-auth.html';
    } catch(err){
      alert('Could not log out: ' + (err.message || String(err)));
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
  document.getElementById('skirtLogoutBottom').addEventListener('click', function(){ easyLogout(this); });

  document.getElementById('logoutAllBtn').addEventListener('click', async function(){
    var confirmed = confirm('This will sign you out of Bastion on every device, including this one. Continue?');
    if(!confirmed) return;
    var btn = this;
    var statusEl = document.getElementById('logoutAllStatus');
    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'SIGNING OUT…';
    statusEl.textContent = '';
    try{
      var res = await supabaseClient.auth.signOut({ scope: 'global' });
      if(res.error){
        statusEl.textContent = 'Could not sign out everywhere: ' + res.error.message;
        btn.disabled = false; btn.textContent = originalText;
        return;
      }
      window.location.href = 'bastion-auth.html';
    } catch(err){
      statusEl.textContent = 'Could not sign out everywhere: ' + (err.message || String(err));
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
})();
