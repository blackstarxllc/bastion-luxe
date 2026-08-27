// netlify/functions/create-escrow-transaction.js
//
// WHAT THIS DOES:
// Called right after Bastion creates its own internal "transactions" row
// (the existing "Begin Secure Purchase" flow). This function talks to the
// REAL Escrow.com API to open a real escrow transaction, then saves the
// real Escrow.com transaction ID back onto the Bastion row so the two
// systems stay linked.
//
// This is the ONLY safe place API keys live — never in the website's HTML/JS.

const ESCROW_API_BASE = 'https://api.escrow-sandbox.com/2017-09-01';
// When ready for real money later, this becomes: https://api.escrow.com/2017-09-01

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { transactionId } = JSON.parse(event.body || '{}');
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
    const ESCROW_EMAIL = process.env.ESCROW_SANDBOX_EMAIL;
    const ESCROW_API_KEY = process.env.ESCROW_SANDBOX_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ESCROW_EMAIL || !ESCROW_API_KEY) {
      console.error('create-escrow-transaction: missing env vars', {
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

    // 1. Fetch the Bastion transaction row using the SERVICE ROLE key
    //    (bypasses RLS — safe because this only ever runs on the server,
    //    never in the browser)
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

    // Only the real buyer on THIS transaction may open a real escrow
    // transaction for it — never anyone else, even if they know or guess
    // the transaction ID.
    if (callerUser.id !== txn.buyer_id) {
      console.error('create-escrow-transaction: caller is not the buyer', {
        callerId: callerUser.id,
        buyerId: txn.buyer_id,
      });
      return { statusCode: 403, body: JSON.stringify({ error: 'Only the buyer on this transaction can start escrow' }) };
    }

    if (txn.escrow_transaction_id) {
      // Already created — don't create a duplicate on Escrow.com
      return { statusCode: 200, body: JSON.stringify({ escrow_transaction_id: txn.escrow_transaction_id, already_existed: true }) };
    }
    if (!txn.buyer_id || !txn.seller_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Transaction is missing buyer_id or seller_id' }) };
    }

    // 1b. Look up the buyer's and seller's real emails securely via Supabase's
    //     admin API — this only works with the service role key, so it can
    //     only ever run here on the server, never in the browser.
    async function getUserEmail(userId) {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (!res.ok) return null;
      const user = await res.json();
      return user && user.email;
    }

    const [buyerEmail, sellerEmail] = await Promise.all([
      getUserEmail(txn.buyer_id),
      getUserEmail(txn.seller_id),
    ]);

    if (!buyerEmail || !sellerEmail) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Could not look up buyer or seller email' }) };
    }

    const itemPrice = Number(txn.price || 0);
    const bastionFee = Number(txn.fee || 0);
    if (itemPrice <= 0 || bastionFee < 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Transaction is missing a valid price/fee' }) };
    }

    // 2. Create the real transaction on Escrow.com — with the payout SPLIT
    // between the seller (item price) and Bastion itself (the protection
    // fee), instead of sending the seller the buyer's entire payment.
    // Bastion joins the transaction as a "broker" party using the same
    // account that authenticates these API calls (ESCROW_EMAIL), so its
    // cut lands directly in Bastion's own Escrow.com account.
    const escrowPayload = {
      parties: [
        { role: 'buyer', customer: buyerEmail },
        { role: 'seller', customer: sellerEmail, agreed: true },
        { role: 'broker', customer: ESCROW_EMAIL, agreed: true },
      ],
      currency: 'usd',
      description: txn.item_name || 'Bastion marketplace item',
      items: [
        {
          title: txn.item_name || 'Item',
          description: txn.item_name || 'Bastion marketplace item',
          type: 'general_merchandise',
          inspection_period: 259200, // 3 days, in seconds — buyer's window to inspect before funds auto-release
          quantity: 1,
          schedule: [
            { amount: itemPrice, payer_customer: buyerEmail, beneficiary_customer: sellerEmail },
            { amount: bastionFee, payer_customer: buyerEmail, beneficiary_customer: ESCROW_EMAIL },
          ],
        },
      ],
    };

    const authHeader = 'Basic ' + Buffer.from(`${ESCROW_EMAIL}:${ESCROW_API_KEY}`).toString('base64');

    const createRes = await fetch(`${ESCROW_API_BASE}/transaction`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(escrowPayload),
    });

    const escrowData = await createRes.json();

    if (!createRes.ok) {
      console.error('create-escrow-transaction: Escrow.com rejected the request', {
        status: createRes.status,
        escrowResponse: escrowData,
      });
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Escrow.com rejected the transaction', details: escrowData }),
      };
    }

    // 3. Save the real Escrow.com transaction ID back onto the Bastion row
    await fetch(`${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        escrow_transaction_id: escrowData.id,
        escrow_status: escrowData.status || 'created',
        escrow_item_id: escrowData.items && escrowData.items[0] ? escrowData.items[0].id : null,
      }),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ escrow_transaction_id: escrowData.id, status: escrowData.status }),
    };
  } catch (err) {
    console.error('create-escrow-transaction fatal error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
