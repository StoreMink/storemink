/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => STORE),
  getViewerAccess: vi.fn(),
}));
vi.mock("@/lib/media/product-images", () => ({
  productImageUsage: vi.fn(async () => new Map()),
  listProductImages: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock("@/lib/media/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/media/library")>()),
  listLibraryAssets: vi.fn(async () => ({ assets: [], total: 0 })),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsUploadObject: vi.fn(
    async (path: string) => `https://storage.googleapis.com/bucket/${path}`,
  ),
  gcsPathFromUrl: vi.fn((url: string) => url.split("/bucket/")[1] ?? null),
  gcsDeletePaths: vi.fn(async () => {}),
}));
vi.mock("@/lib/storage/process-image", () => ({
  processImageUpload: vi.fn(async () => ({
    ok: true,
    data: {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/webp",
      ext: "webp",
    },
  })),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  uploadMediaAsset,
  deleteMediaAsset,
  getMediaPickerPage,
} from "./media-actions";
import { getManagerUserId, getViewerAccess } from "@/app/dashboard/lib/access";
import { revalidatePath } from "next/cache";
import {
  listProductImages,
  productImageUsage,
} from "@/lib/media/product-images";
import { listLibraryAssets } from "@/lib/media/library";
import { gcsUploadObject, gcsDeletePaths } from "@/lib/storage/gcs";
import { mediaAssets } from "@/drizzle/schema";

const STORE = "a0000000-0000-4000-8000-000000000001";

function withFile() {
  const fd = new FormData();
  fd.append("file", new File(["x"], "photo.png", { type: "image/png" }));
  return fd;
}

// media-actions.ts — the media library upload (GCS + media_assets row, orphan
// cleanup on DB failure) and delete (store-scoped row + GCS object).
describe("media-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({
      returning: [{ id: "m1", url: "u", path: "p", filename: "photo.png" }],
    });
    vi.mocked(getManagerUserId).mockResolvedValue("user-1");
  });

  describe("uploadMediaAsset", () => {
    it("rejects when the caller lacks media access (nothing uploaded)", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      const res = await uploadMediaAsset(withFile());
      expect(res.error).toBeTruthy();
      expect(vi.mocked(gcsUploadObject)).not.toHaveBeenCalled();
    });

    it("uploads under a store-scoped path and records a media_assets row", async () => {
      const res = await uploadMediaAsset(withFile());
      expect(res.error).toBeUndefined();
      expect(res.asset?.id).toBe("m1");
      // GCS object path is scoped to the acting store.
      const path = vi.mocked(gcsUploadObject).mock.calls[0][0];
      expect(path).toContain(`stores/${STORE}/media/`);
      // A row was inserted into media_assets.
      expect(dbHolder.current.calls.insert[0]).toBe(mediaAssets);
    });

    it("labels an ordinary upload as an upload and refreshes the Library", async () => {
      await uploadMediaAsset(withFile());
      expect(dbHolder.current.calls.values[0]).toMatchObject({
        storeId: STORE,
        source: "upload",
      });
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/media");
    });

    // ★ A chat attachment still gets its row (Mink's ownership checks need
    //   it); only the label changes, so the Library leaves it out.
    it("labels a Mink chat attachment so the Library does not list it", async () => {
      const fd = withFile();
      fd.append("purpose", "mink_attachment");
      const res = await uploadMediaAsset(fd);
      expect(res.error).toBeUndefined();
      expect(dbHolder.current.calls.insert[0]).toBe(mediaAssets);
      expect(dbHolder.current.calls.values[0]).toMatchObject({
        source: "mink_attachment",
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("treats an unknown purpose as an ordinary upload", async () => {
      const fd = withFile();
      fd.append("purpose", "mink_generated");
      await uploadMediaAsset(fd);
      expect(dbHolder.current.calls.values[0]).toMatchObject({
        source: "upload",
      });
    });

    it("removes the orphaned object when the DB insert fails", async () => {
      dbHolder.current = makeDbMock({ failInsertFor: [mediaAssets] });
      const res = await uploadMediaAsset(withFile());
      expect(res.error).toBeTruthy();
      // The object we just uploaded is cleaned up (no orphan left in the bucket).
      const uploadedPath = vi.mocked(gcsUploadObject).mock.results[0]
        .value as Promise<string>;
      await expect(uploadedPath).resolves.toContain(`stores/${STORE}/media/`);
      expect(vi.mocked(gcsDeletePaths)).toHaveBeenCalledTimes(1);
    });
  });

  describe("deleteMediaAsset", () => {
    it("rejects an unauthorised caller", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      const res = await deleteMediaAsset("m1");
      expect(res.error).toBeTruthy();
    });

    it("deletes the store-scoped row AND the GCS object", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ path: "stores/x/media/f.webp", url: "u" }]],
      });
      const res = await deleteMediaAsset("m1");
      expect(res.success).toBe(true);
      expect(dbHolder.current.calls.delete[0]).toBe(mediaAssets);
      // The bucket object is removed too, using the stored path.
      expect(vi.mocked(gcsDeletePaths)).toHaveBeenCalledWith([
        "stores/x/media/f.webp",
      ]);
    });

    it("returns a friendly error when the item no longer exists", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });
      const res = await deleteMediaAsset("missing");
      expect(res.error).toMatch(/no longer exists/i);
      expect(vi.mocked(gcsDeletePaths)).not.toHaveBeenCalled();
    });

    // ★★ Deleting an image a product shows would leave a broken photo on the
    //    storefront, so it is refused and the products are named.
    it("refuses to delete an image a product still uses", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ path: "stores/x/media/f.webp", url: "u" }]],
      });
      vi.mocked(productImageUsage).mockResolvedValueOnce(
        new Map([
          [
            "u",
            [
              { id: "p1", name: "Almond shake" },
              { id: "p2", name: "Cold coffee" },
            ],
          ],
        ]),
      );
      const res = await deleteMediaAsset("m1");
      expect(res.error).toMatch(/Almond shake and Cold coffee use this image/);
      expect(productImageUsage).toHaveBeenCalledWith(STORE, ["u"]);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
      expect(vi.mocked(gcsDeletePaths)).not.toHaveBeenCalled();
    });

    it("refuses to delete when it cannot tell whether a product uses the image", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ path: "stores/x/media/f.webp", url: "u" }]],
      });
      vi.mocked(productImageUsage).mockRejectedValueOnce(new Error("db down"));
      const res = await deleteMediaAsset("m1");
      expect(res.error).toMatch(/Couldn't check/);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
      expect(vi.mocked(gcsDeletePaths)).not.toHaveBeenCalled();
    });
  });

  describe("getMediaPickerPage", () => {
    function access(allowed: string[]) {
      vi.mocked(getViewerAccess).mockResolvedValue({
        can: (section: string) => allowed.includes(section),
      } as any);
    }

    it("lists Library images with the products that use them", async () => {
      access(["media", "products"]);
      vi.mocked(listLibraryAssets).mockResolvedValueOnce({
        assets: [
          {
            id: "m1",
            url: "https://x/lib.webp",
            path: "p",
            filename: "lib.webp",
            content_type: "image/webp",
            size_bytes: 1,
            source: "mink_generated",
            created_at: "2026-10-16",
          },
        ],
        total: 1,
      });
      vi.mocked(productImageUsage).mockResolvedValueOnce(
        new Map([["https://x/lib.webp", [{ id: "p1", name: "Shake" }]]]),
      );
      const res = await getMediaPickerPage({ tab: "library", page: 1 });
      expect(res.error).toBeUndefined();
      expect(listLibraryAssets).toHaveBeenCalledWith(STORE, {
        page: 1,
        pageSize: 24,
      });
      expect(res.items).toEqual([
        {
          url: "https://x/lib.webp",
          filename: "lib.webp",
          label: "Made by Mink AI",
          products: [{ id: "p1", name: "Shake" }],
        },
      ]);
    });

    it("keeps the Library tab behind the media permission", async () => {
      access(["products"]);
      const res = await getMediaPickerPage({ tab: "library" });
      expect(res.error).toMatch(/can't view the Media Library/);
      expect(listLibraryAssets).not.toHaveBeenCalled();
    });

    it("lists product photos for a role that can view products", async () => {
      access(["products"]);
      vi.mocked(listProductImages).mockResolvedValueOnce({
        items: [
          { url: "https://x/p.webp", products: [{ id: "p1", name: "Shake" }] },
        ],
        total: 1,
      });
      const res = await getMediaPickerPage({ tab: "products", page: 2 });
      expect(listProductImages).toHaveBeenCalledWith(STORE, {
        page: 2,
        pageSize: 24,
      });
      expect(res.items[0]).toMatchObject({ url: "https://x/p.webp" });
      expect(res.total).toBe(1);
    });

    it("ignores a nonsense page number", async () => {
      access(["products"]);
      await getMediaPickerPage({ tab: "products", page: -3 });
      expect(listProductImages).toHaveBeenCalledWith(STORE, {
        page: 1,
        pageSize: 24,
      });
    });
  });
});
