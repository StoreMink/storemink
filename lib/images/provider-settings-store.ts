import "server-only";

import { eq } from "drizzle-orm";
import { imageGenerationSettings } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logWarn } from "@/lib/observability/logger";
import {
  DEFAULT_ELEVENLABS_IMAGE_QUALITY,
  DEFAULT_ELEVENLABS_IMAGE_RESOLUTION,
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  DEFAULT_IMAGE_PROVIDER,
  isElevenLabsImageQuality,
  isElevenLabsImageResolution,
  isImageProvider,
  type ImageGenerationSettings,
} from "./provider-settings";

/**
 * The operator's image settings, read when a job starts drawing.
 *
 * ★ A failed read, or a row from before the migration, is the DEFAULT
 *   (Google): which provider draws is never a reason for a job to fail.
 */
export async function getImageGenerationSettings(): Promise<ImageGenerationSettings> {
  try {
    const [row] = await withService((db) =>
      db
        .select({
          provider: imageGenerationSettings.provider,
          quality: imageGenerationSettings.elevenlabsQuality,
          resolution: imageGenerationSettings.elevenlabsResolution,
        })
        .from(imageGenerationSettings)
        .where(eq(imageGenerationSettings.id, true))
        .limit(1),
    );
    return {
      provider: isImageProvider(row?.provider)
        ? row.provider
        : DEFAULT_IMAGE_PROVIDER,
      elevenlabsQuality: isElevenLabsImageQuality(row?.quality)
        ? row.quality
        : DEFAULT_ELEVENLABS_IMAGE_QUALITY,
      elevenlabsResolution: isElevenLabsImageResolution(row?.resolution)
        ? row.resolution
        : DEFAULT_ELEVENLABS_IMAGE_RESOLUTION,
    };
  } catch {
    return { ...DEFAULT_IMAGE_GENERATION_SETTINGS };
  }
}

/** ElevenLabs' API key, or null when this environment has none. */
export function elevenLabsApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  return env.ELEVENLABS_API_KEY?.trim() || null;
}

/**
 * Whether this environment has declared that its ElevenLabs key is used by
 * NO other environment (`ELEVENLABS_KEY_EXCLUSIVE=true`).
 *
 * ★★ WHY IT IS ASKED (PR #303 re-review, 22 Nov 2026). When a submit's answer
 * is lost, its job is looked for in the provider's job list, and a job made
 * in those seconds that this environment's record does not hold is taken as
 * that submit's (elevenlabs-lost-jobs.ts). The record is this environment's
 * alone, and a job shows no prompt, so a job made in the same seconds by
 * ANOTHER environment on the same key (a laptop, staging) would be taken too:
 * one store's page would get a picture drawn from another's prompt and
 * product photos. Nothing in the provider's API can tell the two apart, so
 * the search runs only where an operator has said the key is not shared.
 * ★ Off by default, which is the safe side: a lost submit then behaves as it
 * did before the search existed (the picture may be paid for twice).
 */
export function elevenLabsKeyIsExclusive(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.ELEVENLABS_KEY_EXCLUSIVE?.trim().toLowerCase() === "true";
}

/**
 * The provider that will really draw: ElevenLabs only when the operator chose
 * it AND this environment holds its key. ★ A missing key falls back to
 * Google and says so in the log; it never fails a merchant's redesign.
 */
export async function resolveImageProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ImageGenerationSettings> {
  const settings = await getImageGenerationSettings();
  if (settings.provider === "elevenlabs" && !elevenLabsApiKey(env)) {
    logWarn("images.provider: ElevenLabs is chosen but has no API key", {
      fallback: "google",
    });
    return { ...settings, provider: "google" };
  }
  return settings;
}
