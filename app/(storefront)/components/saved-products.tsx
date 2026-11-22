"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ShopCard } from "@/app/(storefront)/components/shop-card";
import { useDeviceProducts } from "@/app/(storefront)/components/device-product-row";
import {
  clearDeviceList,
  readDeviceList,
  serverDeviceList,
  subscribeDeviceLists,
} from "@/lib/storefront/device-lists";

// The "Saved items" page (/wishlist, [pageSlug]/built-in.tsx): the products
// this shopper saved with the heart, on this device
// (lib/storefront/device-lists.ts). Each card keeps its heart, so a product
// is removed the way it was saved.

const saved = () => readDeviceList("wishlist");

export function SavedProducts({
  storeLowStockThreshold = 0,
}: {
  storeLowStockThreshold?: number;
}) {
  const slugs = useSyncExternalStore(
    subscribeDeviceLists,
    saved,
    serverDeviceList,
  );
  const products = useDeviceProducts(slugs);

  return (
    <div className="shop-listing sm-saved">
      <section className="shop-hero">
        <div className="shop-hero-row">
          <h1 className="shop-title">Saved items</h1>
        </div>
        <p className="shop-count">
          Saved on this device. They stay here until you remove them or clear
          this browser.
        </p>
      </section>

      {slugs.length === 0 ? (
        <div className="shop-empty">
          <h2>Nothing saved yet</h2>
          <p>Tap the heart on a product to keep it here for later.</p>
          <p>
            <Link href="/shop" className="sm-btn-primary sm-saved-cta">
              Browse the shop
            </Link>
          </p>
        </div>
      ) : products === null ? (
        <p className="shop-count" role="status">
          Loading your saved items
        </p>
      ) : products.length === 0 ? (
        <div className="shop-empty">
          <h2>These products are no longer available</h2>
          <p>
            <Link href="/shop" className="sm-btn-primary sm-saved-cta">
              Browse the shop
            </Link>
          </p>
        </div>
      ) : (
        <>
          <div className="shop-grid">
            {products.map((product) => (
              <ShopCard
                key={product.id}
                product={product}
                headingLevel={2}
                storeLowStockThreshold={storeLowStockThreshold}
              />
            ))}
          </div>
          <p className="sm-saved-clear">
            <button
              type="button"
              className="sm-btn-secondary"
              onClick={() => clearDeviceList("wishlist")}
            >
              Remove all
            </button>
          </p>
        </>
      )}
    </div>
  );
}
