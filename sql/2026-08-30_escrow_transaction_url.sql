-- Bastion: adds a place to store a direct link to a transaction on
-- Escrow.com's own site, captured from their API response when a
-- transaction is successfully created -- IF their response actually
-- includes one. Several likely field names are checked defensively
-- (url, transaction_url, landing_url, checkout_url, hosted_url) since
-- the exact response shape hasn't been confirmed against live
-- documentation. Nothing is ever fabricated: if none of those fields
-- are present, this stays null and the buyer falls back to checking
-- their email instead, exactly as before.
--
-- Run once in the Supabase SQL editor.

alter table public.transactions add column if not exists escrow_transaction_url text;
