-- Bastion: sends a real email (via a Netlify function calling Resend) the
-- moment a "money" notification is created — funded, funds released, a
-- dispute, or a cancellation. Chat messages are deliberately excluded to
-- avoid emailing someone for every single message.
--
-- SECURITY NOTE: this uses a shared secret so the Netlify function can
-- trust that a request really came from this trigger, and not from some
-- random person hitting the endpoint directly. Do NOT hardcode that
-- secret in this file. After running the block below, go set the actual
-- value yourself in the Supabase dashboard:
--   Project Settings → Vault → find "internal_webhook_secret" → edit it.
-- The same value must also exist in Netlify as INTERNAL_WEBHOOK_SECRET
-- (Site configuration → Environment variables) — the two must match
-- exactly, or every email attempt will fail with 401 Unauthorized.
--
-- Run once in the Supabase SQL editor.

create extension if not exists pg_net;

-- Creates the secret slot with a placeholder — go replace the placeholder
-- value in the Vault UI as described above before relying on this.
select vault.create_secret(
  'REPLACE-ME-IN-THE-SUPABASE-DASHBOARD-VAULT-UI',
  'internal_webhook_secret',
  'Shared secret so Postgres triggers can safely call Bastion Netlify functions'
) where not exists (
  select 1 from vault.secrets where name = 'internal_webhook_secret'
);

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
  -- Only email for money-moving events — not every chat message, to avoid spam.
  if new.type not in ('funded', 'funds_released', 'payment_issue', 'dispute') then
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

drop trigger if exists trg_send_email_for_notification on public.notifications;
create trigger trg_send_email_for_notification
after insert on public.notifications
for each row execute function public.send_email_for_notification();
