import "server-only";

/**
 * ElevenLabs' Image API behind the one interface Theme Studio and the
 * storefront redesign draw through (`ThemeStudioImageClient`), so their
 * review, storage, budget and recovery code is unchanged whichever provider
 * draws.
 *
 * ★ What the interface's outcomes mean here:
 *   - `providerAttempts` is 1 when a job exists or may exist for the call
 *     (submitted, its answer lost, or an earlier job collected), and 0 when
 *     provably nothing was drawn. The callers count a draw against their
 *     budget only for the first kind.
 *   - `rate_limited` and a refusal before a job are unbilled, as with Google.
 *   - A job the provider failed or moderated was not charged.
 * ★ Google's per-request safety settings have no equivalent in this API, so
 *   the brief's own rule about people is stated in the prompt, and the
 *   provider's moderation is the backstop (a moderated job is `refused`).
 */

import {
  ZERO_IMAGE_USAGE,
  type ThemeImageReference,
  type ThemeImageRequest,
  type ThemeImageResult,
  type ThemeStudioImageClient,
} from "@/lib/theme-studio/image-provider";
import type { ProviderErrorCode } from "@/lib/theme-studio/provider";
import {
  ELEVENLABS_ASPECT_RATIOS,
  ELEVENLABS_IMAGE_MODEL,
  drawElevenLabsImage,
  elevenLabsCostMicroUsd,
  type ElevenLabsAspectRatio,
  type ElevenLabsDeps,
  type ElevenLabsErrorCode,
} from "./elevenlabs-images";
import type {
  ElevenLabsImageQuality,
  ElevenLabsImageResolution,
} from "./provider-settings";

/** Jobs one process has in flight at once. Five at once were accepted in the
 *  22 Nov 2026 test; a refusal for concurrency is a free 429 either way. */
export const ELEVENLABS_IN_FLIGHT = 5;

const LABELS: Record<ThemeImageReference["role"], string> = {
  anchor: "ANCHOR",
  set: "SET",
  product: "PRODUCT",
};

/**
 * The prompt as this provider needs it: the brief's own prompt, then which
 * attached image is which (Google gets each image after its label; here the
 * images travel in a list), then the brief's rule about people.
 */
export function elevenLabsThemePrompt(request: ThemeImageRequest): string {
  const lines = [request.prompt.trim()];
  if (request.references.length > 0) {
    lines.push(
      "",
      "REFERENCE IMAGES, IN THE ORDER ATTACHED:",
      ...request.references.map(
        (reference, index) =>
          `${index + 1}. The image labelled ${LABELS[reference.role]}.`,
      ),
    );
  }
  lines.push(
    "",
    request.people === "adults"
      ? "PEOPLE: any person shown is an adult. Never a child, and never a real or famous person."
      : "PEOPLE: do not show any person.",
  );
  return lines.join("\n");
}

/**
 * The longest edge a reference is sent at.
 *
 * ★★ A REFERENCE IS WHAT A PICTURE COSTS ON THIS PROVIDER (about 475 credits
 *    with one against about 130 with none, 22 Nov 2026), and nearly every
 *    photo carries the ANCHOR. So a reference is never sent larger than its
 *    job needs: the anchor and a set photo only carry light, palette and
 *    framing, which 512 px shows; a merchant's own product photo must keep
 *    its label readable, so it keeps up to 1,024 px. ⚠ That a smaller
 *    reference costs fewer credits is expected, not yet measured; it cannot
 *    cost more.
 */
export const ELEVENLABS_REFERENCE_EDGE: Record<
  ThemeImageReference["role"],
  number
> = { anchor: 512, set: 512, product: 1024 };

/** A reference at the size it is sent: shrunk, never enlarged. */
export async function shrinkReference(reference: ThemeImageReference): Promise<{
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  base64: string;
}> {
  try {
    const sharp = (await import("sharp")).default;
    const edge = ELEVENLABS_REFERENCE_EDGE[reference.role];
    const out = await sharp(Buffer.from(reference.base64, "base64"))
      .rotate()
      .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { mediaType: "image/jpeg", base64: out.toString("base64") };
  } catch {
    // A reference that cannot be read here is sent as it came.
    return { mediaType: reference.mediaType, base64: reference.base64 };
  }
}

const ERROR_CODES: Record<ElevenLabsErrorCode, ProviderErrorCode> = {
  rate_limited: "rate_limited",
  rejected: "provider_rejected",
  auth: "provider_auth",
  timeout: "provider_timeout",
  unavailable: "provider_unavailable",
  cancelled: "cancelled",
};

function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((go) => waiting.push(go));
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
const inFlight = limiter(ELEVENLABS_IN_FLIGHT);

export interface ElevenLabsThemeClientOptions {
  apiKey: string;
  quality: ElevenLabsImageQuality;
  resolution: ElevenLabsImageResolution;
  /** A redesign's id or a Theme Studio project's id (elevenlabs-generations.ts). */
  scope: string;
  /** Once this fires, no NEW job is submitted (the redesign's drain). */
  draining?: AbortSignal;
  /** Mark a call stopped while its job was under way (the redesign, D3). */
  markStoppedInFlight?: boolean;
  /** Test seams for the draw itself. */
  deps?: Partial<Omit<ElevenLabsDeps, "apiKey">>;
  /** Test seam for the reference shrink. */
  shrink?: typeof shrinkReference;
}

export function createElevenLabsImageClient(
  options: ElevenLabsThemeClientOptions,
): ThemeStudioImageClient {
  return {
    provider: "elevenlabs",
    async generateImage(request, signal): Promise<ThemeImageResult> {
      const started = Date.now();
      const timing = (providerAttempts: number, stoppedInFlight = false) => ({
        durationMs: Math.max(0, Date.now() - started),
        capacityWaitMs: 0,
        providerAttempts,
        ...(stoppedInFlight ? { stoppedInFlight: true as const } : {}),
      });
      // ★ The drain: a draw that has not been sent by then is never sent.
      if (signal.aborted || options.draining?.aborted) {
        return {
          kind: "error",
          code: "cancelled",
          usage: ZERO_IMAGE_USAGE,
          timing: timing(0),
        };
      }
      if (
        !ELEVENLABS_ASPECT_RATIOS.includes(
          request.aspectRatio as ElevenLabsAspectRatio,
        )
      ) {
        return {
          kind: "error",
          code: "provider_rejected",
          usage: ZERO_IMAGE_USAGE,
          timing: timing(0),
        };
      }
      const shrink = options.shrink ?? shrinkReference;
      const references = await Promise.all(request.references.map(shrink));
      const outcome = await inFlight(() =>
        drawElevenLabsImage(
          {
            prompt: elevenLabsThemePrompt(request),
            aspectRatio: request.aspectRatio as ElevenLabsAspectRatio,
            quality: options.quality,
            resolution: options.resolution,
            references,
            scope: options.scope,
          },
          signal,
          { apiKey: options.apiKey, ...options.deps },
        ),
      );
      const attempts = outcome.jobMayExist ? 1 : 0;
      if (outcome.kind === "ok") {
        return {
          kind: "ok",
          bytes: outcome.bytes,
          mediaType: outcome.mediaType,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            model: ELEVENLABS_IMAGE_MODEL,
            flatCostMicroUsd: elevenLabsCostMicroUsd({
              quality: options.quality,
              resolution: options.resolution,
              references: request.references.length,
            }),
          },
          timing: timing(1),
        };
      }
      if (outcome.kind === "refused") {
        return {
          kind: "refused",
          reason: outcome.reason,
          usage: ZERO_IMAGE_USAGE,
          timing: timing(0),
        };
      }
      return {
        kind: "error",
        code: ERROR_CODES[outcome.code],
        usage: ZERO_IMAGE_USAGE,
        timing: timing(
          attempts,
          outcome.code === "cancelled" &&
            outcome.jobMayExist &&
            options.markStoppedInFlight === true,
        ),
      };
    },
  };
}
