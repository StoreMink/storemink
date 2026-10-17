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
import {
  gcsDeletePaths,
  gcsDownloadObject,
  gcsUploadObject,
} from "@/lib/storage/gcs";
import { storeStoragePrefix } from "@/lib/storage/paths";
import { IMAGE_SCENE_CREDITS, type ImageSpec } from "@/lib/media/image-specs";
import { scenePrompt, type ScenePreset } from "@/lib/media/scene-presets";
import { logError } from "@/lib/observability/logger";
import { getMinkConfig, type MinkConfig } from "./config";
import { MinkRequestError } from "./errors";
import { canAfford, type ImageCreditHeadroom } from "./image-credits";
import { reserveMinkImageGeneration } from "./media-generation";
import { assertMediaGenerationAuthority } from "./media-image-proposals";
import type { MinkActorContext } from "./types";

// ---------------------------------------------------------------------------
// Scenes for Change background: an EMPTY set (a marble counter, a linen
// cloth) drawn by Mink's image model, into which the merchant's real cut-out
// is then placed (lib/media/background-render.ts renderOnScene).
//
// ★★ THE MODEL NEVER SEES OR DRAWS THE PRODUCT. The request is text only and
//    asks for a set with nothing on it; the product is copied in afterwards.
// ★ ONE SCENE PER PRESET AND SHAPE, REUSED. A store's marble scene at 3:4 is
//   used for every product placed on marble after it, free, so a catalogue
//   reads as one shoot and the merchant pays for the set once. Drawing a
//   fresh one is an explicit choice ("Draw a new scene"), charged again.
// ★ PRICE: IMAGE_SCENE_CREDITS (5), the owner's price at the real cost of one
//   Gemini 3.1 Flash Image call. Charged only after the scene exists and is
//   stored, atomically and idempotently (consume_mink_scene_credits); a store
//   that cannot pay is refused before the model is called.
// ★ GATES ARE MINK IMAGE GENERATION'S, like Refine: Mink enabled, Media
//   manage, the store's image-generation switch, and the same spend ceiling,
//   claimed before the provider call. People are never drawn (ALLOW_NONE).
// ---------------------------------------------------------------------------

export const SCENE_FOLDER = "scenes";
const SCENE_TIMEOUT_MS = 60_000;
const SCENE_MAX_BYTES = 16 * 1024 * 1024;

const SAFETY_CATEGORIES = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
] as const;

export interface StoredScene {
  id: string;
  preset: string;
  url: string;
  path: string;
  createdAt: string;
}

export interface SceneForUse {
  id: string;
  url: string;
  bytes: Buffer;
  /** Credits this request was charged for the scene: 0 when reused. */
  chargedCredits: number;
  created: boolean;
}

type SharpFactory = (input: Buffer) => import("sharp").Sharp;
async function loadSharp(): Promise<SharpFactory> {
  const mod = await import("sharp");
  return mod.default as unknown as SharpFactory;
}

/** The newest scene per preset this store has for a frame of `size`. */
export async function listStoreScenes(
  storeId: string,
  size: { width: number; height: number },
): Promise<StoredScene[]> {
  const rows = await withService(async (db) => {
    const res = await db.execute(sql`
      select distinct on (preset)
        id::text as id, preset, scene_url as url, scene_path as path,
        created_at::text as created_at
      from public.mink_image_scenes
      where store_id = ${storeId}::uuid
        and width = ${size.width} and height = ${size.height}
      order by preset, created_at desc
    `);
    return res.rows as {
      id: string;
      preset: string;
      url: string;
      path: string;
      created_at: string;
    }[];
  });
  return rows.map((row) => ({
    id: row.id,
    preset: row.preset,
    url: row.url,
    path: row.path,
    createdAt: row.created_at,
  }));
}

/** The newest scene for one preset and frame, or null. */
export async function findStoreScene(
  storeId: string,
  preset: string,
  size: { width: number; height: number },
): Promise<StoredScene | null> {
  const rows = await withService(async (db) => {
    const res = await db.execute(sql`
      select id::text as id, preset, scene_url as url, scene_path as path,
        created_at::text as created_at
      from public.mink_image_scenes
      where store_id = ${storeId}::uuid and preset = ${preset}
        and width = ${size.width} and height = ${size.height}
      order by created_at desc
      limit 1
    `);
    return res.rows as {
      id: string;
      preset: string;
      url: string;
      path: string;
      created_at: string;
    }[];
  });
  const row = rows[0];
  return row
    ? {
        id: row.id,
        preset: row.preset,
        url: row.url,
        path: row.path,
        createdAt: row.created_at,
      }
    : null;
}

/** The checks a NEW scene needs before anything is spent. */
export async function assertSceneGenerationAllowed(
  actor: MinkActorContext,
): Promise<MinkConfig> {
  const config = getMinkConfig();
  if (!config.enabled || !config.projectId) {
    throw new MinkRequestError(
      "scene_not_available",
      "New scenes are not available right now. White, colour and transparent backgrounds still work.",
      503,
    );
  }
  await assertMediaGenerationAuthority(actor);
  return config;
}

/**
 * A stored scene's bytes, or a new scene drawn, stored and charged.
 * `existing` is the store's newest scene for this preset and frame, already
 * looked up by the caller; `fresh` asks for a new one anyway.
 */
export async function getOrCreateScene(input: {
  actor: MinkActorContext;
  preset: ScenePreset;
  spec: ImageSpec;
  existing: StoredScene | null;
  fresh: boolean;
  /** Set when the caller already checked a new scene may be drawn. */
  config: MinkConfig | null;
  headroom: ImageCreditHeadroom;
}): Promise<SceneForUse> {
  const { actor, preset, spec } = input;
  if (input.existing && !input.fresh) {
    try {
      const bytes = Buffer.from(
        await gcsDownloadObject(input.existing.path, SCENE_MAX_BYTES),
      );
      return {
        id: input.existing.id,
        url: input.existing.url,
        bytes,
        chargedCredits: 0,
        created: false,
      };
    } catch (error) {
      // Its file is gone: draw a new one below.
      logError("scene: stored scene unreadable", error, {
        sceneId: input.existing.id,
      });
    }
  }

  // A draw the caller did not plan for (the stored scene's file was lost):
  // ask now what it would have asked up front.
  const config = input.config ?? (await assertSceneGenerationAllowed(actor));
  if (!input.config && !canAfford(input.headroom, IMAGE_SCENE_CREDITS)) {
    throw sceneInsufficient();
  }
  const sceneId = crypto.randomUUID();
  await reserveMinkImageGeneration(actor, sceneId);

  const drawn = await callSceneModel(config, preset, spec);
  let bytes: Buffer;
  try {
    const sharp = await loadSharp();
    bytes = await sharp(drawn)
      .resize(spec.width, spec.height, { fit: "cover", position: "centre" })
      .webp({ quality: 92 })
      .toBuffer();
  } catch (error) {
    logError("scene: output processing failed", error, {});
    throw new MinkRequestError(
      "scene_output_unreadable",
      "The scene couldn't be processed. Nothing was charged for it; try again.",
      502,
    );
  }

  const path = `${storeStoragePrefix(actor.storeId)}${SCENE_FOLDER}/${sceneId}.webp`;
  let url: string;
  try {
    url = await gcsUploadObject(path, bytes, "image/webp");
  } catch (error) {
    logError("scene: upload failed", error, { path });
    throw new MinkRequestError(
      "scene_storage_failed",
      "The scene couldn't be stored. Nothing was charged for it; try again.",
      503,
    );
  }

  let source: string;
  try {
    source = await withService(async (db) => {
      const res = await db.execute(sql`
        select public.consume_mink_scene_credits(
          p_scene => ${sceneId}::uuid,
          p_store => ${actor.storeId}::uuid,
          p_admin => ${actor.adminId},
          p_preset => ${preset.id},
          p_width => ${spec.width},
          p_height => ${spec.height},
          p_scene_url => ${url},
          p_scene_path => ${path},
          p_model => ${config.imageModel},
          p_period => ${input.headroom.period},
          p_plan_cap => ${input.headroom.planCap},
          p_credits => ${IMAGE_SCENE_CREDITS}
        ) as source
      `);
      return String(
        (res.rows[0] as { source?: string } | undefined)?.source ??
          "insufficient",
      );
    });
  } catch (error) {
    await gcsDeletePaths([path]).catch(() => []);
    logError("scene: charge failed", error, { sceneId });
    throw new MinkRequestError(
      "scene_charge_failed",
      "The scene couldn't be saved. Nothing was charged for it; try again.",
      503,
    );
  }
  if (source === "insufficient") {
    await gcsDeletePaths([path]).catch(() => []);
    throw sceneInsufficient();
  }
  return {
    id: sceneId,
    url,
    bytes,
    chargedCredits: source === "plan_unlimited" ? 0 : IMAGE_SCENE_CREDITS,
    created: true,
  };
}

export function sceneInsufficient(): MinkRequestError {
  return new MinkRequestError(
    "scene_insufficient_credits",
    `A new scene uses ${IMAGE_SCENE_CREDITS} Mink credits, and this store doesn't have enough left. Buy Mink credits or upgrade under Plans & Billing.`,
    402,
  );
}

/**
 * One scene from the model. ★ A REFUSAL WITH NO IMAGE IS ASKED ONCE MORE: the
 * safety filter sometimes refuses an innocent empty set (seen live on the
 * marble preset, 2026-10-17), and a refusal bills only the ~300 prompt tokens
 * (a fraction of a paisa), so a second try costs nothing worth refusing the
 * merchant over. A provider ERROR is not retried: it may have been billed.
 */
async function callSceneModel(
  config: MinkConfig,
  preset: ScenePreset,
  spec: ImageSpec,
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
          { role: "user", parts: [{ text: scenePrompt(preset, spec) }] },
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
            personGeneration: "ALLOW_NONE",
            prominentPeople: ProminentPeople.BLOCK_PROMINENT_PEOPLE,
            outputMimeType: "image/jpeg",
            outputCompressionQuality: 95,
          },
          abortSignal: AbortSignal.timeout(SCENE_TIMEOUT_MS),
        },
      });
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status === 429) {
        // The project's image quota: refused before any image was drawn.
        throw new MinkRequestError(
          "scene_busy",
          "Mink AI is drawing a lot of images right now. Nothing was charged for the scene; try again in a minute.",
          429,
        );
      }
      logError("scene: provider failed", error, {
        model: config.imageModel,
        location: config.imageLocation,
      });
      throw new MinkRequestError(
        "scene_provider_unavailable",
        "Mink AI didn't respond. Nothing was charged for the scene; try again shortly.",
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
    "scene_refused",
    reason && /safety/i.test(reason)
      ? "Mink AI's safety check stopped this scene. Nothing was charged for it; try again, or choose another scene."
      : reason
        ? `Mink AI couldn't draw this scene (${reason}). Nothing was charged for it.`
        : "Mink AI returned no scene. Nothing was charged for it; try again.",
    422,
  );
}
