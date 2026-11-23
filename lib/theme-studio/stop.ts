import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  themeStudioAcceptanceRuns,
  themeStudioCaptures,
  themeStudioProjects,
  themeStudioRuns,
  themeStudioVersions,
  themeStudioVisualQaRuns,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { publishedReleaseOf } from "./published-version";
import { pgErrorCode } from "@/lib/db/errors";
import type { ThemeStudioActor } from "./access";
import type { ThemeStudioProjectState } from "./contracts";
import { isUuid, recordThemeStudioEvent, ThemeStudioError } from "./repository";

// ---------------------------------------------------------------------------
// Stop: the operator's way out of a theme that is working, or stuck working.
//
// A theme is `generating` while a run, a capture or a design review holds it,
// and until this existed a capture whose job never started held it for ever:
// no Stop, and Archive and Delete both refuse a generating theme (one local
// project sat that way for 24 days). Stop ends whatever holds the theme, in
// one transaction:
//
// ★ CAPTURES AND DESIGN REVIEWS END AT ONCE, LEASE-FENCED. Each becomes
// `failed` with the stop code `cancelled` and loses its lease. Everything a
// capture job or review worker writes is fenced on its own lease (status
// running, its lease owner, an unexpired lease), so a job still photographing
// is told it lost the capture (409) and its pictures are never saved, and a
// review worker's next renewal answers `false`, which stops its model call
// within one 30-second tick (worker-lease.ts).
//
// ★ RUNS USE THE CANCEL THE WORKER ALREADY HONOURS. A queued run, or one whose
// lease lapsed with no worker left to settle it, is cancelled here (the worker
// and its reaper do the same). A run with a live worker is asked to cancel:
// the worker stops its provider call within 10 seconds, keeps the photos it
// already drew for reuse, records what was spent, and settles the theme
// itself, so Stop leaves that theme `generating` for those seconds.
//
// ★ THE THEME RETURNS WHERE A FAILED STEP WOULD LEAVE IT: the hidden version
// the stopped work was checking is revealed (as failed, the only move the
// 0144 guard allows a hidden version) and becomes current, as `failCapture`,
// the design review and the run worker all do. With no such version (nothing
// active held the theme, as when a design review had to be closed on its
// own) the newest hidden version newer than the current one is revealed the
// same way, so a paid build is never stranded where no screen reaches it;
// otherwise the theme goes back to its current version (`ready`), or
// `failed` when it has none.
// Migration 0151 allows `generating` to `ready` and `failed`. A visible
// version under a re-check is never written (the guard forbids it).
//
// ★ AN IN-BROWSER CHECK LEFT OPEN IS RETIRED TOO. A check run waiting for an
// operator's browser tab (or a server stage abandoned for 15 minutes) holds
// no theme, but Delete refuses while one exists, and only a new start would
// ever retire it. Stop retires it the way a new start does.
//
// ★ IT TAKES THE PROJECT LOCK FIRST, THEN EACH ACTIVE ROW WITH NOWAIT. A
// worker settling a review or a run holds that row's lock and then asks for
// the project's; waiting for it here would deadlock. NOWAIT refuses instead
// ("try again in a few seconds"), and the worker's own settle goes ahead.
// ---------------------------------------------------------------------------

/** The stop code a stopped capture or design review carries, the same word a
 * cancelled run's settle records (worker.ts). */
export const THEME_STUDIO_STOP_CODE = "cancelled";

/** PostgreSQL `lock_not_available`, what NOWAIT raises. */
const LOCK_NOT_AVAILABLE = "55P03";
/** A check run's server stage this old was abandoned (acceptance.ts
 * RUNNING_STALE_MINUTES); a younger one is a request still in progress. */
const BROWSER_CHECK_STALE_MINUTES = 15;

export interface StopThemeStudioChecksResult {
  /** The theme's status after Stop. `generating` only while a run with a live
   * worker finishes cancelling (`cancelling`); the worker settles it. */
  status: ThemeStudioProjectState;
  /** Captures and design reviews ended, runs cancelled or asked to, and
   * in-browser check runs retired. */
  stopped: {
    captures: number;
    reviews: number;
    runs: number;
    browserChecks: number;
  };
  cancelling: boolean;
}

type ActiveCapture = { id: string; versionId: string; automatic: boolean };
type ActiveReview = { id: string; versionId: string };
type ActiveRun = {
  id: string;
  status: string;
  automatic: boolean;
  baseVersionId: string | null;
  cancelRequestedAt: string | null;
  lapsed: boolean;
};
type OpenBrowserCheck = { id: string; status: string };

async function lockActiveWork(db: Db, projectId: string) {
  const active = ["queued", "running"];
  const captures: ActiveCapture[] = await db
    .select({
      id: themeStudioCaptures.id,
      versionId: themeStudioCaptures.versionId,
      automatic: themeStudioCaptures.automatic,
    })
    .from(themeStudioCaptures)
    .where(
      and(
        eq(themeStudioCaptures.projectId, projectId),
        inArray(themeStudioCaptures.status, active),
      ),
    )
    .for("update", { noWait: true });
  const reviews: ActiveReview[] = await db
    .select({
      id: themeStudioVisualQaRuns.id,
      versionId: themeStudioVisualQaRuns.versionId,
    })
    .from(themeStudioVisualQaRuns)
    .where(
      and(
        eq(themeStudioVisualQaRuns.projectId, projectId),
        inArray(themeStudioVisualQaRuns.status, active),
      ),
    )
    .for("update", { noWait: true });
  const runs: ActiveRun[] = await db
    .select({
      id: themeStudioRuns.id,
      status: themeStudioRuns.status,
      automatic: themeStudioRuns.automatic,
      baseVersionId: themeStudioRuns.baseVersionId,
      cancelRequestedAt: themeStudioRuns.cancelRequestedAt,
      // Database time, the clock every lease is written in.
      lapsed: sql<boolean>`(${themeStudioRuns.status} = 'running' AND ${themeStudioRuns.leaseExpiresAt} <= clock_timestamp())`,
    })
    .from(themeStudioRuns)
    .where(
      and(
        eq(themeStudioRuns.projectId, projectId),
        inArray(themeStudioRuns.status, active),
      ),
    )
    .for("update", { noWait: true });
  // Only the ones nobody will finish: a fresh server stage is a request still
  // in progress, and is neither locked nor touched.
  const browserChecks: OpenBrowserCheck[] = await db
    .select({
      id: themeStudioAcceptanceRuns.id,
      status: themeStudioAcceptanceRuns.status,
    })
    .from(themeStudioAcceptanceRuns)
    .where(
      and(
        eq(themeStudioAcceptanceRuns.projectId, projectId),
        sql`(${themeStudioAcceptanceRuns.status} = 'awaiting_browser'
             OR (${themeStudioAcceptanceRuns.status} = 'running'
                 AND ${themeStudioAcceptanceRuns.createdAt} < now() - (${BROWSER_CHECK_STALE_MINUTES}::int * interval '1 minute')))`,
      ),
    )
    .for("update", { noWait: true });
  return { captures, reviews, runs, browserChecks };
}

/**
 * Stop everything working on one theme: queued or running captures and
 * design reviews end at once, lease-fenced; runs are cancelled (or asked to
 * cancel when a live worker holds one). Afterwards the theme is `ready` (or
 * `failed` with no version), so Archive and Delete work; a run still
 * cancelling settles the theme itself within seconds.
 */
export async function stopThemeStudioChecks(
  actor: ThemeStudioActor,
  input: { projectId: string; expectedRevision: number },
): Promise<StopThemeStudioChecksResult> {
  if (!isUuid(input.projectId)) {
    throw new ThemeStudioError("not_found", "That project no longer exists.");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new ThemeStudioError(
      "invalid_input",
      "The request is malformed. Reload and try again.",
    );
  }
  try {
    return await withService(async (db) => {
      const [project] = await db
        .select()
        .from(themeStudioProjects)
        .where(eq(themeStudioProjects.id, input.projectId))
        .for("update")
        .limit(1);
      if (!project) {
        throw new ThemeStudioError(
          "not_found",
          "That project no longer exists.",
        );
      }
      if (project.revision !== input.expectedRevision) {
        throw new ThemeStudioError(
          "stale",
          "This project changed in another tab. Reload to see it.",
        );
      }
      const { captures, reviews, runs, browserChecks } = await lockActiveWork(
        db,
        project.id,
      );
      if (
        project.status !== "generating" &&
        captures.length +
          reviews.length +
          runs.length +
          browserChecks.length ===
          0
      ) {
        // A page check whose server stage is younger than the stale limit is
        // a request still in progress: it ends by itself, or Stop retires it
        // once it is older.
        const [starting] = await db
          .select({ id: themeStudioAcceptanceRuns.id })
          .from(themeStudioAcceptanceRuns)
          .where(
            and(
              eq(themeStudioAcceptanceRuns.projectId, project.id),
              eq(themeStudioAcceptanceRuns.status, "running"),
            ),
          )
          .limit(1);
        throw new ThemeStudioError(
          "illegal_state",
          starting
            ? `A check of the pages is still running. It finishes by itself, or Stop can end it once it is ${BROWSER_CHECK_STALE_MINUTES} minutes old.`
            : "Nothing is running on this theme. Reload to see where it is.",
        );
      }

      for (const capture of captures) {
        await db
          .update(themeStudioCaptures)
          .set({
            status: "failed",
            errorCode: THEME_STUDIO_STOP_CODE,
            finishedAt: sql`now()`,
            leaseOwner: null,
            leaseExpiresAt: null,
          })
          .where(eq(themeStudioCaptures.id, capture.id));
        await recordThemeStudioEvent(db, {
          projectId: project.id,
          actor,
          eventType: "capture_failed",
          detail: { captureId: capture.id, errorCode: THEME_STUDIO_STOP_CODE },
        });
      }

      for (const review of reviews) {
        await db
          .update(themeStudioVisualQaRuns)
          .set({
            status: "failed",
            errorCode: THEME_STUDIO_STOP_CODE,
            finishedAt: sql`now()`,
            leaseOwner: null,
            leaseExpiresAt: null,
          })
          .where(eq(themeStudioVisualQaRuns.id, review.id));
        await recordThemeStudioEvent(db, {
          projectId: project.id,
          actor,
          eventType: "auto_qa_failed",
          detail: {
            qaRunId: review.id,
            versionId: review.versionId,
            errorCode: THEME_STUDIO_STOP_CODE,
          },
        });
      }

      let cancelling = false;
      const cancelledBases: string[] = [];
      for (const run of runs) {
        if (run.status === "queued" || run.lapsed) {
          // Nobody is working on it: cancel it now, as the reaper would.
          await db
            .update(themeStudioRuns)
            .set({
              status: "cancelled",
              cancelRequestedAt: sql`coalesce(${themeStudioRuns.cancelRequestedAt}, now())`,
              retryNotBefore: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              finishedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(themeStudioRuns.id, run.id));
          if (run.automatic && run.baseVersionId) {
            cancelledBases.push(run.baseVersionId);
          }
          await recordThemeStudioEvent(db, {
            projectId: project.id,
            runId: run.id,
            actor,
            eventType: "run_cancelled",
          });
          continue;
        }
        // A live worker holds it: ask, and let its settle record the spend.
        cancelling = true;
        if (!run.cancelRequestedAt) {
          await db
            .update(themeStudioRuns)
            .set({ cancelRequestedAt: sql`now()`, updatedAt: sql`now()` })
            .where(eq(themeStudioRuns.id, run.id));
          await recordThemeStudioEvent(db, {
            projectId: project.id,
            runId: run.id,
            actor,
            eventType: "run_cancel_requested",
          });
        }
      }

      for (const check of browserChecks) {
        // As a new start retires them (acceptance.ts retireStaleRuns).
        await db
          .update(themeStudioAcceptanceRuns)
          .set(
            check.status === "awaiting_browser"
              ? {
                  status: "expired",
                  completedAt: sql`now()`,
                  browserNonceHash: null,
                  browserExpiresAt: null,
                }
              : {
                  status: "error",
                  completedAt: sql`now()`,
                  serverReport: sql`${themeStudioAcceptanceRuns.serverReport} || '{"abandoned":true}'::jsonb`,
                },
          )
          .where(eq(themeStudioAcceptanceRuns.id, check.id));
      }

      let status = project.status as ThemeStudioProjectState;
      let currentVersionId = project.currentVersionId;
      if (project.status === "generating" && !cancelling) {
        // The versions the stopped automatic work was on, the furthest stage
        // first: a design review follows its capture, which follows its run.
        let settled = await settleWorkingVersion(db, project.id, [
          ...reviews.map((review) => review.versionId),
          ...captures
            .filter((capture) => capture.automatic)
            .map((capture) => capture.versionId),
          ...cancelledBases,
        ]);
        if (!settled) {
          // Nothing Stop ended was on a version: a design review the queue
          // had to close on its own (visual-qa.ts settleOnItsOwn) leaves the
          // theme generating with its newest version still hidden, where no
          // screen reaches it and Make current refuses it. That version is
          // shown as a check that stopped, as a failed step shows it.
          const hidden = await newestHiddenVersion(
            db,
            project.id,
            project.currentVersionId,
          );
          if (hidden) {
            settled = await settleWorkingVersion(db, project.id, [hidden]);
            if (settled) {
              await recordThemeStudioEvent(db, {
                projectId: project.id,
                actor,
                eventType: "auto_qa_failed",
                detail: {
                  versionId: settled,
                  errorCode: THEME_STUDIO_STOP_CODE,
                },
              });
            }
          }
        }
        currentVersionId = settled ?? project.currentVersionId;
        // Nothing new became current and the design it kept is a published
        // one: a stopped change leaves a live theme live (0288).
        status = !currentVersionId
          ? "failed"
          : !settled &&
              (await publishedReleaseOf(db, project.id, currentVersionId))
            ? "published"
            : "ready";
      }
      await db
        .update(themeStudioProjects)
        .set({
          status,
          currentVersionId,
          revision: project.revision + 1,
        })
        .where(eq(themeStudioProjects.id, project.id));
      return {
        status,
        stopped: {
          captures: captures.length,
          reviews: reviews.length,
          runs: runs.length,
          browserChecks: browserChecks.length,
        },
        cancelling,
      };
    });
  } catch (error) {
    if (pgErrorCode(error) === LOCK_NOT_AVAILABLE) {
      throw new ThemeStudioError(
        "stale",
        "This theme is saving a step right now. Try Stop again in a few seconds.",
      );
    }
    throw error;
  }
}

/** The newest version a theme was still checking: hidden, pending and newer
 * than the version it shows (an older hidden one is a leftover, never put
 * in front of a newer design). Null when there is none. */
async function newestHiddenVersion(
  db: Db,
  projectId: string,
  currentVersionId: string | null,
): Promise<string | null> {
  const [hidden] = await db
    .select({ id: themeStudioVersions.id })
    .from(themeStudioVersions)
    .where(
      and(
        eq(themeStudioVersions.projectId, projectId),
        eq(themeStudioVersions.visibility, "internal"),
        eq(themeStudioVersions.qaStatus, "pending"),
        sql`${themeStudioVersions.versionNumber} > coalesce((
          SELECT v.version_number FROM theme_studio_versions v
           WHERE v.id = ${currentVersionId}::uuid
        ), 0)`,
      ),
    )
    .orderBy(desc(themeStudioVersions.versionNumber))
    .limit(1);
  return hidden?.id ?? null;
}

/**
 * Of the versions the stopped work was on (furthest stage first), the one
 * the theme now shows: a hidden one is revealed as a failed result, the only
 * move the 0144 guard allows it; a visible one (a re-check of a version
 * already shown) is left exactly as it is. Null when the work was on none.
 */
async function settleWorkingVersion(
  db: Db,
  projectId: string,
  versionIds: readonly string[],
): Promise<string | null> {
  let chosen: string | null = null;
  for (const versionId of new Set(versionIds)) {
    await db
      .update(themeStudioVersions)
      .set({ visibility: "operator", qaStatus: "failed" })
      .where(
        and(
          eq(themeStudioVersions.id, versionId),
          eq(themeStudioVersions.projectId, projectId),
          eq(themeStudioVersions.visibility, "internal"),
          eq(themeStudioVersions.qaStatus, "pending"),
        ),
      );
    if (chosen) continue;
    const [shown] = await db
      .select({ id: themeStudioVersions.id })
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, versionId),
          eq(themeStudioVersions.projectId, projectId),
          eq(themeStudioVersions.visibility, "operator"),
        ),
      )
      .limit(1);
    if (shown) chosen = shown.id;
  }
  return chosen;
}
