#!/usr/bin/env node
// Bastion pre-deploy test suite. Runs as the Netlify build command, so a
// failing test BLOCKS the deploy and the live site stays as it was.
// No dependencies: plain Node. Run locally with:  node tests/run.js
//
// Database-level security is tested separately by
// sql/tests/security_regression.sql (run against Supabase; 35 checks).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'netlify', 'functions');
let passed = 0;
const failures = [];

const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { passed++; }, (e) => { failures.push(name + '\n      ' + (e && e.message || e)); }));
    } else { passed++; }
  } catch (e) { failures.push(name + '\n      ' + (e && e.message || e)); }
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error((label ? label + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function ok(cond, label) { if (!cond) throw new Error(label || 'assertion failed'); }
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

// Keep module-load warnings out of the report.
process.env.SHIPPING_PROVIDER = 'easypost';
process.env.EASYPOST_API_KEY = 'EZTKtest';
process.env.SHIPPING_TEST_MODE = 'true';
process.env.QUOTE_SIGNING_SECRET = 'unit-test-secret';
console.error = () => {};

// ---------------------------------------------------------------- syntax
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const { execFileSync } = require('child_process');
const os = require('os');
for (const file of walk(ROOT, [])) {
  test('syntax: ' + path.relative(ROOT, file), () => {
    const code = fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, '');
    if (/^\s*(import|export)\s/m.test(code)) {
      // ES module (e.g. the Netlify edge function): check it as one.
      const tmp = path.join(os.tmpdir(), 'bastion-check-' + path.basename(file, '.js') + '.mjs');
      fs.writeFileSync(tmp, code);
      try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
      catch (e) { throw new Error(String(e.stderr || e.message).split('\n').slice(0, 4).join(' ')); }
      finally { fs.unlinkSync(tmp); }
    } else {
      new vm.Script(code, { filename: file });
    }
  });
}
for (const f of htmlFiles) {
  const src = read(f);
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(src))) {
    const code = m[1];
    const idx = i++;
    if (!code.trim() || /type="application\/(ld\+)?json"/.test(m[0])) continue;
    test('syntax: ' + f + ' inline script #' + idx, () => { new vm.Script(code, { filename: f }); });
  }
}

// ---------------------------------------------------------------- money path
const escrowLib = require(path.join(FN, '_escrow-lib.js'));
const shipLib = require(path.join(FN, '_shipping-lib.js'));
const escrowWebhook = require(path.join(FN, 'escrow-webhook.js'));
const shippingWebhook = require(path.join(FN, 'shipping-webhook.js'));

test('escrow: the disbursing action is "accept" (never the non-existent "release")', () => {
  eq(escrowLib.ACTION_ACCEPT, 'accept');
  for (const f of fs.readdirSync(FN).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(FN, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    ok(!/action\s*:\s*['"]release['"]/.test(code), f + ' sends action "release"');
  }
});

test('escrow: per-action skip logic', () => {
  eq(escrowLib.itemAlreadyPast({ status: { shipped: true } }, 'ship'), true, 'ship after shipped');
  eq(escrowLib.itemAlreadyPast({ status: { shipped: true } }, 'receive'), false, 'receive after shipped');
  eq(escrowLib.itemAlreadyPast({ status: { received: true } }, 'receive'), true, 'receive after received');
  eq(escrowLib.itemAlreadyPast({ status: { accepted: true } }, 'accept'), true, 'accept after accepted');
  eq(escrowLib.itemAlreadyPast({ status: {} }, 'accept'), false, 'accept when open');
});

test('escrow webhook: status derivation', () => {
  const g = (st, sch) => ({ items: [{ type: 'general_merchandise', title: 'W', status: st || {}, schedule: [{ status: sch || {} }] },
                                    { type: 'broker_fee', title: 'Shipping', status: { accepted: true } }] });
  eq(escrowWebhook.deriveStatus(g({}, { secured: true })), 'funded');
  eq(escrowWebhook.deriveStatus(g({ shipped: true }, { secured: true })), 'shipped');
  eq(escrowWebhook.deriveStatus(g({ received: true }, { secured: true })), 'received');
  eq(escrowWebhook.deriveStatus(g({ accepted: true })), 'released', 'goods accepted');
  eq(escrowWebhook.deriveStatus(g({}, {})), 'created', 'fee line accepted must not count');
  eq(escrowWebhook.deriveStatus({ status: { cancelled: true }, items: [] }), 'cancelled');
});

test('escrow webhook: forward-only transitions', () => {
  const N = escrowWebhook.nextTransactionStatus;
  eq(N('pending_payment', 'funded'), 'funded');
  eq(N('funded', 'funded'), null, 'duplicate');
  eq(N('delivered', 'shipped'), null, 'no regression');
  eq(N('in_transit', 'funded'), null, 'no regression');
  eq(N('delivered', 'released'), 'released');
  eq(N('released', 'cancelled'), null, 'released is final');
  eq(N('pending_payment', 'cancelled'), 'cancelled', 'not disputed');
  eq(N('pending_payment', 'disputed'), null, 'no dispute before funding');
  eq(N('delivered', 'rejected'), 'disputed');
});

test('shipping webhook: status precedence (exception is not terminal)', () => {
  const f = shippingWebhook.nextShipmentStatus;
  eq(f('exception', 'delivered'), 'delivered');
  eq(f('exception', 'in_transit'), 'in_transit');
  eq(f('delivered', 'exception'), null);
  eq(f('in_transit', 'exception'), 'exception');
  eq(f('out_for_delivery', 'in_transit'), null);
  eq(f('delivered', 'returned'), null);
  eq(f('label_created', 'returned'), 'returned');
});

test('shipping webhook: authentication', () => {
  const secret = 'whsec-test';
  const body = '{"description":"tracker.updated"}';
  const sig = 'hmac-sha256-hex=' + crypto.createHmac('sha256', secret.normalize('NFKD')).update(body).digest('hex');
  const A = shippingWebhook.isAuthentic;
  eq(A({ body, headers: { 'x-hmac-signature': sig } }, secret), true, 'valid HMAC');
  eq(A({ body: body + ' ', headers: { 'x-hmac-signature': sig } }, secret), false, 'body tampered');
  eq(A({ body, headers: {}, queryStringParameters: { secret } }, secret), false, 'URL secret no longer accepted (HMAC only)');
  eq(A({ body, headers: {}, queryStringParameters: { secret: 'nope' } }, secret), false, 'wrong secret');
  eq(A({ body, headers: {} }, secret), false, 'no credentials');
  eq(A({ body, headers: { 'x-hmac-signature': sig } }, ''), false, 'fails closed with no secret configured');
});

test('shipping quotes: signed price cannot be tampered with', () => {
  const t = shipLib.signQuote({ u: 'user', d: 'deal', z: '75201', a: 24.5 });
  const p = shipLib.verifyQuote(t);
  ok(p && p.a === 24.5, 'valid token verifies');
  const [body, sig] = t.split('.');
  const decoded = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString().replace('24.5', '0.01');
  const forged = Buffer.from(decoded).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.' + sig;
  eq(shipLib.verifyQuote(forged), null, 'price-edited token');
  eq(shipLib.verifyQuote('x.y'), null, 'garbage');
  eq(shipLib.verifyQuote(undefined), null, 'missing');
});

test('shipping label: never buys a browser-supplied rate', () => {
  const code = fs.readFileSync(path.join(FN, 'create-shipping-label.js'), 'utf8').replace(/\/\/.*$/gm, '');
  ok(!/const\s*\{[^}]*\brateToken\b[^}]*\}\s*=\s*body/.test(code), 'rateToken read from request body');
  ok(/label_claimed_at/.test(code), 'label purchase has no atomic claim');
});

test('escrow creation: atomic claim and shipping verification present', () => {
  const code = read('netlify/functions/create-escrow-transaction.js');
  ok(/escrow_claimed_at/.test(code), 'no atomic claim');
  ok(/shipping_verified_at/.test(code), 'shipped orders not gated on verified shipping');
  ok(/status !== 'pending_payment'/.test(code), 'does not refuse non-payable orders');
});

test('shipping: carrier allowlist and Vault express policy fail closed', () => {
  const vault = shipLib.tierRules('vault');
  const rates = [
    { carrier: 'USPS', service: 'Priority', amount: 20 },
    { carrier: 'USPS', service: 'Express', amount: 60 },
    { carrier: 'DHLeCommerce', service: 'Expedited', amount: 9 },
    { carrier: 'UPSDAP', service: 'NextDayAir', amount: 80 },
    { carrier: 'FedExDefault', service: 'FEDEX_EXPRESS_SAVER', amount: 40 },
  ];
  eq(shipLib.filterForTier(rates, vault).map((r) => r.service).join(','), 'Express,NextDayAir', 'vault services');
  eq(shipLib.filterForTier([rates[0]], vault).length, 0, 'vault with only Priority must return nothing');
  ok(!shipLib.filterForTier(rates, shipLib.tierRules('standard')).some((r) => /dhl/i.test(r.carrier)), 'DHL offered');
});

test('shipping: quote bound to the exact address; no value ceiling', () => {
  const a = { line1: '1 Main St', line2: 'Apt 2', city: 'Dallas', state: 'TX', postal_code: '75201' };
  eq(shipLib.addressFingerprint(a), shipLib.addressFingerprint({ street1: '1 MAIN ST.', street2: 'apt 2', city: 'dallas', state: 'tx', zip: '75201-1234' }), 'formatting');
  ok(shipLib.addressFingerprint(a) !== shipLib.addressFingerprint(Object.assign({}, a, { line1: '9 Elm St' })), 'same ZIP, different street');
  const quote = read('netlify/functions/shipping-quote.js');
  ok(!/exceedsAutoShipCeiling|maxShippableValue|concierge/.test(quote), 'a value ceiling blocks shipping (owner policy: any value ships)');
  ok(/status=eq\.accepted/.test(quote), 'quote does not price from the accepted offer');
  ok(/quote\.f !== lib\.addressFingerprint\(addr\)/.test(read('netlify/functions/create-shipment.js')), 'address fingerprint not verified');
});

test('shipping webhook: reads EasyPost result.tracking_code and records events', () => {
  const code = read('netlify/functions/shipping-webhook.js');
  ok(/result\.tracking_code/.test(code), 'result.tracking_code not read: every real tracking update would be dropped');
  ok(/provider_events/.test(code), 'no webhook inbox');
});

test('labels: interrupted purchases are adopted, never bought twice', () => {
  const code = read('netlify/functions/create-shipping-label.js');
  ok(/fetchPurchasedLabel/.test(code) && /pending_provider_shipment_id/.test(code), 'no purchase journal / adopt path');
  ok(/definitive === false/.test(code), 'unknown outcomes release the claim');
});

test('escrow creation: stale claims look up Escrow.com before creating', () => {
  const code = read('netlify/functions/create-escrow-transaction.js');
  ok(/bastionRef/.test(code) && /adopted: true/.test(code), 'no adopt-before-create');
});

test('sweep: refuses unauthenticated manual calls', async () => {
  delete process.env.INTERNAL_WEBHOOK_SECRET;
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
  const sweep = require(path.join(FN, 'deadline-sweep.js'));
  return sweep.handler({ headers: {} }).then((r) => eq(r.statusCode, 401, 'manual call without secret'));
});


test('shipping: quote bound to exact price, origin and package', () => {
  const o = { street1: '5 Oak Ave', street2: 'Suite 2', city: 'Dallas', state: 'TX', zip: '75201' };
  eq(shipLib.originParcelFingerprint(o, { weight: 12, length: 10, width: 8, height: 4 }),
     shipLib.originParcelFingerprint(o, { weight: '12.0', length: '10', width: 8, height: '4.00' }), 'numeric formatting');
  ok(shipLib.originParcelFingerprint(o, { weight: 12, length: 10, width: 8, height: 4 }) !==
     shipLib.originParcelFingerprint(o, { weight: 13, length: 10, width: 8, height: 4 }), 'weight change not detected');
  const cs = read('netlify/functions/create-shipment.js');
  ok(/Number\(quote\.v\) !== Number\(txn\.price\)/.test(cs), 'exact price not enforced');
  ok(/quote\.p !== originNow/.test(cs), 'origin/parcel not enforced');
  ok(cs.indexOf('const priv = ') < cs.indexOf('originParcelFingerprint('), 'origin check runs before the origin is loaded');
});

test('labels: the purchase journal must be confirmed before paying', () => {
  const code = read('netlify/functions/create-shipping-label.js');
  ok(/journaled\[0\]\.pending_provider_shipment_id !== requote\.providerShipmentId/.test(code), 'journal not verified');
  ok(code.indexOf('journaled') < code.indexOf('lib.buyLabel(token)'), 'journal checked after purchase');
});

test('escrow creation: unknown outcomes keep the claim', () => {
  const code = read('netlify/functions/create-escrow-transaction.js');
  ok(/markCreationUnknown/.test(code) && /createRes\.status >= 500/.test(code), 'network/5xx treated as definite failure');
  const netBlock = code.slice(code.indexOf('} catch (netErr) {'), code.indexOf('} catch (netErr) {') + 400);
  ok(!/releaseClaim/.test(netBlock), 'network error releases the claim');
});

test('webhooks: an unprocessed duplicate is resumed, not dropped', () => {
  for (const f of ['shipping-webhook.js', 'escrow-webhook.js']) {
    const code = read('netlify/functions/' + f);
    ok(/processed_at/.test(code) && /attempts/.test(code), f + ' skips unprocessed duplicates');
  }
  eq(typeof shippingWebhook.processTracking, 'function', 'shared tracking processor');
  ok(!/hmac-sha256-hex/.test(read('netlify/functions/deadline-sweep.js')), 'sweep still forges signed webhooks');
});

test('sweep: failed reads alert, time budget and rotation present', () => {
  const code = read('netlify/functions/deadline-sweep.js');
  ok(/BUDGET_MS/.test(code) && /CONCURRENCY/.test(code), 'no time budget / concurrency');
  ok(/provider_checked_at\.asc\.nullsfirst/.test(code) && /tracking_checked_at\.asc\.nullsfirst/.test(code), 'no fair rotation');
  ok(/could not read/.test(code), 'failed reads are silent');
});

test('email: fails closed, never uses the Resend test sender, links stay on-site', async () => {
  const sender = require(path.join(FN, 'send-notification-email.js'));
  const saved = { k: process.env.RESEND_API_KEY, f: process.env.RESEND_FROM_EMAIL, s: process.env.INTERNAL_WEBHOOK_SECRET };
  process.env.INTERNAL_WEBHOOK_SECRET = 'unit-secret';
  delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM_EMAIL;
  const r = await sender.handler({ httpMethod: 'POST', headers: { 'x-webhook-secret': 'unit-secret' }, body: JSON.stringify({ to_email: 'a@b.co', subject: 'x' }) });
  eq(r.statusCode, 503, 'unconfigured email must not report success');
  const bad = await sender.handler({ httpMethod: 'POST', headers: { 'x-webhook-secret': 'wrong' }, body: '{}' });
  eq(bad.statusCode, 401, 'wrong secret');
  eq(sender.safeLink('bastion-deal-detail.html?id=abc-123'), 'bastion-deal-detail.html?id=abc-123');
  eq(sender.safeLink('https://evil.example/phish'), 'bastion-marketplace.html', 'off-site link');
  eq(sender.safeLink('javascript:alert(1)'), 'bastion-marketplace.html', 'script link');
  for (const f of fs.readdirSync(FN)) ok(!/onboarding@resend\.dev/.test(fs.readFileSync(path.join(FN, f), 'utf8')), f + ' falls back to the Resend test sender');
  process.env.RESEND_API_KEY = saved.k || ''; process.env.RESEND_FROM_EMAIL = saved.f || '';
  if (saved.s === undefined) delete process.env.INTERNAL_WEBHOOK_SECRET; else process.env.INTERNAL_WEBHOOK_SECRET = saved.s;
});

test('support: ticket owner comes from the session, never the request body', () => {
  const code = read('netlify/functions/send-support-request.js');
  ok(!/const \{[^}]*\buser_id\b[^}]*\} = JSON\.parse/.test(code), 'user_id read from body');
  ok(/user_id: verifiedUserId/.test(code), 'ticket not tied to verified session');
  ok(!/Nothing releases while a support case/.test(code), 'false escrow claim still in the customer email');
  ok(/support@bastionmarket\.com/.test(read('bastion-support.html')), 'support address missing from the support page');
});

test('SEO: listing pages get product data, canonical, noindex when sold; sitemap lists listings', async () => {
  const html = '<html><head><title>Listing | Bastion</title></head><body></body></html>';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('deals?id=eq.')
    ? new Response(JSON.stringify([{ item_name: 'Watch </script><script>x()</script>', price: 12500, status: 'sold', description: 'd' }]), { status: 200 })
    : new Response(JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', created_at: '2026-09-01T00:00:00Z' }]), { status: 200 });
  try {
    const ctx = { next: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) };
    const lp = (await import(path.join(ROOT, 'netlify/edge-functions/listing-preview.js'))).default;
    const out = await (await lp(new Request('https://bastionmarket.com/bastion-deal-detail.html?id=11111111-1111-1111-1111-111111111111'), ctx)).text();
    const ld = JSON.parse(out.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    eq(ld['@type'], 'Product'); eq(ld.offers.price, '12500.00');
    ok(!/<\/script><script>x/.test(out), 'listing text escaped out of JSON-LD');
    ok(/rel="canonical"/.test(out), 'no canonical');
    ok(/noindex/.test(out), 'sold listing indexable');
    const sm = (await import(path.join(ROOT, 'netlify/edge-functions/sitemap.js'))).default;
    const xml = await (await sm(new Request('https://bastionmarket.com/sitemap.xml'), ctx)).text();
    ok(xml.includes('bastion-deal-detail.html?id=11111111-1111-1111-1111-111111111111'), 'sitemap missing listings');
  } finally { globalThis.fetch = realFetch; }
});

test('accessibility: every form control and icon button has an accessible name; every image has alt', () => {
  const problems = [];
  for (const f of htmlFiles) {
    const src = read(f).replace(/<script[\s\S]*?<\/script>/g, '');
    const fors = new Set((src.match(/<label[^>]*\bfor="([^"]+)"/g) || []).map((m) => m.match(/for="([^"]+)"/)[1]));
    const labelled = (tag) => /aria-label(ledby)?="[^"]+"|\btitle="[^"]+"/.test(tag) || (/\bid="([^"]+)"/.test(tag) && fors.has(tag.match(/\bid="([^"]+)"/)[1]));
    // controls wrapped in <label>...</label> are named by their label text
    const unwrapped = src.replace(/<label\b[\s\S]*?<\/label>/g, '');
    for (const tag of unwrapped.match(/<(input|select|textarea)\b[^>]*>/g) || []) {
      if (/type="(hidden|submit|button)"/.test(tag)) continue;
      if (!labelled(tag)) problems.push(f + ': ' + tag.slice(0, 80));
    }
    for (const m of src.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []) {
      const open = m.match(/<button\b[^>]*>/)[0];
      const text = m.replace(/<[^>]+>/g, '').trim();
      if (!text && !labelled(open)) problems.push(f + ': ' + open.slice(0, 80));
    }
    for (const img of src.match(/<img\b[^>]*>/g) || []) if (!/\balt="/.test(img)) problems.push(f + ': ' + img.slice(0, 80));
  }
  eq(problems.join(' | '), '', 'unnamed controls');
});

test('checkout: "both" listings offer ship AND in-person at any price', () => {
  const page = read('bastion-deal-detail.html');
  ok(/function chooseFulfilment/.test(page) && /dealFulfilment === 'both'/.test(page), 'no fulfilment choice');
  ok(/id="fulfilShip"/.test(page) && /id="fulfilInPerson"/.test(page), 'both options must always be offered');
  ok(!/AUTO_SHIP_MAX/.test(page), 'a price cut-off removes the shipping option');
});

// ---------------------------------------------------------------- consistency
test('fees: every client-side fee table matches the database schedule', () => {
  // Mirrors public.calculate_protection_fee(): <2000 6%, <10000 5%, <50000 4.5%, else 3%.
  const expected = (n) => (n < 2000 ? 0.06 : n < 10000 ? 0.05 : n < 50000 ? 0.045 : 0.03);
  for (const f of ['bastion-deal-detail.html', 'bastion-create-listing.html']) {
    const m = read(f).match(/function feeRateForPrice\(n\)\{[\s\S]*?\n\}/);
    ok(m, f + ' has no feeRateForPrice');
    const fn = vm.runInNewContext('(' + m[0] + ')');
    for (const price of [1, 1999, 2000, 9999, 10000, 49999, 50000, 230000]) eq(fn(price), expected(price), f + ' @ $' + price);
  }
});

test('inspection windows: escrow creation matches the shipping tiers', () => {
  const code = read('netlify/functions/create-escrow-transaction.js');
  ok(/itemPrice >= 10000 \? 432000/.test(code) && /itemPrice >= 1000\s+\? 259200/.test(code), 'escrow inspection thresholds changed');
  eq(shipLib.tierRules(shipLib.tierForValue(10000)).inspectionSeconds, 432000);
  eq(shipLib.tierRules(shipLib.tierForValue(1000)).inspectionSeconds, 259200);
  eq(shipLib.tierRules(shipLib.tierForValue(999)).inspectionSeconds, 172800);
});

// ---------------------------------------------------------------- site integrity
test('pages: Supabase library pinned with an integrity hash', () => {
  for (const f of htmlFiles) {
    const tags = read(f).match(/<script[^>]+supabase-js[^>]*>/g) || [];
    for (const t of tags) ok(/@2\.\d+\.\d+\//.test(t) && /integrity="sha384-/.test(t) && /crossorigin="anonymous"/.test(t), f + ': ' + t);
  }
});

test('pages: every local link and asset exists', () => {
  const missing = [];
  for (const f of htmlFiles) {
    const src = read(f);
    const re = /(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g;
    let m;
    while ((m = re.exec(src))) {
      const u = m[1];
      if (/^(https?:|mailto:|tel:|data:|javascript:|\/\/)/.test(u) || /[$'+{]/.test(u) || u === '/' || u === '') continue;
      if (!fs.existsSync(path.join(ROOT, u.replace(/^\//, '')))) missing.push(f + ' -> ' + u);
    }
  }
  eq(missing.join(', '), '', 'missing targets');
});

test('service worker: every precached file exists', () => {
  const m = read('service-worker.js').match(/PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/);
  ok(m, 'no precache list');
  const urls = (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
  for (const u of urls) ok(fs.existsSync(path.join(ROOT, u.replace(/^\//, ''))), 'missing ' + u);
});

test('deploy: internal folders are blocked from the public site', () => {
  const toml = read('netlify.toml');
  for (const p of ['/docs/*', '/sql/*', '/tests/*', '/netlify/*', '/*.md']) ok(toml.includes('from = "' + p + '"'), p + ' is not blocked');
});

// ---------------------------------------------------------------- report
Promise.all(pending).then(() => {
const total = passed + failures.length;
if (failures.length) {
  process.stdout.write('\nBASTION TESTS: ' + failures.length + ' of ' + total + ' FAILED - deploy blocked\n\n  x ' + failures.join('\n  x ') + '\n\n');
  process.exit(1);
}
process.stdout.write('BASTION TESTS: all ' + total + ' passed\n');
});
