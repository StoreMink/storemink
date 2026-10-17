import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { MinkActorContext } from "@/lib/mink/types";
import { MinkRequestError } from "@/lib/mink/errors";

const STORE = "a0000000-0000-4000-8000-0000000000aa";
const OTHER = "b0000000-0000-4000-8000-0000000000bb";
const BUCKET = "https://storage.googleapis.com/bucket/";
const SOURCE = `${BUCKET}stores/${STORE}/uploads/shoe.png`;

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  uploads: [] as { path: string; type: string }[],
  deleted: [] as string[],
  inserts: [] as Row[],
  executed: [] as string[],
  findRows: [] as Row[][],
  chargeRow: null as Row | null,
  earlier: [] as Row[],
  headroom: { period: "2026-10", planCap: 20, remaining: 5 } as {
    period: string;
    planCap: number | null;
    remaining: number | null;
  },
  matte: vi.fn(),
  rateAllowed: true,
  existingScene: null as null | {
    id: string;
    preset: string;
    url: string;
    path: string;
    createdAt: string;
  },
  sceneAllowed: vi.fn(),
  getScene: vi.fn(),
}));

vi.mock("@/lib/db/client", () => {
  const db = {
    execute: async (query: unknown) => {
      const text = JSON.stringify(query);
      state.executed.push(text);
      if (text.includes("consume_mink_cutout_credits"))
        return { rows: state.chargeRow ? [state.chargeRow] : [] };
      if (text.includes("from public.mink_image_cutouts"))
        return { rows: state.findRows.shift() ?? [] };
      return { rows: [] };
    },
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => state.earlier }),
      }),
    }),
    insert: () => ({
      values: async (values: Row) => {
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
    if (!bytes) throw new Error(`no object ${path}`);
    return new Uint8Array(bytes);
  },
  gcsUploadObject: async (path: string, bytes: Buffer, type: string) => {
    state.objects.set(path, Buffer.from(bytes));
    state.uploads.push({ path, type });
    return `${BUCKET}${path}`;
  },
  gcsDeletePaths: async (paths: string[]) => {
    state.deleted.push(...paths);
    return [];
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ allowed: state.rateAllowed }),
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ chargeCredits: true }),
}));
vi.mock("@/lib/mink/image-credits", () => ({
  imageCreditHeadroom: async () => state.headroom,
  canAfford: (h: { remaining: number | null }, credits: number) =>
    h.remaining === null || h.remaining >= credits,
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: () => undefined,
  logWarn: () => undefined,
  logInfo: () => undefined,
}));
vi.mock("@/lib/mink/image-scenes", () => ({
  findStoreScene: async () => state.existingScene,
  assertSceneGenerationAllowed: state.sceneAllowed,
  getOrCreateScene: state.getScene,
}));
vi.mock("./matting-client", () => {
  class MattingError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    MattingError,
    mattingConfigured: () => true,
    requestProductMask: state.matte,
  };
});

import { replaceProductBackground } from "./background-edit";
import { MattingError } from "./matting-client";

function actor(overrides: Partial<MinkActorContext> = {}): MinkActorContext {
  return {
    storeId: STORE,
    adminId: "admin-1",
    email: "owner@example.com",
    roleSlug: "superadmin",
    permissions: {},
    isSuperadmin: true,
    effectivePlan: "basic",
    locationIds: null,
    analyticsTimeZone: "Asia/Kolkata",
    currency: "INR",
    defaultLowStockThreshold: 5,
    requestId: "req-1",
    ...overrides,
  };
}

/** A 400×300 photo: grey floor with a red "product" in the middle. */
async function photo(): Promise<Buffer> {
  const product = await sharp({
    create: { width: 160, height: 120, channels: 3, background: "#d02020" },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 400, height: 300, channels: 3, background: "#777777" },
  })
    .composite([{ input: product, left: 120, top: 90 }])
    .png()
    .toBuffer();
}

/** The service's answer: white exactly where the product is. */
async function maskFor(): Promise<{
  mask: Buffer;
  width: number;
  height: number;
  verdict: "ok";
  coverage: number;
}> {
  const white = await sharp({
    create: { width: 160, height: 120, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const mask = await sharp({
    create: { width: 400, height: 300, channels: 3, background: "#000000" },
  })
    .composite([{ input: white, left: 120, top: 90 }])
    .greyscale()
    .png()
    .toBuffer();
  return { mask, width: 400, height: 300, verdict: "ok", coverage: 0.16 };
}

/** A plain beige "scene" at the product slot's size. */
function sceneBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 1600, channels: 3, background: "#d8ccb8" },
  })
    .webp()
    .toBuffer();
}

async function pixel(bytes: Buffer, x: number, y: number) {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

async function expectRefusal(
  promise: Promise<unknown>,
  status: number,
  code?: string,
) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MinkRequestError);
  expect((error as MinkRequestError).status).toBe(status);
  if (code) expect((error as MinkRequestError).code).toBe(code);
}

beforeEach(async () => {
  state.objects.clear();
  state.objects.set(`stores/${STORE}/uploads/shoe.png`, await photo());
  state.uploads = [];
  state.deleted = [];
  state.inserts = [];
  state.executed = [];
  state.findRows = [];
  state.chargeRow = null;
  state.earlier = [];
  state.headroom = { period: "2026-10", planCap: 20, remaining: 5 };
  state.rateAllowed = true;
  state.matte.mockReset();
  state.matte.mockImplementation(async () => maskFor());
  state.existingScene = null;
  state.sceneAllowed.mockReset();
  state.sceneAllowed.mockImplementation(async () => ({ imageModel: "m" }));
  state.getScene.mockReset();
  state.getScene.mockImplementation(
    async (input: { existing: unknown; fresh: boolean }) => ({
      id: "e0000000-0000-4000-8000-000000000005",
      url: `${BUCKET}stores/${STORE}/scenes/s.webp`,
      bytes: await sceneBytes(),
      chargedCredits: input.existing && !input.fresh ? 0 : 5,
      created: !(input.existing && !input.fresh),
    }),
  );
});

describe("replaceProductBackground", () => {
  it("cuts the product out once, charges one credit and puts it on white at the slot's size", async () => {
    state.chargeRow = { cutout_id: null, credit_source: "plan", reused: false };

    const result = await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product",
      background: { kind: "white" },
    });

    expect(state.matte).toHaveBeenCalledTimes(1);
    const cutout = state.uploads.find((u) => u.path.includes("/cutouts/"));
    expect(cutout?.path).toMatch(
      new RegExp(`^stores/${STORE}/cutouts/.+\\.png$`),
    );
    expect(cutout?.type).toBe("image/png");
    const charge = state.executed.find((t) =>
      t.includes("consume_mink_cutout_credits"),
    );
    expect(charge).toBeDefined();

    expect(result.chargedCredits).toBe(1);
    expect(result.reused).toBe(false);
    expect(result.width).toBe(1200);
    expect(result.height).toBe(1600);
    expect(result.url).toMatch(/\/edited\/.+-product-white\.webp$/);

    const edited = state.objects.get(result.url.slice(BUCKET.length))!;
    const meta = await sharp(edited).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1600]);
    // The product, centred; the corner is the new background, not the floor.
    const centre = await pixel(edited, 600, 800);
    expect(centre.r).toBeGreaterThan(180);
    expect(centre.g).toBeLessThan(80);
    const corner = await pixel(edited, 5, 5);
    expect([corner.r, corner.g, corner.b]).toEqual([255, 255, 255]);

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({
      storeId: STORE,
      source: "mink_edited",
      contentType: "image/webp",
      createdBy: "admin-1",
    });
  });

  it("keeps transparency for a transparent background", async () => {
    state.chargeRow = { cutout_id: null, credit_source: "plan", reused: false };
    const result = await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product_square",
      background: { kind: "transparent" },
    });
    const edited = state.objects.get(result.url.slice(BUCKET.length))!;
    expect((await pixel(edited, 5, 5)).a).toBe(0);
    expect((await pixel(edited, 600, 600)).a).toBe(255);
  });

  it("reuses a stored cut-out for the same photo: no service call, no charge", async () => {
    const cutoutPath = `stores/${STORE}/cutouts/existing.png`;
    state.objects.set(
      cutoutPath,
      await sharp({
        create: {
          width: 160,
          height: 120,
          channels: 4,
          background: { r: 200, g: 30, b: 30, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    state.findRows = [
      [
        {
          id: "c0000000-0000-4000-8000-000000000001",
          path: cutoutPath,
          width: 160,
          height: 120,
          checks: ["small", "made up"],
        },
      ],
    ];

    const result = await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product",
      background: { kind: "colour", hex: "#f2ede4" },
    });

    expect(state.matte).not.toHaveBeenCalled();
    expect(
      state.executed.some((t) => t.includes("consume_mink_cutout_credits")),
    ).toBe(false);
    expect(result).toMatchObject({
      chargedCredits: 0,
      reused: true,
      checks: ["small"],
    });
    expect(result.url).toContain(
      "c0000000-0000-4000-8000-000000000001-product-cf2ede4.webp",
    );
  });

  it("returns the earlier result for the same photo, slot and background without composing again", async () => {
    state.chargeRow = { cutout_id: null, credit_source: "plan", reused: false };
    state.earlier = [{ url: `${BUCKET}stores/${STORE}/edited/old.webp` }];
    const result = await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product",
      background: { kind: "white" },
    });
    expect(result.url).toBe(`${BUCKET}stores/${STORE}/edited/old.webp`);
    expect(state.uploads.some((u) => u.path.includes("/edited/"))).toBe(false);
    expect(state.inserts).toHaveLength(0);
  });

  it("charges nothing on an unmetered plan", async () => {
    state.headroom = { period: "2026-10", planCap: null, remaining: null };
    state.chargeRow = {
      cutout_id: null,
      credit_source: "plan_unlimited",
      reused: false,
    };
    const result = await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product",
      background: { kind: "white" },
    });
    expect(result.chargedCredits).toBe(0);
  });

  it("refuses a store with no credits before calling the service", async () => {
    state.headroom = { period: "2026-10", planCap: 20, remaining: 0 };
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "white" },
      }),
      402,
      "cutout_insufficient_credits",
    );
    expect(state.matte).not.toHaveBeenCalled();
    expect(state.uploads).toHaveLength(0);
  });

  it("deletes the stored cut-out when the charge finds no credits left", async () => {
    state.chargeRow = {
      cutout_id: null,
      credit_source: "insufficient",
      reused: false,
    };
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "white" },
      }),
      402,
    );
    const cutout = state.uploads.find((u) => u.path.includes("/cutouts/"));
    expect(state.deleted).toEqual([cutout?.path]);
    expect(state.inserts).toHaveLength(0);
  });

  it("refuses a photo with no product in it, and charges nothing", async () => {
    state.matte.mockImplementation(async () => ({
      ...(await maskFor()),
      verdict: "empty",
    }));
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "white" },
      }),
      422,
      "cutout_no_product",
    );
    expect(state.uploads).toHaveLength(0);
    expect(
      state.executed.some((t) => t.includes("consume_mink_cutout_credits")),
    ).toBe(false);
  });

  it("refuses a photo that is all product", async () => {
    state.matte.mockImplementation(async () => ({
      ...(await maskFor()),
      verdict: "full",
    }));
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "white" },
      }),
      422,
      "cutout_no_background",
    );
  });

  it("maps a busy service to 429 and an unreadable photo to 400", async () => {
    state.matte.mockRejectedValueOnce(new MattingError("busy", "Busy."));
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "white" },
      }),
      429,
      "cutout_busy",
    );
    state.matte.mockRejectedValueOnce(new MattingError("unreadable", "No."));
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "white" },
      }),
      400,
      "cutout_unreadable",
    );
  });

  it("refuses when the store's rate limit is reached", async () => {
    state.rateAllowed = false;
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "white" },
      }),
      429,
      "cutout_rate_limited",
    );
    expect(state.matte).not.toHaveBeenCalled();
  });

  it("refuses another store's photo without reading it", async () => {
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: `${BUCKET}stores/${OTHER}/uploads/shoe.png`,
        specKey: "product",
        background: { kind: "white" },
      }),
      400,
      "cutout_source_not_owned",
    );
    expect(state.matte).not.toHaveBeenCalled();
  });

  it("is not offered for a slot that is a scene, and needs Media manage", async () => {
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "blog_cover",
        background: { kind: "white" },
      }),
      400,
      "cutout_not_offered",
    );
    await expectRefusal(
      replaceProductBackground({
        actor: actor({ isSuperadmin: false, permissions: { media: ["view"] } }),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "white" },
      }),
      403,
      "cutout_forbidden",
    );
  });

  it("uses the cut-out another request stored first and drops its own", async () => {
    const theirsPath = `stores/${STORE}/cutouts/theirs.png`;
    state.objects.set(
      theirsPath,
      await sharp({
        create: {
          width: 160,
          height: 120,
          channels: 4,
          background: { r: 200, g: 30, b: 30, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    const theirsId = "d0000000-0000-4000-8000-000000000002";
    // First lookup: nothing yet. After the charge: the winner's row.
    state.findRows = [
      [],
      [{ id: theirsId, path: theirsPath, width: 160, height: 120, checks: [] }],
    ];
    state.chargeRow = {
      cutout_id: theirsId,
      credit_source: "plan",
      reused: true,
    };

    const result = await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product",
      background: { kind: "white" },
    });

    const ours = state.uploads.find((u) => u.path.includes("/cutouts/"))!;
    expect(state.deleted).toContain(ours.path);
    expect(result.chargedCredits).toBe(0);
    expect(result.reused).toBe(true);
    expect(result.url).toContain(`${theirsId}-product-white.webp`);
  });
});

describe("shadow and scenes", () => {
  it("files a shadowed result separately from a plain one", async () => {
    state.chargeRow = { cutout_id: null, credit_source: "plan", reused: false };
    const shaded = await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product",
      background: { kind: "white" },
      shadow: true,
    });
    expect(shaded.url).toMatch(/-product-white-shadow\.webp$/);
    // Transparent never carries one, whatever was asked.
    const clear = await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product",
      background: { kind: "transparent" },
      shadow: true,
    });
    expect(clear.url).toMatch(/-product-transparent\.webp$/);
  });

  it("charges the cut-out and a new scene together, and checks both up front", async () => {
    state.headroom = { period: "2026-10", planCap: 20, remaining: 6 };
    state.chargeRow = { cutout_id: null, credit_source: "plan", reused: false };
    const result = await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product",
      background: { kind: "scene", preset: "marble" },
    });
    expect(state.sceneAllowed).toHaveBeenCalledOnce();
    expect(result.chargedCredits).toBe(6);
    expect(result.scene).toMatchObject({ created: true });
    expect(result.url).toMatch(/-product-scene-e0000000-.+\.webp$/);
    expect(state.inserts[0]).toMatchObject({
      filename: "background-marble-1200x1600.webp",
      source: "mink_edited",
    });
    // The product stands in the scene: red at the floor line, beige above.
    const edited = state.objects.get(result.url.slice(BUCKET.length))!;
    const top = await pixel(edited, 600, 80);
    expect(top.r).toBeGreaterThan(200);
    expect(top.g).toBeGreaterThan(190);
  });

  it("refuses up front when the store can pay for the cut-out but not the scene", async () => {
    state.headroom = { period: "2026-10", planCap: 20, remaining: 5 };
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "scene", preset: "linen" },
      }),
      402,
      "cutout_insufficient_credits",
    );
    expect(state.matte).not.toHaveBeenCalled();
    expect(state.getScene).not.toHaveBeenCalled();
    expect(state.uploads).toHaveLength(0);
  });

  it("asks whether a new scene may be drawn before cutting anything out", async () => {
    state.sceneAllowed.mockRejectedValueOnce(
      new MinkRequestError("scene_not_available", "Not now.", 503),
    );
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "scene", preset: "linen" },
      }),
      503,
      "scene_not_available",
    );
    expect(state.matte).not.toHaveBeenCalled();
  });

  it("reuses the store's saved scene free, without the drawing gates", async () => {
    state.chargeRow = { cutout_id: null, credit_source: "plan", reused: false };
    state.existingScene = {
      id: "e0000000-0000-4000-8000-000000000005",
      preset: "wood",
      url: `${BUCKET}stores/${STORE}/scenes/s.webp`,
      path: `stores/${STORE}/scenes/s.webp`,
      createdAt: "2026-10-17",
    };
    const result = await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product",
      background: { kind: "scene", preset: "wood" },
    });
    expect(state.sceneAllowed).not.toHaveBeenCalled();
    expect(result.chargedCredits).toBe(1);
    expect(result.scene).toMatchObject({ created: false });
  });

  it("draws a new scene when asked even though one is saved", async () => {
    state.headroom = { period: "2026-10", planCap: 20, remaining: 20 };
    state.chargeRow = { cutout_id: null, credit_source: "plan", reused: false };
    state.existingScene = {
      id: "e0000000-0000-4000-8000-000000000009",
      preset: "wood",
      url: `${BUCKET}x`,
      path: "x",
      createdAt: "2026-10-17",
    };
    await replaceProductBackground({
      actor: actor(),
      sourceUrl: SOURCE,
      specKey: "product",
      background: { kind: "scene", preset: "wood" },
      newScene: true,
    });
    expect(state.sceneAllowed).toHaveBeenCalledOnce();
    expect(state.getScene.mock.calls[0][0]).toMatchObject({ fresh: true });
  });

  it("refuses a scene that is not on the list", async () => {
    await expectRefusal(
      replaceProductBackground({
        actor: actor(),
        sourceUrl: SOURCE,
        specKey: "product",
        background: { kind: "scene", preset: "disco" },
      }),
      400,
      "scene_unknown",
    );
  });
});
