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

const ESCROW_API_BASE = 'https://api.escrow-sandbox.com/2017-09-01';
// Switch to https://api.escrow.com/2017-09-01 when moving to real money.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { transactionId } = JSON.parse(event.body || '{}');
    if (!transactionId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'transactionId is required' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ESCROW_EMAIL = process.env.ESCROW_SANDBOX_EMAIL;
    const ESCROW_API_KEY = process.env.ESCROW_SANDBOX_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ESCROW_EMAIL || !ESCROW_API_KEY) {
      console.error('release-escrow-transaction: missing env vars', {
        hasSupabaseUrl: !!SUPABASE_URL,
        hasServiceRole: !!SUPABASE_SERVICE_ROLE_KEY,
        hasEscrowEmail: !!ESCROW_EMAIL,
        hasEscrowKey: !!ESCROW_API_KEY,
      });
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing required environment variables' }) };
    }

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

    const authHeader = 'Basic ' + Buffer.from(`${ESCROW_EMAIL}:${ESCROW_API_KEY}`).toString('base64');

    // 2. Tell Escrow.com to release this item's funds to the seller now.
    const releaseRes = await fetch(
      `${ESCROW_API_BASE}/transaction/${encodeURIComponent(txn.escrow_transaction_id)}/item/${encodeURIComponent(txn.escrow_item_id)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'release' }),
      }
    );

    const releaseData = await releaseRes.json().catch(() => ({}));

    if (!releaseRes.ok) {
      console.error('release-escrow-transaction: Escrow.com rejected the release', {
        status: releaseRes.status,
        escrowResponse: releaseData,
      });
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Escrow.com rejected the release request', details: releaseData }),
      };
    }

    // 3. Reflect the real release back onto Bastion's own row.
    await fetch(`${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ escrow_status: releaseData.status || 'released' }),
    });

    return { statusCode: 200, body: JSON.stringify({ released: true, escrow_status: releaseData.status }) };
  } catch (err) {
    console.error('release-escrow-transaction fatal error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
