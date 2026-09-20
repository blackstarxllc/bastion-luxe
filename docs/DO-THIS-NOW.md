# Bastion — Your 3 Steps (everything else is done)

Your exact values are filled in below. Nothing to look up.

---

# STEP 1 — Deploy (2 minutes)

Give the zip to Claude Code and say:

> "Commit this, push it, open a PR, and merge it."

That's it. Netlify deploys automatically when it merges.

**Why this matters:** Netlify copies your settings into the site only when
it deploys. Your live keys are saved, but the site is still running on the
OLD settings until a deploy happens. Nothing works until you do this.

---

# STEP 2 — Turn on the two webhooks (5 minutes)

A webhook is just a phone number you give a company so they can call your
site when something happens. Escrow.com needs one so it can tell Bastion
"the buyer paid." EasyPost needs one so it can say "the package moved."

## 2A — Escrow.com

1. Go to **escrow.com** and log in
2. Click **Developers** at the top (or go to escrow.com/integrations/portal/api)
3. On the left, click **Webhooks**
4. Click **Add Webhook** (or **Create**)
5. Paste this in the URL box:

```
https://bastionmarket.com/.netlify/functions/escrow-webhook?secret=PASTE_ESCROW_SECRET_HERE
```

6. Replace `PASTE_ESCROW_SECRET_HERE` with your real secret:
   - Open Netlify in another tab
   - Site configuration -> Environment variables
   - Find `ESCROW_WEBHOOK_SECRET`, click to reveal, copy it
   - Paste it over `PASTE_ESCROW_SECRET_HERE`
   - Keep the `?secret=` part. Delete nothing else.
7. Click **Save**

## 2B — EasyPost

1. Go to **app.easypost.com** and log in
2. On the left, click **Webhooks & Events**
3. Click **Add a Webhook**
4. Paste this in the URL box:

```
https://bastionmarket.com/.netlify/functions/shipping-webhook?secret=PASTE_SHIPPING_SECRET_HERE
```

5. Replace `PASTE_SHIPPING_SECRET_HERE` with your real secret:
   - Open Netlify in another tab
   - Site configuration -> Environment variables
   - Find `SHIPPING_WEBHOOK_SECRET`, copy its value
   - Paste it over `PASTE_SHIPPING_SECRET_HERE`
6. If it asks which events: choose **tracker.updated**. If there is no
   choice, leave the default.
7. Click **Save**

---

# STEP 3 — One cheap test purchase (15 minutes)

Do NOT skip this. This is the only way to know real money works.

## Before you start
You need TWO accounts, and **neither may be blackstarxllc@gmail.com**.
That one is your Escrow.com broker identity — Escrow rejects any deal where
the same person is both broker and buyer/seller.

Use:
- Seller: **emailforwork1994@gmail.com**
- Buyer: **swaggmaster666@gmail.com** (or any other account)

## The walkthrough

1. **Sign in as the seller.** List something cheap — a $20 item.
   Choose **Shipping only**. Fill in weight and box size (guess is fine,
   e.g. 16 oz, 8x6x4 inches).
2. **Sign out. Sign in as the buyer.** Find the listing. Click
   **Begin Secure Purchase**.
3. **Enter a shipping address.** Pick a shipping option when prices appear.
   -> If no prices appear, EasyPost is not working. Stop and tell me.
4. **Pay on Escrow.com** when it sends you there.
5. **Check email.** Both accounts should get a "payment secured" email.
   -> If no email arrives, tell me.
6. **Sign in as the seller.** The order page should show a countdown
   ("Ship within 48 hours") and a **Generate My Shipping Label** button.
   Click it.
   -> If the label does not appear, tell me.
7. **Open the label.** It should be a real carrier label with a real
   tracking number.
8. **Sign in as the buyer.** Click **Confirm Receipt**.
9. **Check Escrow.com.** You should see THREE payments:
   - the item price -> to the seller
   - the shipping cost -> to YOU
   - the protection fee -> to YOU

**If all three land correctly, you are live. Start advertising.**

---

# ALREADY DONE — you do not need to touch any of this

- Live Escrow key installed and verified
- Live EasyPost key installed and verified
- Live mode ON, test mode OFF, provider set to EasyPost
- Broker email set, and the two unbuyable listings removed
- All test transactions, shipments, messages, offers, reviews wiped
- 4 real listings live and correctly configured
- 23 tables protected, 9 money-safety triggers active
- Email delivery confirmed working (15 successful sends)
- Two-buyer race condition fixed and re-tested
- Zero error-level security findings

---

# ONE THING TO WATCH

Your two API keys disappeared once already today, between two checks about
15 minutes apart. If shipping or checkout suddenly breaks after a deploy,
check Netlify first — the keys may have vanished again. Tell me and I will
restore them.

Also: both keys were pasted in chat, so they are exposed. Once your test
purchase works, regenerate both (Escrow.com -> Developers -> API Keys;
EasyPost -> Account Settings -> API Keys) and I will reinstall the new ones.
