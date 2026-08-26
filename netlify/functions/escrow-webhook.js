// netlify/functions/escrow-webhook.js
//
// WHAT THIS DOES:
// Escrow.com will call this URL automatically whenever a transaction's
// status changes on their end (funded, shipped/inspection, released,
// disputed, etc). This keeps Bastion's own "transactions" table in sync
// with reality, instead of only trusting button-clicks in the browser.
//
// Set this URL in your Escrow.com partner dashboard's webhook settings:
//   https://bastionmarket.com/.netlify/functions/escrow-webhook

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const escrowTransactionId = payload.id || payload.transaction_id;
    const newStatus = payload.status;

    if (!escrowTransactionId || !newStatus) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing transaction id or status in webhook payload' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // Map Escrow.com's status vocabulary onto Bastion's own status column.
    // Adjust the right-hand values if your transactions.status uses different words.
    const statusMap = {
      accepted: 'funded',
      shipped: 'shipped',
      inspection: 'shipped',
      released: 'released',
      completed: 'released',
      cancelled: 'disputed',
      disputed: 'disputed',
    };
    const bastionStatus = statusMap[newStatus] || null;

    const updateBody = { escrow_status: newStatus };
    if (bastionStatus) updateBody.status = bastionStatus;

    await fetch(
      `${SUPABASE_URL}/rest/v1/transactions?escrow_transaction_id=eq.${encodeURIComponent(escrowTransactionId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(updateBody),
      }
    );

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
