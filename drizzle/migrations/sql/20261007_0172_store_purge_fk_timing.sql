-- A platform operator could not permanently delete a store that had ever
-- taken an order. "Could not delete the store. Please try again." — and the
-- retry failed identically, because the cause was a constraint, not a blip.
--
-- ★★ RESTRICT IS CHECKED THE MOMENT THE PARENT ROW GOES; NO ACTION IS CHECKED
-- AT THE END OF THE STATEMENT. Deleting a store cascades to products AND to
-- orders (whose order_items cascade with them), but order_items references
-- products with ON DELETE RESTRICT — so the first product deleted raised
-- 23503 against order_items rows that the SAME statement was about to remove
-- through orders. Measured on a copy of production data:
--   update or delete on table "products" violates foreign key constraint
--   "order_items_product_id_fkey" on table "order_items"
-- The four Mink constraints below have the identical shape: a RESTRICT
-- pointing at a sibling table that also cascades from stores.
--
-- ★★ NO ACTION ALONE IS NOT ENOUGH, measured: PostgreSQL runs a statement's
-- AFTER triggers in the order they were queued, and the products cascade is
-- queued before the orders cascade, so the order_items check fires before the
-- rows it objects to have been removed. The constraints are therefore made
-- DEFERRABLE INITIALLY IMMEDIATE: by default they behave exactly as before —
-- deleting ONE ordered product still fails with the same 23503 (the dashboard
-- maps it to "unpublish instead", CODEBASE.md §4 products/), and a Mink
-- approval or draft that a publication or campaign still points at still
-- cannot be deleted on its own. Only a transaction that asks for it with
-- `SET CONSTRAINTS ALL DEFERRED` — the store purge, app/actions/platform.ts —
-- moves the check to commit, after every cascade has run. That is what
-- cascade-from-stores (migration 0014) promised in the first place.

ALTER TABLE public.order_items
  DROP CONSTRAINT order_items_product_id_fkey,
  ADD CONSTRAINT order_items_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.order_items
  DROP CONSTRAINT order_items_variant_id_fkey,
  ADD CONSTRAINT order_items_variant_id_fkey
    FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.mink_blog_publications
  DROP CONSTRAINT mink_blog_publications_approval_store_fkey,
  ADD CONSTRAINT mink_blog_publications_approval_store_fkey
    FOREIGN KEY (approval_id, store_id)
    REFERENCES public.mink_action_approvals(id, store_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.mink_blog_publications
  DROP CONSTRAINT mink_blog_publications_draft_store_fkey,
  ADD CONSTRAINT mink_blog_publications_draft_store_fkey
    FOREIGN KEY (draft_id, store_id)
    REFERENCES public.mink_drafts(id, store_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.email_campaigns
  DROP CONSTRAINT email_campaigns_mink_approval_store_fkey,
  ADD CONSTRAINT email_campaigns_mink_approval_store_fkey
    FOREIGN KEY (mink_approval_id, store_id)
    REFERENCES public.mink_action_approvals(id, store_id) ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

-- Guard: no RESTRICT foreign key may sit inside the store-cascade graph
-- again, and the five above must be deferrable. legal_acceptances →
-- legal_documents is platform-level and deliberately RESTRICT (an acceptance
-- must outlive nothing it points at), so it is exempt.
DO $$
DECLARE offender text;
BEGIN
  SELECT conrelid::regclass || '.' || conname INTO offender
  FROM pg_constraint
  WHERE contype = 'f' AND confdeltype = 'r'
    AND conrelid::regclass::text <> 'legal_acceptances'
  LIMIT 1;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'RESTRICT foreign key would block a store purge: %', offender;
  END IF;
  SELECT conname INTO offender
  FROM pg_constraint
  WHERE conname IN (
    'order_items_product_id_fkey',
    'order_items_variant_id_fkey',
    'mink_blog_publications_approval_store_fkey',
    'mink_blog_publications_draft_store_fkey',
    'email_campaigns_mink_approval_store_fkey'
  ) AND NOT condeferrable
  LIMIT 1;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'store-purge foreign key is not deferrable: %', offender;
  END IF;
END $$;
