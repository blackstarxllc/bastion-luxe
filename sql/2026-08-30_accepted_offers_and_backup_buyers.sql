-- Bastion: two related changes to how a purchase actually gets created.
--
-- 1. An accepted offer now actually leads to a real transaction at the
--    negotiated price, instead of just telling both parties to "message
--    each other to arrange payment." The pricing guard that already
--    prevents a buyer from tampering with the price (it always looks up
--    the real listing price server-side) now ALSO checks whether this
--    exact buyer has an accepted offer on this exact listing, and uses
--    that negotiated amount instead if so. Still fully server-controlled
--    either way -- the buyer never supplies this number themselves.
--
-- 2. Backup buyers can now queue up on a listing that already has a
--    purchase in progress ("pending"), since that first buyer might not
--    follow through. The first transaction to actually reach "funded"
--    wins automatically; every other still-pending transaction on that
--    same listing is cancelled and its buyer is notified they were not
--    charged. A transaction is still fully blocked once the item is
--    actually sold or under dispute.
--
-- Run once in the Supabase SQL editor.

create or replace function public.enforce_transaction_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  live_price numeric;
  accepted_offer_amount numeric;
begin
  select price into live_price from deals where id = new.deal_id;
  if live_price is null then
    raise exception 'Cannot create transaction: deal % not found', new.deal_id;
  end if;

  select amount into accepted_offer_amount
  from public.offers
  where deal_id = new.deal_id
    and buyer_id = new.buyer_id
    and status = 'accepted'
  order by created_at desc
  limit 1;

  new.price := coalesce(accepted_offer_amount, live_price);
  new.fee := calculate_protection_fee(new.price);
  new.total := new.price + new.fee;

  return new;
end;
$$;

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
  if deal_status in ('sold', 'disputed') then
    raise exception 'This item is no longer available for purchase (status: %).', coalesce(deal_status, 'unknown');
  end if;
  return new;
end;
$$;

create or replace function public.cancel_other_pending_transactions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  other record;
begin
  if new.status = 'funded' and (old.status is distinct from 'funded') then
    for other in
      select * from public.transactions
      where deal_id = new.deal_id
        and id != new.id
        and status = 'pending_payment'
    loop
      update public.transactions set status = 'cancelled' where id = other.id;

      insert into public.notifications (user_id, type, title, body, link)
      values (
        other.buyer_id,
        'payment_issue',
        'This item sold to another buyer',
        '"' || coalesce(other.item_name, 'This item') || '" was purchased by someone else before your payment was confirmed. You have not been charged.',
        'bastion-marketplace.html'
      );
    end loop;
  end if;
  return new;
end;
$$;

revoke execute on function public.cancel_other_pending_transactions() from public, anon, authenticated;

drop trigger if exists trg_cancel_other_pending_transactions on public.transactions;
create trigger trg_cancel_other_pending_transactions
after update on public.transactions
for each row execute function public.cancel_other_pending_transactions();
