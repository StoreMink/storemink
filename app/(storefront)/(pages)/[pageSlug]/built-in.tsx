import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getStorefrontLayout } from "@/lib/store/storefront-layout";
import { getPublicShopLocations } from "@/lib/storefront/store-locations";
import { SavedProducts } from "@/app/(storefront)/components/saved-products";

// ---------------------------------------------------------------------------
// The pages every store has without writing them (owner, 22 Nov 2026):
// "Our stores" at /stores and "Saved items" at /wishlist.
//
// ★★ A MERCHANT'S OWN PAGE ALWAYS WINS. These are answered by the merchant
//    page route ([pageSlug]/page.tsx) only when the store has NO page of its
//    own at that address, published or in preview. A static route of their
//    own (stores/page.tsx) would be served first by the App Router and would
//    hide a page a merchant already built at /stores, and reserving the
//    address would change the list of reserved names that every Theme Studio
//    prompt since v19 prints (a persisted request must replay byte for byte).
// ★ Each exists only where the merchant keeps it on (Website Builder, Brand,
//   Shopping extras), and "Our stores" only for a store with a shop to list.
//   Otherwise the address is a 404 like any other unknown page.
// ---------------------------------------------------------------------------

export const BUILT_IN_PAGE_SLUGS = ["stores", "wishlist"] as const;

export interface BuiltInPage {
  metadata: Metadata;
  element: ReactNode;
}

export async function builtInPage(
  slug: string,
  storeId: string,
): Promise<BuiltInPage | null> {
  if (slug === "wishlist") {
    const layout = await getStorefrontLayout();
    if (!layout.wishlist) return null;
    return {
      // noindex: the page is one shopper's own list and empty to a crawler.
      metadata: {
        title: "Saved items",
        robots: { index: false, follow: true },
      },
      element: <SavedProducts />,
    };
  }
  if (slug === "stores") {
    const layout = await getStorefrontLayout();
    if (!layout.storeLocator) return null;
    const shops = await getPublicShopLocations(storeId);
    if (shops.length === 0) return null;
    return {
      metadata: {
        title: "Our stores",
        description: "Where to find us: our shop addresses and directions.",
        alternates: { canonical: "/stores" },
      },
      element: (
        <div className="shop-listing sm-stores">
          <section className="shop-hero">
            <div className="shop-hero-row">
              <h1 className="shop-title">Our stores</h1>
            </div>
            <p className="shop-count">
              {shops.length === 1
                ? "Visit us at our shop."
                : `Visit us at any of our ${shops.length} shops.`}
            </p>
          </section>
          <ul className="sm-stores-list">
            {shops.map((shop) => (
              <li key={shop.id} className="sm-stores-card">
                <h2 className="sm-stores-name">{shop.name}</h2>
                <address className="sm-stores-address">
                  {shop.address.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </address>
                <a
                  className="sm-stores-directions"
                  href={shop.mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get directions
                  <span className="sr-only">
                    {" "}
                    to {shop.name} (opens in a new tab)
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ),
    };
  }
  return null;
}
