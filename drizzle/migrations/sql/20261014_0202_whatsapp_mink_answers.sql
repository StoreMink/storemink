-- Customer-facing Mink on WhatsApp (docs/whatsapp-commerce-plan.md §13,
-- §16 Phase 2): Mink answers a customer's question from the store's own facts
-- (the customer's orders, matched products, delivery to a PIN, offers,
-- policies, hours) or hands the chat to a person, in one of two modes the
-- merchant chooses.
--
--   whatsapp_auto_replies.mink_mode
--       'off' (the default: nothing changes for a store that never chose),
--       'helps' (Mink answers inside its facts and hands over the rest) or
--       'drafts' (every reply waits for a person, with Mink's draft attached).
--
--   whatsapp_mink_answers
--       one row per question Mink was asked: the mode, what happened
--       (draft | sent | discarded | handed_over | failed), the answer, the
--       short list of facts it drew on, the model and its token counts, and,
--       once an answer is SENT, the credit it cost. Service-only like every
--       whatsapp_* table (RLS on, no policies, app_user revoked). A row is the
--       idempotency key for its charge: the function below charges an id it
--       has already charged exactly never again.
--
--   consume_mink_whatsapp_answer
--       the charge, one Mink credit per sent answer (plan §19.6), from the
--       same pool and in the same order as every other Mink charge: the plan
--       cycle's included allowance (ai_usage), then non-expiring top-ups
--       (ai_credit_balances). All-or-nothing, and it FAILS CLOSED: a store
--       with nothing left is told 'insufficient' and the customer gets a
--       person, never an answer that bills later.
--
-- Backward compatible: one column with a default the revision being replaced
-- never reads, one new table, one new function.

ALTER TABLE public.whatsapp_auto_replies
  ADD COLUMN IF NOT EXISTS mink_mode text NOT NULL DEFAULT 'off';

ALTER TABLE public.whatsapp_auto_replies
  DROP CONSTRAINT IF EXISTS whatsapp_auto_replies_mink_mode_check;
ALTER TABLE public.whatsapp_auto_replies
  ADD CONSTRAINT whatsapp_auto_replies_mink_mode_check
    CHECK (mink_mode IN ('off', 'helps', 'drafts'));

COMMENT ON COLUMN public.whatsapp_auto_replies.mink_mode IS
  'What Mink AI does with a customer''s question on WhatsApp: off, helps (answers from the store''s facts, hands over the rest) or drafts (a person approves every reply).';

CREATE TABLE IF NOT EXISTS public.whatsapp_mink_answers (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  -- The customer's message this answers. Kept when the message row goes.
  message_id uuid REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  mode text NOT NULL,
  outcome text NOT NULL,
  reason text NOT NULL DEFAULT '',
  answer text NOT NULL DEFAULT '',
  -- Short labels of what the answer drew on ("Order ORD10011027", "Refund
  -- & Cancellation Policy"), for the staff card. Never amounts or details.
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL DEFAULT '',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  -- The charge, filled by consume_mink_whatsapp_answer once the answer is
  -- sent; credit_source NULL means not charged (a draft, a hand-over).
  period text,
  charged_credits integer NOT NULL DEFAULT 0,
  plan_credits integer NOT NULL DEFAULT 0,
  balance_credits integer NOT NULL DEFAULT 0,
  credit_source text,
  sent_message_id uuid REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  sent_by_admin_id text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_mink_answers_mode_check
    CHECK (mode IN ('helps', 'drafts')),
  CONSTRAINT whatsapp_mink_answers_outcome_check
    CHECK (outcome IN ('draft', 'sent', 'discarded', 'handed_over', 'failed')),
  CONSTRAINT whatsapp_mink_answers_answer_length_check
    CHECK (char_length(answer) <= 4096),
  CONSTRAINT whatsapp_mink_answers_facts_check
    CHECK (jsonb_typeof(facts) = 'array'),
  CONSTRAINT whatsapp_mink_answers_tokens_check
    CHECK (input_tokens >= 0 AND output_tokens >= 0),
  CONSTRAINT whatsapp_mink_answers_credits_check
    CHECK (
      charged_credits >= 0 AND plan_credits >= 0 AND balance_credits >= 0
      AND charged_credits = plan_credits + balance_credits
    ),
  CONSTRAINT whatsapp_mink_answers_source_check
    CHECK (credit_source IS NULL
           OR credit_source IN ('plan', 'credit', 'mixed', 'plan_unlimited')),
  -- A charge names the cycle it was taken from.
  CONSTRAINT whatsapp_mink_answers_period_check
    CHECK (credit_source IS NULL OR period IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS whatsapp_mink_answers_conversation_idx
  ON public.whatsapp_mink_answers (store_id, conversation_id, created_at DESC);
-- The draft a thread shows: at most one pending per conversation is the
-- application's rule, found by this index.
CREATE INDEX IF NOT EXISTS whatsapp_mink_answers_draft_idx
  ON public.whatsapp_mink_answers (conversation_id, created_at DESC)
  WHERE outcome = 'draft';

ALTER TABLE public.whatsapp_mink_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_mink_answers FROM PUBLIC;
REVOKE ALL ON public.whatsapp_mink_answers FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_mink_answers TO app_service;

CREATE OR REPLACE FUNCTION public.consume_mink_whatsapp_answer(
  p_answer uuid,
  p_store uuid,
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
    RAISE EXCEPTION 'invalid Mink WhatsApp credit request';
  END IF;

  -- The row is the idempotency key: locked, and an already-charged id
  -- answers with what it was charged.
  SELECT credit_source INTO existing_source
  FROM public.whatsapp_mink_answers
  WHERE id = p_answer AND store_id = p_store
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown Mink WhatsApp answer';
  END IF;
  IF existing_source IS NOT NULL THEN
    RETURN existing_source;
  END IF;

  IF p_plan_cap IS NULL THEN
    UPDATE public.whatsapp_mink_answers
    SET period = p_period, charged_credits = 0, plan_credits = 0,
        balance_credits = 0, credit_source = 'plan_unlimited'
    WHERE id = p_answer AND store_id = p_store;
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
      'mink-whatsapp:' || p_answer::text,
      'Mink AI WhatsApp answer'
    );
  END IF;

  result_source := CASE
    WHEN plan_part > 0 AND balance_part > 0 THEN 'mixed'
    WHEN balance_part > 0 THEN 'credit'
    ELSE 'plan'
  END;
  UPDATE public.whatsapp_mink_answers
  SET period = p_period,
      charged_credits = p_credits,
      plan_credits = plan_part,
      balance_credits = balance_part,
      credit_source = result_source
  WHERE id = p_answer AND store_id = p_store;
  RETURN result_source;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_mink_whatsapp_answer(
  uuid, uuid, text, integer, integer
) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.consume_mink_whatsapp_answer(
  uuid, uuid, text, integer, integer
) TO app_service;
