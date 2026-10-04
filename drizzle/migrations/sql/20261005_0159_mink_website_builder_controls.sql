-- Exact human-approved Website Builder controls for all stores.
ALTER TABLE public.mink_action_tool_access DROP CONSTRAINT IF EXISTS mink_action_tool_access_name_check;
ALTER TABLE public.mink_action_tool_access ADD CONSTRAINT mink_action_tool_access_name_check CHECK (tool_name = ANY (ARRAY['apply_product_description','apply_product_seo','apply_product_images','create_product','create_coupon','update_coupon','create_customer_group','update_customer_group','create_offer','update_offer','activate_offer','adjust_inventory','bulk_adjust_inventory','apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder','transition_order_status','publish_blog','send_campaign','bulk_update_prices','generate_media_image']::text[]));

ALTER TABLE public.mink_action_approvals DROP CONSTRAINT IF EXISTS mink_action_approvals_tool_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_tool_check CHECK (tool_name = ANY (ARRAY['apply_product_description','apply_product_seo','apply_product_images','create_product','create_coupon','update_coupon','create_customer_group','update_customer_group','create_offer','update_offer','activate_offer','adjust_inventory','bulk_adjust_inventory','apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder','transition_order_status','publish_blog','send_campaign','bulk_update_prices','generate_media_image']::text[]));

ALTER TABLE public.mink_action_audit DROP CONSTRAINT IF EXISTS mink_action_audit_tool_check;
ALTER TABLE public.mink_action_audit ADD CONSTRAINT mink_action_audit_tool_check CHECK (tool_name = ANY (ARRAY['apply_product_description','apply_product_seo','apply_product_images','create_product','create_coupon','update_coupon','create_customer_group','update_customer_group','create_offer','update_offer','activate_offer','adjust_inventory','bulk_adjust_inventory','apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder','transition_order_status','publish_blog','send_campaign','bulk_update_prices','generate_media_image']::text[]));

ALTER TABLE public.mink_drafts DROP CONSTRAINT IF EXISTS mink_drafts_kind_check;
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_kind_check CHECK (kind = ANY (ARRAY['product_description','product_seo','product_images','blog','coupon_email','customer_message','product_create','coupon_create','coupon_update','customer_group_create','customer_group_update','inventory_adjustment','bulk_inventory_adjustment','order_status_transition','bulk_price_update','offer_create','offer_update','offer_activate','storefront_custom_code','storefront_layout','storefront_design','website_builder','media_image']::text[]));

ALTER TABLE public.mink_action_approvals DROP CONSTRAINT IF EXISTS mink_action_approvals_resource_type_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (resource_type = ANY (ARRAY['product','coupon','customer_group','inventory','inventory_bulk','order','blog','campaign','price_bulk','offer','storefront_section','storefront_page','storefront_chrome','website_builder']::text[]));

ALTER TABLE public.mink_action_audit DROP CONSTRAINT IF EXISTS mink_action_audit_resource_type_check;
ALTER TABLE public.mink_action_audit ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (resource_type = ANY (ARRAY['product','coupon','customer_group','inventory','inventory_bulk','order','blog','campaign','price_bulk','offer','storefront_section','storefront_page','storefront_chrome','website_builder']::text[]));

ALTER TABLE public.mink_action_approvals DROP CONSTRAINT IF EXISTS mink_action_approvals_draft_version_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_draft_version_check CHECK (draft_version > 0 OR (tool_name = ANY (ARRAY['apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder']::text[]) AND draft_version = 0));

ALTER TABLE public.mink_drafts DROP CONSTRAINT IF EXISTS mink_drafts_builder_target_check;
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_builder_target_check CHECK (kind <> 'website_builder' OR (destination_type = 'website_builder' AND destination_id IS NULL AND location_id IS NULL AND variant_id IS NULL AND coalesce(jsonb_typeof(content_json->'patch_json'),'') = 'string' AND coalesce(jsonb_typeof(content_json->'patch_digest'),'') = 'string' AND coalesce(jsonb_typeof(content_json->'explanation'),'') = 'string'));

ALTER TABLE public.mink_action_approvals DROP CONSTRAINT IF EXISTS mink_action_approvals_builder_target_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_builder_target_check CHECK (tool_name <> 'manage_website_builder' OR (resource_type = 'website_builder' AND resource_id = store_id AND resource_id IS NOT NULL AND product_id IS NULL AND location_id IS NULL AND variant_id IS NULL AND operation = 'apply'));

ALTER TABLE public.mink_action_audit DROP CONSTRAINT IF EXISTS mink_action_audit_builder_target_check;
ALTER TABLE public.mink_action_audit ADD CONSTRAINT mink_action_audit_builder_target_check CHECK (tool_name <> 'manage_website_builder' OR (resource_type = 'website_builder' AND resource_id = store_id AND resource_id IS NOT NULL AND product_id IS NULL AND location_id IS NULL AND variant_id IS NULL AND operation = 'apply'));

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


SELECT public.enable_store_mink_access(id) FROM public.stores;

UPDATE public.help_articles SET body=replace(body, $old$publishes a product, edits your header or footer, or touches StoreMink's own code.$old$, $new$publishes a product or touches StoreMink's own code.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$None of the three changes your header or footer, and none of them publishes anything.$old$, $new$For header or footer changes, ask for a Website Builder change and review the exact fields in its card. Draft saves do not publish anything.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$Custom code is the boundary between them: a layout proposal must carry every existing custom-code section through unchanged, and cannot add, edit or delete one.$old$, $new$Use a Website Builder change for navigation links, page actions and shared storefront controls. Review the exact changes before approving. Follow <a href="/help/storefront/manage-your-website-with-mink-ai">Manage your website with Mink AI</a> for draft, publication and live-change instructions.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';


-- Keep the task instructions separate from the large general Mink guide.
INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT id,
  'manage-your-website-with-mink-ai',
  'Manage your website with Mink AI',
  'Ask Mink to fix navigation, edit pages and shared storefront controls, then review and approve each change.',
  $article$<p>Open Mink AI in your dashboard or Website Builder and describe the change you want. You need Website Builder Manage permission to approve changes. A Website Builder proposal costs 2 AI credits; chat usage is charged at whichever amount is higher, rather than adding both amounts together.</p>
<h2>Ask for a specific change</h2>
<p>You can ask Mink to fix a navigation link, arrange nested menus, change header or footer controls, update newsletter and legal links, choose product-card and cart styles, or change your logo and accent colour. For example: <em>Make the MEN menu link show the active Men collection.</em> Mink checks your saved categories and pages to find the destination. A new logo must use an image from your store's Media or product catalogue.</p>
<p>You can also create a draft page, edit page titles, addresses and SEO, change its sections, or add and remove custom-code sections. Custom code must be supported by your store's plan and enabled in Website settings. Mink can help change that setting. Ask for colours, fonts and other design changes in the same conversation.</p>
<h2>Review and approve</h2>
<p>Mink prepares a card showing every changed field with its Before and After values. Check the destination, text, images and whether the action affects a draft or your live store. Click the named action button only when those details are right. Sending another chat message does not approve the card. Changes preserve the fields you did not ask to edit.</p>
<p>If someone edits the same content before you approve, ask Mink to read it again and prepare a fresh proposal. Pressing the approval button twice cannot apply the same change twice. Changes to your logo, accent colour, Website settings or metadata on an already published page identify their live effect on the card.</p>
<h2>Publish a reviewed draft</h2>
<p>Saving page sections or header and footer changes keeps them in the Website Builder draft. Ask Mink to publish the page or header and footer when you are ready. Publication creates a separate review card for the whole saved draft, so check all its content before approving.</p>
<p>Changed custom code must pass the card's desktop and mobile checks before publication. If a check fails, ask Mink to correct the proposal and review it again. Expired checks can be run again from the card.</p>
<h2>Restore, unpublish or delete</h2>
<p>Ask Mink to restore a page or header and footer draft to its last published content. Restoring a draft does not publish it. Unpublishing an ordinary page removes it from the live store while keeping the draft. Deleting a page removes it, so review that action carefully. The homepage cannot be deleted or unpublished.</p>
<p>Website Builder changes cover your storefront content and supported settings. Payments, checkout calculations, stock rules and StoreMink application code require changes outside the Builder.</p>$article$,
  'published',
  'Manage your StoreMink website with Mink AI',
  'Use Mink AI to fix storefront navigation, edit pages, review exact changes, publish drafts and manage shared website controls.',
  12, now()
FROM public.help_categories WHERE slug='storefront';
