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
  IMAGE_EDIT_CREDITS,
  IMAGE_SPECS,
  type ImageSpec,
  type ImageSpecKey,
} from "@/lib/media/image-specs";
import { EDITED_FOLDER } from "@/lib/media/background-edit";
import {
  normalizeEditInstruction,
  photoEditPrompt,
} from "@/lib/media/photo-edit";
import { logError } from "@/lib/observability/logger";
import { getMinkConfig, type MinkConfig } from "./config";
import { MinkRequestError } from "./errors";
import { canAfford, imageCreditHeadroom } from "./image-credits";
import { reserveMinkImageGeneration } from "./media-generation";
import { assertMediaGenerationAuthority } from "./media-image-proposals";
import type { MinkActorContext } from "./types";

// ---------------------------------------------------------------------------
// AI product photography from the photo editor: the merchant's own photo is
// sent to Mink's image model with their request ("on a marble counter",
// "hanging from a tree in a garden") and comes back re-shot in that scene, at
// exactly the size its upload slot renders at.
//
// ★★ THE MODEL REDRAWS THE PRODUCT, deliberately (lib/media/photo-edit.ts
//    says why). The original is never touched: the result is a new object,
//    the merchant sees both and must choose "Use this photo".
// ★ PRICE: IMAGE_EDIT_CREDITS per photo created, charged only after the photo
//   exists and is stored, atomically and idempotently
//   (consume_mink_photo_edit_credits, migration 0222). A store that cannot pay
//   is refused before the model is called; a refusal or a failure is free.
// ★ GATES ARE MINK IMAGE GENERATION'S, like Refine: Mink enabled, Media
//   manage, the store's image-generation switch, and the same spend ceiling,
//   claimed before the provider call.
// ★ PEOPLE: the call allows adults (a model wearing the product is a normal
//   request) and blocks prominent people; the prompt adds a person only when
//   the merchant asked for one.
// ---------------------------------------------------------------------------

const EDIT_TIMEOUT_MS = 90_000;
/** Source download ceiling; uploads are capped at 5 MiB, this allows headroom. */
const SOURCE_MAX_BYTES = 12 * 1024 * 1024;
/** The source is downscaled to this before it is sent: enough detail, bounded cost. */
const SOURCE_MAX_EDGE = 2048;

const SAFETY_CATEGORIES = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
] as const;

export interface EditedPhoto {
  id: string;
  url: string;
  width: number;
  height: number;
  chargedCredits: number;
}

type SharpFactory = (input: Buffer) => import("sharp").Sharp;
// Imported lazily, as everywhere else: a missing native library must surface
// as this feature's error, not take the module (and the route) down with it.
async function loadSharp(): Promise<SharpFactory> {
  const mod = await import("sharp");
  return mod.default as unknown as SharpFactory;
}

export async function editProductPhoto(input: {
  actor: MinkActorContext;
  sourceUrl: string;
  specKey: ImageSpecKey;
  instruction: string;
}): Promise<EditedPhoto> {
  const { actor, specKey } = input;
  const spec: ImageSpec = IMAGE_SPECS[specKey];
  if (!spec.background) {
    throw new MinkRequestError(
      "edit_not_offered",
      `${spec.label} images can't be re-shot in a scene.`,
      400,
    );
  }
  const instruction = normalizeEditInstruction(input.instruction);
  if (!instruction) {
    throw new MinkRequestError(
      "edit_instruction_missing",
      "Choose a scene or describe one first.",
      400,
    );
  }
  const config = getMinkConfig();
  if (!config.enabled || !config.projectId || !gcsConfigured) {
    throw new MinkRequestError(
      "edit_not_available",
      "Scenes are not available right now. White, colour and transparent backgrounds still work.",
      503,
    );
  }
  await assertMediaGenerationAuthority(actor);

  const sourcePath = ownedObjectPath(input.sourceUrl, actor.storeId);
  if (!sourcePath) {
    throw new MinkRequestError(
      "edit_source_not_owned",
      "Upload the photo here first, then choose a scene.",
      400,
    );
  }

  // ★ Can the store pay? Asked before the model is called, so a store with no
  //   credits left is not handed a photo it then cannot keep.
  const headroom = await imageCreditHeadroom(actor, config.chargeCredits);
  if (!canAfford(headroom, IMAGE_EDIT_CREDITS)) throw editInsufficient();

  const editId = crypto.randomUUID();
  await reserveMinkImageGeneration(actor, editId);

  let source: Buffer;
  try {
    const raw = await gcsDownloadObject(sourcePath, SOURCE_MAX_BYTES);
    const sharp = await loadSharp();
    source = await sharp(Buffer.from(raw))
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize(SOURCE_MAX_EDGE, SOURCE_MAX_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (error) {
    logError("photo edit: source read failed", error, { sourcePath });
    throw new MinkRequestError(
      "edit_source_unreadable",
      "That photo couldn't be read. Try uploading it again.",
      400,
    );
  }

  const generated = await callEditModel(config, spec, instruction, source);

  // ★ EXACT SIZE, ALWAYS. The model honours the aspect ratio approximately
  //   (it rounds to its own tile grid), so the result is fitted here.
  let output: Buffer;
  try {
    const sharp = await loadSharp();
    output = await sharp(generated)
      .resize(spec.width, spec.height, { fit: "cover", position: "centre" })
      .webp({ quality: 90 })
      .toBuffer();
  } catch (error) {
    logError("photo edit: output processing failed", error, {});
    throw new MinkRequestError(
      "edit_output_unreadable",
      "The new photo couldn't be processed. Nothing was charged; try again.",
      502,
    );
  }

  const path = `${storeStoragePrefix(actor.storeId)}${EDITED_FOLDER}/ai-${editId}.webp`;
  let url: string;
  try {
    url = await gcsUploadObject(path, output, "image/webp");
  } catch (error) {
    logError("photo edit: upload failed", error, { path });
    throw new MinkRequestError(
      "edit_storage_failed",
      "The new photo couldn't be stored. Nothing was charged; try again.",
      503,
    );
  }

  let charged: string;
  try {
    charged = await withService(async (db) => {
      const res = await db.execute(sql`
        select public.consume_mink_photo_edit_credits(
          p_edit => ${editId}::uuid,
          p_store => ${actor.storeId}::uuid,
          p_admin => ${actor.adminId},
          p_destination => ${specKey},
          p_width => ${spec.width},
          p_height => ${spec.height},
          p_source_url => ${input.sourceUrl},
          p_instruction => ${instruction},
          p_result_url => ${url},
          p_result_path => ${path},
          p_model => ${config.imageModel},
          p_period => ${headroom.period},
          p_plan_cap => ${headroom.planCap},
          p_credits => ${IMAGE_EDIT_CREDITS}
        ) as source
      `);
      const source = String(
        (res.rows[0] as { source?: string } | undefined)?.source ??
          "insufficient",
      );
      if (source !== "insufficient") {
        // The row that proves the store owns the file, so the product save
        // and Mink accept it; hidden from the Library like every other edit.
        await db.insert(mediaAssets).values({
          storeId: actor.storeId,
          url,
          path,
          filename: `scene-${specKey}-${spec.width}x${spec.height}.webp`,
          contentType: "image/webp",
          sizeBytes: output.length,
          createdBy: actor.adminId,
          source: "mink_edited",
        });
      }
      return source;
    });
  } catch (error) {
    await gcsDeletePaths([path]).catch(() => []);
    logError("photo edit: charge failed", error, { editId });
    throw new MinkRequestError(
      "edit_charge_failed",
      "The new photo couldn't be saved. Nothing was charged; try again.",
      503,
    );
  }
  if (charged === "insufficient") {
    // Spent elsewhere between the check and now.
    await gcsDeletePaths([path]).catch(() => []);
    throw editInsufficient();
  }

  return {
    id: editId,
    url,
    width: spec.width,
    height: spec.height,
    chargedCredits: charged === "plan_unlimited" ? 0 : IMAGE_EDIT_CREDITS,
  };
}

export function editInsufficient(): MinkRequestError {
  return new MinkRequestError(
    "edit_insufficient_credits",
    "This store doesn't have enough Mink credits left for a scene photo. Buy Mink credits or upgrade under Plans & Billing.",
    402,
  );
}

/**
 * One photo from the model. ★ A REFUSAL WITH NO IMAGE IS ASKED ONCE MORE: the
 * safety filter sometimes refuses an innocent request (seen live on an empty
 * marble set, 2026-10-17), and a refusal bills only the prompt tokens, so a
 * second try costs nothing worth refusing the merchant over. A provider ERROR
 * is not retried: it may have been billed. A project quota 429 is "busy".
 */
async function callEditModel(
  config: MinkConfig,
  spec: ImageSpec,
  instruction: string,
  source: Buffer,
): Promise<Buffer> {
  const ai = new GoogleGenAI({
    enterprise: true,
    project: config.projectId ?? undefined,
    location: config.imageLocation,
    apiVersion: "v1",
    // The SDK never retries: a retry after an error may be a second charge.
    httpOptions: { retryOptions: { attempts: 1 } },
  });

  let reason: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await ai.models.generateContent({
        model: config.imageModel,
        contents: [
          {
            role: "user",
            parts: [
              { text: photoEditPrompt(instruction, spec) },
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
          abortSignal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
        },
      });
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status === 429) {
        // The project's image quota: refused before any image was drawn.
        throw new MinkRequestError(
          "edit_busy",
          "Mink AI is creating a lot of photos right now. Nothing was charged; try again in a minute.",
          429,
        );
      }
      logError("photo edit: provider failed", error, {
        model: config.imageModel,
        location: config.imageLocation,
      });
      throw new MinkRequestError(
        "edit_provider_unavailable",
        "Mink AI didn't respond. Nothing was charged; try again shortly.",
        503,
      );
    }

    const candidate = response.candidates?.[0];
    const data = candidate?.content?.parts?.find((part) =>
      Boolean(part.inlineData?.data),
    )?.inlineData?.data;
    if (data) return Buffer.from(data, "base64");

    reason =
      response.promptFeedback?.blockReasonMessage?.trim() ||
      candidate?.finishMessage?.trim() ||
      (candidate?.finishReason && candidate.finishReason !== "STOP"
        ? String(candidate.finishReason)
        : undefined);
    // An image was produced (and billed) but not returned: do not pay twice.
    if ((response.usageMetadata?.candidatesTokenCount ?? 0) > 0) break;
  }

  throw new MinkRequestError(
    "edit_refused",
    reason && /safety|person|people/i.test(reason)
      ? "Mink AI's safety check stopped this photo. Nothing was charged; describe the scene differently and try again."
      : reason
        ? `Mink AI couldn't create this photo (${reason}). Nothing was charged.`
        : "Mink AI returned no photo. Nothing was charged; try again.",
    422,
  );
}
