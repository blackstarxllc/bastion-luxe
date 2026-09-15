# Bastion — Admin Guide

**Your admin account: `blackstarxllc@gmail.com`**
Sign in with it, then go to `bastionmarket.com/bastion-admin.html`

Verified working by live test: this account CAN ban users, and a banned
user CANNOT unban themselves or make themselves admin.

---

## What you can do as admin

| Action | Where |
|---|---|
| Ban / unban a user | Users section |
| Resolve a dispute (real money) | Disputed Transactions |
| View all shipment evidence | Disputed Transactions |
| See shipments needing attention | Shipments section |
| Handle support requests | Support Requests |
| Review reported listings | Reports |
| Approve a return | Disputed Transactions |
| See every admin action ever taken | admin_action_log (audit trail) |

---

## When a dispute happens

**1. Funds freeze automatically.** The moment either party reports a
problem, the transaction goes to `disputed` and Escrow.com stops all
movement. Nothing releases while it is open. You do not have to do
anything to make this happen.

**2. Open the admin panel -> Disputed Transactions.**
Each case assembles itself. You will see:
- the full carrier timeline (every scan, with location and time)
- who signed for it
- links to every packing and unboxing video/photo
- how many messages the two parties exchanged
- the dispute reason and details

**3. Review the evidence.**
Evidence is APPEND-ONLY. Neither party can delete or edit anything once
submitted. That is what makes it worth something.

The question you are answering is almost always: *does the seller have
continuous, unedited footage of the item going into the box, and does the
buyer have continuous, unedited footage of the sealed box being opened?*
Whoever cannot produce that generally loses.

**4. Decide.** Two buttons:
- **Release funds to seller**
- **Refund buyer / cancel deal**

These call Escrow.com's real API. Bastion's records only update if
Escrow.com CONFIRMS the money moved. If Escrow rejects it, you see the
exact reason and nothing changes locally — there is never a state where
your books say "paid" and the money did not move.

**5. If a return is the right answer**, approve it. The buyer gets a
prepaid Bastion return label. Funds stay frozen until you confirm the
returned item. Check it against the listing's recorded serial number —
that is your protection against a swapped item.

---

## What you CANNOT do (by design)

- You cannot authenticate merchandise. Bastion does not claim to, and
  your Terms say so. If a case turns on whether a watch is genuine,
  direct both parties to independent third-party authentication.
- You cannot edit evidence. Neither can anyone else.
- You cannot make another user an admin from the UI. That requires a
  direct database change — deliberately, so a compromised admin account
  cannot mint more admins.

---

## Escalation

Escrow.com handles the money. If Escrow.com rejects an action you take,
that is a conversation with them, not a Bastion bug. The error is
recorded in `system_alerts` with the exact reason.

---

## Watch this weekly

Admin panel -> **System Alerts**. It should normally be empty. Things
that appear there:
- a shipping label failed to buy
- a notification email could not be sent
- Escrow.com rejected something
- a seller missed a ship-by deadline
- someone tried to move a deal off-platform

An empty alerts list means the machine is running clean.
