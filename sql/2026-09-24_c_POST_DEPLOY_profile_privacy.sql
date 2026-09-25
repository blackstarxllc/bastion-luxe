-- 2026-09-24 (c): APPLY ONLY AFTER the 2026-09-24 site code is deployed.
-- Claude applies this once the deploy is confirmed. Idempotent.
--
-- public.profiles was readable in full by anyone, signed in or not,
-- including phone numbers, notification settings, ban reasons and terms
-- acceptance times. Row security cannot hide a column, so column privileges
-- do: anon/authenticated may read only the public profile fields below.
-- The owner reads their private fields through get_my_profile_private(),
-- admins through admin_list_profiles(). Service-role functions are unaffected.
revoke select on public.profiles from anon, authenticated;
grant select (id, handle, created_at, is_admin, is_banned, id_verified, authenticity_verified,
              handle_changed_count, display_name, bio, updated_at)
  on public.profiles to anon, authenticated;
