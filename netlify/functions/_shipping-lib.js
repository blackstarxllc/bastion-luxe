// netlify/functions/_shipping-lib.js
//
// Shared plumbing for every shipping function. Kept in one place so the
// carrier provider, the tier rules, and the auth checks can never drift
// apart between endpoints.
//
// PROVIDER ABSTRACTION
// --------------------
// Bastion talks to exactly one shipping provider at a time, chosen by the
// SHIPPING_PROVIDER env var. Today that's Shippo or EasyPost. Both expose
// the same three things we need — rates, labels, tracking webhooks — so the
// rest of the codebase never needs to know which one is behind it. Adding a
// third provider later means adding a case here, not touching any page.

// The default here used to be 'shippo'. That was a live landmine: the only
// Shippo credential in production is a TEST key, so if SHIPPING_PROVIDER were
// ever unset, deleted, or dropped by a bad deploy, the code would silently
// fall back to Shippo, read a test key, and hand sellers test labels that no
// carrier accepts — while SHIPPING_TEST_MODE=false made every guard believe
// it was live. Defaulting to the provider that is actually configured for
// production removes that failure mode entirely.
const PROVIDER = (process.env.SHIPPING_PROVIDER || 'easypost').toLowerCase();
const SHIPPING_TEST_MODE = process.env.SHIPPING_TEST_MODE === 'true';

// ---------------------------------------------------------------
// GO-LIVE SAFETY: catch a key/mode mismatch before it costs money.
//
// Two failure modes, both silent and both expensive:
//
//   LIVE key + test mode ON  -> Shippo returns TEST labels. They look
//     real, they download as a PDF, and a carrier will not accept them.
//     A seller ships nothing, the ship-by clock runs out, and the buyer
//     cancels. Worst case this happens on every order until someone
//     notices the labels were never scannable.
//
//   TEST key + test mode OFF -> label purchase fails outright, so no
//     seller can ship at all.
//
// Shippo test keys are prefixed `shippo_test_` and live keys
// `shippo_live_`, so the mismatch is detectable. This does not block
// anything — it writes a loud console error and is surfaced through
// shippingConfigWarning() so the calling function can alert on it.
// ---------------------------------------------------------------
function shippingConfigWarning() {
  if (PROVIDER !== 'shippo' && PROVIDER !== 'easypost') {
    return 'SHIPPING_PROVIDER is set to "' + PROVIDER + '", which is not a provider this code supports. Use "easypost" or "shippo".';
  }

  // Check the key belonging to the ACTIVE provider only. Reading whichever
  // key happened to be set meant a leftover Shippo test key could be
  // inspected while EasyPost was the live provider.
  const activeKey = PROVIDER === 'easypost'
    ? (process.env.EASYPOST_API_KEY || '')
    : (process.env.SHIPPO_API_KEY || '');
  if (!activeKey) {
    return 'SHIPPING_PROVIDER is "' + PROVIDER + '" but its API key is not set. No shipping quote or label can be produced.';
  }

  if (PROVIDER === 'shippo') {
    const key = activeKey;
    const looksTest = key.startsWith('shippo_test_');
    const looksLive = key.startsWith('shippo_live_');
    if (looksLive && SHIPPING_TEST_MODE) {
      return 'LIVE Shippo key is set but SHIPPING_TEST_MODE is still true — labels will be TEST labels that carriers will not accept. Set SHIPPING_TEST_MODE=false.';
    }
    if (looksTest && !SHIPPING_TEST_MODE) {
      return 'TEST Shippo key is set but SHIPPING_TEST_MODE is false — label purchases will fail. Set SHIPPING_TEST_MODE=true, or install the live key.';
    }
  }

  // EasyPost has the identical trap, with its own prefixes:
  //   EZTK... = test key      EZAK... = production key
  // The guard previously only understood Shippo prefixes, so on EasyPost
  // it would never fire at all — silently leaving the most expensive
  // misconfiguration undetected.
  if (PROVIDER === 'easypost') {
    const epKey = activeKey;
    const looksTest = epKey.startsWith('EZTK');
    const looksLive = epKey.startsWith('EZAK');
    if (looksLive && SHIPPING_TEST_MODE) {
      return 'PRODUCTION EasyPost key is set but SHIPPING_TEST_MODE is still true. Set SHIPPING_TEST_MODE=false.';
    }
    if (looksTest && !SHIPPING_TEST_MODE) {
      return 'TEST EasyPost key is set but SHIPPING_TEST_MODE is false — label purchases will fail. Set SHIPPING_TEST_MODE=true, or install the production key.';
    }
  }
  return null;
}

// Surface it immediately on cold start as well, so it shows in function
// logs even if nothing calls the checker.
(function () {
  const w = shippingConfigWarning();
  if (w) console.error('[shipping-config] ' + w);
})();

// ---------------------------------------------------------------
// Protection tiers.
//
// These mirror public.shipping_tier_for_value() in Postgres. They are
// duplicated deliberately: the database enforces them for anything written
// directly, and the function enforces them before money or a label moves.
// If you change one, change both.
// ---------------------------------------------------------------
function tierForValue(value) {
  const v = Number(value) || 0;
  if (v >= 10000) return 'vault';
  if (v >= 1000) return 'protected';
  return 'standard';
}

// ---------------------------------------------------------------
// RETAIL RATE PRESENTATION
//
// Shippo and EasyPost return heavily discounted commercial rates (their
// negotiated volume pricing, often far below what the same service costs
// at a retail counter). Bastion charges the buyer the standard retail
// rate for that service and keeps the spread as platform revenue.
//
// This is an ordinary marketplace practice — it is how essentially every
// platform that resells postage operates. What matters legally is that
// the customer-facing copy describes it accurately. The Shipping page and
// FAQ say shipping is "priced at standard carrier retail rates", NOT that
// Bastion passes through its own cost, because the latter would be a
// false statement of fact to a consumer.
//
// HOW THE ESTIMATE WORKS
// Neither provider reliably returns "the retail price of this same
// service" alongside the discounted one. Where a provider does supply a
// retail figure we use it directly. Where it doesn't, we apply a
// per-service multiplier calibrated to published USPS/UPS retail pricing.
// The multiplier is a floor-and-cap estimate, deliberately conservative:
// it should never quote the buyer MORE than a real post office counter
// would charge for the same service, because that is the one outcome that
// makes the "standard retail rates" description untrue.
// ---------------------------------------------------------------
const RETAIL_MULTIPLIERS = {
  // Ground/economy services carry the widest commercial discounts.
  ground: 1.45,
  priority: 1.35,
  express: 1.25,
  default: 1.35,
};

// Never quote above this multiple of the commercial rate, regardless of
// service matching — a runaway multiplier would overcharge the buyer past
// genuine retail, which is exactly what we must not do.
const RETAIL_MAX_MULTIPLIER = 1.6;

function serviceBand(serviceName) {
  const n = String(serviceName || '').toLowerCase();
  if (/express|overnight|next.?day|priority mail express/.test(n)) return 'express';
  if (/priority|2.?day|second.?day|air/.test(n)) return 'priority';
  if (/ground|surepost|smartpost|parcel select|media mail|home delivery/.test(n)) return 'ground';
  return 'default';
}

// Returns { retail, commercial, margin } — commercial is what Bastion is
// billed by the carrier, retail is what the buyer is charged.
function toRetailRate(rate) {
  const commercial = Number(rate.amount) || 0;
  if (commercial <= 0) return { retail: 0, commercial: 0, margin: 0 };

  // Prefer a real retail figure when the provider gives us one.
  const providerRetail = Number(rate.retailAmount) || 0;
  let retail;
  if (providerRetail > commercial) {
    retail = providerRetail;
  } else {
    const mult = RETAIL_MULTIPLIERS[serviceBand(rate.service)] || RETAIL_MULTIPLIERS.default;
    retail = commercial * Math.min(mult, RETAIL_MAX_MULTIPLIER);
  }

  // Round to a normal-looking price rather than an odd computed figure.
  retail = Math.round(retail * 100) / 100;

  return {
    retail,
    commercial,
    margin: Math.round((retail - commercial) * 100) / 100,
  };
}

function tierRules(tier) {
  switch (tier) {
    case 'vault':
      return {
        label: 'Vault',
        signatureRequired: true,
        adultSignatureRequired: true,
        packingVideoRequired: true,
        doubleBoxRequired: true,
        allowPoBox: false,
        allowHoldAtLocation: true,
        shipByHours: 48,
        inspectionSeconds: 432000, // 5 days
        minCarrierService: 'express',
      };
    case 'protected':
      return {
        label: 'Protected',
        signatureRequired: true,
        adultSignatureRequired: true,
        packingVideoRequired: true,
        doubleBoxRequired: true,
        allowPoBox: false,
        allowHoldAtLocation: true,
        shipByHours: 48,
        inspectionSeconds: 259200, // 3 days
        minCarrierService: 'standard',
      };
    default:
      return {
        label: 'Standard',
        signatureRequired: true,
        adultSignatureRequired: false,
        packingVideoRequired: false,
        doubleBoxRequired: false,
        allowPoBox: false,
        allowHoldAtLocation: false,
        shipByHours: 72,
        inspectionSeconds: 172800, // 2 days
        minCarrierService: 'standard',
      };
  }
}

// ---------------------------------------------------------------
// Destination screening.
//
// PO boxes, general delivery and freight forwarders are where high-value
// parcels go to disappear with no recoverable recipient. Blocked on every
// tier, not just the expensive ones.
// ---------------------------------------------------------------
const BLOCKED_ADDRESS_PATTERNS = [
  /\bp\.?\s*o\.?\s*box\b/i,
  /\bpost\s*office\s*box\b/i,
  /\bpostal\s*box\b/i,
  /\bgeneral\s*delivery\b/i,
  /\bposte\s*restante\b/i,
];

function screenDestination(addr) {
  const haystack = [addr.line1, addr.line2].filter(Boolean).join(' ');
  for (const pattern of BLOCKED_ADDRESS_PATTERNS) {
    if (pattern.test(haystack)) {
      return {
        ok: false,
        reason:
          'Bastion cannot ship to PO boxes or general delivery. Protected shipments must go to a street address where someone can sign for them, or to a carrier pickup location.',
      };
    }
  }
  if (!addr.line1 || !addr.city || !addr.state || !addr.postal_code) {
    return { ok: false, reason: 'That address is missing a required field.' };
  }
  if ((addr.country || 'US').toUpperCase() !== 'US') {
    return {
      ok: false,
      reason:
        'Bastion currently ships within the United States only. International shipping is coming later.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------
// Supabase helpers (service role — server only, never the browser)
// ---------------------------------------------------------------
function supabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase environment variables are not configured');
  return { url, key };
}

function serviceHeaders(key) {
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
}

async function sbSelect(path) {
  const { url, key } = supabaseEnv();
  const res = await fetch(url + '/rest/v1/' + path, { headers: serviceHeaders(key) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('Supabase read failed (' + res.status + '): ' + detail.slice(0, 300));
  }
  return res.json();
}

async function sbInsert(table, body, returning) {
  const { url, key } = supabaseEnv();
  const res = await fetch(url + '/rest/v1/' + table, {
    method: 'POST',
    headers: Object.assign({}, serviceHeaders(key), {
      Prefer: returning ? 'return=representation' : 'return=minimal',
    }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('Supabase insert failed (' + res.status + '): ' + detail.slice(0, 300));
  }
  return returning ? res.json() : null;
}

async function sbPatch(table, filter, body, returning) {
  const { url, key } = supabaseEnv();
  const res = await fetch(url + '/rest/v1/' + table + '?' + filter, {
    method: 'PATCH',
    headers: Object.assign({}, serviceHeaders(key), {
      Prefer: returning ? 'return=representation' : 'return=minimal',
    }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('Supabase update failed (' + res.status + '): ' + detail.slice(0, 300));
  }
  return returning ? res.json() : null;
}

// Verify the caller's Supabase session and return their real user id.
// Every state-changing endpoint runs this first. There is no path that
// trusts a user id sent in the request body.
async function requireUser(event) {
  const raw = event.headers.authorization || event.headers.Authorization;
  if (!raw || !raw.startsWith('Bearer ')) {
    const err = new Error('You need to be signed in to do that.');
    err.statusCode = 401;
    throw err;
  }
  const { url, key } = supabaseEnv();
  const res = await fetch(url + '/auth/v1/user', {
    headers: { apikey: key, Authorization: raw },
  });
  if (!res.ok) {
    const err = new Error('Your session has expired. Please sign in again.');
    err.statusCode = 401;
    throw err;
  }
  const user = await res.json();
  if (!user || !user.id) {
    const err = new Error('Your session has expired. Please sign in again.');
    err.statusCode = 401;
    throw err;
  }
  return user;
}

async function logAlert(source, message, context) {
  console.error('[' + source + ']', message, context || {});
  try {
    const { url, key } = supabaseEnv();
    await fetch(url + '/rest/v1/system_alerts', {
      method: 'POST',
      headers: Object.assign({}, serviceHeaders(key), { Prefer: 'return=minimal' }),
      body: JSON.stringify({ source, message, context: context || {} }),
    });
  } catch (e) {
    console.error('could not write system_alerts:', e.message);
  }
}

// ---------------------------------------------------------------
// Provider: rate quoting
// ---------------------------------------------------------------
function providerAuthHeader() {
  if (PROVIDER === 'easypost') {
    const key = process.env.EASYPOST_API_KEY;
    if (!key) throw new Error('EASYPOST_API_KEY is not configured');
    return 'Basic ' + Buffer.from(key + ':').toString('base64');
  }
  const key = process.env.SHIPPO_API_KEY;
  if (!key) throw new Error('SHIPPO_API_KEY is not configured');
  return 'ShippoToken ' + key;
}

// The label's sender identity.
//
// IMPORTANT — this is per-seller, not one fixed business address.
//
// Every seller on Bastion ships from their own real location. Using one
// global address for every label (an earlier version of this function did
// exactly that) produces an invalid parcel: a carrier requires the street/
// city/state/ZIP to actually match a real place, and Bastion's registered
// business address is a registered-agent address that no parcel is ever
// physically dropped off at. Pairing that street with a seller's real ZIP
// creates a combination that doesn't exist, which carriers reject or
// mis-rate.
//
// So the PHYSICAL address (street/city/state/zip) always comes from the
// seller's own real address, stored privately per listing. The only thing
// Bastion overrides is the NAME on the label — "B.M. LLC" instead of the
// seller's real name — which is what actually protects their privacy
// without breaking the label. Phone/email fall back to Bastion's own
// business contact only if the seller didn't provide one, so a label is
// never missing a required field.
function senderIdentity(sellerAddress) {
  const addr = sellerAddress || {};
  return {
    name: process.env.SHIP_FROM_NAME || 'B.M. LLC',
    street1: addr.street1 || '',
    street2: addr.street2 || '',
    city: addr.city || '',
    state: addr.state || '',
    zip: addr.zip || '',
    country: 'US',
    phone: addr.phone || process.env.SHIP_FROM_PHONE || '',
    email: addr.email || process.env.SHIP_FROM_EMAIL || '',
  };
}

async function fetchRates({ from, to, parcel, declaredValue, tier }) {
  const rules = tierRules(tier);

  if (PROVIDER === 'easypost') {
    const res = await fetch('https://api.easypost.com/v2/shipments', {
      method: 'POST',
      headers: { Authorization: providerAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shipment: {
          to_address: {
            name: to.name, street1: to.line1, street2: to.line2 || '',
            city: to.city, state: to.state, zip: to.postal_code,
            country: to.country || 'US', phone: to.phone || '',
          },
          from_address: {
            name: from.name, street1: from.street1, city: from.city,
            state: from.state, zip: from.zip, country: 'US', phone: from.phone,
          },
          parcel: {
            length: parcel.length, width: parcel.width,
            height: parcel.height, weight: parcel.weight_oz,
          },
          options: {
            delivery_confirmation: rules.adultSignatureRequired
              ? 'ADULT_SIGNATURE'
              : 'SIGNATURE',
          },
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error('Rate lookup failed: ' + (data.error && data.error.message ? data.error.message : res.status));
    }
    return {
      providerShipmentId: data.id,
      rates: (data.rates || []).map((r) => ({
        id: r.id,
        carrier: r.carrier,
        service: r.service,
        amount: Number(r.rate),
        retailAmount: Number(r.retail_rate) || 0,
        days: r.delivery_days,
      })),
    };
  }

  // Shippo
  const res = await fetch('https://api.goshippo.com/shipments/', {
    method: 'POST',
    headers: { Authorization: providerAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address_from: {
        name: from.name, street1: from.street1, city: from.city,
        state: from.state, zip: from.zip, country: 'US', phone: from.phone,
      },
      address_to: {
        name: to.name, street1: to.line1, street2: to.line2 || '',
        city: to.city, state: to.state, zip: to.postal_code,
        country: to.country || 'US', phone: to.phone || '',
      },
      parcels: [{
        length: String(parcel.length), width: String(parcel.width),
        height: String(parcel.height), distance_unit: 'in',
        weight: String(parcel.weight_oz), mass_unit: 'oz',
      }],
      extra: {
        signature_confirmation: rules.adultSignatureRequired ? 'ADULT' : 'STANDARD',
        // UNVERIFIED FIELD NAME — this Shippo-specific code path is not
        // currently active (SHIPPING_PROVIDER=easypost in production) and
        // goshippo.com's own docs aren't reachable from this environment to
        // confirm the exact key Shippo expects for a bare declared value
        // with no insurance product attached. Verify against Shippo's live
        // API docs before ever switching SHIPPING_PROVIDER to 'shippo' —
        // do not assume this key is correct just because it's present.
        optional_declared_value: declaredValue ? String(declaredValue) : undefined,
      },
      async: false,
      test: SHIPPING_TEST_MODE,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Rate lookup failed: ' + (data.detail || JSON.stringify(data).slice(0, 200)));
  }
  return {
    providerShipmentId: data.object_id,
    rates: (data.rates || []).map((r) => ({
      id: r.object_id,
      carrier: r.provider,
      service: r.servicelevel && r.servicelevel.name,
      amount: Number(r.amount),
      // Shippo exposes the undiscounted figure here on carriers that
      // support it. When present it's a real retail price and beats any
      // multiplier estimate.
      retailAmount: Number(r.amount_local) > Number(r.amount) ? Number(r.amount_local) : 0,
      days: r.estimated_days,
    })),
  };
}

async function buyLabel(rateId) {
  if (PROVIDER === 'easypost') {
    const parts = String(rateId).split('|');
    const shipmentId = parts[0];
    const realRateId = parts[1] || parts[0];
    const res = await fetch('https://api.easypost.com/v2/shipments/' + shipmentId + '/buy', {
      method: 'POST',
      headers: { Authorization: providerAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rate: { id: realRateId } }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error('Label purchase failed: ' + (data.error && data.error.message ? data.error.message : res.status));
    }
    return {
      trackingNumber: data.tracking_code,
      labelUrl: data.postage_label && data.postage_label.label_url,
      carrier: data.selected_rate && data.selected_rate.carrier,
      service: data.selected_rate && data.selected_rate.service,
      cost: data.selected_rate ? Number(data.selected_rate.rate) : null,
      providerShipmentId: data.id,
    };
  }

  const res = await fetch('https://api.goshippo.com/transactions/', {
    method: 'POST',
    headers: { Authorization: providerAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rate: rateId,
      label_file_type: 'PDF_4x6',
      async: false,
      test: SHIPPING_TEST_MODE,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.status === 'ERROR') {
    const msg = (data.messages && data.messages[0] && data.messages[0].text) || data.detail || res.status;
    throw new Error('Label purchase failed: ' + msg);
  }
  return {
    trackingNumber: data.tracking_number,
    labelUrl: data.label_url,
    carrier: data.rate && data.rate.provider,
    service: data.rate && data.rate.servicelevel && data.rate.servicelevel.name,
    cost: data.rate ? Number(data.rate.amount) : null,
    providerShipmentId: data.object_id,
  };
}

// Normalise the many carrier vocabularies into Bastion's own five states.
function normaliseTrackingStatus(raw) {
  const s = String(raw || '').toUpperCase();
  if (['DELIVERED'].includes(s)) return 'delivered';
  // AVAILABLE_FOR_PICKUP was missing entirely, which mattered specifically
  // because "hold at location" is a named, promoted feature on Protected
  // and Vault tiers — a buyer using it would carrier-scan into this exact
  // status and then simply never be told their package was ready, because
  // the old code fell through to `return null` and did nothing at all.
  if (['OUT_FOR_DELIVERY', 'OUT FOR DELIVERY', 'AVAILABLE_FOR_PICKUP', 'AVAILABLE FOR PICKUP'].includes(s)) return 'out_for_delivery';
  if (['TRANSIT', 'IN_TRANSIT', 'PRE_TRANSIT'].includes(s)) return 'in_transit';
  if (['RETURNED', 'RETURN_TO_SENDER'].includes(s)) return 'returned';
  // CANCELLED was also missing. A carrier cancelling a label is at least as
  // serious as a delivery exception — it needs a human to look at it, not
  // silence.
  if (['FAILURE', 'ERROR', 'EXCEPTION', 'UNKNOWN', 'CANCELLED', 'CANCELED'].includes(s)) return 'exception';
  return null;
}


// ------------------------------------------------------------------
// SIGNED SHIPPING QUOTES
//
// Before 2026-09-24 the buyer's browser told the server what shipping cost.
// The checkout page quoted a real rate, but then sent that number back as a
// plain field on the order, and create-shipment stored whatever it was
// given. A buyer could edit the request, pay $0 shipping, pick overnight
// service, and Bastion's EasyPost account would pay for the label.
//
// Now every rate the quote function returns carries a quoteToken: the exact
// buyer, listing, destination ZIP, carrier, service and price, signed with a
// server-only secret and valid for 45 minutes. create-shipment accepts ONLY
// a valid token, and writes the order's shipping charge from the token
// itself. A tampered token fails the signature check; an expired one asks
// the buyer to re-quote. The browser can choose a rate, never set a price.
// ------------------------------------------------------------------
const crypto = require('crypto');
const QUOTE_TTL_MS = 45 * 60 * 1000;

function quoteSecret() {
  const s = process.env.QUOTE_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error('No quote signing secret is configured.');
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function normalisePostal(zip) {
  return String(zip || '').trim().slice(0, 5);
}

function signQuote(payload) {
  const body = b64url(JSON.stringify(Object.assign({}, payload, { exp: Date.now() + QUOTE_TTL_MS })));
  const sig = b64url(crypto.createHmac('sha256', quoteSecret()).update(body).digest());
  return body + '.' + sig;
}

// Returns the payload, or null if the token is malformed, forged or expired.
function verifyQuote(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 1) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', quoteSecret()).update(body).digest());
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

module.exports = {
  PROVIDER,
  SHIPPING_TEST_MODE,
  shippingConfigWarning,
  toRetailRate,
  serviceBand,
  tierForValue,
  tierRules,
  screenDestination,
  supabaseEnv,
  serviceHeaders,
  sbSelect,
  sbInsert,
  sbPatch,
  requireUser,
  logAlert,
  senderIdentity,
  fetchRates,
  buyLabel,
  normaliseTrackingStatus,
  json,
  signQuote,
  verifyQuote,
  normalisePostal,
};
