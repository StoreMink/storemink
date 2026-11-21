/* eslint-disable @typescript-eslint/no-explicit-any */
// ElevenLabs behind the interface Theme Studio and the storefront redesign
// draw through. What matters here is that their budget and recovery code,
// written for Google, reads this provider's outcomes correctly: a draw counts
// against the budget only when a job exists or may exist, and never when
// provably nothing was drawn.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
const draw = vi.hoisted(() => ({ drawElevenLabsImage: vi.fn() }));
vi.mock("./elevenlabs-images", async (original) => ({
  ...(await original<typeof import("./elevenlabs-images")>()),
  drawElevenLabsImage: draw.drawElevenLabsImage,
}));
vi.mock("./elevenlabs-generations", () => ({ postgresGenerationStore: {} }));

import type { ThemeImageRequest } from "@/lib/theme-studio/image-provider";
import { estimateImageCostMicroUsd } from "@/lib/theme-studio/cost";
import {
  ELEVENLABS_REFERENCE_EDGE,
  createElevenLabsImageClient,
  elevenLabsThemePrompt,
  shrinkReference,
} from "./elevenlabs-theme-client";

function request(over: Partial<ThemeImageRequest> = {}): ThemeImageRequest {
  return {
    purpose: "product",
    briefId: "p1",
    aspectRatio: "4:5",
    prompt: "A catalogue shot of a mug.",
    references: [],
    ...over,
  };
}
const same = async (reference: any) => ({
  mediaType: reference.mediaType,
  base64: reference.base64,
});
function client(over: Record<string, unknown> = {}) {
  return createElevenLabsImageClient({
    apiKey: "key",
    quality: "low",
    resolution: "1K",
    scope: "revamp:r1",
    shrink: same as any,
    ...over,
  });
}
const outcome = (value: Record<string, unknown>) => ({
  jobMayExist: false,
  adopted: false,
  submits: 0,
  durationMs: 10,
  ...value,
});
const live = () => new AbortController().signal;

beforeEach(() => {
  vi.clearAllMocks();
  draw.drawElevenLabsImage.mockResolvedValue(
    outcome({
      kind: "ok",
      bytes: new Uint8Array([1]),
      mediaType: "image/jpeg",
      generationId: "gen_1",
      jobMayExist: true,
      submits: 1,
    }),
  );
});

describe("the prompt", () => {
  it("names each attached image by the label the brief uses, in order", () => {
    const text = elevenLabsThemePrompt(
      request({
        references: [
          { role: "anchor", mediaType: "image/webp", base64: "QQ==" },
          { role: "product", mediaType: "image/jpeg", base64: "Qg==" },
        ],
      }),
    );
    expect(text).toContain("A catalogue shot of a mug.");
    expect(text).toContain("1. The image labelled ANCHOR.");
    expect(text).toContain("2. The image labelled PRODUCT.");
  });

  // Google enforces this with a request setting this API does not have.
  it("★ states the brief's rule about people: none unless the brief allows adults", () => {
    expect(elevenLabsThemePrompt(request())).toContain(
      "PEOPLE: do not show any person.",
    );
    expect(elevenLabsThemePrompt(request({ people: "none" }))).toContain(
      "PEOPLE: do not show any person.",
    );
    const adults = elevenLabsThemePrompt(request({ people: "adults" }));
    expect(adults).toContain("any person shown is an adult");
    expect(adults).toContain("never a real or famous person");
  });

  it("says nothing about references when there are none", () => {
    expect(elevenLabsThemePrompt(request())).not.toContain("REFERENCE IMAGES");
  });
});

describe("what is asked of the provider", () => {
  it("★★ the operator's quality and resolution, the brief's shape, and this job's scope", async () => {
    await client({ quality: "medium", resolution: "2K" }).generateImage(
      request({ aspectRatio: "16:9" }),
      live(),
    );
    const [input, , deps] = draw.drawElevenLabsImage.mock.calls[0];
    expect(input).toMatchObject({
      aspectRatio: "16:9",
      quality: "medium",
      resolution: "2K",
      scope: "revamp:r1",
      references: [],
    });
    expect(deps.apiKey).toBe("key");
  });

  it("★ each reference is sent at the size its job needs", async () => {
    const shrink = vi.fn(async () => ({
      mediaType: "image/jpeg" as const,
      base64: "c21hbGw=",
    }));
    await client({ shrink }).generateImage(
      request({
        references: [
          { role: "anchor", mediaType: "image/png", base64: "QQ==" },
          { role: "product", mediaType: "image/png", base64: "Qg==" },
        ],
      }),
      live(),
    );
    expect(shrink).toHaveBeenCalledTimes(2);
    expect(draw.drawElevenLabsImage.mock.calls[0][0].references).toEqual([
      { mediaType: "image/jpeg", base64: "c21hbGw=" },
      { mediaType: "image/jpeg", base64: "c21hbGw=" },
    ]);
  });

  it("a style reference is smaller than a product's own photo, whose label must stay readable", () => {
    expect(ELEVENLABS_REFERENCE_EDGE.anchor).toBe(512);
    expect(ELEVENLABS_REFERENCE_EDGE.set).toBe(512);
    expect(ELEVENLABS_REFERENCE_EDGE.product).toBe(1024);
  });
});

describe("★★ how the callers' budgets read each outcome", () => {
  it("a picture: one attempt, with its cost stated (this provider reports no tokens)", async () => {
    const result = await client().generateImage(
      request({
        references: [
          { role: "anchor", mediaType: "image/png", base64: "QQ==" },
        ],
      }),
      live(),
    );
    expect(result).toMatchObject({
      kind: "ok",
      mediaType: "image/jpeg",
      timing: { providerAttempts: 1, capacityWaitMs: 0 },
    });
    if (result.kind !== "ok") return;
    expect(result.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      model: "gpt-image-2.5-sunburst",
    });
    // With no tokens, Google's rates would price it at nothing.
    expect(estimateImageCostMicroUsd(result.usage)).toBe(475 * 166);
  });

  it.each([
    ["rate_limited", "rate_limited"],
    ["rejected", "provider_rejected"],
    ["auth", "provider_auth"],
  ] as const)(
    "%s before a job: no attempt is counted",
    async (code, mapped) => {
      draw.drawElevenLabsImage.mockResolvedValue(
        outcome({ kind: "error", code }),
      );
      const result = await client().generateImage(request(), live());
      expect(result).toMatchObject({
        kind: "error",
        code: mapped,
        timing: { providerAttempts: 0 },
      });
    },
  );

  it("★★ a job that may exist (a lost answer, a wait that ran out) IS counted", async () => {
    draw.drawElevenLabsImage.mockResolvedValue(
      outcome({
        kind: "error",
        code: "timeout",
        jobMayExist: true,
        submits: 1,
      }),
    );
    const result = await client().generateImage(request(), live());
    expect(result).toMatchObject({
      kind: "error",
      code: "provider_timeout",
      timing: { providerAttempts: 1 },
    });
  });

  it("★ a job the provider failed or moderated was not charged: no attempt", async () => {
    draw.drawElevenLabsImage.mockResolvedValue(
      outcome({ kind: "refused", reason: "moderated" }),
    );
    expect(await client().generateImage(request(), live())).toMatchObject({
      kind: "refused",
      reason: "moderated",
      timing: { providerAttempts: 0 },
    });
    draw.drawElevenLabsImage.mockResolvedValue(
      outcome({ kind: "error", code: "unavailable" }),
    );
    expect(await client().generateImage(request(), live())).toMatchObject({
      kind: "error",
      code: "provider_unavailable",
      timing: { providerAttempts: 0 },
    });
  });

  it("★★ a draw stopped while its job was under way says so, for a caller that asks (the redesign)", async () => {
    draw.drawElevenLabsImage.mockResolvedValue(
      outcome({ kind: "error", code: "cancelled", jobMayExist: true }),
    );
    const marked = await client({ markStoppedInFlight: true }).generateImage(
      request(),
      live(),
    );
    expect(marked.timing).toMatchObject({
      providerAttempts: 1,
      stoppedInFlight: true,
    });
    const plain = await client().generateImage(request(), live());
    expect(plain.timing).not.toHaveProperty("stoppedInFlight");
  });
});

describe("★★ nothing is sent once it must not be", () => {
  it("after the redesign's drain has begun", async () => {
    const drain = new AbortController();
    drain.abort();
    const result = await client({ draining: drain.signal }).generateImage(
      request(),
      live(),
    );
    expect(result).toMatchObject({
      kind: "error",
      code: "cancelled",
      timing: { providerAttempts: 0 },
    });
    expect(draw.drawElevenLabsImage).not.toHaveBeenCalled();
  });

  it("when the call is already stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    await client().generateImage(request(), stop.signal);
    expect(draw.drawElevenLabsImage).not.toHaveBeenCalled();
  });

  it("for a shape the model does not draw", async () => {
    const result = await client().generateImage(
      request({ aspectRatio: "7:9" as any }),
      live(),
    );
    expect(result).toMatchObject({ kind: "error", code: "provider_rejected" });
    expect(draw.drawElevenLabsImage).not.toHaveBeenCalled();
  });
});

describe("shrinkReference", () => {
  async function png(width: number, height: number) {
    const sharp = (await import("sharp")).default;
    return (
      await sharp({
        create: { width, height, channels: 3, background: "#336699" },
      })
        .png()
        .toBuffer()
    ).toString("base64");
  }
  async function sizeOf(base64: string) {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.from(base64, "base64")).metadata();
    return [meta.width, meta.height, meta.format];
  }

  it("★ an anchor is sent at 512 px and a product photo at up to 1,024 px, as JPEG", async () => {
    const big = await png(1856, 2304);
    const anchor = await shrinkReference({
      role: "anchor",
      mediaType: "image/png",
      base64: big,
    });
    expect(await sizeOf(anchor.base64)).toEqual([412, 512, "jpeg"]);
    const product = await shrinkReference({
      role: "product",
      mediaType: "image/png",
      base64: big,
    });
    expect(await sizeOf(product.base64)).toEqual([825, 1024, "jpeg"]);
    expect(product.mediaType).toBe("image/jpeg");
  });

  it("never enlarges a small one", async () => {
    const small = await shrinkReference({
      role: "product",
      mediaType: "image/png",
      base64: await png(300, 400),
    });
    expect(await sizeOf(small.base64)).toEqual([300, 400, "jpeg"]);
  });

  it("a reference it cannot read is sent as it came", async () => {
    const out = await shrinkReference({
      role: "anchor",
      mediaType: "image/png",
      base64: "bm90IGFuIGltYWdl",
    });
    expect(out).toEqual({ mediaType: "image/png", base64: "bm90IGFuIGltYWdl" });
  });
});
