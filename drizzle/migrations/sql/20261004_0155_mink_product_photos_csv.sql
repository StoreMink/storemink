-- Exact tool/kind registries preserve existing members and add product photos.
ALTER TABLE public.mink_action_tool_access DROP CONSTRAINT mink_action_tool_access_name_check;
ALTER TABLE public.mink_action_tool_access ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
  tool_name = ANY (ARRAY[
    'apply_product_description',
    'apply_product_seo',
    'apply_product_images',
    'create_product',
    'create_coupon',
    'update_coupon',
    'create_customer_group',
    'update_customer_group',
    'adjust_inventory',
    'bulk_adjust_inventory',
    'transition_order_status',
    'publish_blog',
    'send_campaign',
    'bulk_update_prices',
    'create_offer',
    'update_offer',
    'activate_offer',
    'apply_storefront_code',
    'publish_storefront_code',
    'apply_storefront_layout',
    'apply_storefront_design',
    'generate_media_image']::text[])
);
ALTER TABLE public.mink_action_approvals DROP CONSTRAINT mink_action_approvals_tool_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
  tool_name = ANY (ARRAY[
    'apply_product_description',
    'apply_product_seo',
    'apply_product_images',
    'create_product',
    'create_coupon',
    'update_coupon',
    'create_customer_group',
    'update_customer_group',
    'adjust_inventory',
    'bulk_adjust_inventory',
    'transition_order_status',
    'publish_blog',
    'send_campaign',
    'bulk_update_prices',
    'create_offer',
    'update_offer',
    'activate_offer',
    'apply_storefront_code',
    'publish_storefront_code',
    'apply_storefront_layout',
    'apply_storefront_design']::text[])
);
ALTER TABLE public.mink_action_audit DROP CONSTRAINT mink_action_audit_tool_check;
ALTER TABLE public.mink_action_audit ADD CONSTRAINT mink_action_audit_tool_check CHECK (
  tool_name = ANY (ARRAY[
    'apply_product_description',
    'apply_product_seo',
    'apply_product_images',
    'create_product',
    'create_coupon',
    'update_coupon',
    'create_customer_group',
    'update_customer_group',
    'adjust_inventory',
    'bulk_adjust_inventory',
    'transition_order_status',
    'publish_blog',
    'send_campaign',
    'bulk_update_prices',
    'create_offer',
    'update_offer',
    'activate_offer',
    'apply_storefront_code',
    'publish_storefront_code',
    'apply_storefront_layout',
    'apply_storefront_design']::text[])
);
ALTER TABLE public.mink_drafts DROP CONSTRAINT mink_drafts_kind_check;
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_kind_check CHECK (
  kind = ANY (ARRAY[
    'product_description',
    'product_seo',
    'product_images',
    'blog',
    'coupon_email',
    'customer_message',
    'product_create',
    'coupon_create',
    'coupon_update',
    'customer_group_create',
    'customer_group_update',
    'inventory_adjustment',
    'bulk_inventory_adjustment',
    'order_status_transition',
    'bulk_price_update',
    'offer_create',
    'offer_update',
    'offer_activate',
    'storefront_custom_code',
    'storefront_layout',
    'storefront_design',
    'media_image']::text[])
);
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_product_images_target_check CHECK (
  kind <> 'product_images' OR (
    destination_type='product' AND destination_id IS NOT NULL
    AND coalesce(jsonb_typeof(content_json->'image_url'),'')='string'
    AND coalesce(jsonb_typeof(content_json->'images_json'),'')='string'
  )
);
INSERT INTO public.mink_action_tool_access (store_id,tool_name,enabled,enabled_by,enabled_at,updated_at)
SELECT store_id,'apply_product_images',true,invited_by,now(),now()
FROM public.mink_store_access WHERE enabled AND drafting_enabled
ON CONFLICT (store_id,tool_name) DO NOTHING;

-- Private immutable CSV versions never go in the publicly readable Media bucket.
CREATE TABLE public.mink_csv_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 160),
  csv text NOT NULL CHECK (octet_length(csv) BETWEEN 1 AND 5242880),
  changes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changes)='array'),
  job_id uuid REFERENCES public.data_jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mink_csv_files_owner_idx ON public.mink_csv_files (store_id,admin_id,created_at);
ALTER TABLE public.mink_csv_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_csv_files FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.mink_csv_files TO service_role,app_service;
ALTER TABLE public.data_jobs ADD COLUMN failed_lines integer[] NOT NULL DEFAULT '{}';

-- Replace the existing task guidance, without adding another guide section.
UPDATE public.help_articles SET body=replace(body,
  $old$Spreadsheets, audio files, external web addresses and long documents are not supported$old$,
  $new$Product CSV files are supported; Excel workbooks, audio files, external web addresses and long documents are not supported$new$),updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
UPDATE public.help_articles SET body=replace(body,
  $old$A separately enabled product-text action can change only the product description or SEO fields shown in its exact approval preview.$old$,
  $new$Product changes require your approval of the exact fields shown. To replace a product photo, attach your own image and name the product. Mink prepares a private photo proposal with the primary photo and gallery; review it, save the private draft, then choose Review product change and Approve and apply. You can replace the primary photo, add gallery photos or replace the gallery. The other product fields stay as they are. If you need to undo an approved photo change, use its rollback review before approving the restore.$new$),updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
UPDATE public.help_articles SET body=replace(body,
  $old$Product-description approval changes only the description. Product-SEO approval changes only the SEO title and SEO description. The action never changes price, inventory, variants, status, publication, images or any other product field.$old$,
  $new$Product-description approval changes only the description. Product-SEO approval changes only the SEO title and SEO description. Product-photo approval changes only the primary photo and gallery shown in the review. These actions never change price, inventory, variants, status or publication.$new$),updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
UPDATE public.help_articles SET body=replace(body,
  $old$Short UTF-8 text and Markdown files are read on your device; images and PDFs are read by StoreMink's AI provider.$old$,
  $new$Short UTF-8 text and Markdown files are read on your device; images and PDFs are read by StoreMink's AI provider. To import new products, attach a UTF-8 .csv file up to 5 MiB and 5,000 rows and ask Mink to check and import it. Mink reports errors by line and column and can prepare a corrected copy using the facts you provide; it asks for missing facts rather than guessing prices or stock. Review the corrections or download the CSV, then choose Approve and import new products. Existing product handles are skipped. The CSV's Status and other supplied fields follow the normal product importer, including publication when Status is published. The card shows progress and links to Import details; the import continues if you close chat. Ask Mink to check and correct errors to prepare another import containing only failed or unprocessed rows. Private CSV copies are available for seven days and are never added to your Media library. A photo proposal costs one Mink credit; CSV checks use chat credits without an additional drafting charge.$new$),updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body,
  $old$Audio files, video, spreadsheets and long documents are not attachments: use the microphone for dictation.$old$,
  $new$Audio files, video, Excel workbooks and long documents are not attachments; product CSV files use the chat import workflow. Use the microphone for dictation.$new$),updated_at=now()
WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
