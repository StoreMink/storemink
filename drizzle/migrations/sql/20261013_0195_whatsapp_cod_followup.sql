-- WhatsApp cash-on-delivery follow-up (docs/whatsapp-commerce-plan.md §16
-- Phase 2): a reminder 24 hours after the Confirm/Cancel message, and an
-- optional automatic cancellation 48 hours after it.
--
--   orders.cod_reminded_at
--       when the one reminder was claimed. The hourly sweep claims it in the
--       same transaction that queues the resend, so an order is reminded at
--       most once however often the sweep runs.
--
--   orders.cod_confirmation gains 'expired'
--       the merchant's automatic cancellation fired because nobody answered.
--       Kept apart from 'cancelled' (the CUSTOMER tapped Cancel): the order
--       list says "Not confirmed on WhatsApp", not "Cancelled on WhatsApp".
--
--   orders_cod_awaiting_idx
--       the sweep reads only orders still pending and awaiting an answer, by
--       when the message went; partial, so it stays tiny.
--
-- Backward compatible: a nullable column, a CHECK widened by one value the
-- revision being replaced never writes, and an index.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cod_reminded_at timestamptz;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_cod_confirmation_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_cod_confirmation_check CHECK (
    cod_confirmation IS NULL
    OR cod_confirmation IN ('requested', 'confirmed', 'cancelled', 'expired')
  );

CREATE INDEX IF NOT EXISTS orders_cod_awaiting_idx
  ON public.orders (cod_confirmation_at)
  WHERE cod_confirmation = 'requested' AND status = 'pending';

COMMENT ON COLUMN public.orders.cod_confirmation IS
  'WhatsApp cash-on-delivery confirmation: requested once the message with Confirm/Cancel buttons was sent, then confirmed or cancelled by the customer''s tap, or expired when the store''s automatic cancellation fired because nobody answered. NULL = the customer was never asked.';
