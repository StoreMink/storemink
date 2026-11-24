"use client";

import { useEffect, useSyncExternalStore } from "react";
import { ShopCard } from "@/app/(storefront)/components/shop-card";
import { HorizontalCarousel } from "@/app/(storefront)/components/homepage/horizontal-carousel";
import { useDeviceProducts } from "@/app/(storefront)/components/device-product-row";
import {
  noteViewed,
  readDeviceList,
  serverDeviceList,
  subscribeDeviceLists,
} from "@/lib/storefront/device-lists";

// "Recently viewed" under a product (owner, 22 Nov 2026): the products this
// shopper looked at before this one, newest first. The list is on their own
// device (lib/storefront/device-lists.ts); nothing about it is kept on a
// server.
//
// ★ Renders NOTHING until there is something to show: a first-time visitor,
//   the server's own render and a shopper whose earlier products are no
//   longer sold all see no heading and no gap.
// ★ This product is noted after the row is read, so it never lists itself.

const recent = () => readDeviceList("recent");

export function RecentlyViewed({
  currentSlug,
  storeLowStockThreshold = 0,
}: {
  currentSlug: string;
  storeLowStockThreshold?: number;
}) {
  const list = useSyncExternalStore(
    subscribeDeviceLists,
    recent,
    serverDeviceList,
  );
  const others = list.filter((slug) => slug !== currentSlug);
  const products = useDeviceProducts(others);

  useEffect(() => {
    noteViewed(currentSlug);
  }, [currentSlug]);

  if (!products || products.length === 0) return null;
  return (
    <section className="pdp-related pdp-recent" data-sm="recently-viewed">
      <h2 className="pdp-related-title">Recently viewed</h2>
      <HorizontalCarousel
        carouselClass="home-product-carousel"
        scrollClass="home-product-scroll"
        arrowClass="home-product-arrow"
      >
        {products.map((product) => (
          <ShopCard
            key={product.id}
            product={product}
            storeLowStockThreshold={storeLowStockThreshold}
          />
        ))}
      </HorizontalCarousel>
    </section>
  );
}
