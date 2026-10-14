-- The stock RPCs check that what they move belongs to the store asking.
--
-- ★★ THE DEFECT. `adjust_stock_at(p_store, p_location, p_product, ...)` created
-- an `inventory_levels` row for whatever product id it was handed and never
-- asked which store that product belongs to. The row was written under the
-- CALLER's store id, and the aggregate trigger then recomputed the OTHER store's
-- `products.stock` / `online_stock` from it — so one merchant could set another
-- merchant's storefront stock from the dashboard inventory screen or the POS
-- (both pass the product id through from the request). `transfer_stock`
-- checked both locations but not the product either.
--
-- Bodies are otherwise byte-for-byte the live definitions (supabase/
-- pos_02_rpc_location.sql, pos_11_transfer_stock.sql, locations_04).

CREATE OR REPLACE FUNCTION public.adjust_stock_at(
  p_store uuid,
  p_location uuid,
  p_product uuid,
  p_variant uuid,
  p_delta integer,
  p_reason text,
  p_note text,
  p_actor text
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
DECLARE
  v_new integer;
BEGIN
  -- Everything this writes must be the caller's: the shelf, the product and,
  -- when given, a variant of THAT product.
  IF NOT EXISTS (
       SELECT 1 FROM public.store_locations
        WHERE id = p_location AND store_id = p_store)
     OR NOT EXISTS (
       SELECT 1 FROM public.products
        WHERE id = p_product AND store_id = p_store)
     OR (p_variant IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.product_variants
        WHERE id = p_variant AND product_id = p_product AND store_id = p_store))
  THEN
    RAISE EXCEPTION 'That product or location is not part of this store.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
  VALUES (p_store, p_location, p_product, p_variant, 0)
  ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO NOTHING;

  UPDATE public.inventory_levels
     SET on_hand = GREATEST(0, on_hand + p_delta), updated_at = now()
   WHERE store_id = p_store
     AND location_id = p_location
     AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
  RETURNING on_hand INTO v_new;

  INSERT INTO public.stock_movements
    (store_id, product_id, variant_id, location_id, delta, reason, balance_after, note, created_by)
  VALUES
    (p_store, p_product, p_variant, p_location, p_delta, p_reason, v_new, p_note, p_actor);

  RETURN v_new;
END;
$function$;

CREATE OR REPLACE FUNCTION public.transfer_stock(
  p_store uuid,
  p_from uuid,
  p_to uuid,
  p_product uuid,
  p_variant uuid,
  p_qty integer,
  p_note text,
  p_actor text
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $function$
DECLARE
  v_from_new integer;
  v_to_new   integer;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN false; END IF;
  IF p_from = p_to THEN RETURN false; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.store_locations WHERE id = p_from AND store_id = p_store)
     OR NOT EXISTS (SELECT 1 FROM public.store_locations WHERE id = p_to AND store_id = p_store) THEN
    RETURN false;
  END IF;

  -- The product (and variant) must be the caller's too, or the destination
  -- insert below writes a level row for another store's product.
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product AND store_id = p_store)
     OR (p_variant IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.product_variants
        WHERE id = p_variant AND product_id = p_product AND store_id = p_store)) THEN
    RETURN false;
  END IF;

  UPDATE public.inventory_levels
     SET on_hand = on_hand - p_qty, updated_at = now()
   WHERE store_id = p_store
     AND location_id = p_from
     AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
     -- CHANGED in locations_04: available, not physical.
     AND on_hand - reserved >= p_qty
  RETURNING on_hand INTO v_from_new;

  IF v_from_new IS NULL THEN RETURN false; END IF;

  INSERT INTO public.inventory_levels (store_id, location_id, product_id, variant_id, on_hand)
  VALUES (p_store, p_to, p_product, p_variant, 0)
  ON CONFLICT (location_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO NOTHING;

  UPDATE public.inventory_levels
     SET on_hand = on_hand + p_qty, updated_at = now()
   WHERE store_id = p_store
     AND location_id = p_to
     AND product_id = p_product
     AND variant_id IS NOT DISTINCT FROM p_variant
  RETURNING on_hand INTO v_to_new;

  INSERT INTO public.stock_movements
    (store_id, product_id, variant_id, location_id, delta, reason, balance_after, note, created_by)
  VALUES
    (p_store, p_product, p_variant, p_from, -p_qty, 'transfer_out', v_from_new, p_note, p_actor),
    (p_store, p_product, p_variant, p_to,    p_qty, 'transfer_in',  v_to_new,   p_note, p_actor);

  RETURN true;
END;
$function$;
