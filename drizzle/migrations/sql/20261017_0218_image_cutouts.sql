-- Background removal: one cut-out per photo, charged once, reused for every
-- background the merchant then tries.
--
-- ★ ONE ROW PER PHOTO, KEYED BY THE PHOTO'S BYTES. `source_digest` is the
-- SHA-256 of the photo the merchant uploaded, unique per store. The first
-- request cuts the product out (services/image-matting), stores the cut-out
-- and is charged; every later request for the same photo, with white, a
-- colour or no background, reuses the stored cut-out and is free. That is the
-- price the owner set (2026-10-17): 1 Mink credit per photo, not per try.
--
-- ★ THE ROW IS THE CHARGE, the same contract as mink_image_refinements: the
-- function below records the cut-out and takes the credits in one statement,
-- all-or-nothing, from the plan cycle's allowance first and then top-ups, and
-- reports 'insufficient' rather than clamping, because nothing has been
-- handed to the merchant yet.
--
-- ★ TWO REQUESTS FOR ONE PHOTO CHARGE ONCE. A transaction-scoped advisory
-- lock on (store, digest) serialises them; the second finds the first's row
-- and gets it back with reused = true. The unique constraint is the backstop.
--
-- Service-only (RLS on, no policies, app_user has no grants), like every
-- other Mink ledger.

CREATE TABLE IF NOT EXISTS public.mink_image_cutouts (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  source_url text NOT NULL,
  source_digest text NOT NULL,
  cutout_url text NOT NULL,
  cutout_path text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  checks text[] NOT NULL DEFAULT '{}',
  period text NOT NULL,
  charged_credits integer NOT NULL DEFAULT 0,
  plan_credits integer NOT NULL DEFAULT 0,
  balance_credits integer NOT NULL DEFAULT 0,
  credit_source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mink_image_cutouts_store_digest_key UNIQUE (store_id, source_digest),
  CONSTRAINT mink_image_cutouts_digest_check
    CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mink_image_cutouts_size_check
    CHECK (width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096),
  CONSTRAINT mink_image_cutouts_credits_check
    CHECK (
      charged_credits >= 0 AND plan_credits >= 0 AND balance_credits >= 0
      AND charged_credits = plan_credits + balance_credits
    ),
  CONSTRAINT mink_image_cutouts_source_check
    CHECK (credit_source IN ('plan', 'credit', 'mixed', 'plan_unlimited'))
);

CREATE INDEX IF NOT EXISTS mink_image_cutouts_store_idx
  ON public.mink_image_cutouts (store_id, created_at DESC);

ALTER TABLE public.mink_image_cutouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_image_cutouts FROM PUBLIC;
REVOKE ALL ON public.mink_image_cutouts FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mink_image_cutouts TO app_service;

CREATE OR REPLACE FUNCTION public.consume_mink_cutout_credits(
  p_cutout uuid,
  p_store uuid,
  p_admin text,
  p_source_url text,
  p_source_digest text,
  p_cutout_url text,
  p_cutout_path text,
  p_width integer,
  p_height integer,
  p_checks text[],
  p_period text,
  p_plan_cap integer,
  p_credits integer
) RETURNS TABLE (cutout_id uuid, credit_source text, reused boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
-- The OUT column credit_source shares a name with the table's column;
-- inside SQL statements, the column wins.
#variable_conflict use_column
DECLARE
  existing_id uuid;
  existing_source text;
  used_now integer;
  balance_now integer;
  plan_part integer;
  balance_part integer;
  result_source text;
BEGIN
  IF p_credits < 1 OR p_credits > 20 OR p_plan_cap < 0 THEN
    RAISE EXCEPTION 'invalid Mink cut-out credit request';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('mink-cutout:' || p_store::text || ':' || p_source_digest, 0)
  );

  SELECT c.id, c.credit_source INTO existing_id, existing_source
  FROM public.mink_image_cutouts c
  WHERE c.store_id = p_store AND c.source_digest = p_source_digest;
  IF FOUND THEN
    RETURN QUERY SELECT existing_id, existing_source, true;
    RETURN;
  END IF;

  IF p_plan_cap IS NULL THEN
    INSERT INTO public.mink_image_cutouts
      (id, store_id, admin_id, source_url, source_digest, cutout_url,
       cutout_path, width, height, checks, period,
       charged_credits, plan_credits, balance_credits, credit_source)
    VALUES
      (p_cutout, p_store, p_admin, p_source_url, p_source_digest, p_cutout_url,
       p_cutout_path, p_width, p_height, coalesce(p_checks, '{}'), p_period,
       0, 0, 0, 'plan_unlimited');
    RETURN QUERY SELECT p_cutout, 'plan_unlimited'::text, false;
    RETURN;
  END IF;

  INSERT INTO public.ai_usage (store_id, period, used)
  VALUES (p_store, p_period, 0)
  ON CONFLICT (store_id, period) DO NOTHING;
  SELECT u.used INTO used_now
  FROM public.ai_usage u
  WHERE u.store_id = p_store AND u.period = p_period
  FOR UPDATE;

  INSERT INTO public.ai_credit_balances (store_id, balance)
  VALUES (p_store, 0)
  ON CONFLICT (store_id) DO NOTHING;
  SELECT b.balance INTO balance_now
  FROM public.ai_credit_balances b
  WHERE b.store_id = p_store
  FOR UPDATE;

  plan_part := LEAST(p_credits, GREATEST(p_plan_cap - used_now, 0));
  balance_part := p_credits - plan_part;
  IF balance_now < balance_part THEN
    RETURN QUERY SELECT NULL::uuid, 'insufficient'::text, false;
    RETURN;
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
      'mink-cutout:' || p_cutout::text,
      'Background removal'
    );
  END IF;

  result_source := CASE
    WHEN plan_part > 0 AND balance_part > 0 THEN 'mixed'
    WHEN balance_part > 0 THEN 'credit'
    ELSE 'plan'
  END;
  INSERT INTO public.mink_image_cutouts
    (id, store_id, admin_id, source_url, source_digest, cutout_url,
     cutout_path, width, height, checks, period,
     charged_credits, plan_credits, balance_credits, credit_source)
  VALUES
    (p_cutout, p_store, p_admin, p_source_url, p_source_digest, p_cutout_url,
     p_cutout_path, p_width, p_height, coalesce(p_checks, '{}'), p_period,
     p_credits, plan_part, balance_part, result_source);
  RETURN QUERY SELECT p_cutout, result_source, false;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_mink_cutout_credits(
  uuid, uuid, text, text, text, text, text, integer, integer, text[], text, integer, integer
) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.consume_mink_cutout_credits(
  uuid, uuid, text, text, text, text, text, integer, integer, text[], text, integer, integer
) TO app_service;

-- A photo with its background replaced is a Media row of its own kind
-- ('mink_edited'), so the Library can keep the colour previews a merchant
-- tried and did not use out of its list (the one a product uses shows under
-- Product images) while the row still proves the store owns the file.
ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS media_assets_source_check;
ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_source_check
  CHECK (source = ANY (ARRAY[
    'upload'::text,
    'mink_attachment'::text,
    'mink_generated'::text,
    'mink_refined'::text,
    'mink_prepared'::text,
    'mink_edited'::text
  ]));
