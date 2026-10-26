import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const STORE = "a0000000-0000-4000-8000-0000000000aa";
const OTHER = "b0000000-0000-4000-8000-0000000000bb";

const state = vi.hoisted(() => {
  // Built first, so `reserve` can hand it out without `state` naming itself.
  const giveBack = vi.fn(async () => undefined);
  return {
    remaining: 10,
    chargeSource: "plan" as string | undefined,
    /** Makes the charge transaction's consume call throw. */
    chargeError: null as Error | null,
    executed: [] as string[],
    inserts: [] as Record<string, unknown>[],
    /** PUBLIC uploads (gcsUploadObject): only ever after the charge. */
    uploads: [] as { path: string; bytes: Buffer }[],
    /** Throws on this many public uploads before one succeeds. */
    uploadFailures: 0,
    /** PRIVATE stages (gcsPrivateUploadObject). */
    staged: [] as { path: string; bytes: Buffer }[],
    deleted: [] as { path: string; kind: string }[],
    /** What happened, in order, for the order assertions. */
    events: [] as string[],
    privateConfigured: true,
    generate: vi.fn(),
    giveBack,
    reserve: vi.fn(async () => ({ giveBack })),
    authority: vi.fn(async () => undefined),
    source: Buffer.alloc(0),
    onStage: null as null | (() => void),
    imageModel: "gemini-nano-banana-2.1",
  };
});

vi.mock("@/lib/db/client", () => {
  const db = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(query);
      state.executed.push(text);
      if (text.includes("consume_mink_refine_credits")) {
        state.events.push("consume");
        if (state.chargeError) throw state.chargeError;
        return { rows: [{ source: state.chargeSource }] };
      }
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
    withService: async (operation: (d: typeof db) => unknown) => {
      state.events.push("scope");
      return operation(db);
    },
  };
});
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  get gcsPrivateConfigured() {
    return state.privateConfigured;
  },
  gcsPathFromUrl: (url: string) =>
    url.startsWith("https://storage.googleapis.com/bucket/")
      ? url.slice("https://storage.googleapis.com/bucket/".length)
      : null,
  gcsPublicUrl: (path: string) =>
    `https://storage.googleapis.com/bucket/${path}`,
  gcsDownloadObject: async () => new Uint8Array(state.source),
  gcsPrivateUploadObject: async (path: string, bytes: Buffer) => {
    state.staged.push({ path, bytes });
    state.events.push("stage");
    state.onStage?.();
  },
  gcsUploadObject: async (path: string, bytes: Buffer) => {
    if (state.uploadFailures > 0) {
      state.uploadFailures -= 1;
      throw new Error("upload failed");
    }
    state.uploads.push({ path, bytes });
    state.events.push("upload");
    return `https://storage.googleapis.com/bucket/${path}`;
  },
  gcsDeletePaths: async (paths: string[], kind = "public") => {
    state.deleted.push(...paths.map((path) => ({ path, kind })));
    state.events.push(`delete:${kind}`);
    return [];
  },
}));
// ★ The stop handshake is mocked whole (refine-stop.test.ts pins it): a fresh
//   begin, a claim that wins, and a watch whose settle resolves on a later
//   turn, so a settle that is not awaited shows in the order.
vi.mock("./refine-stop", () => ({
  beginRefineRequest: vi.fn(async () => "fresh"),
  claimRefineCharge: vi.fn(async () => {
    state.events.push("claim");
    return true;
  }),
  watchRefineStop: vi.fn(() => ({
    close: vi.fn(),
    settled: vi.fn(
      () =>
        new Promise<void>((resolve) =>
          setImmediate(() => {
            state.events.push("settled");
            resolve();
          }),
        ),
    ),
    checkNow: vi.fn(async () => false),
  })),
  registerLiveRefine: vi.fn(() => () => {}),
  refineChargeCommitted: vi.fn(async () => false),
  abandonRefineStage: vi.fn(async () => "discard"),
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
import {
  abandonRefineStage,
  beginRefineRequest,
  claimRefineCharge,
  refineChargeCommitted,
  registerLiveRefine,
  watchRefineStop,
} from "./refine-stop";
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
  state.chargeError = null;
  state.executed = [];
  state.inserts = [];
  state.uploads = [];
  state.uploadFailures = 0;
  state.staged = [];
  state.deleted = [];
  state.events = [];
  state.privateConfigured = true;
  state.generate.mockReset();
  state.onStage = null;
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a copy at exactly the slot's size, charged and saved to Media", async () => {
    vi.stubEnv("DB_NAME", "storemink_test");
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
    // ★★ Staged privately under this database's prefix, charged, THEN
    //   published, then the stage removed. The watch had settled (no read
    //   holding a connection) before the charge transaction opened, and the
    //   claim was that transaction's first statement.
    const refinementId = /refined\/([0-9a-f-]{36})\.webp$/.exec(result.url)![1];
    const stagePath = `refine-stage/storemink_test/${STORE}/${refinementId}.webp`;
    expect(state.staged.map((stage) => stage.path)).toEqual([stagePath]);
    expect(state.uploads.map((upload) => upload.path)).toEqual([
      `stores/${STORE}/refined/${refinementId}.webp`,
    ]);
    expect(state.deleted).toEqual([{ path: stagePath, kind: "private" }]);
    expect(state.inserts[0]).toMatchObject({
      url: result.url,
      path: `stores/${STORE}/refined/${refinementId}.webp`,
    });
    const at = (event: string) => state.events.indexOf(event);
    expect(at("stage")).toBeGreaterThan(-1);
    expect(at("stage")).toBeLessThan(at("settled"));
    expect(at("settled")).toBeLessThan(state.events.lastIndexOf("scope"));
    expect(state.events.lastIndexOf("scope")).toBeLessThan(at("claim"));
    expect(at("claim")).toBeLessThan(at("consume"));
    expect(at("consume")).toBeLessThan(at("upload"));
    expect(at("upload")).toBeLessThan(at("delete:private"));
    // The ledger records the PUBLIC path: a path there means charged.
    const ledger = state.executed.find((query) =>
      query.includes("update public.mink_image_refinements"),
    );
    expect(ledger).toContain(`stores/${STORE}/refined/${refinementId}.webp`);
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

  it("★★ insufficient after all: the PRIVATE stage is deleted and nothing is ever public", async () => {
    state.generate.mockResolvedValue(await modelImage(1200, 1600));
    state.chargeSource = "insufficient";
    await expect(
      refineStoreImage({ actor, sourceUrl: ownUrl, specKey: "product" }),
    ).rejects.toMatchObject({ code: "refine_insufficient_credits" });
    expect(state.staged).toHaveLength(1);
    expect(state.deleted).toEqual([
      { path: state.staged[0].path, kind: "private" },
    ]);
    expect(state.uploads).toHaveLength(0);
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

// ★★ Leaving mid-refine charges nothing, and no unpaid picture is ever public
//    (owner, 26 Oct 2026): the browser's stop token, the refine's own row,
//    a private stage, the charge, then the publish.
describe("★★ the stop, the stage and the charge", () => {
  const TOKEN = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
  const refine = (extra: { stopToken?: string } = {}) =>
    refineStoreImage({
      actor,
      sourceUrl: ownUrl,
      specKey: "product",
      ...extra,
    });
  const charged = () =>
    state.executed.filter((q) => q.includes("consume_mink_refine_credits"))
      .length;
  /** The watch the refine opened (watchRefineStop is mocked). */
  const openedWatch = () =>
    vi.mocked(watchRefineStop).mock.results[0].value as {
      close: ReturnType<typeof vi.fn>;
      settled: ReturnType<typeof vi.fn>;
      checkNow: ReturnType<typeof vi.fn>;
    };

  beforeEach(async () => {
    state.generate.mockResolvedValue(await modelImage(1000, 1340));
  });

  it("★ begins the row with the browser's token, lower-cased, and the server's own refine id", async () => {
    await refine({ stopToken: TOKEN.toUpperCase() });
    const [key, refinementId] = vi.mocked(beginRefineRequest).mock.calls[0];
    expect(key).toEqual({
      storeId: STORE,
      adminId: "admin-1",
      stopToken: TOKEN,
    });
    expect(refinementId).toMatch(/^[0-9a-f-]{36}$/);
    expect(refinementId).not.toBe(TOKEN);
    expect(watchRefineStop).toHaveBeenCalledWith(key, expect.any(Function));
    expect(registerLiveRefine).toHaveBeenCalledWith(key, expect.any(Function));
    expect(claimRefineCharge).toHaveBeenCalledWith(
      expect.anything(),
      key,
      refinementId,
    );
  });

  it("★ a tab without a token gets a server token: the same row and storage path", async () => {
    const result = await refine();
    const [key] = vi.mocked(beginRefineRequest).mock.calls[0];
    expect(key.stopToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(state.staged).toHaveLength(1);
    expect(result.url).toContain(`stores/${STORE}/refined/`);
  });

  it("★★ a stop that arrived first: cancelled before anything is reserved or sent", async () => {
    vi.mocked(beginRefineRequest).mockResolvedValueOnce("stopped");
    await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
      code: "refine_cancelled",
      status: 409,
      message: "Refining was stopped. Nothing was charged.",
    });
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
    expect(watchRefineStop).not.toHaveBeenCalled();
  });

  it("★ the same token already refining is refused as a duplicate", async () => {
    vi.mocked(beginRefineRequest).mockResolvedValueOnce("duplicate");
    await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
      code: "refine_duplicate",
      status: 409,
      message: "This photo is already being refined.",
    });
    expect(state.reserve).not.toHaveBeenCalled();
  });

  it("★★ a begin that fails refuses before anything is reserved", async () => {
    vi.mocked(beginRefineRequest).mockRejectedValueOnce(
      new Error("too many clients"),
    );
    await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
      code: "refine_unavailable",
      status: 503,
      message: "Refining couldn't start. Nothing was charged; try again.",
    });
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("★ no stop table (local, before 0247): unguarded, no watch and no claim, the same private-first path", async () => {
    vi.mocked(beginRefineRequest).mockResolvedValueOnce("unavailable");
    const result = await refine({ stopToken: TOKEN });
    expect(result.chargedCredits).toBe(2);
    expect(watchRefineStop).not.toHaveBeenCalled();
    expect(registerLiveRefine).not.toHaveBeenCalled();
    expect(claimRefineCharge).not.toHaveBeenCalled();
    expect(state.events.indexOf("stage")).toBeLessThan(
      state.events.indexOf("consume"),
    );
    expect(state.events.indexOf("consume")).toBeLessThan(
      state.events.indexOf("upload"),
    );
  });

  it("★★ the pre-send check: a stop seen there gives the allowance back and sends nothing", async () => {
    vi.mocked(watchRefineStop).mockImplementationOnce(() => ({
      close: vi.fn(),
      settled: vi.fn(async () => {}),
      checkNow: vi.fn(async () => true),
    }));
    await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
      code: "refine_cancelled",
    });
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.giveBack).toHaveBeenCalledOnce();
    expect(state.staged).toHaveLength(0);
  });

  it("★★ a stop seen after the photo came back: cancelled, nothing staged or charged, and it stays spent", async () => {
    const image = await modelImage(1000, 1340);
    state.generate.mockReset();
    // The stop lands (on this instance) just as the answer is read.
    state.generate.mockResolvedValueOnce({
      get candidates() {
        const onStop = vi.mocked(registerLiveRefine).mock.calls[0][1];
        onStop();
        return image.candidates;
      },
    });
    await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
      code: "refine_cancelled",
    });
    expect(state.staged).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
    expect(charged()).toBe(0);
    expect(state.giveBack).not.toHaveBeenCalled();
    // ★ Whatever way it ends, the watch closes and the live entry goes.
    expect(openedWatch().close).toHaveBeenCalled();
  });

  it("★★ a stop seen while staging: the PRIVATE stage goes, nothing is charged", async () => {
    state.onStage = () => vi.mocked(watchRefineStop).mock.calls[0][1]();
    await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
      code: "refine_cancelled",
    });
    expect(state.deleted).toEqual([
      { path: state.staged[0].path, kind: "private" },
    ]);
    expect(state.uploads).toHaveLength(0);
    expect(charged()).toBe(0);
  });

  it("★★ the claim lost to a stop: the stage goes, nothing is charged or public", async () => {
    vi.mocked(claimRefineCharge).mockResolvedValueOnce(false);
    await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
      code: "refine_cancelled",
    });
    expect(charged()).toBe(0);
    expect(state.inserts).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
    expect(state.deleted).toEqual([
      { path: state.staged[0].path, kind: "private" },
    ]);
  });

  it("★★ a charge that returned nothing fails closed", async () => {
    state.chargeSource = undefined;
    await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
      code: "refine_charge_failed",
    });
    expect(state.inserts).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
  });

  describe("★★ an error from the charge transaction: the abandon decides", () => {
    beforeEach(() => {
      state.chargeError = new Error("Connection terminated during COMMIT");
    });

    it("★★ charged after all: publishes the stage's bytes and answers success", async () => {
      vi.mocked(abandonRefineStage).mockImplementationOnce(
        async (_storeId, refinementId) => ({
          publish: `stores/${STORE}/refined/${refinementId}.webp`,
        }),
      );
      const result = await refine({ stopToken: TOKEN });
      const [storeId, refinementId] =
        vi.mocked(abandonRefineStage).mock.calls[0];
      expect(storeId).toBe(STORE);
      expect(result.url).toBe(
        `https://storage.googleapis.com/bucket/stores/${STORE}/refined/${refinementId}.webp`,
      );
      expect(state.uploads.map((upload) => upload.path)).toEqual([
        `stores/${STORE}/refined/${refinementId}.webp`,
      ]);
      expect(state.uploads[0].bytes).toEqual(state.staged[0].bytes);
      expect(state.deleted).toEqual([
        { path: state.staged[0].path, kind: "private" },
      ]);
      expect(refineChargeCommitted).not.toHaveBeenCalled();
    });

    it("★★ provably not charged: the stage goes, and it says nothing was charged", async () => {
      vi.mocked(abandonRefineStage).mockResolvedValueOnce("discard");
      await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
        code: "refine_charge_failed",
        message:
          "The refined photo couldn't be saved. Nothing was charged; try again.",
      });
      expect(state.deleted).toEqual([
        { path: state.staged[0].path, kind: "private" },
      ]);
      expect(state.uploads).toHaveLength(0);
      expect(refineChargeCommitted).not.toHaveBeenCalled();
    });

    it("★★ unknown (the abandon failed too): the stage is KEPT for the sweep, and nothing is promised", async () => {
      vi.mocked(abandonRefineStage).mockRejectedValueOnce(
        new Error("database down"),
      );
      await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
        code: "refine_charge_unknown",
        status: 503,
        message:
          "We couldn't confirm whether your refined photo was saved. Check your Media Library before you try again.",
      });
      expect(state.deleted).toEqual([]);
      expect(state.uploads).toHaveLength(0);
    });

    it("★ an unguarded refine (no row to lock) reads the ledger instead", async () => {
      vi.mocked(beginRefineRequest).mockResolvedValueOnce("unavailable");
      vi.mocked(refineChargeCommitted).mockResolvedValueOnce(true);
      const result = await refine({ stopToken: TOKEN });
      expect(result.url).toContain(`stores/${STORE}/refined/`);
      expect(abandonRefineStage).not.toHaveBeenCalled();
      expect(state.uploads).toHaveLength(1);

      vi.mocked(beginRefineRequest).mockResolvedValueOnce("unavailable");
      await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
        code: "refine_charge_failed",
      });
      expect(abandonRefineStage).not.toHaveBeenCalled();
    });
  });

  it("★★ a publish that fails three times answers 'still being saved', keeps the stage, never a plain error", async () => {
    state.uploadFailures = 3;
    const error = await refine({ stopToken: TOKEN }).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "refine_saving",
      status: 503,
      message:
        "Your refined photo was made and is still being saved. It will appear in your Media Library in a few minutes.",
    });
    // Charged, in the Media Library, and the stage kept for the sweep.
    expect(charged()).toBe(1);
    expect(state.inserts).toHaveLength(1);
    expect(state.deleted).toEqual([]);
  });

  it("★★ no private bucket: refused before anything else", async () => {
    state.privateConfigured = false;
    await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
      code: "refine_not_configured",
      status: 503,
    });
    expect(state.authority).not.toHaveBeenCalled();
    expect(beginRefineRequest).not.toHaveBeenCalled();
  });

  describe("★ a failed query is logged by its reason, never with the token", () => {
    // Drizzle's own message for a failed query carries its parameters; the
    // begin's and the claim's include the browser's token.
    const REASON = "terminating connection due to administrator command";
    const failedQuery = () =>
      Object.assign(
        new Error(
          `Failed query: update public.mink_refine_requests ...\nparams: ${STORE},admin-1,${TOKEN}`,
        ),
        { cause: new Error(REASON) },
      );
    /** What the real logger wrote as errors. */
    let lines: string[] = [];
    beforeEach(() => {
      lines = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    });
    afterEach(() => vi.mocked(console.error).mockRestore());
    const written = () => lines.join("\n");

    it.each([
      [
        "the begin",
        "refine_unavailable",
        () =>
          vi.mocked(beginRefineRequest).mockRejectedValueOnce(failedQuery()),
      ],
      [
        "the claim, provably not charged",
        "refine_charge_failed",
        () => vi.mocked(claimRefineCharge).mockRejectedValueOnce(failedQuery()),
      ],
      [
        "the claim, outcome unknown",
        "refine_charge_unknown",
        () => {
          vi.mocked(claimRefineCharge).mockRejectedValueOnce(failedQuery());
          vi.mocked(abandonRefineStage).mockRejectedValueOnce(
            new Error("database down"),
          );
        },
      ],
    ])("%s", async (_label, code, arrange) => {
      arrange();
      await expect(refine({ stopToken: TOKEN })).rejects.toMatchObject({
        code,
      });
      expect(written()).toContain(REASON);
      expect(written()).not.toContain(TOKEN);
    });
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

  it("★★ the merchant's stop (seen by the watch) aborts the call in flight: cancelled, nothing staged, and it stays spent", async () => {
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
      stopToken: "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b",
    }).catch((error) => error);
    await until(() => state.generate.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(5_000);
    // What the watcher does when it reads a stop recorded on another instance.
    vi.mocked(watchRefineStop).mock.calls[0][1]();
    const error = await settled;
    expect(sent?.aborted).toBe(true);
    expect(error).toMatchObject({ code: "refine_cancelled", status: 409 });
    expect(state.staged).toHaveLength(0);
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
    expect(state.staged).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
    expect(charged()).toBe(0);
    expect(state.giveBack).not.toHaveBeenCalled();
  });

  it("★★ stopped while the photo was being staged: the PRIVATE stage goes, nothing is public or charged", async () => {
    const stop = new AbortController();
    state.generate.mockResolvedValueOnce(await modelImage(1000, 1340));
    state.onStage = () => stop.abort();
    await expect(
      refineStoreImage({
        actor,
        sourceUrl: ownUrl,
        specKey: "product",
        signal: stop.signal,
      }),
    ).rejects.toMatchObject({ code: "refine_stopped" });
    expect(state.deleted).toEqual([
      { path: state.staged[0].path, kind: "private" },
    ]);
    expect(state.uploads).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
    expect(charged()).toBe(0);
    // The photo came back, so it may have been billed: it stays spent.
    expect(state.giveBack).not.toHaveBeenCalled();
  });
}, 20_000);
