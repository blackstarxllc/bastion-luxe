/* bastion-toast.js
 *
 * WHY THIS EXISTS
 * The site used native window.alert() for every message. On a deployed
 * Netlify site the browser prefixes those dialogs with the origin —
 * "wondrous-cocada-31863c.netlify.app says" — which looked broken and
 * unprofessional on a luxury marketplace, and exposed the internal
 * Netlify subdomain to users.
 *
 * There is no way to suppress that prefix; it is browser chrome. The only
 * fix is to stop using native alerts.
 *
 * This overrides window.alert globally, so all 40+ existing call sites
 * keep working unchanged — no page had to be rewritten, and no handler
 * changed behaviour. Anything already written as alert('...') now renders
 * as a styled toast in Bastion's own visual language.
 *
 * NOTE ON BEHAVIOUR: native alert() is BLOCKING — it pauses JS until
 * dismissed. A toast is not. Code written as `alert(x); doSomething();`
 * now runs doSomething() immediately rather than after dismissal. That is
 * the desired behaviour in every current call site (they all alert and
 * then return, or alert as the last statement), but it is worth knowing
 * before adding new ones. For anything that genuinely needs to block on a
 * user's answer, use the existing showConfirmModal() instead.
 */
(function () {
  'use strict';

  var CONTAINER_ID = 'bastionToastRoot';

  function ensureStyles() {
    if (document.getElementById('bastionToastStyles')) return;
    var css = document.createElement('style');
    css.id = 'bastionToastStyles';
    css.textContent = [
      '#' + CONTAINER_ID + '{',
      '  position:fixed; top:16px; left:50%; transform:translateX(-50%);',
      '  z-index:99999; display:flex; flex-direction:column; gap:10px;',
      '  width:calc(100% - 32px); max-width:420px; pointer-events:none;',
      '}',
      '.bastion-toast{',
      '  pointer-events:auto; position:relative;',
      '  background:#15171B; color:#F1ECE1;',
      '  border:1px solid rgba(241,236,225,0.10);',
      '  border-radius:6px; padding:14px 40px 14px 16px;',
      '  font-family:Inter,system-ui,sans-serif; font-size:13.5px; line-height:1.55;',
      '  box-shadow:0 12px 34px rgba(0,0,0,0.55);',
      '  opacity:0; transform:translateY(-8px);',
      '  transition:opacity .22s cubic-bezier(.22,.61,.36,1), transform .22s cubic-bezier(.22,.61,.36,1);',
      '  overflow-wrap:break-word;',
      '}',
      '.bastion-toast.in{ opacity:1; transform:translateY(0); }',
      /* A brass rule on the leading edge, matching the treatment used on
         dashboard cards and message bubbles. */
      '.bastion-toast::before{',
      '  content:""; position:absolute; left:0; top:0; bottom:0; width:2px;',
      '  background:#C7A268; border-radius:6px 0 0 6px;',
      '}',
      '.bastion-toast.error::before{ background:#C9776B; }',
      '.bastion-toast.success::before{ background:#2C5C4F; }',
      '.bastion-toast-x{',
      '  position:absolute; top:8px; right:8px;',
      '  background:none; border:none; cursor:pointer;',
      '  color:#5B5D62; font-size:17px; line-height:1;',
      '  width:26px; height:26px; border-radius:4px;',
      '}',
      '.bastion-toast-x:hover{ color:#F1ECE1; }',
      '@media (prefers-reduced-motion: reduce){',
      '  .bastion-toast{ transition:none; opacity:1; transform:none; }',
      '}'
    ].join('\n');
    document.head.appendChild(css);
  }

  function root() {
    var el = document.getElementById(CONTAINER_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = CONTAINER_ID;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    return el;
  }

  function dismiss(node) {
    if (!node || node.dataset.closing) return;
    node.dataset.closing = '1';
    node.classList.remove('in');
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 240);
  }

  function toast(message, kind) {
    ensureStyles();
    var text = String(message == null ? '' : message);

    var node = document.createElement('div');
    node.className = 'bastion-toast' + (kind ? ' ' + kind : '');

    // textContent, not innerHTML — messages can include user-supplied
    // content (error text, item names) and must never be parsed as markup.
    var body = document.createElement('div');
    body.textContent = text;
    node.appendChild(body);

    var close = document.createElement('button');
    close.className = 'bastion-toast-x';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '&times;';
    close.addEventListener('click', function () { dismiss(node); });
    node.appendChild(close);

    root().appendChild(node);
    requestAnimationFrame(function () { node.classList.add('in'); });

    // Longer messages need longer to read; cap so nothing lingers.
    var ms = Math.min(9000, Math.max(4000, text.length * 55));
    setTimeout(function () { dismiss(node); }, ms);

    return node;
  }

  // Guess intent from the wording so errors read as errors without every
  // existing call site needing a second argument.
  function classify(text) {
    var t = String(text || '').toLowerCase();
    if (/could not|couldn't|failed|error|not allowed|unable|invalid|denied|too large|rejected|wrong|expired|no longer/.test(t)) {
      return 'error';
    }
    if (/success|saved|sent|created|updated|released|confirmed|approved|copied/.test(t)) {
      return 'success';
    }
    return '';
  }

  window.bastionToast = toast;

  // Override the native dialog. Every existing alert('...') call across the
  // site now renders as a toast, with no page edits required.
  window.alert = function (message) {
    toast(message, classify(message));
  };
})();
