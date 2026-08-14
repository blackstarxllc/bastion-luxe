-- Bastion: audit log for admin actions taken in bastion-admin.html.
-- Run once in the Supabase SQL editor.

create table if not exists admin_action_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  target_type text not null,
  target_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_action_log_created on admin_action_log (created_at desc);

alter table admin_action_log enable row level security;

-- Only admins can read the log. There is deliberately no INSERT policy for
-- regular clients — rows can only be created through log_admin_action()
-- below, which checks admin status itself before writing.
create policy "admins can view action log"
  on admin_action_log for select
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

create or replace function log_admin_action(p_action text, p_target_type text, p_target_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  caller_is_admin boolean;
begin
  select is_admin into caller_is_admin from profiles where id = uid;
  if not coalesce(caller_is_admin, false) then
    raise exception 'Only admins can log admin actions';
  end if;

  insert into admin_action_log (admin_id, action, target_type, target_id)
  values (uid, p_action, p_target_type, p_target_id);
end;
$$;

grant execute on function log_admin_action(text, text, text) to authenticated;
