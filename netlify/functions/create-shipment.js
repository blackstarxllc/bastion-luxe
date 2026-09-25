// netlify/functions/create-shipment.js
//
// WHAT THIS DOES:
// Called immediately after a buyer's transaction row is created, when the
// deal is a shipped one. It snapshots the destination address onto a
// shipment record and locks it.
//
// WHY THE ADDRESS IS COPIED, NOT REFERENCED:
// If the shipment pointed at a row in the buyer's address book, the buyer
// could edit that row after purchase and silently redirect a parcel that
// the seller already packed and the escrow already covers. Copying it means
// a change of destination requires cancelling and starting over — which is
// exactly the "address lock" every serious marketplace enforces.

const lib = require('./_shipping-lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return lib.json(405, { error: 'Method not allowed' });
  }

  try {
    const user = await lib.requireUser(event);

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return lib.json(400, { error: 'Could not read that request.' });
    }

    const { transactionId, addressId, holdAtLocation, quoteToken } = body;
    if (!transactionId) return lib.json(400, { error: 'transactionId is required' });
    if (!addressId) return lib.json(400, { error: 'A shipping address is required' });

    // --- The caller must be the real buyer on this transaction --------
    const txns = await lib.sbSelect(
      'transactions?id=eq.' + encodeURIComponent(transactionId) +
      '&select=id,buyer_id,seller_id,deal_id,price,fee,status,fulfillment_mode,shipping_verified_at'
    );
    const txn = txns && txns[0];
    if (!txn) return lib.json(404, { error: 'Transaction not found.' });

    if (txn.buyer_id !== user.id) {
      return lib.json(403, { error: 'Only the buyer on this order can set its shipping details.' });
    }

    // Once escrow is funded the destination is frozen. This is the hard
    // stop behind the address lock.
    if (txn.status !== 'pending_payment') {
      return lib.json(409, {
        error: 'This order has already moved past checkout, so its delivery address can no longer be changed. Cancel the order and start again if you need a different address.',
      });
    }

    const addrs = await lib.sbSelect(
      'shipping_addresses?id=eq.' + encodeURIComponent(addressId) +
      '&user_id=eq.' + encodeURIComponent(user.id) + '&select=*'
    );
    const addr = addrs && addrs[0];
    if (!addr) return lib.json(404, { error: 'That address was not found on your account.' });

    const screen = lib.screenDestination(addr);
    if (!screen.ok) return lib.json(422, { error: screen.reason });

    // The shipping price comes from a server-signed quote, never from the
    // browser. The token binds buyer, listing, destination ZIP, carrier,
    // service and price; a tampered or stale one is refused outright.
    const quote = lib.verifyQuote(quoteToken);
    if (!quote) {
      return lib.json(409, {
        error: 'Your shipping quote has expired or could not be verified. Please choose your shipping option again.',
        requote: true,
      });
    }
    if (quote.u !== user.id || quote.d !== txn.deal_id ||
        quote.z !== lib.normalisePostal(addr.postal_code) || !(Number(quote.a) > 0)) {
      return lib.json(409, {
        error: 'That shipping quote does not match this order or address. Please choose your shipping option again.',
        requote: true,
      });
    }
    const verifiedShipping = Math.round(Number(quote.a) * 100) / 100;

    // Writes the verified shipping charge onto the order. Runs as the
    // service role, which is the only identity allowed to set
    // shipping_verified_at; create-escrow-transaction refuses a shipped
    // order until it is set.
    async function lockInShipping() {
      const total = Math.round((Number(txn.price) + Number(txn.fee) + verifiedShipping) * 100) / 100;
      const patched = await lib.sbPatch(
        'transactions',
        'id=eq.' + encodeURIComponent(txn.id) + '&status=eq.pending_payment',
        {
          shipping_cost: verifiedShipping,
          total: total,
          fulfillment_mode: 'shipped',
          shipping_verified_at: new Date().toISOString(),
        },
        true
      );
      if (!patched || !patched.length) {
        await lib.logAlert('create_shipment', 'Could not record the verified shipping charge on the order', { transactionId });
        const err = new Error('We could not confirm the shipping charge on your order. Please try again.');
        err.statusCode = 500;
        throw err;
      }
    }

    // Idempotent: a retried checkout reuses the shipment that already exists,
    // but still makes sure the order carries the verified charge.
    const existing = await lib.sbSelect(
      'shipments?transaction_id=eq.' + encodeURIComponent(transactionId) + '&direction=eq.outbound&select=id'
    );
    if (existing && existing.length) {
      if (!txn.shipping_verified_at) await lockInShipping();
      return lib.json(200, { shipmentId: existing[0].id, alreadyExisted: true, shippingCost: verifiedShipping });
    }

    const deals = await lib.sbSelect(
      'deals?id=eq.' + encodeURIComponent(txn.deal_id) + '&select=id,ships_from_postal,fulfilment'
    );
    const deal = deals && deals[0];
    if (!deal) return lib.json(404, { error: 'That listing no longer exists.' });
    if (deal.fulfilment === 'meetup') {
      return lib.json(409, { error: 'This listing is in-person handoff only.' });
    }

    // Snapshot the seller's real origin address now, at the same moment the
    // buyer's destination gets snapshotted — so the label is always built
    // from exactly the address the shipping quote was calculated against,
    // even if the seller edits their listing later.
    const privateRes = await lib.sbSelect(
      'listing_private?deal_id=eq.' + encodeURIComponent(txn.deal_id) +
      '&select=ships_from_street1,ships_from_street2,ships_from_city,ships_from_state'
    );
    const priv = privateRes && privateRes[0];
    if (!priv || !priv.ships_from_street1 || !priv.ships_from_city || !priv.ships_from_state || !deal.ships_from_postal) {
      return lib.json(422, { error: 'The seller has not finished setting up a complete shipping origin address for this listing.' });
    }

    const itemValue = Number(txn.price) || 0;
    const tier = lib.tierForValue(itemValue);
    const rules = lib.tierRules(tier);

    const wantsHold = !!(holdAtLocation && quote.h) && rules.allowHoldAtLocation;

    const created = await lib.sbInsert('shipments', {
      transaction_id: txn.id,
      seller_id: txn.seller_id,
      buyer_id: txn.buyer_id,
      to_name: addr.full_name,
      to_line1: addr.line1,
      to_line2: addr.line2,
      to_city: addr.city,
      to_state: addr.state,
      to_postal: addr.postal_code,
      to_country: addr.country || 'US',
      to_phone: addr.phone,
      hold_at_location: wantsHold,
      from_postal: deal.ships_from_postal,
      from_street1: priv.ships_from_street1,
      from_street2: priv.ships_from_street2 || null,
      from_city: priv.ships_from_city,
      from_state: priv.ships_from_state,
      tier,
      signature_required: rules.signatureRequired,
      adult_signature_required: rules.adultSignatureRequired,
      declared_value: itemValue,
      // The buyer paid for a SPECIFIC service level. Persist it so the
      // label is bought as the service they chose, not as whatever happens
      // to be cheapest when the seller gets round to printing it.
      chosen_carrier: quote.c || null,
      chosen_service: quote.s || null,
      quoted_cost: verifiedShipping,
      status: 'awaiting_label',
    }, true);

    const shipment = created && created[0];
    if (!shipment) {
      await lib.logAlert('create_shipment', 'Insert returned no row', { transactionId });
      return lib.json(500, { error: 'Could not create the shipment record.' });
    }

    await lockInShipping();

    return lib.json(200, {
      shipmentId: shipment.id,
      shippingCost: verifiedShipping,
      tier,
      tierLabel: rules.label,
      shipByHours: rules.shipByHours,
      holdAtLocation: wantsHold,
    });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) {
      await lib.logAlert('create_shipment', 'Fatal error creating shipment', { error: err.message });
    }
    return lib.json(code, { error: code === 500 ? 'Something went wrong setting up shipping.' : err.message });
  }
};
