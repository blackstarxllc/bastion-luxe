# Bastion: actual state, 2026-09-24

Written against the live Supabase database, the live Netlify configuration
and the deployed code (PR #80, 2026-09-20). Where the other files in this
folder disagree with this one, this one is right.

## Verified continuously
- `node tests/run.js`: 61 checks, run by Netlify before EVERY deploy. A
  failure blocks the deploy.
- `sql/tests/security_regression.sql`: 35 live database attack/flow checks.
  Last run 2026-09-24: 35/35 PASS. Everything rolls back; re-run after any
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

## Owner actions still open
1. Supabase > Authentication > Providers > Email: turn on leaked-password protection.
2. Change `ESCROW_LIVE_EMAIL` off `blackstarxllc@gmail.com` (that account also owns live listings; Escrow.com rejects a deal where broker and seller are the same person).
3. Register the webhooks (see CLAUDE-CODE handoff notes / chat for exact URLs).
4. One real low-value purchase end to end.

## Post-deploy step (Claude)
`sql/2026-09-24_c_POST_DEPLOY_profile_privacy.sql` hides private profile
columns. It must run AFTER this code is live, never before.
