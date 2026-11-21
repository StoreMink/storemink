import "server-only";

import type { ElevenLabsImageModel } from "@/lib/mink/image-provider-settings";
import { logWarn } from "@/lib/observability/logger";
import { gcsDownloadObject, GCS_BUCKET_NAME } from "@/lib/storage/gcs";
import { requestElevenLabsImage } from "@/lib/theme-studio/image-elevenlabs";
import {
  MinkImageRateLimitedError,
  MinkRequestError,
  MinkToolInputError,
} from "./errors";
import {
  MinkImageNotSentError,
  minkImageInstruction,
  type MinkGeneratedImage,
} from "./media-generation";
import {
  aspectRatioFor,
  type MinkMediaGenerationRequest,
} from "./media-generation-contract";
import type { MinkMediaReferenceImage } from "./media-reference-images";

// ---------------------------------------------------------------------------
// A Mink picture drawn by ElevenLabs instead of Vertex: the storefront
// redesign's product studio photos, when the operator switch says so
// (lib/mink/image-provider-store.ts). The same brief as the Vertex call
// (`minkImageInstruction`), the same errors, so the caller's handling of a
// refusal, a 429 and a call that never left does not change.
//
// ★ ElevenLabs takes reference images only as bytes, so a store image Vertex
//   would read by its `gs://` address is downloaded from StoreMink's own
//   bucket first. An address in any other bucket is never fetched.
// ---------------------------------------------------------------------------

/** The most one reference may weigh (Vertex's own inline limit). */
const REFERENCE_MAX_BYTES = 7 * 1024 * 1024;

/** A draw ElevenLabs' own clock cut off: it may have been billed. */
export class MinkElevenLabsTimeoutError extends MinkRequestError {
  constructor() {
    super(
      "image_provider_unavailable",
      "The image service did not answer in time.",
      503,
    );
    this.name = "MinkElevenLabsTimeoutError";
  }
}

/** The object path of `gs://<StoreMink's bucket>/<path>`, or null. */
export function storeBucketPath(
  fileUri: string,
  bucket: string | null = GCS_BUCKET_NAME,
): string | null {
  if (!bucket) return null;
  const prefix = `gs://${bucket}/`;
  if (!fileUri.startsWith(prefix)) return null;
  const path = fileUri.slice(prefix.length);
  return path && !path.includes("..") ? path : null;
}

/** Every reference as base64 bytes, in order. Throws when one cannot be read. */
async function referenceBytes(
  references: readonly MinkMediaReferenceImage[],
  download: typeof gcsDownloadObject,
): Promise<{ mediaType: string; base64: string }[]> {
  return Promise.all(
    references.map(async (reference) => {
      if (reference.inlineData) {
        return {
          mediaType: reference.inlineData.mimeType ?? reference.mimeType,
          base64: reference.inlineData.data,
        };
      }
      const path = reference.fileUri
        ? storeBucketPath(reference.fileUri)
        : null;
      if (!path) throw new Error("A reference is not in StoreMink's bucket.");
      const bytes = await download(path, REFERENCE_MAX_BYTES);
      return {
        mediaType: reference.mimeType,
        base64: Buffer.from(bytes).toString("base64"),
      };
    }),
  );
}

export interface MinkElevenLabsTarget {
  apiKey: string;
  model: ElevenLabsImageModel;
}

export interface MinkElevenLabsOptions {
  signal: AbortSignal;
  /** The deadline's drain: no job is created once it has fired. */
  draining?: AbortSignal;
  /** For tests. */
  request?: typeof requestElevenLabsImage;
  download?: typeof gcsDownloadObject;
}

/**
 * One picture from ElevenLabs, as `generateMinkMediaImage` would return it.
 * ★ The errors match the Vertex call's: a refusal is a MinkToolInputError,
 *   every try refused with 429 a MinkImageRateLimitedError, and a call that
 *   created no job a MinkImageNotSentError, so nothing billed is told apart
 *   from what may have been (`isUnbilledImageFailure`).
 */
export async function generateMinkMediaImageWithElevenLabs(
  target: MinkElevenLabsTarget,
  request: MinkMediaGenerationRequest,
  references: readonly MinkMediaReferenceImage[],
  options: MinkElevenLabsOptions,
): Promise<MinkGeneratedImage> {
  const instruction = minkImageInstruction(request, references, {
    provider: "elevenlabs",
    model: target.model,
  });
  let images: { mediaType: string; base64: string }[];
  try {
    images = await referenceBytes(
      references,
      options.download ?? gcsDownloadObject,
    );
  } catch (error) {
    logWarn("mink.image: an ElevenLabs reference could not be read", {
      model: target.model,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new MinkImageNotSentError(
      "image_provider_unavailable",
      "A reference photo could not be read. Nothing was created; try again shortly.",
      503,
    );
  }

  const result = await (options.request ?? requestElevenLabsImage)(
    {
      prompt: instruction,
      aspectRatio: aspectRatioFor(
        request.purpose,
        request.productPhotoShape,
        request.slotAspectRatio,
      ),
      images,
    },
    options.signal,
    {
      apiKey: target.apiKey,
      model: target.model,
      draining: options.draining,
      markStoppedInFlight: true,
    },
  );

  if (result.kind === "ok") {
    return { bytes: Buffer.from(result.bytes), mimeType: result.mediaType };
  }
  if (result.kind === "refused") {
    throw new MinkToolInputError(
      result.reason
        ? `The image service refused this description: ${result.reason}. Describe the scene differently and try again.`
        : "The image service returned no image for this description. Try describing the scene more concretely.",
    );
  }
  const created = (result.timing?.providerAttempts ?? 0) > 0;
  switch (result.code) {
    case "rate_limited":
      throw new MinkImageRateLimitedError(
        "The image service is busy. Nothing was created; try again shortly.",
      );
    case "cancelled":
      if (!created || !result.timing?.stoppedInFlight) {
        throw new MinkImageNotSentError(
          "image_provider_unavailable",
          "The image request stopped before it was sent. Nothing was created.",
          503,
        );
      }
      throw new MinkRequestError(
        "image_provider_unavailable",
        "The image request was stopped.",
        503,
      );
    case "provider_timeout":
      throw new MinkElevenLabsTimeoutError();
    case "provider_auth":
      throw new MinkRequestError(
        "image_not_configured",
        "The ElevenLabs key was refused.",
        503,
      );
    default:
      throw new MinkRequestError(
        "image_provider_unavailable",
        "The image service did not respond. Nothing was created; try again shortly.",
        503,
      );
  }
}
