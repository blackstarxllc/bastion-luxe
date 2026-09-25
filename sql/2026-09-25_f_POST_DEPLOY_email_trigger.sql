-- 2026-09-25 (f): APPLY ONLY AFTER the 2026-09-25 site code is deployed.
-- Claude applies this once the deploy is confirmed. Idempotent.
-- Marks each emailable notification 'queued' and passes its id to
-- send-notification-email, which records 'sent' / 'failed'; the hourly sweep
-- retries anything left 'queued' or 'failed' (max 3, within 48 hours).
create or replace function public.send_email_for_notification()
returns trigger language plpgsql security definer
set search_path to 'public','pg_temp' as $function$
declare
  recipient_email text; webhook_secret text; prefs record;
begin
  if new.type not in ('funded','funds_released','payment_issue','dispute',
                      'offer','saved_search','shipping','transaction') then
    return new;
  end if;
  select email into recipient_email from auth.users where id = new.user_id;
  if recipient_email is null then return new; end if;
  select coalesce(p.notify_email, true) as notify_email,
         coalesce(p.notify_offers, true) as notify_offers,
         coalesce(p.notify_shipping, true) as notify_shipping
    into prefs from public.profiles p where p.id = new.user_id;
  if prefs is not null then
    if prefs.notify_email = false and new.type not in ('funds_released','dispute','payment_issue') then return new; end if;
    if new.type = 'shipping' and prefs.notify_shipping = false then return new; end if;
    if new.type = 'offer' and prefs.notify_offers = false then return new; end if;
  end if;
  select decrypted_secret into webhook_secret from vault.decrypted_secrets where name = 'internal_webhook_secret';
  if webhook_secret is null then
    insert into public.system_alerts (source, message, context)
    values ('notification_email', 'internal_webhook_secret missing from vault; notification emails cannot be sent',
            jsonb_build_object('notification_id', new.id, 'type', new.type));
    return new;
  end if;
  update public.notifications set email_status = 'queued' where id = new.id;
  perform net.http_post(
    url := 'https://bastionmarket.com/.netlify/functions/send-notification-email',
    body := jsonb_build_object('notification_id', new.id, 'to_email', recipient_email,
                               'subject', new.title, 'title', new.title, 'body', new.body, 'link', new.link),
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret', webhook_secret),
    timeout_milliseconds := 8000);
  return new;
end;
$function$;
revoke execute on function public.send_email_for_notification() from public, anon, authenticated;
