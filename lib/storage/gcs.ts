// Google Cloud Storage backend for media (see CODEBASE.md §7).
//
// GCS is the media backend (GCS_BUCKET required). Auth is Application Default
// Credentials (ADC): automatic on Cloud Run's default service account, local
// dev via `gcloud auth application-default login`. An optional base64
// service-account JSON (GCP_SA_KEY) is honoured for hosts without ADC, and is
// REQUIRED to sign video upload URLs off Cloud Run (user ADC can't sign; Cloud
// Run signs via IAM SignBlob).
//
// Server-only (the @google-cloud/storage SDK is Node-only). Objects are served
// from a PUBLIC bucket (uniform bucket-level access), so the public URL is a
// plain https://storage.googleapis.com/<bucket>/<path>.
//
// ★★ OPEN BY LINK, NEVER LISTABLE. The bucket grants `allUsers`
// `roles/storage.legacyObjectReader` (storage.objects.get, not
// storage.objects.list; the owner's change from `roles/storage.objectViewer`,
// which included listing): anyone with an object's URL can read it, nobody can
// list the bucket. An unguessable path is still not access control, so
// anything that is not meant for the public (WhatsApp chat photos, voice
// notes and PDFs, and Mink AI chat attachments) goes in the PRIVATE bucket
// below (GCS_PRIVATE_BUCKET: no public access, public access prevention
// enforced), read only through an authenticated route that streams it. There
// is deliberately no fallback to the public bucket when the private one is
// not configured.
//
// ★ The private bucket also holds Refine with Mink AI results until they are
// paid for (lib/mink/refine-stages.ts), under `refine-stage/{DB_NAME}/`: one
// prefix per database, because local development shares the dev and staging
// bucket, and a stage is decided by rows only its own database holds. It
// holds Mink AI chat attachments too (lib/mink/attachments.ts), under
// `stores/{store}/mink-attachments/{DB_NAME}/`, and the takedown archive
// (lib/moderation/storage.ts), under `takedown-archive/{DB_NAME}/`, for the
// same reason.
//
// ★ Public objects are written `public, max-age=60` unless the caller names
// another value (takedown decision D4): Google's edge may keep a copy for as
// long as an object's Cache-Control allows, and nothing can take it back
// sooner, so a blocked or replaced file stays readable there for at most a
// minute.

import type { Readable } from "node:stream";
import type { Storage } from "@google-cloud/storage";
import { logError } from "@/lib/observability/logger";

export const GCS_PUBLIC_HOST = "storage.googleapis.com";

// The configured media bucket (null when GCS is not the backend).
export const GCS_BUCKET_NAME = process.env.GCS_BUCKET || null;

/** True when GCS is configured as the media backend. */
export const gcsConfigured = Boolean(GCS_BUCKET_NAME);

/** The private bucket (null when not configured): never readable by URL. */
export const GCS_PRIVATE_BUCKET_NAME = process.env.GCS_PRIVATE_BUCKET || null;

/** True when private objects (chat media) can be stored. */
export const gcsPrivateConfigured = Boolean(GCS_PRIVATE_BUCKET_NAME);

let _storage: Storage | null = null;

async function storage(): Promise<Storage> {
  if (!_storage) {
    const { Storage } = await import("@google-cloud/storage");
    const keyB64 = process.env.GCP_SA_KEY;
    _storage = new Storage({
      projectId: process.env.GCP_PROJECT_ID,
      ...(keyB64
        ? {
            credentials: JSON.parse(
              Buffer.from(keyB64, "base64").toString("utf8"),
            ),
          }
        : {}),
    });
  }
  return _storage;
}

async function bucket() {
  if (!GCS_BUCKET_NAME) throw new Error("GCS_BUCKET is not set.");
  return (await storage()).bucket(GCS_BUCKET_NAME);
}

async function privateBucket() {
  if (!GCS_PRIVATE_BUCKET_NAME) {
    throw new Error("GCS_PRIVATE_BUCKET is not set.");
  }
  return (await storage()).bucket(GCS_PRIVATE_BUCKET_NAME);
}

/** Which bucket an object lives in. */
export type GcsBucketKind = "public" | "private";

function bucketFor(kind: GcsBucketKind) {
  return kind === "private" ? privateBucket() : bucket();
}

function assertObjectPath(path: string): void {
  if (!path.trim() || path.split("/").includes("..")) {
    throw new Error("Invalid GCS object path.");
  }
}

/** Public URL for an in-bucket path. */
export function gcsPublicUrl(path: string): string {
  return `https://${GCS_PUBLIC_HOST}/${GCS_BUCKET_NAME}/${path}`;
}

/** Parse a GCS public URL back to its in-bucket path, or null if it isn't one. */
export function gcsPathFromUrl(url: string): string | null {
  if (!GCS_BUCKET_NAME || !url) return null;
  try {
    const parsed = new URL(url);
    const prefix = `/${GCS_BUCKET_NAME}/`;
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== GCS_PUBLIC_HOST ||
      !parsed.pathname.startsWith(prefix)
    ) {
      return null;
    }
    const path = parsed.pathname.slice(prefix.length);
    return path && !path.split("/").includes("..") ? path : null;
  } catch {
    return null;
  }
}

/**
 * The Cache-Control a public object gets when its writer names none
 * (takedown decision D4; see the header).
 */
export const DEFAULT_PUBLIC_CACHE_CONTROL = "public, max-age=60";

/** What an upload may carry beyond its bytes (takedown design 3.3, 5.7). */
export interface GcsUploadOptions {
  /**
   * Custom metadata stored on the object (string keys and values; the
   * takedown placeholder carries `storemink-takedown=<block id>`). An
   * upload replaces the whole object, so an upload without it leaves none.
   */
  metadata?: Record<string, string>;
  /**
   * The object's live generation must be this one; 0 means the object must
   * not exist (create-only). A mismatch answers 412, which is thrown with
   * `code: 412` for the caller to tell apart.
   */
  ifGenerationMatch?: string | number;
}

/** A generation as Google writes it: a whole number, 0 or more. */
function assertGeneration(generation: string | number): void {
  const valid =
    typeof generation === "number"
      ? Number.isSafeInteger(generation) && generation >= 0
      : /^\d{1,20}$/.test(generation);
  if (!valid) throw new Error("Invalid GCS generation.");
}

const METADATA_MAX_ENTRIES = 16;
const METADATA_KEY_MAX = 128;
const METADATA_VALUE_MAX = 1024;

/** A copy of the custom metadata, refused when a key or value is unusable. */
function checkedMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(metadata);
  if (entries.length > METADATA_MAX_ENTRIES) {
    throw new Error("Invalid GCS object metadata.");
  }
  const copy: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (
      !key.trim() ||
      key.length > METADATA_KEY_MAX ||
      typeof value !== "string" ||
      value.length > METADATA_VALUE_MAX
    ) {
      throw new Error("Invalid GCS object metadata.");
    }
    copy[key] = value;
  }
  return copy;
}

/**
 * The SDK's save options, checked before any bucket is touched: a bad
 * generation or metadata value never reaches Google.
 */
function saveOptions(
  contentType: string,
  cacheControl: string,
  options: GcsUploadOptions,
) {
  const { metadata, ifGenerationMatch } = options;
  if (ifGenerationMatch !== undefined) assertGeneration(ifGenerationMatch);
  const custom = metadata === undefined ? undefined : checkedMetadata(metadata);
  return {
    contentType,
    resumable: false,
    metadata: custom ? { cacheControl, metadata: custom } : { cacheControl },
    ...(ifGenerationMatch === undefined
      ? {}
      : { preconditionOpts: { ifGenerationMatch } }),
  };
}

/**
 * Upload bytes and return the public URL. Object is public via bucket policy.
 * Written `public, max-age=60` unless another Cache-Control is named (D4);
 * `options` adds custom metadata and a generation precondition.
 */
export async function gcsUploadObject(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  cacheControl = DEFAULT_PUBLIC_CACHE_CONTROL,
  options: GcsUploadOptions = {},
): Promise<string> {
  assertObjectPath(path);
  const save = saveOptions(contentType, cacheControl, options);
  const b = await bucket();
  await b.file(path).save(Buffer.from(bytes), save);
  return gcsPublicUrl(path);
}

/**
 * Store bytes in the PRIVATE bucket. Returns nothing a browser could use: the
 * object is reachable only through a route that checks who is asking.
 * `options` as for `gcsUploadObject` (the takedown archive writes create-only,
 * `ifGenerationMatch: 0`).
 */
export async function gcsPrivateUploadObject(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  options: GcsUploadOptions = {},
): Promise<void> {
  assertObjectPath(path);
  const save = saveOptions(contentType, "private, max-age=0", options);
  const b = await privateBucket();
  await b.file(path).save(Buffer.from(bytes), save);
}

/** An object's size and stored type, or null when it does not exist. */
export async function gcsObjectInfo(
  kind: GcsBucketKind,
  path: string,
): Promise<{ size: number; contentType: string | null } | null> {
  assertObjectPath(path);
  const file = (await bucketFor(kind)).file(path);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size ?? 0);
  return {
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    contentType:
      typeof metadata.contentType === "string" ? metadata.contentType : null,
  };
}

/** The SDK's "no such object" answer: an ApiError whose code is 404. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === 404
  );
}

/**
 * What `gcsObjectMetadata` reports about one object: the shape the takedown
 * design (next-release/takedown.md 5.7, the `lib/storage/gcs.ts` row) and the
 * storage design (5.1) both name, so the two builds share one helper.
 */
export interface GcsObjectMetadata {
  /** Bytes. */
  size: number;
  /** The stored Content-Type, or null when the object has none. */
  contentType: string | null;
  /** Google's base64 MD5 (`md5Hash`); null for a composite object. */
  md5: string | null;
  /** Google's base64 CRC32C. */
  crc32c: string | null;
  /** The live generation, as Google reports it (a decimal string). */
  generation: string | null;
  /** The stored Cache-Control. */
  cacheControl: string | null;
  /** The custom metadata (string values only, as the JSON API stores them). */
  metadata: Record<string, string>;
}

/**
 * An object's size, type, MD5, CRC32C, generation, cache control and custom
 * metadata, or null when the object does not exist (404); any other error is
 * thrown. One metadata read, no `exists()` first: the legacy move of Mink
 * attachments (lib/mink/attachments-legacy.ts) reads the source's metadata to
 * decide "missing" and to check its copy against the source's size and MD5;
 * the takedown build reads the generation to pin its archive copy and the
 * custom metadata to recognise its own placeholders.
 */
export async function gcsObjectMetadata(
  kind: GcsBucketKind,
  path: string,
): Promise<GcsObjectMetadata | null> {
  assertObjectPath(path);
  const file = (await bucketFor(kind)).file(path);
  let metadata: {
    size?: unknown;
    contentType?: unknown;
    md5Hash?: unknown;
    crc32c?: unknown;
    generation?: unknown;
    cacheControl?: unknown;
    metadata?: unknown;
  };
  try {
    [metadata] = await file.getMetadata();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const size = Number(metadata.size ?? 0);
  const text = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  const generation =
    typeof metadata.generation === "string" ||
    typeof metadata.generation === "number"
      ? String(metadata.generation)
      : null;
  const custom: Record<string, string> = {};
  if (metadata.metadata && typeof metadata.metadata === "object") {
    for (const [key, value] of Object.entries(metadata.metadata)) {
      if (typeof value === "string") custom[key] = value;
    }
  }
  return {
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    contentType: text(metadata.contentType),
    md5: text(metadata.md5Hash),
    crc32c: text(metadata.crc32c),
    generation,
    cacheControl: text(metadata.cacheControl),
    metadata: custom,
  };
}

/** The generation preconditions a copy may carry (takedown design 5.3). */
export interface GcsCopyPreconditions {
  /**
   * Copy exactly this generation of the source. ★ The SDK's copy() passes no
   * `ifSourceGenerationMatch` query parameter (@google-cloud/storage 7.22),
   * so the source is opened at that generation and Google copies it
   * (`sourceGeneration`): a source replaced since is not copied (404 on a
   * bucket without object versioning). The effect the takedown design asks
   * for, "copy exactly that generation".
   */
  ifSourceGenerationMatch?: string | number;
  /**
   * The target's live generation must be this one; 0 means the target must
   * not exist (create-only). A target that does not match answers 412, which
   * is thrown with `code: 412` for the caller to tell apart.
   */
  ifGenerationMatch?: string | number;
}

/**
 * Copy one object to another path, in the same bucket or across the two,
 * server-side (the bytes never pass through this process). The caller has
 * already decided both paths are its own; `assertObjectPath` guards both.
 * Without `ifGenerationMatch` it overwrites a target that exists, as the SDK
 * does.
 */
export async function gcsCopyObject(
  fromKind: GcsBucketKind,
  fromPath: string,
  toKind: GcsBucketKind,
  toPath: string,
  preconditions: GcsCopyPreconditions = {},
): Promise<void> {
  assertObjectPath(fromPath);
  assertObjectPath(toPath);
  const { ifSourceGenerationMatch, ifGenerationMatch } = preconditions;
  const sourceBucket = await bucketFor(fromKind);
  const source =
    ifSourceGenerationMatch === undefined
      ? sourceBucket.file(fromPath)
      : sourceBucket.file(fromPath, { generation: ifSourceGenerationMatch });
  const target = (await bucketFor(toKind)).file(toPath);
  if (ifGenerationMatch === undefined) {
    await source.copy(target);
  } else {
    await source.copy(target, { preconditionOpts: { ifGenerationMatch } });
  }
}

/**
 * Delete exactly one generation of an object (takedown design 3.3 step 5):
 * the live one, or an older one a versioned bucket keeps. "missing" when
 * that generation does not exist (404), which callers treat as done; any
 * other error is thrown as the SDK raised it (a 412 keeps `code: 412`) for
 * the caller to record. Never touches another generation.
 */
export async function gcsDeleteGeneration(
  kind: GcsBucketKind,
  path: string,
  generation: string | number,
): Promise<"deleted" | "missing"> {
  assertObjectPath(path);
  assertGeneration(generation);
  const file = (await bucketFor(kind)).file(path, { generation });
  try {
    await file.delete();
  } catch (err) {
    if (isNotFound(err)) return "missing";
    throw err;
  }
  return "deleted";
}

/**
 * Stream an object, or the inclusive byte range [start, end] of it (an audio
 * element asks for ranges, and Safari will not play a voice note without
 * them). The caller has already checked who may read it.
 */
export async function gcsObjectStream(
  kind: GcsBucketKind,
  path: string,
  range?: { start: number; end: number },
): Promise<Readable> {
  assertObjectPath(path);
  const file = (await bucketFor(kind)).file(path);
  return file.createReadStream(
    range ? { start: range.start, end: range.end, validation: false } : {},
  );
}

/**
 * Read one object from the configured bucket with a hard memory ceiling.
 *
 * Server-side image preparation uses this instead of `fetch(publicUrl)`: the
 * caller has already resolved an exact tenant-owned GCS path, and reading via
 * the authenticated bucket client avoids turning a public URL into an SSRF
 * surface. The metadata check prevents an unexpectedly large legacy object
 * from being buffered before the caller can reject it.
 */
export async function gcsDownloadObject(
  path: string,
  maxBytes: number,
  kind: GcsBucketKind = "public",
): Promise<Uint8Array> {
  assertObjectPath(path);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Invalid GCS download limit.");
  }
  const file = (await bucketFor(kind)).file(path);
  const [metadata] = await file.getMetadata();
  const declaredSize = Number(metadata.size ?? 0);
  if (!Number.isFinite(declaredSize) || declaredSize < 1) {
    throw new Error("The image object is empty.");
  }
  if (declaredSize > maxBytes) {
    throw new Error("The image object is too large to prepare safely.");
  }
  const [downloaded] = await file.download();
  if (!downloaded.length || downloaded.length > maxBytes) {
    throw new Error("The downloaded image exceeded its safe size limit.");
  }
  return new Uint8Array(downloaded);
}

/**
 * Mint a one-time v4 signed URL the client can PUT a video to directly (Cloud
 * Run's 32 MiB request cap makes proxying large files impossible). The signed URL
 * binds the content type, so the client MUST send the same Content-Type header.
 */
export async function gcsSignUploadUrl(
  path: string,
  contentType: string,
): Promise<string> {
  const b = await bucket();
  const [url] = await b.file(path).getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 10 * 60 * 1000, // 10 minutes
    contentType,
  });
  return url;
}

/** Best-effort delete of in-bucket paths. Returns paths that could not be removed. */
export async function gcsDeletePaths(
  paths: string[],
  kind: GcsBucketKind = "public",
): Promise<string[]> {
  if (paths.length === 0) return [];
  const failed: string[] = [];
  try {
    const b = await bucketFor(kind);
    await Promise.all(
      paths.map((p) =>
        b
          .file(p)
          .delete({ ignoreNotFound: true })
          .catch((err) => {
            failed.push(p);
            logError("gcs: delete failed", err, { path: p });
          }),
      ),
    );
  } catch (err) {
    logError("gcs: delete batch failed", err);
    return [...paths];
  }
  return failed;
}

/**
 * List up to `maxResults` objects below a prefix, with their creation times
 * (one call, no paging). An empty prefix is refused before GCS is touched, so
 * a caller can never list a whole bucket by accident.
 */
export async function gcsListObjects(
  kind: GcsBucketKind,
  prefix: string,
  maxResults: number,
): Promise<{ name: string; createdAt: number | null }[]> {
  if (!prefix.trim()) {
    throw new Error("Refusing to list an empty prefix.");
  }
  const b = await bucketFor(kind);
  const [files] = await b.getFiles({
    prefix,
    maxResults,
    autoPaginate: false,
  });
  return files.map((file) => ({
    name: file.name,
    createdAt: Date.parse(String(file.metadata?.timeCreated ?? "")) || null,
  }));
}

/**
 * Best-effort removal of every object below a tenant prefix, including uploads
 * that never made it into a database row. An empty prefix is rejected so a
 * caller can never accidentally target the whole bucket.
 */
export async function gcsDeletePrefix(
  prefix: string,
  kind: GcsBucketKind = "public",
): Promise<{ deleted: number; failed: number; error?: string }> {
  if (!prefix.trim()) {
    return {
      deleted: 0,
      failed: 0,
      error: "Refusing to delete an empty prefix.",
    };
  }
  try {
    const b = await bucketFor(kind);
    const [files] = await b.getFiles({ prefix });
    const failed = await gcsDeletePaths(
      files.map((file) => file.name),
      kind,
    );
    return { deleted: files.length - failed.length, failed: failed.length };
  } catch (err) {
    logError("gcs: delete prefix failed", err, { prefix });
    return {
      deleted: 0,
      failed: 0,
      error: err instanceof Error ? err.message : "GCS prefix deletion failed",
    };
  }
}
