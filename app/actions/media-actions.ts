"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import { mediaAssets } from "@/drizzle/schema";
import {
  getActingStoreId,
  getManagerUserId,
  getViewerAccess,
} from "@/app/dashboard/lib/access";
import {
  gcsConfigured,
  gcsUploadObject,
  gcsPathFromUrl,
  gcsDeletePaths,
} from "@/lib/storage/gcs";
import { processImageUpload } from "@/lib/storage/process-image";
import { listLibraryAssets, MEDIA_ASSET_COLUMNS } from "@/lib/media/library";
import {
  listProductImages,
  productImageUsage,
} from "@/lib/media/product-images";
import {
  MEDIA_PICKER_PAGE_SIZE,
  usedByLabel,
  type MediaAsset,
  type MediaPickerPage,
  type MediaPickerTab,
} from "@/lib/media/library-types";
import { mediaSourceLabel, type MediaSource } from "@/lib/media/sources";

/**
 * Upload one image to the store's media library: validate + optimize (shared
 * with /api/upload), store to GCS under a store-scoped path, and record a
 * media_assets row. Gated on the `media` section. If the DB write fails the
 * just-uploaded object is removed so no orphan is left in the bucket.
 *
 * `purpose: "mink_attachment"` (sent by the Mink chat composer) labels the row
 * so the Library does not list it. It is a display label, not a permission:
 * the gate, the path and the ownership the row proves are identical, and the
 * worst a forged value can do is hide the caller's own upload.
 */
export async function uploadMediaAsset(
  formData: FormData,
): Promise<{ asset?: MediaAsset; error?: string }> {
  const userId = await getManagerUserId("media");
  if (!userId) return { error: "You don't have access to the media library." };
  if (!gcsConfigured) return { error: "Uploads are not configured." };

  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "No file provided." };
  const source: MediaSource =
    formData.get("purpose") === "mink_attachment"
      ? "mink_attachment"
      : "upload";

  const processed = await processImageUpload(file);
  if (!processed.ok) return { error: processed.error };

  const storeId = await getActingStoreId();
  const fileName = `${Math.random().toString(36).slice(2, 12)}_${Date.now()}.${processed.data.ext}`;
  const path = `stores/${storeId}/media/${fileName}`;

  let url: string;
  try {
    url = await gcsUploadObject(
      path,
      processed.data.bytes,
      processed.data.contentType,
    );
  } catch (err) {
    console.error(
      "uploadMediaAsset (GCS):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Upload failed. Please try again." };
  }

  try {
    const [row] = await withService((db) =>
      db
        .insert(mediaAssets)
        .values({
          storeId,
          url,
          path,
          filename: (file.name || "").slice(0, 255),
          contentType: processed.data.contentType,
          sizeBytes: processed.data.bytes.length,
          createdBy: userId,
          source,
        })
        .returning(MEDIA_ASSET_COLUMNS),
    );
    // A chat attachment is not listed, so the Library page has nothing new.
    if (source === "upload") revalidatePath("/dashboard/media");
    return { asset: row as unknown as MediaAsset };
  } catch (err) {
    // Row didn't persist → remove the orphaned object so the bucket stays clean.
    await gcsDeletePaths([path]);
    console.error(
      "uploadMediaAsset (insert):",
      err instanceof Error ? err.message : err,
    );
    return { error: dbErrorMessage(err, "Could not save the upload.") };
  }
}

/**
 * Delete a library item: removes the media_assets row (store-scoped) AND the
 * underlying object from the GCS bucket. Gated on the `media` section.
 *
 * ★★ AN IMAGE A PRODUCT STILL USES IS REFUSED, NAMING THE PRODUCTS. Deleting
 *    the object would leave a broken photo on the storefront, and nothing on
 *    the product would say why. If we cannot tell whether a product uses it,
 *    the delete is refused too: a missing photo cannot be undone, a retry can.
 */
export async function deleteMediaAsset(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const userId = await getManagerUserId("media");
  if (!userId) return { error: "You don't have access to the media library." };
  if (typeof id !== "string" || !id.trim()) return { error: "Invalid item." };

  const storeId = await getActingStoreId();

  // Fetch (store-scoped) to get the bucket path before deleting.
  const rows = await withService((db) =>
    db
      .select({ path: mediaAssets.path, url: mediaAssets.url })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, id), eq(mediaAssets.storeId, storeId)))
      .limit(1),
  ).catch(() => [] as { path: string; url: string }[]);
  const asset = rows[0];
  if (!asset) return { error: "That media item no longer exists." };

  let usedBy: { id: string; name: string }[];
  try {
    usedBy =
      (await productImageUsage(storeId, [asset.url])).get(asset.url) ?? [];
  } catch (err) {
    console.error(
      "deleteMediaAsset (usage):",
      err instanceof Error ? err.message : err,
    );
    return {
      error:
        "Couldn't check whether a product uses this image, so it was not deleted. Please try again.",
    };
  }
  if (usedBy.length > 0) {
    return {
      error: `${usedByLabel(usedBy)} ${usedBy.length === 1 ? "uses" : "use"} this image. Remove it from ${usedBy.length === 1 ? "that product" : "those products"} first.`,
    };
  }

  // DB row is the library's source of truth → delete it first, then best-effort
  // remove the object (gcsDeletePaths never throws).
  try {
    await withService((db) =>
      db
        .delete(mediaAssets)
        .where(and(eq(mediaAssets.id, id), eq(mediaAssets.storeId, storeId))),
    );
  } catch (err) {
    console.error(
      "deleteMediaAsset:",
      err instanceof Error ? err.message : err,
    );
    return { error: dbErrorMessage(err, "Could not delete this item.") };
  }

  const path = asset.path || gcsPathFromUrl(asset.url);
  if (path) await gcsDeletePaths([path]);

  revalidatePath("/dashboard/media");
  return { success: true };
}

/**
 * One page of the product editor's "Choose from library" picker.
 *
 * ★ EACH TAB KEEPS ITS OWN PERMISSION. The Library tab is a `media` read
 *   (file names can name a supplier or an unreleased product, the reason
 *   Mink's own media read is gated the same way); the Product images tab is a
 *   `products` read, which anyone in the product editor already has.
 */
export async function getMediaPickerPage(input: {
  tab: MediaPickerTab;
  page?: number;
}): Promise<MediaPickerPage & { error?: string }> {
  const tab: MediaPickerTab =
    input?.tab === "products" ? "products" : "library";
  const page =
    Number.isInteger(input?.page) && (input.page as number) > 0
      ? Math.min(input.page as number, 10_000)
      : 1;
  const pageSize = MEDIA_PICKER_PAGE_SIZE;
  const empty = { items: [], total: 0, page, pageSize };

  const access = await getViewerAccess();
  if (!access)
    return { ...empty, error: "You don't have access to this store." };
  const section = tab === "library" ? "media" : "products";
  if (!access.can(section, "view")) {
    return {
      ...empty,
      error:
        tab === "library"
          ? "Your role can't view the Media Library."
          : "Your role can't view products.",
    };
  }

  const storeId = await getActingStoreId();
  try {
    if (tab === "products") {
      const { items, total } = await listProductImages(storeId, {
        page,
        pageSize,
      });
      return {
        items: items.map((item) => ({
          url: item.url,
          filename: "",
          label: null,
          products: item.products,
        })),
        total,
        page,
        pageSize,
      };
    }

    const { assets, total } = await listLibraryAssets(storeId, {
      page,
      pageSize,
    });
    const usage = await productImageUsage(
      storeId,
      assets.map((a) => a.url),
    );
    return {
      items: assets.map((asset) => ({
        url: asset.url,
        filename: asset.filename,
        label: mediaSourceLabel(asset.source),
        products: usage.get(asset.url) ?? [],
      })),
      total,
      page,
      pageSize,
    };
  } catch (err) {
    console.error(
      "getMediaPickerPage:",
      err instanceof Error ? err.message : err,
    );
    return { ...empty, error: "Couldn't load your images. Please try again." };
  }
}
