-- The record of a Mink AI change to a product outlives the product (owner's
-- decision D6 in the chat-history design, 26 Oct 2026). Deleting a product
-- deleted, through this foreign key, every Mink AI approval naming it and,
-- through the approval, the change's audit row, so "we keep the record of
-- what Mink AI proposed and what you approved for as long as your store
-- exists" was false for product content, product photo and stock changes.
-- mink_action_approvals.product_id becomes a plain reference, as
-- mink_action_audit.product_id has been since 0042. Readers already answer a
-- missing product with "The linked product is no longer available in this
-- store." (lib/mink/product-actions.ts readProduct); the card's own read of
-- its last change (getLatestMinkProductAction) treats a missing product as no
-- change yet in the revision that ships with this migration, as it did when
-- the cascade had removed the approval.
--
-- ★★ THE NAME STAYS, AS A CHECK THAT IS ALWAYS TRUE. The durable verify of
-- 20260830_0042_mink_phase_4a_product_actions names the constraint
-- mink_action_approvals_product_store_fkey, and the migration runner re-checks
-- every applied migration's durable verify at the end of every apply, status,
-- verify and drift run. Only a named verify QUERY can be retired
-- (supersedesVerifyQueries); a constraint named in a durable verify cannot.
-- Dropping the foreign key alone would therefore apply, then fail 0042's
-- check, and every later run in that environment, Cloud Build's included,
-- would be refused until the ledger was repaired by hand. So the foreign key
-- is dropped and a CHECK with the same name takes its place:
-- product_id IS NULL OR store_id IS NOT NULL. store_id is NOT NULL, so the
-- CHECK is always true and can never refuse a write from either revision;
-- both arms are IS [NOT] NULL, so it never evaluates to NULL. It exists only
-- so that 0042's check keeps passing; it is not a foreign key, and nothing
-- ties product_id to products any more. The store purge still removes a
-- store's approvals through mink_action_approvals_store_id_fkey (CASCADE).
--
-- ★ LOCKS: dropping a foreign key takes ACCESS EXCLUSIVE on BOTH tables,
--   mink_action_approvals and products, held to COMMIT under the 5 s
--   lock_timeout. The drop itself is instant. Adding the CHECK and its comment
--   needs only mink_action_approvals, which the drop already holds, and reads
--   that small table once to validate it; this file touches no other table.
--   While it waits for a busy products table, new product reads queue behind
--   it for at most those 5 s. Two kinds of transaction take the two tables in
--   opposite orders (a Mink AI product action locks its approval and then
--   writes the product; a product delete writes the product and then cascades
--   into approvals), so whichever order this file takes them in, one of them
--   can deadlock with it. Postgres stops one side within a second: that
--   request fails and can be repeated, or this migration fails and the build
--   is re-run. Nothing is half-applied either way.
--
-- Backward compatible: the revision being replaced never needs the cascade.
-- Its one visible difference, for the minutes of the deploy window: opening
-- the Mink card of a product draft whose product was deleted after Mink
-- changed it answers "The linked product is no longer available in this
-- store." instead of showing no change, because the approval is now kept.

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_product_store_fkey;

ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_product_store_fkey
  CHECK (product_id IS NULL OR store_id IS NOT NULL);

COMMENT ON CONSTRAINT mink_action_approvals_product_store_fkey
  ON public.mink_action_approvals IS
  'Always true. Kept only because the durable verify of migration 20260830_0042 names this constraint, which can never be retired. Migration 20261026_0250 dropped the foreign key to products of this name, so a Mink AI approval and its audit row outlive the product they changed.';
