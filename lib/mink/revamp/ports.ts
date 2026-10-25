import "server-only";

// ---------------------------------------------------------------------------
// The revamp runner's ports: what each step needs from the module that owns
// it. The runner (runner.ts) calls only these, through a `RevampDeps` object,
// so every step can be faked in a test and every module can be built and
// tested on its own (docs/mink-storefront-revamp.md, section 3).
//
// Owners:
//   snapshot          → snapshot.ts      readRevampSnapshot
//   plan, repair      → site-planner.ts  planRevampSite, repairRevampSite
//   compile, finalize → site-compiler.ts compileRevampSite, finalizeRevampSite
//   fitBudget         → assemble.ts      fitRevampPlanToBudget
//   productPhotoKeys  → assemble.ts      revampProductPhotoKeys
//   carriedProductPhotoKeys
//                     → assemble.ts      revampCarriedProductPhotoKeys
//   estimate          → assemble.ts      estimateRevampCredits
//   balance           → card.ts          readRevampCreditBalance
//   photos            → photos.ts        drawRevampPhotos
//   products          → products.ts      makeRevampProductPhotos
//   assemble          → assemble.ts      assembleRevampPlan
//   checks            → checks.ts        runRevampChecks
//   card              → card.ts          createRevampCard
//
// deps.ts (`defaultRevampDeps()`) binds these to the production clients;
// tests pass fakes.
// ---------------------------------------------------------------------------

import type { MinkActorContext } from "../types";
import type {
  RevampCreditBreakdown,
  RevampPhotoOutcome,
  RevampRedraw,
  RevampRequest,
  RevampSitePlan,
  RevampSnapshot,
  RevampStoredImage,
  RevampStoredPlan,
} from "./contract";
import { RevampStepError, type RevampStepErrorCode } from "./step-error";

/** Provider usage a step spent, summed into the job's `usage`. */
export interface RevampUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  images: number;
  reviews: number;
  /** Estimated provider cost in micro-USD (an estimate; Vertex billing rules). */
  estimatedCostMicroUsd: number;
  /**
   * ★ Provider tries that did not get an answer, per model (the model key,
   *   such as "gemini-3-pro-image"): refused with 429, and cut off by our own
   *   clock. Diagnostics, never billed: a 429 is refused before the model
   *   runs. Counted as each call returns, like the rest of this record, so a
   *   live run that hands over three times still says how often Google's
   *   shared pool turned it away. Absent while nothing was refused.
   */
  calls?: Record<string, RevampCallCounts>;
}

/** One model's tries that got no answer (`RevampUsage.calls`). */
export interface RevampCallCounts {
  rateLimited: number;
  timeouts: number;
}

export const ZERO_REVAMP_USAGE: RevampUsage = {
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  images: 0,
  reviews: 0,
  estimatedCostMicroUsd: 0,
};

export function addRevampUsage(a: RevampUsage, b: RevampUsage): RevampUsage {
  const calls = addRevampCalls(a.calls, b.calls);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    images: a.images + b.images,
    reviews: a.reviews + b.reviews,
    estimatedCostMicroUsd: a.estimatedCostMicroUsd + b.estimatedCostMicroUsd,
    ...(calls ? { calls } : {}),
  };
}

/** Two per-model counts summed; undefined when neither counted anything. */
function addRevampCalls(
  a: RevampUsage["calls"],
  b: RevampUsage["calls"],
): RevampUsage["calls"] {
  if (!a && !b) return undefined;
  const sum: Record<string, RevampCallCounts> = {};
  for (const counts of [a, b]) {
    for (const [model, count] of Object.entries(counts ?? {})) {
      const before = sum[model] ?? { rateLimited: 0, timeouts: 0 };
      sum[model] = {
        rateLimited: before.rateLimited + count.rateLimited,
        timeouts: before.timeouts + count.timeouts,
      };
    }
  }
  return Object.keys(sum).length > 0 ? sum : undefined;
}

/**
 * A usage record carrying only one model's tries that got no answer, or null
 * when there were none, for a step's `onUsage`.
 */
export function revampCallUsage(
  model: string,
  counts: Partial<RevampCallCounts>,
): RevampUsage | null {
  const rateLimited = Math.max(0, Math.floor(counts.rateLimited ?? 0));
  const timeouts = Math.max(0, Math.floor(counts.timeouts ?? 0));
  if (!model || (rateLimited === 0 && timeouts === 0)) return null;
  return {
    ...ZERO_REVAMP_USAGE,
    calls: { [model]: { rateLimited, timeouts } },
  };
}

/** What every step receives. */
export interface RevampStepContext {
  revampId: string;
  /**
   * The requester, rebuilt from the database at the start of every runner
   * invocation (role, suspension, permissions re-read), with `runId` set to
   * the chat run that started the revamp. Never trusted from the job row.
   */
  actor: MinkActorContext;
  /** Aborts when the lease is lost, the job is cancelled or the deadline passes. */
  signal: AbortSignal;
  /** Milliseconds since the epoch when this invocation must hand over. */
  deadline: number;
  /** Updates the step's detail on the card ("7 of 24"); never throws. */
  report(detail: string | null): Promise<void>;
  /**
   * ★★ Aborts when this invocation's deadline passes (jobs-4): start no new
   *   paid call (an image draw, a studio photo, a compile repair) and let the
   *   ones in flight finish and be stored, since the provider bills them
   *   whatever happens next. `signal` aborts a grace period later if they
   *   have not. A step that left work undone because of it throws
   *   RevampDrainedError, so what it did is kept but the step is never saved
   *   as complete: the next invocation resumes it. Absent when a step runs
   *   on its own (a test), which then never drains.
   */
  draining?: AbortSignal;
  /**
   * ★★ The photo allowance this job holds claimed, kept on its row so a
   *   runner that dies mid-shoot does not take the claim with it (jobs-3,
   *   photo-hold.ts). `held()` is what an earlier invocation claimed and
   *   never settled (null when nothing); `record()` writes what this one
   *   holds now (null when nothing), fenced on the lease: false when the
   *   lease is gone, a throw on a database error. Absent when a step runs on
   *   its own (a test), which then gives back in process as before.
   */
  photoHold?: {
    held(): RevampPhotoHold | null;
    record(hold: RevampPhotoHold | null): Promise<boolean>;
  };
  /**
   * ★★ The photo checks the photos step has asked, kept on the job row
   *   (P0, photos.ts), so the next invocation carries on from them instead
   *   of starting over at every hand-over: the tries so far, when each
   *   photo's check was first asked (its budget keeps counting), and a
   *   verdict once one is known (a blocking one is never asked again).
   *   `held()` is what the row holds (null when nothing); `record()` writes
   *   the whole record, fenced on the lease: false when the lease is gone,
   *   a throw on a database error. Absent when a step runs on its own (a
   *   test), which then keeps it in memory only.
   */
  photoReviews?: {
    held(): RevampPhotoReviews | null;
    record(reviews: RevampPhotoReviews): Promise<boolean>;
  };
}

/**
 * Photographs claimed against the revamp photo allowances and not settled
 * yet (drawn, or given back). One unit per photo, named by the image row a
 * drawn photo leaves: `anchor:anchor`, `slot:<shot id>`, `product:<key>`.
 */
export interface RevampPhotoHold {
  units: string[];
}

/** The photos step's record of its photo checks, by shot id (`photoReviews`). */
export interface RevampPhotoReviews {
  shots: Record<string, RevampPhotoReviewState>;
}

/**
 * One shot's photo check, as far as it got. ★ About the photo PARKED for its
 * check (`<shot>~review`): `sha256` names it, so a record about another
 * picture is never applied to this one.
 */
export interface RevampPhotoReviewState {
  /** The parked photo's digest; absent when only redraws are recorded. */
  sha256?: string;
  /** When its check was first asked (ms since the epoch); absent until then. */
  firstAskedAt?: number;
  /** Check calls made for it so far, across invocations. */
  tries: number;
  /** When the last of them answered (ms since the epoch). */
  lastTriedAt?: number;
  /**
   * The verdict once known: the problems the check named (none is a pass),
   * or "expired" when it could not be had within the photo's budget.
   */
  verdict?: { problems: string[] } | "expired";
  /** Why the shot's photograph was drawn again: one entry per attempt turned down. */
  redraws?: RevampRedraw[];
}

export { RevampStepError, type RevampStepErrorCode } from "./step-error";

/**
 * The verdict that the store can no longer pay for the redesign: its balance
 * fell below the card's cost while it was being made. The runner fails the
 * job with the closed code `out_of_credits` (contract.ts), whose sentence
 * tells the merchant to buy credits, never "something went wrong".
 *
 * ★ A subclass, so every place that already reads a RevampStepError treats
 *   it as the final (non-transient) verdict it is; its own class because
 *   step-error.ts's code list is the one the pure compiler shares, and
 *   running out of credits is never something a step's input can cause.
 */
export class RevampOutOfCreditsError extends RevampStepError {
  /** The code the job fails with. */
  readonly jobCode = "out_of_credits" as const;
  constructor(message: string) {
    super("internal", message, false);
    this.name = "RevampOutOfCreditsError";
  }
}

/**
 * A transient step failure that knows how long to wait before the next claim:
 * the runner parks the job for `retryAfterMs` instead of its usual minute.
 *
 * ★ For a limit shared with other stores (the platform's hourly photo
 *   ceiling): it frees up as its window turns, not in a minute, and claiming
 *   again every minute would spend the job's attempts on refusals.
 */
export class RevampRetryLaterError extends RevampStepError {
  constructor(
    code: RevampStepErrorCode,
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(code, message, true);
    this.name = "RevampRetryLaterError";
  }
}

/**
 * The step stopped starting paid calls at the deadline (jobs-4,
 * `RevampStepContext.draining`) and left work for the next invocation. The
 * runner hands the job over at once, as at any deadline; nothing the step did
 * is lost, since what it drew is already stored.
 */
export class RevampDrainedError extends RevampStepError {
  constructor() {
    super(
      "internal",
      "The step stopped at the deadline with work left for the next run.",
      true,
    );
    this.name = "RevampDrainedError";
  }
}

export interface RevampModelCall {
  /** The model's raw JSON output (parsed), or null when it returned none. */
  raw: unknown;
  usage: RevampUsage;
}

export interface RevampCompileResult {
  plan: RevampSitePlan | null;
  /** Problems a repair call should fix, in plain sentences for the model. */
  issues: string[];
}

export interface RevampPhotoRun {
  images: RevampStoredImage[];
  outcomes: RevampPhotoOutcome[];
  /**
   * The step's own total, for logs and tests. ★ The runner does not add it
   *   to the job's usage: `onUsage` reported each call as it returned, and
   *   adding this too would count every call twice.
   */
  usage: RevampUsage;
}

export interface RevampProductPhotoRun {
  images: RevampStoredImage[];
  /** Product keys whose photo could not be made, with the reason. */
  failed: Array<{ key: string; reason: string }>;
  /**
   * Why a product's studio photo was drawn again, by product key: one entry
   * per attempt its check turned down (P0 diagnostics). Absent when none was.
   */
  redraws?: Record<string, RevampRedraw[]>;
  /** The step's own total; the runner counts `onUsage` instead. */
  usage: RevampUsage;
}

export interface RevampCheckRun {
  plan: RevampStoredPlan;
}

export interface RevampDeps {
  snapshot(
    ctx: RevampStepContext,
    request: RevampRequest,
  ): Promise<RevampSnapshot>;
  plan(
    ctx: RevampStepContext,
    input: {
      request: RevampRequest;
      snapshot: RevampSnapshot;
      /** The parent's plan, for a refinement. */
      previous: RevampSitePlan | null;
    },
  ): Promise<RevampModelCall>;
  repair(
    ctx: RevampStepContext,
    input: {
      request: RevampRequest;
      snapshot: RevampSnapshot;
      previous: RevampSitePlan | null;
      raw: unknown;
      issues: string[];
    },
  ): Promise<RevampModelCall>;
  compile(
    raw: unknown,
    input: {
      request: RevampRequest;
      snapshot: RevampSnapshot;
      previous: RevampSitePlan | null;
    },
  ): RevampCompileResult;
  /** Mechanical fixes for what the repairs left: drop, replace, clear, note. */
  finalize(
    raw: unknown,
    input: {
      request: RevampRequest;
      snapshot: RevampSnapshot;
      previous: RevampSitePlan | null;
    },
  ): RevampSitePlan;
  /**
   * A paid revamp's plan trimmed to what its budget covers, before any photo
   * is drawn (section 6): the most visible work first, the rest listed in
   * `plan.skipped`. Also decides which products get a studio photo. Called
   * only when the job has a budget (never for a free revamp or an unmetered
   * plan).
   */
  fitBudget(
    plan: RevampSitePlan,
    input: { request: RevampRequest; budget: number },
  ): { plan: RevampSitePlan; productPhotoKeys: string[] };
  /**
   * The products a revamp with no budget (a free one, an unmetered plan)
   * takes a studio photo of, in request order: every one with a photo that
   * the redesign creates. ★ Never one the store already has: it is not
   * created, so its studio photo would show nowhere. A paid revamp's come
   * from `fitBudget`, less what its budget left out.
   */
  productPhotoKeys(plan: RevampSitePlan, request: RevampRequest): string[];
  /**
   * The products whose studio photo a refinement carries over from its
   * parent instead of drawing it again: the parent's, unless the refinement
   * is about the products. ★ Exactly the ones the card charges nothing for,
   * by the same rule, so a carried photo is never one somebody pays twice.
   */
  carriedProductPhotoKeys(
    plan: RevampSitePlan,
    request: RevampRequest,
  ): string[];
  /**
   * What a plan's card can charge at most, at today's prices (the card
   * charges only what it made and still shows, never more).
   */
  estimate(
    plan: RevampSitePlan,
    input: { request: RevampRequest; productPhotoKeys: readonly string[] },
  ): RevampCreditBreakdown;
  /**
   * The requester's store's Mink credits left right now, the read the start
   * tool set the budget from, or null on an unmetered plan. ★ Asked again
   * before any photograph of a paid revamp, because the balance the budget
   * was taken from can fall while the plan is written.
   */
  balance(ctx: RevampStepContext): Promise<number | null>;
  photos(
    ctx: RevampStepContext,
    input: {
      plan: RevampSitePlan;
      snapshot: RevampSnapshot;
      /** Photos already stored for this revamp (a resumed run reuses them). */
      stored: RevampStoredImage[];
      /** For a refinement: the parent's photos to carry over by shot id. */
      inherited: RevampStoredImage[];
      /** Shot ids a refinement must redraw; null redraws whatever is missing. */
      redraw: string[] | null;
      /**
       * ★★ The revamp's request (B16, real goods or no goods): a shot that
       *   names a product the merchant sent in the chat does so by its request
       *   key ("p1"), which only the request resolves to that product's photo.
       *   Absent, only "shop:<slug>" keys resolve and such a shot shows no
       *   products.
       */
      request?: RevampRequest;
      /**
       * ★★ Called right after EVERY paid model call returns (each draw,
       *   redraw, review and anchor), with that call's own usage, including a
       *   call whose image is refused later or whose step stops at the
       *   deadline (L2-F). The runner sums these into the job's usage and no
       *   longer adds the step's returned total, so a step handed over before
       *   it returns still records what it paid for. Absent when a step runs
       *   on its own (a test).
       */
      onUsage?: (usage: RevampUsage) => void;
    },
  ): Promise<RevampPhotoRun>;
  products(
    ctx: RevampStepContext,
    input: {
      request: RevampRequest;
      /** Product photos already stored for this revamp (resume reuses them). */
      stored: RevampStoredImage[];
      /** Product keys to photograph; null photographs every product with a photo. */
      only: string[] | null;
      /** For a refinement: the parent's photos, whose studio photos it may carry over. */
      inherited: RevampStoredImage[];
      /**
       * Product keys whose parent studio photo is carried over rather than
       * drawn again (`carriedProductPhotoKeys`); empty for a full revamp.
       */
      carried: string[];
      /**
       * The redesign's page colour (#rrggbb): the one backdrop every studio
       * photo of the revamp shares, so the shop grid reads as one shoot.
       */
      backdrop?: string | null;
      /**
       * ★★ Called right after EVERY paid studio-photo call returns, with that
       *   call's own usage, the photos step's contract (L2-F).
       */
      onUsage?: (usage: RevampUsage) => void;
    },
  ): Promise<RevampProductPhotoRun>;
  assemble(input: {
    revampId: string;
    request: RevampRequest;
    snapshot: RevampSnapshot;
    plan: RevampSitePlan;
    images: RevampStoredImage[];
    outcomes: RevampPhotoOutcome[];
    productFailures: Array<{ key: string; reason: string }>;
    free: boolean;
    /**
     * Whether the requester, as rebuilt for this invocation, holds Branding
     * manage. ★ The tagline and footer description are written to the live
     * store at Apply behind that permission (apply-v2.ts), which refuses the
     * whole card otherwise, so a plan for anyone else carries no brand.
     */
    canChangeBrand: boolean;
  }): RevampStoredPlan;
  checks(
    ctx: RevampStepContext,
    input: {
      plan: RevampStoredPlan;
      snapshot: RevampSnapshot;
      request: RevampRequest;
    },
  ): Promise<RevampCheckRun>;
  card(
    ctx: RevampStepContext,
    input: {
      plan: RevampStoredPlan;
      free: boolean;
    },
  ): Promise<{ draftId: string; credits: number }>;
}
