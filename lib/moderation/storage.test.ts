import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  GcsBucketKind,
  GcsCopyPreconditions,
  GcsObjectMetadata,
  GcsUploadOptions,
} from "@/lib/storage/gcs";
import * as gcs from "@/lib/storage/gcs";
import {
  archiveBucketFile,
  archiveBundledFile,
  archiveFetchedFile,
  bundledThemeFilePath,
  discardArchiveCopy,
  FETCH_MAX_BYTES,
  moderationStorage,
  parseArchivedFile,
  purgeArchiveFiles,
  removeNonImage,
  replaceWithPlaceholder,
  restoreFromArchive,
  TAKEDOWN_METADATA_KEY,
  writeArchiveObject,
  type ArchivedFile,
  type ModerationStorage,
} from "./storage";

// ★ No network and no real bucket: gcs.ts is replaced (the default adapter
//   is checked against these stand-ins), and every test below passes the
//   in-memory FakeStorage instead. `fetch` throws if anything reaches it.
vi.mock("@/lib/storage/gcs", () => ({
  GCS_BUCKET_NAME: "mock-media",
  GCS_PRIVATE_BUCKET_NAME: "mock-private",
  gcsObjectMetadata: vi.fn(async () => null),
  gcsCopyObject: vi.fn(async () => undefined),
  gcsUploadObject: vi.fn(async () => "https://example.invalid/x"),
  gcsPrivateUploadObject: vi.fn(async () => undefined),
  gcsDownloadObject: vi.fn(async () => new Uint8Array([1])),
  gcsDeleteGeneration: vi.fn(async () => "deleted"),
  gcsDeletePaths: vi.fn(async () => []),
}));
vi.mock("@/lib/observability/logger", () => ({
  logWarn: vi.fn(() => undefined),
  logError: vi.fn(() => undefined),
  logInfo: vi.fn(() => undefined),
}));

const BLOCK = "0f8e6a1c-2b3d-4e5f-8a9b-1c2d3e4f5a6b";
const OTHER_BLOCK = "11111111-2222-4333-8444-555555555555";
const STORE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DB = "storemink_test";
const OTHER_DB = "storemink_staging";
const PLACEHOLDER = new Uint8Array([80, 76, 65, 67, 69]);
const NOW = new Date("2026-10-30T06:00:00.000Z");

const md5 = (bytes: Uint8Array) =>
  createHash("md5").update(bytes).digest("base64");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text));
const status = (code: number) =>
  Object.assign(new Error(`status ${code}`), { code });

type Stored = {
  bytes: Uint8Array;
  generation: string;
  contentType: string | null;
  cacheControl: string | null;
  metadata: Record<string, string>;
};

/**
 * An in-memory bucket pair with Google's generation rules: a copy opened at a
 * generation that is no longer live answers 404 (plan A3), a write whose
 * `ifGenerationMatch` does not hold answers 412, a generation delete removes
 * only that generation.
 */
class FakeStorage implements ModerationStorage {
  objects = new Map<string, Stored>();
  calls: string[] = [];
  uploads: {
    kind: GcsBucketKind;
    path: string;
    contentType: string;
    cacheControl: string;
    options: GcsUploadOptions;
  }[] = [];
  deletes: { kind: GcsBucketKind; path: string; generation: string }[] = [];
  /** Errors to throw, by "method kind:path" or by method. */
  errors = new Map<string, unknown>();
  /** Runs at the start of a copy or an upload (a write that races ours). */
  beforeCopy: (() => void) | null = null;
  beforeUpload: (() => void) | null = null;
  /** Changes the bytes a copy or a private upload stores (a bad copy). */
  corruptWrites = false;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = () =>
    Promise.reject(new Error("no network in tests"));
  bundled = new Map<string, Uint8Array>();
  private nextGeneration = 1730000000000001;

  key(kind: GcsBucketKind, objectPath: string) {
    return `${kind}:${objectPath}`;
  }

  put(
    kind: GcsBucketKind,
    objectPath: string,
    bytes: Uint8Array,
    extra: Partial<Omit<Stored, "bytes" | "generation">> = {},
  ): Stored {
    const stored: Stored = {
      bytes,
      generation: String(this.nextGeneration++),
      contentType: extra.contentType ?? "image/webp",
      cacheControl: extra.cacheControl ?? "public, max-age=3600",
      metadata: extra.metadata ?? {},
    };
    this.objects.set(this.key(kind, objectPath), stored);
    return stored;
  }

  get(kind: GcsBucketKind, objectPath: string) {
    return this.objects.get(this.key(kind, objectPath));
  }

  private raise(method: string, kind?: GcsBucketKind, objectPath?: string) {
    const error =
      (kind && objectPath
        ? this.errors.get(`${method} ${this.key(kind, objectPath)}`)
        : undefined) ?? this.errors.get(method);
    if (error) throw error;
  }

  private checkPrecondition(
    existing: Stored | undefined,
    match: string | number | undefined,
  ) {
    if (match === undefined) return;
    if (
      String(match) === "0" ? existing : existing?.generation !== String(match)
    ) {
      throw status(412);
    }
  }

  bucketName(kind: GcsBucketKind) {
    return kind === "private" ? "fake-private" : "fake-media";
  }

  async objectMetadata(
    kind: GcsBucketKind,
    objectPath: string,
  ): Promise<GcsObjectMetadata | null> {
    this.calls.push(`meta ${this.key(kind, objectPath)}`);
    this.raise("objectMetadata", kind, objectPath);
    const stored = this.get(kind, objectPath);
    if (!stored) return null;
    return {
      size: stored.bytes.length,
      contentType: stored.contentType,
      md5: md5(stored.bytes),
      crc32c: null,
      generation: stored.generation,
      cacheControl: stored.cacheControl,
      metadata: { ...stored.metadata },
    };
  }

  async copyObject(
    fromKind: GcsBucketKind,
    fromPath: string,
    toKind: GcsBucketKind,
    toPath: string,
    preconditions: GcsCopyPreconditions,
  ) {
    this.calls.push(
      `copy ${this.key(fromKind, fromPath)} -> ${this.key(toKind, toPath)} ${JSON.stringify(preconditions)}`,
    );
    this.beforeCopy?.();
    this.raise("copyObject", fromKind, fromPath);
    const source = this.get(fromKind, fromPath);
    if (
      !source ||
      (preconditions.ifSourceGenerationMatch !== undefined &&
        source.generation !== String(preconditions.ifSourceGenerationMatch))
    ) {
      throw status(404);
    }
    this.checkPrecondition(
      this.get(toKind, toPath),
      preconditions.ifGenerationMatch,
    );
    this.put(
      toKind,
      toPath,
      this.corruptWrites ? bytesOf("corrupt") : source.bytes,
      source,
    );
  }

  async uploadPublic(
    objectPath: string,
    bytes: Uint8Array,
    contentType: string,
    cacheControl: string,
    options: GcsUploadOptions,
  ) {
    this.calls.push(`upload ${this.key("public", objectPath)}`);
    this.uploads.push({
      kind: "public",
      path: objectPath,
      contentType,
      cacheControl,
      options,
    });
    this.beforeUpload?.();
    this.raise("uploadPublic", "public", objectPath);
    this.checkPrecondition(
      this.get("public", objectPath),
      options.ifGenerationMatch,
    );
    this.put("public", objectPath, bytes, {
      contentType,
      cacheControl,
      metadata: options.metadata ?? {},
    });
  }

  async uploadPrivate(
    objectPath: string,
    bytes: Uint8Array,
    contentType: string,
    options: GcsUploadOptions,
  ) {
    this.calls.push(`upload ${this.key("private", objectPath)}`);
    this.uploads.push({
      kind: "private",
      path: objectPath,
      contentType,
      cacheControl: "private, max-age=0",
      options,
    });
    this.raise("uploadPrivate", "private", objectPath);
    this.checkPrecondition(
      this.get("private", objectPath),
      options.ifGenerationMatch,
    );
    this.put(
      "private",
      objectPath,
      this.corruptWrites ? bytesOf("corrupt") : bytes,
      { contentType, cacheControl: "private, max-age=0" },
    );
  }

  async downloadObject(
    kind: GcsBucketKind,
    objectPath: string,
    maxBytes: number,
  ) {
    this.calls.push(`download ${this.key(kind, objectPath)}`);
    this.raise("downloadObject", kind, objectPath);
    const stored = this.get(kind, objectPath);
    if (!stored) throw status(404);
    if (stored.bytes.length > maxBytes) throw new Error("too large");
    return new Uint8Array(stored.bytes);
  }

  async deleteGeneration(
    kind: GcsBucketKind,
    objectPath: string,
    generation: string | number,
  ) {
    this.calls.push(`delete ${this.key(kind, objectPath)}#${generation}`);
    this.deletes.push({
      kind,
      path: objectPath,
      generation: String(generation),
    });
    this.raise("deleteGeneration", kind, objectPath);
    const stored = this.get(kind, objectPath);
    if (stored && stored.generation === String(generation)) {
      this.objects.delete(this.key(kind, objectPath));
      return "deleted" as const;
    }
    return "missing" as const;
  }

  async deletePaths(kind: GcsBucketKind, paths: string[]) {
    this.calls.push(`deletePaths ${kind} ${paths.join(",")}`);
    const failed: string[] = [];
    for (const objectPath of paths) {
      if (this.errors.get(`deletePaths ${this.key(kind, objectPath)}`)) {
        failed.push(objectPath);
      } else {
        this.objects.delete(this.key(kind, objectPath));
      }
    }
    return failed;
  }

  fetch(url: string, init: RequestInit) {
    this.calls.push(`fetch ${url}`);
    return this.fetchImpl(url, init);
  }

  async readBundledFile(publicPath: string, maxBytes: number) {
    this.calls.push(`read ${publicPath}`);
    const bytes = this.bundled.get(publicPath);
    if (!bytes)
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    if (bytes.length > maxBytes) throw new Error("too large");
    return bytes;
  }

  async placeholder() {
    return PLACEHOLDER;
  }

  now() {
    return NOW;
  }
}

const archiveRoot = (database = DB, block = BLOCK) =>
  `takedown-archive/${database}/${block}/`;

let storage: FakeStorage;

beforeEach(() => {
  vi.stubEnv("DB_NAME", DB);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in tests");
    }),
  );
  storage = new FakeStorage();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** An archived public image, its archive copy in place and confirmed. */
async function archivedImage(
  objectPath = `stores/${STORE}/media/shoe.webp`,
  bytes = bytesOf("original shoe"),
  contentType = "image/webp",
) {
  storage.put("public", objectPath, bytes, { contentType });
  const result = await archiveBucketFile(
    { blockId: BLOCK, n: 1, path: objectPath, expectedMd5: md5(bytes) },
    storage,
  );
  if (!result.ok) throw new Error("setup: archive failed");
  storage.calls = [];
  storage.uploads = [];
  storage.deletes = [];
  return { objectPath, bytes, file: result.file };
}

describe("archiveBucketFile (design 5.3 step 2, 8.1 step 2)", () => {
  it("★ copies exactly the generation it read, create-only, into this database's block folder, and confirms size and MD5", async () => {
    const objectPath = `stores/${STORE}/media/shoe.webp`;
    const bytes = bytesOf("original shoe");
    const source = storage.put("public", objectPath, bytes);
    const result = await archiveBucketFile(
      { blockId: BLOCK, n: 1, path: objectPath, expectedMd5: md5(bytes) },
      storage,
    );
    const archivePath = `${archiveRoot()}1-shoe.webp`;
    expect(result).toEqual({
      ok: true,
      created: true,
      file: {
        n: 1,
        source: "bucket",
        path: objectPath,
        state: "copied",
        sourceBucket: "fake-media",
        sourceGeneration: source.generation,
        archivePath,
        archiveGeneration: storage.get("private", archivePath)?.generation,
        size: bytes.length,
        contentType: "image/webp",
        md5: md5(bytes),
        crc32c: null,
        sha256: null,
        cacheControl: "public, max-age=3600",
        at: NOW.toISOString(),
      },
    });
    expect(storage.calls).toEqual([
      `meta public:${objectPath}`,
      `copy public:${objectPath} -> private:${archivePath} ${JSON.stringify({
        ifSourceGenerationMatch: source.generation,
        ifGenerationMatch: 0,
      })}`,
      `meta private:${archivePath}`,
    ]);
    // The public object is never written by an archive step.
    expect(storage.get("public", objectPath)).toBe(source);
    expect(storage.uploads).toEqual([]);
  });

  it("records an original that is already gone as missing, and copies nothing", async () => {
    const result = await archiveBucketFile(
      { blockId: BLOCK, n: 2, path: `stores/${STORE}/media/gone.webp` },
      storage,
    );
    expect(result).toMatchObject({
      ok: true,
      created: false,
      file: { state: "missing", archivePath: null, sourceGeneration: null },
    });
    expect(storage.calls.some((call) => call.startsWith("copy"))).toBe(false);
  });

  it("★ never copies a placeholder: a source carrying the takedown metadata is recorded, not archived", async () => {
    const objectPath = `stores/${STORE}/media/shoe.webp`;
    storage.put("public", objectPath, PLACEHOLDER, {
      metadata: { [TAKEDOWN_METADATA_KEY]: OTHER_BLOCK },
    });
    const result = await archiveBucketFile(
      { blockId: BLOCK, n: 1, path: objectPath },
      storage,
    );
    expect(result).toMatchObject({
      ok: true,
      created: false,
      file: { state: "placeholder", archivePath: null },
    });
    expect(storage.calls.some((call) => call.startsWith("copy"))).toBe(false);
  });

  it("records a source whose MD5 is no longer the blocked file's as changed, with the MD5 found", async () => {
    const objectPath = `stores/${STORE}/media/shoe.webp`;
    storage.put("public", objectPath, bytesOf("a different shoe"));
    const result = await archiveBucketFile(
      {
        blockId: BLOCK,
        n: 1,
        path: objectPath,
        expectedMd5: md5(bytesOf("original shoe")),
      },
      storage,
    );
    expect(result).toMatchObject({
      ok: true,
      created: false,
      file: {
        state: "changed",
        md5: md5(bytesOf("a different shoe")),
        archivePath: null,
      },
    });
    expect(storage.calls.some((call) => call.startsWith("copy"))).toBe(false);
  });

  it("★ A3: a source replaced between the read and the copy fails with 404 and is recorded as changed, never copied", async () => {
    const objectPath = `stores/${STORE}/media/shoe.webp`;
    const first = storage.put("public", objectPath, bytesOf("original shoe"));
    storage.beforeCopy = () => {
      storage.put("public", objectPath, bytesOf("merchant's new shoe"));
    };
    const result = await archiveBucketFile(
      { blockId: BLOCK, n: 1, path: objectPath },
      storage,
    );
    expect(result).toMatchObject({
      ok: true,
      created: false,
      file: {
        state: "changed",
        sourceGeneration: first.generation,
        archivePath: null,
      },
    });
    expect(
      storage.get("private", `${archiveRoot()}1-shoe.webp`),
    ).toBeUndefined();
  });

  it("★ a destination that already holds the same bytes (412) is accepted and never deleted", async () => {
    const objectPath = `stores/${STORE}/media/shoe.webp`;
    const bytes = bytesOf("original shoe");
    storage.put("public", objectPath, bytes);
    const archivePath = `${archiveRoot()}1-shoe.webp`;
    const earlier = storage.put("private", archivePath, bytes);
    const result = await archiveBucketFile(
      { blockId: BLOCK, n: 1, path: objectPath },
      storage,
    );
    expect(result).toMatchObject({
      ok: true,
      created: false,
      file: { state: "copied", archiveGeneration: earlier.generation },
    });
    expect(storage.deletes).toEqual([]);
    expect(storage.get("private", archivePath)).toBe(earlier);
  });

  it("★ a destination that already holds different bytes (412) is a conflict, left exactly as it is", async () => {
    const objectPath = `stores/${STORE}/media/shoe.webp`;
    storage.put("public", objectPath, bytesOf("original shoe"));
    const archivePath = `${archiveRoot()}1-shoe.webp`;
    const earlier = storage.put(
      "private",
      archivePath,
      bytesOf("something else"),
    );
    const result = await archiveBucketFile(
      { blockId: BLOCK, n: 1, path: objectPath },
      storage,
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "conflict", retryable: false },
    });
    expect(storage.deletes).toEqual([]);
    expect(storage.get("private", archivePath)).toBe(earlier);
  });

  it("★ a copy this attempt made that differs from its source is deleted, pinned to its own generation; the public object is untouched", async () => {
    const objectPath = `stores/${STORE}/media/shoe.webp`;
    const source = storage.put("public", objectPath, bytesOf("original shoe"));
    storage.corruptWrites = true;
    const result = await archiveBucketFile(
      { blockId: BLOCK, n: 1, path: objectPath },
      storage,
    );
    const archivePath = `${archiveRoot()}1-shoe.webp`;
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "mismatch", retryable: true },
    });
    expect(storage.deletes).toEqual([
      { kind: "private", path: archivePath, generation: expect.any(String) },
    ]);
    expect(storage.get("private", archivePath)).toBeUndefined();
    expect(storage.get("public", objectPath)).toBe(source);
    expect(storage.uploads).toEqual([]);
  });

  it("a storage error leaves the public object untouched and asks for another try", async () => {
    const objectPath = `stores/${STORE}/media/shoe.webp`;
    const source = storage.put("public", objectPath, bytesOf("original shoe"));
    storage.errors.set(`objectMetadata public:${objectPath}`, status(503));
    await expect(
      archiveBucketFile({ blockId: BLOCK, n: 1, path: objectPath }, storage),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "unavailable", retryable: true, detail: "status 503" },
    });
    storage.errors.clear();
    storage.errors.set(`copyObject public:${objectPath}`, status(500));
    await expect(
      archiveBucketFile({ blockId: BLOCK, n: 1, path: objectPath }, storage),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "unavailable", retryable: true },
    });
    expect(storage.get("public", objectPath)).toBe(source);
    expect(storage.uploads).toEqual([]);
  });

  it("refuses a bad path, block id or number before touching storage", async () => {
    const cases = [
      { blockId: BLOCK, n: 1, path: `stores/${STORE}/../x.webp` },
      { blockId: BLOCK, n: 1, path: `/stores/${STORE}/x.webp` },
      { blockId: BLOCK, n: 1, path: "" },
      { blockId: BLOCK, n: 1, path: `stores//x.webp` },
      { blockId: BLOCK, n: 1, path: `${archiveRoot()}1-x.webp` },
      { blockId: "not-a-uuid", n: 1, path: `stores/${STORE}/x.webp` },
      { blockId: BLOCK, n: -1, path: `stores/${STORE}/x.webp` },
    ];
    for (const input of cases) {
      await expect(archiveBucketFile(input, storage)).resolves.toMatchObject({
        ok: false,
        failure: { code: "refused", retryable: false },
      });
    }
    expect(storage.calls).toEqual([]);
  });

  it("copies only this database's Mink AI chat attachments from the private bucket", async () => {
    const own = `stores/${STORE}/mink-attachments/${DB}/pic.webp`;
    storage.put("private", own, bytesOf("chat picture"));
    await expect(
      archiveBucketFile(
        { blockId: BLOCK, n: 3, path: own, kind: "private" },
        storage,
      ),
    ).resolves.toMatchObject({
      ok: true,
      created: true,
      file: {
        source: "private",
        sourceBucket: "fake-private",
        state: "copied",
        archivePath: `${archiveRoot()}3-pic.webp`,
      },
    });
    storage.calls = [];
    for (const objectPath of [
      `stores/${STORE}/mink-attachments/${OTHER_DB}/pic.webp`,
      `refine-stage/${DB}/${STORE}/r.webp`,
      `stores/${STORE}/whatsapp/c/in-1.jpg`,
    ]) {
      await expect(
        archiveBucketFile(
          { blockId: BLOCK, n: 3, path: objectPath, kind: "private" },
          storage,
        ),
      ).resolves.toMatchObject({ ok: false, failure: { code: "refused" } });
    }
    expect(storage.calls).toEqual([]);
  });
});

describe("archiveFetchedFile (amendment A1: Unsplash fetched, any other host recorded)", () => {
  const URL_OK =
    "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=1200";

  function respond(body: BodyInit | null, init: ResponseInit = {}) {
    storage.fetchImpl = async () => new Response(body, init);
  }

  it("★ downloads an Unsplash address without following redirects and writes it create-only with its SHA-256 and MD5", async () => {
    const bytes = bytesOf("unsplash photo");
    let seen: RequestInit | undefined;
    storage.fetchImpl = async (_url, init) => {
      seen = init;
      return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
    };
    const result = await archiveFetchedFile(
      { blockId: BLOCK, n: 4, url: URL_OK },
      storage,
    );
    const archivePath = `${archiveRoot()}4-photo-1542291026-7eec264c27ff`;
    expect(result).toMatchObject({
      ok: true,
      created: true,
      file: {
        source: "external",
        path: URL_OK,
        state: "copied",
        archivePath,
        size: bytes.length,
        contentType: "image/jpeg",
        md5: md5(bytes),
        sha256: sha256(bytes),
      },
    });
    expect(seen?.redirect).toBe("manual");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(storage.uploads).toEqual([
      {
        kind: "private",
        path: archivePath,
        contentType: "image/jpeg",
        cacheControl: "private, max-age=0",
        options: { ifGenerationMatch: 0 },
      },
    ]);
  });

  it("records, without fetching, any other host, plain http or another port", async () => {
    for (const url of [
      "https://cdn.example.com/a.jpg",
      "http://images.unsplash.com/photo-1",
      "https://images.unsplash.com:8443/photo-1",
      "https://user@images.unsplash.com/photo-1",
    ]) {
      await expect(
        archiveFetchedFile({ blockId: BLOCK, n: 4, url }, storage),
      ).resolves.toMatchObject({
        ok: true,
        created: false,
        file: { state: "recorded", path: url, archivePath: null },
      });
    }
    expect(storage.calls).toEqual([]);
  });

  it("answers a gone address as missing, a busy host as retryable, and never follows a redirect", async () => {
    respond(null, { status: 404 });
    await expect(
      archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
    ).resolves.toMatchObject({ ok: true, file: { state: "missing" } });
    respond(null, { status: 410 });
    await expect(
      archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
    ).resolves.toMatchObject({ ok: true, file: { state: "missing" } });
    for (const code of [429, 503]) {
      respond(null, { status: code });
      await expect(
        archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
      ).resolves.toMatchObject({
        ok: false,
        failure: { code: "unavailable", retryable: true },
      });
    }
    storage.calls = [];
    respond(null, {
      status: 302,
      headers: { location: "https://evil.example/x" },
    });
    await expect(
      archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "refused", retryable: false },
    });
    respond(null, { status: 403 });
    await expect(
      archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
    ).resolves.toMatchObject({ ok: false, failure: { code: "refused" } });
    expect(storage.calls).toEqual([`fetch ${URL_OK}`, `fetch ${URL_OK}`]);
    expect(storage.uploads).toEqual([]);
  });

  it("refuses more than 50 MB, from the declared length or while reading", async () => {
    respond(bytesOf("x"), {
      headers: { "content-length": String(FETCH_MAX_BYTES + 1) },
    });
    await expect(
      archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
    ).resolves.toMatchObject({ ok: false, failure: { code: "too_large" } });
    const chunk = new Uint8Array(10 * 1024 * 1024);
    let sent = 0;
    respond(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1;
          if (sent > 8) controller.close();
          else controller.enqueue(chunk);
        },
      }),
    );
    await expect(
      archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
    ).resolves.toMatchObject({ ok: false, failure: { code: "too_large" } });
    expect(sent).toBeLessThanOrEqual(7);
    expect(storage.uploads).toEqual([]);
  });

  it("a network failure or timeout asks for another try", async () => {
    storage.fetchImpl = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    await expect(
      archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
    ).resolves.toMatchObject({
      ok: false,
      failure: { code: "unavailable", retryable: true },
    });
  });

  it("★ a retried write that finds its own bytes (412) is accepted; different bytes are a conflict, never deleted", async () => {
    const bytes = bytesOf("unsplash photo");
    const archivePath = `${archiveRoot()}4-photo-1542291026-7eec264c27ff`;
    storage.put("private", archivePath, bytes);
    respond(bytes);
    await expect(
      archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
    ).resolves.toMatchObject({
      ok: true,
      created: false,
      file: { state: "copied" },
    });
    const other = storage.put("private", archivePath, bytesOf("another photo"));
    respond(bytes);
    await expect(
      archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
    ).resolves.toMatchObject({ ok: false, failure: { code: "conflict" } });
    expect(storage.deletes).toEqual([]);
    expect(storage.get("private", archivePath)).toBe(other);
  });

  it("a written copy that does not read back equal is removed, pinned to its own generation", async () => {
    respond(bytesOf("unsplash photo"));
    storage.corruptWrites = true;
    await expect(
      archiveFetchedFile({ blockId: BLOCK, n: 4, url: URL_OK }, storage),
    ).resolves.toMatchObject({ ok: false, failure: { code: "mismatch" } });
    expect(storage.deletes).toHaveLength(1);
    expect(storage.objects.size).toBe(0);
  });
});

describe("archiveBundledFile (a theme file built into the app)", () => {
  it("archives the app's own copy create-only, with its SHA-256 and a type from its name", async () => {
    const bytes = bytesOf("theme hero");
    storage.bundled.set("/themes/basket/hero.webp", bytes);
    await expect(
      archiveBundledFile(
        { blockId: BLOCK, n: 5, publicPath: "/themes/basket/hero.webp" },
        storage,
      ),
    ).resolves.toMatchObject({
      ok: true,
      created: true,
      file: {
        source: "bundled",
        path: "/themes/basket/hero.webp",
        state: "copied",
        archivePath: `${archiveRoot()}5-hero.webp`,
        contentType: "image/webp",
        md5: md5(bytes),
        sha256: sha256(bytes),
      },
    });
  });

  it("records a file the app does not have as missing, and refuses a path outside /themes/ before reading", async () => {
    await expect(
      archiveBundledFile(
        { blockId: BLOCK, n: 5, publicPath: "/themes/basket/none.webp" },
        storage,
      ),
    ).resolves.toMatchObject({ ok: true, file: { state: "missing" } });
    storage.calls = [];
    for (const publicPath of [
      "/themes/../package.json",
      "/themes/basket/../../x.webp",
      "/other/x.webp",
      "/themes//x.webp",
      "themes/x.webp",
    ]) {
      await expect(
        archiveBundledFile({ blockId: BLOCK, n: 5, publicPath }, storage),
      ).resolves.toMatchObject({ ok: false, failure: { code: "refused" } });
    }
    expect(storage.calls).toEqual([]);
  });

  it("the real reader resolves only inside public/themes/", () => {
    expect(bundledThemeFilePath("/themes/basket/hero.webp")).toBe(
      path.join(process.cwd(), "public", "themes", "basket", "hero.webp"),
    );
    expect(bundledThemeFilePath("/themes/../package.json")).toBeNull();
    expect(bundledThemeFilePath("/public/x.webp")).toBeNull();
  });
});

describe("writeArchiveObject and discardArchiveCopy", () => {
  it("writes this database's store-content.jsonl create-only and refuses any other path", async () => {
    const bytes = bytesOf('{"kind":"store"}\n');
    const archivePath = `${archiveRoot()}store-content.jsonl`;
    await expect(
      writeArchiveObject(archivePath, bytes, "application/x-ndjson", storage),
    ).resolves.toMatchObject({
      ok: true,
      created: true,
      size: bytes.length,
      md5: md5(bytes),
      sha256: sha256(bytes),
    });
    storage.calls = [];
    for (const other of [
      `${archiveRoot(OTHER_DB)}store-content.jsonl`,
      `stores/${STORE}/store-content.jsonl`,
    ]) {
      await expect(
        writeArchiveObject(other, bytes, "application/x-ndjson", storage),
      ).resolves.toMatchObject({ ok: false, failure: { code: "refused" } });
    }
    expect(storage.calls).toEqual([]);
  });

  it("deletes a staged copy pinned to its generation, only in this database's archive", async () => {
    const archivePath = `${archiveRoot()}1-shoe.webp`;
    const copy = storage.put("private", archivePath, bytesOf("x"));
    await expect(
      discardArchiveCopy(
        { path: archivePath, generation: copy.generation },
        storage,
      ),
    ).resolves.toEqual({ ok: true, result: "deleted" });
    await expect(
      discardArchiveCopy(
        { path: archivePath, generation: copy.generation },
        storage,
      ),
    ).resolves.toEqual({ ok: true, result: "missing" });
    storage.calls = [];
    await expect(
      discardArchiveCopy(
        { path: `${archiveRoot(OTHER_DB)}1-shoe.webp`, generation: "5" },
        storage,
      ),
    ).resolves.toMatchObject({ ok: false, failure: { code: "refused" } });
    await expect(
      discardArchiveCopy({ path: archivePath, generation: null }, storage),
    ).resolves.toMatchObject({ ok: false, failure: { code: "refused" } });
    expect(storage.calls).toEqual([]);
  });
});

describe("replaceWithPlaceholder (design 3.3 step 5, 8.1 step 3)", () => {
  it("★ overwrites the image with the placeholder pinned to the archived generation, then deletes that generation by number", async () => {
    const { objectPath, file } = await archivedImage();
    const outcome = await replaceWithPlaceholder(
      { blockId: BLOCK, path: objectPath, archived: file },
      storage,
    );
    expect(outcome).toEqual({
      status: "replaced",
      alreadyDone: false,
      archivedGenerationDeleted: true,
      sharedThemeRelease: false,
    });
    expect(storage.uploads).toEqual([
      {
        kind: "public",
        path: objectPath,
        contentType: "image/webp",
        cacheControl: "no-store",
        options: {
          metadata: { [TAKEDOWN_METADATA_KEY]: BLOCK },
          ifGenerationMatch: file.sourceGeneration,
        },
      },
    ]);
    expect(storage.calls).toEqual([
      `meta private:${file.archivePath}`,
      `meta public:${objectPath}`,
      `upload public:${objectPath}`,
      `delete public:${objectPath}#${file.sourceGeneration}`,
    ]);
    const live = storage.get("public", objectPath);
    expect(live?.bytes).toEqual(PLACEHOLDER);
    expect(live?.metadata).toEqual({ [TAKEDOWN_METADATA_KEY]: BLOCK });
    // The archive is never touched by a replacement.
    expect(storage.get("private", file.archivePath ?? "")?.bytes).toEqual(
      bytesOf("original shoe"),
    );
  });

  it("★ E3 row 6: the public object is never written before its copy is confirmed (pending, missing or different archive copy)", async () => {
    const { objectPath, file } = await archivedImage();
    const pending: ArchivedFile = {
      ...file,
      state: "missing",
      archivePath: null,
    };
    await expect(
      replaceWithPlaceholder(
        { blockId: BLOCK, path: objectPath, archived: pending },
        storage,
      ),
    ).resolves.toMatchObject({ status: "not_archived" });

    storage.objects.delete(storage.key("private", file.archivePath ?? ""));
    await expect(
      replaceWithPlaceholder(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({
      status: "not_archived",
      reason: "The archive copy is missing.",
    });

    storage.put("private", file.archivePath ?? "", bytesOf("not the shoe"));
    await expect(
      replaceWithPlaceholder(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({
      status: "not_archived",
      reason: "The archive copy does not match what was recorded.",
    });

    expect(storage.uploads).toEqual([]);
    expect(storage.deletes).toEqual([]);
    expect(storage.get("public", objectPath)?.bytes).toEqual(
      bytesOf("original shoe"),
    );
  });

  it("writes nothing when the file changed after the copy", async () => {
    const { objectPath, file } = await archivedImage();
    const newer = storage.put(
      "public",
      objectPath,
      bytesOf("merchant's new shoe"),
    );
    await expect(
      replaceWithPlaceholder(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({ status: "changed", liveGeneration: newer.generation });
    expect(storage.uploads).toEqual([]);
    expect(storage.get("public", objectPath)).toBe(newer);
  });

  it("a file already gone is reported gone, and its archived generation is deleted by number", async () => {
    const { objectPath, file } = await archivedImage();
    storage.objects.delete(storage.key("public", objectPath));
    await expect(
      replaceWithPlaceholder(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({ status: "gone", archivedGenerationDeleted: true });
    expect(storage.uploads).toEqual([]);
    expect(storage.deletes).toEqual([
      { kind: "public", path: objectPath, generation: file.sourceGeneration },
    ]);
  });

  it("a retried step finds this block's placeholder and writes nothing again", async () => {
    const { objectPath, file } = await archivedImage();
    storage.put("public", objectPath, PLACEHOLDER, {
      metadata: { [TAKEDOWN_METADATA_KEY]: BLOCK },
    });
    await expect(
      replaceWithPlaceholder(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toMatchObject({ status: "replaced", alreadyDone: true });
    expect(storage.uploads).toEqual([]);
  });

  it("a 412 on the write is ours when the placeholder landed, and a change otherwise", async () => {
    const { objectPath, file } = await archivedImage();
    storage.beforeUpload = () => {
      storage.beforeUpload = null;
      storage.put("public", objectPath, PLACEHOLDER, {
        metadata: { [TAKEDOWN_METADATA_KEY]: BLOCK },
      });
    };
    await expect(
      replaceWithPlaceholder(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toMatchObject({ status: "replaced", alreadyDone: false });

    const second = await archivedImage(`stores/${STORE}/media/bag.webp`);
    const merchant = { generation: "" };
    storage.beforeUpload = () => {
      storage.beforeUpload = null;
      merchant.generation = storage.put(
        "public",
        second.objectPath,
        bytesOf("new bag"),
      ).generation;
    };
    const raced = await replaceWithPlaceholder(
      { blockId: BLOCK, path: second.objectPath, archived: second.file },
      storage,
    );
    expect(raced).toEqual({
      status: "changed",
      liveGeneration: merchant.generation,
    });
    expect(storage.get("public", second.objectPath)?.bytes).toEqual(
      bytesOf("new bag"),
    );
  });

  it("refuses a non-image, an entry of another file, and an archive of another database or block, before any write", async () => {
    const { objectPath, file } = await archivedImage();
    const cases: [string, ArchivedFile][] = [
      [objectPath, { ...file, contentType: "video/mp4" }],
      [`stores/${STORE}/media/other.webp`, file],
      [
        objectPath,
        { ...file, archivePath: `${archiveRoot(OTHER_DB)}1-shoe.webp` },
      ],
      [
        objectPath,
        { ...file, archivePath: `${archiveRoot(DB, OTHER_BLOCK)}1-shoe.webp` },
      ],
    ];
    for (const [target, archived] of cases) {
      await expect(
        replaceWithPlaceholder(
          { blockId: BLOCK, path: target, archived },
          storage,
        ),
      ).resolves.toMatchObject({ status: "refused" });
    }
    expect(storage.calls).toEqual([]);
  });

  it("replaces a theme release image and says every store on that theme shows the placeholder", async () => {
    const { objectPath, file } = await archivedImage(
      "theme-releases/luxe/1.0.0/hero-1a2b.webp",
    );
    await expect(
      replaceWithPlaceholder(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toMatchObject({ status: "replaced", sharedThemeRelease: true });
  });

  it("a replacement whose generation delete fails is still a replacement, with the failure named", async () => {
    const { objectPath, file } = await archivedImage();
    storage.errors.set(`deleteGeneration public:${objectPath}`, status(503));
    await expect(
      replaceWithPlaceholder(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toMatchObject({
      status: "replaced",
      archivedGenerationDeleted: false,
      deleteFailure: { code: "unavailable" },
    });
    expect(storage.get("public", objectPath)?.bytes).toEqual(PLACEHOLDER);
  });
});

describe("removeNonImage", () => {
  it("★ deletes a non-image pinned to its archived generation", async () => {
    const { objectPath, file } = await archivedImage(
      `stores/${STORE}/media/manual.pdf`,
      bytesOf("%PDF manual"),
      "application/pdf",
    );
    await expect(
      removeNonImage(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({ status: "removed" });
    expect(storage.deletes).toEqual([
      { kind: "public", path: objectPath, generation: file.sourceGeneration },
    ]);
    expect(storage.get("public", objectPath)).toBeUndefined();
    expect(storage.uploads).toEqual([]);
  });

  it("refuses an image and a theme release file, and deletes nothing before the copy is confirmed or after a change", async () => {
    const image = await archivedImage();
    await expect(
      removeNonImage(
        { blockId: BLOCK, path: image.objectPath, archived: image.file },
        storage,
      ),
    ).resolves.toMatchObject({ status: "refused" });
    const release = await archivedImage(
      "theme-releases/luxe/1.0.0/clip.mp4",
      bytesOf("video"),
      "video/mp4",
    );
    await expect(
      removeNonImage(
        { blockId: BLOCK, path: release.objectPath, archived: release.file },
        storage,
      ),
    ).resolves.toMatchObject({ status: "refused" });

    const pdf = await archivedImage(
      `stores/${STORE}/media/manual.pdf`,
      bytesOf("%PDF manual"),
      "application/pdf",
    );
    const archiveKey = storage.key("private", pdf.file.archivePath ?? "");
    const archiveCopy = storage.objects.get(archiveKey);
    storage.objects.delete(archiveKey);
    await expect(
      removeNonImage(
        { blockId: BLOCK, path: pdf.objectPath, archived: pdf.file },
        storage,
      ),
    ).resolves.toMatchObject({ status: "not_archived" });
    if (archiveCopy) storage.objects.set(archiveKey, archiveCopy);
    storage.put("public", pdf.objectPath, bytesOf("%PDF new manual"), {
      contentType: "application/pdf",
    });
    await expect(
      removeNonImage(
        { blockId: BLOCK, path: pdf.objectPath, archived: pdf.file },
        storage,
      ),
    ).resolves.toMatchObject({ status: "changed" });
    expect(storage.deletes).toEqual([]);
  });
});

describe("restoreFromArchive (design 3.5 step 2)", () => {
  async function replacedImage() {
    const archived = await archivedImage();
    await replaceWithPlaceholder(
      { blockId: BLOCK, path: archived.objectPath, archived: archived.file },
      storage,
    );
    const placeholder = storage.get("public", archived.objectPath);
    storage.calls = [];
    storage.uploads = [];
    storage.deletes = [];
    return { ...archived, placeholderGeneration: placeholder?.generation };
  }

  it("★ writes the original back over this block's placeholder, pinned to that generation, `public, max-age=60` with no takedown metadata", async () => {
    const { objectPath, file, bytes, placeholderGeneration } =
      await replacedImage();
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({ status: "restored", alreadyDone: false });
    expect(storage.uploads).toEqual([
      {
        kind: "public",
        path: objectPath,
        contentType: "image/webp",
        cacheControl: "public, max-age=60",
        options: { ifGenerationMatch: placeholderGeneration },
      },
    ]);
    const live = storage.get("public", objectPath);
    expect(live?.bytes).toEqual(bytes);
    expect(live?.metadata).toEqual({});
  });

  it("★ writes nothing when the merchant has replaced the placeholder since (no takedown metadata)", async () => {
    const { objectPath, file } = await replacedImage();
    const merchant = storage.put(
      "public",
      objectPath,
      bytesOf("merchant's own photo"),
    );
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({ status: "not_restored", reason: "changed" });
    expect(storage.uploads).toEqual([]);
    expect(storage.get("public", objectPath)).toBe(merchant);
  });

  it("writes nothing over another block's placeholder, or when the image was deleted since", async () => {
    const { objectPath, file } = await replacedImage();
    storage.put("public", objectPath, PLACEHOLDER, {
      metadata: { [TAKEDOWN_METADATA_KEY]: OTHER_BLOCK },
    });
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({ status: "not_restored", reason: "changed" });
    storage.objects.delete(storage.key("public", objectPath));
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({ status: "not_restored", reason: "gone" });
    expect(storage.uploads).toEqual([]);
  });

  it("★ A5: an archive path of another database is never restored, and nothing is read", async () => {
    const { objectPath, file } = await replacedImage();
    const foreign: ArchivedFile = {
      ...file,
      archivePath: `${archiveRoot(OTHER_DB)}1-shoe.webp`,
    };
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: objectPath, archived: foreign },
        storage,
      ),
    ).resolves.toEqual({ status: "not_restored", reason: "other_database" });
    await expect(
      restoreFromArchive(
        {
          blockId: BLOCK,
          path: objectPath,
          archived: {
            ...file,
            archivePath: `${archiveRoot(DB, OTHER_BLOCK)}1-shoe.webp`,
          },
        },
        storage,
      ),
    ).resolves.toEqual({ status: "not_restored", reason: "not_this_block" });
    expect(storage.calls).toEqual([]);
  });

  it("an object that already holds the original counts as restored, with nothing written", async () => {
    const { objectPath, file, bytes } = await replacedImage();
    storage.put("public", objectPath, bytes);
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({ status: "restored", alreadyDone: true });
    expect(storage.uploads).toEqual([]);
  });

  it("puts a removed non-image back only while its path is still empty (create-only)", async () => {
    const pdf = await archivedImage(
      `stores/${STORE}/media/manual.pdf`,
      bytesOf("%PDF manual"),
      "application/pdf",
    );
    await removeNonImage(
      { blockId: BLOCK, path: pdf.objectPath, archived: pdf.file },
      storage,
    );
    storage.uploads = [];
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: pdf.objectPath, archived: pdf.file },
        storage,
      ),
    ).resolves.toEqual({ status: "restored", alreadyDone: false });
    expect(storage.uploads[0]?.options).toEqual({ ifGenerationMatch: 0 });
    expect(storage.get("public", pdf.objectPath)?.bytes).toEqual(
      bytesOf("%PDF manual"),
    );

    storage.put("public", pdf.objectPath, bytesOf("%PDF other"), {
      contentType: "application/pdf",
    });
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: pdf.objectPath, archived: pdf.file },
        storage,
      ),
    ).resolves.toEqual({ status: "not_restored", reason: "changed" });
  });

  it("names a missing archive copy, refuses one that reads back different, and loses a race to the merchant", async () => {
    const { objectPath, file } = await replacedImage();
    storage.objects.delete(storage.key("private", file.archivePath ?? ""));
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({ status: "not_restored", reason: "archive_missing" });

    storage.put("private", file.archivePath ?? "", bytesOf("not the shoe"));
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      failure: { code: "mismatch" },
    });

    storage.put("private", file.archivePath ?? "", bytesOf("original shoe"));
    storage.beforeUpload = () => {
      storage.beforeUpload = null;
      storage.put("public", objectPath, bytesOf("merchant's photo"));
    };
    await expect(
      restoreFromArchive(
        { blockId: BLOCK, path: objectPath, archived: file },
        storage,
      ),
    ).resolves.toEqual({ status: "not_restored", reason: "changed" });
    expect(storage.get("public", objectPath)?.bytes).toEqual(
      bytesOf("merchant's photo"),
    );
  });
});

describe("purgeArchiveFiles (design 5.4, 9)", () => {
  it("★ E3 row 26: refuses the whole list, deleting nothing, when any path names another database", async () => {
    const own = `${archiveRoot()}1-shoe.webp`;
    storage.put("private", own, bytesOf("x"));
    const outcome = await purgeArchiveFiles(
      [
        { path: own, generation: "1" },
        { path: `${archiveRoot(OTHER_DB)}1-shoe.webp` },
        { path: `stores/${STORE}/media/a.webp` },
      ],
      storage,
    );
    expect(outcome).toEqual({
      status: "skipped",
      foreignPaths: [
        `${archiveRoot(OTHER_DB)}1-shoe.webp`,
        `stores/${STORE}/media/a.webp`,
      ],
      databases: [OTHER_DB, null],
    });
    expect(storage.calls).toEqual([]);
    expect(storage.get("private", own)).toBeDefined();
  });

  it("deletes by generation when known and by path otherwise", async () => {
    const pinned = storage.put(
      "private",
      `${archiveRoot()}1-shoe.webp`,
      bytesOf("a"),
    );
    storage.put("private", `${archiveRoot()}store-content.jsonl`, bytesOf("b"));
    await expect(
      purgeArchiveFiles(
        [
          {
            path: `${archiveRoot()}1-shoe.webp`,
            generation: pinned.generation,
          },
          { path: `${archiveRoot()}2-gone.webp`, generation: "9" },
          { path: `${archiveRoot()}store-content.jsonl`, generation: null },
        ],
        storage,
      ),
    ).resolves.toEqual({ status: "purged", deleted: 2, missing: 1 });
    expect(storage.objects.size).toBe(0);
    expect(storage.calls).toContain(
      `deletePaths private ${archiveRoot()}store-content.jsonl`,
    );
  });

  it("reports the paths whose delete failed", async () => {
    storage.errors.set(
      `deleteGeneration private:${archiveRoot()}1-shoe.webp`,
      status(503),
    );
    storage.errors.set(
      `deletePaths private:${archiveRoot()}store-content.jsonl`,
      true,
    );
    await expect(
      purgeArchiveFiles(
        [
          { path: `${archiveRoot()}1-shoe.webp`, generation: "4" },
          { path: `${archiveRoot()}store-content.jsonl` },
        ],
        storage,
      ),
    ).resolves.toEqual({
      status: "failed",
      deleted: 0,
      missing: 0,
      failedPaths: [
        `${archiveRoot()}1-shoe.webp`,
        `${archiveRoot()}store-content.jsonl`,
      ],
    });
  });
});

describe("parseArchivedFile", () => {
  it("reads back an entry exactly as it was written, and refuses anything else", async () => {
    const { file } = await archivedImage();
    expect(parseArchivedFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
    for (const value of [
      null,
      [],
      "x",
      { ...file, n: -1 },
      { ...file, source: "legacy" },
      { ...file, state: "pending" },
      { ...file, path: "" },
      { ...file, md5: 5 },
      { ...file, size: -3 },
    ]) {
      expect(parseArchivedFile(value)).toBeNull();
    }
  });
});

describe("the default adapter is lib/storage/gcs.ts", () => {
  it("passes every call through with the bucket kind, the Cache-Control and the options", async () => {
    const bytes = new Uint8Array([7]);
    expect(moderationStorage.bucketName("public")).toBe("mock-media");
    expect(moderationStorage.bucketName("private")).toBe("mock-private");
    await moderationStorage.objectMetadata("private", "takedown-archive/a");
    expect(gcs.gcsObjectMetadata).toHaveBeenCalledWith(
      "private",
      "takedown-archive/a",
    );
    await moderationStorage.copyObject("public", "a", "private", "b", {
      ifSourceGenerationMatch: "5",
      ifGenerationMatch: 0,
    });
    expect(gcs.gcsCopyObject).toHaveBeenCalledWith(
      "public",
      "a",
      "private",
      "b",
      {
        ifSourceGenerationMatch: "5",
        ifGenerationMatch: 0,
      },
    );
    await moderationStorage.uploadPublic("a", bytes, "image/webp", "no-store", {
      metadata: { [TAKEDOWN_METADATA_KEY]: BLOCK },
      ifGenerationMatch: "5",
    });
    expect(gcs.gcsUploadObject).toHaveBeenCalledWith(
      "a",
      bytes,
      "image/webp",
      "no-store",
      {
        metadata: { [TAKEDOWN_METADATA_KEY]: BLOCK },
        ifGenerationMatch: "5",
      },
    );
    await moderationStorage.uploadPrivate("b", bytes, "image/webp", {
      ifGenerationMatch: 0,
    });
    expect(gcs.gcsPrivateUploadObject).toHaveBeenCalledWith(
      "b",
      bytes,
      "image/webp",
      {
        ifGenerationMatch: 0,
      },
    );
    await moderationStorage.downloadObject("private", "b", 100);
    expect(gcs.gcsDownloadObject).toHaveBeenCalledWith("b", 100, "private");
    await moderationStorage.deleteGeneration("public", "a", "5");
    expect(gcs.gcsDeleteGeneration).toHaveBeenCalledWith("public", "a", "5");
    await moderationStorage.deletePaths("private", ["b"]);
    expect(gcs.gcsDeletePaths).toHaveBeenCalledWith(["b"], "private");
    await expect(
      moderationStorage.fetch("https://images.unsplash.com/x", {}),
    ).rejects.toThrow("no network in tests");
  });
});
