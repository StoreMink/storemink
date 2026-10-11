-- WhatsApp Commerce, Phase 1 slice 3: the inbox
-- (docs/whatsapp-commerce-plan.md §10, §11, §15).
--
-- Two tables, both service-only (RLS on, no policies, app_user revoked — the
-- rule 0174 states for every whatsapp_* table, and these hold what customers
-- wrote):
--
--   whatsapp_conversations   one thread per contact per store: who is waiting
--                            on whom, and the facts the list renders without
--                            a join (last message, unread count)
--   whatsapp_messages        every message in both directions — what a
--                            customer sent, what staff replied from the
--                            dashboard, what the merchant typed on the phone
--                            (echoed under Coexistence), and the templates the
--                            notification spine sent, so the thread shows the
--                            order update the customer is replying to
--
-- ★ ONE CONVERSATION PER CONTACT. WhatsApp has no threads: a customer and a
-- business share one chat for ever, and "closing" one is a status the next
-- message reopens. UNIQUE (store_id, contact_id) is that fact as a constraint,
-- and it is what lets an inbound message find its conversation by upsert
-- rather than by search.
--
-- ★ THE PROVIDER MESSAGE ID IS THE IDEMPOTENCY KEY. Meta redelivers for up to
-- a week, and the inbound-event row already dedupes the DELIVERY; this UNIQUE
-- dedupes the MESSAGE, so a redelivered event that slipped past (a reprocess
-- after a failed run) still cannot bump the unread count twice or ring the
-- bell twice. Partial, because a failed send has no id.
--
-- ★ `last_inbound_at` ON THE CONTACT IS THE 24-HOUR WINDOW CLOCK (plan §10),
-- written by every inbound message and never by a send. The conversation
-- carries its own copy only for the list's sort and the window badge; the
-- contact's is what the reply action checks.

CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.whatsapp_contacts(id) ON DELETE CASCADE,
  -- needs_reply: the customer wrote last; open: staff wrote last, or someone
  -- chose to keep it open; closed: done until the customer writes again.
  status text NOT NULL DEFAULT 'needs_reply',
  -- Phase 2 (assignment). Nullable now so the column needs no later migration.
  assigned_admin_id text,
  unread_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  -- The first line of the latest message, for the list.
  last_preview text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_conversations_status_check
    CHECK (status IN ('needs_reply','open','closed')),
  CONSTRAINT whatsapp_conversations_unread_check
    CHECK (unread_count >= 0),
  CONSTRAINT whatsapp_conversations_store_contact_key UNIQUE (store_id, contact_id)
);

-- The list: a store's conversations by status, newest activity first; and the
-- sidebar badge, which is a COUNT over (store_id, status).
CREATE INDEX IF NOT EXISTS whatsapp_conversations_store_status_idx
  ON public.whatsapp_conversations (store_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_store_recent_idx
  ON public.whatsapp_conversations (store_id, last_message_at DESC);

ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_conversations FROM PUBLIC;
REVOKE ALL ON public.whatsapp_conversations FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_conversations TO app_service;

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  direction text NOT NULL,
  -- Who produced it: the customer; a staff member in the dashboard; the
  -- merchant's own phone (a Coexistence echo); the notification template
  -- spine; a later automation.
  source text NOT NULL,
  kind text NOT NULL,
  -- Text, a caption, or a plain-language stand-in for a non-text message
  -- ("📍 Shop 4, MG Road"). Capped by the application at WhatsApp's own 4,096.
  body text,
  -- A copy of inbound media in OUR bucket, under stores/{id}/whatsapp/. Meta's
  -- download URLs expire and need the token, so they are never stored.
  media_path text,
  media_mime text,
  media_name text,
  -- The structured part of a non-text message (coordinates, shared contacts,
  -- the catalogue items in an order, which button was pressed). Bounded.
  payload jsonb,
  -- The message this one replied to, by Meta's id.
  quoted_provider_id text,
  provider_message_id text,
  -- received (inbound) | sent | delivered | read | failed (outbound, advanced
  -- by the status webhook exactly as whatsapp_logs is).
  status text NOT NULL,
  error text,
  sent_by_admin_id text,
  template_id uuid REFERENCES public.whatsapp_templates(id) ON DELETE SET NULL,
  -- Meta's timestamp for an inbound message or an echo; our clock for a send.
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_messages_direction_check
    CHECK (direction IN ('in','out')),
  CONSTRAINT whatsapp_messages_source_check
    CHECK (source IN ('customer','dashboard','phone_app','template','automation')),
  CONSTRAINT whatsapp_messages_kind_check
    CHECK (kind IN ('text','image','video','audio','document','sticker','location','contacts','order','interactive','button','reaction','template','unsupported')),
  CONSTRAINT whatsapp_messages_status_check
    CHECK (status IN ('received','sent','delivered','read','failed'))
);

CREATE INDEX IF NOT EXISTS whatsapp_messages_conversation_idx
  ON public.whatsapp_messages (conversation_id, sent_at);
CREATE INDEX IF NOT EXISTS whatsapp_messages_store_created_idx
  ON public.whatsapp_messages (store_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_provider_message_key
  ON public.whatsapp_messages (store_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_messages FROM PUBLIC;
REVOKE ALL ON public.whatsapp_messages FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_messages TO app_service;
