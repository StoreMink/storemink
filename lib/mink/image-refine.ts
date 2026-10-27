import "server-only";

import {
  HarmBlockThreshold,
  HarmCategory,
  Modality,
  ProminentPeople,
  ThinkingLevel,
} from "@google/genai";
import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { mediaAssets } from "@/drizzle/schema";
import {
  gcsConfigured,
  gcsDeletePaths,
  gcsDownloadObject,
  gcsPrivateConfigured,
  gcsPrivateUploadObject,
  gcsPublicUrl,
} from "@/lib/storage/gcs";
import { ownedObjectPath } from "@/lib/storage/ownership";
import {
  IMAGE_REFINE_CREDITS,
  IMAGE_SPECS,
  type ImageSpec,
  type ImageSpecKey,
} from "@/lib/media/image-specs";
import { logError, logWarn } from "@/lib/observability/logger";
import { getMinkConfig, type MinkConfig } from "./config";
import { MinkRequestError } from "./errors";
import { canAfford, imageCreditHeadroom } from "./image-credits";
import {
  MINK_CHAT_IMAGE_RETRY,
  isUnbilledImageFailure,
  requestMinkImage,
  reserveMinkImageGeneration,
  type MinkImageAllowance,
} from "./media-generation";
import { assertMediaGenerationAuthority } from "./media-image-proposals";
import {
  publishRefinedCopy,
  refinePublicPath,
  refineStagePath,
} from "./refine-stages";
import {
  abandonRefineStage,
  beginRefineRequest,
  claimRefineCharge,
  refineChargeCommitted,
  registerLiveRefine,
  watchRefineStop,
  type RefineBegin,
  type RefineStopKey,
} from "./refine-stop";
import type { StopWatch } from "./stop-watch";
import type { MinkActorContext } from "./types";

export { REFINED_FOLDER } from "./refine-stages";

// ---------------------------------------------------------------------------
// Refine with Mink AI — retouch one of the merchant's own photos and return a
// copy at EXACTLY the size its upload slot renders at.
//
// ★★ THIS IS A RETOUCH OF A REAL PRODUCT PHOTO, chosen deliberately by the
//    owner over "extend the background only". The model re-renders the whole
//    frame, so it can subtly change the product. Three things keep that
//    honest: the prompt forbids changing the goods, the merchant sees the
//    original and the result side by side and must choose "Use refined
//    photo", and the original is never touched — the result is a NEW object.
//    Gemini images carry SynthID.
// ★ PEOPLE: the merchant's photo often shows a model wearing the product, so
//    this call allows adults (`ALLOW_ADULT`), unlike Mink's generated images
//    (`ALLOW_NONE`, where a person would be invented). Prominent people stay
//    blocked and the prompt forbids adding anyone.
// ★ GATES ARE MINK IMAGE GENERATION'S: Media manage, the store's image
//    generation switch, and the same spend ceiling, claimed BEFORE the
//    provider call. Credits are charged only after an image exists and is
//    stored, atomically and idempotently (consume_mink_refine_credits); a
//    store that cannot pay is refused BEFORE the provider is called.
// ★★ A 429 IS ASKED AGAIN, AND A REFUSAL SPENDS NO ALLOWANCE (B10, B3,
//    2026-10-23): the chat image's rule (MINK_CHAT_IMAGE_RETRY) on this
//    call's own 60 s try, and the store's hour and day given back whenever
//    Google provably drew nothing.
// ★★ LEAVING MID-REFINE CHARGES NOTHING, AND NO UNPAID PICTURE IS EVER PUBLIC
//    (owner, 26 Oct 2026). Behind Google's load balancer an aborted browser
//    fetch never reaches Cloud Run, so a merchant who left was charged for a
//    photo nobody waited for; and the result used to be uploaded to the
//    PUBLIC bucket, which anyone can list, before the charge, so every branch
//    that then deleted it (left, could not pay) handed out a free picture.
//    Now the browser sends a stop token, and the refine's own row in
//    mink_refine_requests decides between the stop and the charge
//    (refine-stop.ts: exactly one wins, the claim being the charge
//    transaction's first statement). The result is staged in the PRIVATE
//    bucket, charged, and only then published from memory
//    (refine-stages.ts); a paid photo whose publish fails, or whose charge
//    ended in an error that hid its outcome, is settled by the per-minute
//    stage sweep with the same arbiter.
// ---------------------------------------------------------------------------

const SAFETY_CATEGORIES = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
] as const;

/** One try's own clock: a retouch of a real photo takes longer than a draw. */
const REFINE_TIMEOUT_MS = 60_000;

/**
 * How Refine asks again: the chat image's rule, two free 429 retries 5 to
 * 15 s apart at the same location, each try on Refine's own 60 s clock.
 */
export const REFINE_RETRY = {
  ...MINK_CHAT_IMAGE_RETRY,
  attemptTimeoutMs: REFINE_TIMEOUT_MS,
} as const;

/**
 * How long before the caller's deadline the model must have answered, so the
 * resize, the upload and the charge fit before it.
 */
export const REFINE_POST_RESERVE_MS = 15_000;
/** Source download ceiling; uploads are capped at 5 MiB, this allows headroom. */
const SOURCE_MAX_BYTES = 12 * 1024 * 1024;
/** The source is downscaled to this before it is sent: enough detail, bounded cost. */
const SOURCE_MAX_EDGE = 2048;

export interface RefinedImage {
  url: string;
  width: number;
  height: number;
  chargedCredits: number;
}

export function refinePrompt(spec: ImageSpec): string {
  return [
    "Retouch the attached photograph for an online store.",
    `Output one photograph with a ${spec.aspect} aspect ratio (${spec.width} × ${spec.height}), composed for that frame: ${spec.hint}`,
    "",
    "KEEP EXACTLY THE SAME",
    "- The product: its shape, cut, colours, materials, pattern, stitching and every print, label, logo or lettering that is physically on it. Do not redraw, restyle or correct the product.",
    "- Any person already in the photo: same person, same face, pose, body and clothing. Do not add, remove or replace anyone.",
    "",
    "IMPROVE",
    "- Lighting: even, soft, professional studio light; correct white balance and exposure; no harsh shadows or colour casts.",
    "- Background: clean and uncluttered, in keeping with the original (a seamless studio backdrop if the original background is messy).",
    "- Composition: centre the subject and fill the frame naturally for the requested shape, extending the background where the original is too narrow or too short. Never crop through the product.",
    "- Sharpness and clarity, without an artificial or over-processed look.",
    "",
    "DO NOT",
    "- Add text, watermarks, logos, price tags, borders, props or extra products.",
    "- Change what the product is or make it look different from the real item a customer will receive.",
  ].join("\n");
}

/** Which bucket object the source URL names, if it is provably this store's. */
export const ownedSourcePath = ownedObjectPath;

type SharpFactory = (input: Buffer) => import("sharp").Sharp;
// Imported lazily, as everywhere else: a missing native library must surface
// as this feature's error, not take the module (and the route) down with it.
async function loadSharp(): Promise<SharpFactory> {
  const mod = await import("sharp");
  return mod.default as unknown as SharpFactory;
}

export async function refineStoreImage(input: {
  actor: MinkActorContext;
  sourceUrl: string;
  specKey: ImageSpecKey;
  /**
   * The browser's stop token (checked by the route). ★ Without one (a tab
   *   loaded before this build) the server makes one: that refine cannot be
   *   stopped, but it takes the same private-stage path.
   */
  stopToken?: string;
  /**
   * The route's deadline (and, locally, the request's own signal). ★ It
   *   aborts the provider call in flight, and nothing is stored or charged
   *   once it has fired. A merchant leaving is the stop token's job: behind
   *   the load balancer this signal never fires for that.
   */
  signal?: AbortSignal;
  /** When the caller stops waiting, in epoch milliseconds. */
  deadlineAt?: number;
}): Promise<RefinedImage> {
  const { actor, specKey } = input;
  const spec: ImageSpec = IMAGE_SPECS[specKey];
  if (!spec.refine) {
    throw new MinkRequestError(
      "refine_not_offered",
      `${spec.label} images can't be refined with Mink AI.`,
      400,
    );
  }
  const config = getMinkConfig();
  if (!config.enabled) {
    throw new MinkRequestError("mink_disabled", "Mink AI is unavailable.", 503);
  }
  // ★ No private bucket, no refine: the result must be staged where nobody
  //   can read it until it is paid for, and there is deliberately no fallback
  //   to the public bucket (lib/storage/gcs.ts, the chat media rule).
  if (!gcsConfigured || !gcsPrivateConfigured || !config.projectId) {
    throw new MinkRequestError(
      "refine_not_configured",
      "Image refining is not available right now.",
      503,
    );
  }
  await assertMediaGenerationAuthority(actor);

  const sourcePath = ownedSourcePath(input.sourceUrl, actor.storeId);
  if (!sourcePath) {
    throw new MinkRequestError(
      "refine_source_not_owned",
      "Upload the photo here first, then refine it.",
      400,
    );
  }

  // ★ Can the store pay? Asked before the provider is called, so a store with
  //   no credits left is not handed a picture it then cannot keep.
  const headroom = await imageCreditHeadroom(actor, config.chargeCredits);
  if (!canAfford(headroom, IMAGE_REFINE_CREDITS)) {
    throw insufficient();
  }
  const cycle = { period: headroom.period };
  const planCap = headroom.planCap;

  // ★ Every path comes from the store and the server's own refine id, never
  //   from the browser; the token only finds this refine's row.
  const refinementId = crypto.randomUUID();
  const key: RefineStopKey = {
    storeId: actor.storeId,
    adminId: actor.adminId,
    stopToken: (input.stopToken ?? crypto.randomUUID()).toLowerCase(),
  };
  const stagePath = refineStagePath(actor.storeId, refinementId);
  const publicPath = refinePublicPath(actor.storeId, refinementId);
  const publicUrl = gcsPublicUrl(publicPath);

  let begin: RefineBegin;
  try {
    begin = await beginRefineRequest(key, refinementId);
  } catch (error) {
    // ★ loggableError, here and at the charge: a failed query's own message
    //   carries its parameters, and the begin's and the claim's include the
    //   browser's token.
    logError("mink refine: begin failed", loggableError(error), {
      refinementId,
    });
    throw new MinkRequestError(
      "refine_unavailable",
      "Refining couldn't start. Nothing was charged; try again.",
      503,
    );
  }
  if (begin === "stopped") throw cancelled();
  if (begin === "duplicate") {
    throw new MinkRequestError(
      "refine_duplicate",
      "This photo is already being refined.",
      409,
    );
  }
  // ★ `unavailable` (the table is missing: local only, before 0247) runs
  //   unguarded: no watch, no pre-send check, no claim. A claim on a missing
  //   row would read as "a stop won" after the model was paid for.
  const guarded = begin === "fresh";

  const stop = new AbortController();
  let watch: StopWatch | null = null;
  let unregister: (() => void) | null = null;
  if (guarded) {
    watch = watchRefineStop(key, () => stop.abort());
    unregister = registerLiveRefine(key, () => stop.abort());
  }
  const signal = AbortSignal.any([
    stop.signal,
    ...(input.signal ? [input.signal] : []),
  ]);
  const dropStage = () =>
    gcsDeletePaths([stagePath], "private").catch(() => []);

  try {
    const allowance = await reserveMinkImageGeneration(actor, refinementId);

    let source: Buffer;
    try {
      const raw = await gcsDownloadObject(sourcePath, SOURCE_MAX_BYTES);
      const sharp = await loadSharp();
      source = await sharp(Buffer.from(raw))
        .rotate()
        .resize(SOURCE_MAX_EDGE, SOURCE_MAX_EDGE, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 90 })
        .toBuffer();
    } catch (error) {
      logError("mink refine source read failed", error, { sourcePath });
      // Nothing was sent: the allowance comes back (B3).
      await allowance.giveBack();
      throw new MinkRequestError(
        "refine_source_unreadable",
        "That photo couldn't be read. Try uploading it again.",
        400,
      );
    }

    // ★ The last look before the paid call: a stop recorded on another
    //   instance is read now (never beside a tick's read), and nothing has
    //   been sent, so the allowance comes back.
    if (stop.signal.aborted || (watch && (await watch.checkNow()))) {
      await allowance.giveBack();
      throw cancelled();
    }

    const generated = await callRefineModel(config, spec, source, {
      allowance,
      signal,
      deadlineAt: input.deadlineAt,
      stopSignal: stop.signal,
    });
    // ★ Stopped, or past the route's deadline, after the photo came back:
    //   nothing is stored or charged. It may have been billed, so the
    //   allowance stays spent.
    if (stop.signal.aborted) throw cancelled();
    if (input.signal?.aborted) throw stopped();

    // ★ EXACT SIZE, ALWAYS. The model honours the aspect ratio approximately
    //   (it rounds to its own tile grid), so the result is fitted to the slot's
    //   exact pixels here rather than trusted.
    let output: Buffer;
    try {
      const sharp = await loadSharp();
      output = await sharp(generated)
        .resize(spec.width, spec.height, { fit: "cover", position: "centre" })
        .webp({ quality: 88 })
        .toBuffer();
    } catch (error) {
      logError("mink refine output processing failed", error, {});
      throw new MinkRequestError(
        "refine_output_unreadable",
        "The refined photo couldn't be processed. Nothing was charged; try again.",
        502,
      );
    }

    // ★★ PRIVATE FIRST: nothing unpaid is ever readable or listable by URL.
    try {
      await gcsPrivateUploadObject(stagePath, output, "image/webp");
    } catch (error) {
      logError("mink refine upload failed", error, { path: stagePath });
      throw new MinkRequestError(
        "refine_storage_failed",
        "The refined photo couldn't be stored. Nothing was charged; try again.",
        503,
      );
    }
    if (stop.signal.aborted) {
      await dropStage();
      throw cancelled();
    }
    if (input.signal?.aborted) {
      await dropStage();
      throw stopped();
    }

    // ★ No watcher read may hold a pooled connection once the charge starts,
    //   so the request never holds two (the pool is 5 per process).
    if (watch) {
      watch.close();
      await watch.settled();
      if (stop.signal.aborted) {
        await dropStage();
        throw cancelled();
      }
    }

    let chargeSource: string;
    try {
      chargeSource = await withService(async (db) => {
        // ★★ The claim is this transaction's FIRST statement, so the row
        //   stays locked until it commits or rolls back: a stop waiting on it
        //   then reads the outcome, and exactly one of the two wins.
        if (guarded && !(await claimRefineCharge(db, key, refinementId))) {
          throw new RefineStopWon();
        }
        const res = await db.execute(sql`
          select public.consume_mink_refine_credits(
            p_refinement => ${refinementId}::uuid,
            p_store => ${actor.storeId}::uuid,
            p_admin => ${actor.adminId},
            p_destination => ${specKey},
            p_width => ${spec.width},
            p_height => ${spec.height},
            p_source_url => ${input.sourceUrl},
            p_period => ${cycle.period},
            p_plan_cap => ${planCap},
            p_credits => ${IMAGE_REFINE_CREDITS}
          ) as source
        `);
        const charged = (res.rows[0] as { source?: string } | undefined)
          ?.source;
        // ★ Fails closed: no answer is never read as a charge.
        if (!charged) throw new Error("The refine charge returned nothing.");
        // ★ Rolls the claim back with it, so a later stop still wins.
        if (charged === "insufficient") throw new RefineInsufficient();
        await db.execute(sql`
          update public.mink_image_refinements
          set result_url = ${publicUrl}, result_path = ${publicPath}
          where id = ${refinementId}::uuid and store_id = ${actor.storeId}::uuid
        `);
        // ★ In the Media Library too, so the refined copy can be found and
        //   reused like any other upload.
        await db.insert(mediaAssets).values({
          storeId: actor.storeId,
          url: publicUrl,
          path: publicPath,
          filename: `refined-${specKey}-${spec.width}x${spec.height}.webp`,
          contentType: "image/webp",
          sizeBytes: output.length,
          createdBy: actor.adminId,
          source: "mink_refined",
        });
        return charged;
      });
    } catch (error) {
      if (error instanceof RefineStopWon) {
        await dropStage();
        throw cancelled();
      }
      if (error instanceof RefineInsufficient) {
        // Spent elsewhere between the check and now.
        await dropStage();
        throw insufficient();
      }
      // ★★ AN ERROR DOES NOT PROVE NOTHING WAS WRITTEN: a COMMIT can fail
      //   after it landed, or still be landing. A guarded refine asks the
      //   abandon, a conditional write that waits for that transaction to
      //   end and then decides on the newest row; only an unguarded one
      //   (local, no row to lock) reads the ledger.
      let decision: "discard" | { publish: string } | "unknown";
      try {
        decision = guarded
          ? await abandonRefineStage(actor.storeId, refinementId)
          : (await refineChargeCommitted(actor.storeId, refinementId))
            ? { publish: publicPath }
            : "discard";
      } catch {
        decision = "unknown";
      }
      if (decision === "discard") {
        await dropStage();
        logError("mink refine charge failed", loggableError(error), {
          refinementId,
        });
        throw new MinkRequestError(
          "refine_charge_failed",
          "The refined photo couldn't be saved. Nothing was charged; try again.",
          503,
        );
      }
      if (decision === "unknown") {
        // ★ The stage stays: the sweep settles it with the same abandon.
        logError("mink refine: charge outcome unknown", loggableError(error), {
          refinementId,
        });
        throw new MinkRequestError(
          "refine_charge_unknown",
          "We couldn't confirm whether your refined photo was saved. Check your Media Library before you try again.",
          503,
        );
      }
      logWarn("mink refine: charge committed despite an error", {
        refinementId,
      });
      // The ledger holds the exact source; the browser shows no credit
      // number, so the refine's price stands in for it.
      chargeSource = "credit";
    }

    // ★★ AFTER THE COMMIT, ONLY SUCCESS OR "STILL BEING SAVED": the publish
    //   never throws and the stage's delete is best effort, so the route's
    //   catch-all ("Nothing was charged") only ever answers an uncharged
    //   refine. A publish that failed keeps the stage for the sweep.
    if (!(await publishRefinedCopy(publicPath, output))) {
      logError("mink refine: publish deferred", undefined, { refinementId });
      throw new MinkRequestError(
        "refine_saving",
        "Your refined photo was made and is still being saved. It will appear in your Media Library in a few minutes.",
        503,
      );
    }
    await dropStage();

    return {
      url: publicUrl,
      width: spec.width,
      height: spec.height,
      chargedCredits:
        chargeSource === "plan_unlimited" ? 0 : IMAGE_REFINE_CREDITS,
    };
  } finally {
    watch?.close();
    unregister?.();
  }
}

/** A stop won the claim: the charge transaction must write nothing. */
class RefineStopWon extends Error {
  constructor() {
    super("A stop won the refine's charge claim.");
    this.name = "RefineStopWon";
  }
}

/** The store could not pay after all: rolls the claim back with the rest. */
class RefineInsufficient extends Error {
  constructor() {
    super("The store could not pay for the refine.");
    this.name = "RefineInsufficient";
  }
}

function insufficient(): MinkRequestError {
  return new MinkRequestError(
    "refine_insufficient_credits",
    "This store doesn't have enough Mink credits left to refine a photo. Buy Mink credits or upgrade under Plans & Billing.",
    402,
  );
}

/** Refining stopped before the result was kept: nothing stored or charged. */
function stopped(): MinkRequestError {
  return new MinkRequestError(
    "refine_stopped",
    "Refining took too long. Nothing was charged; try again.",
    504,
  );
}

/** The merchant's stop won (the browser left): nothing stored or charged. */
function cancelled(): MinkRequestError {
  return new MinkRequestError(
    "refine_cancelled",
    "Refining was stopped. Nothing was charged.",
    409,
  );
}

async function callRefineModel(
  config: MinkConfig,
  spec: ImageSpec,
  source: Buffer,
  options: {
    allowance: MinkImageAllowance;
    signal?: AbortSignal;
    deadlineAt?: number;
    /** The merchant's stop alone (part of `signal`), to tell it apart. */
    stopSignal?: AbortSignal;
  },
): Promise<Buffer> {
  let response;
  try {
    response = await requestMinkImage(
      {
        // Checked by the caller (refine_not_configured) before anything else.
        projectId: config.projectId ?? "",
        imageModel: config.imageModel,
        imageLocation: config.imageLocation,
      },
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: refinePrompt(spec) },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: source.toString("base64"),
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: [Modality.TEXT, Modality.IMAGE],
          candidateCount: 1,
          safetySettings: SAFETY_CATEGORIES.map((category) => ({
            category,
            threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
          })),
          imageConfig: {
            aspectRatio: spec.aspect,
            // ★★ Owner, 25 Oct 2026: "2K", which is larger than every
            //   refinable slot (IMAGE_SPECS), so the fit below only shrinks.
            imageSize: "2K",
            personGeneration: "ALLOW_ADULT",
            prominentPeople: ProminentPeople.BLOCK_PROMINENT_PEOPLE,
            outputMimeType: "image/jpeg",
            outputCompressionQuality: 95,
          },
          // ★★ Owner, 25 Oct 2026: MINIMAL thinking; sent to Nano Banana 2.1
          //   only (requestMinkImage). One user turn, nothing earlier to keep.
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        },
      },
      {
        ...REFINE_RETRY,
        abortSignal: options.signal,
        ...(options.deadlineAt !== undefined
          ? { deadlineAt: options.deadlineAt - REFINE_POST_RESERVE_MS }
          : {}),
        logLabel: "mink refine provider",
      },
    );
  } catch (error) {
    // ★★ A REFUSAL SPENDS NO ALLOWANCE (B3): every try answered 429, or none
    //    was sent. A timeout or a 5xx after sending keeps it spent.
    if (isUnbilledImageFailure(error)) await options.allowance.giveBack();
    if (options.stopSignal?.aborted) throw cancelled();
    throw new MinkRequestError(
      "refine_provider_unavailable",
      "Mink AI didn't respond. Nothing was charged; try again shortly.",
      503,
    );
  }

  const candidate = response.candidates?.[0];
  // ★ The final picture: the last image part that is not a thought, never a
  //   1K draft sent ahead of it (media-generation.ts, the same rule).
  const data = (candidate?.content?.parts ?? [])
    .filter((part) => part.thought !== true && Boolean(part.inlineData?.data))
    .at(-1)?.inlineData?.data;
  if (!data) {
    const reason =
      response.promptFeedback?.blockReasonMessage?.trim() ||
      candidate?.finishMessage?.trim() ||
      (candidate?.finishReason && candidate.finishReason !== "STOP"
        ? String(candidate.finishReason)
        : undefined);
    throw new MinkRequestError(
      "refine_refused",
      reason
        ? `Mink AI couldn't refine this photo (${reason}). Nothing was charged.`
        : "Mink AI returned no photo. Nothing was charged; try again.",
      422,
    );
  }
  return Buffer.from(data, "base64");
}
