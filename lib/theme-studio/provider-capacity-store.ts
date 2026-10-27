import "server-only";
import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import {
  coordinatedProviderCapacity,
  IMAGE_START_PACING,
  isImageProviderModel,
  providerCapacityKey,
  PROVIDER_LEASE_MS,
  type CapacityStore,
  type PaceChange,
  type ProviderPacing,
} from "./provider-capacity";
import { SHARED_RATE_LIMIT_PAUSE_MAX_MS } from "./rate-limit-backoff";

/** The most permits a key ever holds (0149's CHECK capacity BETWEEN 1 AND 3). */
const MAX_PERMITS = 3;

/** The least a gap must move for its log line. A refusal at the ceiling
 *  (45 to 45 s), a success at the floor and the last step onto a bound (10.5
 *  to 10 s) move it less and say nothing new; the next line's `refusals`
 *  still counts the refusals among them. */
export const PACE_LOG_MIN_CHANGE_MS = 1_000;

// ★ PACED KEYS KEEP ONE INVARIANT: next_start_at is the latest admission
//   plus gap_ms (migration 0236). Admission stamps it; a gap change moves it
//   by the change, so "the previous start plus the gap" always holds with
//   the CURRENT gap. Nothing writes it further ahead than one gap (45 s at
//   most, IMAGE_START_PACING's ceiling), so a stuck pace cannot hold the
//   image line longer than that. Unpaced keys never name either column.

/** gap_ms after one outcome, in SQL, from the row's gap BEFORE the update
 *  (every right-hand side of one UPDATE reads the old row). */
function shrunkGap(pacing: ProviderPacing) {
  // The same cutoff is evaluated twice in the UPDATE. A stable statement
  // clock keeps next_start_at and gap_ms consistent at hold expiry.
  const floor =
    pacing.recoveryFloorMs && pacing.recoveryHoldMs
      ? sql`CASE WHEN epoch > 0 AND pause_until + ${pacing.recoveryHoldMs}::int * interval '1 millisecond' > statement_timestamp() THEN ${pacing.recoveryFloorMs}::int ELSE ${pacing.minGapMs}::int END`
      : sql`${pacing.minGapMs}::int`;
  return sql`least(${pacing.maxGapMs}::int, greatest(${floor}, round(gap_ms*${pacing.successFactor}::numeric)::int))`;
}
function grownGap(pacing: ProviderPacing) {
  return sql`least(${pacing.maxGapMs}::int, greatest(${pacing.recoveryFloorMs ?? pacing.minGapMs}::int, round(gap_ms*${pacing.rateLimitFactor}::numeric)::int))`;
}

// ★ THE GAP BEFORE AND AFTER COME BACK FROM THE STATEMENT THAT MOVES IT, so
//   logging the pace costs no read of its own: the CTE reads the row as it
//   was (this transaction holds its lock since theme_studio_capacity_lock,
//   so nobody else changed it), RETURNING reads it as written.
type PaceRow = { gap_before: unknown; gap_after: unknown; epoch: unknown };
function gapBefore(key: string) {
  return sql`with before as (select gap_ms from public.theme_studio_provider_capacity where scope_key=${key}) `;
}
const RETURNING_GAPS = sql` returning (select gap_ms from before) as gap_before, gap_ms as gap_after, epoch`;
function paceChange(
  outcome: PaceChange["outcome"],
  row: PaceRow | undefined,
): PaceChange | null {
  if (
    typeof row?.gap_before !== "number" ||
    typeof row.gap_after !== "number" ||
    typeof row.epoch !== "number"
  )
    return null;
  return {
    outcome,
    gapBeforeMs: row.gap_before,
    gapAfterMs: row.gap_after,
    epoch: row.epoch,
  };
}

/** Each statement runs in a short service transaction. The capacity row lock
 * serializes admission across Cloud Run instances, not the provider call. */
export const postgresCapacityStore: CapacityStore = {
  async claim(key, id, pacing) {
    return withService(async (db) => {
      await db.execute(sql`set local statement_timeout = '5s'`);
      await db.execute(sql`select public.theme_studio_capacity_lock(${key})`);
      // now() is fixed at transaction start. A claimant that waited for a newly
      // created row can otherwise see its initial pause_until as in the future.
      // Admission and lease expiry must use the clock after the lock wait.
      await db.execute(
        sql`delete from public.theme_studio_provider_leases where scope_key=${key} and expires_at<=clock_timestamp()`,
      );
      // ★ A paced key also waits for its next start, and an admission
      //   stamps the one after it in the same statement.
      const result = await db.execute<{ id: string; epoch: number }>(sql`
        with admitted as (
          insert into public.theme_studio_provider_leases(scope_key,id,epoch,expires_at)
          select c.scope_key, ${id}::uuid, c.epoch, clock_timestamp()+${PROVIDER_LEASE_MS}*interval '1 millisecond'
          from public.theme_studio_provider_capacity c
          where c.scope_key=${key} and c.pause_until<=clock_timestamp()
            ${pacing ? sql`and c.next_start_at<=clock_timestamp()` : sql``}
            and (select count(*) from public.theme_studio_provider_leases l where l.scope_key=c.scope_key)<c.capacity
          returning id, epoch)${
            pacing
              ? sql`,
        spaced as (
          update public.theme_studio_provider_capacity
          set next_start_at=clock_timestamp()+gap_ms*interval '1 millisecond', updated_at=now()
          where scope_key=${key} and exists (select 1 from admitted)
          returning 1)`
              : sql``
          }
        select id, epoch from admitted`);
      if (result.rows[0]) return result.rows[0];
      const waiting = await db.execute<{ delay: number }>(sql`
        select ceil(extract(epoch from (greatest(pause_until${pacing ? sql`,next_start_at` : sql``})-clock_timestamp()))*1000)::int as delay
        from public.theme_studio_provider_capacity where scope_key=${key}`);
      const delay = waiting.rows[0]?.delay ?? 0;
      return delay > 0 ? { retryAfterMs: delay } : null;
    });
  },
  async renew(key, lease) {
    return withService(async (db) => {
      await db.execute(sql`set local statement_timeout = '5s'`);
      const result =
        await db.execute(sql`update public.theme_studio_provider_leases
        set expires_at=clock_timestamp()+${PROVIDER_LEASE_MS}*interval '1 millisecond'
        where scope_key=${key} and id=${lease.id}::uuid and expires_at>clock_timestamp() returning id`);
      return result.rows.length === 1;
    });
  },
  async release(key, lease, succeeded, pacing) {
    return withService(async (db) => {
      await db.execute(sql`set local statement_timeout = '5s'`);
      await db.execute(sql`select public.theme_studio_capacity_lock(${key})`);
      const removed =
        await db.execute(sql`delete from public.theme_studio_provider_leases
        where scope_key=${key} and id=${lease.id}::uuid and expires_at>clock_timestamp() returning id`);
      // ★★ ONE PERMIT BACK PER SUCCESS (owner's decision, 2026-10-23); it
      //   took three, so after one refusal the line ran at one request for
      //   minutes. ★ Still fenced on the epoch: a response already in flight
      //   when the refusal came says nothing about the provider since, so it
      //   neither restores a permit nor narrows the gap. `successes` is kept
      //   at 0 for the revision this replaces, which still counts to three.
      if (!succeeded || !removed.rows.length) return null;
      const moved = await db.execute<PaceRow>(sql`
        ${pacing ? gapBefore(key) : sql``}update public.theme_studio_provider_capacity
        set capacity=least(${MAX_PERMITS}::int,capacity+1), successes=0${
          pacing
            ? sql`,
            next_start_at=next_start_at-(gap_ms-${shrunkGap(pacing)})*interval '1 millisecond',
            gap_ms=${shrunkGap(pacing)}`
            : sql``
        }, updated_at=now()
        where scope_key=${key} and epoch=${lease.epoch} and pause_until<=clock_timestamp()${
          pacing ? RETURNING_GAPS : sql``
        }`);
      // A stale (fenced) success matches no row, so it reports nothing.
      return pacing ? paceChange("success", moved.rows[0]) : null;
    });
  },
  async pause(key, delayMs, pacing) {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 120_000)
      throw new Error("Invalid provider cooldown");
    // ★★ OTHERS WAIT AT MOST THE SHARED CEILING (15 s), and a longer pause
    //   already on the row (the revision this replaces paused for its
    //   caller's whole 7.5 to 120 s backoff) is cut back to it. A paced key
    //   is held apart by its widened gap instead, which is what the image
    //   models' refusals respond to.
    const pauseMs = Math.min(delayMs, SHARED_RATE_LIMIT_PAUSE_MAX_MS);
    return withService(async (db) => {
      await db.execute(sql`set local statement_timeout = '5s'`);
      await db.execute(sql`select public.theme_studio_capacity_lock(${key})`);
      const moved = await db.execute<PaceRow>(sql`${
        pacing ? gapBefore(key) : sql``
      }update public.theme_studio_provider_capacity
        set capacity=1, successes=0, epoch=epoch+1,
            pause_until=least(
              greatest(pause_until,clock_timestamp()+${pauseMs}*interval '1 millisecond'),
              clock_timestamp()+${SHARED_RATE_LIMIT_PAUSE_MAX_MS}*interval '1 millisecond')${
                pacing
                  ? sql`,
            next_start_at=next_start_at+(${grownGap(pacing)}-gap_ms)*interval '1 millisecond',
            gap_ms=${grownGap(pacing)}`
                  : sql``
              }, updated_at=now()
        where scope_key=${key}${pacing ? RETURNING_GAPS : sql``}`);
      return pacing ? paceChange("rate_limited", moved.rows[0]) : null;
    });
  },
};

/**
 * One content-free line per move of an image key's gap: the model, where it
 * runs and the scope, never the project, the request or its caller.
 * ★ `refusals` is the key's epoch, so two lines' difference counts the 429s
 *   between them, the ones at the ceiling (which move nothing) included.
 */
function logPaceChange(
  change: PaceChange,
  model: string,
  location: string,
  scope: string | undefined,
) {
  if (Math.abs(change.gapAfterMs - change.gapBeforeMs) < PACE_LOG_MIN_CHANGE_MS)
    return;
  logInfo("theme_studio.provider_pace", {
    model,
    location,
    ...(scope ? { scope } : {}),
    outcome: change.outcome,
    gapBeforeMs: change.gapBeforeMs,
    gapAfterMs: change.gapAfterMs,
    refusals: change.epoch,
  });
}

/**
 * The shared capacity for one model at one location.
 * ★ Image models are start-paced (IMAGE_START_PACING), decided here from the
 *   model id so every caller that already builds its capacity this way (the
 *   Theme Studio worker, the revamp's photos and products) is paced with no
 *   change of its own; text models keep plain permits.
 * ★ `scope` gives one caller its own row on a model (providerCapacityKey).
 * ★ A paced key logs its gap as it moves (theme_studio.provider_pace), so the
 *   pace the bounds hold can be read off a live run.
 */
export function sharedProviderCapacity(
  project: string,
  location: string,
  model: string,
  options: { scope?: string } = {},
) {
  const pacing = isImageProviderModel(model) ? IMAGE_START_PACING : null;
  return coordinatedProviderCapacity(
    postgresCapacityStore,
    providerCapacityKey(project, location, model, options.scope),
    {
      pacing,
      onPaceChange: pacing
        ? (change) => logPaceChange(change, model, location, options.scope)
        : undefined,
      onCleanupError: (error) =>
        logError("theme studio provider permit cleanup failed", error),
      onRenewalError: (error) =>
        logError("theme studio provider permit renewal delayed", error),
    },
  );
}
