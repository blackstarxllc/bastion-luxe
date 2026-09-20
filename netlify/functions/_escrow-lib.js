// netlify/functions/_escrow-lib.js
//
// ============================================================
// ESCROW.COM ACTION VOCABULARY — verified against the live API docs
// on 2026-09-20 (escrow.com/api/docs/basics and /accept-transaction-items).
//
// The valid PATCH actions on a transaction or item are:
//
//   agree, ship, receive, accept, reject,
//   ship_return, receive_return, accept_return, reject_return, cancel
//
// "release" IS NOT ONE OF THEM. This codebase sent action: 'release' on
// every buyer confirm-receipt and on every admin dispute release. Escrow.com
// rejects that outright, which means no transaction has ever actually
// disbursed through this code path. The correct action is 'accept'.
//
// ------------------------------------------------------------------
// THE HARDER CONSTRAINT — a partner may not accept for the buyer
// ------------------------------------------------------------------
// Escrow.com's Basics page lists exactly which actions an approved partner
// may perform on behalf of another party via the As-Customer header:
//
//   agree, ship, receive, reject, ship_return, receive_return, reject_return
//
// 'accept' is deliberately absent, and the Accept Items page states it
// directly: "This action must be performed by the buyer in the transaction.
// A partner cannot perform this action on behalf of the buyer."
//
// So simply renaming 'release' to 'accept' does NOT make the release work.
// Bastion authenticates as its own account; it is the partner on every
// transaction it creates. It cannot accept for the buyer, period.
//
// What this library therefore does:
//
//   1. Uses 'accept' (the correct action) and attempts it As-Customer the
//      buyer, because some partner accounts are granted wider permission and
//      if this account has it, the buyer gets a one-click release.
//   2. Treats rejection of that attempt as an EXPECTED outcome, not an
//      error. It reports back needsBuyerAction so the caller can send the
//      buyer to Escrow.com to accept there.
//   3. NEVER lets Bastion record a release that Escrow.com did not confirm.
//
// The backstop is Escrow.com's own behaviour: if the inspection period
// lapses without accept or reject, Escrow.com accepts on the buyer's behalf
// and disburses. Funds are never stranded; the worst case is that the buyer
// waits out the inspection window instead of releasing early.
//
// ------------------------------------------------------------------
// ITEM STATUS SHAPE
// ------------------------------------------------------------------
// Escrow.com returns item.status as an object of booleans with these keys
// (confirmed from the List Transactions response in their docs):
//
//   received, rejected, accepted, shipped,
//   received_returned, rejected_returned, shipped_returned, accepted_returned
//
// The previous isItemAlreadySettled() looked for released/completed/
// cancelled/rejected. Of those, only 'rejected' is real. 'accepted' — the
// one that actually means settled — was never checked, so an already
// accepted item looked unsettled and got re-PATCHed on every retry.
// ============================================================

const ESCROW_API_BASE = process.env.ESCROW_LIVE_MODE === 'true'
  ? 'https://api.escrow.com/2017-09-01'
  : 'https://api.escrow-sandbox.com/2017-09-01';

// The action that disburses funds to the seller. Named here so it is
// impossible to typo it into a different verb in two places again.
const ACTION_ACCEPT = 'accept';
const ACTION_CANCEL = 'cancel';
const ACTION_RECEIVE = 'receive';

function escrowAuthHeader(email, apiKey) {
  return 'Basic ' + Buffer.from(`${email}:${apiKey}`).toString('base64');
}

function isItemAlreadySettled(item) {
  if (!item) return false;
  if (typeof item.status === 'string') {
    return ['accepted', 'rejected', 'cancelled', 'completed', 'released'].includes(item.status);
  }
  const s = item.status || {};
  return !!(s.accepted || s.rejected || s.cancelled || s.completed || s.accepted_returned);
}

function isItemReceived(item) {
  if (!item) return false;
  if (typeof item.status === 'string') return item.status === 'received';
  const s = item.status || {};
  return !!s.received;
}

// Escrow.com signals "you are not allowed to do this as this party" with a
// 401/403, or a 422 whose message names the permission. Distinguishing that
// from a genuine failure is what lets us route the buyer to Escrow.com
// instead of showing them a scary generic error.
function looksLikePermissionRefusal(status, body) {
  if (status === 401 || status === 403) return true;
  const text = JSON.stringify(body || {}).toLowerCase();
  return /partner cannot|must be performed by the buyer|not authorized|not authorised|permission|forbidden/.test(text);
}

async function fetchTransaction({ escrowTransactionId, email, apiKey }) {
  const res = await fetch(
    `${ESCROW_API_BASE}/transaction/${encodeURIComponent(escrowTransactionId)}`,
    { headers: { Authorization: escrowAuthHeader(email, apiKey) } }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail: detail.slice(0, 500), txn: null };
  }
  return { ok: true, status: 200, txn: await res.json() };
}

/**
 * Applies `action` to every item on the transaction that isn't already
 * settled. The merchandise item is PRIMARY: its outcome decides overall
 * success, because that's the item the buyer/seller relationship is about.
 * Fee and shipping items are best-effort — a buyer waiting on their money
 * should never be stuck behind a fee-collection problem — but every
 * secondary failure is reported so it can be alerted on.
 *
 * asCustomer: optional email. Sends the As-Customer header so the action is
 * performed on behalf of that party rather than as Bastion itself.
 *
 * Returns:
 *   {
 *     ok, needsBuyerAction, primaryError, itemCount,
 *     results: [{ id, title, ok|skipped, status, response }]
 *   }
 */
async function applyActionToAllItems({ escrowTransactionId, action, email, apiKey, primaryItemId, asCustomer }) {
  const authHeader = escrowAuthHeader(email, apiKey);

  const loaded = await fetchTransaction({ escrowTransactionId, email, apiKey });
  if (!loaded.ok) {
    return {
      ok: false,
      needsBuyerAction: false,
      primaryError: {
        message: 'Could not load the Escrow.com transaction',
        status: loaded.status,
        detail: loaded.detail,
      },
      itemCount: 0,
      results: [],
    };
  }

  const items = Array.isArray(loaded.txn.items) ? loaded.txn.items : [];
  const results = [];
  let primaryOk = false;
  let primaryError = null;
  let primaryFound = false;
  let needsBuyerAction = false;

  for (const item of items) {
    const isPrimary = String(item.id) === String(primaryItemId);
    if (isPrimary) primaryFound = true;

    if (isItemAlreadySettled(item)) {
      results.push({ id: item.id, title: item.title, skipped: true, reason: 'already settled' });
      if (isPrimary) primaryOk = true;
      continue;
    }

    const headers = { Authorization: authHeader, 'Content-Type': 'application/json' };
    if (asCustomer) headers['As-Customer'] = asCustomer;

    const patchRes = await fetch(
      `${ESCROW_API_BASE}/transaction/${encodeURIComponent(escrowTransactionId)}/item/${encodeURIComponent(item.id)}`,
      { method: 'PATCH', headers, body: JSON.stringify({ action }) }
    );
    const data = await patchRes.json().catch(() => ({}));

    results.push({ id: item.id, title: item.title, ok: patchRes.ok, status: patchRes.status, response: data });

    if (isPrimary) {
      primaryOk = patchRes.ok;
      if (!patchRes.ok) {
        primaryError = data;
        if (action === ACTION_ACCEPT && looksLikePermissionRefusal(patchRes.status, data)) {
          needsBuyerAction = true;
        }
      }
    }
  }

  if (!primaryFound) {
    primaryError = { message: 'The stored escrow_item_id was not found among this transaction\u2019s items on Escrow.com' };
  }

  return { ok: primaryOk && primaryFound, needsBuyerAction, primaryError, itemCount: items.length, results };
}

/**
 * Marks the merchandise item received on behalf of the buyer. Unlike
 * 'accept', 'receive' IS on Escrow.com's approved on-behalf list, so this
 * one genuinely works with Bastion's own credentials.
 *
 * Receiving starts the inspection clock on Escrow.com's side. That matters:
 * the automatic accept-on-lapse backstop only runs once the item is marked
 * received, so calling this on carrier-confirmed delivery is what guarantees
 * the seller eventually gets paid even if the buyer never clicks anything.
 *
 * Failure here is non-fatal to the caller — it is reported, never thrown.
 */
async function markItemsReceived({ escrowTransactionId, email, apiKey, primaryItemId, asCustomer }) {
  const loaded = await fetchTransaction({ escrowTransactionId, email, apiKey });
  if (!loaded.ok) {
    return { ok: false, error: { message: 'Could not load transaction', status: loaded.status, detail: loaded.detail } };
  }

  const items = Array.isArray(loaded.txn.items) ? loaded.txn.items : [];
  const primary = items.find((i) => String(i.id) === String(primaryItemId));
  if (!primary) return { ok: false, error: { message: 'Merchandise item not found on Escrow.com' } };
  if (isItemReceived(primary) || isItemAlreadySettled(primary)) return { ok: true, alreadyReceived: true };

  const headers = {
    Authorization: escrowAuthHeader(email, apiKey),
    'Content-Type': 'application/json',
  };
  if (asCustomer) headers['As-Customer'] = asCustomer;

  const res = await fetch(
    `${ESCROW_API_BASE}/transaction/${encodeURIComponent(escrowTransactionId)}/item/${encodeURIComponent(primary.id)}`,
    { method: 'PATCH', headers, body: JSON.stringify({ action: ACTION_RECEIVE }) }
  );
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, response: data, error: res.ok ? null : data };
}

/**
 * Asks Escrow.com for a real landing-page URL for a given action, so the
 * buyer can complete it on Escrow.com's own site while signed in as
 * themselves. This is the documented escape hatch for exactly the actions a
 * partner cannot perform on someone's behalf.
 *
 * Returns null rather than throwing: a missing link degrades the UI to
 * "check your email", it does not break a transaction.
 */
async function getWebLink({ escrowTransactionId, action, email, apiKey }) {
  try {
    const res = await fetch(
      `${ESCROW_API_BASE}/transaction/${encodeURIComponent(escrowTransactionId)}/web_link/${encodeURIComponent(action)}`,
      { headers: { Authorization: escrowAuthHeader(email, apiKey), 'Content-Type': 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.landing_page || null;
  } catch (e) {
    console.error('getWebLink failed for action', action, e);
    return null;
  }
}

module.exports = {
  ESCROW_API_BASE,
  ACTION_ACCEPT,
  ACTION_CANCEL,
  ACTION_RECEIVE,
  escrowAuthHeader,
  isItemAlreadySettled,
  isItemReceived,
  fetchTransaction,
  applyActionToAllItems,
  markItemsReceived,
  getWebLink,
};
