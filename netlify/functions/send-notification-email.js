// netlify/functions/send-notification-email.js
//
// WHAT THIS DOES:
// Sends a real transactional email via Resend for important account
// events (funds available, item sold/funded, a transaction was
// cancelled or disputed). It is called by a Postgres trigger in
// Supabase the moment the relevant row changes — not from the
// browser — so a user can't spoof or skip it.
//
// SECURITY: only accepts requests carrying the shared secret Bastion's
// own database trigger sends. Anyone else calling this URL gets rejected.
//
// REQUIRES the following Netlify environment variables to actually send:
//   RESEND_API_KEY      - from resend.com
//   RESEND_FROM_EMAIL    - a verified sender, e.g. "Bastion <notify@bastionmarket.com>"
//   INTERNAL_WEBHOOK_SECRET - already set; shared with the DB trigger

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const incomingSecret = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'];
  if (!incomingSecret || incomingSecret !== process.env.INTERNAL_WEBHOOK_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Bastion <onboarding@resend.dev>';

  if (!RESEND_API_KEY) {
    // No key configured yet — fail quietly rather than erroring the trigger.
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'RESEND_API_KEY not configured' }) };
  }

  try {
    const { to_email, subject, title, body, link } = JSON.parse(event.body || '{}');
    if (!to_email || !subject) {
      return { statusCode: 400, body: JSON.stringify({ error: 'to_email and subject are required' }) };
    }

    const siteUrl = 'https://bastionmarket.com/' + (link || 'bastion-marketplace.html');

    const html = `
      <div style="font-family:Georgia,serif;background:#0A0B0D;color:#F1ECE1;padding:32px;">
        <div style="max-width:480px;margin:0 auto;">
          <div style="font-size:22px;margin-bottom:24px;">Bast<span style="color:#C7A268;font-style:italic;">ion</span></div>
          <h1 style="font-size:20px;font-weight:500;margin:0 0 12px;">${escapeHtml(title || subject)}</h1>
          <p style="font-size:14px;line-height:1.6;color:#D8D3C6;">${escapeHtml(body || '')}</p>
          <a href="${siteUrl}" style="display:inline-block;margin-top:20px;background:#C7A268;color:#171308;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;">View on Bastion</a>
        </div>
      </div>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [to_email],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Resend rejected the email', detail: errText }) };
    }

    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
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
