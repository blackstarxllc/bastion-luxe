-- Bastion: "Delete my account" request flow, used by bastion-my-account.html.
-- Run once in the Supabase SQL editor.
--
-- This does NOT delete the auth.users row directly from client-triggered SQL —
-- actually removing an account (and deciding how to handle their listings,
-- transaction history, reviews left by/about them, etc.) is a judgment call
-- that shouldn't happen unattended from a single button click. Instead this
-- records a request for staff to review and action, matching the "may take
-- time to process" language shown to the user in the confirmation dialog.

create table if not exists account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','completed','cancelled')),
  requested_at timestamptz not null default now(),
  processed_at timestamptz
);

-- One open request per user at a time.
create unique index if not exists idx_one_pending_deletion_per_user
  on account_deletion_requests (user_id)
  where status = 'pending';

alter table account_deletion_requests enable row level security;

create policy "users can view their own deletion requests"
  on account_deletion_requests for select
  using (auth.uid() = user_id);

create policy "admins can view all deletion requests"
  on account_deletion_requests for select
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

create policy "admins can update deletion requests"
  on account_deletion_requests for update
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

-- security definer + no arguments + reads auth.uid() internally, so a caller
-- can only ever file a request for themselves.
create or replace function request_account_deletion()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into account_deletion_requests (user_id)
  values (uid)
  on conflict (user_id) where status = 'pending' do nothing;
end;
$$;

grant execute on function request_account_deletion() to authenticated;
