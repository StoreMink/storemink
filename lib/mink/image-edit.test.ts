import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { MinkActorContext } from "./types";
import { MinkRequestError } from "./errors";

const STORE = "a0000000-0000-4000-8000-0000000000aa";
const OTHER = "b0000000-0000-4000-8000-0000000000bb";
const BUCKET = "https://storage.googleapis.com/bucket/";
const SOURCE = `${BUCKET}stores/${STORE}/uploads/tee.png`;

const state = vi.hoisted(() => ({
  generate: vi.fn(),
  reserve: vi.fn(async () => undefined),
  authority: vi.fn(async () => undefined),
  chargeSource: "plan",
  headroom: { period: "2026-10", planCap: 20, remaining: 10 } as {
    period: string;
    planCap: number | null;
    remaining: number | null;
  },
  executed: [] as string[],
  inserts: [] as Record<string, unknown>[],
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
      if (text.includes("consume_mink_photo_edit_credits"))
        return { rows: [{ source: state.chargeSource }] };
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
    url.startsWith(BUCKET) ? url.slice(BUCKET.length) : null,
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
vi.mock("./image-credits", () => ({
  imageCreditHeadroom: async () => state.headroom,
  canAfford: (h: { remaining: number | null }, credits: number) =>
    h.remaining === null || h.remaining >= credits,
}));
vi.mock("./media-generation", () => ({
  reserveMinkImageGeneration: state.reserve,
}));
vi.mock("./media-image-proposals", () => ({
  assertMediaGenerationAuthority: state.authority,
}));
vi.mock("@/lib/media/background-edit", () => ({ EDITED_FOLDER: "edited" }));
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

import { editProductPhoto } from "./image-edit";

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

/** A model answer: a 4:5 photo, as the model returns for a 3:4 request. */
async function imageAnswer() {
  const jpeg = await sharp({
    create: { width: 400, height: 500, channels: 3, background: "#3a6b35" },
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
  usageMetadata: { promptTokenCount: 600 },
};

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MinkRequestError);
  return error as MinkRequestError;
}

const edit = (
  overrides: Partial<Parameters<typeof editProductPhoto>[0]> = {},
) =>
  editProductPhoto({
    actor: actor(),
    sourceUrl: SOURCE,
    specKey: "product",
    instruction: "hanging from a tree in a garden",
    ...overrides,
  });

beforeEach(async () => {
  state.generate.mockReset();
  state.reserve.mockClear();
  state.authority.mockReset();
  state.authority.mockImplementation(async () => undefined);
  state.chargeSource = "plan";
  state.headroom = { period: "2026-10", planCap: 20, remaining: 10 };
  state.executed = [];
  state.inserts = [];
  state.uploads = [];
  state.deleted = [];
  state.objects.clear();
  state.objects.set(
    `stores/${STORE}/uploads/tee.png`,
    await sharp({
      create: {
        width: 300,
        height: 300,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer(),
  );
  state.config = {
    enabled: true,
    projectId: "proj",
    imageModel: "gemini-3.1-flash-image",
    imageLocation: "global",
    chargeCredits: true,
  };
});

describe("editProductPhoto", () => {
  it("sends the real photo with the request, adults allowed, famous people blocked", async () => {
    state.generate.mockResolvedValueOnce(await imageAnswer());
    await edit();
    const call = state.generate.mock.calls[0][0];
    const [prompt, photo] = call.contents[0].parts;
    expect(prompt.text).toContain("hanging from a tree in a garden");
    expect(prompt.text).toContain("KEEP THE PRODUCT EXACTLY THE SAME");
    expect(photo.inlineData.mimeType).toBe("image/jpeg");
    expect(call.config.imageConfig).toMatchObject({
      aspectRatio: "3:4",
      personGeneration: "ALLOW_ADULT",
      prominentPeople: "BLOCK",
    });
  });

  it("fits the photo to the slot exactly, stores it, records it and charges 5", async () => {
    state.generate.mockResolvedValueOnce(await imageAnswer());
    const result = await edit();
    expect(result).toMatchObject({
      width: 1200,
      height: 1600,
      chargedCredits: 5,
    });
    expect(result.url).toMatch(/\/stores\/a0+-.+\/edited\/ai-.+\.webp$/);
    const stored = state.objects.get(result.url.slice(BUCKET.length))!;
    const meta = await sharp(stored).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1600]);
    const charge = state.executed.find((q) =>
      q.includes("consume_mink_photo_edit_credits"),
    )!;
    expect(charge).toContain("hanging from a tree in a garden");
    expect(state.inserts[0]).toMatchObject({
      storeId: STORE,
      source: "mink_edited",
      filename: "scene-product-1200x1600.webp",
    });
    expect(state.reserve).toHaveBeenCalledOnce();
  });

  it("charges nothing on an unmetered plan", async () => {
    state.chargeSource = "plan_unlimited";
    state.generate.mockResolvedValueOnce(await imageAnswer());
    expect((await edit()).chargedCredits).toBe(0);
  });

  it("refuses a store that cannot pay before the model is called", async () => {
    state.headroom = { period: "2026-10", planCap: 20, remaining: 4 };
    const error = await failure(edit());
    expect(error.status).toBe(402);
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.reserve).not.toHaveBeenCalled();
  });

  it("deletes the stored photo when the credits ran out meanwhile", async () => {
    state.chargeSource = "insufficient";
    state.generate.mockResolvedValueOnce(await imageAnswer());
    const error = await failure(edit());
    expect(error.code).toBe("edit_insufficient_credits");
    expect(state.deleted).toEqual(state.uploads);
    expect(state.inserts).toHaveLength(0);
  });

  it("refuses another store's photo unread, and a blank request", async () => {
    const foreign = await failure(
      edit({ sourceUrl: `${BUCKET}stores/${OTHER}/uploads/x.png` }),
    );
    expect(foreign.code).toBe("edit_source_not_owned");
    const blank = await failure(edit({ instruction: "  " }));
    expect(blank.code).toBe("edit_instruction_missing");
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("is not offered for a banner, and needs Mink and the generation gates", async () => {
    expect((await failure(edit({ specKey: "blog_cover" }))).status).toBe(400);
    state.config = { ...state.config, enabled: false };
    expect((await failure(edit())).code).toBe("edit_not_available");
    state.config = { ...state.config, enabled: true };
    state.authority.mockRejectedValueOnce(new Error("no media permission"));
    await expect(edit()).rejects.toThrow("no media permission");
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("asks once more after a refusal that drew nothing, never after an error", async () => {
    state.generate
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(await imageAnswer());
    expect((await edit()).chargedCredits).toBe(5);
    expect(state.generate).toHaveBeenCalledTimes(2);

    state.generate.mockReset();
    state.generate.mockResolvedValue(refused);
    const error = await failure(edit());
    expect(error.code).toBe("edit_refused");
    expect(error.message).toMatch(/Nothing was charged/);
    expect(state.generate).toHaveBeenCalledTimes(2);

    state.generate.mockReset();
    state.generate.mockRejectedValueOnce(new Error("timeout"));
    expect((await failure(edit())).code).toBe("edit_provider_unavailable");
    expect(state.generate).toHaveBeenCalledOnce();
  });

  it("calls a project quota refusal busy", async () => {
    state.generate.mockRejectedValueOnce(
      Object.assign(new Error("quota"), { status: 429 }),
    );
    const error = await failure(edit());
    expect(error.status).toBe(429);
    expect(error.code).toBe("edit_busy");
  });
});
