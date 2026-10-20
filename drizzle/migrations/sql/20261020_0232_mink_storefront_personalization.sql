-- Mink AI: personalise the whole storefront from an interview, as one charged
-- private proposal and one human approval into the Website Builder draft.
--
-- Found by querying rather than enumerating (CODEBASE §38): every constraint
-- whose definition names 'apply_storefront_design', 'storefront_chrome' or
-- 'website_builder' is a vocabulary this tool or its draft kind has to join,
-- which is eight, plus the credit bounds, the credit function and the
-- provisioning function.

-- ---- The tool, in all three tool vocabularies -------------------------------
ALTER TABLE public.mink_action_tool_access DROP CONSTRAINT IF EXISTS mink_action_tool_access_name_check;
ALTER TABLE public.mink_action_tool_access ADD CONSTRAINT mink_action_tool_access_name_check CHECK (tool_name = ANY (ARRAY['apply_product_description','apply_product_seo','apply_product_images','create_product','create_coupon','update_coupon','create_customer_group','update_customer_group','create_category','update_category','create_offer','update_offer','activate_offer','adjust_inventory','bulk_adjust_inventory','apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder','apply_storefront_personalization','transition_order_status','publish_blog','send_campaign','bulk_update_prices','generate_media_image']::text[]));

ALTER TABLE public.mink_action_approvals DROP CONSTRAINT IF EXISTS mink_action_approvals_tool_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_tool_check CHECK (tool_name = ANY (ARRAY['apply_product_description','apply_product_seo','apply_product_images','create_product','create_coupon','update_coupon','create_customer_group','update_customer_group','create_category','update_category','create_offer','update_offer','activate_offer','adjust_inventory','bulk_adjust_inventory','apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder','apply_storefront_personalization','transition_order_status','publish_blog','send_campaign','bulk_update_prices','generate_media_image']::text[]));

ALTER TABLE public.mink_action_audit DROP CONSTRAINT IF EXISTS mink_action_audit_tool_check;
ALTER TABLE public.mink_action_audit ADD CONSTRAINT mink_action_audit_tool_check CHECK (tool_name = ANY (ARRAY['apply_product_description','apply_product_seo','apply_product_images','create_product','create_coupon','update_coupon','create_customer_group','update_customer_group','create_category','update_category','create_offer','update_offer','activate_offer','adjust_inventory','bulk_adjust_inventory','apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder','apply_storefront_personalization','transition_order_status','publish_blog','send_campaign','bulk_update_prices','generate_media_image']::text[]));

-- ★ The proposal is immutable, so its only version is 0 (0101's lesson: this
--   allowlist's NAME says nothing about tools).
ALTER TABLE public.mink_action_approvals DROP CONSTRAINT IF EXISTS mink_action_approvals_draft_version_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_draft_version_check CHECK (draft_version > 0 OR (tool_name = ANY (ARRAY['apply_storefront_code','publish_storefront_code','apply_storefront_layout','apply_storefront_design','manage_website_builder','apply_storefront_personalization']::text[]) AND draft_version = 0));

-- ---- The resource: the whole storefront ------------------------------------
-- ★ BOTH tables, or the audit insert rolls back the approval it records
--   (0071's lesson).
ALTER TABLE public.mink_action_approvals DROP CONSTRAINT IF EXISTS mink_action_approvals_resource_type_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (resource_type = ANY (ARRAY['product','coupon','customer_group','category','inventory','inventory_bulk','order','blog','campaign','price_bulk','offer','storefront_section','storefront_page','storefront_chrome','website_builder','storefront']::text[]));

ALTER TABLE public.mink_action_audit DROP CONSTRAINT IF EXISTS mink_action_audit_resource_type_check;
ALTER TABLE public.mink_action_audit ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (resource_type = ANY (ARRAY['product','coupon','customer_group','category','inventory','inventory_bulk','order','blog','campaign','price_bulk','offer','storefront_section','storefront_page','storefront_chrome','website_builder','storefront']::text[]));

-- ★ The approval names the store as its resource and carries the plan's
--   digest on both sides. Every jsonb_typeof is coalesced and resource_id is
--   tested for NULL on its own: a CHECK is satisfied by NULL, so an absent
--   key, or `resource_id = store_id` with no resource, would otherwise pass
--   (the trap recorded on 0062, 0064, 0101, 0103, 0106, 0215). Each result
--   arm is false, never NULL, for the same reason (0103).
ALTER TABLE public.mink_action_approvals DROP CONSTRAINT IF EXISTS mink_action_approvals_storefront_personalization_target_check;
ALTER TABLE public.mink_action_approvals ADD CONSTRAINT mink_action_approvals_storefront_personalization_target_check CHECK (tool_name <> 'apply_storefront_personalization' OR (resource_type = 'storefront' AND resource_id IS NOT NULL AND resource_id = store_id AND product_id IS NULL AND location_id IS NULL AND variant_id IS NULL AND operation = 'apply' AND source_approval_id IS NULL AND coalesce(jsonb_typeof(before_json->'plan_digest'),'') = 'string' AND coalesce(jsonb_typeof(after_json->'plan_digest'),'') = 'string' AND ((status = 'executed' AND result_id IS NOT NULL AND result_id = resource_id) OR (status <> 'executed' AND result_id IS NULL AND result_version IS NULL))));

ALTER TABLE public.mink_action_audit DROP CONSTRAINT IF EXISTS mink_action_audit_storefront_personalization_target_check;
ALTER TABLE public.mink_action_audit ADD CONSTRAINT mink_action_audit_storefront_personalization_target_check CHECK (tool_name <> 'apply_storefront_personalization' OR (resource_type = 'storefront' AND resource_id IS NOT NULL AND resource_id = store_id AND product_id IS NULL AND location_id IS NULL AND variant_id IS NULL AND operation = 'apply' AND coalesce(jsonb_typeof(before_json->'plan_digest'),'') = 'string' AND coalesce(jsonb_typeof(after_json->'plan_digest'),'') = 'string' AND ((outcome = 'executed' AND result_id IS NOT NULL AND result_id = resource_id) OR (outcome <> 'executed' AND result_id IS NULL))));

-- ---- The draft kind --------------------------------------------------------
ALTER TABLE public.mink_drafts DROP CONSTRAINT IF EXISTS mink_drafts_kind_check;
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_kind_check CHECK (kind = ANY (ARRAY['product_description','product_seo','product_images','blog','coupon_email','customer_message','product_create','coupon_create','coupon_update','customer_group_create','customer_group_update','category_create','category_update','social_post','inventory_adjustment','bulk_inventory_adjustment','order_status_transition','bulk_price_update','offer_create','offer_update','offer_activate','storefront_custom_code','storefront_layout','storefront_design','website_builder','media_image','storefront_personalization']::text[]));

ALTER TABLE public.mink_drafts DROP CONSTRAINT IF EXISTS mink_drafts_storefront_personalization_target_check;
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_storefront_personalization_target_check CHECK (kind <> 'storefront_personalization' OR (destination_type = 'storefront' AND destination_id IS NULL AND location_id IS NULL AND variant_id IS NULL AND coalesce(jsonb_typeof(content_json->'plan_json'),'') = 'string' AND coalesce(jsonb_typeof(content_json->'plan_digest'),'') = 'string' AND coalesce(jsonb_typeof(content_json->'explanation'),'') = 'string'));

-- ---- The charge ------------------------------------------------------------
-- ★★ A PERSONALISATION IS CHARGED FOR EVERYTHING IT MADE (owner, 2026-10-20:
--   each page and photo at today's price), so it may cost up to 200 credits
--   where every other proposal stays within 20. The ceiling is per KIND, in
--   the two ledgers and the function that writes them, so no other proposal
--   can reach the wider bound.
ALTER TABLE public.mink_drafts DROP CONSTRAINT IF EXISTS mink_drafts_credit_check;
ALTER TABLE public.mink_drafts ADD CONSTRAINT mink_drafts_credit_check CHECK (expected_credits >= 1 AND expected_credits <= (CASE WHEN kind = 'storefront_personalization' THEN 200 ELSE 20 END) AND charged_credits >= 0 AND charged_credits <= (CASE WHEN kind = 'storefront_personalization' THEN 200 ELSE 20 END) AND (credit_source IS NULL OR credit_source = ANY (ARRAY['plan','credit','mixed','plan_unlimited']::text[])));

ALTER TABLE public.mink_draft_credit_usage DROP CONSTRAINT IF EXISTS mink_draft_credit_usage_counts_check;
ALTER TABLE public.mink_draft_credit_usage ADD CONSTRAINT mink_draft_credit_usage_counts_check CHECK (expected_credits >= 1 AND expected_credits <= (CASE WHEN draft_kind = 'storefront_personalization' THEN 200 ELSE 20 END) AND charged_credits >= 0 AND charged_credits <= (CASE WHEN draft_kind = 'storefront_personalization' THEN 200 ELSE 20 END) AND plan_credits >= 0 AND balance_credits >= 0 AND charged_credits = plan_credits + balance_credits);

-- The function is 0040's, unchanged but for the per-kind ceiling.
CREATE OR REPLACE FUNCTION public.consume_mink_draft_credits(
  p_store UUID,
  p_admin TEXT,
  p_run UUID,
  p_draft UUID,
  p_period TEXT,
  p_plan_cap INTEGER,
  p_credits INTEGER,
  p_kind TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  existing_source TEXT;
  used_now INTEGER;
  balance_now INTEGER;
  plan_part INTEGER;
  balance_part INTEGER;
  result_source TEXT;
BEGIN
  IF p_credits < 1
    OR p_credits > (CASE WHEN p_kind = 'storefront_personalization' THEN 200 ELSE 20 END)
    OR p_plan_cap < 0 THEN
    RAISE EXCEPTION 'invalid Mink draft credit request';
  END IF;

  -- Locking the draft makes retries idempotent even when two tool calls for
  -- the same proposal arrive concurrently.
  PERFORM 1
  FROM public.mink_drafts AS draft
  JOIN public.mink_runs AS run
    ON run.id = draft.run_id AND run.store_id = draft.store_id
  JOIN public.mink_store_access AS access
    ON access.store_id = draft.store_id
  WHERE draft.id = p_draft AND draft.store_id = p_store
    AND draft.admin_id = p_admin AND draft.run_id = p_run
    AND draft.kind = p_kind AND run.requested_by = p_admin
    AND access.enabled AND access.drafting_enabled
  FOR UPDATE OF draft;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mink draft credit scope rejected';
  END IF;

  SELECT source INTO existing_source
  FROM public.mink_draft_credit_usage
  WHERE draft_id = p_draft;
  IF FOUND THEN
    RETURN existing_source;
  END IF;

  IF p_plan_cap IS NULL THEN
    INSERT INTO public.mink_draft_credit_usage
      (draft_id, store_id, run_id, draft_kind, period, expected_credits,
       charged_credits, plan_credits, balance_credits, source)
    VALUES
      (p_draft, p_store, p_run, p_kind, p_period, p_credits, 0, 0, 0, 'plan_unlimited');
    RETURN 'plan_unlimited';
  END IF;

  INSERT INTO public.ai_usage (store_id, period, used)
  VALUES (p_store, p_period, 0)
  ON CONFLICT (store_id, period) DO NOTHING;
  SELECT used INTO used_now
  FROM public.ai_usage
  WHERE store_id = p_store AND period = p_period
  FOR UPDATE;

  INSERT INTO public.ai_credit_balances (store_id, balance)
  VALUES (p_store, 0)
  ON CONFLICT (store_id) DO NOTHING;
  SELECT balance INTO balance_now
  FROM public.ai_credit_balances
  WHERE store_id = p_store
  FOR UPDATE;

  plan_part := LEAST(p_credits, GREATEST(p_plan_cap - used_now, 0));
  balance_part := p_credits - plan_part;
  IF balance_now < balance_part THEN
    RETURN 'insufficient';
  END IF;

  IF plan_part > 0 THEN
    UPDATE public.ai_usage
    SET used = used + plan_part
    WHERE store_id = p_store AND period = p_period;
  END IF;
  IF balance_part > 0 THEN
    UPDATE public.ai_credit_balances
    SET balance = balance - balance_part, updated_at = now()
    WHERE store_id = p_store;
    INSERT INTO public.ai_credit_ledger (store_id, delta, kind, ref, note)
    VALUES (
      p_store,
      -balance_part,
      'spend',
      'mink-draft:' || p_draft::text,
      'Mink AI ' || replace(p_kind, '_', ' ') || ' draft'
    );
  END IF;

  result_source := CASE
    WHEN plan_part > 0 AND balance_part > 0 THEN 'mixed'
    WHEN balance_part > 0 THEN 'credit'
    ELSE 'plan'
  END;
  INSERT INTO public.mink_draft_credit_usage
    (draft_id, store_id, run_id, draft_kind, period, expected_credits,
     charged_credits, plan_credits, balance_credits, source)
  VALUES
    (p_draft, p_store, p_run, p_kind, p_period, p_credits,
     p_credits, plan_part, balance_part, result_source);
  RETURN result_source;
END;
$fn$;
REVOKE ALL ON FUNCTION public.consume_mink_draft_credits(UUID, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.consume_mink_draft_credits(UUID, TEXT, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT) TO app_service;

-- ---- Every store gets the tool ----------------------------------------------
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
    'manage_website_builder',
    'apply_storefront_personalization'
  ]::text[]) AS tool
  ON CONFLICT (store_id, tool_name) DO UPDATE SET enabled=true,
    enabled_by=EXCLUDED.enabled_by, enabled_at=EXCLUDED.enabled_at, updated_at=now();
END;
$fn$;
REVOKE ALL ON FUNCTION public.enable_store_mink_access(uuid) FROM PUBLIC, anon, authenticated, app_user;

-- Every existing store gets the new tool, matching the all-or-nothing switch
-- every earlier tool followed (0101, 0103, 0106, 0159, 0215).
SELECT public.enable_store_mink_access(id) FROM public.stores;

-- ---- Help: the guide's design sentence, extended in place ------------------
UPDATE public.help_articles SET body=replace(body, $old$Ask for colours, fonts and other design changes in the same conversation.</p>$old$, $new$Ask for colours, fonts and other design changes in the same conversation.</p>

<p>To make your theme feel like your own shop, ask Mink to <strong>personalise my storefront</strong>. Mink asks a few questions about what you sell and how your store should look, then prepares one card. It rewrites the theme's sample text on your pages, draws new photos in place of the theme's own photos (photos you uploaded stay as they are), suggests colours and fonts, and can take the theme's sample products off your shop. Store policies are never rewritten, and sample customer quotes and press logos are switched off rather than rewritten. Mink changes a category only after you agree to that change. Applying the card saves your pages, header and footer to the Website Builder draft for you to publish; category, sample product, tagline and footer description changes apply to your live store straight away, and the card lists them before you apply. One card makes up to 12 new photos, the most visible first. When photos are left over, or your Mink credits run low, the card says so; after you apply it, ask Mink to make the rest of the photos.</p>$new$), updated_at=now() WHERE slug='manage-your-website-with-mink-ai' AND status='published';
