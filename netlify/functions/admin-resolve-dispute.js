// netlify/functions/admin-resolve-dispute.js
//
// WHAT THIS DOES:
// Lets an admin resolve a disputed transaction by actually telling
// Escrow.com to release or cancel the held funds — not just flipping a
// status flag in Supabase.
//
// ============================ WHY THIS EXISTS ============================
// The admin panel's dispute buttons previously did ONLY this:
//
//   supabaseClient.from('transactions').update({ status: 'released' })
//
// That changes what Bastion's own database SAYS happened. It does not tell
// Escrow.com to release a single dollar. An admin clicking "Release funds
// to seller" on a disputed transaction was lying to themselves — the money
// was still sitting exactly where it was, and the seller was never paid.
// The reverse was true for "Refund buyer": the buyer's money was never
// actually returned. This function makes the button do what it says.
// ===========================================================================

const ESCROW_API_BASE = process.env.ESCROW_LIVE_MODE === 'true'
  ? 'https://api.escrow.com/2017-09-01'
  : 'https://api.escrow-sandbox.com/2017-09-01';

// 🔴 Same gap as release-escrow-transaction.js — see _escrow-lib.js. This
// used to act on only the merchandise item, leaving the protection fee and
// shipping items untouched on both release and cancel/refund.
const { applyActionToAllItems } = require('./_escrow-lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { transactionId, action } = JSON.parse(event.body || '{}');
    if (!transactionId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'transactionId is required' }) };
    }
    if (!['release', 'refund'].includes(action)) {
      return { statusCode: 400, body: JSON.stringify({ error: "action must be 'release' or 'refund'" }) };
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
      console.error('admin-resolve-dispute: missing env vars');
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing required environment variables' }) };
    }

    const svcHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    };

    // Verify the caller's session, then verify they are actually an admin.
    // Never trust an "isAdmin" flag sent in the request body — that would
    // let anyone resolve any dispute in their own favor.
    const whoRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${callerToken}` },
    });
    if (!whoRes.ok) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session' }) };
    }
    const callerUser = await whoRes.json();

    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(callerUser.id)}&select=is_admin`,
      { headers: svcHeaders }
    );
    const profileRows = await profileRes.json().catch(() => []);
    if (!profileRows || !profileRows[0] || !profileRows[0].is_admin) {
      console.error('admin-resolve-dispute: caller is not an admin', { callerId: callerUser.id });
      return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    // Load the transaction.
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}&select=*`,
      { headers: svcHeaders }
    );
    const rows = await getRes.json();
    const txn = rows && rows[0];
    if (!txn) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Transaction not found' }) };
    }

    if (txn.status !== 'disputed') {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'This transaction is not currently disputed (status: ' + txn.status + ').' }),
      };
    }

    if (!txn.escrow_transaction_id || !txn.escrow_item_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'This transaction has no linked Escrow.com transaction to act on. Resolve it manually on Escrow.com and update the record by hand.' }),
      };
    }

    // ------------------------------------------------------------------
    // NOTE ON ESCROW.COM'S REFUND BEHAVIOUR — READ BEFORE CHANGING
    //
    // 'release' is confirmed against Escrow.com's documented item actions
    // and mirrors release-escrow-transaction.js exactly.
    //
    // 'cancel' is the correct action for an item that has not yet been
    // accepted by both parties. Once an item is funded, Escrow.com's own
    // dispute process may require the cancel request to be reciprocated by
    // the counterparty, or may reject it outright if funds have moved
    // further along the schedule than a straightforward hold. This function
    // does NOT paper over that: if Escrow.com rejects the cancel, the raw
    // rejection reason is returned to the admin and NOTHING is changed in
    // Bastion's own database. An admin seeing that error needs to complete
    // the refund from the Escrow.com dashboard directly, then use "Reopen"
    // or manually correct the record — never assume success where Escrow.com
    // didn't confirm it.
    // ------------------------------------------------------------------
    const escrowAction = action === 'release' ? 'release' : 'cancel';

    // Act on EVERY item (merchandise, protection fee, shipping) — see
    // _escrow-lib.js. Previously only the merchandise item was ever
    // touched here, meaning a dispute resolved through this endpoint never
    // released or cancelled Bastion's own fee/shipping revenue either way.
    const actionResult = await applyActionToAllItems({
      escrowTransactionId: txn.escrow_transaction_id,
      action: escrowAction,
      email: ESCROW_EMAIL,
      apiKey: ESCROW_API_KEY,
      primaryItemId: txn.escrow_item_id,
    });

    const secondaryFailures = actionResult.results.filter((r) => r.ok === false);
    if (secondaryFailures.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/system_alerts`, {
        method: 'POST',
        headers: Object.assign({}, svcHeaders, { Prefer: 'return=minimal' }),
        body: JSON.stringify({
          source: 'admin_resolve_dispute',
          message: 'One or more non-merchandise items failed to ' + escrowAction + ' — revenue may be stuck in escrow',
          context: { transactionId, escrowAction, failures: secondaryFailures },
        }),
      }).catch(() => {});
    }

    if (!actionResult.ok) {
      console.error('admin-resolve-dispute: Escrow.com rejected the action on the merchandise item', {
        transactionId, action: escrowAction, error: actionResult.primaryError,
      });
      await fetch(`${SUPABASE_URL}/rest/v1/system_alerts`, {
        method: 'POST',
        headers: Object.assign({}, svcHeaders, { Prefer: 'return=minimal' }),
        body: JSON.stringify({
          source: 'admin_resolve_dispute',
          message: 'Escrow.com rejected an admin dispute resolution — resolve manually on Escrow.com',
          context: { transactionId, action: escrowAction, error: actionResult.primaryError },
        }),
      }).catch(() => {});
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: 'Escrow.com did not accept this action: ' + (actionResult.primaryError && (actionResult.primaryError.description || actionResult.primaryError.message) || 'unknown error') + '. Nothing was changed. This may need to be completed on the Escrow.com dashboard directly.',
          escrowResponse: actionResult.primaryError,
        }),
      };
    }

    // Escrow.com confirmed the merchandise item. Now, and only now, reflect
    // it locally.
    const primaryResult = actionResult.results.find((r) => String(r.id) === String(txn.escrow_item_id));
    const newTxnStatus = action === 'release' ? 'released' : 'cancelled';
    const patch = { status: newTxnStatus, escrow_status: (primaryResult && primaryResult.response && primaryResult.response.status) || newTxnStatus };
    if (action === 'release') patch.released_at = new Date().toISOString();

    await fetch(`${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}`, {
      method: 'PATCH',
      headers: Object.assign({}, svcHeaders, { Prefer: 'return=minimal' }),
      body: JSON.stringify(patch),
    });

    if (txn.deal_id) {
      await fetch(`${SUPABASE_URL}/rest/v1/deals?id=eq.${encodeURIComponent(txn.deal_id)}`, {
        method: 'PATCH',
        headers: Object.assign({}, svcHeaders, { Prefer: 'return=minimal' }),
        body: JSON.stringify({ status: action === 'release' ? 'sold' : 'active' }),
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        resolved: true, action,
        escrow_status: patch.escrow_status,
        itemsProcessed: actionResult.itemCount,
        secondaryFailures: secondaryFailures.length,
      }),
    };
  } catch (err) {
    console.error('admin-resolve-dispute fatal error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
