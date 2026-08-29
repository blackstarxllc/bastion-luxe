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
    const { name, email, subject, message, user_id } = JSON.parse(event.body || '{}');

    if (!name || !email || !subject || !message) {
      return { statusCode: 400, body: JSON.stringify({ error: 'name, email, subject, and message are all required' }) };
    }
    if (name.length > 200 || subject.length > 200 || message.length > 5000 || email.length > 320) {
      return { statusCode: 400, body: JSON.stringify({ error: 'One of the fields is too long' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // 1) Save it, so it's tracked in the Admin panel even if the email below fails.
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/support_requests`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        name, email, subject, message,
        user_id: user_id || null,
      }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not save your request', detail: errText }) };
    }

    // 2) Email the team, best-effort — a failure here doesn't lose the request,
    // since it's already saved above.
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Bastion <onboarding@resend.dev>';
    const SUPPORT_NOTIFY_EMAIL = process.env.SUPPORT_NOTIFY_EMAIL;

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
          from: RESEND_FROM_EMAIL,
          to: [SUPPORT_NOTIFY_EMAIL],
          reply_to: email,
          subject: `[Support] ${subject}`,
          html,
        }),
      });
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
