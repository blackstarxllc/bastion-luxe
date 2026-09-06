// netlify/functions/_escrow-lib.js
//
// ============================================================
// WHY THIS FILE EXISTS
//
// release-escrow-transaction.js and admin-resolve-dispute.js each only
// ever acted on ONE escrow item — the merchandise item — via a single
// PATCH to /transaction/{id}/item/{escrow_item_id}. That was correct back
// when a transaction had exactly one item.
//
// It stopped being correct the moment a second item was added (the
// protection fee, then shipping). Neither of those items was EVER
// explicitly released or cancelled by any code path. The transaction
// itself moved to "released" in Bastion's own database, but the fee and
// shipping items sat on Escrow.com's side with no explicit action ever
// taken on them.
//
// This means: for every past transaction, shipped or not, Bastion's
// protection fee revenue was never confirmed to have been explicitly
// released. Whether Escrow.com auto-completes an item's schedule once its
// own inspection period elapses without a dispute is NOT something this
// codebase can verify without live confirmation from Escrow.com — and
// relying on undocumented auto-behavior for real revenue is not
// acceptable. The fix is to act on every item explicitly, every time.
//
// applyActionToAllItems() below fetches the full transaction, and applies
// the requested action ('release' or 'cancel') to every item that isn't
// already settled. The merchandise item is treated as the PRIMARY item —
// its outcome determines overall success, since that's the item the
// buyer/seller relationship is actually about. Fee and shipping items are
// best-effort: a failure on one of those is logged for admin follow-up
// but does not block the primary transaction from completing, because a
// buyer waiting on their money should not be stuck behind an unrelated
// fee-collection problem.
// ============================================================

const ESCROW_API_BASE = process.env.ESCROW_LIVE_MODE === 'true'
  ? 'https://api.escrow.com/2017-09-01'
  : 'https://api.escrow-sandbox.com/2017-09-01';

function escrowAuthHeader(email, apiKey) {
  return 'Basic ' + Buffer.from(`${email}:${apiKey}`).toString('base64');
}

// Escrow.com has used a few different status shapes elsewhere in this
// codebase (see deriveStatus in escrow-webhook.js) — a plain string, or an
// object of booleans. Handle both rather than assuming one.
function isItemAlreadySettled(item) {
  if (!item) return false;
  if (typeof item.status === 'string') {
    return ['released', 'completed', 'cancelled', 'rejected'].includes(item.status);
  }
  const s = item.status || {};
  return !!(s.released || s.completed || s.cancelled || s.rejected);
}

/**
 * Fetches the live transaction from Escrow.com and applies `action`
 * ('release' or 'cancel') to every item that isn't already settled.
 *
 * Returns:
 *   {
 *     ok: boolean,              // whether the PRIMARY item succeeded
 *     primaryError: object|null,
 *     itemCount: number,
 *     results: [{ id, title, ok|skipped, status, response }]
 *   }
 */
async function applyActionToAllItems({ escrowTransactionId, action, email, apiKey, primaryItemId }) {
  const authHeader = escrowAuthHeader(email, apiKey);

  const getRes = await fetch(
    `${ESCROW_API_BASE}/transaction/${encodeURIComponent(escrowTransactionId)}`,
    { headers: { Authorization: authHeader } }
  );

  if (!getRes.ok) {
    const detail = await getRes.text().catch(() => '');
    return {
      ok: false,
      primaryError: { message: 'Could not load the Escrow.com transaction', status: getRes.status, detail: detail.slice(0, 500) },
      itemCount: 0,
      results: [],
    };
  }

  const txn = await getRes.json();
  const items = Array.isArray(txn.items) ? txn.items : [];
  const results = [];
  let primaryOk = false;
  let primaryError = null;
  let primaryFound = false;

  for (const item of items) {
    const isPrimary = String(item.id) === String(primaryItemId);
    if (isPrimary) primaryFound = true;

    if (isItemAlreadySettled(item)) {
      results.push({ id: item.id, title: item.title, skipped: true, reason: 'already settled' });
      if (isPrimary) primaryOk = true;
      continue;
    }

    const patchRes = await fetch(
      `${ESCROW_API_BASE}/transaction/${encodeURIComponent(escrowTransactionId)}/item/${encodeURIComponent(item.id)}`,
      {
        method: 'PATCH',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }
    );
    const data = await patchRes.json().catch(() => ({}));

    results.push({ id: item.id, title: item.title, ok: patchRes.ok, status: patchRes.status, response: data });

    if (isPrimary) {
      primaryOk = patchRes.ok;
      if (!patchRes.ok) primaryError = data;
    }
  }

  if (!primaryFound) {
    primaryError = { message: 'The stored escrow_item_id was not found among this transaction\u2019s items on Escrow.com' };
  }

  return { ok: primaryOk && primaryFound, primaryError, itemCount: items.length, results };
}

module.exports = { ESCROW_API_BASE, escrowAuthHeader, isItemAlreadySettled, applyActionToAllItems };
