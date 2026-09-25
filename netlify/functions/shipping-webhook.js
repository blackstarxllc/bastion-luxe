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

const crypto = require('crypto');
const lib = require('./_shipping-lib');
const escrow = require('./_escrow-lib');

// ------------------------------------------------------------------
// AUTHENTICATION
// A request is accepted only if it carries a valid X-Hmac-Signature over
// the exact raw body: EasyPost's own signing scheme, keyed with the
// webhook_secret the webhook was registered with. Anything else gets 401.
// The earlier fallback that also accepted the secret in the URL query
// string was removed on 2026-09-24, after the EasyPost webhook was
// re-registered without it: secrets in URLs leak into logs.
//
// This used to log a mismatch and carry on. That was not directly
// exploitable, because every status is re-fetched from EasyPost with
// Bastion's own key before anything changes, so a forged call could only
// trigger a refresh of real data. But an endpoint anyone can make do work
// is not acceptable, and it let anyone burn Bastion's EasyPost rate limit.
// ------------------------------------------------------------------
function rawBody(event) {
  return event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function isAuthentic(event, secret) {
  if (!secret) return false;
  const headers = event.headers || {};
  const sig = headers['x-hmac-signature'] || headers['X-Hmac-Signature'];
  if (sig) {
    const expected = 'hmac-sha256-hex=' + crypto
      .createHmac('sha256', String(secret).normalize('NFKD'))
      .update(rawBody(event))
      .digest('hex');
    return safeEqual(sig, expected);
  }
  return false;
}

// ------------------------------------------------------------------
// STATUS PRECEDENCE
// Carrier status is not a simple ladder. The old code ranked 'delivered'
// and 'exception' equally and only moved "up", so a package that hit a
// delay and was then delivered stayed 'exception' forever, and the buyer's
// release button, which waits for 'delivered', never unlocked. An exception
// is a side condition: any later real progress clears it.
// ------------------------------------------------------------------
const PROGRESS = { awaiting_label: 0, label_created: 1, in_transit: 2, out_for_delivery: 3, delivered: 4 };
const TERMINAL = ['delivered', 'returned', 'cancelled'];

function nextShipmentStatus(current, incoming) {
  if (!incoming || incoming === current) return null;
  if (TERMINAL.includes(current)) return null;
  if (incoming === 'returned' || incoming === 'cancelled') return incoming;
  if (incoming === 'exception') return 'exception';
  if (current === 'exception') return incoming;
  return (PROGRESS[incoming] ?? -1) > (PROGRESS[current] ?? -1) ? incoming : null;
}

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
    if (!isAuthentic(event, process.env.SHIPPING_WEBHOOK_SECRET)) {
      await lib.logAlert('shipping_webhook', 'Rejected an unauthenticated webhook call', {
        hasSignature: !!((event.headers || {})['x-hmac-signature'] || (event.headers || {})['X-Hmac-Signature']),
        secretConfigured: !!process.env.SHIPPING_WEBHOOK_SECRET,
      });
      return lib.json(401, { error: 'Unauthorized' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody(event).toString('utf8') || '{}');
    } catch (e) {
      await lib.logAlert('shipping_webhook', 'Could not parse webhook body', {
        rawBody: (event.body || '').slice(0, 600),
      });
      return lib.json(200, { received: true, parsed: false });
    }

    // EasyPost sends EVERY account event to this URL (invoices, refunds,
    // batches...). Only tracker and shipment events carry tracking.
    const eventType = String(payload.description || '');
    const result = payload.result || {};

    // EasyPost's Tracker and Shipment objects carry the number in
    // result.tracking_code. That exact field was missing from this list, so
    // every real tracking update was logged as "no tracking number" and
    // dropped: delivery could never register.
    const trackingNumber =
      result.tracking_code
      || result.tracking_number
      || payload.tracking_number
      || payload.tracking_code
      || (payload.data && (payload.data.tracking_code || payload.data.tracking_number))
      || null;

    // Webhook inbox: record the event once, keyed by EasyPost's own event
    // id. A replayed or duplicate delivery is recognised and skipped.
    const eventId = payload.id ? String(payload.id) : null;
    if (eventId) {
      try {
        await lib.sbInsert('provider_events', {
          provider: 'easypost', event_key: eventId, object_ref: trackingNumber || result.id || null, payload,
        }, false);
      } catch (inboxErr) {
        if (/409|23505|duplicate/i.test(inboxErr.message)) {
          return lib.json(200, { received: true, duplicate: true });
        }
        await lib.logAlert('shipping_webhook', 'Could not record event in the inbox (processing anyway)', { eventId, error: inboxErr.message });
      }
    }

    if (!trackingNumber) {
      if (!/^tracker\.|^shipment\./.test(eventType)) {
        return lib.json(200, { received: true, ignored: eventType || 'unknown event' });
      }
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
    //
    // BUG FIXED HERE: this used to dedupe on an exact match of
    // (status, occurred_at). When a carrier response has no timestamp —
    // which happens — the code fell back to `new Date().toISOString()`,
    // generating a brand-new value on every single call. That meant the
    // dedup match NEVER fired for any event missing a carrier timestamp:
    // every webhook retry (providers explicitly deliver "at least once",
    // so retries are expected, not rare) would insert a fresh duplicate
    // row. A tracking timeline padded with near-identical duplicate scans
    // at slightly different timestamps is exactly what tampering would
    // look like — the opposite of what an append-only chain of custody is
    // supposed to guarantee in a dispute.
    //
    // Fixed by deduping on (status, location, description) instead, which
    // does not depend on a timestamp existing or being stable across calls.
    // A genuine repeat delivery of the same scan has identical status,
    // location and description. A genuinely new scan — the package moving
    // to a new facility under the same status — will differ in location or
    // description and is correctly kept as a new row.
    const occurredAt = verified.occurredAt || new Date().toISOString();
    const eventLocation = verified.location || null;
    const eventDescription = verified.description || null;

    let dedupeFilter =
      'shipment_events?shipment_id=eq.' + encodeURIComponent(shipment.id) +
      '&status=eq.' + encodeURIComponent(newStatus);
    dedupeFilter += eventLocation
      ? '&location=eq.' + encodeURIComponent(eventLocation)
      : '&location=is.null';
    dedupeFilter += eventDescription
      ? '&description=eq.' + encodeURIComponent(eventDescription)
      : '&description=is.null';
    dedupeFilter += '&select=id';

    const existingEvents = await lib.sbSelect(dedupeFilter);

    if (!existingEvents || !existingEvents.length) {
      await lib.sbInsert('shipment_events', {
        shipment_id: shipment.id,
        status: newStatus,
        description: eventDescription,
        location: eventLocation,
        occurred_at: occurredAt,
        raw: verified.raw || null,
      });
    }

    // --- Advance the shipment ------------------------------------------
    // Never move backwards. Carriers do re-send older scans out of order,
    // and a "delivered" shipment must not revert to "in transit".
    const patch = {};
    const advanced = nextShipmentStatus(shipment.status, newStatus);
    if (advanced) patch.status = advanced;

    if (['in_transit', 'out_for_delivery', 'delivered'].includes(newStatus) && !shipment.first_scan_at) {
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

    if (eventId) {
      await lib.sbPatch('provider_events', 'provider=eq.easypost&event_key=eq.' + encodeURIComponent(eventId),
        { processed_at: new Date().toISOString() }).catch(() => {});
    }
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
      // The list endpoint returns { trackers: [...] }. An empty list means
      // "no tracker yet", not "this list is the tracker".
      const tracker = Array.isArray(data.trackers)
        ? data.trackers[0]
        : (data && data.object === 'Tracker' ? data : null);
      if (!tracker || !tracker.status) return null;
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

    // Shippo support was removed on 2026-09-24: EasyPost is the only
    // configured provider and the Shippo key was deleted from production.
    return null;
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
    'transactions?id=eq.' + encodeURIComponent(shipment.transaction_id) + '&select=id,status,buyer_id,seller_id,escrow_transaction_id,escrow_item_id'
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
    // This bucket now also covers AVAILABLE_FOR_PICKUP (see
    // normaliseTrackingStatus in _shipping-lib.js), which is a materially
    // different situation for the buyer: nothing is arriving at their door
    // today, a package is waiting for THEM to go get it at a carrier
    // location. Using the home-delivery wording there would have told a
    // "hold at location" buyer to expect a delivery that was never coming.
    if (shipment.hold_at_location) {
      notifyTitle = 'Your package is ready for pickup';
      notifyBody = 'Your held package has arrived and is ready for pickup at the carrier location. Bring ID matching the name on the shipment. Remember: film one continuous video as you open the sealed box.';
    } else {
      notifyTitle = 'Out for delivery today';
      notifyBody = 'Your package is out for delivery. Remember: film one continuous video as you open the sealed box.';
    }
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

  // Keep Escrow.com's own record in step with the carrier. Outbound only:
  // a return shipment moves money the other way and is settled by staff.
  if (shipment.direction === 'outbound' && txn.escrow_transaction_id && txn.escrow_item_id &&
      ['in_transit', 'out_for_delivery', 'delivered'].includes(newStatus)) {
    await advanceEscrow(shipment, txn, newStatus);
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

// Marks the Escrow.com item shipped on the first carrier scan and received on
// delivery. Each step is skipped if Escrow.com already shows it done, so a
// repeated or out-of-order webhook is harmless. Failures never throw: they
// raise a system alert, and the delivery still records on Bastion's side.
async function advanceEscrow(shipment, txn, newStatus) {
  try {
    const sellerEmail = await escrow.lookupUserEmail(txn.seller_id);
    const shipped = await escrow.markShipped({
      escrowTransactionId: txn.escrow_transaction_id,
      primaryItemId: txn.escrow_item_id,
      sellerEmail,
      trackingInfo: { carrier: shipment.carrier, tracking_id: shipment.tracking_number },
    });
    if (!shipped.ok) {
      await lib.logAlert('escrow_lifecycle', 'Could not mark the item shipped on Escrow.com', {
        transactionId: txn.id, error: shipped.primaryError,
      });
      return;
    }
    if (newStatus !== 'delivered') return;

    const buyerEmail = await escrow.lookupUserEmail(txn.buyer_id);
    const received = await escrow.markReceived({
      escrowTransactionId: txn.escrow_transaction_id,
      primaryItemId: txn.escrow_item_id,
      buyerEmail,
    });
    if (!received.ok) {
      await lib.logAlert('escrow_lifecycle',
        'Could not mark the item received on Escrow.com; the inspection clock has NOT started, so the automatic payout cannot fire until this is fixed', {
          transactionId: txn.id, error: received.primaryError,
        });
    }
  } catch (e) {
    await lib.logAlert('escrow_lifecycle', 'Unexpected error advancing Escrow.com state', { transactionId: txn.id, error: e.message });
  }
}

module.exports.nextShipmentStatus = nextShipmentStatus;
module.exports.isAuthentic = isAuthentic;
