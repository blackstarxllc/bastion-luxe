-- Bastion: seller verification badges ("ID Verified" / "Authenticity Verified"),
-- shown on high-value listings and on seller profiles. Run once in the Supabase SQL editor.

alter table profiles add column if not exists id_verified boolean not null default false;
alter table profiles add column if not exists authenticity_verified boolean not null default false;

-- Defense-in-depth: these two flags must only ever be set by an admin through
-- bastion-admin.html. Your profiles table likely already has an RLS policy
-- letting a user update their own row (that's how the handle-editing on
-- bastion-my-account.html works) — RLS policies don't restrict which *columns*
-- change, only which *rows*, so without this trigger any signed-in user could
-- call the Supabase REST API directly and set id_verified/authenticity_verified
-- on their own profile, bypassing the UI entirely.
-- This trigger silently reverts those two columns to their previous value
-- unless the row is being changed by a user whose own profile has is_admin = true.
create or replace function prevent_self_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_is_admin boolean;
begin
  select is_admin into acting_is_admin from profiles where id = auth.uid();
  if not coalesce(acting_is_admin, false) then
    new.id_verified := old.id_verified;
    new.authenticity_verified := old.authenticity_verified;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_self_verification on profiles;
create trigger trg_prevent_self_verification
  before update on profiles
  for each row execute function prevent_self_verification();
