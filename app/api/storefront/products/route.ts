import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { isStorefrontGated } from "@/lib/store/launch-state";
import { storefrontAccess } from "@/lib/store/storefront-access";
import { maskBlockedMedia } from "@/lib/moderation/blocked-objects";
import { getPublishedProducts } from "@/lib/storefront/queries";
import { cleanSlug, DEVICE_LIST_MAX } from "@/lib/storefront/device-lists";

// ---------------------------------------------------------------------------
// POST /api/storefront/products  { "slugs": ["a", "b"] }: product cards for
// the lists a shopper keeps on their own device (saved items, recently
// viewed; lib/storefront/device-lists.ts).
//
// ★★ A POST, SO THE LIST IS IN NO LOG. The slugs are what one shopper saved
//    or looked at. In a query string they would be written to every access
//    log between the browser and this function; in the body they are read
//    here, used for one catalogue lookup, and kept nowhere. Nothing is
//    written, so the method is the only thing "POST" means here.
// The same rules as /api/storefront/search otherwise, for the same reasons:
// ★ A ROUTE HANDLER, never a Server Action (actions queue one at a time per
//   client, so this would wait behind an Add to cart).
// ★ THE STORE COMES FROM THE HOST, never the request body; an unknown host
//   answers with nothing.
// ★ IT READS THE CATALOGUE THE SHOP GRID RENDERS (getPublishedProducts), so a
//   card here is a card /shop would show: published products only, today's
//   price and stock. A slug that is no longer sold is simply left out.
// ★ THE ANSWER IS MASKED (takedown): a blocked photo is the placeholder.
// ★ A store that has not opened answers nothing without its password.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The most cards one request returns: the longer of the two lists. */
export const PRODUCT_CARDS_MAX = Math.max(
  DEVICE_LIST_MAX.wishlist,
  DEVICE_LIST_MAX.recent,
);

/** A request body larger than any real list is not read. */
const BODY_MAX_BYTES = 16 * 1024;

function json(products: unknown[]): Response {
  return Response.json(
    { products },
    // One shopper's own list: never kept by anything in between.
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown = null;
  try {
    const text = await request.text();
    if (text.length <= BODY_MAX_BYTES) body = JSON.parse(text);
  } catch {
    body = null;
  }
  const raw = (body as { slugs?: unknown } | null)?.slugs;
  const slugs: string[] = [];
  // Bounded before anything is read: at most a list's worth of short slugs.
  for (const part of Array.isArray(raw) ? raw.slice(0, 500) : []) {
    const slug = cleanSlug(part);
    if (slug && !slugs.includes(slug)) slugs.push(slug);
    if (slugs.length >= PRODUCT_CARDS_MAX) break;
  }
  if (slugs.length === 0) return json([]);

  const store = await getCurrentStoreOrNull();
  if (!store) return json([]);
  if (
    isStorefrontGated(store) &&
    (await storefrontAccess(store)) === "locked"
  ) {
    return json([]);
  }

  const catalogue = await getPublishedProducts(store.id);
  const bySlug = new Map(catalogue.map((product) => [product.slug, product]));
  // In the order asked for: the list's own order (newest first).
  const products = slugs.flatMap((slug) => {
    const product = bySlug.get(slug);
    return product ? [product] : [];
  });
  return json(await maskBlockedMedia(products));
}
