-- Refine with Mink AI: one retouched, exactly-sized copy of a merchant photo.
--
-- ★ ONE ROW PER REFINE, AND THE ROW IS THE CHARGE. A refine is not part of a
-- Mink chat run, so the run- and draft-scoped credit functions cannot carry
-- it. This table is both the audit record (who refined which photo, for which
-- destination, and what came back) and the idempotency key for the charge:
-- the function below returns the recorded outcome for an id it has already
-- seen, so a retried request can never take the credits twice.
--
-- ★ THE SAME POOL, IN THE SAME ORDER, as every other Mink charge: the plan
-- cycle's included allowance (`ai_usage`) first, then non-expiring top-ups
-- (`ai_credit_balances`). All-or-nothing — a refine either takes every credit
-- it costs or none, and reports 'insufficient' rather than clamping, because
-- nothing has been handed to the merchant yet when it is called.
--
-- Service-only (RLS on, no policies, app_user has no grants), like every other
-- Mink ledger.

CREATE TABLE IF NOT EXISTS public.mink_image_refinements (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  destination text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  source_url text NOT NULL,
  result_url text,
  result_path text,
  period text NOT NULL,
  charged_credits integer NOT NULL DEFAULT 0,
  plan_credits integer NOT NULL DEFAULT 0,
  balance_credits integer NOT NULL DEFAULT 0,
  credit_source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mink_image_refinements_size_check
    CHECK (width BETWEEN 64 AND 4096 AND height BETWEEN 64 AND 4096),
  CONSTRAINT mink_image_refinements_credits_check
    CHECK (
      charged_credits >= 0 AND plan_credits >= 0 AND balance_credits >= 0
      AND charged_credits = plan_credits + balance_credits
    ),
  CONSTRAINT mink_image_refinements_source_check
    CHECK (credit_source IN ('plan', 'credit', 'mixed', 'plan_unlimited'))
);

CREATE INDEX IF NOT EXISTS mink_image_refinements_store_idx
  ON public.mink_image_refinements (store_id, created_at DESC);

ALTER TABLE public.mink_image_refinements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mink_image_refinements FROM PUBLIC;
REVOKE ALL ON public.mink_image_refinements FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mink_image_refinements TO app_service;

CREATE OR REPLACE FUNCTION public.consume_mink_refine_credits(
  p_refinement uuid,
  p_store uuid,
  p_admin text,
  p_destination text,
  p_width integer,
  p_height integer,
  p_source_url text,
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
    RAISE EXCEPTION 'invalid Mink refine credit request';
  END IF;

  SELECT credit_source INTO existing_source
  FROM public.mink_image_refinements
  WHERE id = p_refinement AND store_id = p_store
  FOR UPDATE;
  IF FOUND THEN
    RETURN existing_source;
  END IF;

  IF p_plan_cap IS NULL THEN
    INSERT INTO public.mink_image_refinements
      (id, store_id, admin_id, destination, width, height, source_url, period,
       charged_credits, plan_credits, balance_credits, credit_source)
    VALUES
      (p_refinement, p_store, p_admin, p_destination, p_width, p_height,
       p_source_url, p_period, 0, 0, 0, 'plan_unlimited');
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
      'mink-refine:' || p_refinement::text,
      'Refine with Mink AI'
    );
  END IF;

  result_source := CASE
    WHEN plan_part > 0 AND balance_part > 0 THEN 'mixed'
    WHEN balance_part > 0 THEN 'credit'
    ELSE 'plan'
  END;
  INSERT INTO public.mink_image_refinements
    (id, store_id, admin_id, destination, width, height, source_url, period,
     charged_credits, plan_credits, balance_credits, credit_source)
  VALUES
    (p_refinement, p_store, p_admin, p_destination, p_width, p_height,
     p_source_url, p_period, p_credits, plan_part, balance_part, result_source);
  RETURN result_source;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_mink_refine_credits(
  uuid, uuid, text, text, integer, integer, text, text, integer, integer
) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.consume_mink_refine_credits(
  uuid, uuid, text, text, integer, integer, text, text, integer, integer
) TO app_service;
