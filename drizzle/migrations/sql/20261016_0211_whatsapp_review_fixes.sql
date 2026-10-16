-- WhatsApp Commerce: the schema the PR #283 review fixes need.
--
-- One migration for several independent fixes, because each is a column or a
-- constraint that its code half cannot run without, and they ship together:
--
--   notification_whatsapp_queue.provider_message_id
--       Meta's id for the message this row sent. The worker writes it after a
--       successful send, so a delivery STATUS (inbound.ts) can find the row it
--       is about: to release or drop its held SMS, and to mark a COD
--       confirmation that never arrived. whatsapp_logs already carries the id
--       but has no way back to the queue row.
--
--   notification_whatsapp_queue.fallback_sms / fallback_state / fallback_settled_at
--       ★ THE SMS IS HELD, NOT DROPPED. Under `whatsapp_first` the fan-out
--       used to skip the SMS for everyone it queued on WhatsApp, and nothing
--       re-queued it when the send failed or Meta later said `failed` (a
--       number not on WhatsApp, 131026), so that customer got nothing. Now the
--       SMS row the fan-out would have queued rides on the WhatsApp row as
--       `held`: a send error or a `failed` status RELEASES it into
--       notification_sms_queue (once, by a conditional claim on the state),
--       and `delivered`/`read` DROPS it. Kept on the row after settling, so
--       "did this customer get a text instead?" stays answerable.
--
--   whatsapp_inbound_events.attempts / next_attempt_at
--       A processing error used to mark the event processed WITH the error,
--       so a connection reset dropped the customer's message, COD tap or STOP
--       for good. Rows are now claimed with a lease (next_attempt_at), retried
--       with backoff, and given up on only after a few attempts. The send-
--       emails heartbeat drains whatever the webhook's after() missed.
--
--   whatsapp_mink_answers.sending_started_at
--       The claim on a Mink draft becomes a lease: set inside the claim, so a
--       second Send (another person, another tab, the automatic send still in
--       flight) finds the draft taken instead of sending it twice; cleared
--       again when the send fails, so the draft can be sent later.
--
--   orders.cod_confirmation gains 'undelivered'
--       Meta accepted the Confirm/Cancel message and later reported it failed:
--       the customer never saw the buttons, so the COD sweep must neither
--       remind nor auto-cancel the order as "not confirmed".
--
--   orders.whatsapp_updates
--       What the shopper ticked for THIS order (true/false), or NULL when the
--       boxes were not shown (a till sale, a store with no number, an order
--       placed before this column). The fan-out sends an order's WhatsApp
--       updates to the phone typed at checkout; a shopper who unticked the box
--       (a gift, a surprise) is not overridden by a consent the recipient gave
--       on their own orders, and cannot withdraw that consent either.
--
--   whatsapp_number_pins
--       The two-step verification PIN we registered a number with, kept apart
--       from store_whatsapp_accounts so Disconnect (which deletes that row)
--       does not lose it. Every connect generated a new PIN, and Meta refuses
--       to re-register a number with a PIN other than the one it holds, so
--       Disconnect then Connect, the only recovery the modal offers, failed.
--       Keyed by the number: Meta holds one PIN per number. Encrypted under
--       PAYMENT_CRED_KEY like the account's own copy, service-only like every
--       whatsapp_* table, and deleted with the store (a store purge leaves no
--       secret behind). Backfilled from the numbers we actually registered.
--
--   whatsapp_conversations.retention_failed_at
--       A closed conversation whose media folder could not be emptied kept its
--       place at the front of the oldest-first batch every night, so 50 such
--       chats stopped all pruning. The sweep now marks the failure and skips
--       the row for a while; the mark is cleared when the deletion succeeds.
--
-- Backward compatible: new nullable columns, one with a default, a widened
-- CHECK, one new table. The revision being replaced reads none of them and
-- writes none of the new values.

-- ── notification_whatsapp_queue ─────────────────────────────────────────────

ALTER TABLE public.notification_whatsapp_queue
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS fallback_sms jsonb,
  ADD COLUMN IF NOT EXISTS fallback_state text,
  ADD COLUMN IF NOT EXISTS fallback_settled_at timestamptz;

-- A status finds its row by Meta's id. Not UNIQUE: a uniqueness failure here
-- would fail the worker's settle after Meta had already accepted the message.
CREATE INDEX IF NOT EXISTS notification_whatsapp_queue_provider_idx
  ON public.notification_whatsapp_queue (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ★ Every arm is NULL-safe (IS NULL / IS NOT NULL / coalesce), because a CHECK
-- is SATISFIED by NULL: `fallback_state = 'held'` on a NULL state would make an
-- arm NULL and let a held SMS with no state, or a state with no SMS, through.
ALTER TABLE public.notification_whatsapp_queue
  DROP CONSTRAINT IF EXISTS notification_whatsapp_queue_fallback_check;
ALTER TABLE public.notification_whatsapp_queue
  ADD CONSTRAINT notification_whatsapp_queue_fallback_check CHECK (
    (fallback_state IS NULL AND fallback_sms IS NULL AND fallback_settled_at IS NULL)
    OR (coalesce(fallback_state, '') = 'held'
        AND coalesce(jsonb_typeof(fallback_sms), '') = 'object'
        AND fallback_settled_at IS NULL)
    OR (coalesce(fallback_state, '') IN ('released', 'dropped')
        AND coalesce(jsonb_typeof(fallback_sms), '') = 'object'
        AND fallback_settled_at IS NOT NULL)
  );

COMMENT ON COLUMN public.notification_whatsapp_queue.fallback_sms IS
  'The SMS row the fan-out held behind this WhatsApp message (recipient_id, recipient_type, phone, event_key, values). Released into notification_sms_queue when WhatsApp fails, dropped when it is delivered.';

-- ── whatsapp_inbound_events ─────────────────────────────────────────────────

ALTER TABLE public.whatsapp_inbound_events
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

ALTER TABLE public.whatsapp_inbound_events
  DROP CONSTRAINT IF EXISTS whatsapp_inbound_events_attempts_check;
ALTER TABLE public.whatsapp_inbound_events
  ADD CONSTRAINT whatsapp_inbound_events_attempts_check CHECK (attempts >= 0);

COMMENT ON COLUMN public.whatsapp_inbound_events.next_attempt_at IS
  'NULL = due now. Set to a lease when a run claims the row, and to a backoff after a failed attempt; processed_at ends it.';

-- ── whatsapp_mink_answers ───────────────────────────────────────────────────

ALTER TABLE public.whatsapp_mink_answers
  ADD COLUMN IF NOT EXISTS sending_started_at timestamptz;

-- ── orders ──────────────────────────────────────────────────────────────────

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_cod_confirmation_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_cod_confirmation_check CHECK (
    cod_confirmation IS NULL
    OR cod_confirmation IN ('requested', 'confirmed', 'cancelled', 'expired', 'undelivered')
  );

COMMENT ON COLUMN public.orders.cod_confirmation IS
  'WhatsApp cash-on-delivery confirmation: requested (the buttons were sent), confirmed / cancelled (the customer tapped), expired (cancelled automatically, not confirmed in time), undelivered (Meta reported the message failed, so the customer never saw it). NULL = never asked.';

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS whatsapp_updates boolean;

COMMENT ON COLUMN public.orders.whatsapp_updates IS
  'The checkout''s "order updates on WhatsApp" box for this order. NULL = not asked. False stops this order''s WhatsApp updates whatever the phone''s stored consent says.';

-- ── whatsapp_number_pins ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_number_pins (
  phone_number_id text PRIMARY KEY,
  -- The store that last registered the number. A store purge removes it.
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  -- AES-256-GCM under PAYMENT_CRED_KEY, the same encoding as
  -- store_whatsapp_accounts.two_fa_pin_enc.
  pin_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_number_pins_phone_check
    CHECK (length(btrim(phone_number_id)) > 0),
  CONSTRAINT whatsapp_number_pins_pin_check
    CHECK (length(pin_enc) > 0)
);

CREATE INDEX IF NOT EXISTS whatsapp_number_pins_store_idx
  ON public.whatsapp_number_pins (store_id);

ALTER TABLE public.whatsapp_number_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_number_pins FROM PUBLIC;
REVOKE ALL ON public.whatsapp_number_pins FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_number_pins TO app_service;

-- Only numbers we registered ourselves: under Coexistence the WhatsApp
-- Business app registered the number and the stored PIN was never used.
INSERT INTO public.whatsapp_number_pins (phone_number_id, store_id, pin_enc)
SELECT a.phone_number_id, a.store_id, a.two_fa_pin_enc
FROM public.store_whatsapp_accounts a
WHERE a.coexistence = false
  AND a.registered_at IS NOT NULL
  AND length(a.two_fa_pin_enc) > 0
ON CONFLICT (phone_number_id) DO NOTHING;

-- ── whatsapp_conversations ──────────────────────────────────────────────────

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS retention_failed_at timestamptz;

COMMENT ON COLUMN public.whatsapp_conversations.retention_failed_at IS
  'When the retention sweep last failed to delete this closed conversation''s media. The sweep skips it for a while, so one stuck chat cannot hold the oldest-first batch.';
