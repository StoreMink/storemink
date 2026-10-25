-- Generate with AI gives back what it took when the model fails (robustness
-- audit B1, 2026-10-23).
--
-- consumeAiQuota (lib/ai/quota.ts) takes a Mink credit BEFORE the model is
-- asked: one unit of the plan cycle's included allowance (ai_usage.used, by
-- try_ai_generation) or, once that is spent, one purchased or granted credit
-- (by try_spend_ai_credit). Nothing ever gave it back, so a busy, slow or
-- failed model call charged the merchant for nothing. refund_ai_quota is the
-- way back; refundAiQuota calls it on every way out that does not deliver.
--
-- ★★ ONE REFUND PER TAKE. Every take carries a fresh id minted by the app
-- (take_id). The refund records that id here FIRST, with ON CONFLICT DO
-- NOTHING, and gives back only when that insert happened, inside the same
-- function call. So a second refund of the same take (a retried request, a
-- caller wired twice, two racing calls: the loser waits on the primary key
-- and then finds it taken) gives back nothing. The primary key is the whole
-- idempotency story, the purchase-ref pattern add_ai_credits uses.
--
-- ★ THE PLAN ALLOWANCE IS GIVEN BACK BY COUNT, NEVER BELOW 0. ai_usage keeps
-- one counter per store and period, not a row per generation, so the refund
-- lowers the period the take was counted in. The take carries that period,
-- so a 30-day cycle that turned during the request is still refunded where
-- it was charged.
--
-- ★ A PURCHASED CREDIT COMES BACK AS A LEDGER 'grant' WITH ref
-- 'refund:<take id>'. ai_credit_ledger.kind allows purchase, grant and spend,
-- and a separate 'refund' kind is deliberately not added here: the Plans &
-- Billing activity list looks every row's kind up in a fixed table
-- (app/dashboard/plans/plans-client.tsx KIND_META), so a kind it does not know
-- would stop that page rendering. A grant reads correctly to both readers of
-- the ledger: Plans & Billing shows "Grant +1" with the note beside it, and
-- the operator console shows the refund: ref, which no operator grant carries
-- (theirs is the operator's email). The balance and the ledger stay in step:
-- the take's spend row and this grant row add up to what the balance shows.
--
-- Expand-only: a new service-only table (RLS on, no policies, app_user has no
-- grants) and a new function nothing in the running revision calls.

CREATE TABLE IF NOT EXISTS public.ai_quota_refunds (
  take_id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  source text NOT NULL,
  period text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_quota_refunds_source_check CHECK (
    (source = 'plan' AND period IS NOT NULL)
    OR (source = 'credit' AND period IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_quota_refunds_store_idx
  ON public.ai_quota_refunds (store_id, created_at DESC);

ALTER TABLE public.ai_quota_refunds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_quota_refunds FROM PUBLIC;
REVOKE ALL ON public.ai_quota_refunds FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_quota_refunds TO app_service;

CREATE OR REPLACE FUNCTION public.refund_ai_quota(
  p_take uuid,
  p_store uuid,
  p_source text,
  p_period text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Once the first three arms have passed, every arm is true or false,
  -- never a NULL that plpgsql would read as false.
  IF p_take IS NULL OR p_store IS NULL OR p_source IS NULL
     OR p_source NOT IN ('plan', 'credit')
     OR (p_source = 'plan' AND p_period IS NULL)
     OR (p_source = 'credit' AND p_period IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid AI quota refund';
  END IF;

  INSERT INTO public.ai_quota_refunds (take_id, store_id, source, period)
  VALUES (p_take, p_store, p_source, p_period)
  ON CONFLICT (take_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN false; -- this take was already refunded
  END IF;

  IF p_source = 'plan' THEN
    UPDATE public.ai_usage
       SET used = used - 1
     WHERE store_id = p_store AND period = p_period AND used > 0;
  ELSE
    INSERT INTO public.ai_credit_ledger (store_id, delta, kind, ref, note)
    VALUES (
      p_store,
      1,
      'grant',
      'refund:' || p_take::text,
      'Refund: an AI request failed'
    );
    INSERT INTO public.ai_credit_balances (store_id, balance, updated_at)
    VALUES (p_store, 1, now())
    ON CONFLICT (store_id) DO UPDATE
      SET balance = public.ai_credit_balances.balance + 1,
          updated_at = now();
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_ai_quota(uuid, uuid, text, text)
  FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.refund_ai_quota(uuid, uuid, text, text)
  TO app_service;
