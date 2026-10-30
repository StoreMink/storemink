-- drizzle/migrations/sql/20261030_0269_content_takedown.sql (requires 20261029_0268_plans_and_billing_name_help).
--
-- Operator takedown of one item or a whole store, the 180-day archive, store
-- holds, the complaints log and the moderation record (IT Rules 3(1)(d),
-- 3(1)(g), 3(1)(j), 3(2)(a), 3(2)(b)).
--
-- Expand-only, and backward compatible with the revision being replaced:
--   * six new tables that nothing in the replaced revision names;
--   * one nullable column with no default (moderation_blocked_at) on six
--     content tables: a catalogue-only change, no rewrite;
--   * read policies that ALSO hide a row whose moderation_blocked_at is set.
--     Nothing sets it until the new revision blocks something, so for the
--     replaced revision every read returns exactly what it returned before;
--   * guard triggers that act only when moderation_blocked_at changes, which
--     the replaced revision never writes;
--   * a BEFORE INSERT guard on product_reviews and blog_comments that refuses
--     a row only while a review or comment block names its author, and only
--     the new revision writes blocks;
--   * on stores, a BEFORE DELETE guard that acts only while a hold or an
--     unfinished archive exists, and a BEFORE UPDATE OF status guard that acts
--     only while a whole-store block exists; only the new revision writes
--     either.
-- No existing column, constraint or grant changes.
--
-- LOCKS. This file lowers lock_timeout to 1 s for itself (the runner sets
-- 5 s with SET LOCAL; this SET LOCAL replaces it for the rest of the same
-- transaction only). The foreign keys to stores take SHARE ROW EXCLUSIVE on
-- stores first: writes to stores wait, reads do not. Then ADD COLUMN takes
-- ACCESS EXCLUSIVE on six tables, from the least read to the most read
-- (blog_comments, product_reviews, blogs, categories, store_pages, products),
-- so the busiest tables wait the least. Every later trigger and policy
-- statement needs no lock it does not already hold. Each lock is held to
-- COMMIT, and every statement is a catalogue change. Worst case, when each
-- wait runs to its full second: reads of blog_comments queue for about 6 s,
-- reads of products for about 1 s, writes to stores for about 7 s. A longer
-- wait fails the migration whole (nothing is half applied) and fails the
-- build; the owner re-runs it (docs/migrations.md section 6).
SET LOCAL lock_timeout = '1s';

-- ── 1. The complaints log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.grievance_complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  received_at timestamptz NOT NULL,
  channel text NOT NULL,
  kind text NOT NULL,
  complainant_name text NOT NULL DEFAULT '',
  complainant_contact text NOT NULL DEFAULT '',
  acting_for text NOT NULL DEFAULT '',
  authority_ref text NOT NULL DEFAULT '',
  store_id uuid REFERENCES public.stores(id) ON DELETE SET NULL,
  store_label text NOT NULL DEFAULT '',
  urls text[] NOT NULL DEFAULT '{}',
  summary text NOT NULL,
  acknowledge_due_at timestamptz NOT NULL,
  action_due_at timestamptz NOT NULL,
  resolve_due_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by text,
  acknowledgement_emailed boolean NOT NULL DEFAULT false,
  actioned_at timestamptz,
  actioned_by text,
  resolved_at timestamptz,
  resolved_by text,
  outcome text,
  outcome_note text NOT NULL DEFAULT '',
  alerts jsonb NOT NULL DEFAULT '{}'::jsonb,
  alert_claimed_at timestamptz,
  erased_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grievance_complaints_channel_check CHECK (
    channel IN ('email', 'post', 'web_form', 'gac', 'court', 'government', 'other')
  ),
  CONSTRAINT grievance_complaints_kind_check CHECK (
    kind IN ('court_order', 'government_order', 'information_order',
             'intimate_or_impersonation', 'listed_content', 'other_removal',
             'grievance', 'data_request')
  ),
  CONSTRAINT grievance_complaints_outcome_check CHECK (
    outcome IS NULL
    OR outcome IN ('removed', 'partly_removed', 'not_removed', 'not_ours',
                   'withdrawn', 'answered')
  ),
  CONSTRAINT grievance_complaints_summary_check CHECK (
    erased_at IS NOT NULL OR char_length(btrim(summary)) BETWEEN 1 AND 4000
  ),
  -- Erasure is all or nothing, and only after the complaint is resolved.
  CONSTRAINT grievance_complaints_erased_check CHECK (
    erased_at IS NULL
    OR (resolved_at IS NOT NULL
        AND complainant_name = '' AND complainant_contact = '' AND acting_for = ''
        AND authority_ref = '' AND summary = '' AND cardinality(urls) = 0
        AND outcome_note = '')
  ),
  CONSTRAINT grievance_complaints_text_lengths CHECK (
    char_length(complainant_name) <= 200
    AND char_length(complainant_contact) <= 320
    AND char_length(acting_for) <= 200
    AND char_length(authority_ref) <= 500
    AND char_length(store_label) <= 300
    AND char_length(outcome_note) <= 4000
  ),
  CONSTRAINT grievance_complaints_urls_check CHECK (cardinality(urls) <= 50),
  CONSTRAINT grievance_complaints_alerts_check CHECK (jsonb_typeof(alerts) = 'object'),
  CONSTRAINT grievance_complaints_received_check CHECK (
    received_at <= created_at + interval '5 minutes'
    AND received_at > created_at - interval '1 year'
  ),
  CONSTRAINT grievance_complaints_ack_pair CHECK (
    (acknowledged_at IS NULL) = (acknowledged_by IS NULL)
    AND (acknowledged_at IS NOT NULL OR NOT acknowledgement_emailed)
  ),
  CONSTRAINT grievance_complaints_action_pair CHECK (
    (actioned_at IS NULL) = (actioned_by IS NULL)
  ),
  CONSTRAINT grievance_complaints_resolve_triple CHECK (
    (resolved_at IS NULL) = (resolved_by IS NULL)
    AND (resolved_at IS NULL) = (outcome IS NULL)
  ),
  -- The outer limits StoreMink has bound itself to (IT Rules 3(1)(d),
  -- 3(1)(j), 3(2)(a)(i) and its proviso, 3(2)(b); Privacy sections 7 and 8).
  -- The app sets these or earlier; nothing may record a later deadline.
  CONSTRAINT grievance_complaints_due_check CHECK (
    acknowledge_due_at > received_at
    AND acknowledge_due_at <= received_at + interval '24 hours'
    AND action_due_at > received_at
    AND resolve_due_at >= action_due_at
    AND resolve_due_at <= received_at + CASE kind
      WHEN 'court_order' THEN interval '3 hours'
      WHEN 'government_order' THEN interval '3 hours'
      WHEN 'intimate_or_impersonation' THEN interval '36 hours'
      WHEN 'listed_content' THEN interval '36 hours'
      WHEN 'information_order' THEN interval '72 hours'
      WHEN 'data_request' THEN interval '15 days'
      ELSE interval '7 days'
    END
    AND (kind <> 'intimate_or_impersonation'
         OR action_due_at <= received_at + interval '2 hours')
  )
);
CREATE INDEX IF NOT EXISTS grievance_complaints_open_idx
  ON public.grievance_complaints (action_due_at)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS grievance_complaints_store_idx
  ON public.grievance_complaints (store_id, received_at DESC);
CREATE INDEX IF NOT EXISTS grievance_complaints_resolved_idx
  ON public.grievance_complaints (resolved_at)
  WHERE resolved_at IS NOT NULL AND erased_at IS NULL;

-- ── 2. One blocked item, or a whole store ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.content_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid REFERENCES public.stores(id) ON DELETE SET NULL,
  store_label text NOT NULL,
  item_kind text NOT NULL,
  item_id uuid,
  object_path text,
  object_md5 text,
  file_source text,
  author_user_id text,
  parent_item_id uuid,
  store_status_before text,
  parent_block_id uuid REFERENCES public.content_blocks(id) ON DELETE RESTRICT,
  item_label text NOT NULL,
  item_url text NOT NULL DEFAULT '',
  complaint_id uuid REFERENCES public.grievance_complaints(id) ON DELETE RESTRICT,
  reason_kind text NOT NULL,
  legal_basis text NOT NULL DEFAULT '',
  store_message text NOT NULL,
  tell_store boolean NOT NULL DEFAULT true,
  storage_state text NOT NULL DEFAULT 'none',
  storage_attempts integer NOT NULL DEFAULT 0,
  storage_next_attempt_at timestamptz,
  storage_claimed_at timestamptz,
  storage_error text NOT NULL DEFAULT '',
  blocked_at timestamptz NOT NULL DEFAULT now(),
  blocked_by text NOT NULL,
  merchant_notified_at timestamptz,
  notice_claimed_at timestamptz,
  merchant_seen_at timestamptz,
  lifted_at timestamptz,
  lifted_by text,
  lift_note text NOT NULL DEFAULT '',
  erased_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_blocks_kind_check CHECK (
    item_kind IN ('product', 'page', 'blog_post', 'collection', 'review',
                  'blog_comment', 'file', 'store')
  ),
  CONSTRAINT content_blocks_reason_check CHECK (
    reason_kind IN ('court_order', 'government_order', 'intimate_or_impersonation',
                    'listed_content', 'other_removal', 'terms_breach', 'store_request')
  ),
  -- A store asks StoreMink to remove only what it cannot remove itself.
  CONSTRAINT content_blocks_store_request_check CHECK (
    reason_kind <> 'store_request' OR item_kind IN ('review', 'blog_comment')
  ),
  -- A block is kept from the store only on a court or government order that
  -- says so, and the order's reference is then required.
  CONSTRAINT content_blocks_tell_check CHECK (
    tell_store
    OR (reason_kind IN ('court_order', 'government_order')
        AND char_length(btrim(legal_basis)) > 0)
  ),
  CONSTRAINT content_blocks_storage_values_check CHECK (
    storage_state IN ('none', 'pending', 'failed', 'replaced', 'restoring',
                      'restored', 'not_restored', 'cancelled', 'not_ours',
                      'manual', 'removed_by_hand')
  ),
  -- What each kind names. Written as a CASE so that no NULL can satisfy it.
  -- A file names an object and its source: a path in this environment's
  -- bucket, a bundled /themes/ file, or a full https address on another
  -- host. A review or comment also names its author
  -- and its product or post; a whole-store block names the store and the
  -- status it had, which lifting restores.
  CONSTRAINT content_blocks_target_check CHECK (
    CASE item_kind
      WHEN 'file' THEN
        item_id IS NULL AND object_path IS NOT NULL
        AND char_length(object_path) BETWEEN 1 AND 2048
        AND author_user_id IS NULL AND parent_item_id IS NULL
        AND store_status_before IS NULL
        AND CASE file_source
              WHEN 'bucket' THEN object_path !~ '^(https?:)?/'
              WHEN 'bundled' THEN object_path ~ '^/themes/[A-Za-z0-9._/-]+$'
                                  AND object_path !~ '(^|/)[.][.](/|$)'
              WHEN 'external' THEN object_path ~ '^https://'
              ELSE false
            END
      WHEN 'store' THEN
        item_id IS NOT NULL AND object_path IS NULL AND object_md5 IS NULL
        AND file_source IS NULL AND author_user_id IS NULL AND parent_item_id IS NULL
        AND store_status_before IS NOT NULL
        AND store_status_before IN ('active', 'pending', 'suspended')
        AND (store_id IS NULL OR store_id = item_id)
      WHEN 'review' THEN
        item_id IS NOT NULL AND object_path IS NULL AND object_md5 IS NULL
        AND file_source IS NULL AND store_status_before IS NULL
        AND author_user_id IS NOT NULL AND parent_item_id IS NOT NULL
      WHEN 'blog_comment' THEN
        item_id IS NOT NULL AND object_path IS NULL AND object_md5 IS NULL
        AND file_source IS NULL AND store_status_before IS NULL
        AND author_user_id IS NOT NULL AND parent_item_id IS NOT NULL
      ELSE
        item_id IS NOT NULL AND object_path IS NULL AND object_md5 IS NULL
        AND file_source IS NULL AND store_status_before IS NULL
        AND author_user_id IS NULL AND parent_item_id IS NULL
    END
  ),
  -- What can happen to the stored file, by source.
  CONSTRAINT content_blocks_storage_kind_check CHECK (
    CASE
      WHEN item_kind <> 'file' THEN storage_state = 'none'
      WHEN file_source = 'bucket' THEN storage_state IN (
        'pending', 'failed', 'replaced', 'restoring', 'restored', 'not_restored', 'cancelled')
      WHEN file_source = 'external' THEN storage_state = 'not_ours'
      WHEN file_source = 'bundled' THEN storage_state IN ('manual', 'removed_by_hand')
      ELSE false
    END
  ),
  -- A replacement never runs for a lifted block, and a restore only for one:
  -- lifting must cancel a pending replacement or start the restore in the
  -- same statement.
  CONSTRAINT content_blocks_storage_lift_check CHECK (
    CASE WHEN lifted_at IS NULL
      THEN storage_state NOT IN ('restoring', 'restored', 'not_restored', 'cancelled')
      ELSE storage_state NOT IN ('pending', 'failed', 'replaced')
    END
  ),
  CONSTRAINT content_blocks_label_check CHECK (
    char_length(item_label) BETWEEN 1 AND 300
    AND char_length(store_label) BETWEEN 1 AND 300
    AND char_length(item_url) <= 2048
    AND char_length(legal_basis) <= 1000
    AND char_length(lift_note) <= 2000
    AND char_length(storage_error) <= 1000
  ),
  CONSTRAINT content_blocks_message_check CHECK (
    char_length(btrim(store_message)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT content_blocks_lift_check CHECK (
    (lifted_at IS NULL) = (lifted_by IS NULL)
    AND (lifted_at IS NULL OR lifted_at >= blocked_at)
  ),
  -- Erasure (3 years after the lift) blanks the words and keeps the facts.
  CONSTRAINT content_blocks_erased_check CHECK (
    erased_at IS NULL
    OR (lifted_at IS NOT NULL AND item_label = 'Erased' AND item_url = ''
        AND legal_basis = '' AND lift_note = '' AND store_message = 'Erased')
  ),
  CONSTRAINT content_blocks_attempts_check CHECK (storage_attempts >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS content_blocks_active_item_key
  ON public.content_blocks (item_kind, item_id)
  WHERE lifted_at IS NULL AND item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS content_blocks_active_file_key
  ON public.content_blocks (object_path)
  WHERE lifted_at IS NULL AND object_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_blocks_store_idx
  ON public.content_blocks (store_id, blocked_at DESC);
CREATE INDEX IF NOT EXISTS content_blocks_complaint_idx
  ON public.content_blocks (complaint_id) WHERE complaint_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_blocks_md5_idx
  ON public.content_blocks (store_id, object_md5)
  WHERE lifted_at IS NULL AND object_md5 IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_blocks_author_idx
  ON public.content_blocks (author_user_id, parent_item_id)
  WHERE lifted_at IS NULL AND author_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_blocks_storage_due_idx
  ON public.content_blocks (storage_next_attempt_at)
  WHERE storage_state IN ('pending', 'restoring');
CREATE INDEX IF NOT EXISTS content_blocks_notice_due_idx
  ON public.content_blocks (blocked_at)
  WHERE tell_store AND merchant_notified_at IS NULL AND lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS content_blocks_erase_idx
  ON public.content_blocks (lifted_at)
  WHERE lifted_at IS NOT NULL AND erased_at IS NULL;

-- A block's item, time, author, reason and words are a record: they never
-- change. The store link may still be cleared (ON DELETE SET NULL); a
-- complaint may be linked once; the file's MD5 may be filled in once; a block
-- kept from the store may later be told, never the reverse; lifting happens
-- once and is never undone (block again instead); erasure, once, is the only
-- change to the words.
CREATE OR REPLACE FUNCTION public.content_blocks_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
declare
  v_erasing boolean := old.erased_at is null and new.erased_at is not null;
begin
  if new.item_kind is distinct from old.item_kind
     or new.item_id is distinct from old.item_id
     or new.object_path is distinct from old.object_path
     or (old.object_md5 is not null and new.object_md5 is distinct from old.object_md5)
     or new.file_source is distinct from old.file_source
     or new.author_user_id is distinct from old.author_user_id
     or new.parent_item_id is distinct from old.parent_item_id
     or new.store_status_before is distinct from old.store_status_before
     or new.parent_block_id is distinct from old.parent_block_id
     or new.reason_kind is distinct from old.reason_kind
     or new.blocked_at is distinct from old.blocked_at
     or new.blocked_by is distinct from old.blocked_by
     or (old.tell_store and not new.tell_store)
     or (old.complaint_id is not null and new.complaint_id is distinct from old.complaint_id)
     or (old.lifted_at is not null and (new.lifted_at is distinct from old.lifted_at
                                        or new.lifted_by is distinct from old.lifted_by))
     or (old.erased_at is not null and new.erased_at is distinct from old.erased_at)
     or (not v_erasing and (new.item_label is distinct from old.item_label
                            or new.item_url is distinct from old.item_url
                            or new.legal_basis is distinct from old.legal_basis
                            or new.store_message is distinct from old.store_message
                            or (old.lifted_at is not null
                                and new.lift_note is distinct from old.lift_note)))
  then
    raise exception 'content_blocks: % is a record; block again instead of editing it', old.id;
  end if;
  return new;
end;
$$;
DROP TRIGGER IF EXISTS content_blocks_keep_record ON public.content_blocks;
CREATE TRIGGER content_blocks_keep_record
  BEFORE UPDATE ON public.content_blocks
  FOR EACH ROW EXECUTE FUNCTION public.content_blocks_guard_update();

-- ── 3. What the store and StoreMink say to each other about a block ────────
CREATE TABLE IF NOT EXISTS public.content_block_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id uuid NOT NULL REFERENCES public.content_blocks(id) ON DELETE RESTRICT,
  from_side text NOT NULL,
  author text NOT NULL,
  body text NOT NULL,
  asks_review boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  CONSTRAINT content_block_messages_side_check CHECK (from_side IN ('store', 'storemink')),
  CONSTRAINT content_block_messages_author_check CHECK (char_length(author) BETWEEN 1 AND 320),
  CONSTRAINT content_block_messages_body_check CHECK (
    char_length(btrim(body)) BETWEEN 1 AND 4000
  ),
  CONSTRAINT content_block_messages_review_check CHECK (
    NOT asks_review OR from_side = 'store'
  )
);
CREATE INDEX IF NOT EXISTS content_block_messages_block_idx
  ON public.content_block_messages (block_id, created_at);
CREATE INDEX IF NOT EXISTS content_block_messages_unseen_idx
  ON public.content_block_messages (from_side, created_at)
  WHERE seen_at IS NULL;

-- ── 4. The preserved copy, out of the merchant's reach ─────────────────────
CREATE TABLE IF NOT EXISTS public.content_block_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id uuid NOT NULL UNIQUE REFERENCES public.content_blocks(id) ON DELETE RESTRICT,
  store_id uuid REFERENCES public.stores(id) ON DELETE SET NULL,
  snapshot jsonb,
  snapshot_sha256 text NOT NULL,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  files_state text NOT NULL DEFAULT 'none',
  files_attempts integer NOT NULL DEFAULT 0,
  files_next_attempt_at timestamptz,
  files_claimed_at timestamptz,
  files_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  keep_until timestamptz NOT NULL,
  legal_hold boolean NOT NULL DEFAULT false,
  legal_hold_note text NOT NULL DEFAULT '',
  legal_hold_set_at timestamptz,
  legal_hold_set_by text,
  purged_at timestamptz,
  CONSTRAINT content_block_archives_files_check CHECK (jsonb_typeof(files) = 'array'),
  CONSTRAINT content_block_archives_files_state_check CHECK (
    files_state IN ('none', 'pending', 'copied', 'failed')
  ),
  CONSTRAINT content_block_archives_attempts_check CHECK (
    files_attempts >= 0 AND char_length(files_error) <= 1000
  ),
  CONSTRAINT content_block_archives_sha_check CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_block_archives_keep_check CHECK (
    keep_until >= created_at + interval '180 days'
  ),
  CONSTRAINT content_block_archives_purge_check CHECK (
    (purged_at IS NULL) = (snapshot IS NOT NULL)
  ),
  CONSTRAINT content_block_archives_hold_check CHECK (
    (legal_hold_set_at IS NULL) = (legal_hold_set_by IS NULL)
    AND (NOT legal_hold OR (purged_at IS NULL AND legal_hold_set_at IS NOT NULL))
  )
);
CREATE INDEX IF NOT EXISTS content_block_archives_due_idx
  ON public.content_block_archives (keep_until)
  WHERE purged_at IS NULL AND NOT legal_hold;
CREATE INDEX IF NOT EXISTS content_block_archives_files_due_idx
  ON public.content_block_archives (files_next_attempt_at)
  WHERE files_state = 'pending';
CREATE INDEX IF NOT EXISTS content_block_archives_unfinished_idx
  ON public.content_block_archives (store_id)
  WHERE files_state IN ('pending', 'failed');

-- The preserved copy is write-once ("without vitiating the evidence"): its
-- snapshot never changes; its file list changes only while the files are
-- still being copied, and is frozen once copied; the purge empties it only
-- after keep_until, never while held; keep_until only grows. The claim and
-- attempt columns are bookkeeping and may change.
CREATE OR REPLACE FUNCTION public.content_block_archives_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
declare
  v_purging boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'content_block_archives: % is kept; the purge empties it instead', old.id;
  end if;
  v_purging := old.purged_at is null and new.purged_at is not null;
  if v_purging and (old.legal_hold or new.legal_hold or old.keep_until > now()) then
    raise exception 'content_block_archives: % is held or not yet due for purging', old.id;
  end if;
  if new.block_id is distinct from old.block_id
     or new.created_at is distinct from old.created_at
     or new.snapshot_sha256 is distinct from old.snapshot_sha256
     or new.keep_until < old.keep_until
     or (old.purged_at is not null and new.purged_at is distinct from old.purged_at)
     or (new.snapshot is distinct from old.snapshot and not (v_purging and new.snapshot is null))
     or (new.files is distinct from old.files
         and not (v_purging and new.files = '[]'::jsonb)
         and old.files_state not in ('none', 'pending', 'failed'))
     or (old.files_state = 'copied' and new.files_state is distinct from old.files_state)
  then
    raise exception 'content_block_archives: % is a preserved copy and cannot be changed', old.id;
  end if;
  return new;
end;
$$;
DROP TRIGGER IF EXISTS content_block_archives_write_once ON public.content_block_archives;
CREATE TRIGGER content_block_archives_write_once
  BEFORE UPDATE OR DELETE ON public.content_block_archives
  FOR EACH ROW EXECUTE FUNCTION public.content_block_archives_guard();

-- ── 5. Stores: holds, and what a whole-store block and its archive need ────
CREATE TABLE IF NOT EXISTS public.store_legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid REFERENCES public.stores(id) ON DELETE SET NULL,
  store_label text NOT NULL,
  reason text NOT NULL,
  authority_ref text NOT NULL DEFAULT '',
  complaint_id uuid REFERENCES public.grievance_complaints(id) ON DELETE RESTRICT,
  set_at timestamptz NOT NULL DEFAULT now(),
  set_by text NOT NULL,
  review_on date,
  released_at timestamptz,
  released_by text,
  release_note text NOT NULL DEFAULT '',
  CONSTRAINT store_legal_holds_reason_check CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 2000
    AND char_length(authority_ref) <= 500
    AND char_length(store_label) BETWEEN 1 AND 300
  ),
  CONSTRAINT store_legal_holds_release_pair CHECK (
    (released_at IS NULL) = (released_by IS NULL)
  ),
  -- An active hold always names its store: the delete guard below reads it.
  CONSTRAINT store_legal_holds_active_store CHECK (
    released_at IS NOT NULL OR store_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS store_legal_holds_one_active_key
  ON public.store_legal_holds (store_id) WHERE released_at IS NULL;

-- No path deletes a store that is held, or whose archived copy is still
-- being made (store deletion empties stores/<id>/, which would take the
-- originals before they are copied).
CREATE OR REPLACE FUNCTION public.stores_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if exists (
    select 1 from public.store_legal_holds h
     where h.store_id = old.id and h.released_at is null
  ) then
    raise exception 'stores: % is on hold for an investigation and cannot be deleted', old.id;
  end if;
  if exists (
    select 1 from public.content_block_archives a
     where a.store_id = old.id and a.files_state in ('pending', 'failed')
  ) then
    raise exception 'stores: % has a StoreMink archive whose files are not copied yet', old.id;
  end if;
  return old;
end;
$$;
DROP TRIGGER IF EXISTS stores_keep_for_investigation ON public.stores;
CREATE TRIGGER stores_keep_for_investigation
  BEFORE DELETE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.stores_guard_delete();

-- A store suspended by a whole-store block stays suspended until the block
-- is lifted: the console's Reactivate, a script or psql cannot undo it.
-- (Lifting runs inside content_blocks_apply after the block row is lifted,
-- so no live block remains and this guard lets it through.)
CREATE OR REPLACE FUNCTION public.stores_guard_moderation_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if exists (
    select 1 from public.content_blocks b
     where b.item_kind = 'store' and b.item_id = old.id and b.lifted_at is null
  ) then
    raise exception 'stores: % is suspended by a StoreMink block; lift the block instead', old.id;
  end if;
  return new;
end;
$$;
DROP TRIGGER IF EXISTS stores_keep_moderation_suspension ON public.stores;
CREATE TRIGGER stores_keep_moderation_suspension
  BEFORE UPDATE OF status ON public.stores
  FOR EACH ROW
  WHEN (old.status = 'suspended' AND new.status IS DISTINCT FROM old.status)
  EXECUTE FUNCTION public.stores_guard_moderation_status();

-- ── 6. The record of every action (append-only for the app) ────────────────
CREATE TABLE IF NOT EXISTS public.moderation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  complaint_id uuid,
  block_id uuid,
  hold_id uuid,
  store_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT moderation_events_actor_check CHECK (char_length(actor) BETWEEN 1 AND 320),
  CONSTRAINT moderation_events_detail_check CHECK (
    jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 16384
  ),
  CONSTRAINT moderation_events_action_check CHECK (action IN (
    'complaint_logged', 'complaint_updated', 'complaint_acknowledged',
    'complaint_actioned', 'complaint_resolved', 'complaint_reopened',
    'complaint_alerted', 'complaint_erased',
    'block_created', 'block_lifted', 'block_erased', 'store_told',
    'archive_written', 'archive_files_copied', 'archive_files_failed',
    'archive_viewed', 'archive_downloaded', 'archive_kept_longer',
    'archive_hold_set', 'archive_hold_released', 'archive_purged',
    'archive_purge_skipped',
    'storage_replaced', 'storage_failed', 'storage_cancelled', 'storage_restored',
    'storage_not_restored', 'storage_removed_by_hand',
    'merchant_notified', 'merchant_notify_failed',
    'store_replied', 'storemink_replied', 'reupload_refused',
    'store_hold_set', 'store_hold_released', 'store_delete_refused',
    'store_deleted', 'store_suspended', 'store_reactivated'
  ))
);
CREATE INDEX IF NOT EXISTS moderation_events_store_idx
  ON public.moderation_events (store_id, at DESC);
CREATE INDEX IF NOT EXISTS moderation_events_complaint_idx
  ON public.moderation_events (complaint_id, at) WHERE complaint_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS moderation_events_block_idx
  ON public.moderation_events (block_id, at) WHERE block_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS moderation_events_at_idx
  ON public.moderation_events (at);

-- Retention of the record. The daily sweep calls this; the app itself has no
-- DELETE on the table. Never while the store or the block's archive is held.
CREATE OR REPLACE FUNCTION public.moderation_prune_events(p_floor timestamptz, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_deleted integer;
begin
  if p_floor > now() - interval '1 year' then
    raise exception 'moderation_prune_events: the record is kept at least 1 year';
  end if;
  with doomed as (
    select e.id
      from public.moderation_events e
     where e.at < p_floor
       and not exists (
         select 1 from public.store_legal_holds h
          where h.store_id = e.store_id and h.released_at is null)
       and not exists (
         select 1 from public.content_block_archives a
          where a.block_id = e.block_id and (a.legal_hold or a.purged_at is null))
     order by e.at
     limit greatest(p_limit, 0)
  )
  delete from public.moderation_events e using doomed d where e.id = d.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ── 7. The visibility flag on each content table ───────────────────────────
-- Least read first, so the busiest tables wait the least (see LOCKS above).
ALTER TABLE public.blog_comments ADD COLUMN IF NOT EXISTS moderation_blocked_at timestamptz;
ALTER TABLE public.product_reviews ADD COLUMN IF NOT EXISTS moderation_blocked_at timestamptz;
ALTER TABLE public.blogs ADD COLUMN IF NOT EXISTS moderation_blocked_at timestamptz;
ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS moderation_blocked_at timestamptz;
ALTER TABLE public.store_pages ADD COLUMN IF NOT EXISTS moderation_blocked_at timestamptz;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS moderation_blocked_at timestamptz;

-- Set and cleared ONLY by content_blocks_apply() below. Every other write
-- keeps the stored value: an INSERT never arrives blocked, and no UPDATE from
-- the dashboard, Mink AI, an import or a theme can unblock a row.
CREATE OR REPLACE FUNCTION public.moderation_flag_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  -- content_blocks_apply() is itself a trigger, so its UPDATE arrives here at
  -- depth 2. A statement from the app, Mink AI, an import or psql is depth 1.
  if pg_trigger_depth() < 2 then
    if tg_op = 'INSERT' then
      new.moderation_blocked_at := null;
    else
      new.moderation_blocked_at := old.moderation_blocked_at;
    end if;
  end if;
  return new;
end;
$$;

DO $$
declare
  t text;
begin
  foreach t in array array['blog_comments', 'product_reviews', 'blogs', 'categories',
                           'store_pages', 'products']
  loop
    execute format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_moderation_insert_guard', t);
    execute format(
      'CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW
         WHEN (new.moderation_blocked_at IS NOT NULL)
         EXECUTE FUNCTION public.moderation_flag_guard()',
      t || '_moderation_insert_guard', t);
    execute format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_moderation_update_guard', t);
    execute format(
      'CREATE TRIGGER %I BEFORE UPDATE OF moderation_blocked_at ON public.%I FOR EACH ROW
         WHEN (new.moderation_blocked_at IS DISTINCT FROM old.moderation_blocked_at)
         EXECUTE FUNCTION public.moderation_flag_guard()',
      t || '_moderation_update_guard', t);
  end loop;
end;
$$;

-- An author whose review or comment StoreMink removed cannot post another on
-- the same product or post while the block is live, whether or not they
-- deleted the first one (reviews are unique per author and product only
-- while the row exists; comments are not unique at all). SECURITY DEFINER
-- because shoppers (app_user) cannot read content_blocks.
CREATE OR REPLACE FUNCTION public.moderation_author_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if tg_table_name = 'product_reviews' then
    if exists (
      select 1 from public.content_blocks b
       where b.lifted_at is null and b.item_kind = 'review'
         and b.author_user_id = new.user_id and b.parent_item_id = new.product_id
    ) then
      raise exception using errcode = 'P0001',
        message = 'moderation: review removed by StoreMink';
    end if;
  else
    if exists (
      select 1 from public.content_blocks b
       where b.lifted_at is null and b.item_kind = 'blog_comment'
         and b.author_user_id = new.user_id and b.parent_item_id = new.blog_id
    ) then
      raise exception using errcode = 'P0001',
        message = 'moderation: comment removed by StoreMink';
    end if;
  end if;
  return new;
end;
$$;
DROP TRIGGER IF EXISTS product_reviews_moderation_author_guard ON public.product_reviews;
CREATE TRIGGER product_reviews_moderation_author_guard
  BEFORE INSERT ON public.product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.moderation_author_guard();
DROP TRIGGER IF EXISTS blog_comments_moderation_author_guard ON public.blog_comments;
CREATE TRIGGER blog_comments_moderation_author_guard
  BEFORE INSERT ON public.blog_comments
  FOR EACH ROW EXECUTE FUNCTION public.moderation_author_guard();

-- A new block hides its row (or suspends its store) in the same transaction;
-- lifting shows it again. The row must exist, belong to the block's store and
-- match what the block recorded (a review's or comment's author and product
-- or post, a store's status), so a mistyped id never records a block that
-- hides nothing.
CREATE OR REPLACE FUNCTION public.content_blocks_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_at timestamptz;
  v_rows integer;
begin
  if new.item_kind = 'file' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if new.lifted_at is not null then
      return null;
    end if;
    v_at := new.blocked_at;
  elsif old.lifted_at is null and new.lifted_at is not null then
    v_at := null;
  else
    return null;
  end if;

  case new.item_kind
    when 'store' then
      if v_at is not null then
        update public.stores set status = 'suspended'
         where id = new.item_id and id = new.store_id
           and status = new.store_status_before;
      else
        update public.stores set status = new.store_status_before
         where id = new.item_id and status = 'suspended';
      end if;
    when 'product' then
      update public.products set moderation_blocked_at = v_at
       where id = new.item_id and (v_at is null or store_id = new.store_id);
    when 'page' then
      update public.store_pages set moderation_blocked_at = v_at
       where id = new.item_id and (v_at is null or store_id = new.store_id);
    when 'blog_post' then
      update public.blogs set moderation_blocked_at = v_at
       where id = new.item_id and (v_at is null or store_id = new.store_id);
    when 'collection' then
      update public.categories set moderation_blocked_at = v_at
       where id = new.item_id and (v_at is null or store_id = new.store_id);
    when 'review' then
      update public.product_reviews set moderation_blocked_at = v_at
       where id = new.item_id
         and (v_at is null
              or (store_id = new.store_id and user_id = new.author_user_id
                  and product_id = new.parent_item_id));
    when 'blog_comment' then
      update public.blog_comments set moderation_blocked_at = v_at
       where id = new.item_id
         and (v_at is null
              or (store_id = new.store_id and user_id = new.author_user_id
                  and blog_id = new.parent_item_id));
  end case;
  get diagnostics v_rows = row_count;
  if tg_op = 'INSERT' and v_rows <> 1 then
    raise exception 'content_blocks: no % % in store % as recorded', new.item_kind, new.item_id, new.store_id;
  end if;
  return null;
end;
$$;
DROP TRIGGER IF EXISTS content_blocks_apply_flag ON public.content_blocks;
CREATE TRIGGER content_blocks_apply_flag
  AFTER INSERT OR UPDATE OF lifted_at ON public.content_blocks
  FOR EACH ROW EXECUTE FUNCTION public.content_blocks_apply();

-- ── 8. The public read policies also hide a blocked row ────────────────────
-- Same expressions as before with one more condition. Store admins (and
-- operators, through is_store_admin) still read their own rows, and a
-- shopper still reads their own review, comment or submitted post, so their
-- account pages and delete keep working; nobody else sees a blocked row.
ALTER POLICY "Anyone can read blog comments" ON public.blog_comments
  USING ((moderation_blocked_at IS NULL)
         OR (user_id = ( SELECT auth.uid() AS uid)));
ALTER POLICY "Anyone can read reviews" ON public.product_reviews
  USING ((moderation_blocked_at IS NULL)
         OR (user_id = ( SELECT auth.uid() AS uid)));
ALTER POLICY "Read blogs" ON public.blogs
  USING (((status = 'published'::text) AND (moderation_blocked_at IS NULL))
         OR ((submitted_by = ( SELECT auth.uid() AS uid)) AND (is_customer_submission = true))
         OR ( SELECT is_store_admin(blogs.store_id) AS is_store_admin));
ALTER POLICY "Read categories" ON public.categories
  USING (((status = 'active'::text) AND (moderation_blocked_at IS NULL))
         OR ( SELECT is_store_admin(categories.store_id) AS is_store_admin));
ALTER POLICY "Public read published store_pages" ON public.store_pages
  USING (((status = 'published'::text) AND (moderation_blocked_at IS NULL))
         OR ( SELECT is_store_admin(store_pages.store_id) AS is_store_admin));
ALTER POLICY "Read products" ON public.products
  USING (((status = 'published'::text) AND (moderation_blocked_at IS NULL))
         OR ( SELECT is_store_admin(products.store_id) AS is_store_admin));

-- ── 9. Access: StoreMink's own code only, never app_user ───────────────────
-- ★ The schema's default privileges give app_user AND app_service
-- SELECT, INSERT, UPDATE, DELETE on every new table and EXECUTE on every new
-- function (pg_default_acl, checked on storemink_local), so each grant below
-- starts from REVOKE ALL for both roles. Without it app_service could delete
-- the moderation record and app_user could run the prune.
ALTER TABLE public.grievance_complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_block_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_block_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderation_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.grievance_complaints, public.content_blocks,
  public.content_block_messages, public.content_block_archives,
  public.store_legal_holds, public.moderation_events
  FROM PUBLIC, app_user, app_service;
REVOKE ALL ON SEQUENCE public.grievance_complaints_ref_no_seq
  FROM PUBLIC, app_user, app_service;

GRANT SELECT, INSERT, UPDATE ON public.grievance_complaints TO app_service;
GRANT SELECT, INSERT, UPDATE ON public.content_blocks TO app_service;
GRANT SELECT, INSERT, UPDATE ON public.content_block_messages TO app_service;
GRANT SELECT, INSERT, UPDATE ON public.content_block_archives TO app_service;
GRANT SELECT, INSERT, UPDATE ON public.store_legal_holds TO app_service;
GRANT SELECT, INSERT ON public.moderation_events TO app_service;

REVOKE ALL ON FUNCTION public.moderation_prune_events(timestamptz, integer)
  FROM PUBLIC, app_user, app_service;
GRANT EXECUTE ON FUNCTION public.moderation_prune_events(timestamptz, integer) TO app_service;
-- Trigger functions: nobody calls them directly. A trigger fires whatever the
-- caller's EXECUTE rights (probe P12).
REVOKE ALL ON FUNCTION public.stores_guard_delete(), public.stores_guard_moderation_status(),
  public.content_blocks_apply(), public.moderation_flag_guard(),
  public.moderation_author_guard(), public.content_blocks_guard_update(),
  public.content_block_archives_guard()
  FROM PUBLIC, app_user, app_service;
