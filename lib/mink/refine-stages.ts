import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import {
  gcsConfigured,
  gcsDeletePaths,
  gcsDownloadObject,
  gcsListObjects,
  gcsPrivateConfigured,
  gcsUploadObject,
} from "@/lib/storage/gcs";
import { storeStoragePrefix } from "@/lib/storage/paths";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { abandonRefineStage } from "./refine-stop";

// ---------------------------------------------------------------------------
// ★★ NOTHING UNPAID IS EVER PUBLIC (26 Oct 2026). The public bucket can be
// listed by anyone (lib/storage/gcs.ts), so a refined photo that was uploaded
// there before its charge, and deleted when the merchant left or could not
// pay, was a free picture for whoever listed it first. A refine now writes its
// result to the PRIVATE bucket (a stage), charges, and only then publishes the
// same bytes to `stores/{id}/refined/`.
//
// ★★ A PAID PICTURE IS NEVER LOST. A publish that fails, or a process that
// dies after the charge, leaves the stage; the per-minute workflow heartbeat
// (app/api/cron/mink-workflows) sweeps stages older than five minutes and
// decides each with abandonRefineStage: publish it when its charge committed,
// delete it when it never can be.
//
// ★★ STAGES ARE FILED BY DATABASE: `refine-stage/{DB_NAME}/{store}/{refine}.webp`.
// A stage is decided by rows that exist only in the database that ran its
// refine, while one private bucket serves several databases (dev and staging
// share theirs, and local development uses that same bucket with
// storemink_local, which is rebuilt from staging and so holds the same store
// ids). Each sweep lists only its own database's prefix, so no environment
// ever decides, publishes or deletes a stage another one wrote.
// ---------------------------------------------------------------------------

export const REFINE_STAGE_ROOT = "refine-stage/";
/** Where a store's refined photos are published (inside its own prefix). */
export const REFINED_FOLDER = "refined";

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The database this process charges in: `DB_NAME` when it is a plain name,
 * else "default". Read on every call.
 */
export function refineStageDatabase(): string {
  const name = process.env.DB_NAME ?? "";
  return DATABASE_NAME_PATTERN.test(name) ? name : "default";
}

/**
 * `refine-stage/{database}/`. ★ With the trailing slash, so `storemink`
 * never lists `storemink_staging`.
 */
export function refineStagePrefix(): string {
  return `${REFINE_STAGE_ROOT}${refineStageDatabase()}/`;
}

/** A refine's private stage, under this database's prefix. */
export function refineStagePath(storeId: string, refinementId: string): string {
  return `${refineStagePrefix()}${storeId}/${refinementId}.webp`;
}

/** A refine's public copy, published only after its charge commits. */
export function refinePublicPath(
  storeId: string,
  refinementId: string,
): string {
  return `${storeStoragePrefix(storeId)}${REFINED_FOLDER}/${refinementId}.webp`;
}

const PUBLISH_WAITS_MS = [0, 300, 1_000] as const;

/**
 * Publish a paid refined photo: up to three uploads, after the given waits.
 * True on the first success; false after the third failure (logged once,
 * with the path). ★ Never throws: the refine's success path after the charge
 * may end only in success or "still being saved", so the route's catch-all
 * ("Nothing was charged") stays true.
 */
export async function publishRefinedCopy(
  publicPath: string,
  bytes: Uint8Array,
  options: { waitsMs?: readonly number[] } = {},
): Promise<boolean> {
  let lastError: unknown;
  for (const wait of options.waitsMs ?? PUBLISH_WAITS_MS) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      await gcsUploadObject(publicPath, bytes, "image/webp");
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  logError("mink.image-refine: publish failed", lastError, {
    path: publicPath,
  });
  return false;
}

/** A stage is decided only once its refine is surely over (about 3 minutes). */
export const REFINE_STAGE_SWEEP_AGE_MS = 5 * 60_000;
/** At most this many stages are decided in one pass. */
export const REFINE_STAGE_SWEEP_LIMIT = 20;
/** And for at most this long, so the minute heartbeat keeps its headroom. */
export const REFINE_STAGE_SWEEP_BUDGET_MS = 10_000;
/** One listing call a pass; normally it is empty. */
const REFINE_STAGE_LIST_MAX = 100;
/** A stage is the slot's exact WebP, far smaller than this. */
const STAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Publish the paid stages and delete the unpaid ones of THIS database, five
 * minutes after they were written. ★ Each stage is decided by
 * abandonRefineStage, the same conditional write a stop makes, so the sweep
 * can never discard a stage whose charge commits later, nor publish one whose
 * charge did not. Bounded (count and time); one stage's failure is logged and
 * left for the next pass, and never stops the next stage. Overlapping passes
 * are safe: the abandon is idempotent, the upload overwrites the same bytes,
 * and a delete ignores a missing object.
 */
export async function sweepRefineStages(): Promise<{
  published: number;
  deleted: number;
  failed: number;
}> {
  const counts = { published: 0, deleted: 0, failed: 0 };
  if (!gcsConfigured || !gcsPrivateConfigured) return counts;
  // ★ THE BUDGET COVERS EVERY STORAGE CALL, THE LISTING'S TOO, and each one is
  //   cut at what is left of it: an upload has no timeout of its own (the
  //   SDK's write stream), so a storage stall would otherwise hold the
  //   heartbeat for minutes.
  const startedAt = Date.now();
  const remaining = () =>
    REFINE_STAGE_SWEEP_BUDGET_MS - (Date.now() - startedAt);
  const prefix = refineStagePrefix();
  // ★ Only this database's stages, never REFINE_STAGE_ROOT as a whole.
  const stages = await withinBudget(
    () => gcsListObjects("private", prefix, REFINE_STAGE_LIST_MAX),
    remaining(),
  );
  const pattern = new RegExp(
    `^${escapeRegExp(prefix)}(${UUID})/(${UUID})\\.webp$`,
  );
  const deleteStage = async (path: string) => {
    const kept = await withinBudget(
      () => gcsDeletePaths([path], "private"),
      remaining(),
    );
    if (kept.length > 0) counts.failed += 1;
    else counts.deleted += 1;
  };
  let warnedMalformed = false;
  let warnedUndated = false;
  for (const stage of stages) {
    if (
      counts.published + counts.deleted + counts.failed >=
      REFINE_STAGE_SWEEP_LIMIT
    ) {
      break;
    }
    if (remaining() <= 0) break;
    const match = pattern.exec(stage.name);
    if (!match) {
      // ★ Never deleted: this code did not write it.
      if (!warnedMalformed) {
        warnedMalformed = true;
        logWarn("mink.image-refine: unexpected stage name", {
          path: stage.name,
        });
      }
      continue;
    }
    // A live refine's stage lives seconds; an unknown age is left alone, and
    // said once a pass (a stage that never ages would never be decided).
    if (stage.createdAt === null) {
      if (!warnedUndated) {
        warnedUndated = true;
        logWarn("mink.image-refine: stage without a creation time", {
          path: stage.name,
        });
      }
      continue;
    }
    if (Date.now() - stage.createdAt < REFINE_STAGE_SWEEP_AGE_MS) continue;
    const [, storeId, refinementId] = match;
    try {
      const decision = await abandonRefineStage(storeId, refinementId);
      if (decision === "discard") {
        await deleteStage(stage.name);
        continue;
      }
      if (decision.publish !== refinePublicPath(storeId, refinementId)) {
        counts.failed += 1;
        logError("mink.image-refine: stage ledger path unexpected", undefined, {
          path: stage.name,
        });
        continue;
      }
      // ★ Paid, but deleted from the Media Library since (its publish had
      //   failed, so the merchant saw a broken photo there): the merchant's
      //   choice stands, so nothing is published and the stage goes.
      if (!(await refinedPhotoInLibrary(storeId, decision.publish))) {
        await deleteStage(stage.name);
        continue;
      }
      const bytes = await withinBudget(
        () => gcsDownloadObject(stage.name, STAGE_MAX_BYTES, "private"),
        remaining(),
      );
      // ★★ Published BEFORE the stage is deleted: an upload that fails keeps
      //   the stage for the next pass, so a paid photo is never lost.
      await withinBudget(
        () => gcsUploadObject(decision.publish, bytes, "image/webp"),
        remaining(),
      );
      counts.published += 1;
      // Best effort: a stage left behind is published again (the same bytes)
      // and deleted by the next pass.
      await withinBudget(
        () => gcsDeletePaths([stage.name], "private"),
        remaining(),
      ).catch(() => []);
    } catch (error) {
      counts.failed += 1;
      logError("mink.image-refine: stage sweep failed", loggableError(error), {
        path: stage.name,
      });
    }
  }
  if (counts.published + counts.deleted + counts.failed > 0) {
    logInfo("mink.image-refine: stages swept", counts);
  }
  return counts;
}

/**
 * One storage call, cut at what is left of the pass's budget. ★ A call that
 * runs out of time is no longer waited for, not cancelled (the SDK cannot
 * be): an upload that lands late writes the bytes the next pass would, and a
 * stage stays until a pass sees its delete succeed.
 */
async function withinBudget<T>(
  call: () => Promise<T>,
  remainingMs: number,
): Promise<T> {
  if (remainingMs <= 0) throw new Error("The stage sweep ran out of time.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The stage sweep ran out of time.")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the store's Media Library still holds a refined photo. The charge
 * commits its Media Library row with the claim, so a paid refine without one
 * was deleted there by the merchant.
 */
async function refinedPhotoInLibrary(
  storeId: string,
  publicPath: string,
): Promise<boolean> {
  const result = await withService((db) =>
    db.execute(sql`
      select 1 as kept
        from public.media_assets
       where store_id = ${storeId}::uuid and path = ${publicPath}
       limit 1`),
  );
  return result.rows.length > 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
