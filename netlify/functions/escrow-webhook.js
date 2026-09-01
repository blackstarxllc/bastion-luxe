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
    const statusMap = {
      created: null,      // still awaiting payment - nothing to change yet
      unfunded: null,
      funded: 'funded',
      accepted: 'funded',
      secured: 'funded',
      in_transit: 'shipped',
      shipped: 'shipped',
      inspection: 'shipped',
      released: 'released',
      completed: 'released',
      cancelled: 'disputed',
      disputed: 'disputed',
      rejected: 'disputed',
    };
    const bastionStatus = statusMap[verifiedStatus] || null;

    const updateBody = { escrow_status: verifiedStatus };
    if (bastionStatus) {
      updateBody.status = bastionStatus;
      const timestampField = { funded: 'funded_at', shipped: 'shipped_at', released: 'released_at' }[bastionStatus];
      if (timestampField) updateBody[timestampField] = new Date().toISOString();
    }

    const patchRes = await fetch(
      SUPABASE_URL + '/rest/v1/transactions?escrow_transaction_id=eq.' + encodeURIComponent(escrowTransactionId),
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(updateBody),
      }
    );

    if (!patchRes.ok) {
      const detail = await patchRes.text().catch(() => '');
      await logAlert('Failed to write the verified status onto the Bastion transaction', {
        escrowTransactionId,
        status: patchRes.status,
        detail: detail.slice(0, 500),
      });
      return { statusCode: 200, body: JSON.stringify({ received: true, synced: false }) };
    }

    const updated = await patchRes.json().catch(() => []);
    if (!Array.isArray(updated) || updated.length === 0) {
      await logAlert('No Bastion transaction matched this Escrow.com transaction id', { escrowTransactionId });
    }

    const dealId = Array.isArray(updated) && updated[0] ? updated[0].deal_id : null;

    if (bastionStatus === 'released' && dealId) {
      await patchDeal(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, dealId, 'sold', logAlert);
    }
    if (verifiedStatus === 'cancelled' && dealId) {
      await patchDeal(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, dealId, 'active', logAlert);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true, verified: true, status: verifiedStatus }) };
  } catch (err) {
    await logAlert('Fatal error in escrow-webhook', { error: err.message, stack: (err.stack || '').slice(0, 1000) });
    return { statusCode: 200, body: JSON.stringify({ received: true, fatalError: true }) };
  }
};

async function patchDeal(supabaseUrl, serviceKey, dealId, status, logAlert) {
  try {
    await fetch(supabaseUrl + '/rest/v1/deals?id=eq.' + encodeURIComponent(dealId), {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status: status }),
    });
  } catch (e) {
    await logAlert('Could not set deal status to ' + status, { dealId, error: e.message });
  }
}

// Escrow.com has used a few different status shapes (a plain string, an
// object of booleans on the transaction, and a per-item status). Handle
// all of them rather than assuming one and silently breaking.
function deriveStatus(escrowTxn) {
  if (!escrowTxn) return null;

  if (typeof escrowTxn.status === 'string') return escrowTxn.status;

  const s = escrowTxn.status || {};
  if (typeof s === 'object') {
    if (s.disputed) return 'disputed';
    if (s.cancelled) return 'cancelled';
    if (s.rejected) return 'rejected';
    if (s.completed || s.released) return 'released';
    if (s.in_transit || s.shipped) return 'shipped';
    if (s.secured || s.funded) return 'funded';
  }

  const item = Array.isArray(escrowTxn.items) ? escrowTxn.items[0] : null;
  if (item) {
    if (typeof item.status === 'string') return item.status;
    const is = item.status || {};
    if (is.disputed) return 'disputed';
    if (is.cancelled) return 'cancelled';
    if (is.completed || is.released) return 'released';
    if (is.shipped || is.in_transit) return 'shipped';
    if (is.secured || is.funded) return 'funded';
  }

  return null;
}
