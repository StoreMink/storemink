-- WhatsApp Commerce, Phase 1 slice 2: order updates on WhatsApp
-- (docs/whatsapp-commerce-plan.md §8, §10, §15).
--
-- Four things, all service-only (RLS on, no policies, app_user revoked — the
-- rule 0174 states for the account row applies to every table here, because
-- each one carries a customer's phone number):
--
--   whatsapp_contacts            who may be messaged, and the consent they gave
--   notification_whatsapp_queue  what the notification fan-out queued
--   whatsapp_logs                every send, with the delivery timeline Meta
--                                reports back
--   whatsapp_templates           gains the two columns the bootstrap needs
--
-- ★ CONSENT IS A ROW WITH THE WORDS ON IT, not a boolean on `users`. The
-- checkout box's exact label is snapshotted beside the timestamp (the §25
-- legal-acceptance shape), and order updates and offers are two separate
-- consents because they are two separate questions at checkout (plan §19.2):
-- the first ticked by default, the second never.
--
-- ★ A LOG ROW OUTLIVES ITS QUEUE ROW and carries the delivery timeline. SMS
-- can only ever say "sent" (§37); Meta reports sent → delivered → read, or
-- failed with a code, through the status webhook, and the status handler
-- finds the row by provider_message_id — hence the UNIQUE partial index.

CREATE TABLE IF NOT EXISTS public.whatsapp_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  -- E.164, the shape users.phone holds since 0095; one row per number per store.
  phone text NOT NULL,
  -- Meta's id for the person, learned from the first inbound message.
  wa_id text,
  profile_name text,
  -- The shopper's account when known. ON UPDATE CASCADE so adopting a
  -- till-created customer (pos_13) carries the contact with it; SET NULL on
  -- delete so a removed account leaves the consent record standing.
  user_id text REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  updates_opt_in_at timestamptz,
  updates_consent_text text,
  updates_opt_out_at timestamptz,
  marketing_opt_in_at timestamptz,
  marketing_consent_text text,
  marketing_opt_out_at timestamptz,
  -- When they last wrote to the business — the 24-hour service window.
  last_inbound_at timestamptz,
  referral jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_contacts_store_phone_key UNIQUE (store_id, phone)
);

CREATE INDEX IF NOT EXISTS whatsapp_contacts_user_idx
  ON public.whatsapp_contacts (user_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.whatsapp_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_contacts FROM PUBLIC;
REVOKE ALL ON public.whatsapp_contacts FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_contacts TO app_service;

-- The queue: notification_sms_queue's shape (§37) plus the template the
-- fan-out chose. A provider round trip must never sit on a checkout's code
-- path, so the fan-out enqueues and a worker on the send-emails heartbeat
-- drains. No digest column, for the SMS queue's reason: a WhatsApp update
-- either goes now or does not go.
CREATE TABLE IF NOT EXISTS public.notification_whatsapp_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  event_id uuid REFERENCES public.activity_events(id) ON DELETE CASCADE,
  recipient_id text NOT NULL,
  recipient_type text NOT NULL,
  phone text NOT NULL,
  event_key text NOT NULL,
  audience text NOT NULL,
  template_id uuid NOT NULL REFERENCES public.whatsapp_templates(id) ON DELETE CASCADE,
  -- Snapshotted at enqueue, like the SMS queue's values: a receipt keeps the
  -- figures it was written with even if the order is edited before it sends.
  values jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT notification_whatsapp_queue_status_check
    CHECK (status IN ('pending','sending','sent','failed')),
  CONSTRAINT notification_whatsapp_queue_audience_check
    CHECK (audience IN ('team','customer'))
);

CREATE INDEX IF NOT EXISTS notification_whatsapp_queue_claim_idx
  ON public.notification_whatsapp_queue (status, next_attempt_at)
  WHERE status IN ('pending','sending');
CREATE INDEX IF NOT EXISTS notification_whatsapp_queue_created_idx
  ON public.notification_whatsapp_queue (created_at);

ALTER TABLE public.notification_whatsapp_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_whatsapp_queue FROM PUBLIC;
REVOKE ALL ON public.notification_whatsapp_queue FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_whatsapp_queue TO app_service;

-- Every send. `status` starts at what the choke point knows (sent / failed /
-- skipped) and advances to delivered / read / failed as Meta reports; each
-- step has its own timestamp so "delivered 14:02, read 14:05" is a fact, not
-- an inference. `body` is the rendered text — fixed template copy plus order
-- details, the same facts the order row shows any member of staff.
CREATE TABLE IF NOT EXISTS public.whatsapp_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  to_phone text NOT NULL,
  event_key text,
  template_name text,
  template_id uuid,
  category text,
  body text,
  status text NOT NULL,
  error text,
  -- Meta's numeric error code (131026 not a WhatsApp user, 130429 rate limit…).
  error_code integer,
  provider_message_id text,
  -- From the status webhook: which conversation this billed to, and its kind.
  conversation_id text,
  pricing_category text,
  billable boolean,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_logs_status_check
    CHECK (status IN ('sent','delivered','read','failed','skipped'))
);

CREATE INDEX IF NOT EXISTS whatsapp_logs_store_created_idx
  ON public.whatsapp_logs (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_logs_status_idx
  ON public.whatsapp_logs (store_id, status, created_at DESC);
-- The status handler's lookup; partial, since a skipped or refused send has
-- no message id. UNIQUE so one provider message can only ever be one row.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_logs_provider_message_key
  ON public.whatsapp_logs (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
-- Retention (§32) filters on created_at ALONE, which the composites cannot serve.
CREATE INDEX IF NOT EXISTS whatsapp_logs_created_idx
  ON public.whatsapp_logs (created_at);

ALTER TABLE public.whatsapp_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_logs FROM PUBLIC;
REVOKE ALL ON public.whatsapp_logs FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_logs TO app_service;

-- The template bootstrap needs to say when Meta last answered about a row and
-- why a submission was refused — which is not the same fact as Meta REJECTING
-- a template it accepted for review (rejection_reason, status REJECTED).
ALTER TABLE public.whatsapp_templates
  ADD COLUMN IF NOT EXISTS sync_error text,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

-- The raw-event table joins the retention sweep, which filters on received_at
-- alone; 0174's partial index covers only unprocessed rows.
CREATE INDEX IF NOT EXISTS whatsapp_inbound_events_received_idx
  ON public.whatsapp_inbound_events (received_at);
