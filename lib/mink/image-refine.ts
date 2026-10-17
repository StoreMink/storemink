import "server-only";

import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Modality,
  ProminentPeople,
} from "@google/genai";
import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { mediaAssets } from "@/drizzle/schema";
import {
  gcsConfigured,
  gcsDeletePaths,
  gcsDownloadObject,
  gcsUploadObject,
} from "@/lib/storage/gcs";
import { ownedObjectPath } from "@/lib/storage/ownership";
import { storeStoragePrefix } from "@/lib/storage/paths";
import {
  IMAGE_REFINE_CREDITS,
  IMAGE_SPECS,
  type ImageSpec,
  type ImageSpecKey,
} from "@/lib/media/image-specs";
import { logError } from "@/lib/observability/logger";
import { getMinkConfig, type MinkConfig } from "./config";
import { MinkRequestError } from "./errors";
import { canAfford, imageCreditHeadroom } from "./image-credits";
import { reserveMinkImageGeneration } from "./media-generation";
import { assertMediaGenerationAuthority } from "./media-image-proposals";
import type { MinkActorContext } from "./types";

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
// ---------------------------------------------------------------------------

const SAFETY_CATEGORIES = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
] as const;

const REFINE_TIMEOUT_MS = 60_000;
/** Source download ceiling; uploads are capped at 5 MiB, this allows headroom. */
const SOURCE_MAX_BYTES = 12 * 1024 * 1024;
/** The source is downscaled to this before it is sent: enough detail, bounded cost. */
const SOURCE_MAX_EDGE = 2048;
export const REFINED_FOLDER = "refined";

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
  if (!gcsConfigured || !config.projectId) {
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

  const refinementId = crypto.randomUUID();
  await reserveMinkImageGeneration(actor, refinementId);

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
    throw new MinkRequestError(
      "refine_source_unreadable",
      "That photo couldn't be read. Try uploading it again.",
      400,
    );
  }

  const generated = await callRefineModel(config, spec, source);

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

  const path = `${storeStoragePrefix(actor.storeId)}${REFINED_FOLDER}/${refinementId}.webp`;
  let url: string;
  try {
    url = await gcsUploadObject(path, output, "image/webp");
  } catch (error) {
    logError("mink refine upload failed", error, { path });
    throw new MinkRequestError(
      "refine_storage_failed",
      "The refined photo couldn't be stored. Nothing was charged; try again.",
      503,
    );
  }

  let chargeSource: string | undefined;
  try {
    chargeSource = await withService(async (db) => {
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
      const charged = (res.rows[0] as { source?: string } | undefined)?.source;
      if (charged && charged !== "insufficient") {
        await db.execute(sql`
          update public.mink_image_refinements
          set result_url = ${url}, result_path = ${path}
          where id = ${refinementId}::uuid and store_id = ${actor.storeId}::uuid
        `);
        // ★ In the Media Library too, so the refined copy can be found and
        //   reused like any other upload.
        await db.insert(mediaAssets).values({
          storeId: actor.storeId,
          url,
          path,
          filename: `refined-${specKey}-${spec.width}x${spec.height}.webp`,
          contentType: "image/webp",
          sizeBytes: output.length,
          createdBy: actor.adminId,
          source: "mink_refined",
        });
      }
      return charged;
    });
  } catch (error) {
    await gcsDeletePaths([path]).catch(() => []);
    logError("mink refine charge failed", error, { refinementId });
    throw new MinkRequestError(
      "refine_charge_failed",
      "The refined photo couldn't be saved. Nothing was charged; try again.",
      503,
    );
  }
  if (chargeSource === "insufficient") {
    // Spent elsewhere between the check and now.
    await gcsDeletePaths([path]).catch(() => []);
    throw insufficient();
  }

  return {
    url,
    width: spec.width,
    height: spec.height,
    chargedCredits:
      chargeSource === "plan_unlimited" ? 0 : IMAGE_REFINE_CREDITS,
  };
}

function insufficient(): MinkRequestError {
  return new MinkRequestError(
    "refine_insufficient_credits",
    "This store doesn't have enough Mink credits left to refine a photo. Buy Mink credits or upgrade under Plans & Billing.",
    402,
  );
}

async function callRefineModel(
  config: MinkConfig,
  spec: ImageSpec,
  source: Buffer,
): Promise<Buffer> {
  const ai = new GoogleGenAI({
    enterprise: true,
    project: config.projectId ?? undefined,
    location: config.imageLocation,
    apiVersion: "v1",
    // One attempt: a retry is a second provider charge.
    httpOptions: { retryOptions: { attempts: 1 } },
  });

  let response;
  try {
    response = await ai.models.generateContent({
      model: config.imageModel,
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
          imageSize: "2K",
          personGeneration: "ALLOW_ADULT",
          prominentPeople: ProminentPeople.BLOCK_PROMINENT_PEOPLE,
          outputMimeType: "image/jpeg",
          outputCompressionQuality: 95,
        },
        abortSignal: AbortSignal.timeout(REFINE_TIMEOUT_MS),
      },
    });
  } catch (error) {
    logError("mink refine provider failed", error, {
      model: config.imageModel,
      location: config.imageLocation,
    });
    throw new MinkRequestError(
      "refine_provider_unavailable",
      "Mink AI didn't respond. Nothing was charged; try again shortly.",
      503,
    );
  }

  const candidate = response.candidates?.[0];
  const data = candidate?.content?.parts?.find((part) =>
    Boolean(part.inlineData?.data),
  )?.inlineData?.data;
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
