-- Saved custom reports ("explorations"), Basic and above. A report is a name
-- plus a config the server re-validates on every read (dataset, measures,
-- grouping, chart), never SQL: see lib/analytics/explore.ts. Store-wide, so
-- everyone with Analytics access can open it; saving needs Analytics manage.

CREATE TABLE public.analytics_saved_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  name        text NOT NULL,
  config      jsonb NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_saved_reports_name_check CHECK (length(name) BETWEEN 1 AND 80),
  CONSTRAINT analytics_saved_reports_config_check CHECK (
    jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 2048
  ),
  CONSTRAINT analytics_saved_reports_store_name_key UNIQUE (store_id, name)
);

ALTER TABLE public.analytics_saved_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analytics_saved_reports FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.analytics_saved_reports TO app_service;
