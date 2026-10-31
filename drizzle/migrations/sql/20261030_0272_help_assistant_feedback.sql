-- Help Centre: thumbs up and down on Mink AI answers, so StoreMink's operators
-- can see which questions the public Help assistant answers badly.
--
-- ★ PLATFORM-GLOBAL, NO store_id. The Help Centre is StoreMink's own docs
-- (help_articles has no store either), and its visitors are anonymous: a
-- rating belongs to nobody but the conversation that produced it.
--
-- ★ ONE ROW PER ANSWER, NOT PER CLICK. conversation_id and message_key are
-- random ids the visitor's browser makes for its chat and for each answer in
-- it; (conversation_id, message_key) is unique, so changing a thumbs up to a
-- thumbs down updates the row instead of counting the answer twice
-- (app/actions/help-assistant-feedback-actions.ts upserts on it). Both are
-- shaped by CHECK so nothing but an id can be stored there.
--
-- ★ WHAT IS KEPT IS WHAT THE VISITOR RATED: the question they asked, the
-- answer Mink AI gave (plain text, bounded) and the guides it cited. That is
-- what an operator needs to fix a guide; nothing identifies the visitor (no
-- IP, no account, no user agent). The Help guide says a rating sends the
-- question and the answer to StoreMink. Retention: one year
-- (lib/retention/prune.ts).
--
-- ★ NULL-SAFE. Every column a CHECK reads is NOT NULL except language, whose
-- CHECK names IS NULL itself; sources is NOT NULL and must be an array.
--
-- ★ EXPAND ONLY. A new service-only table (RLS on, no policies, app_user has
-- no grants) that the revision being replaced never names.

CREATE TABLE IF NOT EXISTS public.help_assistant_feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  message_key text NOT NULL,
  rating text NOT NULL,
  language text,
  question text NOT NULL,
  answer text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT help_assistant_feedback_pkey PRIMARY KEY (id),
  CONSTRAINT help_assistant_feedback_answer_key
    UNIQUE (conversation_id, message_key),
  CONSTRAINT help_assistant_feedback_rating_check
    CHECK (rating IN ('up', 'down')),
  CONSTRAINT help_assistant_feedback_ids_check
    CHECK (
      conversation_id ~ '^[A-Za-z0-9_-]{8,64}$'
      AND message_key ~ '^[A-Za-z0-9_-]{8,64}$'
    ),
  CONSTRAINT help_assistant_feedback_language_check
    CHECK (language IS NULL OR language ~ '^[a-z]{2}$'),
  CONSTRAINT help_assistant_feedback_question_check
    CHECK (char_length(question) BETWEEN 1 AND 1200),
  CONSTRAINT help_assistant_feedback_answer_check
    CHECK (char_length(answer) BETWEEN 1 AND 4000),
  CONSTRAINT help_assistant_feedback_sources_check
    CHECK (jsonb_typeof(sources) = 'array')
);

CREATE INDEX IF NOT EXISTS help_assistant_feedback_created_idx
  ON public.help_assistant_feedback (created_at);

CREATE INDEX IF NOT EXISTS help_assistant_feedback_rating_idx
  ON public.help_assistant_feedback (rating, created_at DESC);

ALTER TABLE public.help_assistant_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.help_assistant_feedback FROM PUBLIC;
REVOKE ALL ON public.help_assistant_feedback FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.help_assistant_feedback TO app_service;
