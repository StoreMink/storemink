-- Analytics targets (Basic and above): a store-wide goal for one metric over
-- a fixed period, shown as a progress card on the Analytics dashboard.
--
-- Periods are store-local calendar dates, inclusive at both ends, so a target
-- for "October" means 1 Oct to 31 Oct in the store's business time zone no
-- matter when it is viewed. Progress is computed on read from the same
-- definitions as the dashboard cards; nothing here caches a value.

CREATE TABLE public.analytics_targets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  metric        text NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  target_value  numeric NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_targets_metric_check CHECK (
    metric IN ('total_sales', 'orders', 'average_order_value', 'new_customers', 'sessions', 'conversion_rate')
  ),
  CONSTRAINT analytics_targets_period_check CHECK (
    period_end >= period_start AND period_end - period_start <= 731
  ),
  CONSTRAINT analytics_targets_value_check CHECK (target_value > 0)
);

CREATE INDEX analytics_targets_store_period_idx
  ON public.analytics_targets (store_id, period_end DESC);

ALTER TABLE public.analytics_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analytics_targets FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.analytics_targets TO app_service;
