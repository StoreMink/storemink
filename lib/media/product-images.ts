import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import type { ProductImageItem, ProductRef } from "./library-types";

// Which photos a store's products use, read straight from the product rows.
//
// ★ DERIVED, NEVER COPIED. A product photo uploaded in the product editor has
//   no media_assets row, and giving it one would mean a backfill plus keeping
//   two records in step on every save, CSV import and Mink action. Reading the
//   products themselves is always right, including for photos added before
//   this existed.
//
// ★ EVERY PLACE A PRODUCT KEEPS A PHOTO: its primary image, its gallery, each
//   variant's photos, and the photos per colour on its options. Missing one
//   would let the clean-up below delete a colour photo a product still shows.
//
// Every read runs under withService with an explicit store predicate; the
// store id always comes from the server, never the browser.

/** Every (product, url) pair for one store, empty urls removed. */
function productImageRefs(storeId: string): SQL {
  return sql`
    select refs.product_id, refs.product_name, refs.product_updated_at, refs.url
    from (
      select p.id as product_id, p.name as product_name,
             p.updated_at as product_updated_at, own.url
      from public.products p
      cross join lateral (
        select p.image_url as url
        union all
        select unnest(p.images)
      ) own
      where p.store_id = ${storeId}

      union all

      select p.id, p.name, p.updated_at, variant_photo.url
      from public.product_variants v
      join public.products p on p.id = v.product_id
      cross join lateral (
        select v.image_url as url
        union all
        select unnest(v.images)
      ) variant_photo
      where p.store_id = ${storeId}

      union all

      select p.id, p.name, p.updated_at, colour_photo.url
      from public.products p
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(p.options) = 'array' then p.options else '[]'::jsonb end
      ) opt
      cross join lateral jsonb_each(
        case when jsonb_typeof(opt -> 'images') = 'object'
             then opt -> 'images' else '{}'::jsonb end
      ) by_value(value_name, photos)
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(by_value.photos) = 'array'
             then by_value.photos else '[]'::jsonb end
      ) colour_photo(url)
      where p.store_id = ${storeId}
    ) refs
    where refs.url is not null and btrim(refs.url) <> ''
  `;
}

function readProducts(value: unknown): ProductRef[] {
  if (!Array.isArray(value)) return [];
  const out: ProductRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== "string") continue;
    out.push({ id, name: typeof name === "string" ? name : "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One page of the photos a store's products use, most recently edited product
 * first. Throws on a read failure, so the page can say so rather than show an
 * empty tab as though the store had no photos.
 */
export async function listProductImages(
  storeId: string,
  { page, pageSize }: { page: number; pageSize: number },
): Promise<{ items: ProductImageItem[]; total: number }> {
  const offset = Math.max(0, (page - 1) * pageSize);
  return withService(async (db) => {
    const counted = await db.execute(sql`
      select count(distinct refs.url)::int as total
      from (${productImageRefs(storeId)}) refs
    `);
    const total = Number(
      (counted.rows[0] as { total?: number } | undefined)?.total ?? 0,
    );
    if (total === 0) return { items: [], total: 0 };

    const rows = await db.execute(sql`
      select refs.url,
             max(refs.product_updated_at) as last_used,
             jsonb_agg(distinct jsonb_build_object(
               'id', refs.product_id, 'name', refs.product_name
             )) as products
      from (${productImageRefs(storeId)}) refs
      group by refs.url
      order by last_used desc, refs.url
      limit ${pageSize} offset ${offset}
    `);
    const items = (rows.rows as { url: string; products: unknown }[]).map(
      (row) => ({ url: row.url, products: readProducts(row.products) }),
    );
    return { items, total };
  });
}

/** How many different photos the store's products use. */
export async function countProductImages(storeId: string): Promise<number> {
  const counted = await withService((db) =>
    db.execute(sql`
      select count(distinct refs.url)::int as total
      from (${productImageRefs(storeId)}) refs
    `),
  );
  return Number(
    (counted.rows[0] as { total?: number } | undefined)?.total ?? 0,
  );
}

/**
 * Which of `urls` this store's products use, and which products use them.
 * Throws on a read failure: every caller has to decide what "we could not
 * tell" means for it, and none of them may treat it as "nothing uses it".
 */
export async function productImageUsage(
  storeId: string,
  urls: readonly string[],
): Promise<Map<string, ProductRef[]>> {
  const wanted = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  const usage = new Map<string, ProductRef[]>();
  if (wanted.length === 0) return usage;
  const rows = await withService((db) =>
    db.execute(sql`
      select refs.url,
             jsonb_agg(distinct jsonb_build_object(
               'id', refs.product_id, 'name', refs.product_name
             )) as products
      from (${productImageRefs(storeId)}) refs
      where refs.url = any(${sql.param(wanted)}::text[])
      group by refs.url
    `),
  );
  for (const row of rows.rows as { url: string; products: unknown }[]) {
    usage.set(row.url, readProducts(row.products));
  }
  return usage;
}

/**
 * Of `urls`, the ones that must NOT be deleted from storage because something
 * still uses them: a Media Library row, or any product, variant or colour
 * photo in the store.
 *
 * ★★ THE PRODUCT CLEAN-UP USED TO ASK ONLY "DOES THIS PRODUCT STILL USE IT".
 *    So removing a photo from one product, or deleting the product, deleted
 *    the file even when the Media Library listed it or another product showed
 *    it, leaving a broken image in both. Mink already put Library images on
 *    products; picking from the library in the product editor makes it the
 *    ordinary case.
 *
 * ★ IT FAILS TOWARD KEEPING. On a read failure every url counts as in use:
 *   an orphaned file costs storage, a deleted one breaks a live storefront.
 *
 * Call it AFTER the save or delete has committed, so the product's own rows
 * already describe what it keeps.
 */
export async function imageUrlsStillInUse(
  storeId: string,
  urls: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  const wanted = [
    ...new Set(
      urls.map((u) => (typeof u === "string" ? u.trim() : "")).filter(Boolean),
    ),
  ];
  if (wanted.length === 0) return new Set();
  try {
    const rows = await withService((db) =>
      db.execute(sql`
        select wanted.url
        from unnest(${sql.param(wanted)}::text[]) as wanted(url)
        where exists (
                select 1 from public.media_assets m
                where m.store_id = ${storeId} and m.url = wanted.url
              )
           or exists (
                select 1 from (${productImageRefs(storeId)}) refs
                where refs.url = wanted.url
              )
      `),
    );
    return new Set((rows.rows as { url: string }[]).map((row) => row.url));
  } catch (error) {
    logError("imageUrlsStillInUse failed; keeping every file", error, {
      storeId,
      count: wanted.length,
    });
    return new Set(wanted);
  }
}

/**
 * The files a product save or delete may remove: what it dropped, less
 * anything the Library or another product still uses. Never throws.
 */
export async function productImagesSafeToDelete(
  storeId: string,
  dropped: readonly (string | null | undefined)[],
): Promise<string[]> {
  const candidates = [
    ...new Set(
      dropped
        .map((u) => (typeof u === "string" ? u.trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (candidates.length === 0) return [];
  const inUse = await imageUrlsStillInUse(storeId, candidates);
  return candidates.filter((url) => !inUse.has(url));
}
