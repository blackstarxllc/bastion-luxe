// netlify/functions/shipping-webhook.js
//
// WHAT THIS DOES:
// The carrier (via Shippo/EasyPost) calls this whenever a parcel is scanned.
// It records the scan and moves the Bastion transaction forward.
//
// ============================ SECURITY ============================
// The payload is an UNTRUSTED HINT. The only thing taken from it is the
// tracking number. The actual tracking state is then re-fetched from the
// provider's own API using our credentials, and THAT is what gets written.
// A forged webhook can at worst trigger a harmless re-sync against the real
// source of truth. This mirrors how escrow-webhook.js already works.
// ==================================================================
//
// ======================= WHY IT ALWAYS RETURNS 200 =================
// Providers disable webhooks that keep returning errors. Every failure path
// here answers 200 but writes a row to system_alerts, which surfaces in the
// Admin panel. Silent to the carrier, loud to Bastion.
// ==================================================================

const lib = require('./_shipping-lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return lib.json(405, { error: 'Method not allowed' });
  }

  try {
    // --- Soft gate against junk traffic -------------------------------
    // Non-blocking on purpose, for the same reason as the escrow webhook:
    // if the provider does not preserve the query string on the registered
    // URL, a hard 401 would fail every legitimate call. The real boundary
    // is the re-verification below.
    const expected = process.env.SHIPPING_WEBHOOK_SECRET;
    if (expected) {
      const params = event.queryStringParameters || {};
      const provided = params.secret
        || event.headers['x-webhook-secret']
        || event.headers['X-Webhook-Secret'];
      if (provided !== expected) {
        await lib.logAlert('shipping_webhook',
          'Webhook secret did not match (proceeding — provider re-verification below is the real boundary)',
          { providedLength: provided ? String(provided).length : 0 });
      }
    }

    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      await lib.logAlert('shipping_webhook', 'Could not parse webhook body', {
        rawBody: (event.body || '').slice(0, 600),
      });
      return lib.json(200, { received: true, parsed: false });
    }

    // Both providers nest this differently, and have changed it before.
    const trackingNumber =
      payload.tracking_number
      || (payload.data && payload.data.tracking_number)
      || (payload.result && payload.result.tracking_number)
      || (payload.data && payload.data.tracking_code)
      || payload.tracking_code
      || null;

    if (!trackingNumber) {
      await lib.logAlert('shipping_webhook', 'No tracking number anywhere in payload', {
        payload: JSON.stringify(payload).slice(0, 600),
      });
      return lib.json(200, { received: true, foundTracking: false });
    }

    const shipments = await lib.sbSelect(
      'shipments?tracking_number=eq.' + encodeURIComponent(trackingNumber) + '&select=*'
    );
    const shipment = shipments && shipments[0];
    if (!shipment) {
      await lib.logAlert('shipping_webhook', 'No Bastion shipment matches this tracking number', {
        trackingNumber,
      });
      return lib.json(200, { received: true, matched: false });
    }

    // --- Re-verify with the provider ----------------------------------
    const verified = await verifyTracking(shipment.carrier, trackingNumber);
    if (!verified) {
      await lib.logAlert('shipping_webhook', 'Could not verify tracking with the provider', {
        trackingNumber, shipmentId: shipment.id,
      });
      return lib.json(200, { received: true, verified: false });
    }

    const newStatus = lib.normaliseTrackingStatus(verified.status);
    if (!newStatus) {
      return lib.json(200, { received: true, verified: true, mapped: false });
    }

    // --- Record the scan (append-only chain of custody) ----------------
    // Deduped on (status, occurred_at) so provider retries don't produce
    // a duplicate history that would look tampered-with in a dispute.
    const occurredAt = verified.occurredAt || new Date().toISOString();
    const existingEvents = await lib.sbSelect(
      'shipment_events?shipment_id=eq.' + encodeURIComponent(shipment.id) +
      '&status=eq.' + encodeURIComponent(newStatus) +
      '&occurred_at=eq.' + encodeURIComponent(occurredAt) + '&select=id'
    );

    if (!existingEvents || !existingEvents.length) {
      await lib.sbInsert('shipment_events', {
        shipment_id: shipment.id,
        status: newStatus,
        description: verified.description || null,
        location: verified.location || null,
        occurred_at: occurredAt,
        raw: verified.raw || null,
      });
    }

    // --- Advance the shipment ------------------------------------------
    // Never move backwards. Carriers do re-send older scans out of order,
    // and a "delivered" shipment must not revert to "in transit".
    const ORDER = {
      awaiting_label: 0, label_created: 1, in_transit: 2,
      out_for_delivery: 3, delivered: 4, exception: 4, returned: 5, cancelled: 5,
    };

    const patch = {};
    if ((ORDER[newStatus] ?? 0) > (ORDER[shipment.status] ?? 0)) {
      patch.status = newStatus;
    }

    if (newStatus === 'in_transit' && !shipment.first_scan_at) {
      patch.first_scan_at = occurredAt;
    }
    if (newStatus === 'delivered' && !shipment.delivered_at) {
      patch.delivered_at = occurredAt;
      if (verified.signedBy) patch.delivery_signed_by = verified.signedBy;
    }

    if (Object.keys(patch).length) {
      await lib.sbPatch('shipments', 'id=eq.' + encodeURIComponent(shipment.id), patch);
    }

    // --- Mirror onto the transaction -----------------------------------
    await syncTransaction(shipment, newStatus, occurredAt);

    return lib.json(200, { received: true, verified: true, status: newStatus });
  } catch (err) {
    await lib.logAlert('shipping_webhook', 'Fatal error in shipping webhook', {
      error: err.message, stack: (err.stack || '').slice(0, 800),
    });
    return lib.json(200, { received: true, fatalError: true });
  }
};

// ---------------------------------------------------------------
// Ask the provider directly what this parcel's state really is.
// ---------------------------------------------------------------
async function verifyTracking(carrier, trackingNumber) {
  try {
    if (lib.PROVIDER === 'easypost') {
      const key = process.env.EASYPOST_API_KEY;
      if (!key) return null;
      const auth = 'Basic ' + Buffer.from(key + ':').toString('base64');
      const res = await fetch(
        'https://api.easypost.com/v2/trackers?tracking_code=' + encodeURIComponent(trackingNumber),
        { headers: { Authorization: auth } }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const tracker = (data.trackers && data.trackers[0]) || data;
      if (!tracker) return null;
      const latest = (tracker.tracking_details || []).slice(-1)[0] || {};
      return {
        status: tracker.status,
        description: latest.message || null,
        location: latest.tracking_location
          ? [latest.tracking_location.city, latest.tracking_location.state].filter(Boolean).join(', ')
          : null,
        occurredAt: latest.datetime || null,
        signedBy: tracker.signed_by || null,
        raw: latest,
      };
    }

    const key = process.env.SHIPPO_API_KEY;
    if (!key) return null;
    const provider = carrier || 'shippo';
    const res = await fetch(
      'https://api.goshippo.com/tracks/' + encodeURIComponent(provider) + '/' + encodeURIComponent(trackingNumber),
      { headers: { Authorization: 'ShippoToken ' + key } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const s = data.tracking_status || {};
    return {
      status: s.status,
      description: s.status_details || null,
      location: s.location
        ? [s.location.city, s.location.state].filter(Boolean).join(', ')
        : null,
      occurredAt: s.status_date || null,
      signedBy: (data.tracking_status && data.tracking_status.signed_by) || null,
      raw: s,
    };
  } catch (e) {
    console.error('verifyTracking failed:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------
// Keep the transaction in step with the parcel.
//
// Note what this deliberately does NOT do: it never releases funds.
// Delivery is not the same as the buyer having what they paid for, and an
// automatic release on a delivery scan is exactly how empty-box fraud gets
// paid out. Delivery opens the inspection window; a human closes it.
// ---------------------------------------------------------------
async function syncTransaction(shipment, newStatus, occurredAt) {
  const txns = await lib.sbSelect(
    'transactions?id=eq.' + encodeURIComponent(shipment.transaction_id) + '&select=id,status,buyer_id,seller_id'
  );
  const txn = txns && txns[0];
  if (!txn) return;

  // Never touch a transaction that has already concluded or gone to dispute.
  if (['released', 'disputed', 'cancelled'].includes(txn.status)) return;

  const patch = {};
  let notifyTitle = null;
  let notifyBody = null;
  let notifyUser = txn.buyer_id;

  if (newStatus === 'in_transit' && txn.status === 'funded') {
    patch.status = 'shipped';
    patch.shipped_at = occurredAt;
    notifyTitle = 'Your item is on its way';
    notifyBody = 'The carrier has scanned the package in. You can follow every scan on your order page.';
  } else if (newStatus === 'out_for_delivery') {
    notifyTitle = 'Out for delivery today';
    notifyBody = 'Your package is out for delivery. Remember: film one continuous video as you open the sealed box.';
  } else if (newStatus === 'delivered') {
    patch.status = 'delivered';
    notifyTitle = 'Delivered — please inspect';
    notifyBody = 'Your package was delivered. Open it on camera, check the item, then confirm receipt to release payment. If something is wrong, report an issue instead.';
  } else if (newStatus === 'exception') {
    notifyTitle = 'Delivery problem';
    notifyBody = 'The carrier reported a problem with your package. Bastion support has been alerted and your payment stays held in escrow.';
    await lib.logAlert('shipping_exception', 'Carrier reported a delivery exception', {
      shipmentId: shipment.id, transactionId: txn.id, tracking: shipment.tracking_number,
    });
  } else if (newStatus === 'returned') {
    notifyTitle = 'Package returned to sender';
    notifyBody = 'The carrier is returning this package. Your payment remains held in escrow while support reviews it.';
    await lib.logAlert('shipping_returned', 'Parcel returned to sender', {
      shipmentId: shipment.id, transactionId: txn.id,
    });
  }

  if (Object.keys(patch).length) {
    await lib.sbPatch('transactions', 'id=eq.' + encodeURIComponent(txn.id), patch);
  }

  if (notifyTitle) {
    await lib.sbInsert('notifications', {
      user_id: notifyUser,
      type: 'shipping',
      title: notifyTitle,
      body: notifyBody,
      link: '/bastion-transaction.html?id=' + txn.id,
    }).catch(() => {});

    // The seller cares about delivery and about anything going wrong.
    if (['delivered', 'exception', 'returned'].includes(newStatus)) {
      await lib.sbInsert('notifications', {
        user_id: txn.seller_id,
        type: 'shipping',
        title: newStatus === 'delivered' ? 'Your item was delivered' : notifyTitle,
        body: newStatus === 'delivered'
          ? 'The buyer now has an inspection window to confirm receipt. Funds release once they confirm.'
          : notifyBody,
        link: '/bastion-transaction.html?id=' + txn.id,
      }).catch(() => {});
    }
  }
}
