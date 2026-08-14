-- Bastion: "Download my data" export, used by the button on
-- bastion-my-account.html. Run once in the Supabase SQL editor.
--
-- SECURITY DEFINER so it can read across tables regardless of each table's
-- RLS policies, but it takes no arguments and reads auth.uid() internally —
-- a caller can only ever get their own data, never another user's, no matter
-- what they pass from the client (the client passes nothing).
create or replace function get_my_data()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  result json;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select json_build_object(
    'exported_at', now(),
    'user_id', uid,
    'profile', (select row_to_json(p) from profiles p where p.id = uid),
    'listings', (select coalesce(json_agg(d), '[]'::json) from deals d where d.seller_id = uid),
    'favorites', (select coalesce(json_agg(f), '[]'::json) from favorites f where f.user_id = uid),
    'transactions_as_buyer', (select coalesce(json_agg(t), '[]'::json) from transactions t where t.buyer_id = uid),
    'transactions_as_seller', (select coalesce(json_agg(t), '[]'::json) from transactions t where t.seller_id = uid),
    'reviews_written', (select coalesce(json_agg(r), '[]'::json) from reviews r where r.buyer_id = uid),
    'reviews_received', (select coalesce(json_agg(r), '[]'::json) from reviews r where r.seller_id = uid),
    'conversations', (select coalesce(json_agg(c), '[]'::json) from conversations c where c.buyer_id = uid or c.seller_id = uid),
    'messages_sent', (select coalesce(json_agg(m), '[]'::json) from messages m where m.sender_id = uid),
    'reports_filed', (select coalesce(json_agg(rp), '[]'::json) from reports rp where rp.reporter_id = uid),
    'notifications', (select coalesce(json_agg(n), '[]'::json) from notifications n where n.user_id = uid)
  ) into result;

  return result;
end;
$$;

grant execute on function get_my_data() to authenticated;
