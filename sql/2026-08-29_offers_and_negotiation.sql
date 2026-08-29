-- Bastion: Offers & Negotiation. A buyer can propose a price on any active
-- listing; the seller can accept, decline, or counter — and either side can
-- keep countering. Each row is one "turn" in the negotiation (chained via
-- parent_offer_id); the most recent row per (deal_id, buyer_id) pair is the
-- current state of that thread. Reuses the existing notifications system —
-- no separate email/push plumbing needed, the same triggers that power
-- messages and transaction-status notifications cover offers too.
-- Run once in the Supabase SQL editor.

create table if not exists public.offers (
  id uuid primary key default gen_random_uuid(),
  deal_id text not null references public.deals(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  seller_id uuid not null references auth.users(id) on delete cascade,
  amount numeric not null check (amount > 0),
  made_by text not null check (made_by in ('buyer','seller')),
  status text not null default 'pending' check (status in ('pending','accepted','declined','withdrawn')),
  message text,
  parent_offer_id uuid references public.offers(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '72 hours'),
  created_at timestamptz not null default now()
);

create index if not exists idx_offers_deal_id on public.offers(deal_id);
create index if not exists idx_offers_buyer_id on public.offers(buyer_id, created_at desc);
create index if not exists idx_offers_seller_id on public.offers(seller_id, created_at desc);
create index if not exists idx_offers_thread on public.offers(deal_id, buyer_id, created_at desc);

alter table public.offers enable row level security;

create policy "participants can view their offers"
on public.offers for select
to authenticated
using ((select auth.uid()) = buyer_id or (select auth.uid()) = seller_id);

-- Buyers can open or continue a negotiation as themselves
create policy "buyer can make or counter an offer"
on public.offers for insert
to authenticated
with check (
  made_by = 'buyer' and buyer_id = (select auth.uid())
  and not exists (select 1 from public.profiles where profiles.id = (select auth.uid()) and profiles.is_banned = true)
);

-- Sellers can only respond as the real listing owner — prevents someone
-- forging a fake "seller counter-offer" on a listing they don't own.
create policy "seller can counter as the real listing owner"
on public.offers for insert
to authenticated
with check (
  made_by = 'seller' and seller_id = (select auth.uid())
  and exists (select 1 from public.deals d where d.id = offers.deal_id and d.seller_id = (select auth.uid()))
);

-- The recipient of a pending offer (whoever did NOT make it) can accept or decline it
create policy "recipient can respond to a pending offer"
on public.offers for update
to authenticated
using (
  status = 'pending' and (
    (made_by = 'buyer' and seller_id = (select auth.uid()))
    or (made_by = 'seller' and buyer_id = (select auth.uid()))
  )
)
with check (status in ('accepted','declined'));

-- A buyer can withdraw their own still-pending offer
create policy "buyer can withdraw their own pending offer"
on public.offers for update
to authenticated
using (made_by = 'buyer' and buyer_id = (select auth.uid()) and status = 'pending')
with check (status = 'withdrawn');

-- New offer / counter → notify the other party
create or replace function public.notify_on_new_offer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recipient_id uuid;
  item_name text;
  sender_label text;
begin
  select coalesce(d.item_name, 'an item') into item_name from public.deals d where d.id = new.deal_id;

  if new.made_by = 'buyer' then
    recipient_id := new.seller_id;
    select '@' || p.handle into sender_label from public.profiles p where p.id = new.buyer_id;
  else
    recipient_id := new.buyer_id;
    select '@' || p.handle into sender_label from public.profiles p where p.id = new.seller_id;
  end if;
  if sender_label is null then sender_label := 'Someone'; end if;

  insert into public.notifications (user_id, type, title, body, link)
  values (
    recipient_id,
    'offer',
    case when new.parent_offer_id is null then sender_label || ' made an offer' else sender_label || ' countered' end,
    '$' || to_char(new.amount, 'FM999,999,999.00') || ' for "' || item_name || '"' || case when new.message is not null and new.message <> '' then ' — "' || left(new.message, 100) || '"' else '' end,
    'bastion-deal-detail.html?id=' || new.deal_id
  );

  return new;
end;
$$;

drop trigger if exists trg_notify_on_new_offer on public.offers;
create trigger trg_notify_on_new_offer
after insert on public.offers
for each row execute function public.notify_on_new_offer();

-- Accept / decline → notify whoever made the offer that was responded to
create or replace function public.notify_on_offer_response()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item_name text;
  maker_id uuid;
begin
  if new.status is distinct from old.status and new.status in ('accepted','declined') then
    select coalesce(d.item_name, 'an item') into item_name from public.deals d where d.id = new.deal_id;
    maker_id := case when new.made_by = 'buyer' then new.buyer_id else new.seller_id end;

    insert into public.notifications (user_id, type, title, body, link)
    values (
      maker_id,
      'offer',
      case when new.status = 'accepted' then 'Your offer was accepted' else 'Your offer was declined' end,
      '$' || to_char(new.amount, 'FM999,999,999.00') || ' for "' || item_name || '"' ||
        case when new.status = 'accepted' then ' — message the other party to arrange payment.' else '.' end,
      'bastion-deal-detail.html?id=' || new.deal_id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notify_on_offer_response on public.offers;
create trigger trg_notify_on_offer_response
after update on public.offers
for each row execute function public.notify_on_offer_response();

-- KNOWN SIMPLIFICATION: when a counter-offer is sent, the previous row in
-- that thread is left as-is (still 'pending') rather than being marked
-- superseded — the app only ever reads the most recent row per thread, so
-- this has no visible effect, it just means older rows are inert history
-- rather than explicitly closed out.
