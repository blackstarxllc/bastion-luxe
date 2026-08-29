-- Bastion: lets a seller turn off offers on a specific listing. Defaults to
-- true, so every existing listing and every new one going forward accepts
-- offers unless the seller explicitly opts out from the List an Item form.
-- Enforced server-side (not just hiding the button in the UI) — continuing
-- an existing negotiation is still always allowed even if the seller later
-- turns this off, since it would be unfair to cut off a conversation that
-- was already underway.
-- Run once in the Supabase SQL editor.

alter table public.deals add column if not exists accepts_offers boolean not null default true;

drop policy if exists "buyer can make or counter an offer" on public.offers;

create policy "buyer can make or counter an offer"
on public.offers for insert
to authenticated
with check (
  made_by = 'buyer' and buyer_id = (select auth.uid())
  and not exists (select 1 from public.profiles where profiles.id = (select auth.uid()) and profiles.is_banned = true)
  and (
    parent_offer_id is not null -- continuing an existing negotiation is always allowed
    or exists (select 1 from public.deals d where d.id = offers.deal_id and d.accepts_offers = true)
  )
);
