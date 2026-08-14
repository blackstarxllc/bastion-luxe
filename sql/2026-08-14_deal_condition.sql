-- Bastion: normalized "condition" field on listings, used for the new
-- marketplace condition filter. Run this once in the Supabase SQL editor.
--
-- Nullable and unconstrained on purpose: existing listings created before this
-- change simply won't have a condition and are excluded when a specific
-- condition filter is applied (they still show under "Any Condition").
-- New/edited listings always set it via bastion-create-listing.html's
-- required Condition dropdown (New / Like New / Excellent / Good / Fair / For Parts).

alter table deals add column if not exists condition text;
