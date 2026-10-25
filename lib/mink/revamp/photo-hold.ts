import "server-only";

import { logWarn } from "@/lib/observability/logger";
import type { RevampImageRole, RevampStoredImage } from "./contract";
import { releaseRevampPhotos } from "./image-store";
import {
  RevampStepError,
  type RevampPhotoHold,
  type RevampStepContext,
} from "./ports";

// ---------------------------------------------------------------------------
// The photo claim a revamp holds, kept on its job row (jobs-3).
//
// The photos and product photos steps claim the store's and the platform's
// photo allowances before drawing (image-store.ts) and give back what they
// did not draw when they end. A runner that died in between (a killed
// container, a lost lease) used to take the give-back with it: the claim
// stayed counted for the day, and the next invocation claimed the same
// photos again, so a few crashes could use up most of a store's day.
//
// ★★ RECORDED BEFORE ANYTHING IS DRAWN; GIVEN BACK ONLY BY WHOEVER CLEARS THE
//   RECORD. The record is a fenced write on the job row (the runner's
//   `ctx.photoHold`), so exactly one invocation can clear it: this one when
//   its step ends, or, when this one died or lost its lease, the next one
//   when it starts the step. A claim is given back once, never twice, and
//   never by a runner that no longer owns the job.
// ★ A UNIT IS THE IMAGE ROW A DRAWN PHOTO LEAVES (`role:slotId`), so the next
//   invocation tells what was drawn from what is stored: a unit with a row
//   was drawn (or a crop stands in for one that may have been) and stays
//   counted; one with no row is given back.
// ---------------------------------------------------------------------------

/** The unit a photo of this role and slot is held under. */
export function revampPhotoUnit(role: RevampImageRole, slotId: string): string {
  return `${role}:${slotId}`;
}

/**
 * A photo still waiting for its review is stored under the shot id with
 * this suffix (photos.ts, L2-I). ★ Defined here, beside the unit rule,
 * because a claim is settled in two places (the photos step's start and the
 * sweep in jobs.ts) and both must read a parked photo the same way.
 */
export const REVAMP_REVIEW_PENDING_SUFFIX = "~review";

/**
 * The unit a stored image row covers. ★ A photo parked for its review was
 * drawn under its shot's claim, so it covers that shot: read under its own
 * slot id, a runner that died holding the claim would hand a drawn photo
 * back to the allowance.
 */
export function storedPhotoUnit(
  image: Pick<RevampStoredImage, "role" | "slotId">,
): string {
  if (
    image.role === "slot" &&
    typeof image.slotId === "string" &&
    image.slotId.endsWith(REVAMP_REVIEW_PENDING_SUFFIX)
  ) {
    const shotId = image.slotId.slice(0, -REVAMP_REVIEW_PENDING_SUFFIX.length);
    if (shotId) return revampPhotoUnit("slot", shotId);
  }
  return revampPhotoUnit(image.role, image.slotId);
}

/**
 * Record what this invocation now holds (null: nothing). True when it landed,
 * or when there is no record to keep (a step run on its own gives back in
 * process, as before). Never throws.
 */
export async function recordPhotoHold(
  ctx: RevampStepContext,
  hold: RevampPhotoHold | null,
): Promise<boolean> {
  const port = ctx.photoHold;
  if (!port) return true;
  try {
    return await port.record(hold);
  } catch (error) {
    logWarn("mink.revamp: the photo claim could not be recorded", {
      revampId: ctx.revampId,
      holding: hold ? hold.units.length : 0,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Settle the claim an earlier invocation left on the row before this one
 * claims: the units with no stored row were never drawn, so they are given
 * back, once the record is cleared. A no-op when nothing is held.
 */
export async function settleStalePhotoHold(
  ctx: RevampStepContext,
  stored: readonly RevampStoredImage[],
): Promise<void> {
  const stale = ctx.photoHold?.held() ?? null;
  if (!stale) return;
  const present = new Set(
    (Array.isArray(stored) ? stored : []).map(storedPhotoUnit),
  );
  const unused = stale.units.filter((unit) => !present.has(unit)).length;
  // ★ Cleared first: a claim goes back only through whoever clears it.
  if (!(await recordPhotoHold(ctx, null))) {
    // ★ Claiming now would write this invocation's claim over the record,
    //   and what the dead runner never drew would never be given back. A
    //   later claim (or the runner that owns the job now) settles it.
    ctx.signal.throwIfAborted();
    throw new RevampStepError(
      "internal",
      "The photo claim an earlier run left could not be settled.",
      true,
    );
  }
  await releaseRevampPhotos(ctx.actor.storeId, unused);
}

/**
 * Give back `unused` photos of this invocation's claim when its step ends:
 * the record is cleared first, and nothing is given back when it could not
 * be (another runner owns the job and settles the claim from the record).
 */
export async function settlePhotoHold(
  ctx: RevampStepContext,
  unused: number,
): Promise<void> {
  if (!(await recordPhotoHold(ctx, null))) return;
  await releaseRevampPhotos(ctx.actor.storeId, Math.max(0, unused));
}
