-- Release indexes and grants (robustness follow-ups, 2026-10-24).
--
-- Seven indexes, each for a statement that otherwise reads its whole table,
-- and the two grants the failed-run record needs that no migration ever made.
--
-- ★★ THE STORE PURGE: storefront_events.order_id. Its foreign key to orders is
-- ON DELETE CASCADE and no index leads with order_id (the only index naming it
-- is the partial unique (store_id, order_id) of purchase events, which a delete
-- by order alone cannot use), so deleting a store scanned storefront_events
-- once per order. Measured on a local copy (24 Oct): a store with 200,305
-- orders was cancelled after 238 s, and with this index the delete took
-- 13.9 s; 200 orders of that store spent 2,999 ms in the cascade before and
-- 0.75 ms after. Partial: only a purchase event carries an order (20 of
-- 211,473 rows locally), and the cascade's own statement (order_id = $1)
-- implies order_id IS NOT NULL, so the planner uses it, generic plan included.
--
-- ★★ THE DEAD-RUN SWEEP: mink_runs (robustness audit B7). The per-minute sweep
-- (closeStaleMinkRuns, lib/mink/persistence.ts, through staleMinkRunCondition
-- in lib/mink/conversation-history.ts) asks every store at once for runs with
-- status = 'running' and started_at more than 15 minutes ago, ordered by
-- started_at, id, limit 20, and without this it reads every run ever recorded
-- to find none. The index holds only running runs, in the sweep's own order,
-- so there is no sort either. Measured on a local copy with 200,083 runs
-- (rolled back): 15.7 ms and 12,656 buffers before, 0.09 ms and 131 buffers
-- after, the generic plan too. The one-chat close (the History delete) names
-- its store and conversation and keeps using mink_runs_status_idx.
--
-- ★ THE RETENTION CASCADES (CODEBASE.md section 32). Pruning activity_events
-- cascades to notification_sms_queue and notification_whatsapp_queue by
-- event_id. Pruning a closed WhatsApp conversation deletes its Mink answers by
-- conversation_id and sets whatsapp_mink_answers.message_id and
-- sent_message_id to null for each of its messages. All five are foreign keys
-- and none was indexed: the two indexes that name conversation_id lead with
-- store_id or hold drafts only, so that cascade read every answer of every
-- store once per pruned conversation (a 50-conversation batch over 200,000
-- answers spent 270 ms in it, in a scratch database on 25 Oct, and 0.42 ms
-- with its index). conversation_id is NOT NULL and the app writes event_id on
-- every queue row and message_id on every answer, so those four indexes are
-- whole; sent_message_id is set only for an answer that was sent, so its
-- index is partial.
--
-- ★★ THE GRANTS (robustness audit B4). When a failed run kept a redesign card
-- beside other unseen proposals, failMinkRun (discardBesideCard) moves those
-- proposals and their credit rows to a holder run, lets
-- discard_failed_mink_run_drafts (0040, SECURITY DEFINER, so it writes the
-- refunds as its owner) discard and refund them, and deletes the holder. As
-- app_service that needs DELETE on mink_runs (0035 grants SELECT, INSERT,
-- UPDATE) and UPDATE of run_id on mink_draft_credit_usage (0040 grants SELECT,
-- INSERT), which every database held only through the default privileges of
-- drizzle/manual/0000_compat_setup.sql. Granted here, and nothing more: UPDATE
-- is on run_id alone, the one column the move writes, so app_service still
-- cannot rewrite what a proposal was charged. Proved on a local copy, rolled
-- back: with every privilege no migration grants removed, those two statements
-- were refused and every other statement of the failure record ran; with these
-- two grants the whole path ran, the refunds included.
--
-- ★ LOCKS. The runner wraps this file in one transaction under a 5 s
-- lock_timeout, so CONCURRENTLY cannot be used. Each CREATE INDEX takes a SHARE
-- lock on its table (reads go on, writes wait) from the moment it runs until
-- COMMIT, so the statements run from the least written table to the most
-- written one, and the busiest tables wait the least. In production every one
-- of these tables is small (storefront_events keeps 14 days of raw events),
-- so the whole file holds those locks for milliseconds. A GRANT holds no lock
-- on its table. A write still holding one of these tables after 5 s fails
-- this migration cleanly and stops the deploy; run it again.
--
-- Expand-only: indexes and grants; nothing the running revision uses changes.

CREATE INDEX IF NOT EXISTS whatsapp_mink_answers_message_idx
  ON public.whatsapp_mink_answers (message_id);

CREATE INDEX IF NOT EXISTS whatsapp_mink_answers_sent_message_idx
  ON public.whatsapp_mink_answers (sent_message_id)
  WHERE sent_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS whatsapp_mink_answers_conversation_id_idx
  ON public.whatsapp_mink_answers (conversation_id);

CREATE INDEX IF NOT EXISTS notification_whatsapp_queue_event_idx
  ON public.notification_whatsapp_queue (event_id);

CREATE INDEX IF NOT EXISTS notification_sms_queue_event_idx
  ON public.notification_sms_queue (event_id);

CREATE INDEX IF NOT EXISTS mink_runs_running_idx
  ON public.mink_runs (started_at, id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS storefront_events_order_idx
  ON public.storefront_events (order_id)
  WHERE order_id IS NOT NULL;

GRANT DELETE ON TABLE public.mink_runs TO app_service;
GRANT UPDATE (run_id) ON TABLE public.mink_draft_credit_usage TO app_service;
