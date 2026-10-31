import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ★ A stand-in for @google-cloud/storage (no network): which bucket each call
//   reaches, what it asked for, and what the bucket answers.
const sdk = vi.hoisted(() => ({
  downloads: [] as { bucket: string; path: string }[],
  listings: [] as { bucket: string; query: unknown }[],
  files: [] as { name: string; metadata?: { timeCreated?: string } }[],
  copies: [] as {
    fromBucket: string;
    fromPath: string;
    toBucket: string;
    toPath: string;
    /** The generation the source was opened at, when one was named. */
    sourceGeneration?: string | number;
    /** What copy() was asked, beyond the target. */
    options?: unknown;
  }[],
  // What getMetadata answers per "bucket/path"; a function throws its error.
  metadata: {} as Record<string, Record<string, unknown> | (() => never)>,
  saves: [] as {
    bucket: string;
    path: string;
    bytes: number[];
    /** What save() was asked, beyond the bytes. */
    options: unknown;
  }[],
  deletes: [] as {
    bucket: string;
    path: string;
    /** The generation the file was opened at, when one was named. */
    generation?: string | number;
    /** What delete() was asked, when anything. */
    options?: unknown;
  }[],
  // What save() and delete() throw per "bucket/path"; absent means success.
  saveErrors: {} as Record<string, unknown>,
  deleteErrors: {} as Record<string, unknown>,
}));
vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket(name: string) {
      return {
        file: (path: string, options?: { generation?: string | number }) => ({
          bucketName: name,
          name: path,
          generation: options?.generation,
          getMetadata: async () => {
            const answer = sdk.metadata[`${name}/${path}`];
            if (typeof answer === "function") answer();
            return [answer ?? { size: 3 }];
          },
          download: async () => {
            sdk.downloads.push({ bucket: name, path });
            return [Buffer.from([1, 2, 3])];
          },
          save: async (data: Buffer, saveOptions?: unknown) => {
            const error = sdk.saveErrors[`${name}/${path}`];
            if (error) throw error;
            sdk.saves.push({
              bucket: name,
              path,
              bytes: [...data],
              options: saveOptions,
            });
          },
          delete: async (deleteOptions?: unknown) => {
            sdk.deletes.push({
              bucket: name,
              path,
              ...(options?.generation === undefined
                ? {}
                : { generation: options.generation }),
              ...(deleteOptions === undefined
                ? {}
                : { options: deleteOptions }),
            });
            const error = sdk.deleteErrors[`${name}/${path}`];
            if (error) throw error;
          },
          copy: async (
            target: { bucketName: string; name: string },
            copyOptions?: unknown,
          ) => {
            sdk.copies.push({
              fromBucket: name,
              fromPath: path,
              toBucket: target.bucketName,
              toPath: target.name,
              ...(options?.generation === undefined
                ? {}
                : { sourceGeneration: options.generation }),
              ...(copyOptions === undefined ? {} : { options: copyOptions }),
            });
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
// re-import under a reset registry per env to test both states. (Signing
// wraps the SDK and needs credentials: not unit-tested here. Uploads and
// deletes are, against the stand-in above.)
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

  // ★★ The legacy move of Mink attachments (lib/mink/attachments.ts) copies a
  //   public picture into the private bucket and checks the copy against the
  //   source's size and MD5; "missing" is a null from the metadata read, never
  //   a thrown 404 that would fail the batch.
  describe("★★ the calls the Mink attachment move depends on", () => {
    beforeEach(() => {
      sdk.copies = [];
      sdk.metadata = {};
      vi.stubEnv("GCS_PRIVATE_BUCKET", "storemink-private");
    });

    it("gcsCopyObject asks the source bucket to copy into the target bucket, server-side", async () => {
      const gcs = await loadGcs("storemink-media");
      await gcs.gcsCopyObject(
        "public",
        "stores/s/media/a.webp",
        "private",
        "stores/s/mink-attachments/db/x.webp",
      );
      await gcs.gcsCopyObject(
        "private",
        "stores/s/mink-attachments/db/x.webp",
        "public",
        "stores/s/media/mink-attachment-db-x.webp",
      );
      expect(sdk.copies).toEqual([
        {
          fromBucket: "storemink-media",
          fromPath: "stores/s/media/a.webp",
          toBucket: "storemink-private",
          toPath: "stores/s/mink-attachments/db/x.webp",
        },
        {
          fromBucket: "storemink-private",
          fromPath: "stores/s/mink-attachments/db/x.webp",
          toBucket: "storemink-media",
          toPath: "stores/s/media/mink-attachment-db-x.webp",
        },
      ]);
    });

    it("★ gcsCopyObject carries the takedown design's generation preconditions: the source opened at its generation, the target's precondition to the SDK", async () => {
      const gcs = await loadGcs("storemink-media");
      await gcs.gcsCopyObject(
        "public",
        "stores/s/media/a.webp",
        "private",
        "takedown-archive/db/block/1-a.webp",
        { ifSourceGenerationMatch: "1730000000000001", ifGenerationMatch: 0 },
      );
      await gcs.gcsCopyObject(
        "public",
        "stores/s/media/b.webp",
        "private",
        "takedown-archive/db/block/2-b.webp",
        { ifSourceGenerationMatch: 7 },
      );
      expect(sdk.copies).toEqual([
        {
          fromBucket: "storemink-media",
          fromPath: "stores/s/media/a.webp",
          toBucket: "storemink-private",
          toPath: "takedown-archive/db/block/1-a.webp",
          sourceGeneration: "1730000000000001",
          options: { preconditionOpts: { ifGenerationMatch: 0 } },
        },
        {
          fromBucket: "storemink-media",
          fromPath: "stores/s/media/b.webp",
          toBucket: "storemink-private",
          toPath: "takedown-archive/db/block/2-b.webp",
          sourceGeneration: 7,
        },
      ]);
    });

    it("gcsCopyObject refuses a bad path on either side before touching GCS", async () => {
      const gcs = await loadGcs("storemink-media");
      await expect(
        gcs.gcsCopyObject("public", "stores/../a.webp", "private", "b.webp"),
      ).rejects.toThrow("Invalid GCS object path.");
      await expect(
        gcs.gcsCopyObject("public", "a.webp", "private", " "),
      ).rejects.toThrow("Invalid GCS object path.");
      expect(sdk.copies).toEqual([]);
    });

    it("★ gcsObjectMetadata returns the takedown design's shape: size, type, md5 (not md5Hash), CRC32C, generation, cache control and custom metadata", async () => {
      const gcs = await loadGcs("storemink-media");
      sdk.metadata["storemink-media/stores/s/media/a.webp"] = {
        size: "4096",
        contentType: "image/webp",
        md5Hash: "1B2M2Y8AsgTpgAmY7PhCfg==",
        crc32c: "AAAAAA==",
        generation: "1730000000000001",
        cacheControl: "public, max-age=3600",
        metadata: { "storemink-takedown": "placeholder" },
      };
      await expect(
        gcs.gcsObjectMetadata("public", "stores/s/media/a.webp"),
      ).resolves.toEqual({
        size: 4096,
        contentType: "image/webp",
        md5: "1B2M2Y8AsgTpgAmY7PhCfg==",
        crc32c: "AAAAAA==",
        generation: "1730000000000001",
        cacheControl: "public, max-age=3600",
        metadata: { "storemink-takedown": "placeholder" },
      });
    });

    it("gcsObjectMetadata reads a missing field as null, a numeric generation as its digits, and keeps only string custom metadata", async () => {
      const gcs = await loadGcs("storemink-media");
      sdk.metadata["storemink-private/stores/s/mink-attachments/db/x.webp"] = {
        size: "12",
        generation: 1730000000000002,
        metadata: { kept: "yes", dropped: 5, gone: null },
      };
      await expect(
        gcs.gcsObjectMetadata("private", "stores/s/mink-attachments/db/x.webp"),
      ).resolves.toEqual({
        size: 12,
        contentType: null,
        md5: null,
        crc32c: null,
        generation: "1730000000000002",
        cacheControl: null,
        metadata: { kept: "yes" },
      });
    });

    it("gcsObjectMetadata is null for a missing object (404) and throws anything else", async () => {
      const gcs = await loadGcs("storemink-media");
      sdk.metadata["storemink-private/stores/s/mink-attachments/db/gone.webp"] =
        () => {
          throw Object.assign(new Error("No such object"), { code: 404 });
        };
      await expect(
        gcs.gcsObjectMetadata(
          "private",
          "stores/s/mink-attachments/db/gone.webp",
        ),
      ).resolves.toBeNull();
      sdk.metadata["storemink-media/stores/s/media/locked.webp"] = () => {
        throw Object.assign(new Error("Forbidden"), { code: 403 });
      };
      await expect(
        gcs.gcsObjectMetadata("public", "stores/s/media/locked.webp"),
      ).rejects.toThrow("Forbidden");
      await expect(
        gcs.gcsObjectMetadata("public", "stores/../a.webp"),
      ).rejects.toThrow("Invalid GCS object path.");
    });
  });

  // ★★ The takedown build's writes (design 3.3 and 5.7, plan A3): the
  //   placeholder is written pinned to the archived generation with its
  //   marker, the archive is written create-only, and an archived generation
  //   is deleted by number. Every public object is `public, max-age=60`
  //   unless its writer names another value (decision D4).
  describe("★★ the takedown build's writes", () => {
    beforeEach(() => {
      sdk.saves = [];
      sdk.deletes = [];
      sdk.saveErrors = {};
      sdk.deleteErrors = {};
      vi.stubEnv("GCS_PRIVATE_BUCKET", "storemink-private");
    });

    it("★ gcsUploadObject writes `public, max-age=60` when no Cache-Control is named (D4), with no custom metadata and no precondition", async () => {
      const gcs = await loadGcs("storemink-media");
      expect(gcs.DEFAULT_PUBLIC_CACHE_CONTROL).toBe("public, max-age=60");
      await expect(
        gcs.gcsUploadObject(
          "stores/s/uploads/a.webp",
          new Uint8Array([1, 2, 3]),
          "image/webp",
        ),
      ).resolves.toBe(
        "https://storage.googleapis.com/storemink-media/stores/s/uploads/a.webp",
      );
      expect(sdk.saves).toEqual([
        {
          bucket: "storemink-media",
          path: "stores/s/uploads/a.webp",
          bytes: [1, 2, 3],
          options: {
            contentType: "image/webp",
            resumable: false,
            metadata: { cacheControl: "public, max-age=60" },
          },
        },
      ]);
    });

    it("gcsUploadObject keeps a Cache-Control its caller names", async () => {
      const gcs = await loadGcs("storemink-media");
      await gcs.gcsUploadObject(
        "theme-releases/t/1.0.0/hero.webp",
        new Uint8Array([9]),
        "image/webp",
        "public, max-age=31536000, immutable",
      );
      expect(sdk.saves[0]?.options).toEqual({
        contentType: "image/webp",
        resumable: false,
        metadata: { cacheControl: "public, max-age=31536000, immutable" },
      });
    });

    it("★ gcsUploadObject carries the custom metadata and the generation precondition to the SDK", async () => {
      const gcs = await loadGcs("storemink-media");
      await gcs.gcsUploadObject(
        "stores/s/media/a.webp",
        new Uint8Array([4, 5]),
        "image/webp",
        "no-store",
        {
          metadata: { "storemink-takedown": "block-1" },
          ifGenerationMatch: "1730000000000001",
        },
      );
      await gcs.gcsUploadObject(
        "stores/s/media/b.pdf",
        new Uint8Array([6]),
        "application/pdf",
        undefined,
        { ifGenerationMatch: 0 },
      );
      expect(sdk.saves).toEqual([
        {
          bucket: "storemink-media",
          path: "stores/s/media/a.webp",
          bytes: [4, 5],
          options: {
            contentType: "image/webp",
            resumable: false,
            metadata: {
              cacheControl: "no-store",
              metadata: { "storemink-takedown": "block-1" },
            },
            preconditionOpts: { ifGenerationMatch: "1730000000000001" },
          },
        },
        {
          bucket: "storemink-media",
          path: "stores/s/media/b.pdf",
          bytes: [6],
          options: {
            contentType: "application/pdf",
            resumable: false,
            metadata: { cacheControl: "public, max-age=60" },
            preconditionOpts: { ifGenerationMatch: 0 },
          },
        },
      ]);
    });

    it("gcsUploadObject refuses a bad path, generation or metadata before touching GCS", async () => {
      const gcs = await loadGcs("storemink-media");
      const bytes = new Uint8Array([1]);
      for (const path of ["stores/../a.webp", " ", ""]) {
        await expect(
          gcs.gcsUploadObject(path, bytes, "image/webp"),
        ).rejects.toThrow("Invalid GCS object path.");
      }
      for (const ifGenerationMatch of ["-1", "abc", "", 1.5, -1]) {
        await expect(
          gcs.gcsUploadObject(
            "stores/s/a.webp",
            bytes,
            "image/webp",
            "no-store",
            {
              ifGenerationMatch,
            },
          ),
        ).rejects.toThrow("Invalid GCS generation.");
      }
      for (const metadata of [
        { "": "x" },
        { key: 5 as unknown as string },
        { key: "x".repeat(1025) },
      ] as Record<string, string>[]) {
        await expect(
          gcs.gcsUploadObject(
            "stores/s/a.webp",
            bytes,
            "image/webp",
            "no-store",
            {
              metadata,
            },
          ),
        ).rejects.toThrow("Invalid GCS object metadata.");
      }
      expect(sdk.saves).toEqual([]);
    });

    it("a precondition that does not hold is thrown with its 412 for the caller", async () => {
      const gcs = await loadGcs("storemink-media");
      sdk.saveErrors["storemink-media/stores/s/media/a.webp"] = Object.assign(
        new Error("Precondition Failed"),
        { code: 412 },
      );
      await expect(
        gcs.gcsUploadObject(
          "stores/s/media/a.webp",
          new Uint8Array([1]),
          "image/webp",
          "no-store",
          { ifGenerationMatch: "7" },
        ),
      ).rejects.toMatchObject({ code: 412 });
    });

    it("gcsPrivateUploadObject writes as before when given no options, and takes the archive's create-only precondition", async () => {
      const gcs = await loadGcs("storemink-media");
      await gcs.gcsPrivateUploadObject(
        "stores/s/mink-attachments/db/x.webp",
        new Uint8Array([1]),
        "image/webp",
      );
      await gcs.gcsPrivateUploadObject(
        "takedown-archive/db/block/store-content.jsonl",
        new Uint8Array([2]),
        "application/x-ndjson",
        { ifGenerationMatch: 0 },
      );
      expect(sdk.saves).toEqual([
        {
          bucket: "storemink-private",
          path: "stores/s/mink-attachments/db/x.webp",
          bytes: [1],
          options: {
            contentType: "image/webp",
            resumable: false,
            metadata: { cacheControl: "private, max-age=0" },
          },
        },
        {
          bucket: "storemink-private",
          path: "takedown-archive/db/block/store-content.jsonl",
          bytes: [2],
          options: {
            contentType: "application/x-ndjson",
            resumable: false,
            metadata: { cacheControl: "private, max-age=0" },
            preconditionOpts: { ifGenerationMatch: 0 },
          },
        },
      ]);
    });

    it("★ gcsDeleteGeneration deletes exactly that generation, in the bucket its kind names", async () => {
      const gcs = await loadGcs("storemink-media");
      await expect(
        gcs.gcsDeleteGeneration(
          "public",
          "stores/s/media/a.webp",
          "1730000000000001",
        ),
      ).resolves.toBe("deleted");
      await expect(
        gcs.gcsDeleteGeneration(
          "private",
          "takedown-archive/db/block/1-a.webp",
          7,
        ),
      ).resolves.toBe("deleted");
      expect(sdk.deletes).toEqual([
        {
          bucket: "storemink-media",
          path: "stores/s/media/a.webp",
          generation: "1730000000000001",
        },
        {
          bucket: "storemink-private",
          path: "takedown-archive/db/block/1-a.webp",
          generation: 7,
        },
      ]);
    });

    it("gcsDeleteGeneration answers missing for a 404, and throws a 412 or any other error with its code", async () => {
      const gcs = await loadGcs("storemink-media");
      sdk.deleteErrors["storemink-media/stores/s/media/gone.webp"] =
        Object.assign(new Error("No such object"), { code: 404 });
      await expect(
        gcs.gcsDeleteGeneration("public", "stores/s/media/gone.webp", "1"),
      ).resolves.toBe("missing");
      sdk.deleteErrors["storemink-media/stores/s/media/moved.webp"] =
        Object.assign(new Error("Precondition Failed"), { code: 412 });
      await expect(
        gcs.gcsDeleteGeneration("public", "stores/s/media/moved.webp", "2"),
      ).rejects.toMatchObject({ code: 412 });
      sdk.deleteErrors["storemink-media/stores/s/media/locked.webp"] =
        Object.assign(new Error("Forbidden"), { code: 403 });
      await expect(
        gcs.gcsDeleteGeneration("public", "stores/s/media/locked.webp", "3"),
      ).rejects.toThrow("Forbidden");
    });

    it("gcsDeleteGeneration refuses a bad path or generation before touching GCS", async () => {
      const gcs = await loadGcs("storemink-media");
      await expect(
        gcs.gcsDeleteGeneration("public", "stores/../a.webp", "1"),
      ).rejects.toThrow("Invalid GCS object path.");
      for (const generation of ["", "x1", -2, 0.5]) {
        await expect(
          gcs.gcsDeleteGeneration("public", "stores/s/a.webp", generation),
        ).rejects.toThrow("Invalid GCS generation.");
      }
      expect(sdk.deletes).toEqual([]);
    });
  });
});
