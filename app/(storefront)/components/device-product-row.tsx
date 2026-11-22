"use client";

import { useEffect, useState } from "react";
import type { ShopCardProduct } from "./shop-card";

/**
 * The product cards for a list of slugs kept on the shopper's device
 * (lib/storefront/device-lists.ts), read from POST /api/storefront/products.
 *
 * `null` while the first answer is on its way; then the products the store
 * still sells, in the list's order. A failed read is an empty list: these
 * rows are extras, never worth an error on the page.
 */
export function useDeviceProducts(
  slugs: readonly string[],
): ShopCardProduct[] | null {
  const key = slugs.join(",");
  const [answer, setAnswer] = useState<{
    key: string;
    products: ShopCardProduct[];
  } | null>(null);

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    // A POST: the list travels in the body, never in an address a log keeps.
    fetch("/api/storefront/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slugs: key.split(",") }),
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : { products: [] }))
      .then((body: { products?: unknown }) => {
        setAnswer({
          key,
          products: Array.isArray(body.products)
            ? (body.products as ShopCardProduct[])
            : [],
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setAnswer({ key, products: [] });
      });
    return () => controller.abort();
  }, [key]);

  if (!key) return [];
  // An answer for an earlier list is not this list's answer.
  return answer && answer.key === key ? answer.products : null;
}
