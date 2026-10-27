import { buildRevampDesignPreview } from "./preview";
import {
  REVAMP_WORK_BUDGET,
  revampFinishBy,
  revampRecovers,
} from "./pacing-policy";
import "server-only";

// ---------------------------------------------------------------------------
// The storefront revamp's job: the `mink_revamps` repository
// (docs/mink-storefront-revamp.md section 4; build spec section 3.7).
//
// One row per "customise my store". The start and refine tools create it, the
// runner claims, renews, saves and finishes it under a lease, the card reads
// it through the status route, and the sweep and the status poll keep a job
// moving with no scheduler of its own.
//
// ★★ ONE ACTIVE REVAMP PER STORE, AND THE FREE ONE, ARE DECIDED IN ONE
//   TRANSACTION under a per-store advisory lock. Two "customise my store"
//   messages a second apart serialise on the lock, so the second sees the
//   first's row and is refused; and because the free decision is read under
//   the same lock, two first revamps cannot both be free. The partial unique
//   index `mink_revamps_one_active_idx` is the backstop: its violation is
//   mapped to the same refusal, never surfaced as an error.
//
// ★★ EVERY RUNNER WRITE IS FENCED ON THE LEASE TOKEN, in the statement that
//   writes. A claim always mints a new token, so a matching token proves no
//   other invocation has claimed the job since; a runner whose lease was lost
//   (it hung past its lease and another invocation claimed) writes nothing at
//   all, because its single UPDATE matches no row. That is what lets a runner
//   die at any instant without leaving a half-written job.
//
// ★ A PARKED LEASE. The lease CHECK requires token and expiry together, so a
//   transient failure that must wait before the next claim keeps a lease with
//   a fixed token nobody holds (`PARKED_LEASE_TOKEN`). Nothing can renew or
//   save under it, a cancel takes effect at once, and the job becomes
//   claimable when the wait passes.
//
// ★★ A CLAIM IS NOT AN ATTEMPT (robustness audit B8). `attempts` counts the
//   step's real failures, written by the release that follows one. A wait on
//   Google (a 429, a held check, a paced start), a deadline hand-over of a
//   step that calls a model, and a claim whose process died with nothing
//   handed back (killed, restarted by a deploy, out of CPU once its request
//   hung up) cost nothing. What ends a job that never finishes is its
//   wall-clock ceiling (`REVAMP_RUN_CEILING_MS`) and the hard limits on what
//   it may spend; the same real error `maxAttempts` times still fails a step.
//
// ★★ A FAILED REDESIGN GIVES ITS DAY'S START BACK (robustness audit B5), once,
//   after the transaction that failed it commits (`settling`).
//
// ★ EVERY JSONB COLUMN IS READ DEFENSIVELY. A row an older revision wrote, or
//   one this revision cannot read, must never throw at the card: an unreadable
//   progress list is rebuilt from the step, an unreadable snapshot, plan or
//   result reads as null, and an unreadable request is failed at the claim
//   (the runner cannot build from it) while every other read gets the row with
//   an empty request.
//
// ★ SERVICE SCOPE, TENANT IN EVERY PREDICATE. Both revamp tables are
//   service-only, so every query here runs under `withService` and carries the
//   store id (and the admin id for a requester-scoped read) itself.
// ---------------------------------------------------------------------------

import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { can } from "@/app/dashboard/lib/permissions";
import {
  minkConversations,
  minkRevampImages,
  minkRevamps,
} from "@/drizzle/schema";
import { withService as withDatabaseService, type Db } from "@/lib/db/client";

/** Transaction-local protocol fences all writes, including old revision sweeps. */
function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return withDatabaseService(async (db) => {
    await db.execute(
      sql`select set_config('app.mink_revamp_recovery', '2', true)`,
    );
    return fn(db);
  });
}
import { isUniqueViolation, pgConstraint } from "@/lib/db/errors";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getMinkConfig } from "../config";
import { MinkRequestError, MinkToolInputError } from "../errors";
import { releaseSpendLimits, type SpendLimit } from "../spend-limits";
import type { PersonalizationCategoryChange } from "../storefront-personalization-contract";
import type { MinkActorContext } from "../types";
import {
  REVAMP_ERROR_CODES,
  REVAMP_ERROR_MESSAGES,
  REVAMP_KINDS,
  REVAMP_LIMITS,
  REVAMP_STATUSES,
  REVAMP_STEPS,
  initialRevampProgress,
  isRevampPlan,
  type RevampBrief,
  type RevampErrorCode,
  type RevampImageRole,
  type RevampKind,
  type RevampPhotoOutcome,
  type RevampProductInput,
  type RevampProgressItem,
  type RevampRedraw,
  type RevampRefineScope,
  type RevampRequest,
  type RevampSitePlan,
  type RevampSnapshot,
  type RevampStatus,
  type RevampStatusView,
  type RevampStep,
  type RevampStepState,
  type RevampStoredPlan,
} from "./contract";
import type { RevampDistinctReport } from "./distinctness";
import { listRevampImages, releaseRevampPhotos } from "./image-store";
import type { RevampUndoResult } from "./lifecycle-types";
import { storedPhotoUnit } from "./photo-hold";
import {
  ZERO_REVAMP_USAGE,
  type RevampCallCounts,
  type RevampPhotoHold,
  type RevampPhotoReviewState,
  type RevampPhotoReviews,
  type RevampUsage,
} from "./ports";
import { revampReadyEvent } from "./ready-notice";
import { toRevampReview } from "./review";
import { kickRevampRunner } from "./trigger";

// ---------------------------------------------------------------------------
// The row and its columns.
// ---------------------------------------------------------------------------

/** mink_revamps.plan, written by the runner. */
export type RevampPlanColumn =
  | {
      stage: "raw";
      raw: unknown;
      repairs: number;
      issues: string[];
      /**
       * ★★ A repair call failed (busy, timed out, refused or unreadable) and
       *   the runner finalised leniently from `raw` instead (L2-B), so the
       *   compile step never asks that repair again, however often it is
       *   claimed. Absent until a repair fails.
       */
      repairFailed?: boolean;
    }
  | {
      stage: "compiled";
      plan: RevampSitePlan;
      productPhotoKeys: string[] | null;
      /**
       * A paid revamp's plan before it was cut to its budget. ★ Kept so a
       * balance that falls before the photos are drawn is fitted afresh from
       * it (runner.ts): fitting the cut plan again would list what the first
       * fit left out a second time. Absent on a free or unmetered revamp, and
       * on a column written before it existed.
       */
      unfitted?: RevampSitePlan;
    };

/** mink_revamps.result, written by the runner. */
export interface RevampResultColumn {
  recoveryVersion?: 2;
  /** Performance target only; never a claim, charge or failure condition. */
  targetReadyAt?: number;
  /** Stored at creation, never extended by a claim or a checkpoint. */
  finishBy?: number;
  photos?: { outcomes: RevampPhotoOutcome[] };
  products?: {
    failed: Array<{ key: string; reason: string }>;
    /** Why a studio photo was drawn again, by product key (P0 diagnostics). */
    redraws?: Record<string, RevampRedraw[]>;
  };
  /** The v2 plan after assemble; replaced by the checked plan. */
  stored?: RevampStoredPlan;
  checked?: boolean;
  /**
   * ★★ The photo allowance the running step holds claimed and has not
   *   settled (jobs-3, photo-hold.ts): written by `holdRevampPhotos` before
   *   the first photo is drawn and cleared when the step gives back what it
   *   did not draw, so a runner that dies with a claim leaves it here for the
   *   next one to settle. Absent when nothing is held.
   */
  photoHold?: RevampPhotoHold;
  /**
   * ★★ The photo checks the photos step has asked (P0, photos.ts): written
   *   by `recordRevampPhotoReviews` as each check moves, so the next
   *   invocation carries on from them (tries, when each was first asked, a
   *   verdict once known) instead of starting over at every hand-over. Kept
   *   once the step is done, as the record of how its checks went.
   */
  photoReviews?: RevampPhotoReviews;
  /**
   * ★★ When the job was first claimed, in epoch milliseconds (robustness
   *   audit B8): the start of its `REVAMP_RUN_CEILING_MS`. Written by the
   *   claim and never moved after; `saveRevampStep` keeps the stored value
   *   whatever a step sends. Absent until the first claim.
   */
  firstClaimedAt?: number;
  /**
   * How many claims found the claim before them ended with nothing handed
   * back (the process was killed, restarted by a deploy, or lost its CPU),
   * counted by the claim for the logs and never against the job (B8).
   */
  interruptions?: number;
  /**
   * ★★ THE REDO MEMORY'S CHECK (robustness audit section 5, step 6): how far
   *   the compiled plan was from this store's earlier redesigns over its
   *   current theme, before and after `makeDistinct` (distinctness.ts), and
   *   which choices that changed. Numbers and closed words only (statuses,
   *   choice names, schemes, sides, heights, variants, pairing keys), never
   *   the store's words. Written by the compile step with the compiled plan;
   *   absent on a refinement and on a job compiled before the check existed.
   */
  distinctness?: RevampDistinctnessRecord;
}

/**
 * Why the redo memory's check could not run (`RevampDistinctnessRecord.reason`):
 * this store's earlier redesigns could not be read, or the registry could not
 * serve the store's theme. Either way the redesign went on unchanged.
 */
export const REVAMP_DISTINCTNESS_SKIPS = [
  "earlier_unreadable",
  "theme_unavailable",
] as const;
export type RevampDistinctnessSkip = (typeof REVAMP_DISTINCTNESS_SKIPS)[number];

/**
 * The check as the job keeps it (`result.distinctness`): `makeDistinct`'s own
 * report, or "skipped" with its reason when the check could not run.
 */
export type RevampDistinctnessRecord = Omit<
  RevampDistinctReport,
  "status" | "changed" | "kept"
> & {
  status: RevampDistinctReport["status"] | "skipped";
  reason?: RevampDistinctnessSkip;
  changed: Array<{ choice: string; from: string; to: string }>;
  kept: string[];
};

export interface RevampJobRow {
  id: string;
  storeId: string;
  adminId: string;
  requesterEmail: string | null;
  conversationId: string | null;
  originRunId: string | null;
  parentId: string | null;
  supersededBy: string | null;
  kind: RevampKind;
  status: RevampStatus;
  step: RevampStep;
  progress: RevampProgressItem[];
  request: RevampRequest;
  snapshot: RevampSnapshot | null;
  plan: RevampPlanColumn | null;
  result: RevampResultColumn | null;
  draftId: string | null;
  free: boolean;
  budgetCredits: number | null;
  credits: number;
  leaseToken: string | null;
  leaseUntil: string | null;
  attempts: number;
  maxAttempts: number;
  lastKickAt: string | null;
  cancelRequestedAt: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  appliedAt: string | null;
  publishedAt: string | null;
  undoneAt: string | null;
  applySnapshot: unknown;
  publishSnapshot: unknown;
  usage: RevampUsage;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** One revamp of a conversation, for the chat's revamp state reference. */
export interface RevampConversationEntry {
  id: string;
  kind: RevampKind;
  status: RevampStatus;
  draftId: string | null;
  summary: string | null;
  appliedAt: string | null;
  publishedAt: string | null;
  undoneAt: string | null;
  createdAt: string;
  /**
   * Stop was asked for and its runner has not stopped yet. ★ Read with the
   * list, so the chat tools tell "still being made" from "still stopping"
   * without a second read.
   */
  cancelRequested: boolean;
}

type RawRevampRow = typeof minkRevamps.$inferSelect;
type RevampUpdate = PgUpdateSetSource<typeof minkRevamps>;

const ACTIVE_STATUSES = ["queued", "running"] as const;
/**
 * A full revamp in one of these statuses holds the store's free revamp. A
 * failed or cancelled one gave nothing, so it does not use it up (product
 * spec section 6); a ready or superseded one did.
 *
 * ★ Exported because the chat tools read it to decide whether a budget is
 *   needed before the job exists; one list, so the two cannot drift.
 */
export const FREE_HOLDING_STATUSES = [
  "queued",
  "running",
  "ready",
  "superseded",
];
const ACTIVE_INDEX = "mink_revamps_one_active_idx";
/**
 * The token of a parked lease (a transient failure waiting before the next
 * claim). Fixed, so a parked job is recognisable; refused by every fenced write,
 * so nobody can renew or save under it.
 */
const PARKED_LEASE_TOKEN = "00000000-0000-4000-8000-000000000000";
/**
 * ★★ THE WALL-CLOCK CEILING ON ONE REVAMP: four hours from its first claim
 *   (robustness audit B8). Waits on Google and claims whose process died no
 *   longer count against the step, so this is what ends a job that never
 *   finishes: past it, the claim refuses the job and the status poll or the
 *   sweep fails it with `out_of_attempts` (detail `run_ceiling`).
 * ★ Why four hours. The slowest redesign measured end to end took 72 minutes
 *   (neem-ritual on 23 Oct, sharing Google's image line with another shop),
 *   and the audit's busy-evening estimate is under an hour a shop, so four
 *   hours is about three times the worst seen: room for a crowded pool, the
 *   start pacer and a deploy or two restarting the runner, and still a job
 *   that is truly stuck ends the same afternoon instead of polling forever.
 *   ★ It is also bounded in spend: about 13 invocations at the runner's
 *   18 minute deadline, each paid call still held to the hard limits (the
 *   store's 120 photos a day and the platform's 400 an hour, two planner
 *   calls an invocation, the card's credit ceiling).
 */
export const REVAMP_RUN_CEILING_MS = 4 * 60 * 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const MAX_ERROR_DETAIL = 2_000;
const MAX_PROGRESS_DETAIL = 120;
const MAX_SUMMARY = 280;
const CONVERSATION_ENTRIES = 5;
const SWEEP_SETTLE_LIMIT = 25;
const MAX_SWEEP_KICKS = 25;
const TREE_DEPTH_LIMIT = 50;
const EPOCH = new Date(0).toISOString();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// The day's starts.
// ---------------------------------------------------------------------------

/**
 * The store's daily redesign starts (docs/mink-storefront-revamp.md section
 * 12: six a day), defined once for the start tool that claims one and the job
 * code that gives a failed redesign's back (robustness audit B5), so the two
 * can never name different counters.
 */
export function revampStartLimit(storeId: string): SpendLimit {
  return {
    key: `mink-revamp-starts:${storeId}`,
    max: REVAMP_LIMITS.startsPerStorePerDay,
    windowSeconds: 86_400,
  };
}

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------

/**
 * Queue a revamp. Refused (not thrown) while the store already has one
 * building; `free` is decided here, under the store's lock, and never again.
 */
export async function createRevampJob(input: {
  actor: MinkActorContext;
  conversationId: string | null;
  kind: RevampKind;
  request: RevampRequest;
  parentId: string | null;
  budgetCredits: number | null;
}): Promise<
  | { ok: true; job: RevampJobRow }
  | { ok: false; reason: "active_exists"; activeId: string }
> {
  const { actor } = input;
  assertCreateAuthority(actor);
  if (!isRevampKind(input.kind)) {
    throw new MinkToolInputError("Choose a full redesign or a refinement.");
  }
  // ★ The request is read back with the same reader every later read uses, so
  //   a row this module cannot read is never written in the first place.
  const request = readRequest(input.request, input.kind);
  if (!request) {
    throw new MinkToolInputError(
      "The redesign request is incomplete. Gather the merchant's answers again.",
    );
  }
  const parentId = readParentId(input.kind, input.parentId);
  if (input.conversationId !== null && !isUuid(input.conversationId)) {
    throw new MinkToolInputError(
      "The conversation for this redesign is invalid.",
    );
  }
  const budgetCredits = readBudget(input.budgetCredits);

  // ★ Two attempts: a unique violation whose active job finished before the
  //   lookup leaves nothing to point at, and the honest answer then is to try
  //   once more, not to report a job that no longer exists.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withService((db) =>
        insertUnderStoreLock(db, {
          actor,
          kind: input.kind,
          request,
          parentId,
          conversationId: input.conversationId,
          budgetCredits,
        }),
      );
    } catch (error) {
      if (!isActiveIndexViolation(error)) throw error;
      const activeId = await findActiveRevampId(actor.storeId);
      if (activeId) {
        logInfo("mink.revamp: create refused by the active index", {
          storeId: actor.storeId,
          activeId,
        });
        return { ok: false, reason: "active_exists", activeId };
      }
    }
  }
  throw new MinkRequestError(
    "mink_revamp_busy",
    "Another redesign was starting at the same moment. Try again in a moment.",
    409,
  );
}

async function insertUnderStoreLock(
  db: Db,
  input: {
    actor: MinkActorContext;
    kind: RevampKind;
    request: RevampRequest;
    parentId: string | null;
    conversationId: string | null;
    budgetCredits: number | null;
  },
): Promise<
  | { ok: true; job: RevampJobRow }
  | { ok: false; reason: "active_exists"; activeId: string }
> {
  const { actor } = input;
  // ★ Per store, transaction-scoped: released at commit or rollback, so a
  //   crashed request can never leave a store locked.
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`mink-revamp:${actor.storeId}`}, 0))`,
  );
  const active = await db
    .select({ id: minkRevamps.id })
    .from(minkRevamps)
    .where(
      and(
        eq(minkRevamps.storeId, actor.storeId),
        inArray(minkRevamps.status, [...ACTIVE_STATUSES]),
      ),
    )
    .limit(1);
  if (active[0]) {
    return { ok: false, reason: "active_exists", activeId: active[0].id };
  }
  if (input.parentId) {
    // ★ A refinement builds on the requester's own revamp of THIS store. The
    //   parent's plan and photos are read by the runner, so a foreign parent
    //   id would carry another store's design into this one.
    const parent = await db
      .select({ id: minkRevamps.id })
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.id, input.parentId),
          eq(minkRevamps.storeId, actor.storeId),
          eq(minkRevamps.adminId, actor.adminId),
        ),
      )
      .limit(1);
    if (!parent[0]) {
      throw new MinkRequestError(
        "mink_revamp_parent_unavailable",
        "The redesign this refinement builds on is not available.",
        404,
      );
    }
  }
  if (input.conversationId) {
    const conversation = await db
      .select({ id: minkConversations.id })
      .from(minkConversations)
      .where(
        and(
          eq(minkConversations.id, input.conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
        ),
      )
      .limit(1);
    if (!conversation[0]) {
      throw new MinkRequestError(
        "mink_revamp_conversation_unavailable",
        "This conversation is not available for a redesign.",
        404,
      );
    }
  }
  let free = false;
  if (input.kind === "full") {
    const taken = await db
      .select({ id: minkRevamps.id })
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.storeId, actor.storeId),
          eq(minkRevamps.kind, "full"),
          eq(minkRevamps.free, true),
          inArray(minkRevamps.status, FREE_HOLDING_STATUSES),
        ),
      )
      .limit(1);
    free = !taken[0];
  }
  const inserted = await db
    .insert(minkRevamps)
    .values({
      id: crypto.randomUUID(),
      storeId: actor.storeId,
      adminId: actor.adminId,
      requesterEmail: normalizeEmail(actor.email),
      conversationId: input.conversationId,
      originRunId: actor.runId ?? null,
      parentId: input.parentId,
      kind: input.kind,
      status: "queued",
      step: "snapshot",
      progress: initialRevampProgress(),
      request: input.request,
      free,
      // ★ A free revamp has no budget at all: the DB CHECK refuses one, and a
      //   budget there would trim a free plan for a balance it never spends.
      budgetCredits: free ? null : input.budgetCredits,
      credits: 0,
      attempts: 0,
      maxAttempts: REVAMP_LIMITS.maxAttempts,
      usage: ZERO_REVAMP_USAGE,
      ...(input.kind === "full"
        ? {
            result: sql`jsonb_build_object('recoveryVersion', 2, 'targetReadyAt', floor(extract(epoch from now()) * 1000) + ${REVAMP_WORK_BUDGET.targetMs}::bigint)`,
          }
        : {}),
    })
    .returning();
  const parsed = inserted[0] ? parseRow(inserted[0]) : null;
  if (!parsed) throw new Error("mink_revamp_insert_unreadable");
  logInfo("mink.revamp: created", {
    revampId: parsed.row.id,
    storeId: actor.storeId,
    kind: input.kind,
    free,
  });
  return { ok: true, job: parsed.row };
}

/**
 * The store's one active revamp, if any. ★ Read by the chat tools before
 * they claim anything (storefront-revamp-tools.ts `queueRevamp`); the insert
 * above still decides a race under the store's lock.
 */
export async function findActiveRevampId(
  storeId: string,
): Promise<string | null> {
  const rows = await withService((db) =>
    db
      .select({ id: minkRevamps.id })
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.storeId, storeId),
          inArray(minkRevamps.status, [...ACTIVE_STATUSES]),
        ),
      )
      .limit(1),
  );
  return rows[0]?.id ?? null;
}

function isActiveIndexViolation(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  // pg names the violated index; the primary key is a random UUID, so an
  // unnamed unique violation on this insert is the active index too.
  const constraint = pgConstraint(error);
  return constraint === undefined || constraint === ACTIVE_INDEX;
}

function assertCreateAuthority(actor: MinkActorContext) {
  if (!actor.runId) {
    // ★ The card's draft belongs to the chat run that started the revamp; a
    //   job with no run could never produce one.
    throw new MinkToolInputError(
      "A redesign can be started only from an active Mink AI run.",
    );
  }
  if (!can(actor.permissions, "builder", "manage", actor.isSuperadmin)) {
    throw new MinkRequestError(
      "mink_revamp_access_denied",
      "Your role cannot change the Website Builder.",
      403,
    );
  }
  if (actor.draftingEnabled !== true) {
    throw new MinkRequestError(
      "mink_revamp_access_denied",
      "Mink AI drafting is not enabled for this store.",
      403,
    );
  }
}

function readParentId(
  kind: RevampKind,
  parentId: string | null,
): string | null {
  if (kind === "full") {
    if (parentId !== null) {
      throw new MinkToolInputError(
        "A full redesign does not build on another one.",
      );
    }
    return null;
  }
  if (!isUuid(parentId)) {
    throw new MinkToolInputError(
      "A refinement needs the redesign it builds on.",
    );
  }
  return parentId;
}

function readBudget(value: number | null): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MinkToolInputError("The redesign budget is invalid.");
  }
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// The lease.
// ---------------------------------------------------------------------------

/**
 * Claim one revamp for a runner invocation. Claimable while queued or running
 * with no cancel request, failures left, no live lease and inside its
 * wall-clock ceiling. A claim sets it running under a NEW token, for
 * `REVAMP_LIMITS.leaseMs`.
 *
 * ★★ THE CLAIM COUNTS NOTHING (robustness audit B8). It used to count an
 *   attempt, so a job whose process was killed, restarted by a deploy or left
 *   without CPU once the request that started it hung up spent one of its four
 *   claims on nothing, and the sweep that re-kicked it ran it out of attempts
 *   in the end: production is the first place a redesign runs after its start
 *   request hangs up. Only the release that follows a real failure counts
 *   (`releaseRevampLease`). The claim records when the job was first claimed,
 *   which starts its ceiling, and how many claims found the one before them
 *   gone with nothing handed back.
 */
export async function claimRevampJob(
  revampId: string,
): Promise<{ job: RevampJobRow; leaseToken: string } | null> {
  if (!isUuid(revampId)) return null;
  const leaseToken = crypto.randomUUID();
  const job = await settling(async (db, ready, failed) => {
    // ★ ONE CONDITIONAL UPDATE BY PRIMARY KEY. Two claims racing serialise on
    //   the row lock, and the loser's WHERE is re-checked against the winner's
    //   row, whose lease is now live, so exactly one invocation gets the job.
    const rows = await db
      .update(minkRevamps)
      .set({
        status: "running",
        leaseToken,
        leaseUntil: leaseUntilSql(),
        result: claimedResultSql(leaseToken),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(minkRevamps.id, revampId),
          inArray(minkRevamps.status, [...ACTIVE_STATUSES]),
          isNull(minkRevamps.cancelRequestedAt),
          sql`${minkRevamps.attempts} < ${minkRevamps.maxAttempts}`,
          sql`NOT ${pastCeilingSql()}`,
          claimableLeaseSql(),
        ),
      )
      .returning();
    const raw = rows[0];
    if (!raw) return null;
    const parsed = parseRow(raw);
    if (parsed?.requestReadable) return parsed.row;
    // ★★ A paid card is finished, never failed (`finishMadeCard`): its job
    //   needs nothing more from the request, and failing it would keep the
    //   charge. A revision that cannot read what a newer one wrote (a
    //   rollout's overlap) can claim such a job.
    if (await finishMadeCard(db, fenceSql(revampId, leaseToken), ready)) {
      return null;
    }
    // ★ Nothing can be built from a request this revision cannot read, and a
    //   job left running would be claimed and fail again until its attempts
    //   ran out. Fail it now, under the lease just taken.
    const unreadable = await db
      .update(minkRevamps)
      .set({
        status: "failed",
        errorCode: "internal",
        errorDetail: "unreadable_request",
        leaseToken: null,
        leaseUntil: null,
        progress: stoppedProgressSql(sql`${minkRevamps.progress}`),
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(fenceSql(revampId, leaseToken))
      .returning(failedStartColumns());
    noteFailedStart(failed, unreadable[0]);
    logError("mink.revamp: unreadable job failed at claim", null, {
      revampId,
      storeId: raw.storeId,
    });
    return null;
  });
  if (!job) return null;
  const clock = job.result?.firstClaimedAt;
  logInfo("mink.revamp: claimed", {
    revampId,
    storeId: job.storeId,
    step: job.step,
    // ★ The step's failures so far; this claim counts none (B8).
    failures: job.attempts,
    interruptions: job.result?.interruptions ?? 0,
    ...(typeof clock === "number"
      ? {
          minutesSinceFirstClaim: Math.max(
            0,
            Math.round((Date.now() - clock) / 60_000),
          ),
        }
      : {}),
  });
  return { job, leaseToken };
}

/**
 * Extend a held lease by `REVAMP_LIMITS.leaseMs`. `ok: false` means the lease
 * is gone (another invocation claimed, or the job left `running`): stop at
 * once and write nothing. Throws on a database error, which is not an answer
 * about the lease either way.
 */
export async function renewRevampLease(
  revampId: string,
  leaseToken: string,
): Promise<{ ok: boolean; cancelRequested: boolean }> {
  if (!isUuid(revampId) || !isHeldToken(leaseToken)) {
    return { ok: false, cancelRequested: false };
  }
  const rows = await withService((db) =>
    db
      .update(minkRevamps)
      .set({ leaseUntil: leaseUntilSql(), updatedAt: sql`now()` })
      .where(fenceSql(revampId, leaseToken))
      .returning({ cancelRequestedAt: minkRevamps.cancelRequestedAt }),
  );
  const row = rows[0];
  if (!row) return { ok: false, cancelRequested: false };
  return { ok: true, cancelRequested: row.cancelRequestedAt !== null };
}

/**
 * Give the lease back. With `retryAfterMs` (a transient failure) the job waits
 * that long before the next claim; without it the job is claimable at once (a
 * deadline hand-over). With `progressed` (a hand-over whose step stored new
 * photos this invocation, jobs-5) the step's failure count starts again.
 * `counted` says whether this hand-over is one of the step's failures (B8).
 * Best effort: a release that fails leaves the lease to expire on its own,
 * which delays the job and loses nothing.
 */
export async function releaseRevampLease(
  revampId: string,
  leaseToken: string,
  options: {
    retryAfterMs?: number;
    progressed?: boolean;
    /**
     * ★★ Whether this hand-over counts one failure against the step
     *   (robustness audit B8). Absent, a parked release (one that follows a
     *   failure) counts and a clean one (a deadline hand-over) does not. The
     *   runner says false for a wait on Google or on the platform's photo
     *   hour, and true for a deadline that caught a step which calls no model
     *   half way, which is stuck rather than waiting.
     */
    counted?: boolean;
    /**
     * ★★ What the job has spent, this invocation's calls included (L2-F):
     *   a step handed over before it returns has no save of its own, so its
     *   paid calls reach the row here, in the same fenced statement, or the
     *   next invocation starts from a total that never had them.
     */
    usage?: RevampUsage;
  } = {},
): Promise<void> {
  if (!isUuid(revampId) || !isHeldToken(leaseToken)) return;
  const retryAfterMs = boundedRetryAfter(options.retryAfterMs);
  const spent = options.usage ? { usage: readUsage(options.usage) } : {};
  // ★★ ONLY A REAL FAILURE COUNTS, AND IN THE SAME FENCED STATEMENT (B8), so a
  //   runner that lost its lease counts nothing: the claim no longer does, and
  //   `maxAttempts` failures of a step in a row still fail it.
  const counted = options.counted ?? retryAfterMs > 0;
  const failure = counted ? { attempts: sql`${minkRevamps.attempts} + 1` } : {};
  // ★★ A HAND-OVER THAT MADE PROGRESS IS NOT A FAILURE (jobs-5). A photos
  //   step that hands over at the deadline while storing photos each time is
  //   working, so the count goes back to 0 IN THE SAME FENCED STATEMENT, so a
  //   runner that lost its lease resets nothing. ★ Bounded: each reset needs
  //   a new image row, and a revamp's rows are unique per role and slot.
  try {
    await withService((db) =>
      db
        .update(minkRevamps)
        .set(
          retryAfterMs > 0
            ? {
                leaseToken: PARKED_LEASE_TOKEN,
                result: sql`${minkRevamps.result} || jsonb_strip_nulls(jsonb_build_object('deadlineLeaseToken', CASE WHEN jsonb_typeof(${minkRevamps.result} -> 'finishBy') = 'number' THEN to_jsonb(${PARKED_LEASE_TOKEN}::text) END, 'recoveryLeaseToken', CASE WHEN ${minkRevamps.result} -> 'recoveryVersion' = '2'::jsonb THEN to_jsonb(${PARKED_LEASE_TOKEN}::text) END))`,
                leaseUntil: sql`now() + (${retryAfterMs}::int * interval '1 millisecond')`,
                updatedAt: sql`now()`,
                // ★ A parked release follows a failure: it never gives the
                //   count back, progress or not.
                ...failure,
                ...spent,
              }
            : {
                leaseToken: null,
                leaseUntil: null,
                updatedAt: sql`now()`,
                ...(options.progressed === true ? { attempts: 0 } : failure),
                ...spent,
              },
        )
        .where(fenceSql(revampId, leaseToken)),
    );
  } catch (error) {
    logWarn("mink.revamp: lease release failed", {
      revampId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

// ---------------------------------------------------------------------------
// The runner's writes. All fenced on the lease token.
// ---------------------------------------------------------------------------

/**
 * Save one step's output and move the job to `step`. Returns false when the
 * lease is gone, in which case NOTHING was written (one fenced UPDATE).
 */
export async function saveRevampStep(input: {
  revampId: string;
  leaseToken: string;
  step: RevampStep;
  progress: RevampProgressItem[];
  patch: {
    snapshot?: RevampSnapshot;
    plan?: RevampPlanColumn;
    result?: RevampResultColumn;
    usage?: RevampUsage;
  };
}): Promise<boolean> {
  if (!isRevampStep(input.step)) throw new Error("invalid_revamp_step");
  if (!isUuid(input.revampId) || !isHeldToken(input.leaseToken)) return false;
  const set: RevampUpdate = {
    step: input.step,
    progress: readProgress(input.progress, input.step, "running"),
    // ★★ THE FAILURE COUNT IS PER STEP (lib/mink/workflows.ts learned this
    //   the hard way): a step that finished owes the next one nothing, so
    //   moving to a new step starts its count at 0 (B8: the claim counts
    //   nothing, so 0 and not the 1 a claim used to have spent). A step that
    //   fails `maxAttempts` times in a row still fails.
    attempts: sql`CASE WHEN ${minkRevamps.step} <> ${input.step} THEN 0 ELSE ${minkRevamps.attempts} END`,
    updatedAt: sql`now()`,
  };
  if (input.patch.snapshot !== undefined) set.snapshot = input.patch.snapshot;
  if (input.patch.plan !== undefined) set.plan = input.patch.plan;
  if (input.patch.result !== undefined) {
    set.result = keepingClaimFieldsSql(input.patch.result);
  }
  if (input.patch.usage !== undefined) set.usage = readUsage(input.patch.usage);
  const rows = await withService((db) =>
    db
      .update(minkRevamps)
      .set(set)
      .where(fenceSql(input.revampId, input.leaseToken))
      .returning({ id: minkRevamps.id }),
  );
  return rows.length === 1;
}

/** The running step's detail for the card ("7 of 24"). Best effort; never throws. */
export async function reportRevampProgress(
  revampId: string,
  leaseToken: string,
  progress: RevampProgressItem[],
): Promise<void> {
  if (!isUuid(revampId) || !isHeldToken(leaseToken)) return;
  try {
    await withService((db) =>
      db
        .update(minkRevamps)
        .set({ progress: readProgressInput(progress), updatedAt: sql`now()` })
        .where(fenceSql(revampId, leaseToken)),
    );
  } catch (error) {
    logWarn("mink.revamp: progress report failed", {
      revampId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * Record the photo allowance the running step holds claimed (jobs-3,
 * photo-hold.ts), or clear it with `hold: null`. ★ Only `result.photoHold`
 * moves: the rest of the column is the steps' own and is written by
 * saveRevampStep, so a claim recorded mid-step can never put back an older
 * copy of their outcomes. Returns false when the lease is gone, in which case
 * nothing was written (the next owner settles the claim from the record);
 * throws on a database error or a claim that could not be read back.
 */
export async function holdRevampPhotos(input: {
  revampId: string;
  leaseToken: string;
  hold: RevampPhotoHold | null;
}): Promise<boolean> {
  const hold = input.hold === null ? null : readPhotoHold(input.hold, true);
  if (input.hold !== null && !hold) throw new Error("invalid_photo_hold");
  if (!isUuid(input.revampId) || !isHeldToken(input.leaseToken)) return false;
  // A column that is not an object (absent, or written by something else)
  // is treated as empty rather than turned into an array by `||`.
  const column = sql`CASE WHEN jsonb_typeof(${minkRevamps.result}) = 'object' THEN ${minkRevamps.result} ELSE '{}'::jsonb END`;
  const result = hold
    ? sql`${column} || jsonb_build_object('photoHold', ${JSON.stringify(hold)}::jsonb)`
    : sql`${column} - 'photoHold'`;
  const rows = await withService((db) =>
    db
      .update(minkRevamps)
      .set({ result, updatedAt: sql`now()` })
      .where(fenceSql(input.revampId, input.leaseToken))
      .returning({ id: minkRevamps.id }),
  );
  return rows.length === 1;
}

/**
 * Record the photos step's photo checks (P0, `ctx.photoReviews`): the whole
 * record, replacing the last. ★ Only `result.photoReviews` moves, for
 * holdRevampPhotos' reason: the rest of the column is the steps' own. Returns
 * false when the lease is gone (nothing written); throws on a database error
 * or a record that could not be read back.
 */
export async function recordRevampPhotoReviews(input: {
  revampId: string;
  leaseToken: string;
  reviews: RevampPhotoReviews;
}): Promise<boolean> {
  const reviews = readPhotoReviews(input.reviews, true);
  if (!reviews) throw new Error("invalid_photo_reviews");
  if (!isUuid(input.revampId) || !isHeldToken(input.leaseToken)) return false;
  const column = sql`CASE WHEN jsonb_typeof(${minkRevamps.result}) = 'object' THEN ${minkRevamps.result} ELSE '{}'::jsonb END`;
  const rows = await withService((db) =>
    db
      .update(minkRevamps)
      .set({
        result: sql`${column} || jsonb_build_object('photoReviews', ${JSON.stringify(reviews)}::jsonb)`,
        updatedAt: sql`now()`,
      })
      .where(fenceSql(input.revampId, input.leaseToken))
      .returning({ id: minkRevamps.id }),
  );
  return rows.length === 1;
}

/**
 * The card exists: the job is ready. In the same transaction, the parent of a
 * refinement and every other ready, unapplied revamp of the same conversation
 * become superseded by this one, so a conversation never shows two live cards.
 * Returns false when the lease is gone (nothing written).
 */
export async function finishRevampReady(input: {
  revampId: string;
  leaseToken: string;
  draftId: string;
  credits: number;
  result: RevampResultColumn;
  usage: RevampUsage;
}): Promise<boolean> {
  if (!isUuid(input.revampId) || !isHeldToken(input.leaseToken)) return false;
  if (!isUuid(input.draftId)) throw new Error("invalid_revamp_draft");
  const credits = boundedCredits(input.credits);
  if (!readResultColumn(input.result, input.revampId)?.stored) {
    // A card with no readable stored plan still applies (E reads the draft),
    // but the review would be empty: worth knowing, not worth failing over.
    logWarn("mink.revamp: finished without a readable stored plan", {
      revampId: input.revampId,
    });
  }
  const finished = await withService(async (db) => {
    const rows = await db
      .update(minkRevamps)
      .set({
        status: "ready",
        step: "card",
        progress: doneProgressSql(sql`${minkRevamps.progress}`),
        draftId: input.draftId,
        // ★ A free revamp charges nothing, whatever the caller says: the DB
        //   CHECK would refuse anything else and roll the card's job back.
        credits: sql`CASE WHEN ${minkRevamps.free} THEN 0 ELSE ${credits}::int END`,
        result: input.result,
        usage: readUsage(input.usage),
        leaseToken: null,
        leaseUntil: null,
        errorCode: null,
        errorDetail: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(fenceSql(input.revampId, input.leaseToken))
      .returning({
        id: minkRevamps.id,
        storeId: minkRevamps.storeId,
        parentId: minkRevamps.parentId,
        conversationId: minkRevamps.conversationId,
      });
    const job = rows[0];
    if (!job) return null;
    const superseded = await supersedeForReady(db, job);
    return { storeId: job.storeId, superseded };
  });
  if (!finished) return false;
  logInfo("mink.revamp: ready", {
    revampId: input.revampId,
    storeId: finished.storeId,
    superseded: finished.superseded.length,
  });
  return true;
}

/**
 * Fail a job with a closed code. The detail is stored for the logs and never
 * shown; the card shows `REVAMP_ERROR_MESSAGES[code]`. With a lease token the
 * write is fenced on it; with `null` it applies only while no invocation holds
 * a live lease, so it can never fail a job another runner is working on.
 * "failed" when it failed the job, "ready" when the job's card was already
 * made and paid for and it was finished instead (`finishMadeCard`), null when
 * nothing was written.
 *
 * ★★ A paid card is finished, never failed. A runner that resumes a job at
 *   its card step can still fail it before any step runs (the requester lost
 *   the Website Builder since the card was made), and failing it then would
 *   keep the charge and orphan the draft: a failure that charged credits.
 */
export async function failRevampJob(input: {
  revampId: string;
  leaseToken: string | null;
  code: RevampErrorCode;
  detail: string;
  /**
   * The runner's total, when it spent something since its last save
   * (L2-F): a failure never charges credits, but StoreMink's own record of
   * what the job cost still counts every call it paid for.
   */
  usage?: RevampUsage;
}): Promise<"failed" | "ready" | null> {
  if (!isUuid(input.revampId)) return null;
  if (input.leaseToken !== null && !isHeldToken(input.leaseToken)) return null;
  const code = isRevampErrorCode(input.code) ? input.code : "internal";
  const where = input.leaseToken
    ? fenceSql(input.revampId, input.leaseToken)
    : and(
        eq(minkRevamps.id, input.revampId),
        inArray(minkRevamps.status, [...ACTIVE_STATUSES]),
        noLiveHolderSql(),
      );
  const settled = await settling(async (db, ready, failed) => {
    if (await finishMadeCard(db, where, ready)) return "ready" as const;
    const rows = await db
      .update(minkRevamps)
      .set({
        status: "failed",
        errorCode: code,
        errorDetail: boundedDetail(input.detail),
        leaseToken: null,
        leaseUntil: null,
        progress: stoppedProgressSql(sql`${minkRevamps.progress}`),
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
        ...(input.usage ? { usage: readUsage(input.usage) } : {}),
      })
      .where(where)
      .returning(failedStartColumns());
    noteFailedStart(failed, rows[0]);
    return rows[0] ? { storeId: rows[0].storeId } : null;
  });
  if (settled === "ready") return "ready";
  if (!settled) return null;
  logWarn("mink.revamp: failed", {
    revampId: input.revampId,
    storeId: settled.storeId,
    code,
  });
  return "failed";
}

/**
 * The runner saw a cancel request at its renewal: the job stops, cancelled,
 * unless its card was already made and paid for (an earlier invocation made
 * it and could not attach it), which finishes it as ready instead
 * (`finishMadeCard`). Null when the lease is gone and nothing was written.
 */
export async function markRevampCancelled(
  revampId: string,
  leaseToken: string,
  /** The runner's total, when it spent something since its last save (L2-F). */
  usage?: RevampUsage,
): Promise<"cancelled" | "ready" | null> {
  if (!isUuid(revampId) || !isHeldToken(leaseToken)) return null;
  return settling(async (db, ready) => {
    const fence = fenceSql(revampId, leaseToken);
    if (await finishMadeCard(db, fence, ready)) return "ready";
    const rows = await db
      .update(minkRevamps)
      .set({
        ...cancelledSet(),
        ...(usage ? { usage: readUsage(usage) } : {}),
      })
      .where(fence)
      .returning({ id: minkRevamps.id });
    return rows.length === 1 ? "cancelled" : null;
  });
}

// ---------------------------------------------------------------------------
// The requester's actions and reads.
// ---------------------------------------------------------------------------

/**
 * Stop a revamp for its requester. Queued (or running with no live lease, so
 * nobody would see a request) is cancelled at once; running under a live lease
 * records the request, which the runner sees at its next renewal. A finished
 * revamp is returned unchanged. Null when it is not the requester's.
 *
 * ★ No permission beyond being the requester: stopping only ever reduces what
 *   happens, so a role that lost the Website Builder can still stop its own
 *   build (the POS `revokeDevice` reasoning).
 * ★★ A card already made and paid for is finished as ready, never cancelled
 *   (`finishMadeCard`): the stop came too late to save the merchant anything.
 */
export async function cancelRevamp(
  actor: MinkActorContext,
  revampId: string,
): Promise<RevampStatusView | null> {
  if (!isUuid(revampId)) return null;
  const row = await settling(async (db, ready) => {
    const settleable = and(
      ownedSql(actor, revampId),
      sql`(${minkRevamps.status} = 'queued' OR (${minkRevamps.status} = 'running' AND ${noLiveHolderSql()}))`,
    );
    const made = await finishMadeCard(db, settleable, ready);
    if (made) return made;
    const now = await db
      .update(minkRevamps)
      .set(cancelledSet())
      .where(settleable)
      .returning();
    if (now[0]) return now[0];
    const requested = await db
      .update(minkRevamps)
      .set({
        cancelRequestedAt: sql`coalesce(${minkRevamps.cancelRequestedAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(and(ownedSql(actor, revampId), eq(minkRevamps.status, "running")))
      .returning();
    if (requested[0]) return requested[0];
    const current = await db
      .select()
      .from(minkRevamps)
      .where(ownedSql(actor, revampId))
      .limit(1);
    return current[0] ?? null;
  });
  if (!row) return null;
  const parsed = parseRow(row);
  if (!parsed) return null;
  logInfo("mink.revamp: cancel", {
    revampId,
    storeId: actor.storeId,
    status: parsed.row.status,
    requested: parsed.row.cancelRequestedAt !== null,
  });
  return toStatusView(parsed.row);
}

/** The runner's read: by id, with no requester scope (the runner has none). */
export async function readRevampJob(
  revampId: string,
): Promise<RevampJobRow | null> {
  if (!isUuid(revampId)) return null;
  const rows = await withService((db) =>
    db.select().from(minkRevamps).where(eq(minkRevamps.id, revampId)).limit(1),
  );
  return rows[0] ? (parseRow(rows[0])?.row ?? null) : null;
}

/**
 * The redesigns a merchant saw: a card that is or was in the chat. A failed,
 * stopped or unfinished one showed nobody a design.
 */
const EARLIER_DESIGN_STATUSES = ["ready", "superseded"] as const;
/** The most earlier plans one read returns, whatever a caller asks for. */
const EARLIER_PLANS_CEILING = 10;

/**
 * ★★ THIS STORE'S OWN EARLIER REDESIGNS, FOR THE REDO MEMORY (robustness
 * audit section 5, step 6): the plans of its redesigns a merchant saw (a card
 * that is ready or was superseded) whose plan is compiled, newest first, at
 * most `limit`, never the job asking. The runner summarises them for the
 * planner and measures the new plan against them (distinctness.ts).
 * ★★ THE STORE ID IS IN THE PREDICATE: never another store's plan, words,
 *   names or photos (step 7 of the audit, memory across stores, is not
 *   approved).
 * ★ NARROW: only the plan the card showed (`plan -> 'plan'`), never the
 *   request, snapshot or result, nor the copy kept from before a budget fit,
 *   so five earlier redesigns stay one small read on `mink_revamps_store_idx`.
 *   A full redesign and a refinement count alike: both are designs the
 *   merchant saw.
 */
export async function readEarlierRevampPlans(input: {
  storeId: string;
  revampId: string;
  limit: number;
}): Promise<unknown[]> {
  if (!isUuid(input.storeId) || !isUuid(input.revampId)) return [];
  const limit = Number.isFinite(input.limit)
    ? Math.min(EARLIER_PLANS_CEILING, Math.max(0, Math.floor(input.limit)))
    : 0;
  if (limit === 0) return [];
  const rows = await withService((db) =>
    db
      .select({ plan: sql<unknown>`${minkRevamps.plan} -> 'plan'` })
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.storeId, input.storeId),
          ne(minkRevamps.id, input.revampId),
          inArray(minkRevamps.status, [...EARLIER_DESIGN_STATUSES]),
          sql`${minkRevamps.plan} ->> 'stage' = 'compiled'`,
        ),
      )
      .orderBy(desc(minkRevamps.createdAt), desc(minkRevamps.id))
      .limit(limit),
  );
  return rows.flatMap((row) => (record(row.plan) ? [row.plan] : []));
}

/** The requester's read: the store AND the admin must both match. */
export async function readRevampForActor(
  actor: MinkActorContext,
  revampId: string,
): Promise<RevampJobRow | null> {
  if (!isUuid(revampId)) return null;
  const rows = await withService((db) =>
    db.select().from(minkRevamps).where(ownedSql(actor, revampId)).limit(1),
  );
  return rows[0] ? (parseRow(rows[0])?.row ?? null) : null;
}

/**
 * What the card shows. A job nobody is working on that has used up its
 * attempts, or run past its wall-clock ceiling (B8), is failed here with
 * `out_of_attempts`, and one whose stop request no runner will ever see is
 * cancelled here, so a card never polls a job that cannot move. Null when the
 * revamp is not the requester's.
 */
/** Read the compiled design only for its requester, on demand, never in polling. */
export async function readRevampDesignPreview(
  actor: MinkActorContext,
  revampId: string,
) {
  if (!isUuid(revampId)) return null;
  if (!can(actor.permissions, "builder", "view", actor.isSuperadmin))
    throw new MinkRequestError(
      "mink_revamp_access_denied",
      "You no longer have permission to view this redesign.",
      403,
    );
  const rows = await withService((db) =>
    db.select().from(minkRevamps).where(ownedSql(actor, revampId)).limit(1),
  );
  const row = rows[0] ? parseRow(rows[0])?.row : null;
  if (
    !row ||
    !ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number]) ||
    row.cancelRequestedAt ||
    row.plan?.stage !== "compiled" ||
    !row.snapshot ||
    (!revampRecovers(row.result) &&
      row.result?.finishBy &&
      row.result.finishBy <= Date.now())
  )
    return null;
  const images = await listRevampImages(revampId, actor.storeId);
  return buildRevampDesignPreview({
    revampId,
    request: row.request,
    snapshot: row.snapshot,
    plan: row.plan.plan,
    images,
    outcomes: [],
    productFailures: [],
    free: row.free,
    canChangeBrand: can(
      actor.permissions,
      "branding",
      "manage",
      actor.isSuperadmin,
    ),
  });
}

export async function readRevampStatus(
  actor: MinkActorContext,
  revampId: string,
): Promise<RevampStatusView | null> {
  if (!isUuid(revampId)) return null;
  // ★ The review carries the proposed pages and chrome, which are Website
  //   Builder content: a requester who lost the Builder no longer reads them.
  if (!can(actor.permissions, "builder", "view", actor.isSuperadmin)) {
    throw new MinkRequestError(
      "mink_revamp_access_denied",
      "You no longer have permission to view this redesign.",
      403,
    );
  }
  const row = await settling(async (db, ready, failed) => {
    const rows = await db
      .select({
        ...getTableColumns(minkRevamps),
        noLiveHolder: sql<boolean>`${noLiveHolderSql()}`,
        pastCeiling: sql<boolean>`${pastCeilingSql()}`,
      })
      .from(minkRevamps)
      .where(ownedSql(actor, revampId))
      .limit(1);
    const found = rows[0];
    if (!found) return null;
    const active = (ACTIVE_STATUSES as readonly string[]).includes(
      found.status,
    );
    if (!active || found.noLiveHolder !== true) return found;
    if (revampRecovers(record(found.result)) && found.step === "card") {
      const made = await finishMadeCard(
        db,
        and(
          ownedSql(actor, revampId),
          inArray(minkRevamps.status, [...ACTIVE_STATUSES]),
          noLiveHolderSql(),
        ),
        ready,
      );
      if (made) return made;
    }
    if (found.cancelRequestedAt) {
      const settleable = and(
        ownedSql(actor, revampId),
        inArray(minkRevamps.status, [...ACTIVE_STATUSES]),
        noLiveHolderSql(),
      );
      // ★★ A paid card is finished, never cancelled (`finishMadeCard`).
      const made = await finishMadeCard(db, settleable, ready);
      if (made) return made;
      const settled = await db
        .update(minkRevamps)
        .set(cancelledSet())
        .where(settleable)
        .returning();
      return settled[0] ?? found;
    }
    if (found.attempts >= found.maxAttempts || found.pastCeiling === true) {
      const settleable = and(
        ownedSql(actor, revampId),
        inArray(minkRevamps.status, [...ACTIVE_STATUSES]),
        runEndedSql(),
        noLiveHolderSql(),
      );
      // ★★ A paid card is finished, never failed (`finishMadeCard`).
      const made = await finishMadeCard(db, settleable, ready);
      if (made) return made;
      const settled = await db
        .update(minkRevamps)
        .set(exhaustedSet())
        .where(settleable)
        .returning();
      if (settled[0]) {
        noteFailedStart(failed, settled[0]);
        logWarn("mink.revamp: failed after its attempts or its time ran out", {
          revampId,
          storeId: actor.storeId,
          reason: settled[0].errorDetail ?? "attempts_exhausted",
        });
      }
      return settled[0] ?? found;
    }
    return found;
  });
  if (!row) return null;
  // ★★ A finished job that still records a photo claim lost its runner with
  //   the claim (jobs-3); on dev, with no sweep, this read is what gives it
  //   back.
  if (
    !(ACTIVE_STATUSES as readonly string[]).includes(row.status) &&
    record(record(row.result)?.photoHold)
  ) {
    await settleFinishedPhotoHolds({ revampId, storeId: actor.storeId });
  }
  const parsed = parseRow(row);
  return parsed ? toStatusView(parsed.row) : null;
}

/**
 * Kick the runner for a job that is waiting with nobody working on it, at most
 * once per `REVAMP_LIMITS.kickCooldownMs` per job. The cooldown is CLAIMED by a
 * conditional update of `last_kick_at`, so many polling tabs (or the poll and
 * the sweep) send one kick between them. Never throws.
 */
export async function kickRevampIfStalled(revampId: string): Promise<boolean> {
  if (!isUuid(revampId)) return false;
  let claimed = false;
  try {
    const rows = await withService((db) =>
      db
        .update(minkRevamps)
        .set({ lastKickAt: sql`now()` })
        .where(and(eq(minkRevamps.id, revampId), stalledSql()))
        .returning({ id: minkRevamps.id }),
    );
    claimed = rows.length === 1;
  } catch (error) {
    logWarn("mink.revamp: stall check failed", {
      revampId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return false;
  }
  if (!claimed) return false;
  await kickRevampRunner(revampId);
  return true;
}

/**
 * A runner process just freed its revamp slot (runner.ts
 * `REVAMP_RUNS_PER_PROCESS`) after turning a kick away: kick the oldest
 * revamp waiting for a runner, never `exceptRevampId` (the one that ran).
 * Returns how many it kicked. Never throws.
 *
 * ★ NOT held to the poll's kick cooldown: the kick that was turned away a
 *   moment ago claimed that cooldown, and it is exactly the job this hands
 *   the slot to. A redundant kick costs nothing (the claim is atomic).
 */
export async function kickWaitingRevamp(
  exceptRevampId: string,
): Promise<number> {
  if (!getMinkConfig().enabled) return 0;
  const except = isUuid(exceptRevampId)
    ? exceptRevampId
    : "00000000-0000-0000-0000-000000000000";
  let ids: string[];
  try {
    const rows = await withService((db) =>
      db.execute(sql`
        WITH candidate AS (
          SELECT id FROM public.mink_revamps
          WHERE status IN ('queued', 'running')
            AND cancel_requested_at IS NULL
            AND attempts < max_attempts
            AND NOT ${pastCeilingRawSql()}
            AND (lease_until IS NULL OR lease_until <= now())
            AND id <> ${except}::uuid
          ORDER BY coalesce(lease_until, created_at), id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public.mink_revamps AS r
        SET last_kick_at = now()
        FROM candidate
        WHERE r.id = candidate.id
        RETURNING r.id
      `),
    );
    ids = rows.rows
      .map((row) => (row as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");
  } catch (error) {
    logWarn("mink.revamp: waiting revamp could not be found", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return 0;
  }
  await Promise.all(ids.map((id) => kickRevampRunner(id)));
  return ids.length;
}

/**
 * The production minute heartbeat's pass: fail jobs whose attempts or whose
 * wall-clock ceiling ran out (B8), cancel jobs whose stop request no runner
 * will see, and kick up to `limit` stalled jobs (one kick each), which
 * resumes a job whose runner died at the step it had saved. Bounded, and a
 * no-op while Mink AI is switched off.
 */
export async function sweepStalledRevamps(
  limit = 5,
): Promise<{ kicked: number; failed: number }> {
  if (!getMinkConfig().enabled) return { kicked: 0, failed: 0 };
  const kicks = Math.max(
    1,
    Math.min(MAX_SWEEP_KICKS, Number.isFinite(limit) ? Math.trunc(limit) : 5),
  );
  const { failed, cancelled, kickIds } = await settling(
    async (db, ready, starts) => {
      // ★★ First, the jobs whose card was made and paid for and that would be
      //   failed or cancelled below: they are finished as ready with their card
      //   (`finishMadeCard`), and both statements below leave them alone.
      const madeCards = await db
        .select({ id: minkRevamps.id })
        .from(minkRevamps)
        .where(settleableMadeCardSql())
        .orderBy(minkRevamps.id)
        .limit(SWEEP_SETTLE_LIMIT)
        .for("update", { skipLocked: true });
      for (const { id } of madeCards) {
        await finishMadeCard(
          db,
          and(eq(minkRevamps.id, id), settleableMadeCardSql()),
          ready,
        );
      }
      const exhausted = await db.execute(sql`
      WITH candidate AS (
        SELECT id FROM public.mink_revamps
        WHERE status IN ('queued', 'running')
          AND cancel_requested_at IS NULL
          AND (attempts >= max_attempts OR ${pastCeilingRawSql()})
          AND ${noLiveHolderRawSql()}
          AND NOT ${madeCardRawSql()}
        ORDER BY lease_until NULLS FIRST, id
        LIMIT ${SWEEP_SETTLE_LIMIT}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.mink_revamps AS r
      SET status = 'failed',
          error_code = 'out_of_attempts',
          error_detail = CASE WHEN r.attempts >= r.max_attempts THEN 'attempts_exhausted' ELSE 'run_ceiling' END,
          lease_token = NULL,
          lease_until = NULL,
          progress = ${stoppedProgressSql(sql.raw("r.progress"))},
          finished_at = now(),
          updated_at = now()
      FROM candidate
      WHERE r.id = candidate.id
      RETURNING r.id, r.store_id, r.created_at::text AS created_at
    `);
      // ★★ Each failed here gives its day's start back once committed (B5).
      for (const row of exhausted.rows) {
        const failedRow = row as {
          id?: unknown;
          store_id?: unknown;
          created_at?: unknown;
        };
        noteFailedStart(starts, {
          id: failedRow.id,
          storeId: failedRow.store_id,
          createdAt: failedRow.created_at,
          cancelRequestedAt: null,
        });
      }
      const stopped = await db.execute(sql`
      WITH candidate AS (
        SELECT id FROM public.mink_revamps
        WHERE status IN ('queued', 'running')
          AND cancel_requested_at IS NOT NULL
          AND ${noLiveHolderRawSql()}
          AND NOT ${madeCardRawSql()}
        ORDER BY lease_until NULLS FIRST, id
        LIMIT ${SWEEP_SETTLE_LIMIT}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.mink_revamps AS r
      SET status = 'cancelled',
          error_code = 'cancelled',
          lease_token = NULL,
          lease_until = NULL,
          progress = ${stoppedProgressSql(sql.raw("r.progress"))},
          finished_at = now(),
          updated_at = now()
      FROM candidate
      WHERE r.id = candidate.id
      RETURNING r.id
    `);
      const stalled = await db.execute(sql`
      WITH candidate AS (
        SELECT id FROM public.mink_revamps
        WHERE status IN ('queued', 'running')
          AND cancel_requested_at IS NULL
          AND attempts < max_attempts
          AND NOT ${pastCeilingRawSql()}
          AND (lease_until IS NULL OR lease_until <= now())
          AND coalesce(last_kick_at, created_at) <= now() - (${REVAMP_LIMITS.kickCooldownMs}::int * interval '1 millisecond')
        ORDER BY coalesce(lease_until, created_at), id
        LIMIT ${kicks}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.mink_revamps AS r
      SET last_kick_at = now()
      FROM candidate
      WHERE r.id = candidate.id
      RETURNING r.id
    `);
      return {
        failed: exhausted.rows.length,
        cancelled: stopped.rows.length,
        kickIds: stalled.rows
          .map((row) => (row as { id?: unknown }).id)
          .filter((id): id is string => typeof id === "string"),
      };
    },
  );
  // Each kick is bounded at five seconds and never throws, so they go out
  // together rather than one after another inside the heartbeat.
  await Promise.all(kickIds.map((id) => kickRevampRunner(id)));
  await settleFinishedPhotoHolds();
  if (failed || cancelled || kickIds.length) {
    logInfo("mink.revamp: sweep", {
      failed,
      cancelled,
      kicked: kickIds.length,
    });
  }
  return { kicked: kickIds.length, failed };
}

/**
 * ★★ Give back the photo claim a FINISHED job still records (jobs-3,
 *   photo-hold.ts): its runner died holding the claim, and the job then
 *   ended without another invocation of the step that made it (a Stop,
 *   attempts that ran out, a failure someone else settled). The units no
 *   stored image row covers were never drawn and go back. The record is
 *   cleared by the statement that reads it, under a row lock, before anything
 *   is given back, so two settlers give a claim back once between them.
 * ★ A queued or running job is never touched: its runner settles its own
 *   claim, at the start of the step or as it ends.
 * Bounded, best effort; never throws. Returns how many photos went back.
 */
export async function settleFinishedPhotoHolds(
  scope: { revampId: string; storeId: string } | null = null,
): Promise<number> {
  if (scope && (!isUuid(scope.revampId) || !isUuid(scope.storeId))) return 0;
  let owed: Array<{ revampId: string; storeId: string; unused: number }>;
  try {
    owed = await withService(async (db) => {
      const settled = await db.execute(sql`
        WITH candidate AS (
          SELECT id, store_id, result -> 'photoHold' AS hold
          FROM public.mink_revamps
          WHERE status IN ('failed', 'cancelled', 'ready', 'superseded')
            AND jsonb_typeof(result -> 'photoHold') = 'object'
            ${scope ? sql`AND id = ${scope.revampId}::uuid AND store_id = ${scope.storeId}::uuid` : sql``}
          ORDER BY id
          LIMIT ${SWEEP_SETTLE_LIMIT}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public.mink_revamps AS r
        SET result = r.result - 'photoHold',
            updated_at = now()
        FROM candidate
        WHERE r.id = candidate.id
        RETURNING r.id, candidate.store_id, candidate.hold
      `);
      const out: Array<{ revampId: string; storeId: string; unused: number }> =
        [];
      for (const raw of settled.rows) {
        const row = raw as { id?: unknown; store_id?: unknown; hold?: unknown };
        if (typeof row.id !== "string" || typeof row.store_id !== "string") {
          continue;
        }
        const hold = readPhotoHold(row.hold, false);
        if (!hold) continue;
        const images = await db
          .select({
            role: minkRevampImages.role,
            slotId: minkRevampImages.slotId,
          })
          .from(minkRevampImages)
          .where(
            and(
              eq(minkRevampImages.revampId, row.id),
              eq(minkRevampImages.storeId, row.store_id),
            ),
          );
        // ★ A photo parked for its review (`<shot>~review`) covers its
        //   shot's unit, as the photos step reads it.
        const present = new Set(
          images.map((image) =>
            storedPhotoUnit({
              role: image.role as RevampImageRole,
              slotId: image.slotId,
            }),
          ),
        );
        const unused = hold.units.filter((unit) => !present.has(unit)).length;
        if (unused > 0) {
          out.push({ revampId: row.id, storeId: row.store_id, unused });
        }
      }
      return out;
    });
  } catch (error) {
    logWarn("mink.revamp: finished photo claims could not be settled", {
      revampId: scope?.revampId ?? null,
      error: error instanceof Error ? error.message : "unknown",
    });
    return 0;
  }
  let given = 0;
  for (const entry of owed) {
    // Never throws: a give-back that fails costs the store a few photos of
    // today's allowance, and the record is already cleared.
    await releaseRevampPhotos(entry.storeId, entry.unused);
    given += entry.unused;
    logInfo("mink.revamp: gave back a finished job's photo claim", {
      revampId: entry.revampId,
      storeId: entry.storeId,
      photos: entry.unused,
    });
  }
  return given;
}

/** A conversation's revamps for its state reference: newest first, at most five. */
export async function listConversationRevamps(input: {
  storeId: string;
  adminId: string;
  conversationId: string;
}): Promise<RevampConversationEntry[]> {
  if (
    !isUuid(input.storeId) ||
    !isUuid(input.conversationId) ||
    typeof input.adminId !== "string" ||
    input.adminId === ""
  ) {
    return [];
  }
  const rows = await withService((db) =>
    db
      .select({
        id: minkRevamps.id,
        kind: minkRevamps.kind,
        status: minkRevamps.status,
        draftId: minkRevamps.draftId,
        appliedAt: minkRevamps.appliedAt,
        publishedAt: minkRevamps.publishedAt,
        undoneAt: minkRevamps.undoneAt,
        createdAt: minkRevamps.createdAt,
        // ★ Read in SQL so the list never loads a snapshot or a plan just to
        //   print one line about it.
        summary: sql<
          string | null
        >`coalesce(${minkRevamps.result} -> 'stored' ->> 'summary', ${minkRevamps.plan} -> 'plan' ->> 'summary')`,
        cancelRequested: sql<boolean>`${minkRevamps.cancelRequestedAt} is not null`,
      })
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.storeId, input.storeId),
          eq(minkRevamps.adminId, input.adminId),
          eq(minkRevamps.conversationId, input.conversationId),
        ),
      )
      .orderBy(desc(minkRevamps.createdAt), desc(minkRevamps.id))
      .limit(CONVERSATION_ENTRIES),
  );
  return rows.flatMap((row): RevampConversationEntry[] => {
    if (!isRevampKind(row.kind) || !isRevampStatus(row.status)) return [];
    return [
      {
        id: row.id,
        kind: row.kind,
        status: row.status,
        draftId: row.draftId,
        summary: boundedSummary(row.summary),
        appliedAt: stamp(row.appliedAt),
        publishedAt: stamp(row.publishedAt),
        undoneAt: stamp(row.undoneAt),
        createdAt: stamp(row.createdAt) ?? EPOCH,
        cancelRequested: row.cancelRequested === true,
      },
    ];
  });
}

/**
 * How many refinements the revamp tree holds, every generation under the same
 * root (any member of the tree may be passed). A refinement that failed or was
 * cancelled built no version, so it does not count against
 * `REVAMP_LIMITS.maxRefinements`.
 */
export async function countRefinements(rootId: string): Promise<number> {
  if (!isUuid(rootId)) return 0;
  const result = await withService((db) =>
    db.execute(sql`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, store_id, 0 AS depth
        FROM public.mink_revamps
        WHERE id = ${rootId}::uuid
        UNION ALL
        SELECT p.id, p.parent_id, p.store_id, up.depth + 1
        FROM public.mink_revamps p
        JOIN up ON p.id = up.parent_id AND p.store_id = up.store_id
        WHERE up.depth < ${TREE_DEPTH_LIMIT}
      ),
      root AS (
        SELECT id, store_id FROM up ORDER BY depth DESC LIMIT 1
      ),
      down AS (
        SELECT r.id, r.store_id, r.status, 0 AS depth
        FROM public.mink_revamps r
        JOIN root ON r.parent_id = root.id AND r.store_id = root.store_id
        WHERE r.kind = 'refine'
        UNION ALL
        SELECT r.id, r.store_id, r.status, down.depth + 1
        FROM public.mink_revamps r
        JOIN down ON r.parent_id = down.id AND r.store_id = down.store_id
        WHERE r.kind = 'refine' AND down.depth < ${TREE_DEPTH_LIMIT}
      )
      SELECT count(*)::int AS count
      FROM down
      WHERE status NOT IN ('failed', 'cancelled')
    `),
  );
  const value = Number(
    (result.rows[0] as { count?: unknown } | undefined)?.count,
  );
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** E: the ready job behind a card's draft, in this store. */
export async function findReadyRevampByDraft(
  storeId: string,
  draftId: string,
): Promise<RevampJobRow | null> {
  if (!isUuid(storeId) || !isUuid(draftId)) return null;
  const rows = await withService((db) =>
    db
      .select()
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.storeId, storeId),
          eq(minkRevamps.draftId, draftId),
          eq(minkRevamps.status, "ready"),
        ),
      )
      .orderBy(desc(minkRevamps.createdAt))
      .limit(1),
  );
  return rows[0] ? (parseRow(rows[0])?.row ?? null) : null;
}

// ---------------------------------------------------------------------------
// The status view.
// ---------------------------------------------------------------------------

function toStatusView(row: RevampJobRow): RevampStatusView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    draftId: row.draftId,
    error: errorSentence(row),
    appliedAt: row.appliedAt,
    publishedAt: row.publishedAt,
    undoneAt: row.undoneAt,
    review: reviewOf(row),
    design: {
      ready:
        (row.status === "running" || row.status === "queued") &&
        row.plan?.stage === "compiled" &&
        row.snapshot !== null,
      photosIn:
        row.result?.photos?.outcomes.filter(
          (outcome) => outcome.status === "generated",
        ).length ?? 0,
      photosTotal:
        row.plan?.stage === "compiled" ? row.plan.plan.shots.length : 0,
    },
    supersededBy: row.supersededBy,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    waiting:
      (row.status === "running" || row.status === "queued") &&
      row.leaseToken === PARKED_LEASE_TOKEN &&
      row.leaseUntil !== null &&
      Date.parse(row.leaseUntil) > Date.now(),
    cancelRequested: row.cancelRequestedAt !== null,
    undo: row.undoneAt === null ? null : undoAnswer(row.applySnapshot),
  };
}

/**
 * Undo's own answer (`apply_snapshot.undo`, lifecycle-types.ts), so a card
 * opened after the Undo still says what came back and what was kept.
 * ★ Read defensively, and null when its shape cannot be read: an empty
 *   answer would read as "nothing was put back", which is a claim.
 */
function undoAnswer(snapshot: unknown): RevampUndoResult | null {
  const undo = record(record(snapshot)?.undo);
  if (!undo || !Array.isArray(undo.restored) || !Array.isArray(undo.kept)) {
    return null;
  }
  const restored = undo.restored.filter(
    (label): label is string =>
      typeof label === "string" && label.trim() !== "",
  );
  const kept = undo.kept.flatMap((entry) => {
    const line = record(entry);
    return line &&
      typeof line.label === "string" &&
      typeof line.reason === "string"
      ? [{ label: line.label, reason: line.reason }]
      : [];
  });
  return { restored, kept };
}

function errorSentence(row: RevampJobRow): string | null {
  if (row.status === "cancelled") return REVAMP_ERROR_MESSAGES.cancelled;
  if (row.status !== "failed") return null;
  if (row.errorDetail === "run_ceiling" && row.result?.finishBy)
    return REVAMP_ERROR_MESSAGES.time_limit;
  // ★ Closed codes only: an unknown code (a newer revision's, or a typo)
  //   reads as `internal`, never as the raw code or the stored detail.
  return REVAMP_ERROR_MESSAGES[
    isRevampErrorCode(row.errorCode) ? row.errorCode : "internal"
  ];
}

function reviewOf(row: RevampJobRow) {
  // A superseded card the merchant applied keeps its review, so it can still
  // show what went into the Builder draft.
  const reviewable =
    row.status === "ready" ||
    (row.status === "superseded" && row.appliedAt !== null);
  const stored = row.result?.stored;
  if (!reviewable || !stored) return null;
  try {
    const review = toRevampReview(stored);
    // ★ What Apply did differently from the plan (a product filed without
    //   the category it named) is told on the same card, under the plan's
    //   own notes, once Apply has run.
    const applied = appliedNotes(row.applySnapshot).filter(
      (note) => !review.notes.includes(note),
    );
    return applied.length
      ? { ...review, notes: [...review.notes, ...applied] }
      : review;
  } catch (error) {
    logWarn("mink.revamp: review could not be built", {
      revampId: row.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

/** `apply_snapshot.notes` (lifecycle-types.ts), read defensively. */
function appliedNotes(snapshot: unknown): string[] {
  const notes =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as { notes?: unknown }).notes
      : undefined;
  return Array.isArray(notes)
    ? notes.filter(
        (note): note is string =>
          typeof note === "string" && note.trim() !== "",
      )
    : [];
}

// ---------------------------------------------------------------------------
// SQL fragments.
// ---------------------------------------------------------------------------

/** The fence every runner write carries: this job, still running, our lease. */
function fenceSql(revampId: string, leaseToken: string): SQL | undefined {
  return and(
    eq(minkRevamps.id, revampId),
    eq(minkRevamps.leaseToken, leaseToken),
    eq(minkRevamps.status, "running"),
  );
}

function ownedSql(actor: MinkActorContext, revampId: string): SQL | undefined {
  return and(
    eq(minkRevamps.id, revampId),
    eq(minkRevamps.storeId, actor.storeId),
    eq(minkRevamps.adminId, actor.adminId),
  );
}

function leaseUntilSql(): SQL {
  return sql`now() + (${REVAMP_LIMITS.leaseMs}::int * interval '1 millisecond')`;
}

/** A claim may take the job: no lease, or one whose time has passed. */
function claimableLeaseSql(): SQL {
  return sql`(${minkRevamps.leaseUntil} IS NULL OR ${minkRevamps.leaseUntil} <= now())`;
}

/** Nobody is working on it: no lease, an expired one, or a parked one. */
function noLiveHolderSql(): SQL {
  return sql`(${minkRevamps.leaseToken} IS NULL OR ${minkRevamps.leaseUntil} <= now() OR ${minkRevamps.leaseToken} = ${PARKED_LEASE_TOKEN}::uuid)`;
}

function noLiveHolderRawSql(): SQL {
  return sql`(lease_token IS NULL OR lease_until <= now() OR lease_token = ${PARKED_LEASE_TOKEN}::uuid)`;
}

/**
 * Waiting to be claimed with nobody on it, inside its ceiling, past the kick
 * cooldown. ★ A job whose runner died is one of these once its lease runs
 * out, and the kick resumes it at the step it saved (B8).
 */
function stalledSql(): SQL {
  return sql`(
    ${minkRevamps.status} IN ('queued', 'running')
    AND ${minkRevamps.cancelRequestedAt} IS NULL
    AND ${minkRevamps.attempts} < ${minkRevamps.maxAttempts}
    AND NOT ${pastCeilingSql()}
    AND (${minkRevamps.leaseUntil} IS NULL OR ${minkRevamps.leaseUntil} <= now())
    AND coalesce(${minkRevamps.lastKickAt}, ${minkRevamps.createdAt}) <= now() - (${REVAMP_LIMITS.kickCooldownMs}::int * interval '1 millisecond')
  )`;
}

/** The database's now in epoch milliseconds, the unit of `firstClaimedAt`. */
function nowMsSql(): SQL {
  return sql`floor(extract(epoch from now()) * 1000)`;
}

/**
 * ★★ Past its wall-clock ceiling (B8): first claimed more than
 *   `REVAMP_RUN_CEILING_MS` ago. A job never claimed has no clock and is
 *   never past it, and a clock that is not a number reads as none, so an
 *   unreadable column can only ever keep a job going, never fail it.
 */
function pastCeilingSql(): SQL {
  return ceilingSql(sql`${minkRevamps.result}`);
}

/** The same test, for the raw statements over `public.mink_revamps`. */
function pastCeilingRawSql(): SQL {
  return ceilingSql(sql.raw("result"));
}

function ceilingSql(result: SQL): SQL {
  return sql`(CASE WHEN ${result} -> 'recoveryVersion' = '2'::jsonb THEN false ELSE ((CASE WHEN jsonb_typeof(${result} -> 'finishBy') = 'number' THEN (${result} ->> 'finishBy')::numeric <= ${nowMsSql()} ELSE false END) OR CASE WHEN jsonb_typeof(${result} -> 'firstClaimedAt') = 'number' THEN (${result} ->> 'firstClaimedAt')::numeric <= ${nowMsSql()} - ${REVAMP_RUN_CEILING_MS}::bigint ELSE false END) END)`;
}

/** A run that has ended without finishing: its failures or its time ran out. */
function runEndedSql(): SQL {
  return sql`(${minkRevamps.attempts} >= ${minkRevamps.maxAttempts} OR ${pastCeilingSql()})`;
}

/**
 * The result column a claim writes (B8). ★ The job's ceiling starts at its
 *   first claim and never moves. ★ A claim that finds the token of the claim
 *   before it still on the row (a release always clears or parks it, and every
 *   finish clears it) found that claim ended with nothing handed back: one
 *   interruption, kept for the logs. The token read here is the row's before
 *   this statement, as every expression in an UPDATE's SET reads it.
 */
function claimedResultSql(leaseToken: string): SQL {
  const result = sql`${minkRevamps.result}`;
  return sql`((CASE WHEN jsonb_typeof(${result}) = 'object' THEN ${result} ELSE '{}'::jsonb END) || jsonb_build_object(
    'recoveryLeaseToken', CASE WHEN ${result} -> 'recoveryVersion' = '2'::jsonb THEN to_jsonb(${leaseToken}::text) END,
    'deadlineLeaseToken', CASE WHEN jsonb_typeof(${result} -> 'finishBy') = 'number' THEN to_jsonb(${leaseToken}::text) END,
    'firstClaimedAt', CASE WHEN jsonb_typeof(${result} -> 'firstClaimedAt') = 'number' THEN ${result} -> 'firstClaimedAt' ELSE to_jsonb(${nowMsSql()}) END,
    'interruptions', (CASE WHEN jsonb_typeof(${result} -> 'interruptions') = 'number' THEN greatest(floor((${result} ->> 'interruptions')::numeric), 0) ELSE 0 END)
      + (CASE WHEN ${minkRevamps.leaseToken} IS NOT NULL AND ${minkRevamps.leaseToken} <> ${PARKED_LEASE_TOKEN}::uuid THEN 1 ELSE 0 END)
  ))`;
}

/**
 * A step's result written over the column, keeping the claim's own fields
 * (B8): when the job was first claimed and how often a claim found the one
 * before it interrupted are the claim's to write, so no step's save, nor a
 * revision that does not know them, moves them.
 */
function keepingClaimFieldsSql(result: RevampResultColumn): SQL {
  const stored = sql`${minkRevamps.result}`;
  return sql`(${JSON.stringify(result)}::jsonb || jsonb_strip_nulls(jsonb_build_object(
    'recoveryVersion', CASE WHEN ${stored} -> 'recoveryVersion' = '2'::jsonb THEN ${stored} -> 'recoveryVersion' END,
    'targetReadyAt', CASE WHEN jsonb_typeof(${stored} -> 'targetReadyAt') = 'number' THEN ${stored} -> 'targetReadyAt' END,
    'finishBy', CASE WHEN jsonb_typeof(${stored} -> 'finishBy') = 'number' THEN ${stored} -> 'finishBy' END,
    'firstClaimedAt', CASE WHEN jsonb_typeof(${stored} -> 'firstClaimedAt') = 'number' THEN ${stored} -> 'firstClaimedAt' END,
    'interruptions', CASE WHEN jsonb_typeof(${stored} -> 'interruptions') = 'number' THEN ${stored} -> 'interruptions' END
  )))`;
}

/**
 * A finished job has no step still turning: every `running` entry of the
 * progress list goes back to `waiting`, in place, whatever else the list holds.
 */
function stoppedProgressSql(column: SQL): SQL {
  return sql`(SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(t.item) = 'object' AND t.item ->> 'state' = 'running' THEN t.item || '{"state":"waiting"}'::jsonb ELSE t.item END ORDER BY t.ord), '[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END) WITH ORDINALITY AS t(item, ord))`;
}

/** A ready job ran every step it did not skip. */
function doneProgressSql(column: SQL): SQL {
  return sql`(SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(t.item) = 'object' AND coalesce(t.item ->> 'state', '') <> 'skipped' THEN t.item || '{"state":"done"}'::jsonb ELSE t.item END ORDER BY t.ord), '[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END) WITH ORDINALITY AS t(item, ord))`;
}

function cancelledSet(): RevampUpdate {
  return {
    status: "cancelled",
    errorCode: "cancelled",
    leaseToken: null,
    leaseUntil: null,
    cancelRequestedAt: sql`coalesce(${minkRevamps.cancelRequestedAt}, now())`,
    progress: stoppedProgressSql(sql`${minkRevamps.progress}`),
    finishedAt: sql`now()`,
    updatedAt: sql`now()`,
  };
}

function exhaustedSet(): RevampUpdate {
  return {
    status: "failed",
    errorCode: "out_of_attempts",
    // ★ Which ran out, for the logs (B8); the card says the same either way.
    errorDetail: sql`CASE WHEN ${minkRevamps.attempts} >= ${minkRevamps.maxAttempts} THEN 'attempts_exhausted' ELSE 'run_ceiling' END`,
    leaseToken: null,
    leaseUntil: null,
    progress: stoppedProgressSql(sql`${minkRevamps.progress}`),
    finishedAt: sql`now()`,
    updatedAt: sql`now()`,
  };
}

/**
 * The job reached its card step and the card exists: the draft keyed by the
 * revamp's own id, in this store. ★ The card step writes that draft and its
 * charge in one transaction (drafts.ts), so a draft row IS a card the
 * merchant has paid for (or was given free).
 */
function madeCardSql(): SQL {
  return sql`(${minkRevamps.step} = 'card' AND EXISTS (SELECT 1 FROM public.mink_drafts d WHERE d.id = ${minkRevamps.id} AND d.store_id = ${minkRevamps.storeId}))`;
}

/** The same test, for the sweep's raw statements over `public.mink_revamps`. */
function madeCardRawSql(): SQL {
  return sql`(step = 'card' AND EXISTS (SELECT 1 FROM public.mink_drafts d WHERE d.id = mink_revamps.id AND d.store_id = mink_revamps.store_id))`;
}

/**
 * What the sweep would fail (attempts spent or the ceiling passed, B8) or
 * cancel (a stop nobody will see) while nobody holds it, narrowed to a job
 * whose card was made. ★ The ceiling too, or a paid card past it would be
 * neither claimed again nor failed, and wait for ever.
 */
function settleableMadeCardSql(): SQL | undefined {
  return and(
    inArray(minkRevamps.status, [...ACTIVE_STATUSES]),
    sql`(${minkRevamps.cancelRequestedAt} IS NOT NULL OR ${runEndedSql()} OR ${minkRevamps.result} -> 'recoveryVersion' = '2'::jsonb)`,
    noLiveHolderSql(),
    madeCardSql(),
  );
}

/** Ready with the card that was made, charged exactly what its draft charged. */
function readyWithMadeCardSet(): RevampUpdate {
  return {
    status: "ready",
    progress: doneProgressSql(sql`${minkRevamps.progress}`),
    draftId: sql`${minkRevamps.id}`,
    // ★ What the draft charged, never a second figure: a free revamp is 0
    //   whatever the draft says (the DB CHECK), and the rest is bounded by
    //   the revamp ceiling the same CHECK holds.
    credits: sql`CASE WHEN ${minkRevamps.free} THEN 0 ELSE coalesce((SELECT least(greatest(d.charged_credits, 0), ${REVAMP_LIMITS.maxCredits}::int) FROM public.mink_drafts d WHERE d.id = ${minkRevamps.id} AND d.store_id = ${minkRevamps.storeId}), 0) END`,
    leaseToken: null,
    leaseUntil: null,
    errorCode: null,
    errorDetail: null,
    finishedAt: sql`now()`,
    updatedAt: sql`now()`,
  };
}

/**
 * One service transaction for a settlement that may finish a made card
 * (`finishMadeCard`), and the requester's ready notice for each card it
 * finished.
 *
 * ★★ EVERY PATH THAT TURNS A JOB READY TELLS THE REQUESTER (ops-4). The
 *   runner's card step always did; a card finished here (the claim, a
 *   failure, a Stop, the status poll, the sweep) turned ready in silence, so
 *   a merchant who had left the chat never learned their redesign was
 *   waiting. ★ Sent only after the transaction commits, so a settlement that
 *   rolled back announces nothing, and outside it, so the notice's own writes
 *   never hold the settlement's connection. ★ Best effort: a notice that
 *   fails is logged and never fails the settlement.
 * ★★ AND EVERY PATH THAT FAILS A JOB GIVES ITS DAY'S START BACK (B5): the
 *   claim that cannot read the request, a failure, the status poll and the
 *   sweep note each job they moved to failed in `failed`, and its start goes
 *   back here, after the commit, for the same two reasons.
 */
async function settling<T>(
  fn: (db: Db, ready: RawRevampRow[], failed: FailedStart[]) => Promise<T>,
): Promise<T> {
  const ready: RawRevampRow[] = [];
  const failed: FailedStart[] = [];
  const result = await withService((db) => fn(db, ready, failed));
  for (const job of ready) await notifyRevampReady(job);
  for (const job of failed) await giveStartBack(job);
  return result;
}

/** A redesign a settlement failed, whose day's start goes back (B5). */
interface FailedStart {
  revampId: string;
  storeId: string;
  /**
   * When the job was created, to the microsecond: the start was claimed just
   * before the job was inserted, so the window that counted it began at or
   * before this moment.
   */
  createdAt: string;
}

/** What a failing statement returns for `noteFailedStart`. */
function failedStartColumns() {
  return {
    id: minkRevamps.id,
    storeId: minkRevamps.storeId,
    createdAt: minkRevamps.createdAt,
    cancelRequestedAt: minkRevamps.cancelRequestedAt,
  };
}

/**
 * Notes a job a settlement has just moved to failed, so `settling` gives its
 * start back once the transaction commits (B5). ★ Each failure is ONE
 *   conditional transition out of queued or running, which only one
 *   settlement can win, so a start goes back exactly once however many
 *   settlers race. ★ Not a job somebody had asked to stop: a stopped redesign
 *   keeps its start, as a cancelled one always has, and the start tool gives
 *   back the one it withdraws itself, so a stop that ends as a failure is
 *   never given back twice. A row that cannot be read is not given back.
 */
function noteFailedStart(
  failed: FailedStart[],
  row:
    | {
        id?: unknown;
        storeId?: unknown;
        createdAt?: unknown;
        cancelRequestedAt?: unknown;
      }
    | undefined,
): void {
  if (!row || row.cancelRequestedAt) return;
  const createdAt = stamp(row.createdAt);
  if (!isUuid(row.id) || !isUuid(row.storeId) || !createdAt) {
    logWarn("mink.revamp: failed redesign's start not given back", {
      revampId: typeof row.id === "string" ? row.id : "unknown",
    });
    return;
  }
  failed.push({ revampId: row.id, storeId: row.storeId, createdAt });
}

/**
 * ★★ A FAILED REDESIGN GIVES ITS DAY'S START BACK (robustness audit B5).
 *   The store's six starts a day bound what merchants ask for, and a
 *   redesign that failed gave them nothing. ★ Only to the window that
 *   counted it (`claimedAt`): a day begun since the job was created never
 *   counted its start and keeps its own count. ★ Best effort, like every
 *   give-back (`releaseSpendLimits` logs and never throws): one that does not
 *   land costs the store one start of that day, which is what it cost before.
 */
async function giveStartBack(job: FailedStart): Promise<void> {
  await releaseSpendLimits([revampStartLimit(job.storeId)], {
    claimedAt: job.createdAt,
  });
  logInfo("mink.revamp: failed redesign's start given back", {
    revampId: job.revampId,
    storeId: job.storeId,
  });
}

/** The ready notice for one card, through the runner's own builder. */
async function notifyRevampReady(job: RawRevampRow): Promise<void> {
  try {
    // Imported on demand, as the runner does: the notification spine is
    // only loaded when a card is actually finished.
    const { recordEvent } = await import("@/lib/notifications/record");
    await recordEvent(revampReadyEvent(job));
  } catch (error) {
    logWarn("mink.revamp: ready notification failed", {
      revampId: job.id,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * ★★ A MADE CARD IS ALWAYS FINISHED, WHOEVER SETTLES THE JOB. The card step
 *   makes the draft and takes its charge first, and only then attaches it to
 *   the job; a Stop, or an attempt budget that ran out, landing between the
 *   two (the attaching write failed and the lease was parked) would end a
 *   paid card as "You stopped this redesign. Nothing was changed." or as a
 *   failure, its credits kept and its draft orphaned. So every settlement
 *   that would cancel or fail a job at its card step asks this first: when
 *   the card exists, the job is finished as ready with it, exactly as the
 *   card step finishes it, retiring the same older cards. Null when there is
 *   no such job under `where`. A finished job goes into `ready`, whose
 *   requester `settling` tells once the transaction commits (ops-4).
 */
async function finishMadeCard(
  db: Db,
  where: SQL | undefined,
  ready: RawRevampRow[],
): Promise<RawRevampRow | null> {
  const rows = await db
    .update(minkRevamps)
    .set(readyWithMadeCardSet())
    .where(and(where, madeCardSql()))
    .returning();
  const finished = rows[0];
  if (!finished) return null;
  const superseded = await supersedeForReady(db, finished);
  ready.push(finished);
  logInfo("mink.revamp: made card finished at settlement", {
    revampId: finished.id,
    storeId: finished.storeId,
    superseded: superseded.length,
  });
  return finished;
}

/**
 * A card just became ready: the parent of a refinement and every other ready,
 * unapplied card of the same conversation are superseded by it, so a
 * conversation never shows two live cards. Returns the ids it retired.
 */
async function supersedeForReady(
  db: Db,
  job: {
    id: string;
    storeId: string;
    parentId: string | null;
    conversationId: string | null;
  },
): Promise<string[]> {
  const superseded: string[] = [];
  if (job.parentId) {
    // ★ The parent is retired whether or not it was applied: the refinement
    //   is its new version (product spec section 1, step 4).
    const parent = await db
      .update(minkRevamps)
      .set({
        status: "superseded",
        supersededBy: job.id,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(minkRevamps.id, job.parentId),
          eq(minkRevamps.storeId, job.storeId),
          eq(minkRevamps.status, "ready"),
        ),
      )
      .returning({ id: minkRevamps.id });
    superseded.push(...parent.map((row) => row.id));
  }
  if (job.conversationId) {
    // Other ready cards of the conversation that were never applied are
    // retired too; one the merchant applied stays theirs to publish or undo.
    const others = await db
      .update(minkRevamps)
      .set({
        status: "superseded",
        supersededBy: job.id,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(minkRevamps.storeId, job.storeId),
          eq(minkRevamps.conversationId, job.conversationId),
          eq(minkRevamps.status, "ready"),
          isNull(minkRevamps.appliedAt),
          sql`${minkRevamps.id} <> ${job.id}`,
        ),
      )
      .returning({ id: minkRevamps.id });
    superseded.push(...others.map((row) => row.id));
  }
  return superseded;
}

// ---------------------------------------------------------------------------
// Reading a row. Nothing below throws on bad data.
// ---------------------------------------------------------------------------

interface ParsedRow {
  row: RevampJobRow;
  /** False when the stored request could not be read (a fallback stands in). */
  requestReadable: boolean;
}

function parseRow(raw: RawRevampRow): ParsedRow | null {
  if (
    !isRevampKind(raw.kind) ||
    !isRevampStatus(raw.status) ||
    !isRevampStep(raw.step) ||
    typeof raw.id !== "string" ||
    typeof raw.storeId !== "string"
  ) {
    // The DB CHECKs make this unreachable; a row that gets here anyway is
    // reported, not rendered.
    logWarn("mink.revamp: unreadable row", { revampId: raw.id });
    return null;
  }
  const request = readRequest(raw.request, raw.kind);
  return {
    requestReadable: request !== null,
    row: {
      id: raw.id,
      storeId: raw.storeId,
      adminId: raw.adminId,
      requesterEmail: raw.requesterEmail ?? null,
      conversationId: raw.conversationId ?? null,
      originRunId: raw.originRunId ?? null,
      parentId: raw.parentId ?? null,
      supersededBy: raw.supersededBy ?? null,
      kind: raw.kind,
      status: raw.status,
      step: raw.step,
      progress: readProgress(raw.progress, raw.step, raw.status),
      request: request ?? fallbackRequest(raw.kind),
      snapshot: readSnapshot(raw.snapshot, raw.storeId),
      plan: readPlanColumn(raw.plan),
      result: readResultColumn(raw.result, raw.id),
      draftId: raw.draftId ?? null,
      free: raw.free === true,
      budgetCredits:
        typeof raw.budgetCredits === "number" &&
        Number.isInteger(raw.budgetCredits)
          ? raw.budgetCredits
          : null,
      credits: wholeNumber(raw.credits),
      leaseToken: raw.leaseToken ?? null,
      leaseUntil: stamp(raw.leaseUntil),
      attempts: wholeNumber(raw.attempts),
      maxAttempts: wholeNumber(raw.maxAttempts) || REVAMP_LIMITS.maxAttempts,
      lastKickAt: stamp(raw.lastKickAt),
      cancelRequestedAt: stamp(raw.cancelRequestedAt),
      errorCode: raw.errorCode ?? null,
      errorDetail: raw.errorDetail ?? null,
      appliedAt: stamp(raw.appliedAt),
      publishedAt: stamp(raw.publishedAt),
      undoneAt: stamp(raw.undoneAt),
      applySnapshot: raw.applySnapshot ?? null,
      publishSnapshot: raw.publishSnapshot ?? null,
      usage: readUsage(raw.usage),
      createdAt: stamp(raw.createdAt) ?? EPOCH,
      updatedAt: stamp(raw.updatedAt) ?? EPOCH,
      finishedAt: stamp(raw.finishedAt),
    },
  };
}

/** A request nothing can be built from: what a row with an unreadable one carries. */
function fallbackRequest(kind: RevampKind): RevampRequest {
  return {
    kind,
    brief: {
      business: "",
      look: "",
      audience: "",
      facts: [],
      avoid: "",
      language: "English",
    },
    products: [],
    categories: [],
    pages: null,
    instruction: null,
    refineScope: null,
  };
}

const INVALID = Symbol("invalid");
type Read<T> = T | typeof INVALID;

/**
 * The stored request, read strictly: a field that is present but of the wrong
 * type makes the whole request unreadable (dropping one product or one
 * category change would build something the merchant did not ask for), while
 * an absent optional field takes its obvious default.
 */
function readRequest(value: unknown, kind: RevampKind): RevampRequest | null {
  const row = record(value);
  if (!row || row.kind !== kind) return null;
  const brief = readBrief(row.brief);
  const products = readStrictList(row.products, readProductInput);
  const categories = readStrictList(row.categories, readCategoryChange);
  const pages = readNullableStrings(row.pages);
  const instruction = readNullableString(row.instruction);
  const refineScope =
    row.refineScope === undefined || row.refineScope === null
      ? null
      : readRefineScope(row.refineScope);
  if (
    brief === INVALID ||
    products === INVALID ||
    categories === INVALID ||
    pages === INVALID ||
    instruction === INVALID ||
    refineScope === INVALID
  ) {
    return null;
  }
  return { kind, brief, products, categories, pages, instruction, refineScope };
}

function readBrief(value: unknown): Read<RevampBrief> {
  const row = record(value);
  if (!row || typeof row.business !== "string") return INVALID;
  const look = readText(row.look);
  const audience = readText(row.audience);
  const avoid = readText(row.avoid);
  const language = readText(row.language, "English");
  const facts = readStrictList(row.facts, (fact) =>
    typeof fact === "string" ? fact : INVALID,
  );
  if (
    look === INVALID ||
    audience === INVALID ||
    avoid === INVALID ||
    language === INVALID ||
    facts === INVALID
  ) {
    return INVALID;
  }
  return {
    business: row.business,
    look,
    audience,
    facts,
    avoid,
    language: language || "English",
  };
}

function readProductInput(value: unknown): Read<RevampProductInput> {
  const row = record(value);
  if (
    !row ||
    typeof row.key !== "string" ||
    row.key === "" ||
    typeof row.name !== "string"
  ) {
    return INVALID;
  }
  const description = readText(row.description);
  const photoUrl = readNullableString(row.photoUrl);
  const categorySlug = readNullableString(row.categorySlug);
  const sizes = readStrictList(row.sizes, (size) => {
    const entry = record(size);
    if (!entry || !isFiniteNumber(entry.price)) return INVALID;
    const label = readText(entry.label);
    const mrp =
      entry.mrp === undefined || entry.mrp === null
        ? null
        : isFiniteNumber(entry.mrp)
          ? entry.mrp
          : INVALID;
    if (label === INVALID || mrp === INVALID) return INVALID;
    return { label, price: entry.price, mrp };
  });
  if (
    description === INVALID ||
    photoUrl === INVALID ||
    categorySlug === INVALID ||
    sizes === INVALID
  ) {
    return INVALID;
  }
  return {
    key: row.key,
    name: row.name,
    description,
    sizes,
    photoUrl,
    categorySlug,
  };
}

function readCategoryChange(
  value: unknown,
): Read<PersonalizationCategoryChange> {
  const row = record(value);
  if (!row) return INVALID;
  if (row.action === "hide") {
    return typeof row.slug === "string"
      ? { action: "hide", slug: row.slug }
      : INVALID;
  }
  const description = readNullableString(row.description);
  const newPhoto = readFlag(row.newPhoto);
  if (description === INVALID || newPhoto === INVALID) return INVALID;
  if (row.action === "update") {
    const name = readNullableString(row.name);
    if (typeof row.slug !== "string" || name === INVALID) return INVALID;
    return { action: "update", slug: row.slug, name, description, newPhoto };
  }
  if (row.action === "create") {
    const slug = readNullableString(row.slug);
    if (typeof row.name !== "string" || slug === INVALID) return INVALID;
    return { action: "create", name: row.name, slug, description, newPhoto };
  }
  return INVALID;
}

function readRefineScope(value: unknown): Read<RevampRefineScope> {
  const row = record(value);
  if (!row) return INVALID;
  const design = readFlag(row.design);
  const copy = readFlag(row.copy);
  const layout = readFlag(row.layout);
  const products = readFlag(row.products);
  const pages = readNullableStrings(row.pages);
  const photos: Read<string[] | "all" | null> =
    row.photos === "all" ? "all" : readNullableStrings(row.photos);
  if (
    design === INVALID ||
    copy === INVALID ||
    layout === INVALID ||
    products === INVALID ||
    pages === INVALID ||
    photos === INVALID
  ) {
    return INVALID;
  }
  return { design, copy, layout, photos, pages, products };
}

/**
 * The snapshot, checked for its shape and its store: the deep contents are the
 * snapshot module's to judge, but one for another store is never handed on.
 */
function readSnapshot(value: unknown, storeId: string): RevampSnapshot | null {
  const row = record(value);
  if (
    !row ||
    row.storeId !== storeId ||
    !Array.isArray(row.pages) ||
    !Array.isArray(row.categories) ||
    !Array.isArray(row.products) ||
    !record(row.chrome) ||
    !record(row.brand) ||
    !record(row.theme) ||
    !record(row.facts) ||
    !record(row.photos)
  ) {
    return null;
  }
  return row as unknown as RevampSnapshot;
}

function readPlanColumn(value: unknown): RevampPlanColumn | null {
  const row = record(value);
  if (!row) return null;
  if (row.stage === "raw") {
    return {
      stage: "raw",
      raw: row.raw ?? null,
      repairs:
        typeof row.repairs === "number" &&
        Number.isInteger(row.repairs) &&
        row.repairs >= 0
          ? row.repairs
          : 0,
      issues: Array.isArray(row.issues)
        ? row.issues.filter(
            (issue): issue is string => typeof issue === "string",
          )
        : [],
      ...(row.repairFailed === true ? { repairFailed: true } : {}),
    };
  }
  if (row.stage === "compiled") {
    const plan = readSitePlan(row.plan);
    if (!plan) return null;
    // ★ A copy that cannot be read is dropped, never the column: the cut
    //   plan is what every later step works from.
    const unfitted = readSitePlan(row.unfitted);
    return {
      stage: "compiled",
      plan,
      productPhotoKeys: Array.isArray(row.productPhotoKeys)
        ? row.productPhotoKeys.filter(
            (key): key is string => typeof key === "string",
          )
        : null,
      ...(unfitted ? { unfitted } : {}),
    };
  }
  return null;
}

/** A compiled site plan, read just far enough to be used. */
function readSitePlan(value: unknown): RevampSitePlan | null {
  const plan = record(value);
  if (
    !plan ||
    !Array.isArray(plan.pages) ||
    !Array.isArray(plan.shots) ||
    !Array.isArray(plan.bindings)
  ) {
    return null;
  }
  return plan as unknown as RevampSitePlan;
}

function readResultColumn(
  value: unknown,
  revampId: string,
): RevampResultColumn | null {
  const row = record(value);
  if (!row) return null;
  const result: RevampResultColumn = {};
  if (revampRecovers(row)) result.recoveryVersion = 2;
  const targetReadyAt = revampFinishBy(row.targetReadyAt);
  if (targetReadyAt !== null) result.targetReadyAt = targetReadyAt;
  const finishBy = revampFinishBy(row.finishBy);
  if (finishBy !== null) result.finishBy = finishBy;
  const photos = record(row.photos);
  if (photos && Array.isArray(photos.outcomes)) {
    result.photos = { outcomes: photos.outcomes.flatMap(readOutcome) };
  }
  const products = record(row.products);
  if (products && Array.isArray(products.failed)) {
    const redraws = readRedrawsByKey(products.redraws);
    result.products = {
      failed: products.failed.flatMap((entry) => {
        const failure = record(entry);
        return failure &&
          typeof failure.key === "string" &&
          typeof failure.reason === "string"
          ? [{ key: failure.key, reason: failure.reason }]
          : [];
      }),
      ...(redraws ? { redraws } : {}),
    };
  }
  const stored = readStoredPlan(row.stored, revampId);
  if (stored) result.stored = stored;
  if (typeof row.checked === "boolean") result.checked = row.checked;
  const photoHold = readPhotoHold(row.photoHold, false);
  if (photoHold) result.photoHold = photoHold;
  const photoReviews = readPhotoReviews(row.photoReviews, false);
  if (photoReviews) result.photoReviews = photoReviews;
  // The claim's own fields (B8): read back so the runner carries them on.
  if (isFiniteNumber(row.firstClaimedAt) && row.firstClaimedAt >= 0) {
    result.firstClaimedAt = row.firstClaimedAt;
  }
  const interruptions = wholeNumber(row.interruptions);
  if (interruptions > 0) result.interruptions = interruptions;
  // The redo memory's check (section 5, step 6): read back so every later
  // save carries it on.
  const distinctness = readDistinctnessRecord(row.distinctness);
  if (distinctness) result.distinctness = distinctness;
  return result;
}

const DISTINCTNESS_STATUSES: ReadonlySet<string> = new Set<
  RevampDistinctnessRecord["status"]
>([
  "not-compared",
  "refinement",
  "distinct",
  "changed",
  "too-close",
  "error",
  "skipped",
]);
/** Distances, changes and kept choices a record holds at most. */
const MAX_DISTINCTNESS_ITEMS = 16;
/** A choice's name ("bandRhythm", "fontPairing"). */
const DISTINCT_CHOICE_NAME = /^[A-Za-z]{1,40}$/;
/**
 * The closed words a change reads in: schemes and dashes, sides, heights,
 * card variants, pairing keys, "the theme's".
 */
const DISTINCT_CHOICE_WORDS = /^[a-z0-9 ,'_-]{0,160}$/i;

/**
 * The redo memory's record (`result.distinctness`), read defensively like
 * every column here: anything that is not the record's own shape (a status
 * outside the list, a distance outside 0 to 1, free text) drops the whole
 * record, never just a part of it, so what the job shows is what the check
 * wrote.
 */
function readDistinctnessRecord(
  value: unknown,
): RevampDistinctnessRecord | null {
  const row = record(value);
  if (
    !row ||
    typeof row.status !== "string" ||
    !DISTINCTNESS_STATUSES.has(row.status) ||
    typeof row.passed !== "boolean"
  ) {
    return null;
  }
  const isDistance = (n: unknown): n is number =>
    isFiniteNumber(n) && n >= 0 && n <= 1;
  const distances = (list: unknown): number[] | null =>
    Array.isArray(list) &&
    list.length <= MAX_DISTINCTNESS_ITEMS &&
    list.every(isDistance)
      ? [...list]
      : null;
  const before = distances(row.before);
  const after = distances(row.after);
  const bar = row.bar === null ? null : isDistance(row.bar) ? row.bar : NaN;
  const changed = Array.isArray(row.changed)
    ? row.changed.map((entry) => {
        const change = record(entry);
        return change &&
          typeof change.choice === "string" &&
          DISTINCT_CHOICE_NAME.test(change.choice) &&
          typeof change.from === "string" &&
          DISTINCT_CHOICE_WORDS.test(change.from) &&
          typeof change.to === "string" &&
          DISTINCT_CHOICE_WORDS.test(change.to)
          ? { choice: change.choice, from: change.from, to: change.to }
          : null;
      })
    : null;
  const kept = Array.isArray(row.kept) ? row.kept : null;
  const reason =
    row.reason === undefined
      ? undefined
      : (REVAMP_DISTINCTNESS_SKIPS as readonly unknown[]).includes(row.reason)
        ? (row.reason as RevampDistinctnessSkip)
        : null;
  if (
    !before ||
    !after ||
    Number.isNaN(bar) ||
    !changed ||
    changed.length > MAX_DISTINCTNESS_ITEMS ||
    changed.some((change) => change === null) ||
    !kept ||
    kept.length > MAX_DISTINCTNESS_ITEMS ||
    !kept.every(
      (choice) =>
        typeof choice === "string" && DISTINCT_CHOICE_NAME.test(choice),
    ) ||
    reason === null
  ) {
    return null;
  }
  return {
    status: row.status as RevampDistinctnessRecord["status"],
    ...(reason ? { reason } : {}),
    passed: row.passed,
    bar,
    before,
    after,
    changed: changed as RevampDistinctnessRecord["changed"],
    kept: kept as string[],
  };
}

/** At most every shot of a plan, with room to spare (REVAMP_LIMITS.maxShots). */
const MAX_REVIEW_SHOTS = 64;
const MAX_REVIEW_TRIES = 100;
const MAX_REDRAWS = 12;
const MAX_REDRAW_PROBLEMS = 12;
const MAX_PROBLEM_CHARS = 40;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The photos step's record of its checks (`result.photoReviews`). `strict`
 * (a write) refuses the whole record on one entry it cannot read, since a
 * record the next runner cannot read back is one it would quietly ignore; a
 * read keeps the entries it can read and drops the rest.
 */
function readPhotoReviews(
  value: unknown,
  strict: boolean,
): RevampPhotoReviews | null {
  const row = record(value);
  const shots = record(row?.shots);
  if (!row || !shots) return null;
  const entries = Object.entries(shots);
  if (entries.length > MAX_REVIEW_SHOTS) return null;
  const out: Record<string, RevampPhotoReviewState> = {};
  for (const [shotId, raw] of entries) {
    const state = isPhotoReviewShotId(shotId)
      ? readPhotoReviewState(raw)
      : null;
    if (state) out[shotId] = state;
    else if (strict) return null;
  }
  return { shots: out };
}

function isPhotoReviewShotId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PHOTO_HOLD_SLOT_CHARS &&
    value === value.trim()
  );
}

function readPhotoReviewState(value: unknown): RevampPhotoReviewState | null {
  const row = record(value);
  if (!row) return null;
  const tries = row.tries;
  if (
    typeof tries !== "number" ||
    !Number.isSafeInteger(tries) ||
    tries < 0 ||
    tries > MAX_REVIEW_TRIES
  ) {
    return null;
  }
  const state: RevampPhotoReviewState = { tries };
  if (row.draws !== undefined) {
    if (
      typeof row.draws !== "number" ||
      !Number.isSafeInteger(row.draws) ||
      row.draws < 0 ||
      row.draws > 100
    )
      return null;
    state.draws = row.draws;
  }
  if (row.correction !== undefined) {
    if (typeof row.correction !== "string" || row.correction.length > 1600)
      return null;
    state.correction = row.correction;
  }
  if (row.sha256 !== undefined) {
    if (typeof row.sha256 !== "string" || !SHA256_PATTERN.test(row.sha256)) {
      return null;
    }
    state.sha256 = row.sha256;
  }
  for (const key of ["firstAskedAt", "lastTriedAt"] as const) {
    if (row[key] === undefined) continue;
    const at = row[key];
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
    state[key] = at;
  }
  if (row.verdict === "expired") {
    state.verdict = "expired";
  } else if (row.verdict !== undefined) {
    const problems = readProblems(record(row.verdict)?.problems);
    if (!problems) return null;
    state.verdict = { problems };
  }
  if (row.redraws !== undefined) {
    const redraws = readRedraws(row.redraws);
    if (!redraws) return null;
    if (redraws.length > 0) state.redraws = redraws;
  }
  return state;
}

/** A check's problems: short words, bounded. Null when it is not a list of them. */
function readProblems(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REDRAW_PROBLEMS) return null;
  const problems: string[] = [];
  for (const problem of value) {
    if (
      typeof problem !== "string" ||
      problem.length === 0 ||
      problem.length > MAX_PROBLEM_CHARS
    ) {
      return null;
    }
    problems.push(problem);
  }
  return problems;
}

function readRedraws(value: unknown): RevampRedraw[] | null {
  if (!Array.isArray(value) || value.length > MAX_REDRAWS) return null;
  const redraws: RevampRedraw[] = [];
  for (const entry of value) {
    const row = record(entry);
    const problems = readProblems(row?.problems);
    if (
      !row ||
      !problems ||
      typeof row.attempt !== "number" ||
      !Number.isSafeInteger(row.attempt) ||
      row.attempt < 1 ||
      row.attempt > MAX_REVIEW_TRIES
    ) {
      return null;
    }
    redraws.push({ attempt: row.attempt, problems });
  }
  return redraws;
}

/** Redraws by product key, keeping only the readable ones; null when none. */
function readRedrawsByKey(
  value: unknown,
): Record<string, RevampRedraw[]> | null {
  const row = record(value);
  if (!row) return null;
  const out: Record<string, RevampRedraw[]> = {};
  for (const [key, raw] of Object.entries(row).slice(0, MAX_REVIEW_SHOTS)) {
    const redraws = readRedraws(raw);
    if (redraws && redraws.length > 0) out[key] = redraws;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** At most the anchor and every shot, or every product, with room to spare. */
const MAX_PHOTO_HOLD_UNITS = 64;
const MAX_PHOTO_HOLD_SLOT_CHARS = 160;
const PHOTO_HOLD_ROLES: ReadonlySet<string> = new Set([
  "anchor",
  "slot",
  "product",
]);

/**
 * A photo claim's units, `role:slotId` as the image row a drawn photo leaves
 * names them (photo-hold.ts). `strict` (a write) refuses the whole claim on
 * one unit it cannot read, since a unit the next runner cannot match to a row
 * is a photo given back twice or never; a read keeps the units it can read.
 */
function readPhotoHold(
  value: unknown,
  strict: boolean,
): RevampPhotoHold | null {
  const row = record(value);
  if (!row || !Array.isArray(row.units)) return null;
  if (row.units.length > MAX_PHOTO_HOLD_UNITS) return null;
  const units: string[] = [];
  for (const unit of row.units) {
    if (isPhotoHoldUnit(unit)) units.push(unit);
    else if (strict) return null;
  }
  if (units.length === 0) return null;
  return { units };
}

function isPhotoHoldUnit(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const at = value.indexOf(":");
  if (at <= 0) return false;
  const slotId = value.slice(at + 1);
  return (
    PHOTO_HOLD_ROLES.has(value.slice(0, at)) &&
    slotId.length > 0 &&
    slotId.length <= MAX_PHOTO_HOLD_SLOT_CHARS &&
    slotId === slotId.trim()
  );
}

function readOutcome(value: unknown): RevampPhotoOutcome[] {
  const row = record(value);
  if (
    !row ||
    typeof row.shotId !== "string" ||
    (row.status !== "generated" &&
      row.status !== "failed" &&
      row.status !== "skipped")
  ) {
    return [];
  }
  const redraws = row.redraws === undefined ? null : readRedraws(row.redraws);
  return [
    {
      shotId: row.shotId,
      status: row.status,
      reason: typeof row.reason === "string" ? row.reason : null,
      ...(redraws && redraws.length > 0 ? { redraws } : {}),
    },
  ];
}

function readStoredPlan(
  value: unknown,
  revampId: string,
): RevampStoredPlan | null {
  if (!isRevampPlan(value)) return null;
  const row = value as unknown as Record<string, unknown>;
  const products = record(row.products);
  if (
    typeof row.summary !== "string" ||
    !Array.isArray(row.pages) ||
    !Array.isArray(row.categories) ||
    !Array.isArray(row.photos) ||
    !Array.isArray(row.checks) ||
    !Array.isArray(row.skipped) ||
    !Array.isArray(row.notes) ||
    !products ||
    !Array.isArray(products.hide) ||
    !Array.isArray(products.create) ||
    // A stored plan names the revamp it belongs to; another one's is never
    // shown on this card.
    (typeof row.revampId === "string" && row.revampId !== revampId)
  ) {
    return null;
  }
  return value;
}

/**
 * One entry per step, in the runner's order, whatever the column holds: an
 * entry that cannot be read is rebuilt from where the job is.
 */
function readProgress(
  value: unknown,
  step: RevampStep,
  status: RevampStatus,
): RevampProgressItem[] {
  const parsed = readProgressInput(value);
  const byStep = new Map(parsed.map((item) => [item.step, item]));
  const current = REVAMP_STEPS.indexOf(step);
  return REVAMP_STEPS.map((key, index) => {
    const item = byStep.get(key);
    if (item) return item;
    const state: RevampStepState =
      status === "ready" || index < current
        ? "done"
        : index === current && status === "running"
          ? "running"
          : "waiting";
    return { step: key, state, detail: null };
  });
}

/** The readable entries of a progress list, first one per step, bounded. */
function readProgressInput(value: unknown): RevampProgressItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<RevampStep>();
  const items: RevampProgressItem[] = [];
  for (const entry of value) {
    const row = record(entry);
    if (!row || !isRevampStep(row.step) || !isStepState(row.state)) continue;
    if (seen.has(row.step)) continue;
    seen.add(row.step);
    items.push({
      step: row.step,
      state: row.state,
      detail:
        typeof row.detail === "string" && row.detail.trim() !== ""
          ? clip(cleanText(row.detail), MAX_PROGRESS_DETAIL)
          : null,
    });
  }
  return items.sort(
    (a, b) => REVAMP_STEPS.indexOf(a.step) - REVAMP_STEPS.indexOf(b.step),
  );
}

function readUsage(value: unknown): RevampUsage {
  const row = record(value) ?? {};
  const read = (key: keyof RevampUsage) => {
    const number = row[key];
    return typeof number === "number" && Number.isFinite(number) && number > 0
      ? number
      : 0;
  };
  const calls = readCallCounts(row.calls);
  return {
    inputTokens: read("inputTokens"),
    outputTokens: read("outputTokens"),
    thinkingTokens: read("thinkingTokens"),
    images: read("images"),
    reviews: read("reviews"),
    estimatedCostMicroUsd: read("estimatedCostMicroUsd"),
    ...(calls ? { calls } : {}),
  };
}

/** Models a usage record counts refused and timed-out tries for, at most. */
const MAX_CALL_MODELS = 16;
const MAX_CALL_MODEL_CHARS = 80;

/**
 * The per-model counts of tries with no answer (`RevampUsage.calls`), the
 * readable ones; null when there are none.
 */
function readCallCounts(
  value: unknown,
): Record<string, RevampCallCounts> | null {
  const row = record(value);
  if (!row) return null;
  const out: Record<string, RevampCallCounts> = {};
  const count = (n: unknown) =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0;
  for (const [model, raw] of Object.entries(row).slice(0, MAX_CALL_MODELS)) {
    const entry = record(raw);
    if (!entry || !model || model.length > MAX_CALL_MODEL_CHARS) continue;
    const rateLimited = count(entry.rateLimited);
    const timeouts = count(entry.timeouts);
    if (rateLimited > 0 || timeouts > 0) {
      out[model] = { rateLimited, timeouts };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Small readers and guards.
// ---------------------------------------------------------------------------

function readStrictList<T>(
  value: unknown,
  readItem: (item: unknown) => Read<T>,
): Read<T[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return INVALID;
  const items: T[] = [];
  for (const entry of value) {
    const item = readItem(entry);
    if (item === INVALID) return INVALID;
    items.push(item);
  }
  return items;
}

function readText(value: unknown, fallback = ""): Read<string> {
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value : INVALID;
}

function readNullableString(value: unknown): Read<string | null> {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : INVALID;
}

function readNullableStrings(value: unknown): Read<string[] | null> {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return INVALID;
  return value.every((item) => typeof item === "string")
    ? (value as string[])
    : INVALID;
}

function readFlag(value: unknown): Read<boolean> {
  if (value === undefined || value === null) return false;
  return typeof value === "boolean" ? value : INVALID;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

function wholeNumber(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** A token a runner could hold: a UUID, and never the parked one. */
function isHeldToken(value: unknown): value is string {
  return isUuid(value) && value !== PARKED_LEASE_TOKEN;
}

function isRevampKind(value: unknown): value is RevampKind {
  return (REVAMP_KINDS as readonly unknown[]).includes(value);
}

function isRevampStatus(value: unknown): value is RevampStatus {
  return (REVAMP_STATUSES as readonly unknown[]).includes(value);
}

function isRevampStep(value: unknown): value is RevampStep {
  return (REVAMP_STEPS as readonly unknown[]).includes(value);
}

function isStepState(value: unknown): value is RevampStepState {
  return (
    value === "waiting" ||
    value === "running" ||
    value === "done" ||
    value === "skipped"
  );
}

function isRevampErrorCode(value: unknown): value is RevampErrorCode {
  return (REVAMP_ERROR_CODES as readonly unknown[]).includes(value);
}

function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email ? email.slice(0, 320) : null;
}

function boundedRetryAfter(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(value));
}

function boundedCredits(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const bounded = Math.min(REVAMP_LIMITS.maxCredits, Math.floor(value));
  if (bounded !== value) {
    logWarn("mink.revamp: card credits bounded", { requested: value, bounded });
  }
  return bounded;
}

function boundedDetail(value: unknown): string {
  const detail = typeof value === "string" ? cleanText(value).trim() : "";
  return clip(detail || "no_detail", MAX_ERROR_DETAIL);
}

function boundedSummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const summary = cleanText(value).replace(/\s+/g, " ").trim();
  return summary ? clip(summary, MAX_SUMMARY) : null;
}

/** Control characters out, by code point, so no escape is needed in source. */
function cleanText(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out +=
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
        ? " "
        : char;
  }
  return out;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
