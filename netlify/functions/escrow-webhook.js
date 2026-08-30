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
//
// Anyone on the internet can POST to this URL. If we simply believed the
// body, an attacker could send {"id": "...", "status": "released"} and
// mark a real transaction as released -- moving real money. So instead:
//
//   1. An optional shared secret gates obvious junk traffic cheaply.
//   2. The ONLY thing we take from the payload is the transaction ID.
//   3. We then ask Escrow.com directly what that transaction's status
//      actually is, using our own API credentials, and write THAT.
//
// The result: a forged webhook can at worst trigger a harmless re-sync
// against the real source of truth. It can never invent a status.
// This also means we don't need to reverse-engineer Escrow.com's
// signature scheme in order to be safe.
// ==================================================================

const ESCROW_API_BASE = process.env.ESCROW_LIVE_MODE === 'true'
  ? 'https://api.escrow.com/2017-09-01'
  : 'https://api.escrow-sandbox.com/2017-09-01';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    // ---- Step 1: cheap gate against junk traffic -------------------
    // If ESCROW_WEBHOOK_SECRET is configured, require it. Escrow.com lets
    // you register a webhook URL with a query string, so register:
    //   https://bastionmarket.com/.netlify/functions/escrow-webhook?secret=YOUR_SECRET
    const expectedSecret = process.env.ESCROW_WEBHOOK_SECRET;
    if (expectedSecret) {
      const params = event.queryStringParameters || {};
      const provided = params.secret
        || event.headers['x-webhook-secret']
        || event.headers['X-Webhook-Secret'];
      if (provided !== expectedSecret) {
        console.warn('escrow-webhook: rejected request with bad/missing secret');
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
    }

    const payload = JSON.parse(event.body || '{}');
    const escrowTransactionId = payload.id || payload.transaction_id;

    if (!escrowTransactionId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing transaction id in webhook payload' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const isLive = process.env.ESCROW_LIVE_MODE === 'true';
    const ESCROW_EMAIL = isLive ? process.env.ESCROW_LIVE_EMAIL : process.env.ESCROW_SANDBOX_EMAIL;
    const ESCROW_API_KEY = isLive ? process.env.ESCROW_LIVE_API_KEY : process.env.ESCROW_SANDBOX_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ESCROW_EMAIL || !ESCROW_API_KEY) {
      console.error('escrow-webhook: missing env vars', {
        hasSupabaseUrl: !!SUPABASE_URL,
        hasServiceRole: !!SUPABASE_SERVICE_ROLE_KEY,
        hasEscrowEmail: !!ESCROW_EMAIL,
        hasEscrowKey: !!ESCROW_API_KEY,
        liveMode: isLive,
      });
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing required environment variables' }) };
    }

    // ---- Step 2: ask Escrow.com what the truth actually is ---------
    const authHeader = 'Basic ' + Buffer.from(ESCROW_EMAIL + ':' + ESCROW_API_KEY).toString('base64');

    const verifyRes = await fetch(
      ESCROW_API_BASE + '/transaction/' + encodeURIComponent(escrowTransactionId),
      { headers: { Authorization: authHeader } }
    );

    if (!verifyRes.ok) {
      const detail = await verifyRes.text().catch(() => '');
      console.error('escrow-webhook: could not verify transaction with Escrow.com', {
        escrowTransactionId,
        status: verifyRes.status,
        detail: detail.slice(0, 500),
      });
      // Return 200 so Escrow.com doesn't hammer retries over something a
      // retry won't fix; the error is logged loudly for a human instead.
      return { statusCode: 200, body: JSON.stringify({ received: true, verified: false }) };
    }

    const escrowTxn = await verifyRes.json();
    const verifiedStatus = deriveStatus(escrowTxn);

    if (!verifiedStatus) {
      console.warn('escrow-webhook: could not derive a status from verified transaction', {
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

    // Previously this response was never checked at all, so a failed sync
    // was completely invisible. Now it's surfaced.
    if (!patchRes.ok) {
      const detail = await patchRes.text().catch(() => '');
      console.error('escrow-webhook: failed to update Bastion transaction', {
        escrowTransactionId,
        status: patchRes.status,
        detail: detail.slice(0, 500),
      });
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not sync status' }) };
    }

    const updated = await patchRes.json().catch(() => []);
    if (!Array.isArray(updated) || updated.length === 0) {
      console.warn('escrow-webhook: no Bastion transaction matched this escrow id', { escrowTransactionId });
    }

    const dealId = Array.isArray(updated) && updated[0] ? updated[0].deal_id : null;

    // When a trade completes, close out the listing so it can't be bought again.
    if (bastionStatus === 'released' && dealId) {
      await patchDeal(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, dealId, 'sold');
    }

    // If the trade was cancelled outright, put the listing back on the market.
    if (verifiedStatus === 'cancelled' && dealId) {
      await patchDeal(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, dealId, 'active');
    }

    return { statusCode: 200, body: JSON.stringify({ received: true, verified: true, status: verifiedStatus }) };
  } catch (err) {
    console.error('escrow-webhook fatal error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function patchDeal(supabaseUrl, serviceKey, dealId, status) {
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
    console.error('escrow-webhook: could not set deal status to ' + status, e);
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
