// netlify/functions/release-escrow-transaction.js
//
// WHAT THIS DOES:
// Called the moment a buyer confirms receipt (or enters the seller's
// matching release code) on Bastion's transaction page. This tells the
// REAL Escrow.com transaction to release the held funds to the seller
// immediately — no waiting period, no manual step on Escrow.com's own
// site required.
//
// VERIFIED 2026-09-20 against Escrow.com's live API docs:
//
//   * The action that disburses funds is 'accept', not 'release'. This
//     function sent 'release' — an action that does not exist in their API —
//     so every confirm-receipt ever made here was rejected by Escrow.com.
//   * 'accept' cannot be performed by a partner on behalf of the buyer.
//     Bastion IS the partner on every transaction it creates. So there is no
//     credential Bastion can hold that lets it accept for the buyer.
//
// What happens now:
//   1. Mark the item received on the buyer's behalf ('receive' IS allowed
//      on-behalf). This starts Escrow.com's inspection clock, which is what
//      arms their automatic accept-on-lapse. The seller gets paid eventually
//      even if the buyer never clicks again.
//   2. Attempt 'accept' As-Customer the buyer, in case this partner account
//      has been granted wider permission.
//   3. If Escrow.com refuses that — the expected case — return a real
//      Escrow.com landing-page link and tell the buyer plainly that the last
//      click happens there.
//
// Bastion writes status='released' ONLY when Escrow.com confirms. It never
// guesses.

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
const {
  applyActionToAllItems,
  markShipped,
  markReceived,
  lookupUserEmail,
  getWebLink,
  ACTION_ACCEPT,
} = require('./_escrow-lib');

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

    // ------------------------------------------------------------------
    // 🔴 WHICH FLOW IS THIS? The shipment row decides — not the code.
    //
    // A listing set to fulfilment='both' lets the BUYER choose at checkout
    // whether to meet in person or have it shipped. But the release-code
    // trigger fires on transaction insert, before that choice is known, so
    // it generates a code for every 'both' listing.
    //
    // The old logic here keyed purely off "does a code exist?" — so a
    // buyer who chose SHIPPING on a 'both' listing got a code they could
    // never legitimately obtain (there is no handoff), and release was
    // demanded against it. Funds on those orders could never be released
    // at all: the buyer had no code, and the delivery branch was
    // unreachable because a code existed.
    //
    // The shipment row is the actual source of truth for how this specific
    // transaction is being fulfilled, so check it first and let it decide.
    // ------------------------------------------------------------------
    const shipLookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/shipments?transaction_id=eq.${encodeURIComponent(transactionId)}&direction=eq.outbound&select=status,delivered_at`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const shipLookupRows = await shipLookupRes.json().catch(() => []);
    const outboundShipment = shipLookupRows && shipLookupRows[0];
    const isShippedOrder = !!outboundShipment;

    if (isShippedOrder) {
      // Shipped: the carrier must confirm delivery before funds move.
      // A stale release code from a 'both' listing is ignored entirely.
      if (outboundShipment.status !== 'delivered') {
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'This order has not been confirmed delivered by the carrier yet. Funds cannot be released before delivery.',
            notDelivered: true,
          }),
        };
      }
    } else if (expectedCode) {
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
    }
    // No shipment and no code: an in-person order created before release
    // codes existed. Nothing further to gate on — the buyer confirming
    // receipt is the whole signal.

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

    // Look up the buyer's email — needed for the As-Customer header.
    const buyerRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${txn.buyer_id}`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    const buyerUser = buyerRes.ok ? await buyerRes.json().catch(() => null) : null;
    const buyerEmail = buyerUser && buyerUser.email;

    async function alert(message, context) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/system_alerts`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ source: 'release_escrow_transaction', message, context: context || {}, transaction_id: transactionId }),
        });
      } catch (e) {
        console.error('release-escrow-transaction: could not write system_alert', e);
      }
    }

    // STEP 1 — bring Escrow.com's record up to "received" on the parties'
    // behalf: shipped (as the seller) then received (as the buyer). Both are
    // on Escrow.com's approved on-behalf list, both are skipped if already
    // done (the tracking webhook normally does them on a shipped order), and
    // "received" is what arms the automatic accept-on-inspection-lapse.
    // An in-person handoff never had a carrier scan, so this is the only
    // place those two steps happen for it.
    if (buyerEmail) {
      const sellerEmail = await lookupUserEmail(txn.seller_id);
      const shipped = await markShipped({
        escrowTransactionId: txn.escrow_transaction_id,
        primaryItemId: txn.escrow_item_id,
        sellerEmail,
        bastionTransactionId: transactionId,
        initiatedBy: 'buyer_release',
      });
      if (!shipped.ok) {
        await alert('Could not mark the item shipped on Escrow.com before release', {
          escrowTransactionId: txn.escrow_transaction_id, error: shipped.primaryError,
        });
      } else {
        const received = await markReceived({
          escrowTransactionId: txn.escrow_transaction_id,
          primaryItemId: txn.escrow_item_id,
          buyerEmail,
          bastionTransactionId: transactionId,
          initiatedBy: 'buyer_release',
        });
        if (!received.ok) {
          await alert('Could not mark the item received on Escrow.com; the inspection clock may not have started', {
            escrowTransactionId: txn.escrow_transaction_id, error: received.primaryError,
          });
        }
      }
    }

    // STEP 2 — attempt the real disbursing action.
    const releaseResult = await applyActionToAllItems({
      escrowTransactionId: txn.escrow_transaction_id,
      action: ACTION_ACCEPT,
      email: ESCROW_EMAIL,
      apiKey: ESCROW_API_KEY,
      primaryItemId: txn.escrow_item_id,
      asCustomer: buyerEmail || undefined,
      bastionTransactionId: transactionId,
      initiatedBy: 'buyer_release',
    });

    const secondaryFailures = releaseResult.results.filter((r) => r.ok === false);
    if (secondaryFailures.length && releaseResult.ok) {
      await alert('One or more non-merchandise items failed to accept — fee or shipping revenue may be stuck in escrow', {
        escrowTransactionId: txn.escrow_transaction_id, failures: secondaryFailures,
      });
    }

    // STEP 3 — Escrow.com refused to let Bastion accept for the buyer. This
    // is the documented, expected path. Hand the buyer a real link instead
    // of an error, and change NOTHING about the local money state.
    if (!releaseResult.ok && releaseResult.needsBuyerAction) {
      const link = await getWebLink({
        escrowTransactionId: txn.escrow_transaction_id,
        action: 'accept',
        email: ESCROW_EMAIL,
        apiKey: ESCROW_API_KEY,
      });

      await fetch(`${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ escrow_status: 'awaiting_buyer_acceptance' }),
      }).catch(() => {});

      return {
        statusCode: 200,
        body: JSON.stringify({
          released: false,
          needsBuyerAction: true,
          acceptUrl: link,
          message: link
            ? 'Escrow.com requires you to approve the release from your own Escrow.com account. Use the button to finish — it takes one click, and this page updates automatically.'
            : 'Escrow.com requires you to approve the release from your own Escrow.com account. Sign in at escrow.com and accept the item there; this page updates automatically once you do.',
        }),
      };
    }

    if (!releaseResult.ok) {
      console.error('release-escrow-transaction: Escrow.com rejected accepting the merchandise item', {
        error: releaseResult.primaryError,
      });
      await alert('Escrow.com rejected the release of the merchandise item', {
        escrowTransactionId: txn.escrow_transaction_id, error: releaseResult.primaryError,
      });
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Escrow.com did not accept the release request. Nothing was changed.', details: releaseResult.primaryError }),
      };
    }

    // STEP 4 — Escrow.com CONFIRMED it. Only now does Bastion record the
    // release. The browser no longer writes this; the database trigger
    // enforces that, so this is the single path that can produce it.
    const nowIso = new Date().toISOString();
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ status: 'released', released_at: nowIso, escrow_status: 'accepted' }),
    });

    if (!patchRes.ok) {
      const detail = await patchRes.text().catch(() => '');
      // Money HAS moved but Bastion failed to record it. That is the single
      // worst state to leave silent, so it is alerted at the top severity.
      await alert('CRITICAL: Escrow.com released the funds but Bastion could not record it. The database and Escrow.com now disagree.', {
        escrowTransactionId: txn.escrow_transaction_id, status: patchRes.status, detail: detail.slice(0, 500),
      });
      return {
        statusCode: 500,
        body: JSON.stringify({
          released: true,
          recordFailed: true,
          error: 'Your funds were released successfully, but we could not update this page. Support has been alerted — your release is safe and confirmed on Escrow.com.',
        }),
      };
    }

    return { statusCode: 200, body: JSON.stringify({ released: true, escrow_status: 'accepted' }) };
  } catch (err) {
    console.error('release-escrow-transaction fatal error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
