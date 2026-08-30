-- Bastion: pre-launch security hardening, done ahead of switching Escrow.com
-- from sandbox keys to real money. Findings from a full audit of the
-- database, storage, and the escrow chain.
--
-- Run once in the Supabase SQL editor.

-- ---------------------------------------------------------------------
-- 1. Trigger-only functions were exposed as public API endpoints.
--    Every function created during the recent feature work was callable
--    directly via /rest/v1/rpc/... by anyone, signed in or not. They are
--    only ever meant to fire automatically from their own triggers.
-- ---------------------------------------------------------------------
revoke execute on function public.mark_deal_pending_on_transaction() from public, anon, authenticated;
revoke execute on function public.prevent_duplicate_purchase() from public, anon, authenticated;
revoke execute on function public.notify_on_new_message() from public, anon, authenticated;
revoke execute on function public.notify_on_new_offer() from public, anon, authenticated;
revoke execute on function public.notify_on_offer_response() from public, anon, authenticated;
revoke execute on function public.notify_on_transaction_status_change() from public, anon, authenticated;
revoke execute on function public.notify_matching_saved_searches() from public, anon, authenticated;
revoke execute on function public.send_email_for_notification() from public, anon, authenticated;

-- These two ARE legitimate user-facing RPCs, but only for signed-in users.
revoke execute on function public.get_my_data() from public, anon;
revoke execute on function public.request_account_deletion() from public, anon;

-- ---------------------------------------------------------------------
-- 2. Transaction status could be set to anything by either party.
--    The "Buyers and sellers can update their transactions" RLS policy
--    is needed for the legitimate mark-shipped / confirm-receipt buttons,
--    but RLS can't restrict WHICH columns or values are written. Without
--    this guard, a seller could simply PATCH status='released' via the API
--    and skip the escrow release entirely -- corrupting the record and
--    firing a false "funds released" notification to the buyer.
--
--    This trigger enforces a legal state machine. The service role (the
--    escrow webhook and internal functions) and admins are unrestricted;
--    buyers and sellers may only make their specific legitimate moves.
-- ---------------------------------------------------------------------
create or replace function public.enforce_transaction_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  is_admin boolean;
  uid uuid;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  uid := (select auth.uid());

  -- No signed-in user means the service role (escrow webhook / internal
  -- function). Those are the trusted source of truth.
  if uid is null then
    return new;
  end if;

  select coalesce(p.is_admin, false) into is_admin from public.profiles p where p.id = uid;
  if is_admin then
    return new;
  end if;

  -- Seller confirms handoff
  if old.status = 'funded' and new.status = 'shipped' and uid = old.seller_id then
    return new;
  end if;
  -- Buyer confirms receipt / releases funds
  if old.status in ('funded','shipped') and new.status = 'released' and uid = old.buyer_id then
    return new;
  end if;
  -- Either party opens a dispute
  if old.status in ('funded','shipped') and new.status = 'disputed' and uid in (old.buyer_id, old.seller_id) then
    return new;
  end if;

  raise exception 'Not allowed to change transaction status from % to %.', old.status, new.status;
end;
$$;

revoke execute on function public.enforce_transaction_status_transition() from public, anon, authenticated;

drop trigger if exists trg_enforce_transaction_status_transition on public.transactions;
create trigger trg_enforce_transaction_status_transition
before update on public.transactions
for each row execute function public.enforce_transaction_status_transition();

-- ---------------------------------------------------------------------
-- 3. Storage buckets had no size or file-type limits at all.
--    Anyone could upload a multi-gigabyte file, or an executable renamed
--    to look like a photo. Now capped at 10MB and images only, enforced
--    by the storage layer itself rather than only by browser-side checks.
-- ---------------------------------------------------------------------
update storage.buckets
set file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic','image/heif']
where id in ('listing-photos','message-photos');

-- ---------------------------------------------------------------------
-- 4. Missing indexes on foreign keys flagged by the performance advisor.
-- ---------------------------------------------------------------------
create index if not exists idx_offers_parent_offer_id on public.offers(parent_offer_id);
create index if not exists idx_support_requests_user_id on public.support_requests(user_id);

-- ---------------------------------------------------------------------
-- STILL REQUIRES A MANUAL STEP IN THE SUPABASE DASHBOARD:
--   Authentication -> Providers -> Email -> enable "leaked password
--   protection". This checks new passwords against known-breached
--   password lists. It cannot be enabled from SQL.
-- ---------------------------------------------------------------------
