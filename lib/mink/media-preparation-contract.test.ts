import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MinkActorContext } from "./types";

const mocks = vi.hoisted(() => ({
  owned: vi.fn(async (_s: string, urls: readonly string[]) => new Set(urls)),
  download: vi.fn(async () => new Uint8Array([1, 2, 3])),
  upload: vi.fn(async () => "uploaded"),
  deletePaths: vi.fn(async () => [] as string[]),
  /** One entry per SELECT, in order: the cache lookup, then the re-check
   *  under the advisory lock. A missing entry reads as "no row". */
  selectQueue: [] as { url: string }[][],
  inserted: [] as unknown[],
  deleted: 0,
  locks: [] as unknown[],
}));

vi.mock("./storefront-media-read", () => ({
  readOwnedStorefrontImageUrls: mocks.owned,
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsPathFromUrl: (url: string) => {
    const m = /^https:\/\/storage\.googleapis\.com\/bkt\/(.+)$/.exec(url || "");
    return m ? m[1] : null;
  },
  gcsPublicUrl: (path: string) => `https://storage.googleapis.com/bkt/${path}`,
  gcsDownloadObject: mocks.download,
  gcsDeletePaths: mocks.deletePaths,
}));
// ★ The store's one writer (takedown design 5.7) is the upload seam.
vi.mock("@/lib/storage/store-objects", () => ({
  writeStoreObject: mocks.upload,
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) =>
    fn({
      execute: vi.fn(async (q: unknown) => {
        mocks.locks.push(q);
        return { rows: [] };
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => mocks.selectQueue.shift() ?? [] }),
        }),
      }),
      insert: () => ({
        values: (v: unknown) => ({
          returning: async () => {
            mocks.inserted.push(v);
            return [{ url: (v as { url: string }).url }];
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          mocks.deleted += 1;
        },
      }),
    }),
  ),
}));

import sharp from "sharp";
import { BlockedUploadError } from "@/lib/moderation/upload-guard";
import { MinkToolInputError } from "./errors";
import {
  discardPreparedMinkImage,
  prepareMinkImageForDestination,
} from "./media-preparation";

/** A real portrait image, so the full save path runs rather than the decode
 *  fallback. */
async function portrait() {
  return new Uint8Array(
    await sharp({
      create: {
        width: 400,
        height: 900,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer(),
  );
}

const OWN = "https://storage.googleapis.com/bkt/stores/store-1/media/a.webp";
const LEGACY = "https://cdn.example.com/m/old.webp";

function actor(overrides: Partial<MinkActorContext> = {}): MinkActorContext {
  return {
    storeId: "store-1",
    adminId: "admin-1",
    permissions: { media: ["manage"], blogs: ["manage"] },
    isSuperadmin: false,
    ...overrides,
  } as unknown as MinkActorContext;
}

beforeEach(() => {
  mocks.owned.mockImplementation(
    async (_s: string, urls: readonly string[]) => new Set(urls),
  );
  mocks.download.mockImplementation(async () => new Uint8Array([1, 2, 3]));
  mocks.upload.mockImplementation(async () => "uploaded");
  mocks.deletePaths.mockImplementation(async () => []);
  mocks.selectQueue = [];
  mocks.inserted = [];
  mocks.deleted = 0;
  mocks.locks = [];
});

// ★★ PREPARATION IS BEST-EFFORT; OWNERSHIP IS NOT. Every degraded path must
//    fall back to the source, because failing loses the whole proposal — and
//    the credits already spent on a generated cover — over a picture that
//    merely renders in the wrong shape.
describe("prepared image contract", () => {
  it("refuses only an image the store does not own", async () => {
    mocks.owned.mockResolvedValueOnce(new Set<string>());
    await expect(
      prepareMinkImageForDestination(actor(), OWN, "blog_cover"),
    ).rejects.toThrow(/not one of this store's own/i);
  });

  // The ownership question is the one `assertOwnedCover` re-asks inside the
  // publication transaction, so a legacy cover outside our bucket it accepts must not
  // be refused here.
  it("passes a legacy object outside our bucket straight through", async () => {
    const result = await prepareMinkImageForDestination(
      actor(),
      LEGACY,
      "blog_cover",
    );
    expect(result).toEqual({
      url: LEGACY,
      prepared: false,
      createdPath: null,
    });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  // ★ Checked BEFORE the download, which needs no image data and costs real
  //   CPU — and a pass-through, so an admin who may write a product but not
  //   manage Media still gets their product.
  it("skips preparation without media:manage, before reading anything", async () => {
    const result = await prepareMinkImageForDestination(
      actor({ permissions: { products: ["manage"] } }),
      OWN,
      "product_photo",
    );
    expect(result.prepared).toBe(false);
    expect(result.url).toBe(OWN);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("falls back to the source when the object cannot be read", async () => {
    mocks.download.mockRejectedValueOnce(new Error("gone"));
    const result = await prepareMinkImageForDestination(
      actor(),
      OWN,
      "blog_cover",
    );
    expect(result).toEqual({ url: OWN, prepared: false, createdPath: null });
  });

  it("falls back to the source when the bytes cannot be decoded", async () => {
    // Three arbitrary bytes are not an image sharp can read.
    const result = await prepareMinkImageForDestination(
      actor(),
      OWN,
      "blog_cover",
    );
    expect(result).toEqual({ url: OWN, prepared: false, createdPath: null });
  });

  // ★★ `media_assets` HAS NO UNIQUE INDEX ON (store_id, path), so a plain
  //    check-then-insert lets two concurrent runs both write a row for the
  //    same object — and deleting either removes the shared file and leaves
  //    the other rendering a broken image.
  it("takes an advisory lock and re-checks before inserting", async () => {
    mocks.download.mockResolvedValueOnce(await portrait());
    const result = await prepareMinkImageForDestination(
      actor(),
      OWN,
      "blog_cover",
    );
    expect(result.prepared).toBe(true);
    expect(result.createdPath).toMatch(/mink-prepared\/blog_cover-/);
    expect(mocks.locks).toHaveLength(1);
    expect(mocks.inserted).toHaveLength(1);
  });

  it("yields to the run that won the race instead of inserting twice", async () => {
    mocks.download.mockResolvedValueOnce(await portrait());
    // Select #1 is the cache lookup and misses; select #2 runs under the
    // advisory lock and finds the row the other run committed meanwhile.
    mocks.selectQueue = [
      [],
      [{ url: "https://storage.googleapis.com/bkt/won.webp" }],
    ];
    const result = await prepareMinkImageForDestination(
      actor(),
      OWN,
      "blog_cover",
    );
    expect(result).toEqual({
      url: "https://storage.googleapis.com/bkt/won.webp",
      prepared: true,
      // Nothing of its own to undo.
      createdPath: null,
    });
    expect(mocks.inserted).toHaveLength(0);
  });

  it("writes the copy through the store's one writer, for this store", async () => {
    mocks.download.mockResolvedValueOnce(await portrait());
    await prepareMinkImageForDestination(actor(), OWN, "blog_cover");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.stringMatching(
        /^stores\/store-1\/media\/mink-prepared\/blog_cover-/,
      ),
      expect.any(Uint8Array),
      "image/webp",
      {
        storeId: "store-1",
        via: "mink_media_preparation",
        actor: "admin-1",
      },
    );
  });

  it("still falls back to the source when the upload itself fails", async () => {
    mocks.download.mockResolvedValueOnce(await portrait());
    mocks.upload.mockRejectedValueOnce(new Error("storage down"));
    const result = await prepareMinkImageForDestination(
      actor(),
      OWN,
      "blog_cover",
    );
    expect(result).toEqual({ url: OWN, prepared: false, createdPath: null });
    expect(mocks.inserted).toHaveLength(0);
  });

  // ★★ A copy of a picture StoreMink has blocked is the same photograph: the
  //    takedown sentence is the answer, never a quiet fall back to the source.
  it("refuses a copy whose bytes StoreMink has blocked, in the design's words", async () => {
    mocks.download.mockResolvedValueOnce(await portrait());
    mocks.upload.mockRejectedValueOnce(
      new BlockedUploadError({
        told: true,
        kindWord: "image",
        blockId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    const refused = prepareMinkImageForDestination(actor(), OWN, "blog_cover");
    await expect(refused).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(refused).rejects.toThrow(
      "StoreMink has blocked this image, so it can't be uploaded again. See Settings, Notices from StoreMink.",
    );
    expect(mocks.inserted).toHaveLength(0);
    expect(mocks.deletePaths).not.toHaveBeenCalled();
  });

  it("names nothing when the block is kept from the store", async () => {
    mocks.download.mockResolvedValueOnce(await portrait());
    mocks.upload.mockRejectedValueOnce(
      new BlockedUploadError({
        told: false,
        kindWord: "image",
        blockId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    await expect(
      prepareMinkImageForDestination(actor(), OWN, "blog_cover"),
    ).rejects.toThrow(
      "This file can't be uploaded. If you need help, write to support@storemink.com.",
    );
  });

  it("reuses a derivative an earlier run made, claiming nothing to undo", async () => {
    mocks.selectQueue = [
      [{ url: "https://storage.googleapis.com/bkt/prepared.webp" }],
    ];
    const result = await prepareMinkImageForDestination(
      actor(),
      OWN,
      "blog_cover",
    );
    expect(result).toMatchObject({ prepared: true, createdPath: null });
    expect(mocks.download).not.toHaveBeenCalled();
  });
});

// ★ `createdPath` is null for a cache hit and a pass-through, so a failed
//   proposal can never delete the merchant's own source image.
describe("discardPreparedMinkImage", () => {
  it("removes only a derivative this run created", async () => {
    await discardPreparedMinkImage(actor(), {
      url: OWN,
      prepared: true,
      createdPath: "stores/store-1/media/mink-prepared/x.webp",
    });
    expect(mocks.deleted).toBe(1);
    expect(mocks.deletePaths).toHaveBeenCalledWith([
      "stores/store-1/media/mink-prepared/x.webp",
    ]);
  });

  it("does nothing for a pass-through or a cache hit", async () => {
    await discardPreparedMinkImage(actor(), {
      url: OWN,
      prepared: false,
      createdPath: null,
    });
    expect(mocks.deleted).toBe(0);
    expect(mocks.deletePaths).not.toHaveBeenCalled();
  });

  // It runs on a path that is already failing; replacing that failure with a
  // cleanup error would hide the real one.
  it("never throws", async () => {
    mocks.deletePaths.mockRejectedValueOnce(new Error("storage down"));
    await expect(
      discardPreparedMinkImage(actor(), {
        url: OWN,
        prepared: true,
        createdPath: "stores/store-1/media/mink-prepared/x.webp",
      }),
    ).resolves.toBeUndefined();
  });
});
