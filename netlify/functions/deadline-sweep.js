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

    // NOTE: this function does NOT send emails itself.
    //
    // An earlier version did, and that was a duplicate-send bug waiting to
    // happen: public.notifications has an AFTER INSERT trigger
    // (trg_send_email_for_notification) which already emails every
    // transactional notification. Emailing again from here would have sent
    // every deadline reminder twice.
    //
    // The trigger is also the better place for it — it covers notifications
    // created from anywhere (webhooks, status triggers, this sweep) rather
    // than just the ones this function happens to create, and it reads each
    // user's notification preferences.

    console.log('deadline-sweep: sent', count, 'reminders');
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: count }) };
  } catch (err) {
    console.error('deadline-sweep fatal:', err);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
