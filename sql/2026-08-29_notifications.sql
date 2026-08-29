-- Bastion: real notifications, replacing what was previously a bell icon
-- calling a table that didn't exist anywhere in this schema. Creates the
-- table, enables Realtime on it so the bell updates instantly, and adds
-- triggers that actually create a notification for the events that
-- matter: a new message, a payment landing in escrow, funds releasing,
-- and a dispute or cancellation.
-- Run once in the Supabase SQL editor.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user_id_created_at on public.notifications(user_id, created_at desc);
create index if not exists idx_notifications_user_id_unread on public.notifications(user_id) where is_read = false;

alter table public.notifications enable row level security;

create policy "users can view their own notifications"
on public.notifications for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "users can mark their own notifications read"
on public.notifications for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- So the bell updates the instant a row is inserted, no polling required.
alter publication supabase_realtime add table public.notifications;

-- New message → notify the recipient (not the sender)
create or replace function public.notify_on_new_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recipient_id uuid;
  sender_label text;
  preview text;
begin
  if new.conversation_id is not null then
    select case when c.buyer_id = new.sender_id then c.seller_id else c.buyer_id end
      into recipient_id
    from public.conversations c where c.id = new.conversation_id;
  else
    select case when t.buyer_id = new.sender_id then t.seller_id else t.buyer_id end
      into recipient_id
    from public.transactions t where t.id = new.transaction_id;
  end if;

  if recipient_id is null then
    return new;
  end if;

  select '@' || p.handle into sender_label from public.profiles p where p.id = new.sender_id;
  if sender_label is null then
    sender_label := 'Someone';
  end if;

  preview := coalesce(nullif(trim(new.body), ''), case when new.image_url is not null then '📷 Sent a photo' else 'Sent a message' end);
  if length(preview) > 80 then
    preview := left(preview, 77) || '...';
  end if;

  insert into public.notifications (user_id, type, title, body, link)
  values (
    recipient_id,
    'message',
    sender_label || ' sent you a message',
    preview,
    'bastion-messages.html?id=' || coalesce(new.conversation_id::text, '')
  );

  return new;
end;
$$;

drop trigger if exists trg_notify_on_new_message on public.messages;
create trigger trg_notify_on_new_message
after insert on public.messages
for each row execute function public.notify_on_new_message();

-- Transaction status changes → notify the relevant party (or both)
create or replace function public.notify_on_transaction_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'funded' then
      insert into public.notifications (user_id, type, title, body, link)
      values (new.seller_id, 'funded', 'Buyer has paid', '"' || coalesce(new.item_name, 'Your item') || '" is funded and held in escrow. You can proceed with the handoff.', 'bastion-transaction.html?id=' || new.id::text);

    elsif new.status = 'released' then
      insert into public.notifications (user_id, type, title, body, link)
      values (new.seller_id, 'funds_released', 'Funds released to you', '$' || to_char(coalesce(new.total, new.amount), 'FM999,999,999.00') || ' for "' || coalesce(new.item_name, 'your item') || '" has been released to your payout.', 'bastion-transaction.html?id=' || new.id::text);
      insert into public.notifications (user_id, type, title, body, link)
      values (new.buyer_id, 'funds_released', 'Trade complete', 'Funds for "' || coalesce(new.item_name, 'this item') || '" have been released to the seller. Thanks for trading on Bastion.', 'bastion-transaction.html?id=' || new.id::text);

    elsif new.status = 'disputed' then
      if new.escrow_status = 'cancelled' then
        insert into public.notifications (user_id, type, title, body, link)
        values (new.buyer_id, 'payment_issue', 'Transaction cancelled', '"' || coalesce(new.item_name, 'This transaction') || '" was cancelled — this can happen when required verification info is missing at Escrow.com. Contact support if you need help.', 'bastion-transaction.html?id=' || new.id::text);
        insert into public.notifications (user_id, type, title, body, link)
        values (new.seller_id, 'payment_issue', 'Transaction cancelled', '"' || coalesce(new.item_name, 'This transaction') || '" was cancelled — this can happen when required verification info is missing at Escrow.com. Contact support if you need help.', 'bastion-transaction.html?id=' || new.id::text);
      else
        insert into public.notifications (user_id, type, title, body, link)
        values (new.buyer_id, 'dispute', 'A dispute was opened', '"' || coalesce(new.item_name, 'Your transaction') || '" has a dispute — funds are on hold until it''s resolved.', 'bastion-transaction.html?id=' || new.id::text);
        insert into public.notifications (user_id, type, title, body, link)
        values (new.seller_id, 'dispute', 'A dispute was opened', '"' || coalesce(new.item_name, 'Your transaction') || '" has a dispute — funds are on hold until it''s resolved.', 'bastion-transaction.html?id=' || new.id::text);
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notify_on_transaction_status_change on public.transactions;
create trigger trg_notify_on_transaction_status_change
after update on public.transactions
for each row execute function public.notify_on_transaction_status_change();
