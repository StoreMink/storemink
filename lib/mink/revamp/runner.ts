import "server-only";
import { REVAMP_WORK_BUDGET, revampRecovers } from "./pacing-policy";

// ---------------------------------------------------------------------------
// The revamp runner: one invocation claims one job, carries it as far as it
// can, and either finishes it (the review card), fails it with a closed code,
// or hands it over to the next invocation (docs/mink-storefront-revamp.md).
//
// ★★ EVERY STEP'S OUTPUT IS SAVED BEFORE THE NEXT STEP STARTS, fenced on the
//   lease. A save that finds the lease gone writes nothing and the runner
//   stops at once without writing anything else: another invocation owns the
//   job now, and two writers is how a stale plan overwrites a fresh one.
// ★★ AN UNKNOWN ERROR IS NEVER A VERDICT. Only a RevampStepError that says it
//   is not transient fails the job; anything else (a network blip, a bug, a
//   database hiccup) gives the lease back with a short wait, and the job's
//   per-step failure count (jobs.ts) is what eventually ends a step that
//   keeps dying the same way.
// ★★ WAITING ON GOOGLE IS NOT FAILING (robustness audit B8). A step parked
//   because Google was busy or held its photos, or because the platform's
//   photo hour was spent, and a deadline that caught a step waiting on a
//   model, hand over without counting; a claim whose process died counts
//   nothing either. The job's wall-clock ceiling (jobs.ts
//   `REVAMP_RUN_CEILING_MS`) ends one that never finishes.
// ★ THE DEADLINE HANDS OVER, IT DOES NOT FAIL. Long revamps outlive one
//   request, so at the deadline the runner releases the lease with no wait
//   and kicks the next invocation; the saved steps are not redone.
// ★ THE ACTOR IS REBUILT FROM THE DATABASE ON EVERY INVOCATION (actor.ts),
//   never trusted from the job row, so a requester demoted or suspended mid-
//   revamp stops it at the next hand-over.
// ★★ EVERY PAID CALL IS COUNTED AS IT RETURNS (L2-F). The photos and
//   products steps report each draw, review and studio photo through
//   `onUsage`, and whatever this invocation spent since its last save rides
//   on the hand-over, the failure or the stop, so a step that spans three
//   invocations still leaves the job's usage the sum of all it paid for.
// ★★ A COMPILE REPAIR IS AN IMPROVEMENT, NOT A REQUIREMENT (L2-B). When the
//   model cannot answer one (busy, timed out, refused, unreadable), the plan
//   is finalised leniently from the last answer it gave, and the column
//   records it, so a retried step never pays for that repair again.
// ★★ A REDO IS DISTINCT FROM THIS STORE'S EARLIER REDESIGNS (robustness
//   audit section 5, step 6). A full redesign's planner sees a summary of the
//   store's own earlier redesigns (closed words only), and once the plan is
//   compiled, before the budget fit and any photograph, `makeDistinct` moves
//   it at least the same-theme bar from each of them where the merchant did
//   not ask for something (distinctness.ts), and the plan the fit leaves is
//   checked again, so the record is the shown plan's. Never another store's
//   plan, and never a reason to fail or wait: a read that fails skips it.
// ---------------------------------------------------------------------------

import { can } from "@/app/dashboard/lib/permissions";
import { pgErrorCode } from "@/lib/db/errors";
import type { EmitEventInput } from "@/lib/notifications/record";
import { logInfo, logWarn } from "@/lib/observability/logger";
import type { ThemeDefinition } from "@/lib/themes/types";
import type { MinkActorContext } from "../types";
import {
  REVAMP_LIMITS,
  REVAMP_STEPS,
  initialRevampProgress,
  type RevampErrorCode,
  type RevampProductInput,
  type RevampProgressItem,
  type RevampRefineScope,
  type RevampRequest,
  type RevampSitePlan,
  type RevampSnapshot,
  type RevampStep,
  type RevampStepState,
  type RevampStoredImage,
} from "./contract";
import {
  REVAMP_EARLIER_PLANS_MAX,
  earlierDesignsSummary,
  makeDistinct,
  makeDistinctAfterFit,
  revampKeptSectionIds,
} from "./distinctness";
import type {
  RevampDistinctnessRecord,
  RevampDistinctnessSkip,
  RevampJobRow,
  RevampPlanColumn,
  RevampResultColumn,
} from "./jobs";
import {
  RevampDrainedError,
  RevampOutOfCreditsError,
  RevampRetryLaterError,
  RevampStepError,
  ZERO_REVAMP_USAGE,
  addRevampUsage,
  type RevampDeps,
  type RevampModelCall,
  type RevampPhotoHold,
  type RevampPhotoReviews,
  type RevampStepContext,
  type RevampUsage,
} from "./ports";
import { revampReadyEvent } from "./ready-notice";
import { revampProductNameKey } from "./request";

export type RevampRunOutcome =
  | "ready"
  | "failed"
  | "cancelled"
  | "handover"
  | "not_claimed"
  // This process is already working on a revamp; nothing was claimed.
  | "busy";

type JobsModule = typeof import("./jobs");
type ActorModule = typeof import("./actor");

/** Every side effect the runner has, so a test can replace all of them. */
export interface RevampRunnerJobs {
  claim: JobsModule["claimRevampJob"];
  renew: JobsModule["renewRevampLease"];
  release: JobsModule["releaseRevampLease"];
  save: JobsModule["saveRevampStep"];
  report: JobsModule["reportRevampProgress"];
  finish: JobsModule["finishRevampReady"];
  fail: JobsModule["failRevampJob"];
  cancel: JobsModule["markRevampCancelled"];
  read: JobsModule["readRevampJob"];
  rebuildActor: ActorModule["rebuildRevampActor"];
  listImages: (
    revampId: string,
    storeId: string,
  ) => Promise<RevampStoredImage[]>;
  kick: (revampId: string) => Promise<void>;
  /**
   * Kick the oldest revamp waiting for a runner, other than `exceptRevampId`
   * (the one that just ran). Best effort; never throws.
   */
  kickWaiting: (exceptRevampId: string) => Promise<unknown>;
  /** Record or clear the step's photo claim on the job row (jobs-3). */
  hold: JobsModule["holdRevampPhotos"];
  /** Record the photos step's photo checks on the job row (P0). */
  reviews: JobsModule["recordRevampPhotoReviews"];
  /**
   * Whether the merchant has pressed Stop: one primary-key read of the
   * cancel flag, asked every `stopPollMs` on a recoverable job. ★ Optional
   * so a caller that builds its own side effects keeps working: absent, Stop
   * is read by the once-a-minute lease renewal and before the charge, as
   * every job's always was.
   */
  stopRequested?: JobsModule["revampStopRequested"];
  notify: (input: EmitEventInput) => Promise<unknown>;
  /**
   * ★★ This store's own earlier redesigns' plans, newest first (the redo
   *   memory, robustness audit section 5 step 6): jobs.ts
   *   `readEarlierRevampPlans`. ★ Optional so a caller that builds its own
   *   side effects (scripts/revamp-live-check.ts) keeps working: absent, the
   *   runner reads them with jobs.ts itself, as production does.
   */
  earlierPlans?: JobsModule["readEarlierRevampPlans"];
  /**
   * The store's current theme as the runtime registry serves it (the
   *   snapshot's theme id and version), which every plan is measured over.
   *   Absent: the registry, as for `earlierPlans`.
   */
  theme?: (theme: RevampThemeSelection) => Promise<ThemeDefinition | null>;
}

/** The installed theme a snapshot names (contract.ts RevampThemeInfo). */
export interface RevampThemeSelection {
  id: string;
  version: string | null;
}

/**
 * The plan port's input with the two fields the production planner reads
 * (site-schema.ts `RevampSiteInput`): the redesign's own id, which seeds the
 * prompt's option order, the compiler's fallbacks and the fake planner
 * (`revampDesignSeed`), and the summary of this store's earlier redesigns
 * (`<earlier_designs>`). ★ Declared here because the port types (ports.ts) do
 *   not name them yet; the compile, finalize and repair inputs carry them
 *   too, and the compiler reads the id.
 */
type RevampPlannerInput = Parameters<RevampDeps["plan"]>[1] & {
  photoBudget?: number;
  revampId: string;
  earlierDesigns?: string;
};

/** What the redo memory's check compared a plan with: theme and earlier plans. */
interface RevampMeasure {
  theme: ThemeDefinition;
  earlier: readonly unknown[];
}

/**
 * Revamps one server process works on at once.
 *
 * ★★ ONE, BECAUSE A REVAMP RUNS INSIDE THE PUBLIC WEB SERVICE. Its photos are
 *   the Theme Studio image pipeline (base64 references, decoded originals,
 *   sharp crops) and its product photos follow, and that pipeline is what ran
 *   Theme Studio out of its 1 GiB container (docs/theme-studio-live-benchmark-
 *   2026-10-04.md); a container killed that way takes every storefront,
 *   checkout and chat request on it down too. Nothing else bounded it: one
 *   active revamp per STORE still let any number of stores land on one
 *   instance.
 * ★ A turned-away kick claims nothing, so the waiting job's lease and attempt
 *   count are untouched and any later kick can take it. When this process's
 *   revamp ends it kicks the oldest waiting one itself, so on dev, which has
 *   no scheduler, a job never waits for somebody to open its card.
 */
export const REVAMP_RUNS_PER_PROCESS = 1;
let runsInProcess = 0;
let turnedAway = false;

/** Repair calls the model may make before the plan is finalised mechanically. */
export const REVAMP_MAX_REPAIRS = 2;
/**
 * Planner calls one invocation may make for the plan step (L2-B): the first,
 * and one more when the first fails because the model was busy or slow.
 * ★ A failed call used to give the lease back with a minute's wait, so one
 *   busy answer spent a whole claim of the step's four, and the minutes the
 *   invocation still had, on nothing (the live run: six minutes and a claim
 *   on two shops). The second call is asked straight away; it waits for the
 *   shared capacity like any other.
 */
export const REVAMP_PLAN_CALLS_PER_RUN = 2;
/**
 * The least time before the deadline that second call may start with: the
 * planner's own cap on one call once the shared capacity admits it
 * (site-planner.ts REVAMP_PLANNER_TIMEOUT_MS), so it can finish before the
 * deadline drains the step. With less left, the job is parked as before.
 */
export const REVAMP_PLAN_RETRY_MIN_LEFT_MS = 6 * 60_000;
/** The most earlier versions of a refinement read for its photos (R-1). */
const REVAMP_CHAIN_LIMIT = REVAMP_LIMITS.maxRefinements + 1;
/** How long a transient failure waits before the next claim. */
export const REVAMP_RETRY_AFTER_MS = 60_000;
/**
 * How long before the lease could lapse the runner stops when no renewal has
 * succeeded since (D1): the lease runs `REVAMP_LIMITS.leaseMs` from the start
 * of the last renewal that succeeded (or of the claim), and after it another
 * invocation may claim the job and pay for the same calls again. Theme
 * Studio's worker lease stops the same 5 s early (worker-lease.ts).
 */
export const REVAMP_LEASE_MARGIN_MS = 5_000;
/** One progress write per this long, at most; the rest ride on the next save. */
export const REVAMP_REPORT_INTERVAL_MS = 2_000;
/**
 * How long a step may drain after the deadline before it is stopped (jobs-4).
 * ★ The calls in flight at the deadline are billed whatever happens next, so
 *   they are let finish and be stored. ★★ No IMAGE call can still be on the
 *   wire at the hard stop (D2): one is admitted only while its own per-try
 *   clock and `REVAMP_LIMITS.hardStopMarginMs` fit before it, so a studio
 *   photo or a photo check (75 s each) is admitted until the drain and a
 *   shoot photo (180 s) only until 95 s before it (photos.ts
 *   `revampAdmissionDrain`). The planner and its compile repairs are not held
 *   to this yet: each is admitted until the drain on a 6 minute cap
 *   (site-planner.ts REVAMP_PLANNER_TIMEOUT_MS), so one admitted late can
 *   still be cut off by the hard stop. ★ The route runs for 1,200 seconds
 *   against an 18 minute deadline, so 90 seconds of drain still leaves half a
 *   minute to hand over; it cannot grow to a photo's 180 s without a shorter
 *   deadline.
 */
export const REVAMP_DEADLINE_GRACE_MS = REVAMP_LIMITS.deadlineGraceMs;
/**
 * ★★ The steps that wait on Google (robustness audit B8): the planner and its
 *   repairs, the shoot and its checks, the studio photos, each queued on the
 *   shared provider capacity and its start pacer. The deadline catching one
 *   of these half way is the step waiting its turn, so the hand-over counts
 *   nothing. The other steps call no model, and one still running at the
 *   deadline is stuck, which counts as a failure as it always has.
 */
export const REVAMP_GOOGLE_BOUND_STEPS: ReadonlySet<RevampStep> = new Set([
  "plan",
  "compile",
  "photos",
  "products",
]);
/**
 * The closed codes a step uses for "Google could not answer yet" when it
 * says the failure is transient: the planner busy, slow or refused for
 * capacity (`model_unavailable`), and a shoot whose photos Google refused,
 * held or timed out (`photos_unavailable`). B8: parked as before, not counted.
 */
const GOOGLE_WAIT_CODES: ReadonlySet<string> = new Set([
  "model_unavailable",
  "photos_unavailable",
]);
// Where the ready notification points when the revamp has no chat to open;
// built with the notice itself, which every path that turns a revamp ready
// shares (ops-4).
export { REVAMP_READY_URL } from "./ready-notice";

type StopReason = "deadline" | "renew_failed" | "cancelled" | "lease_lost";

// ★ A LOST LEASE OUTRANKS EVERYTHING (nothing may be written after it), and a
//   cancel outranks a deadline (the merchant's stop wins over our clock).
const STOP_RANK: Record<StopReason, number> = {
  deadline: 1,
  renew_failed: 1,
  cancelled: 2,
  lease_lost: 3,
};

class RevampHalted extends Error {
  constructor(readonly reason: StopReason | "lease_lost") {
    super(`revamp halted: ${reason}`);
    this.name = "RevampHalted";
  }
}

interface StepOutput {
  patch: {
    snapshot?: RevampSnapshot;
    plan?: RevampPlanColumn;
    result?: RevampResultColumn;
  };
  skipped?: boolean;
}

interface RevampRunInput {
  revampId: string;
  deps: RevampDeps;
  now?: () => number;
  deadlineMs?: number;
  requestId?: string;
  jobs?: RevampRunnerJobs;
}

export async function runRevampJob(
  input: RevampRunInput,
): Promise<{ outcome: RevampRunOutcome }> {
  // ★ Before the claim, so a turned-away kick changes nothing on the job.
  if (runsInProcess >= REVAMP_RUNS_PER_PROCESS) {
    turnedAway = true;
    logInfo("mink.revamp: this process is busy, kick turned away", {
      revampId: input.revampId,
    });
    return { outcome: "busy" };
  }
  runsInProcess += 1;
  const slot = { held: true, handOn: false };
  const freeSlot = () => {
    if (!slot.held) return;
    slot.held = false;
    runsInProcess -= 1;
    // A kick turned away while this run held the slot is this run's to pass on.
    slot.handOn = turnedAway;
    turnedAway = false;
  };
  let jobs: RevampRunnerJobs | null = null;
  try {
    jobs = input.jobs ?? (await defaultRevampRunnerJobs());
    return await runHeldRevamp(input, jobs, freeSlot);
  } finally {
    freeSlot();
    if (slot.handOn && jobs) {
      try {
        await jobs.kickWaiting(input.revampId);
      } catch {
        // The status poll and the sweep kick a waiting job too.
      }
    }
  }
}

async function runHeldRevamp(
  input: RevampRunInput,
  jobs: RevampRunnerJobs,
  freeSlot: () => void,
): Promise<{ outcome: RevampRunOutcome }> {
  const deps = input.deps;
  const now = input.now ?? Date.now;
  const requestId = input.requestId ?? crypto.randomUUID();

  // The lease runs from the claim's own write, which starts after this.
  const claimStarted = now();
  const claimed = await jobs.claim(input.revampId);
  if (!claimed) return { outcome: "not_claimed" };
  const { job, leaseToken } = claimed;
  const revampId = job.id;
  const request = job.request;
  // ★★ A new full redesign recovers (pacing-policy.ts): waits park it without
  //   counting, every paid candidate is stored before its review, and it
  //   draws within the photo and image-call budgets. Legacy jobs and
  //   refinements keep the earlier contract. ★ The twelve-minute target it
  //   carries (`targetReadyAt`) is observed in the timeline only: it never
  //   gates a claim, a paid call, the preview or the card.
  const recoverable = revampRecovers(job.result);

  const controller = new AbortController();
  let stop: StopReason | null = null;
  // Read through a call so TypeScript does not narrow `stop` across awaits:
  // the renewal timer changes it while a step is running.
  const stopNow = (): StopReason | null => stop;
  const halt = (reason: StopReason) => {
    if (stop && STOP_RANK[stop] >= STOP_RANK[reason]) return;
    stop = reason;
    if (!controller.signal.aborted) {
      controller.abort(new RevampHalted(reason));
    }
  };

  const deadlineMs = Math.max(
    0,
    input.deadlineMs ?? REVAMP_LIMITS.runnerDeadlineMs,
  );
  const deadline = now() + deadlineMs;
  // ★★ THE DEADLINE DRAINS BEFORE IT STOPS (jobs-4). Aborting at once cut
  //   off image draws the provider was already billing, and the next run
  //   paid for them again. The steps start no new paid call once `draining`
  //   aborts; the hard stop comes a grace period later.
  const drainController = new AbortController();
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const deadlineTimer = setTimeout(() => {
    if (stop) return;
    drainController.abort(new RevampHalted("deadline"));
    graceTimer = setTimeout(() => halt("deadline"), REVAMP_DEADLINE_GRACE_MS);
  }, deadlineMs);
  // ★★ ONLY A LOST LEASE STOPS PAID WORK AT ONCE, NOT A FAILED RENEWAL (D1,
  //   Theme Studio's P2 rule, worker-lease.ts). A renewal answering false
  //   means another invocation owns the job: stop at once. A renewal that
  //   THROWS says nothing about the lease (jobs.ts): one UPDATE whose pool
  //   wait is 5 s can time out on a busy server with minutes of lease left,
  //   and stopping then aborted every photo Google was already drawing, paid
  //   for and drawn again by the next invocation. It is logged and asked
  //   again at the next tick, and this watchdog, armed from the START of the
  //   last renewal that succeeded (or of the claim), still stops the work
  //   `REVAMP_LEASE_MARGIN_MS` before the lease could lapse, the halt the
  //   throw used to make: parked and counted as before.
  let leaseWatch: ReturnType<typeof setTimeout> | null = null;
  // ★ Set once the run has returned: a renewal still in flight then answers
  //   into a finished run and must not arm the watchdog again (Theme
  //   Studio's `stopped`, worker-lease.ts).
  let ended = false;
  let renewFailures = 0;
  const watchLease = (from: number) => {
    if (leaseWatch) clearTimeout(leaseWatch);
    leaseWatch = setTimeout(
      () => {
        if (stop) return;
        logWarn("mink.revamp: lease could lapse, stopping", {
          revampId,
          failures: renewFailures,
        });
        halt("renew_failed");
      },
      Math.max(
        0,
        from + REVAMP_LIMITS.leaseMs - REVAMP_LEASE_MARGIN_MS - now(),
      ),
    );
  };
  watchLease(claimStarted);
  // ★ One renewal at a time; a caller that must know the answer (the card
  //   step, before its charge) awaits the one already in flight. Resolves
  //   false when the renewal threw, so no answer about the lease came back.
  let renewal: Promise<boolean> | null = null;
  const renewOnce = (): Promise<boolean> => {
    if (stop) return Promise.resolve(true);
    renewal ??= (async () => {
      const started = now();
      try {
        const lease = await jobs.renew(revampId, leaseToken);
        renewFailures = 0;
        if (!lease.ok) halt("lease_lost");
        else if (lease.cancelRequested) halt("cancelled");
        else if (!stop && !ended) watchLease(started);
        return true;
      } catch (error) {
        renewFailures += 1;
        // ★ Content-free: a failed query's message carries its SQL text and
        //   parameters, so only a closed code is logged.
        logWarn("mink.revamp: lease renewal failed", {
          revampId,
          attempt: renewFailures,
          code: failureCode(error),
        });
        return false;
      } finally {
        renewal = null;
      }
    })();
    return renewal;
  };
  const renewTimer = setInterval(() => {
    void renewOnce();
  }, REVAMP_LIMITS.leaseRenewMs);
  // ★★ STOP IS READ EVERY TEN SECONDS ON A RECOVERABLE JOB, AS A READ. The
  //   lease renewal reads the cancel flag too, but renewing six times a
  //   minute is six fenced UPDATEs a minute per running job (each through
  //   the recovery fence trigger) on a database that already alerts on
  //   connections. A primary-key SELECT of the flag costs nothing to speak
  //   of, so Stop is honoured within `stopPollMs` and the lease is still
  //   renewed once a minute. ★ A read that throws is logged and asked again
  //   at the next tick; it says nothing about the lease (D1).
  const stopTimer =
    recoverable && jobs.stopRequested
      ? setInterval(() => {
          if (stop) return;
          void jobs.stopRequested!(revampId)
            .then((requested) => {
              if (requested && !stop && !ended) halt("cancelled");
            })
            .catch((error) => {
              logWarn("mink.revamp: stop check failed", {
                revampId,
                code: failureCode(error),
              });
            });
        }, REVAMP_WORK_BUDGET.stopPollMs)
      : null;

  // Local state: the job row as this invocation has advanced it.
  const state: {
    snapshot: RevampSnapshot | null;
    plan: RevampPlanColumn | null;
    result: RevampResultColumn;
  } = {
    snapshot: job.snapshot,
    plan: job.plan,
    result: job.result ?? {},
  };
  let usage = readUsage(job.usage);
  // ★ What the job row holds: the claim's total, then each save's (L2-F).
  let savedUsage = usage;
  let progress = readProgress(job.progress);
  let current: RevampStep | null = null;
  // The step under way and not yet saved, or null between steps (B8): a
  // deadline between two steps caught nothing half done.
  let working: RevampStep | null = null;
  let lastReportAt = Number.NEGATIVE_INFINITY;
  // ★ The photos step's "7 of 24" never runs backwards on the card: a resumed
  //   shoot counts its own draws from zero while the earlier ones are stored,
  //   and lanes settle out of order. The high-water mark is the stored
  //   detail's, and starts over when the step is redone or its total changes
  //   (a re-planned shoot), so "6 of 6" is never shown before a draw.
  const storedPhotoDetail = job.progress
    .find((item) => item.step === "photos")
    ?.detail?.match(/^(\d+) of (\d+)$/);
  let photosReported = Number(storedPhotoDetail?.[1] ?? 0);
  let photosTotal = Number(storedPhotoDetail?.[2] ?? 0);
  // The revamp's stored photos when the photos or products step started in
  // this invocation (jobs-5); null for every other step.
  let imagesAtStepStart: number | null = null;

  // Also the photos and products steps' `onUsage`: called once per paid call.
  const spend = (more: RevampUsage | undefined) => {
    if (more) usage = addRevampUsage(usage, readUsage(more));
  };
  /**
   * This invocation's total when it spent something the row does not hold
   * yet, for the writes that end an invocation (a hand-over, a failure, a
   * stop); null when nothing is unsaved, so those writes stay as they were.
   */
  const unsavedUsage = (): RevampUsage | null =>
    sameUsage(usage, savedUsage) ? null : usage;
  const setState = (
    step: RevampStep,
    stepState: RevampStepState,
    detail?: string | null,
  ) => {
    progress = progress.map((item) =>
      item.step === step
        ? {
            step,
            state: stepState,
            detail: detail === undefined ? item.detail : detail,
          }
        : item,
    );
  };

  const report = async (detail: string | null): Promise<void> => {
    try {
      if (!current) return;
      if (current === "photos" && detail) {
        const count = detail.match(/^(\d+) of (\d+)$/);
        if (count) {
          const total = Number(count[2]);
          if (total !== photosTotal) {
            photosTotal = total;
            photosReported = 0;
          }
          photosReported = Math.max(photosReported, Number(count[1]));
          detail = `${Math.min(photosReported, total)} of ${total}`;
        }
      }
      setState(current, "running", boundedDetail(detail));
      if (stop) return;
      const at = now();
      if (at - lastReportAt < REVAMP_REPORT_INTERVAL_MS) return;
      lastReportAt = at;
      await jobs.report(revampId, leaseToken, progress);
    } catch {
      // The card's "7 of 24" is a courtesy; it never stops a step.
    }
  };

  let parentRead: Promise<RevampJobRow | null> | null = null;
  const parentRow = (): Promise<RevampJobRow | null> => {
    if (!job.parentId) return Promise.resolve(null);
    parentRead ??= jobs.read(job.parentId);
    return parentRead;
  };
  const previousPlan = async (): Promise<RevampSitePlan | null> => {
    const parent = await parentRow();
    // ★ Never another store's plan, whatever the parent id says.
    if (!parent || parent.storeId !== job.storeId) return null;
    return parent.plan?.stage === "compiled" ? parent.plan.plan : null;
  };

  let chainRead: Promise<RevampJobRow[]> | null = null;
  /**
   * The versions a refinement builds on, newest first: its parent, then the
   * parent's parent, up to the full redesign (R-1). ★ Each one this store's
   * own, the rule `previousPlan` holds the parent to: the chain ends at a
   * version that cannot be read, another store's, or one already in it.
   */
  const earlierVersions = (): Promise<RevampJobRow[]> => {
    chainRead ??= (async () => {
      const chain: RevampJobRow[] = [];
      let next = job.parentId;
      while (next && chain.length < REVAMP_CHAIN_LIMIT) {
        const id: string = next;
        // A loop ends the chain before anything is read again.
        if (id === job.id || chain.some((version) => version.id === id)) break;
        let found: RevampJobRow | null;
        try {
          found = chain.length === 0 ? await parentRow() : await jobs.read(id);
        } catch (error) {
          // ★ An older version that cannot be read only means its photos
          //   are drawn again: a cost, never a broken redesign.
          if (chain.length === 0) throw error;
          logWarn("mink.revamp: an earlier version could not be read", {
            revampId,
            versionId: id,
            error: errorText(error),
          });
          break;
        }
        if (!found || found.id !== id || found.storeId !== job.storeId) break;
        chain.push(found);
        next = found.parentId;
      }
      return chain;
    })();
    return chainRead;
  };

  let memoryRead: Promise<readonly unknown[] | null> | null = null;
  /**
   * ★★ THE REDO MEMORY (robustness audit section 5, step 6): the plans of
   *   this store's own earlier redesigns, newest first, at most
   *   `REVAMP_EARLIER_PLANS_MAX`, read once per invocation for the planner,
   *   its repairs and the check. Never another store's (jobs.ts puts the
   *   store in the predicate) and never this job. ★ None for a refinement:
   *   it keeps its parent's design, and the memory asks for different
   *   choices. Null when the read failed, which only skips the memory.
   */
  const earlierPlans = (): Promise<readonly unknown[] | null> => {
    if (request.kind !== "full") return Promise.resolve([]);
    memoryRead ??= (async () => {
      try {
        const read = jobs.earlierPlans ?? (await memoryDefaults()).earlierPlans;
        return await read({
          storeId: job.storeId,
          revampId,
          limit: REVAMP_EARLIER_PLANS_MAX,
        });
      } catch (error) {
        logWarn("mink.revamp: earlier redesigns could not be read", {
          revampId,
          error: errorText(error),
        });
        return null;
      }
    })();
    return memoryRead;
  };

  /** The summary of those redesigns for the planner; "" when there is none. */
  const earlierDesigns = async (): Promise<string> =>
    earlierDesignsSummary((await earlierPlans()) ?? []);

  /**
   * Give the lease back. `counted` is said only when it differs from jobs.ts'
   * default for the kind of release (B8): false for a parked wait on Google,
   * true for a deadline that caught a stuck step.
   */
  const release = async (
    retryAfterMs?: number,
    terms: { progressed?: boolean; counted?: boolean } = {},
  ) => {
    // ★ What this invocation paid for since its last save rides on the
    //   hand-over (L2-F): a step that stops at the deadline has no save of
    //   its own, and its calls were billed all the same.
    const unsaved = unsavedUsage();
    const options = {
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(terms.progressed ? { progressed: true } : {}),
      ...(terms.counted !== undefined ? { counted: terms.counted } : {}),
      ...(unsaved ? { usage: unsaved } : {}),
    };
    try {
      if (Object.keys(options).length > 0) {
        await jobs.release(revampId, leaseToken, options);
      } else {
        await jobs.release(revampId, leaseToken);
      }
    } catch (error) {
      logWarn("mink.revamp: lease release failed", {
        revampId,
        error: errorText(error),
      });
    }
  };

  /**
   * Whether the step handing over stored new photos or studio photos in this
   * invocation (jobs-5), which makes the hand-over progress rather than a
   * failure. ★ A read that fails answers no: the hand-over is then judged by
   * its step alone (B8).
   */
  const storedSinceStepStart = async (): Promise<boolean> => {
    if (imagesAtStepStart === null) return false;
    try {
      const images = await jobs.listImages(revampId, job.storeId);
      return images.length > imagesAtStepStart;
    } catch (error) {
      logWarn("mink.revamp: progress check failed", {
        revampId,
        error: errorText(error),
      });
      return false;
    }
  };

  const settleStop = async (): Promise<RevampRunOutcome> => {
    switch (stop) {
      case "lease_lost":
        return "handover";
      case "cancelled": {
        let settled: Awaited<ReturnType<RevampRunnerJobs["cancel"]>>;
        const unsaved = unsavedUsage();
        try {
          settled = unsaved
            ? await jobs.cancel(revampId, leaseToken, unsaved)
            : await jobs.cancel(revampId, leaseToken);
        } catch (error) {
          logWarn("mink.revamp: cancel write failed", {
            revampId,
            error: errorText(error),
          });
          return "handover";
        }
        // ★★ A card an earlier invocation made and paid for is finished as
        //   ready by jobs.ts, never cancelled: the stop came too late to
        //   save the merchant anything.
        if (settled === "ready") {
          logInfo("mink.revamp: stop arrived after the card was made", {
            revampId,
            step: current,
          });
          return "ready";
        }
        if (settled === null) return "handover";
        logInfo("mink.revamp: cancelled", { revampId, step: current });
        return "cancelled";
      }
      case "deadline": {
        // ★★ A hand-over that stored photos gives the step its failure count
        //   back (jobs-5): the deadline is a turn, not a failure.
        const progressed = await storedSinceStepStart();
        // ★★ AND ONE THAT CAUGHT A STEP WAITING ON GOOGLE COUNTS NOTHING
        //   (B8): the planner, the shoot and the studio photos queue on the
        //   shared capacity and its pacer, and a busy evening outlasts an
        //   invocation without anything going wrong. Only a step that calls
        //   no model and was still running counts: it is stuck. Between two
        //   steps nothing was half done.
        const stuck =
          !progressed &&
          working !== null &&
          !REVAMP_GOOGLE_BOUND_STEPS.has(working);
        await release(undefined, {
          progressed,
          ...(stuck ? { counted: true } : {}),
        });
        // ★ Before the kick: the next invocation may land on this process,
        //   and must not be turned away by the run that asked for it.
        freeSlot();
        try {
          await jobs.kick(revampId);
        } catch {
          // The status poll kicks a stalled job too; a lost kick only waits.
        }
        logInfo("mink.revamp: handed over at the deadline", {
          revampId,
          step: current,
          progressed,
          counted: stuck,
        });
        return "handover";
      }
      default:
        await release(REVAMP_RETRY_AFTER_MS);
        return "handover";
    }
  };

  const failWith = async (
    code: RevampErrorCode,
    detail: string,
  ): Promise<RevampRunOutcome> => {
    if (stop === "lease_lost") return "handover";
    let settled: Awaited<ReturnType<RevampRunnerJobs["fail"]>>;
    const unsaved = unsavedUsage();
    try {
      settled = await jobs.fail({
        revampId,
        leaseToken,
        code,
        detail: detail.slice(0, 500),
        ...(unsaved ? { usage: unsaved } : {}),
      });
    } catch (error) {
      logWarn("mink.revamp: fail write failed", {
        revampId,
        code,
        error: errorText(error),
      });
      return "handover";
    }
    // ★★ A card an earlier invocation made and paid for is finished as ready
    //   by jobs.ts, never failed: failing it would keep the charge.
    if (settled === "ready") {
      logInfo("mink.revamp: failure arrived after the card was made", {
        revampId,
        code,
      });
      return "ready";
    }
    return "failed";
  };

  const settleError = async (
    error: unknown,
    step: RevampStep | "actor",
  ): Promise<RevampRunOutcome> => {
    if (error instanceof RevampHalted && error.reason === "lease_lost") {
      halt("lease_lost");
    }
    // ★ A step that drained at the deadline left work for the next run: the
    //   job is handed over at once, as at any deadline, never parked.
    if (error instanceof RevampDrainedError) halt("deadline");
    // ★ A stop outranks whatever the step threw: an abort makes a step throw,
    //   and the deadline's own error is not a verdict on the revamp.
    if (stop) return settleStop();
    if (error instanceof RevampStepError && !error.transient) {
      // ★ A store that ran out of credits is told so, in its own sentence.
      const code =
        error instanceof RevampOutOfCreditsError ? error.jobCode : error.code;
      logWarn("mink.revamp: step failed", { revampId, step, code });
      return failWith(code, error.message);
    }
    // ★ A step that knows its own wait (a limit shared with other stores that
    //   frees up as its window turns) is parked for that long; claiming again
    //   in a minute would only spend the job's attempts on refusals.
    const wait =
      error instanceof RevampRetryLaterError
        ? error.retryAfterMs
        : REVAMP_RETRY_AFTER_MS;
    // ★★ A wait on Google or on the platform's photo hour is parked as
    //   before but not counted (B8); any other transient failure (a database
    //   error, a claim that could not be recorded, a bug) is one of the step's
    //   failures, so the same real error `maxAttempts` times still fails it.
    const google =
      waitedOnGoogle(error) || (recoverable && infrastructureWait(error));
    logWarn("mink.revamp: step will be retried", {
      revampId,
      step,
      retryAfterMs: wait,
      counted: !google,
      error: errorText(error),
    });
    await release(wait, google ? { counted: false } : {});
    return "handover";
  };

  /** A mid-step save (the compile loop's repairs). */
  const checkpoint = async (
    step: RevampStep,
    patch: StepOutput["patch"],
  ): Promise<void> => {
    const before = stopNow();
    if (before === "lease_lost" || before === "cancelled") {
      throw new RevampHalted(before);
    }
    const written = usage;
    const saved = await jobs.save({
      revampId,
      leaseToken,
      step,
      progress,
      patch: { ...patch, usage: written },
    });
    if (!saved) throw new RevampHalted("lease_lost");
    savedUsage = written;
    applyPatch(patch);
    const after = stopNow();
    if (after) throw new RevampHalted(after);
  };

  /**
   * The photo steps' record of their claim (jobs-3, photo-hold.ts), written
   * under this lease. ★★ The local column follows the row, so the step's own
   *   save (which writes the whole column) never puts a cleared claim back
   *   and never drops one that is still held. False when the lease is gone:
   *   the run stops, and the next owner settles the claim from the record.
   */
  const hold = async (next: RevampPhotoHold | null): Promise<boolean> => {
    if (stopNow() === "lease_lost") return false;
    const saved = await jobs.hold({ revampId, leaseToken, hold: next });
    if (!saved) {
      halt("lease_lost");
      return false;
    }
    const rest = { ...state.result };
    delete rest.photoHold;
    state.result = next ? { ...rest, photoHold: next } : rest;
    return true;
  };

  /**
   * The photos step's record of its checks (P0, `ctx.photoReviews`), written
   * under this lease, the way `hold` writes the claim: the local column
   * follows the row, so the step's own save carries it. False when the lease
   * is gone: the run stops, and the next owner reads the record as it was.
   */
  const recordReviews = async (next: RevampPhotoReviews): Promise<boolean> => {
    if (stopNow() === "lease_lost") return false;
    const saved = await jobs.reviews({ revampId, leaseToken, reviews: next });
    if (!saved) {
      halt("lease_lost");
      return false;
    }
    state.result = { ...state.result, photoReviews: next };
    return true;
  };

  const applyPatch = (patch: StepOutput["patch"]) => {
    if (patch.snapshot !== undefined) state.snapshot = patch.snapshot;
    if (patch.plan !== undefined) state.plan = patch.plan;
    if (patch.result !== undefined) state.result = patch.result;
  };

  try {
    const started = now();
    const outcome = await drive();
    logInfo("mink.revamp: timeline", {
      revampId,
      outcome,
      invocationMs: Math.max(0, now() - started),
      wallMs: Math.max(0, now() - Date.parse(job.createdAt)),
      images: usage.images,
      reviews: usage.reviews,
      estimatedCostMicroUsd: usage.estimatedCostMicroUsd,
      recoverable,
      targetExceeded:
        typeof job.result?.targetReadyAt === "number" &&
        now() > job.result.targetReadyAt,
    });
    return { outcome };
  } finally {
    ended = true;
    clearTimeout(deadlineTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (leaseWatch) clearTimeout(leaseWatch);
    clearInterval(renewTimer);
    if (stopTimer) clearInterval(stopTimer);
  }

  async function drive(): Promise<RevampRunOutcome> {
    let actor: MinkActorContext | null;
    try {
      actor = await jobs.rebuildActor(
        {
          storeId: job.storeId,
          adminId: job.adminId,
          requesterEmail: job.requesterEmail,
          originRunId: job.originRunId,
        },
        requestId,
      );
    } catch (error) {
      return settleError(error, "actor");
    }
    if (stopNow()) return settleStop();
    // ★ The same two gates the proposal tool checked when the revamp started,
    //   asked again of the requester as they are now.
    if (
      !actor ||
      actor.draftingEnabled !== true ||
      !can(actor.permissions, "builder", "manage", actor.isSuperadmin)
    ) {
      return failWith(
        "not_allowed",
        actor
          ? "requester may not draft Website Builder changes"
          : "requester no longer has dashboard access",
      );
    }
    if (!job.originRunId) {
      return failWith("internal", "revamp has no origin run for its draft");
    }
    const ctx: RevampStepContext = {
      revampId,
      actor: actor.runId ? actor : { ...actor, runId: job.originRunId },
      signal: controller.signal,
      deadline,
      ...(recoverable ? { recoverable: true } : {}),
      report,
      draining: drainController.signal,
      photoHold: { held: () => state.result.photoHold ?? null, record: hold },
      photoReviews: {
        held: () => state.result.photoReviews ?? null,
        record: recordReviews,
      },
    };

    logInfo("mink.revamp: runner started", {
      revampId,
      storeId: job.storeId,
      step: job.step,
      // The step's failures so far; the claim counted none (B8).
      failures: job.attempts,
    });

    let index = Math.max(0, REVAMP_STEPS.indexOf(job.step));
    while (index < REVAMP_STEPS.length) {
      if (!stopNow() && now() >= deadline) halt("deadline");
      if (stopNow()) return settleStop();
      const step = REVAMP_STEPS[index];
      const redo = producerIndexFor(step);
      if (redo !== null && redo < index) {
        // ★ A later step whose input is gone (an unreadable column) goes back
        //   to the step that makes it, and on from there: the plan depends on
        //   the snapshot, so nothing downstream of a redo can be kept.
        logWarn("mink.revamp: redoing an earlier step", {
          revampId,
          at: step,
          from: REVAMP_STEPS[redo],
        });
        for (const later of REVAMP_STEPS.slice(redo)) {
          setState(later, "waiting", null);
        }
        // A shoot done over counts its photos from nothing again.
        photosReported = 0;
        photosTotal = 0;
        index = redo;
        continue;
      }
      current = step;
      working = step;
      setState(step, "running", null);

      if (step === "card") {
        try {
          return await cardStep(ctx);
        } catch (error) {
          return settleError(error, step);
        }
      }

      const stepStarted = now();
      let output: StepOutput;
      try {
        output = await runStep(step, ctx);
      } catch (error) {
        return settleError(error, step);
      }
      logInfo("mink.revamp: step done", {
        revampId,
        step,
        ms: Math.max(0, now() - stepStarted),
      });
      // ★ A step that returned is complete (steps throw when aborted), so its
      //   output is kept even at the deadline; a lost lease or a cancel keeps
      //   nothing.
      if (stopNow() === "lease_lost") return "handover";
      if (stopNow() === "cancelled") return settleStop();
      const next = REVAMP_STEPS[index + 1];
      setState(step, output.skipped ? "skipped" : "done");
      setState(next, "running", null);
      let saved: boolean;
      const written = usage;
      try {
        saved = await jobs.save({
          revampId,
          leaseToken,
          step: next,
          progress,
          patch: { ...output.patch, usage: written },
        });
      } catch (error) {
        return settleError(error, step);
      }
      if (!saved) {
        halt("lease_lost");
        return "handover";
      }
      savedUsage = written;
      applyPatch(output.patch);
      // The step is done; a hand-over from here is the next step's.
      imagesAtStepStart = null;
      working = null;
      index += 1;
    }
    // Unreachable: the card step always returns.
    return failWith("internal", "revamp ran past its last step");
  }

  /** The earliest step whose output `step` needs and does not have. */
  function producerIndexFor(step: RevampStep): number | null {
    const needs: RevampStep[] = [];
    const needsSnapshot =
      step === "plan" ||
      step === "compile" ||
      step === "photos" ||
      step === "assemble" ||
      step === "checks";
    if (needsSnapshot && !state.snapshot) needs.push("snapshot");
    if (step === "compile" && !state.plan) needs.push("plan");
    if (
      (step === "photos" || step === "products" || step === "assemble") &&
      state.plan?.stage !== "compiled"
    ) {
      needs.push(state.plan ? "compile" : "plan");
    }
    if (step === "assemble" && !state.result.photos) needs.push("photos");
    if (step === "assemble" && !state.result.products) needs.push("products");
    if ((step === "checks" || step === "card") && !state.result.stored) {
      needs.push("assemble");
    }
    if (step === "card" && state.result.checked !== true && !job.draftId) {
      needs.push("checks");
    }
    if (needs.length === 0) return null;
    return Math.min(...needs.map((need) => REVAMP_STEPS.indexOf(need)));
  }

  async function runStep(
    step: Exclude<RevampStep, "card">,
    ctx: RevampStepContext,
  ): Promise<StepOutput> {
    switch (step) {
      case "snapshot":
        return { patch: { snapshot: await deps.snapshot(ctx, request) } };
      case "plan": {
        const summary = await earlierDesigns();
        const call = await planCall(ctx, {
          request,
          snapshot: required(state.snapshot, "snapshot"),
          previous: await previousPlan(),
          revampId,
          ...(summary ? { earlierDesigns: summary } : {}),
        });
        spend(call.usage);
        return {
          patch: {
            plan: { stage: "raw", raw: call.raw, repairs: 0, issues: [] },
          },
        };
      }
      case "compile": {
        const { column, distinctness } = await compileStep(ctx);
        return {
          patch: {
            plan: column,
            // ★ Saved with the plan it describes, in the same fenced write.
            ...(distinctness
              ? { result: { ...state.result, distinctness } }
              : {}),
          },
        };
      }
      case "photos": {
        const plan = (await fitToBalance(ctx)).plan;
        const stored = await jobs.listImages(revampId, job.storeId);
        imagesAtStepStart = stored.length;
        const inherited = job.parentId
          ? [
              ...(await jobs.listImages(job.parentId, job.storeId)),
              ...(await olderKeptShots(plan)),
            ]
          : [];
        const run = await deps.photos(ctx, {
          plan,
          snapshot: required(state.snapshot, "snapshot"),
          stored,
          inherited,
          redraw: redrawFor(request.refineScope, plan),
          // ★★ The request resolves the goods keys the plan's shots name for
          //   the products the merchant sent ("p1"), the same catalogue the
          //   compiler validated them with (B16).
          request,
          // ★★ Not `spend(run.usage)` once it returns: each call is counted
          //   as it comes back, so the calls of a step that hands over at the
          //   deadline are counted too, and counting the total as well would
          //   count every one of them twice (L2-F).
          onUsage: spend,
        });
        return {
          patch: {
            result: { ...state.result, photos: { outcomes: run.outcomes } },
          },
        };
      }
      case "products": {
        const column = compiledColumn();
        // A plan saved before a revamp with no budget named its products
        // finds them the same way now.
        const only =
          column.productPhotoKeys ??
          deps.productPhotoKeys(column.plan, request);
        const wanted = request.products.some(
          (product) => Boolean(product.photoUrl) && only.includes(product.key),
        );
        if (!wanted) {
          return {
            patch: { result: { ...state.result, products: { failed: [] } } },
            skipped: true,
          };
        }
        const stored = await jobs.listImages(revampId, job.storeId);
        imagesAtStepStart = stored.length;
        // ★★ A refinement takes its parent's studio photo of each product it
        //   carries over (f-5): the card charges nothing for those, so drawing
        //   them again is a photograph StoreMink pays for twice. ★ And one an
        //   older version made, for a product the chain carries from it
        //   (R-1): the plan's basis names those carried as well.
        const carried = job.parentId
          ? deps.carriedProductPhotoKeys(column.plan, request)
          : [];
        const inherited =
          job.parentId && carried.length > 0
            ? [
                ...(await jobs.listImages(job.parentId, job.storeId)),
                ...(await olderStudioPhotos()),
              ]
            : [];
        const backdrop = productBackdrop(column.plan, state.snapshot);
        const run = await deps.products(ctx, {
          request,
          stored,
          only,
          inherited,
          carried,
          ...(backdrop ? { backdrop } : {}),
          // ★★ Counted per call, never the returned total too (L2-F).
          onUsage: spend,
        });
        return {
          patch: {
            result: {
              ...state.result,
              products: {
                failed: run.failed,
                // ★ Why a studio photo was drawn again (P0 diagnostics).
                ...(run.redraws && Object.keys(run.redraws).length > 0
                  ? { redraws: run.redraws }
                  : {}),
              },
            },
          },
        };
      }
      case "assemble": {
        const images = await jobs.listImages(revampId, job.storeId);
        const stored = deps.assemble({
          revampId,
          request,
          snapshot: required(state.snapshot, "snapshot"),
          plan: compiledColumn().plan,
          images,
          outcomes: required(state.result.photos, "photos").outcomes,
          productFailures: required(state.result.products, "products").failed,
          free: job.free,
          // ★ From the actor rebuilt for this invocation, never the job row:
          //   Apply refuses a whole card that writes the tagline for someone
          //   without Branding manage, so their card leaves it as it is.
          canChangeBrand: can(
            ctx.actor.permissions,
            "branding",
            "manage",
            ctx.actor.isSuperadmin,
          ),
        });
        // A fresh stored plan has not been checked, whatever the last one was.
        return {
          patch: { result: { ...state.result, stored, checked: false } },
        };
      }
      case "checks": {
        const run = await deps.checks(ctx, {
          plan: required(state.result.stored, "stored plan"),
          snapshot: required(state.snapshot, "snapshot"),
          request,
        });
        // ★★ A CHECK LEFT OPEN IS A NOTE ON THE CARD, NEVER A FAILURE
        //   (checks.ts): everything with a mechanical fix was fixed, and
        //   what remains (a merchant's own unfinished section, a wide
        //   opening photo with no phone crop, a claim in a menu link) is
        //   reported in plain words for the merchant to weigh. Failing the
        //   job here threw away eight paid photographs for advice, and the
        //   retry failed the same way.
        return {
          patch: {
            result: { ...state.result, stored: run.plan, checked: true },
          },
        };
      }
    }
  }

  async function compileStep(ctx: RevampStepContext): Promise<{
    column: RevampPlanColumn;
    distinctness: RevampDistinctnessRecord | null;
  }> {
    const column = required(state.plan, "plan");
    const snapshot = required(state.snapshot, "snapshot");
    let plan: RevampSitePlan;
    let keys: string[] | null;
    let unfitted: RevampSitePlan | null = null;
    let distinctness: RevampDistinctnessRecord | null = null;
    let measured: RevampMeasure | null = null;
    if (column.stage === "compiled") {
      plan = column.plan;
      keys = column.productPhotoKeys;
      unfitted = column.unfitted ?? null;
    } else {
      // ★ The repairs see what the plan call saw: the redesign's id and the
      //   summary of this store's earlier redesigns.
      const summary = await earlierDesigns();
      const inputs: RevampPlannerInput = {
        ...(recoverable ? { photoBudget: REVAMP_WORK_BUDGET.photos } : {}),
        request,
        snapshot,
        previous: await previousPlan(),
        revampId,
        ...(summary ? { earlierDesigns: summary } : {}),
      };
      plan = withCarriedProducts(
        await compileWithRepairs(column, inputs, ctx),
        await olderCarriedProductKeys(),
      );
      keys = null;
      // ★★ Before the budget fit (whose uncut copy is kept for a later
      //   re-fit) and before any photograph is drawn for it.
      const checked = await distinctFromEarlier(plan, snapshot);
      plan = checked.plan;
      distinctness = checked.record;
      measured = checked.measured;
    }
    // ★ THE BUDGET IS FITTED BEFORE ANY PHOTO IS DRAWN, and only when the job
    //   has one (a free revamp and an unmetered plan never do). A fitted plan
    //   always names its product keys, so `null` keys mean "not fitted yet".
    if (job.budgetCredits !== null && keys === null) {
      const fitted = deps.fitBudget(plan, {
        request:
          recoverable && request.kind === "full"
            ? withProductPhotosOnly(request, [])
            : request,
        budget: job.budgetCredits,
      });
      unfitted = plan;
      plan = fitted.plan;
      keys = fitted.productPhotoKeys;
      // ★★ The fit can drop what the check counted on (the design, a
      //   section with its photograph): the plan shoppers will see is
      //   checked again, so the record is that plan's (review fix, 25 Oct).
      if (measured && distinctness) {
        const again = afterFit(measured, plan, snapshot, distinctness);
        plan = again.plan;
        distinctness = again.record;
      }
    } else if (keys === null) {
      // ★ A revamp with no budget names its products too (f-5): "every
      //   product with a photo" took a studio photo of one the store already
      //   has, which is not created, so the photo showed nowhere.
      keys = deps.productPhotoKeys(plan, request);
    }
    if (recoverable && request.kind === "full") keys = [];
    if (distinctness) logDistinctness(distinctness);
    return {
      column: {
        stage: "compiled",
        plan,
        productPhotoKeys: keys,
        ...(unfitted ? { unfitted } : {}),
      },
      distinctness,
    };
  }

  /** The check's one log line: numbers and closed words only. */
  function logDistinctness(record: RevampDistinctnessRecord): void {
    logInfo("mink.revamp.distinctness", {
      revampId,
      status: record.status,
      passed: record.passed,
      bar: record.bar,
      before: record.before,
      after: record.after,
      changes: record.changed.length,
      ...(record.reason ? { reason: record.reason } : {}),
    });
  }

  /**
   * The fitted plan checked again (`makeDistinctAfterFit`), with the theme
   * and the earlier redesigns the first check used. A record that compared
   * nothing stays as it is; a check that throws keeps the fitted plan.
   */
  function afterFit(
    measured: RevampMeasure,
    fitted: RevampSitePlan,
    snapshot: RevampSnapshot,
    first: RevampDistinctnessRecord,
  ): { plan: RevampSitePlan; record: RevampDistinctnessRecord } {
    try {
      const again = makeDistinctAfterFit(
        measured.theme,
        fitted,
        measured.earlier,
        request,
        {
          storeId: job.storeId,
          revampId,
          keptSectionIds: revampKeptSectionIds(snapshot),
        },
        first,
      );
      return again
        ? { plan: again.plan, record: again.report }
        : { plan: fitted, record: first };
    } catch {
      return { plan: fitted, record: uncheckedRecord("error") };
    }
  }

  /**
   * ★★ THE REDO MEMORY'S CHECK (robustness audit section 5, step 6). A full
   *   redesign closer than the same-theme bar to one of this store's earlier
   *   redesigns has the choices the merchant did not ask about changed
   *   (`makeDistinct`: band rhythm, image sides, opening height, card style,
   *   font pairing, each from its closed list), measured over the store's
   *   current theme. Its record is numbers and closed words only, and so is
   *   its one log line (`mink.revamp.distinctness`, written by the caller
   *   once the fitted plan is checked again). `measured` is what it compared
   *   with, for that second check; null when it compared nothing.
   * ★★ IT NEVER FAILS OR DELAYS A REDESIGN: earlier redesigns that cannot be
   *   read, or a theme the registry cannot serve, skip it ("skipped" with
   *   the reason), and a check that throws keeps the plan as it was. A
   *   refinement keeps its parent's design and is never checked.
   */
  async function distinctFromEarlier(
    plan: RevampSitePlan,
    snapshot: RevampSnapshot,
  ): Promise<{
    plan: RevampSitePlan;
    record: RevampDistinctnessRecord | null;
    measured: RevampMeasure | null;
  }> {
    if (request.kind !== "full") return { plan, record: null, measured: null };
    const { earlier, theme } = await memoryForCheck(snapshot);
    let next = plan;
    let record: RevampDistinctnessRecord;
    let measured: RevampMeasure | null = null;
    if (!earlier) {
      record = uncheckedRecord("skipped", "earlier_unreadable");
    } else if (!theme) {
      record = uncheckedRecord("skipped", "theme_unavailable");
    } else {
      try {
        const result = makeDistinct(theme, plan, earlier, request, {
          storeId: job.storeId,
          revampId,
          keptSectionIds: revampKeptSectionIds(snapshot),
        });
        next = result.plan;
        record = result.report;
        measured = { theme, earlier };
      } catch {
        // ★ makeDistinct keeps the plan on its own failures; this guard is
        //   the runner's, so not even a broken check can stop a redesign.
        record = uncheckedRecord("error");
      }
    }
    return { plan: next, record, measured };
  }

  /**
   * This store's earlier redesigns (read once per invocation) and its
   * current theme (the snapshot's id and version), for the check. Either is
   * null when it could not be read: the check is then skipped, never the
   * redesign.
   */
  async function memoryForCheck(snapshot: RevampSnapshot): Promise<{
    earlier: readonly unknown[] | null;
    theme: ThemeDefinition | null;
  }> {
    const earlier = await earlierPlans();
    let theme: ThemeDefinition | null = null;
    if (earlier) {
      try {
        const read = jobs.theme ?? (await memoryDefaults()).theme;
        theme = await read({
          id: snapshot.theme.id,
          version: snapshot.theme.version ?? null,
        });
      } catch (error) {
        logWarn(
          "mink.revamp: the theme for the distinctness check could not be read",
          {
            revampId,
            error: errorText(error),
          },
        );
      }
    }
    return { earlier, theme };
  }

  /**
   * ★★ A PAID REVAMP CHECKS THE STORE CAN STILL PAY BEFORE ANY PHOTOGRAPH.
   *   Its budget was read when it started, and the balance can fall while
   *   the plan is written (another chat or a photo tool spends from it);
   *   finding out only at the card's charge means every paid model and
   *   photo call came first, for a card that then fails. So the balance is
   *   read again (the read the start tool budgets from): while it covers
   *   what the card could charge, nothing changes; otherwise the plan is
   *   fitted afresh to what is left, and when not even the card's fixed part
   *   fits, the job fails now with the code that says the store ran out.
   * ★ Not again for what the starting run costs: the start kept that back,
   *   and the run is settled long before the plan is written.
   */
  async function fitToBalance(
    ctx: RevampStepContext,
  ): Promise<Extract<RevampPlanColumn, { stage: "compiled" }>> {
    const column = compiledColumn();
    if (job.free || job.budgetCredits === null) return column;
    const remaining = await deps.balance(ctx);
    // The plan became unmetered since the start: nothing to fit.
    if (remaining === null) return column;
    const keys = column.productPhotoKeys ?? [];
    const charge = deps.estimate(column.plan, {
      request,
      productPhotoKeys: keys,
    }).total;
    if (remaining >= charge) return column;
    const budget = Math.max(0, Math.min(job.budgetCredits, remaining));
    // ★ Fitted afresh from the plan before the first cut, so "Not done this
    //   time" lists each thing left out once. A column saved before that
    //   copy existed is fitted again as it is, with the product photos the
    //   first fit already left out withheld for the same reason.
    const fitted = column.unfitted
      ? deps.fitBudget(column.unfitted, {
          request:
            recoverable && request.kind === "full"
              ? withProductPhotosOnly(request, [])
              : request,
          budget,
        })
      : deps.fitBudget(column.plan, {
          request: withProductPhotosOnly(
            request,
            recoverable && request.kind === "full" ? [] : keys,
          ),
          budget,
        });
    const total = deps.estimate(fitted.plan, {
      request,
      productPhotoKeys: fitted.productPhotoKeys,
    }).total;
    if (total > budget) {
      // ★ The fit never drops the homepage's words, the header and footer,
      //   the opening photograph or the confirmed categories: a total above
      //   the budget is that part alone, which this store cannot pay.
      throw new RevampOutOfCreditsError(
        "the store's balance no longer covers the redesign's fixed part",
      );
    }
    // ★★ The plan fitted again is the one shoppers will see: the redo
    //   memory's record is made that plan's too (review fix, 25 Oct).
    const checked = await recheckRefitted(fitted.plan);
    const next: Extract<RevampPlanColumn, { stage: "compiled" }> = {
      stage: "compiled",
      plan: checked.plan,
      productPhotoKeys:
        recoverable && request.kind === "full" ? [] : fitted.productPhotoKeys,
      ...(column.unfitted ? { unfitted: column.unfitted } : {}),
    };
    logInfo("mink.revamp: plan fitted again to the store's balance", {
      revampId,
      shots: next.plan.shots.length,
      productPhotos: fitted.productPhotoKeys.length,
    });
    // Saved before any photograph, so a resumed run draws for this plan.
    await checkpoint("photos", {
      plan: next,
      ...(checked.record
        ? { result: { ...state.result, distinctness: checked.record } }
        : {}),
    });
    return next;
  }

  /**
   * A plan fitted again to the store's balance, checked again against this
   * store's earlier redesigns when the compile step's check compared it with
   * them. Null record: nothing to update (a refinement, a first redesign, a
   * check that was skipped or failed). Earlier redesigns or a theme that can
   * no longer be read leave the plan as fitted and record the check skipped.
   */
  async function recheckRefitted(fitted: RevampSitePlan): Promise<{
    plan: RevampSitePlan;
    record: RevampDistinctnessRecord | null;
  }> {
    const first = state.result.distinctness;
    if (
      request.kind !== "full" ||
      !first ||
      !["distinct", "changed", "too-close"].includes(first.status)
    ) {
      return { plan: fitted, record: null };
    }
    const snapshot = required(state.snapshot, "snapshot");
    const { earlier, theme } = await memoryForCheck(snapshot);
    const checked =
      earlier && theme
        ? afterFit({ theme, earlier }, fitted, snapshot, first)
        : {
            plan: fitted,
            record: uncheckedRecord(
              "skipped",
              earlier ? "theme_unavailable" : "earlier_unreadable",
            ),
          };
    logDistinctness(checked.record);
    return checked;
  }

  async function compileWithRepairs(
    column: Extract<RevampPlanColumn, { stage: "raw" }>,
    inputs: RevampPlannerInput,
    ctx: RevampStepContext,
  ): Promise<RevampSitePlan> {
    /**
     * The plan the lenient finaliser makes from the last answer after a
     * repair failed, or null when nothing in it is usable (no pages).
     * ★★ Recorded on the column before the plan is used, so a step that is
     *   claimed again (a lost lease, a crash, a save that failed) finalises
     *   at once instead of paying for the repair that already failed.
     */
    const finalizeAfterFailedRepair = async (
      last: unknown,
      repairsSoFar: number,
      issues: string[],
      reason: string,
    ): Promise<RevampSitePlan | null> => {
      let plan: RevampSitePlan;
      try {
        plan = deps.finalize(last, inputs);
      } catch (error) {
        logWarn("mink.revamp: compile repair failed, nothing to finalize", {
          revampId,
          repairs: repairsSoFar,
          reason: reason.slice(0, TRACE_ISSUE_CHARS),
          error: errorText(error),
        });
        return null;
      }
      logInfo("mink.revamp: compile repair failed, finalized instead", {
        revampId,
        repairs: repairsSoFar,
        reason: reason.slice(0, TRACE_ISSUE_CHARS),
        ...issueTrace(issues),
      });
      await checkpoint("compile", {
        plan: {
          stage: "raw",
          raw: last,
          repairs: repairsSoFar,
          issues,
          repairFailed: true,
        },
      });
      return plan;
    };

    let raw = column.raw;
    let repairs = column.repairs;
    // ★★ A REPAIR THE MODEL COULD NOT ANSWER IS NEVER ASKED AGAIN (L2-B).
    //   The live run asked the same repair five times, six minutes each,
    //   across four claims, then failed the redesign out of attempts with a
    //   plan the finaliser could have used all along.
    const failedBefore = column.repairFailed === true;
    for (;;) {
      const compiled = deps.compile(raw, inputs);
      if (compiled.plan) return compiled.plan;
      // ★ Two repairs, then the mechanical finaliser: a third model call is
      //   rarely better than dropping what still fails, and each one is paid.
      if (repairs >= REVAMP_MAX_REPAIRS || failedBefore) {
        logInfo("mink.revamp: compile finalized", {
          revampId,
          repairs,
          ...(failedBefore ? { repairFailed: true } : {}),
          ...issueTrace(compiled.issues),
        });
        return deps.finalize(raw, inputs);
      }
      ctx.signal.throwIfAborted();
      if (recoverable && !plannerCallFits()) throw new RevampDrainedError();
      // ★ No repair is started once the deadline has passed (jobs-4): the
      //   answered ones are saved, and the next run carries on from them.
      if (ctx.draining?.aborted) throw new RevampDrainedError();
      // ★ The trace of why a plan was slow: the job row keeps only the
      //   compiled plan, so these issues are gone once the compile finishes.
      logInfo("mink.revamp: compile repair", {
        revampId,
        repair: repairs + 1,
        ...issueTrace(compiled.issues),
      });
      let call: RevampModelCall;
      try {
        call = await deps.repair(ctx, {
          ...inputs,
          raw,
          issues: compiled.issues,
        });
      } catch (error) {
        // ★ A stop outranks it (the lease, a cancel, the hard stop, a call
        //   the drain never sent): nothing is decided for a run that is over.
        if (isStop(error, ctx)) throw error;
        const plan = await finalizeAfterFailedRepair(
          raw,
          repairs,
          compiled.issues,
          errorText(error),
        );
        // ★ With nothing the finaliser can use, the repair is the only way
        //   on: the step is retried later, as any transient failure is.
        if (plan) return plan;
        throw error;
      }
      spend(call.usage);
      repairs += 1;
      if (hasAnswer(call.raw) || !hasAnswer(raw)) {
        raw = call.raw;
      } else {
        // ★ An answer that cannot be read is a failed repair too: the last
        //   answer the model gave is still there to finalise, and it was
        //   being thrown away for the unreadable one (then a third repair, or
        //   plan_invalid). Kept for the next repair when it cannot be used.
        const plan = await finalizeAfterFailedRepair(
          raw,
          repairs,
          compiled.issues,
          "the repair's answer could not be read",
        );
        if (plan) return plan;
      }
      // Saved at once, so a repair the model already answered is never paid
      // for twice by a resumed run.
      await checkpoint("compile", {
        plan: { stage: "raw", raw, repairs, issues: compiled.issues },
      });
    }
  }

  /**
   * The plan step's model call, asked once more in the same invocation when
   * the first fails for a busy or slow model and a whole call still fits
   * before the deadline (L2-B, `REVAMP_PLAN_CALLS_PER_RUN`). ★ Anything else
   *   (a refusal, a configuration fault, a stop, the drain) is settled as it
   *   always was.
   */
  function plannerCallFits(): boolean {
    return (
      now() + REVAMP_PLAN_RETRY_MIN_LEFT_MS + REVAMP_LIMITS.hardStopMarginMs <
      deadline + REVAMP_DEADLINE_GRACE_MS
    );
  }

  async function planCall(
    ctx: RevampStepContext,
    input: RevampPlannerInput,
  ): Promise<RevampModelCall> {
    for (let calls = 1; ; calls += 1) {
      if (recoverable && !plannerCallFits()) throw new RevampDrainedError();
      try {
        return await deps.plan(ctx, input);
      } catch (error) {
        if (
          calls >= REVAMP_PLAN_CALLS_PER_RUN ||
          !askAgainNow(error, ctx) ||
          deadline - now() < REVAMP_PLAN_RETRY_MIN_LEFT_MS
        ) {
          throw error;
        }
        logInfo("mink.revamp: plan call failed, asking again in this run", {
          revampId,
          call: calls,
          error: errorText(error),
        });
      }
    }
  }

  /**
   * A model that was busy or slow, while this invocation still runs freely:
   * never once the deadline drains it, when no new paid call may start.
   */
  function askAgainNow(error: unknown, ctx: RevampStepContext): boolean {
    return (
      error instanceof RevampStepError &&
      error.transient &&
      error.code === "model_unavailable" &&
      !(error instanceof RevampRetryLaterError) &&
      !isStop(error, ctx) &&
      ctx.draining?.aborted !== true
    );
  }

  /**
   * Whether `error` is this invocation stopping, not the call failing: the
   * lease, a cancel, the hard stop, or a call the drain never sent. ★ A call
   *   that was sent and failed during the drain is a failure like any other.
   */
  function isStop(error: unknown, ctx: RevampStepContext): boolean {
    return (
      error instanceof RevampHalted ||
      error instanceof RevampDrainedError ||
      ctx.signal.aborted ||
      stopNow() !== null
    );
  }

  async function cardStep(ctx: RevampStepContext): Promise<RevampRunOutcome> {
    const stored = required(state.result.stored, "stored plan");
    let draftId = job.draftId;
    let credits = job.credits;
    if (!draftId) {
      // ★★ The lease is asked right before the charge, not left to the
      //   once-a-minute timer: renewing reads the cancel flag, so a Stop the
      //   merchant pressed during the last minute is honoured here and
      //   nothing is charged for it. ★ A renewal that threw read no flag, so
      //   no card is made on it: the job is parked, as it always was (D1
      //   spares only paid work in flight, and none is in flight here).
      if (!(await renewOnce())) halt("renew_failed");
      // ★ Checked before the charge: a card made for a job nobody can finish
      //   is a charge with nothing to show for it.
      if (stopNow()) return settleStop();
      const card = await deps.card(ctx, { plan: stored, free: job.free });
      draftId = card.draftId;
      credits = card.credits;
    }
    // ★ Once the card exists it is finished even if a cancel or the deadline
    //   arrived meanwhile: the draft is made and paid for, and leaving it
    //   unattached is the one outcome that helps nobody. Only a lost lease
    //   stops here, because the fenced write could not land anyway.
    if (stopNow() === "lease_lost") return "handover";
    const finished = await jobs.finish({
      revampId,
      leaseToken,
      draftId,
      credits,
      result: state.result,
      usage,
    });
    if (!finished) {
      halt("lease_lost");
      return "handover";
    }
    setState("card", "done");
    try {
      // recordEvent, not emitEvent: a background route has no after().
      // ★ The same notice a settlement that finishes a made card sends
      //   (jobs.ts), to the admin who asked and nobody else, opening the
      //   chat the card is in (B20).
      await jobs.notify(
        revampReadyEvent({
          id: revampId,
          storeId: job.storeId,
          adminId: job.adminId,
          conversationId: job.conversationId,
        }),
      );
    } catch (error) {
      logWarn("mink.revamp: ready notification failed", {
        revampId,
        error: errorText(error),
      });
    }
    logInfo("mink.revamp: card ready", {
      revampId,
      storeId: job.storeId,
      free: job.free,
    });
    return "ready";
  }

  function compiledColumn(): Extract<RevampPlanColumn, { stage: "compiled" }> {
    const column = state.plan;
    if (column?.stage !== "compiled") {
      throw new RevampStepError("internal", "plan is not compiled", false);
    }
    return column;
  }

  // ── What older versions of a refinement left (R-1) ─────────────────────
  // ★★ The parent's photos were all a refinement ever carried, so a product
  //   the chain carries from further up (an older version undone after its
  //   child was made, whose products come back into the carry) had its
  //   studio photo drawn again and charged. The parent's photos still come
  //   first and whole; each older version adds only what this revamp carries
  //   from it, and the photos and products steps keep the newest of each.

  /** Each older version (the parent's parent and up), with the products this revamp carries from it. */
  async function olderVersionsCarrying(): Promise<
    Array<{ version: RevampJobRow; keys: Set<string> }>
  > {
    if (!job.parentId) return [];
    const older = (await earlierVersions()).slice(1);
    return older.map((version) => ({
      version,
      keys: new Set(
        request.products
          .filter((product) =>
            version.request.products.some((theirs) =>
              sameProduct(product, theirs),
            ),
          )
          .map((product) => product.key),
      ),
    }));
  }

  /** The request's products an older version asked for as they are now. */
  async function olderCarriedProductKeys(): Promise<string[]> {
    const keys = new Set(
      (await olderVersionsCarrying()).flatMap(({ keys }) => [...keys]),
    );
    return request.products
      .map((product) => product.key)
      .filter((key) => keys.has(key));
  }

  /** The studio photos older versions made of the products carried from them. */
  async function olderStudioPhotos(): Promise<RevampStoredImage[]> {
    const photos: RevampStoredImage[] = [];
    for (const { version, keys } of await olderVersionsCarrying()) {
      if (keys.size === 0) continue;
      for (const image of await imagesOf(version)) {
        if (image.role === "product" && keys.has(image.slotId)) {
          photos.push(image);
        }
      }
    }
    return photos;
  }

  /**
   * The photographs older versions took of the shots this plan keeps, each
   * only where that version's shot is the same one (subject and shape), so
   * a new shot that reuses an old id never gets an older version's picture.
   * The phone crop is cut again from the photo carried over.
   */
  async function olderKeptShots(
    plan: RevampSitePlan,
  ): Promise<RevampStoredImage[]> {
    const kept = new Set(plan.basis?.carried?.shots ?? []);
    if (!job.parentId || kept.size === 0) return [];
    const ours = new Map(
      plan.shots.filter((shot) => kept.has(shot.id)).map((s) => [s.id, s]),
    );
    const photos: RevampStoredImage[] = [];
    for (const version of (await earlierVersions()).slice(1)) {
      const theirs =
        version.plan?.stage === "compiled" ? version.plan.plan.shots : [];
      const same = new Set(
        theirs
          .filter((shot) => {
            const mine = ours.get(shot.id);
            return (
              !!mine &&
              mine.subject === shot.subject &&
              mine.aspectRatio === shot.aspectRatio
            );
          })
          .map((shot) => shot.id),
      );
      if (same.size === 0) continue;
      for (const image of await imagesOf(version)) {
        if (image.role === "slot" && same.has(image.slotId)) {
          photos.push(image);
        }
      }
    }
    return photos;
  }

  /** An older version's photo rows, this store's only; none when unreadable. */
  async function imagesOf(version: RevampJobRow): Promise<RevampStoredImage[]> {
    try {
      return await jobs.listImages(version.id, job.storeId);
    } catch (error) {
      logWarn("mink.revamp: an earlier version's photos could not be read", {
        revampId,
        versionId: version.id,
        error: errorText(error),
      });
      return [];
    }
  }
}

/**
 * One product as two versions of a redesign asked for it: the same key, name
 * and photo. ★ Keys alone are not enough: before every key a chain used was
 * reserved, a refinement's new product could take a key an older version
 * had given another product, and its studio photo is of that other item.
 */
function sameProduct(
  a: Pick<RevampProductInput, "key" | "name" | "photoUrl">,
  b: Pick<RevampProductInput, "key" | "name" | "photoUrl">,
): boolean {
  return (
    a.key === b.key &&
    revampProductNameKey(a.name) === revampProductNameKey(b.name) &&
    (a.photoUrl ?? null) === (b.photoUrl ?? null)
  );
}

/**
 * The compiled plan with the products an older version made (R-1) counted
 * as carried, the way the compiler counts the parent's. ★ The basis is the
 *   one rule the charge, the budget fit and the carry-over all read
 *   (assemble.ts `productPhotoRule`), so a product carried from further up
 *   is never charged and its photo is carried over, not drawn again.
 */
function withCarriedProducts(
  plan: RevampSitePlan,
  keys: readonly string[],
): RevampSitePlan {
  const basis = plan.basis;
  const carried = basis?.carried;
  if (!basis || !carried || keys.length === 0) return plan;
  const have = new Set(carried.products);
  const more = keys.filter((key) => !have.has(key));
  if (more.length === 0) return plan;
  return {
    ...plan,
    basis: {
      ...basis,
      carried: { ...carried, products: [...carried.products, ...more] },
    },
  };
}

/** Whether the model gave an answer at all (an unreadable one is null). */
function hasAnswer(raw: unknown): boolean {
  return raw !== null && raw !== undefined;
}

/**
 * The record of a redo-memory check that compared nothing: "skipped" (the
 * earlier redesigns or the theme could not be read, `reason` says which) or
 * "error" (the check itself failed). Either way the plan went on unchanged.
 */
function uncheckedRecord(
  status: "skipped" | "error",
  reason?: RevampDistinctnessSkip,
): RevampDistinctnessRecord {
  return {
    status,
    ...(reason ? { reason } : {}),
    passed: false,
    bar: null,
    before: [],
    after: [],
    changed: [],
    kept: [],
  };
}

/**
 * The redo memory's two reads as production makes them, for a runner whose
 * side effects leave them out: jobs.ts for this store's earlier plans, the
 * runtime registry for its theme. Imported on demand, like every other real
 * side effect here.
 */
async function memoryDefaults(): Promise<
  Required<Pick<RevampRunnerJobs, "earlierPlans" | "theme">>
> {
  const [jobs, registry] = await Promise.all([
    import("./jobs"),
    import("@/lib/themes/runtime-registry"),
  ]);
  return {
    earlierPlans: jobs.readEarlierRevampPlans,
    theme: (theme) =>
      registry.resolveInstalledThemeDefinition({
        id: theme.id,
        ...(theme.version ? { version: theme.version } : {}),
      }),
  };
}

function sameUsage(a: RevampUsage, b: RevampUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.thinkingTokens === b.thinkingTokens &&
    a.images === b.images &&
    a.reviews === b.reviews &&
    a.estimatedCostMicroUsd === b.estimatedCostMicroUsd &&
    // ★ A hand-over that only counted refusals still carries them (P0).
    JSON.stringify(a.calls ?? {}) === JSON.stringify(b.calls ?? {})
  );
}

/**
 * The request with the photo taken off every product whose studio photo the
 * first fit left out, for fitting a cut plan again: a product the fit sees
 * no photo for is neither bought nor listed as left out a second time. Only
 * the fit reads this copy; every later step works from the real request.
 */
function withProductPhotosOnly(
  request: RevampRequest,
  keys: readonly string[],
): RevampRequest {
  const kept = new Set(keys);
  return {
    ...request,
    products: request.products.map((product) =>
      kept.has(product.key) ? product : { ...product, photoUrl: null },
    ),
  };
}

/** Which shots a refinement redraws; null redraws only what is missing. */
export function redrawFor(
  scope: RevampRefineScope | null | undefined,
  plan: Pick<RevampSitePlan, "shots">,
): string[] | null {
  const photos = scope?.photos;
  if (photos === "all") return plan.shots.map((shot) => shot.id);
  if (Array.isArray(photos)) {
    return [
      ...new Set(
        photos.filter(
          (id): id is string => typeof id === "string" && id !== "",
        ),
      ),
    ];
  }
  return null;
}

/** Issues a compile log line carries, and how much of each. */
const TRACE_ISSUES = 5;
const TRACE_ISSUE_CHARS = 200;

/**
 * The compiler's issue sentences for a log line: how many, and the first few,
 * each cut short. ★ Bounded, so a plan with a hundred problems is one short
 *   line, and the sentences are the compiler's own (a quoted heading at most),
 *   never the merchant's brief or the plan itself.
 */
function issueTrace(issues: readonly string[]): {
  issueCount: number;
  issues: string[];
} {
  return {
    issueCount: issues.length,
    issues: issues
      .slice(0, TRACE_ISSUES)
      .map((issue) => String(issue).slice(0, TRACE_ISSUE_CHARS)),
  };
}

/**
 * The backdrop every studio photo of the revamp shares: the page colour the
 * redesign sets, else the one the theme already shows. ★ One colour for the
 * whole run, so the shop grid reads as one shoot; products.ts accepts only a
 * hex colour from it.
 */
function productBackdrop(
  plan: RevampSitePlan,
  snapshot: RevampSnapshot | null,
): string | null {
  return plan.design?.palette?.cream ?? snapshot?.theme?.palette?.page ?? null;
}

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new RevampStepError("internal", `missing ${what}`, false);
  }
  return value;
}

function readUsage(value: unknown): RevampUsage {
  const row =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const usage: RevampUsage = { ...ZERO_REVAMP_USAGE };
  for (const key of USAGE_NUMBERS) {
    const n = row[key];
    usage[key] = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  }
  // ★ The per-model counts of tries with no answer (P0), the readable ones.
  const calls = readCalls(row.calls);
  return calls ? { ...usage, calls } : usage;
}

const USAGE_NUMBERS = [
  "inputTokens",
  "outputTokens",
  "thinkingTokens",
  "images",
  "reviews",
  "estimatedCostMicroUsd",
] as const satisfies ReadonlyArray<keyof RevampUsage>;

function readCalls(value: unknown): RevampUsage["calls"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const count = (n: unknown) =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : 0;
  const out: NonNullable<RevampUsage["calls"]> = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!model || !raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const rateLimited = count(entry.rateLimited);
    const timeouts = count(entry.timeouts);
    if (rateLimited > 0 || timeouts > 0) {
      out[model] = { rateLimited, timeouts };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const STEP_STATES: ReadonlySet<RevampStepState> = new Set([
  "waiting",
  "running",
  "done",
  "skipped",
]);

function readProgress(value: unknown): RevampProgressItem[] {
  const list = Array.isArray(value) ? value : [];
  return initialRevampProgress().map((item) => {
    const found = list.find(
      (entry) => entry && typeof entry === "object" && entry.step === item.step,
    ) as Partial<RevampProgressItem> | undefined;
    if (!found || !STEP_STATES.has(found.state as RevampStepState)) return item;
    return {
      step: item.step,
      state: found.state as RevampStepState,
      detail: typeof found.detail === "string" ? found.detail : null,
    };
  });
}

function boundedDetail(detail: string | null): string | null {
  if (typeof detail !== "string") return null;
  const text = detail.trim().slice(0, 60);
  return text || null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown";
}

/**
 * A closed, content-free word for why a database call threw (D1): the pool's
 * reason (DatabaseBusyError), the SQLSTATE or system code (`57014`,
 * `ECONNRESET`), else the error's class name. ★ Never its message: a failed
 * query's carries its SQL text and parameters.
 */
function failureCode(error: unknown): string {
  const word = (value: unknown): string | null =>
    typeof value === "string" && /^[A-Za-z0-9_]{1,40}$/.test(value)
      ? value
      : null;
  if (error instanceof Error && error.name === "DatabaseBusyError") {
    const reason = word((error as { reason?: unknown }).reason);
    if (reason) return reason;
  }
  return (
    word(pgErrorCode(error)) ??
    (error instanceof Error ? word(error.name) : null) ??
    "unknown"
  );
}

/**
 * ★★ A transient failure that is only a wait (robustness audit B8): a step
 *   that named its own wait (`RevampRetryLaterError`, the platform's photo
 *   hour), or Google that could not answer yet (`GOOGLE_WAIT_CODES`). Nothing
 *   else qualifies, so a database error or a bug keeps counting.
 */
function waitedOnGoogle(error: unknown): boolean {
  if (error instanceof RevampRetryLaterError) return true;
  return (
    error instanceof RevampStepError &&
    error.transient &&
    GOOGLE_WAIT_CODES.has(error.code)
  );
}

/** Retry recognized transport/transaction failures; programming faults still count. */
function infrastructureWait(error: unknown): boolean {
  const code = pgErrorCode(error);
  return (
    (typeof code === "string" &&
      (code.startsWith("08") ||
        [
          "40001",
          "40P01",
          "53300",
          "57P01",
          "57P02",
          "57P03",
          "ECONNRESET",
          "ECONNREFUSED",
          "ETIMEDOUT",
          "EPIPE",
          "EAI_AGAIN",
        ].includes(code))) ||
    (error instanceof Error && error.name === "DatabaseBusyError")
  );
}

async function defaultRevampRunnerJobs(): Promise<RevampRunnerJobs> {
  // Imported on demand so the runner (and its tests, which pass their own
  // jobs) never load the database client unless they run for real.
  const [jobs, actor, images, trigger, record] = await Promise.all([
    import("./jobs"),
    import("./actor"),
    import("./image-store"),
    import("./trigger"),
    import("@/lib/notifications/record"),
  ]);
  return {
    claim: jobs.claimRevampJob,
    renew: jobs.renewRevampLease,
    release: jobs.releaseRevampLease,
    save: jobs.saveRevampStep,
    report: jobs.reportRevampProgress,
    finish: jobs.finishRevampReady,
    fail: jobs.failRevampJob,
    cancel: jobs.markRevampCancelled,
    read: jobs.readRevampJob,
    rebuildActor: actor.rebuildRevampActor,
    listImages: images.listRevampImages,
    kick: trigger.kickRevampRunner,
    kickWaiting: (exceptRevampId) => jobs.kickWaitingRevamp(exceptRevampId),
    hold: jobs.holdRevampPhotos,
    reviews: jobs.recordRevampPhotoReviews,
    stopRequested: jobs.revampStopRequested,
    notify: (event) => record.recordEvent(event),
    // ★ No `earlierPlans` or `theme`: the runner reads both the production
    //   way when they are absent (`memoryDefaults`), one path for this and
    //   every caller that builds its own side effects.
  };
}
