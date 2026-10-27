-- AI product photos: the merchant's real photo re-shot by Mink AI in a scene
-- they chose or described ("on a marble counter", "hanging from a tree in a
-- garden"). Replaces the empty-set scenes of 0220 in the photo editor: the
-- owner judged a cut-out standing on a drawn set unconvincing (2026-10-18) and
-- chose the Shopify Sidekick approach, where the model draws the product into
-- the scene. mink_image_scenes stays (forward-only) and is no longer written.
--
-- ★ ONE ROW PER PHOTO CREATED, AND THE ROW IS THE CHARGE: the function below
-- records the photo and takes the credits in one statement, all-or-nothing,
-- from the plan cycle's allowance first and then top-ups, and reports
-- 'insufficient' rather than clamping, because nothing has been handed to the
-- merchant yet. Idempotent per edit id. "Try again" is a new photo and a new
-- row: every photo is a real model call.
--
-- ★ THE REQUEST IS KEPT (instruction): it is what the merchant paid for, and
-- the only way to answer "why does this photo look like that?" later.
--
-- Service-only (RLS on, no policies, app_user has no grants).

CREATE TABLE IF NOT EXISTS public.mink_photo_edits (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  destination text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  source_url text NOT NULL,
  instruction text NOT NULL,
  result_url text NOT NULL,
  result_path text NOT NULL,
  model text NOT NULL,
  period text NOT NULL,
  charged_credits integer NOT NULL DEFAULT 0,
  plan_credits integer NOT NULL DEFAULT 0,
  balance_credits integer NOT NULL DEFAULT 0,
  credit_source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mink_photo_edits_instruction_check
    CHECK (char_length(instruction) BETWEEN 1 AND 1000),
  CONSTRAINT mink_photo_edits_size_check
    CHECK (width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096),
  CONSTRAINT mink_photo_edits_credits_check
    CHECK (
      charged_credits >= 0 AND plan_credits >= 0 AND balance_credits >= 0
      AND charged_credits = plan_credits + balance_credits
    ),
  CONSTRAINT mink_photo_edits_source_check
    CHECK (credit_source IN ('plan', 'credit', 'mixed', 'plan_unlimited'))
);

CREATE INDEX IF NOT EXISTS mink_photo_edits_store_idx
  ON public.mink_photo_edits (store_id, created_at DESC);

ALTER TABLE public.mink_photo_edits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_photo_edits FROM PUBLIC;
REVOKE ALL ON public.mink_photo_edits FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mink_photo_edits TO app_service;

CREATE OR REPLACE FUNCTION public.consume_mink_photo_edit_credits(
  p_edit uuid,
  p_store uuid,
  p_admin text,
  p_destination text,
  p_width integer,
  p_height integer,
  p_source_url text,
  p_instruction text,
  p_result_url text,
  p_result_path text,
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
    RAISE EXCEPTION 'invalid Mink photo edit credit request';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('mink-photo-edit:' || p_edit::text, 0)
  );

  SELECT e.credit_source INTO existing_source
  FROM public.mink_photo_edits e
  WHERE e.id = p_edit AND e.store_id = p_store;
  IF FOUND THEN
    RETURN existing_source;
  END IF;

  IF p_plan_cap IS NULL THEN
    INSERT INTO public.mink_photo_edits
      (id, store_id, admin_id, destination, width, height, source_url,
       instruction, result_url, result_path, model, period,
       charged_credits, plan_credits, balance_credits, credit_source)
    VALUES
      (p_edit, p_store, p_admin, p_destination, p_width, p_height,
       p_source_url, p_instruction, p_result_url, p_result_path, p_model,
       p_period, 0, 0, 0, 'plan_unlimited');
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
      'mink-photo-edit:' || p_edit::text,
      'AI product photo'
    );
  END IF;

  result_source := CASE
    WHEN plan_part > 0 AND balance_part > 0 THEN 'mixed'
    WHEN balance_part > 0 THEN 'credit'
    ELSE 'plan'
  END;
  INSERT INTO public.mink_photo_edits
    (id, store_id, admin_id, destination, width, height, source_url,
     instruction, result_url, result_path, model, period,
     charged_credits, plan_credits, balance_credits, credit_source)
  VALUES
    (p_edit, p_store, p_admin, p_destination, p_width, p_height,
     p_source_url, p_instruction, p_result_url, p_result_path, p_model,
     p_period, p_credits, plan_part, balance_part, result_source);
  RETURN result_source;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_mink_photo_edit_credits(
  uuid, uuid, text, text, integer, integer, text, text, text, text, text, text, integer, integer
) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.consume_mink_photo_edit_credits(
  uuid, uuid, text, text, integer, integer, text, text, text, text, text, text, integer, integer
) TO app_service;
