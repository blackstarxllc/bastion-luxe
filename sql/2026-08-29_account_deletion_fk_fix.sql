-- Bastion: fixes a real bug found during a database audit — deals.buyer_id
-- and listings.seller_id were foreign-keyed to a legacy `public.users` table
-- instead of `auth.users` (the table every other user-referencing column in
-- this schema correctly points to). Since public.users was always empty,
-- the first real purchase or listing to actually set one of these columns
-- would have been rejected by Postgres with a foreign key violation.
-- Run once in the Supabase SQL editor.

alter table public.deals drop constraint if exists deals_buyer_id_fkey;
alter table public.deals add constraint deals_buyer_id_fkey
  foreign key (buyer_id) references auth.users(id);

alter table public.listings drop constraint if exists listings_seller_id_fkey;
alter table public.listings add constraint listings_seller_id_fkey
  foreign key (seller_id) references auth.users(id);

-- Safe to drop only after the fix above — confirmed nothing else referenced them.
drop table if exists public.users;
drop table if exists public.conversation_messages;
