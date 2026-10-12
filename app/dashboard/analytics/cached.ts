import "server-only";

import { unstable_cache } from "next/cache";
import {
  getActivity,
  getCatalogSnapshots,
  getCustomerMix,
  getDiscountImpact,
  getGrossMarginAnalytics,
  getInventoryVelocity,
  getRecentOrders,
  getReturnsAndRefunds,
  getSalesAnalytics,
  getSalesBreakdown,
  getSalesByChannel,
  getSalesByDiscountCode,
  getSalesByLocation,
  getSalesByPaymentMethod,
  getSalesByRegion,
  getSalesTotals,
  getTopCategories,
  getTopProducts,
} from "./data";
import { getSearchAnalytics, getSearchDimensionBreakdown } from "./search-data";
import {
  getSessionsSeries,
  getStorefrontAnalytics,
  getTrafficBreakdown,
} from "./storefront-data";

// One-minute result cache for the Analytics OVERVIEW page (owner decision,
// 2026-10-12): about Shopify's own freshness, and repeat views or switching
// back to a range cost almost no database work. Production gives each
// instance only five DB connections and an Overview load is ~45 transactions,
// so this protects every other request on the instance too.
//
// ★ KEYS. unstable_cache keys on the function's ARGUMENTS (store id, the
// viewer's resolved location scope, the range) plus the name below, so a
// result is only ever served to the same store and scope. The page rounds
// "now" down to the minute, so a preset like "Last 90 days" keeps one key for
// a minute instead of a new one every millisecond.
//
// ★ RENDER SCOPE ONLY. unstable_cache throws outside a render ("incremental
// cache missing"), and these readers are ALSO used by Mink, the CSV route and
// the report builder, which must stay live. So the cache wraps the readers
// HERE, for the Overview page, never inside data.ts. Live View and target
// cards are deliberately not cached.

const TTL_SECONDS = 60;
// Bump when a reader's result shape changes, so a deploy never serves an
// entry written by the previous code.
const VERSION = "v1";

function cached<A extends unknown[], R>(
  name: string,
  reader: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return unstable_cache(reader, ["analytics", VERSION, name], {
    revalidate: TTL_SECONDS,
    tags: ["analytics"],
  });
}

export const cachedReaders = {
  sales: cached("sales", getSalesAnalytics),
  salesTotals: cached("salesTotals", getSalesTotals),
  catalog: cached("catalog", getCatalogSnapshots),
  categories: cached("categories", getTopCategories),
  topProducts: cached("topProducts", getTopProducts),
  channel: cached("channel", getSalesByChannel),
  payment: cached("payment", getSalesByPaymentMethod),
  location: cached("location", getSalesByLocation),
  customerMix: cached("customerMix", getCustomerMix),
  discounts: cached("discounts", getDiscountImpact),
  returns: cached("returns", getReturnsAndRefunds),
  velocity: cached("velocity", getInventoryVelocity),
  breakdown: cached("breakdown", getSalesBreakdown),
  discountCodes: cached("discountCodes", getSalesByDiscountCode),
  regions: cached("regions", getSalesByRegion),
  recentOrders: cached("recentOrders", getRecentOrders),
  activity: cached("activity", getActivity),
  margin: cached("margin", getGrossMarginAnalytics),
  search: cached("search", getSearchAnalytics),
  searchDimension: cached("searchDimension", getSearchDimensionBreakdown),
  storefront: cached("storefront", getStorefrontAnalytics),
  sessionsSeries: cached("sessionsSeries", getSessionsSeries),
  traffic: cached("traffic", getTrafficBreakdown),
};

/** "Now" rounded down to the minute: the Overview's cache-friendly clock. */
export function minuteNow(): Date {
  const now = new Date();
  now.setSeconds(0, 0);
  return now;
}
