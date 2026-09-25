// netlify/functions/deadline-sweep.js
//
// Runs every hour (netlify.toml: schedule "@hourly"). Four jobs:
//
//   1. Deadline reminders           (send_deadline_reminders RPC, unchanged)
//   2. Escrow.com reconciliation    every open order is re-read from
//                                   Escrow.com and moved FORWARD if a
//                                   webhook was missed
//   3. Carrier reconciliation       every in-flight shipment is re-read from
//                                   EasyPost through the tracking webhook's
//                                   own logic
//   4. Abandoned checkouts          an unpaid order that never reached
//                                   Escrow.com is cancelled after 24 hours,
//                                   so the listing is not held forever
//
// Why 2 and 3 matter: the webhooks return 200 even when processing fails,
// because Escrow.com disabled this site's webhook once after error
// responses. Without a reconciler, one lost or failed notification would
// leave an order stuck forever. With it, the worst case is one hour.
//
// Auth: Netlify's scheduler invokes this with x-nf-event: schedule. Any
// other caller must present INTERNAL_WEBHOOK_SECRET in the x-internal-secret
// header. If that secret is not configured, non-scheduled calls are REFUSED
// (this used to fail open), and query-string secrets are no longer accepted.
'use strict';
const crypto = require('crypto');
const escrowLib = require('./_escrow-lib');
const { deriveStatus, nextTransactionStatus } = require('./escrow-webhook');

const OPEN_STATUSES = ['pending_payment', 'funded', 'shipped', 'in_transit', 'delivered',
  'disputed', 'return_approved', 'return_in_transit'];
const BATCH = 40;

exports.handler = async (event) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) {
    console.error('deadline-sweep: missing Supabase env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Not configured' }) };
  }

  const headers = (event && event.headers) || {};
  const isScheduled = headers['x-nf-event'] === 'schedule';
  if (!isScheduled) {
    const secret = process.env.INTERNAL_WEBHOOK_SECRET;
    const provided = headers['x-internal-secret'] || headers['X-Internal-Secret'];
    const ok = secret && provided && provided.length === secret.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (!ok) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const svc = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const sb = (path, init) => fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({ headers: svc }, init || {}));
  async function alert(message, context) {
    await sb('system_alerts', {
      method: 'POST', headers: Object.assign({}, svc, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ source: 'deadline_sweep', message, context: context || {} }),
    }).catch(() => {});
  }

  const report = { reminders: null, escrowChecked: 0, escrowAdvanced: 0, trackingChecked: 0, abandonedCancelled: 0, errors: 0 };

  // 1. Deadline reminders
  try {
    const res = await sb('rpc/send_deadline_reminders', { method: 'POST', body: '{}' });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      report.errors++;
      await alert('Deadline reminder sweep failed', { status: res.status, detail: detail.slice(0, 400) });
    } else {
      report.reminders = await res.json().catch(() => 0);
    }
  } catch (e) { report.errors++; await alert('Deadline reminder sweep threw', { error: e.message }); }

  // 2. Escrow.com reconciliation
  try {
    const { email, apiKey } = escrowLib.escrowCredentials();
    const rowsRes = await sb('transactions?escrow_transaction_id=not.is.null&status=in.(' + OPEN_STATUSES.join(',') + ')' +
      '&select=id,status,escrow_transaction_id,funded_at,released_at&order=created_at.asc&limit=' + BATCH);
    const rows = rowsRes.ok ? await rowsRes.json() : [];
    for (const row of rows) {
      report.escrowChecked++;
      const loaded = await escrowLib.fetchTransaction({ escrowTransactionId: row.escrow_transaction_id, email, apiKey });
      if (!loaded.ok) { report.errors++; continue; }
      const verified = deriveStatus(loaded.txn);
      const next = nextTransactionStatus(row.status, verified);
      if (!next) continue;
      const nowIso = new Date().toISOString();
      const patch = { status: next, escrow_status: verified };
      if (next === 'funded' && !row.funded_at) patch.funded_at = nowIso;
      if (next === 'released' && !row.released_at) patch.released_at = nowIso;
      const up = await sb('transactions?id=eq.' + encodeURIComponent(row.id) + '&status=eq.' + encodeURIComponent(row.status), {
        method: 'PATCH', headers: Object.assign({}, svc, { Prefer: 'return=minimal' }), body: JSON.stringify(patch),
      });
      if (up.ok) {
        report.escrowAdvanced++;
        await alert('Reconciler applied an Escrow.com state change that no webhook had delivered', { transactionId: row.id, from: row.status, to: next });
      } else {
        report.errors++;
        await alert('Reconciler could not apply an Escrow.com state change', { transactionId: row.id, from: row.status, to: next, status: up.status });
      }
    }
  } catch (e) { report.errors++; await alert('Escrow.com reconciliation threw', { error: e.message }); }

  // 3. Carrier reconciliation: replay each in-flight tracking number through
  //    the tracking webhook's own handler, signed exactly as EasyPost signs,
  //    so there is one code path for carrier state, not two.
  try {
    const secret = process.env.SHIPPING_WEBHOOK_SECRET;
    if (secret) {
      const shipping = require('./shipping-webhook');
      const shipRes = await sb('shipments?tracking_number=not.is.null&status=not.in.(delivered,returned,cancelled)' +
        '&select=tracking_number&order=created_at.asc&limit=' + BATCH);
      const ships = shipRes.ok ? await shipRes.json() : [];
      for (const s of ships) {
        report.trackingChecked++;
        const body = JSON.stringify({ description: 'tracker.updated', result: { object: 'Tracker', tracking_code: s.tracking_number } });
        const sig = 'hmac-sha256-hex=' + crypto.createHmac('sha256', String(secret).normalize('NFKD')).update(body).digest('hex');
        await shipping.handler({ httpMethod: 'POST', body, headers: { 'x-hmac-signature': sig }, isBase64Encoded: false })
          .catch(() => { report.errors++; });
      }
    }
  } catch (e) { report.errors++; await alert('Carrier reconciliation threw', { error: e.message }); }

  // 4. Abandoned checkouts (never reached Escrow.com, so nothing to refund)
  try {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await sb('transactions?status=eq.pending_payment&escrow_transaction_id=is.null&escrow_claimed_at=is.null' +
      '&created_at=lt.' + encodeURIComponent(cutoff), {
      method: 'PATCH', headers: Object.assign({}, svc, { Prefer: 'return=representation' }),
      body: JSON.stringify({ status: 'cancelled', escrow_status: 'abandoned_before_payment' }),
    });
    const cancelled = res.ok ? await res.json().catch(() => []) : [];
    report.abandonedCancelled = cancelled.length;
  } catch (e) { report.errors++; await alert('Abandoned-checkout cleanup threw', { error: e.message }); }

  console.log('deadline-sweep:', JSON.stringify(report));
  return { statusCode: 200, body: JSON.stringify(Object.assign({ ok: report.errors === 0 }, report)) };
};
