-- Mink AI chat history (owner's decision, 25 Oct 2026, informed by the
-- roughly 3-month window Shopify gives Sidekick's memory): a chat is kept 90
-- days after it was last used and then deleted; every chat from that period
-- is listed and searchable; there is no ten-chat cap. Records of what Mink AI
-- proposed and what the merchant approved or published stay for as long as
-- the store exists.
--
-- ★ expires_at becomes the SLIDING deletion time, last use + 90 days
--   (lib/mink/persistence.ts startMinkRun and lib/mink/conversation-history.ts
--   getMinkConversation move it). The revision being replaced never moves it,
--   so the retention sweep also requires last_message_at, which every
--   revision writes, to be 90 days old, and moves expires_at forward for a
--   chat that revision used (lib/mink/conversation-retention.ts).
-- ★ retention_failed_at: the sweep's marker, the shape lib/whatsapp/retention.ts
--   uses: a chat it could not retire is left out for 7 days.
-- ★ LOCKS: ONE TABLE. ADD COLUMN takes ACCESS EXCLUSIVE on mink_conversations
--   and CREATE INDEX a SHARE lock on it, both held to COMMIT under the 5 s
--   lock_timeout; GRANT takes no table lock. The message search index is
--   0249, its own transaction: a Mink reply writes mink_conversations and
--   mink_messages in one order when it starts and in the other when it
--   finishes, so one transaction locking both tables could deadlock with it.
--
-- Expand-only: a nullable column, an index, three grants, and a backfill that
-- only moves expiries later. Nothing the running revision reads changes shape.

ALTER TABLE public.mink_conversations
  ADD COLUMN IF NOT EXISTS retention_failed_at timestamptz;

UPDATE public.mink_conversations
   SET expires_at = last_message_at + interval '90 days'
 WHERE status = 'active'
   AND expires_at < last_message_at + interval '90 days';

CREATE INDEX IF NOT EXISTS mink_conversations_retention_idx
  ON public.mink_conversations (expires_at, id)
  WHERE status = 'active';

-- Reducing a chat that holds approved or published records deletes its
-- messages, its feedback and its unconfirmed previews (pending approvals)
-- directly (a full delete cascades as the table owner and needs none of
-- these). 0035, 0039 and 0042 granted SELECT, INSERT, UPDATE only; every
-- database held DELETE through drizzle/manual/0000_compat_setup.sql's
-- default privileges, the gap 0240 closed for mink_runs.
GRANT DELETE ON TABLE public.mink_messages TO app_service;
GRANT DELETE ON TABLE public.mink_feedback TO app_service;
GRANT DELETE ON TABLE public.mink_action_approvals TO app_service;
