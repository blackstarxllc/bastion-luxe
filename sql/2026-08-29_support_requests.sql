-- Bastion: backs the "Contact Support" page (bastion-support.html). Anyone,
-- logged in or not, can submit one — the Netlify function that handles
-- submission also emails the team and enforces basic rate limits (see
-- netlify/functions/send-support-request.js) using the ip_address and
-- email columns below.
-- Run once in the Supabase SQL editor.

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  subject text not null,
  message text not null,
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'open',
  ip_address text,
  created_at timestamptz not null default now()
);

create index if not exists idx_support_requests_created_at on public.support_requests(created_at desc);
create index if not exists idx_support_requests_ip_recent on public.support_requests(ip_address, created_at);
create index if not exists idx_support_requests_email_recent on public.support_requests(email, created_at);

alter table public.support_requests enable row level security;

-- Anyone (logged in or not) can submit a support request
create policy "anyone can submit a support request"
on public.support_requests for insert
to public
with check (true);

-- Only admins can view or manage them — same pattern as the reports table.
create policy "admins can view support requests"
on public.support_requests for select
to authenticated
using (exists (select 1 from public.profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));

create policy "admins can update support requests"
on public.support_requests for update
to authenticated
using (exists (select 1 from public.profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true))
with check (exists (select 1 from public.profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));
