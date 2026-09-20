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

// Sandbox vs live is controlled by a single environment variable, so
// going live is a config flip — not a code edit that could be half-applied.
// Set ESCROW_LIVE_MODE=true in Netlify when you're ready for real money.
const ESCROW_API_BASE = process.env.ESCROW_LIVE_MODE === 'true'
  ? 'https://api.escrow.com/2017-09-01'
  : 'https://api.escrow-sandbox.com/2017-09-01';

const { getWebLink } = require('./_escrow-lib');

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
    const isLive = process.env.ESCROW_LIVE_MODE === 'true';
    const ESCROW_EMAIL = isLive ? process.env.ESCROW_LIVE_EMAIL : process.env.ESCROW_SANDBOX_EMAIL;
    const ESCROW_API_KEY = isLive ? process.env.ESCROW_LIVE_API_KEY : process.env.ESCROW_SANDBOX_API_KEY;

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

    // ------------------------------------------------------------------
    // BROKER IDENTITY COLLISION GUARD
    //
    // ESCROW_EMAIL is Bastion's own broker account at Escrow.com. Escrow
    // rejects any transaction where the same customer appears as more than
    // one non-partner party — so if the seller (or buyer) signed up using
    // that same email, the API returns:
    //
    //   "Cannot have the same customer as multiple non-partner parties"
    //
    // That already happened in testing and the 422 is opaque: the buyer
    // just sees a failed purchase with no explanation, and the listing
    // looks broken. Catch it here with a message that says what's actually
    // wrong, and log it so it surfaces in the Admin panel.
    // ------------------------------------------------------------------
    const brokerEmail = String(ESCROW_EMAIL || '').trim().toLowerCase();
    if (brokerEmail && String(sellerEmail || '').trim().toLowerCase() === brokerEmail) {
      await logAlertToSupabase(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, 'escrow_transaction_creation',
        'Seller account uses the same email as the Bastion broker identity — Escrow.com will reject this transaction',
        { transactionId, sellerEmail, brokerEmail });
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: 'This listing cannot be purchased because the seller account uses the same email address as Bastion\u2019s escrow account. The seller needs to list from a different account. Support has been notified.',
          brokerCollision: true,
        }),
      };
    }
    if (brokerEmail && String(buyerEmail || '').trim().toLowerCase() === brokerEmail) {
      await logAlertToSupabase(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, 'escrow_transaction_creation',
        'Buyer account uses the same email as the Bastion broker identity — Escrow.com will reject this transaction',
        { transactionId, buyerEmail, brokerEmail });
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: 'You cannot purchase using the account that Bastion\u2019s escrow service is registered to. Please use a different account.',
          brokerCollision: true,
        }),
      };
    }

    const itemPrice = Number(txn.price || 0);
    const bastionFee = Number(txn.fee || 0);
    const shippingCost = Number(txn.shipping_cost || 0);
    if (itemPrice <= 0 || bastionFee < 0 || shippingCost < 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Transaction is missing a valid price/fee' }) };
    }

    // ------------------------------------------------------------------
    // Buyer inspection window, scaled to what's at stake.
    //
    // A flat 3 days was previously applied to a $200 pair of sneakers and
    // an $80,000 watch alike. A buyer verifying a five-figure item may need
    // a third-party appraisal; a buyer checking a common item does not need
    // to sit on the seller's money for three days. These mirror
    // public.inspection_window_for_value() in Postgres — change both.
    // ------------------------------------------------------------------
    const inspectionPeriod =
      itemPrice >= 10000 ? 432000 :  // 5 days
      itemPrice >= 1000  ? 259200 :  // 3 days
                           172800;   // 2 days

    // 2. Create the real transaction on Escrow.com — with the payout SPLIT
    // between the seller (item price) and Bastion itself (the protection
    // fee), instead of sending the seller the buyer's entire payment.
    // Bastion joins the transaction as a "broker" party using the same
    // account that authenticates these API calls (ESCROW_EMAIL), so its
    // cut lands directly in Bastion's own Escrow.com account.
    //
    // ⚠ THE BROKER FEE MUST BE ITS OWN ITEM.
    //
    // This previously added Bastion's protection fee as a SECOND SCHEDULE
    // LINE inside the merchandise item, with type: 'broker_fee' on the
    // schedule entry. Escrow.com rejected every single one of those with
    // HTTP 422:
    //
    //   "Non-broker/partner fee item schedule beneficiary must be a seller"
    //
    // Within a normal merchandise item, every schedule line must pay the
    // seller. A commission to anyone else has to be a separate item whose
    // ITEM type (not schedule type) is 'broker_fee'. Because the whole call
    // was rejected, no escrow transaction was ever created, no payment link
    // was ever generated, and Escrow.com never emailed a single buyer.
    //
    // If you ever change the fee structure, change it here and re-test a
    // real purchase end to end — a 422 on this call is silent to the buyer
    // by design, so it will not announce itself.
    const escrowItems = [
      {
        title: txn.item_name || 'Item',
        description: txn.item_name || 'Bastion marketplace item',
        type: 'general_merchandise',
        inspection_period: inspectionPeriod, // value-tiered, in seconds — see above
        quantity: 1,
        schedule: [
          { amount: itemPrice, payer_customer: buyerEmail, beneficiary_customer: sellerEmail },
        ],
      },
    ];

    // ------------------------------------------------------------------
    // 🔴 CORRECTED HERE — this previously paid the SELLER, which was a
    // guaranteed loss on every real shipment.
    //
    // Retail-rate pricing (added 2026-09-02) charges the buyer the
    // standard carrier RETAIL rate, while Bastion is billed the discounted
    // COMMERCIAL rate by the carrier when the label is actually purchased
    // (create-shipping-label.js, billed to Bastion's own Shippo/EasyPost
    // account — never through escrow). The margin is the spread between
    // those two figures, and it is real revenue ONLY if the retail amount
    // collected from the buyer actually reaches Bastion.
    //
    // This item's beneficiary was left as the seller from before Bastion
    // took over buying labels directly, back when a seller genuinely paid
    // for their own postage out of pocket. With Bastion now purchasing
    // every label, that beneficiary was never updated. The result: the
    // full RETAIL shipping amount released to the seller — a windfall for
    // a cost they never paid — while Bastion separately paid the real
    // COMMERCIAL rate to the carrier out of its own account, recovering
    // nothing. Every real shipment lost Bastion money, guaranteed, with no
    // hypothetical about it.
    //
    // Fixed: shipping now pays Bastion's own broker account (ESCROW_EMAIL),
    // the same beneficiary as the protection fee. Bastion collects the
    // retail amount through escrow, pays the commercial rate to the
    // carrier when the label is bought, and keeps the spread. The seller
    // never sees a shipping line item, correctly, because the seller was
    // never the one paying for postage in the first place.
    //
    // type must be 'broker_fee': Escrow.com rejects any schedule line
    // that pays a non-seller party unless the ITEM's type is 'broker_fee'
    // (confirmed against the live 422 that governed the original protection
    // fee item — see the comment on that item below).
    // ------------------------------------------------------------------
    if (shippingCost > 0) {
      escrowItems.push({
        title: 'Shipping',
        description: 'Carrier shipping cost \u2014 collected by Bastion, which purchases the label',
        type: 'broker_fee',
        inspection_period: inspectionPeriod,
        quantity: 1,
        schedule: [
          { amount: shippingCost, payer_customer: buyerEmail, beneficiary_customer: ESCROW_EMAIL },
        ],
      });
    }

    // Only add the commission item when there is actually a fee to collect.
    // An item with a zero amount is another way to earn a 422.
    if (bastionFee > 0) {
      escrowItems.push({
        title: 'Bastion protection fee',
        description: 'Bastion marketplace protection fee',
        type: 'broker_fee',
        inspection_period: inspectionPeriod,
        quantity: 1,
        schedule: [
          { amount: bastionFee, payer_customer: buyerEmail, beneficiary_customer: ESCROW_EMAIL },
        ],
      });
    }

    const escrowPayload = {
      parties: [
        { role: 'buyer', customer: buyerEmail },
        { role: 'seller', customer: sellerEmail, agreed: true },
        { role: 'broker', customer: ESCROW_EMAIL, agreed: true },
      ],
      currency: 'usd',
      description: txn.item_name || 'Bastion marketplace item',
      items: escrowItems,
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

    if (createRes.ok) {
      console.log('create-escrow-transaction: Escrow.com accepted the transaction', JSON.stringify(escrowData).slice(0, 1500));
    }

    if (!createRes.ok) {
      console.error('create-escrow-transaction: Escrow.com rejected the request', {
        status: createRes.status,
        escrowResponse: JSON.stringify(escrowData),
        sentPayload: JSON.stringify(escrowPayload),
      });
      await logAlertToSupabase(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, 'escrow_transaction_creation', 'Escrow.com rejected the transaction creation request', {
        transactionId,
        status: createRes.status,
        escrowResponse: JSON.stringify(escrowData).slice(0, 800),
      });
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Escrow.com rejected the transaction', details: escrowData }),
      };
    }

    // ------------------------------------------------------------------
    // 3a. Get a REAL payment link for the buyer.
    //
    // The create-transaction response does not contain a payment URL. The
    // previous code guessed at five field names (url, transaction_url,
    // landing_url, checkout_url, hosted_url) — Escrow.com returns none of
    // them, so escrow_transaction_url was ALWAYS null and every buyer was
    // told to "check your email" instead of being given a button. On a
    // luxury marketplace that is where checkout quietly dies.
    //
    // The documented way to get one is the web_link endpoint, which returns
    // a real Escrow.com landing page for a given action. 'agree' is the
    // buyer's next step, and it leads straight into funding.
    // ------------------------------------------------------------------
    const payLink = await getWebLink({
      escrowTransactionId: escrowData.id,
      action: 'agree',
      email: ESCROW_EMAIL,
      apiKey: ESCROW_API_KEY,
    });
    if (!payLink) {
      await logAlertToSupabase(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, 'escrow_transaction_creation',
        'Escrow.com did not return a payment landing page — the buyer will have to use the email link instead',
        { transactionId, escrowTransactionId: escrowData.id });
    }

    // Pick the GOODS item explicitly, by title. There are up to three items
    // (goods, Shipping, protection fee). Matching on type alone is not
    // sufficient because Shipping is also a broker_fee item — if Escrow.com
    // returned it first, the release call would target the shipping line
    // instead of the actual goods. That is a real money bug.
    const escrowItemId = (function () {
      const items = escrowData.items || [];
      const goodsTitle = txn.item_name || 'Item';
      let goods = items.find((i) => i.title === goodsTitle);
      if (!goods) goods = items.find((i) => i.type !== 'broker_fee' && i.title !== 'Shipping');
      return goods ? goods.id : (items[0] ? items[0].id : null);
    })();

    if (!escrowItemId) {
      await logAlertToSupabase(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, 'escrow_transaction_creation',
        'CRITICAL: created an Escrow.com transaction but could not identify its merchandise item — funds will not be releasable',
        { transactionId, escrowTransactionId: escrowData.id, items: escrowData.items });
    }

    // ------------------------------------------------------------------
    // 3b. Link the real Escrow transaction back onto the Bastion row — and
    // VERIFY that the write landed.
    //
    // This response was previously ignored entirely. A failed PATCH here
    // leaves a real escrow transaction, holding real money, that Bastion has
    // no record of: an orphaned financial object nobody can release, refund
    // or even find. Silence was the worst possible handling.
    // ------------------------------------------------------------------
    const linkRes = await fetch(`${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        escrow_transaction_id: escrowData.id,
        escrow_status: escrowData.status || 'created',
        escrow_item_id: escrowItemId,
        escrow_transaction_url: payLink,
      }),
    });

    if (!linkRes.ok) {
      const detail = await linkRes.text().catch(() => '');
      await logAlertToSupabase(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, 'escrow_transaction_creation',
        'CRITICAL: an Escrow.com transaction was created but could not be linked to its Bastion transaction. Orphaned escrow object — reconcile by hand.',
        { transactionId, escrowTransactionId: escrowData.id, status: linkRes.status, detail: detail.slice(0, 500) });

      // Reported as a failure, because it IS one. The caller must not tell
      // the buyer their purchase is set up when we cannot find it again.
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Your payment was set up with Escrow.com, but we could not finish linking it to this order. Support has been alerted and will contact you — do not pay until you hear from us.',
          escrow_transaction_id: escrowData.id,
          linkFailed: true,
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ escrow_transaction_id: escrowData.id, status: escrowData.status, payment_url: payLink }),
    };
  } catch (err) {
    console.error('create-escrow-transaction fatal error:', err);
    await logAlertToSupabase(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, 'escrow_transaction_creation', 'Fatal error creating escrow transaction', {
      error: err.message,
    });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function logAlertToSupabase(supabaseUrl, serviceKey, source, message, context){
  if (!supabaseUrl || !serviceKey) return;
  try {
    await fetch(supabaseUrl + '/rest/v1/system_alerts', {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ source, message, context: context || {} }),
    });
  } catch (e) {
    console.error('create-escrow-transaction: could not write to system_alerts', e);
  }
}
