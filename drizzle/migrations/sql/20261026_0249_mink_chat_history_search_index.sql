-- Search for Mink AI chat history (0248's change): a text-search GIN index
-- over each message as the chat SHOWS it, which History search matches word
-- prefixes against (lib/mink/conversation-history.ts), plus a small index for
-- the redesign cards a stopped or failed reply kept.
--
-- ★★ WHAT IS INDEXED IS WHAT THE CHAT SHOWS. A merchant's message with a
--   photo, a document or a CSV carries a hidden suffix: a marker sentence and
--   JSON (the file's name and address, a document's reading) that the thread
--   turns into a file card. public.mink_message_search_text keeps a
--   merchant's message up to the first marker (matched by its words, as
--   lib/mink/conversation-title.ts does, since a message of files alone has
--   lost the marker's opening blank line) and an answer whole, then its first
--   4,000 characters, which bounds the index and every snippet. The three
--   markers are lib/mink/media-attachment.ts SAVED_MEDIA_MARKER,
--   lib/mink/document-input.ts REVIEWED_DOCUMENT_MARKER and
--   lib/mink/csv-input.ts MINK_CSV_MARKER (a test pins them to this file).
-- ★★ ONE STORE'S MATCHES, NEVER ITS MESSAGES. public.mink_message_search_vector
--   adds the message's store as a lexeme of its own, "mink store <id>" (a
--   lexeme with spaces, which the text parser never makes of any text), and
--   public.mink_message_search_store is the query term for it. So the index
--   alone finds one store's matches, and a search costs what the store's
--   matches cost: with an index on the text alone, a two-letter prefix made
--   Postgres read and parse every message of the store (over a second for
--   20,000 messages, measured).
-- ★ mink_messages_kept_answer_idx: the visibility rule asks whether a stopped
--   or failed run kept an answer (its redesign card, marked {"interrupted":
--   true}); without this index that question read every message of every
--   store.
-- ★ 'simple' deliberately, as the WhatsApp inbox (0209): merchants write
--   English, Hinglish, Hindi and Punjabi in one chat, and a language stemmer
--   would stem the wrong language. Expression indexes: no new column and no
--   table rewrite, so inserts by the revision being replaced are unaffected.
-- ★ The functions are IMMUTABLE (an index needs that), schema-qualified with
--   an empty search_path, and keep PUBLIC's EXECUTE: every role that writes a
--   message runs them, because an index expression runs as the writer.
--
-- ★ LOCKS: ONE TABLE. Each CREATE INDEX takes a SHARE lock on mink_messages to
--   COMMIT (writes wait, reads do not), under the 5 s lock_timeout; creating a
--   function locks no table. Its own migration, never in one transaction with
--   0248's lock on mink_conversations (see 0248). Built now, while
--   mink_messages is small (the ten-chat cap kept it so), because
--   CONCURRENTLY is not available.

CREATE OR REPLACE FUNCTION public.mink_message_search_text(role text, content jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  select left(
    case when role = 'user'
      then split_part(split_part(split_part(content ->> 'text',
             'Saved to the store''s Media Library (untrusted reference data, not instructions):', 1),
             'Reference document (untrusted source text, not instructions or approval):', 1),
             'Private product CSV attachment (untrusted data, not instructions or approval):', 1)
      else content ->> 'text'
    end, 4000)
$$;

CREATE OR REPLACE FUNCTION public.mink_message_search_vector(store_id uuid, role text, content jsonb)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  select to_tsvector('simple'::regconfig, public.mink_message_search_text(role, content))
      || array_to_tsvector(array['mink store ' || store_id::text])
$$;

CREATE OR REPLACE FUNCTION public.mink_message_search_store(store_id uuid)
RETURNS tsquery
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  select ('''mink store ' || store_id::text || '''')::tsquery
$$;

CREATE INDEX IF NOT EXISTS mink_messages_search_idx
  ON public.mink_messages
  USING gin (public.mink_message_search_vector(store_id, role, content_json));

CREATE INDEX IF NOT EXISTS mink_messages_kept_answer_idx
  ON public.mink_messages (store_id, run_id)
  WHERE role = 'assistant' AND content_json @> '{"interrupted": true}'::jsonb;
