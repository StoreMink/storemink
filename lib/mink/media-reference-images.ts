import "server-only";

import { sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { withService } from "@/lib/db/client";
import { GCS_BUCKET_NAME, gcsPathFromUrl } from "@/lib/storage/gcs";
import { minkAttachmentIdOf } from "./attachment-ref";
import {
  readMinkAttachmentReferences,
  type MinkAttachmentReference,
} from "./attachments";
import { MinkToolInputError } from "./errors";
import { selectBlockedImageUrls } from "./storefront-media-read";
import type { MinkActorContext } from "./types";

export type MinkMediaReferenceSource =
  | "product"
  | "category"
  | "media"
  | "attachment";

export interface MinkMediaReferenceImage {
  url: string;
  /**
   * The object in StoreMink's media bucket as Vertex reads it (`gs://`): a
   * product, category or Media Library image. Absent for an attachment.
   */
  fileUri?: string;
  /**
   * The private bytes of a picture attached in this chat, base64, for
   * Vertex's inline part (lib/mink/attachments.ts). ★ Never a public URL:
   * an attachment is kept privately, so it reaches the image model only as
   * bytes read through the server. Absent for a store image.
   */
  inlineData?: MinkAttachmentReference["inlineData"];
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  source: MinkMediaReferenceSource;
}

type ReferenceRow = {
  url: string;
  source: Exclude<MinkMediaReferenceSource, "attachment">;
  content_type: string | null;
};

/**
 * Resolve model-selected reference URLs back to current-store records.
 *
 * The model may repeat only exact URLs returned by a permission-filtered read
 * tool, or the address of a picture the merchant attached in this chat. This
 * lookup is the real authority boundary: it rechecks the tenant and the
 * actor's permission for the source collection, then converts only objects
 * in StoreMink's configured GCS bucket to Vertex-readable `gs://` references.
 * An attachment address is taken out of the list first and read through the
 * server as the attacher's own private bytes (`readMinkAttachmentReferences`,
 * which refuses anything that is not this admin's); the answers are merged
 * back in the caller's order, so the product photo stays first. No arbitrary
 * URL is fetched by StoreMink or handed to the image model.
 *
 * ★ A file StoreMink blocked (told or not) is never sent as a reference, in
 *   the same words as one no collection returned, so nothing hints at a
 *   block kept from the store (D21). Read on the lookup's own connection,
 *   the way `selectOwnedStorefrontImageUrls` skips one.
 */
export async function resolveMinkMediaReferenceImages(
  actor: MinkActorContext,
  urls: readonly string[],
): Promise<MinkMediaReferenceImage[]> {
  if (urls.length === 0) return [];

  const attachmentUrls: string[] = [];
  const storeUrls: string[] = [];
  for (const url of urls) {
    (minkAttachmentIdOf(url) ? attachmentUrls : storeUrls).push(url);
  }

  // The store lookup first: one cheap query, and a URL no collection
  // returned is refused before any attachment bytes are downloaded.
  const stored = await resolveStoreReferences(actor, storeUrls);

  // Its own scope, after the query's has closed (never nested inside it:
  // lib/db/nested-scope-coverage.test.ts). The read binds the attacher, so
  // it needs no permission check of its own.
  const attached = new Map<string, MinkMediaReferenceImage>();
  if (attachmentUrls.length > 0) {
    const references = await readMinkAttachmentReferences(actor, [
      ...new Set(attachmentUrls),
    ]);
    for (const reference of references) {
      attached.set(reference.url, {
        url: reference.url,
        inlineData: reference.inlineData,
        mimeType: reference.mimeType,
        source: "attachment",
      });
    }
  }

  return urls.map((url) => {
    const reference = attached.get(url) ?? stored.get(url);
    if (!reference) {
      // Cannot happen: every store URL is checked above and every attachment
      // address is answered or refused by the reader. Kept as a refusal rather
      // than a hole in the list the model asked for.
      throw new MinkToolInputError(
        "Every reference image must be an exact, accessible URL returned by the current store's product, category, or Media Library tools.",
      );
    }
    return reference;
  });
}

async function resolveStoreReferences(
  actor: MinkActorContext,
  urls: readonly string[],
): Promise<Map<string, MinkMediaReferenceImage>> {
  const resolved = new Map<string, MinkMediaReferenceImage>();
  if (urls.length === 0) return resolved;

  const mediaAllowed = can(
    actor.permissions,
    "media",
    "view",
    actor.isSuperadmin,
  );
  const productsAllowed = can(
    actor.permissions,
    "products",
    "view",
    actor.isSuperadmin,
  );
  const categoriesAllowed = can(
    actor.permissions,
    "categories",
    "view",
    actor.isSuperadmin,
  );

  const { rows, blocked } = await withService(async (db) => {
    const result = await db.execute(sql`
      select distinct on (reference.url)
        reference.url,
        reference.source,
        reference.content_type
      from (
        select
          media.url,
          'media'::text as source,
          media.content_type,
          3 as source_rank
        from media_assets media
        where ${mediaAllowed}
          and media.store_id = ${actor.storeId}
          and media.url = any(${sql.param(urls)}::text[])

        union all

        select
          product.image_url as url,
          'product'::text as source,
          null::text as content_type,
          1 as source_rank
        from products product
        where ${productsAllowed}
          and product.store_id = ${actor.storeId}
          and product.image_url = any(${sql.param(urls)}::text[])

        union all

        select
          product_image.url,
          'product'::text as source,
          null::text as content_type,
          1 as source_rank
        from products product
        cross join lateral unnest(product.images) as product_image(url)
        where ${productsAllowed}
          and product.store_id = ${actor.storeId}
          and product_image.url = any(${sql.param(urls)}::text[])

        union all

        select
          category.image_url as url,
          'category'::text as source,
          null::text as content_type,
          2 as source_rank
        from categories category
        where ${categoriesAllowed}
          and category.store_id = ${actor.storeId}
          and category.image_url = any(${sql.param(urls)}::text[])
      ) reference
      order by reference.url, reference.source_rank
    `);
    // Same connection, no scope of its own (never nested: the
    // nested-scope rule); costs no statement when no address is a media one.
    return {
      rows: result.rows as ReferenceRow[],
      blocked: await selectBlockedImageUrls(db, urls),
    };
  });
  const byUrl = new Map(
    rows.filter((row) => !blocked.has(row.url)).map((row) => [row.url, row]),
  );

  for (const url of urls) {
    if (resolved.has(url)) continue;
    const row = byUrl.get(url);
    if (!row) {
      throw new MinkToolInputError(
        "Every reference image must be an exact, accessible URL returned by the current store's product, category, or Media Library tools.",
      );
    }
    const path = gcsPathFromUrl(url);
    const mimeType = referenceMimeType(row.content_type, url);
    if (!path || !GCS_BUCKET_NAME || !mimeType) {
      throw new MinkToolInputError(
        "A selected reference image is not a supported StoreMink PNG, JPEG, or WebP object. Choose another current-store image.",
      );
    }
    resolved.set(url, {
      url,
      fileUri: `gs://${GCS_BUCKET_NAME}/${path}`,
      mimeType,
      source: row.source,
    });
  }
  return resolved;
}

function referenceMimeType(
  contentType: string | null,
  url: string,
): MinkMediaReferenceImage["mimeType"] | null {
  if (
    contentType === "image/jpeg" ||
    contentType === "image/png" ||
    contentType === "image/webp"
  ) {
    return contentType;
  }
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\.jpe?g$/.test(pathname)) return "image/jpeg";
  if (/\.png$/.test(pathname)) return "image/png";
  if (/\.webp$/.test(pathname)) return "image/webp";
  return null;
}
