// Google Cloud Storage backend for media (GCP migration Phase 3 — see
// docs/gcp-migration-phase5-6.md and CODEBASE.md §7).
//
// GCS is the media backend (GCS_BUCKET required — the Supabase Storage fallback
// was removed). Auth is Application Default Credentials (ADC) — automatic on Cloud Run's default
// service account, local dev via `gcloud auth application-default login`. An
// optional base64 service-account JSON (GCP_SA_KEY) is honoured for hosts
// without ADC (e.g. Vercel) and is REQUIRED to sign video upload URLs off
// Cloud Run (user ADC can't sign; Cloud Run signs via IAM SignBlob).
//
// Server-only (the @google-cloud/storage SDK is Node-only). Objects are served
// from a PUBLIC bucket (uniform bucket-level access + allUsers:objectViewer),
// so the public URL is a plain https://storage.googleapis.com/<bucket>/<path>.
//
// ★★ AND objectViewer INCLUDES `storage.objects.list`: anyone can list the
// public bucket without credentials, so an unguessable path is not privacy.
// Anything that is not meant for the public (WhatsApp chat photos, voice
// notes and PDFs) goes in the PRIVATE bucket below (GCS_PRIVATE_BUCKET: no
// public access, public access prevention enforced), read only through an
// authenticated route that streams it. There is deliberately no fallback to
// the public bucket when the private one is not configured.

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

/** Upload bytes and return the public URL. Object is public via bucket policy. */
export async function gcsUploadObject(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  cacheControl = "public, max-age=3600",
): Promise<string> {
  const b = await bucket();
  await b.file(path).save(Buffer.from(bytes), {
    contentType,
    resumable: false,
    metadata: { cacheControl },
  });
  return gcsPublicUrl(path);
}

/**
 * Store bytes in the PRIVATE bucket. Returns nothing a browser could use: the
 * object is reachable only through a route that checks who is asking.
 */
export async function gcsPrivateUploadObject(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  assertObjectPath(path);
  const b = await privateBucket();
  await b.file(path).save(Buffer.from(bytes), {
    contentType,
    resumable: false,
    metadata: { cacheControl: "private, max-age=0" },
  });
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
): Promise<Uint8Array> {
  assertObjectPath(path);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Invalid GCS download limit.");
  }
  const file = (await bucket()).file(path);
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
 * Mint a one-time v4 signed URL the client can PUT a video to directly (the
 * serverless body cap makes proxying large files impossible). The signed URL
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
