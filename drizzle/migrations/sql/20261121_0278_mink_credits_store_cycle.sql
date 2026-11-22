-- Included Mink credits refresh on the store's own date (owner, 21 Nov 2026).
--
-- A store on a paid plan cycle already counts its 30-day credit window from
-- `billing_subscriptions.current_period_start` (0114). Every other store (the
-- Free plan, and a plan StoreMink granted) was still metered by UTC calendar
-- month, so all of them refreshed together on the 1st, whatever day they
-- joined. `lib/ai/quota.ts` now counts those stores' 30-day windows from
-- `stores.created_at`, with the same 'cycle:<window start>' key a paid cycle
-- uses.
--
-- 1. CARRY THIS MONTH'S USAGE to the new key, by 0114's own rule: only when
--    the store's current 30-day window already covered the whole recorded
--    calendar month (it began on or before the 1st). `ai_usage.used` is one
--    number and cannot be split across two windows, so a window that opened
--    mid-month starts clean. The cost is at most one extra allowance per
--    store, once. GREATEST keeps a retried deploy from double-counting.
--
--    The offsets are 720 hours, never `interval '30 days'` (Postgres resolves
--    that in the session time zone), and the start is cut to milliseconds, so
--    the key is byte-identical to the one `minkCreditCycleAt` builds from a
--    JavaScript Date. Only stores with no usable paid cycle start are touched:
--    a paid cycle keeps its own key.
--
-- 2. HELP: the credits guide said the 30 days are counted from the paid plan
--    cycle start, and said nothing for a store without one. One sentence is
--    corrected in place.
--
-- Data and content only; no schema changes. Backward compatible: the revision
-- being replaced keeps reading and writing the calendar key, which is left
-- exactly as it is.

INSERT INTO public.ai_usage (store_id, period, used)
SELECT
  usage.store_id,
  'cycle:' || to_char(
    boundary.starts_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ),
  usage.used
FROM public.ai_usage AS usage
JOIN public.stores AS store
  ON store.id = usage.store_id
LEFT JOIN public.billing_subscriptions AS subscription
  ON subscription.store_id = usage.store_id
CROSS JOIN LATERAL (
  SELECT max(
    date_trunc('milliseconds', store.created_at)
      + (series.n * interval '720 hours')
  ) AS starts_at
  FROM generate_series(0, 240) AS series(n)
  WHERE date_trunc('milliseconds', store.created_at)
          + (series.n * interval '720 hours') <= now()
) AS boundary
WHERE usage.period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
  AND usage.used > 0
  AND (
    subscription.current_period_start IS NULL
    OR subscription.current_period_start > now()
  )
  AND boundary.starts_at IS NOT NULL
  AND boundary.starts_at
      <= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
ON CONFLICT (store_id, period) DO UPDATE
SET used = greatest(public.ai_usage.used, EXCLUDED.used);

UPDATE public.help_articles SET body = replace(body,
  $old$Included credits refresh every 30 days, counted from the paid plan cycle start.$old$,
  $new$Included credits refresh every 30 days. On a paid plan the 30 days are counted from the start of your current plan cycle. A store with no paid plan cycle counts them from the day the store was created.$new$),
  updated_at = now()
WHERE slug = 'understand-ai-usage-and-credits' AND status = 'published'
  AND strpos(body, $old$Included credits refresh every 30 days, counted from the paid plan cycle start.$old$) > 0;
