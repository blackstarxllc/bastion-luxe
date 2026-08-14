-- Bastion: in-app buyer/seller messaging
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query) before using bastion-messages.html.
--
-- Assumes deals.id and auth.users.id are uuid, matching every other table in this schema
-- (profiles.id, transactions.buyer_id/seller_id, favorites.deal_id, etc). If deals.id turns
-- out not to be uuid, change the `deal_id uuid` type below to match before running.

create extension if not exists pgcrypto;

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid references deals(id) on delete set null,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  seller_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (deal_id, buyer_id, seller_id)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists idx_conversations_buyer on conversations (buyer_id);
create index if not exists idx_conversations_seller on conversations (seller_id);
create index if not exists idx_messages_conversation on messages (conversation_id, created_at);

alter table conversations enable row level security;
alter table messages enable row level security;

-- Only the two participants can see or create their conversation.
create policy "participants can view their conversations"
  on conversations for select
  using (auth.uid() = buyer_id or auth.uid() = seller_id);

create policy "buyer can start a conversation"
  on conversations for insert
  with check (auth.uid() = buyer_id and auth.uid() <> seller_id);

-- Only participants can read or send messages in their own conversation.
create policy "participants can view their messages"
  on messages for select
  using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id
        and (c.buyer_id = auth.uid() or c.seller_id = auth.uid())
    )
  );

create policy "participants can send messages"
  on messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from conversations c
      where c.id = messages.conversation_id
        and (c.buyer_id = auth.uid() or c.seller_id = auth.uid())
    )
  );

-- Lets a participant mark the other side's messages as read.
create policy "participants can mark messages read"
  on messages for update
  using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id
        and (c.buyer_id = auth.uid() or c.seller_id = auth.uid())
    )
  )
  with check (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id
        and (c.buyer_id = auth.uid() or c.seller_id = auth.uid())
    )
  );

-- Keeps conversations.last_message_at current for inbox sorting, without
-- needing an UPDATE policy on conversations for regular users.
create or replace function bump_conversation_last_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists trg_bump_conversation_last_message on messages;
create trigger trg_bump_conversation_last_message
  after insert on messages
  for each row execute function bump_conversation_last_message();
