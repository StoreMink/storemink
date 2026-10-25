import "server-only";

import { createHash } from "node:crypto";
import {
  ZERO_IMAGE_USAGE,
  aspectValue,
  assertThemeImageRequest,
  type ThemeImageAspectRatio,
  type ThemeStudioImageClient,
} from "./image-provider";
import { ZERO_USAGE, type ThemeStudioModelClient } from "./provider";

// ---------------------------------------------------------------------------
// The offline image client: deterministic pictures, no network, no cost.
//
// ★ SAME REQUEST, SAME BYTES. The picture is a two-colour gradient chosen from a
// hash of the request, so tests and the offline Studio flow can assert on exact
// digests and a retry reproduces what it replaced.
//
// ★ ITS OUTPUT GOES THROUGH THE REAL PIPELINE: a PNG at the requested ratio and
// the provider's long edge, so the crop and compress step (slot-images.ts
// prepareSlotImage) does exactly the work it does for a Gemini JPEG.
//
// Hooks, for exercising the unhappy paths without a provider: a prompt that
// contains [[fake-image:refuse]] is refused, [[fake-image:error]] fails as
// an unavailable provider, and [[fake-image:flaky]] is rate-limited the first
// time each brief is drawn by this client and drawn normally after — which is
// what a fill run (worker.ts) meets in production.
// ---------------------------------------------------------------------------

/** The long edge of a fake image: the provider's 2K. */
export const FAKE_IMAGE_LONG_EDGE = 2048;

/**
 * What the image model really returns at 2K, per ratio (Google's Gemini image
 * table; measured live: 4:3 2400x1792, 4:5 1856x2304, 21:9 3168x1344). Wide
 * ratios run past 2048, so a fake capped there is smaller than the real thing.
 */
export const FAKE_MODEL_IMAGE_SIZES: Readonly<
  Record<ThemeImageAspectRatio, { width: number; height: number }>
> = {
  "1:1": { width: 2048, height: 2048 },
  "2:3": { width: 1696, height: 2528 },
  "3:2": { width: 2528, height: 1696 },
  "3:4": { width: 1792, height: 2400 },
  "4:3": { width: 2400, height: 1792 },
  "4:5": { width: 1856, height: 2304 },
  "5:4": { width: 2304, height: 1856 },
  "9:16": { width: 1536, height: 2752 },
  "16:9": { width: 2752, height: 1536 },
  "21:9": { width: 3168, height: 1344 },
};

export interface FakeImageClientOptions {
  /**
   * "studio" (the default): the long edge is 2048, as Theme Studio's offline
   * flow and its pinned digests expect. "model": the image model's own 2K
   * sizes, for a caller whose later crops depend on the real pixel count
   * (the revamp's phone crop is cut from the stored wide photo, and a
   * 2048x878 hero leaves 702px, under the storefront's 800px floor).
   */
  size?: "studio" | "model";
}

/** Briefs a flaky hook has already failed once, per process. */
const flakyFailed = new Set<string>();

export function createFakeImageClient(
  options: FakeImageClientOptions = {},
): ThemeStudioImageClient {
  const modelSizes = options.size === "model";
  return {
    provider: "fake",
    async generateImage(request, signal) {
      assertThemeImageRequest(request);
      if (signal.aborted) {
        return { kind: "error", code: "cancelled", usage: ZERO_IMAGE_USAGE };
      }
      if (request.prompt.includes("[[fake-image:refuse]]")) {
        return {
          kind: "refused",
          reason: "IMAGE_SAFETY",
          usage: ZERO_IMAGE_USAGE,
        };
      }
      if (
        request.prompt.includes("[[fake-image:flaky]]") &&
        !flakyFailed.has(request.briefId)
      ) {
        flakyFailed.add(request.briefId);
        return { kind: "error", code: "rate_limited", usage: ZERO_IMAGE_USAGE };
      }
      if (request.prompt.includes("[[fake-image:error]]")) {
        return {
          kind: "error",
          code: "provider_unavailable",
          usage: ZERO_IMAGE_USAGE,
        };
      }

      const aspect = aspectValue(request.aspectRatio);
      const real = modelSizes
        ? FAKE_MODEL_IMAGE_SIZES[request.aspectRatio]
        : undefined;
      const width =
        real?.width ??
        (aspect >= 1
          ? FAKE_IMAGE_LONG_EDGE
          : Math.round(FAKE_IMAGE_LONG_EDGE * aspect));
      const height =
        real?.height ??
        (aspect >= 1
          ? Math.round(FAKE_IMAGE_LONG_EDGE / aspect)
          : FAKE_IMAGE_LONG_EDGE);
      const digest = createHash("sha256")
        .update(
          [
            request.purpose,
            request.briefId,
            request.aspectRatio,
            request.prompt,
            ...request.references.map((r) => `${r.role}:${r.base64.length}`),
          ].join("\n"),
        )
        .digest("hex");
      const from = `#${digest.slice(0, 6)}`;
      const to = `#${digest.slice(6, 12)}`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${Math.round(width / 2)}" cy="${Math.round(height / 2)}" r="${Math.round(Math.min(width, height) / 4)}" fill="${to}" fill-opacity="0.55"/></svg>`;
      const sharp = (await import("sharp")).default;
      const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
      return {
        kind: "ok",
        bytes: new Uint8Array(bytes),
        mediaType: "image/png",
        usage: ZERO_IMAGE_USAGE,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The offline image REVIEWER (Track 3.4): passes every image, no cost.
//
// Hooks, read from the brief the reviewer is shown: [[fake-review:<problem>]]
// reports that problem on a first attempt only, so the redraw passes;
// [[fake-review:<problem>:always]] reports it on every attempt.
// ---------------------------------------------------------------------------

export function createFakeImageReviewClient(): ThemeStudioModelClient {
  return {
    provider: "fake",
    async generate(request, signal) {
      if (signal.aborted) {
        return { kind: "error", code: "cancelled", usage: ZERO_USAGE };
      }
      const text = request.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      const redraw = text.includes("It is a redraw");
      const problems = [
        ...text.matchAll(/\[\[fake-review:([a-z_]+)(:always)?\]\]/g),
      ]
        .filter((match) => match[2] || !redraw)
        .map((match) => match[1]);
      return {
        kind: "ok",
        usage: ZERO_USAGE,
        value: {
          problems,
          note: problems.length ? "Offline reviewer drill." : "",
        },
      };
    },
  };
}
