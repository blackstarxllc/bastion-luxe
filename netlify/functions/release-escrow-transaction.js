// netlify/functions/release-escrow-transaction.js
//
// WHAT THIS DOES:
// Called the moment a buyer confirms receipt (or enters the seller's
// matching release code) on Bastion's transaction page. This tells the
// REAL Escrow.com transaction to release the held funds to the seller
// immediately — no waiting period, no manual step on Escrow.com's own
// site required.
//
// NOTE: Escrow.com's exact release-endpoint shape is being verified
// against a real sandbox test — if the first attempt doesn't match their
// API exactly, the error response will tell us precisely what to adjust.

// Sandbox vs live is controlled by a single environment variable, so
// going live is a config flip — not a code edit that could be half-applied.
// Set ESCROW_LIVE_MODE=true in Netlify when you're ready for real money.
const ESCROW_API_BASE = process.env.ESCROW_LIVE_MODE === 'true'
  ? 'https://api.escrow.com/2017-09-01'
  : 'https://api.escrow-sandbox.com/2017-09-01';

// 🔴 See _escrow-lib.js for the full explanation. This used to release
// ONLY the merchandise item — the protection fee and shipping items were
// never explicitly released on any transaction, ever. applyActionToAllItems
// releases every item on the transaction, treating the merchandise item as
// the one whose success actually matters to the buyer/seller relationship.
const { applyActionToAllItems } = require('./_escrow-lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { transactionId, releaseCode } = JSON.parse(event.body || '{}');
    if (!transactionId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'transactionId is required' }) };
    }

    const authHeaderIn = event.headers.authorization || event.headers.Authorization;
    if (!authHeaderIn || !authHeaderIn.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing auth token' }) };
    }
    const callerToken = authHeaderIn.slice('Bearer '.length);

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const isLive = process.env.ESCROW_LIVE_MODE === 'true';
    const ESCROW_EMAIL = isLive ? process.env.ESCROW_LIVE_EMAIL : process.env.ESCROW_SANDBOX_EMAIL;
    const ESCROW_API_KEY = isLive ? process.env.ESCROW_LIVE_API_KEY : process.env.ESCROW_SANDBOX_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ESCROW_EMAIL || !ESCROW_API_KEY) {
      console.error('release-escrow-transaction: missing env vars', {
        hasSupabaseUrl: !!SUPABASE_URL,
        hasServiceRole: !!SUPABASE_SERVICE_ROLE_KEY,
        hasEscrowEmail: !!ESCROW_EMAIL,
        hasEscrowKey: !!ESCROW_API_KEY,
      });
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing required environment variables' }) };
    }

    // Verify the caller's token is real and find out who they actually are.
    const whoRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${callerToken}`,
      },
    });
    if (!whoRes.ok) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session' }) };
    }
    const callerUser = await whoRes.json();

    // 1. Look up the Bastion transaction row to get the linked Escrow.com IDs
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}&select=*`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const rows = await getRes.json();
    const txn = rows && rows[0];
    if (!txn) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Transaction not found' }) };
    }

    // The security check that was missing: only the real buyer on THIS
    // transaction may trigger a release — never anyone else, even if they
    // know or guess the transaction ID from the URL.
    if (callerUser.id !== txn.buyer_id) {
      console.error('release-escrow-transaction: caller is not the buyer', {
        callerId: callerUser.id,
        buyerId: txn.buyer_id,
      });
      return { statusCode: 403, body: JSON.stringify({ error: 'Only the buyer on this transaction can release funds' }) };
    }

    // Guard against releasing something that was never funded, or releasing
    // the same transaction twice. Without this, a repeated request (a double
    // click, a retry, a replayed request) could hit Escrow.com more than once.
    if (txn.status === 'released') {
      return { statusCode: 200, body: JSON.stringify({ released: true, already_released: true }) };
    }
    if (txn.status === 'disputed') {
      return { statusCode: 409, body: JSON.stringify({ error: 'This transaction is under dispute and cannot be released until it is resolved.' }) };
    }
    if (!['funded', 'shipped', 'in_transit', 'delivered'].includes(txn.status)) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'This transaction is not in a releasable state yet (current status: ' + (txn.status || 'unknown') + ').' }),
      };
    }

    // ------------------------------------------------------------------
    // SERVER-SIDE RELEASE CODE VERIFICATION
    //
    // This used to be compared in the buyer's own browser against a
    // release_code that was sitting on the transaction row the buyer could
    // read. That made the in-person handoff proof decorative: the buyer
    // could read the code straight out of the page data without ever
    // meeting the seller.
    //
    // The code now lives in transaction_release_codes, which only the
    // seller can read, and the comparison happens here where the buyer
    // cannot see either side of it.
    // ------------------------------------------------------------------
    const codeRes = await fetch(
      `${SUPABASE_URL}/rest/v1/transaction_release_codes?transaction_id=eq.${encodeURIComponent(transactionId)}&select=code`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const codeRows = await codeRes.json().catch(() => []);
    const expectedCode = codeRows && codeRows[0] && codeRows[0].code;

    if (expectedCode) {
      // This is an in-person handoff. The buyer must present the seller's code.
      const supplied = String(releaseCode || '').trim().toUpperCase();
      if (!supplied) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Enter the release code the seller gives you at the handoff.', codeRequired: true }),
        };
      }
      if (supplied !== String(expectedCode).trim().toUpperCase()) {
        console.error('release-escrow-transaction: release code mismatch', { transactionId });
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'That release code is not correct.', codeInvalid: true }),
        };
      }
    } else {
      // No release code means this is a shipped order. Funds cannot be
      // released before the carrier has actually confirmed delivery —
      // otherwise a buyer could release on a promise and a seller could
      // pressure them into it.
      const shipRes = await fetch(
        `${SUPABASE_URL}/rest/v1/shipments?transaction_id=eq.${encodeURIComponent(transactionId)}&select=status,delivered_at`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      const shipRows = await shipRes.json().catch(() => []);
      const shipment = shipRows && shipRows[0];

      if (shipment && shipment.status !== 'delivered') {
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'This order has not been confirmed delivered by the carrier yet. Funds cannot be released before delivery.',
            notDelivered: true,
          }),
        };
      }
    }

    if (!txn.escrow_transaction_id || !txn.escrow_item_id) {
      console.error('release-escrow-transaction: missing escrow IDs on transaction', {
        id: transactionId,
        hasEscrowTransactionId: !!txn.escrow_transaction_id,
        hasEscrowItemId: !!txn.escrow_item_id,
      });
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'This transaction has no linked Escrow.com transaction/item to release' }),
      };
    }

    // 2. Release every item on the transaction — merchandise, protection
    //    fee, and shipping — not just the merchandise item. See
    //    _escrow-lib.js for the full history of why this matters: the fee
    //    and shipping items were never explicitly released before this fix.
    const releaseResult = await applyActionToAllItems({
      escrowTransactionId: txn.escrow_transaction_id,
      action: 'release',
      email: ESCROW_EMAIL,
      apiKey: ESCROW_API_KEY,
      primaryItemId: txn.escrow_item_id,
    });

    // Log every non-primary failure to system_alerts so a fee or shipping
    // item that failed to release doesn't disappear into function logs
    // nobody is watching. This function previously had NO system_alerts
    // logging at all — every failure path only reached console.error.
    const secondaryFailures = releaseResult.results.filter((r) => r.ok === false);
    if (secondaryFailures.length) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/system_alerts`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            source: 'release_escrow_transaction',
            message: 'One or more non-merchandise items failed to release — revenue may be stuck in escrow',
            context: { transactionId, escrowTransactionId: txn.escrow_transaction_id, failures: secondaryFailures },
          }),
        });
      } catch (e) {
        console.error('release-escrow-transaction: could not log secondary failure alert', e);
      }
    }

    if (!releaseResult.ok) {
      console.error('release-escrow-transaction: Escrow.com rejected releasing the merchandise item', {
        error: releaseResult.primaryError,
      });
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Escrow.com rejected the release request', details: releaseResult.primaryError }),
      };
    }

    // 3. Reflect the real release back onto Bastion's own row.
    const primaryResult = releaseResult.results.find((r) => String(r.id) === String(txn.escrow_item_id));
    const releasedStatus = (primaryResult && primaryResult.response && primaryResult.response.status) || 'released';

    await fetch(`${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ escrow_status: releasedStatus }),
    });

    return { statusCode: 200, body: JSON.stringify({ released: true, escrow_status: releasedStatus }) };
  } catch (err) {
    console.error('release-escrow-transaction fatal error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
