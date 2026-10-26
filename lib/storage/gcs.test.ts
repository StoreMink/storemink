import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ★ A stand-in for @google-cloud/storage (no network): which bucket each call
//   reaches, what it asked for, and what the bucket answers.
const sdk = vi.hoisted(() => ({
  downloads: [] as { bucket: string; path: string }[],
  listings: [] as { bucket: string; query: unknown }[],
  files: [] as { name: string; metadata?: { timeCreated?: string } }[],
}));
vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (path: string) => ({
          getMetadata: async () => [{ size: 3 }],
          download: async () => {
            sdk.downloads.push({ bucket: name, path });
            return [Buffer.from([1, 2, 3])];
          },
        }),
        getFiles: async (query: unknown) => {
          sdk.listings.push({ bucket: name, query });
          return [sdk.files];
        },
      };
    }
  },
}));

// gcsConfigured / GCS_BUCKET_NAME are evaluated at module load from env, so we
// re-import under a reset registry per env to test both states. (upload/sign/
// delete wrap the SDK and hit the network — not unit-tested here.)
async function loadGcs(bucket?: string) {
  vi.resetModules();
  if (bucket === undefined) vi.stubEnv("GCS_BUCKET", "");
  else vi.stubEnv("GCS_BUCKET", bucket);
  return import("./gcs");
}

describe("gcs helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  describe("with GCS_BUCKET configured", () => {
    it("reports configured and builds a public URL", async () => {
      const gcs = await loadGcs("storemink-media");
      expect(gcs.gcsConfigured).toBe(true);
      expect(gcs.GCS_BUCKET_NAME).toBe("storemink-media");
      expect(gcs.gcsPublicUrl("products/a.webp")).toBe(
        "https://storage.googleapis.com/storemink-media/products/a.webp",
      );
    });

    it("round-trips a public URL back to its in-bucket path", async () => {
      const gcs = await loadGcs("storemink-media");
      const url = gcs.gcsPublicUrl("blog/x_123.webp");
      expect(gcs.gcsPathFromUrl(url)).toBe("blog/x_123.webp");
    });

    it("returns null for a non-GCS or wrong-bucket URL", async () => {
      const gcs = await loadGcs("storemink-media");
      expect(
        gcs.gcsPathFromUrl("https://cdn.example.com/media/a.png"),
      ).toBeNull();
      expect(
        gcs.gcsPathFromUrl("https://storage.googleapis.com/other-bucket/a.png"),
      ).toBeNull();
      expect(
        gcs.gcsPathFromUrl(
          "https://evil.example/storage.googleapis.com/storemink-media/a.png",
        ),
      ).toBeNull();
      expect(
        gcs.gcsPathFromUrl(
          "https://storage.googleapis.com/storemink-media/../other/a.png",
        ),
      ).toBeNull();
      expect(gcs.gcsPathFromUrl("")).toBeNull();
    });
  });

  describe("without GCS_BUCKET", () => {
    it("reports not configured and never matches a path", async () => {
      const gcs = await loadGcs(undefined);
      expect(gcs.gcsConfigured).toBe(false);
      expect(gcs.GCS_BUCKET_NAME).toBeNull();
      expect(
        gcs.gcsPathFromUrl("https://storage.googleapis.com/any/a.png"),
      ).toBeNull();
    });

    it("refuses an empty bulk-delete prefix before touching GCS", async () => {
      const gcs = await loadGcs(undefined);
      await expect(gcs.gcsDeletePrefix("")).resolves.toEqual({
        deleted: 0,
        failed: 0,
        error: "Refusing to delete an empty prefix.",
      });
    });

    it("refuses to list an empty prefix before touching GCS", async () => {
      vi.stubEnv("GCS_PRIVATE_BUCKET", "");
      const gcs = await loadGcs(undefined);
      // ★ The refusal comes first: with no bucket configured, a later check
      //   would have answered "GCS_PRIVATE_BUCKET is not set." instead.
      await expect(gcs.gcsListObjects("private", " ", 100)).rejects.toThrow(
        "Refusing to list an empty prefix.",
      );
      await expect(gcs.gcsListObjects("public", "", 100)).rejects.toThrow(
        "Refusing to list an empty prefix.",
      );
    });
  });

  // ★★ The Refine stage sweep (lib/mink/refine-stages.ts) publishes a paid
  //   photo from the PRIVATE bucket, and decides a stage only by its age: a
  //   listing that lost the creation time would leave every stage undecided.
  describe("★★ the calls the Refine stage sweep depends on", () => {
    beforeEach(() => {
      sdk.downloads = [];
      sdk.listings = [];
      sdk.files = [];
      vi.stubEnv("GCS_PRIVATE_BUCKET", "storemink-private");
    });

    it("gcsDownloadObject reads the bucket its kind names (public by default)", async () => {
      const gcs = await loadGcs("storemink-media");
      await expect(
        gcs.gcsDownloadObject("refine-stage/db/s/r.webp", 100, "private"),
      ).resolves.toEqual(new Uint8Array([1, 2, 3]));
      await gcs.gcsDownloadObject("stores/s/uploads/a.jpg", 100);
      expect(sdk.downloads).toEqual([
        { bucket: "storemink-private", path: "refine-stage/db/s/r.webp" },
        { bucket: "storemink-media", path: "stores/s/uploads/a.jpg" },
      ]);
    });

    it("gcsListObjects asks for one page below the prefix, with each object's creation time", async () => {
      const gcs = await loadGcs("storemink-media");
      sdk.files = [
        {
          name: "refine-stage/db/a.webp",
          metadata: { timeCreated: "2026-10-26T08:00:00.000Z" },
        },
        { name: "refine-stage/db/b.webp", metadata: {} },
        { name: "refine-stage/db/c.webp" },
        {
          name: "refine-stage/db/d.webp",
          metadata: { timeCreated: "not a date" },
        },
      ];
      await expect(
        gcs.gcsListObjects("private", "refine-stage/db/", 100),
      ).resolves.toEqual([
        {
          name: "refine-stage/db/a.webp",
          createdAt: Date.parse("2026-10-26T08:00:00.000Z"),
        },
        { name: "refine-stage/db/b.webp", createdAt: null },
        { name: "refine-stage/db/c.webp", createdAt: null },
        { name: "refine-stage/db/d.webp", createdAt: null },
      ]);
      expect(sdk.listings).toEqual([
        {
          bucket: "storemink-private",
          query: {
            prefix: "refine-stage/db/",
            maxResults: 100,
            autoPaginate: false,
          },
        },
      ]);
    });
  });
});
