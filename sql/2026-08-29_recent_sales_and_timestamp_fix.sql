-- Bastion: two things.
--
-- 1) Bug fix found while building Price History: funded_at, shipped_at, and
--    released_at were never being set anywhere in the app — the columns
--    existed but every transaction had them permanently null, regardless of
--    when it actually happened. The real fix is in the application code
--    (escrow-webhook.js, bastion-transaction.html, bastion-admin.html all
--    needed the missing timestamp added to their status-update calls) — the
--    one-time backfill below just repairs existing rows using created_at as
--    a reasonable stand-in, since the real historical timestamp is gone.
--
-- 2) get_recent_sales(): a security-definer function that returns ONLY
--    item name, sold price, and sold date for released transactions in a
--    given category — never buyer_id, seller_id, or anything else. This is
--    what lets Price History show real market data to any visitor without
--    exposing who bought or sold anything (the transactions table itself
--    stays locked down to just its two participants, as it should be).
--
-- Run once in the Supabase SQL editor.

update public.transactions
set released_at = created_at
where status = 'released' and released_at is null;

create or replace function public.get_recent_sales(p_category text, p_exclude_deal_id text default null, p_limit int default 5)
returns table(item_name text, sold_price numeric, sold_at timestamptz)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select d.item_name, t.total as sold_price, t.released_at as sold_at
  from public.transactions t
  join public.deals d on d.id = t.deal_id
  where d.category = p_category
    and t.status = 'released'
    and t.released_at is not null
    and (p_exclude_deal_id is null or d.id != p_exclude_deal_id)
  order by t.released_at desc
  limit least(p_limit, 20);
$$;

revoke all on function public.get_recent_sales(text, text, int) from public;
grant execute on function public.get_recent_sales(text, text, int) to anon, authenticated;
