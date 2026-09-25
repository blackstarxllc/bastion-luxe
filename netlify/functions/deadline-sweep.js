// netlify/functions/deadline-sweep.js
//
// Runs every hour (netlify.toml: schedule "@hourly"). Jobs, in order:
//
//   1. Deadline reminders        send_deadline_reminders RPC
//   2. Escrow.com reconciliation  re-read open orders from Escrow.com and move
//                                 state FORWARD where a webhook was missed
//   3. Carrier reconciliation     re-read in-flight parcels from EasyPost via
//                                 the same processTracking() the webhook uses
//   4. Email retries              re-send notification emails left 'queued'
//                                 or 'failed' (max 3 attempts, 48 hours)
//   5. Abandoned checkouts        withdraw unpaid orders that never reached
//                                 Escrow.com, after 24 hours
//
// Hardened 2026-09-25 (Audit #4 P1-5 / P1-6 / P1-7):
//   * TIME BUDGET. Scheduled functions have a hard execution limit. Work
//     stops being started after BUDGET_MS, and whatever is left is picked up
//     next hour. Nothing is ever cut off half-applied.
//   * BOUNDED CONCURRENCY. Provider calls run a few at a time, not serially.
//   * FAIR ROTATION. Orders and parcels are checked least-recently-checked
//     first (provider_checked_at / tracking_checked_at), so none is starved.
//   * A FAILED READ IS AN ALERT, never "there was nothing to do".
//   * No synthetic webhooks: carrier state goes through processTracking().
//
// Auth: Netlify's scheduler sends x-nf-event: schedule. Any other caller
// must present INTERNAL_WEBHOOK_SECRET in x-internal-secret; with no secret
// configured, manual calls are refused.
'use strict';
const crypto = require('crypto');
const escrowLib = require('./_escrow-lib');
const { deriveStatus, nextTransactionStatus } = require('./escrow-webhook');

const OPEN_STATUSES = ['pending_payment', 'funded', 'shipped', 'in_transit', 'delivered',
  'disputed', 'return_approved', 'return_in_transit'];
const BATCH = 25;
const CONCURRENCY = 4;
const BUDGET_MS = 20000;

async function pool(items, limit, worker, outOfTime) {
  let i = 0;
  async function lane() {
    while (i < items.length && !outOfTime()) {
      const item = items[i++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

exports.handler = async (event) => {
  const started = Date.now();
  const outOfTime = () => Date.now() - started > BUDGET_MS;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) {
    console.error('deadline-sweep: missing Supabase env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Not configured' }) };
  }

  const headers = (event && event.headers) || {};
  if (headers['x-nf-event'] !== 'schedule') {
    const secret = process.env.INTERNAL_WEBHOOK_SECRET;
    const provided = headers['x-internal-secret'] || headers['X-Internal-Secret'];
    const ok = secret && provided && provided.length === secret.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (!ok) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const svc = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const sb = (path, init) => fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({ headers: svc }, init || {}));
  const patch = (path, body) => sb(path, { method: 'PATCH', headers: Object.assign({}, svc, { Prefer: 'return=minimal' }), body: JSON.stringify(body) });
  async function alert(message, context) {
    await sb('system_alerts', {
      method: 'POST', headers: Object.assign({}, svc, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ source: 'deadline_sweep', message, context: context || {} }),
    }).catch(() => {});
  }
  // A read that fails is reported and returns null: never an empty list.
  async function readRows(label, path, init) {
    try {
      const res = await sb(path, init);
      if (!res.ok) {
        report.errors++;
        await alert('Sweep could not read ' + label + '; this job was skipped this hour', { status: res.status, detail: (await res.text().catch(() => '')).slice(0, 300) });
        return null;
      }
      return await res.json();
    } catch (e) {
      report.errors++;
      await alert('Sweep could not read ' + label + '; this job was skipped this hour', { error: e.message });
      return null;
    }
  }

  const report = { reminders: null, escrowChecked: 0, escrowAdvanced: 0, trackingChecked: 0,
                   emailsRetried: 0, abandonedCancelled: 0, errors: 0, stoppedForTime: false };

  // 1. Deadline reminders
  const reminders = await readRows('deadline reminders', 'rpc/send_deadline_reminders', { method: 'POST', body: '{}' });
  if (reminders !== null) report.reminders = reminders;

  // 2. Escrow.com reconciliation
  if (!outOfTime()) {
    const rows = await readRows('open orders',
      'transactions?escrow_transaction_id=not.is.null&status=in.(' + OPEN_STATUSES.join(',') + ')' +
      '&select=id,status,escrow_transaction_id,funded_at,released_at&order=provider_checked_at.asc.nullsfirst&limit=' + BATCH);
    if (rows) {
      const { email, apiKey } = escrowLib.escrowCredentials();
      await pool(rows, CONCURRENCY, async (row) => {
        report.escrowChecked++;
        const loaded = await escrowLib.fetchTransaction({ escrowTransactionId: row.escrow_transaction_id, email, apiKey });
        if (!loaded.ok) {
          report.errors++;
          await patch('transactions?id=eq.' + encodeURIComponent(row.id), { provider_checked_at: new Date().toISOString(), provider_state: 'unreachable:' + loaded.status });
          return;
        }
        const verified = deriveStatus(loaded.txn);
        const next = nextTransactionStatus(row.status, verified);
        const nowIso = new Date().toISOString();
        const body = { provider_checked_at: nowIso, provider_state: verified };
        if (next) {
          body.status = next;
          body.escrow_status = verified;
          if (next === 'funded' && !row.funded_at) body.funded_at = nowIso;
          if (next === 'released' && !row.released_at) body.released_at = nowIso;
        }
        const up = await patch('transactions?id=eq.' + encodeURIComponent(row.id) + '&status=eq.' + encodeURIComponent(row.status), body);
        if (!up.ok) {
          report.errors++;
          await alert('Reconciler could not record an Escrow.com comparison', { transactionId: row.id, to: next, status: up.status });
        } else if (next) {
          report.escrowAdvanced++;
          await alert('Reconciler applied an Escrow.com state change that no webhook had delivered', { transactionId: row.id, from: row.status, to: next });
        }
      }, outOfTime);
    }
  }

  // 3. Carrier reconciliation
  if (!outOfTime()) {
    const ships = await readRows('in-flight shipments',
      'shipments?tracking_number=not.is.null&status=not.in.(delivered,returned,cancelled)' +
      '&select=id,tracking_number&order=tracking_checked_at.asc.nullsfirst&limit=' + BATCH);
    if (ships) {
      const { processTracking } = require('./shipping-webhook');
      await pool(ships, CONCURRENCY, async (s) => {
        report.trackingChecked++;
        try { await processTracking(s.tracking_number); }
        catch (e) { report.errors++; await alert('Carrier reconciliation failed for a shipment', { shipmentId: s.id, error: e.message }); }
        await patch('shipments?id=eq.' + encodeURIComponent(s.id), { tracking_checked_at: new Date().toISOString() });
      }, outOfTime);
    }
  }

  // 4. Email retries (same function, same idempotency key: never a duplicate)
  if (!outOfTime() && process.env.INTERNAL_WEBHOOK_SECRET) {
    const pending = await readRows('undelivered emails', 'rpc/email_retry_batch', { method: 'POST', body: JSON.stringify({ p_limit: BATCH }) });
    if (pending && pending.length) {
      const sender = require('./send-notification-email');
      await pool(pending, CONCURRENCY, async (n) => {
        await patch('notifications?id=eq.' + encodeURIComponent(n.notification_id), { email_attempts: (n.attempts || 0) + 1 });
        const res = await sender.handler({
          httpMethod: 'POST',
          headers: { 'x-webhook-secret': process.env.INTERNAL_WEBHOOK_SECRET },
          body: JSON.stringify({ notification_id: n.notification_id, to_email: n.to_email, subject: n.subject, title: n.subject, body: n.body, link: n.link }),
        }).catch(() => ({ statusCode: 500 }));
        report.emailsRetried++;
        if (res.statusCode !== 200) report.errors++;
      }, outOfTime);
    }
  }

  // 5. Abandoned checkouts (never reached Escrow.com, so nothing to refund)
  if (!outOfTime()) {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const cancelled = await readRows('abandoned checkouts',
      'transactions?status=eq.pending_payment&escrow_transaction_id=is.null&escrow_claimed_at=is.null' +
      '&created_at=lt.' + encodeURIComponent(cutoff),
      { method: 'PATCH', headers: Object.assign({}, svc, { Prefer: 'return=representation' }),
        body: JSON.stringify({ status: 'cancelled', escrow_status: 'abandoned_before_payment' }) });
    if (cancelled) report.abandonedCancelled = cancelled.length;
  }

  report.stoppedForTime = outOfTime();
  report.elapsedMs = Date.now() - started;
  console.log('deadline-sweep:', JSON.stringify(report));
  return { statusCode: report.errors ? 207 : 200, body: JSON.stringify(Object.assign({ ok: report.errors === 0 }, report)) };
};
