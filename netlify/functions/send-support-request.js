// netlify/functions/send-support-request.js
//
// WHAT THIS DOES:
// Handles the public "Contact Support" form. Anyone can call this
// (no login required) — it saves the request to Supabase so it shows
// up in the Admin panel, AND emails the Bastion team immediately via
// Resend with "reply-to" set to the person who wrote in, so replying
// goes straight back to them.
//
// REQUIRES these Netlify environment variables (RESEND_* already set
// for the notification-email feature; SUPPORT_NOTIFY_EMAIL is new):
//   RESEND_API_KEY
//   RESEND_FROM_EMAIL
//   SUPPORT_NOTIFY_EMAIL   - where support requests land, e.g. blackstarxllc@gmail.com
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    // user_id is NEVER taken from the request body. If the caller is signed
    // in, the account is derived from their verified session token; a
    // browser could otherwise file a ticket under someone else's account.
    const { name, email, subject, message } = JSON.parse(event.body || '{}');
    let verifiedUserId = null;
    const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
    if (bearer && process.env.SUPABASE_URL) {
      const who = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
        headers: { apikey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + bearer },
      }).catch(() => null);
      if (who && who.ok) {
        const u = await who.json().catch(() => null);
        if (u && u.id) verifiedUserId = u.id;
      }
    }

    if (!name || !email || !subject || !message) {
      return { statusCode: 400, body: JSON.stringify({ error: 'name, email, subject, and message are all required' }) };
    }
    if (name.length > 200 || subject.length > 200 || message.length > 5000 || email.length > 320) {
      return { statusCode: 400, body: JSON.stringify({ error: 'One of the fields is too long' }) };
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid email address' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const clientIp = event.headers['x-nf-client-connection-ip']
      || event.headers['client-ip']
      || (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || 'unknown';

    // ---- Rate limiting: reject before writing anything or sending email ----
    // Max 3 submissions per IP per hour, and max 5 per email per 24 hours.
    // This is a basic guard against flooding, not a full anti-abuse system —
    // a determined attacker could still rotate both, but this stops casual spam.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const supaHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    };

    if (clientIp !== 'unknown') {
      const ipCheckRes = await fetch(
        `${SUPABASE_URL}/rest/v1/support_requests?select=id&ip_address=eq.${encodeURIComponent(clientIp)}&created_at=gte.${encodeURIComponent(oneHourAgo)}`,
        { headers: { ...supaHeaders, Prefer: 'count=exact' } }
      );
      const ipCount = parseInt((ipCheckRes.headers.get('content-range') || '').split('/')[1] || '0', 10);
      if (ipCount >= 3) {
        return { statusCode: 429, body: JSON.stringify({ error: "You've sent a few messages recently — please wait a bit before sending another." }) };
      }
    }

    const emailCheckRes = await fetch(
      `${SUPABASE_URL}/rest/v1/support_requests?select=id&email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(oneDayAgo)}`,
      { headers: { ...supaHeaders, Prefer: 'count=exact' } }
    );
    const emailCount = parseInt((emailCheckRes.headers.get('content-range') || '').split('/')[1] || '0', 10);
    if (emailCount >= 5) {
      return { statusCode: 429, body: JSON.stringify({ error: "We've received several messages from this email today — our team will get back to you soon." }) };
    }

    // 1) Save it, so it's tracked in the Admin panel even if the email below fails.
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/support_requests`, {
      method: 'POST',
      headers: {
        ...supaHeaders,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        name, email, subject, message,
        user_id: verifiedUserId,
        ip_address: clientIp !== 'unknown' ? clientIp : null,
      }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not save your request', detail: errText }) };
    }

    // 2) Email the team, best-effort — a failure here doesn't lose the request,
    // since it's already saved above.
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    // Support mail goes out under its own identity rather than the generic
    // notifications address, so a customer replying to a support thread is
    // replying to support@ — not to a no-reply notifications mailbox.
    const SUPPORT_FROM_EMAIL = process.env.SUPPORT_FROM_EMAIL
      || 'Bastion Support <support@bastionmarket.com>';
    const SUPPORT_NOTIFY_EMAIL = process.env.SUPPORT_NOTIFY_EMAIL;

    if (!SUPPORT_NOTIFY_EMAIL) {
      console.error('send-support-request: SUPPORT_NOTIFY_EMAIL is not set — request saved but nobody was emailed');
    }

    if (RESEND_API_KEY && SUPPORT_NOTIFY_EMAIL) {
      const html = `
        <div style="font-family:Georgia,serif;background:#0A0B0D;color:#F1ECE1;padding:32px;">
          <div style="max-width:520px;margin:0 auto;">
            <div style="font-size:22px;margin-bottom:24px;">Bast<span style="color:#C7A268;font-style:italic;">ion</span> Support</div>
            <p style="font-size:13px;color:#8D8F94;margin:0 0 4px;">From</p>
            <p style="font-size:15px;margin:0 0 16px;">${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
            <p style="font-size:13px;color:#8D8F94;margin:0 0 4px;">Subject</p>
            <p style="font-size:15px;margin:0 0 16px;">${escapeHtml(subject)}</p>
            <p style="font-size:13px;color:#8D8F94;margin:0 0 4px;">Message</p>
            <p style="font-size:14px;line-height:1.6;color:#D8D3C6;white-space:pre-wrap;">${escapeHtml(message)}</p>
          </div>
        </div>`;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: SUPPORT_FROM_EMAIL,
          to: [SUPPORT_NOTIFY_EMAIL],
          // Replying in the inbox goes straight back to the customer.
          reply_to: email,
          subject: `[Support] ${subject}`,
          html,
        }),
      }).then(async (r) => {
        if (r && !r.ok) {
          const detail = await r.text().catch(() => '');
          console.error('send-support-request: team email rejected', r.status, detail.slice(0, 300));
          // Silent email failure on a support request is the worst kind —
          // the customer thinks they've been heard and nobody has seen it.
          await fetch(`${SUPABASE_URL}/rest/v1/system_alerts`, {
            method: 'POST',
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({
              source: 'support_request',
              message: 'Support notification email was rejected — a customer request may be unseen',
              context: { to: SUPPORT_NOTIFY_EMAIL, status: r.status, detail: detail.slice(0, 300) },
            }),
          }).catch(() => {});
        } else {
          console.log('send-support-request: notified', SUPPORT_NOTIFY_EMAIL);
        }
      }).catch((e) => console.error('send-support-request: team email failed', e.message));

      // Acknowledge to the customer. Without this, someone who writes in
      // has no idea whether it went anywhere, and the usual next move is
      // to submit the same request three more times.
      const ackHtml = `
        <div style="font-family:Georgia,serif;background:#0A0B0D;color:#F1ECE1;padding:32px;">
          <div style="max-width:520px;margin:0 auto;">
            <div style="font-size:22px;margin-bottom:20px;">Bast<span style="color:#C7A268;font-style:italic;">ion</span></div>
            <p style="font-size:15px;line-height:1.65;margin:0 0 16px;">Hi ${escapeHtml(name)}, we've got your message and it's with the Bastion support team.</p>
            <p style="font-size:14px;line-height:1.65;color:#D8D3C6;margin:0 0 20px;">You'll get a reply at this address. Just reply to this email if you need to add anything — it stays on the same thread.</p>
            <div style="border-left:2px solid #C7A268;padding-left:14px;margin:0 0 20px;">
              <p style="font-size:12px;color:#8D8F94;margin:0 0 4px;">Your message</p>
              <p style="font-size:13px;color:#8D8F94;margin:0 0 8px;"><strong style="color:#F1ECE1;">${escapeHtml(subject)}</strong></p>
              <p style="font-size:13px;line-height:1.6;color:#8D8F94;white-space:pre-wrap;margin:0;">${escapeHtml(message)}</p>
            </div>
            <p style="font-size:12px;color:#5B5D62;line-height:1.6;margin:0;">If this is about a live order, please note that contacting support does not pause your order. If something is wrong with an item you received, open a dispute from the order page before your inspection period ends: that is what holds the funds in escrow.</p>
          </div>
        </div>`;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: SUPPORT_FROM_EMAIL,
          to: [email],
          reply_to: SUPPORT_NOTIFY_EMAIL,
          subject: `We received your message — ${subject}`,
          html: ackHtml,
        }),
      }).catch((e) => console.error('send-support-request: ack email failed', e.message));
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
