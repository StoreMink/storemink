"use server";

import { and, asc, eq } from "drizzle-orm";
import { withAnon } from "@/lib/db/client";
import { categories, productVariants, products } from "@/drizzle/schema";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { isStorefrontGated } from "@/lib/store/launch-state";
import { storefrontAccess } from "@/lib/store/storefront-access";
import { maskBlockedMedia } from "@/lib/moderation/blocked-objects";
import { normalizeOptions, type ProductOption } from "@/lib/products/options";
import { productGallery } from "@/lib/products/gallery";
import { productExcerpt } from "@/lib/products/excerpt";

// ---------------------------------------------------------------------------
// The one product a card's "+ Add" needs when it has variants: its option
// axes and every variant's price and stock, loaded when the shopper taps the
// button rather than shipped with every card in the grid.
//
// ★ Everything returned is what the public product page already shows — a
//   published product of the HOST's store, read under the anonymous role —
//   so this grants nothing the storefront does not. The store is never an
//   argument: it comes from the request host, and a product id from another
//   store simply finds nothing.
// ★ Prices here only PREVIEW. The cart re-prices every line on the server at
//   checkout (placeOrder), so a stale number costs a wrong label, never a
//   wrong charge.
// ★★ THE ANSWER IS MASKED (takedown; PR #303 review, 22 Nov 2026). A file
//   StoreMink has blocked is hidden by the page swap, not by row security: a
//   published product keeps its row while one of its photos is blocked. The
//   answer carries the primary photo, the gallery, every variant's photos and
//   the colour photos inside `options`, and it went out unmasked, so a
//   blocked file's real address reached the shopper and was copied into the
//   cart line. `maskBlockedMedia` runs after the database scope closes, as
//   for every other storefront reader (lib/moderation/mask-coverage.test.ts
//   lists this module).
// ★ A store that has not opened answers nothing without its password, like
//   /api/storefront/products: a product id must not read an unopened store's
//   prices and stock.
// ---------------------------------------------------------------------------

export interface QuickAddVariant {
  id: string;
  name: string;
  base_price: number;
  selling_price: number;
  special_price: number | null;
  images: string[] | null;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  option_values: string[];
}

export interface QuickAddProduct {
  id: string;
  slug: string;
  name: string;
  image_url: string | null;
  category: string | null;
  options: ProductOption[];
  variants: QuickAddVariant[];
}

/**
 * What the quick view shows (the eye on a product card): the chooser's
 * product plus its photographs, the first lines of its description and, for
 * a product sold without variants, its own price and stock. Still nothing
 * the public product page does not show.
 */
export interface QuickViewProduct extends QuickAddProduct {
  /** Every distinct photograph, primary first (lib/products/gallery.ts). */
  gallery: string[];
  /** The first lines of the description, plain text, or null. */
  excerpt: string | null;
  base_price: number;
  selling_price: number;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getQuickAddProduct(
  productId: string,
): Promise<QuickAddProduct | null> {
  const product = await getQuickViewProduct(productId);
  if (!product) return null;
  // The chooser's own shape: it has no use for the rest, so none is sent.
  const { id, slug, name, image_url, category, options, variants } = product;
  return { id, slug, name, image_url, category, options, variants };
}

export async function getQuickViewProduct(
  productId: string,
): Promise<QuickViewProduct | null> {
  if (typeof productId !== "string" || !UUID.test(productId)) return null;
  const store = await getCurrentStoreOrNull();
  if (!store) return null;
  if (
    isStorefrontGated(store) &&
    (await storefrontAccess(store)) === "locked"
  ) {
    return null;
  }

  try {
    const product = await withAnon(async (db) => {
      const rows = await db
        .select({
          id: products.id,
          slug: products.slug,
          name: products.name,
          image_url: products.imageUrl,
          images: products.images,
          description: products.description,
          base_price: products.basePrice,
          selling_price: products.sellingPrice,
          track_inventory: products.trackInventory,
          stock: products.onlineStock,
          low_stock_threshold: products.lowStockThreshold,
          allow_backorder: products.allowBackorder,
          options: products.options,
          category: categories.name,
        })
        .from(products)
        .leftJoin(categories, eq(products.categoryId, categories.id))
        .where(
          and(
            eq(products.storeId, store.id),
            eq(products.id, productId),
            eq(products.status, "published"),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;

      const variants = await db
        .select({
          id: productVariants.id,
          name: productVariants.name,
          base_price: productVariants.basePrice,
          selling_price: productVariants.sellingPrice,
          special_price: productVariants.specialPrice,
          images: productVariants.images,
          track_inventory: productVariants.trackInventory,
          stock: productVariants.onlineStock,
          low_stock_threshold: productVariants.lowStockThreshold,
          allow_backorder: productVariants.allowBackorder,
          option_values: productVariants.optionValues,
        })
        .from(productVariants)
        .where(eq(productVariants.productId, row.id))
        .orderBy(asc(productVariants.sortOrder));

      const normalized = normalizeOptions(row.options);
      const { images, description, ...fields } = row;
      return {
        ...fields,
        gallery: productGallery(row.image_url, images),
        excerpt: productExcerpt(description),
        options: "options" in normalized ? normalized.options : [],
        variants,
      };
    });
    return product ? await maskBlockedMedia(product) : null;
  } catch (err) {
    console.error(
      "getQuickViewProduct:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
