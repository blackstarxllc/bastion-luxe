# Bastion — actual state, 2026-09-20

The four files beside this one (DO-THIS-NOW, GO-LIVE-CHECKLIST, LAUNCH-DAY,
ADMIN-GUIDE) contradict each other and several of their claims are out of
date. Where they disagree with this file, this file is right — it was written
against the live Supabase database and the live Netlify configuration, not
from memory.

## Corrections to those files

| They say | Actually |
|---|---|
| "4 real listings live" | **47** active listings, 7 seller accounts, $2,400–$230,000 |
| `SHIPPING_PROVIDER` "currently says shippo, must change" | Already `easypost`. Fixed 2026-09-14. |
| "Live Escrow key installed and verified" | Installed, but **never verified** — the release call used an action that does not exist in the Escrow.com API |
| "23 tables protected, 9 money-safety triggers active" | True, but the status-transition trigger permitted a buyer to write `released` themselves |
| Shipping cost missing from the pricing trigger (second audit) | **Wrong.** Live trigger is `total := price + fee + ship_cost` |

## Verified against Escrow.com's live API docs

Valid PATCH actions: `agree`, `ship`, `receive`, `accept`, `reject`,
`ship_return`, `receive_return`, `accept_return`, `reject_return`, `cancel`.

`release` is not one of them. It is what this codebase sent on every buyer
confirm-receipt and every admin dispute release.

A partner may perform only these on another party's behalf (`As-Customer`):
`agree`, `ship`, `receive`, `reject`, `ship_return`, `receive_return`,
`reject_return`. **`accept` is excluded** — Escrow.com's Accept Items page
states a partner cannot accept for the buyer. Bastion is the partner on every
transaction it creates, so no credential lets it release funds for a buyer.

The release flow therefore: marks the item received on the buyer's behalf
(allowed, and it arms Escrow.com's automatic accept-on-inspection-lapse),
attempts `accept`, and on refusal hands the buyer a real Escrow.com link.
Bastion records `released` only when Escrow.com confirms.

## Still open — owner action required

1. **Rotate both API keys.** `ESCROW_LIVE_API_KEY` and `EASYPOST_API_KEY` are
   stored in Netlify as plaintext (not marked secret) and have been pasted
   into at least two AI chat sessions. Treat both as compromised.
2. **Broker collision.** `ESCROW_LIVE_EMAIL` is `blackstarxllc@gmail.com`,
   which is also a Bastion account. Any listing sold from it will be rejected
   by Escrow.com. Use a dedicated broker address no seller account uses.
3. **`SHIPPO_API_KEY` is dead weight** — provider is EasyPost. Delete it.
4. **`support@bastionmarket.com` receives no mail.** The Support, Privacy and
   Terms pages link to it.
5. **One real low-value end-to-end purchase.** Nothing substitutes for it.
