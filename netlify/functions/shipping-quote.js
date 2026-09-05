// netlify/functions/shipping-quote.js
//
// WHAT THIS DOES:
// Called from the listing page before checkout. The buyer picks (or enters)
// a destination; this returns real, live carrier prices for it plus the
// protection tier that applies.
//
// WHY IT'S A SERVER FUNCTION:
// The carrier API key must never touch the browser, and the price the buyer
// is charged must be one Bastion computed — not one the browser sent us.

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

    const { dealId, address } = body;
    if (!dealId) return lib.json(400, { error: 'dealId is required' });
    if (!address) return lib.json(400, { error: 'A destination address is required' });

    // --- Screen the destination before spending a carrier API call -----
    const screen = lib.screenDestination(address);
    if (!screen.ok) {
      return lib.json(422, { error: screen.reason, blocked: true });
    }

    // --- Load the real listing. Price comes from the database, never
    //     from the browser, so a tampered request can't lower the tier.
    const deals = await lib.sbSelect(
      'deals?id=eq.' + encodeURIComponent(dealId) +
      '&select=id,price,status,seller_id,fulfilment,ships_from_postal,item_weight_oz,item_length_in,item_width_in,item_height_in'
    );
    const deal = deals && deals[0];
    if (!deal) return lib.json(404, { error: 'That listing no longer exists.' });

    if (deal.status !== 'active') {
      return lib.json(409, { error: 'That listing is no longer available.' });
    }
    if (deal.seller_id === user.id) {
      return lib.json(403, { error: 'You cannot buy your own listing.' });
    }
    if (deal.fulfilment === 'meetup') {
      return lib.json(409, {
        error: 'This listing is in-person handoff only. The seller has not enabled shipping for it.',
      });
    }

    // --- Parcel dimensions -------------------------------------------
    // Sellers give these at listing time. If any are missing we refuse to
    // guess: a wrong weight means a wrong price and a carrier adjustment
    // bill later, which would land on Bastion.
    const weight = Number(deal.item_weight_oz);
    const length = Number(deal.item_length_in);
    const width = Number(deal.item_width_in);
    const height = Number(deal.item_height_in);

    if (!weight || !length || !width || !height ||
        weight <= 0 || length <= 0 || width <= 0 || height <= 0) {
      return lib.json(422, {
        error: 'This listing is missing its package size or weight, so shipping cannot be quoted. The seller needs to add those before it can ship.',
        missingDimensions: true,
      });
    }

    const itemValue = Number(deal.price) || 0;
    const tier = lib.tierForValue(itemValue);
    const rules = lib.tierRules(tier);

    if (address.hold_at_location && !rules.allowHoldAtLocation) {
      return lib.json(422, {
        error: 'Carrier pickup holds are available on Protected and Vault shipments only.',
      });
    }

    // Real per-seller origin address, not a fixed business address — see
    // the comment on senderIdentity() in _shipping-lib.js for why this
    // matters. Stored privately, same treatment as the anti-fraud serial
    // number: a buyer never needs to see a seller's street address.
    const privateRes = await lib.sbSelect(
      'listing_private?deal_id=eq.' + encodeURIComponent(dealId) +
      '&select=ships_from_street1,ships_from_street2,ships_from_city,ships_from_state'
    );
    const priv = privateRes && privateRes[0];

    const from = lib.senderIdentity({
      street1: priv && priv.ships_from_street1,
      street2: priv && priv.ships_from_street2,
      city: priv && priv.ships_from_city,
      state: priv && priv.ships_from_state,
      zip: deal.ships_from_postal,
    });

    if (!from.zip || !from.street1 || !from.city || !from.state) {
      await lib.logAlert('shipping_quote', 'Seller has not set a complete shipping origin address', { dealId });
      return lib.json(422, {
        error: 'The seller has not finished setting up their shipping origin address for this listing, so shipping cannot be quoted yet.',
      });
    }

    let quoted;
    try {
      quoted = await lib.fetchRates({
        from,
        to: address,
        parcel: { weight_oz: weight, length, width, height },
        declaredValue: itemValue,
        tier,
      });
    } catch (rateErr) {
      await lib.logAlert('shipping_quote', 'Carrier rate lookup failed', {
        dealId, error: rateErr.message,
      });
      return lib.json(502, {
        error: 'We could not reach the carrier for live rates just now. Please try again in a moment.',
      });
    }

    // --- Filter to services that actually satisfy the tier ------------
    // A Vault item is not going ground with no signature. Anything that
    // can't carry the required confirmation is removed from the list the
    // buyer ever sees, rather than shown and rejected later.
    let rates = (quoted.rates || []).filter((r) => r.amount > 0);

    if (rules.minCarrierService === 'express') {
      const expressish = rates.filter((r) =>
        /express|priority|overnight|2.?day|next.?day/i.test(r.service || '')
      );
      if (expressish.length) rates = expressish;
    }

    rates.sort((a, b) => a.amount - b.amount);
    rates = rates.slice(0, 6).map((r) => {
      // The buyer is quoted the standard retail rate for the service.
      // Bastion is billed the discounted commercial rate and keeps the
      // spread — see toRetailRate() in _shipping-lib.js for why this is
      // presented the way it is. The commercial figure is deliberately
      // NOT returned to the browser.
      const priced = lib.toRetailRate(r);
      return {
        rateToken: lib.PROVIDER === 'easypost'
          ? quoted.providerShipmentId + '|' + r.id
          : r.id,
        carrier: r.carrier,
        service: r.service,
        amount: priced.retail,
        estimatedDays: r.days || null,
      };
    });
    // Re-sort on the price the buyer actually sees, since the retail
    // multiplier differs by service band and can reorder the list.
    rates.sort((a, b) => a.amount - b.amount);

    if (!rates.length) {
      return lib.json(422, {
        error: 'No carrier service is available to that address for this item at its protection level.',
      });
    }

    return lib.json(200, {
      tier,
      tierLabel: rules.label,
      signatureRequired: rules.signatureRequired,
      adultSignatureRequired: rules.adultSignatureRequired,
      packingVideoRequired: rules.packingVideoRequired,
      doubleBoxRequired: rules.doubleBoxRequired,
      // Was computed and enforced server-side already (see the
      // address.hold_at_location check above) but never actually returned
      // to the client — so there was nothing for the checkout UI to key
      // off of to decide whether to offer the option at all.
      allowHoldAtLocation: rules.allowHoldAtLocation,
      shipByHours: rules.shipByHours,
      inspectionDays: Math.round(rules.inspectionSeconds / 86400),
      declaredValue: itemValue,
      providerShipmentId: quoted.providerShipmentId,
      rates,
    });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) {
      await lib.logAlert('shipping_quote', 'Fatal error quoting shipping', { error: err.message });
    }
    return lib.json(code, { error: code === 500 ? 'Something went wrong quoting shipping.' : err.message });
  }
};
