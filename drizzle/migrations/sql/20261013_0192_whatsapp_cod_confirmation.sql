-- WhatsApp cash-on-delivery confirmation (docs/whatsapp-commerce-plan.md §16
-- Phase 2; stories WA-4.x in docs/whatsapp-acceptance.md).
--
-- A website cash-on-delivery order, on a store that switched
-- `whatsapp.codConfirmation` on, gets a WhatsApp message with Confirm order /
-- Cancel order buttons instead of the plain order message. Two places need
-- somewhere to put that:
--
--   orders.cod_confirmation / cod_confirmation_at
--       where the customer's answer stands. NULL = never asked, and the order
--       list shows nothing for it (never asked must not read as a customer who
--       ignored us). 'requested' is written by the worker only once the message
--       with the buttons has really gone, and only over NULL, so a resend never
--       resets an answer; then 'confirmed' or 'cancelled' from the tap.
--
--   notification_whatsapp_queue.button_payloads
--       the payloads the queued message's quick-reply buttons carry, in button
--       order. Written at enqueue, because the order is known there and nowhere
--       downstream; NULL for a template without buttons.
--
-- Additive only: two nullable columns on orders, one on the queue, and CHECKs
-- every existing row satisfies (all three columns start NULL). The revision
-- being replaced neither reads nor writes them.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cod_confirmation text;
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cod_confirmation_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'orders_cod_confirmation_check'
       AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_cod_confirmation_check CHECK (
        cod_confirmation IS NULL
        OR cod_confirmation IN ('requested', 'confirmed', 'cancelled')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.orders.cod_confirmation IS
  'WhatsApp cash-on-delivery confirmation: requested once the message with Confirm/Cancel buttons was sent, then confirmed or cancelled by the customer''s tap. NULL = the customer was never asked.';

ALTER TABLE public.notification_whatsapp_queue
  ADD COLUMN IF NOT EXISTS button_payloads jsonb;

-- ★ A CASE, NOT AN AND: Postgres does not promise to short-circuit, and
-- jsonb_array_length raises on a non-array rather than returning NULL. Ten is
-- Meta's ceiling for quick-reply buttons on one template.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notification_whatsapp_queue_button_payloads_check'
       AND conrelid = 'public.notification_whatsapp_queue'::regclass
  ) THEN
    ALTER TABLE public.notification_whatsapp_queue
      ADD CONSTRAINT notification_whatsapp_queue_button_payloads_check CHECK (
        button_payloads IS NULL
        OR CASE
             WHEN jsonb_typeof(button_payloads) = 'array'
               THEN jsonb_array_length(button_payloads) BETWEEN 1 AND 10
             ELSE false
           END
      );
  END IF;
END $$;
