-- Bastion: fixes a serious, confirmed bug — the same listing could be
-- purchased by multiple different buyers, because the code responsible for
-- marking a listing "pending" after a purchase started ran from the
-- BUYER'S OWN session, and buyers were never allowed to update someone
-- else's listing (correctly, per your existing security rules). That
-- update failed silently every single time, so the listing stayed
-- "active" forever and could be bought again and again.
--
-- Confirmed against real data before this fix: two of your test listings
-- already had multiple "funded" and even multiple "released" transactions
-- against the same item. That existing bad data was NOT touched by this
-- migration — it needs a manual decision on how to handle it, not an
-- automatic cleanup.
--
-- Two triggers close this properly, server-side, regardless of who
-- initiates the purchase:
--   1. The moment a transaction is created, the matching listing is
--      automatically flipped to "pending" — via a function with elevated
--      permissions, not dependent on the buyer's own access.
--   2. A transaction can no longer even be CREATED against a listing that
--      isn't "active" — closing the race-condition gap, not just the
--      silent-failure gap.
--
-- Run once in the Supabase SQL editor.

create or replace function public.mark_deal_pending_on_transaction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.deals
  set status = 'pending'
  where id = new.deal_id and status = 'active';
  return new;
end;
$$;

drop trigger if exists trg_mark_deal_pending_on_transaction on public.transactions;
create trigger trg_mark_deal_pending_on_transaction
after insert on public.transactions
for each row execute function public.mark_deal_pending_on_transaction();

create or replace function public.prevent_duplicate_purchase()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deal_status text;
begin
  select status into deal_status from public.deals where id = new.deal_id;
  if deal_status is distinct from 'active' then
    raise exception 'This item is no longer available for purchase (status: %).', coalesce(deal_status, 'unknown');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_duplicate_purchase on public.transactions;
create trigger trg_prevent_duplicate_purchase
before insert on public.transactions
for each row execute function public.prevent_duplicate_purchase();
