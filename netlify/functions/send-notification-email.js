// netlify/functions/send-notification-email.js
//
// Sends one Bastion notification email through Resend. Called by the
// database (send_email_for_notification trigger, via pg_net) and by the
// hourly sweep when it retries a delivery.
//
// Delivery is PROVEN, not assumed (2026-09-25):
//   * Fails CLOSED. A missing RESEND_API_KEY or RESEND_FROM_EMAIL used to
//     return 200 "skipped", and the sender silently fell back to Resend's
//     onboarding test address. Now it raises a system alert and returns 503.
//   * Records the outcome on the notification row (email_status 'sent' or
//     'failed'), so the sweep can retry failures instead of losing them.
//   * Sends with a Resend Idempotency-Key per notification, so a retry can
//     never deliver the same email twice.
//   * Includes a plain-text part (better inbox placement) and a Reply-To that
//     reaches a real, monitored inbox: notifications@ cannot receive mail, so
//     a customer's reply used to bounce.
'use strict';
const crypto = require('crypto');

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Only relative Bastion paths are ever linked. Anything else falls back to
// the marketplace, so a notification can never carry an off-site link.
function safeLink(link) {
  const l = String(link || '');
  return /^[a-z0-9][a-z0-9\-_.]*\.html(\?[a-z0-9=&%\-_.]*)?$/i.test(l) ? l : 'bastion-marketplace.html';
}

async function supabase(path, init) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return fetch(url + '/rest/v1/' + path, Object.assign({
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
  }, init || {})).catch(() => null);
}

async function recordOutcome(notificationId, patch) {
  if (!notificationId) return;
  await supabase('notifications?id=eq.' + encodeURIComponent(notificationId), { method: 'PATCH', body: JSON.stringify(patch) });
}

async function alert(message, context) {
  await supabase('system_alerts', { method: 'POST', body: JSON.stringify({ source: 'notification_email', message, context: context || {} }) });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const incoming = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'];
  if (!safeEqual(incoming, process.env.INTERNAL_WEBHOOK_SECRET)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const { notification_id, to_email, subject, title, body, link } = payload;
  if (!to_email || !subject) {
    return { statusCode: 400, body: JSON.stringify({ error: 'to_email and subject are required' }) };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.RESEND_FROM_EMAIL;
  if (!RESEND_API_KEY || !FROM) {
    await alert('Notification email is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL missing); nothing can be sent', { notification_id });
    await recordOutcome(notification_id, { email_status: 'failed', email_error: 'email service not configured' });
    return { statusCode: 503, body: JSON.stringify({ sent: false, error: 'Email service not configured' }) };
  }

  const url = 'https://bastionmarket.com/' + safeLink(link);
  const heading = title || subject;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0A0B0D;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0A0B0D"><tr><td align="center" style="padding-top:32px;padding-bottom:32px;">
<table width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
<tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:28px;color:#F1ECE1;padding-bottom:24px;">Bast<span style="color:#C7A268;font-style:italic;">ion</span></td></tr>
<tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:20px;line-height:26px;color:#F1ECE1;padding-bottom:12px;">${escapeHtml(heading)}</td></tr>
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#D8D3C6;padding-bottom:20px;">${escapeHtml(body || '')}</td></tr>
<tr><td bgcolor="#C7A268" style="border-radius:8px;"><a href="${escapeHtml(url)}" style="display:block;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#171308;text-decoration:none;padding-top:12px;padding-bottom:12px;padding-left:22px;padding-right:22px;letter-spacing:0.05em;text-transform:uppercase;">View on Bastion</a></td></tr>
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:#5B5D62;padding-top:24px;">You are receiving this because you have an account on Bastion. Manage email preferences in My Account.</td></tr>
</table></td></tr></table></body></html>`;
  const text = heading + '\n\n' + (body || '') + '\n\nView on Bastion: ' + url +
    '\n\nYou are receiving this because you have an account on Bastion. Manage email preferences in My Account.';

  const message = { from: FROM, to: [to_email], subject, html, text };
  if (process.env.SUPPORT_NOTIFY_EMAIL) message.reply_to = process.env.SUPPORT_NOTIFY_EMAIL;

  const headers = { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' };
  if (notification_id) headers['Idempotency-Key'] = 'bastion-notification-' + notification_id;

  let res;
  try {
    res = await fetch('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify(message) });
  } catch (netErr) {
    await recordOutcome(notification_id, { email_status: 'failed', email_error: 'network: ' + String(netErr.message).slice(0, 200) });
    return { statusCode: 502, body: JSON.stringify({ sent: false, error: 'Could not reach Resend' }) };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    await recordOutcome(notification_id, { email_status: 'failed', email_error: res.status + ': ' + detail });
    await alert('Resend rejected a notification email', { notification_id, status: res.status, detail });
    return { statusCode: 502, body: JSON.stringify({ sent: false, error: 'Resend rejected the email' }) };
  }
  await recordOutcome(notification_id, { email_status: 'sent', email_sent_at: new Date().toISOString(), email_error: null });
  return { statusCode: 200, body: JSON.stringify({ sent: true }) };
};

exports.safeLink = safeLink;
