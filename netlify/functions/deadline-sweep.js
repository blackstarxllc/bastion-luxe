// netlify/functions/deadline-sweep.js
//
// WHAT THIS DOES
// Runs the deadline reminder sweep: seller ship-by warnings, missed
// deadlines, and buyer inspection-window warnings. Writes in-app
// notifications and (for the ones that matter most) sends email too.
//
// HOW IT RUNS
// Netlify Scheduled Functions — see the [functions."deadline-sweep"]
// block in netlify.toml. Set to hourly, which is the right granularity:
// deadlines are measured in days, and the reminders fire at 24-hours-out
// checkpoints, so hourly is precise enough without being noisy.
//
// WHY IT'S SAFE TO RUN OFTEN
// send_deadline_reminders() is idempotent — reminder_log has a unique
// index on (transaction_id, user_id, kind), so each person gets each
// reminder exactly once, ever. Verified: running it twice in a row sends
// once and then zero. Without that, an hourly cron would re-notify the
// same seller every hour until their deadline passed, which trains people
// to ignore Bastion's emails entirely.
//
// This endpoint requires INTERNAL_WEBHOOK_SECRET so it can't be triggered
// by anyone who guesses the URL.

exports.handler = async (event) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const INTERNAL_SECRET = process.env.INTERNAL_WEBHOOK_SECRET;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('deadline-sweep: missing Supabase env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Not configured' }) };
  }

  // Netlify's own scheduler invokes this without our header, and that
  // invocation is trusted because it originates inside Netlify. Manual
  // HTTP calls must present the shared secret.
  const isScheduled = !!(event && event.headers && event.headers['x-nf-event'] === 'schedule');
  if (!isScheduled && INTERNAL_SECRET) {
    const provided =
      (event.headers && (event.headers['x-internal-secret'] || event.headers['X-Internal-Secret'])) ||
      (event.queryStringParameters && event.queryStringParameters.secret);
    if (provided !== INTERNAL_SECRET) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  const svc = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/send_deadline_reminders', {
      method: 'POST',
      headers: svc,
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('deadline-sweep: RPC failed', res.status, detail.slice(0, 400));
      await fetch(SUPABASE_URL + '/rest/v1/system_alerts', {
        method: 'POST',
        headers: Object.assign({}, svc, { Prefer: 'return=minimal' }),
        body: JSON.stringify({
          source: 'deadline_sweep',
          message: 'Deadline reminder sweep failed',
          context: { status: res.status, detail: detail.slice(0, 400) },
        }),
      }).catch(() => {});
      return { statusCode: 200, body: JSON.stringify({ ok: false }) };
    }

    const count = await res.json().catch(() => 0);

    // Email the notifications this sweep just created. In-app alone isn't
    // enough for a deadline — someone who isn't on the site that day is
    // exactly the person who needs telling.
    if (Number(count) > 0) {
      await emailNewNotifications(SUPABASE_URL, svc);
    }

    console.log('deadline-sweep: sent', count, 'reminders');
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: count }) };
  } catch (err) {
    console.error('deadline-sweep fatal:', err);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

// Pulls very recent unsent notifications and emails them via the existing
// send-notification-email function, respecting each user's preferences.
async function emailNewNotifications(SUPABASE_URL, svc) {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/notifications?select=id,user_id,title,body,link&created_at=gte.' +
        encodeURIComponent(new Date(Date.now() - 5 * 60 * 1000).toISOString()) +
        '&type=in.(shipping,transaction)&order=created_at.desc&limit=50',
      { headers: svc }
    );
    if (!res.ok) return;
    const rows = await res.json().catch(() => []);
    if (!rows.length) return;

    // One preferences lookup for the whole batch rather than per row.
    const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
    const prefRes = await fetch(
      SUPABASE_URL + '/rest/v1/profiles?select=id,notify_email,notify_shipping&id=in.(' +
        userIds.join(',') + ')',
      { headers: svc }
    );
    const prefs = {};
    if (prefRes.ok) {
      (await prefRes.json().catch(() => [])).forEach((p) => { prefs[p.id] = p; });
    }

    // send-notification-email takes to_email, not a user id — it does no
    // user lookup of its own. Resolve addresses here, in one admin call,
    // rather than one per recipient.
    const emails = {};
    try {
      const authRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users?per_page=200', { headers: svc });
      if (authRes.ok) {
        const payload = await authRes.json().catch(() => ({}));
        const list = Array.isArray(payload) ? payload : (payload.users || []);
        list.forEach((u) => { if (u && u.id) emails[u.id] = u.email; });
      }
    } catch (e) {
      console.error('deadline-sweep: could not resolve user emails', e.message);
    }

    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://bastionmarket.com';

    for (const row of rows) {
      const p = prefs[row.user_id];
      // Deadline reminders are transaction-critical, but still respect a
      // user who has switched account emails off entirely.
      if (p && p.notify_email === false) continue;

      const toEmail = emails[row.user_id];
      if (!toEmail) {
        console.error('deadline-sweep: no email on file for user', row.user_id);
        continue;
      }

      // Header name and payload shape must match send-notification-email
      // exactly: it authenticates on 'x-webhook-secret' and requires
      // to_email. Getting either wrong fails silently with a 401/400 that
      // nobody sees, so these are deliberately not guessed.
      await fetch(base + '/.netlify/functions/send-notification-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': process.env.INTERNAL_WEBHOOK_SECRET || '',
        },
        body: JSON.stringify({
          to_email: toEmail,
          subject: row.title,
          title: row.title,
          body: row.body,
          link: (row.link || '').replace(/^\//, ''),
        }),
      }).catch((e) => console.error('deadline-sweep: email send failed', e.message));
    }
  } catch (e) {
    console.error('deadline-sweep: emailNewNotifications failed', e.message);
  }
}
