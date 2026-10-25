import "server-only";
import { readDistinctnessReport } from "./fingerprint";

import { randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, like, sql } from "drizzle-orm";
import { buildVisualEvidence } from "./visual-evidence";
import {
  startWorkerLease,
  WORKER_LEASE_RENEW_MS,
  WORKER_LEASE_SECONDS,
} from "./worker-lease";
import { renewStudioLease } from "./worker-lease-store";
import {
  qaImageIssues,
  imageAssessmentsComplete,
  type QaImageIssue,
} from "./qa-image-issues";
import {
  buildVisualQaRequest,
  classifyVisualQaReport,
  parseVisualQaReport,
  VISUAL_QA_PROMPT_VERSION,
  type VisualQaReport,
} from "./visual-qa-request";
import {
  themeStudioAssets,
  themeStudioMessages,
  themeStudioProjects,
  themeStudioRuns,
  themeStudioVersions,
  themeStudioVisualQaRuns,
  themeStudioAcceptanceRuns,
  themeStudioCaptures,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { pgErrorCode } from "@/lib/db/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import { getThemeStudioConfig, type ThemeStudioProvider } from "./config";
import { createFakeModelClient } from "./fake-provider";
import { createVertexModelClient, getVertexConfig } from "./gemini-vertex";
import { sharedProviderCapacity } from "./provider-capacity-store";
import { resolveThemeStudioModel, type ThemeStudioModelKey } from "./models";
import { THEME_STUDIO_PROMPT_VERSION } from "./prompts";
import type {
  ProviderUsage,
  ThemeStudioContentBlock,
  ThemeStudioModelClient,
} from "./provider";
import { recordThemeStudioEvent } from "./repository";
import {
  currentAcceptanceBuildId,
  verifyCandidateEvidenceWithDb,
} from "./acceptance";
import { readAcceptanceReport, type GateResult } from "./acceptance-gates";
import {
  automaticQaAttention,
  automaticQaDecision,
  automaticAcceptanceFailures,
  MAX_AUTOMATIC_QA_REPAIRS,
} from "./automatic-qa-policy";
import { SEVERITY_RULES_VERSION } from "./finding-severity";
import { AUTOMATIC_CAPTURE_MAX_ATTEMPTS } from "./capture-core";
import { repairTargets } from "./targeted-repair";
import { describeSlots } from "./slot-images-core";
import {
  validateThemeIntent,
  validateThemePackageV2,
  type ThemePackageV2,
} from "./contracts";
import {
  automaticImageProvider,
  noteThemeStudioOperatorNotice,
  queueAutomaticImages,
  queueAutomaticCapture,
  withNoticeScope,
  withServiceAndNotices,
} from "./automatic-work";
import { startCaptureJobAfterCommit } from "./capture-start";
import { checkUncheckedPhotos } from "./image-recovery";
import { generatableSlots } from "./image-generation-core";
import {
  deterministicRepairs,
  qaProgress,
  qaImproved,
  type QaProgress,
} from "./qa-diagnosis";
import { SCORECARD_DIMENSIONS, type ReviewFinding } from "./scorecard";

const QA_LEASE_SECONDS = WORKER_LEASE_SECONDS;
/** The stop code of a check that could not finish, or that StoreMink's
 * preview broke: "Couldn't finish the checks", Check again, never "describe
 * a fix" (studio-ui.tsx REVIEW_STOP). A serious finding left after the
 * repairs is `quality_bar_not_met`. Free text: no migration (0144). */
const CHECKS_INCOMPLETE = "checks_incomplete";
/** Recaptures one version may take because a deploy outdated its evidence.
 * Deploys are finite, but a busy day of them must not keep a project cycling
 * through full browser captures without ever reaching a verdict. */
export const MAX_BUILD_RECAPTURES = 2;
/** The design review's own clock, from the start of its reads to its answer. */
export const QA_TIMEOUT_MS = 4 * 60_000;

// ── The design-review lane on the shared web service (TS-3A) ─────────────
//
// The capture job now wakes the review route the moment a capture finishes,
// so two captures finishing together plus the minute ticks could start up to
// six review lanes on one web server, which also serves every shopper. So:
//   ★ At most DESIGN_REVIEW_CAP reviews run at once on the whole platform,
//     checked when a review is CLAIMED: the claim takes a transaction-scoped
//     advisory lock (released when the claim commits, milliseconds later),
//     counts the final reviews running on live leases (and those Stop ended
//     so recently that their model call may still run), and claims none at
//     the cap. Nothing holds a lock or a connection through the review's
//     model call: wave 1 ends a transaction idle for 60 s and waits at most
//     5 s for one of the pool's connections (lib/db/client.ts). A layout
//     check needs no model call, so it is claimed even at the cap.
//   ★ A review sent back after a failed try is claimable again only after
//     QA_RETRY_COOLDOWN_SECONDS (`updated_at`, which the QA guard sets on
//     every update; a row never claimed has no `started_at`).
//   ★ The review has its own capacity row on its model
//     (THEME_STUDIO_REVIEW_CAPACITY_SCOPE, plan optimisation 8), so it no
//     longer holds the permits photo checks and merchants' redesign checks
//     need.
//   ★ `logThemeStudioQaWaiting` counts the reviews waiting over
//     QA_WAITING_ALERT_MINUTES for an alert (P6).

/** Design reviews that may run at once on the whole platform. */
export const DESIGN_REVIEW_CAP = 2;
/** The code Stop gives a review it ends (stop.ts THEME_STUDIO_STOP_CODE). */
const STOPPED_REVIEW_CODE = "cancelled";
/**
 * How long a final review that Stop ended still counts against
 * DESIGN_REVIEW_CAP. Stop fails the row and clears its lease at once (the
 * database allows no lease on a failed row), but the worker running it
 * learns so only at its next lease renewal (every WORKER_LEASE_RENEW_MS,
 * 30 s, and a renewal waits at most 5 s for a connection), and its model
 * call runs until then. So the stopped review keeps its slot that long.
 */
export const STOPPED_REVIEW_HOLDS_SLOT_MS = WORKER_LEASE_RENEW_MS + 5_000;
/** A review sent back after a failed try waits this long to be claimed. */
export const QA_RETRY_COOLDOWN_SECONDS = 60;
/** A review queued longer than this counts in `theme_studio.qa_waiting`. */
export const QA_WAITING_ALERT_MINUTES = 10;
/** Theme Studio's own capacity row for its design review (optimisation 8). */
export const THEME_STUDIO_REVIEW_CAPACITY_SCOPE = "theme-studio-review";
/**
 * ★★ When the photo checks of one claim must have answered, counted from the
 * claim (TS-3 fixer, 25 Oct 2026). Theme Studio's check sends one try to
 * Google's US endpoint and, when that is refused or runs out its own 120 s
 * clock, one to global (worker.ts THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS),
 * so the first checks get both whole tries and 10 s to be admitted. The
 * deadline is each check's own clock, never a stop: a check it cuts counts
 * as a try, so the same bytes are not sent again on every claim, and a check
 * is started only with PHOTO_RECHECK_MIN_CLOCK_MS left (image-recovery.ts).
 * With its reads and settlement the claim ends well inside the review
 * route's five-minute schedule; the review then runs in a claim of its own
 * (PHOTO_CHECK_INLINE_MS).
 */
export const PHOTO_CHECK_BUDGET_MS = 250_000;
/**
 * Photo checks that ended within this long of the claim leave the review its
 * whole clock (QA_TIMEOUT_MS) inside the route's five minutes, so the review
 * follows in the same claim. After longer checks the review goes back to the
 * queue with no try spent and is claimable at once (`photoCheck.state`
 * "checked"): one claim never holds photo checks and a review together past
 * the schedule's deadline.
 */
export const PHOTO_CHECK_INLINE_MS = 20_000;
/** Longest a review waits for its photo checks ("Checking pictures") before
 * the checks stop as could not finish. */
export const PHOTO_CHECK_WAIT_LIMIT_MS = 20 * 60_000;
/** The claim's one-at-a-time lock (released by the claim's commit). */
const REVIEW_CLAIM_LOCK = sql`select pg_advisory_xact_lock(hashtextextended('theme-studio:design-review-claim', 0))`;
export {
  VISUAL_QA_PROMPT_VERSION,
  VISUAL_QA_SCHEMA,
  parseVisualQaReport,
  visualQaContext,
  type VisualQaReport,
} from "./visual-qa-request";

type QaRow = typeof themeStudioVisualQaRuns.$inferSelect;

/** A model call that answered but could not be used (refused, cut off, not
 * JSON, an incomplete answer): what it cost rides with the error, so a retry
 * never drops it. */
class ReviewCallError extends Error {
  constructor(
    code: string,
    readonly usage: ProviderUsage,
  ) {
    super(code);
  }
}

/** Errors in our own inputs (a screenshot or photo the review needs is gone
 * or unreadable): no retry can fix them, and they are not the provider's. */
const REVIEW_INPUT_ERRORS: ReadonlySet<string> = new Set([
  "qa_input_missing",
  "qa_image_input_missing",
  "qa_screenshot_unusable",
]);

function isReviewInputError(error: unknown): boolean {
  return (
    error instanceof Error &&
    !(error instanceof ReviewCallError) &&
    REVIEW_INPUT_ERRORS.has(error.message)
  );
}

/** What the review's failed model calls cost so far, as a retry stored it on
 * the row (`failedCalls`, `failedCallUsage`). Empty when there were none. */
function failedCallsOf(visionReport: unknown): {
  failedCalls?: number;
  failedCallUsage?: ProviderUsage;
} {
  const report =
    visionReport && typeof visionReport === "object"
      ? (visionReport as Record<string, unknown>)
      : {};
  const calls = report.failedCalls;
  const usage = report.failedCallUsage as Partial<ProviderUsage> | undefined;
  if (typeof calls !== "number" || !Number.isSafeInteger(calls) || calls < 1)
    return {};
  const tokens = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  return {
    failedCalls: calls,
    failedCallUsage: {
      inputTokens: tokens(usage?.inputTokens),
      cachedTokens: tokens(usage?.cachedTokens),
      outputTokens: tokens(usage?.outputTokens),
      thinkingTokens: tokens(usage?.thinkingTokens),
    },
  };
}

/** The failed-call totals with one more failed call added. */
function withFailedCall(
  visionReport: unknown,
  usage: ProviderUsage,
): { failedCalls: number; failedCallUsage: ProviderUsage } {
  const prior = failedCallsOf(visionReport);
  const sum = prior.failedCallUsage;
  return {
    failedCalls: (prior.failedCalls ?? 0) + 1,
    failedCallUsage: {
      inputTokens: (sum?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
      cachedTokens: (sum?.cachedTokens ?? 0) + (usage.cachedTokens ?? 0),
      outputTokens: (sum?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
      thinkingTokens: (sum?.thinkingTokens ?? 0) + (usage.thinkingTokens ?? 0),
    },
  };
}

/** The serious review findings in the operator's words, for the reason a
 * stopped theme shows. Plain text: no dashes, no credit amounts. */
function reviewReasons(findings: readonly ReviewFinding[]): string[] {
  const photos = (code: string) =>
    findings.filter((f) => f.code === code).map((f) => f.slotId ?? "a photo");
  const reasons = findings.flatMap((f) => {
    switch (f.code) {
      case "inaccessible_copy":
        return [
          "Some text cannot be read: it sits on a photo, a gradient or another layer, is cut off, or is too small or too faint.",
        ];
      case "unsupported_claim":
        return [
          "The pages claim an award, rating, endorsement or similar that the brief does not support.",
        ];
      case "unfinished_surface":
        return ["A shop, product, cart or phone view looks unfinished."];
      case "placeholder_copy":
        return ["Placeholder text is showing."];
      case "copied":
        return [
          "The design review found copied design or assets from another store.",
        ];
      case "very_low_score": {
        const row = SCORECARD_DIMENSIONS.find((d) => d.key === f.row);
        return [
          `The design review scored ${row?.label.toLowerCase() ?? "a row"} ${f.score ?? "very low"} out of 5.`,
        ];
      }
      default:
        return [];
    }
  });
  const unchecked = photos("image_unchecked");
  const hard = photos("image_hard_problem");
  return [
    ...reasons,
    ...(unchecked.length
      ? [
          `These photos have not passed their picture check yet: ${unchecked.join(", ")}. Redraw them, or check the theme again.`,
        ]
      : []),
    ...(hard.length
      ? [
          `The picture check found a problem it does not allow in these photos: ${hard.join(", ")}. Redraw them.`,
        ]
      : []),
  ];
}

type ClaimedQa = QaRow & {
  projectName: string;
  modelKey: ThemeStudioModelKey;
  packageJson: unknown;
  distinctnessReport: unknown;
  originalBrief: string;
  screenshotAssets: { id: string }[];
};

/**
 * Mark a hidden version as judged. ★ Only a hidden, pending version can be
 * judged (migration 0144's guard raises on any other update), and the design
 * review also runs over versions the operator already sees: a layout re-check
 * after "Retry", a deploy re-capture, a re-check before Publish. For those the
 * filter matches no row, which is expected: the version keeps its old mark,
 * and its state is read from its newest check run and review. Updating by id
 * alone raised inside the claim's transaction and could stop every design
 * review on the platform (TS-1B).
 */
async function revealVersion(
  db: Db,
  versionId: string,
  qaStatus: "passed" | "failed",
) {
  await db
    .update(themeStudioVersions)
    .set({ visibility: "operator", qaStatus })
    .where(
      and(
        eq(themeStudioVersions.id, versionId),
        eq(themeStudioVersions.visibility, "internal"),
        eq(themeStudioVersions.qaStatus, "pending"),
      ),
    );
}

/**
 * Close a review as failed, reveal its hidden version and hand the theme
 * back. The closing report keeps what the review's failed model calls cost.
 * When this stops the theme (it was generating), the operator who started
 * it is told it needs them (decision 8).
 */
async function revealFailed(
  db: Db,
  qa: Pick<QaRow, "id" | "projectId" | "versionId"> & {
    visionReport?: unknown;
  },
  errorCode: string,
  report: Record<string, unknown> = {},
) {
  await db
    .update(themeStudioVisualQaRuns)
    .set({
      status: "failed",
      errorCode,
      visionReport: { ...failedCallsOf(qa.visionReport), ...report },
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: sql`now()`,
    })
    .where(eq(themeStudioVisualQaRuns.id, qa.id));
  await revealVersion(db, qa.versionId, "failed");
  const moved = await db
    .update(themeStudioProjects)
    .set({
      status: "ready",
      currentVersionId: qa.versionId,
      revision: sql`${themeStudioProjects.revision} + 1`,
    })
    .where(
      and(
        eq(themeStudioProjects.id, qa.projectId),
        eq(themeStudioProjects.status, "generating"),
      ),
    )
    .returning({ id: themeStudioProjects.id });
  await recordThemeStudioEvent(db, {
    projectId: qa.projectId,
    actor: "worker",
    eventType: "auto_qa_failed",
    detail: { qaRunId: qa.id, versionId: qa.versionId, errorCode },
  });
  // Sent once this settlement commits (withServiceAndNotices).
  if (moved.length > 0)
    noteThemeStudioOperatorNotice({
      projectId: qa.projectId,
      kind: "needs_fix",
    });
}

/**
 * Close a run whose project stopped generating (cancelled, archived, or moved
 * on by an operator). Only the run is touched: the project is no longer this
 * worker's to change, and revealing its version would contradict whatever the
 * operator did. Releasing the lease is what stops the run being re-claimed and
 * re-judged by a paid vision call on every lease expiry.
 */
async function closeAbandoned(db: Db, qaRunId: string) {
  await closeRun(db, qaRunId, "project_state_changed");
}

/** Close the review row alone. A finished row is left as it is: the QA guard
 * refuses any change to one. */
async function closeRun(db: Db, qaRunId: string, errorCode: string) {
  await db
    .update(themeStudioVisualQaRuns)
    .set({
      status: "failed",
      errorCode,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(themeStudioVisualQaRuns.id, qaRunId),
        inArray(themeStudioVisualQaRuns.status, ["queued", "running"]),
      ),
    );
}

const ROW_SAVEPOINT = "theme_studio_qa_row";

/**
 * Run `work` in a savepoint of the caller's transaction, so a statement the
 * database refuses undoes only this work. ★ Raw savepoints: withService opens
 * its transaction by hand, and drizzle's db.transaction() on that handle would
 * COMMIT the caller's transaction early.
 */
async function inSavepoint(db: Db, work: () => Promise<void>) {
  await db.execute(sql.raw(`SAVEPOINT ${ROW_SAVEPOINT}`));
  let failure: { error: unknown } | null = null;
  try {
    await work();
  } catch (error) {
    failure = { error };
    await db.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${ROW_SAVEPOINT}`));
  }
  await db.execute(sql.raw(`RELEASE SAVEPOINT ${ROW_SAVEPOINT}`));
  if (failure) throw failure.error;
}

/** SQLSTATEs that mean "not now", never "not ever": a statement or lock
 * timeout (wave 1 gave every pool a 30-second statement limit), a lock that
 * NOWAIT could not take, a serialization failure or a deadlock, a database
 * shutting down, out of resources, or a lost connection (classes 53 and 08). */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  "57014",
  "55P03",
  "40001",
  "40P01",
  "57P01",
  "57P02",
  "57P03",
]);

function isTransientDbError(error: unknown): boolean {
  const code = pgErrorCode(error);
  return (
    typeof code === "string" &&
    (TRANSIENT_SQLSTATES.has(code) ||
      code.startsWith("08") ||
      code.startsWith("53"))
  );
}

/**
 * Settle one row that can no longer be worked (worn out, or its inputs are
 * gone) without letting it hold up the queue: its work runs in a savepoint,
 * so a failure undoes only this row's work and the claim goes on to the rest
 * of the queue. A transient failure (a timeout, a lock, a lost connection)
 * leaves the row exactly as it was, so the next claim settles it, revealing
 * its version. Only when the database refuses the settlement itself (a
 * guard's raise, a constraint) or it fails some other way is the row closed
 * alone with `errorCode`, so it is never retried for ever; its project is
 * then left for Stop. One bad row never blocks the claim of every other
 * review on the platform.
 */
async function settleOnItsOwn(
  db: Db,
  qaRunId: string,
  errorCode: string,
  settle: () => Promise<void>,
) {
  try {
    // A settlement rolled back to its savepoint takes its notices with it.
    await inSavepoint(db, () => withNoticeScope(settle));
    return;
  } catch (error) {
    if (isTransientDbError(error)) {
      logError(
        "theme studio: visual QA row settlement deferred to the next claim",
        error,
        { qaRunId, errorCode },
      );
      return;
    }
    logError("theme studio: visual QA row could not be settled", error, {
      qaRunId,
      errorCode,
    });
  }
  try {
    await inSavepoint(db, () => closeRun(db, qaRunId, errorCode));
  } catch (error) {
    logError("theme studio: visual QA row could not be closed", error, {
      qaRunId,
      errorCode,
    });
  }
}

async function projectIsGenerating(db: Db, projectId: string) {
  const [project] = await db
    .select({ status: themeStudioProjects.status })
    .from(themeStudioProjects)
    .where(eq(themeStudioProjects.id, projectId))
    .limit(1);
  return project?.status === "generating";
}

/** A review the queue may hand out: queued (one sent back after a failed try
 * only once its cooldown has passed; one sent back because its photo checks
 * took their own claim, `photoCheck.state` "checked", at once), or running
 * on a lapsed lease with tries left. */
const CLAIMABLE_REVIEW = sql`((${themeStudioVisualQaRuns.status} = 'queued'
    AND (${themeStudioVisualQaRuns.startedAt} IS NULL
      OR ${themeStudioVisualQaRuns.updatedAt} <= now() - (${QA_RETRY_COOLDOWN_SECONDS}::int * interval '1 second')
      OR ${themeStudioVisualQaRuns.visionReport}->'photoCheck'->>'state' = 'checked'))
  OR (${themeStudioVisualQaRuns.status} = 'running'
    AND ${themeStudioVisualQaRuns.leaseExpiresAt} <= now()
    AND ${themeStudioVisualQaRuns.attemptCount} < ${themeStudioVisualQaRuns.maxAttempts}))`;

/** A layout check: rule-based gates only, never a model call. */
const LAYOUT_CHECK = sql`${themeStudioVisualQaRuns.browserReport}->>'phase' = 'layout'`;

/**
 * Claim the next review for this worker, or none. "capped" means a design
 * review is waiting but DESIGN_REVIEW_CAP of them already run on live
 * leases: the claim takes the platform's one-at-a-time lock for its own
 * transaction only, so two claims at once never both pass the count, and it
 * is released when this short transaction commits, before any model call.
 */
async function claimQa(
  db: Db,
  workerId: string,
): Promise<ClaimedQa | "capped" | null> {
  const exhausted = await db
    .select()
    .from(themeStudioVisualQaRuns)
    .where(
      sql`${themeStudioVisualQaRuns.status} = 'running'
          AND ${themeStudioVisualQaRuns.leaseExpiresAt} <= now()
          AND ${themeStudioVisualQaRuns.attemptCount} >= ${themeStudioVisualQaRuns.maxAttempts}`,
    )
    .for("update", { skipLocked: true });
  for (const row of exhausted) {
    await settleOnItsOwn(db, row.id, "qa_lease_expired", async () => {
      if (await projectIsGenerating(db, row.projectId)) {
        await revealFailed(db, row, "qa_lease_expired");
      } else {
        await closeAbandoned(db, row.id);
      }
    });
  }

  // ★ The platform-wide cap, checked here and only here: one claim at a
  // time, then the final reviews running on live leases are counted, and
  // those Stop ended so recently that their model call may still be running
  // (STOPPED_REVIEW_HOLDS_SLOT_MS).
  await db.execute(REVIEW_CLAIM_LOCK);
  const [{ running }] = await db
    .select({ running: count() })
    .from(themeStudioVisualQaRuns)
    .where(
      sql`coalesce(${themeStudioVisualQaRuns.browserReport}->>'phase', 'final') <> 'layout'
          AND ((${themeStudioVisualQaRuns.status} = 'running'
                AND ${themeStudioVisualQaRuns.leaseExpiresAt} > now())
            OR (${themeStudioVisualQaRuns.status} = 'failed'
                AND ${themeStudioVisualQaRuns.errorCode} = ${STOPPED_REVIEW_CODE}
                AND ${themeStudioVisualQaRuns.startedAt} IS NOT NULL
                AND ${themeStudioVisualQaRuns.finishedAt} > now() - (${STOPPED_REVIEW_HOLDS_SLOT_MS}::int * interval '1 millisecond')))`,
    );
  const atCap = Number(running) >= DESIGN_REVIEW_CAP;
  const [next] = await db
    .select()
    .from(themeStudioVisualQaRuns)
    // At the cap only a layout check, which makes no model call.
    .where(atCap ? and(CLAIMABLE_REVIEW, LAYOUT_CHECK) : CLAIMABLE_REVIEW)
    .orderBy(themeStudioVisualQaRuns.createdAt)
    .for("update", { skipLocked: true })
    .limit(1);
  if (!next) {
    if (!atCap) return null;
    const [waiting] = await db
      .select({ id: themeStudioVisualQaRuns.id })
      .from(themeStudioVisualQaRuns)
      .where(CLAIMABLE_REVIEW)
      .limit(1);
    return waiting ? "capped" : null;
  }
  return takeClaim(db, workerId, next);
}

/**
 * Lease one review row to `workerId` and load what judging it needs. A row
 * whose project stopped generating is closed unrun; one whose inputs are
 * gone is failed as `qa_input_missing`. Either way null.
 */
async function takeClaim(
  db: Db,
  workerId: string,
  next: QaRow,
): Promise<ClaimedQa | null> {
  await db
    .update(themeStudioVisualQaRuns)
    .set({
      status: "running",
      leaseOwner: workerId,
      leaseExpiresAt: sql`now() + (${QA_LEASE_SECONDS}::int * interval '1 second')`,
      attemptCount: next.attemptCount + 1,
      startedAt: sql`coalesce(${themeStudioVisualQaRuns.startedAt}, now())`,
    })
    .where(eq(themeStudioVisualQaRuns.id, next.id));
  const [project] = await db
    .select({
      name: themeStudioProjects.name,
      modelKey: themeStudioProjects.modelKey,
      status: themeStudioProjects.status,
      brief: sql<string>`(SELECT m.body FROM theme_studio_messages m WHERE m.project_id=${next.projectId}::uuid AND m.kind='brief' ORDER BY m.created_at LIMIT 1)`,
    })
    .from(themeStudioProjects)
    .where(eq(themeStudioProjects.id, next.projectId))
    .limit(1);
  // Never pay for a vision call on a project nobody is generating any more.
  if (project && project.status !== "generating") {
    await closeAbandoned(db, next.id);
    return null;
  }
  const [version] = await db
    .select({
      packageJson: themeStudioVersions.packageJson,
      distinctnessReport: themeStudioVersions.distinctnessReport,
    })
    .from(themeStudioVersions)
    .where(eq(themeStudioVersions.id, next.versionId))
    .limit(1);
  const assets = await db
    .select({
      id: themeStudioAssets.id,
      purpose: themeStudioAssets.purpose,
    })
    .from(themeStudioAssets)
    .where(
      and(
        eq(themeStudioAssets.projectId, next.projectId),
        inArray(themeStudioAssets.id, next.screenshotAssetIds),
      ),
    );
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const ordered = next.screenshotAssetIds
    .map((id) => byId.get(id))
    .filter((asset): asset is (typeof assets)[number] =>
      Boolean(asset && asset.purpose === "qa_screenshot"),
    )
    .map(({ id }) => ({ id }));
  if (
    !project ||
    !version ||
    ordered.length !== next.screenshotAssetIds.length
  ) {
    await settleOnItsOwn(db, next.id, "qa_input_missing", () =>
      revealFailed(db, next, "qa_input_missing"),
    );
    return null;
  }
  return {
    ...next,
    projectName: project.name,
    modelKey: project.modelKey as ThemeStudioModelKey,
    packageJson: version.packageJson,
    distinctnessReport: version.distinctnessReport,
    originalBrief: (project.brief ?? "").slice(0, 12_000),
    screenshotAssets: ordered,
  };
}

async function contactSheets(
  qa: ClaimedQa,
  signal: AbortSignal,
): Promise<ThemeStudioContentBlock[]> {
  const evidence = (qa.browserReport as { evidence?: { samples?: unknown[] } })
    .evidence;
  const samples = Array.isArray(evidence?.samples) ? evidence.samples : [];
  return buildVisualEvidence(
    qa.screenshotAssets.map((asset, index) => {
      const sample = samples[index] as
        | { viewport?: string; path?: string; surface?: string }
        | undefined;
      return {
        assetId: asset.id,
        viewport: sample?.viewport ?? "unknown",
        page: `${sample?.surface ?? "page"} ${sample?.path ?? ""}`,
      };
    }),
    async (id) => {
      const [asset] = await withService((db) =>
        db
          .select({ bytes: themeStudioAssets.bytes })
          .from(themeStudioAssets)
          .where(
            and(
              eq(themeStudioAssets.id, id),
              eq(themeStudioAssets.projectId, qa.projectId),
              eq(themeStudioAssets.purpose, "qa_screenshot"),
            ),
          )
          .limit(1),
      );
      if (!asset) throw new Error("qa_input_missing");
      return asset.bytes;
    },
    signal,
  );
}

function qaClient(provider: ThemeStudioProvider, qa: ClaimedQa) {
  if (provider === "fake") {
    return createFakeModelClient({
      name: qa.projectName,
      brief: "automatic visual QA",
      industries: [],
      catalogSizes: [],
      requiredFeatures: [],
      referenceCount: 0,
      answered: true,
    });
  }
  const vertex = getVertexConfig();
  return vertex
    ? createVertexModelClient(vertex, {
        // Its own row on the model: a review no longer holds the permits the
        // photo checks (and merchants' redesign checks) need.
        capacity: (model) =>
          sharedProviderCapacity(vertex.projectId, vertex.region, model, {
            scope: THEME_STUDIO_REVIEW_CAPACITY_SCOPE,
          }),
      })
    : null;
}

/** Per-photo check results along this version's ancestry, nearest first, by
 * the bytes they judged (`qaImageIssues` reads them). */
async function imageReviewHistory(
  qa: Pick<ClaimedQa, "projectId" | "versionId">,
) {
  return withService(async (db) => {
    const rows = await db.execute(sql`
      WITH RECURSIVE chain(id, parent, run_id, depth) AS (
        SELECT v.id, v.parent_version_id, v.run_id, 0 FROM theme_studio_versions v
         WHERE v.id=${qa.versionId}::uuid AND v.project_id=${qa.projectId}::uuid
        UNION ALL
        SELECT v.id, v.parent_version_id, v.run_id, c.depth+1 FROM theme_studio_versions v
         JOIN chain c ON v.id=c.parent WHERE c.depth<50 AND v.project_id=${qa.projectId}::uuid
      )
      SELECT DISTINCT ON (asset->>'sha256') asset->>'sha256' AS "sha256",
        outcome->>'review' AS "review", outcome->>'note' AS "note",
        outcome->'problems' AS "problems"
        FROM chain c JOIN theme_studio_versions v ON v.id=c.id
        JOIN theme_studio_runs r ON r.id=c.run_id AND r.project_id=${qa.projectId}::uuid AND r.kind='images'
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.outcome_detail->'outcomes', '[]'::jsonb)) outcome
        CROSS JOIN LATERAL jsonb_array_elements(v.package_json->'assets') asset
       WHERE outcome->>'status'='generated' AND asset->>'id'=outcome->>'slotId'
       ORDER BY asset->>'sha256', c.depth
    `);
    return rows.rows as {
      sha256: string;
      review: string;
      note: string | null;
      problems: unknown;
    }[];
  });
}

async function evaluateQa(
  qa: ClaimedQa,
  provider: ThemeStudioProvider,
  leaseSignal: AbortSignal,
): Promise<{
  report: VisualQaReport;
  issues: QaImageIssue[];
  usage: ProviderUsage;
  provider: ThemeStudioProvider;
  providerModel: string;
}> {
  const client: ThemeStudioModelClient | null = qaClient(provider, qa);
  if (!client) throw new Error("provider_unavailable");
  const model = resolveThemeStudioModel(qa.modelKey);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, leaseSignal]);
  const timeout = setTimeout(() => controller.abort(), QA_TIMEOUT_MS);
  try {
    const history = await imageReviewHistory(qa);
    const issues = qaImageIssues(qa.packageJson as ThemePackageV2, history);
    const imageBlocks: { issue: QaImageIssue; base64: string }[] = [];
    for (const issue of issues) {
      signal.throwIfAborted();
      const [asset] = await withService((db) =>
        db
          .select({
            bytes: themeStudioAssets.bytes,
            mediaType: themeStudioAssets.mediaType,
          })
          .from(themeStudioAssets)
          .where(
            and(
              eq(themeStudioAssets.projectId, qa.projectId),
              eq(themeStudioAssets.purpose, "image"),
              eq(themeStudioAssets.sha256, issue.sha256),
            ),
          )
          .limit(1),
      );
      if (!asset || asset.mediaType !== "image/webp")
        throw new Error("qa_image_input_missing");
      imageBlocks.push({ issue, base64: asset.bytes.toString("base64") });
    }
    const result = await client.generate(
      buildVisualQaRequest({
        modelKey: qa.modelKey,
        providerModel: provider === "fake" ? "fake" : model.providerModel,
        projectName: qa.projectName,
        originalBrief: qa.originalBrief,
        packageJson: qa.packageJson,
        browserReport: qa.browserReport,
        issues,
        evidence: await contactSheets(qa, signal),
        images: imageBlocks,
      }),
      signal,
    );
    // A call that answered but cannot be used was still paid for: its usage
    // rides with the error into the row (`failedCallUsage`).
    if (result.kind !== "ok")
      throw new ReviewCallError(`provider_${result.kind}`, result.usage);
    const report = parseVisualQaReport(result.value);
    if (!report || !imageAssessmentsComplete(issues, report))
      throw new ReviewCallError("qa_output_invalid", result.usage);
    return {
      report,
      issues,
      usage: result.usage,
      provider: client.provider,
      providerModel: provider === "fake" ? "fake" : model.providerModel,
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface EvaluatedQa {
  report: VisualQaReport | null;
  /** The photos the review had to assess (evaluateQa); none without one. */
  issues?: QaImageIssue[];
  usage: ProviderUsage | null;
  provider?: ThemeStudioProvider;
  providerModel?: string;
}

interface SettleOptions {
  /** False when the capture job's own finish settles a layout check: the
   * job claims the capture this queues next, so no second execution. */
  startCaptureJob?: boolean;
}

type SettleOutcome =
  | "lost"
  | "failed"
  | "recapture_queued"
  | "layout_passed"
  | "passed"
  | "revision_queued";

function settleQa(
  workerId: string,
  qa: ClaimedQa,
  evaluated: EvaluatedQa,
): Promise<SettleOutcome> {
  return withServiceAndNotices((db) =>
    settleQaWithDb(db, workerId, qa, evaluated, {}),
  );
}

async function settleQaWithDb(
  db: Db,
  workerId: string,
  qa: ClaimedQa,
  evaluated: EvaluatedQa,
  options: SettleOptions,
): Promise<SettleOutcome> {
  const [held] = await db
    .select()
    .from(themeStudioVisualQaRuns)
    .where(
      and(
        eq(themeStudioVisualQaRuns.id, qa.id),
        eq(themeStudioVisualQaRuns.status, "running"),
        eq(themeStudioVisualQaRuns.leaseOwner, workerId),
        gt(themeStudioVisualQaRuns.leaseExpiresAt, sql`clock_timestamp()`),
      ),
    )
    .for("update")
    .limit(1);
  if (!held) return "lost" as const;
  const [project] = await db
    .select()
    .from(themeStudioProjects)
    .where(eq(themeStudioProjects.id, qa.projectId))
    .for("update")
    .limit(1);
  if (!project || project.status !== "generating") {
    // The run is still ours (locked above): close it rather than leave it
    // leased, or it is re-claimed after every expiry until it exhausts.
    await closeAbandoned(db, qa.id);
    return "failed" as const;
  }
  const binding = qa.browserReport as {
    acceptanceRunId?: string;
    buildId?: string;
    phase?: "layout" | "final";
    gates?: GateResult[];
  };
  const phase = binding.phase === "layout" ? "layout" : "final";
  const [acceptance] =
    phase === "layout"
      ? [
          {
            id: null,
            packageDigest: qa.packageDigest,
            buildId: binding.buildId,
            status: "layout",
            serverReport: { gates: binding.gates ?? [] },
            browserReport: { gates: [] },
          },
        ]
      : binding.acceptanceRunId
        ? await db
            .select()
            .from(themeStudioAcceptanceRuns)
            .where(
              and(
                eq(themeStudioAcceptanceRuns.id, binding.acceptanceRunId),
                eq(themeStudioAcceptanceRuns.projectId, qa.projectId),
                eq(themeStudioAcceptanceRuns.versionId, qa.versionId),
              ),
            )
            .limit(1)
        : [];
  if (!acceptance || acceptance.packageDigest !== qa.packageDigest) {
    await revealFailed(db, qa, "automatic_acceptance_missing");
    return "failed" as const;
  }
  if (acceptance.buildId !== currentAcceptanceBuildId()) {
    // A deploy invalidates old rendering evidence. Recapture this same
    // immutable version instead of paying to regenerate its design/images,
    // so the review always judges today's build: a check run with no
    // review on it can never publish. The same holds for a re-check of a
    // version the operator already sees (the capture re-measures it in
    // place). Counted per check: only the re-captures since this version's
    // newest capture that was not one, so a version re-checked months later
    // is not refused for the deploys its first check met.
    const [{ n: recaptures }] = await db
      .select({ n: count() })
      .from(themeStudioCaptures)
      .where(
        and(
          eq(themeStudioCaptures.versionId, qa.versionId),
          like(themeStudioCaptures.idempotencyKey, "auto\\_recapture\\_%"),
          sql`${themeStudioCaptures.createdAt} > coalesce((
              SELECT max(c.created_at) FROM theme_studio_captures c
               WHERE c.version_id = ${qa.versionId}::uuid
                 AND c.idempotency_key NOT LIKE 'auto\\_recapture\\_%'
            ), '-infinity'::timestamptz)`,
        ),
      );
    if (Number(recaptures) >= MAX_BUILD_RECAPTURES) {
      await revealFailed(db, qa, "acceptance_build_unstable", {
        phase,
        diagnosis:
          "StoreMink was updated more often during these checks than they allow, so they could not finish on one build. Check this theme again.",
      });
      return "failed" as const;
    }
    const [recapture] = await db
      .insert(themeStudioCaptures)
      .values({
        projectId: qa.projectId,
        versionId: qa.versionId,
        packageDigest: qa.packageDigest,
        previousStatus: "generating",
        automatic: true,
        phase,
        qaIteration: qa.qaIteration,
        maxAttempts: AUTOMATIC_CAPTURE_MAX_ATTEMPTS,
        idempotencyKey: `auto_recapture_${qa.id}`,
        createdBy: qa.createdBy,
      })
      .returning({ id: themeStudioCaptures.id });
    // The capture job starts as soon as this settlement commits.
    if (options.startCaptureJob !== false)
      startCaptureJobAfterCommit(recapture.id);
    await db
      .update(themeStudioVisualQaRuns)
      .set({
        status: "failed",
        errorCode: "acceptance_build_changed",
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: sql`now()`,
      })
      .where(eq(themeStudioVisualQaRuns.id, qa.id));
    await recordThemeStudioEvent(db, {
      projectId: qa.projectId,
      actor: "worker",
      eventType: "capture_requested",
      detail: { versionId: qa.versionId, reason: "acceptance_build_changed" },
    });
    return "recapture_queued" as const;
  }
  const gates: GateResult[] = [
    ...readAcceptanceReport(acceptance.serverReport).gates,
    ...readAcceptanceReport(acceptance.browserReport).gates,
  ];
  const failures = automaticAcceptanceFailures(gates);
  // What the design review found, split into serious findings and taste
  // (scorecard.ts). The layout check has no review: its browser gates
  // decide alone. A final check with no review is never a pass.
  const severity = evaluated.report
    ? classifyVisualQaReport(evaluated.report, evaluated.issues ?? [])
    : null;
  const review: { outcome: "pass" | "taste" | "serious" } | null =
    phase === "layout"
      ? { outcome: "pass" }
      : severity
        ? { outcome: severity.outcome }
        : null;
  const distinctness = readDistinctnessReport(qa.distinctnessReport);
  const report = {
    // What this review's earlier failed model calls cost (a retry stored it).
    ...failedCallsOf(qa.visionReport),
    phase,
    ...(distinctness ? { distinctness } : {}),
    progress: qaProgress(gates, evaluated.report),
    promptVersion: VISUAL_QA_PROMPT_VERSION,
    severityRules: SEVERITY_RULES_VERSION,
    usage: evaluated.usage,
    ...evaluated.report,
    ...(severity ? { reviewSeverity: severity } : {}),
    provider: evaluated.provider ?? null,
    providerModel: evaluated.providerModel ?? null,
    repairs: [
      ...deterministicRepairs(gates),
      ...(evaluated.report?.repairs ?? []),
    ],
    acceptanceFailures: failures,
    acceptanceRunId: acceptance.id,
  };
  const decision = automaticQaDecision(gates, review, qa.qaIteration, phase);
  // Taste never blocks: once no repair round can help (the rounds are used
  // up, or what is left needs a StoreMink fix or did not improve), only a
  // serious finding stops the theme. The policy answers that question
  // itself when asked at the repair ceiling.
  const onlyWarningsLeft = () =>
    automaticQaDecision(gates, review, MAX_AUTOMATIC_QA_REPAIRS, phase) ===
    "pass";

  const passLayout = async () => {
    const pkg = validateThemePackageV2(qa.packageJson);
    const [version] = await db
      .select({
        intentJson: themeStudioVersions.intentJson,
        packageDigest: themeStudioVersions.packageDigest,
      })
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, qa.versionId),
          eq(themeStudioVersions.projectId, qa.projectId),
        ),
      )
      .limit(1);
    const intent = validateThemeIntent(version?.intentJson);
    const config = getThemeStudioConfig();
    if (
      !pkg.ok ||
      !intent.ok ||
      version?.packageDigest !== qa.packageDigest ||
      !config.provider
    ) {
      await revealFailed(db, qa, "qa_input_missing", report);
      return "failed" as const;
    }
    const work = {
      id: qa.id,
      projectId: qa.projectId,
      provider: config.provider,
      modelKey: qa.modelKey,
      qaIteration: qa.qaIteration,
      createdBy: qa.createdBy,
    };
    const slots = generatableSlots(pkg.value, intent.value).length;
    // Queue the next stage and close this QA row in the same transaction.
    if (slots > 0) {
      if (
        !(await queueAutomaticImages(
          db,
          work,
          { id: qa.versionId },
          qa.packageDigest,
          slots,
        ))
      ) {
        await revealFailed(db, qa, "image_provider_unavailable", report);
        return "failed" as const;
      }
    } else
      await queueAutomaticCapture(
        db,
        work,
        { id: qa.versionId },
        qa.packageDigest,
        "final",
        { startJob: options.startCaptureJob !== false },
      );
    await db
      .update(themeStudioVisualQaRuns)
      .set({
        status: "passed",
        visionReport: report,
        finishedAt: sql`now()`,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(themeStudioVisualQaRuns.id, qa.id));
    // Deliberately keep the version internal/pending and project generating.
    return "layout_passed" as const;
  };

  const passFinal = async () => {
    if (acceptance.status !== "passed") {
      // The stored outcome and the re-read gates disagree. Paying for a
      // revision of a theme whose every gate passed would be wrong, and so
      // would delivering a candidate the database will refuse: stop here.
      logError(
        "theme studio: acceptance outcome disagrees with its gates",
        undefined,
        { qaRunId: qa.id, acceptanceRunId: acceptance.id },
      );
      await revealFailed(db, qa, "acceptance_outcome_mismatch", report);
      return "failed" as const;
    }
    // Verify asset/build bindings before marking visible or ready. The
    // verifier is read-only; this row is still generating until settlement.
    const verified = await verifyCandidateEvidenceWithDb(db, {
      id: qa.projectId,
      status: "candidate",
      currentVersionId: qa.versionId,
    });
    if (!verified.ok) {
      await revealFailed(db, qa, "acceptance_evidence_stale", {
        reason: verified.reason,
      });
      return "failed" as const;
    }
    // The taste findings left are the warnings this pass accepts: saved on
    // the review with the rule version, shown beside Publish.
    await db
      .update(themeStudioVisualQaRuns)
      .set({
        status: "passed",
        visionReport: report,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: sql`now()`,
      })
      .where(eq(themeStudioVisualQaRuns.id, qa.id));
    // A re-check of a version the operator already sees matches no row
    // here: it keeps its old mark (re-check contract, item 4).
    await revealVersion(db, qa.versionId, "passed");
    await db
      .update(themeStudioProjects)
      .set({
        status: "ready",
        currentVersionId: qa.versionId,
        revision: sql`${themeStudioProjects.revision} + 1`,
      })
      .where(eq(themeStudioProjects.id, qa.projectId));
    // Keep the database state machine: generating -> ready -> candidate.
    // Both updates commit atomically after the passing acceptance exists.
    await db
      .update(themeStudioProjects)
      .set({ status: "candidate" })
      .where(eq(themeStudioProjects.id, qa.projectId));
    await recordThemeStudioEvent(db, {
      projectId: qa.projectId,
      actor: "worker",
      eventType: "auto_qa_passed",
      detail: {
        qaRunId: qa.id,
        versionId: qa.versionId,
        severityRules: SEVERITY_RULES_VERSION,
        // Codes only, once each: the event detail is capped at 4 KiB.
        warnings: [...new Set((severity?.warnings ?? []).map((w) => w.code))],
      },
    });
    // Ready to publish (a first build or a re-check): the operator who
    // started the theme is told once this commits (decision 8).
    noteThemeStudioOperatorNotice({ projectId: qa.projectId, kind: "ready" });
    return "passed" as const;
  };
  const pass = () => (phase === "layout" ? passLayout() : passFinal());

  if (decision === "pass") return pass();
  if (decision === "attention" || decision === "blocked") {
    // A check that could not finish, or StoreMink's preview not working,
    // is told apart from a serious finding left after the repairs: only
    // the last asks for a change to the theme (plan section 4, rows 12
    // and 14), so no stop sends the operator to a paid revision that
    // cannot help.
    const attention =
      decision === "attention"
        ? automaticQaAttention(gates, review, qa.qaIteration, phase)
        : null;
    const incomplete = decision === "attention" && attention !== "serious";
    await revealFailed(
      db,
      qa,
      incomplete
        ? CHECKS_INCOMPLETE
        : decision === "blocked"
          ? "acceptance_security_failed"
          : "quality_bar_not_met",
      {
        ...report,
        diagnosis:
          decision === "blocked"
            ? "Required security checks failed. Resolve the listed security findings before retrying."
            : incomplete
              ? attention === "runtime"
                ? "The checks could not judge the theme: the demo store, a page, a stored picture or a menu did not work during them (the findings say which). A change to the theme will not fix this. Check again, and replace any picture the findings name on the Images page."
                : "The checks could not finish: a page or a check was not measured, timed out or was skipped, or the design review did not run. This is a StoreMink problem, not the theme's. Check again."
              : [
                  ...reviewReasons(severity?.serious ?? []),
                  "Serious problems remain after the automatic checks and fixes. Review the listed findings before retrying.",
                ].join(" "),
      },
    );
    if (decision === "blocked")
      await db
        .update(themeStudioProjects)
        .set({ status: "blocked" })
        .where(eq(themeStudioProjects.id, qa.projectId));
    return "failed" as const;
  }
  const config = getThemeStudioConfig();
  if (!config.autoQaEnabled || !config.provider) {
    await revealFailed(db, qa, "auto_qa_disabled", report);
    return "failed" as const;
  }
  const pkg = validateThemePackageV2(qa.packageJson);
  if (!pkg.ok) {
    await revealFailed(db, qa, "qa_input_missing", report);
    return "failed" as const;
  }
  const repairs = report.repairs;
  const settings = new Set(repairTargets(pkg.value).map((t) => t.path));
  const imageSlots = new Set(
    describeSlots(pkg.value)
      .filter(
        (s) =>
          s.source === "generated" && !s.catalogPreview && !s.catalogScreenshot,
      )
      .map((s) => s.id),
  );
  const invalidTarget = repairs.some(
    (r) =>
      (r.kind === "settings" && r.target !== null && !settings.has(r.target)) ||
      (r.kind === "image" && (!r.target || !imageSlots.has(r.target))),
  );
  const renderer =
    repairs.some((r) => r.kind === "renderer") ||
    evaluated.report?.rejections.includes("needs_custom_code");
  // Legacy visual evidence cannot silently route explicit platform work to a
  // settings repair merely because it predates structured repairs.
  const legacyRenderer =
    !evaluated.report?.repairs &&
    /(?:renderer|custom code|\bCSS\b|JavaScript|preload|srcset)/i.test(
      evaluated.report?.revisionBrief ?? "",
    );
  // A photo whose own check has not passed on its bytes, or found a hard
  // problem, stays serious whatever the review says, and no theme revision
  // can clear it: only a redraw (checked as it is drawn) or the photo check
  // itself. Stop rather than buy a revision that cannot help.
  const photosToCheck = (severity?.serious ?? []).filter(
    (f) =>
      (f.code === "image_unchecked" || f.code === "image_hard_problem") &&
      !repairs.some((r) => r.kind === "image" && r.target === f.slotId),
  );
  if (photosToCheck.length) {
    await revealFailed(db, qa, "image_check_required", {
      ...report,
      repairs,
      diagnosis: reviewReasons(photosToCheck).join(" "),
    });
    return "failed" as const;
  }
  if (renderer || legacyRenderer || invalidTarget) {
    // No revision can do this work. If only taste is left, it is shown as
    // warnings and the theme goes on; a serious finding stops it here.
    if (onlyWarningsLeft()) return pass();
    await revealFailed(
      db,
      qa,
      invalidTarget ? "repair_not_supported" : "renderer_fix_required",
      {
        ...report,
        repairs,
        diagnosis: invalidTarget
          ? "The required repair has no supported setting or generated image slot. Review the platform implementation."
          : "These findings require a platform renderer fix. Further theme revisions cannot resolve them.",
      },
    );
    return "failed" as const;
  }
  if (qa.qaIteration > 0) {
    // Follow only this immutable version's ancestry. Unrelated branches,
    // explicit retries and older builds must not stop a fresh attempt.
    const previous = await db
      .select({ visionReport: themeStudioVisualQaRuns.visionReport })
      .from(themeStudioVisualQaRuns)
      .where(
        and(
          eq(themeStudioVisualQaRuns.projectId, qa.projectId),
          eq(themeStudioVisualQaRuns.status, "revision_queued"),
          sql`coalesce(${themeStudioVisualQaRuns.browserReport}->>'phase','final') = ${phase}`,
          sql`${themeStudioVisualQaRuns.browserReport}->>'buildId' = ${acceptance.buildId}`,
          sql`${themeStudioVisualQaRuns.versionId} IN (WITH RECURSIVE ancestry AS (
            SELECT id,parent_version_id,0 AS depth FROM theme_studio_versions WHERE id=${qa.versionId}::uuid AND project_id=${qa.projectId}::uuid
            UNION ALL SELECT v.id,v.parent_version_id,a.depth+1 FROM theme_studio_versions v JOIN ancestry a ON v.id=a.parent_version_id
            WHERE v.project_id=${qa.projectId}::uuid AND a.depth<50) SELECT id FROM ancestry WHERE depth>0)`,
        ),
      )
      .orderBy(sql`${themeStudioVisualQaRuns.createdAt} DESC`)
      .limit(12);
    const history = previous
      .map((p) => (p.visionReport as { progress?: QaProgress })?.progress)
      .filter((p): p is QaProgress => Boolean(p && Array.isArray(p.patterns)));
    const current = report.progress;
    if (
      history.length &&
      (!qaImproved(current, history[0]) ||
        history.some((p) => JSON.stringify(p) === JSON.stringify(current)))
    ) {
      // Repairs stopped helping. Taste left over becomes warnings.
      if (onlyWarningsLeft()) return pass();
      await revealFailed(db, qa, "qa_no_progress", {
        ...report,
        repairs,
        diagnosis:
          "Automatic QA stopped because the same findings did not improve after a repair, or a previous failure pattern returned. Review the listed defects before retrying.",
      });
      return "failed" as const;
    }
  }
  const redrawIds = [
    ...new Set(repairs.filter((r) => r.kind === "image").map((r) => r.target!)),
  ];
  const settingRepairs = repairs.filter((r) => r.kind === "settings");
  // Stabilize layout first when both settings and artwork need changes. The
  // next final review will route any remaining artwork defect to its slot.
  if (redrawIds.length && !settingRepairs.length) {
    if (
      !automaticImageProvider({
        provider: config.provider,
        modelKey: qa.modelKey,
        id: qa.id,
        projectId: qa.projectId,
        qaIteration: qa.qaIteration,
        createdBy: qa.createdBy,
      })
    ) {
      await revealFailed(db, qa, "image_provider_unavailable", report);
      return "failed" as const;
    }
    const imageRunId = await queueAutomaticImages(
      db,
      {
        id: qa.id,
        projectId: qa.projectId,
        provider: config.provider,
        modelKey: qa.modelKey,
        qaIteration: qa.qaIteration + 1,
        createdBy: qa.createdBy,
      },
      { id: qa.versionId },
      qa.packageDigest,
      redrawIds.length,
      redrawIds,
      Object.fromEntries(
        repairs
          .filter((r) => r.kind === "image")
          .map((r) => [r.target!, r.reason]),
      ),
    );
    if (!imageRunId) {
      await revealFailed(db, qa, "image_provider_unavailable", report);
      return "failed" as const;
    }
    await db
      .update(themeStudioVisualQaRuns)
      .set({
        status: "revision_queued",
        revisionRunId: imageRunId,
        visionReport: { ...report, repairs },
        finishedAt: sql`now()`,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(themeStudioVisualQaRuns.id, qa.id));
    return "revision_queued" as const;
  }
  const model = resolveThemeStudioModel(qa.modelKey);
  const brief = redrawIds.length
    ? [
        "Revise only the following supported theme settings. Artwork changes are deferred until these settings are stable.",
        ...settingRepairs.map(
          (r) =>
            `Setting ${r.target ?? "(choose a supported path)"}: ${r.reason}`,
        ),
        "Preserve all artwork, content, product identity and other settings. Do not hide content or disable checks.",
      ]
        .join("\n")
        .slice(0, 12_000)
    : [
        "Revise this theme to clear its automatic checks.",
        ...failures.map((finding) => `Acceptance: ${finding}`),
        ...(evaluated.report
          ? [
              `Visual scores: ${JSON.stringify(evaluated.report.scores)}. Raise every row to at least 4 and the total to at least 34.`,
              ...evaluated.report.rejections.map(
                (reason) => `Visual rejection: ${reason}`,
              ),
            ]
          : []),
        ...(evaluated.report?.findings ?? []).map(
          (finding) => `Visual: ${finding}`,
        ),
        evaluated.report?.revisionBrief
          ? `Required changes: ${evaluated.report.revisionBrief}`
          : "Fix every reported acceptance finding using the theme's supported settings. Preserve existing artwork; do not hide content or disable checks.",
        "Preserve the product identity and any strong choices that already work. Do not ask questions; use stated assumptions.",
      ]
        .join("\n")
        .slice(0, 12_000);
  const [message] = await db
    .insert(themeStudioMessages)
    .values({
      projectId: qa.projectId,
      kind: "revision",
      body: brief,
      referenceAssetIds: [],
      createdBy: qa.createdBy,
    })
    .returning({ id: themeStudioMessages.id });
  const [revision] = await db
    .insert(themeStudioRuns)
    .values({
      projectId: qa.projectId,
      messageId: message.id,
      kind: "revise",
      baseVersionId: qa.versionId,
      basePackageDigest: qa.packageDigest,
      contextMessageIds: [message.id],
      provider: config.provider,
      modelKey: qa.modelKey,
      providerModel: config.provider === "fake" ? "fake" : model.providerModel,
      promptVersion:
        config.provider === "fake"
          ? "theme-studio-fake-v1"
          : THEME_STUDIO_PROMPT_VERSION,
      idempotencyKey: `auto_revision_${qa.id}`,
      maxAttempts: 3,
      automatic: true,
      qaIteration: qa.qaIteration + 1,
      createdBy: qa.createdBy,
    })
    .returning({ id: themeStudioRuns.id });
  await db
    .update(themeStudioVisualQaRuns)
    .set({
      status: "revision_queued",
      visionReport: { ...report, repairs },
      revisionRunId: revision.id,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: sql`now()`,
    })
    .where(eq(themeStudioVisualQaRuns.id, qa.id));
  await db
    .update(themeStudioProjects)
    .set({ revision: sql`${themeStudioProjects.revision} + 1` })
    .where(eq(themeStudioProjects.id, qa.projectId));
  await recordThemeStudioEvent(db, {
    projectId: qa.projectId,
    runId: revision.id,
    actor: "worker",
    eventType: "auto_qa_revision_queued",
    detail: {
      qaRunId: qa.id,
      fromVersionId: qa.versionId,
      qaIteration: qa.qaIteration + 1,
    },
  });
  return "revision_queued" as const;
}

export interface VisualQaWorkerResult {
  claimed: number;
  passed: number;
  revisionQueued: number;
  /** Same version re-measured after a deploy; no design revision. */
  recaptureQueued: number;
  failed: number;
  layoutPassed: number;
  /** A design review was waiting, but DESIGN_REVIEW_CAP already ran. */
  capped?: number;
  /** The review went back to wait for its photo checks. */
  photosWaiting?: number;
  /** Its photo checks passed but took long enough that the review went back
   * to the queue, to run in a claim of its own (PHOTO_CHECK_INLINE_MS). */
  photosChecked?: number;
}

/** The review row this worker still holds on a live lease, locked. */
async function heldReview(
  db: Db,
  qaRunId: string,
  workerId: string,
): Promise<QaRow | null> {
  const [held] = await db
    .select()
    .from(themeStudioVisualQaRuns)
    .where(
      and(
        eq(themeStudioVisualQaRuns.id, qaRunId),
        eq(themeStudioVisualQaRuns.status, "running"),
        eq(themeStudioVisualQaRuns.leaseOwner, workerId),
        gt(themeStudioVisualQaRuns.leaseExpiresAt, sql`clock_timestamp()`),
      ),
    )
    .for("update")
    .limit(1);
  return held ?? null;
}

// ── The photo check before the design review (TS-3A) ─────────────────────
//
// ★ An unchecked photo stays serious until the photo check itself, with its
// list of hard problems, has passed on those exact bytes; the review's
// approval never clears it (plan section 3, finding K4). So before every
// final review, a photo of the reviewed version with no check on its bytes
// (one whose check was put off while it was drawn, or one carried over from
// an earlier version) goes through builder 3B's `checkUncheckedPhotos`.
// ★ It runs HERE, after the final capture and before the review's model
// call, rather than in the capture's claim: a photo check is a paid model
// call, which may run only inside an HTTP request with no transaction held,
// and the capture claim answers the job within 60 s. Here it runs inside the
// review route's request, under the platform cap of design reviews, and the
// review row's lease means two workers never check the same photo at once.
// The capture photographs the same bytes either way, so the order changes
// no result.
// ★★ NOTHING IS HELD THROUGH A CHECK (TS-3 fixer): `checkUncheckedPhotos` is
// given `withService` itself, so its reads commit before any check is sent
// and each claim and record is a short transaction of its own; no pooled
// connection waits on Google, and a worker with a pool of 1 can still claim.
// ★★ ONE CLAIM, ONE KIND OF PAID WORK, INSIDE THE ROUTE'S FIVE MINUTES. The
// checks get until PHOTO_CHECK_BUDGET_MS after the claim, enough for a try
// at the US and one at global on Theme Studio's 120 s clock; that deadline
// is the checks' own clock, so a check it cuts counts as a try. The review
// follows in the same claim only when the checks ended within
// PHOTO_CHECK_INLINE_MS; otherwise the row goes back to the queue with no
// try spent, claimable at once (`photoCheck.state` "checked").
// ★ While it waits ("Checking pictures"), the row carries
// `vision_report.photoCheck` = { state: checking | waiting | failed, since,
// unchecked } (a count, no content); a wait is not a failed try of the
// review. After PHOTO_CHECK_WAIT_LIMIT_MS, or when the check reports it
// stayed unavailable, the checks stop as could not finish, with Check again.

interface PhotoCheckMarker {
  state: "checking" | "waiting" | "failed" | "checked";
  since: string;
  unchecked: number;
}

function photoCheckSince(visionReport: unknown): string | null {
  const marker = (visionReport as { photoCheck?: { since?: unknown } } | null)
    ?.photoCheck;
  const since = marker?.since;
  return typeof since === "string" && Number.isFinite(Date.parse(since))
    ? since
    : null;
}

/** Show "Checking pictures" on the review row this worker holds. */
async function markPhotoCheck(
  qa: ClaimedQa,
  workerId: string,
  marker: PhotoCheckMarker,
): Promise<void> {
  await withService((db) =>
    db
      .update(themeStudioVisualQaRuns)
      .set({
        visionReport: { ...failedCallsOf(qa.visionReport), photoCheck: marker },
      })
      .where(
        and(
          eq(themeStudioVisualQaRuns.id, qa.id),
          eq(themeStudioVisualQaRuns.status, "running"),
          eq(themeStudioVisualQaRuns.leaseOwner, workerId),
        ),
      ),
  );
}

async function checkPhotosBeforeReview(
  qa: ClaimedQa,
  workerId: string,
  signal: AbortSignal,
  claimStarted: number,
): Promise<{
  outcome: "passed" | "waiting" | "failed";
  marker: PhotoCheckMarker | null;
}> {
  const issues = qaImageIssues(
    qa.packageJson as ThemePackageV2,
    await imageReviewHistory(qa),
  );
  const unchecked = issues.filter((i) => i.review === "unreviewed").length;
  if (unchecked === 0) return { outcome: "passed", marker: null };
  const since = photoCheckSince(qa.visionReport) ?? new Date().toISOString();
  const marker: PhotoCheckMarker = { state: "checking", since, unchecked };
  if (Date.now() - Date.parse(since) > PHOTO_CHECK_WAIT_LIMIT_MS)
    return { outcome: "failed", marker };
  await markPhotoCheck(qa, workerId, marker);
  let outcome: "passed" | "waiting" | "failed";
  try {
    // ★ `withService` itself, not a transaction of ours: the check reads in
    // a short transaction of its own and holds none while Google answers.
    // The lease is its stop; the deadline is the checks' own clock.
    outcome = await checkUncheckedPhotos(withService, {
      projectId: qa.projectId,
      versionId: qa.versionId,
      signal,
      deadline: claimStarted + PHOTO_CHECK_BUDGET_MS,
    });
  } catch (error) {
    // A lost lease ends here like the review would; anything else is a
    // photo check that could not run this time.
    signal.throwIfAborted();
    logError(
      "theme studio: photo check before the design review failed",
      error,
      {
        qaRunId: qa.id,
      },
    );
    outcome = "waiting";
  }
  return { outcome, marker };
}

/** Send the review back to the queue after its photo checks: no try is
 * spent. "waiting": photos are still unchecked, and the retry cooldown
 * spaces the next attempt. "checked": every photo now has its check, and
 * the review is claimable at once, to run in a claim of its own. */
async function waitForPhotoChecks(
  qa: ClaimedQa,
  workerId: string,
  marker: PhotoCheckMarker,
  state: "waiting" | "checked" = "waiting",
): Promise<boolean> {
  return withService(async (db) => {
    const held = await heldReview(db, qa.id, workerId);
    if (!held) return false;
    await db
      .update(themeStudioVisualQaRuns)
      .set({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        attemptCount: Math.max(0, held.attemptCount - 1),
        visionReport: {
          ...failedCallsOf(held.visionReport),
          photoCheck: { ...marker, state },
        },
      })
      .where(eq(themeStudioVisualQaRuns.id, qa.id));
    return true;
  });
}

/** The photo checks stayed unavailable: the checks could not finish. */
async function failForPhotoChecks(
  qa: ClaimedQa,
  workerId: string,
  marker: PhotoCheckMarker,
): Promise<boolean> {
  return withServiceAndNotices(async (db) => {
    const held = await heldReview(db, qa.id, workerId);
    if (!held) return false;
    if (!(await projectIsGenerating(db, qa.projectId))) {
      await closeAbandoned(db, qa.id);
      return true;
    }
    await revealFailed(
      db,
      { ...qa, visionReport: held.visionReport },
      CHECKS_INCOMPLETE,
      {
        phase: "final",
        photoCheck: { ...marker, state: "failed" },
        diagnosis:
          "The picture check could not run on every photo, so the design review could not judge this theme. This is a StoreMink problem, not the theme's. Check again.",
      },
    );
    return true;
  });
}

/** Drain at most one expensive visual verdict per invocation. */
export async function runThemeStudioVisualQaWorker(options: {
  providers: readonly ThemeStudioProvider[];
}): Promise<VisualQaWorkerResult> {
  const result: VisualQaWorkerResult = {
    claimed: 0,
    passed: 0,
    revisionQueued: 0,
    recaptureQueued: 0,
    layoutPassed: 0,
    failed: 0,
    capped: 0,
    photosWaiting: 0,
    photosChecked: 0,
  };
  const config = getThemeStudioConfig();
  if (!config.provider || !options.providers.includes(config.provider)) {
    return result;
  }
  const workerId = randomUUID();
  const claimStarted = Date.now();
  const claimed = await withServiceAndNotices((db) => claimQa(db, workerId));
  if (claimed === "capped") {
    result.capped = 1;
    return result;
  }
  if (!claimed) return result;
  const qa = claimed;
  result.claimed = 1;
  const lease = startWorkerLease(
    () => withService((db) => renewStudioLease(db, "qa", qa.id, workerId)),
    undefined,
    WORKER_LEASE_SECONDS * 1000 - (Date.now() - claimStarted),
  );
  try {
    if (!config.autoQaEnabled) throw new Error("auto_qa_disabled");
    if (config.disabledModels.has(qa.modelKey))
      throw new Error("model_disabled");
    const binding = qa.browserReport as {
      buildId?: string;
      acceptanceRunId?: string;
      gates?: GateResult[];
    };
    // Deterministic failures already contain a repair brief. Avoid an expensive
    // vision call until they pass, and never judge screenshots from old builds
    // (a deploy re-captures first, so a review always judges today's build).
    const needsVision =
      binding.buildId === currentAcceptanceBuildId() &&
      Boolean(binding.acceptanceRunId) &&
      automaticQaDecision(
        binding.gates ?? [],
        { outcome: "pass" },
        qa.qaIteration,
      ) === "pass";
    if (needsVision) {
      const photos = await checkPhotosBeforeReview(
        qa,
        workerId,
        lease.signal,
        claimStarted,
      );
      // ★ The review follows in this claim only when no photo needed its
      //   check, or the checks passed soon enough to leave the review its
      //   whole clock inside the route's five minutes.
      const reviewNow =
        photos.outcome === "passed" &&
        (!photos.marker || Date.now() - claimStarted <= PHOTO_CHECK_INLINE_MS);
      if (!reviewNow && photos.marker) {
        lease.signal.throwIfAborted();
        if (photos.outcome === "failed") {
          if (await failForPhotoChecks(qa, workerId, photos.marker))
            result.failed = 1;
        } else if (photos.outcome === "passed") {
          if (await waitForPhotoChecks(qa, workerId, photos.marker, "checked"))
            result.photosChecked = 1;
        } else if (await waitForPhotoChecks(qa, workerId, photos.marker)) {
          result.photosWaiting = 1;
        }
        return result;
      }
      // Its photos are all checked now: the row stops saying "Checking
      // pictures" while its review runs.
      if (photos.marker)
        await markPhotoCheck(qa, workerId, {
          ...photos.marker,
          state: "checked",
        });
    }
    const evaluated = needsVision
      ? await evaluateQa(qa, config.provider, lease.signal)
      : { report: null, usage: null };
    lease.signal.throwIfAborted();
    const settled = await settleQa(workerId, qa, evaluated);
    if (settled === "passed") result.passed = 1;
    if (settled === "layout_passed") result.layoutPassed = 1;
    if (settled === "revision_queued") result.revisionQueued = 1;
    if (settled === "recapture_queued") result.recaptureQueued = 1;
    if (settled === "failed") result.failed = 1;
  } catch (error) {
    logError("theme studio: visual QA execution failed", error, {
      qaRunId: qa.id,
    });
    // ★ Our own inputs missing or unreadable: no retry can help, and it is
    // not the provider's failure. A model call that answered unusably was
    // still paid for: its usage is kept on the row through the retries and
    // in the closing report.
    const inputError = isReviewInputError(error);
    const usage = error instanceof ReviewCallError ? error.usage : null;
    await withServiceAndNotices(async (db) => {
      const held = await heldReview(db, qa.id, workerId);
      if (!held) return;
      const failedCalls = usage
        ? withFailedCall(held.visionReport, usage)
        : failedCallsOf(held.visionReport);
      const closing = { ...qa, visionReport: failedCalls };
      if (inputError) {
        await settleOnItsOwn(db, qa.id, "qa_input_missing", () =>
          revealFailed(db, closing, "qa_input_missing"),
        );
        result.failed = 1;
      } else if (held.attemptCount < held.maxAttempts) {
        // Claimable again after QA_RETRY_COOLDOWN_SECONDS (claimQa).
        await db
          .update(themeStudioVisualQaRuns)
          .set({
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            visionReport: failedCalls,
          })
          .where(eq(themeStudioVisualQaRuns.id, qa.id));
      } else {
        await settleOnItsOwn(db, qa.id, "qa_provider_failed", () =>
          revealFailed(db, closing, "qa_provider_failed"),
        );
        result.failed = 1;
      }
    });
  } finally {
    await lease.stop();
  }
  return result;
}

/** A layout check that only the review route may settle (its model is
 * switched off): left queued, so that route says why. */
class LeftForReviewRoute extends Error {}

/**
 * Settle a layout check the moment its capture finishes, inside the
 * capture's own finish (TS-3A, plan optimisation 2). A layout check is the
 * rule-based browser gates alone, never a model call, so it does not wait up
 * to a minute for the review tick, and it is not counted against the cap of
 * design reviews. One transaction claims exactly that row (SKIP LOCKED, so a
 * review worker that took it first keeps it) and settles it as the review
 * worker would. What it queues next starts nothing new: the photo run is the
 * run worker's, and a final capture is the one this capture job claims next.
 *
 * Answers what the settlement did, "closed" when the claim closed the row
 * (its project stopped generating, or its inputs are gone), or null when the
 * row is left queued for the review route (its job wake, or the minute
 * tick). Never throws.
 */
export async function settleThemeStudioLayoutCheck(
  qaRunId: string,
): Promise<SettleOutcome | "closed" | null> {
  const config = getThemeStudioConfig();
  if (!config.autoQaEnabled || !config.provider) return null;
  try {
    return await withServiceAndNotices(async (db) => {
      const [row] = await db
        .select()
        .from(themeStudioVisualQaRuns)
        .where(
          and(
            eq(themeStudioVisualQaRuns.id, qaRunId),
            eq(themeStudioVisualQaRuns.status, "queued"),
            LAYOUT_CHECK,
          ),
        )
        .for("update", { skipLocked: true })
        .limit(1);
      if (!row) return null;
      const workerId = randomUUID();
      const qa = await takeClaim(db, workerId, row);
      if (!qa) return "closed" as const;
      // Undoes this claim: the review route handles a switched-off model.
      if (config.disabledModels.has(qa.modelKey))
        throw new LeftForReviewRoute();
      return settleQaWithDb(
        db,
        workerId,
        qa,
        { report: null, usage: null },
        { startCaptureJob: false },
      );
    });
  } catch (error) {
    if (!(error instanceof LeftForReviewRoute))
      logError("theme studio: layout check left for the review route", error, {
        qaRunId,
      });
    return null;
  }
}

/**
 * The content-free count an alert watches (plan P6): design reviews waiting
 * to be claimed for over QA_WAITING_ALERT_MINUTES since they were queued.
 * Logged as `theme_studio.qa_waiting` only when there are some. Never throws.
 */
export async function logThemeStudioQaWaiting(): Promise<number> {
  try {
    const [row] = await withService((db) =>
      db
        .select({
          waiting: count(),
          oldestMinutes: sql<
            number | null
          >`floor(extract(epoch from (now() - min(${themeStudioVisualQaRuns.createdAt}))) / 60)::int`,
        })
        .from(themeStudioVisualQaRuns)
        .where(
          sql`(${themeStudioVisualQaRuns.status} = 'queued'
                OR (${themeStudioVisualQaRuns.status} = 'running'
                  AND ${themeStudioVisualQaRuns.leaseExpiresAt} <= now()))
              AND ${themeStudioVisualQaRuns.createdAt} <= now() - (${QA_WAITING_ALERT_MINUTES}::int * interval '1 minute')`,
        ),
    );
    const waiting = Number(row?.waiting ?? 0);
    if (waiting > 0)
      logWarn("theme_studio.qa_waiting", {
        waiting,
        oldestMinutes: row?.oldestMinutes ?? null,
        overMinutes: QA_WAITING_ALERT_MINUTES,
        cap: DESIGN_REVIEW_CAP,
      });
    return waiting;
  } catch (error) {
    logError("theme studio: waiting reviews could not be counted", error);
    return 0;
  }
}
