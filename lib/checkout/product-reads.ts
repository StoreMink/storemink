import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { products } from "@/drizzle/schema";
import type { Db } from "@/lib/db/client";
import { productGallery } from "@/lib/products/gallery";
import { normalizeOptions, photosForVariant } from "@/lib/products/options";

// ---------------------------------------------------------------------------
// The product reads that serve a shopper's order (takedown design 5.7, review
// findings F5 and F26).
//
// ★ SERVICE SCOPE, SO THE FLAG IS IN THE QUERY. These run under `withService`
// (RLS bypassed: stock is already public, and the order write needs the
// service role anyway), so the read policies that hide a product StoreMink
// blocked never see them. Each read therefore carries the store AND
// `moderation_blocked_at is null` itself: a blocked product leaves the cart at
// the checkout's stock check, `placeOrder` refuses it with its existing
// "Product no longer available: {name}", and a blocked free gift is dropped by
// the existing vanished-gift branch. Blocked products only (decision D17): a
// draft keeps today's behaviour, and the POS reads its own products
// (`app/actions/pos-sale-actions.ts`, decision D18).
//
// ★ THEY TAKE `db`, so each caller keeps its own scope (never one opened
// inside another), and `lib/moderation/shopper-reads.local.test.ts` runs them
// against real blocked rows: the shared db mock returns its queued rows
// whatever the WHERE clause says, so only a real database can show the filter
// works.
// ---------------------------------------------------------------------------

/** Snake-case aliases, the row shape `placeOrder` and `getCartStock` read. */
const CART_PRODUCT_COLUMNS = {
  id: products.id,
  name: products.name,
  selling_price: products.sellingPrice,
  cost_price: products.costPrice,
  store_id: products.storeId,
  tax_class_id: products.taxClassId,
  // Routing only: a location cannot be disqualified by a SKU that has no
  // stock to run out of (roadmap Phase D). The checkout's stock check reads
  // the same three.
  track_inventory: products.trackInventory,
  stock: products.stock,
  allow_backorder: products.allowBackorder,
  sku: products.sku,
  hsn_code: products.hsnCode,
  requires_shipping: products.requiresShipping,
  weight_grams: products.weightGrams,
  length_cm: products.lengthCm,
  width_cm: products.widthCm,
  height_cm: products.heightCm,
  // Offer scoping (docs/offers-plan.md). Selected here rather than in a
  // second read: the offer engine needs it for every line, and a cart must
  // not pay another round trip at ~46ms for a column this query is already
  // positioned to return.
  category_id: products.categoryId,
  // The line's current photos (`cartLinePhotos`), for the checkout's stock
  // check.
  image_url: products.imageUrl,
  images: products.images,
  options: products.options,
};

/** The columns the free gift's line is priced and named from. */
const GIFT_PRODUCT_COLUMNS = {
  id: products.id,
  name: products.name,
  // ★ What the shopper would OTHERWISE have paid, which is what the gift
  // costs its offer's budget, the same rule the shipping waiver's
  // `offerWaivedAmount` follows. The LINE is still ₹0.
  selling_price: products.sellingPrice,
  tax_class_id: products.taxClassId,
  category_id: products.categoryId,
  sku: products.sku,
  hsn_code: products.hsnCode,
  requires_shipping: products.requiresShipping,
  weight_grams: products.weightGrams,
  length_cm: products.lengthCm,
  width_cm: products.widthCm,
  height_cm: products.heightCm,
};

/**
 * The cart's products in this store that StoreMink has not blocked. A product
 * missing from the answer is gone, from the shopper's point of view, whether
 * it was deleted, moved to another store or blocked.
 */
export async function readCartProducts(
  db: Db,
  storeId: string,
  productIds: readonly string[],
) {
  if (productIds.length === 0) return [];
  return db
    .select(CART_PRODUCT_COLUMNS)
    .from(products)
    .where(
      and(
        inArray(products.id, [...productIds]),
        eq(products.storeId, storeId),
        isNull(products.moderationBlockedAt),
      ),
    );
}

export type CartProductRow = Awaited<
  ReturnType<typeof readCartProducts>
>[number];

/**
 * The free gift an offer names, or null when it is not in this store or
 * StoreMink has blocked it (the caller then drops the gift and keeps the sale).
 */
export async function readGiftProduct(
  db: Db,
  storeId: string,
  productId: string,
) {
  const [row] = await db
    .select(GIFT_PRODUCT_COLUMNS)
    .from(products)
    // ★ STORE-SCOPED, like every other product read here. The offer row is
    // store-scoped too, but a gift is the one product id that reaches the
    // order without having been in the shopper's cart, so the predicate is
    // doing real work rather than restating a guarantee.
    .where(
      and(
        eq(products.id, productId),
        eq(products.storeId, storeId),
        isNull(products.moderationBlockedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type GiftProductRow = NonNullable<
  Awaited<ReturnType<typeof readGiftProduct>>
>;

type CartLineVariant = {
  images?: string[] | null;
  option_values?: string[] | null;
};

/**
 * Every photo the product page offers for a cart line, in its order: the
 * variant's own photos, else its colour's photos, else the product's gallery
 * (`photosForVariant`, `productGallery`, composed as the product page
 * composes its gallery). The first is the photo the page opens on, and the
 * picture a line shows NOW unless the shopper chose another of these
 * (`shopperLinePhoto`): an unchanged product keeps its picture, while a photo
 * replaced since (or blocked, once the caller passes the answer through
 * `maskBlockedMedia`) is refreshed. Pure.
 */
export function cartLinePhotos(
  product: Pick<CartProductRow, "image_url" | "images" | "options">,
  variant: CartLineVariant | null,
): string[] {
  const gallery = productGallery(product.image_url, product.images);
  if (!variant) return gallery;
  const normalized = normalizeOptions(product.options);
  const options = "options" in normalized ? normalized.options : [];
  const own = photosForVariant(options, variant);
  return own.length > 0 ? Array.from(new Set(own)) : gallery;
}

/**
 * The photo the shopper chose for a line (a gallery or colour photo they
 * were looking at when they added it), while it is still one of `photos`;
 * else null. ★ COMPARED, NEVER TRUSTED: `current` comes from the browser, so
 * it is only matched against the product's own photos, and what comes back
 * is the product's own address from `photos`, never the browser's value.
 * Pure.
 */
export function shopperLinePhoto(
  photos: readonly string[],
  current: unknown,
): string | null {
  if (typeof current !== "string" || current === "") return null;
  return photos.find((photo) => photo === current) ?? null;
}
