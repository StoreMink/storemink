import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/logger", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/storage/gcs", () => ({
  GCS_BUCKET_NAME: "sm-media",
  gcsDownloadObject: vi.fn(),
}));

import { isUnbilledImageFailure } from "./media-generation";
import {
  generateMinkMediaImageWithElevenLabs,
  MinkElevenLabsTimeoutError,
  storeBucketPath,
} from "./media-generation-elevenlabs";
import { MinkImageRateLimitedError, MinkToolInputError } from "./errors";
import type { MinkMediaGenerationRequest } from "./media-generation-contract";
import type { MinkMediaReferenceImage } from "./media-reference-images";
import type { ThemeImageResult } from "@/lib/theme-studio/image-provider";

const target = { apiKey: "k", model: "gemini-3.1-flash-image" as const };
const request = {
  purpose: "product",
  prompt: "A studio photo of the item",
  alt: "The item",
  referenceImageUrls: [],
  productPhotoShape: "portrait",
} as unknown as MinkMediaGenerationRequest;
const references: MinkMediaReferenceImage[] = [
  {
    url: "https://storage.googleapis.com/sm-media/stores/s1/p.webp",
    fileUri: "gs://sm-media/stores/s1/p.webp",
    mimeType: "image/webp",
    source: "product",
  },
];
const usage = { inputTokens: 0, outputTokens: 0 } as never;

function answer(result: Partial<ThemeImageResult> & { kind: string }) {
  return vi.fn(async () => ({ usage, ...result }) as ThemeImageResult);
}

type Download = (path: string, maxBytes: number) => Promise<Uint8Array>;
let download: ReturnType<typeof vi.fn<Download>>;
beforeEach(() => {
  download = vi.fn<Download>(async () => new Uint8Array([1, 2, 3]));
});

describe("generateMinkMediaImageWithElevenLabs", () => {
  it("sends the store photo as bytes and returns the picture", async () => {
    const send = answer({
      kind: "ok",
      bytes: new Uint8Array([9, 9]),
      mediaType: "image/png",
    } as never);
    const image = await generateMinkMediaImageWithElevenLabs(
      target,
      request,
      references,
      { signal: new AbortController().signal, request: send, download },
    );
    expect(image.mimeType).toBe("image/png");
    expect(Array.from(image.bytes)).toEqual([9, 9]);
    expect(download).toHaveBeenCalledWith(
      "stores/s1/p.webp",
      expect.any(Number),
    );
    const [input, , opts] = send.mock.calls[0] as unknown as [
      { aspectRatio: string; images: { base64: string }[]; prompt: string },
      AbortSignal,
      { markStoppedInFlight: boolean },
    ];
    expect(input.aspectRatio).toBe("3:4");
    expect(input.images[0].base64).toBe(
      Buffer.from([1, 2, 3]).toString("base64"),
    );
    expect(input.prompt).toContain("A studio photo of the item");
    expect(opts.markStoppedInFlight).toBe(true);
  });

  it("never downloads a reference from another bucket", async () => {
    const send = answer({ kind: "ok" } as never);
    const error = await generateMinkMediaImageWithElevenLabs(
      target,
      request,
      [{ ...references[0], fileUri: "gs://elsewhere/x.webp" }],
      { signal: new AbortController().signal, request: send, download },
    ).catch((e) => e);
    expect(isUnbilledImageFailure(error)).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("maps refusals, 429s, stops and timeouts like the Vertex call", async () => {
    const run = (result: Record<string, unknown>) =>
      generateMinkMediaImageWithElevenLabs(target, request, references, {
        signal: new AbortController().signal,
        request: answer(result as never),
        download,
      }).catch((e) => e);

    expect(await run({ kind: "refused", reason: "policy" })).toBeInstanceOf(
      MinkToolInputError,
    );
    const busy = await run({ kind: "error", code: "rate_limited" });
    expect(busy).toBeInstanceOf(MinkImageRateLimitedError);
    expect(isUnbilledImageFailure(busy)).toBe(true);

    const notSent = await run({
      kind: "error",
      code: "cancelled",
      timing: { durationMs: 1, capacityWaitMs: 0, providerAttempts: 0 },
    });
    expect(isUnbilledImageFailure(notSent)).toBe(true);

    const cutOff = await run({
      kind: "error",
      code: "cancelled",
      timing: {
        durationMs: 1,
        capacityWaitMs: 0,
        providerAttempts: 1,
        stoppedInFlight: true,
      },
    });
    expect(isUnbilledImageFailure(cutOff)).toBe(false);

    expect(
      await run({ kind: "error", code: "provider_timeout" }),
    ).toBeInstanceOf(MinkElevenLabsTimeoutError);
    const auth = await run({ kind: "error", code: "provider_auth" });
    expect(auth.code).toBe("image_not_configured");
  });
});

describe("storeBucketPath", () => {
  it("reads only StoreMink's own bucket", () => {
    expect(storeBucketPath("gs://sm-media/stores/a.webp", "sm-media")).toBe(
      "stores/a.webp",
    );
    expect(storeBucketPath("gs://other/stores/a.webp", "sm-media")).toBeNull();
    expect(storeBucketPath("gs://sm-media/../x", "sm-media")).toBeNull();
    expect(storeBucketPath("gs://sm-media/a.webp", null)).toBeNull();
  });
});
