import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const STORE = "a0000000-0000-4000-8000-0000000000aa";
const OTHER = "b0000000-0000-4000-8000-0000000000bb";

const state = vi.hoisted(() => {
  // Built first, so `reserve` can hand it out without `state` naming itself.
  const giveBack = vi.fn(async () => undefined);
  return {
    remaining: 10,
    chargeSource: "plan" as string,
    executed: [] as string[],
    inserts: [] as Record<string, unknown>[],
    uploads: [] as { path: string; bytes: Buffer }[],
    deleted: [] as string[],
    generate: vi.fn(),
    giveBack,
    reserve: vi.fn(async () => ({ giveBack })),
    authority: vi.fn(async () => undefined),
    source: Buffer.alloc(0),
    onUpload: null as null | (() => void),
    imageModel: "gemini-nano-banana-2.1",
  };
});

vi.mock("@/lib/db/client", () => {
  const db = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(query);
      state.executed.push(text);
      if (text.includes("consume_mink_refine_credits"))
        return { rows: [{ source: state.chargeSource }] };
      if (text.includes("remaining"))
        return { rows: [{ remaining: state.remaining }] };
      return { rows: [] };
    },
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        state.inserts.push(values);
      },
    }),
  };
  return {
    withService: async (operation: (d: typeof db) => unknown) => operation(db),
  };
});
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsPathFromUrl: (url: string) =>
    url.startsWith("https://storage.googleapis.com/bucket/")
      ? url.slice("https://storage.googleapis.com/bucket/".length)
      : null,
  gcsDownloadObject: async () => new Uint8Array(state.source),
  gcsUploadObject: async (path: string, bytes: Buffer) => {
    state.uploads.push({ path, bytes });
    state.onUpload?.();
    return `https://storage.googleapis.com/bucket/${path}`;
  },
  gcsDeletePaths: async (paths: string[]) => {
    state.deleted.push(...paths);
    return [];
  },
}));
vi.mock("./config", () => ({
  getMinkConfig: () => ({
    enabled: true,
    projectId: "proj",
    imageModel: state.imageModel,
    imageLocation: "global",
    chargeCredits: true,
  }),
}));
vi.mock("./media-generation", async () => {
  // The real request loop (retries, clocks, what counts as billed); only the
  // allowance claim is faked.
  const actual =
    await vi.importActual<typeof import("./media-generation")>(
      "./media-generation",
    );
  return { ...actual, reserveMinkImageGeneration: state.reserve };
});
vi.mock("./media-image-proposals", () => ({
  assertMediaGenerationAuthority: state.authority,
}));
vi.mock("@/lib/ai/quota", () => ({
  getMinkCreditCycle: async () => ({ period: "2026-10" }),
}));
vi.mock("@/lib/plans/allowances", () => ({
  getPlanAllowancesLive: async () => ({}),
}));
vi.mock("@/lib/plans", () => ({ aiAllowanceFor: () => 100 }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: state.generate };
  },
  HarmBlockThreshold: { BLOCK_LOW_AND_ABOVE: "low" },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "h",
    HARM_CATEGORY_HATE_SPEECH: "hs",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "s",
    HARM_CATEGORY_DANGEROUS_CONTENT: "d",
  },
  Modality: { TEXT: "TEXT", IMAGE: "IMAGE" },
  ProminentPeople: { BLOCK_PROMINENT_PEOPLE: "block" },
  ThinkingLevel: {
    MINIMAL: "MINIMAL",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
  },
}));

import {
  ownedSourcePath,
  refinePrompt,
  refineStoreImage,
} from "./image-refine";
import { IMAGE_SPECS } from "@/lib/media/image-specs";
import { IMAGE_SAMPLING_PARAMETERS } from "@/lib/theme-studio/image-models";
import type { MinkActorContext } from "./types";

const actor = {
  storeId: STORE,
  adminId: "admin-1",
  effectivePlan: "pro",
} as unknown as MinkActorContext;
const ownUrl = `https://storage.googleapis.com/bucket/stores/${STORE}/uploads/shirt.jpg`;

async function modelImage(width: number, height: number) {
  const bytes = await sharp({
    create: { width, height, channels: 3, background: "#888888" },
  })
    .jpeg()
    .toBuffer();
  return {
    candidates: [
      {
        content: {
          parts: [{ inlineData: { data: bytes.toString("base64") } }],
        },
        finishReason: "STOP",
      },
    ],
  };
}

beforeEach(async () => {
  state.remaining = 10;
  state.chargeSource = "plan";
  state.executed = [];
  state.inserts = [];
  state.uploads = [];
  state.deleted = [];
  state.generate.mockReset();
  state.onUpload = null;
  state.imageModel = "gemini-nano-banana-2.1";
  state.source = await sharp({
    create: { width: 900, height: 900, channels: 3, background: "#ffffff" },
  })
    .jpeg()
    .toBuffer();
});

describe("ownedSourcePath", () => {
  it("accepts only this store's objects", () => {
    expect(ownedSourcePath(ownUrl, STORE)).toBe(
      `stores/${STORE}/uploads/shirt.jpg`,
    );
    expect(
      ownedSourcePath(
        `https://storage.googleapis.com/bucket/stores/${OTHER}/uploads/x.jpg`,
        STORE,
      ),
    ).toBeNull();
    expect(
      ownedSourcePath("https://example.com/stores/x/uploads/y.jpg", STORE),
    ).toBeNull();
    expect(
      ownedSourcePath(
        `https://storage.googleapis.com/bucket/stores/${STORE}/../${OTHER}/x.jpg`,
        STORE,
      ),
    ).toBeNull();
  });
});

describe("refinePrompt", () => {
  it("names the exact size and forbids changing the product", () => {
    const prompt = refinePrompt(IMAGE_SPECS.product);
    expect(prompt).toContain("3:4");
    expect(prompt).toContain("1200 × 1600");
    expect(prompt).toMatch(/Do not redraw, restyle or correct the product/);
  });
});

describe("refineStoreImage", () => {
  it("returns a copy at exactly the slot's size, charged and saved to Media", async () => {
    state.generate.mockResolvedValue(await modelImage(1000, 1340));
    const result = await refineStoreImage({
      actor,
      sourceUrl: ownUrl,
      specKey: "product",
    });
    expect(result.chargedCredits).toBe(2);
    expect(result.url).toContain(`stores/${STORE}/refined/`);
    const meta = await sharp(state.uploads[0].bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1600]);
    expect(state.inserts[0]).toMatchObject({
      storeId: STORE,
      source: "mink_refined",
    });
    // Asked for the slot's aspect, with adults allowed (the merchant's own
    // model shot) and prominent people still blocked.
    const config = state.generate.mock.calls[0][0].config;
    expect(config.imageConfig).toMatchObject({
      aspectRatio: "3:4",
      personGeneration: "ALLOW_ADULT",
    });
  });

  it("★★ asks Nano Banana 2.1 for 2K at MINIMAL thinking, with no sampling parameter, in one user turn (owner, 25 Oct 2026)", async () => {
    state.generate.mockResolvedValue(await modelImage(1000, 1340));
    await refineStoreImage({ actor, sourceUrl: ownUrl, specKey: "product" });
    const params = state.generate.mock.calls[0][0];
    expect(params.model).toBe("gemini-nano-banana-2.1");
    expect(params.config.imageConfig.imageSize).toBe("2K");
    expect(params.config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    for (const parameter of IMAGE_SAMPLING_PARAMETERS) {
      expect(params.config).not.toHaveProperty(parameter);
    }
    // ★ One user turn: no earlier model turn, so no thought signature, is
    //   ever sent back.
    expect(params.contents).toHaveLength(1);
    expect(params.contents[0].role).toBe("user");
  });

  it("★★ a MINK_IMAGE_MODEL rollback is sent the same size and no thinking config", async () => {
    state.imageModel = "gemini-3.1-flash-image";
    state.generate.mockResolvedValue(await modelImage(1000, 1340));
    await refineStoreImage({ actor, sourceUrl: ownUrl, specKey: "product" });
    const params = state.generate.mock.calls[0][0];
    expect(params.model).toBe("gemini-3.1-flash-image");
    expect(params.config.imageConfig.imageSize).toBe("2K");
    expect(params.config).not.toHaveProperty("thinkingConfig");
  });

  it("refuses a slot that does not offer refine, before anything else", async () => {
    await expect(
      refineStoreImage({ actor, sourceUrl: ownUrl, specKey: "logo" }),
    ).rejects.toMatchObject({ code: "refine_not_offered" });
    expect(state.authority).not.toHaveBeenCalled();
  });

  it("refuses a photo that is not this store's", async () => {
    await expect(
      refineStoreImage({
        actor,
        sourceUrl: `https://storage.googleapis.com/bucket/stores/${OTHER}/uploads/x.jpg`,
        specKey: "product",
      }),
    ).rejects.toMatchObject({ code: "refine_source_not_owned" });
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("refuses an unaffordable refine WITHOUT calling the paid provider", async () => {
    state.remaining = 1;
    await expect(
      refineStoreImage({ actor, sourceUrl: ownUrl, specKey: "product" }),
    ).rejects.toMatchObject({ status: 402 });
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("deletes the stored copy when the charge loses a race", async () => {
    state.generate.mockResolvedValue(await modelImage(1200, 1600));
    state.chargeSource = "insufficient";
    await expect(
      refineStoreImage({ actor, sourceUrl: ownUrl, specKey: "product" }),
    ).rejects.toMatchObject({ code: "refine_insufficient_credits" });
    expect(state.deleted).toEqual([state.uploads[0].path]);
    expect(state.inserts).toHaveLength(0);
  });

  it("refines the final picture, never a thought draft sent ahead of it", async () => {
    // gemini-3-pro-image's answer shape since about 22 Oct 2026, and Nano
    // Banana 2.1's on every answer (25 Oct): a thought draft first (at HIGH
    // thinking with thought text around it), the picture asked for last.
    // This draft is not even an image, so keeping it would fail.
    const draft = {
      thought: true,
      inlineData: { data: Buffer.from("draft").toString("base64") },
    };
    const { candidates } = await modelImage(1000, 1340);
    state.generate.mockResolvedValue({
      candidates: [
        {
          ...candidates[0],
          content: {
            parts: [
              { text: "Planning the retouch", thought: true },
              draft,
              { text: "Checking the product", thought: true },
              ...candidates[0].content.parts,
            ],
          },
        },
      ],
    });
    const result = await refineStoreImage({
      actor,
      sourceUrl: ownUrl,
      specKey: "product",
    });
    expect(result.url).toContain(`stores/${STORE}/refined/`);
    const meta = await sharp(state.uploads[0].bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1600]);

    // A draft alone is no photo.
    state.generate.mockResolvedValue({
      candidates: [{ content: { parts: [draft] }, finishReason: "STOP" }],
    });
    await expect(
      refineStoreImage({ actor, sourceUrl: ownUrl, specKey: "product" }),
    ).rejects.toMatchObject({ code: "refine_refused" });
  });

  it("charges nothing when the provider returns no image", async () => {
    state.generate.mockResolvedValue({
      candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
    });
    await expect(
      refineStoreImage({ actor, sourceUrl: ownUrl, specKey: "product" }),
    ).rejects.toMatchObject({ code: "refine_refused" });
    expect(
      state.executed.some((q) => q.includes("consume_mink_refine_credits")),
    ).toBe(false);
  });
});

// ★★ B10 and B3 (2026-10-23): one 60 s try used to be all Refine had, and a
//    refusal still spent the store's hourly and daily image allowance.
// ★ These tests wait on real sharp work (see `until`), which a 2-core CI runner
//   with coverage does far more slowly than a laptop: 20 s each, set at the
//   end of this block, not the default 5.
describe("★★ Refine asks again, and a refusal spends no allowance", () => {
  const rateLimited = Object.assign(new Error("RESOURCE_EXHAUSTED"), {
    status: 429,
  });

  beforeEach(() => {
    // setImmediate stays real, so sharp's own work can finish between steps.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.giveBack.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Let real I/O (the sharp import and its image work) run until `condition`
   * holds.
   * ★★ Bounded by REAL time, and it FAILS when the time runs out. It used to
   *    stop quietly after 2,000 event-loop turns: on CI (2-core runner,
   *    coverage, 25 Oct 2026) sharp needed more turns than that, so a test
   *    went on to wind the fake clock before the first call was even sent. The
   *    retry wait was then scheduled after the clock had moved (a timeout), or
   *    Stop landed before the call (`sent` undefined), and the unfinished work
   *    leaked into the next test. `performance.now()` is not on the faked list
   *    above, so it is the real clock.
   */
  async function until(condition: () => boolean, limitMs = 10_000) {
    const started = performance.now();
    while (!condition()) {
      if (performance.now() - started > limitMs) {
        throw new Error(`until(): still not true after ${limitMs} ms`);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** A try that answers after `ms`, or stops at once when its signal fires. */
  function answersAfter(ms: number, outcome: unknown) {
    return (params: { config: { abortSignal: AbortSignal } }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => (outcome === "busy" ? reject(rateLimited) : resolve(outcome)),
          ms,
        );
        params.config.abortSignal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("This operation was aborted"));
          },
          { once: true },
        );
      });
  }

  const charged = () =>
    state.executed.filter((q) => q.includes("consume_mink_refine_credits"))
      .length;

  it("★★ two refused tries then a success: refined once, charged once, allowance kept", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const image = await modelImage(1000, 1340);
    state.generate
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(image);
    const pending = refineStoreImage({
      actor,
      sourceUrl: ownUrl,
      specKey: "product",
    });
    await until(() => state.generate.mock.calls.length === 1);
    // 5 s apart at the least, and asked again.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(state.generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(state.generate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_100);
    const result = await pending;

    expect(result.chargedCredits).toBe(2);
    expect(state.generate).toHaveBeenCalledTimes(3);
    expect(state.uploads).toHaveLength(1);
    expect(charged()).toBe(1);
    expect(state.giveBack).not.toHaveBeenCalled();
  });

  it("★★ three refusals give the allowance back and charge nothing", async () => {
    state.generate.mockRejectedValue(rateLimited);
    const settled = refineStoreImage({
      actor,
      sourceUrl: ownUrl,
      specKey: "product",
    }).catch((error) => error);
    await until(() => state.generate.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(40_000);
    const error = await settled;

    expect(error).toMatchObject({ code: "refine_provider_unavailable" });
    expect(state.generate).toHaveBeenCalledTimes(3);
    expect(state.giveBack).toHaveBeenCalledTimes(1);
    expect(state.uploads).toHaveLength(0);
    expect(charged()).toBe(0);
  });

  it("★★ a timeout keeps the allowance spent and is never asked again", async () => {
    state.generate.mockImplementation(answersAfter(120_000, {}));
    const settled = refineStoreImage({
      actor,
      sourceUrl: ownUrl,
      specKey: "product",
    }).catch((error) => error);
    await until(() => state.generate.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(60_100);
    const error = await settled;

    expect(error).toMatchObject({ code: "refine_provider_unavailable" });
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.giveBack).not.toHaveBeenCalled();
  });

  it("★★ every try has its own 60 s clock", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    state.generate
      .mockImplementationOnce(answersAfter(55_000, "busy"))
      .mockImplementationOnce(
        answersAfter(55_000, await modelImage(1000, 1340)),
      );
    const pending = refineStoreImage({
      actor,
      sourceUrl: ownUrl,
      specKey: "product",
    });
    await until(() => state.generate.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(55_000 + 5_000 + 55_000);
    const result = await pending;
    expect(result.url).toContain(`stores/${STORE}/refined/`);
    expect(state.generate).toHaveBeenCalledTimes(2);
  });

  it("★ the chain stops at the caller's deadline, and that refusal gives the allowance back", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    state.generate.mockRejectedValue(rateLimited);
    const settled = refineStoreImage({
      actor,
      sourceUrl: ownUrl,
      specKey: "product",
      // Room for one try (the deadline less the 15 s the writes need), not
      // for a 15 s wait and another.
      deadlineAt: Date.now() + 50_000,
    }).catch((error) => error);
    await until(() => state.generate.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(0);
    const error = await settled;
    expect(error).toMatchObject({ code: "refine_provider_unavailable" });
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.giveBack).toHaveBeenCalledTimes(1);
  });

  it("★ an unreadable source sends nothing and gives the allowance back", async () => {
    state.source = Buffer.from("not an image");
    await expect(
      refineStoreImage({ actor, sourceUrl: ownUrl, specKey: "product" }),
    ).rejects.toMatchObject({ code: "refine_source_unreadable" });
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.giveBack).toHaveBeenCalledTimes(1);
  });

  it("★ a caller stopped before the call sends nothing and gives it back", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(
      refineStoreImage({
        actor,
        sourceUrl: ownUrl,
        specKey: "product",
        signal: stop.signal,
      }),
    ).rejects.toMatchObject({ code: "refine_provider_unavailable" });
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.giveBack).toHaveBeenCalledTimes(1);
  });

  it("★★ the caller's stop aborts the call in flight; nothing is stored or charged, and it stays spent", async () => {
    const stop = new AbortController();
    let sent: AbortSignal | undefined;
    state.generate.mockImplementationOnce(
      (params: { config: { abortSignal: AbortSignal } }) => {
        sent = params.config.abortSignal;
        return answersAfter(30_000, {})(params);
      },
    );
    const settled = refineStoreImage({
      actor,
      sourceUrl: ownUrl,
      specKey: "product",
      signal: stop.signal,
    }).catch((error) => error);
    await until(() => state.generate.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(5_000);
    stop.abort();
    const error = await settled;
    expect(sent?.aborted).toBe(true);
    expect(error).toMatchObject({ code: "refine_provider_unavailable" });
    expect(state.uploads).toHaveLength(0);
    expect(charged()).toBe(0);
    expect(state.giveBack).not.toHaveBeenCalled();
  });

  it("★★ stopped after the photo came back: not stored, not charged", async () => {
    const stop = new AbortController();
    const image = await modelImage(1000, 1340);
    // The stop lands just as the answer is read, after the call returned.
    state.generate.mockResolvedValueOnce({
      get candidates() {
        stop.abort();
        return image.candidates;
      },
    });
    await expect(
      refineStoreImage({
        actor,
        sourceUrl: ownUrl,
        specKey: "product",
        signal: stop.signal,
      }),
    ).rejects.toMatchObject({ code: "refine_stopped" });
    expect(state.uploads).toHaveLength(0);
    expect(charged()).toBe(0);
    expect(state.giveBack).not.toHaveBeenCalled();
  });

  it("★★ stopped while the photo was being stored: the copy goes, nothing is charged", async () => {
    const stop = new AbortController();
    state.generate.mockResolvedValueOnce(await modelImage(1000, 1340));
    state.onUpload = () => stop.abort();
    await expect(
      refineStoreImage({
        actor,
        sourceUrl: ownUrl,
        specKey: "product",
        signal: stop.signal,
      }),
    ).rejects.toMatchObject({ code: "refine_stopped" });
    expect(state.deleted).toEqual([state.uploads[0].path]);
    expect(state.inserts).toHaveLength(0);
    expect(charged()).toBe(0);
    // The photo came back, so it may have been billed: it stays spent.
    expect(state.giveBack).not.toHaveBeenCalled();
  });
}, 20_000);
