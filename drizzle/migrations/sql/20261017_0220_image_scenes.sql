-- Scenes for Change background: an empty set (a marble counter, linen, a
-- beach) drawn by Mink's image model, into which a merchant's real product is
-- placed. The model never draws the product.
--
-- ★ ONE ROW PER SCENE DRAWN, REUSED. The web app uses a store's newest scene
-- for a preset and frame size for every product placed in it, free; drawing
-- a new one is an explicit choice and adds a row. That is the owner's price
-- (2026-10-17): 5 Mink credits per scene, the real cost of one Gemini 3.1
-- Flash Image call.
--
-- ★ THE ROW IS THE CHARGE, the mink_image_cutouts contract: the function below
-- records the scene and takes the credits in one statement, all-or-nothing,
-- from the plan cycle's allowance first and then top-ups, and reports
-- 'insufficient' rather than clamping, because nothing has been handed to the
-- merchant yet. Idempotent per scene id.
--
-- ★ `preset` is checked for shape only: the list of presets is the web app's
-- (lib/media/scene-presets.ts), so a new preset needs no migration.
--
-- Service-only (RLS on, no policies, app_user has no grants).

CREATE TABLE IF NOT EXISTS public.mink_image_scenes (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  preset text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  scene_url text NOT NULL,
  scene_path text NOT NULL,
  model text NOT NULL,
  period text NOT NULL,
  charged_credits integer NOT NULL DEFAULT 0,
  plan_credits integer NOT NULL DEFAULT 0,
  balance_credits integer NOT NULL DEFAULT 0,
  credit_source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mink_image_scenes_preset_check
    CHECK (preset ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT mink_image_scenes_size_check
    CHECK (width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096),
  CONSTRAINT mink_image_scenes_credits_check
    CHECK (
      charged_credits >= 0 AND plan_credits >= 0 AND balance_credits >= 0
      AND charged_credits = plan_credits + balance_credits
    ),
  CONSTRAINT mink_image_scenes_source_check
    CHECK (credit_source IN ('plan', 'credit', 'mixed', 'plan_unlimited'))
);

CREATE INDEX IF NOT EXISTS mink_image_scenes_lookup_idx
  ON public.mink_image_scenes (store_id, preset, width, height, created_at DESC);

ALTER TABLE public.mink_image_scenes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_image_scenes FROM PUBLIC;
REVOKE ALL ON public.mink_image_scenes FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mink_image_scenes TO app_service;

CREATE OR REPLACE FUNCTION public.consume_mink_scene_credits(
  p_scene uuid,
  p_store uuid,
  p_admin text,
  p_preset text,
  p_width integer,
  p_height integer,
  p_scene_url text,
  p_scene_path text,
  p_model text,
  p_period text,
  p_plan_cap integer,
  p_credits integer
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  existing_source text;
  used_now integer;
  balance_now integer;
  plan_part integer;
  balance_part integer;
  result_source text;
BEGIN
  IF p_credits < 1 OR p_credits > 20 OR p_plan_cap < 0 THEN
    RAISE EXCEPTION 'invalid Mink scene credit request';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('mink-scene:' || p_scene::text, 0)
  );

  SELECT s.credit_source INTO existing_source
  FROM public.mink_image_scenes s
  WHERE s.id = p_scene AND s.store_id = p_store;
  IF FOUND THEN
    RETURN existing_source;
  END IF;

  IF p_plan_cap IS NULL THEN
    INSERT INTO public.mink_image_scenes
      (id, store_id, admin_id, preset, width, height, scene_url, scene_path,
       model, period, charged_credits, plan_credits, balance_credits,
       credit_source)
    VALUES
      (p_scene, p_store, p_admin, p_preset, p_width, p_height, p_scene_url,
       p_scene_path, p_model, p_period, 0, 0, 0, 'plan_unlimited');
    RETURN 'plan_unlimited';
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
      'mink-scene:' || p_scene::text,
      'Background scene'
    );
  END IF;

  result_source := CASE
    WHEN plan_part > 0 AND balance_part > 0 THEN 'mixed'
    WHEN balance_part > 0 THEN 'credit'
    ELSE 'plan'
  END;
  INSERT INTO public.mink_image_scenes
    (id, store_id, admin_id, preset, width, height, scene_url, scene_path,
     model, period, charged_credits, plan_credits, balance_credits,
     credit_source)
  VALUES
    (p_scene, p_store, p_admin, p_preset, p_width, p_height, p_scene_url,
     p_scene_path, p_model, p_period, p_credits, plan_part, balance_part,
     result_source);
  RETURN result_source;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_mink_scene_credits(
  uuid, uuid, text, text, integer, integer, text, text, text, text, integer, integer
) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.consume_mink_scene_credits(
  uuid, uuid, text, text, integer, integer, text, text, text, text, integer, integer
) TO app_service;
