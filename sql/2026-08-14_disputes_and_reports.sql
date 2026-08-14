-- Bastion: richer dispute context + a general-purpose report flow for
-- listings/sellers outside of an active transaction. Run once in the
-- Supabase SQL editor.

-- Capture *why* a transaction was disputed, instead of just flipping status.
alter table transactions add column if not exists dispute_reason text;
alter table transactions add column if not exists dispute_details text;

-- Reports against a listing or a seller, independent of any transaction
-- (e.g. a scam listing spotted before anyone's bought it).
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('listing','seller')),
  target_id uuid not null,
  target_label text,
  reason text not null,
  details text,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_reports_status on reports (status, created_at);

alter table reports enable row level security;

create policy "users can create reports"
  on reports for insert
  with check (auth.uid() = reporter_id);

create policy "users can view their own reports"
  on reports for select
  using (auth.uid() = reporter_id);

create policy "admins can view all reports"
  on reports for select
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

create policy "admins can update reports"
  on reports for update
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
