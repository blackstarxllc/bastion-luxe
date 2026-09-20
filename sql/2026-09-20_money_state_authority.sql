-- 2026-09-20 — Money-state authority, evidence integrity, private media.
--
-- APPLIED TO PRODUCTION on 2026-09-20. This file is the executable source of
-- truth, not a note describing a change made elsewhere. Every statement here
-- is idempotent and safe to re-run against a fresh restore.
--
-- Background: the audit found that several security-critical changes existed
-- in this directory only as prose ("already applied" records), so a rebuild
-- could not reproduce production. That is why this migration is written out
-- in full.

-- ============================================================
-- 1. The browser is no longer an authority on money state.
--
-- The previous trigger explicitly permitted funded/shipped/in_transit/
-- delivered -> 'released' when auth.uid() = buyer_id. A buyer could PATCH
-- their own transaction to released with no proof that Escrow.com moved a
-- cent. That fired "funds released" notifications and marked the deal sold.
--
-- Compounding it: the release action being sent to Escrow.com ('release')
-- does not exist in their API, so the real escrow transaction stayed funded
-- every time while Bastion's record said otherwise.
--
-- 'released' is now writable only by the service role (the release function
-- and the escrow webhook, both of which verify with Escrow.com first) and by
-- an admin resolving a dispute.
--
-- Seller 'shipped' is likewise restricted to genuine in-person handoffs. On
-- an order with a shipment, fulfilment state comes from the carrier.
-- ============================================================
create or replace function public.enforce_transaction_status_transition()
returns trigger language plpgsql security definer
set search_path to 'public', 'pg_temp' as $function$
declare
  is_admin boolean; uid uuid; has_shipment boolean;
begin
  if new.status is not distinct from old.status then return new; end if;

  uid := (select auth.uid());
  if uid is null then return new; end if;  -- service role

  select coalesce(p.is_admin,false) into is_admin from public.profiles p where p.id = uid;
  if is_admin then return new; end if;

  select exists(select 1 from public.shipments s
                where s.transaction_id = old.id and s.direction='outbound')
    into has_shipment;

  if old.status='funded' and new.status='shipped'
     and uid = old.seller_id and not has_shipment then
    return new;
  end if;

  if old.status in ('funded','shipped','in_transit','delivered','return_in_transit')
     and new.status='disputed' and uid in (old.buyer_id, old.seller_id) then
    return new;
  end if;

  raise exception 'Not allowed to change transaction status from % to %.', old.status, new.status;
end; $function$;

-- ============================================================
-- 2. Offers are append-only in everything but status.
--
-- "recipient can respond to a pending offer" constrained only the NEW status
-- to accepted/declined. It froze nothing else. So a seller accepting a
-- buyer's $100 offer could rewrite amount to $10,000 in the same PATCH — and
-- enforce_transaction_pricing() reads the newest accepted offer amount and
-- makes it the transaction price. The mutated figure becomes the real bill.
-- ============================================================
create or replace function public.freeze_offer_columns()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $function$
begin
  if (select auth.uid()) is null then return new; end if;
  new.id:=old.id; new.deal_id:=old.deal_id;
  new.buyer_id:=old.buyer_id; new.seller_id:=old.seller_id;
  new.amount:=old.amount; new.made_by:=old.made_by; new.message:=old.message;
  new.parent_offer_id:=old.parent_offer_id;
  new.created_at:=old.created_at; new.expires_at:=old.expires_at;
  return new;
end; $function$;

drop trigger if exists trg_freeze_offer_columns on public.offers;
create trigger trg_freeze_offer_columns before update on public.offers
  for each row execute function public.freeze_offer_columns();

-- ============================================================
-- 3. Messages are dispute evidence, so only read_at may change.
--
-- Participants could update any column. A party able to rewrite a sent
-- message, or repoint an attachment URL, after a dispute opens destroys the
-- entire evidentiary value of the thread.
-- ============================================================
create or replace function public.freeze_message_columns()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $function$
begin
  if (select auth.uid()) is null then return new; end if;
  new.id:=old.id; new.transaction_id:=old.transaction_id;
  new.conversation_id:=old.conversation_id; new.sender_id:=old.sender_id;
  new.body:=old.body; new.image_url:=old.image_url; new.video_url:=old.video_url;
  new.created_at:=old.created_at;
  return new;  -- read_at intentionally writable
end; $function$;

drop trigger if exists trg_freeze_message_columns on public.messages;
create trigger trg_freeze_message_columns before update on public.messages
  for each row execute function public.freeze_message_columns();

drop policy if exists "no client deletes of messages" on public.messages;
create policy "no client deletes of messages" on public.messages
  for delete to authenticated, anon using (false);

drop policy if exists "no client deletes of offers" on public.offers;
create policy "no client deletes of offers" on public.offers
  for delete to authenticated, anon using (false);

-- ============================================================
-- 4. Private message media stops being world-readable.
--
-- 'message-photos' was a PUBLIC bucket and the client stored getPublicUrl()
-- results on the message row. Every photo and video sent inside a private
-- conversation was retrievable by anyone holding the URL, no login, forever.
-- ============================================================
update storage.buckets set public=false where id='message-photos';

drop policy if exists "anyone can view message photos" on storage.objects;
drop policy if exists "authenticated users can upload message photos" on storage.objects;

create policy "participants upload message media" on storage.objects
  for insert to authenticated with check (
    bucket_id='message-photos' and (storage.foldername(name))[1] in (
      select c.id::text from public.conversations c
      where c.buyer_id=(select auth.uid()) or c.seller_id=(select auth.uid())));

create policy "participants read message media" on storage.objects
  for select to authenticated using (
    bucket_id='message-photos' and (
      (storage.foldername(name))[1] in (
        select c.id::text from public.conversations c
        where c.buyer_id=(select auth.uid()) or c.seller_id=(select auth.uid()))
      or exists (select 1 from public.profiles p
                 where p.id=(select auth.uid()) and p.is_admin)));

-- Listing photos are genuinely public, but uploads were unrestricted: any
-- caller could write any object anywhere in the bucket.
drop policy if exists "Authenticated users can upload listing photos" on storage.objects;
create policy "sellers upload listing photos to own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id='listing-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "anyone can read listing photos" on storage.objects;
create policy "anyone can read listing photos" on storage.objects
  for select to authenticated, anon using (bucket_id='listing-photos');

-- ============================================================
-- 5. Either participant may open a conversation.
--
-- Only the buyer could INSERT one, but the transaction page offers "Message"
-- to both parties, so a seller messaging first hit a bare RLS failure.
-- ============================================================
drop policy if exists "buyer can start a conversation" on public.conversations;
drop policy if exists "participants can start a conversation" on public.conversations;
create policy "participants can start a conversation" on public.conversations
  for insert to authenticated with check (
    ((select auth.uid())=buyer_id or (select auth.uid())=seller_id)
    and buyer_id is distinct from seller_id
    and not exists (select 1 from public.profiles p
                    where p.id=(select auth.uid()) and p.is_banned=true));

-- ============================================================
-- 6. A listing with transaction history is never deletable.
--
-- Sellers had an unconditional DELETE policy on deals. Deleting a listing
-- must never detach the object behind a live transaction or an open dispute.
-- ============================================================
create or replace function public.block_delete_of_transacted_deal()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $function$
begin
  if exists (select 1 from public.transactions t where t.deal_id=old.id) then
    raise exception 'This listing has transaction history and cannot be deleted. Archive it instead.'
      using errcode='restrict_violation';
  end if;
  return old;
end; $function$;

drop trigger if exists trg_block_delete_of_transacted_deal on public.deals;
create trigger trg_block_delete_of_transacted_deal before delete on public.deals
  for each row execute function public.block_delete_of_transacted_deal();

alter table public.deals drop constraint if exists deals_status_check;
alter table public.deals add constraint deals_status_check
  check (status in ('active','pending','sold','archived','removed'));

create or replace function public.deal_is_shippable(p_deal_id text)
returns boolean language sql stable security definer
set search_path to 'public','pg_temp' as $function$
  select exists (select 1 from public.deals d
    join public.listing_private lp on lp.deal_id=d.id
    where d.id=p_deal_id
      and coalesce(lp.ships_from_city,'')<>''
      and coalesce(lp.ships_from_street1,'')<>''
      and coalesce(d.item_weight_oz,0)>0);
$function$;
