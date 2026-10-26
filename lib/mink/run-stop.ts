import "server-only";

import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { minkRuns, minkToolCalls } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import { MinkRunStoppedError } from "./errors";
import { failMinkRun } from "./persistence";
import type { MinkStopResult, MinkStoppedRunStatus } from "./run-stop-types";
import {
  createLiveStopRegistry,
  watchForStop,
  type StopWatch,
} from "./stop-watch";

// ---------------------------------------------------------------------------
// ★★ A STOP IS DECIDED ON THE RUN'S OWN ROW, NOT BY AN ABORTED FETCH
// (25 Oct 2026). Behind Google's load balancer an aborted browser fetch never
// reaches Cloud Run, so the stream route's request signal never fired in
// production: a reply the merchant stopped, or a voice barge-in dropped, kept
// going on the server, and one started a storefront redesign whose card never
// showed. Now the browser asks POST /api/mink/runs/[runId]/stop and lets go of
// the reply only when the answer is `stopped`.
//
// ★★ EXACTLY ONE OF {THE STOP, THE RUN'S FIRST SIDE EFFECT} WINS. The stop
// sets `stop_requested_at` only while `acted_at` is null; a tool that writes
// or charges first sets `acted_at` only while `stop_requested_at` is null.
// Both take this run's row lock, and Postgres re-reads the newest row version
// before a waiting statement decides (READ COMMITTED), so there is no window
// in which both succeed. Migration 0244's CHECK is the backstop.
//   - stop won: every later claim is refused, the run ends `cancelled` with
//     code `stopped`, no answer is stored and nothing is charged;
//   - the run acted first: the stop answers `acted` and the run finishes.
//
// ★ THE CLAIM IS ITS OWN SHORT TRANSACTION, so it never holds the run's row
// while a tool takes its draft, credit or revamp locks; a draft insert's
// foreign key takes KEY SHARE on the run row, which the claim's NO KEY UPDATE
// does not block.
// ---------------------------------------------------------------------------

/** What the stop route may answer: a stop result, or no such run here. */
export type MinkStopAnswer = MinkStopResult | { outcome: "not_found" };

const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * Ask a run to stop. ★ It wins only while the run is still running and has
 * not acted. Another admin's run, another store's run and a run that does not
 * exist all answer `not_found`, so the answer says nothing about runs that are
 * not the caller's. ★ Asking twice answers `stopped` twice, also after the run
 * has closed as cancelled.
 */
export async function requestMinkRunStop(input: {
  runId: string;
  storeId: string;
  adminId: string;
}): Promise<MinkStopAnswer> {
  return withService(async (db) => {
    const rows = await db
      .select({
        status: minkRuns.status,
        actedAt: minkRuns.actedAt,
        stopRequestedAt: minkRuns.stopRequestedAt,
      })
      .from(minkRuns)
      .where(
        and(
          eq(minkRuns.id, input.runId),
          eq(minkRuns.storeId, input.storeId),
          eq(minkRuns.requestedBy, input.adminId),
        ),
      )
      .for("update")
      .limit(1);
    const run = rows[0];
    if (!run) return { outcome: "not_found" };
    if (run.stopRequestedAt) return { outcome: "stopped" };
    if (run.status !== "running") {
      return FINISHED_STATUSES.has(run.status)
        ? {
            outcome: "finished",
            status: run.status as MinkStoppedRunStatus,
          }
        : { outcome: "finished" };
    }
    if (run.actedAt) return { outcome: "acted" };
    // ★ Every predicate again, though the row is locked: a future caller that
    //   drops the lock still cannot record a stop beside a claim.
    const stopped = await db
      .update(minkRuns)
      .set({ stopRequestedAt: sql`now()` })
      .where(unclaimedRunningRun(input.runId, input.storeId))
      .returning({ id: minkRuns.id });
    // Unreachable under the lock; "unknown" keeps the browser reading.
    return stopped[0] ? { outcome: "stopped" } : { outcome: "unknown" };
  });
}

/**
 * The run's first side effect. ★ Throws `MinkRunStoppedError` when a stop won
 * (or the run has already ended), and then the tool must not write. Repeating
 * it is harmless: the first claim's time is kept.
 */
export async function claimMinkRunAct(input: {
  runId: string;
  storeId: string;
}): Promise<void> {
  const claimed = await withService((db) =>
    db
      .update(minkRuns)
      .set({ actedAt: sql`coalesce(${minkRuns.actedAt}, now())` })
      .where(
        and(
          eq(minkRuns.id, input.runId),
          eq(minkRuns.storeId, input.storeId),
          eq(minkRuns.status, "running"),
          isNull(minkRuns.stopRequestedAt),
        ),
      )
      .returning({ id: minkRuns.id }),
  );
  if (!claimed[0]) throw new MinkRunStoppedError();
}

/** Whether a stop has been recorded for this run. One primary-key read. */
export async function isMinkRunStopRequested(input: {
  runId: string;
  storeId: string;
}): Promise<boolean> {
  const rows = await withService((db) =>
    db
      .select({ stopRequestedAt: minkRuns.stopRequestedAt })
      .from(minkRuns)
      .where(
        and(eq(minkRuns.id, input.runId), eq(minkRuns.storeId, input.storeId)),
      )
      .limit(1),
  );
  return Boolean(rows[0]?.stopRequestedAt);
}

function unclaimedRunningRun(runId: string, storeId: string): SQL {
  return and(
    eq(minkRuns.id, runId),
    eq(minkRuns.storeId, storeId),
    eq(minkRuns.status, "running"),
    isNull(minkRuns.actedAt),
    isNull(minkRuns.stopRequestedAt),
  )!;
}

// ---------------------------------------------------------------------------
// Seeing a stop asked for on another instance (the watcher and the live
// registry live in stop-watch.ts, shared with Refine with Mink AI).
// ---------------------------------------------------------------------------

export {
  STOP_WATCH_FAST_FOR_MS,
  STOP_WATCH_FAST_MS,
  STOP_WATCH_JITTER,
  STOP_WATCH_SLOW_MS,
} from "./stop-watch";

/**
 * Watch a run for a stop asked for on another instance, and call `onStop`
 * once when one is seen (stop-watch.ts: one primary-key read per tick, never
 * stacked, a failed tick skipped and logged once per run). `close()` ends it;
 * the stream route closes it once the run has acted (a stop can no longer
 * win) and when the run ends.
 */
export function watchMinkRunStop(input: {
  runId: string;
  storeId: string;
  onStop: () => void;
}): StopWatch {
  return watchForStop({
    read: () => isMinkRunStopRequested(input),
    onStop: input.onStop,
    skippedLog: {
      message: "mink.stop: watch read skipped",
      fields: { runId: input.runId, storeId: input.storeId },
    },
    failedLog: {
      message: "mink.stop: watch stop failed",
      fields: { runId: input.runId },
    },
  });
}

// ---------------------------------------------------------------------------
// The same-instance fast path.
// ---------------------------------------------------------------------------

const liveRuns = createLiveStopRegistry(
  "storemink.mink.liveRuns",
  "mink.stop: live stop failed",
);

/**
 * Note a run this process is answering, so a stop recorded here reaches it at
 * once rather than at the watcher's next tick. Returns the unregister call.
 */
export function registerLiveMinkRun(
  runId: string,
  onStop: () => void,
): () => void {
  return liveRuns.register(runId, onStop);
}

/** Stop a run this process is answering. A run elsewhere is left to its watcher. */
export function stopLiveMinkRun(runId: string): void {
  liveRuns.stop(runId, { runId });
}

// ---------------------------------------------------------------------------
// A stopped run whose instance went away.
// ---------------------------------------------------------------------------

/**
 * A live instance sees a stop within about two seconds, so a run still
 * "running" three minutes after its stop was recorded has lost its process.
 */
export const MINK_STOPPED_RUN_GRACE_MS = 3 * 60_000;
/** At most this many stopped runs are closed in one pass. */
export const MINK_STOPPED_RUN_SWEEP_LIMIT = 20;

/** `latency_ms` is a Postgres integer. */
const MAX_LATENCY_MS = 2_147_483_647;

/**
 * Close the runs that were stopped and whose instance never closed them, each
 * through `failMinkRun` as `cancelled` with code `stopped`, as the stream route
 * would have. ★ Called by the per-minute workflow heartbeat beside
 * `closeStaleMinkRuns`, which would close them as abandoned after 15 minutes.
 * ★ Bounded and oldest first; each run is its own transaction, and one that
 * cannot be closed is logged and left for the next pass.
 */
export async function closeStoppedMinkRuns(
  scope: { limit?: number } = {},
): Promise<{ closed: number; failed: number }> {
  const asked =
    typeof scope.limit === "number" && Number.isFinite(scope.limit)
      ? Math.floor(scope.limit)
      : MINK_STOPPED_RUN_SWEEP_LIMIT;
  const limit = Math.max(1, Math.min(MINK_STOPPED_RUN_SWEEP_LIMIT, asked));
  const graceSeconds = MINK_STOPPED_RUN_GRACE_MS / 1_000;
  const stopped = await withService((db) =>
    db
      .select({
        id: minkRuns.id,
        storeId: minkRuns.storeId,
        conversationId: minkRuns.conversationId,
        requestedBy: minkRuns.requestedBy,
        model: minkRuns.model,
        ageMs: sql<number>`least(floor(extract(epoch from (now() - ${minkRuns.startedAt})) * 1000), ${MAX_LATENCY_MS})::int`,
        // ★ Qualified by hand: Drizzle writes a select list's columns without
        //   their table, which inside this subquery would name the tool call.
        toolCalls: sql<number>`(
          select count(*)::int from ${minkToolCalls} as stopped_run_call
          where stopped_run_call.run_id = ${minkRuns}.id
            and stopped_run_call.store_id = ${minkRuns}.store_id
        )`,
      })
      .from(minkRuns)
      .where(
        and(
          // ★ The running-runs partial index (0240) keeps this off the table.
          eq(minkRuns.status, "running"),
          isNotNull(minkRuns.stopRequestedAt),
          sql`${minkRuns.stopRequestedAt} < now() - make_interval(secs => ${graceSeconds})`,
        ),
      )
      .orderBy(minkRuns.startedAt, minkRuns.id)
      .limit(limit),
  );
  let closed = 0;
  let failed = 0;
  for (const run of stopped) {
    try {
      const record = await failMinkRun({
        actor: { storeId: run.storeId, adminId: run.requestedBy },
        started: { conversationId: run.conversationId, runId: run.id },
        status: "cancelled",
        errorCode: "stopped",
        latencyMs: Number(run.ageMs) || 0,
        model: run.model,
        // Unused: nothing is known of the run's usage, so it is priced at
        // nothing ("unavailable").
        pricingLocation: "global",
        progress: {
          steps: 0,
          toolCalls: Number(run.toolCalls) || 0,
          retryCount: 0,
          usage: {
            promptTokens: 0,
            outputTokens: 0,
            thoughtTokens: 0,
            totalTokens: 0,
            cachedTokens: 0,
            basePromptTokens: 0,
          },
        },
        usageStatus: "unavailable",
      });
      if (record.closed) {
        closed += 1;
        // Content-free: ids and the age only.
        logWarn("mink.run: stopped run closed", {
          storeId: run.storeId,
          runId: run.id,
          ageMs: Number(run.ageMs) || 0,
        });
      }
    } catch (error) {
      failed += 1;
      logError("mink.run: stopped run not closed", loggableError(error), {
        storeId: run.storeId,
        runId: run.id,
      });
    }
  }
  return { closed, failed };
}
