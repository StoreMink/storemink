-- WhatsApp Commerce, Phase 2 slice 6: the full inbox
-- (docs/whatsapp-commerce-plan.md §4 "Inbox: Full", §11, §16 Phase 2).
--
-- What a team needs once more than one person works the inbox: who is on a
-- conversation, what it is about, what was agreed internally, the sentence
-- everybody types ten times a day, and a way to find the chat where a
-- customer mentioned a thing. Four service-only tables (RLS on, no policies,
-- app_user revoked, the rule 0174 states for every whatsapp_* table) and two
-- indexes on tables that already exist:
--
--   whatsapp_labels                 a store's own label vocabulary (name,
--                                   colour), at most 20 per store (the action
--                                   enforces the count; the name's length and
--                                   the colour are checked here)
--   whatsapp_conversation_labels    which labels a conversation carries
--   whatsapp_conversation_notes     a private note a person left on a
--                                   conversation; never sent, never a message
--                                   row (whatsapp_messages' source CHECK is
--                                   what keeps a note out of the thread's
--                                   wire record)
--   whatsapp_canned_replies         saved replies with a shortcut ("/hours"),
--                                   at most 50 per store
--
--   whatsapp_conversations.assigned_admin_id
--                                   0177 created it "nullable now so the
--                                   column needs no later migration"; this is
--                                   the later migration, and it adds only the
--                                   index the "Mine" filter needs
--   whatsapp_messages body search   a GIN index over to_tsvector('simple',
--                                   body): the list's search box also finds a
--                                   conversation by a word inside it.
--                                   'simple' deliberately: customers write in
--                                   English, Hinglish and Devanagari in one
--                                   thread, and a language stemmer would stem
--                                   the wrong language. Prefix matching
--                                   ("stoc" finds "stock") is the query's
--                                   job, not the index's.
--
-- ★ A NOTE'S AUTHOR AND AN ASSIGNEE ARE TEXT, NOT FOREIGN KEYS. admins.id is
-- the Firebase uid, and a person who leaves the store takes their admins row
-- with them; a note they wrote is still the store's record of what was
-- agreed, and a conversation they were on is still assigned until somebody
-- changes it (the list shows it as assigned to nobody named). The read side
-- resolves names best-effort, as the thread already does for sent_by_admin_id.
--
-- Backward compatible: four new tables, two new indexes, nothing the
-- revision being replaced reads changes shape.

CREATE TABLE IF NOT EXISTS public.whatsapp_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- One of the dashboard's chip colours; the application maps it to paint.
  color text NOT NULL DEFAULT 'grey',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_labels_name_check
    CHECK (length(btrim(name)) BETWEEN 1 AND 30 AND name = btrim(name)),
  CONSTRAINT whatsapp_labels_color_check
    CHECK (color IN ('grey','red','orange','yellow','green','blue','purple','pink'))
);

-- Two labels that differ only in case are one label twice.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_labels_store_name_key
  ON public.whatsapp_labels (store_id, lower(name));

ALTER TABLE public.whatsapp_labels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_labels FROM PUBLIC;
REVOKE ALL ON public.whatsapp_labels FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_labels TO app_service;

CREATE TABLE IF NOT EXISTS public.whatsapp_conversation_labels (
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES public.whatsapp_labels(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_conversation_labels_pkey PRIMARY KEY (conversation_id, label_id)
);

-- The list filtered by one label.
CREATE INDEX IF NOT EXISTS whatsapp_conversation_labels_store_label_idx
  ON public.whatsapp_conversation_labels (store_id, label_id);

ALTER TABLE public.whatsapp_conversation_labels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_conversation_labels FROM PUBLIC;
REVOKE ALL ON public.whatsapp_conversation_labels FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_conversation_labels TO app_service;

CREATE TABLE IF NOT EXISTS public.whatsapp_conversation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_conversation_notes_body_check
    CHECK (length(body) BETWEEN 1 AND 2000)
);

-- The thread reads a conversation's notes in time order beside its messages.
CREATE INDEX IF NOT EXISTS whatsapp_conversation_notes_conversation_idx
  ON public.whatsapp_conversation_notes (conversation_id, created_at);

ALTER TABLE public.whatsapp_conversation_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_conversation_notes FROM PUBLIC;
REVOKE ALL ON public.whatsapp_conversation_notes FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_conversation_notes TO app_service;

CREATE TABLE IF NOT EXISTS public.whatsapp_canned_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  -- Typed after "/" in the message box: lowercase letters, digits, - and _.
  shortcut text NOT NULL,
  title text NOT NULL,
  -- WhatsApp's own cap on a text message, so a saved reply always fits.
  body text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_canned_replies_shortcut_check
    CHECK (shortcut ~ '^[a-z0-9][a-z0-9_-]{0,29}$'),
  CONSTRAINT whatsapp_canned_replies_title_check
    CHECK (length(btrim(title)) BETWEEN 1 AND 60),
  CONSTRAINT whatsapp_canned_replies_body_check
    CHECK (length(body) BETWEEN 1 AND 4096)
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_canned_replies_store_shortcut_key
  ON public.whatsapp_canned_replies (store_id, shortcut);

ALTER TABLE public.whatsapp_canned_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_canned_replies FROM PUBLIC;
REVOKE ALL ON public.whatsapp_canned_replies FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_canned_replies TO app_service;

-- The "Mine" and per-person filters: a store's conversations by assignee.
CREATE INDEX IF NOT EXISTS whatsapp_conversations_store_assignee_idx
  ON public.whatsapp_conversations (store_id, assigned_admin_id)
  WHERE assigned_admin_id IS NOT NULL;

-- Search inside messages. An expression index over an IMMUTABLE call: the
-- two-argument to_tsvector with an explicit configuration is immutable, the
-- one-argument form (which reads default_text_search_config) is not.
CREATE INDEX IF NOT EXISTS whatsapp_messages_body_search_idx
  ON public.whatsapp_messages
  USING gin (to_tsvector('simple', coalesce(body, '')));

COMMENT ON TABLE public.whatsapp_labels IS
  'A store''s own labels for WhatsApp conversations (at most 20; the Inbox action enforces the count).';
COMMENT ON TABLE public.whatsapp_conversation_notes IS
  'Private notes staff leave on a WhatsApp conversation. Never sent; read by anyone who can view the inbox.';
COMMENT ON TABLE public.whatsapp_canned_replies IS
  'Saved replies a store''s staff send from the inbox by shortcut (at most 50; the action enforces the count).';
