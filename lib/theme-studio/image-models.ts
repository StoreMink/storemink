import type { GenerateContentConfig } from "@google/genai";
import type { ThemePackageV2 } from "./contracts";
import { isAllowedProviderVersion } from "./models";

// ---------------------------------------------------------------------------
// The image model every picture StoreMink draws is made with, and the rules a
// request to it follows.
//
// ★★ ONE IMAGE MODEL: NANO BANANA 2.1 (owner, 25 Oct 2026: "use
// gemini-nano-banana-2.1 for all image generation tasks"). It draws Theme
// Studio's photos and the Mink storefront redesign's photos (this registry
// and image-vertex.ts), and every other Mink picture: chat images, storefront
// personalisation photos, the redesign's product re-shoots and Refine with
// Mink AI (lib/mink/config.ts imageModel, lib/mink/media-generation.ts).
// Verified live on storemink-staging on 25 Oct at the global endpoint with
// every request option this code sends: 2K at 4:3, 4:5, 1:1, 16:9 and 3:4,
// 4K at 21:9, thinking HIGH, MEDIUM and MINIMAL, inline references after a
// label, the four harm filters at BLOCK_LOW_AND_ABOVE, ALLOW_NONE and
// ALLOW_ADULT, prominent people blocked, one JPEG candidate at quality 95
// (revamp-handoff/scratchpad/theme-research/nano-banana-smoke-test.md).
// About $0.05 to $0.06 a 2K photo all in, against about $0.14 for Pro.
//
// History. Until 29 Sep 2026 Theme Studio drew with gemini-3.1-flash-image,
// the model merchant Mink called. ★ On 29 Sep the owner chose the Pro image
// model for every Theme Studio photo ("highest capacity, no limitation in
// terms of cost"): gemini-3-pro-image, verified live in storemink-prod with
// this client's configuration (a 1856x2304 4:5 JPEG in 26.4 s, 1,120 output
// tokens). The decision of 25 Oct replaces that rule, for Theme Studio and
// for Mink alike; Pro stays only as the owner's rollback below.
//
// ★ THE ROLLBACK IS THE OWNER'S, AND IT IS PRO OR NOTHING. An override
// (THEME_STUDIO_IMAGE_MODEL) may name the 2.1 family (the default, or a
// published version of it) or the Pro family (gemini-3-pro-image, or a
// published version of it), and nothing else: silently substituting another
// model is what the allowlist forbids (the text registry's rule).
// cloudbuild.yaml passes it from the _THEME_STUDIO_IMAGE_MODEL substitution,
// so switching back is one trigger substitution and a deploy. Mink keeps its
// own override (MINK_IMAGE_MODEL, from _MINK_IMAGE_MODEL).
// ---------------------------------------------------------------------------

/** ★★ The one image model (owner, 25 Oct 2026), served at `global`. */
export const THEME_STUDIO_IMAGE_MODEL_KEY = "gemini-nano-banana-2.1";

/** The owner's rollback, chosen only by THEME_STUDIO_IMAGE_MODEL. */
export const THEME_STUDIO_ROLLBACK_IMAGE_MODEL_KEY = "gemini-3-pro-image";

export type ThemeStudioImageModelKey =
  | typeof THEME_STUDIO_IMAGE_MODEL_KEY
  | typeof THEME_STUDIO_ROLLBACK_IMAGE_MODEL_KEY;

export interface ThemeStudioImageConfig {
  projectId: string;
  location: string;
  /** The family the model belongs to: 2.1, or the Pro rollback. */
  modelKey: ThemeStudioImageModelKey;
  /** The provider id actually sent: the key, or an allowed version of it. */
  providerModel: string;
}

/** The family an override names, each with its published versions; null
 *  for any other model. */
function imageModelFamily(model: string): ThemeStudioImageModelKey | null {
  if (isAllowedProviderVersion(THEME_STUDIO_IMAGE_MODEL_KEY, model)) {
    return THEME_STUDIO_IMAGE_MODEL_KEY;
  }
  if (isAllowedProviderVersion(THEME_STUDIO_ROLLBACK_IMAGE_MODEL_KEY, model)) {
    return THEME_STUDIO_ROLLBACK_IMAGE_MODEL_KEY;
  }
  return null;
}

/** Null when no Google Cloud project is configured (the offline fake runs). */
export function getThemeStudioImageConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ThemeStudioImageConfig | null {
  const projectId =
    env.THEME_STUDIO_GCP_PROJECT_ID?.trim() || env.GCP_PROJECT_ID?.trim();
  if (!projectId) return null;
  const override = env.THEME_STUDIO_IMAGE_MODEL?.trim();
  const modelKey = override
    ? imageModelFamily(override)
    : THEME_STUDIO_IMAGE_MODEL_KEY;
  if (!modelKey) {
    throw new Error(
      `THEME_STUDIO_IMAGE_MODEL must stay within the ${THEME_STUDIO_IMAGE_MODEL_KEY} model family, or name the ${THEME_STUDIO_ROLLBACK_IMAGE_MODEL_KEY} model family as the owner's rollback.`,
    );
  }
  return {
    projectId,
    location: env.THEME_STUDIO_IMAGE_LOCATION?.trim() || "global",
    modelKey,
    providerModel: override || modelKey,
  };
}

// ── The size a picture is drawn at ──────────────────────────────────────────

/** The sizes the image model draws at, case-sensitive (Google's
 *  `imageConfig.imageSize`): about 1, 4 and 16 megapixels. */
export const IMAGE_SIZES = ["1K", "2K", "4K"] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number];

/**
 * A size a caller may name: one of the three, or a legacy "512" or "0.5K".
 * ★ 2.1 refuses those two with 400 INVALID_ARGUMENT (the 25 Oct smoke test,
 * a free refusal), so a request to 2.1 asks for "1K" instead (owner's spec,
 * section 3). No caller names one today: every call site states "2K", and
 * Theme Studio's homepage hero slides "4K".
 */
export type RequestedImageSize = ImageSize | "512" | "0.5K";

const KNOWN_SIZES: ReadonlySet<string> = new Set<string>(IMAGE_SIZES);
const LEGACY_SIZES: ReadonlySet<string> = new Set(["512", "0.5K"]);

/**
 * ★ The one frame StoreMink draws whose 1K picture is narrower than
 * Theme Studio's 800 px storefront minimum (THEME_IMAGE_RULES.minWidth,
 * which prepareSlotImage refuses below): 9:16, 768x1376 at 1K in Google's
 * size table for its Gemini 3 image models. A legacy "512" or "0.5K" asked
 * of 2.1 at this frame becomes "2K" (1536 px wide), the smallest size whose
 * picture StoreMink's own checks accept, never "1K".
 */
const NARROWER_THAN_MINIMUM_AT_1K: ReadonlySet<string> = new Set(["9:16"]);

/**
 * ★★ THEME STUDIO'S PHOTO SIZE (owner, 25 Oct 2026): "2K", and "4K" for the
 * homepage's hero slides only. A hero slide is a photo the homepage opens
 * with (`homepageOpeningPhotoIds`: the slides of its first section's
 * hero_carousel, or the photo of a fullbleed hero there, opening.ts) whose
 * purpose is "hero" in a wide frame (16:9 or 21:9), as the image prompt
 * draws "a wide establishing scene for the top of the homepage"
 * (image-prompt.ts compositionFor; prompts.ts asks for 21:9, or 16:9 for a
 * squarer scene). ★ Every other photo is "2K", a wide banner hero that opens
 * another page included (prompts.ts lets one open a story or promo page; on
 * 4 Oct story-page-hero, promo-tasting-box and others were such heroes):
 * the request alone cannot tell them apart, so the caller names the
 * homepage's slides (worker.ts imageClientFor), and a caller that names none
 * draws everything at "2K". The stored picture is 2,400 px across either way
 * (slot-images-core.ts SLOT_IMAGE_WIDE_LONG_EDGE); a 4K draw (6336x2688 at
 * 21:9 on 25 Oct) is the owner's choice for the sharpest homepage hero, at
 * about twice a 2K hero's price and about 17 s longer.
 */
export function themeStudioImageSize(
  request: { purpose: string; aspectRatio: string; briefId?: string },
  homepageSlides: ReadonlySet<string> = NO_SLIDES,
): ImageSize {
  return request.purpose === "hero" &&
    isWideFrame(request.aspectRatio) &&
    request.briefId !== undefined &&
    homepageSlides.has(request.briefId)
    ? "4K"
    : "2K";
}

const NO_SLIDES: ReadonlySet<string> = new Set();

/**
 * The asset ids of the photos the homepage opens with: each slide's photo
 * when its first enabled section is a hero_carousel, or the photo of a
 * fullbleed hero there (opening.ts, the opening every Studio homepage must
 * have). A photo's image request names its slot by that id (`briefId`).
 * Empty when the homepage opens any other way.
 */
export function homepageOpeningPhotoIds(pkg: ThemePackageV2): Set<string> {
  const home = pkg.definition.preset.pages.find((page) => page.slug === "");
  const first = home?.sections.find((section) => section.enabled !== false);
  const config = (first?.config ?? {}) as Record<string, unknown>;
  const urls: unknown[] =
    first?.type === "hero_carousel"
      ? (Array.isArray(config.slides) ? config.slides : []).map(
          (slide) => (slide as { image_url?: unknown } | null)?.image_url,
        )
      : first?.type === "hero" && config.variant === "fullbleed"
        ? [config.image_url]
        : [];
  const paths = new Set(
    urls.filter((url): url is string => typeof url === "string" && !!url),
  );
  return new Set(
    pkg.assets.filter((asset) => paths.has(asset.path)).map((a) => a.id),
  );
}

/** 16:9 and wider, as image-prompt.ts reads a frame as wide. */
function isWideFrame(ratio: string): boolean {
  const [w, h] = ratio.split(":").map(Number);
  return w > 0 && h > 0 && w / h >= 16 / 9;
}

// ── The rules a request to the image model follows ──────────────────────────

/** Whether `model` is Nano Banana 2.1, or a published version of it. */
export function isNanoBanana21(model: string): boolean {
  return isAllowedProviderVersion(THEME_STUDIO_IMAGE_MODEL_KEY, model);
}

/**
 * The request fields that steer sampling. ★ Google documents that 2.1
 * refuses every one of them with an error (the 25 Oct research); on 25 Oct
 * a temperature was in fact accepted, so none is ever sent to 2.1 and
 * nothing relies on a refusal to catch one.
 */
export const IMAGE_SAMPLING_PARAMETERS = [
  "temperature",
  "topP",
  "topK",
  "seed",
  "presencePenalty",
  "frequencyPenalty",
  "responseLogprobs",
  "logprobs",
] as const satisfies readonly (keyof GenerateContentConfig)[];

/**
 * ★★ THE ONE PLACE AN IMAGE REQUEST IS FITTED TO THE MODEL THAT RECEIVES IT
 * (owner's spec, section 3, 25 Oct 2026). Theme Studio's client
 * (image-vertex.ts themeImageConfig) and Mink's (media-generation.ts
 * requestMinkImage, for chat images, personalisation photos, product
 * re-shoots and Refine) send every config through it.
 * - To 2.1: never a sampling parameter; `imageSize` only "1K", "2K" or "4K",
 *   a legacy "512" or "0.5K" asked for as "1K" (as "2K" at 9:16, see
 *   NARROWER_THAN_MINIMUM_AT_1K); the thinking level the caller stated,
 *   which every request to 2.1 must state.
 * - To any other model (the owner's rollback to Pro, or a MINK_IMAGE_MODEL
 *   override): no thinking config, as before 25 Oct (whether Pro or 3.1
 *   Flash takes a thinking level was never tested), and everything else as
 *   the caller gave it, its size and any sampling parameter included.
 * ★ Every request states its size: without one Google draws 1K, below what
 *   StoreMink stores, so a config with none, or with an unknown one, throws
 *   here, before anything is sent.
 */
export function imageRequestConfig(
  model: string,
  config: GenerateContentConfig,
): GenerateContentConfig {
  const size = config.imageConfig?.imageSize;
  if (!size || !(KNOWN_SIZES.has(size) || LEGACY_SIZES.has(size))) {
    throw new Error(
      `An image request must state its size (1K, 2K or 4K), not ${size === undefined ? "none" : JSON.stringify(size)}.`,
    );
  }
  const fitted: GenerateContentConfig = { ...config };
  if (!isNanoBanana21(model)) {
    delete fitted.thinkingConfig;
    return fitted;
  }
  if (!config.thinkingConfig?.thinkingLevel) {
    throw new Error(
      `A request to ${THEME_STUDIO_IMAGE_MODEL_KEY} must state its thinking level.`,
    );
  }
  for (const parameter of IMAGE_SAMPLING_PARAMETERS) delete fitted[parameter];
  fitted.imageConfig = {
    ...config.imageConfig,
    imageSize: LEGACY_SIZES.has(size)
      ? NARROWER_THAN_MINIMUM_AT_1K.has(config.imageConfig?.aspectRatio ?? "")
        ? "2K"
        : "1K"
      : size,
  };
  return fitted;
}
