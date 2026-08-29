-- Bastion: RLS performance pass found by a database audit. Every policy
-- below called auth.uid() directly, which Postgres re-evaluates on every
-- single row; wrapping it as (select auth.uid()) lets Postgres compute it
-- once per query instead. Behavior is unchanged — this is a pure speed fix.
-- Also adds indexes on foreign-key columns that had none, and locks down
-- a few internal functions that had no business being publicly callable.
-- Run once in the Supabase SQL editor.

-- account_deletion_requests
alter policy "admins can update deletion requests" on public.account_deletion_requests
  using (exists (select 1 from profiles p where p.id = (select auth.uid()) and p.is_admin))
  with check (exists (select 1 from profiles p where p.id = (select auth.uid()) and p.is_admin));
alter policy "admins can view all deletion requests" on public.account_deletion_requests
  using (exists (select 1 from profiles p where p.id = (select auth.uid()) and p.is_admin));
alter policy "users can view their own deletion requests" on public.account_deletion_requests
  using ((select auth.uid()) = user_id);

-- conversations
alter policy "buyer can start a conversation" on public.conversations
  with check ((select auth.uid()) = buyer_id and (select auth.uid()) <> seller_id);
alter policy "participants can view their conversations" on public.conversations
  using ((select auth.uid()) = buyer_id or (select auth.uid()) = seller_id);

-- deals
alter policy "Admins can delete any deal" on public.deals
  using (exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));
alter policy "Admins can update any deal" on public.deals
  using (exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));
alter policy "Sellers can delete their own deals" on public.deals
  using ((select auth.uid()) = seller_id);
alter policy "Sellers can insert their own deals" on public.deals
  with check ((select auth.uid()) = seller_id and not exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_banned = true));
alter policy "Sellers can update their own deals" on public.deals
  using ((select auth.uid()) = seller_id);
alter policy "deletion-pending accounts cannot list" on public.deals
  with check (not exists (select 1 from account_deletion_requests adr where adr.user_id = (select auth.uid()) and adr.status = 'pending'));

-- favorites
alter policy "Users manage their own favorites" on public.favorites
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- listings
alter policy "Sellers can manage own listings" on public.listings
  using ((select auth.uid()) = seller_id);

-- messages
alter policy "Admins can read all messages" on public.messages
  using (exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));
alter policy "Buyer and seller can read their messages" on public.messages
  using (exists (select 1 from transactions t where t.id = messages.transaction_id and (t.buyer_id = (select auth.uid()) or t.seller_id = (select auth.uid()))));
alter policy "Buyer and seller can send messages" on public.messages
  with check (sender_id = (select auth.uid())
    and not exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_banned = true)
    and exists (select 1 from transactions t where t.id = messages.transaction_id and (t.buyer_id = (select auth.uid()) or t.seller_id = (select auth.uid()))));
alter policy "participants can mark conversation messages read" on public.messages
  using (conversation_id is not null and exists (select 1 from conversations c where c.id = messages.conversation_id and (c.buyer_id = (select auth.uid()) or c.seller_id = (select auth.uid()))))
  with check (conversation_id is not null and exists (select 1 from conversations c where c.id = messages.conversation_id and (c.buyer_id = (select auth.uid()) or c.seller_id = (select auth.uid()))));
alter policy "participants can send conversation messages" on public.messages
  with check (sender_id = (select auth.uid()) and conversation_id is not null and exists (select 1 from conversations c where c.id = messages.conversation_id and (c.buyer_id = (select auth.uid()) or c.seller_id = (select auth.uid()))));
alter policy "participants can view their conversation messages" on public.messages
  using (conversation_id is null or exists (select 1 from conversations c where c.id = messages.conversation_id and (c.buyer_id = (select auth.uid()) or c.seller_id = (select auth.uid()))));

-- profiles
alter policy "Admins can update any profile" on public.profiles
  using (exists (select 1 from profiles p2 where p2.id = (select auth.uid()) and p2.is_admin = true));
alter policy "Users can insert their own profile" on public.profiles
  with check ((select auth.uid()) = id);
alter policy "Users can update their own profile" on public.profiles
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- reports
alter policy "admins can update reports" on public.reports
  using (exists (select 1 from profiles p where p.id = (select auth.uid()) and p.is_admin))
  with check (exists (select 1 from profiles p where p.id = (select auth.uid()) and p.is_admin));
alter policy "admins can view all reports" on public.reports
  using (exists (select 1 from profiles p where p.id = (select auth.uid()) and p.is_admin));
alter policy "users can create reports" on public.reports
  with check ((select auth.uid()) = reporter_id);
alter policy "users can view their own reports" on public.reports
  using ((select auth.uid()) = reporter_id);

-- reviews
alter policy "Admins can delete any review" on public.reviews
  using (exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));
alter policy "Buyers can write their own reviews" on public.reviews
  with check ((select auth.uid()) = buyer_id);

-- transactions
alter policy "Admins can update any transaction" on public.transactions
  using (exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));
alter policy "Admins can view all transactions" on public.transactions
  using (exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));
alter policy "Buyers and sellers can update their transactions" on public.transactions
  using ((select auth.uid()) = buyer_id or (select auth.uid()) = seller_id);
alter policy "Buyers and sellers can view their transactions" on public.transactions
  using ((select auth.uid()) = buyer_id or (select auth.uid()) = seller_id);
alter policy "Buyers can create transactions" on public.transactions
  with check ((select auth.uid()) = buyer_id and not exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_banned = true));
alter policy "Users can view own transactions" on public.transactions
  using ((select auth.uid()) = buyer_id or (select auth.uid()) = seller_id);
alter policy "deletion-pending accounts cannot transact" on public.transactions
  with check (not exists (select 1 from account_deletion_requests adr where adr.user_id = (select auth.uid()) and adr.status = 'pending'));

-- user_reports
alter policy "Admins can update reports" on public.user_reports
  using (exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));
alter policy "Admins can view all reports" on public.user_reports
  using (exists (select 1 from profiles where profiles.id = (select auth.uid()) and profiles.is_admin = true));
alter policy "Users can file reports" on public.user_reports
  with check (reporter_id = (select auth.uid()) and reported_user_id <> (select auth.uid()));

-- Missing indexes on foreign-key columns
create index if not exists idx_deals_buyer_id on public.deals(buyer_id);
create index if not exists idx_deals_seller_id on public.deals(seller_id);
create index if not exists idx_deals_listing_id on public.deals(listing_id);
create index if not exists idx_listings_seller_id on public.listings(seller_id);
create index if not exists idx_favorites_deal_id on public.favorites(deal_id);
create index if not exists idx_messages_sender_id on public.messages(sender_id);
create index if not exists idx_messages_transaction_id on public.messages(transaction_id);
create index if not exists idx_reports_reporter_id on public.reports(reporter_id);
create index if not exists idx_reviews_buyer_id on public.reviews(buyer_id);
create index if not exists idx_reviews_seller_id on public.reviews(seller_id);
create index if not exists idx_reviews_transaction_id on public.reviews(transaction_id);
create index if not exists idx_transactions_buyer_id on public.transactions(buyer_id);
create index if not exists idx_transactions_deal_id on public.transactions(deal_id);
create index if not exists idx_transactions_listing_id on public.transactions(listing_id);
create index if not exists idx_transactions_seller_id on public.transactions(seller_id);
create index if not exists idx_user_reports_reported_user_id on public.user_reports(reported_user_id);
create index if not exists idx_user_reports_reporter_id on public.user_reports(reporter_id);

-- These four are trigger functions only — nothing should ever call them
-- directly via the exposed RPC endpoint.
revoke execute on function public.bump_conversation_last_message() from public, anon, authenticated;
revoke execute on function public.enforce_transaction_pricing() from public, anon, authenticated;
revoke execute on function public.prevent_self_verification() from public, anon, authenticated;
revoke execute on function public.enforce_handle_change_limit() from public, anon, authenticated;

-- These two are legitimate RPCs called by logged-in users (get_my_data,
-- account deletion) — just no reason for a logged-out visitor to call them.
revoke execute on function public.get_my_data() from anon;
revoke execute on function public.request_account_deletion() from anon;

-- Pin the search_path so this function can't be hijacked by a malicious
-- schema earlier in the resolution order.
alter function public.calculate_protection_fee(numeric) set search_path = public, pg_temp;
