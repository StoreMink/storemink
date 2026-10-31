import "server-only";

// ---------------------------------------------------------------------------
// ★★ TEMPORARY. The nightly job that sorts the Mink AI chat pictures attached
// BEFORE they were stored privately: public `media_assets` rows with source
// `mink_attachment` (design next-release/storage.md 5.10; the log table is
// migration 20261028_0262's mink_attachment_legacy_log). It is the LAST entry
// of RETENTION_POLICIES (lib/retention/prune.ts) and runs only against the two
// real databases. Once production reports nothing left to handle for a week
// (owner step P5: `left` equals `givenUp + held`), delete this file, its test,
// the retention entry and the log table, and nothing else moves.
//
// ★ Its own module, not the design's lib/mink/attachments.ts: the job is
//   temporary and lives better in a file that can be deleted whole, and the
//   build of items 5 and 6 (promotion, inline references) was appending to
//   attachments.ts at the same time. It imports what it needs from there and
//   renames nothing.
//
// What happens to each picture, in order (design 5.10):
//   0. given up (three failed nights): kept as an ordinary upload;
//   1. the public object is gone: the row goes, recorded `missing`;
//   2. the store still shows it, or a proposal that can still be approved
//      names it: kept as an ordinary upload (`in_use`, `live_proposal`);
//   3. exactly one live chat names it: copied to private storage, checked by
//      size and MD5, linked to the chat under the chat's own try-lock, the
//      chat's messages rewritten to the new address, the public object
//      deleted, the row removed, recorded `moved`; several live chats keep
//      it; no live chat: the public object and the row go, recorded
//      `deleted`;
//   4. one content-free log line per batch with the progress counts.
// Every outcome is recorded in mink_attachment_legacy_log with the public
// path, so a mistaken deletion can be restored from the bucket's soft delete
// (owner step P9). A failure is recorded `failing` with the step's reason and
// the picture is out of the candidates for 20 hours, so it is tried again the
// next night and never sits at the head of every batch.
//
// ★ A decision is recorded only when the media change it records touched a
//   row (an overlapping run, or a delete, may have taken the row first).
// ★ A private object is deleted only when no private row holds the id: the
//   private path is the same for every run (the id is the media id), so an
//   overlapping run may have linked that very path. Unknown means keep.
// ★ A move records that it started (a failing `copy_failed` record that does
//   not count an attempt) before it copies, so a run that dies between the
//   copy and the link leaves the record that sends the next night looking for
//   its copy: before any final decision (kept or missing), a picture with a
//   record has its private leftover deleted when no private row holds the id.
// ★ A chat with a reply still running waits a night, uncounted: the running
//   reply's history carries the public address, and the move would rewrite
//   and delete it underneath. The same wait is re-checked under the chat's
//   lock, with the proposals naming the picture.
// ★ The sweep's deadline reaches the batch: no picture is started within
//   MINK_LEGACY_PICTURE_RESERVE_MS of it, and the batch tells the sweep it
//   stopped for time. A failure whose record cannot be written is not taken
//   again in the same run (the run's skip set).
// ★ The store's own uses are searched by the object PATH, so an address
//   written with another host form or a query string still keeps the picture.
//
// ★ Every withService scope is separate, never nested, and none holds a
//   connection across a storage call (lib/db/nested-scope-coverage.test.ts).
// ★ A store under a legal hold keeps its pictures where they are (design
//   14.1 point 3, storage decision D10): the candidates leave it out until the
//   hold is released, and the batch line counts what waits on a hold (`held`).
// ---------------------------------------------------------------------------

import { sql, type SQL } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { storefrontImageUsage } from "@/lib/media/image-usage";
import { productImageUsage } from "@/lib/media/product-images";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  gcsCopyObject,
  gcsDeletePaths,
  gcsObjectMetadata,
  gcsPrivateConfigured,
} from "@/lib/storage/gcs";
import {
  isOtherStoreObjectPath,
  isStoreOwnedObjectPath,
} from "@/lib/storage/paths";
import { MAX_IMAGE_BYTES } from "@/lib/storage/process-image";
import { minkAttachmentUrl } from "./attachment-ref";
import {
  MINK_ATTACHMENT_EXTENSIONS,
  MINK_ATTACHMENT_FILENAME_MAX,
  attachmentDatabase,
  minkAttachmentPath,
} from "./attachments";

/** A picture that failed tonight is out of the candidates for this long. */
export const MINK_LEGACY_RETRY_AFTER_HOURS = 20;

/** After this many failed nights a picture is kept as an ordinary upload. */
export const MINK_LEGACY_GIVE_UP_AFTER = 3;

/** The retention entry's batch: a storage copy or delete and several reads a picture. */
export const MINK_LEGACY_BATCH_SIZE = 25;

/**
 * Room left for one more picture before the run's deadline: up to eight
 * round trips and a copy of up to 5 MB. No picture is started closer to it.
 */
export const MINK_LEGACY_PICTURE_RESERVE_MS = 20_000;

/**
 * The only databases the job runs against (docs/migrations.md names them):
 * the public objects of old attachments are shared by staging and
 * storemink_local rows with the same paths (design 5.8), so a local or an
 * unknown database name does nothing.
 */
export const MINK_LEGACY_DATABASES = [
  "storemink",
  "storemink_staging",
] as const;

/** The log's CHECK: `stores/{store}/...`, at most this long, no `..`. */
const LOG_PATH_MAX = 1024;

export type MinkLegacyKeptReason =
  | "in_use"
  | "live_proposal"
  | "several_chats"
  | "not_movable"
  | "gave_up";

export type MinkLegacyFailingReason =
  | "read_failed"
  | "copy_failed"
  | "copy_mismatch"
  | "chat_busy"
  | "delete_failed"
  | "keep_failed";

/** A final record, with the one reason each outcome pairs with (0262's CHECK). */
export type MinkLegacyDecision =
  | { outcome: "kept"; reason: MinkLegacyKeptReason }
  | { outcome: "moved"; reason: "moved_with_chat" }
  | { outcome: "deleted"; reason: "no_live_use" }
  | { outcome: "missing"; reason: "object_missing" };

/** What the batch counts a picture as. */
export type MinkLegacyHandled =
  | "kept"
  | "moved"
  | "deleted"
  | "missing"
  | "failed";

export interface MinkLegacyCandidate {
  id: string;
  store_id: string;
  url: string;
  path: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** Failed nights so far (0 with no record). */
  attempts: number;
  /**
   * Whether the picture has a record (a failure, an uncounted wait, or a
   * move that started): only then can an earlier attempt have left a
   * private copy behind.
   */
  recorded: boolean;
}

/**
 * What one run of the sweep hands each batch: lib/retention/prune.ts
 * `RetentionBatchContext`, read structurally (that module imports this one).
 */
export interface MinkLegacyBatch {
  /** The run's deadline on `clock`. */
  deadline?: number;
  clock?: () => number;
  /**
   * Pictures this run does not take again: a failure it could not record,
   * or a row that changed underneath. One set for every batch of the run.
   */
  skip?: Set<string>;
  /** Set when the batch stopped for time, so the sweep reports "budget". */
  outOfTime?: boolean;
}

/** Whether the job may run against `database` (design 5.8, 5.10). */
export function legacyMoveAllowed(database = attachmentDatabase()): boolean {
  return (MINK_LEGACY_DATABASES as readonly string[]).includes(database);
}

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

/**
 * The pictures to handle tonight, oldest first: public attachment rows
 * created before the floor (now minus 2 days, so one still staged in an open
 * composer at deploy time is left alone), with no record yet, or a failing
 * record of fewer than four attempts last tried over 20 hours ago, and none
 * the run has set aside (`skip`). No index is added to a busy table for a
 * temporary job: one sequential scan per batch over the media rows is cheap
 * (a few thousand expected on production).
 */
export function legacyCandidatesSql(
  floorIso: string,
  limit: number,
  skip: readonly string[] = [],
): SQL {
  // ★ A held store's pictures are left where they are until the hold is
  //   released (design 14.1 point 3, decision D10): the clause sits after the
  //   record arm.
  const setAside =
    skip.length > 0
      ? sql`and not (m.id = any(${sql.param([...skip])}::uuid[]))`
      : sql``;
  return sql`
    select m.id, m.store_id, m.url, m.path, m.filename, m.content_type, m.size_bytes,
           coalesce(l.attempts, 0)::int as attempts,
           (l.media_asset_id is not null) as recorded
      from public.media_assets m
      left join public.mink_attachment_legacy_log l on l.media_asset_id = m.id
     where m.source = 'mink_attachment'
       and m.created_at < ${floorIso}::timestamptz
       and (l.media_asset_id is null
            or (l.outcome = 'failing'
                and l.attempts < ${sql.raw(String(MINK_LEGACY_GIVE_UP_AFTER + 1))}
                and l.last_attempt_at < now() - make_interval(hours => ${sql.raw(String(MINK_LEGACY_RETRY_AFTER_HOURS))})))
       and not exists (select 1 from public.store_legal_holds h
                        where h.store_id = m.store_id and h.released_at is null)
       ${setAside}
     order by m.created_at, m.id
     limit ${limit}
  `;
}

/**
 * The record of one picture, by upsert: a failure counts an attempt and
 * stays `failing`; a decision sets `decided_at` and is final. The update arm
 * runs only on a failing row, so a decided row is never reopened (probe v2
 * step 3). A decision is written IN THE SAME TRANSACTION as the media change
 * it records, and only when that change touched a row, so a recorded outcome
 * always means the row was relabelled or deleted.
 *
 * `countsAttempt: false` (a failing record only) is a wait that is not a
 * failure: a move that has started, or a chat with a reply running. It sets
 * the 20-hour backoff and the reason without counting toward give-up.
 */
export function legacyLogSql(input: {
  mediaAssetId: string;
  storeId: string;
  publicPath: string;
  outcome: MinkLegacyDecision["outcome"] | "failing";
  reason: MinkLegacyDecision["reason"] | MinkLegacyFailingReason;
  countsAttempt?: boolean;
}): SQL {
  const decidedAt = input.outcome === "failing" ? sql`null` : sql`now()`;
  const step = sql.raw(
    input.outcome === "failing" && input.countsAttempt === false ? "0" : "1",
  );
  return sql`
    insert into public.mink_attachment_legacy_log as l
      (media_asset_id, store_id, public_path, outcome, reason, attempts, last_attempt_at, decided_at)
    values (${input.mediaAssetId}, ${input.storeId}, ${input.publicPath}, ${input.outcome}, ${input.reason}, ${step}, now(), ${decidedAt})
    on conflict (media_asset_id) do update
       set outcome = excluded.outcome, reason = excluded.reason,
           attempts = l.attempts + ${step}, last_attempt_at = now(), decided_at = excluded.decided_at
     where l.outcome = 'failing'
    returning l.attempts, l.outcome
  `;
}

/** KEEP: the picture becomes an ordinary Media Library upload. */
export function legacyKeepSql(mediaAssetId: string): SQL {
  return sql`
    update public.media_assets
       set source = 'upload'
     where id = ${mediaAssetId} and source = 'mink_attachment'
    returning id
  `;
}

/** The row goes (the object is already gone, or was deleted first). */
export function legacyRemoveSql(mediaAssetId: string): SQL {
  return sql`
    delete from public.media_assets
     where id = ${mediaAssetId} and source = 'mink_attachment'
    returning id
  `;
}

/**
 * What the product and storefront usage reads do not cover (probe v2 step
 * 6): blog covers and bodies, campaign bodies, the store's settings (logo,
 * brand), a mega-menu image in the menus, the invoice logo, product
 * descriptions (HTML a merchant may have pasted a Library address into) and
 * the store's notification email templates. ★ Searched by the object PATH,
 * never the full URL: an address written with another host form or a query
 * string still contains the path, so the search fails toward keeping. The
 * path is the store's own (recordablePath) and never empty.
 */
export function legacyStoreUsageSql(storeId: string, path: string): SQL {
  return sql`
    select (exists (select 1 from public.blogs b where b.store_id = ${storeId}
                     and strpos(coalesce(b.cover_image_url, '') || ' ' || coalesce(b.content, ''), ${path}) > 0)
         or exists (select 1 from public.email_campaigns e where e.store_id = ${storeId} and strpos(e.body, ${path}) > 0)
         or exists (select 1 from public.stores st where st.id = ${storeId} and strpos(st.settings::text, ${path}) > 0)
         or exists (select 1 from public.store_menus sm where sm.store_id = ${storeId}
                     and strpos(sm.header::text || ' ' || sm.footer_groups::text || ' ' || sm.footer_legal::text, ${path}) > 0)
         or exists (select 1 from public.store_billing_settings bs where bs.store_id = ${storeId} and strpos(coalesce(bs.logo_url, ''), ${path}) > 0)
         or exists (select 1 from public.products p where p.store_id = ${storeId} and strpos(coalesce(p.description, ''), ${path}) > 0)
         or exists (select 1 from public.notification_settings ns where ns.store_id = ${storeId} and strpos(ns.templates::text, ${path}) > 0)) as used
  `;
}

/**
 * A proposal that can still become a store change (probe v2 step 5): a
 * draft naming the picture, in a chat that is active and within its 90 days,
 * with no approval that was decided or has expired. Approving it later must
 * still find the picture at its public address, so the picture is kept.
 * Searched by the object path, as the store usage read is.
 */
export function legacyLiveProposalSql(storeId: string, path: string): SQL {
  return sql`
    select exists (
      select 1 from public.mink_drafts d
        join public.mink_runs r on r.id = d.run_id and r.store_id = d.store_id
        join public.mink_conversations c on c.id = r.conversation_id and c.store_id = r.store_id
       where d.store_id = ${storeId} and c.status = 'active' and c.expires_at > now()
         and strpos(d.content_json::text, ${path}) > 0
         and not exists (select 1 from public.mink_action_approvals a
                          where a.draft_id = d.id and a.store_id = d.store_id
                            and (a.status <> 'pending' or a.expires_at <= now()))) as live_proposal
  `;
}

/**
 * Whether chat `c` has a reply running (the retention sweep's own test,
 * lib/mink/conversation-retention.ts). A run a dead server left running is
 * closed within 15 minutes by closeStaleMinkRuns, so it holds a picture back
 * a night at most.
 */
const REPLY_RUNNING = sql`exists (
      select 1 from public.mink_runs r
       where r.store_id = c.store_id and r.conversation_id = c.id
         and r.status = 'running')`;

/** The chats whose messages carry the picture's address, whether each is live, and whether a reply is running in it. */
export function legacyChatsSql(storeId: string, url: string): SQL {
  return sql`
    select distinct m.conversation_id, c.admin_id,
           (c.status = 'active' and c.expires_at > now()) as live,
           ${REPLY_RUNNING} as running
      from public.mink_messages m
      join public.mink_conversations c on c.id = m.conversation_id and c.store_id = m.store_id
     where m.store_id = ${storeId} and strpos(m.content_json ->> 'text', ${url}) > 0
  `;
}

/** The key startMinkRun, the merchant's delete and the sweep take (design 2.5). */
export function legacyChatLockSql(conversationId: string): SQL {
  return sql`select pg_try_advisory_xact_lock(hashtextextended(${`mink-conversation:${conversationId}`}, 0)) as locked`;
}

/** The chat re-read under its lock: its admin, only while it is live, and whether a reply is running in it. */
export function legacyChatLiveSql(
  storeId: string,
  conversationId: string,
): SQL {
  return sql`
    select c.admin_id, ${REPLY_RUNNING} as running
      from public.mink_conversations c
     where c.id = ${conversationId} and c.store_id = ${storeId}
       and c.status = 'active' and c.expires_at > now()
  `;
}

/** The private row of a moved picture: the attachment id IS the media id. */
export function legacyLinkSql(input: {
  mediaAssetId: string;
  storeId: string;
  adminId: string;
  conversationId: string;
  privatePath: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): SQL {
  return sql`
    insert into public.mink_attachments
      (id, store_id, admin_id, conversation_id, linked_at, path, filename, content_type, size_bytes)
    values (${input.mediaAssetId}, ${input.storeId}, ${input.adminId}, ${input.conversationId}, now(),
            ${input.privatePath}, left(${input.filename}, ${sql.raw(String(MINK_ATTACHMENT_FILENAME_MAX))}),
            ${input.contentType}, ${input.sizeBytes})
    on conflict (id) do nothing
  `;
}

/** The chat's messages, rewritten to the new address (probe step 11). */
export function legacyRewriteMessagesSql(input: {
  storeId: string;
  conversationId: string;
  url: string;
  newUrl: string;
}): SQL {
  return sql`
    update public.mink_messages
       set content_json = jsonb_set(content_json, '{text}',
                                    to_jsonb(replace(content_json ->> 'text', ${input.url}, ${input.newUrl})))
     where store_id = ${input.storeId} and conversation_id = ${input.conversationId}
       and strpos(content_json ->> 'text', ${input.url}) > 0
  `;
}

/** The same replace on the chat's summary. */
export function legacyRewriteSummarySql(input: {
  storeId: string;
  conversationId: string;
  url: string;
  newUrl: string;
}): SQL {
  return sql`
    update public.mink_conversations
       set summary_json = replace(summary_json::text, ${input.url}, ${input.newUrl})::jsonb
     where id = ${input.conversationId} and store_id = ${input.storeId}
       and summary_json is not null and strpos(summary_json::text, ${input.url}) > 0
  `;
}

/** Whether a private row already holds this id (an earlier move's). */
export function legacyAttachmentRowSql(
  storeId: string,
  mediaAssetId: string,
): SQL {
  return sql`
    select a.id from public.mink_attachments a
     where a.id = ${mediaAssetId} and a.store_id = ${storeId}
  `;
}

/**
 * The owner's progress signal (P5): what is left, and how many of those the
 * job has given up on. The job is done when `left` equals `givenUp + held`.
 */
export function legacyProgressSql(): SQL {
  // ★ `held` counts, over the same rows, the pictures of a store under an
  //   active legal hold (design 14.1 point 3). A picture given up on before
  //   its store was held is counted in both `given_up` and `held`.
  return sql`
    select count(*)::int as left,
           count(*) filter (where l.outcome = 'failing'
                              and l.attempts > ${sql.raw(String(MINK_LEGACY_GIVE_UP_AFTER))})::int as given_up,
           count(*) filter (where exists (select 1 from public.store_legal_holds h
                                           where h.store_id = m.store_id and h.released_at is null))::int as held
      from public.media_assets m
      left join public.mink_attachment_legacy_log l on l.media_asset_id = m.id
     where m.source = 'mink_attachment'
  `;
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

interface ObjectFacts {
  size: number;
  md5: string | null;
}

interface ChatRow {
  conversation_id: string;
  admin_id: string;
  live: boolean;
  running: boolean;
}

/** What one run carries from picture to picture and batch to batch. */
interface LegacyRun {
  /** Pictures not to take again in this run (MinkLegacyBatch.skip). */
  skip: Set<string>;
}

/** The log's path CHECK, decided before anything is done to the picture. */
function recordablePath(storeId: string, path: string): boolean {
  return (
    isStoreOwnedObjectPath(path, storeId) &&
    path.length <= LOG_PATH_MAX &&
    !path.includes("..")
  );
}

/** Content-free: ids, the attempt count and codes. */
function facts(picture: MinkLegacyCandidate) {
  return {
    storeId: picture.store_id,
    mediaAssetId: picture.id,
    attempts: picture.attempts,
  };
}

/**
 * A failing record in its own scope. A record that cannot be written is
 * logged and the picture is set aside for the rest of the run: without a
 * record it is still a candidate, and every later batch of the same run would
 * take it again (it is tried again the next night).
 */
async function writeFailing(
  picture: MinkLegacyCandidate,
  reason: MinkLegacyFailingReason,
  run: LegacyRun,
  countsAttempt: boolean,
): Promise<void> {
  try {
    await withService((db) =>
      db.execute(
        legacyLogSql({
          mediaAssetId: picture.id,
          storeId: picture.store_id,
          publicPath: picture.path,
          outcome: "failing",
          reason,
          countsAttempt,
        }),
      ),
    );
  } catch (recordError) {
    run.skip.add(picture.id);
    logError(
      "mink.attachments: legacy failure not recorded",
      loggableError(recordError),
      { ...facts(picture), reason },
    );
  }
}

/**
 * Record a failure (one scope, its own transaction) and count the picture as
 * failed. The recordable-path rule above keeps the log's CHECKs out of its
 * way; a record that still cannot be written sets the picture aside for the
 * run.
 */
async function fail(
  picture: MinkLegacyCandidate,
  reason: MinkLegacyFailingReason,
  run: LegacyRun,
  error?: unknown,
): Promise<MinkLegacyHandled> {
  if (error === undefined) {
    logWarn("mink.attachments: legacy picture waits", {
      ...facts(picture),
      reason,
    });
  } else {
    logError("mink.attachments: legacy picture failed", loggableError(error), {
      ...facts(picture),
      reason,
    });
  }
  await writeFailing(picture, reason, run, true);
  return "failed";
}

/**
 * A chat with a reply still running: the picture waits a night without
 * counting toward give-up (the 20-hour backoff, reason `chat_busy`).
 */
async function waitForReply(
  picture: MinkLegacyCandidate,
  run: LegacyRun,
): Promise<MinkLegacyHandled> {
  logWarn("mink.attachments: legacy picture waits", {
    ...facts(picture),
    reason: "chat_busy",
    replyRunning: true,
  });
  await writeFailing(picture, "chat_busy", run, false);
  return "failed";
}

/**
 * One transaction: the media change and the decision that records it. The
 * decision is written only when the change touched a row; a row another run
 * or a delete took first records nothing (the picture is no longer a
 * candidate) and is set aside for the run. A throw rolls both back and is
 * recorded as failing with the step's reason.
 */
async function decide(
  picture: MinkLegacyCandidate,
  decision: MinkLegacyDecision,
  change: SQL,
  onFailure: MinkLegacyFailingReason,
  run: LegacyRun,
): Promise<MinkLegacyHandled> {
  let changed: boolean;
  try {
    changed = await withService(async (db) => {
      const result = await db.execute(change);
      if (result.rows.length === 0) return false;
      await db.execute(
        legacyLogSql({
          mediaAssetId: picture.id,
          storeId: picture.store_id,
          publicPath: picture.path,
          ...decision,
        }),
      );
      return true;
    });
  } catch (error) {
    return fail(picture, onFailure, run, error);
  }
  if (!changed) {
    run.skip.add(picture.id);
    logWarn("mink.attachments: legacy picture changed underneath", {
      ...facts(picture),
      outcome: decision.outcome,
    });
    return "failed";
  }
  return decision.outcome;
}

/** Whether a private row holds the picture's id (an earlier move's link). Throws when it cannot tell. */
async function privateRowHolds(picture: MinkLegacyCandidate): Promise<boolean> {
  return withService(async (db) => {
    const result = await db.execute(
      legacyAttachmentRowSql(picture.store_id, picture.id),
    );
    return result.rows.length > 0;
  });
}

/** Best effort: the delete itself (a missing object counts as gone). */
async function discardPrivate(
  picture: MinkLegacyCandidate,
  privatePath: string,
): Promise<void> {
  const failed = await gcsDeletePaths([privatePath], "private");
  if (failed.length > 0) {
    logWarn(
      "mink.attachments: legacy private copy left behind",
      facts(picture),
    );
  }
}

/**
 * A private copy that must not outlive a move that did not land, deleted
 * only when no private row holds the id: an overlapping run may have linked
 * this very path, and deleting it would leave that row and its chat pointing
 * at nothing. Unknown means keep (the next night's leftover check deletes it
 * once it can tell).
 */
async function discardUnlinkedCopy(
  picture: MinkLegacyCandidate,
  privatePath: string,
): Promise<void> {
  let held: boolean;
  try {
    held = await privateRowHolds(picture);
  } catch (error) {
    logError(
      "mink.attachments: legacy private copy kept, row check failed",
      loggableError(error),
      facts(picture),
    );
    return;
  }
  if (!held) await discardPrivate(picture, privatePath);
}

/**
 * Before a final decision (kept or missing): a private copy an earlier
 * attempt left behind (its copy threw after landing, its discard failed, or
 * the run died between the copy and the link) is deleted when no private row
 * holds the id. Only for a picture with a record, since one never tried has
 * no copy, and only when the object is there. Best effort: a read that fails
 * keeps the object and the decision goes ahead.
 */
async function discardLeftover(picture: MinkLegacyCandidate): Promise<void> {
  if (!picture.recorded) return;
  const ext = MINK_ATTACHMENT_EXTENSIONS[picture.content_type];
  if (!ext) return;
  const privatePath = minkAttachmentPath(picture.store_id, picture.id, ext);
  let leftover: boolean;
  try {
    leftover =
      !(await privateRowHolds(picture)) &&
      (await gcsObjectMetadata("private", privatePath)) !== null;
  } catch (error) {
    logError(
      "mink.attachments: legacy leftover check failed",
      loggableError(error),
      facts(picture),
    );
    return;
  }
  if (leftover) await discardPrivate(picture, privatePath);
}

async function keep(
  picture: MinkLegacyCandidate,
  reason: MinkLegacyKeptReason,
  run: LegacyRun,
): Promise<MinkLegacyHandled> {
  await discardLeftover(picture);
  return decide(
    picture,
    { outcome: "kept", reason },
    legacyKeepSql(picture.id),
    "keep_failed",
    run,
  );
}

/**
 * The public object's delete, with the store-ownership guard of
 * lib/storage/cleanup.ts: an object that provably belongs to another store is
 * refused and counted, never deleted. True when the object is gone.
 */
async function deletePublic(picture: MinkLegacyCandidate): Promise<boolean> {
  if (isOtherStoreObjectPath(picture.path, picture.store_id)) {
    logError(
      "mink.attachments: legacy delete refused, another store's object",
      new Error("cross_store_object_skipped"),
      facts(picture),
    );
    return false;
  }
  const failed = await gcsDeletePaths([picture.path], "public");
  return failed.length === 0;
}

/**
 * Whether the store still shows the picture (the Media Library's own delete
 * guards, plus the surfaces they do not read), or a proposal that can still
 * be approved names it. Each read is its own scope; a read that throws is a
 * `read_failed` night for the picture, never "nothing uses it".
 */
async function usedByStore(
  picture: MinkLegacyCandidate,
): Promise<MinkLegacyKeptReason | null> {
  const { store_id: storeId, url, path } = picture;
  const products = await productImageUsage(storeId, [url]);
  if (products.size > 0) return "in_use";
  const storefront = await storefrontImageUsage(storeId, { url, path });
  if (
    storefront.redesignInProgress ||
    storefront.redesignCard ||
    storefront.pages.length > 0 ||
    storefront.categories.length > 0 ||
    storefront.headerFooter
  ) {
    return "in_use";
  }
  const [elsewhere, proposal] = await withService(async (db) => {
    const used = await db.execute(legacyStoreUsageSql(storeId, path));
    const live = await db.execute(legacyLiveProposalSql(storeId, path));
    return [
      (used.rows[0] as { used?: unknown } | undefined)?.used === true,
      (live.rows[0] as { live_proposal?: unknown } | undefined)
        ?.live_proposal === true,
    ];
  });
  if (elsewhere) return "in_use";
  if (proposal) return "live_proposal";
  return null;
}

type LinkOutcome = "linked" | "busy" | "not_live" | "running" | "proposal";

/**
 * MOVE: copy first, link second, so a merchant deleting the chat meanwhile
 * can never leave a private object with no row. The link runs under the
 * chat's own try-lock with the chat re-read as live, no reply running in it
 * and no proposal that can still be approved naming the picture; the public
 * object goes only once the move is committed.
 */
async function move(
  picture: MinkLegacyCandidate,
  chat: ChatRow,
  source: ObjectFacts,
  ext: string,
  run: LegacyRun,
): Promise<MinkLegacyHandled> {
  const { id, store_id: storeId, path, url } = picture;
  const privatePath = minkAttachmentPath(storeId, id, ext);

  // a. The record says a copy is starting (no attempt counted), so a run
  //    that dies before the outcome leaves a record the next night reads.
  try {
    await withService((db) =>
      db.execute(
        legacyLogSql({
          mediaAssetId: id,
          storeId,
          publicPath: path,
          outcome: "failing",
          reason: "copy_failed",
          countsAttempt: false,
        }),
      ),
    );
  } catch (error) {
    return fail(picture, "copy_failed", run, error);
  }
  const tried: MinkLegacyCandidate = { ...picture, recorded: true };

  // b. The copy, then its size and MD5 against the source's. A copy that
  //    threw may still have landed (an answer lost after the bytes were
  //    written), so it is discarded like a mismatch.
  let copy: ObjectFacts | null;
  try {
    await gcsCopyObject("public", path, "private", privatePath);
    copy = await gcsObjectMetadata("private", privatePath);
  } catch (error) {
    await discardUnlinkedCopy(tried, privatePath);
    return fail(tried, "copy_failed", run, error);
  }
  if (
    !copy ||
    copy.size !== source.size ||
    copy.md5 === null ||
    copy.md5 !== source.md5
  ) {
    await discardUnlinkedCopy(tried, privatePath);
    return fail(tried, "copy_mismatch", run, new Error("copy_mismatch"));
  }

  // c. The link under the chat's lock, and the rewrite, in one transaction.
  const newUrl = minkAttachmentUrl(id);
  let linked: LinkOutcome;
  try {
    linked = await withService(async (db): Promise<LinkOutcome> => {
      const lock = await db.execute(legacyChatLockSql(chat.conversation_id));
      if ((lock.rows[0] as { locked?: unknown } | undefined)?.locked !== true) {
        return "busy";
      }
      const live = await db.execute(
        legacyChatLiveSql(storeId, chat.conversation_id),
      );
      const row = live.rows[0] as
        | { admin_id?: unknown; running?: unknown }
        | undefined;
      if (!row) return "not_live";
      if (row.running === true) return "running";
      // A reply that finished since the usage read may have proposed the
      // picture at its public address; approving that must still find it.
      const proposal = await db.execute(legacyLiveProposalSql(storeId, path));
      if (
        (proposal.rows[0] as { live_proposal?: unknown } | undefined)
          ?.live_proposal === true
      ) {
        return "proposal";
      }
      await db.execute(
        legacyLinkSql({
          mediaAssetId: id,
          storeId,
          adminId: String(row.admin_id),
          conversationId: chat.conversation_id,
          privatePath,
          filename: picture.filename,
          contentType: picture.content_type,
          sizeBytes: source.size,
        }),
      );
      await db.execute(
        legacyRewriteMessagesSql({
          storeId,
          conversationId: chat.conversation_id,
          url,
          newUrl,
        }),
      );
      await db.execute(
        legacyRewriteSummarySql({
          storeId,
          conversationId: chat.conversation_id,
          url,
          newUrl,
        }),
      );
      return "linked";
    });
  } catch (error) {
    await discardUnlinkedCopy(tried, privatePath);
    return fail(tried, "chat_busy", run, error);
  }
  if (linked !== "linked") {
    await discardUnlinkedCopy(tried, privatePath);
    // A proposal that can still be approved keeps the picture; a reply
    // running waits a night uncounted; the lock held (a run starting, a
    // delete, the sweep) or a chat no longer live waits counted, and the
    // next night finds it free, or gone and deletes the picture.
    if (linked === "proposal") return keep(tried, "live_proposal", run);
    if (linked === "running") return waitForReply(tried, run);
    return fail(tried, "chat_busy", run);
  }

  // d. The public object. A failure here leaves the move committed: tomorrow
  //    no chat names the public address, so the delete branch takes it and
  //    keeps the private copy, whose row exists.
  if (!(await deletePublic(picture))) {
    return fail(tried, "delete_failed", run);
  }

  // e. The row and the record.
  return decide(
    tried,
    { outcome: "moved", reason: "moved_with_chat" },
    legacyRemoveSql(id),
    "delete_failed",
    run,
  );
}

/**
 * DELETE: no live chat names the picture. The public object goes (guarded),
 * then a private copy an interrupted move left behind, only when no private
 * row holds the id, then the row with its record.
 */
async function remove(
  picture: MinkLegacyCandidate,
  run: LegacyRun,
): Promise<MinkLegacyHandled> {
  const { id, store_id: storeId } = picture;
  if (!(await deletePublic(picture))) {
    return fail(picture, "delete_failed", run);
  }

  const ext = MINK_ATTACHMENT_EXTENSIONS[picture.content_type];
  if (ext) {
    let hasRow: boolean;
    try {
      hasRow = await privateRowHolds(picture);
    } catch (error) {
      return fail(picture, "read_failed", run, error);
    }
    if (!hasRow) {
      await discardPrivate(picture, minkAttachmentPath(storeId, id, ext));
    }
  }

  return decide(
    picture,
    { outcome: "deleted", reason: "no_live_use" },
    legacyRemoveSql(id),
    "delete_failed",
    run,
  );
}

/** The per-picture steps 0 to 3, each failure caught and recorded. */
async function handle(
  picture: MinkLegacyCandidate,
  run: LegacyRun,
): Promise<MinkLegacyHandled> {
  // ★ A path the log's CHECK refuses (outside its own store's prefix, over
  //   long, or with `..`) can be neither recorded nor safely deleted. It is
  //   kept as an ordinary upload with no record, the one outcome that moves
  //   nothing, and logged for the owner (ids only). Relabelled directly, not
  //   through `keep`, whose record would be refused and roll the keep back.
  //   With no record, a relabel that fails or finds the row changed sets the
  //   picture aside for the run.
  if (!recordablePath(picture.store_id, picture.path)) {
    logError(
      "mink.attachments: legacy picture outside its store, kept as an upload without a record",
      new Error("unrecordable_path"),
      facts(picture),
    );
    let relabelled: boolean;
    try {
      relabelled = await withService(
        async (db) =>
          (await db.execute(legacyKeepSql(picture.id))).rows.length > 0,
      );
    } catch (error) {
      run.skip.add(picture.id);
      logError(
        "mink.attachments: legacy picture failed",
        loggableError(error),
        { ...facts(picture), reason: "keep_failed" },
      );
      return "failed";
    }
    if (!relabelled) {
      run.skip.add(picture.id);
      logWarn("mink.attachments: legacy picture changed underneath", {
        ...facts(picture),
        outcome: "kept",
      });
      return "failed";
    }
    return "kept";
  }

  // 0. Given up.
  if (picture.attempts >= MINK_LEGACY_GIVE_UP_AFTER) {
    return keep(picture, "gave_up", run);
  }

  // 1. The source object.
  let source: ObjectFacts | null;
  try {
    source = await gcsObjectMetadata("public", picture.path);
  } catch (error) {
    return fail(picture, "read_failed", run, error);
  }
  if (!source) {
    await discardLeftover(picture);
    return decide(
      picture,
      { outcome: "missing", reason: "object_missing" },
      legacyRemoveSql(picture.id),
      "delete_failed",
      run,
    );
  }

  // 2. Still used by the store, or by a proposal that can still be approved.
  let usage: MinkLegacyKeptReason | null;
  try {
    usage = await usedByStore(picture);
  } catch (error) {
    return fail(picture, "read_failed", run, error);
  }
  if (usage) return keep(picture, usage, run);

  // 3. Referenced by chats.
  let chats: ChatRow[];
  try {
    chats = await withService(async (db) => {
      const result = await db.execute(
        legacyChatsSql(picture.store_id, picture.url),
      );
      return result.rows as unknown as ChatRow[];
    });
  } catch (error) {
    return fail(picture, "read_failed", run, error);
  }
  const live = chats.filter((chat) => chat.live === true);
  if (live.length > 1) return keep(picture, "several_chats", run);
  if (live.length === 1) {
    const ext = MINK_ATTACHMENT_EXTENSIONS[picture.content_type];
    if (!ext || source.size < 1 || source.size > MAX_IMAGE_BYTES) {
      return keep(picture, "not_movable", run);
    }
    // A reply running in the chat carries the public address in its
    // history: the picture waits a night, with nothing copied.
    if (live[0].running === true) return waitForReply(picture, run);
    return move(picture, live[0], source, ext, run);
  }
  return remove(picture, run);
}

/**
 * The nightly retention entry (`RETENTION_POLICIES`, `mink_attachments_legacy`,
 * last): `floorIso` is now minus 2 days, as `sweepPolicy` passes it, and
 * `batch` is the sweep's run context. Returns the number of pictures HANDLED
 * (kept, moved, deleted, missing or failed), so a batch with failures is
 * still a full batch and the sweep fetches the next one, which no longer
 * contains them; `stop` reads `drained` only when no candidate is left.
 * ★ No picture is started within MINK_LEGACY_PICTURE_RESERVE_MS of the run's
 * deadline: the batch stops, sets `batch.outOfTime`, and the sweep reports
 * "budget" instead of asking for another batch. Guarded: it does nothing,
 * and says so once, off the two real databases or without a private bucket.
 */
export async function moveLegacyMinkAttachments(
  floorIso: string,
  limit: number,
  batch: MinkLegacyBatch = {},
): Promise<number> {
  const database = attachmentDatabase();
  if (!legacyMoveAllowed(database)) {
    logWarn("mink.attachments: legacy move skipped", {
      database,
      reason: "database",
    });
    return 0;
  }
  if (!gcsPrivateConfigured) {
    logWarn("mink.attachments: legacy move skipped", {
      database,
      reason: "no_private_bucket",
    });
    return 0;
  }

  const clock = batch.clock ?? Date.now;
  const outOfTime = () =>
    batch.deadline !== undefined &&
    clock() > batch.deadline - MINK_LEGACY_PICTURE_RESERVE_MS;
  if (outOfTime()) {
    batch.outOfTime = true;
    return 0;
  }
  const run: LegacyRun = { skip: batch.skip ?? new Set<string>() };

  // ★ Scopes one after the other, never one inside another: the candidates,
  //   then each picture's own reads and transactions, then the progress.
  const candidates = await withService(async (db) => {
    const result = await db.execute(
      legacyCandidatesSql(floorIso, limit, [...run.skip]),
    );
    return result.rows as unknown as MinkLegacyCandidate[];
  });

  const counts = { kept: 0, moved: 0, deleted: 0, missing: 0, failed: 0 };
  for (const candidate of candidates) {
    if (outOfTime()) {
      batch.outOfTime = true;
      break;
    }
    counts[await handle(candidate, run)] += 1;
  }

  const progress = await withService(async (db) => {
    const result = await db.execute(legacyProgressSql());
    const row = result.rows[0] as
      | { left?: unknown; given_up?: unknown; held?: unknown }
      | undefined;
    return {
      left: Number(row?.left ?? 0),
      givenUp: Number(row?.given_up ?? 0),
      held: Number(row?.held ?? 0),
    };
  });

  // One content-free line per batch (design 5.10 step 4).
  logInfo("mink.attachments: legacy batch", {
    ...counts,
    left: progress.left,
    givenUp: progress.givenUp,
    held: progress.held,
  });
  return (
    counts.kept + counts.moved + counts.deleted + counts.missing + counts.failed
  );
}
