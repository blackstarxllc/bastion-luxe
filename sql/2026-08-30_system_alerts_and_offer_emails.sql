-- Bastion: two things, in response to a real review of the previous
-- webhook change.
--
-- 1. Making the escrow webhook non-blocking (always return 200, even on
--    failure) closes the "auto-disabled after too many failures" risk,
--    but on its own it trades that for silence -- a genuine sync failure
--    would only show up in Netlify's function logs, which nobody is
--    watching in real time. This table closes that gap: every real
--    failure (webhook or transaction-creation side) is written here,
--    visible in the Admin panel's new "System Alerts" section, without
--    ever surfacing anything to the buyer or seller.
--
-- 2. Offers and counters were only ever creating in-app bell
--    notifications -- 'offer' was missing from the list of notification
--    types that also trigger a real email. Fixed, and tested live: a
--    test offer notification was inserted and confirmed to actually
--    send (net.http_response showed {"sent":true}) before this was
--    shipped. Also added 'saved_search' to the same list, for the same
--    reason -- a new listing matching a saved search is exactly the
--    kind of thing worth an email for, not just a bell.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.system_alerts (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  message text not null,
  context jsonb,
  transaction_id uuid references public.transactions(id) on delete set null,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_system_alerts_unresolved on public.system_alerts(created_at desc) where resolved = false;

alter table public.system_alerts enable row level security;

create policy "admins can view system alerts"
on public.system_alerts for select
to authenticated
using (exists (select 1 from public.profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));

create policy "admins can update system alerts"
on public.system_alerts for update
to authenticated
using (exists (select 1 from public.profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true))
with check (exists (select 1 from public.profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));

create or replace function public.send_email_for_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recipient_email text;
  webhook_secret text;
begin
  if new.type not in ('funded', 'funds_released', 'payment_issue', 'dispute', 'offer', 'saved_search') then
    return new;
  end if;

  select email into recipient_email from auth.users where id = new.user_id;
  if recipient_email is null then
    return new;
  end if;

  select decrypted_secret into webhook_secret
  from vault.decrypted_secrets where name = 'internal_webhook_secret';

  if webhook_secret is null then
    return new;
  end if;

  perform net.http_post(
    url := 'https://bastionmarket.com/.netlify/functions/send-notification-email',
    body := jsonb_build_object(
      'to_email', recipient_email,
      'subject', new.title,
      'title', new.title,
      'body', new.body,
      'link', new.link
    ),
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', webhook_secret),
    timeout_milliseconds := 8000
  );

  return new;
end;
$$;
