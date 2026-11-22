import "server-only";

/**
 * A store's shops, as a shopper may see them: the "Our stores" page and the
 * footer link to it (owner, 22 Nov 2026).
 *
 * ★ ONLY SHOPS, ONLY ACTIVE ONES, ONLY WHAT A SHOP SIGN WOULD SAY. A location
 *   of type `shop` is a place the public walks into, so its name and address
 *   are public by nature. A warehouse or a dark store is never listed,
 *   whatever it is called, and nothing else on the row (GSTIN, receipt
 *   prefix, capabilities, stock) ever leaves this function.
 * ★ `store_locations` is readable by store admins only (RLS), so this is a
 *   service read that selects the public columns and nothing more.
 * ★ CACHED FOR FIVE MINUTES. The storefront layout asks on every page
 *   whether to show the footer link, and a location changes a few times a
 *   year. A new or renamed shop appears within five minutes.
 * ★ A failed read is "no shops": the link and the page simply do not show.
 */

import { unstable_cache } from "next/cache";
import { and, asc, eq } from "drizzle-orm";
import { storeLocations } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { locationAddressLines } from "@/lib/locations/address";

export interface PublicShopLocation {
  id: string;
  name: string;
  /** The address as lines; never empty (a shop with no address is left out). */
  address: string[];
  /** A maps search for the shop by its name and address. */
  mapsUrl: string;
}

/** The most shops one page lists. */
export const PUBLIC_SHOP_LOCATIONS_MAX = 100;
export const PUBLIC_SHOP_LOCATIONS_REVALIDATE_SECONDS = 300;
export const PUBLIC_SHOP_LOCATIONS_TAG = "storefront-shop-locations";

/** The public card for one location row, or null when it is not a shop a
 *  shopper can be sent to. Pure, so the rule is tested without a database. */
export function publicShopLocation(row: {
  id: string;
  name: string;
  type: string;
  active: boolean;
  address: unknown;
}): PublicShopLocation | null {
  if (row.type !== "shop" || !row.active) return null;
  const name = row.name.trim();
  const address = locationAddressLines(
    row.address &&
      typeof row.address === "object" &&
      !Array.isArray(row.address)
      ? (row.address as Record<string, unknown>)
      : null,
  );
  if (!name || address.length === 0) return null;
  return {
    id: row.id,
    name,
    address,
    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      [name, ...address].join(", ").slice(0, 400),
    )}`,
  };
}

async function readShopLocations(
  storeId: string,
): Promise<PublicShopLocation[]> {
  const rows = await withService((db) =>
    db
      .select({
        id: storeLocations.id,
        name: storeLocations.name,
        type: storeLocations.type,
        active: storeLocations.active,
        address: storeLocations.address,
      })
      .from(storeLocations)
      .where(
        and(
          eq(storeLocations.storeId, storeId),
          eq(storeLocations.type, "shop"),
          eq(storeLocations.active, true),
        ),
      )
      .orderBy(asc(storeLocations.sortOrder), asc(storeLocations.name))
      .limit(PUBLIC_SHOP_LOCATIONS_MAX),
  );
  return rows.flatMap((row) => {
    const shop = publicShopLocation(row);
    return shop ? [shop] : [];
  });
}

const cachedShopLocations = unstable_cache(
  readShopLocations,
  [PUBLIC_SHOP_LOCATIONS_TAG, "v1"],
  {
    tags: [PUBLIC_SHOP_LOCATIONS_TAG],
    revalidate: PUBLIC_SHOP_LOCATIONS_REVALIDATE_SECONDS,
  },
);

/** `unstable_cache` refuses to run without a render or request scope. */
function isMissingCacheScope(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /incrementalCache missing/i.test(message);
}

/** The store's shops for a shopper. Empty on any failure. */
export async function getPublicShopLocations(
  storeId: string,
): Promise<PublicShopLocation[]> {
  try {
    return await cachedShopLocations(storeId);
  } catch (err) {
    if (isMissingCacheScope(err)) {
      try {
        return await readShopLocations(storeId);
      } catch {
        return [];
      }
    }
    return [];
  }
}
