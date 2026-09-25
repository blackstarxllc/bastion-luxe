-- 2026-09-24 (d): purchase serialisation, evidence freezing, message
-- cross-link guard, webhook inbox, label-claim journal.
-- APPLIED TO PRODUCTION 2026-09-24. Idempotent.

-- 1. PURCHASES ON ONE LISTING ARE SERIALISED.
--    prevent_duplicate_purchase() counts other live orders, but two INSERTs
--    arriving together each counted zero (neither was committed yet) and both
--    succeeded. A transaction-scoped advisory lock per listing makes the
--    second insert wait until the first commits, then its check sees it.
--    Together with the existing unique index idx_one_live_funded_txn_per_deal
--    (at most one funded-or-later order per listing, enforced on every
--    UPDATE), only one buyer can ever win a listing.
create or replace function public.guard_transaction_insert()
returns trigger language plpgsql security invoker
set search_path to 'public','pg_temp' as $fn$
declare
  d record; uid uuid := (select auth.uid()); recent int;
begin
  perform pg_advisory_xact_lock(hashtextextended('bastion_deal:' || new.deal_id, 0));

  select id, seller_id, item_name, status, fulfilment into d from public.deals where id = new.deal_id;
  if d.id is null then raise exception 'This listing no longer exists.'; end if;
  if d.fulfilment = 'meetup' then
    new.fulfillment_mode := 'in_person';
  elsif d.fulfilment = 'shipping' then
    new.fulfillment_mode := 'shipped';
  elsif new.fulfillment_mode is null then
    new.fulfillment_mode := case when coalesce(new.shipping_cost,0) > 0 then 'shipped' else 'in_person' end;
  end if;
  if new.fulfillment_mode = 'in_person' then
    new.shipping_cost := 0;
  end if;
  if not public.bastion_is_client_request() then return new; end if;
  if new.buyer_id is distinct from uid then raise exception 'Not allowed.'; end if;
  if uid = d.seller_id then raise exception 'You cannot buy your own listing.'; end if;
  if d.status not in ('active','pending') then
    raise exception 'This item is no longer available for purchase.';
  end if;
  new.seller_id      := d.seller_id;
  new.item_name      := d.item_name;
  new.status         := 'pending_payment';
  new.created_at     := now();
  new.funded_at      := null;
  new.shipped_at     := null;
  new.released_at    := null;
  new.escrow_transaction_id  := null;
  new.escrow_item_id         := null;
  new.escrow_status          := null;
  new.escrow_transaction_url := null;
  new.escrow_claimed_at      := null;
  new.dispute_reason  := null;
  new.dispute_details := null;
  new.shipping_verified_at := null;
  select count(*) into recent from public.transactions t
   where t.buyer_id = uid and t.created_at > now() - interval '1 hour';
  if recent >= 10 then
    raise exception 'Too many purchase attempts in a short time. Please wait a little and try again.';
  end if;
  return new;
end $fn$;
revoke execute on function public.guard_transaction_insert() from public, anon, authenticated;

-- 2. EVIDENCE FIELDS ARE WRITE-ONCE.
--    shipped_at and the dispute reason/details were editable by either party
--    at any time. A dispute record whose reason can be rewritten after the
--    fact is not evidence. Now: shipped_at is stamped by the database (never
--    the browser's clock) at the in-person handoff; the dispute reason is set
--    once, at the moment the dispute is opened, and frozen afterwards.
create or replace function public.protect_transaction_columns()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
begin
  if (select auth.uid()) is null then return new; end if;
  if public.bastion_caller_is_admin() then return new; end if;
  new.id := old.id; new.buyer_id := old.buyer_id; new.seller_id := old.seller_id;
  new.deal_id := old.deal_id; new.item_name := old.item_name;
  new.price := old.price; new.fee := old.fee; new.total := old.total;
  new.shipping_cost := old.shipping_cost; new.created_at := old.created_at;
  new.escrow_transaction_id := old.escrow_transaction_id;
  new.escrow_item_id := old.escrow_item_id;
  new.escrow_status := old.escrow_status;
  new.escrow_transaction_url := old.escrow_transaction_url;
  new.escrow_claimed_at := old.escrow_claimed_at;
  new.funded_at := old.funded_at; new.released_at := old.released_at;
  new.fulfillment_mode := old.fulfillment_mode;
  new.shipping_verified_at := old.shipping_verified_at;

  if old.status = 'funded' and new.status = 'shipped' then
    new.shipped_at := now();
  else
    new.shipped_at := old.shipped_at;
  end if;

  if new.status = 'disputed' and old.status is distinct from 'disputed' and old.dispute_reason is null then
    new.dispute_reason  := left(coalesce(new.dispute_reason, ''), 200);
    new.dispute_details := left(new.dispute_details, 5000);
  else
    new.dispute_reason  := old.dispute_reason;
    new.dispute_details := old.dispute_details;
  end if;
  return new;
end $fn$;
revoke execute on function public.protect_transaction_columns() from public, anon, authenticated;

-- 3. A BUYER MAY WITHDRAW AN ORDER THAT NEVER REACHED ESCROW.COM.
--    When checkout fails part-way (shipping could not be confirmed, Escrow.com
--    unreachable), the order row was left 'pending_payment' forever, holding
--    the listing 'pending' so nobody could buy it. The buyer can now cancel
--    it, but ONLY while no Escrow.com transaction exists: once one exists the
--    buyer could still pay it, so cancelling locally would strand real money.
create or replace function public.enforce_transaction_status_transition()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare uid uuid; has_shipment boolean;
begin
  if new.status is not distinct from old.status then return new; end if;
  uid := (select auth.uid());
  if uid is null then return new; end if;
  if public.bastion_caller_is_admin() then return new; end if;

  if old.status = 'pending_payment' and new.status = 'cancelled'
     and uid = old.buyer_id and old.escrow_transaction_id is null then
    return new;
  end if;

  select exists(select 1 from public.shipments s
                 where s.transaction_id = old.id and s.direction = 'outbound') into has_shipment;
  if old.status = 'funded' and new.status = 'shipped' and uid = old.seller_id
     and coalesce(old.fulfillment_mode,'in_person') = 'in_person' and not has_shipment then
    return new;
  end if;
  if old.status in ('funded','shipped','in_transit','delivered','return_in_transit')
     and new.status = 'disputed' and uid in (old.buyer_id, old.seller_id) then
    return new;
  end if;
  raise exception 'Not allowed to change transaction status from % to %.', old.status, new.status;
end $fn$;
revoke execute on function public.enforce_transaction_status_transition() from public, anon, authenticated;

-- 4. A MESSAGE CANNOT STITCH TWO UNRELATED DEALS TOGETHER.
--    A user who legitimately belongs to one transaction and one conversation
--    could post a message carrying both ids even when they concern different
--    listings, filing transaction evidence into an unrelated thread.
create or replace function public.guard_message_insert()
returns trigger language plpgsql security invoker
set search_path to 'public','pg_temp' as $fn$
declare uid uuid := (select auth.uid()); per_min int; per_day int;
begin
  if not public.bastion_is_client_request() then return new; end if;
  new.created_at := now();
  new.read_at := null;
  if length(coalesce(new.body,'')) > 5000 then
    raise exception 'That message is too long (5,000 characters maximum).';
  end if;
  if new.transaction_id is not null and new.conversation_id is not null and not exists (
       select 1 from public.conversations c join public.transactions t on t.id = new.transaction_id
        where c.id = new.conversation_id and c.deal_id = t.deal_id
          and c.buyer_id = t.buyer_id and c.seller_id = t.seller_id) then
    raise exception 'That conversation does not belong to this order.';
  end if;
  select count(*) filter (where created_at > now() - interval '1 minute'),
         count(*) filter (where created_at > now() - interval '24 hours')
    into per_min, per_day
    from public.messages where sender_id = uid and created_at > now() - interval '24 hours';
  if per_min >= 20 or per_day >= 1000 then
    raise exception 'You are sending messages too quickly. Please wait a moment.';
  end if;
  return new;
end $fn$;
revoke execute on function public.guard_message_insert() from public, anon, authenticated;

-- 5. WEBHOOK INBOX (Audit #3 P1-4 / P1-5). Every authenticated provider
--    event is recorded once, keyed by the provider's own event id (EasyPost)
--    or a hash of the exact body (Escrow.com, which sends no event id). A
--    replayed delivery is recognised and skipped; the raw payload is kept for
--    audit and support. Server-only writes; admins may read.
create table if not exists public.provider_events (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null check (provider in ('escrow','easypost')),
  event_key     text not null,
  object_ref    text,
  payload       jsonb,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  attempts      int not null default 0,
  last_error    text,
  unique (provider, event_key)
);
alter table public.provider_events enable row level security;
drop policy if exists "admins read provider events" on public.provider_events;
create policy "admins read provider events" on public.provider_events
  for select to authenticated using (public.bastion_caller_is_admin());
create index if not exists idx_provider_events_unprocessed on public.provider_events (received_at) where processed_at is null;
revoke all on public.provider_events from anon;
revoke insert, update, delete, truncate on public.provider_events from authenticated;

-- 6. LABEL PURCHASE JOURNAL. The EasyPost shipment a label is about to be
--    bought from is recorded BEFORE the purchase, so an interrupted purchase
--    can be looked up and adopted instead of paid for twice.
alter table public.shipments add column if not exists pending_provider_shipment_id text;
