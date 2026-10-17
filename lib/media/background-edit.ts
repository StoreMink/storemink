import "server-only";

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { mediaAssets } from "@/drizzle/schema";
import { can } from "@/app/dashboard/lib/permissions";
import {
  gcsConfigured,
  gcsDeletePaths,
  gcsDownloadObject,
  gcsUploadObject,
} from "@/lib/storage/gcs";
import { ownedObjectPath } from "@/lib/storage/ownership";
import { storeStoragePrefix } from "@/lib/storage/paths";
import { rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { canAfford, imageCreditHeadroom } from "@/lib/mink/image-credits";
import type { MinkActorContext } from "@/lib/mink/types";
import {
  IMAGE_CUTOUT_CREDITS,
  IMAGE_SPECS,
  type ImageSpec,
  type ImageSpecKey,
} from "./image-specs";
import {
  type BackgroundChoice,
  type CutoutCheck,
  backgroundKey,
  isCutoutCheck,
} from "./background-layout";
import { cutOut, renderOnBackground } from "./background-render";
import {
  MattingError,
  mattingConfigured,
  requestProductMask,
} from "./matting-client";

// ---------------------------------------------------------------------------
// Background removal: the merchant's REAL product, cut out and placed on
// white, a colour or transparency at exactly the size its slot renders at.
//
// ★★ THE PRODUCT'S PIXELS ARE NEVER REDRAWN. The model (BiRefNet, on the
//    image-matting service) only decides which pixels are product; the
//    product itself is copied from the merchant's photo. That is the whole
//    difference from Refine with Mink AI, which re-renders the frame.
// ★ CHARGED ONCE PER PHOTO (owner's price, 2026-10-17). The first request for
//    a photo stores the cut-out and takes IMAGE_CUTOUT_CREDITS; every later
//    request for the same bytes, whatever the background, reuses the stored
//    cut-out and is free. consume_mink_cutout_credits records and charges in
//    one statement and makes two simultaneous first requests charge once.
// ★ NOTHING IS CHARGED FOR A FAILURE. The store's credits are checked before
//    the service is called, the cut-out is stored before the charge, and a
//    photo with no product found (or nothing but product) is refused before
//    anything is stored.
// ★ The original is never touched: every result is a new object, and the
//    merchant compares and chooses before a product uses it.
// ---------------------------------------------------------------------------

/** Source download ceiling; uploads are capped at 5 MiB. */
const SOURCE_MAX_BYTES = 12 * 1024 * 1024;
/** A stored cut-out is at most the matting service's 4096 px square. */
const CUTOUT_MAX_BYTES = 64 * 1024 * 1024;
export const CUTOUT_FOLDER = "cutouts";
export const EDITED_FOLDER = "edited";

export interface BackgroundEditResult {
  url: string;
  width: number;
  height: number;
  chargedCredits: number;
  /** True when the photo's earlier cut-out was reused (and nothing charged). */
  reused: boolean;
  checks: CutoutCheck[];
}

interface Cutout {
  id: string;
  png: Buffer;
  width: number;
  height: number;
  checks: CutoutCheck[];
  chargedCredits: number;
  reused: boolean;
}

function refuse(
  code: string,
  message: string,
  status: number,
): MinkRequestError {
  return new MinkRequestError(code, message, status);
}

function insufficient(): MinkRequestError {
  return refuse(
    "cutout_insufficient_credits",
    `Removing a background uses ${IMAGE_CUTOUT_CREDITS} Mink credit, and this store doesn't have enough left. Buy Mink credits or upgrade under Plans & Billing.`,
    402,
  );
}

const NO_PRODUCT =
  "No product could be found in this photo. Nothing was charged. A photo with the product clearly in the middle works best.";

export async function replaceProductBackground(input: {
  actor: MinkActorContext;
  sourceUrl: string;
  specKey: ImageSpecKey;
  background: BackgroundChoice;
}): Promise<BackgroundEditResult> {
  const { actor, specKey, background } = input;
  const spec: ImageSpec = IMAGE_SPECS[specKey];
  if (!spec.background) {
    throw refuse(
      "cutout_not_offered",
      `Background removal isn't offered for a ${spec.label.toLowerCase()}.`,
      400,
    );
  }
  if (!can(actor.permissions, "media", "manage", actor.isSuperadmin)) {
    throw refuse(
      "cutout_forbidden",
      "You need Media manage permission to change a photo's background.",
      403,
    );
  }
  if (!gcsConfigured || !mattingConfigured()) {
    throw refuse(
      "cutout_not_configured",
      "Background removal is not available right now.",
      503,
    );
  }
  const sourcePath = ownedObjectPath(input.sourceUrl, actor.storeId);
  if (!sourcePath) {
    throw refuse(
      "cutout_source_not_owned",
      "Upload the photo here first, then change its background.",
      400,
    );
  }

  let photo: Buffer;
  try {
    photo = Buffer.from(await gcsDownloadObject(sourcePath, SOURCE_MAX_BYTES));
  } catch (error) {
    logError("background edit: source read failed", error, { sourcePath });
    throw refuse(
      "cutout_source_unreadable",
      "That photo couldn't be read. Try uploading it again.",
      400,
    );
  }

  const cutout = await getOrCreateCutout({
    actor,
    photo,
    sourceUrl: input.sourceUrl,
    frame: spec,
  });
  return composeOnBackground({ actor, cutout, specKey, spec, background });
}

interface StoredCutout {
  id: string;
  path: string;
  width: number;
  height: number;
  checks: CutoutCheck[];
}

async function findCutout(
  storeId: string,
  digest: string,
): Promise<StoredCutout | null> {
  const rows = await withService(async (db) => {
    const res = await db.execute(sql`
      select id::text as id, cutout_path as path, width, height, checks
      from public.mink_image_cutouts
      where store_id = ${storeId}::uuid and source_digest = ${digest}
      limit 1
    `);
    return res.rows as {
      id: string;
      path: string;
      width: number | string;
      height: number | string;
      checks: unknown;
    }[];
  });
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    width: Number(row.width),
    height: Number(row.height),
    checks: Array.isArray(row.checks) ? row.checks.filter(isCutoutCheck) : [],
  };
}

async function loadStoredCutout(found: StoredCutout): Promise<Cutout> {
  const png = Buffer.from(
    await gcsDownloadObject(found.path, CUTOUT_MAX_BYTES),
  );
  return {
    id: found.id,
    png,
    width: found.width,
    height: found.height,
    checks: found.checks,
    chargedCredits: 0,
    reused: true,
  };
}

async function getOrCreateCutout(input: {
  actor: MinkActorContext;
  photo: Buffer;
  sourceUrl: string;
  frame: ImageSpec;
}): Promise<Cutout> {
  const { actor, photo } = input;
  const digest = createHash("sha256").update(photo).digest("hex");

  const existing = await findCutout(actor.storeId, digest);
  if (existing) {
    try {
      return await loadStoredCutout(existing);
    } catch (error) {
      // Its file is gone: cut the photo out again below. The charge function
      // finds the row, so nothing is charged twice.
      logError("background edit: stored cut-out unreadable", error, {
        cutoutId: existing.id,
      });
    }
  }

  const config = getMinkConfig();
  const headroom = await imageCreditHeadroom(actor, config.chargeCredits);
  if (!existing && !canAfford(headroom, IMAGE_CUTOUT_CREDITS)) {
    throw insufficient();
  }

  // One instance handles one photo at a time; these keep one store, or one
  // person, from queueing everyone else behind them.
  const [perStore, perAdmin] = await Promise.all([
    rateLimit(`image-cutout:store:${actor.storeId}`, {
      max: 40,
      windowSeconds: 3600,
    }),
    rateLimit(`image-cutout:admin:${actor.storeId}:${actor.adminId}`, {
      max: 6,
      windowSeconds: 60,
    }),
  ]);
  if (!perStore.allowed || !perAdmin.allowed) {
    throw refuse(
      "cutout_rate_limited",
      "Too many background removals at once. Wait a minute and try again.",
      429,
    );
  }

  let matte;
  try {
    matte = await requestProductMask(photo);
  } catch (error) {
    if (error instanceof MattingError) {
      const status =
        error.code === "busy"
          ? 429
          : error.code === "unreadable" || error.code === "too_large"
            ? 400
            : 503;
      throw refuse(`cutout_${error.code}`, error.message, status);
    }
    throw error;
  }
  if (matte.verdict === "empty") {
    throw refuse("cutout_no_product", NO_PRODUCT, 422);
  }
  if (matte.verdict === "full") {
    throw refuse(
      "cutout_no_background",
      "This photo looks like it is all product, so there is no background to remove. Nothing was charged.",
      422,
    );
  }

  let cut;
  try {
    cut = await cutOut(photo, matte, input.frame);
  } catch (error) {
    logError("background edit: cut-out failed", error, {});
    throw refuse(
      "cutout_processing_failed",
      "The photo couldn't be processed. Nothing was charged; try again.",
      502,
    );
  }
  if (!cut) throw refuse("cutout_no_product", NO_PRODUCT, 422);
  const { png, bounds, checks } = cut;

  const cutoutId = crypto.randomUUID();
  const path = `${storeStoragePrefix(actor.storeId)}${CUTOUT_FOLDER}/${cutoutId}.png`;
  let url: string;
  try {
    url = await gcsUploadObject(path, png, "image/png");
  } catch (error) {
    logError("background edit: cut-out upload failed", error, { path });
    throw refuse(
      "cutout_storage_failed",
      "The photo couldn't be stored. Nothing was charged; try again.",
      503,
    );
  }

  let charged: { cutoutId: string | null; source: string; reused: boolean };
  try {
    charged = await withService(async (db) => {
      const res = await db.execute(sql`
        select cutout_id::text as cutout_id, credit_source, reused
        from public.consume_mink_cutout_credits(
          p_cutout => ${cutoutId}::uuid,
          p_store => ${actor.storeId}::uuid,
          p_admin => ${actor.adminId},
          p_source_url => ${input.sourceUrl},
          p_source_digest => ${digest},
          p_cutout_url => ${url},
          p_cutout_path => ${path},
          p_width => ${bounds.width},
          p_height => ${bounds.height},
          p_checks => ${sql.param(checks)}::text[],
          p_period => ${headroom.period},
          p_plan_cap => ${headroom.planCap},
          p_credits => ${IMAGE_CUTOUT_CREDITS}
        )
      `);
      const row = res.rows[0] as
        | { cutout_id: string | null; credit_source: string; reused: boolean }
        | undefined;
      return {
        cutoutId: row?.cutout_id ?? null,
        source: row?.credit_source ?? "insufficient",
        reused: row?.reused === true,
      };
    });
  } catch (error) {
    await gcsDeletePaths([path]).catch(() => []);
    logError("background edit: charge failed", error, { cutoutId });
    throw refuse(
      "cutout_charge_failed",
      "The photo couldn't be saved. Nothing was charged; try again.",
      503,
    );
  }
  if (charged.source === "insufficient") {
    await gcsDeletePaths([path]).catch(() => []);
    throw insufficient();
  }

  const ownId = charged.cutoutId ?? cutoutId;
  if (charged.reused && ownId !== cutoutId) {
    // The photo already has a cut-out (another request finished first, or its
    // file was lost). Use that one and drop ours, so the store holds one copy;
    // if its file is gone, point its row at ours instead.
    const theirs = await findCutout(actor.storeId, digest);
    if (theirs) {
      try {
        const loaded = await loadStoredCutout(theirs);
        await gcsDeletePaths([path]).catch(() => []);
        return loaded;
      } catch {
        // Its file is gone: repoint its row at ours, below.
      }
    }
    await withService((db) =>
      db.execute(sql`
        update public.mink_image_cutouts
        set cutout_path = ${path}, cutout_url = ${url},
            width = ${bounds.width}, height = ${bounds.height},
            checks = ${sql.param(checks)}::text[]
        where id = ${ownId}::uuid and store_id = ${actor.storeId}::uuid
      `),
    ).catch((error) =>
      logError("background edit: cut-out repoint failed", error, {}),
    );
  }

  return {
    id: ownId,
    png,
    width: bounds.width,
    height: bounds.height,
    checks,
    chargedCredits:
      charged.reused || charged.source === "plan_unlimited"
        ? 0
        : IMAGE_CUTOUT_CREDITS,
    reused: charged.reused,
  };
}

async function composeOnBackground(input: {
  actor: MinkActorContext;
  cutout: Cutout;
  specKey: ImageSpecKey;
  spec: ImageSpec;
  background: BackgroundChoice;
}): Promise<BackgroundEditResult> {
  const { actor, cutout, specKey, spec, background } = input;
  const key = backgroundKey(background);
  const path = `${storeStoragePrefix(actor.storeId)}${EDITED_FOLDER}/${cutout.id}-${specKey}-${key}.webp`;
  const result = (url: string): BackgroundEditResult => ({
    url,
    width: spec.width,
    height: spec.height,
    chargedCredits: cutout.chargedCredits,
    reused: cutout.reused,
    checks: cutout.checks,
  });

  // The same photo, slot and background asked for again: the first result.
  const earlier = await withService((db) =>
    db
      .select({ url: mediaAssets.url })
      .from(mediaAssets)
      .where(
        and(eq(mediaAssets.storeId, actor.storeId), eq(mediaAssets.path, path)),
      )
      .limit(1),
  );
  if (earlier[0]?.url) return result(earlier[0].url);

  let output: Buffer;
  try {
    output = await renderOnBackground(cutout.png, cutout, spec, background);
  } catch (error) {
    logError("background edit: compose failed", error, { cutoutId: cutout.id });
    throw refuse(
      "cutout_compose_failed",
      "The new photo couldn't be made. Try again.",
      502,
    );
  }

  let url: string;
  try {
    url = await gcsUploadObject(path, output, "image/webp");
    await withService((db) =>
      db.insert(mediaAssets).values({
        storeId: actor.storeId,
        url,
        path,
        filename: `background-${key}-${spec.width}x${spec.height}.webp`,
        contentType: "image/webp",
        sizeBytes: output.length,
        createdBy: actor.adminId,
        source: "mink_edited",
      }),
    );
  } catch (error) {
    await gcsDeletePaths([path]).catch(() => []);
    logError("background edit: result storage failed", error, { path });
    throw refuse(
      "cutout_storage_failed",
      "The new photo couldn't be saved. Try again.",
      503,
    );
  }
  return result(url);
}
