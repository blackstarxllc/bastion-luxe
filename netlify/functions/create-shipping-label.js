// netlify/functions/create-shipping-label.js
//
// WHAT THIS DOES:
// The seller clicks "Get my shipping label". This buys a real prepaid label
// from the carrier and attaches the tracking number to the shipment.
//
// WHY THE SELLER NEVER TYPES A TRACKING NUMBER:
// A tracking number a seller types in is worth nothing — it can be any
// parcel going anywhere, including an empty envelope to the right zip code.
// A tracking number Bastion generated is bound to this transaction, this
// destination and this declared weight, and the carrier's own scan events
// are what move the transaction forward. That binding is the entire point.
//
// GATE ORDER MATTERS: escrow must be funded before a label is bought, or
// Bastion would be paying postage for orders that were never paid for.

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

    const { shipmentId, rateToken, packingChecklistConfirmed } = body;
    if (!shipmentId) return lib.json(400, { error: 'shipmentId is required' });

    const shipments = await lib.sbSelect(
      'shipments?id=eq.' + encodeURIComponent(shipmentId) + '&select=*'
    );
    const shipment = shipments && shipments[0];
    if (!shipment) return lib.json(404, { error: 'Shipment not found.' });

    // --- Only the seller buys the label -------------------------------
    if (shipment.seller_id !== user.id) {
      return lib.json(403, { error: 'Only the seller on this order can create its shipping label.' });
    }

    // --- Idempotency: never buy two labels for one shipment -----------
    // Postage is real money. A double-click must not cost twice.
    if (shipment.tracking_number) {
      return lib.json(200, {
        alreadyExisted: true,
        trackingNumber: shipment.tracking_number,
        labelUrl: shipment.label_url,
        carrier: shipment.carrier,
        service: shipment.service,
      });
    }

    if (['cancelled', 'returned'].includes(shipment.status)) {
      return lib.json(409, { error: 'This shipment is closed and cannot have a new label.' });
    }

    // --- Escrow must actually be funded first -------------------------
    const txns = await lib.sbSelect(
      'transactions?id=eq.' + encodeURIComponent(shipment.transaction_id) +
      '&select=id,status,price,deal_id'
    );
    const txn = txns && txns[0];
    if (!txn) return lib.json(404, { error: 'The order for this shipment no longer exists.' });

    if (txn.status !== 'funded') {
      return lib.json(409, {
        error: 'The buyer\u2019s payment is not confirmed in escrow yet. Your label unlocks the moment it is \u2014 do not ship before then.',
        notFunded: true,
      });
    }

    const rules = lib.tierRules(shipment.tier);

    // --- Packing checklist gate ---------------------------------------
    // On Protected and Vault tiers the seller must confirm the packing
    // requirements before a label exists. If they never confirmed, they
    // can later claim they were never told — and that claim would be true.
    if (rules.packingVideoRequired && !packingChecklistConfirmed) {
      return lib.json(422, {
        error: 'Please confirm the packing checklist before your label is issued.',
        checklistRequired: true,
        rules: {
          doubleBox: rules.doubleBoxRequired,
          packingVideo: rules.packingVideoRequired,
          adultSignature: rules.adultSignatureRequired,
        },
      });
    }

    const deals = await lib.sbSelect(
      'deals?id=eq.' + encodeURIComponent(txn.deal_id) +
      '&select=item_weight_oz,item_length_in,item_width_in,item_height_in'
    );
    const deal = deals && deals[0];
    if (!deal) return lib.json(404, { error: 'That listing no longer exists.' });

    const weight = Number(deal.item_weight_oz);
    const length = Number(deal.item_length_in);
    const width = Number(deal.item_width_in);
    const height = Number(deal.item_height_in);
    if (!weight || !length || !width || !height) {
      return lib.json(422, { error: 'This listing is missing its package size or weight.' });
    }

    // --- Resolve which rate to buy ------------------------------------
    // Normally the buyer's chosen rate token was carried through. If it
    // has expired (carrier rate tokens are short-lived), re-quote and take
    // the cheapest compliant service rather than failing the seller.
    let token = rateToken;
    if (!token) {
      // Use the address snapshotted onto the shipment at purchase time, not
      // a fresh listing lookup — this is the exact origin the buyer's rate
      // was quoted against, and stays correct even if the seller has since
      // edited their listing's address.
      const from = lib.senderIdentity({
        street1: shipment.from_street1,
        street2: shipment.from_street2,
        city: shipment.from_city,
        state: shipment.from_state,
        zip: shipment.from_postal,
      });
      const requote = await lib.fetchRates({
        from,
        to: {
          name: shipment.to_name, line1: shipment.to_line1, line2: shipment.to_line2,
          city: shipment.to_city, state: shipment.to_state,
          postal_code: shipment.to_postal, country: shipment.to_country,
          phone: shipment.to_phone,
        },
        parcel: { weight_oz: weight, length, width, height },
        declaredValue: shipment.declared_value,
        tier: shipment.tier,
      });
      let candidates = (requote.rates || []).filter((r) => r.amount > 0);
      if (rules.minCarrierService === 'express') {
        const expressish = candidates.filter((r) =>
          /express|priority|overnight|2.?day|next.?day/i.test(r.service || '')
        );
        if (expressish.length) candidates = expressish;
      }
      if (!candidates.length) {
        return lib.json(422, { error: 'No carrier service is currently available for this shipment.' });
      }

      // ------------------------------------------------------------------
      // Buy the service the BUYER PAID FOR, not the cheapest one available.
      //
      // This previously sorted by price and took candidates[0]. Since the
      // buyer's selection was never persisted, a buyer could pay for a
      // 2-day service and receive ground, with the price difference
      // disappearing into the payout. Rate tokens are short-lived and
      // escrow funding can take days, so the durable key is the carrier +
      // service level recorded at purchase, re-matched against a fresh
      // quote here.
      // ------------------------------------------------------------------
      let picked = null;
      if (shipment.chosen_service) {
        const wantService = String(shipment.chosen_service).trim().toLowerCase();
        const wantCarrier = String(shipment.chosen_carrier || '').trim().toLowerCase();
        picked = candidates.find((r) =>
          String(r.service || '').trim().toLowerCase() === wantService &&
          (!wantCarrier || String(r.carrier || '').trim().toLowerCase() === wantCarrier)
        );
        // Same service, any carrier, before giving up on the choice.
        if (!picked) {
          picked = candidates.find((r) =>
            String(r.service || '').trim().toLowerCase() === wantService
          );
        }
        if (!picked) {
          // The carrier no longer offers what the buyer bought. Falling back
          // silently would hand them a slower service than they paid for, so
          // this is recorded for review rather than swallowed.
          await lib.logAlert('shipping_label',
            'Buyer\u2019s chosen service is no longer available \u2014 fell back to cheapest compliant rate',
            {
              shipmentId,
              chosenCarrier: shipment.chosen_carrier,
              chosenService: shipment.chosen_service,
              quotedCost: shipment.quoted_cost,
              available: candidates.map((r) => (r.carrier || '') + ' ' + (r.service || '')).join(' | ').slice(0, 400),
            });
        }
      }

      if (!picked) {
        candidates.sort((a, b) => a.amount - b.amount);
        picked = candidates[0];
      }

      token = lib.PROVIDER === 'easypost'
        ? requote.providerShipmentId + '|' + picked.id
        : picked.id;
    }

    let label;
    try {
      label = await lib.buyLabel(token);
    } catch (labelErr) {
      await lib.logAlert('shipping_label', 'Carrier label purchase failed', {
        shipmentId, error: labelErr.message,
      });
      return lib.json(502, {
        error: 'The carrier could not issue a label just now. Please try again in a moment \u2014 you have not been charged.',
      });
    }

    if (!label.trackingNumber || !label.labelUrl) {
      await lib.logAlert('shipping_label', 'Carrier returned an incomplete label', {
        shipmentId, label: JSON.stringify(label).slice(0, 400),
      });
      return lib.json(502, { error: 'The carrier returned an incomplete label. Support has been alerted.' });
    }

    // --- Ship-by deadline -----------------------------------------------
    // This should already be set by escrow-webhook.js the moment funding
    // was confirmed — that's what the shipping FAQ and Terms of Service
    // promise ("measured from when escrow confirms funding"). Calculating
    // a fresh one HERE, every time, used to silently overwrite that with a
    // brand-new, more generous deadline starting from whenever the seller
    // finally got around to clicking this button — which could be days
    // later, defeating the entire point of a bounded shipping window.
    //
    // Fixed: only fill this in if it is somehow still missing (funding
    // fired, but the deadline-setting step failed for some other reason —
    // logged as a system_alert when that happens, so it's never silent).
    // The normal path preserves whatever escrow-webhook.js already set.
    const shipBy = shipment.ship_by || new Date(Date.now() + rules.shipByHours * 3600 * 1000).toISOString();
    if (!shipment.ship_by) {
      await lib.logAlert('shipping_label', 'Shipment had no ship_by deadline at label creation — funding webhook may not have set one', { shipmentId });
    }

    await lib.sbPatch('shipments', 'id=eq.' + encodeURIComponent(shipmentId), {
      tracking_number: label.trackingNumber,
      label_url: label.labelUrl,
      carrier: label.carrier,
      service: label.service,
      shipping_cost: label.cost,
      provider_shipment_id: label.providerShipmentId,
      status: 'label_created',
      label_created_at: new Date().toISOString(),
      ship_by: shipBy,
    });

    // If the label cost materially more than the buyer was charged, the
    // seller absorbs the gap. Surface it rather than letting it accumulate
    // invisibly across many orders.
    if (shipment.quoted_cost && label.cost) {
      const drift = Number(label.cost) - Number(shipment.quoted_cost);
      if (Math.abs(drift) >= 3) {
        await lib.logAlert('shipping_label', 'Label cost drifted from the rate quoted to the buyer', {
          shipmentId,
          quotedToBuyer: shipment.quoted_cost,
          actualLabelCost: label.cost,
          drift: drift.toFixed(2),
        });
      }
    }

    await lib.sbInsert('shipment_events', {
      shipment_id: shipmentId,
      status: 'label_created',
      description: 'Bastion issued a prepaid ' + (label.carrier || 'carrier') + ' label.',
      occurred_at: new Date().toISOString(),
    });

    // Tell the buyer their order is moving.
    await lib.sbInsert('notifications', {
      user_id: shipment.buyer_id,
      type: 'shipping',
      title: 'Your order has a shipping label',
      body: 'The seller has generated a prepaid, tracked label. You will be notified at every carrier scan.',
      link: '/bastion-transaction.html?id=' + shipment.transaction_id,
    }).catch(() => {});

    return lib.json(200, {
      trackingNumber: label.trackingNumber,
      labelUrl: label.labelUrl,
      carrier: label.carrier,
      service: label.service,
      shipBy,
      rules: {
        doubleBox: rules.doubleBoxRequired,
        packingVideo: rules.packingVideoRequired,
        adultSignature: rules.adultSignatureRequired,
      },
    });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) {
      await lib.logAlert('shipping_label', 'Fatal error creating label', { error: err.message });
    }
    return lib.json(code, { error: code === 500 ? 'Something went wrong creating the label.' : err.message });
  }
};
