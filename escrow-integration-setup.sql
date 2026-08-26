-- Run this once in Supabase SQL editor before using the new escrow functions.
-- Adds columns needed to track the real Escrow.com transaction alongside
-- Bastion's existing internal transaction row.

alter table transactions
  add column if not exists escrow_transaction_id text,
  add column if not exists escrow_status text;

comment on column transactions.escrow_transaction_id is 'The transaction ID returned by Escrow.com — links this Bastion row to the real escrow.com transaction';
comment on column transactions.escrow_status is 'Raw status string as last reported by Escrow.com (via webhook or API poll)';
