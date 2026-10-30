import "server-only";

/**
 * The takedown build's storage steps (design 3.3, 3.5, 5.3 step 2, 8.1 steps
 * 2 to 4; plan A3 and A5). Every function here is one step on one file, says
 * what happened in a value, and never throws: the callers (blocking, the
 * every-minute follow-up, lifting, the archive purge) decide what a result
 * means for the block and record it.
 *
 * Archive first, overwrite second, and the overwrite never comes before the
 * copy is confirmed, because the overwrite destroys the evidence:
 * - `archiveBucketFile` copies exactly the generation it read to the private
 *   bucket at `takedown-archive/<database>/<block id>/<n>-<name>`, create-only
 *   (`ifGenerationMatch: 0`), then confirms the copy's size and MD5. A copy
 *   this attempt created that differs from its source is deleted, pinned to
 *   its own generation; a destination that already existed (412) is compared
 *   and accepted only when equal, never deleted. SDK 7.22 opens the source at
 *   its generation, so a source replaced since the metadata read fails with
 *   404 (not 412): that is "changed before it could be copied".
 * - `archiveFetchedFile` downloads an address on `images.unsplash.com` (https
 *   only, at most 50 MB, 30 seconds) with its SHA-256 and MD5; any other host
 *   is recorded, not fetched. `archiveBundledFile` reads a `/themes/` file
 *   from the app's own `public/` copy. Both write create-only.
 * - `replaceWithPlaceholder` re-reads the archive copy and writes nothing
 *   unless it is there and matches; then overwrites the public object with
 *   the placeholder (`no-store`, metadata `storemink-takedown=<block id>`),
 *   pinned to the archived generation, and deletes that generation by
 *   number. `removeNonImage` deletes a non-image, pinned the same way.
 * - `restoreFromArchive` writes the original back only when the public
 *   object still carries this block's placeholder, pinned to that
 *   generation, as `public, max-age=60` with no takedown metadata.
 * - `purgeArchiveFiles` deletes archive objects, refusing the whole list when
 *   any path names another database (dev, staging and local share one
 *   private bucket; design 9).
 *
 * MD5 is Google's base64 form everywhere (the block's `object_md5` too).
 * Storage is reached through `ModerationStorage`, bound by default to
 * `lib/storage/gcs.ts`, so the tests use a fake and nothing here touches a
 * network by itself.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  GCS_BUCKET_NAME,
  GCS_PRIVATE_BUCKET_NAME,
  gcsCopyObject,
  gcsDeleteGeneration,
  gcsDeletePaths,
  gcsDownloadObject,
  gcsObjectMetadata,
  gcsPrivateUploadObject,
  gcsUploadObject,
  type GcsBucketKind,
  type GcsCopyPreconditions,
  type GcsObjectMetadata,
  type GcsUploadOptions,
} from "@/lib/storage/gcs";
import { isThemeReleaseObjectPath } from "@/lib/storage/paths";
import { logWarn } from "@/lib/observability/logger";
import {
  archiveBlockPrefix,
  archiveDatabase,
  archiveObjectPath,
  archivePathDatabase,
  isThisDatabaseArchivePath,
} from "./archive-paths";
import { PLACEHOLDER_CONTENT_TYPE, placeholderWebp } from "./placeholder";

// ── Constants ───────────────────────────────────────────────────────────────

/** The custom metadata key every placeholder carries, valued its block id. */
export const TAKEDOWN_METADATA_KEY = "storemink-takedown";

/** The placeholder's Cache-Control: no edge or browser keeps it. */
export const PLACEHOLDER_CACHE_CONTROL = "no-store";

/** A restored object's Cache-Control (design 3.5 step 2, decision D4). */
export const RESTORED_CACHE_CONTROL = "public, max-age=60";

/** The only outside host whose files are fetched into the archive. */
export const FETCHABLE_HOSTS: readonly string[] = ["images.unsplash.com"];

/** The most a fetched or bundled file may weigh. */
export const FETCH_MAX_BYTES = 50 * 1024 * 1024;

/** How long a fetch may take, body included. */
export const FETCH_TIMEOUT_MS = 30_000;

/** The most an archived file may weigh to be put back by a restore. */
export const RESTORE_MAX_BYTES = 64 * 1024 * 1024;

const MESSAGE_MAX = 300;
const DETAIL_MAX = 200;
const PURGE_CONCURRENCY = 8;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUNDLED_PATTERN = /^\/themes\/[A-Za-z0-9._/-]+$/;

// ── The storage adapter ─────────────────────────────────────────────────────

/** Everything this module asks of storage, the network and the disk. */
export interface ModerationStorage {
  /** The bucket a kind names (recorded with each archived file). */
  bucketName(kind: GcsBucketKind): string | null;
  objectMetadata(
    kind: GcsBucketKind,
    path: string,
  ): Promise<GcsObjectMetadata | null>;
  copyObject(
    fromKind: GcsBucketKind,
    fromPath: string,
    toKind: GcsBucketKind,
    toPath: string,
    preconditions: GcsCopyPreconditions,
  ): Promise<void>;
  uploadPublic(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    cacheControl: string,
    options: GcsUploadOptions,
  ): Promise<void>;
  uploadPrivate(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    options: GcsUploadOptions,
  ): Promise<void>;
  downloadObject(
    kind: GcsBucketKind,
    path: string,
    maxBytes: number,
  ): Promise<Uint8Array>;
  deleteGeneration(
    kind: GcsBucketKind,
    path: string,
    generation: string | number,
  ): Promise<"deleted" | "missing">;
  /** Path deletes; answers the paths that could not be removed. */
  deletePaths(kind: GcsBucketKind, paths: string[]): Promise<string[]>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** A `/themes/...` file from the app's `public/` copy. */
  readBundledFile(publicPath: string, maxBytes: number): Promise<Uint8Array>;
  placeholder(): Promise<Uint8Array>;
  now(): Date;
}

/** The real storage: `lib/storage/gcs.ts`, `fetch` and the app's disk. */
export const moderationStorage: ModerationStorage = {
  bucketName: (kind) =>
    kind === "private" ? GCS_PRIVATE_BUCKET_NAME : GCS_BUCKET_NAME,
  objectMetadata: (kind, objectPath) => gcsObjectMetadata(kind, objectPath),
  copyObject: (fromKind, fromPath, toKind, toPath, preconditions) =>
    gcsCopyObject(fromKind, fromPath, toKind, toPath, preconditions),
  uploadPublic: async (
    objectPath,
    bytes,
    contentType,
    cacheControl,
    options,
  ) => {
    await gcsUploadObject(
      objectPath,
      bytes,
      contentType,
      cacheControl,
      options,
    );
  },
  uploadPrivate: (objectPath, bytes, contentType, options) =>
    gcsPrivateUploadObject(objectPath, bytes, contentType, options),
  downloadObject: (kind, objectPath, maxBytes) =>
    gcsDownloadObject(objectPath, maxBytes, kind),
  deleteGeneration: (kind, objectPath, generation) =>
    gcsDeleteGeneration(kind, objectPath, generation),
  deletePaths: (kind, paths) => gcsDeletePaths(paths, kind),
  fetch: (url, init) => fetch(url, init),
  readBundledFile: readBundledThemeFile,
  placeholder: placeholderWebp,
  now: () => new Date(),
};

// ── Results ─────────────────────────────────────────────────────────────────

/**
 * Why a step did not finish: `unavailable` (storage or the network did not
 * answer; try again), `mismatch` (a copy did not match its source; try
 * again), `conflict` (a different archive object already sits at the path;
 * a person must look), `refused` (this module may not touch that input),
 * `too_large`.
 */
export type StorageFailureCode =
  | "unavailable"
  | "mismatch"
  | "conflict"
  | "refused"
  | "too_large";

export interface StorageFailure {
  code: StorageFailureCode;
  /** True when the same step may succeed later on its own. */
  retryable: boolean;
  /** A plain sentence for the operator and the log. */
  message: string;
  /** The underlying error's message, when there was one. */
  detail?: string;
}

/** Where an archived file came from. */
export type ArchivedFileSource = "bucket" | "private" | "external" | "bundled";

/**
 * What became of one file: `copied` (in the archive, confirmed), `missing`
 * (the original was already gone), `placeholder` (the source was a
 * placeholder, never copied), `changed` (the original changed before it
 * could be copied), `recorded` (an outside file noted, not fetched).
 */
export type ArchivedFileState =
  | "copied"
  | "missing"
  | "placeholder"
  | "changed"
  | "recorded";

/** One entry of an archive's `files` list (content_block_archives.files). */
export interface ArchivedFile {
  /** The file's number within its block (the `<n>-` of its archive path). */
  n: number;
  source: ArchivedFileSource;
  /** The bucket path, the https address or the `/themes/...` path. */
  path: string;
  state: ArchivedFileState;
  /** The bucket the original was in (bucket and private sources). */
  sourceBucket: string | null;
  /** The generation read (and copied, when `copied`). */
  sourceGeneration: string | null;
  archivePath: string | null;
  archiveGeneration: string | null;
  size: number | null;
  contentType: string | null;
  /** Base64 MD5; for `changed`, the MD5 found when one was read. */
  md5: string | null;
  crc32c: string | null;
  /** Hex SHA-256 of the bytes written (fetched and bundled files). */
  sha256: string | null;
  cacheControl: string | null;
  /** When this entry was written (ISO 8601). */
  at: string;
}

export type ArchiveResult =
  | { ok: true; file: ArchivedFile; created: boolean }
  | { ok: false; failure: StorageFailure };

function failure(
  code: StorageFailureCode,
  message: string,
  err?: unknown,
): StorageFailure {
  const result: StorageFailure = {
    code,
    retryable: code === "unavailable" || code === "mismatch",
    message: message.slice(0, MESSAGE_MAX),
  };
  const detail = errorMessage(err);
  if (detail) result.detail = detail;
  return result;
}

function errorMessage(err: unknown): string | null {
  if (err === undefined || err === null) return null;
  const text = err instanceof Error ? err.message : String(err);
  return text ? text.slice(0, DETAIL_MAX) : null;
}

/** The status Google's SDK put on an error (404, 412, ...). */
function statusOf(err: unknown): unknown {
  return typeof err === "object" && err !== null
    ? (err as { code?: unknown }).code
    : undefined;
}

function md5Base64(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Fingerprint = {
  size: number | null;
  md5: string | null;
  crc32c: string | null;
};

/**
 * Two objects hold the same bytes: the same size and MD5, or the same CRC32C
 * when either has no MD5 (a composite object). Nothing to compare is not a
 * match.
 */
function sameContents(a: Fingerprint, b: Fingerprint): boolean {
  if (a.size === null || b.size === null || a.size !== b.size) return false;
  if (a.md5 && b.md5) return a.md5 === b.md5;
  if (a.crc32c && b.crc32c) return a.crc32c === b.crc32c;
  return false;
}

type EntryBase = Pick<ArchivedFile, "n" | "source" | "path" | "sourceBucket">;

function makeEntry(
  storage: ModerationStorage,
  base: EntryBase,
  state: ArchivedFileState,
  fields: Partial<
    Omit<ArchivedFile, "n" | "source" | "path" | "sourceBucket" | "state">
  > = {},
): ArchivedFile {
  return {
    ...base,
    state,
    sourceGeneration: fields.sourceGeneration ?? null,
    archivePath: fields.archivePath ?? null,
    archiveGeneration: fields.archiveGeneration ?? null,
    size: fields.size ?? null,
    contentType: fields.contentType ?? null,
    md5: fields.md5 ?? null,
    crc32c: fields.crc32c ?? null,
    sha256: fields.sha256 ?? null,
    cacheControl: fields.cacheControl ?? null,
    at: storage.now().toISOString(),
  };
}

function fromMetadata(meta: GcsObjectMetadata) {
  return {
    sourceGeneration: meta.generation,
    size: meta.size,
    contentType: meta.contentType,
    md5: meta.md5,
    crc32c: meta.crc32c,
    cacheControl: meta.cacheControl,
  };
}

function isImageType(contentType: string | null | undefined): boolean {
  return /^image\//i.test((contentType ?? "").trim());
}

/** A path with no empty, `.` or `..` segment, no leading slash, no backslash. */
function plainObjectPath(objectPath: unknown): objectPath is string {
  if (typeof objectPath !== "string" || !objectPath.trim()) return false;
  if (objectPath.includes("\\") || objectPath.includes("\0")) return false;
  return objectPath
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Why a bucket file may not be archived, or null. A public file is any
 * plain path outside the archive; a private file is only one of this
 * database's Mink AI chat attachments
 * (`stores/<store>/mink-attachments/<database>/<name>`), copied for a whole
 * store's archive.
 */
function bucketSourceRefusal(
  kind: GcsBucketKind,
  objectPath: string,
): string | null {
  if (!plainObjectPath(objectPath)) {
    return "The file's storage path is not valid.";
  }
  if (kind === "public") {
    return objectPath.startsWith("takedown-archive/")
      ? "An archive path is never archived again."
      : null;
  }
  const segments = objectPath.split("/");
  const attachment =
    segments.length === 5 &&
    segments[0] === "stores" &&
    UUID_PATTERN.test(segments[1] ?? "") &&
    segments[2] === "mink-attachments" &&
    segments[3] === archiveDatabase();
  return attachment
    ? null
    : "Only this database's Mink AI chat attachments are copied from the private bucket.";
}

// ── Archiving ───────────────────────────────────────────────────────────────

export interface BucketFileInput {
  blockId: string;
  /** The file's number within the block. */
  n: number;
  /** The object's path in its bucket. */
  path: string;
  /** `public` (default) or `private` (a whole store's chat attachments). */
  kind?: GcsBucketKind;
  /**
   * The base64 MD5 the block recorded for the blocked file: a source that no
   * longer has it is recorded `changed`, never archived as the blocked file.
   */
  expectedMd5?: string | null;
}

/**
 * Copy one bucket object into the archive (design 5.3 step 2, 8.1 step 2).
 * `created` says whether this attempt made the archive object, so a block
 * whose transaction then fails deletes only what it made
 * (`discardArchiveCopy`).
 */
export async function archiveBucketFile(
  input: BucketFileInput,
  storage: ModerationStorage = moderationStorage,
): Promise<ArchiveResult> {
  const kind = input.kind ?? "public";
  const refusal = bucketSourceRefusal(kind, input.path);
  if (refusal) return { ok: false, failure: failure("refused", refusal) };
  let archivePath: string;
  try {
    archivePath = archiveObjectPath(input.blockId, input.n, input.path);
  } catch (err) {
    return {
      ok: false,
      failure: failure(
        "refused",
        "The block id or file number is not valid.",
        err,
      ),
    };
  }
  const base: EntryBase = {
    n: input.n,
    source: kind === "private" ? "private" : "bucket",
    path: input.path,
    sourceBucket: storage.bucketName(kind),
  };

  let source: GcsObjectMetadata | null;
  try {
    source = await storage.objectMetadata(kind, input.path);
  } catch (err) {
    return {
      ok: false,
      failure: failure("unavailable", "Storage could not read the file.", err),
    };
  }
  if (!source) {
    return {
      ok: true,
      created: false,
      file: makeEntry(storage, base, "missing"),
    };
  }
  if (TAKEDOWN_METADATA_KEY in source.metadata) {
    return {
      ok: true,
      created: false,
      file: makeEntry(storage, base, "placeholder", fromMetadata(source)),
    };
  }
  if (input.expectedMd5 && source.md5 !== input.expectedMd5) {
    return {
      ok: true,
      created: false,
      file: makeEntry(storage, base, "changed", fromMetadata(source)),
    };
  }
  if (!source.generation) {
    return {
      ok: false,
      failure: failure(
        "unavailable",
        "Storage did not report the file's generation, so it was not copied.",
      ),
    };
  }

  try {
    await storage.copyObject(kind, input.path, "private", archivePath, {
      ifSourceGenerationMatch: source.generation,
      ifGenerationMatch: 0,
    });
  } catch (err) {
    if (statusOf(err) === 404) {
      // The generation read a moment ago is gone (plan A3).
      return {
        ok: true,
        created: false,
        file: makeEntry(storage, base, "changed", {
          sourceGeneration: source.generation,
          size: source.size,
          contentType: source.contentType,
          cacheControl: source.cacheControl,
        }),
      };
    }
    if (statusOf(err) === 412) {
      return acceptExistingCopy(storage, base, archivePath, source);
    }
    return {
      ok: false,
      failure: failure("unavailable", "Storage could not copy the file.", err),
    };
  }
  return confirmCreatedCopy(storage, base, archivePath, source);
}

/** A destination that already existed: equal is accepted, never deleted. */
async function acceptExistingCopy(
  storage: ModerationStorage,
  base: EntryBase,
  archivePath: string,
  source: GcsObjectMetadata,
): Promise<ArchiveResult> {
  let existing: GcsObjectMetadata | null;
  try {
    existing = await storage.objectMetadata("private", archivePath);
  } catch (err) {
    return {
      ok: false,
      failure: failure(
        "unavailable",
        "Storage could not read the archive copy.",
        err,
      ),
    };
  }
  if (!existing) {
    return {
      ok: false,
      failure: failure(
        "unavailable",
        "The archive copy was reported and then not found. Try again.",
      ),
    };
  }
  if (!sameContents(existing, source)) {
    return {
      ok: false,
      failure: failure(
        "conflict",
        `A different file is already archived at ${archivePath}. StoreMink left it as it is.`,
      ),
    };
  }
  return {
    ok: true,
    created: false,
    file: makeEntry(storage, base, "copied", {
      ...fromMetadata(source),
      archivePath,
      archiveGeneration: existing.generation,
    }),
  };
}

/** Read back a copy this attempt made; delete it, pinned, when it differs. */
async function confirmCreatedCopy(
  storage: ModerationStorage,
  base: EntryBase,
  archivePath: string,
  source: GcsObjectMetadata,
): Promise<ArchiveResult> {
  let copy: GcsObjectMetadata | null;
  try {
    copy = await storage.objectMetadata("private", archivePath);
  } catch (err) {
    return {
      ok: false,
      failure: failure(
        "unavailable",
        "Storage could not read the archive copy back.",
        err,
      ),
    };
  }
  if (!copy) {
    return {
      ok: false,
      failure: failure(
        "unavailable",
        "The archive copy could not be read back. Try again.",
      ),
    };
  }
  if (!sameContents(copy, source)) {
    await removeOwnCopy(storage, archivePath, copy.generation);
    return {
      ok: false,
      failure: failure(
        "mismatch",
        "The archive copy did not match the file, so it was removed. Try again.",
      ),
    };
  }
  return {
    ok: true,
    created: true,
    file: makeEntry(storage, base, "copied", {
      ...fromMetadata(source),
      archivePath,
      archiveGeneration: copy.generation,
    }),
  };
}

/** Delete an archive object this attempt wrote, pinned to its generation. */
async function removeOwnCopy(
  storage: ModerationStorage,
  archivePath: string,
  generation: string | null,
): Promise<void> {
  if (!generation) {
    logWarn("moderation: mismatched archive copy kept", { archivePath });
    return;
  }
  try {
    await storage.deleteGeneration("private", archivePath, generation);
  } catch (err) {
    logWarn("moderation: mismatched archive copy kept", {
      archivePath,
      error: errorMessage(err),
    });
  }
}

type CreateOnlyResult =
  | {
      ok: true;
      created: boolean;
      generation: string | null;
      size: number;
      md5: string;
      crc32c: string | null;
    }
  | { ok: false; failure: StorageFailure };

/**
 * Write bytes to the private bucket create-only and confirm them: an object
 * already there with the same bytes is accepted (a retried write), a
 * different one is a conflict and is never touched.
 */
async function writeCreateOnly(
  storage: ModerationStorage,
  archivePath: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<CreateOnlyResult> {
  const md5 = md5Base64(bytes);
  const expected: Fingerprint = { size: bytes.length, md5, crc32c: null };
  let created = true;
  try {
    await storage.uploadPrivate(archivePath, bytes, contentType, {
      ifGenerationMatch: 0,
    });
  } catch (err) {
    if (statusOf(err) !== 412) {
      return {
        ok: false,
        failure: failure(
          "unavailable",
          "Storage could not write the archive copy.",
          err,
        ),
      };
    }
    created = false;
  }
  let written: GcsObjectMetadata | null;
  try {
    written = await storage.objectMetadata("private", archivePath);
  } catch (err) {
    return {
      ok: false,
      failure: failure(
        "unavailable",
        "Storage could not read the archive copy back.",
        err,
      ),
    };
  }
  if (!written) {
    return {
      ok: false,
      failure: failure(
        "unavailable",
        "The archive copy could not be read back. Try again.",
      ),
    };
  }
  if (sameContents(written, expected)) {
    return {
      ok: true,
      created,
      generation: written.generation,
      size: bytes.length,
      md5,
      crc32c: written.crc32c,
    };
  }
  if (!created) {
    return {
      ok: false,
      failure: failure(
        "conflict",
        `A different file is already archived at ${archivePath}. StoreMink left it as it is.`,
      ),
    };
  }
  await removeOwnCopy(storage, archivePath, written.generation);
  return {
    ok: false,
    failure: failure(
      "mismatch",
      "The archive copy did not match the file, so it was removed. Try again.",
    ),
  };
}

class TooLargeError extends Error {
  constructor() {
    super("The file is larger than StoreMink archives.");
  }
}

/** The body, refused as soon as it passes `maxBytes`. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.length > maxBytes) throw new TooLargeError();
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function lastSegment(text: string): string {
  return text.split("/").filter(Boolean).pop() ?? "file";
}

export interface FetchedFileInput {
  blockId: string;
  n: number;
  /** The outside address, as the page used it. */
  url: string;
}

/**
 * Archive an outside file (design 3.3 "Other sources", 8.1 step 2, A1): an
 * https address on `images.unsplash.com` is downloaded (no redirect is
 * followed, at most 50 MB, 30 seconds) and written create-only with its
 * SHA-256 and MD5; any other address is recorded, not fetched.
 */
export async function archiveFetchedFile(
  input: FetchedFileInput,
  storage: ModerationStorage = moderationStorage,
): Promise<ArchiveResult> {
  let address: URL;
  try {
    address = new URL(input.url);
  } catch (err) {
    return {
      ok: false,
      failure: failure("refused", "The file's address is not valid.", err),
    };
  }
  let archivePath: string;
  try {
    archivePath = archiveObjectPath(
      input.blockId,
      input.n,
      lastSegment(address.pathname),
    );
  } catch (err) {
    return {
      ok: false,
      failure: failure(
        "refused",
        "The block id or file number is not valid.",
        err,
      ),
    };
  }
  const base: EntryBase = {
    n: input.n,
    source: "external",
    path: input.url,
    sourceBucket: null,
  };
  const fetchable =
    address.protocol === "https:" &&
    !address.username &&
    !address.password &&
    address.port === "" &&
    FETCHABLE_HOSTS.includes(address.hostname.toLowerCase());
  if (!fetchable) {
    return {
      ok: true,
      created: false,
      file: makeEntry(storage, base, "recorded"),
    };
  }

  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await storage.fetch(address.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      failure: failure("unavailable", "The file could not be downloaded.", err),
    };
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: true,
      created: false,
      file: makeEntry(storage, base, "missing"),
    };
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      failure: failure(
        "unavailable",
        `The file's host answered ${response.status}. Try again.`,
      ),
    };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      failure: failure(
        "refused",
        response.status >= 300 && response.status < 400
          ? "The file's address sent StoreMink elsewhere, which StoreMink does not follow."
          : `The file's host refused the download (${response.status}).`,
      ),
    };
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FETCH_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      failure: failure(
        "too_large",
        "The file is larger than StoreMink archives (50 MB).",
      ),
    };
  }
  try {
    bytes = await readCapped(response, FETCH_MAX_BYTES);
  } catch (err) {
    return err instanceof TooLargeError
      ? {
          ok: false,
          failure: failure(
            "too_large",
            "The file is larger than StoreMink archives (50 MB).",
          ),
        }
      : {
          ok: false,
          failure: failure(
            "unavailable",
            "The file could not be downloaded.",
            err,
          ),
        };
  }
  const contentType =
    (response.headers.get("content-type") ?? "").trim().slice(0, 200) ||
    "application/octet-stream";
  return writeFetched(storage, base, archivePath, bytes, contentType);
}

async function writeFetched(
  storage: ModerationStorage,
  base: EntryBase,
  archivePath: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<ArchiveResult> {
  const written = await writeCreateOnly(
    storage,
    archivePath,
    bytes,
    contentType,
  );
  if (!written.ok) return written;
  return {
    ok: true,
    created: written.created,
    file: makeEntry(storage, base, "copied", {
      archivePath,
      archiveGeneration: written.generation,
      size: written.size,
      contentType,
      md5: written.md5,
      crc32c: written.crc32c,
      sha256: sha256Hex(bytes),
    }),
  };
}

const BUNDLED_TYPES: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  webm: "video/webm",
  webp: "image/webp",
};

/** True for a `/themes/...` path migration 0269's target check admits. */
export function isBundledThemePath(publicPath: string): boolean {
  if (typeof publicPath !== "string" || !BUNDLED_PATTERN.test(publicPath)) {
    return false;
  }
  return publicPath
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The file a `/themes/...` path serves from the app's `public/`, or null:
 * resolved, then checked to stay inside `public/themes/` (the
 * `lib/mink/revamp/ownership.ts` rule).
 */
export function bundledThemeFilePath(publicPath: string): string | null {
  if (!isBundledThemePath(publicPath)) return null;
  const publicRoot = path.join(process.cwd(), "public");
  const themesRoot = path.join(publicRoot, "themes") + path.sep;
  const resolved = path.resolve(publicRoot, `.${publicPath}`);
  return resolved.startsWith(themesRoot) ? resolved : null;
}

async function readBundledThemeFile(
  publicPath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const file = bundledThemeFilePath(publicPath);
  if (!file) {
    throw Object.assign(new Error("Not a theme file."), { code: "ENOENT" });
  }
  // ★ turbopackIgnore: the build cannot tell this path stays inside
  //   public/themes/, so without it the production build traced the whole
  //   project into .next/standalone. public/ is copied into the image on its
  //   own (Dockerfile), so nothing here needs tracing.
  const info = await stat(/*turbopackIgnore: true*/ file);
  if (!info.isFile()) {
    throw Object.assign(new Error("Not a file."), { code: "ENOENT" });
  }
  if (info.size > maxBytes) throw new TooLargeError();
  const bytes = new Uint8Array(await readFile(/*turbopackIgnore: true*/ file));
  if (bytes.length > maxBytes) throw new TooLargeError();
  return bytes;
}

export interface BundledFileInput {
  blockId: string;
  n: number;
  /** The `/themes/...` path pages use. */
  publicPath: string;
}

/**
 * Archive an image built into the app (design 3.3 "Other sources", 8.1 step
 * 2) from the app's own `public/` copy, create-only, with its SHA-256 and
 * MD5. A file the app does not have is recorded `missing`.
 */
export async function archiveBundledFile(
  input: BundledFileInput,
  storage: ModerationStorage = moderationStorage,
): Promise<ArchiveResult> {
  if (!isBundledThemePath(input.publicPath)) {
    return {
      ok: false,
      failure: failure("refused", "The theme file's path is not valid."),
    };
  }
  let archivePath: string;
  try {
    archivePath = archiveObjectPath(input.blockId, input.n, input.publicPath);
  } catch (err) {
    return {
      ok: false,
      failure: failure(
        "refused",
        "The block id or file number is not valid.",
        err,
      ),
    };
  }
  const base: EntryBase = {
    n: input.n,
    source: "bundled",
    path: input.publicPath,
    sourceBucket: null,
  };
  let bytes: Uint8Array;
  try {
    bytes = await storage.readBundledFile(input.publicPath, FETCH_MAX_BYTES);
  } catch (err) {
    if (err instanceof TooLargeError) {
      return {
        ok: false,
        failure: failure(
          "too_large",
          "The file is larger than StoreMink archives (50 MB).",
        ),
      };
    }
    const code = statusOf(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        ok: true,
        created: false,
        file: makeEntry(storage, base, "missing"),
      };
    }
    return {
      ok: false,
      failure: failure("unavailable", "The theme file could not be read.", err),
    };
  }
  const extension = (input.publicPath.split(".").pop() ?? "").toLowerCase();
  const contentType = BUNDLED_TYPES[extension] ?? "application/octet-stream";
  return writeFetched(storage, base, archivePath, bytes, contentType);
}

export type ArchiveObjectWrite =
  | {
      ok: true;
      created: boolean;
      generation: string | null;
      size: number;
      md5: string;
      sha256: string;
    }
  | { ok: false; failure: StorageFailure };

/**
 * Write one object of this database's archive create-only and confirm it
 * (the whole-store `store-content.jsonl`, design 3.6). Any path outside
 * `takedown-archive/<this database>/` is refused.
 */
export async function writeArchiveObject(
  archivePath: string,
  bytes: Uint8Array,
  contentType: string,
  storage: ModerationStorage = moderationStorage,
): Promise<ArchiveObjectWrite> {
  if (!isThisDatabaseArchivePath(archivePath)) {
    return {
      ok: false,
      failure: failure("refused", "Only this database's archive is written."),
    };
  }
  const written = await writeCreateOnly(
    storage,
    archivePath,
    bytes,
    contentType,
  );
  if (!written.ok) return written;
  return {
    ok: true,
    created: written.created,
    generation: written.generation,
    size: written.size,
    md5: written.md5,
    sha256: sha256Hex(bytes),
  };
}

export type DiscardResult =
  | { ok: true; result: "deleted" | "missing" }
  | { ok: false; failure: StorageFailure };

/**
 * Delete an archive object this attempt made (a block whose transaction
 * failed, design 5.3 step 3), pinned to its generation. Only this database's
 * archive, and only a known generation.
 */
export async function discardArchiveCopy(
  copy: { path: string; generation: string | null },
  storage: ModerationStorage = moderationStorage,
): Promise<DiscardResult> {
  if (!isThisDatabaseArchivePath(copy.path) || !copy.generation) {
    return {
      ok: false,
      failure: failure(
        "refused",
        "Only this database's archive copies with a known generation are deleted.",
      ),
    };
  }
  try {
    const result = await storage.deleteGeneration(
      "private",
      copy.path,
      copy.generation,
    );
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      failure: failure(
        "unavailable",
        "Storage could not delete the archive copy.",
        err,
      ),
    };
  }
}

// ── Replacing and removing ──────────────────────────────────────────────────

export interface ReplaceInput {
  blockId: string;
  /** The public object's path (the block's `object_path`). */
  path: string;
  /** This file's archive entry. */
  archived: ArchivedFile;
}

export type ReplaceOutcome =
  | {
      status: "replaced";
      /** The placeholder was already there (a retried step). */
      alreadyDone: boolean;
      /** The archived generation is no longer readable at the public path. */
      archivedGenerationDeleted: boolean;
      /** Why it could not be deleted, when it could not. */
      deleteFailure?: StorageFailure;
      /** A theme release image: every store on that theme shows the placeholder. */
      sharedThemeRelease: boolean;
    }
  | { status: "removed" }
  | {
      /** The public object is not the archived generation: nothing written. */
      status: "changed";
      liveGeneration: string | null;
    }
  | {
      /** The public object no longer exists: nothing to replace. */
      status: "gone";
      archivedGenerationDeleted: boolean;
    }
  | {
      /** No confirmed archive copy: the public object is never touched. */
      status: "not_archived";
      reason: string;
    }
  | { status: "refused"; reason: string }
  | { status: "failed"; failure: StorageFailure };

type Prepared = { sourceGeneration: string; live: GcsObjectMetadata };

/**
 * The checks every write to the public object makes first, in this order:
 * the input, the archive copy re-read and matched (nothing is written before
 * that), then the public object's generation.
 */
async function prepareWrite(
  input: ReplaceInput,
  storage: ModerationStorage,
  wantImage: boolean,
): Promise<Prepared | ReplaceOutcome> {
  const { archived } = input;
  if (
    !plainObjectPath(input.path) ||
    input.path.startsWith("takedown-archive/")
  ) {
    return {
      status: "refused",
      reason: "The file's storage path is not valid.",
    };
  }
  if (archived.source !== "bucket" || archived.path !== input.path) {
    return {
      status: "refused",
      reason: "The archive entry is not this file's.",
    };
  }
  if (isImageType(archived.contentType) !== wantImage) {
    return {
      status: "refused",
      reason: wantImage
        ? "The file is not an image, so it is deleted rather than replaced."
        : "The file is an image, so it is replaced rather than deleted.",
    };
  }
  if (!wantImage && isThemeReleaseObjectPath(input.path)) {
    return {
      status: "refused",
      reason:
        "A theme release file is shared by every store on that theme and is not deleted.",
    };
  }
  if (
    archived.state !== "copied" ||
    !archived.archivePath ||
    !archived.sourceGeneration
  ) {
    return {
      status: "not_archived",
      reason: "The file has no confirmed copy in the archive.",
    };
  }
  let prefix: string;
  try {
    prefix = archiveBlockPrefix(input.blockId);
  } catch {
    return { status: "refused", reason: "The block id is not valid." };
  }
  if (!archived.archivePath.startsWith(prefix)) {
    return {
      status: "refused",
      reason: "The archive copy is not this block's in this database.",
    };
  }

  let copy: GcsObjectMetadata | null;
  try {
    copy = await storage.objectMetadata("private", archived.archivePath);
  } catch (err) {
    return {
      status: "failed",
      failure: failure(
        "unavailable",
        "Storage could not read the archive copy.",
        err,
      ),
    };
  }
  if (!copy) {
    return { status: "not_archived", reason: "The archive copy is missing." };
  }
  if (
    (archived.archiveGeneration &&
      copy.generation !== archived.archiveGeneration) ||
    !sameContents(copy, archived)
  ) {
    return {
      status: "not_archived",
      reason: "The archive copy does not match what was recorded.",
    };
  }

  let live: GcsObjectMetadata | null;
  try {
    live = await storage.objectMetadata("public", input.path);
  } catch (err) {
    return {
      status: "failed",
      failure: failure("unavailable", "Storage could not read the file.", err),
    };
  }
  if (!live) {
    const deleted = await deleteArchivedGeneration(
      storage,
      input.path,
      archived.sourceGeneration,
    );
    return { status: "gone", archivedGenerationDeleted: deleted.ok };
  }
  if (wantImage && live.metadata[TAKEDOWN_METADATA_KEY] === input.blockId) {
    return replacedAlready(
      storage,
      input.path,
      archived.sourceGeneration,
      true,
    );
  }
  if (live.generation !== archived.sourceGeneration) {
    return { status: "changed", liveGeneration: live.generation };
  }
  return { sourceGeneration: archived.sourceGeneration, live };
}

function isPrepared(value: Prepared | ReplaceOutcome): value is Prepared {
  return "sourceGeneration" in value;
}

async function deleteArchivedGeneration(
  storage: ModerationStorage,
  objectPath: string,
  generation: string,
): Promise<{ ok: true } | { ok: false; failure: StorageFailure }> {
  try {
    // "missing" is fine: that generation is gone already.
    await storage.deleteGeneration("public", objectPath, generation);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      failure: failure(
        "unavailable",
        "The archived generation could not be deleted from the public bucket.",
        err,
      ),
    };
  }
}

async function replacedAlready(
  storage: ModerationStorage,
  objectPath: string,
  sourceGeneration: string,
  alreadyDone: boolean,
): Promise<ReplaceOutcome> {
  const deleted = await deleteArchivedGeneration(
    storage,
    objectPath,
    sourceGeneration,
  );
  return {
    status: "replaced",
    alreadyDone,
    archivedGenerationDeleted: deleted.ok,
    ...(deleted.ok ? {} : { deleteFailure: deleted.failure }),
    sharedThemeRelease: isThemeReleaseObjectPath(objectPath),
  };
}

/**
 * Overwrite a blocked image with the placeholder (design 3.3 step 5, 8.1
 * step 3), pinned to the archived generation, then delete that generation by
 * number. Writes nothing unless the archive copy is there and matches.
 */
export async function replaceWithPlaceholder(
  input: ReplaceInput,
  storage: ModerationStorage = moderationStorage,
): Promise<ReplaceOutcome> {
  const prepared = await prepareWrite(input, storage, true);
  if (!isPrepared(prepared)) return prepared;
  let bytes: Uint8Array;
  try {
    bytes = await storage.placeholder();
  } catch (err) {
    return {
      status: "failed",
      failure: failure(
        "unavailable",
        "The placeholder image could not be read.",
        err,
      ),
    };
  }
  try {
    await storage.uploadPublic(
      input.path,
      bytes,
      PLACEHOLDER_CONTENT_TYPE,
      PLACEHOLDER_CACHE_CONTROL,
      {
        metadata: { [TAKEDOWN_METADATA_KEY]: input.blockId },
        ifGenerationMatch: prepared.sourceGeneration,
      },
    );
  } catch (err) {
    if (statusOf(err) !== 412) {
      return {
        status: "failed",
        failure: failure(
          "unavailable",
          "Storage could not write the placeholder.",
          err,
        ),
      };
    }
    // The precondition failed: either the file changed, or a retried write
    // of this very placeholder had already landed.
    let now: GcsObjectMetadata | null;
    try {
      now = await storage.objectMetadata("public", input.path);
    } catch (readErr) {
      return {
        status: "failed",
        failure: failure(
          "unavailable",
          "Storage could not read the file.",
          readErr,
        ),
      };
    }
    if (now?.metadata[TAKEDOWN_METADATA_KEY] !== input.blockId) {
      return { status: "changed", liveGeneration: now?.generation ?? null };
    }
  }
  return replacedAlready(storage, input.path, prepared.sourceGeneration, false);
}

/**
 * Delete a blocked file that is not an image (a video, a PDF), pinned to the
 * archived generation. Writes nothing unless the archive copy is there and
 * matches; never deletes under `theme-releases/`.
 */
export async function removeNonImage(
  input: ReplaceInput,
  storage: ModerationStorage = moderationStorage,
): Promise<ReplaceOutcome> {
  const prepared = await prepareWrite(input, storage, false);
  if (!isPrepared(prepared)) return prepared;
  let result: "deleted" | "missing";
  try {
    result = await storage.deleteGeneration(
      "public",
      input.path,
      prepared.sourceGeneration,
    );
  } catch (err) {
    return {
      status: "failed",
      failure: failure(
        "unavailable",
        "Storage could not delete the file.",
        err,
      ),
    };
  }
  if (result === "deleted") return { status: "removed" };
  // The generation vanished between the read and the delete.
  let now: GcsObjectMetadata | null;
  try {
    now = await storage.objectMetadata("public", input.path);
  } catch (err) {
    return {
      status: "failed",
      failure: failure("unavailable", "Storage could not read the file.", err),
    };
  }
  return now
    ? { status: "changed", liveGeneration: now.generation }
    : { status: "removed" };
}

// ── Restoring ───────────────────────────────────────────────────────────────

export type RestoreRefusal =
  /** The archive path names another database (design 9). */
  | "other_database"
  /** The archive path is not under this block's folder. */
  | "not_this_block"
  /** The entry has no confirmed copy. */
  | "not_archived"
  /** The entry does not describe this public file. */
  | "invalid"
  /** The public object is not this block's placeholder any more. */
  | "changed"
  /** The public image was deleted since. */
  | "gone"
  /** The archive copy is not there. */
  | "archive_missing";

export type RestoreOutcome =
  | { status: "restored"; alreadyDone: boolean }
  | { status: "not_restored"; reason: RestoreRefusal }
  | { status: "failed"; failure: StorageFailure };

/**
 * Put the original back after a lift (design 3.5 step 2, 5.4): only from an
 * archive path of this database and this block, only while the public object
 * still carries this block's placeholder (pinned to that generation), written
 * `public, max-age=60` with no takedown metadata. A removed non-image is put
 * back only while its path is still empty (create-only). An object that
 * already holds the original counts as restored.
 */
export async function restoreFromArchive(
  input: ReplaceInput,
  storage: ModerationStorage = moderationStorage,
): Promise<RestoreOutcome> {
  const { archived } = input;
  if (
    archived.archivePath &&
    !isThisDatabaseArchivePath(archived.archivePath)
  ) {
    return { status: "not_restored", reason: "other_database" };
  }
  if (archived.state !== "copied" || !archived.archivePath) {
    return { status: "not_restored", reason: "not_archived" };
  }
  let prefix: string;
  try {
    prefix = archiveBlockPrefix(input.blockId);
  } catch {
    return { status: "not_restored", reason: "invalid" };
  }
  if (!archived.archivePath.startsWith(prefix)) {
    return { status: "not_restored", reason: "not_this_block" };
  }
  if (
    !plainObjectPath(input.path) ||
    archived.source !== "bucket" ||
    archived.path !== input.path
  ) {
    return { status: "not_restored", reason: "invalid" };
  }

  let live: GcsObjectMetadata | null;
  try {
    live = await storage.objectMetadata("public", input.path);
  } catch (err) {
    return {
      status: "failed",
      failure: failure("unavailable", "Storage could not read the file.", err),
    };
  }
  let pin: string | number;
  if (live) {
    const marker = live.metadata[TAKEDOWN_METADATA_KEY];
    if (marker === input.blockId && live.generation) {
      pin = live.generation;
    } else if (marker === undefined && sameContents(live, archived)) {
      return { status: "restored", alreadyDone: true };
    } else {
      return { status: "not_restored", reason: "changed" };
    }
  } else if (isImageType(archived.contentType)) {
    return { status: "not_restored", reason: "gone" };
  } else {
    pin = 0;
  }

  let copy: GcsObjectMetadata | null;
  try {
    copy = await storage.objectMetadata("private", archived.archivePath);
  } catch (err) {
    return {
      status: "failed",
      failure: failure(
        "unavailable",
        "Storage could not read the archive copy.",
        err,
      ),
    };
  }
  if (!copy) return { status: "not_restored", reason: "archive_missing" };
  if (copy.size > RESTORE_MAX_BYTES) {
    return {
      status: "failed",
      failure: failure(
        "too_large",
        "The archived copy is too large to put back automatically.",
      ),
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await storage.downloadObject(
      "private",
      archived.archivePath,
      RESTORE_MAX_BYTES,
    );
  } catch (err) {
    if (statusOf(err) === 404) {
      return { status: "not_restored", reason: "archive_missing" };
    }
    return {
      status: "failed",
      failure: failure(
        "unavailable",
        "Storage could not read the archive copy.",
        err,
      ),
    };
  }
  if (archived.md5 && md5Base64(bytes) !== archived.md5) {
    return {
      status: "failed",
      failure: failure(
        "mismatch",
        "The archive copy read back did not match what was recorded.",
      ),
    };
  }
  try {
    await storage.uploadPublic(
      input.path,
      bytes,
      archived.contentType ?? copy.contentType ?? "application/octet-stream",
      RESTORED_CACHE_CONTROL,
      { ifGenerationMatch: pin },
    );
  } catch (err) {
    if (statusOf(err) !== 412) {
      return {
        status: "failed",
        failure: failure(
          "unavailable",
          "Storage could not write the file back.",
          err,
        ),
      };
    }
    let now: GcsObjectMetadata | null;
    try {
      now = await storage.objectMetadata("public", input.path);
    } catch (readErr) {
      return {
        status: "failed",
        failure: failure(
          "unavailable",
          "Storage could not read the file.",
          readErr,
        ),
      };
    }
    return now &&
      now.metadata[TAKEDOWN_METADATA_KEY] === undefined &&
      sameContents(now, archived)
      ? { status: "restored", alreadyDone: true }
      : { status: "not_restored", reason: "changed" };
  }
  return { status: "restored", alreadyDone: false };
}

// ── Purging ─────────────────────────────────────────────────────────────────

export interface ArchiveObjectRef {
  path: string;
  /** Deleted by number when known, so no version of it stays. */
  generation?: string | null;
}

export type PurgeOutcome =
  | { status: "purged"; deleted: number; missing: number }
  | {
      /** A path names another database: nothing was deleted (design 9). */
      status: "skipped";
      foreignPaths: string[];
      /** The database each foreign path names (null: not an archive path). */
      databases: (string | null)[];
    }
  | {
      status: "failed";
      deleted: number;
      missing: number;
      failedPaths: string[];
    };

/**
 * Delete an archive's objects from the private bucket (the archive purge,
 * design 5.4 and 8.2). Refuses the whole list, deleting nothing, when any
 * path is not under this database's archive; deletes by generation when one
 * is known, else by path.
 */
export async function purgeArchiveFiles(
  objects: ArchiveObjectRef[],
  storage: ModerationStorage = moderationStorage,
): Promise<PurgeOutcome> {
  const foreign = objects.filter(
    (object) => !isThisDatabaseArchivePath(object.path),
  );
  if (foreign.length > 0) {
    return {
      status: "skipped",
      foreignPaths: foreign.map((object) => object.path),
      databases: foreign.map((object) => archivePathDatabase(object.path)),
    };
  }
  let deleted = 0;
  let missing = 0;
  const failedPaths: string[] = [];
  const pinned = objects.filter(
    (object) =>
      typeof object.generation === "string" && /^\d+$/.test(object.generation),
  );
  const byPath = objects
    .filter((object) => !pinned.includes(object))
    .map((object) => object.path);

  for (let i = 0; i < pinned.length; i += PURGE_CONCURRENCY) {
    await Promise.all(
      pinned.slice(i, i + PURGE_CONCURRENCY).map(async (object) => {
        try {
          const result = await storage.deleteGeneration(
            "private",
            object.path,
            object.generation as string,
          );
          if (result === "deleted") deleted += 1;
          else missing += 1;
        } catch {
          failedPaths.push(object.path);
        }
      }),
    );
  }
  if (byPath.length > 0) {
    let failed: string[];
    try {
      failed = await storage.deletePaths("private", byPath);
    } catch {
      failed = [...byPath];
    }
    failedPaths.push(...failed);
    deleted += byPath.length - failed.length;
  }
  return failedPaths.length > 0
    ? { status: "failed", deleted, missing, failedPaths }
    : { status: "purged", deleted, missing };
}

// ── Reading an archive entry back ───────────────────────────────────────────

const SOURCES: readonly ArchivedFileSource[] = [
  "bucket",
  "private",
  "external",
  "bundled",
];
const STATES: readonly ArchivedFileState[] = [
  "copied",
  "missing",
  "placeholder",
  "changed",
  "recorded",
];

/**
 * One `files` entry read back from the database, or null when it is not one
 * this module wrote (a caller then treats the file as not archived).
 */
export function parseArchivedFile(value: unknown): ArchivedFile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const text = (key: string): string | null | undefined => {
    const field = row[key];
    if (field === null || field === undefined) return null;
    return typeof field === "string" ? field : undefined;
  };
  const n = row.n;
  const size = row.size;
  if (
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < 0 ||
    !SOURCES.includes(row.source as ArchivedFileSource) ||
    !STATES.includes(row.state as ArchivedFileState) ||
    typeof row.path !== "string" ||
    !row.path ||
    typeof row.at !== "string" ||
    !(
      size === null ||
      size === undefined ||
      (typeof size === "number" && size >= 0)
    )
  ) {
    return null;
  }
  const keys = [
    "sourceBucket",
    "sourceGeneration",
    "archivePath",
    "archiveGeneration",
    "contentType",
    "md5",
    "crc32c",
    "sha256",
    "cacheControl",
  ] as const;
  const strings: Partial<Record<(typeof keys)[number], string | null>> = {};
  for (const key of keys) {
    const field = text(key);
    if (field === undefined) return null;
    strings[key] = field;
  }
  return {
    n,
    source: row.source as ArchivedFileSource,
    path: row.path,
    state: row.state as ArchivedFileState,
    sourceBucket: strings.sourceBucket ?? null,
    sourceGeneration: strings.sourceGeneration ?? null,
    archivePath: strings.archivePath ?? null,
    archiveGeneration: strings.archiveGeneration ?? null,
    size: typeof size === "number" ? size : null,
    contentType: strings.contentType ?? null,
    md5: strings.md5 ?? null,
    crc32c: strings.crc32c ?? null,
    sha256: strings.sha256 ?? null,
    cacheControl: strings.cacheControl ?? null,
    at: row.at,
  };
}
