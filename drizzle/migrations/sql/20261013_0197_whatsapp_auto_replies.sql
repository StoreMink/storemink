-- WhatsApp automatic replies (docs/whatsapp-commerce-plan.md §4 Automation,
-- §16 Phase 2): a welcome message, an away message outside business hours,
-- and answering "where is my order?".
--
--   whatsapp_auto_replies
--       one row per store: the two messages as the merchant wrote them, the
--       weekly business hours the away message follows, and whether order
--       questions are answered. Service-only like every whatsapp_* table (RLS
--       on, no policies, app_user revoked). No row means every reply is off,
--       so a store that never opens the settings page sends nothing new.
--       Kept apart from store_whatsapp_accounts so disconnecting and
--       reconnecting a number does not lose what the merchant wrote.
--
--   whatsapp_conversations.welcome_sent_at / away_sent_at
--       when the conversation last got each automatic message. The sender
--       claims them with a conditional UPDATE, so two messages arriving
--       together never get two welcomes, and the away message goes once per
--       closed spell rather than once per message.
--
-- Backward compatible: a new table and two nullable columns the revision being
-- replaced never reads.

CREATE TABLE IF NOT EXISTS public.whatsapp_auto_replies (
  store_id uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  welcome_enabled boolean NOT NULL DEFAULT false,
  welcome_text text NOT NULL DEFAULT '',
  away_enabled boolean NOT NULL DEFAULT false,
  away_text text NOT NULL DEFAULT '',
  -- { "mon": { "open": "10:00", "close": "19:00" } | null, ... }, in the
  -- store's business time zone. Shape checked by the application.
  business_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  order_status_enabled boolean NOT NULL DEFAULT false,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_auto_replies_welcome_length_check
    CHECK (char_length(welcome_text) <= 1000),
  CONSTRAINT whatsapp_auto_replies_away_length_check
    CHECK (char_length(away_text) <= 1000),
  -- A reply that is on has something to say. Every column here is NOT NULL,
  -- so neither check can pass on a NULL.
  CONSTRAINT whatsapp_auto_replies_welcome_text_check
    CHECK (NOT welcome_enabled OR char_length(btrim(welcome_text)) > 0),
  CONSTRAINT whatsapp_auto_replies_away_text_check
    CHECK (NOT away_enabled OR char_length(btrim(away_text)) > 0),
  CONSTRAINT whatsapp_auto_replies_hours_check
    CHECK (jsonb_typeof(business_hours) = 'object')
);

ALTER TABLE public.whatsapp_auto_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_auto_replies FROM PUBLIC;
REVOKE ALL ON public.whatsapp_auto_replies FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_auto_replies TO app_service;

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS welcome_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS away_sent_at timestamptz;

COMMENT ON COLUMN public.whatsapp_conversations.welcome_sent_at IS
  'When this conversation last got the automatic welcome message. Claimed by a conditional UPDATE; at most once per 14 days.';
COMMENT ON COLUMN public.whatsapp_conversations.away_sent_at IS
  'When this conversation last got the automatic away message. Claimed by a conditional UPDATE; at most once until the store has opened again.';
