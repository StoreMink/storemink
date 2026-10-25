import "server-only";

import { sql } from "drizzle-orm";
import { type Db, withService } from "@/lib/db/client";

/**
 * ★★ THE ROLLUP'S OWN STATEMENT LIMIT, 5 MINUTES, NOT THE POOL'S 30 S
 * (lib/db/client.ts). Each rebuild is ONE statement over every store's raw
 * events in the window, so it grows with the platform, not with one store.
 * Measured on storemink_local (2026-10-24, rolled back, the window widened to
 * all 211,473 events): the bucket rebuild 2.2 s, the dimensions' DELETE 23 ms
 * and INSERT 2.6 s, its sort spilling 39 MB to disk at the default 4 MB
 * work_mem. A shared-core production database is several times slower, so a
 * busy fortnight would pass 30 s and the rollup would never finish again;
 * 5 minutes is over 100 times today's local cost and still ends a runaway.
 * SET LOCAL lasts only for its transaction, so nothing else on the
 * connection gets the longer limit.
 * ⚠ The cron's attempt deadline is 300 s (docs/cron-jobs.md): a rebuild that
 * needs minutes outlives the attempt, and the scheduler's retry starts a
 * second one beside it. The primary keys keep the counts right (a
 * dimensions rebuild that collides fails rather than doubling a row).
 */
async function setRollupStatementLimit(db: Db): Promise<void> {
  await db.execute(sql`set local statement_timeout = '5min'`);
}

/**
 * Rebuild every raw bucket still inside the 14-day correction window.
 * Rebuilding (rather than incrementing) makes retries and late purchase events
 * deterministic. The primary-key upsert is the cross-instance lock.
 */
export async function runStorefrontAnalyticsRollup(): Promise<number> {
  const result = await withService(async (db) => {
    await setRollupStatementLimit(db);
    return db.execute(sql`
      WITH ordered AS (
        SELECT e.*,
               lag(e.occurred_at) OVER (
                 PARTITION BY e.store_id, e.event_date, e.visitor_key
                 ORDER BY e.occurred_at, e.id
               ) AS previous_at
          FROM storefront_events e
         WHERE e.created_at >= now() - interval '14 days'
      ), marked AS (
        SELECT ordered.*,
               CASE WHEN previous_at IS NULL
                          OR occurred_at - previous_at > interval '30 minutes'
                    THEN 1 ELSE 0 END AS starts_session
          FROM ordered
      ), numbered AS (
        SELECT marked.*,
               sum(starts_session) OVER (
                 PARTITION BY store_id, event_date, visitor_key
                 ORDER BY occurred_at, id
               ) AS session_no
          FROM marked
      ), session_steps AS (
        SELECT store_id, event_date, visitor_key, session_no,
               count(*) FILTER (WHERE event_type = 'page_view')::int AS page_views,
               min(occurred_at) FILTER (WHERE event_type = 'product_view') AS product_at,
               count(*) FILTER (WHERE event_type = 'purchase')::int AS purchases
          FROM numbered
         GROUP BY store_id, event_date, visitor_key, session_no
      ), cart_steps AS (
        SELECT s.*,
               min(e.occurred_at) FILTER (
                 WHERE e.event_type = 'add_to_cart' AND e.occurred_at > s.product_at
               ) AS cart_at
          FROM session_steps s
          LEFT JOIN numbered e USING (store_id, event_date, visitor_key, session_no)
         GROUP BY s.store_id, s.event_date, s.visitor_key, s.session_no,
                  s.page_views, s.product_at, s.purchases
      ), checkout_steps AS (
        SELECT s.*,
               min(e.occurred_at) FILTER (
                 WHERE e.event_type = 'checkout_start' AND e.occurred_at > s.cart_at
               ) AS checkout_at
          FROM cart_steps s
          LEFT JOIN numbered e USING (store_id, event_date, visitor_key, session_no)
         GROUP BY s.store_id, s.event_date, s.visitor_key, s.session_no,
                  s.page_views, s.product_at, s.purchases, s.cart_at
      ), purchase_steps AS (
        SELECT s.*,
               min(e.occurred_at) FILTER (
                 WHERE e.event_type = 'purchase' AND e.occurred_at >= s.checkout_at
               ) AS purchase_at
          FROM checkout_steps s
          LEFT JOIN numbered e USING (store_id, event_date, visitor_key, session_no)
         GROUP BY s.store_id, s.event_date, s.visitor_key, s.session_no,
                  s.page_views, s.product_at, s.purchases, s.cart_at, s.checkout_at
      ), bucket AS (
        SELECT store_id, event_date,
               count(DISTINCT visitor_key)::int AS visitors,
               count(*)::int AS sessions,
               coalesce(sum(page_views), 0)::int AS page_views,
               count(*) FILTER (WHERE product_at IS NOT NULL)::int AS product_sessions,
               count(*) FILTER (WHERE cart_at IS NOT NULL)::int AS cart_sessions,
               count(*) FILTER (WHERE checkout_at IS NOT NULL)::int AS checkout_sessions,
               count(*) FILTER (WHERE purchase_at IS NOT NULL)::int AS converted_sessions,
               coalesce(sum(purchases), 0)::int AS purchases
          FROM purchase_steps
         GROUP BY store_id, event_date
      )
      INSERT INTO storefront_daily
        (store_id, date, visitors, sessions, page_views, product_sessions,
         cart_sessions, checkout_sessions, converted_sessions, purchases, updated_at)
      SELECT store_id, event_date, visitors, sessions, page_views,
             product_sessions, cart_sessions, checkout_sessions,
             converted_sessions, purchases, now()
        FROM bucket
      ON CONFLICT (store_id, date) DO UPDATE SET
        visitors = EXCLUDED.visitors,
        sessions = EXCLUDED.sessions,
        page_views = EXCLUDED.page_views,
        product_sessions = EXCLUDED.product_sessions,
        cart_sessions = EXCLUDED.cart_sessions,
        checkout_sessions = EXCLUDED.checkout_sessions,
        converted_sessions = EXCLUDED.converted_sessions,
        purchases = EXCLUDED.purchases,
        updated_at = now()
      RETURNING store_id
    `);
  });
  const dimensions = await runStorefrontDimensionRollup();
  return (result.rowCount ?? 0) + dimensions;
}

/**
 * Rebuild sessions by device / source / referrer / landing page / campaign /
 * country / region / city (migration 0187).
 *
 * A session is credited by its FIRST page view (source, referrer, campaign,
 * landing page); device and location belong to the visitor key, which is
 * derived per device and day, so they are constant within it. Sales are the
 * totals of orders whose purchase event landed in the session.
 *
 * ★ Only days at least two days clear of the 14-day raw-event prune are
 * rebuilt: a day straddling that boundary would be recomputed from a partial
 * set of events and quietly shrink. DELETE then INSERT (one transaction)
 * because a key can legitimately disappear on rebuild (top-50 cap shifts).
 */
export async function runStorefrontDimensionRollup(): Promise<number> {
  return withService(async (db) => {
    await setRollupStatementLimit(db);
    await db.execute(sql`
      DELETE FROM storefront_daily_dimensions
       WHERE date >= (now() AT TIME ZONE 'UTC')::date - 12
    `);
    const result = await db.execute(sql`
      WITH ordered AS (
        SELECT e.*,
               lag(e.occurred_at) OVER (
                 PARTITION BY e.store_id, e.event_date, e.visitor_key
                 ORDER BY e.occurred_at, e.id
               ) AS previous_at
          FROM storefront_events e
         WHERE e.event_date >= (now() AT TIME ZONE 'UTC')::date - 12
      ), numbered AS (
        SELECT ordered.*,
               sum(CASE WHEN previous_at IS NULL
                             OR occurred_at - previous_at > interval '30 minutes'
                        THEN 1 ELSE 0 END) OVER (
                 PARTITION BY store_id, event_date, visitor_key
                 ORDER BY occurred_at, id
               ) AS session_no
          FROM ordered
      ), sessions AS (
        SELECT store_id, event_date, visitor_key, session_no,
               (array_agg(source ORDER BY occurred_at, id)
                  FILTER (WHERE event_type = 'page_view'))[1] AS source,
               (array_agg(referrer_host ORDER BY occurred_at, id)
                  FILTER (WHERE event_type = 'page_view'))[1] AS referrer_host,
               (array_agg(utm_campaign ORDER BY occurred_at, id)
                  FILTER (WHERE event_type = 'page_view'))[1] AS campaign,
               (array_agg(path ORDER BY occurred_at, id)
                  FILTER (WHERE event_type = 'page_view'))[1] AS landing_page,
               max(device_type) AS device,
               max(country) AS country,
               max(region) AS region,
               max(city) AS city,
               count(*) FILTER (WHERE event_type = 'page_view')::int AS page_views,
               bool_or(event_type = 'purchase') AS converted,
               array_agg(order_id) FILTER (
                 WHERE event_type = 'purchase' AND order_id IS NOT NULL
               ) AS order_ids
          FROM numbered
         GROUP BY store_id, event_date, visitor_key, session_no
      ), session_sales AS (
        SELECT s.*,
               coalesce((
                 SELECT sum(o.total)
                   FROM orders o
                  WHERE o.id = ANY (s.order_ids)
                    AND o.store_id = s.store_id
                    AND o.status <> 'cancelled'
                    AND o.payment_method <> 'exchange'
               ), 0) AS sales
          FROM sessions s
      ), dims AS (
        SELECT store_id, event_date, 'source' AS dimension,
               coalesce(source, 'direct') AS key,
               visitor_key, page_views, converted, sales
          FROM session_sales
        UNION ALL
        SELECT store_id, event_date, 'device', device,
               visitor_key, page_views, converted, sales
          FROM session_sales WHERE device IS NOT NULL
        UNION ALL
        SELECT store_id, event_date, 'referrer', referrer_host,
               visitor_key, page_views, converted, sales
          FROM session_sales WHERE referrer_host IS NOT NULL
        UNION ALL
        SELECT store_id, event_date, 'landing_page', landing_page,
               visitor_key, page_views, converted, sales
          FROM session_sales WHERE landing_page IS NOT NULL
        UNION ALL
        SELECT store_id, event_date, 'campaign', campaign,
               visitor_key, page_views, converted, sales
          FROM session_sales WHERE campaign IS NOT NULL
        UNION ALL
        SELECT store_id, event_date, 'country', country,
               visitor_key, page_views, converted, sales
          FROM session_sales WHERE country IS NOT NULL
        UNION ALL
        SELECT store_id, event_date, 'region', country || '|' || region,
               visitor_key, page_views, converted, sales
          FROM session_sales WHERE country IS NOT NULL AND region IS NOT NULL
        UNION ALL
        SELECT store_id, event_date, 'city',
               country || '|' || coalesce(region, '') || '|' || city,
               visitor_key, page_views, converted, sales
          FROM session_sales WHERE country IS NOT NULL AND city IS NOT NULL
      ), aggregated AS (
        SELECT store_id, event_date, dimension, key,
               count(*)::int AS sessions,
               count(DISTINCT visitor_key)::int AS visitors,
               coalesce(sum(page_views), 0)::int AS page_views,
               count(*) FILTER (WHERE converted)::int AS converted_sessions,
               coalesce(sum(sales), 0) AS sales,
               row_number() OVER (
                 PARTITION BY store_id, event_date, dimension
                 ORDER BY count(*) DESC, key
               ) AS rank
          FROM dims
         GROUP BY store_id, event_date, dimension, key
      )
      INSERT INTO storefront_daily_dimensions
        (store_id, date, dimension, key, sessions, visitors, page_views,
         converted_sessions, sales, updated_at)
      SELECT store_id, event_date, dimension, left(key, 512), sessions,
             visitors, page_views, converted_sessions, sales, now()
        FROM aggregated
       WHERE rank <= 50 AND length(key) > 0
    `);
    return result.rowCount ?? 0;
  });
}
