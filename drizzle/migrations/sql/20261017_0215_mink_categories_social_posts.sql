-- Mink AI: category proposals as a guarded domain action, a social-posts draft
-- kind, and the Help guide's three sentences that now understate it.
--
-- Found by querying rather than enumerating (CODEBASE §38): every constraint
-- whose definition names 'create_customer_group' or 'customer_group' is
-- widened here, which is six, plus the provisioning function. The three
-- vocabularies that already applied to customer groups apply to categories.

ALTER TABLE public.mink_action_tool_access DROP CONSTRAINT IF EXISTS mink_action_tool_access_name_check;
ALTER TABLE public.mink_action_tool_access ADD CONSTRAINT mink_action_tool_access_name_check CHECK (tool_name = ANY (ARRAY['apply_product_description','apply_product_seo','apply_product_images','create_product','create_coupon','update_coupon','create_customer_group','update_customer_group','create_category','update_category','create_offer','update_offer','activate_offer','adjust_inventory','bulk_adjust_inventory','apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder','transition_order_status','publish_blog','send_campaign','bulk_update_prices','generate_media_image']::text[]));

ALTER TABLE public.mink_action_approvals DROP CONSTRAINT IF EXISTS mink_action_approvals_tool_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_tool_check CHECK (tool_name = ANY (ARRAY['apply_product_description','apply_product_seo','apply_product_images','create_product','create_coupon','update_coupon','create_customer_group','update_customer_group','create_category','update_category','create_offer','update_offer','activate_offer','adjust_inventory','bulk_adjust_inventory','apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder','transition_order_status','publish_blog','send_campaign','bulk_update_prices','generate_media_image']::text[]));

ALTER TABLE public.mink_action_audit DROP CONSTRAINT IF EXISTS mink_action_audit_tool_check;
ALTER TABLE public.mink_action_audit ADD CONSTRAINT mink_action_audit_tool_check CHECK (tool_name = ANY (ARRAY['apply_product_description','apply_product_seo','apply_product_images','create_product','create_coupon','update_coupon','create_customer_group','update_customer_group','create_category','update_category','create_offer','update_offer','activate_offer','adjust_inventory','bulk_adjust_inventory','apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder','transition_order_status','publish_blog','send_campaign','bulk_update_prices','generate_media_image']::text[]));

ALTER TABLE public.mink_drafts DROP CONSTRAINT IF EXISTS mink_drafts_kind_check;
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_kind_check CHECK (kind = ANY (ARRAY['product_description','product_seo','product_images','blog','coupon_email','customer_message','product_create','coupon_create','coupon_update','customer_group_create','customer_group_update','category_create','category_update','social_post','inventory_adjustment','bulk_inventory_adjustment','order_status_transition','bulk_price_update','offer_create','offer_update','offer_activate','storefront_custom_code','storefront_layout','storefront_design','website_builder','media_image']::text[]));

ALTER TABLE public.mink_action_approvals DROP CONSTRAINT IF EXISTS mink_action_approvals_resource_type_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (resource_type = ANY (ARRAY['product','coupon','customer_group','category','inventory','inventory_bulk','order','blog','campaign','price_bulk','offer','storefront_section','storefront_page','storefront_chrome','website_builder']::text[]));

ALTER TABLE public.mink_action_audit DROP CONSTRAINT IF EXISTS mink_action_audit_resource_type_check;
ALTER TABLE public.mink_action_audit ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (resource_type = ANY (ARRAY['product','coupon','customer_group','category','inventory','inventory_bulk','order','blog','campaign','price_bulk','offer','storefront_section','storefront_page','storefront_chrome','website_builder']::text[]));

-- A category draft names its destination and carries the two fields the
-- action cannot do without; an update names the category row. Every
-- jsonb_typeof is coalesced: a CHECK is satisfied by NULL, so an absent key
-- would otherwise pass (the trap recorded on 0062, 0064, 0101, 0103, 0106).
ALTER TABLE public.mink_drafts DROP CONSTRAINT IF EXISTS mink_drafts_category_target_check;
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_category_target_check CHECK (kind <> ALL (ARRAY['category_create','category_update']::text[]) OR (destination_type = 'category' AND location_id IS NULL AND variant_id IS NULL AND coalesce(jsonb_typeof(content_json->'name'),'') = 'string' AND coalesce(jsonb_typeof(content_json->'slug'),'') = 'string' AND coalesce(jsonb_typeof(content_json->'status'),'') = 'string' AND (kind <> 'category_update' OR destination_id IS NOT NULL)));

ALTER TABLE public.mink_drafts DROP CONSTRAINT IF EXISTS mink_drafts_social_post_target_check;
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_social_post_target_check CHECK (kind <> 'social_post' OR (destination_type = 'social_post' AND destination_id IS NULL AND location_id IS NULL AND variant_id IS NULL AND coalesce(jsonb_typeof(content_json->'instagram'),'') = 'string'));

CREATE OR REPLACE FUNCTION public.enable_store_mink_access(target_store uuid)
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
    'create_category',
    'update_category',
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
    'generate_media_image',
    'manage_website_builder'
  ]::text[]) AS tool
  ON CONFLICT (store_id, tool_name) DO UPDATE SET enabled=true,
    enabled_by=EXCLUDED.enabled_by, enabled_at=EXCLUDED.enabled_at, updated_at=now();
END;
$fn$;
REVOKE ALL ON FUNCTION public.enable_store_mink_access(uuid) FROM PUBLIC, anon, authenticated, app_user;

-- Every existing store gets the two category tools, matching the all-or-nothing
-- switch every earlier tool followed (0101, 0103, 0106, 0159).
SELECT public.enable_store_mink_access(id) FROM public.stores;

-- The merchant guide: the three sentences that now understate what Mink can
-- prepare, each replaced in place.
UPDATE public.help_articles SET body=replace(body, $old$<h2>Creating products, coupons and customer groups</h2>$old$, $new$<h2>Creating products, coupons, customer groups and categories</h2>$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$Membership remains a separate manual workflow.$old$, $new$Membership remains a separate manual workflow. <strong>Categories:</strong> Mink can create a category or change an existing one's name, URL slug, description, image and visibility. It cannot add or remove products from a category.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$and customer groups must have no members or coupon links. Otherwise rollback is refused.$old$, $new$customer groups must have no members or coupon links, and categories must have no products in them. Otherwise rollback is refused.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$<li>Which offers are running now, scheduled, disabled or unable to run?</li></ul>$old$, $new$<li>Which offers are running now, scheduled, disabled or unable to run?</li><li>Chart sales, orders, average order value or traffic by day, product, category, channel or location (Analytics &rarr; View); the card links to the same report.</li><li>Audit my delivery settings: the rate mode, free-delivery threshold, carrier connection and products missing a weight (Settings &rarr; View).</li><li>Which marketing channels are connected, how many offers and campaigns are running, and where visitors come from (Marketing &rarr; View).</li><li>Open a dashboard page for me, such as a product, an order or Inventory.</li></ul>$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$Every store can ask Mink AI for a product description, product SEO, blog post, coupon email or reusable customer-message template.$old$, $new$Every store can ask Mink AI for a product description, product SEO, blog post, coupon email, reusable customer-message template or a set of social-media captions (Instagram, Facebook, WhatsApp and hashtags), which you copy into your own accounts; Mink never posts anywhere.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
