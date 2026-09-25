# Bastion: actual state, 2026-09-25 (round 5)

Written against the live Supabase database, the live Netlify configuration
and the deployed code (PR #80, 2026-09-20). Where the other files in this
folder disagree with this one, this one is right.

## Verified continuously
- `node tests/run.js`: 75 checks, run by Netlify before EVERY deploy. A
  failure blocks the deploy.
- `sql/tests/security_regression.sql`: 35 live database attack/flow checks.
  Last run 2026-09-25: 38/38 PASS. Everything rolls back; re-run after any
  change to RLS, triggers or pricing.

## Money path (how it actually works now)
1. Buyer picks a shipping rate. The server signs that exact price
   (`quoteToken`, 45 minutes). The browser can choose a rate but never set one.
2. Order row is created. The database forces status `pending_payment`, the
   real seller, the real item name, the listing or accepted-offer price, and
   an immutable `fulfillment_mode`.
3. `create-shipment` verifies the signed quote and writes the shipping charge.
4. `create-escrow-transaction` refuses anything not `pending_payment` or with
   unverified shipping, then takes an atomic claim so exactly one Escrow.com
   transaction can ever be created per order.
5. Escrow.com webhook moves status FORWARD only: funded, released, cancelled.
6. Carrier webhook (authenticated) drives shipping progress, and on first
   scan / delivery tells Escrow.com the item was shipped / received. That
   "received" step starts Escrow.com's inspection clock, which is what makes
   its automatic payout possible if the buyer never clicks anything.
7. Release: Bastion attempts `accept`. Escrow.com only lets the buyer accept,
   so the expected path is a real Escrow.com link for the buyer. Bastion
   records `released` only when Escrow.com confirms.

## Self-healing
The hourly `deadline-sweep` re-reads every open order from Escrow.com and
every in-flight parcel from EasyPost and moves state forward if a webhook
was missed; it also withdraws unpaid checkouts that never reached
Escrow.com after 24 hours. Worst case for a lost webhook: one hour.

## EasyPost (verified 2026-09-25)
Production webhook `hook_09549c74...` -> /.netlify/functions/shipping-webhook,
HMAC-signed (X-Hmac-Signature); the old URL-secret webhook was deleted.
Only USPS, UPS and FedEx rates are offered. Items above
SHIPPING_MAX_ITEM_VALUE (default $50,000) are in-person / concierge only.

## Email (verified 2026-09-25)
Resend domain bastionmarket.com verified (DKIM + SPF). A live notification
sent through the production pipeline reached the owner's Gmail INBOX in 2 s,
marked Important. Each notification now records email_status
('queued' / 'sent' / 'failed'); the hourly sweep retries failures (max 3,
48 h) with a Resend idempotency key, so a retry can never duplicate an email.
support@bastionmarket.com forwards to the support Gmail inbox (owner-managed).

## Provider audit trail
public.provider_actions records every money-moving call to Escrow.com
(create / ship / receive / accept / cancel): order, item, on whose behalf,
HTTP status and Escrow.com's exact response. Admin-read only.

## Owner actions still open
1. Supabase > Authentication > Providers > Email: turn on leaked-password protection.
2. Change `ESCROW_LIVE_EMAIL` off `blackstarxllc@gmail.com` (that account also owns live listings; Escrow.com rejects a deal where broker and seller are the same person).
4. One real low-value purchase end to end.

## Post-deploy steps (Claude)
`sql/2026-09-25_f_POST_DEPLOY_email_trigger.sql` switches on email delivery
tracking; it must run only after the 2026-09-25 round-5 code is live.

`sql/2026-09-24_c_POST_DEPLOY_profile_privacy.sql` hides private profile
columns. It must run AFTER this code is live, never before.
