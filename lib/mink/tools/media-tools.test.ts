import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A chat image end to end, through the real registry, tool, proposal and
// generation code, with only Google, storage and the database faked: the
// chain B3, B6 and B10 (2026-10-23) changed, tried the way a chat runs it.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  generateContent: vi.fn(),
  claim: vi.fn(async () => ({
    ok: true as const,
    claimedAt: "2026-10-23 18:00:00.000001+00",
  })),
  release: vi.fn(async () => undefined),
  inserts: [] as Record<string, unknown>[],
  upload: vi.fn(
    async (path: string) => `https://storage.googleapis.com/bucket/${path}`,
  ),
  deleted: [] as string[],
  draft: vi.fn(async () => ({
    type: "proposal",
    draftId: "11111111-1111-4111-8111-111111111111",
    title: "Hero banner",
    destinationLabel: "Media Library · Hero banner",
    expectedCredits: 3,
    chargedCredits: 3,
    creditSource: "plan",
  })),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: h.generateContent };
  },
  HarmBlockThreshold: { BLOCK_LOW_AND_ABOVE: "BLOCK_LOW_AND_ABOVE" },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "h",
    HARM_CATEGORY_HATE_SPEECH: "hs",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "s",
    HARM_CATEGORY_DANGEROUS_CONTENT: "d",
  },
  Modality: { TEXT: "TEXT", IMAGE: "IMAGE" },
  ProminentPeople: { BLOCK_PROMINENT_PEOPLE: "BLOCK_PROMINENT_PEOPLE" },
  ThinkingLevel: {
    MINIMAL: "MINIMAL",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
  },
}));
// Draws with Vertex here: the switch's read is not this suite's subject.
vi.mock("@/lib/mink/image-provider-store", () => ({
  resolveRevampImageTarget: async () => ({ kind: "vertex" }),
}));
vi.mock("@/lib/db/client", () => {
  const db = {
    // The store's image-generation switch.
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ enabled: true }] }),
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        h.inserts.push(values);
      },
    }),
    delete: () => ({ where: async () => undefined }),
  };
  return {
    withService: vi.fn(async (operation: (d: typeof db) => unknown) =>
      operation(db),
    ),
  };
});
// ★ The picture goes through the store's one writer (takedown design 5.7).
vi.mock("@/lib/storage/store-objects", () => ({
  writeStoreObject: h.upload,
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsDeletePaths: vi.fn(async (paths: string[]) => {
    h.deleted.push(...paths);
    return [];
  }),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("../config", () => ({
  getMinkConfig: () => ({
    projectId: "project-1",
    imageModel: "gemini-nano-banana-2.1",
    imageLocation: "global",
  }),
}));
vi.mock("../drafts", () => ({ createMinkDraftProposal: h.draft }));
vi.mock("../media-reference-images", () => ({
  resolveMinkMediaReferenceImages: vi.fn(async () => []),
}));
vi.mock("@/lib/chrome/queries", () => ({
  getStoreChrome: vi.fn(async () => ({
    appearance: { cardPhoto: "portrait" },
  })),
}));
vi.mock("../spend-limits", () => ({
  MINK_IMAGE_GLOBAL_LIMIT: {
    key: "mink-image-global",
    max: 200,
    windowSeconds: 3_600,
  },
  claimSpendLimits: h.claim,
  releaseSpendLimits: h.release,
}));

import {
  MAX_RUN_BUDGET_MS,
  MinkToolRegistry,
  TOOL_COMMIT_GRACE_MS,
} from "./registry";
import { MEDIA_TOOL_TIMEOUT_MS, minkMediaTools } from "./media-tools";
import { BlockedUploadError } from "@/lib/moderation/upload-guard";
import type { MinkActorContext } from "../types";

const STORE = "a0000000-0000-4000-8000-000000000001";
const actor = {
  storeId: STORE,
  adminId: "admin-1",
  runId: "22222222-2222-4222-8222-222222222222",
  requestId: "request-1",
  draftingEnabled: true,
  isSuperadmin: true,
  permissions: {},
} as unknown as MinkActorContext;

const call = {
  id: "call-1",
  name: "generate_storefront_image",
  args: {
    purpose: "hero",
    prompt: "A warm overhead still life of loose grains on linen.",
    reference_image_urls: [],
    alt: "Grains and pulses on linen",
  },
};

const rateLimited = Object.assign(new Error("RESOURCE_EXHAUSTED"), {
  status: 429,
});
const PIXEL = Buffer.from("hello").toString("base64");
const imageResponse = () => ({
  candidates: [
    {
      finishReason: "STOP",
      content: {
        parts: [{ inlineData: { data: PIXEL, mimeType: "image/jpeg" } }],
      },
    },
  ],
});

/** A try that answers after `ms`, or stops at once when its signal fires. */
function answersAfter(ms: number, outcome: "image" | "busy") {
  return (params: { config: { abortSignal: AbortSignal } }) =>
    new Promise((resolve, reject) => {
      const signal = params.config.abortSignal;
      const timer = setTimeout(
        () =>
          outcome === "image" ? resolve(imageResponse()) : reject(rateLimited),
        ms,
      );
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("This operation was aborted"));
        },
        { once: true },
      );
    });
}

const registry = () => new MinkToolRegistry(minkMediaTools);
/** The limits a refusal gives back: the store's hour and day, the platform's hour. */
const ALLOWANCE_KEYS = [
  `mink-image-store:${STORE}`,
  `mink-image-day:${STORE}`,
  "mink-image-global",
];

beforeEach(() => {
  vi.useFakeTimers();
  h.inserts = [];
  h.deleted = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("★★ a chat image through the tool (B3, B6, B10)", () => {
  it("two refused tries then a success: drawn once, stored once, charged once, allowance kept", async () => {
    h.generateContent
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(imageResponse());
    const pending = registry().execute(actor, call);
    await vi.advanceTimersByTimeAsync(40_000);
    const response = await pending;

    expect(response.response.error).toBeUndefined();
    expect(response.artifact).toMatchObject({ type: "media_image_proposal" });
    expect(h.generateContent).toHaveBeenCalledTimes(3);
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.inserts).toHaveLength(1);
    expect(h.draft).toHaveBeenCalledTimes(1);
    // The allowance was claimed once and, the picture being drawn, kept.
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.release).not.toHaveBeenCalled();
  });

  it("★★ three refusals give the store's allowance back, once", async () => {
    h.generateContent.mockRejectedValue(rateLimited);
    const pending = registry().execute(actor, call);
    await vi.advanceTimersByTimeAsync(40_000);
    const response = await pending;

    expect(response.response.error).toMatchObject({ code: "tool_failed" });
    expect(h.generateContent).toHaveBeenCalledTimes(3);
    expect(h.release).toHaveBeenCalledTimes(1);
    const [limits, options] = h.release.mock.calls[0] as unknown as [
      Array<{ key: string }>,
      { claimedAt?: string },
    ];
    expect(limits.map((limit) => limit.key)).toEqual(ALLOWANCE_KEYS);
    // Given back only to the window that counted the claim.
    expect(options).toEqual({ claimedAt: "2026-10-23 18:00:00.000001+00" });
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.draft).not.toHaveBeenCalled();
  });

  it("★★ a timeout keeps the allowance spent: it may have been billed", async () => {
    h.generateContent.mockImplementation(answersAfter(120_000, "image"));
    const pending = registry().execute(actor, call);
    await vi.advanceTimersByTimeAsync(46_000);
    const response = await pending;

    expect(response.response.error).toMatchObject({ code: "tool_failed" });
    // Never asked again: one paid attempt.
    expect(h.generateContent).toHaveBeenCalledTimes(1);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.draft).not.toHaveBeenCalled();
  });

  it("★★ every try has its own clock: a refusal at 40 s does not cut the next try short", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    h.generateContent
      .mockImplementationOnce(answersAfter(40_000, "busy"))
      .mockImplementationOnce(answersAfter(40_000, "image"));
    const pending = registry().execute(actor, call);
    await vi.advanceTimersByTimeAsync(40_000 + 5_000 + 40_000);
    const response = await pending;

    expect(response.artifact).toMatchObject({ type: "media_image_proposal" });
    expect(h.generateContent).toHaveBeenCalledTimes(2);
    expect(h.draft).toHaveBeenCalledTimes(1);
  });

  it("★★ the run's stop aborts the provider call, and nothing is stored, saved or charged after it", async () => {
    const run = new AbortController();
    let sent: AbortSignal | undefined;
    h.generateContent.mockImplementationOnce(
      (params: { config: { abortSignal: AbortSignal } }) => {
        sent = params.config.abortSignal;
        return answersAfter(30_000, "image")(params);
      },
    );
    const pending = registry().execute(actor, call, { signal: run.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    run.abort();
    const response = await pending;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(response.response.error).toMatchObject({ code: "tool_timeout" });
    expect(sent?.aborted).toBe(true);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
    expect(h.draft).not.toHaveBeenCalled();
    // The request had been sent: it may have been billed.
    expect(h.release).not.toHaveBeenCalled();
  });

  // ★★ A picture whose bytes StoreMink has blocked: the model is told the
  //    design's sentence, nothing is saved or charged, the draw stays spent.
  it("★★ a blocked picture: the chat hears StoreMink's sentence, nothing is saved or charged", async () => {
    h.generateContent.mockResolvedValueOnce(imageResponse());
    h.upload.mockRejectedValueOnce(
      new BlockedUploadError({
        told: true,
        kindWord: "image",
        blockId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    const response = await registry().execute(actor, call);
    expect(response.response.error).toMatchObject({
      code: "tool_failed",
      message:
        "StoreMink has blocked this image, so it can't be uploaded again. See Settings, Notices from StoreMink.",
    });
    expect(h.upload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^stores/${STORE}/mink-generated/`)),
      expect.anything(),
      "image/jpeg",
      expect.objectContaining({ storeId: STORE, via: "mink_media_image" }),
    );
    expect(h.inserts).toEqual([]);
    expect(h.deleted).toEqual([]);
    expect(h.draft).not.toHaveBeenCalled();
    // The picture came back, so it may have been billed: kept spent.
    expect(h.release).not.toHaveBeenCalled();
  });

  it("★★ the tool's deadline during the upload: the chat hears the timeout, and the picture is removed, never saved or charged", async () => {
    h.generateContent.mockResolvedValueOnce(imageResponse());
    h.upload.mockImplementationOnce(
      (path: string) =>
        new Promise<string>((resolve) =>
          setTimeout(
            () => resolve(`https://storage.googleapis.com/bucket/${path}`),
            MEDIA_TOOL_TIMEOUT_MS + 5_000,
          ),
        ),
    );
    const pending = registry().execute(actor, call);
    await vi.advanceTimersByTimeAsync(MEDIA_TOOL_TIMEOUT_MS);
    const response = await pending;
    expect(response.response.error).toMatchObject({ code: "tool_timeout" });

    // The upload finishes after the chat was told: the commit refuses.
    await vi.advanceTimersByTimeAsync(6_000);
    const uploaded = h.upload.mock.calls[0][0] as string;
    expect(h.deleted).toEqual([uploaded]);
    expect(h.inserts).toEqual([]);
    expect(h.draft).not.toHaveBeenCalled();
  });

  it("★ the draft under way at the deadline is kept, and its card is the answer", async () => {
    h.generateContent.mockResolvedValueOnce(imageResponse());
    h.upload.mockImplementationOnce(
      (path: string) =>
        new Promise<string>((resolve) =>
          setTimeout(
            () => resolve(`https://storage.googleapis.com/bucket/${path}`),
            MEDIA_TOOL_TIMEOUT_MS - 1_000,
          ),
        ),
    );
    // The charged draft takes 3 s and is still being written at the deadline.
    h.draft.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return {
        type: "proposal",
        draftId: "11111111-1111-4111-8111-111111111111",
        title: "Hero banner",
        destinationLabel: "Media Library · Hero banner",
        expectedCredits: 3,
        chargedCredits: 3,
        creditSource: "plan",
      };
    });
    const pending = registry().execute(actor, call);
    await vi.advanceTimersByTimeAsync(MEDIA_TOOL_TIMEOUT_MS + 3_000);
    const response = await pending;

    // Charged exactly when shown.
    expect(response.artifact).toMatchObject({ type: "media_image_proposal" });
    expect(h.draft).toHaveBeenCalledTimes(1);
    expect(h.deleted).toEqual([]);
    // ★★ Owner, 25 Oct 2026: the chat image went to Nano Banana 2.1 at 2K
    //   with MINIMAL thinking, and no sampling parameter.
    const sent = h.generateContent.mock.calls[0][0] as {
      model: string;
      config: Record<string, unknown> & {
        imageConfig: { imageSize: string };
      };
    };
    expect(sent.model).toBe("gemini-nano-banana-2.1");
    expect(sent.config.imageConfig.imageSize).toBe("2K");
    expect(sent.config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    for (const parameter of ["temperature", "topP", "topK", "seed"]) {
      expect(sent.config).not.toHaveProperty(parameter);
    }
  });

  it("★ the run waits for the tool: its budget covers the deadline, the commit grace and the answer after it", () => {
    const tool = minkMediaTools[0];
    expect(tool.timeoutMs).toBe(MEDIA_TOOL_TIMEOUT_MS);
    // A minute for the model's answer after the longest the tool can take.
    expect(
      registry().runBudgetMs("generate_storefront_image")! -
        (MEDIA_TOOL_TIMEOUT_MS + TOOL_COMMIT_GRACE_MS),
    ).toBeGreaterThanOrEqual(60_000);
    expect(
      registry().runBudgetMs("generate_storefront_image"),
    ).toBeLessThanOrEqual(MAX_RUN_BUDGET_MS);
  });
});
