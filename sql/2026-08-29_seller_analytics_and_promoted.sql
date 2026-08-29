-- Bastion: Seller Analytics & Promoted Listings.
-- Adds a view counter and a promoted flag to listings. View counting goes
-- through a security-definer function rather than opening UPDATE access on
-- deals to anonymous visitors — the function can only ever increment the
-- one views column, nothing else.
-- Run once in the Supabase SQL editor.

alter table public.deals add column if not exists views integer not null default 0;
alter table public.deals add column if not exists promoted boolean not null default false;

create or replace function public.increment_deal_view(p_deal_id text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.deals set views = views + 1 where id = p_deal_id;
$$;

revoke all on function public.increment_deal_view(text) from public;
grant execute on function public.increment_deal_view(text) to anon, authenticated;

-- NOTE: "promoted" is a manual flag for now, toggled from the Admin panel —
-- there's no self-serve payment flow for sellers to buy promotion yet.
-- Building that would mean a real payment collection step (a small paid
-- add-on beyond the escrow fee), which is a meaningfully bigger feature on
-- its own. This gives you the on/off switch and the marketplace display
-- logic; wiring up actual payment for it is a separate, later decision.
