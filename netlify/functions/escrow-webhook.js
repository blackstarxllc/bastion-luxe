// netlify/functions/escrow-webhook.js
//
// WHAT THIS DOES:
// Escrow.com calls this URL whenever a transaction's status changes on
// their end (funded, shipped/inspection, released, disputed, etc). This
// keeps Bastion's own "transactions" table in sync with reality, instead
// of only trusting button-clicks in the browser.
//
// ============================ SECURITY ============================
// The webhook payload is treated as an UNTRUSTED HINT, never as truth.
// The ONLY thing taken from it is the transaction ID; the actual status
// is then fetched directly from Escrow.com's own API using our own
// credentials, and THAT is what gets written. A forged webhook can at
// worst trigger a harmless re-sync against the real source of truth.
//
// The shared secret check below is a soft gate, not this security
// boundary — see the note above it for why it's intentionally
// non-blocking.
// ==================================================================
//
// ======================== FAILURE VISIBILITY =======================
// Every failure path here returns 200, on purpose — a non-2xx response
// is very likely what got a previous version of this webhook disabled
// by Escrow.com after "too many failures". But silent-to-Escrow.com
// does NOT mean silent to Bastion: every real failure is written to the
// system_alerts table (visible in the Admin panel), not just logged to
// Netlify's function logs where nobody is watching in real time.
// ==================================================================

const { tierRules } = require('./_shipping-lib');

const ESCROW_API_BASE = process.env.ESCROW_LIVE_MODE === 'true'
  ? 'https://api.escrow.com/2017-09-01'
  : 'https://api.escrow-sandbox.com/2017-09-01';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  async function logAlert(message, context) {
    console.error('escrow-webhook:', message, context || {});
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
    try {
      await fetch(SUPABASE_URL + '/rest/v1/system_alerts', {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          source: 'escrow_webhook',
          message: message,
          context: context || {},
        }),
      });
    } catch (e) {
      // If even logging the alert fails, there's nothing further to do —
      // it's still in the Netlify console output above as a last resort.
      console.error('escrow-webhook: could not write to system_alerts', e);
    }
  }

  try {
    // ---- Step 1: cheap gate against junk traffic -------------------
    // The secret is a soft check, not the real security boundary — that
    // comes from Step 2 below, where we verify the transaction status
    // directly with Escrow.com's own API before trusting anything. Making
    // this a hard 401 was a real risk: if Escrow.com's dashboard doesn't
    // reliably preserve a "?secret=..." query string on the URL it calls
    // back (some platforms strip query strings from registered webhook
    // URLs), every single call would fail here — which looks exactly like
    // what happened previously.
    const expectedSecret = process.env.ESCROW_WEBHOOK_SECRET;
    if (expectedSecret) {
      const params = event.queryStringParameters || {};
      const provided = params.secret
        || event.headers['x-webhook-secret']
        || event.headers['X-Webhook-Secret'];
      if (provided !== expectedSecret) {
        await logAlert('Webhook secret did not match (proceeding anyway — verification against Escrow.com below is the real security boundary)', {
          hadQueryParams: Object.keys(params).length > 0,
          providedLength: provided ? provided.length : 0,
        });
      }
    }

    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (parseErr) {
      await logAlert('Could not parse webhook body as JSON', { rawBody: (event.body || '').slice(0, 1000) });
      return { statusCode: 200, body: JSON.stringify({ received: true, parsed: false }) };
    }

    console.log('escrow-webhook: received payload', JSON.stringify(payload).slice(0, 2000));

    const escrowTransactionId =
      payload.id
      || payload.transaction_id
      || payload.transactionId
      || (payload.transaction && payload.transaction.id)
      || (payload.data && payload.data.id)
      || payload.object_id
      || null;

    // Escrow.com also sends CUSTOMER-level events (identity verification
    // approved/rejected, and so on). Those legitimately carry
    // transaction_id: 0 because they aren't about a transaction at all.
    // They were being logged as errors, which buried the real failures in
    // system_alerts under a pile of noise. Acknowledge and move on.
    if (payload.event_type === 'customer' || Number(payload.transaction_id) === 0) {
      console.log('escrow-webhook: customer-level event, not transaction related', payload.event || '');
      return { statusCode: 200, body: JSON.stringify({ received: true, customerEvent: true }) };
    }

    if (!escrowTransactionId) {
      await logAlert('Could not find a transaction id anywhere in the webhook payload', { payload: JSON.stringify(payload).slice(0, 1000) });
      return { statusCode: 200, body: JSON.stringify({ received: true, foundId: false }) };
    }

    const isLive = process.env.ESCROW_LIVE_MODE === 'true';
    const ESCROW_EMAIL = isLive ? process.env.ESCROW_LIVE_EMAIL : process.env.ESCROW_SANDBOX_EMAIL;
    const ESCROW_API_KEY = isLive ? process.env.ESCROW_LIVE_API_KEY : process.env.ESCROW_SANDBOX_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ESCROW_EMAIL || !ESCROW_API_KEY) {
      await logAlert('Missing required environment variables', {
        hasSupabaseUrl: !!SUPABASE_URL,
        hasServiceRole: !!SUPABASE_SERVICE_ROLE_KEY,
        hasEscrowEmail: !!ESCROW_EMAIL,
        hasEscrowKey: !!ESCROW_API_KEY,
        liveMode: isLive,
      });
      return { statusCode: 200, body: JSON.stringify({ received: true, configOk: false }) };
    }

    // ---- Step 2: ask Escrow.com what the truth actually is ---------
    const authHeader = 'Basic ' + Buffer.from(ESCROW_EMAIL + ':' + ESCROW_API_KEY).toString('base64');

    const verifyRes = await fetch(
      ESCROW_API_BASE + '/transaction/' + encodeURIComponent(escrowTransactionId),
      { headers: { Authorization: authHeader } }
    );

    if (!verifyRes.ok) {
      const detail = await verifyRes.text().catch(() => '');
      await logAlert('Could not verify transaction with Escrow.com', {
        escrowTransactionId,
        status: verifyRes.status,
        detail: detail.slice(0, 500),
      });
      return { statusCode: 200, body: JSON.stringify({ received: true, verified: false }) };
    }

    const escrowTxn = await verifyRes.json();
    const verifiedStatus = deriveStatus(escrowTxn);

    if (!verifiedStatus) {
      // Often this simply means the transaction has no actionable state
      // change yet (an empty status object). Only worth alerting on if we
      // actually own this transaction.
      await logAlert('Could not derive a status from the verified Escrow.com transaction', {
        escrowTransactionId,
        rawStatus: JSON.stringify(escrowTxn.status || {}).slice(0, 300),
      });
      return { statusCode: 200, body: JSON.stringify({ received: true, verified: true, mapped: false }) };
    }

    // ---- Step 3: map onto Bastion's own vocabulary ------------------
    // ------------------------------------------------------------------
    // FORWARD-ONLY STATE MACHINE
    //
    // This used to map Escrow.com's status straight onto the Bastion row and
    // write it unconditionally. Three real bugs followed from that:
    //   * Status went BACKWARDS. A late or repeated webhook could knock a
    //     'delivered' order back to 'shipped' (hiding the buyer's release
    //     button) or an 'in_transit' order back to 'funded'.
    //   * A cancelled Escrow.com transaction was recorded as 'disputed'.
    //   * funded_at / released_at were overwritten on every repeat.
    // It also force-set the listing back to 'active' on cancellation,
    // bypassing the database rule that keeps it pending while another buyer
    // still has a live order. Listing status is now left entirely to the
    // sync_deal_status_from_transaction trigger.
    //
    // Shipping progress (shipped / in_transit / delivered) is owned by the
    // carrier webhook. This webhook owns money: funded, released, cancelled.
    // ------------------------------------------------------------------
    const svc = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    };
    const curRes = await fetch(
      SUPABASE_URL + '/rest/v1/transactions?escrow_transaction_id=eq.' + encodeURIComponent(escrowTransactionId) +
        '&select=id,status,funded_at,released_at,deal_id',
      { headers: svc }
    );
    const curRows = curRes.ok ? await curRes.json().catch(() => []) : [];
    const current = curRows && curRows[0];
    if (!current) {
      await logAlert('No Bastion transaction matched this Escrow.com transaction id', { escrowTransactionId, verifiedStatus });
      return { statusCode: 200, body: JSON.stringify({ received: true, matched: false }) };
    }

    const nowIso = new Date().toISOString();
    const updateBody = { escrow_status: verifiedStatus };
    const next = nextTransactionStatus(current.status, verifiedStatus);
    if (next) {
      updateBody.status = next;
      if (next === 'funded' && !current.funded_at) updateBody.funded_at = nowIso;
      if (next === 'released' && !current.released_at) updateBody.released_at = nowIso;
      if (next === 'released' && current.status === 'disputed') {
        await logAlert('Escrow.com disbursed funds on a transaction Bastion had marked disputed; recorded as released', {
          escrowTransactionId, transactionId: current.id,
        });
      }
      if (next === 'cancelled' && current.status !== 'pending_payment') {
        await logAlert('Escrow.com cancelled a transaction AFTER it was funded (refund to buyer); recorded as cancelled', {
          escrowTransactionId, transactionId: current.id, previousStatus: current.status,
        });
      }
    }

    const patchRes = await fetch(
      SUPABASE_URL + '/rest/v1/transactions?id=eq.' + encodeURIComponent(current.id),
      { method: 'PATCH', headers: Object.assign({}, svc, { Prefer: 'return=representation' }), body: JSON.stringify(updateBody) }
    );
    if (!patchRes.ok) {
      const detail = await patchRes.text().catch(() => '');
      await logAlert('Failed to write the verified status onto the Bastion transaction', {
        escrowTransactionId, status: patchRes.status, detail: detail.slice(0, 500),
      });
      return { statusCode: 200, body: JSON.stringify({ received: true, synced: false }) };
    }

    // Start the seller's ship-by clock at the moment funding is confirmed.
    if (next === 'funded') {
      try {
        const shipRes = await fetch(
          SUPABASE_URL + '/rest/v1/shipments?transaction_id=eq.' + encodeURIComponent(current.id) +
            '&direction=eq.outbound&ship_by=is.null&select=id,tier',
          { headers: svc }
        );
        const shipRows = await shipRes.json().catch(() => []);
        const shipment = shipRows && shipRows[0];
        if (shipment) {
          const rules = tierRules(shipment.tier);
          const shipBy = new Date(Date.parse(updateBody.funded_at || current.funded_at || nowIso) + rules.shipByHours * 3600 * 1000).toISOString();
          await fetch(SUPABASE_URL + '/rest/v1/shipments?id=eq.' + encodeURIComponent(shipment.id) + '&ship_by=is.null', {
            method: 'PATCH', headers: Object.assign({}, svc, { Prefer: 'return=minimal' }), body: JSON.stringify({ ship_by: shipBy }),
          });
        }
      } catch (shipByErr) {
        await logAlert('Could not start the ship-by deadline on funding', { escrowTransactionId, error: shipByErr.message });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true, verified: true, status: verifiedStatus, applied: next || null }) };
  } catch (err) {
    await logAlert('Fatal error in escrow-webhook', { error: err.message, stack: (err.stack || '').slice(0, 1000) });
    return { statusCode: 200, body: JSON.stringify({ received: true, fatalError: true }) };
  }
};

// Reads Escrow.com's own record into one of:
// cancelled | disputed | released | rejected | received | shipped | funded | created
// Item and schedule flags are checked on the MERCHANDISE item (not the
// broker-fee lines). Keys follow Escrow.com's documented ItemStatus shape;
// transaction-level flags are honoured too where present.
function deriveStatus(escrowTxn) {
  if (!escrowTxn) return null;
  if (typeof escrowTxn.status === 'string') return escrowTxn.status;
  const t = (escrowTxn.status && typeof escrowTxn.status === 'object') ? escrowTxn.status : {};
  const items = Array.isArray(escrowTxn.items) ? escrowTxn.items : [];
  const goods = items.find((i) => i && i.type !== 'broker_fee' && i.title !== 'Shipping') || items[0] || null;
  const is = goods && goods.status && typeof goods.status === 'object' ? goods.status : {};
  const schedules = goods && Array.isArray(goods.schedule) ? goods.schedule : [];
  const sched = (key) => schedules.some((sc) => sc && sc.status && sc.status[key]);

  if (t.cancelled || is.cancelled) return 'cancelled';
  if (t.disputed || is.disputed) return 'disputed';
  if (t.completed || t.released || is.accepted || sched('disbursed_to_beneficiary')) return 'released';
  if (is.rejected) return 'rejected';
  if (is.received) return 'received';
  if (is.shipped || t.shipped || t.in_transit) return 'shipped';
  if (t.secured || t.funded || sched('secured')) return 'funded';
  return 'created';
}

// Money-state transitions only, and only forwards.
const LIVE_AFTER_FUNDING = ['funded', 'shipped', 'in_transit', 'delivered', 'return_approved', 'return_in_transit'];
function nextTransactionStatus(current, escrowState) {
  if (!current || current === 'released' || current === 'cancelled') return null;
  switch (escrowState) {
    case 'funded':
    case 'shipped':
    case 'received':
      return current === 'pending_payment' ? 'funded' : null;
    case 'released':
      return 'released';
    case 'cancelled':
      return 'cancelled';
    case 'disputed':
    case 'rejected':
      return LIVE_AFTER_FUNDING.includes(current) ? 'disputed' : null;
    default:
      return null;
  }
}

module.exports.deriveStatus = deriveStatus;
module.exports.nextTransactionStatus = nextTransactionStatus;
