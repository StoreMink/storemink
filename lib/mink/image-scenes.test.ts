import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { MinkActorContext } from "./types";
import { MinkRequestError } from "./errors";
import { IMAGE_SPECS } from "@/lib/media/image-specs";
import { scenePreset } from "@/lib/media/scene-presets";

const STORE = "a0000000-0000-4000-8000-0000000000aa";
const BUCKET = "https://storage.googleapis.com/bucket/";

const state = vi.hoisted(() => ({
  generate: vi.fn(),
  reserve: vi.fn(async () => undefined),
  authority: vi.fn(async () => undefined),
  chargeSource: "plan",
  executed: [] as string[],
  uploads: [] as string[],
  deleted: [] as string[],
  objects: new Map<string, Buffer>(),
  config: {
    enabled: true,
    projectId: "proj",
    imageModel: "gemini-3.1-flash-image",
    imageLocation: "global",
    chargeCredits: true,
  },
}));

vi.mock("@/lib/db/client", () => {
  const db = {
    execute: async (query: unknown) => {
      const text = JSON.stringify(query);
      state.executed.push(text);
      if (text.includes("consume_mink_scene_credits"))
        return { rows: [{ source: state.chargeSource }] };
      return { rows: [] };
    },
  };
  return {
    withService: async (operation: (d: typeof db) => unknown) => operation(db),
  };
});
vi.mock("@/lib/storage/gcs", () => ({
  gcsDownloadObject: async (path: string) => {
    const bytes = state.objects.get(path);
    if (!bytes) throw new Error("gone");
    return new Uint8Array(bytes);
  },
  gcsUploadObject: async (path: string, bytes: Buffer) => {
    state.uploads.push(path);
    state.objects.set(path, bytes);
    return `${BUCKET}${path}`;
  },
  gcsDeletePaths: async (paths: string[]) => {
    state.deleted.push(...paths);
    return [];
  },
}));
vi.mock("./config", () => ({ getMinkConfig: () => state.config }));
vi.mock("./media-generation", () => ({
  reserveMinkImageGeneration: state.reserve,
}));
vi.mock("./media-image-proposals", () => ({
  assertMediaGenerationAuthority: state.authority,
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: () => undefined,
  logWarn: () => undefined,
}));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: state.generate };
  },
  HarmBlockThreshold: { BLOCK_LOW_AND_ABOVE: "BLOCK_LOW_AND_ABOVE" },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "H",
    HARM_CATEGORY_HATE_SPEECH: "HS",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "SE",
    HARM_CATEGORY_DANGEROUS_CONTENT: "DC",
  },
  Modality: { TEXT: "TEXT", IMAGE: "IMAGE" },
  ProminentPeople: { BLOCK_PROMINENT_PEOPLE: "BLOCK" },
}));

import { getOrCreateScene } from "./image-scenes";

const SPEC = IMAGE_SPECS.product;
const PRESET = scenePreset("marble")!;
const HEADROOM = { period: "2026-10", planCap: 20, remaining: 10 };

function actor(): MinkActorContext {
  return {
    storeId: STORE,
    adminId: "admin-1",
    email: null,
    roleSlug: "superadmin",
    permissions: {},
    isSuperadmin: true,
    effectivePlan: "basic",
    locationIds: null,
    analyticsTimeZone: "Asia/Kolkata",
    currency: "INR",
    defaultLowStockThreshold: 5,
    requestId: "r",
  };
}

async function imageAnswer() {
  const jpeg = await sharp({
    create: { width: 300, height: 400, channels: 3, background: "#eeeeee" },
  })
    .jpeg()
    .toBuffer();
  return {
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ inlineData: { data: jpeg.toString("base64") } }] },
      },
    ],
    usageMetadata: { candidatesTokenCount: 1680 },
  };
}

const refused = {
  candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }],
  usageMetadata: { promptTokenCount: 300 },
};

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MinkRequestError);
  return error as MinkRequestError;
}

beforeEach(() => {
  state.generate.mockReset();
  state.reserve.mockClear();
  state.authority.mockClear();
  state.chargeSource = "plan";
  state.executed = [];
  state.uploads = [];
  state.deleted = [];
  state.objects.clear();
});

describe("getOrCreateScene", () => {
  it("reuses the store's saved scene without asking the model or charging", async () => {
    state.objects.set("stores/x/scenes/old.webp", Buffer.from("old"));
    const scene = await getOrCreateScene({
      actor: actor(),
      preset: PRESET,
      spec: SPEC,
      existing: {
        id: "old",
        preset: "marble",
        url: `${BUCKET}stores/x/scenes/old.webp`,
        path: "stores/x/scenes/old.webp",
        createdAt: "",
      },
      fresh: false,
      config: null,
      headroom: HEADROOM,
    });
    expect(scene).toMatchObject({
      id: "old",
      chargedCredits: 0,
      created: false,
    });
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.authority).not.toHaveBeenCalled();
  });

  it("draws an empty set with no people, stores it at the slot's size and charges 5", async () => {
    state.generate.mockResolvedValueOnce(await imageAnswer());
    const scene = await getOrCreateScene({
      actor: actor(),
      preset: PRESET,
      spec: SPEC,
      existing: null,
      fresh: false,
      config: null,
      headroom: HEADROOM,
    });
    expect(state.authority).toHaveBeenCalledOnce();
    expect(state.reserve).toHaveBeenCalledOnce();
    const request = state.generate.mock.calls[0][0];
    expect(request.model).toBe("gemini-3.1-flash-image");
    expect(request.contents[0].parts).toHaveLength(1); // text only, no product
    expect(request.contents[0].parts[0].text).toContain("empty set");
    expect(request.config.imageConfig).toMatchObject({
      aspectRatio: "3:4",
      personGeneration: "ALLOW_NONE",
    });
    expect(state.uploads[0]).toMatch(
      new RegExp(`^stores/${STORE}/scenes/.+\\.webp$`),
    );
    const meta = await sharp(state.objects.get(state.uploads[0])!).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1600]);
    expect(
      state.executed.some((t) => t.includes("consume_mink_scene_credits")),
    ).toBe(true);
    expect(scene).toMatchObject({ chargedCredits: 5, created: true });
  });

  it("deletes the stored scene when the charge finds no credits", async () => {
    state.generate.mockResolvedValueOnce(await imageAnswer());
    state.chargeSource = "insufficient";
    const error = await codeOf(
      getOrCreateScene({
        actor: actor(),
        preset: PRESET,
        spec: SPEC,
        existing: null,
        fresh: true,
        config: null,
        headroom: HEADROOM,
      }),
    );
    expect(error.status).toBe(402);
    expect(state.deleted).toEqual(state.uploads);
  });

  it("asks once more after a refusal that drew nothing, then explains a second one", async () => {
    state.generate.mockResolvedValueOnce(refused);
    state.generate.mockResolvedValueOnce(await imageAnswer());
    const scene = await getOrCreateScene({
      actor: actor(),
      preset: PRESET,
      spec: SPEC,
      existing: null,
      fresh: false,
      config: null,
      headroom: HEADROOM,
    });
    expect(state.generate).toHaveBeenCalledTimes(2);
    expect(scene.created).toBe(true);

    state.generate.mockReset();
    state.generate.mockResolvedValue(refused);
    const error = await codeOf(
      getOrCreateScene({
        actor: actor(),
        preset: PRESET,
        spec: SPEC,
        existing: null,
        fresh: false,
        config: null,
        headroom: HEADROOM,
      }),
    );
    expect(state.generate).toHaveBeenCalledTimes(2);
    expect(error.status).toBe(422);
    expect(error.message).toMatch(/safety check/);
  });

  it("does not ask again when an image was billed but not returned", async () => {
    state.generate.mockResolvedValue({
      candidates: [{ finishReason: "OTHER", content: { parts: [] } }],
      usageMetadata: { candidatesTokenCount: 1680 },
    });
    await codeOf(
      getOrCreateScene({
        actor: actor(),
        preset: PRESET,
        spec: SPEC,
        existing: null,
        fresh: false,
        config: null,
        headroom: HEADROOM,
      }),
    );
    expect(state.generate).toHaveBeenCalledTimes(1);
  });

  it("calls a quota refusal busy and never retries a provider error", async () => {
    state.generate.mockRejectedValueOnce(
      Object.assign(new Error("exhausted"), { status: 429 }),
    );
    const busy = await codeOf(
      getOrCreateScene({
        actor: actor(),
        preset: PRESET,
        spec: SPEC,
        existing: null,
        fresh: false,
        config: null,
        headroom: HEADROOM,
      }),
    );
    expect(busy.code).toBe("scene_busy");
    expect(busy.status).toBe(429);

    state.generate.mockReset();
    state.generate.mockRejectedValueOnce(new Error("timeout"));
    const down = await codeOf(
      getOrCreateScene({
        actor: actor(),
        preset: PRESET,
        spec: SPEC,
        existing: null,
        fresh: false,
        config: null,
        headroom: HEADROOM,
      }),
    );
    expect(down.status).toBe(503);
    expect(state.generate).toHaveBeenCalledTimes(1);
  });

  it("refuses an unplanned draw the store cannot pay for before the model is called", async () => {
    const error = await codeOf(
      getOrCreateScene({
        actor: actor(),
        preset: PRESET,
        spec: SPEC,
        existing: {
          id: "lost",
          preset: "marble",
          url: "",
          path: "stores/x/scenes/lost.webp",
          createdAt: "",
        },
        fresh: false,
        config: null,
        headroom: { ...HEADROOM, remaining: 2 },
      }),
    );
    expect(error.code).toBe("scene_insufficient_credits");
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("is unavailable when Mink is switched off", async () => {
    state.config = { ...state.config, enabled: false };
    try {
      const error = await codeOf(
        getOrCreateScene({
          actor: actor(),
          preset: PRESET,
          spec: SPEC,
          existing: null,
          fresh: false,
          config: null,
          headroom: HEADROOM,
        }),
      );
      expect(error.code).toBe("scene_not_available");
      expect(state.generate).not.toHaveBeenCalled();
    } finally {
      state.config = { ...state.config, enabled: true };
    }
  });
});
