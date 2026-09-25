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

    // rateToken is deliberately NOT read from the request. See below.
    const { shipmentId, packingChecklistConfirmed } = body;
    if (!shipmentId) return lib.json(400, { error: 'shipmentId is required' });

    const shipments = await lib.sbSelect(
      'shipments?id=eq.' + encodeURIComponent(shipmentId) + '&select=*'
    );
    const shipment = shipments && shipments[0];
    if (!shipment) return lib.json(404, { error: 'Shipment not found.' });

    // --- Who may buy this label depends on which way it's going -------
    // Outbound is the seller shipping to the buyer. A return is the buyer
    // shipping back to the seller, so the buyer is the one who needs the
    // label. Checking only seller_id here would have made an approved
    // return impossible to actually post.
    const isReturn = shipment.direction === 'return';
    const authorisedUser = isReturn ? shipment.buyer_id : shipment.seller_id;

    if (authorisedUser !== user.id) {
      return lib.json(403, {
        error: isReturn
          ? 'Only the buyer on this order can create its return label.'
          : 'Only the seller on this order can create its shipping label.',
      });
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
      '&select=id,status,price,deal_id,funded_at'
    );
    const txn = txns && txns[0];
    if (!txn) return lib.json(404, { error: 'The order for this shipment no longer exists.' });

    // The "must be funded" gate exists so a seller never ships before the
    // money is secured. It applies to the outbound leg only — a return
    // happens after funding, usually while the transaction is disputed or
    // return_approved, so applying it here would block every return label.
    if (!isReturn && txn.status !== 'funded') {
      return lib.json(409, {
        error: 'The buyer\u2019s payment is not confirmed in escrow yet. Your label unlocks the moment it is \u2014 do not ship before then.',
        notFunded: true,
      });
    }

    if (isReturn && !['return_approved', 'disputed'].includes(txn.status)) {
      return lib.json(409, {
        error: 'A return has not been approved on this order yet.',
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
    // ------------------------------------------------------------------
    // RECOVER AN INTERRUPTED PURCHASE BEFORE BUYING ANYTHING.
    // If an earlier attempt recorded the EasyPost shipment it was buying
    // from, ask EasyPost whether that purchase actually went through. If it
    // did, adopt that label. An abandoned attempt is "unknown", never simply
    // "available again": treating it as available is how a lost response
    // turns into two paid labels.
    // ------------------------------------------------------------------
    if (shipment.pending_provider_shipment_id) {
      let prior;
      try {
        prior = await lib.fetchPurchasedLabel(shipment.pending_provider_shipment_id);
      } catch (lookupErr) {
        await lib.logAlert('shipping_label', 'Could not confirm whether an interrupted label purchase went through; refusing to buy another until it can', {
          shipmentId, pending: shipment.pending_provider_shipment_id, error: lookupErr.message,
        });
        return lib.json(503, { error: 'We are confirming an earlier label attempt with the carrier. Please try again in a few minutes \u2014 you will not be charged twice.' });
      }
      if (prior) {
        const adopted = await lib.sbPatch('shipments',
          'id=eq.' + encodeURIComponent(shipmentId) + '&tracking_number=is.null',
          {
            tracking_number: prior.trackingNumber, label_url: prior.labelUrl,
            carrier: prior.carrier, service: prior.service, shipping_cost: prior.cost,
            provider_shipment_id: prior.providerShipmentId,
            status: 'label_created', label_created_at: new Date().toISOString(),
            label_claimed_at: null, pending_provider_shipment_id: null,
          }, true);
        await lib.logAlert('shipping_label', 'Adopted a label from an interrupted purchase instead of buying a second one', {
          shipmentId, trackingNumber: prior.trackingNumber, recorded: !!(adopted && adopted.length),
        });
        return lib.json(200, { trackingNumber: prior.trackingNumber, labelUrl: prior.labelUrl, adopted: true });
      }
    }

    // ------------------------------------------------------------------
    // The label is ALWAYS bought from a fresh server-side quote for THIS
    // shipment's stored addresses.
    //
    // This used to accept a rateToken from the browser and buy whatever it
    // pointed to. A token names a shipment and rate inside Bastion's own
    // EasyPost account, so a seller could submit one from a different quote
    // (another address, another parcel, overnight service) and Bastion
    // would pay for it. The browser no longer has any say in what is bought.
    // ------------------------------------------------------------------
    const from = lib.senderIdentity({
      street1: shipment.from_street1,
      street2: shipment.from_street2,
      city: shipment.from_city,
      state: shipment.from_state,
      zip: shipment.from_postal,
    });
    let requote;
    try {
      requote = await lib.fetchRates({
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
    } catch (rateErr) {
      await lib.logAlert('shipping_label', 'Carrier rate lookup failed at label time', { shipmentId, error: rateErr.message });
      return lib.json(502, { error: 'We could not reach the carrier just now. Please try again in a moment \u2014 you have not been charged.' });
    }
    // Carrier allowlist + tier policy, failing CLOSED: a Vault item with no
    // true express service available gets no label, not a slower one.
    let candidates = lib.filterForTier(requote.rates, rules);
    if (!candidates.length) {
      await lib.logAlert('shipping_label', 'No compliant carrier service for this shipment; label NOT bought', {
        shipmentId, tier: shipment.tier, minService: rules.minCarrierService,
      });
      return lib.json(422, {
        error: rules.minCarrierService === 'express'
          ? 'No express service is available for this shipment right now, and items at this value must travel express. Support has been alerted.'
          : 'No carrier service is currently available for this shipment. Please try again shortly.',
      });
    }

    // Honour what the buyer paid for: exact carrier and service first, then
    // the same service on any carrier. If neither exists, take the cheapest
    // service in the SAME OR A FASTER speed band, never a slower one. The old
    // fallback was "cheapest compliant rate", which could hand a buyer who
    // paid for 2-Day a Ground label. Logging that was not consent.
    const SPEED = { ground: 1, default: 2, priority: 3, express: 4 };
    let picked = null;
    let substituted = false;
    if (shipment.chosen_service) {
      const wantService = String(shipment.chosen_service).trim().toLowerCase();
      const wantCarrier = String(shipment.chosen_carrier || '').trim().toLowerCase();
      picked = candidates.find((r) =>
        String(r.service || '').trim().toLowerCase() === wantService &&
        (!wantCarrier || String(r.carrier || '').trim().toLowerCase() === wantCarrier)
      ) || candidates.find((r) => String(r.service || '').trim().toLowerCase() === wantService) || null;

      if (!picked) {
        const minSpeed = SPEED[lib.serviceBand(shipment.chosen_service)] || SPEED.default;
        const sameOrFaster = candidates
          .filter((r) => (SPEED[lib.serviceBand(r.service)] || SPEED.default) >= minSpeed)
          .sort((a, b) => a.amount - b.amount);
        picked = sameOrFaster[0] || null;
        substituted = !!picked;
        if (!picked) {
          await lib.logAlert('shipping_label',
            'The service the buyer paid for is unavailable and nothing equally fast is offered; label NOT bought',
            {
              shipmentId,
              chosenCarrier: shipment.chosen_carrier,
              chosenService: shipment.chosen_service,
              available: candidates.map((r) => (r.carrier || '') + ' ' + (r.service || '')).join(' | ').slice(0, 400),
            });
          return lib.json(409, {
            error: 'The shipping service the buyer paid for is not available from the carrier right now, and we will not substitute a slower one. Support has been alerted and will contact you shortly.',
            serviceUnavailable: true,
          });
        }
      }
    } else {
      candidates.sort((a, b) => a.amount - b.amount);
      picked = candidates[0];
    }
    const token = lib.PROVIDER === 'easypost'
      ? requote.providerShipmentId + '|' + picked.id
      : picked.id;

    const configWarning = lib.shippingConfigWarning();
    if (configWarning) {
      await lib.logAlert('shipping_config', configWarning, {
        shipmentId,
        provider: lib.PROVIDER,
        testMode: lib.SHIPPING_TEST_MODE,
      });
      return lib.json(503, {
        error: 'Shipping is temporarily unavailable while a configuration issue is resolved. Support has been alerted — your order is unaffected, but your ship-by deadline keeps running, so contact support right away if it is close.',
        configIssue: true,
      });
    }

    // ------------------------------------------------------------------
    // ATOMIC CLAIM: one real label per shipment, ever.
    // The tracking_number check above is a read, so two clicks together both
    // pass it and both would buy a label with real money. Only one request
    // can win this conditional update. A claim older than five minutes is
    // considered abandoned and may be taken over.
    // ------------------------------------------------------------------
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const claimed = await lib.sbPatch(
      'shipments',
      'id=eq.' + encodeURIComponent(shipmentId) +
        '&tracking_number=is.null&or=(label_claimed_at.is.null,label_claimed_at.lt.' + encodeURIComponent(staleBefore) + ')',
      { label_claimed_at: new Date().toISOString() },
      true
    );
    if (!claimed || !claimed.length) {
      return lib.json(409, { error: 'A label for this shipment is already being created. Refresh the page in a moment.', inProgress: true });
    }
    async function releaseLabelClaim() {
      await lib.sbPatch('shipments', 'id=eq.' + encodeURIComponent(shipmentId) + '&tracking_number=is.null',
        { label_claimed_at: null }).catch(() => {});
    }

    // Journal the exact EasyPost shipment BEFORE paying for it.
    await lib.sbPatch('shipments', 'id=eq.' + encodeURIComponent(shipmentId),
      { pending_provider_shipment_id: requote.providerShipmentId });

    let label;
    try {
      label = await lib.buyLabel(token);
    } catch (labelErr) {
      if (labelErr.definitive === false) {
        // Outcome unknown: EasyPost may have bought the label. Keep the claim
        // and the journal; the next attempt looks it up and adopts it.
        await lib.logAlert('shipping_label', 'Label purchase outcome UNKNOWN (no/ambiguous response); holding the claim for reconciliation', {
          shipmentId, pending: requote.providerShipmentId, error: labelErr.message,
        });
        return lib.json(502, { error: 'We could not confirm the label with the carrier. Please wait a few minutes before trying again \u2014 you will not be charged twice.' });
      }
      await lib.sbPatch('shipments', 'id=eq.' + encodeURIComponent(shipmentId), { pending_provider_shipment_id: null }).catch(() => {});
      await releaseLabelClaim();
      await lib.logAlert('shipping_label', 'Carrier label purchase failed', {

        shipmentId, error: labelErr.message,
      });
      return lib.json(502, {
        error: 'The carrier could not issue a label just now. Please try again in a moment \u2014 you have not been charged.',
      });
    }

    if (!label.trackingNumber || !label.labelUrl) {
      await releaseLabelClaim();
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
    // The seller's ship-by clock starts when the buyer's money is confirmed,
    // never when the label happens to be printed. A missing deadline is
    // repaired from the verified funding time, so a late label can never
    // quietly buy the seller a fresh 48-72 hours.
    let shipBy = shipment.ship_by;
    if (!shipBy) {
      const fromFunding = !isReturn && txn.funded_at;
      const anchor = fromFunding ? new Date(txn.funded_at).getTime() : Date.now();
      shipBy = new Date(anchor + rules.shipByHours * 3600 * 1000).toISOString();
      await lib.logAlert('shipping_label',
        'Shipment had no ship_by deadline at label time; set it from ' + (fromFunding ? 'the funding timestamp' : 'now (return label)'),
        { shipmentId, shipBy });
    }

    try {
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
      label_claimed_at: null,
      pending_provider_shipment_id: null,
    });
    } catch (recordErr) {
      // A real label was bought and paid for, but Bastion failed to record
      // it. The claim is deliberately NOT released, so nobody can buy a
      // second label; support must attach this one by hand.
      await lib.logAlert('shipping_label', 'CRITICAL: label purchased but could not be recorded on the shipment; attach it manually', {
        shipmentId, trackingNumber: label.trackingNumber, labelUrl: label.labelUrl, error: recordErr.message,
      });
      return lib.json(500, {
        error: 'Your label was created, but we could not save it to this order. Support has been alerted and will send it to you. Please do not try again.',
        trackingNumber: label.trackingNumber,
        labelUrl: label.labelUrl,
      });
    }
    if (substituted) {
      await lib.logAlert('shipping_label', 'Buyer\u2019s exact service was unavailable; an equal-or-faster service was bought instead', {
        shipmentId, paidFor: (shipment.chosen_carrier || '') + ' ' + (shipment.chosen_service || ''),
        bought: (label.carrier || '') + ' ' + (label.service || ''),
      });
    }


    // If the label cost materially more than the buyer was charged, the
    // seller absorbs the gap. Surface it rather than letting it accumulate
    // invisibly across many orders.
    // quoted_cost is the RETAIL figure the buyer paid; label.cost is the
    // discounted commercial rate Bastion was billed. The expected state is
    // quoted_cost > label.cost — that gap is the platform margin, not an
    // error. Only alert when the actual cost EXCEEDS what the buyer paid,
    // which means the margin inverted and Bastion is losing money on the
    // shipment.
    if (shipment.quoted_cost && label.cost) {
      const drift = Number(label.cost) - Number(shipment.quoted_cost);
      if (drift >= 1) {
        await lib.logAlert('shipping_label', 'Label cost EXCEEDED the retail rate charged to the buyer \u2014 margin inverted', {
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
      user_id: isReturn ? shipment.seller_id : shipment.buyer_id,
      type: 'shipping',
      title: isReturn ? 'Return label created' : 'Your order has a shipping label',
      body: isReturn
        ? 'The buyer has generated their prepaid return label. Funds stay held in escrow until you confirm the returned item \u2014 check it against your listing\u2019s serial number before confirming.'
        : 'The seller has generated a prepaid, tracked label. You will be notified at every carrier scan.',
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
