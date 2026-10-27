import "server-only";
import { REVAMP_WORK_BUDGET, revampPaidAdmissionEndsAt } from "./pacing-policy";

import { createHash } from "node:crypto";
import { ThinkingLevel } from "@google/genai";
import { IMAGE_SPECS } from "@/lib/media/image-specs";
import { logInfo, logWarn } from "@/lib/observability/logger";
import { SECTION_TYPE_META } from "@/lib/sections/registry";
import { getThemeStudioConfig } from "@/lib/theme-studio/config";
import {
  estimateImageCostMicroUsd,
  imageThinkingTokens,
} from "@/lib/theme-studio/cost";
import {
  DESIGN_DIRECTIONS,
  type DesignDirection,
} from "@/lib/theme-studio/design-directions";
import {
  IMAGE_REVIEW_TRY_TIMEOUT_MS,
  createVertexModelClient,
  getVertexConfig,
} from "@/lib/theme-studio/gemini-vertex";
import {
  createFakeImageClient,
  createFakeImageReviewClient,
} from "@/lib/theme-studio/image-fake";
import {
  IMAGE_CONCURRENCY,
  runSlotImageGeneration,
  type SlotOutcome,
  type StoredReference,
  type ThemeImageReviewer,
  type ThemeImageRunResult,
} from "@/lib/theme-studio/image-generation";
import {
  nearestImageRatio,
  type GeneratableSlot,
} from "@/lib/theme-studio/image-generation-core";
import { ImageCheckpointError } from "@/lib/theme-studio/image-recovery";
import { ImageRequestPool } from "@/lib/theme-studio/image-request-pool";
import {
  THEME_STUDIO_IMAGE_MODEL_KEY,
  getThemeStudioImageConfig,
} from "@/lib/theme-studio/image-models";
import type {
  AnchorLead,
  ThemeImageDirection,
  ThemeImageGoods,
  ThemeImageGoodsProduct,
} from "@/lib/theme-studio/image-prompt";
import {
  THEME_IMAGE_ASPECT_RATIOS,
  ZERO_IMAGE_USAGE,
  aspectValue,
  type ThemeImageAspectRatio,
  type ThemeImageReference,
  type ThemeImageResult,
  type ThemeStudioImageClient,
} from "@/lib/theme-studio/image-provider";
import {
  THEME_IMAGE_PROBLEMS,
  THEME_IMAGE_REDRAWS,
  THEME_IMAGE_REVIEW_MODEL_KEY,
  isBlocking,
  reviewThemeImage,
  type ThemeImageProblem,
  type ThemeImageReview,
  type ThemeImageReviewInput,
} from "@/lib/theme-studio/image-review";
import {
  IMAGE_REQUEST_TIMEOUT_MS,
  createVertexImageClient,
} from "@/lib/theme-studio/image-vertex";
import { resolveThemeStudioModel } from "@/lib/theme-studio/models";
import {
  ZERO_USAGE,
  type ThemeStudioModelClient,
} from "@/lib/theme-studio/provider";
import type { ProviderCapacity } from "@/lib/theme-studio/provider-capacity";
import { sharedProviderCapacity } from "@/lib/theme-studio/provider-capacity-store";
import { sleepUnlessAborted } from "@/lib/theme-studio/rate-limit-backoff";
import { openUntrustedImage } from "@/lib/theme-studio/references";
import {
  prepareSlotImage,
  type PreparedSlotImage,
} from "@/lib/theme-studio/slot-images";
import {
  SLOT_IMAGE_MIN_WIDTH,
  slotByteLimit,
} from "@/lib/theme-studio/slot-images-core";
import {
  REVAMP_LIMITS,
  REVAMP_SHOT_PURPOSES,
  revampShotGoods,
  type RevampPhotoOutcome,
  type RevampRequest,
  type RevampShot,
  type RevampShotPurpose,
  type RevampSitePlan,
  type RevampSlotBinding,
  type RevampSnapshot,
  type RevampStoredImage,
} from "./contract";
import {
  REVAMP_PHONE_SUFFIX,
  REVAMP_PLATFORM_PHOTO_LIMIT_KEY,
  adoptRevampImage,
  claimRevampPhotos,
  listRevampImageRecords,
  readRevampImageBytes,
  readStoreOwnedImageBytes,
  releaseRevampPhotos,
  revampImageStoreConfigured,
  storeRevampImage,
  type RevampImageMediaType,
  type RevampImageRecord,
} from "./image-store";
import {
  REVAMP_REVIEW_PENDING_SUFFIX,
  recordPhotoHold,
  revampPhotoUnit,
  settlePhotoHold,
  settleStalePhotoHold,
} from "./photo-hold";
import {
  RevampDrainedError,
  RevampRetryLaterError,
  RevampStepError,
  ZERO_REVAMP_USAGE,
  addRevampUsage,
  revampCallUsage,
  type RevampCallCounts,
  type RevampPhotoReviewState,
  type RevampPhotoRun,
  type RevampStepContext,
  type RevampUsage,
} from "./ports";
import { revampProvider, type RevampProvider } from "./provider";
import {
  revampGoodsCatalogue,
  revampShotSubjectFor,
  type RevampGoodsItem,
} from "./site-compiler";

// ---------------------------------------------------------------------------
// Mink storefront revamp: the photographs (docs/mink-storefront-revamp.md,
// section 8; build spec 3.6).
//
// The site plan names a list of SHOTS and binds each one to the image fields
// that use it. This step turns every shot that has no photograph yet into a
// Theme Studio slot and runs the Theme Studio image set over them
// (`runSlotImageGeneration`): one anchor that sets the light, palette and
// grade, then every shot matched to it, three at a time, reviewed, redrawn up
// to twice, each cropped and compressed to the frame its sections show it in.
//
// ★★ EVERY SHOT ENDS THE STEP WITH A STORED PHOTOGRAPH. A shot whose own
//    picture could not be drawn gets a crop of the closest shaped photo the
//    shoot kept for a page (drawn under its own goods rule, and checked as a
//    page photo unless that check could not be had), marked `flagged`, with
//    an outcome that says why in the merchant's words. Never a theme photo,
//    never an empty frame, and ★★ never the anchor: it is a hidden
//    reference, checked only for the look it sets (a mark on a jar or an odd
//    handle is kept, image-review.ts), never told the goods rule, so a crop
//    of it on a page could show what it was never checked for (B16).
//    Only an anchor that cannot be drawn stops the step, because nothing
//    drawn without it would belong to the same shoot (`anchorFailureError`
//    gives each way it fails the code whose sentence is true); a step left
//    with nothing to crop from stops too (`nothingToCropFrom`).
//
// ★★ EVERY DRAWN PHOTO IS STORED THE MOMENT IT SETTLES (`onAnchor`,
//    `onSlotSettled`), so a runner that loses its lease half way has lost no
//    picture it paid for. A resumed run draws only the shots with no stored
//    photograph and matches them to the stored anchor.
//
// ★ A REFINEMENT CARRIES ITS PARENT'S PHOTOGRAPHS OVER by shot id, unless the
//   merchant asked for that shot again (`redraw`; null keeps everything), and
//   keeps the parent's anchor as the shoot's reference so a redrawn photo
//   still matches the ones it sits beside. A photo whose frame changed shape
//   is drawn again rather than squeezed into the new frame.
//
// ★ THE PHOTO LIMITS ARE CLAIMED BEFORE A PICTURE IS DRAWN, for every shot
//   about to be drawn and the anchor when it is not stored. A refusal tries
//   the homepage's shots alone (the ones shoppers see first) and recrops the
//   rest; a refusal of that too stops the step. Whatever was claimed and never
//   drawn is given back.
//
// ★★ A PHOTO IS THE SHOT'S ONLY ONCE ITS REVIEW HAS SPOKEN (L2-I). A photo
//    whose review was unavailable, or never started because the deadline
//    drained the step, is stored straight away (it is paid for) but PARKED,
//    under `<shot>~review`, which no section reads. It is asked for again
//    at once, DURING the shoot (P0), after 15, 30 and 60 s (a later
//    invocation never draws it again, and carries on from where its check
//    got to): a pass or a minor problem makes it the shot's photo; a
//    blocking problem never reaches a page (the shoot's flagged earlier
//    attempt, or a crop of the shoot, stands in). ★ Parked, never stored as
//    the shot's own, because a stored row is never replaced (image-store.ts
//    is insert-once per slot), so a photo must not become the shot's before
//    anyone has looked at it.
//
// ★★ A CHECK HAS ABOUT FOUR MINUTES IN ALL (P0, REVAMP_PHOTO_CHECK_BUDGET_MS),
//    from the first time it was asked, counted ACROSS runner invocations:
//    one photo's check used to hold a redesign's card for 52 minutes, its
//    tries starting over at every hand-over. The tries, when the check was
//    first asked and a verdict once known are kept on the job row
//    (`ctx.photoReviews`), so a blocking verdict is never asked again and
//    the budget keeps counting. ★★ When the budget runs out with no verdict
//    (owner's decision 2, 2026-10-23), a crop of an ALREADY CHECKED photo of
//    the same shoot that fits the frame stands in; when none fits, the photo
//    is let in unchecked and the card says so under "Not done this time".
//
// ★ WHY A PHOTO WAS DRAWN AGAIN, AND EVERY REFUSAL, IS KEPT (P0): the
//   problems each turned-down attempt had go on its outcome (`redraws`), and
//   the tries Google refused with 429 or our clock cut off are counted per
//   model in the usage (`calls`), so a live run can explain its redraws.
//
// ★ THE PHONE CROP IS CUT FROM THE PICTURE THE MODEL DREW (L2-D), not from
//   its stored copy: the 21:9 draw (3168x1344 at 2K) gives a 1075x1344 crop
//   where the 2520x1080 copy gives 864x1080. A resumed run that only has the
//   stored copy cuts it from that.
//
// ★ EVERY PAID CALL IS REPORTED AS IT RETURNS (`onUsage`, L2-F): each draw,
//   redraw, review and the anchor, so a step the deadline or a lost lease
//   stops half way has still told the runner everything it spent.
//
// ★★ A PHOTO SMALLER THAN ITS FRAME IS DRAWN AGAIN, ONCE (B14). The crop
//    never upscales, so a picture drawn below the size asked for used to be
//    kept soft with only a log line. Once its check has passed (or found only
//    minor problems) it is redrawn, inside the engine's own redraw budget, so
//    no other photo, claim or charge rule changes; of the two, the larger
//    picture the check let through is kept. A photo still smaller than its
//    frame is marked (REVAMP_SMALL_PROBLEM), listed under "Not done this
//    time" and, like every photo listed there, never charged.
//
// ★★ REAL GOODS OR NO GOODS (owner's decision B16, 2026-10-23). A shot of the
//    merchant's goods (`goods: "merchant"`, `productKeys`) is drawn with each
//    named product's OWN photograph as a reference after the anchor, read
//    from this store's own objects only, and checked against them; every
//    other shot, and the anchor, shows no products at all. A shot whose
//    product photo cannot be read shows no products, never invented goods
//    (`resolveShotGoods`), and its words, which named them, are written
//    again (`revampShotSubjectFor`). The anchor follows the opening shot's
//    look, never its goods (`noGoodsAnchorLead`). Theme Studio's own
//    pictures keep their fictional goods: the rule rides on the brief, which
//    only this step sets.
// ---------------------------------------------------------------------------

export interface DrawRevampPhotosOptions {
  /** Test seam; production picks Vertex or the offline fake (`revampProvider`). */
  imageClient?: ThemeStudioImageClient;
  /**
   * The vision reviewer. Null draws without review; absent picks it the way
   * the Theme Studio worker does (the fake reviewer offline, none when the
   * review model is switched off).
   */
  reviewer?: ThemeImageReviewer | null;
  /** Test seam; production crops and compresses with sharp. */
  prepare?: typeof prepareSlotImage;
  /** Images drawn at once; Theme Studio's ceiling of three applies. */
  concurrency?: number;
  /**
   * Test seam for the waits before an unavailable review is asked again:
   * resolves false when the wait was cut short (the drain, a stop).
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  /**
   * Test seam for the clock a photo check's budget is counted on (P0);
   * production reads Date.now.
   */
  now?: () => number;
}

/** The crop a stored photograph ends at. */
export interface RevampPhotoFrame {
  width: number;
  height: number;
  aspect: number;
}
type Frame = RevampPhotoFrame;

/** One shot of the plan, as this step draws and stores it. */
export interface RevampPlannedShot {
  shot: RevampShot;
  /** The frame every binding ends at (the largest of them), or null when nothing uses the shot. */
  frame: Frame | null;
  byteLimit: number;
  /** A binding also takes a phone crop of the same photograph. */
  needsPhone: boolean;
  /** The page slugs (and "@category") the shot is shown on. */
  pages: ReadonlySet<string>;
  onHomepage: boolean;
  /** What the image run draws; null when nothing uses the shot. */
  slot: GeneratableSlot | null;
}

type FallbackCause =
  | "refused"
  | "rejected"
  | "failed"
  | "limit"
  | "cap"
  | "unchecked";

/** A shot's wide photograph, and its bytes when this call already holds them. */
interface Photo {
  image: RevampStoredImage;
  bytes: Uint8Array | null;
  /** A fallback crop: never the source of another one. */
  recrop: boolean;
}

/** A kept photo of the shoot a fallback may be cropped from (never the anchor). */
interface Source {
  id: string;
  width: number;
  height: number;
  bytes: Uint8Array | null;
  image: RevampStoredImage | null;
  pages: ReadonlySet<string>;
}

/** A photo kept for its review, not yet any shot's own (L2-I). */
interface PendingPhoto {
  /** The parked row (`<shot>~review`). */
  image: RevampStoredImage;
  /** Its bytes, when this call holds them. */
  bytes: Uint8Array | null;
  /** Review calls made for it so far, across invocations; 0 when none yet. */
  tries: number;
  /** When the last of them answered (ms since the epoch). */
  lastTriedAt: number;
  /**
   * When its check was first asked (ms since the epoch), the start of its
   * budget (P0); null until it is.
   */
  firstAskedAt: number | null;
  /** The draw attempt it came from, for the reviewer's wording. */
  attempt: number;
}

/** A picture this invocation prepared, with the draw it was cut from. */
interface Candidate {
  prepared: PreparedSlotImage;
  /** The provider's own picture, kept for a shot that takes a phone crop. */
  drawn: Uint8Array | null;
}

/** What a delayed review settled on (`settlePending`). */
type DelayedVerdict =
  | { kind: "reviewed"; problems: ThemeImageProblem[] }
  /**
   * No verdict within the photo's budget, or asked at every wait and never
   * answered (P0): owner's decision 2 applies.
   */
  | { kind: "expired" }
  /** The parked object could not be read back to show the reviewer. */
  | { kind: "unreadable" }
  /** The drain began first: the photo stays parked for the next run. */
  | { kind: "left" };

/**
 * A photo still waiting for its review is stored under the shot id with
 * this suffix (defined in photo-hold.ts, which settles claims by it). ★ No
 * section reads it (assemble.ts takes `<shot>` and `<shot>~phone` only), so
 * it reaches no page until a verdict lets it in; shot ids are `[a-z0-9-]`
 * (site-compiler.ts), so it is never a shot's.
 */
export { REVAMP_REVIEW_PENDING_SUFFIX };
const REVIEW_PENDING_PROBLEM = "review-pending";

/**
 * How long a photo whose review was unavailable waits before it is asked
 * again, one wait per try (P0): 15, 30, then 60 s, from when the last try
 * answered. It used to be 60 and 120 s, and only after the whole image run.
 * ★ Bounded twice: these three, and the photo's budget
 * (REVAMP_PHOTO_CHECK_BUDGET_MS). After either, owner's decision 2 applies.
 */
export const REVAMP_REVIEW_RETRY_DELAYS_MS: readonly number[] = [
  15_000, 30_000, 60_000,
];

/**
 * ★★ How long one photo's check may take IN ALL, from the first time it was
 *   asked, across runner invocations (P0): about four minutes. Each try runs
 *   on its own 75 s clock (gemini-vertex.ts, IMAGE_REVIEW_TRY_TIMEOUT_MS); a
 *   try still in flight when the budget runs out is cut off, and a wait that
 *   would end past it is not waited.
 */
export const REVAMP_PHOTO_CHECK_BUDGET_MS = 4 * 60_000;

/**
 * ★ The most of a checked photo a crop may throw away to stand in for a
 *   photo that could not be checked (owner's decision 2): a crop that keeps
 *   less than this much of its picture no longer reads as that picture, and
 *   the photo drawn for the shot, unchecked, is the better stand-in. A 16:9
 *   photo cut to 21:9 keeps 76%; a 4:3 one keeps 57% and does not fit.
 */
export const REVAMP_CHECKED_CROP_MAX_LOSS = 0.3;

/**
 * What the card says, under "Not done this time", about a photo let in
 * unchecked because its check could not be had in time (owner's decision 2).
 */
export const REVAMP_UNCHECKED_PHOTO_REASON =
  "Mink AI could not check this photograph in time, so it is shown unchecked.";

/** The record key for the anchor's redraws: never a shot id (`[a-z0-9-]`). */
const ANCHOR_CHECK_KEY = "@anchor";
/** The problem word a redraw records when the image model declined a draw. */
const REFUSED_PROBLEM = "refused";
/** The most redraws one shot's record keeps (jobs.ts reads at most 12). */
const MAX_RECORDED_REDRAWS = 12;
/** A delayed review's call permit is waited for, never abandoned half way. */
const NEVER_ABORTED = new AbortController().signal;

/** The phone frame: the storefront's phone hero (lib/media/image-specs.ts). */
export const REVAMP_PHONE_FRAME: Frame = {
  width: IMAGE_SPECS.hero_phone.width,
  height: IMAGE_SPECS.hero_phone.height,
  aspect: IMAGE_SPECS.hero_phone.width / IMAGE_SPECS.hero_phone.height,
};
const PHONE_BYTE_LIMIT = slotByteLimit({
  catalogPreview: false,
  width: REVAMP_PHONE_FRAME.width,
  height: REVAMP_PHONE_FRAME.height,
});

/** Two shapes within 3% of each other are the same frame (the binding rule). */
const SHAPE_TOLERANCE = 0.03;
/** Crops this close in loss are equal; the photo kept first then wins. */
const LOSS_TIE = 0.02;
const ANCHOR_SLOT = "anchor";
const ALT_CHARS = 180;
/** An unprepared anchor original is read only up to this size. */
const MEASURE_MAX_BYTES = 25 * 1024 * 1024;

/** Marks a stored fallback crop, so a resumed run can still say why. */
export const REVAMP_RECROP_PROBLEM = "recropped";
/**
 * ★★ Marks a photo let in unchecked (owner's decision 2) on its own row, the
 *   way REVAMP_RECROP_PROBLEM marks a crop. The record that its check ran out
 *   reaches the job row best effort, so a later invocation that found only
 *   the row read the photo as an ordinary one: charged, and missing from the
 *   card's "Not done this time". The row is written with its marker in one
 *   insert, so the photo is never the shot's without it.
 */
export const REVAMP_UNCHECKED_PROBLEM = "unchecked";
/**
 * ★★ Marks a photograph kept smaller than its frame (B14) on its own row, the
 *   way REVAMP_UNCHECKED_PROBLEM marks one let in unchecked, so a later
 *   invocation still lists it under "Not done this time" and never charges
 *   it.
 */
export const REVAMP_SMALL_PROBLEM = "smaller-than-frame";
/** The card's words for a photograph kept smaller than its frame (B14). */
export const REVAMP_SMALL_PHOTO_REASON =
  "The new photograph came back smaller than this place on the page needs, so it may look a little soft here.";
/** Why a photo was drawn again when it came back too small (B14, P0 record). */
export const REVAMP_TOO_SMALL_CAUSE = "too_small";
/**
 * What the image model is told when a photo is drawn again for its size
 * (B14): the engine names a redraw's reasons from the closed problem list,
 * so the closest one (poor_crop) goes with this note saying what happened.
 */
const TOO_SMALL_NOTE =
  "Nothing was wrong with how the picture was composed: it came back at a lower resolution than the size asked for. Draw the same picture again, whole, at the full size requested.";
const RECROP_SOURCE = "recrop-source:";
const RECROP_CAUSE = "recrop-cause:";

const RECROP_REASONS: Record<FallbackCause, string> = {
  refused:
    "The photo service declined to draw this picture, so a crop of another photograph from the same shoot is used here.",
  rejected:
    "The new photograph did not pass Mink AI's own check, so a crop of another photograph from the same shoot is used here.",
  failed:
    "The photo service could not finish this picture, so a crop of another photograph from the same shoot is used here.",
  limit:
    "The limit for new photographs was reached, so a crop of another photograph from the same shoot is used here.",
  cap: "This redesign planned more photographs than one redesign may take, so a crop of another photograph from the same shoot is used here.",
  unchecked:
    "Mink AI could not check the new photograph in time, so a crop of another photograph from the same shoot is used here.",
};
const FALLBACK_CAUSES = new Set<string>(Object.keys(RECROP_REASONS));
const UNUSED_SHOT_REASON =
  "No section of the new pages uses this photograph, so it was not taken.";

/**
 * Anchor failures worth another try later: the provider was unavailable.
 * ★ Only an outage. A refusal, a failed check or a picture our own crop
 *   could not use would fail the same way on every retry, so retrying it
 *   would only spend the photo allowance again.
 */
const TRANSIENT_ANCHOR_CODES: ReadonlySet<string> = new Set([
  "rate_limited",
  "provider_unavailable",
  "provider_timeout",
]);

/** Directions whose own styling asks for more or less room in a picture. */
const DIRECTION_DENSITY: Partial<
  Record<DesignDirection, ThemeImageDirection["density"]>
> = {
  "luxury-minimal": "airy",
  "magazine-editorial": "airy",
  "soft-and-natural": "airy",
  "bold-and-loud": "dense",
  "dense-catalogue": "dense",
};

export async function drawRevampPhotos(
  ctx: RevampStepContext,
  input: {
    plan: RevampSitePlan;
    snapshot: RevampSnapshot;
    /** Photos already stored for this revamp (a resumed run reuses them). */
    stored: RevampStoredImage[];
    /** For a refinement: the parent's photos to carry over by shot id. */
    inherited: RevampStoredImage[];
    /** Shot ids a refinement must redraw; null keeps everything inherited. */
    redraw: string[] | null;
    /**
     * ★ The revamp's request (B16): a shot of the merchant's goods names a
     *   product by its request key ("p1") or as "shop:<slug>", and only the
     *   request knows the first. Absent, only the store's own products can be
     *   shown, and a shot naming any other key shows no products.
     */
    request?: RevampRequest;
    /**
     * ★★ Called right after EVERY paid model call returns (L2-F): each draw,
     *   redraw and review and the anchor, refused and rejected ones and those
     *   the deadline caught included, with that call's usage. The runner
     *   saves it with its next checkpoint, so a step handed over or stopped
     *   half way has still counted what it paid for; the returned `usage` is
     *   the same calls summed.
     */
    onUsage?: (usage: RevampUsage) => void;
  },
  options: DrawRevampPhotosOptions = {},
): Promise<RevampPhotoRun> {
  ctx.signal.throwIfAborted();
  const budgeted = Boolean(ctx.finishBy || ctx.recoverable);
  let capacityPending = false;
  const storeId = ctx.actor.storeId;
  const revampId = ctx.revampId;
  if (input.snapshot.storeId !== storeId) {
    throw new RevampStepError(
      "internal",
      "The photos step was given another store's snapshot.",
    );
  }
  // ★★ A claim an earlier invocation left on the job row is settled before
  //   anything else (jobs-3): what it never drew goes back, once. ★ A photo
  //   parked for its review was drawn, so it counts as its shot's row
  //   (`storedPhotoUnit`, which the finished-job sweep reads by too).
  await settleStalePhotoHold(ctx, input.stored);
  const prepare = options.prepare ?? prepareSlotImage;
  const sleep = options.sleep ?? sleepUnlessAborted;
  const now = options.now ?? Date.now;
  // ★★ Every paid call, reported the moment it returns (L2-F); the step's
  //   own total is the same calls summed. A reporter that throws costs the
  //   record one call, never the photographs.
  let spent: RevampUsage = { ...ZERO_REVAMP_USAGE };
  const charge = (usage: RevampUsage | null) => {
    if (!usage) return;
    spent = addRevampUsage(spent, usage);
    if (!input.onUsage) return;
    try {
      input.onUsage(usage);
    } catch (error) {
      logWarn("mink.revamp: a photo call's usage could not be reported", {
        revampId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  /**
   * What one sent review cost, with its last try counted against the review
   * model when that got no answer (P0): a 429 the client gave up on, or a
   * try its own clock or the photo's budget cut off. One report per call.
   */
  const reviewUsage = (review: ThemeImageReview): RevampUsage | null =>
    mergeUsage(
      reviewCallUsage(review),
      review.kind === "unavailable"
        ? revampCallUsage(THEME_IMAGE_REVIEW_MODEL_KEY, {
            rateLimited: review.code === "rate_limited" ? 1 : 0,
            timeouts: review.code === "provider_timeout" ? 1 : 0,
          })
        : null,
    );

  // ★★ THE RECORD OF THIS STEP'S PHOTO CHECKS (P0), as the job row keeps it
  //   (`ctx.photoReviews`): what an earlier invocation got to, and every move
  //   this one makes. Entries are replaced, never changed in place, so the
  //   copy a write is sending can never change under it.
  const checks = new Map<string, RevampPhotoReviewState>(
    Object.entries(ctx.photoReviews?.held()?.shots ?? {}),
  );
  const noteCheck = (
    key: string,
    patch: Partial<RevampPhotoReviewState>,
  ): void => {
    checks.set(key, { tries: 0, ...checks.get(key), ...patch });
  };
  /** One more attempt turned down, for the shot's `redraws` (P0). */
  const noteRedraw = (key: string, attempt: number, problems: string[]) => {
    const redraws = checks.get(key)?.redraws ?? [];
    if (redraws.length >= MAX_RECORDED_REDRAWS) return;
    noteCheck(key, {
      redraws: [...redraws, { attempt, problems }],
      correction: problems.join(", ").slice(0, 1600),
    });
    void saveChecks().catch(() => undefined);
  };
  let checksDirty = false;
  let checksWriting: Promise<void> | null = null;
  /**
   * Write the record to the job row: one write at a time, each with the
   * latest record, so a burst of moves costs a write or two. ★ Best effort:
   * a write that fails costs the next invocation a check it asks again, the
   * way every check used to start over, never the photographs; a lease that
   * is gone stops the run in the runner.
   */
  const saveChecks = (): Promise<void> => {
    const port = ctx.photoReviews;
    if (!port) return Promise.resolve();
    checksDirty = true;
    checksWriting ??= (async () => {
      try {
        while (checksDirty) {
          checksDirty = false;
          try {
            if (!(await port.record({ shots: Object.fromEntries(checks) }))) {
              if (budgeted)
                throw new RevampStepError(
                  "internal",
                  "The image attempt lost its lease before admission.",
                  true,
                );
              return;
            }
          } catch (error) {
            logWarn("mink.revamp: the photo checks could not be recorded", {
              revampId,
              error: error instanceof Error ? error.message : String(error),
            });
            if (budgeted) throw error;
            return;
          }
        }
      } finally {
        checksWriting = null;
      }
    })();
    return checksWriting;
  };
  /** Wait for the record's last write; a write that failed was logged. */
  const flushChecks = async (): Promise<void> => {
    while (checksWriting) await checksWriting;
  };
  const planned = planRevampShots(input.plan, input.snapshot);
  const usable = planned.filter((p) => p.frame !== null);
  const byId = new Map(usable.map((p) => [p.shot.id, p]));
  const total = usable.length;
  if (total === 0) {
    return {
      images: input.stored.filter(
        (image) => image.role !== "product" && !pendingShotOf(image.slotId),
      ),
      outcomes: buildOutcomes(planned, emptyLedger(), [], checks),
      usage: { ...ZERO_REVAMP_USAGE },
    };
  }
  // ★ StoreMink's own setup, not a busy photo service: `internal`, whose
  //   sentence blames neither the merchant nor a wait.
  if (!revampImageStoreConfigured()) {
    throw new RevampStepError(
      "internal",
      "Media storage is not configured (GCS_BUCKET), so no photograph can be stored.",
      false,
    );
  }

  const ledger = emptyLedger();
  const own = indexImages(input.stored);
  const parent = indexImages(input.inherited);
  const bytesByPath = new Map<string, Uint8Array | null>();
  // One read per stored object: a fallback may crop the same source twice.
  const readBytes = async (
    image: RevampStoredImage,
  ): Promise<Uint8Array | null> => {
    if (bytesByPath.has(image.path)) return bytesByPath.get(image.path) ?? null;
    const bytes = await readRevampImageBytes(image);
    bytesByPath.set(image.path, bytes);
    return bytes;
  };

  /** Photos waiting for a verdict before they may be their shot's (L2-I). */
  const pending = new Map<string, PendingPhoto>();
  /**
   * Every picture this invocation prepared, per shot, by the digest of its
   * prepared bytes: the full-size draw behind it (for the phone crop, L2-D)
   * and, for a parked photo, the attempts a delayed verdict may fall back to.
   */
  const candidates = new Map<string, Map<string, Candidate>>();
  const candidateFor = (shotId: string, bytes: Uint8Array | null) =>
    bytes ? (candidates.get(shotId)?.get(digestOf(bytes)) ?? null) : null;
  /**
   * What each shot about to be drawn or checked shows (B16): the merchant's
   * own products with their photographs, or none. Filled before the draw.
   */
  const goodsByShot = new Map<string, ThemeImageGoods>();
  /** A check of a shot, told the shot's goods (never the anchor's). */
  const withGoods = (
    reviewInput: ThemeImageReviewInput,
    shotId: string,
  ): ThemeImageReviewInput => {
    const goods =
      reviewInput.purpose === "anchor" ? undefined : goodsByShot.get(shotId);
    return goods ? { ...reviewInput, goods } : reviewInput;
  };

  // 1. What this revamp already holds.
  for (const p of usable) {
    const wide = own.get(slotKey("slot", p.shot.id));
    if (wide) {
      ledger.photos.set(p.shot.id, { image: wide, bytes: null, recrop: false });
      // ★ A photo an earlier attempt carried over from the parent points at
      //   the parent's own object: it is still a kept photo, so its outcome
      //   says so, and the parent's anchor stays the shoot's reference.
      if (parent.get(slotKey("slot", p.shot.id))?.path === wide.path) {
        ledger.adopted.add(p.shot.id);
      }
    } else {
      // ★★ Parked by an earlier invocation before its review spoke: drawn and
      //   paid for, so it is not drawn again, and it is reviewed first.
      //   ★★ Its check carries on from the record (P0): the tries so far,
      //   the budget's start and any verdict, never from nothing.
      const candidate = budgeted
        ? input.stored
            .filter(
              (image) =>
                image.role === "slot" &&
                image.slotId.startsWith(`${p.shot.id}~candidate-`),
            )
            .sort(
              (a, b) =>
                Number(b.slotId.split("~candidate-")[1]) -
                Number(a.slotId.split("~candidate-")[1]),
            )[0]
        : undefined;
      const verdict = checks.get(p.shot.id);
      const blockedCandidate =
        candidate &&
        verdict?.sha256 === candidate.sha256 &&
        verdict.verdict &&
        verdict.verdict !== "expired" &&
        isBlocking(
          verdict.verdict.problems.filter(isThemeImageProblem),
          p.slot!.purpose,
        );
      const parked =
        own.get(slotKey("slot", pendingSlotId(p.shot.id))) ??
        (blockedCandidate ? undefined : candidate);
      if (parked) {
        const known = checks.get(p.shot.id);
        const same =
          !!known && (!known.sha256 || known.sha256 === parked.sha256);
        pending.set(p.shot.id, {
          image: parked,
          bytes: null,
          tries: same ? known.tries : 0,
          lastTriedAt: same ? (known.lastTriedAt ?? 0) : 0,
          firstAskedAt: same ? (known.firstAskedAt ?? null) : null,
          attempt: 1,
        });
        if (!same) {
          noteCheck(p.shot.id, {
            sha256: parked.sha256,
            tries: 0,
            firstAskedAt: undefined,
            lastTriedAt: undefined,
            verdict: undefined,
          });
        }
      }
    }
    const phone = own.get(slotKey("slot", phoneSlotId(p.shot.id)));
    if (phone) ledger.phones.set(p.shot.id, phone);
  }
  let anchorImage = own.get(slotKey("anchor", ANCHOR_SLOT)) ?? null;
  const lastAnchorCandidate =
    ctx.recoverable && !anchorImage
      ? input.stored
          .filter(
            (image) =>
              image.role === "anchor" &&
              /^anchor~candidate-[1-4]$/.test(image.slotId),
          )
          .sort((a, b) => b.slotId.localeCompare(a.slotId))[0]
      : undefined;
  const anchorVerdict = checks.get(ANCHOR_CHECK_KEY);
  const anchorCandidate =
    lastAnchorCandidate &&
    !(
      anchorVerdict?.sha256 === lastAnchorCandidate.sha256 &&
      anchorVerdict.verdict &&
      anchorVerdict.verdict !== "expired" &&
      isBlocking(
        anchorVerdict.verdict.problems.filter(isThemeImageProblem),
        "anchor",
      )
    )
      ? lastAnchorCandidate
      : undefined;

  // 2. A refinement carries its parent's photographs over.
  // ★ A photo that cannot be carried over is drawn again rather than failing
  //   the redesign: one more picture costs less than a step that never ends.
  const adopt = async (
    image: RevampStoredImage,
    problems: readonly string[] = [],
  ): Promise<RevampStoredImage | null> => {
    try {
      return await adoptRevampImage({ revampId, storeId, image, problems });
    } catch (error) {
      logWarn("mink.revamp: a stored photograph could not be carried over", {
        revampId,
        slotId: image.slotId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
  const redraw = input.redraw === null ? null : new Set(input.redraw);
  for (const p of usable) {
    if (
      ledger.photos.has(p.shot.id) ||
      pending.has(p.shot.id) ||
      redraw?.has(p.shot.id)
    ) {
      continue;
    }
    const inheritedWide = parent.get(slotKey("slot", p.shot.id));
    if (!inheritedWide || !fitsFrame(inheritedWide, p.frame!)) continue;
    const image = await adopt(inheritedWide);
    if (!image) continue;
    ledger.photos.set(p.shot.id, { image, bytes: null, recrop: false });
    ledger.adopted.add(p.shot.id);
    const inheritedPhone = parent.get(slotKey("slot", phoneSlotId(p.shot.id)));
    // ★ The phone crop comes along only with the very photo it was cut from.
    if (
      p.needsPhone &&
      !ledger.phones.has(p.shot.id) &&
      inheritedPhone &&
      image.sha256 === inheritedWide.sha256
    ) {
      const phone = await adopt(inheritedPhone);
      if (phone) ledger.phones.set(p.shot.id, phone);
    }
  }
  if (!anchorImage && ledger.adopted.size > 0) {
    const parentAnchor = parent.get(slotKey("anchor", ANCHOR_SLOT));
    if (parentAnchor) anchorImage = await adopt(parentAnchor);
  }
  ctx.signal.throwIfAborted();

  // 3. What still needs a photograph. ★ A parked photo was drawn: it waits
  //    for its verdict (step 6b), it is not drawn again.
  const missing = usable
    .filter((p) => !ledger.photos.has(p.shot.id) && !pending.has(p.shot.id))
    .sort((a, b) => {
      if (!budgeted) return 0;
      const rank = (p: RevampPlannedShot) =>
        checks.get(p.shot.id)?.redraws?.length ? 0 : p.onHomepage ? 1 : 2;
      return rank(a) - rank(b);
    });
  let toDraw = missing.slice(0, REVAMP_LIMITS.maxShots);
  for (const p of missing.slice(REVAMP_LIMITS.maxShots)) {
    ledger.causes.set(p.shot.id, "cap");
  }
  let done = total - missing.length;
  await reportProgress(ctx, done, total);

  // 4. The shoot's reference: the stored anchor when there is one.
  let seed: { anchor: StoredReference; set: null } | null = null;
  if (anchorImage && toDraw.length > 0) {
    const bytes = await readBytes(anchorImage);
    if (bytes) {
      seed = {
        anchor: { bytes, mediaType: mediaTypeOfPath(anchorImage.path) },
        set: null,
      };
    } else {
      // ★ A new anchor costs one more picture; a step that can never resume
      //   because a stored object went missing costs the whole redesign.
      logWarn("mink.revamp: stored anchor unreadable, drawing a new one", {
        revampId,
      });
    }
  }

  // ★★ The shoot's own drain (D2): a draw's 180 s clock outlasts the runner's
  //   grace, so draws stop being admitted while that clock still fits before
  //   the hard stop, 95 s before the deadline drains the step.
  const drawsDrain =
    toDraw.length > 0
      ? revampAdmissionDrain(ctx, IMAGE_REQUEST_TIMEOUT_MS)
      : ctx.draining;
  // ★ Past it nothing new is drawn (jobs-4), so nothing is claimed either:
  //   the shots still missing are the next run's, and claiming them only to
  //   give them all back is two writes for nothing.
  if (toDraw.length > 0 && drawsDrain?.aborted) {
    if (!budgeted || ctx.recoverable) throw new RevampDrainedError();
    toDraw = [];
  }

  // 5. The photo limits, for every photo about to be drawn (and the anchor).
  //    ★ A refusal tries the homepage's photographs alone, the ones shoppers
  //    see first; whatever is left is cropped from the shoot. Only a refusal
  //    with nothing to crop from stops the step.
  //    ★★ Unless the platform's hour refused (jobs-2): other stores used it
  //    up, this store's own day may be untouched, and the hour turns. The
  //    step waits for a later claim instead, drawing and cropping nothing.
  const anchorCost = toDraw.length > 0 && !seed && !anchorCandidate ? 1 : 0;
  let drawSet = toDraw;
  let claimed = 0;
  if (toDraw.length > 0) {
    const first = await claimPhotos(storeId, toDraw.length + anchorCost);
    if (first.ok) {
      claimed = toDraw.length + anchorCost;
    } else {
      waitOutPlatformCeiling(first.refusedKey);
      const homepage = toDraw.filter((p) => p.onHomepage);
      let granted = false;
      if (homepage.length > 0 && homepage.length < toDraw.length) {
        const second = await claimPhotos(storeId, homepage.length + anchorCost);
        if (second.ok) {
          claimed = homepage.length + anchorCost;
          granted = true;
        } else {
          waitOutPlatformCeiling(second.refusedKey);
        }
      }
      drawSet = granted ? homepage : [];
      const drawing = new Set(drawSet.map((p) => p.shot.id));
      for (const p of toDraw) {
        if (!drawing.has(p.shot.id)) ledger.causes.set(p.shot.id, "limit");
      }
      // ★ A stored anchor is no source: it never stands in for a page photo.
      if (!granted && ledger.photos.size === 0 && pending.size === 0) {
        throw limitReached(
          `Photo limit ${first.refusedKey} refused the shoot's photographs.`,
        );
      }
      logInfo("mink.revamp: photo limit reached, drawing fewer photographs", {
        revampId,
        drawn: drawSet.length,
        recropped: toDraw.length - drawSet.length,
      });
    }
  }
  // ★★ The claim goes on the job row before the first picture is drawn
  //   (jobs-3), so a runner that dies with it leaves it for the next one to
  //   settle. One that cannot be recorded is given straight back.
  if (claimed > 0) {
    const units = [
      ...(anchorCost > 0 ? [revampPhotoUnit("anchor", ANCHOR_SLOT)] : []),
      ...drawSet.map((p) => revampPhotoUnit("slot", p.shot.id)),
    ];
    if (!(await recordPhotoHold(ctx, { units }))) {
      await releaseRevampPhotos(storeId, claimed);
      ctx.signal.throwIfAborted();
      throw new RevampStepError(
        "internal",
        "The photo claim could not be recorded on the job.",
        true,
      );
    }
  }

  /**
   * Store a newly drawn anchor, the shoot's reference for a later invocation.
   * ★ Stored, never shown: no page photo is ever cut from it (B16, the
   *   header), so a resumed run reads it only to match its photos to it.
   */
  const keepAnchor = async (anchor: {
    bytes: Uint8Array;
    mediaType: ThemeImageReference["mediaType"];
    prepared: PreparedSlotImage | null;
  }): Promise<RevampStoredImage | null> => {
    const prepared = anchor.prepared;
    const measured = prepared
      ? { width: prepared.width, height: prepared.height }
      : await measureImage(anchor.bytes);
    if (!measured) return null;
    try {
      return await storeRevampImage({
        revampId,
        storeId,
        role: "anchor",
        slotId: ANCHOR_SLOT,
        bytes: prepared ? prepared.bytes : anchor.bytes,
        mediaType: prepared ? prepared.mediaType : anchor.mediaType,
        width: measured.width,
        height: measured.height,
        review: "unreviewed",
        problems: [],
        alt: `Art direction for ${input.snapshot.storeName}`.slice(
          0,
          ALT_CHARS,
        ),
      });
    } catch (error) {
      // ★ The anchor is a reference, never shown in the store: the image run
      //   keeps it for this run's photos, and only a later resume would have
      //   to draw another.
      logWarn("mink.revamp: the anchor could not be stored", {
        revampId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  /** Shots whose photo is too small for any phone crop (L2-D). */
  const noPhoneCrop = new Set<string>();
  /**
   * A shot's phone crop: a centred 4:5 cut of its own photo. ★★ Cut from the
   * picture the model drew when this invocation holds it (L2-D): a 21:9 draw
   * is 1344 px tall at 2K, where its stored 2520x1080 copy leaves 864 px
   * across. A resumed run that only has the stored copy cuts it from that.
   */
  const storePhone = async (
    p: RevampPlannedShot,
    wide: Photo,
    drawn: Uint8Array | null = null,
  ) => {
    if (
      !p.needsPhone ||
      ledger.phones.has(p.shot.id) ||
      noPhoneCrop.has(p.shot.id)
    ) {
      return;
    }
    const source = drawn ?? wide.bytes ?? (await readBytes(wide.image));
    const prepared = source
      ? await safePrepare(prepare, source, REVAMP_PHONE_FRAME, PHONE_BYTE_LIMIT)
      : null;
    if (!prepared) {
      // ★ A phone crop that cannot be made leaves the phone showing the
      //   wide photo, as the storefront does for any slot without one. The
      //   picture's own size says why: a 21:9 picture drawn at 1K is 672 px
      //   tall, and no 4:5 cut of it reaches the storefront's 800 px floor.
      const size = source ? await measureImage(source) : null;
      // ★ Too small is final: the stored copy is a crop of the same picture,
      //   so no later try in this run can cut a larger one.
      if (size && phoneCropWidth(size) < SLOT_IMAGE_MIN_WIDTH) {
        noPhoneCrop.add(p.shot.id);
      }
      logWarn("mink.revamp: phone crop could not be made", {
        revampId,
        shotId: p.shot.id,
        from: drawn ? "drawn" : "stored",
        width: size?.width ?? null,
        height: size?.height ?? null,
        cropWidth: size ? phoneCropWidth(size) : null,
        minWidth: SLOT_IMAGE_MIN_WIDTH,
      });
      return;
    }
    ledger.phones.set(
      p.shot.id,
      await storeRevampImage({
        revampId,
        storeId,
        role: "slot",
        slotId: phoneSlotId(p.shot.id),
        bytes: prepared.bytes,
        mediaType: prepared.mediaType,
        width: prepared.width,
        height: prepared.height,
        review: wide.image.review,
        problems: [],
        alt: altFor(p.shot),
      }),
    );
  };
  /** The full-size draw behind a kept photo of this invocation, if any. */
  const drawnBehind = (p: RevampPlannedShot, photo: Photo) =>
    photo.recrop ? null : (candidateFor(p.shot.id, photo.bytes)?.drawn ?? null);

  // The reviewer, as the engine and the delayed reviews share it: picked once.
  const provider = revampProvider();
  let reviewerPicked = false;
  let reviewerChosen: ThemeImageReviewer | null = null;
  const pickReviewer = (): ThemeImageReviewer | null => {
    if (!reviewerPicked) {
      reviewerPicked = true;
      reviewerChosen =
        options.reviewer !== undefined
          ? options.reviewer
          : defaultReviewer(
              provider,
              revampAdmissionDrain(ctx, IMAGE_REVIEW_TRY_TIMEOUT_MS),
              () =>
                // ★ A 429 the review client waited out and tried again (P0).
                charge(
                  revampCallUsage(THEME_IMAGE_REVIEW_MODEL_KEY, {
                    rateLimited: 1,
                  }),
                ),
            );
    }
    return reviewerChosen;
  };
  /**
   * The anchor a delayed review compares a photo with: what the engine
   * showed its own reviewer (the reused stored anchor, or the crop of the
   * one it drew, none when that could not be cropped). Null until either is
   * known: a run that drew nothing compares with the stored anchor.
   */
  let anchorReview: { bytes: Uint8Array | null } | null = seed
    ? { bytes: seed.anchor.bytes }
    : null;
  /**
   * Each brief's last review call: which picture, sent or not, when it was
   * asked and when it answered.
   */
  const lastReview = new Map<
    string,
    { key: string; sent: boolean; at: number; startedAt: number }
  >();
  /**
   * Each brief's least flawed picture this run with only minor problems: what
   * a delayed verdict falls back to when the photo kept after it (an
   * unreviewed redraw) turns out to block, or is never looked at.
   */
  const flagged = new Map<
    string,
    { key: string; problems: ThemeImageProblem[]; small?: boolean }
  >();
  /**
   * What each check really said of each picture of a shot this run, by the
   * digest of the picture checked (B14): a photo redrawn for its size goes
   * back to the engine with a problem of its own, which is never a verdict.
   */
  const verdicts = new Map<string, Map<string, ThemeImageProblem[]>>();
  /** Shots already drawn again for their size this run: once only (B14). */
  const smallRedrawn = new Set<string>();
  /** The picture of a shot this run prepared, by digest, is below its frame. */
  const isSmall = (shotId: string, key: string): boolean => {
    const p = byId.get(shotId);
    const prepared = candidates.get(shotId)?.get(key)?.prepared;
    return !!p?.frame && !!prepared && prepared.width < p.frame.width;
  };
  /**
   * The largest picture of a shot this run that its check let through
   * (passed, or only minor problems) and that is wider than `width` (B14):
   * of a photo and its redraw, the larger is kept.
   */
  const largerChecked = (
    p: RevampPlannedShot,
    width: number,
  ): { prepared: PreparedSlotImage; problems: ThemeImageProblem[] } | null => {
    let best: {
      prepared: PreparedSlotImage;
      problems: ThemeImageProblem[];
    } | null = null;
    for (const [key, candidate] of candidates.get(p.shot.id) ?? []) {
      const problems = verdicts.get(p.shot.id)?.get(key);
      if (!problems || isBlocking(problems, p.slot!.purpose)) continue;
      if (candidate.prepared.width <= (best?.prepared.width ?? width)) {
        continue;
      }
      best = { prepared: candidate.prepared, problems };
    }
    return best;
  };
  /**
   * The engine's crop and compress, keeping every picture it prepares for a
   * shot with the draw it came from (`candidates`). ★ The engine hands a
   * slot's own `target` object to the crop, which is how a picture is told
   * apart from the anchor's; a picture it cannot place is simply not kept.
   */
  const shotByTarget = new Map<object, RevampPlannedShot>();
  for (const p of usable) if (p.slot) shotByTarget.set(p.slot.target, p);
  const preparing: typeof prepareSlotImage = async (
    bytes,
    target,
    byteLimit,
    loader,
  ) => {
    const prepared = await prepare(bytes, target, byteLimit, loader);
    const p = shotByTarget.get(target);
    if (prepared.ok && p) {
      const kept = candidates.get(p.shot.id) ?? new Map<string, Candidate>();
      kept.set(digestOf(prepared.value.bytes), {
        prepared: prepared.value,
        drawn: p.needsPhone ? bytes : null,
      });
      candidates.set(p.shot.id, kept);
    }
    return prepared;
  };

  // ★★ No new paid call once the deadline has passed (jobs-4): no draw, no
  //   redraw and no review is started, the ones in flight finish and are
  //   stored (the provider bills them whatever happens next), and what was
  //   never started is left for the next run instead of being cropped from
  //   the shoot. `drained` records that something was left.
  let drained = false;

  // ── A verdict for every parked photo (L2-I, P0) ──────────────────────────
  // ★★ Worked out from the moment a photo is parked, DURING the shoot (P0),
  //   and for a photo an earlier invocation parked as soon as the shoot's
  //   anchor is known, so its waits overlap the rest of the shoot instead of
  //   following it. Step 6b waits for all of them.

  /**
   * Make a parked photo its shot's own: the same object, under the shot id.
   * ★★ One let in `unchecked` (owner's decision 2) is adopted WITH its
   *   marker, REVAMP_UNCHECKED_PROBLEM, written on the row in the same insert,
   *   so it is never the shot's without it (and never charged: buildOutcomes
   *   reads the marker). It used to be uploaded and filed a second time,
   *   because an adopted row could carry no problems.
   */
  const promote = async (
    p: RevampPlannedShot,
    entry: PendingPhoto,
    review: RevampStoredImage["review"],
    unchecked = false,
  ): Promise<void> => {
    // ★★ A parked photo smaller than its frame keeps saying so (B14): it was
    //   drawn before its check spoke, so no redraw is left to make it larger.
    const small = entry.image.width < p.frame!.width;
    const marker = [
      ...(unchecked ? [REVAMP_UNCHECKED_PROBLEM] : []),
      ...(small ? [REVAMP_SMALL_PROBLEM] : []),
    ];
    let image = await adopt(
      { ...entry.image, slotId: p.shot.id, review },
      marker,
    );
    let bytes = entry.bytes;
    if (!image) {
      // The parked object could not be carried over: its bytes, stored
      // again, with the same marker.
      bytes = bytes ?? (await readBytes(entry.image));
      if (bytes) {
        try {
          image = await storeRevampImage({
            revampId,
            storeId,
            role: "slot",
            slotId: p.shot.id,
            bytes,
            mediaType: mediaTypeOfPath(entry.image.path),
            width: entry.image.width,
            height: entry.image.height,
            review,
            problems: marker,
            alt: altFor(p.shot),
          });
        } catch (error) {
          logWarn("mink.revamp: a reviewed photograph could not be stored", {
            revampId,
            shotId: p.shot.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (!image) {
      ledger.causes.set(p.shot.id, "failed");
      return;
    }
    if (small) ledger.small.add(p.shot.id);
    ledger.photos.set(p.shot.id, {
      image,
      bytes: image.sha256 === entry.image.sha256 ? bytes : null,
      recrop: false,
    });
  };
  /** This run's flagged earlier attempt of a shot, kept as its photo. */
  const keepFlaggedAttempt = async (p: RevampPlannedShot): Promise<boolean> => {
    const best = flagged.get(p.shot.id);
    const candidate = best
      ? candidates.get(p.shot.id)?.get(best.key)
      : undefined;
    if (!best || !candidate) return false;
    // ★ An earlier attempt kept for its size check (B14) passed its check: it
    //   is flagged only when the check found minor problems.
    const small = candidate.prepared.width < p.frame!.width;
    try {
      const stored = await storeRevampImage({
        revampId,
        storeId,
        role: "slot",
        slotId: p.shot.id,
        bytes: candidate.prepared.bytes,
        mediaType: candidate.prepared.mediaType,
        width: candidate.prepared.width,
        height: candidate.prepared.height,
        review: best.problems.length > 0 ? "flagged" : "passed",
        problems: [...best.problems, ...(small ? [REVAMP_SMALL_PROBLEM] : [])],
        alt: altFor(p.shot),
      });
      if (small) ledger.small.add(p.shot.id);
      ledger.photos.set(p.shot.id, {
        image: stored,
        bytes:
          stored.sha256 === candidate.prepared.sha256
            ? candidate.prepared.bytes
            : null,
        recrop: false,
      });
      return true;
    } catch (error) {
      logWarn("mink.revamp: an earlier attempt could not be stored", {
        revampId,
        shotId: p.shot.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
  /**
   * Parked photos whose check could not be had in time (owner's decision 2):
   * what stands in for each is decided at step 7, once every checked photo
   * of the shoot is known; each keeps its parked photo, let in unchecked
   * when no checked photo's crop fits its frame.
   */
  const unchecked = new Map<string, PendingPhoto>();
  const delayedReviewCalls = new ImageRequestPool(IMAGE_CONCURRENCY);
  /** Ends the parked photos' waits and checks when the step stops on a failure. */
  const settleStop = new AbortController();
  /** The anchor a delayed review shows beside the photo, as base64. */
  const anchorForReview = async (): Promise<string | null> => {
    const bytes = anchorReview
      ? anchorReview.bytes
      : anchorImage
        ? await readBytes(anchorImage)
        : null;
    return bytes ? base64(bytes) : null;
  };
  /**
   * Ask the reviewer about a parked photo: at once when its check was never
   * asked, then again after each wait of REVAMP_REVIEW_RETRY_DELAYS_MS while
   * it stays unavailable, all inside the photo's budget
   * (REVAMP_PHOTO_CHECK_BUDGET_MS) from its first ask, in whichever
   * invocation that was. ★★ A verdict the record already holds is never asked
   * again, and the tries and the budget carry on from the record (P0).
   * ★ Never once the drain has begun (jobs-4): the photo then stays parked
   * for the next run, which carries on from where this one got to.
   */
  const reviewLater = async (
    p: RevampPlannedShot,
    entry: PendingPhoto,
    reviewer: ThemeImageReviewer,
  ): Promise<DelayedVerdict> => {
    const shotId = p.shot.id;
    const known = checks.get(shotId);
    if (
      known?.verdict &&
      known.sha256 === entry.image.sha256 &&
      !(ctx.recoverable && known.verdict === "expired")
    ) {
      return known.verdict === "expired"
        ? { kind: "expired" }
        : {
            kind: "reviewed",
            problems: known.verdict.problems.filter(isThemeImageProblem),
          };
    }
    const bytes = entry.bytes ?? (await readBytes(entry.image));
    if (!bytes) return { kind: "unreadable" };
    const anchor = await anchorForReview();
    const cut = AbortSignal.any([
      ctx.signal,
      settleStop.signal,
      ...(ctx.draining ? [ctx.draining] : []),
    ]);
    let tries = ctx.recoverable ? 0 : entry.tries;
    let lastAt = entry.lastTriedAt;
    let firstAskedAt = ctx.recoverable ? null : entry.firstAskedAt;
    const budgetEnd = () =>
      Math.min(
        ctx.finishBy
          ? ctx.finishBy - REVAMP_WORK_BUDGET.finalChecksMs
          : Infinity,
        firstAskedAt === null
          ? Infinity
          : firstAskedAt + REVAMP_PHOTO_CHECK_BUDGET_MS,
      );
    const left = (): DelayedVerdict => {
      if (ctx.draining?.aborted) drained = true;
      return { kind: "left" };
    };
    for (;;) {
      if (tries > 0) {
        const delay = REVAMP_REVIEW_RETRY_DELAYS_MS[tries - 1];
        if (delay === undefined) return { kind: "expired" };
        const wait = Math.max(0, delay - (now() - lastAt));
        // ★ A wait that would end past the photo's budget is not waited.
        if (now() + wait >= budgetEnd()) return { kind: "expired" };
        if (wait > 0 && !(await sleep(wait, cut))) {
          ctx.signal.throwIfAborted();
          return left();
        }
      } else if (now() >= budgetEnd()) {
        return { kind: "expired" };
      }
      // ★ At most IMAGE_CONCURRENCY review calls at once, the engine's own
      //   bound, while every parked photo's wait runs at the same time. The
      //   permit is never given up half way: a call it started is paid for.
      const asked = await delayedReviewCalls.run(async () => {
        if (
          ctx.signal.aborted ||
          ctx.draining?.aborted ||
          settleStop.signal.aborted
        ) {
          return null;
        }
        if (firstAskedAt === null) {
          // ★★ The budget starts with the first ask, and is kept (P0).
          firstAskedAt = now();
          noteCheck(shotId, { sha256: entry.image.sha256, firstAskedAt });
          void saveChecks().catch(() => undefined);
        }
        return reviewOnce(
          reviewer,
          withGoods(
            {
              purpose: p.slot!.purpose,
              brief: p.slot!.brief,
              candidate: base64(bytes),
              anchor,
              set: null,
              attempt: entry.attempt,
            },
            shotId,
          ),
          AbortSignal.any([ctx.signal, settleStop.signal]),
          { until: budgetEnd(), now },
        );
      }, NEVER_ABORTED);
      if (!asked) {
        ctx.signal.throwIfAborted();
        return left();
      }
      const { review, sent, outOfTime } = asked;
      if (
        review.kind === "unavailable" &&
        review.code === "cancelled" &&
        !outOfTime &&
        (ctx.draining?.aborted || settleStop.signal.aborted)
      ) {
        return left();
      }
      if (sent) charge(reviewUsage(review));
      ctx.signal.throwIfAborted();
      // A budget spent before its permit came: nothing was asked.
      if (!sent && outOfTime) return { kind: "expired" };
      tries += 1;
      lastAt = now();
      noteCheck(shotId, {
        sha256: entry.image.sha256,
        tries,
        firstAskedAt: firstAskedAt ?? undefined,
        lastTriedAt: lastAt,
        ...(review.kind === "reviewed"
          ? { verdict: { problems: [...review.problems] } }
          : {}),
      });
      void saveChecks().catch(() => undefined);
      if (review.kind === "reviewed") {
        return { kind: "reviewed", problems: review.problems };
      }
      logInfo("mink.revamp: a photograph's review is unavailable", {
        revampId,
        shotId,
        tries,
        code: review.code,
      });
      if (ctx.recoverable) {
        capacityPending = true;
        return { kind: "left" };
      }
      if (outOfTime) return { kind: "expired" };
    }
  };
  /** What a delayed verdict makes of a parked photo. */
  const settleVerdict = async (
    p: RevampPlannedShot,
    entry: PendingPhoto,
    verdict: DelayedVerdict,
  ): Promise<void> => {
    // ★ Left parked when the drain came first: the next run starts with it.
    if (verdict.kind === "left") return;
    pending.delete(p.shot.id);
    if (verdict.kind === "unreadable") {
      // A photo nobody can read back is not one to show: a crop stands in.
      logWarn("mink.revamp: a parked photograph could not be read", {
        revampId,
        shotId: p.shot.id,
      });
      ledger.causes.set(p.shot.id, "failed");
      return;
    }
    if (
      verdict.kind === "reviewed" &&
      !isBlocking(verdict.problems, p.slot!.purpose)
    ) {
      // ★ The engine's own rule: the least flawed picture of the shot is
      //   kept, so an earlier attempt with fewer minor problems wins.
      const earlier = flagged.get(p.shot.id);
      if (
        verdict.problems.length > 0 &&
        earlier &&
        // ★ An attempt kept back for its size (B14) never wins on count.
        !earlier.small &&
        earlier.problems.length < verdict.problems.length &&
        (await keepFlaggedAttempt(p))
      ) {
        return;
      }
      await promote(p, entry, verdict.problems.length ? "flagged" : "passed");
      return;
    }
    // ★★ A blocking problem never reaches a page, and a photo nobody could
    //   look at gives way to one that was looked at: this run's flagged
    //   earlier attempt of the shot when there is one.
    if (await keepFlaggedAttempt(p)) return;
    if (verdict.kind === "reviewed") {
      logInfo("mink.revamp: a photograph failed its delayed review", {
        revampId,
        shotId: p.shot.id,
        problems: verdict.problems,
      });
      // The no-photo rule: a crop of the shoot, noted on the card.
      ledger.causes.set(p.shot.id, "rejected");
      ledger.blocked.add(p.shot.id);
      return;
    }
    // ★★ No verdict within its budget (owner's decision 2, 2026-10-23): a
    //   crop of a photo of the shoot that WAS checked stands in when one
    //   fits the frame, else this photo is let in unchecked and the card
    //   says so. Decided at step 7, once every checked photo is known; the
    //   record keeps the verdict, so no later run asks again.
    noteCheck(p.shot.id, { sha256: entry.image.sha256, verdict: "expired" });
    void saveChecks().catch(() => undefined);
    unchecked.set(p.shot.id, entry);
    ledger.causes.set(p.shot.id, "unchecked");
    logInfo("mink.revamp: a photograph's check could not be had in time", {
      revampId,
      shotId: p.shot.id,
    });
  };
  /** Each parked photo's verdict being worked out: started once, awaited at 6b. */
  const settling = new Map<string, Promise<void>>();
  const settleOne = async (
    p: RevampPlannedShot,
    entry: PendingPhoto,
  ): Promise<void> => {
    const reviewer = pickReviewer();
    if (!reviewer) {
      // ★ The review model is switched off: as for any photo drawn without
      //   one, a parked photo is let in unreviewed.
      pending.delete(p.shot.id);
      if (budgeted) {
        unchecked.set(p.shot.id, entry);
        return;
      }
      await promote(p, entry, "unreviewed");
      return;
    }
    await settleVerdict(p, entry, await reviewLater(p, entry, reviewer));
  };
  const startSettling = (p: RevampPlannedShot, entry: PendingPhoto): void => {
    if (!p.slot || settling.has(p.shot.id)) return;
    const work = settleOne(p, entry);
    // Awaited at step 6b, which reports a failure: this only keeps one from
    // being an unhandled rejection while the shoot runs.
    work.catch(() => undefined);
    settling.set(p.shot.id, work);
  };
  /**
   * ★ Every parked photo at once: the waits are most of the time, so under a
   *   reviewer outage a whole shoot waits one round, not one per three
   *   photos (the calls themselves are bounded in reviewLater).
   */
  const settlePending = async (): Promise<void> => {
    for (const [shotId, entry] of pending) {
      const p = byId.get(shotId);
      if (p) startSettling(p, entry);
    }
    const settled = await Promise.allSettled(settling.values());
    const failed = settled.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  /** On a stop or a failure: end the waits and the checks, and let them finish. */
  const abandonSettling = async (): Promise<void> => {
    settleStop.abort();
    await Promise.allSettled(settling.values());
  };

  /**
   * ★★ Park a photo whose review has not spoken (L2-I): stored, because it is
   *   paid for, under `<shot>~review`, where no section reads it, until a
   *   delayed review decides: asked again at once, during the shoot (P0).
   */
  const park = async (
    p: RevampPlannedShot,
    outcome: Extract<SlotOutcome, { status: "generated" }>,
    image: PreparedSlotImage,
  ) => {
    const stored = await storeRevampImage({
      revampId,
      storeId,
      role: "slot",
      slotId: pendingSlotId(p.shot.id),
      bytes: image.bytes,
      mediaType: image.mediaType,
      width: image.width,
      height: image.height,
      review: "unreviewed",
      problems: [REVIEW_PENDING_PROBLEM],
      alt: altFor(p.shot),
    });
    const ours = stored.sha256 === image.sha256;
    const last = lastReview.get(p.shot.id);
    // The engine's last review of this shot was of the picture it kept.
    const asked =
      ours && !!last && last.key === digestOf(image.bytes) && last.sent;
    const entry: PendingPhoto = {
      image: stored,
      bytes: ours ? image.bytes : null,
      tries: asked ? 1 : 0,
      lastTriedAt: asked && last ? last.at : 0,
      firstAskedAt: asked && last ? last.startedAt : null,
      attempt: outcome.attempts,
    };
    pending.set(p.shot.id, entry);
    // ★★ Its check so far goes on the job row (P0): the next invocation
    //   carries on from it, never from nothing.
    noteCheck(p.shot.id, {
      sha256: stored.sha256,
      tries: entry.tries,
      firstAskedAt: entry.firstAskedAt ?? undefined,
      lastTriedAt: asked ? entry.lastTriedAt : undefined,
      verdict: undefined,
    });
    void saveChecks().catch(() => undefined);
    logInfo("mink.revamp: a photograph waits for its review", {
      revampId,
      shotId: p.shot.id,
      asked,
    });
    startSettling(p, entry);
  };
  // ★★ What each shot shows (B16), worked out before anything is drawn or
  //   checked: its brief carries it to the image request (the product photos
  //   after the anchor, image-prompt.ts), and `withGoods` to every check.
  const goodsShots = new Map<string, RevampShot>();
  for (const p of drawSet) goodsShots.set(p.shot.id, p.shot);
  for (const shotId of pending.keys()) {
    const p = byId.get(shotId);
    if (p) goodsShots.set(shotId, p.shot);
  }
  if (goodsShots.size > 0) {
    const resolved = await resolveShotGoods({
      revampId,
      storeId,
      shots: [...goodsShots.values()],
      request: input.request,
      snapshot: input.snapshot,
    });
    for (const [shotId, { goods, lost }] of resolved) {
      goodsByShot.set(shotId, goods);
      const p = byId.get(shotId);
      if (!p?.slot) continue;
      // ★★ A picture with no products has nobody in it (the compiler's rule,
      //    for a shot this step took the products from), and a shot that
      //    lost products is described by what it now shows: its own words
      //    may name them, and a picture asked for a product beside the rule
      //    that it shows none (or only the others) invents it (B16). The
      //    alt text follows the picture (`p.shot`, this step's own copy).
      const { people, ...brief } = p.slot.brief;
      const subject = lost
        ? revampShotSubjectFor({
            storeName: input.snapshot.storeName,
            business: businessLine(input.request),
            names:
              goods.kind === "merchant"
                ? goods.products.map((product) => product.name)
                : [],
          })
        : null;
      p.slot.brief = {
        ...brief,
        ...(subject ? { subject } : {}),
        ...(people && goods.kind !== "none" ? { people } : {}),
        goods,
      };
      if (subject) {
        p.shot = {
          ...p.shot,
          subject,
          ...(goods.kind === "none" ? { people: "none" as const } : {}),
        };
      }
    }
  }

  // ★★ A photo an earlier invocation parked is asked again while this one
  //   draws (P0), once the anchor it is compared with is known.
  if (anchorReview) {
    for (const [shotId, entry] of pending) {
      const p = byId.get(shotId);
      if (p) startSettling(p, entry);
    }
  }

  // 6. Draw.
  let result: ThemeImageRunResult | null = null;
  /**
   * ★★ The draws asked and not answered yet (D3). A stop ends the engine's
   *   wait for a draw before the draw itself answers, and only its answer
   *   says whether the stop cut it off on the wire (`ledger.cutOff`), so a
   *   stop counts what was drawn once these are in. The image client ends
   *   each one at the stop, so this costs no real wait.
   */
  const drawsInFlight = new Set<Promise<ThemeImageResult>>();
  const tracked =
    (
      draw: ThemeStudioImageClient["generateImage"],
    ): ThemeStudioImageClient["generateImage"] =>
    (request, signal) => {
      const answer = draw(request, signal);
      drawsInFlight.add(answer);
      const done = () => drawsInFlight.delete(answer);
      void answer.then(done, done);
      return answer;
    };
  let released = false;
  const release = async () => {
    if (released || claimed === 0) return;
    released = true;
    if (ctx.signal.aborted) await Promise.allSettled(drawsInFlight);
    let used = 0;
    if (anchorCost > 0 && anchorWasDrawn(ledger, result)) used += 1;
    for (const outcome of ledger.settled.values()) {
      if (wasDrawn(outcome, ledger)) used += 1;
    }
    // ★ The record is cleared first; when it cannot be, another runner owns
    //   the job and settles the claim from the record instead.
    await settlePhotoHold(ctx, claimed - used);
  };
  if (drawSet.length > 0) {
    try {
      // ★ Picked inside the try: a misconfigured image model throws, and the
      //   photos claimed above must go back when it does.
      const provided =
        options.imageClient ?? defaultImageClient(provider, drawsDrain);
      /** Draws asked per brief in this invocation: which attempt a refusal was. */
      const drawAttempts = new Map<string, number>(
        [...checks].map(([key, state]) => [
          key === checkKeyOf(ANCHOR_SLOT) ? ANCHOR_SLOT : key,
          state.draws ?? state.redraws?.length ?? 0,
        ]),
      );
      let anchorReplayed = false;
      const client: ThemeStudioImageClient = {
        provider: provided.provider,
        generateImage: tracked(async (request, signal) => {
          if (
            request.purpose === "anchor" &&
            anchorCandidate &&
            !anchorReplayed
          ) {
            const bytes = await readBytes(anchorCandidate);
            if (!bytes) throw new ImageCheckpointError();
            anchorReplayed = true;
            return {
              kind: "ok",
              bytes,
              mediaType: mediaTypeOfPath(anchorCandidate.path),
              usage: ZERO_IMAGE_USAGE,
            };
          }
          const attempt = (drawAttempts.get(request.briefId) ?? 0) + 1;
          drawAttempts.set(request.briefId, attempt);
          if (drawsDrain?.aborted) {
            drained = true;
            // Never sent, so never billed: given back with the claim.
            return {
              kind: "error",
              code: "cancelled",
              usage: ZERO_IMAGE_USAGE,
            };
          }
          if (budgeted) {
            const used = [...checks.values()].reduce(
              (sum, state) => sum + (state.draws ?? 0),
              0,
            );
            if (
              used >= REVAMP_WORK_BUDGET.imageCalls ||
              attempt > (request.purpose === "anchor" ? 4 : 3)
            )
              return {
                kind: "error",
                code: "cancelled",
                usage: ZERO_IMAGE_USAGE,
              };
            noteCheck(checkKeyOf(request.briefId), { draws: attempt });
            await saveChecks();
            ctx.signal.throwIfAborted();
          }
          const answer = await provided.generateImage(request, signal);
          // ★★ One the run's stop cut off on the wire keeps its photo spent
          //   (D3, `stoppedInFlight`).
          if (stoppedInFlight(answer)) ledger.cutOff.add(request.briefId);
          // ★★ Counted the moment it returns (L2-F), whatever becomes of
          //   the picture: refused by its review, unusable, or the step
          //   stopped before storing it; with the tries it met that got no
          //   answer, a 429 or a clock, counted per model (P0).
          charge(
            mergeUsage(
              drawCallUsage(answer),
              revampCallUsage(
                THEME_STUDIO_IMAGE_MODEL_KEY,
                drawCallCounts(answer),
              ),
            ),
          );
          if (
            ctx.recoverable &&
            answer.kind === "error" &&
            (answer.code === "rate_limited" ||
              answer.timing?.providerAttempts === 0)
          ) {
            noteCheck(checkKeyOf(request.briefId), { draws: attempt - 1 });
            await saveChecks();
          }
          if (
            ctx.recoverable &&
            answer.kind === "error" &&
            TRANSIENT_ANCHOR_CODES.has(answer.code)
          )
            capacityPending = true;
          if (answer.kind === "refused") {
            // ★ Why it is drawn again (P0): the image model declined it.
            noteRedraw(checkKeyOf(request.briefId), attempt, [REFUSED_PROBLEM]);
          }
          // A draw the client held back once the shoot's drain began (its
          // permit or its retry came too late, `revampDrainingCapacity`) is
          // left too.
          if (
            answer.kind === "error" &&
            answer.code === "cancelled" &&
            drawsDrain?.aborted
          ) {
            drained = true;
          }
          return answer;
        }),
      };
      const reviewer = pickReviewer();
      if (budgeted && !reviewer)
        throw new RevampStepError(
          "photos_failed",
          "The photo reviewer is unavailable; a checked redesign cannot be completed.",
        );
      result = await runSlotImageGeneration(
        client,
        {
          slots: drawSet.map((p) => p.slot!),
          direction: revampImageDirection(input.plan, input.snapshot),
          // ★ The anchor shows no products (B16): it carries no references,
          //   so it could show none of the merchant's own, and every other
          //   picture is matched to it.
          anchorLead: noGoodsAnchorLead(
            input.plan,
            input.snapshot,
            input.request,
          ),
          reviewer,
          seed,
        },
        ctx.signal,
        {
          onPrepared: budgeted
            ? async (briefId, image, attempt) => {
                const p = byId.get(briefId);
                const anchor = ctx.recoverable && briefId === ANCHOR_SLOT;
                if (!p && !anchor) return;
                await storeRevampImage({
                  revampId,
                  storeId,
                  role: anchor ? "anchor" : "slot",
                  slotId: `${briefId}~candidate-${attempt}`,
                  bytes: image.bytes,
                  mediaType: image.mediaType,
                  width: image.width,
                  height: image.height,
                  review: "unreviewed",
                  problems: ["review-pending"],
                  alt: p ? altFor(p.shot) : "Private art direction reference",
                });
                if (anchor) ledger.anchorDrawn = true;
              }
            : undefined,
          resume: Object.fromEntries(
            [...checks].map(([key, state]) => [
              key === checkKeyOf(ANCHOR_SLOT) ? ANCHOR_SLOT : key,
              {
                attempts: Math.max(
                  0,
                  (state.draws ?? state.redraws?.length ?? 0) -
                    (key === ANCHOR_CHECK_KEY && anchorCandidate ? 1 : 0),
                ),
                ...(state.correction
                  ? {
                      retake: {
                        problems: [state.correction],
                        note: "Correct the problems from the earlier attempt.",
                      },
                    }
                  : {}),
              },
            ]),
          ),
          prepare: async (bytes, target, byteLimit) => {
            if (anchorCandidate && digestOf(bytes) === anchorCandidate.sha256)
              return {
                ok: true,
                value: {
                  bytes: Buffer.from(bytes),
                  mediaType: "image/webp",
                  width: anchorCandidate.width,
                  height: anchorCandidate.height,
                  sha256: anchorCandidate.sha256,
                  originalMediaType: mediaTypeOfPath(anchorCandidate.path),
                  originalByteSize: bytes.byteLength,
                },
              };
            return preparing(bytes, target, byteLimit);
          },
          ...(options.concurrency ? { concurrency: options.concurrency } : {}),
          // ★ The engine's own review, unless the drain has begun: a photo
          //   drawn in flight then is parked "unreviewed" and the step hands
          //   over, so the next run can check it rather than this one
          //   starting a paid call the hard stop may cut off.
          review: async (imageReviewer, reviewInput, signal, briefId) => {
            const key = digestOf(Buffer.from(reviewInput.candidate, "base64"));
            const startedAt = now();
            if (ctx.draining?.aborted) {
              drained = true;
              lastReview.set(briefId, {
                key,
                sent: false,
                at: startedAt,
                startedAt,
              });
              if (ctx.recoverable && reviewInput.purpose === "anchor")
                throw new ImageCheckpointError();
              return {
                kind: "unavailable",
                code: "cancelled",
                usage: ZERO_USAGE,
                estimatedCostMicroUsd: 0,
              };
            }
            // ★★ The photo's budget starts with this, its first ask (P0): a
            //   check that outlasts it reads as a timeout, and the photo is
            //   parked with its budget spent.
            const { review, sent } = await reviewOnce(
              imageReviewer,
              withGoods(reviewInput, briefId),
              signal,
              { until: startedAt + REVAMP_PHOTO_CHECK_BUDGET_MS, now },
            );
            const heldBack =
              review.kind === "unavailable" &&
              review.code === "cancelled" &&
              ctx.draining?.aborted === true;
            if (heldBack) drained = true;
            else if (sent) charge(reviewUsage(review));
            lastReview.set(briefId, {
              key,
              sent: sent && !heldBack,
              at: now(),
              startedAt,
            });
            if (
              ctx.recoverable &&
              review.kind === "unavailable" &&
              reviewInput.purpose === "anchor" &&
              !heldBack
            ) {
              capacityPending = true;
              throw new ImageCheckpointError();
            }
            if (review.kind !== "reviewed") return review;
            if (
              budgeted &&
              (ctx.recoverable || reviewInput.purpose !== "anchor")
            ) {
              const keyOf = checkKeyOf(briefId);
              noteCheck(keyOf, {
                sha256: key,
                tries: (checks.get(keyOf)?.tries ?? 0) + 1,
                verdict: { problems: [...review.problems] },
                firstAskedAt: checks.get(keyOf)?.firstAskedAt ?? startedAt,
                lastTriedAt: now(),
              });
              await saveChecks();
            }
            logInfo("mink.revamp: photo check done", {
              revampId,
              shotId: briefId,
              ms: Math.max(0, now() - startedAt),
              verdict: review.problems.length ? "problems" : "passed",
            });
            const shot = reviewInput.purpose !== "anchor";
            if (shot) {
              const known = verdicts.get(briefId) ?? new Map();
              known.set(key, [...review.problems]);
              verdicts.set(briefId, known);
            }
            // ★★ B14: a picture its check let through but smaller than its
            //   frame is drawn again, once, while the engine still has a
            //   redraw to give (no new claim, no new charge rule).
            const small = shot && isSmall(briefId, key);
            const redrawSmall =
              small &&
              !smallRedrawn.has(briefId) &&
              reviewInput.attempt <= THEME_IMAGE_REDRAWS &&
              !isBlocking(review.problems, reviewInput.purpose);
            if (redrawSmall) smallRedrawn.add(briefId);
            if (review.problems.length > 0 || redrawSmall) {
              logInfo("mink.revamp: photo check failed", {
                revampId,
                shotId: briefId,
                attempt: reviewInput.attempt,
                problems: review.problems,
                blocking: isBlocking(review.problems, reviewInput.purpose),
              });
              // ★ Why this attempt was turned down (P0).
              noteRedraw(
                checkKeyOf(briefId),
                reviewInput.attempt,
                redrawSmall
                  ? [REVAMP_TOO_SMALL_CAUSE, ...review.problems]
                  : review.problems,
              );
              if (!isBlocking(review.problems, reviewInput.purpose)) {
                const best = flagged.get(briefId);
                if (!best || review.problems.length < best.problems.length) {
                  flagged.set(briefId, {
                    key,
                    problems: review.problems,
                    ...(small ? { small: true } : {}),
                  });
                }
              }
            }
            if (!redrawSmall) return review;
            // The engine redraws only on a problem from its closed list: the
            // closest one, with a note saying what really happened. Nothing
            // more is asked of the check: this verdict was already paid for.
            return {
              ...review,
              problems: review.problems.includes("poor_crop")
                ? review.problems
                : [...review.problems, "poor_crop"],
              note: review.note.trim()
                ? `${TOO_SMALL_NOTE} ${review.note}`
                : TOO_SMALL_NOTE,
            };
          },
          onAnchor: async (anchor) => {
            const stored = await keepAnchor(anchor);
            ledger.anchorDrawn = true;
            if (stored) anchorImage = stored;
            // What the engine shows the reviewer as the anchor: its crop.
            anchorReview = { bytes: anchor.prepared?.bytes ?? null };
          },
          onSlotSettled: async (outcome, settled) => {
            ledger.settled.set(outcome.slotId, outcome);
            const p = byId.get(outcome.slotId);
            if (p && outcome.status === "generated" && settled) {
              let image = settled;
              let review = outcome.review;
              let problems: string[] = [...(outcome.problems ?? [])];
              if (review !== "unreviewed") {
                // ★★ B14: what the check really said of the kept picture (the
                //   problem a size redraw goes back with is not a verdict),
                //   and of a photo and its redraw, both still below the
                //   frame, the larger one the check let through.
                const real = verdicts
                  .get(p.shot.id)
                  ?.get(digestOf(image.bytes));
                if (real) {
                  problems = [...real];
                  review = real.length > 0 ? "flagged" : "passed";
                }
                const larger =
                  image.width < p.frame!.width
                    ? largerChecked(p, image.width)
                    : null;
                if (larger) {
                  image = larger.prepared;
                  problems = [...larger.problems];
                  review = larger.problems.length > 0 ? "flagged" : "passed";
                }
              }
              const small = image.width < p.frame!.width;
              if (small) {
                // ★ Only the picture can make it smaller than its frame (the
                //   crop never upscales): a draw at less than the 2K asked.
                logWarn(
                  "mink.revamp: a photograph came back smaller than its frame",
                  {
                    revampId,
                    shotId: p.shot.id,
                    width: image.width,
                    height: image.height,
                    frameWidth: p.frame!.width,
                    frameHeight: p.frame!.height,
                  },
                );
              }
              if ((reviewer || budgeted) && outcome.review === "unreviewed") {
                await park(p, outcome, image);
              } else {
                const drawn =
                  candidateFor(p.shot.id, image.bytes)?.drawn ?? null;
                const stored = await storeRevampImage({
                  revampId,
                  storeId,
                  role: "slot",
                  slotId: p.shot.id,
                  bytes: image.bytes,
                  mediaType: image.mediaType,
                  width: image.width,
                  height: image.height,
                  review,
                  // ★★ Kept smaller than its frame: the row says so (B14).
                  problems: small
                    ? [...problems, REVAMP_SMALL_PROBLEM]
                    : problems,
                  alt: altFor(p.shot),
                });
                // ★ A racing run may have filled the slot first; its photo is
                //   the slot's, so these bytes are kept only when they ARE it.
                const ours = stored.sha256 === image.sha256;
                if (small && ours) ledger.small.add(p.shot.id);
                const photo: Photo = {
                  image: stored,
                  bytes: ours ? image.bytes : null,
                  recrop: false,
                };
                ledger.photos.set(p.shot.id, photo);
                // The phone crop is stored with its photo; one that fails here
                // is tried again after the run, never failing the run itself.
                try {
                  await storePhone(p, photo, ours ? drawn : null);
                  candidates.delete(p.shot.id);
                } catch (error) {
                  logWarn("mink.revamp: phone crop could not be stored", {
                    revampId,
                    shotId: p.shot.id,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              }
            } else if (p) {
              ledger.causes.set(p.shot.id, causeOf(outcome));
              candidates.delete(p.shot.id);
            }
            // A shot the run stopped before drawing (the drain, a stop) is
            // not done: the card's "7 of 24" must not run ahead of the shoot.
            if (!notStarted(outcome)) {
              done += 1;
              await reportProgress(ctx, done, total);
            }
          },
        },
      );
    } catch (error) {
      await abandonSettling();
      await release();
      await flushChecks();
      ctx.signal.throwIfAborted();
      if (ctx.recoverable && drained) throw new RevampDrainedError();
      if (
        ctx.recoverable &&
        capacityPending &&
        error instanceof ImageCheckpointError
      )
        throw new RevampRetryLaterError(
          "photos_unavailable",
          "The saved art direction reference is waiting for its check.",
          REVAMP_WORK_BUDGET.capacityRetryMs,
        );
      throw error;
    }
    if (ctx.signal.aborted) {
      await abandonSettling();
      await release();
      ctx.signal.throwIfAborted();
    }
    if (drained) {
      // ★ The checks in flight and the parked photos' checks finish (they
      //   are paid for, and a check's 75 s clock fits before the hard stop).
      //   The runner's drain ends their waits; when only the shoot's own
      //   drain has closed (D2), a parked photo's waits can go on until the
      //   runner's drain, at most 95 s later, and the hand-over with them.
      await Promise.allSettled(settling.values());
      await release();
      await flushChecks();
      if (!budgeted || ctx.recoverable) throw new RevampDrainedError();
    }
    if (
      ctx.recoverable &&
      result.anchorFailure &&
      result.anchorFailure.kind === "failed" &&
      TRANSIENT_ANCHOR_CODES.has(result.anchorFailure.code)
    )
      capacityPending = true;
    if (result.anchorFailure && !(budgeted && ledger.photos.size > 0)) {
      await abandonSettling();
      await release();
      await flushChecks();
      throw anchorFailureError(result.anchorFailure);
    }
  }

  // 7. A photograph for every shot that still has none.
  /**
   * A crop of a kept photo of the shoot, stored as the shot's own; never of
   * the anchor (B16, the header). ★★ With `checked` (owner's decision 2)
   * only a CHECKED photo of the shoot may be cut, never another crop, and
   * only one whose crop keeps enough of it (REVAMP_CHECKED_CROP_MAX_LOSS).
   */
  const recrop = async (
    p: RevampPlannedShot,
    cause: FallbackCause,
    checked?: CheckedSources,
  ): Promise<Photo | null> => {
    for (const source of fallbackSources(
      p,
      ledger,
      byId,
      checked,
      Boolean(budgeted),
    )) {
      const bytes =
        source.bytes ?? (source.image ? await readBytes(source.image) : null);
      if (!bytes) continue;
      const prepared = await safePrepare(prepare, bytes, p.frame!, p.byteLimit);
      if (!prepared) continue;
      const stored = await storeRevampImage({
        revampId,
        storeId,
        role: "slot",
        slotId: p.shot.id,
        bytes: prepared.bytes,
        mediaType: prepared.mediaType,
        width: prepared.width,
        height: prepared.height,
        review: "flagged",
        problems: [
          REVAMP_RECROP_PROBLEM,
          `${RECROP_SOURCE}${source.id}`,
          `${RECROP_CAUSE}${cause}`,
        ],
        alt: altFor(p.shot),
      });
      return {
        image: stored,
        bytes: stored.sha256 === prepared.sha256 ? prepared.bytes : null,
        recrop: true,
      };
    }
    return null;
  };
  /** The shots whose stored photo is a crop an earlier invocation made. */
  const recroppedShots = async (): Promise<ReadonlySet<string>> => {
    const records = await listRevampImageRecords(revampId, storeId);
    return new Set(
      records
        .filter(
          (record) =>
            record.role === "slot" &&
            record.problems.includes(REVAMP_RECROP_PROBLEM),
        )
        .map((record) => record.slotId),
    );
  };
  try {
    // 6b. The parked photos first: one that passes is a source for a crop.
    await settlePending();
    if (ctx.recoverable && capacityPending) {
      throw new RevampRetryLaterError(
        "photos_unavailable",
        "The photo service is temporarily unavailable; saved photographs will be resumed.",
        REVAMP_WORK_BUDGET.capacityRetryMs,
      );
    }
    // ★ A photo left parked by the drain is the next run's to review: the
    //   step is not done, so nothing is cropped in its place.
    if (drained && (!budgeted || ctx.recoverable))
      throw new RevampDrainedError();

    let checked: CheckedSources | null = null;
    for (const p of usable) {
      if (ledger.photos.has(p.shot.id)) continue;
      ctx.signal.throwIfAborted();
      const entry = unchecked.get(p.shot.id);
      if (entry) {
        // ★★ Owner's decision 2: a crop of a CHECKED photo of the shoot that
        //   fits stands in; when none fits, the photo itself, unchecked, and
        //   the card says so.
        checked ??= { recropped: await recroppedShots() };
        const crop = await recrop(p, "unchecked", checked);
        if (crop) {
          ledger.photos.set(p.shot.id, crop);
          ledger.fallbacks.set(p.shot.id, "unchecked");
          continue;
        }
        if (budgeted) continue;
        logWarn("mink.revamp: a photograph is let in unchecked", {
          revampId,
          shotId: p.shot.id,
        });
        await promote(p, entry, "unreviewed", true);
        if (ledger.photos.has(p.shot.id)) {
          ledger.unchecked.add(p.shot.id);
          continue;
        }
      }
      const cause = ledger.causes.get(p.shot.id) ?? "failed";
      const made = await recrop(
        p,
        cause,
        budgeted
          ? (checked ??= { recropped: await recroppedShots() })
          : undefined,
      );
      if (made) {
        ledger.photos.set(p.shot.id, made);
        ledger.fallbacks.set(p.shot.id, cause);
      }
    }
    const stillMissing = usable.filter((p) => !ledger.photos.has(p.shot.id));
    if (stillMissing.length > 0 && (!budgeted || ctx.recoverable)) {
      const limited = stillMissing.some(
        (p) => ledger.causes.get(p.shot.id) === "limit",
      );
      const detail = `${stillMissing.length} of ${total} photographs could not be drawn or cropped from the shoot.`;
      const exhausted =
        ctx.recoverable &&
        [...checks.values()].reduce(
          (sum, state) => sum + (state.draws ?? 0),
          0,
        ) >= REVAMP_WORK_BUDGET.imageCalls;
      const shotExhausted =
        ctx.recoverable &&
        stillMissing.every((p) => (checks.get(p.shot.id)?.draws ?? 0) >= 3);
      if (exhausted || shotExhausted)
        throw new RevampStepError(
          "photos_failed",
          "The planned photographs exhausted their quality redraw budget.",
        );
      throw limited
        ? limitReached(detail)
        : nothingToCropFrom(detail, stillMissing, ledger);
    }

    if (budgeted) {
      const home = usable.filter((p) => p.onHomepage);
      const ready = home.filter((p) => ledger.photos.has(p.shot.id));
      if (
        home.length &&
        (ready.length < 3 || !ledger.photos.has(home[0].shot.id))
      )
        throw new RevampStepError(
          "photos_failed",
          "Too few checked homepage photographs remain to finish the redesign.",
        );
    }

    // 8. The phone crops still missing: a kept, adopted, reviewed or cropped
    //    photo's, and any a drawn photo could not store as it settled, cut
    //    from the draw behind it when this run holds that.
    for (const p of usable) {
      if (!p.needsPhone || ledger.phones.has(p.shot.id)) continue;
      const wide = ledger.photos.get(p.shot.id);
      if (!wide) continue;
      ctx.signal.throwIfAborted();
      await storePhone(p, wide, drawnBehind(p, wide));
    }
  } catch (error) {
    // Whatever went wrong, photos claimed and never drawn are given back.
    await abandonSettling();
    await release();
    await flushChecks();
    throw error;
  }

  // 9. Give back what was claimed and never drawn.
  await release();
  await reportProgress(ctx, total, total);
  // ★ The record of the checks reaches the job row before the step ends (P0).
  await flushChecks();

  // 10. Everything this revamp now holds, and one outcome per shot.
  const records = await listRevampImageRecords(revampId, storeId);
  return {
    images: records
      .filter(
        (record) => record.role !== "product" && !pendingShotOf(record.slotId),
      )
      .map(stripRecord),
    outcomes: buildOutcomes(planned, ledger, records, checks),
    usage: spent,
  };
}

// ── The plan, as shots ──────────────────────────────────────────────────────

/**
 * Every shot of the plan with its frame, byte limit and image-run slot: the
 * planned shots, the refills inside the merchant's own sections and the
 * category photographs alike, since each is a shot with bindings.
 */
export function planRevampShots(
  plan: RevampSitePlan,
  snapshot?: Pick<RevampSnapshot, "pages"> | null,
): RevampPlannedShot[] {
  const bindings = Array.isArray(plan.bindings) ? plan.bindings : [];
  const byShot = new Map<string, RevampSlotBinding[]>();
  for (const binding of bindings) {
    if (!binding || typeof binding.shotId !== "string") continue;
    byShot.set(binding.shotId, [
      ...(byShot.get(binding.shotId) ?? []),
      binding,
    ]);
  }
  const opening = openingShotId(plan, snapshot);
  const seen = new Set<string>();
  const out: RevampPlannedShot[] = [];
  for (const shot of Array.isArray(plan.shots) ? plan.shots : []) {
    if (
      !shot ||
      typeof shot.id !== "string" ||
      !shot.id.trim() ||
      seen.has(shot.id)
    ) {
      continue;
    }
    seen.add(shot.id);
    const own = byShot.get(shot.id) ?? [];
    const frame = largestFrame(own);
    const byteLimit = frame
      ? slotByteLimit({
          catalogPreview: false,
          width: frame.width,
          height: frame.height,
        })
      : 0;
    const pages = new Set(own.map((b) => b.pageSlug));
    const usage = usageLabel(plan, own, shot.id === opening);
    out.push({
      shot,
      frame,
      byteLimit,
      needsPhone: own.some(
        (b) => Array.isArray(b.phonePath) && b.phonePath.length > 0,
      ),
      pages,
      onHomepage: pages.has(""),
      slot: frame
        ? {
            slotId: shot.id,
            purpose: shotPurpose(shot.purpose),
            brief: {
              id: shot.id,
              purpose: usage,
              subject:
                cleanLine(shot.subject, 600) ||
                cleanLine(shot.artDirection, 600) ||
                usage,
              artDirection: cleanLine(shot.artDirection, 600),
              aspectRatio: shotRatio(shot, frame),
              ...(shot.people === "adults"
                ? { people: "adults" as const }
                : {}),
            },
            target: frame,
            byteLimit,
          }
        : null,
    });
  }
  return out;
}

/**
 * The image direction for the whole shoot, from the plan: its industry, its
 * design direction, its summary, and the palette the design sets (the
 * theme's own colour where the design inherits it).
 */
export function revampImageDirection(
  plan: RevampSitePlan,
  snapshot: RevampSnapshot,
): ThemeImageDirection {
  const known = knownDirection(plan.direction);
  const palette = plan.design?.palette ?? {};
  const mood = known
    ? DESIGN_DIRECTIONS[known].label
    : cleanLine(plan.direction ?? "", 60);
  return {
    themeName: snapshot.storeName,
    summary: cleanLine(plan.summary ?? "", 400),
    industries: plan.industry ? [plan.industry] : [],
    moodKeywords: mood ? [mood] : [],
    paletteDirection: "",
    density: (known && DIRECTION_DENSITY[known]) || "balanced",
    shape: shapeOf(plan.design?.shape?.card),
    palette: {
      page: palette.cream ?? snapshot.theme.palette.page,
      surface: palette.surface ?? snapshot.theme.palette.surface,
      ink: palette.ink ?? snapshot.theme.palette.ink,
      accent: palette.accent ?? snapshot.theme.palette.accent,
    },
  };
}

/**
 * What the anchor takes its look from: the homepage's opening photograph,
 * else the first hero shot. ★ The anchor sets the light and grade of every
 * picture, so it follows the photograph shoppers see first.
 */
export function revampAnchorLead(
  plan: RevampSitePlan,
  snapshot?: Pick<RevampSnapshot, "pages"> | null,
): AnchorLead | null {
  const shot = anchorLeadShot(plan, snapshot);
  const subject = cleanLine(shot?.subject ?? "", 600);
  return shot && subject
    ? { subject, artDirection: cleanLine(shot.artDirection ?? "", 600) }
    : null;
}

/** The shot the anchor follows: the opening photograph, else a hero. */
function anchorLeadShot(
  plan: RevampSitePlan,
  snapshot?: Pick<RevampSnapshot, "pages"> | null,
): RevampShot | undefined {
  const shots = (Array.isArray(plan.shots) ? plan.shots : []).filter(
    (s): s is RevampShot => Boolean(s && typeof s.id === "string"),
  );
  const bound = new Set(
    (Array.isArray(plan.bindings) ? plan.bindings : []).map((b) => b?.shotId),
  );
  const opening = openingShotId(plan, snapshot);
  // A hero nothing shows is a weaker lead than one a page uses.
  return (
    (opening ? shots.find((s) => s.id === opening) : undefined) ??
    shots.find((s) => s.purpose === "hero" && bound.has(s.id)) ??
    shots.find((s) => s.purpose === "hero")
  );
}

/**
 * ★★ The anchor's lead with no goods (B16): the look of the shot it follows,
 * and a still life with no product in it. The anchor carries no product
 * photo, so any product it showed would be invented, and every other picture
 * is matched to it: a lead shot of the merchant's goods, whose words name
 * them, is followed for its art direction only, its subject the store's own
 * setting (`revampShotSubjectFor`). With no shot to follow, the anchor is the
 * store's own still life, as before.
 */
export function noGoodsAnchorLead(
  plan: RevampSitePlan,
  snapshot: Pick<RevampSnapshot, "pages" | "storeName">,
  request?: Pick<RevampRequest, "brief">,
): AnchorLead {
  const shot = anchorLeadShot(plan, snapshot);
  if (shot && revampShotGoods(shot).goods === "merchant") {
    return {
      subject: revampShotSubjectFor({
        storeName: snapshot.storeName,
        business: businessLine(request),
        names: [],
      }),
      artDirection: cleanLine(shot.artDirection ?? "", 600),
      goods: "none",
    };
  }
  const lead = revampAnchorLead(plan, snapshot);
  return {
    subject: lead?.subject ?? "",
    artDirection: lead?.artDirection ?? "",
    goods: "none",
  };
}

/** What the store sells, in the merchant's words: "" when the request has none. */
function businessLine(
  request: Pick<RevampRequest, "brief"> | undefined,
): string {
  const business = (
    request?.brief as Partial<RevampRequest["brief"]> | undefined
  )?.business;
  return typeof business === "string" ? business : "";
}

/** The longest side a product's own photograph is sent at (B16). */
const GOODS_REFERENCE_EDGE = 1536;

/**
 * `revampGoodsCatalogue` reads only the request's products: with no request,
 * only the store's own products ("shop:<slug>") can be found.
 */
const NO_REQUEST_PRODUCTS = { products: [] } as unknown as RevampRequest;

/**
 * ★★ WHAT EACH SHOT SHOWS (B16): the merchant's own products, each with its
 * OWN photograph, or no products at all.
 * ★ A product is found by its goods key through `revampGoodsCatalogue`, the
 *   rule the compiler validated the key with: only this store's products,
 *   only a photo the store owns, never one under another store's prefix.
 * ★ Its photograph is read from THIS store's own objects only
 *   (`readStoreOwnedImageBytes`, which refuses any other path unread), so a
 *   reference can never come from another store, and re-encoded as a WebP of
 *   at most GOODS_REFERENCE_EDGE a side.
 * ★★ A shot whose product photos cannot be read, or found, shows NO
 *   products: never invented goods. Logged without names, keys or URLs.
 *   `lost` says it shows fewer products than it named, so the caller writes
 *   its words again.
 */
export async function resolveShotGoods(input: {
  revampId: string;
  storeId: string;
  shots: readonly RevampShot[];
  request: RevampRequest | undefined;
  snapshot: RevampSnapshot;
}): Promise<Map<string, { goods: ThemeImageGoods; lost: boolean }>> {
  const out = new Map<string, { goods: ThemeImageGoods; lost: boolean }>();
  let catalogue: Map<string, RevampGoodsItem> | null = null;
  const lookup = (key: string): RevampGoodsItem | null => {
    catalogue ??= (() => {
      try {
        return revampGoodsCatalogue({
          request: input.request ?? NO_REQUEST_PRODUCTS,
          snapshot: input.snapshot,
        });
      } catch (error) {
        logWarn("mink.revamp: the shoot's product list could not be read", {
          revampId: input.revampId,
          error: error instanceof Error ? error.message : String(error),
        });
        return new Map<string, RevampGoodsItem>();
      }
    })();
    return catalogue.get(key) ?? null;
  };
  const photos = new Map<
    string,
    Promise<ThemeImageGoodsProduct["reference"] | null>
  >();
  const photoOf = (url: string) => {
    let read = photos.get(url);
    if (!read) {
      read = readStoreOwnedImageBytes(url, input.storeId)
        .then((bytes) => (bytes ? goodsReference(bytes) : null))
        .catch(() => null);
      photos.set(url, read);
    }
    return read;
  };
  for (const shot of input.shots) {
    const wanted = revampShotGoods(shot);
    if (wanted.goods === "none") {
      out.set(shot.id, { goods: { kind: "none" }, lost: false });
      continue;
    }
    const products: ThemeImageGoodsProduct[] = [];
    const shown = new Set<string>();
    for (const key of wanted.productKeys) {
      const item = lookup(key);
      if (!item || shown.has(item.photoUrl)) continue;
      const reference = await photoOf(item.photoUrl);
      if (!reference) continue;
      shown.add(item.photoUrl);
      products.push({ name: item.name, reference });
    }
    const lost = products.length < wanted.productKeys.length;
    out.set(shot.id, {
      goods:
        products.length > 0 ? { kind: "merchant", products } : { kind: "none" },
      lost,
    });
    if (lost) {
      logInfo("mink.revamp: a shot's product photo could not be read", {
        revampId: input.revampId,
        shotId: shot.id,
        asked: wanted.productKeys.length,
        read: products.length,
      });
    }
  }
  return out;
}

/** A product's own photograph as the image model and the check see it. */
async function goodsReference(
  bytes: Uint8Array,
): Promise<ThemeImageGoodsProduct["reference"] | null> {
  const opened = await openUntrustedImage(bytes, MEASURE_MAX_BYTES).catch(
    () => null,
  );
  if (!opened?.ok) return null;
  try {
    const data = await opened.source
      .rotate()
      .resize(GOODS_REFERENCE_EDGE, GOODS_REFERENCE_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer();
    return { mediaType: "image/webp", base64: data.toString("base64") };
  } catch {
    return null;
  }
}

/**
 * The shot bound to the first enabled section of the homepage that has one.
 * ★ The plan's homepage when the revamp writes it; otherwise the store's
 *   own (the snapshot's), whose theme photos a revamp still refills, so the
 *   opening photograph of a kept homepage still leads the shoot.
 */
function openingShotId(
  plan: RevampSitePlan,
  snapshot?: Pick<RevampSnapshot, "pages"> | null,
): string | null {
  const bindings = (Array.isArray(plan.bindings) ? plan.bindings : []).filter(
    Boolean,
  );
  const storePages = snapshot?.pages;
  const home =
    (Array.isArray(plan.pages) ? plan.pages : []).find(
      (page) => page?.slug === "",
    ) ??
    (Array.isArray(storePages) ? storePages : []).find(
      (page) => page?.slug === "",
    );
  for (const section of home?.sections ?? []) {
    if (!section || section.enabled === false) continue;
    const binding = bindings.find(
      (b) => b.pageSlug === "" && b.sectionId === section.id,
    );
    if (binding) return binding.shotId;
  }
  return null;
}

function largestFrame(bindings: readonly RevampSlotBinding[]): Frame | null {
  let best: Frame | null = null;
  for (const binding of bindings) {
    const width = Math.round(Number(binding.frame?.width));
    const height = Math.round(Number(binding.frame?.height));
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    if (width < 1 || height < 1) continue;
    if (!best || width * height > best.width * best.height) {
      best = { width, height, aspect: width / height };
    }
  }
  return best;
}

/**
 * The ratio a shot is drawn at: its own when it is one the image model takes
 * and matches its frame, else the accepted ratio nearest the frame. ★ The
 * frame is what the photo must end at, so a ratio the crop would cut through
 * is never asked for.
 */
function shotRatio(shot: RevampShot, frame: Frame): ThemeImageAspectRatio {
  const own = shot.aspectRatio as ThemeImageAspectRatio;
  if (
    (THEME_IMAGE_ASPECT_RATIOS as readonly string[]).includes(own) &&
    Math.abs(aspectValue(own) / frame.aspect - 1) <= SHAPE_TOLERANCE
  ) {
    return own;
  }
  return nearestImageRatio(frame.aspect);
}

function shotPurpose(purpose: string): RevampShotPurpose {
  return (REVAMP_SHOT_PURPOSES as readonly string[]).includes(purpose)
    ? (purpose as RevampShotPurpose)
    : "content";
}

/** Where the photo goes, in a few words, for the image brief. */
function usageLabel(
  plan: RevampSitePlan,
  bindings: readonly RevampSlotBinding[],
  opening: boolean,
): string {
  if (opening) {
    return "the opening photograph of the homepage, filling the band behind the headline";
  }
  const binding = bindings[0];
  if (!binding) return "a photograph for this store";
  if (binding.pageSlug === "@category") {
    return `the photograph for the ${cleanLine(binding.sectionId, 60)} category`;
  }
  const page = (Array.isArray(plan.pages) ? plan.pages : []).find(
    (candidate) => candidate.slug === binding.pageSlug,
  );
  const section = page?.sections.find((s) => s.id === binding.sectionId);
  // A section type outside the registry reads as no type, never as a crash.
  const meta: { label: string } | undefined = section
    ? SECTION_TYPE_META[section.type]
    : undefined;
  const label = meta?.label;
  const where =
    binding.pageSlug === ""
      ? "the homepage"
      : `the ${cleanLine(page?.title || binding.pageSlug, 60)} page`;
  return `${label ? `the ${label.toLowerCase()} section` : "a section"} on ${where}`;
}

function knownDirection(value: unknown): DesignDirection | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (Object.hasOwn(DESIGN_DIRECTIONS, key)) return key as DesignDirection;
  return (
    (Object.keys(DESIGN_DIRECTIONS) as DesignDirection[]).find(
      (id) => DESIGN_DIRECTIONS[id].label.toLowerCase() === key,
    ) ?? null
  );
}

function shapeOf(card: unknown): ThemeImageDirection["shape"] {
  if (typeof card !== "number" || !Number.isFinite(card)) return "mixed";
  if (card <= 2) return "square";
  if (card >= 12) return "soft";
  return "mixed";
}

// ── Clients ─────────────────────────────────────────────────────────────────

/**
 * The image client: Vertex with the shared provider capacity, or the fake.
 * `draining` is the shoot's drain (jobs-4; D2, `revampAdmissionDrain`, 95 s
 * before the runner's): the Vertex client then sends no attempt that gets its
 * permit, or its 429 retry, after it began.
 * ★★ Owner, 25 Oct 2026: Nano Banana 2.1 (image-models.ts) draws a
 * redesign's photos at "2K" with MEDIUM thinking.
 */
function defaultImageClient(
  provider: RevampProvider,
  draining?: AbortSignal,
): ThemeStudioImageClient {
  // ★ The model's own output sizes offline: the phone crop is cut from the
  //   stored wide photo, and Theme Studio's 2048px fake made every offline
  //   hero too small for one (702px against the 800px floor).
  if (provider === "fake") return createFakeImageClient({ size: "model" });
  // ★ An image model StoreMink did not set up is its own fault, not a busy
  //   photo service (`anchorFailureError`): `internal`, for good.
  let config;
  try {
    config = getThemeStudioImageConfig();
  } catch (error) {
    throw new RevampStepError(
      "internal",
      `The image model is misconfigured: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
  if (!config) {
    throw new RevampStepError(
      "internal",
      "No image model is configured (GCP_PROJECT_ID).",
      false,
    );
  }
  return createVertexImageClient(config, {
    imageSize: "2K",
    thinkingLevel: ThinkingLevel.MEDIUM,
    // ★★ A draw the run's stop cuts off on the wire says so (D3).
    markStoppedInFlight: true,
    capacity: revampDrainingCapacity(
      sharedProviderCapacity(
        config.projectId,
        config.location,
        config.providerModel,
      ),
      draining,
    ),
    ...revampDrainingSleep(draining),
  });
}

/**
 * The reviewer, as the Theme Studio worker picks it: the offline reviewer
 * with the fake provider, the fast Studio text model on Vertex, and none when
 * an operator has switched that model off (the images are then kept
 * unreviewed; the review is a quality check, not the safety boundary).
 * `draining` holds back a review attempt the same way the image client does;
 * `onRetry` hears of each 429 the client waits out and tries again (P0).
 * ★★ Each check goes to Google's US endpoint first and to global when the US
 *   refuses or times out (owner's decision, 23 Oct 2026; gemini-vertex.ts,
 *   `capacityAt`), each try on its location's shared row and on the
 *   redesigns' 75 s clock. The drain wraps BOTH locations' capacity, so a
 *   check waiting for its turn at either stops waiting when it begins.
 */
function defaultReviewer(
  provider: RevampProvider,
  draining?: AbortSignal,
  onRetry?: () => void,
): ThemeImageReviewer | null {
  if (provider === "fake") {
    return { client: createFakeImageReviewClient(), providerModel: "fake" };
  }
  try {
    if (
      getThemeStudioConfig().disabledModels.has(THEME_IMAGE_REVIEW_MODEL_KEY)
    ) {
      return null;
    }
    const vertex = getVertexConfig();
    if (!vertex) return null;
    return {
      client: createVertexModelClient(vertex, {
        capacityAt: (model, location) =>
          revampDrainingCapacity(
            sharedProviderCapacity(vertex.projectId, location, model),
            draining,
          ),
        imageReviewTryTimeoutMs: IMAGE_REVIEW_TRY_TIMEOUT_MS,
        ...revampDrainingSleep(draining),
        ...(onRetry ? { onRetry } : {}),
      }),
      providerModel: resolveThemeStudioModel(THEME_IMAGE_REVIEW_MODEL_KEY)
        .providerModel,
    };
  } catch (error) {
    logWarn("mink.revamp: image reviewer unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The shared provider capacity, refusing to SEND an attempt that gets its
 * turn after the runner's deadline began to drain the step (jobs-4).
 *
 * ★★ A call the engine started before the deadline is not necessarily on the
 *   wire: the image and review clients wait for a permit of the capacity
 *   other stores share, and wait out a 429 before trying again, all inside
 *   one call. Sending it after the deadline is a new paid call that the hard
 *   stop may cut off, billed and lost, so it is refused at the permit. ★ The
 *   refusal is an abort, which both clients report as "cancelled": nothing
 *   was drawn, its photo goes back with the claim, and the next run draws it.
 *   An attempt already sent is untouched and finishes.
 * ★★ AND A WAIT THE DRAIN ENDS IS NEVER ADMITTED (the capacity's
 *   `admission`): admitted at the drain only to be refused, a photo still
 *   stamped the paced key's next start, so Theme Studio's photos and other
 *   redesigns on the model lost a start, up to a gap each, with no call
 *   made, and the step's hand-over waited for that admission. The check at
 *   the permit stays for a claim already on its way back at the drain.
 */
export function revampDrainingCapacity(
  capacity: ProviderCapacity,
  draining: AbortSignal | undefined,
): ProviderCapacity {
  if (!draining) return capacity;
  return {
    run: async (operation, signal, options) => {
      let started = false;
      try {
        return await capacity.run(
          async (permit) => {
            if (draining.aborted) throw notSentAtDeadline();
            started = true;
            return operation(permit);
          },
          signal,
          {
            admission: options?.admission
              ? AbortSignal.any([options.admission, draining])
              : draining,
          },
        );
      } catch (error) {
        // ★ The drain's own reason (the runner's halt) is no abort to the
        //   clients, which would read it as an outage that may have billed:
        //   a wait it ended is the same refusal as one at the permit.
        if (!started && draining.aborted && !signal.aborted) {
          throw notSentAtDeadline();
        }
        throw error;
      }
    },
  };
}

function notSentAtDeadline(): Error {
  const error = new Error(
    "Not sent: the redesign stopped starting paid calls at its deadline.",
  );
  // ★ The name both Vertex clients read as their own abort ("cancelled"),
  //   never as an outage that may have billed ("provider_unavailable").
  error.name = "AbortError";
  return error;
}

/**
 * ★★ THE DRAIN FOR A GOOGLE CALL WITH THIS PER-TRY CLOCK (D2). A call is
 *   admitted only while its whole clock and `REVAMP_LIMITS.hardStopMarginMs`
 *   fit before the runner's hard stop (`ctx.deadline` plus `deadlineGraceMs`),
 *   so the hard stop never cuts off a call Google may already have drawn and
 *   billed. A 75 s clock (a photo check, a studio photo) fits after the
 *   drain, so the drain itself is the answer; a shoot photo's 180 s clock
 *   (IMAGE_REQUEST_TIMEOUT_MS) is longer than the 90 s grace, so its draws
 *   stop being admitted 95 s before the drain. A call this drain refuses is
 *   refused exactly as at the drain (never sent, nothing billed, the step
 *   hands over). Absent with no drain: a step run on its own never drains.
 *   ★ Its timer is unref'd and cleared by the drain.
 */
export function revampAdmissionDrain(
  ctx: Pick<RevampStepContext, "deadline" | "draining" | "finishBy">,
  clockMs: number,
): AbortSignal | undefined {
  const draining = ctx.draining;
  if (!draining) return undefined;
  if (draining.aborted) return draining;
  const closesAt = ctx.finishBy
    ? revampPaidAdmissionEndsAt(ctx.finishBy, clockMs)
    : ctx.deadline +
      REVAMP_LIMITS.deadlineGraceMs -
      clockMs -
      REVAMP_LIMITS.hardStopMarginMs;
  if (closesAt >= ctx.deadline) return draining;
  const closed = new AbortController();
  const reason = new Error(
    "Not admitted: the call could still be on the wire at the redesign's hard stop.",
  );
  const left = closesAt - Date.now();
  if (left <= 0) {
    closed.abort(reason);
  } else {
    const timer = setTimeout(() => closed.abort(reason), left);
    timer.unref?.();
    draining.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
  }
  return AbortSignal.any([draining, closed.signal]);
}

/**
 * The clients' 429 wait, ending when the drain begins as well as when the run
 * stops: the retry after it would not be sent (`revampDrainingCapacity`), so
 * waiting it out would only hold back the hand-over. ★ Shared with the
 * product photos' check (products.ts), which waits the same way.
 */
export function revampDrainingSleep(draining: AbortSignal | undefined): {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
} {
  if (!draining) return {};
  return {
    sleep: (ms, signal) =>
      sleepUnlessAborted(
        ms,
        signal ? AbortSignal.any([signal, draining]) : draining,
      ),
  };
}

// ── The run's bookkeeping ───────────────────────────────────────────────────

interface Ledger {
  photos: Map<string, Photo>;
  phones: Map<string, RevampStoredImage>;
  adopted: Set<string>;
  settled: Map<string, SlotOutcome>;
  causes: Map<string, FallbackCause>;
  fallbacks: Map<string, FallbackCause>;
  /** Shots shown their own photo unchecked: its check could not be had in time. */
  unchecked: Set<string>;
  /** Shots whose photo was kept smaller than its frame (B14). */
  small: Set<string>;
  /**
   * Shots whose parked photo a check blocked: it is never drawn again (it
   * was paid for), so no later invocation gives the shot a photo of its own.
   */
  blocked: Set<string>;
  /** This invocation drew the anchor (its photo allowance was used). */
  anchorDrawn: boolean;
  /**
   * Briefs (shot ids, "anchor") a draw of which the run's own stop cut off on
   * the wire (`stoppedInFlight`, D3): it may have been billed.
   */
  cutOff: Set<string>;
}

function emptyLedger(): Ledger {
  return {
    photos: new Map(),
    phones: new Map(),
    adopted: new Set(),
    settled: new Map(),
    causes: new Map(),
    fallbacks: new Map(),
    unchecked: new Set(),
    small: new Set(),
    blocked: new Set(),
    anchorDrawn: false,
    cutOff: new Set(),
  };
}

/**
 * Failures that provably made no picture: a provider that turned the request
 * away for its rate before drawing, and the run's own stop before the request
 * left. ★★ A stop that cut a draw off on the wire is not one (B3, D3): it may
 *   have been billed (`stoppedInFlight`).
 */
const NOT_DRAWN_CODES: ReadonlySet<string> = new Set([
  "cancelled",
  "rate_limited",
]);

/**
 * ★★ A draw the run's own stop cut off on the wire (D3, robustness audit
 *   B3): sent, never refused with 429, unanswered when the run stopped
 *   (image-vertex.ts `markStoppedInFlight`). Google may have drawn and billed
 *   it, so it is counted as a call and its photo stays spent, as products.ts
 *   counts the same case. The merchant is never charged for it: the card
 *   charges only photographs a page shows (assemble.ts). ⚠ Only while the
 *   stopping run still owns the job (the merchant's Stop, the hard stop, the
 *   lease watchdog) and its clear of the claim lands: after a lost lease, a
 *   crash or a clear that fails, the next run settles the claim from the
 *   stored photos (photo-hold.ts), so a cut-off draw, which stored none, is
 *   given back, and after a lost lease or a crash its usage is not recorded.
 */
function stoppedInFlight(answer: ThemeImageResult): boolean {
  return (
    answer.kind === "error" &&
    answer.code === "cancelled" &&
    answer.timing?.stoppedInFlight === true
  );
}

/**
 * Whether a slot outcome came from a picture the provider may have made, so
 * its photo stays counted against the limits. A refusal draws nothing; a
 * stop draws nothing unless it cut a draw off on the wire (`ledger.cutOff`).
 */
function wasDrawn(outcome: SlotOutcome, ledger: Ledger): boolean {
  switch (outcome.status) {
    case "generated":
    case "rejected":
    case "unusable":
      return true;
    case "failed":
      return (
        !NOT_DRAWN_CODES.has(outcome.code) || ledger.cutOff.has(outcome.slotId)
      );
    case "refused":
    case "skipped":
      return false;
  }
}

/** A slot the run stopped before it drew anything (the drain, a stop). */
function notStarted(outcome: SlotOutcome): boolean {
  return (
    outcome.status === "skipped" ||
    (outcome.status === "failed" && outcome.code === "cancelled")
  );
}

function anchorWasDrawn(
  ledger: Ledger,
  result: ThemeImageRunResult | null,
): boolean {
  // ★ An anchor the run's stop cut off on the wire may have been billed (D3).
  if (ledger.anchorDrawn || ledger.cutOff.has(ANCHOR_SLOT)) return true;
  const failure = result?.anchorFailure;
  if (!failure) return false;
  if (failure.kind === "rejected") return true;
  return failure.kind === "failed" && !NOT_DRAWN_CODES.has(failure.code);
}

function causeOf(outcome: SlotOutcome): FallbackCause {
  switch (outcome.status) {
    case "refused":
      return "refused";
    case "rejected":
      return "rejected";
    default:
      return "failed";
  }
}

/**
 * The shoot's anchor did not come back, so no photograph can be drawn.
 * ★★ Each permanent case carries the closed code whose sentence is true for
 *   it. All of them used to be `photos_unavailable`, whose card sentence
 *   says the photo service was too busy and to try again in a few minutes,
 *   which nothing here was and no wait fixes:
 *   - refused after every redraw: `model_refused`, the design model's own
 *     refusal ("try describing the store a little differently");
 *   - turned down by its check after every redraw: `photos_failed`;
 *   - failed for anything but an outage (a request the model turned down,
 *     its credentials, a picture that could not be read): `internal`.
 *   Only an outage (TRANSIENT_ANCHOR_CODES) stays `photos_unavailable`, a
 *   wait like any other on the photo service.
 */
function anchorFailureError(
  failure: NonNullable<ThemeImageRunResult["anchorFailure"]>,
): RevampStepError {
  switch (failure.kind) {
    case "refused":
      return new RevampStepError(
        "model_refused",
        `The image model declined the shoot's anchor photograph${failure.reason ? ` (${failure.reason})` : ""}.`,
        false,
      );
    case "rejected":
      return new RevampStepError(
        "photos_failed",
        `The shoot's anchor photograph failed its review after every redraw (${failure.problems.join(", ") || "no detail"}).`,
        false,
      );
    case "failed": {
      const detail = `The shoot's anchor photograph could not be drawn (${failure.code}).`;
      return TRANSIENT_ANCHOR_CODES.has(failure.code)
        ? new RevampStepError("photos_unavailable", detail, true)
        : new RevampStepError("internal", detail, false);
    }
  }
}

/**
 * The store's own daily photo allowance refused the shoot. ★ Not transient:
 * a retry inside the runner's backoff would only be refused again, and the
 * card's sentence (the store made as many photographs today as it may) is
 * then true. The platform's hour is never reported this way
 * (`waitOutPlatformCeiling`).
 */
function limitReached(detail: string): RevampStepError {
  return new RevampStepError("limit_reached", detail, false);
}

/**
 * Shots left with no photograph and no photo of the shoot to crop one from.
 * ★ Transient while any of them can be drawn again by a later invocation (a
 *   refusal, a failed draw, a picture its checks turned down):
 *   `photos_unavailable`, a wait like any other on the photo service.
 * ★★ Not when every one is a parked photo a check blocked: those are never
 *   drawn again, so a later invocation would only find the same nothing
 *   until the job's ceiling, hours later. It used to be the anchor's crop
 *   that stood in, which no page may show (B16, the header). That ends the
 *   job as `photos_failed`, whose sentence says the photographs did not pass
 *   their checks: under `photos_unavailable` the card blamed a busy photo
 *   service and asked the merchant to wait, which was neither true nor any
 *   help.
 */
function nothingToCropFrom(
  detail: string,
  missing: readonly RevampPlannedShot[],
  ledger: Ledger,
): RevampStepError {
  const drawable = missing.some((p) => !ledger.blocked.has(p.shot.id));
  return drawable
    ? new RevampStepError("photos_unavailable", detail, true)
    : new RevampStepError("photos_failed", detail, false);
}

/**
 * How long a shoot the platform's hourly photo ceiling refused waits before
 * its next claim. ★ That ceiling is one fixed hour shared by every store,
 * begun at most an hour before the refusal, so claims 20 minutes apart meet
 * a fresh window within the job's remaining attempts.
 */
export const REVAMP_PHOTO_SERVICE_RETRY_MS = 20 * 60_000;

/**
 * ★★ A refusal by the platform's hour, not the store's day (jobs-2): the
 *   store may have drawn nothing today, and the same job succeeds once the
 *   hour turns. So the step is parked for a later claim (transient, with its
 *   own wait); failing it would show the store-day sentence, which is false,
 *   and throw away the plan the model was already paid for.
 */
function waitOutPlatformCeiling(refusedKey: string): void {
  if (refusedKey !== REVAMP_PLATFORM_PHOTO_LIMIT_KEY) return;
  throw new RevampRetryLaterError(
    "photos_unavailable",
    "The platform's hourly photo ceiling refused the shoot; waiting for the hour to turn.",
    REVAMP_PHOTO_SERVICE_RETRY_MS,
  );
}

async function claimPhotos(storeId: string, cost: number) {
  try {
    return await claimRevampPhotos(storeId, cost);
  } catch (error) {
    throw new RevampStepError(
      "internal",
      `The photo limits could not be checked: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

/** What a crop for a photo that could not be checked may be cut from. */
interface CheckedSources {
  /** Shots whose stored photo is a crop an earlier invocation made. */
  recropped: ReadonlySet<string>;
}

/**
 * The pictures a missing shot may be cropped from, best first: the kept
 * photos of the shoot, the ones shown on another page when there are any
 * (the same picture twice on one page reads as a mistake), the least cut
 * first. ★★ Never the anchor (B16): a hidden reference whose check never
 *   looked for goods, or for lettering and odd shapes a page may not show
 *   (image-review.ts ANCHOR_BLOCKING_PROBLEMS), while a kept photo was drawn
 *   under its own goods rule and checked as a page photo (unless that check
 *   could not be had, owner's decision 2). It used to lead whenever its crop
 *   was about as good, so a failed shot could show the anchor's invented
 *   bottles. ★★ With `checked` (owner's decision 2) only a CHECKED photo, and
 *   only one whose crop keeps enough of it.
 */
function fallbackSources(
  p: RevampPlannedShot,
  ledger: Ledger,
  byId: ReadonlyMap<string, RevampPlannedShot>,
  checked?: CheckedSources,
  strict = false,
): Source[] {
  if (strict && p.pages.has("@category")) return [];
  const loss = (source: Source) =>
    cropLoss(source.width / source.height, p.frame!.aspect);
  const kept: Source[] = [];
  for (const [shotId, photo] of ledger.photos) {
    if (photo.recrop || shotId === p.shot.id) continue;
    if (strict) {
      const other = byId.get(shotId);
      if (
        !other ||
        other.pages.has("@category") ||
        other.shot.goods !== p.shot.goods ||
        JSON.stringify([...(other.shot.productKeys ?? [])].sort()) !==
          JSON.stringify([...(p.shot.productKeys ?? [])].sort())
      )
        continue;
    }
    if (checked && !wasChecked(shotId, photo, ledger, checked.recropped)) {
      continue;
    }
    const source: Source = {
      id: shotId,
      width: photo.image.width,
      height: photo.image.height,
      bytes: photo.bytes,
      image: photo.image,
      pages: byId.get(shotId)?.pages ?? new Set<string>(),
    };
    if (checked && loss(source) > REVAMP_CHECKED_CROP_MAX_LOSS) continue;
    kept.push(source);
  }
  const elsewhere = kept.filter(
    (source) => ![...source.pages].some((page) => p.pages.has(page)),
  );
  const pool = strict ? elsewhere : elsewhere.length ? elsewhere : kept;
  return pool
    .map((source, index) => ({ source, index, loss: loss(source) }))
    .sort((a, b) => {
      if (Math.abs(a.loss - b.loss) > LOSS_TIE) return a.loss - b.loss;
      return a.index - b.index;
    })
    .map((entry) => entry.source);
}

/**
 * A kept photo that was CHECKED (owner's decision 2): passed by its review,
 * or flagged with minor problems only, and never a crop of another (a crop is
 * stored flagged too). ★ One carried over from a refinement's parent counts
 * only when it passed, since this revamp cannot see the parent's own record
 * of which of its photos were crops.
 */
function wasChecked(
  shotId: string,
  photo: Photo,
  ledger: Ledger,
  recropped: ReadonlySet<string>,
): boolean {
  if (photo.recrop || recropped.has(shotId)) return false;
  if (photo.image.review === "passed") return true;
  return photo.image.review === "flagged" && !ledger.adopted.has(shotId);
}

/** The share of a picture a centred crop to `target` throws away. */
function cropLoss(source: number, target: number): number {
  if (!(source > 0) || !(target > 0)) return 1;
  return source > target ? 1 - target / source : 1 - source / target;
}

function fitsFrame(image: RevampStoredImage, frame: Frame): boolean {
  if (!(image.width > 0) || !(image.height > 0)) return false;
  return (
    Math.abs(image.width / image.height / frame.aspect - 1) <= SHAPE_TOLERANCE
  );
}

async function safePrepare(
  prepare: typeof prepareSlotImage,
  bytes: Uint8Array,
  frame: Frame,
  byteLimit: number,
): Promise<PreparedSlotImage | null> {
  try {
    const prepared = await prepare(bytes, frame, byteLimit);
    if (prepared.ok) return prepared.value;
    logWarn("mink.revamp: a photograph could not be cropped", {
      code: prepared.code,
    });
    return null;
  } catch (error) {
    logWarn("mink.revamp: a photograph could not be cropped", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function measureImage(
  bytes: Uint8Array,
): Promise<{ width: number; height: number } | null> {
  try {
    const opened = await openUntrustedImage(bytes, MEASURE_MAX_BYTES);
    return opened.ok ? { width: opened.width, height: opened.height } : null;
  } catch {
    return null;
  }
}

/**
 * How wide the largest centred phone (4:5) cut of a picture is, the rule
 * `prepareSlotImage` crops by: under SLOT_IMAGE_MIN_WIDTH it refuses.
 */
function phoneCropWidth(size: { width: number; height: number }): number {
  return size.width / size.height > REVAMP_PHONE_FRAME.aspect
    ? Math.floor(size.height * REVAMP_PHONE_FRAME.aspect)
    : size.width;
}

function buildOutcomes(
  planned: readonly RevampPlannedShot[],
  ledger: Ledger,
  records: readonly RevampImageRecord[],
  checks: ReadonlyMap<string, RevampPhotoReviewState>,
): RevampPhotoOutcome[] {
  const stored = new Map(
    records
      .filter((record) => record.role === "slot")
      .map((record) => [record.slotId, record]),
  );
  return planned.map((p): RevampPhotoOutcome => {
    const shotId = p.shot.id;
    if (!p.frame) {
      return { shotId, status: "skipped", reason: UNUSED_SHOT_REASON };
    }
    const check = checks.get(shotId);
    // ★ Why its photograph was drawn again, attempt by attempt (P0).
    const outcome = (
      status: RevampPhotoOutcome["status"],
      reason: string | null,
    ): RevampPhotoOutcome =>
      check?.redraws?.length
        ? { shotId, status, reason, redraws: check.redraws }
        : { shotId, status, reason };
    const fallback = ledger.fallbacks.get(shotId);
    if (fallback) return outcome("failed", RECROP_REASONS[fallback]);
    if (ledger.unchecked.has(shotId)) {
      return outcome("failed", REVAMP_UNCHECKED_PHOTO_REASON);
    }
    // ★★ Kept smaller than its frame (B14): listed, so never charged.
    if (ledger.small.has(shotId)) {
      return outcome("failed", REVAMP_SMALL_PHOTO_REASON);
    }
    if (ledger.settled.get(shotId)?.status === "generated") {
      return outcome("generated", null);
    }
    if (ledger.adopted.has(shotId)) {
      return { shotId, status: "skipped", reason: null };
    }
    // Stored by an earlier attempt of this revamp: a fallback says so, and
    // so does a photo it let in unchecked: its own row's marker, or, for a
    // row stored before the marker, its record saying the check expired.
    const row = stored.get(shotId);
    const cause = recropCause(row?.problems ?? []);
    if (cause) return outcome("failed", RECROP_REASONS[cause]);
    if (
      row?.problems.includes(REVAMP_UNCHECKED_PROBLEM) ||
      (row?.review === "unreviewed" &&
        check?.verdict === "expired" &&
        check.sha256 === row.sha256)
    ) {
      return outcome("failed", REVAMP_UNCHECKED_PHOTO_REASON);
    }
    if (row?.problems.includes(REVAMP_SMALL_PROBLEM)) {
      return outcome("failed", REVAMP_SMALL_PHOTO_REASON);
    }
    return outcome("generated", null);
  });
}

function recropCause(problems: readonly string[]): FallbackCause | null {
  if (!problems.includes(REVAMP_RECROP_PROBLEM)) return null;
  const cause = problems
    .find((problem) => problem.startsWith(RECROP_CAUSE))
    ?.slice(RECROP_CAUSE.length);
  return cause && FALLBACK_CAUSES.has(cause)
    ? (cause as FallbackCause)
    : "failed";
}

/**
 * What one draw cost, or null when it cost nothing (L2-F). ★ The rule the
 * photo allowance already uses (`wasDrawn`): a call never sent (no provider
 * attempt), a 429 that outlasted its retries (refused before the model ran)
 * and a call cancelled before its request left are not counted; every other
 * answer is a paid or possibly paid image, a refusal, an outage and a draw
 * the run's stop cut off on the wire (D3) included, priced from the usage it
 * returned (none for a cut-off one, as for a timeout), at the rates of the
 * model that drew it, its thinking included (Nano Banana 2.1 bills it,
 * 25 Oct 2026; cost.ts). ⚠ So the job's estimated cost leaves out what an
 *   unanswered draw may have been billed; products.ts prices every draw,
 *   answered or not, at its flat estimate
 *   (PRODUCT_PHOTO_ESTIMATED_COST_MICRO_USD).
 */
function drawCallUsage(answer: ThemeImageResult): RevampUsage | null {
  if (answer.timing?.providerAttempts === 0) return null;
  if (
    answer.kind === "error" &&
    NOT_DRAWN_CODES.has(answer.code) &&
    !stoppedInFlight(answer)
  ) {
    return null;
  }
  return {
    inputTokens: answer.usage.inputTokens,
    outputTokens: answer.usage.outputTokens,
    thinkingTokens: imageThinkingTokens(answer.usage),
    images: 1,
    reviews: 0,
    estimatedCostMicroUsd: estimateImageCostMicroUsd(answer.usage),
  };
}

/**
 * The tries of one draw that got no answer (P0): every try before the last
 * was a 429 (the image client tries again after nothing else), and the last
 * was one too when the draw ended rate-limited, or ran out of its clock.
 * ⚠ A last try refused with 429 whose retry the stop or a drain then ended
 *   reads as cancelled, and that one 429 is not counted: the client does not
 *   say which try it was, and `providerAttempts` rises before the send, so it
 *   cannot be inferred (products.ts counts each 429 as it comes). StoreMink's
 *   own metric only: no allowance or charge reads it.
 */
function drawCallCounts(answer: ThemeImageResult): RevampCallCounts {
  const code = answer.kind === "error" ? answer.code : null;
  const before = Math.max(0, (answer.timing?.providerAttempts ?? 1) - 1);
  return {
    rateLimited: before + (code === "rate_limited" ? 1 : 0),
    timeouts: code === "provider_timeout" ? 1 : 0,
  };
}

/** One call's records as one report; either may be absent. */
function mergeUsage(
  a: RevampUsage | null,
  b: RevampUsage | null,
): RevampUsage | null {
  return a && b ? addRevampUsage(a, b) : (a ?? b);
}

/**
 * One review, and whether its request reached the review model's client at
 * all. ★ A review the run's stop or the deadline turned away before it was
 * sent comes back "unavailable" like an outage does, with no usage; only one
 * that was sent may have been billed, so only that one is reported (L2-F).
 * ★★ `budget` (P0) ends the check when the photo's budget does: a check cut
 *   off there, or never started because the budget was already spent, reads
 *   as a timeout (`outOfTime`), never as the run's own stop. A plain timer,
 *   so a test's fake clock decides when it fires.
 */
async function reviewOnce(
  reviewer: ThemeImageReviewer,
  input: ThemeImageReviewInput,
  signal: AbortSignal,
  budget?: { until: number; now: () => number },
): Promise<{ review: ThemeImageReview; sent: boolean; outOfTime: boolean }> {
  let sent = false;
  const client: ThemeStudioModelClient = {
    provider: reviewer.client.provider,
    generate: (request, callSignal) => {
      sent = true;
      return reviewer.client.generate(request, callSignal);
    },
  };
  const left = budget ? budget.until - budget.now() : Number.POSITIVE_INFINITY;
  if (left <= 0) {
    return {
      review: {
        kind: "unavailable",
        code: "provider_timeout",
        usage: ZERO_USAGE,
        estimatedCostMicroUsd: 0,
      },
      sent: false,
      outOfTime: true,
    };
  }
  const spent = new AbortController();
  const timer = Number.isFinite(left)
    ? setTimeout(() => spent.abort(), left)
    : null;
  try {
    const review = await reviewThemeImage(
      client,
      reviewer.providerModel,
      input,
      timer ? AbortSignal.any([signal, spent.signal]) : signal,
    );
    if (
      review.kind === "unavailable" &&
      spent.signal.aborted &&
      !signal.aborted
    ) {
      return {
        review: { ...review, code: "provider_timeout" },
        sent,
        outOfTime: true,
      };
    }
    return { review, sent, outOfTime: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What one review cost, or null when it cost nothing (the draws' rule). */
function reviewCallUsage(review: ThemeImageReview): RevampUsage | null {
  if (review.kind === "unavailable" && NOT_DRAWN_CODES.has(review.code)) {
    return null;
  }
  return {
    inputTokens: review.usage.inputTokens,
    outputTokens: review.usage.outputTokens,
    thinkingTokens: review.usage.thinkingTokens,
    images: 0,
    reviews: 1,
    estimatedCostMicroUsd: review.estimatedCostMicroUsd,
  };
}

async function reportProgress(
  ctx: RevampStepContext,
  done: number,
  total: number,
): Promise<void> {
  if (total <= 0) return;
  try {
    await ctx.report(`${Math.min(done, total)} of ${total}`);
  } catch {
    // The card's detail line is best effort by contract.
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────

function indexImages(
  images: readonly RevampStoredImage[],
): Map<string, RevampStoredImage> {
  const index = new Map<string, RevampStoredImage>();
  for (const image of Array.isArray(images) ? images : []) {
    if (!image || typeof image.slotId !== "string") continue;
    const key = slotKey(image.role, image.slotId);
    if (!index.has(key)) index.set(key, image);
  }
  return index;
}

function slotKey(role: RevampStoredImage["role"], slotId: string): string {
  return `${role}:${slotId}`;
}

function phoneSlotId(shotId: string): string {
  return `${shotId}${REVAMP_PHONE_SUFFIX}`;
}

/** The key a brief's checks are recorded under: the shot id, or the anchor's. */
function checkKeyOf(briefId: string): string {
  return briefId === ANCHOR_SLOT ? ANCHOR_CHECK_KEY : briefId;
}

/** A problem word a check can name, as a recorded verdict is read back. */
function isThemeImageProblem(value: string): value is ThemeImageProblem {
  return (THEME_IMAGE_PROBLEMS as readonly string[]).includes(value);
}

/** Where a shot's photo waits for its review (L2-I). */
function pendingSlotId(shotId: string): string {
  return `${shotId}${REVAMP_REVIEW_PENDING_SUFFIX}`;
}

/** The shot a parked photo's slot id belongs to, or null for any other. */
function pendingShotOf(slotId: unknown): string | null {
  if (typeof slotId === "string") {
    const candidate = slotId.match(/^(.+)~candidate-[1-4]$/);
    if (candidate) return candidate[1];
  }
  if (typeof slotId !== "string") return null;
  if (!slotId.endsWith(REVAMP_REVIEW_PENDING_SUFFIX)) return null;
  const shotId = slotId.slice(0, -REVAMP_REVIEW_PENDING_SUFFIX.length);
  return shotId || null;
}

/** The SHA-256 of some bytes, hex: how this step tells pictures apart. */
function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64",
  );
}

function mediaTypeOfPath(path: string): RevampImageMediaType {
  if (path.endsWith(".jpg")) return "image/jpeg";
  if (path.endsWith(".png")) return "image/png";
  return "image/webp";
}

function altFor(shot: RevampShot): string {
  return (
    cleanLine(shot.subject, ALT_CHARS) ||
    cleanLine(shot.artDirection, ALT_CHARS)
  );
}

function cleanLine(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function stripRecord(record: RevampImageRecord): RevampStoredImage {
  return {
    role: record.role,
    slotId: record.slotId,
    url: record.url,
    path: record.path,
    sha256: record.sha256,
    width: record.width,
    height: record.height,
    review: record.review,
  };
}
