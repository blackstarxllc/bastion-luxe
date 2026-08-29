-- Bastion: adds a general location (city/state only — never a full address,
-- which stays private between matched buyer and seller) to listings, so a
-- buyer can tell at a glance whether an in-person trade is even realistic
-- before messaging the seller. Shows on Marketplace cards and the item page.
-- Run once in the Supabase SQL editor.

alter table public.deals add column if not exists city text;
alter table public.deals add column if not exists state text;
