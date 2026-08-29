-- Bastion: Saved Searches & Price Alerts. A buyer saves a category/price/
-- keyword/condition combination; the moment a new listing goes active that
-- matches it, they get a real notification (bell + email, since it reuses
-- the same notifications table everything else already runs through).
-- Run once in the Supabase SQL editor.

create table if not exists public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text,
  category text,
  keyword text,
  min_price numeric,
  max_price numeric,
  condition text,
  created_at timestamptz not null default now()
);

create index if not exists idx_saved_searches_user_id on public.saved_searches(user_id, created_at desc);

alter table public.saved_searches enable row level security;

create policy "users manage their own saved searches"
on public.saved_searches for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create or replace function public.notify_matching_saved_searches()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  search_row record;
begin
  if new.status is distinct from 'active' then
    return new;
  end if;
  -- only fire on genuinely new listings, or a listing just turning active —
  -- not on every unrelated edit to an already-active listing
  if tg_op = 'UPDATE' and old.status = 'active' then
    return new;
  end if;

  for search_row in
    select * from public.saved_searches ss
    where (ss.category is null or ss.category = new.category)
      and (ss.keyword is null or ss.keyword = '' or new.item_name ilike '%' || ss.keyword || '%')
      and (ss.min_price is null or new.price >= ss.min_price)
      and (ss.max_price is null or new.price <= ss.max_price)
      and (ss.condition is null or ss.condition = new.condition)
      and ss.user_id != new.seller_id
  loop
    insert into public.notifications (user_id, type, title, body, link)
    values (
      search_row.user_id,
      'saved_search',
      'New match for your saved search',
      '"' || coalesce(new.item_name, 'An item') || '" — $' || to_char(new.price, 'FM999,999,999.00'),
      'bastion-deal-detail.html?id=' || new.id
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_notify_matching_saved_searches_insert on public.deals;
create trigger trg_notify_matching_saved_searches_insert
after insert on public.deals
for each row execute function public.notify_matching_saved_searches();

drop trigger if exists trg_notify_matching_saved_searches_update on public.deals;
create trigger trg_notify_matching_saved_searches_update
after update on public.deals
for each row execute function public.notify_matching_saved_searches();
