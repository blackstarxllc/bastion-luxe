// netlify/functions/_shipping-lib.js
//
// Shared plumbing for every shipping function. Kept in one place so the
// carrier provider, the tier rules, and the auth checks can never drift
// apart between endpoints.
//
// PROVIDER
// --------
// EasyPost is the only shipping provider. (A Shippo adapter existed until
// 2026-09-24; its key had already been removed from production, so it was
// unreachable code and was deleted.)
const crypto = require('crypto');
const PROVIDER = (process.env.SHIPPING_PROVIDER || 'easypost').toLowerCase();
const SHIPPING_TEST_MODE = process.env.SHIPPING_TEST_MODE === 'true';

// GO-LIVE SAFETY: a production key with test mode on, or a test key with
// test mode off, both fail silently and expensively (unscannable labels, or
// no labels at all). EasyPost keys are prefixed EZAK (production) and EZTK
// (test), so the mismatch is detectable and is reported by
// shippingConfigWarning() for the calling function to alert on.
function shippingConfigWarning() {
  if (PROVIDER !== 'easypost') {
    return 'SHIPPING_PROVIDER is "' + PROVIDER + '". EasyPost is the only supported provider (Shippo support was removed on 2026-09-24).';
  }
  const epKey = process.env.EASYPOST_API_KEY || '';
  if (!epKey) return 'EASYPOST_API_KEY is not set. No shipping quote or label can be produced.';
  const looksTest = epKey.startsWith('EZTK');
  const looksLive = epKey.startsWith('EZAK');
  if (looksLive && SHIPPING_TEST_MODE) {
    return 'PRODUCTION EasyPost key is set but SHIPPING_TEST_MODE is still true. Set SHIPPING_TEST_MODE=false.';
  }
  if (looksTest && !SHIPPING_TEST_MODE) {
    return 'TEST EasyPost key is set but SHIPPING_TEST_MODE is false; label purchases will fail. Set SHIPPING_TEST_MODE=true, or install the production key.';
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
// EasyPost returns heavily discounted commercial rates (its
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

// ------------------------------------------------------------------
// SERVICE SPEED — explicit rules, not loose word matching.
//
// The old check treated any service containing "priority" as express, so
// USPS Priority Mail (2-3 days) counted as express for Vault shipments,
// while UPS "2ndDayAir" did NOT match its /2.?day/ pattern at all. Names are
// normalised (lowercase, letters and digits only) and classified by what
// the service actually promises:
//   express : overnight / next day / 1-2 day guaranteed (Priority Mail
//             Express, NextDayAir*, *_OVERNIGHT, 2ndDayAir*, FEDEX_2_DAY*)
//   priority: 3-day and USPS Priority Mail
//   ground  : ground / economy
// ------------------------------------------------------------------
function normService(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function serviceBand(serviceName) {
  const n = normService(serviceName);
  if (!n) return 'default';
  if (/overnight|nextday|expressmail|prioritymailexpress|^express$|usps?express|2ndday|2day|secondday/.test(n) && !/expresssaver|3day/.test(n)) return 'express';
  if (/3day|expresssaver|^priority$|prioritymail|fedexexpresssaver/.test(n)) return 'priority';
  if (/ground|surepost|smartpost|parcelselect|mediamail|homedelivery|economy|groundadvantage/.test(n)) return 'ground';
  return 'default';
}

function isExpressService(serviceName) {
  return serviceBand(serviceName) === 'express';
}

// Items worth more than this are not shipped through the automated flow.
// Declared value is not insurance, and Bastion does not insure shipments, so
// past this point a carrier loss would fall on a buyer or seller with no
// recourse. Above the limit a listing sells for in-person handoff, or
// support arranges concierge logistics. Set SHIPPING_MAX_ITEM_VALUE in
// Netlify to change it; 0 disables automated shipping entirely.
// SHIPPING_MAX_ITEM_VALUE semantics (Audit #4 P1-1: the old comment said
// "0 disables automated shipping", but 0 actually disabled the CEILING):
//   unset / empty -> $50,000 default
//   0             -> automated shipping OFF for every item
//   positive      -> hard maximum item value
//   negative / not a number -> fail CLOSED (treated as 0: nothing ships)
function maxShippableValue() {
  const raw = process.env.SHIPPING_MAX_ITEM_VALUE;
  if (raw === undefined || raw === '') return 50000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
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
  const key = process.env.EASYPOST_API_KEY;
  if (!key) throw new Error('EASYPOST_API_KEY is not configured');
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}
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
          name: from.name, street1: from.street1, street2: from.street2 || '', city: from.city,
          state: from.state, zip: from.zip, country: 'US', phone: from.phone,
        },
        parcel: {
          length: parcel.length, width: parcel.width,
          height: parcel.height, weight: parcel.weight_oz,
        },
        options: {
          delivery_confirmation: rules.adultSignatureRequired ? 'ADULT_SIGNATURE' : 'SIGNATURE',
        },
        carrier_accounts: carrierAccountIds().length ? carrierAccountIds() : undefined,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Rate lookup failed: ' + (data.error && data.error.message ? data.error.message : res.status));
  }
  return {
    providerShipmentId: data.id,
    rates: (data.rates || []).filter((r) => carrierAllowed(r.carrier)).map((r) => ({
      id: r.id,
      carrier: r.carrier,
      service: r.service,
      amount: Number(r.rate),
      retailAmount: Number(r.retail_rate) || 0,
      days: r.delivery_days,
    })),
  };
}

// Buys the label for "shipmentId|rateId". Errors carry `definitive`:
//   true  -> EasyPost answered with a 4xx; nothing was bought. Safe to retry.
//   false -> network failure, timeout or 5xx; a label MAY have been bought.
//            The caller must treat the outcome as unknown and reconcile,
//            never simply try again (that is how a second real label gets
//            paid for).
// Looks up an EasyPost shipment and, if a label was already purchased on it,
// returns it in buyLabel()'s shape. Used to ADOPT a label whose purchase
// response was lost, instead of paying for a second one. Returns null when
// no label exists yet. Throws only when EasyPost cannot be reached, because
// "unknown" must never be treated as "not bought".
async function fetchPurchasedLabel(providerShipmentId) {
  const res = await fetch('https://api.easypost.com/v2/shipments/' + encodeURIComponent(providerShipmentId), {
    headers: { Authorization: providerAuthHeader() },
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Could not look up EasyPost shipment (' + res.status + ')');
  if (!data.tracking_code || !data.postage_label || !data.postage_label.label_url) return null;
  return {
    trackingNumber: data.tracking_code,
    labelUrl: data.postage_label.label_url,
    carrier: data.selected_rate && data.selected_rate.carrier,
    service: data.selected_rate && data.selected_rate.service,
    cost: data.selected_rate ? Number(data.selected_rate.rate) : null,
    providerShipmentId: data.id,
  };
}

async function buyLabel(rateToken) {
  const parts = String(rateToken).split('|');
  const shipmentId = parts[0];
  const realRateId = parts[1] || parts[0];
  let res;
  try {
    res = await fetch('https://api.easypost.com/v2/shipments/' + encodeURIComponent(shipmentId) + '/buy', {
      method: 'POST',
      headers: { Authorization: providerAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rate: { id: realRateId } }),
    });
  } catch (netErr) {
    const e = new Error('Label purchase: no response from EasyPost (' + netErr.message + ')');
    e.definitive = false;
    e.providerShipmentId = shipmentId;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error('Label purchase failed: ' + (data.error && data.error.message ? data.error.message : res.status));
    e.definitive = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    e.providerShipmentId = shipmentId;
    throw e;
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
// CARRIER ALLOWLIST
// The EasyPost account has seven carriers linked, including DHL Express,
// DHL eCommerce, Canada Post and Asendia (international / economy
// services). Rating used all of them, so a buyer could be offered, and pick,
// a service that cannot carry the signature requirement the tier demands.
// Bastion ships domestically with USPS, UPS and FedEx only. The account ids
// can be pinned with EASYPOST_CARRIER_ACCOUNTS (comma-separated ca_ ids);
// otherwise rates from any other carrier are discarded.
// ------------------------------------------------------------------
const ALLOWED_CARRIER = /^(usps|ups|upsdap|fedex|fedexdefault)$/i;
function carrierAllowed(carrier) {
  return ALLOWED_CARRIER.test(String(carrier || '').replace(/\s+/g, ''));
}
function carrierAccountIds() {
  return String(process.env.EASYPOST_CARRIER_ACCOUNTS || '')
    .split(',').map((s) => s.trim()).filter((s) => /^ca_[a-z0-9]+$/i.test(s));
}

// Vault items must travel on a genuinely express service. This filters by
// the explicit serviceBand() classifier and FAILS CLOSED: if nothing
// qualifies, the result is empty. The old filter matched the word
// "priority" (so USPS Priority passed as express) and, when nothing
// matched, silently fell back to every rate.
function filterForTier(rates, rules) {
  const usable = (rates || []).filter((r) => r.amount > 0 && carrierAllowed(r.carrier));
  if (rules && rules.minCarrierService === 'express') {
    return usable.filter((r) => isExpressService(r.service));
  }
  return usable;
}

// A quote is bound to the EXACT destination, not just its ZIP. Two
// addresses on the same ZIP can rate differently (residential surcharges,
// delivery areas), and the label must go where the buyer was quoted.
function addressFingerprint(a) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = [a.line1 || a.street1, a.line2 || a.street2, a.city, a.state,
                 String(a.postal_code || a.zip || '').slice(0, 5), a.country || 'US'].map(norm);
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

// HIGH-VALUE CEILING
// maxShippableValue() (SHIPPING_MAX_ITEM_VALUE, default $50,000) existed
// before 2026-09-24 but nothing called it: it looked like a limit and
// enforced none. Bastion does not insure shipments, and carrier
// declared-value limits sit around $50,000 even where coverage is bought,
// so above the ceiling items are in-person / concierge only. The quote
// function now enforces it. Setting SHIPPING_MAX_ITEM_VALUE=0 disables it.
function exceedsAutoShipCeiling(value) {
  const cap = maxShippableValue();
  if (cap === 0) return true;
  return Number(value) > cap;
}

// Binds a quote to the exact origin address and package it was priced for
// (Audit #4 P1-3). Weight and dimensions are compared numerically so that
// "12" and "12.0" match.
function originParcelFingerprint(origin, parcel) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const num = (v) => (Number(v) || 0).toFixed(2);
  const parts = [origin.street1, origin.street2, origin.city, origin.state,
                 String(origin.zip || '').slice(0, 5)].map(norm)
    .concat([parcel.weight, parcel.length, parcel.width, parcel.height].map(num));
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
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
  isExpressService,
  maxShippableValue,
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
  carrierAllowed,
  filterForTier,
  addressFingerprint,
  exceedsAutoShipCeiling,
  originParcelFingerprint,
  fetchPurchasedLabel,
};
