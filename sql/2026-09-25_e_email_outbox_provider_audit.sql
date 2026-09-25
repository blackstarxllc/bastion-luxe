-- 2026-09-25 (e): durable email delivery, provider action audit trail,
-- reconciliation cursors. APPLIED TO PRODUCTION 2026-09-25. Idempotent.

-- 1. EMAIL OUTBOX. Notification emails were fire-and-forget: the database
--    called the send function through pg_net and never looked at the answer,
--    so a failed send was never retried and nobody was told. Each emailable
--    notification now carries a delivery status. send-notification-email
--    records 'sent' or 'failed'; the hourly sweep retries 'queued' (never
--    answered) and 'failed' up to 3 times within 48 hours, using a Resend
--    idempotency key so a retry can never produce a duplicate email.
alter table public.notifications add column if not exists email_status   text;
alter table public.notifications add column if not exists email_sent_at  timestamptz;
alter table public.notifications add column if not exists email_error    text;
alter table public.notifications add column if not exists email_attempts int not null default 0;
alter table public.notifications drop constraint if exists notifications_email_status_check;
alter table public.notifications add constraint notifications_email_status_check
  check (email_status is null or email_status in ('queued','sent','failed'));
create index if not exists idx_notifications_email_retry on public.notifications (created_at)
  where email_status in ('queued','failed');

-- The trigger change that marks emails 'queued' and passes notification_id
-- is in 2026-09-25_f_POST_DEPLOY_email_trigger.sql: it must go live only
-- once the send function that records 'sent' is deployed, otherwise the
-- retry job could re-send an email the old function already delivered.


-- Server-only lookup the sweep uses to rebuild a retry (recipient email lives
-- in auth.users, which the REST API cannot read).
create or replace function public.email_retry_batch(p_limit int default 25)
returns table(notification_id uuid, to_email text, subject text, body text, link text, attempts int)
language sql stable security definer set search_path to 'public','pg_temp' as $$
  select n.id, u.email::text, n.title, n.body, n.link, n.email_attempts
    from public.notifications n join auth.users u on u.id = n.user_id
   where n.email_status in ('queued','failed') and n.email_sent_at is null
     and n.email_attempts < 3
     and n.created_at < now() - interval '10 minutes'
     and n.created_at > now() - interval '48 hours'
   order by n.created_at
   limit least(greatest(p_limit,1), 100);
$$;
revoke execute on function public.email_retry_batch(int) from public, anon, authenticated;

-- 2. PROVIDER ACTION AUDIT TRAIL (Audit #4 P1-16). Every call Bastion makes
--    to Escrow.com that can move or commit money (create, ship, receive,
--    accept, cancel) is written here: who, what, which order, the provider's
--    exact answer. In a six-figure dispute this is the record of what Bastion
--    asked for and what Escrow.com said back. Server-only writes; admin reads.
create table if not exists public.provider_actions (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null check (provider in ('escrow','easypost')),
  action          text not null,
  transaction_id  uuid,
  external_id     text,
  item_id         text,
  as_customer     text,
  initiated_by    text,
  http_status     int,
  ok              boolean,
  response        jsonb,
  created_at      timestamptz not null default now()
);
alter table public.provider_actions enable row level security;
drop policy if exists "admins read provider actions" on public.provider_actions;
create policy "admins read provider actions" on public.provider_actions
  for select to authenticated using (public.bastion_caller_is_admin());
revoke all on public.provider_actions from anon;
revoke insert, update, delete, truncate on public.provider_actions from authenticated;
create index if not exists idx_provider_actions_txn on public.provider_actions (transaction_id, created_at desc);

-- 3. RECONCILIATION CURSORS (Audit #4 P1-5 / P1-15). The sweep checks the
--    least-recently-checked orders and parcels first and records when each
--    was last compared with its provider, so no order is starved and the
--    admin can see how fresh each comparison is.
alter table public.transactions add column if not exists provider_checked_at timestamptz;
alter table public.transactions add column if not exists provider_state      text;
alter table public.shipments    add column if not exists tracking_checked_at timestamptz;

-- The reconciliation fields are server-owned like every other provider field.
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
  new.provider_checked_at := old.provider_checked_at;
  new.provider_state := old.provider_state;
  if old.status = 'funded' and new.status = 'shipped' then
    new.shipped_at := now();
  else
    new.shipped_at := old.shipped_at;
  end if;
  if new.status = 'disputed' and old.status is distinct from 'disputed' and old.dispute_reason is null then
    new.dispute_reason  := left(coalesce(new.dispute_reason, ''), 200);
    new.dispute_details := left(new.dispute_details, 5000);
  else
    new.dispute_reason  := old.dispute_reason;
    new.dispute_details := old.dispute_details;
  end if;
  return new;
end $fn$;
revoke execute on function public.protect_transaction_columns() from public, anon, authenticated;
