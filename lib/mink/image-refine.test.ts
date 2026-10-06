import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const STORE = "a0000000-0000-4000-8000-0000000000aa";
const OTHER = "b0000000-0000-4000-8000-0000000000bb";

const state = vi.hoisted(() => ({
  remaining: 10,
  chargeSource: "plan" as string,
  executed: [] as string[],
  inserts: [] as Record<string, unknown>[],
  uploads: [] as { path: string; bytes: Buffer }[],
  deleted: [] as string[],
  generate: vi.fn(),
  reserve: vi.fn(async () => undefined),
  authority: vi.fn(async () => undefined),
  source: Buffer.alloc(0),
}));

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
    imageModel: "gemini-3.1-flash-image",
    imageLocation: "global",
    chargeCredits: true,
  }),
}));
vi.mock("./media-generation", () => ({
  reserveMinkImageGeneration: state.reserve,
}));
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
}));

import {
  ownedSourcePath,
  refinePrompt,
  refineStoreImage,
} from "./image-refine";
import { IMAGE_SPECS } from "@/lib/media/image-specs";
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
    expect(state.inserts[0]).toMatchObject({ storeId: STORE });
    // Asked for the slot's aspect, with adults allowed (the merchant's own
    // model shot) and prominent people still blocked.
    const config = state.generate.mock.calls[0][0].config;
    expect(config.imageConfig).toMatchObject({
      aspectRatio: "3:4",
      personGeneration: "ALLOW_ADULT",
    });
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
