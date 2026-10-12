import "server-only";

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { orders, products, storefrontEvents } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { trafficKeyLabel } from "../storefront-data";

// Live View: what the storefront is doing in the last few minutes.
//
// Reads RAW storefront events (Pro collection only, consented visitors only),
// so it is current to the second rather than the hourly rollup. A "visitor"
// here is the daily visitor key; it rotates at the store's midnight, so a
// visitor active across midnight briefly counts twice, which is acceptable for
// a live pulse and is never written anywhere.

const NOW_WINDOW = "5 minutes";
const BEHAVIOUR_WINDOW = "10 minutes";
const TOP_WINDOW = "30 minutes";

export interface LiveTraffic {
  visitorsNow: number;
  visitorsToday: number;
  activeCarts: number;
  checkingOut: number;
  purchased: number;
  topLocations: Array<{ key: string; label: string; visitors: number }>;
  topProducts: Array<{ key: string; name: string; visitors: number }>;
  activity: LiveActivity[];
}

export interface LiveActivity {
  id: string;
  kind: "product_view" | "add_to_cart" | "checkout_start" | "purchase";
  at: string;
  where: string | null;
  product: string | null;
  amount: number | null;
}

export async function getLiveTraffic(
  storeId: string,
  todayStart: Date,
): Promise<LiveTraffic> {
  return withService(async (db) => {
    const since = (window: string) =>
      sql`${storefrontEvents.occurredAt} > now() - ${window}::interval`;

    const [now] = await db
      .select({
        visitors: sql<number>`count(distinct ${storefrontEvents.visitorKey})::int`,
      })
      .from(storefrontEvents)
      .where(
        and(
          eq(storefrontEvents.storeId, storeId),
          ne(storefrontEvents.eventType, "purchase"),
          since(NOW_WINDOW),
        ),
      );

    const [today] = await db
      .select({
        visitors: sql<number>`count(distinct ${storefrontEvents.visitorKey})::int`,
      })
      .from(storefrontEvents)
      .where(
        and(
          eq(storefrontEvents.storeId, storeId),
          ne(storefrontEvents.eventType, "purchase"),
          gte(storefrontEvents.occurredAt, todayStart.toISOString()),
        ),
      );

    // Shopify's "customer behaviour": the furthest step each visitor reached
    // in the window, so one shopper is never in two buckets.
    const [behaviour] = await db
      .execute<{
        carts: number;
        checkout: number;
        purchased: number;
      }>(
        sql`
      WITH reached AS (
        SELECT visitor_key,
               bool_or(event_type = 'purchase') AS purchased,
               bool_or(event_type = 'checkout_start') AS checkout,
               bool_or(event_type = 'add_to_cart') AS cart
          FROM storefront_events
         WHERE store_id = ${storeId}
           AND occurred_at > now() - ${BEHAVIOUR_WINDOW}::interval
         GROUP BY visitor_key
      )
      SELECT count(*) FILTER (WHERE cart AND NOT checkout AND NOT purchased)::int AS carts,
             count(*) FILTER (WHERE checkout AND NOT purchased)::int AS checkout,
             count(*) FILTER (WHERE purchased)::int AS purchased
        FROM reached
    `,
      )
      .then((result) => result.rows);

    const locationRows = await db
      .select({
        country: storefrontEvents.country,
        region: storefrontEvents.region,
        city: storefrontEvents.city,
        visitors: sql<number>`count(distinct ${storefrontEvents.visitorKey})::int`,
      })
      .from(storefrontEvents)
      .where(
        and(
          eq(storefrontEvents.storeId, storeId),
          isNotNull(storefrontEvents.country),
          isNotNull(storefrontEvents.city),
          since(TOP_WINDOW),
        ),
      )
      .groupBy(
        storefrontEvents.country,
        storefrontEvents.region,
        storefrontEvents.city,
      )
      .orderBy(desc(sql`4`))
      .limit(5);

    // Product interest: a product page view carries the slug in its path; an
    // add to cart carries the product id. Either counts the visitor once.
    const productRows = await db
      .execute<{
        id: string;
        name: string;
        visitors: number;
      }>(
        sql`
      SELECT p.id, p.name, count(DISTINCT e.visitor_key)::int AS visitors
        FROM storefront_events e
        JOIN products p
          ON p.store_id = e.store_id
         AND (p.id = e.product_id
              OR (e.event_type = 'product_view'
                  AND e.path = '/shop/' || p.slug))
       WHERE e.store_id = ${storeId}
         AND e.event_type IN ('product_view', 'add_to_cart')
         AND e.occurred_at > now() - ${TOP_WINDOW}::interval
       GROUP BY p.id, p.name
       ORDER BY visitors DESC, p.name
       LIMIT 5
    `,
      )
      .then((result) => result.rows);

    const eventRows = await db
      .select({
        id: storefrontEvents.id,
        kind: storefrontEvents.eventType,
        at: storefrontEvents.occurredAt,
        country: storefrontEvents.country,
        region: storefrontEvents.region,
        city: storefrontEvents.city,
        path: storefrontEvents.path,
        productId: storefrontEvents.productId,
        orderId: storefrontEvents.orderId,
      })
      .from(storefrontEvents)
      .where(
        and(
          eq(storefrontEvents.storeId, storeId),
          inArray(storefrontEvents.eventType, [
            "product_view",
            "add_to_cart",
            "checkout_start",
            "purchase",
          ]),
          since(TOP_WINDOW),
        ),
      )
      .orderBy(desc(storefrontEvents.occurredAt))
      .limit(12);

    // Resolve product names and order totals for the feed in two lookups.
    const slugs = eventRows
      .map((row) => /^\/shop\/([^/]+)$/.exec(row.path ?? "")?.[1])
      .filter((slug): slug is string => Boolean(slug));
    const productIds = eventRows
      .map((row) => row.productId)
      .filter((id): id is string => Boolean(id));
    const named =
      slugs.length || productIds.length
        ? await db
            .select({
              id: products.id,
              slug: products.slug,
              name: products.name,
            })
            .from(products)
            .where(
              and(
                eq(products.storeId, storeId),
                or(
                  ...(slugs.length ? [inArray(products.slug, slugs)] : []),
                  ...(productIds.length
                    ? [inArray(products.id, productIds)]
                    : []),
                ),
              ),
            )
        : [];
    const bySlug = new Map(named.map((row) => [row.slug, row.name]));
    const byId = new Map(named.map((row) => [row.id, row.name]));
    const orderIds = eventRows
      .map((row) => row.orderId)
      .filter((id): id is string => Boolean(id));
    const totals = orderIds.length
      ? await db
          .select({ id: orders.id, total: orders.total })
          .from(orders)
          .where(and(eq(orders.storeId, storeId), inArray(orders.id, orderIds)))
      : [];
    const totalById = new Map(totals.map((row) => [row.id, Number(row.total)]));

    const where = (row: {
      country: string | null;
      region: string | null;
      city: string | null;
    }) =>
      row.country && row.city
        ? trafficKeyLabel(
            "city",
            `${row.country}|${row.region ?? ""}|${row.city}`,
          )
        : null;

    return {
      visitorsNow: Number(now?.visitors ?? 0),
      visitorsToday: Number(today?.visitors ?? 0),
      activeCarts: Number(behaviour?.carts ?? 0),
      checkingOut: Number(behaviour?.checkout ?? 0),
      purchased: Number(behaviour?.purchased ?? 0),
      topLocations: locationRows.map((row) => ({
        key: `${row.country}|${row.region ?? ""}|${row.city}`,
        label: where(row) ?? "",
        visitors: Number(row.visitors),
      })),
      topProducts: productRows.map((row) => ({
        key: row.id,
        name: row.name,
        visitors: Number(row.visitors),
      })),
      activity: eventRows.map((row) => {
        const slug = /^\/shop\/([^/]+)$/.exec(row.path ?? "")?.[1];
        return {
          id: row.id,
          kind: row.kind as LiveActivity["kind"],
          at: row.at,
          where: where(row),
          product:
            (row.productId ? byId.get(row.productId) : undefined) ??
            (slug ? bySlug.get(slug) : undefined) ??
            null,
          amount: row.orderId ? (totalById.get(row.orderId) ?? null) : null,
        };
      }),
    };
  });
}

/** Orders placed today that have not been cancelled (every plan). */
export async function getLiveOrders(
  storeId: string,
  since: Date,
): Promise<Array<{ id: string; ref: string; total: number; at: string }>> {
  const rows = await withService((db) =>
    db
      .select({
        id: orders.id,
        ref: orders.orderRef,
        total: orders.total,
        at: orders.createdAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          ne(orders.status, "cancelled"),
          ne(orders.paymentMethod, "exchange"),
          gte(orders.createdAt, since.toISOString()),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(8),
  );
  return rows.map((row) => ({
    id: row.id,
    ref: row.ref ?? "",
    total: Number(row.total),
    at: row.at,
  }));
}
