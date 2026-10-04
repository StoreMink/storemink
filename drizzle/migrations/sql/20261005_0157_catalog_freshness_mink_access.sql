-- Provision all stores through the same path, including future signups.
-- Keep legacy access rows for scheduled workers; invitation is no longer an
-- application eligibility check. Staff authority and exact approvals remain.
CREATE FUNCTION public.enable_store_mink_access(target_store uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
BEGIN
  INSERT INTO public.mink_store_access
    (store_id, enabled, drafting_enabled, phase, invited_by, invited_at, updated_at)
  VALUES (target_store, true, true, 'merchant_beta', 'automatic-store-access', now(), now())
  ON CONFLICT (store_id) DO UPDATE SET enabled=true, drafting_enabled=true,
    invited_by=coalesce(mink_store_access.invited_by, EXCLUDED.invited_by),
    invited_at=coalesce(mink_store_access.invited_at, EXCLUDED.invited_at), updated_at=now();
  INSERT INTO public.mink_action_tool_access
    (store_id, tool_name, enabled, enabled_by, enabled_at, updated_at)
  SELECT target_store, tool, true, 'automatic-store-access', now(), now()
  FROM unnest(ARRAY[
    'apply_product_description',
    'apply_product_seo',
    'apply_product_images',
    'create_product',
    'create_coupon',
    'update_coupon',
    'create_customer_group',
    'update_customer_group',
    'create_offer',
    'update_offer',
    'activate_offer',
    'adjust_inventory',
    'bulk_adjust_inventory',
    'transition_order_status',
    'publish_blog',
    'send_campaign',
    'bulk_update_prices',
    'apply_storefront_code',
    'publish_storefront_code',
    'apply_storefront_layout',
    'apply_storefront_design',
    'generate_media_image'
  ]::text[]) AS tool
  ON CONFLICT (store_id, tool_name) DO UPDATE SET enabled=true,
    enabled_by=EXCLUDED.enabled_by, enabled_at=EXCLUDED.enabled_at, updated_at=now();
END;
$fn$;
REVOKE ALL ON FUNCTION public.enable_store_mink_access(uuid) FROM PUBLIC, anon, authenticated, app_user;

CREATE FUNCTION public.provision_store_mink_access()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $fn$
BEGIN
  PERFORM public.enable_store_mink_access(NEW.id);
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.provision_store_mink_access() FROM PUBLIC, anon, authenticated, app_user;
CREATE TRIGGER stores_provision_mink_access AFTER INSERT ON public.stores
FOR EACH ROW EXECUTE FUNCTION public.provision_store_mink_access();
SELECT public.enable_store_mink_access(id) FROM public.stores;

UPDATE public.help_articles SET body=replace(body,
  $old$<li>Sign in to the correct store dashboard.</li>$old$,
  $new$<li>Mink AI is available in every store, including a new store, without an invitation. Sign in to the correct store dashboard. Your staff permissions and Mink credit balance determine which requests you can make.</li>$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$<li>Enter the product base or MRP value and its selling price.</li>$old$,
  $new$<li>Enter the product base or MRP value and its selling price. If there is one variant, changing these fields also updates that variant. With several variants, these fields are defaults for new variants; edit each existing variant in Variants. A variant special price overrides its selling price. Save your changes: the next storefront request uses the saved prices, photos, names and other published details. Return to a storefront tab to refresh its visible details.</li>$new$), updated_at=now()
WHERE slug='set-product-pricing-tax-and-shipping-details' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$The Sell screen is designed for quick taps and scans. The product grid can be arranged for each location without hiding the rest of the catalogue.$old$,
  $new$The Sell screen is designed for quick taps and scans. The product grid shows the complete photo in a portrait card, including on a phone. The product grid can be arranged for each location without hiding the rest of the catalogue.$new$), updated_at=now()
WHERE slug='customize-register-and-scan-products' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$Stores separately enrolled in the drafting beta can ask Mink AI$old$,
  $new$Every store can ask Mink AI$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$StoreMink support must enable product-description and product-SEO actions separately for the store. These are independent kill switches on top of the Mink beta and private-drafting gates. The signed-in admin must also have$old$,
  $new$The signed-in admin must have$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$StoreMink support must enable each live-action tool separately. You must have$old$,
  $new$You must have$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$StoreMink controls general Mink availability and private drafting separately. Removing the invitation-only rollout requirement does not enable drafting for every store: StoreMink support must still enable the store's drafting switch, and the signed-in admin still needs the matching Manage permission. Each live-action tool remains independently disabled until support enables it.$old$,
  $new$Mink AI can read store information and prepare private proposals in every store. The signed-in admin needs the matching staff permissions and sufficient credits. Review and approve the exact proposed change before it is applied.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$permission, and StoreMink support must enable the single-SKU inventory action separately for your store.$old$,
  $new$permission.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$Use the separately enabled bulk workflow$old$,
  $new$Use the bulk workflow$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$Transfers, order-status changes, publishing, campaigns and price updates remain unavailable.$old$,
  $new$Use their own reviewed proposals for order-status changes, publishing, campaigns and price updates. Inventory transfers use the normal Inventory workflow.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$permission, and StoreMink support must enable <strong>Bulk inventory adjustments</strong> separately from the single-SKU action.$old$,
  $new$permission.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$permission, drafting access and the separately enabled <strong>Delivery order-status transitions</strong> switch.$old$,
  $new$permission.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$permission, Pro email-campaign access, drafting access, configured email delivery and the separately enabled <strong>Coupon email campaigns</strong> switch.$old$,
  $new$permission, Pro email-campaign access and configured email delivery.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$permission, drafting access and the separately enabled <strong>Bulk price updates</strong> switch.$old$,
  $new$permission.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$and Mink drafting must be enabled for the store.$old$,
  $new$and sufficient Mink credits.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$Publication and rollback must be switched on separately for your store by StoreMink support, and the AI model is never able to run either of them.$old$,
  $new$Publication and rollback require your exact review and approval; the AI model cannot approve either of them.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$StoreMink support must separately enable <strong>Website Builder draft code saves</strong> for the store.$old$,
  $new$$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$StoreMink support must separately enable <strong>Checked storefront publication and rollback</strong> for the store.$old$,
  $new$$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$If drafting tools are unavailable, ask a store owner to check your Manage permission and ask StoreMink support whether the separate drafting beta is enabled.$old$,
  $new$If drafting tools are unavailable, ask a store owner to check your Manage permission and Mink credit balance. Contact StoreMink support if the problem continues.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$Drafting does not need to be enabled.$old$,
  $new$Briefs are available with these View permissions.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$when Mink generation or invitations are disabled$old$,
  $new$when Mink generation is temporarily unavailable$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$check that Mink AI is switched on for your store and that you hold$old$,
  $new$check your Mink credit balance and that you hold$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$Draft saves and publication still need their separate permissions, enabled controls and human approvals.$old$,
  $new$Draft saves and publication need their separate permissions and human approvals.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$An access or feature-disabled message is different from a hidden panel: ask your administrator to check Mink availability and your permissions.$old$,
  $new$For an access error, ask your administrator to check your staff permissions and Mink credit balance. For a service outage, try again or contact StoreMink support.$new$), updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
