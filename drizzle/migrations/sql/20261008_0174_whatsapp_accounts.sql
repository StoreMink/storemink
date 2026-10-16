-- WhatsApp Commerce, Phase 1 slice 1: a store's connected WhatsApp account,
-- the templates Meta holds for it, and the raw webhook deliveries that reach
-- the one app-level endpoint (docs/whatsapp-commerce-plan.md §9, §15).
--
-- ★ EVERY TABLE IS SERVICE-ONLY: RLS on, no policies, app_user revoked. The
-- account row carries the Meta business token (which can send messages as the
-- merchant and read every conversation) and the number's 2FA PIN; the
-- inbound events carry customer message text. None of it may be reachable by
-- the storefront's anonymous client or by a dashboard session through RLS —
-- the same rule store_sms_providers and mink_* already follow.
--
-- ★ ONE ACCOUNT PER STORE, keyed on store_id, like store_sms_providers. A
-- second number per store is a non-goal (plan §17), and making it a list now
-- would put a choice in front of every send path for a case nobody has.
--
-- ★ phone_number_id IS GLOBALLY UNIQUE, not merely per store. It is the
-- routing key for every webhook delivery (plan §9): Meta posts to one URL for
-- every merchant, and the handler maps metadata.phone_number_id to exactly
-- one store. Two stores claiming one number would make routing ambiguous, so
-- the database refuses it rather than leaving the handler to pick.

CREATE TABLE IF NOT EXISTS public.store_whatsapp_accounts (
  store_id uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  waba_id text NOT NULL,
  phone_number_id text NOT NULL,
  display_phone text NOT NULL,
  verified_name text,
  -- Meta's display-name review: APPROVED / PENDING_REVIEW / DECLINED / NONE.
  name_status text,
  -- AES-256-GCM under PAYMENT_CRED_KEY (lib/payments/crypto.ts). Encrypted,
  -- not hashed: the token is PRESENTED to Meta on every request.
  business_token_enc text NOT NULL,
  -- The six-digit two-step-verification PIN we registered the number with.
  -- Needed again on re-registration; encrypted for the same reason.
  two_fa_pin_enc text NOT NULL,
  coexistence boolean NOT NULL DEFAULT false,
  -- Meta's per-number facts, refreshed from the Graph API and from webhooks.
  messaging_tier text,
  quality_rating text,
  waba_name text,
  waba_review_status text,
  app_subscribed_at timestamptz,
  registered_at timestamptz,
  -- connected | needs_reauth | disconnected. `enabled` is the merchant's own
  -- pause switch, independent of status (the SMS card's pattern).
  status text NOT NULL DEFAULT 'connected',
  enabled boolean NOT NULL DEFAULT true,
  -- Per-number send pacing; a coexistence number is capped by Meta (~20/s).
  send_rate_per_sec integer NOT NULL DEFAULT 80,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_whatsapp_accounts_status_check
    CHECK (status IN ('connected','needs_reauth','disconnected')),
  CONSTRAINT store_whatsapp_accounts_rate_check
    CHECK (send_rate_per_sec BETWEEN 1 AND 1000),
  CONSTRAINT store_whatsapp_accounts_phone_number_id_key UNIQUE (phone_number_id)
);

CREATE INDEX IF NOT EXISTS store_whatsapp_accounts_waba_idx
  ON public.store_whatsapp_accounts (waba_id);

ALTER TABLE public.store_whatsapp_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_whatsapp_accounts FROM PUBLIC;
REVOKE ALL ON public.store_whatsapp_accounts FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_whatsapp_accounts TO app_service;

-- The templates a store holds at Meta: StoreMink's bootstrapped set (one per
-- notification event and audience) plus any the merchant adds later.
-- `status` is what Meta last told us, by API response or by the
-- message_template_status_update webhook, and is the switch the notification
-- fan-out reads (plan §8): a row that is not APPROVED is never queued.
CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  waba_id text NOT NULL,
  -- NULL for a merchant-authored template with no event behind it.
  event_key text,
  audience text,
  name text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  category text NOT NULL,
  -- Meta's component array exactly as submitted (header/body/footer/buttons).
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The ordered mapping from named event values onto {{1}}, {{2}}, … — the
  -- store_sms_templates.variables shape, because the body is positional.
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_template_id text,
  status text NOT NULL DEFAULT 'PENDING',
  rejection_reason text,
  quality text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_templates_category_check
    CHECK (category IN ('UTILITY','MARKETING','AUTHENTICATION')),
  CONSTRAINT whatsapp_templates_status_check
    CHECK (status IN ('PENDING','APPROVED','REJECTED','PAUSED','DISABLED','IN_APPEAL','PENDING_DELETION','DELETED','LIMIT_EXCEEDED')),
  CONSTRAINT whatsapp_templates_audience_check
    CHECK (audience IS NULL OR audience IN ('team','customer')),
  CONSTRAINT whatsapp_templates_name_language_key UNIQUE (store_id, name, language)
);

CREATE INDEX IF NOT EXISTS whatsapp_templates_event_idx
  ON public.whatsapp_templates (store_id, event_key, audience);
CREATE INDEX IF NOT EXISTS whatsapp_templates_provider_idx
  ON public.whatsapp_templates (provider_template_id);

ALTER TABLE public.whatsapp_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_templates FROM PUBLIC;
REVOKE ALL ON public.whatsapp_templates FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_templates TO app_service;

-- Raw webhook deliveries, one row per change, acknowledged first and worked
-- later (plan §9). The handler answers Meta in milliseconds and a worker
-- turns rows into messages, statuses, template updates and account updates.
--
-- ★ `event_id` IS THE IDEMPOTENCY KEY. Meta redelivers on any non-2xx and on
-- its own schedule for up to a week; a redelivery must become a no-op, not a
-- second inbound message or a second COD cancellation. For a message it is
-- the message id, for a status the message id plus the status, for anything
-- else a digest of the change — computed by lib/whatsapp/inbound.ts, which
-- is the only writer.
--
-- ★ `store_id` IS NULLABLE: a delivery for a phone number no store holds
-- (Meta's dashboard sample, a disconnected merchant, a number mid-signup) is
-- still recorded, because "why did nothing happen?" needs the evidence.
-- Pruned by §32's retention sweep; the payload carries customer text.
CREATE TABLE IF NOT EXISTS public.whatsapp_inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE,
  waba_id text,
  phone_number_id text,
  field text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text,
  CONSTRAINT whatsapp_inbound_events_event_id_key UNIQUE (phone_number_id, field, event_id)
);

CREATE INDEX IF NOT EXISTS whatsapp_inbound_events_pending_idx
  ON public.whatsapp_inbound_events (received_at)
  WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS whatsapp_inbound_events_store_idx
  ON public.whatsapp_inbound_events (store_id, received_at DESC);

ALTER TABLE public.whatsapp_inbound_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_inbound_events FROM PUBLIC;
REVOKE ALL ON public.whatsapp_inbound_events FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_inbound_events TO app_service;
