# Bastion — Go-Live Checklist

Do these **in order**. Steps 1–3 are the switch itself; step 4 is the one
test that actually proves it works.


---

## 🔴 READ FIRST — a blocker specific to your account

`ESCROW_SANDBOX_EMAIL` (and whatever you set `ESCROW_LIVE_EMAIL` to) is
**`blackstarxllc@gmail.com`** — that is Bastion's *broker* identity at
Escrow.com.

Your own Bastion user account uses that **same email**, and it is the
seller on two listings.

Escrow.com refuses any transaction where one customer appears as more than
one non-partner party, with:

> `Cannot have the same customer as multiple non-partner parties`

So **any listing you create under `blackstarxllc@gmail.com` cannot be
bought by anyone.** The buyer just sees a failed purchase. This already
happened once during testing — that's what the earlier 422 was.

**Two options:**
- **A (recommended):** sell from a different Bastion account. Keep
  `blackstarxllc@gmail.com` purely as the broker/owner identity.
- **B:** set `ESCROW_LIVE_EMAIL` to a *different* address than the one your
  seller account uses, and register that address as the broker at
  Escrow.com.

This build now catches the collision **before** calling Escrow.com and
returns a plain-English message plus a `system_alert`, instead of an opaque
failed purchase. But the guard only explains the problem — it does not
remove it.

---

## 1. Deploy this build first

Hand this zip to Claude Code and let it merge before changing any keys.

**This matters:** Netlify bakes environment variables into functions at
deploy time. A variable changed *after* a deploy is not picked up until the
next one. That is exactly why your support email still went to the old
address — the variable was right, the deploy was old.

---

## 2. Escrow.com live keys

In Netlify → Site configuration → Environment variables:

| Variable | Value |
|---|---|
| `ESCROW_LIVE_EMAIL` | your Escrow.com **live** account email |
| `ESCROW_LIVE_API_KEY` | your Escrow.com **live** API key — mark **secret** |
| `ESCROW_LIVE_MODE` | `true` |

⚠️ Add the two live keys **before** flipping `ESCROW_LIVE_MODE`. If the flag
is true while the keys are missing, every purchase fails with a config
error. The code checks for this and returns a clean 500 rather than doing
anything dangerous, but no one can buy anything until it's fixed.

**Also update the Escrow.com webhook** to point at production and confirm
the secret matches `ESCROW_WEBHOOK_SECRET`.

---

## 3. Shippo live key

| Variable | Value |
|---|---|
| `SHIPPO_API_KEY` | your **live** key (`shippo_live_...`) — mark **secret** |
| `SHIPPING_TEST_MODE` | `false` |

⚠️ **Delete `SHIPPO_API_KEY` and recreate it** rather than editing. Netlify
will not convert an existing plaintext variable to secret (returns 422),
and it is currently plaintext — visible to anyone with dashboard access.
Same for `SHIPPING_WEBHOOK_SECRET`.

⚠️ **Both must change together.** A live key with `SHIPPING_TEST_MODE=true`
produces TEST labels: they download as a real-looking PDF and no carrier
will accept them. A seller ships nothing, the ship-by clock runs out, the
buyer cancels — and nothing errors.

This build adds a guard for exactly that: `shippingConfigWarning()` detects
the mismatch, blocks label purchase with a clear message, and writes a
`system_alert`. It is a safety net, not a substitute for setting both.

**Register the Shippo webhook:**
`https://bastionmarket.com/.netlify/functions/shipping-webhook?secret=<SHIPPING_WEBHOOK_SECRET>`
event `track_updated`.

---

## 4. The one test that proves it — do not skip

Run **one real low-value transaction end to end** with your own money:

1. List a cheap item from a seller account (shipping enabled, real address)
2. Buy it from a different account with a different email
   *(not `blackstarxllc@gmail.com` — that is your Escrow.com broker
   identity, and Escrow.com rejects a transaction where the seller and
   broker are the same party)*
3. Pay through Escrow.com
4. Confirm: funded email arrives, ship-by countdown appears
5. Generate the label — confirm it's a **real** carrier label
6. Ship it, watch tracking update on the order page
7. Confirm receipt, verify funds release
8. Check your Escrow.com balance for **all three** line items:
   goods → seller, shipping → you, protection fee → you

That single run exercises every integration at once. Nothing I can do from
here substitutes for it, because I cannot reach either provider's API.

---

## 5. Still open (your call, not blockers)

- **Leaked-password protection** — paid Supabase feature, deferred
- **`support@bastionmarket.com` receiving** — the mailto links on Support,
  Privacy and Terms point there but nothing receives mail. Cloudflare Email
  Routing (free) or Resend "Enable Receiving" fixes it
- **Gmail "Send mail as"** — so support replies show as Bastion Support
- **Circumvention flags & returns have no admin UI** — both are fully built
  and secured in the backend, but nothing surfaces them on a screen yet

---

## What's verified

All nine money-path guards confirmed live in the database:
server-side pricing, frozen money columns, guarded status transitions,
auto-generated seller-only release codes, blocked privilege escalation,
deal-status sync on release, notification email trigger, circumvention
detection.

Zero ERROR-level security findings. All 14 JS files, every page's inline
script, HTML structure, and internal links validate clean. No secrets in
client code.
