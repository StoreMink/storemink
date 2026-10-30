import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logInfo } from "@/lib/observability/logger";
import type { RetentionBatchContext } from "@/lib/retention/prune";
import { purgeDueArchives } from "./archive";
import { eraseResolvedComplaints } from "./complaints";
import { recordModerationEvent } from "./record";

/**
 * The takedown build's four entries in the daily retention sweep
 * (`lib/retention/prune.ts`, design 8.2, owner's decision D3). The policies
 * themselves (table, days, reason) live in `RETENTION_POLICIES`, beside every
 * other window; these are their deleters, each with the sweep's
 * `deleteBatch(floorIso, limit, batch)` shape:
 *
 * - `purgeTakedownArchives`: `purgeDueArchives` (archive.ts) at most 20 at a
 *   time, handed the sweep's own `RetentionBatchContext`, so an archive it
 *   sets aside stays aside for the rest of the run and a stop for the clock
 *   is reported as "budget". `keep_until` decides what is due, not the floor.
 * - `pruneModerationEvents`: the record's only delete,
 *   `moderation_prune_events(floor, limit)`, which keeps at least a year and
 *   never takes an event whose store is held or whose archive is kept.
 * - `eraseTakedownComplaints`: `eraseResolvedComplaints` (complaints.ts).
 * - `eraseLiftedBlocks`: a block lifted at least three years ago keeps what
 *   was blocked, when, why and by whom; its words go (item label and message
 *   "Erased", address, legal basis and lift note empty, the CHECK refuses
 *   anything else) and so do the words and senders of its conversation
 *   (each message's body "Erased", its author "erased"). Never while its
 *   store is held, while a hold names its complaint, or while its archive is
 *   held or still kept (not yet purged): a copy kept longer is kept because
 *   someone asked, and the conversation is part of what they asked for.
 *
 * ★ EACH BATCH IS ITS OWN TRANSACTION (CODEBASE.md §32): one `withService`
 * per call, never a loop inside one. The sweep calls again while batches come
 * back full.
 */

/** The archive purge's batch (design 8.2); `purgeDueArchives` caps at 50. */
export const ARCHIVE_PURGE_BATCH = 20;

/** How long an archived copy is kept at least (IT Rules 3(1)(g)). */
export const ARCHIVE_KEEP_DAYS = 180;

/** The takedown record, complaints and lifted blocks: 3 years (D3). */
export const MODERATION_RECORD_DAYS = 1095;

/** Most lifted blocks erased in one batch. */
export const BLOCK_ERASE_BATCH_MAX = 200;

/** The words an erased block and message keep (content_blocks_erased_check). */
export const ERASED_LABEL = "Erased";
export const ERASED_AUTHOR = "erased";

function toDate(value: Date | string): Date | null {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function oneYearBefore(date: Date): Date {
  const back = new Date(date.getTime());
  back.setUTCFullYear(back.getUTCFullYear() - 1);
  return back;
}

/**
 * The sweep's deleter for `content_block_archives`: one batch of due
 * archives, the sweep's context passed straight through (it is assignable
 * to `ArchivePurgeRun`). Answers how many archives it HANDLED, so a batch
 * with a skip still reads as full and the sweep asks again.
 */
export function purgeTakedownArchives(
  _floorIso: string,
  limit: number,
  batch: RetentionBatchContext,
): Promise<number> {
  return purgeDueArchives(Math.min(limit, ARCHIVE_PURGE_BATCH), batch);
}

/**
 * The sweep's deleter for `moderation_events`: the SECURITY DEFINER function
 * is the only delete the app has on the record (app_service holds no DELETE).
 * It raises for a floor less than a year old.
 */
export function pruneModerationEvents(
  floorIso: string,
  limit: number,
): Promise<number> {
  return withService(async (db) => {
    const result = await db.execute<{ deleted: number }>(
      sql`select public.moderation_prune_events(${floorIso}::timestamptz, ${limit}::integer) as deleted`,
    );
    return Number(result.rows[0]?.deleted ?? 0);
  });
}

/** The sweep's deleter for `grievance_complaints` (complaints.ts). */
export function eraseTakedownComplaints(
  floorIso: string,
  limit: number,
): Promise<number> {
  return eraseResolvedComplaints(floorIso, limit);
}

/**
 * Erase the words of blocks lifted before `floor` (design 3.9, 8.2): one
 * statement locks a batch (`skip locked`, oldest lift first), blanks each
 * block and its conversation, and records `block_erased` for each in the same
 * transaction. Answers how many blocks were erased; a held one is skipped, not
 * counted. Refuses a floor less than a year old, which can only be a mistake.
 */
export async function eraseLiftedBlocks(
  floor: Date | string,
  limit: number,
  options: { actor?: string; now?: Date } = {},
): Promise<number> {
  const floorDate = toDate(floor);
  if (!floorDate) {
    throw new RangeError("eraseLiftedBlocks: the floor is not a time.");
  }
  const now = options.now ?? new Date();
  if (floorDate.getTime() > oneYearBefore(now).getTime()) {
    throw new RangeError(
      "eraseLiftedBlocks: the floor must be at least a year ago.",
    );
  }
  const batch = Math.max(
    0,
    Math.min(BLOCK_ERASE_BATCH_MAX, Math.trunc(Number(limit) || 0)),
  );
  if (batch === 0) return 0;
  const actor = (options.actor ?? "system").trim() || "system";

  const erased = await withService(async (db) => {
    const result = await db.execute<{
      id: string;
      store_id: string | null;
      messages: number;
    }>(sql`
      with due as (
        select b.id
          from public.content_blocks b
         where b.erased_at is null
           and b.lifted_at is not null
           and b.lifted_at < ${floorDate.toISOString()}::timestamptz
           and not exists (
             select 1 from public.store_legal_holds h
              where h.released_at is null
                and (h.store_id = b.store_id
                     or (b.complaint_id is not null
                         and h.complaint_id = b.complaint_id)))
           and not exists (
             select 1 from public.content_block_archives a
              where a.block_id = b.id
                and (a.legal_hold or a.purged_at is null))
         order by b.lifted_at, b.id
         limit ${batch}
         for update of b skip locked
      ), erased as (
        update public.content_blocks c
           set item_label = ${ERASED_LABEL},
               item_url = '',
               legal_basis = '',
               lift_note = '',
               store_message = ${ERASED_LABEL},
               erased_at = now(),
               updated_at = now()
          from due
         where c.id = due.id
        returning c.id, c.store_id
      ), messages as (
        update public.content_block_messages m
           set body = ${ERASED_LABEL}, author = ${ERASED_AUTHOR}
          from erased
         where m.block_id = erased.id
        returning m.block_id
      )
      select e.id::text as id, e.store_id::text as store_id,
             (select count(*) from messages
               where messages.block_id = e.id)::int as messages
        from erased e
    `);
    for (const row of result.rows) {
      await recordModerationEvent(db, {
        actor,
        action: "block_erased",
        blockId: row.id,
        storeId: row.store_id,
        detail: { messages: Number(row.messages ?? 0) },
      });
    }
    return result.rows.length;
  });
  if (erased > 0) {
    logInfo("moderation.retention: blocks erased", { erased });
  }
  return erased;
}
