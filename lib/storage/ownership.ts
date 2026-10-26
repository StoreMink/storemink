import { gcsPathFromUrl } from "@/lib/storage/gcs";
import { isStoreOwnedObjectPath } from "@/lib/storage/paths";

// Which image URLs a store may put on its own rows.
//
// ★★ THE DANGEROUS SET IS "IN OUR BUCKET, OUTSIDE THIS STORE", and it is
//    narrower than either obvious rule. The media bucket is shared by every
//    store, so an in-bucket URL is not ownership; but a URL outside the bucket
//    is harmless here, because `deleteStorageUrls` cannot resolve it to a path
//    and already treats it as unmanaged. Refusing everything external would
//    only break older media hosted outside our bucket that rows still use.
//
// ★ WHY A WRITE IS GUARDED AT ALL, when the sweep is scoped too: the sweep's
//   scope protects the OTHER store's file, and this protects the merchant
//   doing the writing - a row pointing at somebody else's object renders an
//   image they do not control on their own storefront, and stops rendering
//   whenever that merchant deletes it.

/**
 * The bucket object `url` names when it is provably this store's, else null.
 * What a server-side photo tool (Refine, background removal) may download and
 * work on: a path traversal or another store's object is refused outright.
 */
export function ownedObjectPath(url: string, storeId: string): string | null {
  const path = gcsPathFromUrl(url);
  if (!path || path.split("/").includes("..")) return null;
  return isStoreOwnedObjectPath(path, storeId) ? path : null;
}

/** True when `url` is one of our bucket's objects but not under this store. */
export function isForeignStoreImageUrl(storeId: string, url: string): boolean {
  const trimmed = (url ?? "").trim();
  if (!trimmed || !storeId) return false;
  const path = gcsPathFromUrl(trimmed);
  return path !== null && !isStoreOwnedObjectPath(path, storeId);
}

/**
 * The first URL in `urls` that this store cannot be shown to own, or null.
 *
 * ★ `skip` IS THE "ALREADY STORED" EXEMPTION every caller needs. Objects
 *   uploaded before 2026-08-23 have no store prefix, so a value already on the
 *   row cannot be proven ours and re-judging it would make an existing product
 *   or category uneditable over an image nobody is touching. Only what a save
 *   ADDS is held to the rule.
 */
export function firstForeignStoreImageUrl(
  storeId: string,
  urls: readonly (string | null | undefined)[],
  skip?: ReadonlySet<string>,
): string | null {
  for (const url of urls) {
    if (!url) continue;
    const trimmed = url.trim();
    if (!trimmed || skip?.has(trimmed)) continue;
    if (isForeignStoreImageUrl(storeId, trimmed)) return trimmed;
  }
  return null;
}

/** The one sentence every surface shows for a refused image. */
export const FOREIGN_IMAGE_ERROR =
  "That image is not one of this store's own images. Upload it, or pick it from this store's Media Library.";
