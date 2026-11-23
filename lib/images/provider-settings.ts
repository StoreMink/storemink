/**
 * Which provider draws Theme Studio's and the storefront redesign's photos,
 * as a platform operator sets it (migration 0284). Client-safe: no imports.
 *
 * ★ TWO PROVIDERS. Google's Nano Banana 2.1 on Vertex (the default, and what
 *   every other picture in StoreMink is drawn with) and GPT Image 2.5
 *   Sunburst through ElevenLabs' Image API (owner, 22 Nov 2026). Google caps
 *   image starts at two a minute for the whole project; ElevenLabs took five
 *   and ten at once in the 22 Nov test.
 * ★ ELEVENLABS' QUALITY IS ALWAYS SENT. The API's own default is `high`,
 *   which costs more; only `low` and `medium` are ever asked for.
 */
export const IMAGE_PROVIDERS = ["google", "elevenlabs"] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];
export const DEFAULT_IMAGE_PROVIDER: ImageProvider = "google";

export const ELEVENLABS_IMAGE_QUALITIES = ["low", "medium"] as const;
export type ElevenLabsImageQuality =
  (typeof ELEVENLABS_IMAGE_QUALITIES)[number];
export const DEFAULT_ELEVENLABS_IMAGE_QUALITY: ElevenLabsImageQuality = "low";

export const ELEVENLABS_IMAGE_RESOLUTIONS = ["1K", "2K"] as const;
export type ElevenLabsImageResolution =
  (typeof ELEVENLABS_IMAGE_RESOLUTIONS)[number];
export const DEFAULT_ELEVENLABS_IMAGE_RESOLUTION: ElevenLabsImageResolution =
  "1K";

export interface ImageGenerationSettings {
  provider: ImageProvider;
  elevenlabsQuality: ElevenLabsImageQuality;
  elevenlabsResolution: ElevenLabsImageResolution;
}

export const DEFAULT_IMAGE_GENERATION_SETTINGS: ImageGenerationSettings =
  Object.freeze({
    provider: DEFAULT_IMAGE_PROVIDER,
    elevenlabsQuality: DEFAULT_ELEVENLABS_IMAGE_QUALITY,
    elevenlabsResolution: DEFAULT_ELEVENLABS_IMAGE_RESOLUTION,
  });

export const IMAGE_PROVIDER_LABELS: Record<ImageProvider, string> = {
  google: "Google Nano Banana 2.1",
  elevenlabs: "GPT Image 2.5 Sunburst (ElevenLabs)",
};
export const ELEVENLABS_IMAGE_QUALITY_LABELS: Record<
  ElevenLabsImageQuality,
  string
> = { low: "Low", medium: "Medium" };
export const ELEVENLABS_IMAGE_RESOLUTION_LABELS: Record<
  ElevenLabsImageResolution,
  string
> = { "1K": "1K", "2K": "2K" };

export function isImageProvider(value: unknown): value is ImageProvider {
  return IMAGE_PROVIDERS.includes(value as ImageProvider);
}
export function isElevenLabsImageQuality(
  value: unknown,
): value is ElevenLabsImageQuality {
  return ELEVENLABS_IMAGE_QUALITIES.includes(value as ElevenLabsImageQuality);
}
export function isElevenLabsImageResolution(
  value: unknown,
): value is ElevenLabsImageResolution {
  return ELEVENLABS_IMAGE_RESOLUTIONS.includes(
    value as ElevenLabsImageResolution,
  );
}
