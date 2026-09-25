-- 2026-09-24 (b): additive changes, safe with both old and new site code.
-- APPLIED TO PRODUCTION 2026-09-24. Idempotent.

-- 1. Claim columns backing the atomic "exactly one caller" locks in
--    create-escrow-transaction.js and create-shipping-label.js.
alter table public.transactions add column if not exists escrow_claimed_at timestamptz;
alter table public.shipments    add column if not exists label_claimed_at  timestamptz;

-- The claim marker is server-owned, like every other escrow field.
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
  return new;
end $fn$;
revoke execute on function public.protect_transaction_columns() from public, anon, authenticated;

-- 2. Transactions had NO constraint on status at all: any string could be
--    written by a server function or an admin, and the UI would render
--    whatever it got. These are every status the code base uses.
alter table public.transactions drop constraint if exists transactions_status_check;
alter table public.transactions add constraint transactions_status_check
  check (status in ('pending_payment','funded','shipped','in_transit','delivered','released',
                    'disputed','cancelled','return_approved','return_in_transit'));

-- 3. An accepted offer told the buyer to "message the other party to
--    arrange payment". On an escrow marketplace that is an instruction to
--    take the deal off-platform. It now points at the protected checkout.
create or replace function public.notify_on_offer_response()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare item_name text; maker_id uuid;
begin
  if new.status is distinct from old.status and new.status in ('accepted','declined') then
    select coalesce(d.item_name, 'an item') into item_name from public.deals d where d.id = new.deal_id;
    maker_id := case when new.made_by = 'buyer' then new.buyer_id else new.seller_id end;
    insert into public.notifications (user_id, type, title, body, link)
    values (
      maker_id, 'offer',
      case when new.status = 'accepted' then 'Your offer was accepted' else 'Your offer was declined' end,
      '$' || to_char(new.amount, 'FM999,999,999.00') || ' for "' || item_name || '"' ||
        case when new.status = 'accepted' and new.made_by = 'buyer'
               then '. Complete your purchase through Bastion''s protected checkout on the listing page. Never pay outside Bastion.'
             when new.status = 'accepted'
               then '. The buyer can now complete the purchase through Bastion''s protected checkout.'
             else '.' end,
      'bastion-deal-detail.html?id=' || new.deal_id
    );
  end if;
  return new;
end $fn$;

-- 4. Private profile fields, served only to their owner or to an admin.
--    Column privileges on public.profiles are tightened in migration (c),
--    which runs AFTER the site code that uses these functions is live.
create or replace function public.get_my_profile_private()
returns jsonb language sql stable security definer
set search_path to 'public','pg_temp' as $$
  select jsonb_build_object(
    'display_name', p.display_name, 'phone', p.phone, 'bio', p.bio,
    'notify_email', p.notify_email, 'notify_offers', p.notify_offers, 'notify_shipping', p.notify_shipping,
    'is_banned', p.is_banned, 'ban_reason', p.ban_reason)
  from public.profiles p where p.id = (select auth.uid());
$$;
revoke execute on function public.get_my_profile_private() from public, anon;
grant execute on function public.get_my_profile_private() to authenticated;

create or replace function public.admin_list_profiles(p_search text default null)
returns setof public.profiles language plpgsql stable security definer
set search_path to 'public','pg_temp' as $$
begin
  if not exists (select 1 from public.profiles a where a.id = (select auth.uid()) and a.is_admin) then
    raise exception 'Admin access required.';
  end if;
  return query
    select * from public.profiles p
     where p_search is null or p.handle ilike '%' || p_search || '%'
     order by p.created_at desc nulls last
     limit 50;
end $$;
revoke execute on function public.admin_list_profiles(text) from public, anon;
grant execute on function public.admin_list_profiles(text) to authenticated;

revoke execute on function public.notify_on_offer_response() from public, anon, authenticated;
