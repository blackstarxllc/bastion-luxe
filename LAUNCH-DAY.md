# Bastion — Launch Day

## 🔴 STEP 0 — ROTATE BOTH KEYS FIRST

Both keys were pasted into a chat and appear in screenshots. They are
compromised. Regenerate both before launch:

- **Escrow.com** → Developers → API → API Keys → delete + create new
- **EasyPost** → Account Settings → API Keys → regenerate production key

With those keys, someone else can buy shipping labels billed to you and
act on real-money escrow transactions as your broker account.

## STEP 1 — Deploy this build
Env vars only take effect on the next deploy.

## STEP 2 — Set env vars (use the NEW rotated keys)

| Variable | Value |
|---|---|
| `SHIPPING_PROVIDER` | `easypost`  ← **currently says `shippo`. Must change.** |
| `EASYPOST_API_KEY` | new production key — **mark secret** |
| `SHIPPING_TEST_MODE` | `false` |
| `ESCROW_LIVE_EMAIL` | your Escrow.com production account email |
| `ESCROW_LIVE_API_KEY` | new live key — **mark secret** |
| `ESCROW_LIVE_MODE` | `true` |

You sent an **EasyPost** key (`EZAK…`), but `SHIPPING_PROVIDER` is set to
`shippo`. If that isn't changed, the code reads `SHIPPO_API_KEY` and
**ignores the EasyPost key entirely** — every shipping quote fails. The
build now detects this and returns a clear error instead of a silent
failure, but the setting still has to be right.

Delete and recreate `SHIPPO_API_KEY` / `SHIPPING_WEBHOOK_SECRET` rather
than editing — Netlify won't convert an existing var to secret.

## STEP 3 — Register webhooks against the LIVE accounts
- **Escrow.com:** production webhook → `https://bastionmarket.com/.netlify/functions/escrow-webhook?secret=<ESCROW_WEBHOOK_SECRET>`
- **EasyPost:** → `https://bastionmarket.com/.netlify/functions/shipping-webhook?secret=<SHIPPING_WEBHOOK_SECRET>`

## STEP 4 — The broker collision (unresolved, your decision)
`ESCROW_SANDBOX_EMAIL` is `blackstarxllc@gmail.com`. If
`ESCROW_LIVE_EMAIL` is the same address as any Bastion **seller** account,
Escrow.com rejects the transaction:
`"Cannot have the same customer as multiple non-partner parties"`.
That is what caused both earlier 422s. Use a broker email that no seller
account uses.

## STEP 5 — One real low-value transaction, end to end
Buy from an account that is **not** the broker email. Verify: funded email
arrives → ship-by countdown → real carrier label → tracking updates →
confirm receipt → funds release → all three line items land correctly
(goods→seller, shipping→you, protection fee→you).
