-- 2026-09-24 (a) — Insert-time guards, listing protection, abuse limits.
-- APPLIED TO PRODUCTION 2026-09-24. Idempotent; safe to re-run.
--
-- WHY: live testing on 2026-09-24 proved two critical exploits, both through
-- INSERT paths that no previous fix covered (the 2026-09-20 hardening froze
-- offers and transactions against UPDATE only):
--
--   1. A buyer inserted an offer with status='accepted', amount=1 on a
--      $230,000 listing. enforce_transaction_pricing() then priced their
--      order at $1.06. No seller involvement at all.
--   2. A buyer inserted a transaction with status='funded', funded_at set,
--      a seller_id that was not the listing owner, and an arbitrary
--      item_name. A seller seeing "funded" ships a real item for free.
--
-- Both tests ran inside a rolled-back transaction; nothing was saved.
--
-- DESIGN NOTE: the guard functions below are SECURITY INVOKER and key off
-- current_user. For a request arriving through the API, current_user is
-- 'authenticated' or 'anon'. For work done inside our own SECURITY DEFINER
-- functions and triggers (view counter, deal-pending sync, return approval)
-- it is the function owner, and for serverless functions it is service_role.
-- auth.uid() cannot make that distinction, because it stays set inside a
-- definer function called by a signed-in user.

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function public.bastion_is_client_request()
returns boolean language sql stable security invoker
set search_path to 'public','pg_temp' as $$
  select current_user in ('authenticated','anon');
$$;

create or replace function public.bastion_caller_is_admin()
returns boolean language sql stable security invoker
set search_path to 'public','pg_temp' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = (select auth.uid())), false);
$$;

-- ---------------------------------------------------------------------------
-- 1. OFFERS — nothing about a new offer is taken on trust except its amount,
--    and the amount is bounded by the real listing price.
-- ---------------------------------------------------------------------------
alter table public.offers drop constraint if exists offers_status_check;
alter table public.offers add constraint offers_status_check
  check (status in ('pending','accepted','declined','withdrawn','countered'));

alter table public.offers add column if not exists responded_at timestamptz;

create or replace function public.guard_offer_insert()
returns trigger language plpgsql security invoker
set search_path to 'public','pg_temp' as $fn$
declare
  d record; parent record; uid uuid := (select auth.uid()); recent int;
begin
  if not public.bastion_is_client_request() then return new; end if;

  select id, seller_id, price, status, accepts_offers into d from public.deals where id = new.deal_id;
  if d.id is null then raise exception 'This listing no longer exists.'; end if;
  if d.status <> 'active' then raise exception 'This listing is not accepting offers right now.'; end if;

  new.seller_id  := d.seller_id;          -- never the caller's choice
  new.status     := 'pending';            -- an offer is born pending, always
  new.created_at := now();
  new.responded_at := null;
  if new.expires_at is null or new.expires_at <= now() or new.expires_at > now() + interval '7 days' then
    new.expires_at := now() + interval '72 hours';
  end if;

  if new.amount is null or new.amount <= 0 then
    raise exception 'Enter an offer amount above zero.';
  end if;
  if new.amount > d.price then
    raise exception 'An offer cannot be higher than the listing price. Use Buy Now instead.';
  end if;

  if new.parent_offer_id is not null then
    select * into parent from public.offers where id = new.parent_offer_id;
    if parent.id is null or parent.deal_id <> new.deal_id then
      raise exception 'That offer could not be found.';
    end if;
    if parent.status <> 'pending' or parent.expires_at <= now() then
      raise exception 'That offer is no longer open.';
    end if;
    if new.made_by = 'seller' and parent.made_by <> 'buyer' then
      raise exception 'You can only counter an offer the buyer made.';
    end if;
    if new.made_by = 'buyer' and parent.made_by <> 'seller' then
      raise exception 'You can only counter an offer the seller made.';
    end if;
    new.buyer_id := parent.buyer_id;      -- a counter stays between the same two people
  elsif new.made_by = 'seller' then
    raise exception 'A seller can only respond to an existing offer.';
  end if;

  if new.buyer_id = d.seller_id then
    raise exception 'You cannot make an offer on your own listing.';
  end if;
  if new.made_by = 'buyer' and new.buyer_id is distinct from uid then
    raise exception 'Not allowed.';
  end if;
  if new.made_by = 'seller' and d.seller_id is distinct from uid then
    raise exception 'Not allowed.';
  end if;

  select count(*) into recent from public.offers o
   where o.created_at > now() - interval '1 hour'
     and ((o.made_by = 'buyer' and o.buyer_id = uid) or (o.made_by = 'seller' and o.seller_id = uid));
  if recent >= 20 then
    raise exception 'You are sending offers too quickly. Please wait a little and try again.';
  end if;

  return new;
end $fn$;

drop trigger if exists trg_0_guard_offer_insert on public.offers;
create trigger trg_0_guard_offer_insert before insert on public.offers
  for each row execute function public.guard_offer_insert();

-- A counter supersedes the offer it answers, so the original can no longer
-- be accepted behind it. Runs as definer because the counter-maker is not the
-- party RLS lets update the parent.
create or replace function public.mark_parent_offer_countered()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
begin
  if new.parent_offer_id is not null then
    update public.offers set status = 'countered', responded_at = now()
     where id = new.parent_offer_id and status = 'pending';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_mark_parent_offer_countered on public.offers;
create trigger trg_mark_parent_offer_countered after insert on public.offers
  for each row execute function public.mark_parent_offer_countered();

-- Responding to an offer: freeze every column but status, and only allow a
-- real transition out of 'pending' on an unexpired offer for a live listing.
create or replace function public.freeze_offer_columns()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
begin
  if (select auth.uid()) is null then return new; end if;

  new.id := old.id; new.deal_id := old.deal_id;
  new.buyer_id := old.buyer_id; new.seller_id := old.seller_id;
  new.amount := old.amount; new.made_by := old.made_by; new.message := old.message;
  new.parent_offer_id := old.parent_offer_id;
  new.created_at := old.created_at; new.expires_at := old.expires_at;

  if new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'This offer is no longer open.';
    end if;
    if new.status = 'accepted' then
      if old.expires_at <= now() then
        raise exception 'This offer has expired.';
      end if;
      if not exists (select 1 from public.deals d where d.id = old.deal_id and d.status = 'active') then
        raise exception 'This listing is no longer available.';
      end if;
    end if;
    new.responded_at := now();
  else
    new.responded_at := old.responded_at;
  end if;
  return new;
end $fn$;

-- ---------------------------------------------------------------------------
-- 2. TRANSACTIONS — a new order is always born unpaid, belongs to the real
--    listing owner, carries the real item name, and has an immutable
--    fulfilment mode.
-- ---------------------------------------------------------------------------
alter table public.transactions add column if not exists fulfillment_mode text;
alter table public.transactions drop constraint if exists transactions_fulfillment_mode_check;
alter table public.transactions add constraint transactions_fulfillment_mode_check
  check (fulfillment_mode in ('in_person','shipped'));
alter table public.transactions add column if not exists shipping_verified_at timestamptz;

create or replace function public.guard_transaction_insert()
returns trigger language plpgsql security invoker
set search_path to 'public','pg_temp' as $fn$
declare
  d record; uid uuid := (select auth.uid()); recent int;
begin
  select id, seller_id, item_name, status, fulfilment into d from public.deals where id = new.deal_id;
  if d.id is null then raise exception 'This listing no longer exists.'; end if;

  -- Fulfilment mode is decided once, here, and never changes afterwards.
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
  new.dispute_reason  := null;
  new.dispute_details := null;
  new.shipping_verified_at := null;  -- only the server may vouch for a shipping price

  select count(*) into recent from public.transactions t
   where t.buyer_id = uid and t.created_at > now() - interval '1 hour';
  if recent >= 10 then
    raise exception 'Too many purchase attempts in a short time. Please wait a little and try again.';
  end if;
  return new;
end $fn$;

-- Named trg_0_* so it fires before trg_enforce_transaction_pricing
-- (Postgres fires same-timing triggers in name order): pricing must see the
-- final shipping_cost.
drop trigger if exists trg_0_guard_transaction_insert on public.transactions;
create trigger trg_0_guard_transaction_insert before insert on public.transactions
  for each row execute function public.guard_transaction_insert();

-- Pricing runs on INSERT only. It used to run on every UPDATE as well, and
-- the column-protection trigger only restores money columns for client
-- updates. So every service-role update — the escrow webhook, the release
-- function — silently re-priced the order from the listing's CURRENT price.
-- A seller editing the price after a sale would have changed the recorded
-- amount out from under the real Escrow.com transaction.
create or replace function public.enforce_transaction_pricing()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare
  d record; accepted_offer_amount numeric; ship_cost numeric;
begin
  select price, seller_id into d from public.deals where id = new.deal_id;
  if d.price is null then
    raise exception 'Cannot create transaction: deal % not found', new.deal_id;
  end if;

  select o.amount into accepted_offer_amount
    from public.offers o
   where o.deal_id = new.deal_id
     and o.buyer_id = new.buyer_id
     and o.seller_id = d.seller_id
     and o.status = 'accepted'
   order by o.responded_at desc nulls last, o.created_at desc
   limit 1;

  new.price := coalesce(accepted_offer_amount, d.price);
  new.fee   := public.calculate_protection_fee(new.price);
  ship_cost := greatest(coalesce(new.shipping_cost, 0), 0);
  new.shipping_cost := ship_cost;
  new.total := new.price + new.fee + ship_cost;
  return new;
end $fn$;

drop trigger if exists trg_enforce_transaction_pricing on public.transactions;
create trigger trg_enforce_transaction_pricing before insert on public.transactions
  for each row execute function public.enforce_transaction_pricing();

-- Fulfilment mode and shipping verification are server-owned after insert.
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
  new.funded_at := old.funded_at; new.released_at := old.released_at;
  new.fulfillment_mode := old.fulfillment_mode;
  new.shipping_verified_at := old.shipping_verified_at;
  return new;
end $fn$;

-- In-person handoff is now keyed to the recorded fulfilment mode, not to
-- whether a shipment row happens to exist yet.
create or replace function public.enforce_transaction_status_transition()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare uid uuid; has_shipment boolean;
begin
  if new.status is not distinct from old.status then return new; end if;
  uid := (select auth.uid());
  if uid is null then return new; end if;
  if public.bastion_caller_is_admin() then return new; end if;

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

-- ---------------------------------------------------------------------------
-- 3. DEALS — sellers edit their listing, not the marketplace's bookkeeping.
-- ---------------------------------------------------------------------------
create or replace function public.guard_deal_write()
returns trigger language plpgsql security invoker
set search_path to 'public','pg_temp' as $fn$
declare uid uuid := (select auth.uid()); recent int; live boolean;
begin
  if not public.bastion_is_client_request() then return new; end if;
  if public.bastion_caller_is_admin() then return new; end if;

  if tg_op = 'INSERT' then
    new.seller_id  := uid;
    new.status     := 'active';
    new.promoted   := false;
    new.views      := 0;
    new.created_at := now();
    select count(*) into recent from public.deals
     where seller_id = uid and created_at > now() - interval '24 hours';
    if recent >= 30 then
      raise exception 'You have created a lot of listings today. Please try again tomorrow or contact support.';
    end if;
    return new;
  end if;

  -- UPDATE
  new.id := old.id; new.seller_id := old.seller_id; new.created_at := old.created_at;
  new.views := old.views; new.promoted := old.promoted;

  if new.status is distinct from old.status then
    select exists (select 1 from public.transactions t where t.deal_id = old.id
                   and t.status in ('pending_payment','funded','shipped','in_transit','delivered',
                                    'disputed','return_approved','return_in_transit'))
      into live;
    if not ((old.status = 'active' and new.status = 'archived')
         or (old.status = 'archived' and new.status = 'active' and not live)) then
      raise exception 'You cannot change this listing''s status from % to %.', old.status, new.status;
    end if;
  end if;

  -- Once an item is under contract or sold, the listing is part of the
  -- transaction record (and of any dispute). Its substance is frozen.
  if old.status in ('pending','sold') then
    new.price := old.price; new.item_name := old.item_name; new.description := old.description;
    new.condition := old.condition; new.category := old.category; new.details := old.details;
    new.image_url := old.image_url; new.fulfilment := old.fulfilment;
    new.item_weight_oz := old.item_weight_oz; new.item_length_in := old.item_length_in;
    new.item_width_in := old.item_width_in; new.item_height_in := old.item_height_in;
    new.accepts_offers := old.accepts_offers;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_guard_deal_write on public.deals;
create trigger trg_guard_deal_write before insert or update on public.deals
  for each row execute function public.guard_deal_write();

-- ---------------------------------------------------------------------------
-- 4. MESSAGES — close the world-readable hole and the cross-conversation
--    injection, and rate-limit sending.
-- ---------------------------------------------------------------------------
-- "conversation_id IS NULL OR ..." made every message without a conversation
-- readable by ANYONE, signed in or not.
drop policy if exists "participants can view their conversation messages" on public.messages;
create policy "participants can view their conversation messages" on public.messages
  for select to authenticated using (
    conversation_id is not null and exists (
      select 1 from public.conversations c where c.id = messages.conversation_id
        and ((select auth.uid()) in (c.buyer_id, c.seller_id))));

drop policy if exists "Buyer and seller can read their messages" on public.messages;
create policy "Buyer and seller can read their messages" on public.messages
  for select to authenticated using (
    transaction_id is not null and exists (
      select 1 from public.transactions t where t.id = messages.transaction_id
        and ((select auth.uid()) in (t.buyer_id, t.seller_id))));

drop policy if exists "Admins can read all messages" on public.messages;
create policy "Admins can read all messages" on public.messages
  for select to authenticated using (public.bastion_caller_is_admin());

-- The transaction-based send rule never looked at conversation_id, so any
-- user with any transaction could post into a stranger's conversation.
drop policy if exists "Buyer and seller can send messages" on public.messages;
create policy "Buyer and seller can send messages" on public.messages
  for insert to authenticated with check (
    sender_id = (select auth.uid())
    and transaction_id is not null
    and not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_banned)
    and exists (select 1 from public.transactions t where t.id = messages.transaction_id
                and (select auth.uid()) in (t.buyer_id, t.seller_id))
    and (conversation_id is null or exists (
          select 1 from public.conversations c where c.id = messages.conversation_id
            and (select auth.uid()) in (c.buyer_id, c.seller_id))));

drop policy if exists "participants can send conversation messages" on public.messages;
create policy "participants can send conversation messages" on public.messages
  for insert to authenticated with check (
    sender_id = (select auth.uid())
    and conversation_id is not null
    and not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_banned)
    and exists (select 1 from public.conversations c where c.id = messages.conversation_id
                and (select auth.uid()) in (c.buyer_id, c.seller_id)));

drop policy if exists "participants can mark conversation messages read" on public.messages;
create policy "participants can mark conversation messages read" on public.messages
  for update to authenticated
  using (conversation_id is not null and exists (
    select 1 from public.conversations c where c.id = messages.conversation_id
      and (select auth.uid()) in (c.buyer_id, c.seller_id)))
  with check (conversation_id is not null and exists (
    select 1 from public.conversations c where c.id = messages.conversation_id
      and (select auth.uid()) in (c.buyer_id, c.seller_id)));

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
  select count(*) filter (where created_at > now() - interval '1 minute'),
         count(*) filter (where created_at > now() - interval '24 hours')
    into per_min, per_day
    from public.messages where sender_id = uid and created_at > now() - interval '24 hours';
  if per_min >= 20 or per_day >= 1000 then
    raise exception 'You are sending messages too quickly. Please wait a moment.';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_0_guard_message_insert on public.messages;
create trigger trg_0_guard_message_insert before insert on public.messages
  for each row execute function public.guard_message_insert();

create index if not exists idx_messages_sender_created on public.messages (sender_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. CONVERSATIONS — tied to the real listing; a seller may only open one
--    with someone who has actually engaged with that listing.
-- ---------------------------------------------------------------------------
drop policy if exists "participants can start a conversation" on public.conversations;
create policy "participants can start a conversation" on public.conversations
  for insert to authenticated with check (
    (select auth.uid()) in (buyer_id, seller_id)
    and buyer_id is distinct from seller_id
    and not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_banned)
    and (deal_id is null or exists (select 1 from public.deals d
                                    where d.id = conversations.deal_id and d.seller_id = conversations.seller_id))
    and ((select auth.uid()) = buyer_id
         or exists (select 1 from public.transactions t where t.deal_id = conversations.deal_id
                    and t.buyer_id = conversations.buyer_id and t.seller_id = conversations.seller_id)
         or exists (select 1 from public.offers o where o.deal_id = conversations.deal_id
                    and o.buyer_id = conversations.buyer_id and o.seller_id = conversations.seller_id)));

create or replace function public.guard_conversation_insert()
returns trigger language plpgsql security invoker
set search_path to 'public','pg_temp' as $fn$
declare recent int;
begin
  if not public.bastion_is_client_request() then return new; end if;
  new.created_at := now(); new.last_message_at := now();
  select count(*) into recent from public.conversations
   where (buyer_id = (select auth.uid()) or seller_id = (select auth.uid()))
     and created_at > now() - interval '1 hour';
  if recent >= 30 then
    raise exception 'You are starting conversations too quickly. Please wait a little.';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_0_guard_conversation_insert on public.conversations;
create trigger trg_0_guard_conversation_insert before insert on public.conversations
  for each row execute function public.guard_conversation_insert();

-- ---------------------------------------------------------------------------
-- 6. REVIEWS — only the real buyer, only after a completed sale, once.
-- ---------------------------------------------------------------------------
create unique index if not exists reviews_one_per_transaction on public.reviews (transaction_id);

create or replace function public.guard_review_insert()
returns trigger language plpgsql security invoker
set search_path to 'public','pg_temp' as $fn$
declare t record;
begin
  if not public.bastion_is_client_request() then return new; end if;
  if new.transaction_id is null then raise exception 'A review must belong to a completed order.'; end if;
  select buyer_id, seller_id, status into t from public.transactions where id = new.transaction_id;
  if t.buyer_id is null or t.buyer_id is distinct from (select auth.uid()) then
    raise exception 'Only the buyer on this order can review it.';
  end if;
  if t.status <> 'released' then
    raise exception 'You can leave a review once the order is complete.';
  end if;
  new.buyer_id := t.buyer_id; new.seller_id := t.seller_id; new.created_at := now();
  if length(coalesce(new.comment,'')) > 2000 then
    raise exception 'That review is too long (2,000 characters maximum).';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_0_guard_review_insert on public.reviews;
create trigger trg_0_guard_review_insert before insert on public.reviews
  for each row execute function public.guard_review_insert();

-- ---------------------------------------------------------------------------
-- 7. Abuse limits on reports, support requests and saved searches.
-- ---------------------------------------------------------------------------
create or replace function public.guard_report_insert()
returns trigger language plpgsql security invoker
set search_path to 'public','pg_temp' as $fn$
declare recent int;
begin
  if not public.bastion_is_client_request() then return new; end if;
  new.status := 'open'; new.created_at := now();
  select count(*) into recent from public.reports
   where reporter_id = (select auth.uid()) and created_at > now() - interval '1 hour';
  if recent >= 10 then raise exception 'You have sent several reports recently. Please wait a little.'; end if;
  return new;
end $fn$;
drop trigger if exists trg_0_guard_report_insert on public.reports;
create trigger trg_0_guard_report_insert before insert on public.reports
  for each row execute function public.guard_report_insert();

create or replace function public.guard_support_request_insert()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare recent int; global_recent int;
begin
  new.status := 'open'; new.created_at := now();
  if length(coalesce(new.message,'')) > 10000 then
    raise exception 'That message is too long.';
  end if;
  select count(*) into recent from public.support_requests
   where lower(email) = lower(new.email) and created_at > now() - interval '1 hour';
  select count(*) into global_recent from public.support_requests
   where created_at > now() - interval '1 hour';
  if recent >= 5 or global_recent >= 300 then
    raise exception 'We have received several requests from you recently. Please wait a little before sending another.';
  end if;
  return new;
end $fn$;
drop trigger if exists trg_0_guard_support_request_insert on public.support_requests;
create trigger trg_0_guard_support_request_insert before insert on public.support_requests
  for each row execute function public.guard_support_request_insert();

create unique index if not exists saved_searches_unique_per_user on public.saved_searches
  (user_id, coalesce(category,''), lower(coalesce(keyword,'')), coalesce(min_price,-1),
   coalesce(max_price,-1), coalesce(condition,''));

-- ---------------------------------------------------------------------------
-- 8. Housekeeping flagged by the Supabase security linter.
-- ---------------------------------------------------------------------------
-- Trigger functions are not meant to be callable over the API. (Firing a
-- trigger does not check EXECUTE, so revoking is safe.)
do $$
declare f text;
begin
  foreach f in array array[
    'block_delete_of_transacted_deal()','freeze_message_columns()','freeze_offer_columns()',
    'guard_offer_insert()','mark_parent_offer_countered()','guard_transaction_insert()',
    'guard_deal_write()','guard_message_insert()','guard_conversation_insert()',
    'guard_review_insert()','guard_report_insert()','guard_support_request_insert()',
    'enforce_transaction_pricing()','protect_transaction_columns()',
    'enforce_transaction_status_transition()']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- deal_is_shippable() was added on 2026-09-20 and never wired into anything.
drop function if exists public.deal_is_shippable(text);

-- "Recent sales" reported the buyer's TOTAL (price + protection fee +
-- shipping) as the item's sold price. Comparable-sales data should be the
-- item price.
create or replace function public.get_recent_sales(p_category text, p_exclude_deal_id text default null, p_limit integer default 5)
returns table(item_name text, sold_price numeric, sold_at timestamptz)
language sql stable security definer set search_path to 'public','pg_temp' as $$
  select d.item_name, t.price as sold_price, t.released_at as sold_at
    from public.transactions t join public.deals d on d.id = t.deal_id
   where d.category = p_category and t.status = 'released' and t.released_at is not null
     and (p_exclude_deal_id is null or d.id <> p_exclude_deal_id)
   order by t.released_at desc
   limit least(greatest(p_limit,1), 20);
$$;
