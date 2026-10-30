import "server-only";

/**
 * The one way to write a public object for a store (takedown design 5.7,
 * plan A4 and A8): every write under `stores/<store id>/` or
 * `theme-releases/` goes through `writeStoreObject`, which hashes the bytes
 * (MD5, base64) and asks the re-upload guard first, so bytes StoreMink has
 * blocked can never be put back by any StoreMink tool. Only then does it call
 * `gcsUploadObject`, with the cache control it was given (default
 * `DEFAULT_PUBLIC_CACHE_CONTROL`, `public, max-age=60`, decision D4).
 *
 * It refuses, with a plain Error and before anything is read or written:
 * a path outside those two roots, a path with an empty, `.` or `..` segment
 * or a backslash, a store path whose store is not the one named, and a
 * theme release path given a store. A refused upload throws
 * `BlockedUploadError` (lib/moderation/upload-guard.ts) and writes nothing.
 *
 * It answers the object's public URL, as `gcsUploadObject` does. The guard
 * may read the database and records a refusal in its own scope, so this must
 * never be called inside another scope's callback (CODEBASE §5 item 2).
 */

import { createHash } from "node:crypto";
import { assertUploadAllowed } from "@/lib/moderation/upload-guard";
import {
  DEFAULT_PUBLIC_CACHE_CONTROL,
  gcsUploadObject,
  type GcsUploadOptions,
} from "./gcs";
import { THEME_RELEASE_OBJECT_ROOT } from "./paths";

const STORE_ROOT = "stores/";

export type StoreObjectOptions = {
  /** The store the object belongs to; null only for a theme release. */
  storeId: string | null;
  /** Cache-Control for the object; `public, max-age=60` when not given. */
  cacheControl?: string;
  /** Custom metadata stored with the object. */
  metadata?: Record<string, string>;
  /** Which tool is writing, for the refusal's record. */
  via?: string;
  /** Who is uploading (an admin's id or email), for the refusal's record. */
  actor?: string | null;
};

/** Why a path is not one `writeStoreObject` may write, or null. */
export function storeObjectPathProblem(
  path: unknown,
  storeId: string | null,
): string | null {
  if (typeof path !== "string" || !path) return "the path is empty";
  if (path.startsWith("/")) return "the path starts with a slash";
  if (path.includes("\\")) return "the path holds a backslash";
  const segments = path.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return "the path has an empty, '.' or '..' segment";
  }
  if (path.startsWith(STORE_ROOT)) {
    if (segments.length < 3) return "the store path names no object";
    if (!storeId) return "a store path needs its store";
    if (segments[1].toLowerCase() !== storeId.toLowerCase()) {
      return "the path belongs to another store";
    }
    return null;
  }
  if (path.startsWith(THEME_RELEASE_OBJECT_ROOT)) {
    if (segments.length < 2) return "the theme release path names no object";
    if (storeId) return "a theme release path belongs to no store";
    return null;
  }
  return "the path is outside stores/ and theme-releases/";
}

/** The bytes' MD5, base64 (Google's `md5Hash` form). */
export function md5Base64Of(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

/**
 * Write a public object for a store (module comment): the path check, the
 * re-upload guard, then the upload. Answers the public URL.
 */
export async function writeStoreObject(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  options: StoreObjectOptions,
): Promise<string> {
  const storeId = options.storeId ?? null;
  const problem = storeObjectPathProblem(path, storeId);
  if (problem) throw new Error(`writeStoreObject: ${problem}.`);

  await assertUploadAllowed({
    storeId,
    md5Base64: md5Base64Of(bytes),
    path,
    via: options.via?.trim() ? options.via.trim() : "store_object",
    contentType,
    actor: options.actor,
  });

  const uploadOptions: GcsUploadOptions = options.metadata
    ? { metadata: options.metadata }
    : {};
  return gcsUploadObject(
    path,
    bytes,
    contentType,
    options.cacheControl ?? DEFAULT_PUBLIC_CACHE_CONTROL,
    uploadOptions,
  );
}
