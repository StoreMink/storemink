-- Storefront traffic by device, source and approximate location (Pro).
--
-- Raw events gain session-attribution columns. All are nullable and filled
-- only for visitors who allowed analytics; nothing here stores an IP address,
-- a user agent or a full referring URL:
--   device_type   derived on the server from the user agent, which is then
--                 discarded (desktop / mobile / tablet)
--   source        the traffic channel the server classified the visit as
--   referrer_host the referring site's host name only
--   utm_*         campaign tags from the landing URL, length-capped
--   country/region/city  the approximate location the load balancer reports
--                 for the connection (ISO country, ISO subdivision, city)
--
-- storefront_daily_dimensions is the durable, non-identifying reporting
-- surface, rebuilt by the hourly rollup alongside storefront_daily and capped
-- at the top 50 keys per store, day and dimension.

ALTER TABLE public.storefront_events
  ADD COLUMN device_type text,
  ADD COLUMN source text,
  ADD COLUMN referrer_host text,
  ADD COLUMN utm_source text,
  ADD COLUMN utm_medium text,
  ADD COLUMN utm_campaign text,
  ADD COLUMN country text,
  ADD COLUMN region text,
  ADD COLUMN city text;

ALTER TABLE public.storefront_events
  ADD CONSTRAINT storefront_events_device_check CHECK (
    device_type IS NULL OR device_type IN ('desktop', 'mobile', 'tablet')
  ),
  ADD CONSTRAINT storefront_events_source_check CHECK (
    source IS NULL OR source IN ('direct', 'search', 'social', 'email', 'paid', 'referral')
  ),
  ADD CONSTRAINT storefront_events_attribution_length_check CHECK (
    (referrer_host IS NULL OR length(referrer_host) <= 255) AND
    (utm_source IS NULL OR length(utm_source) <= 100) AND
    (utm_medium IS NULL OR length(utm_medium) <= 100) AND
    (utm_campaign IS NULL OR length(utm_campaign) <= 100) AND
    (country IS NULL OR length(country) = 2) AND
    (region IS NULL OR length(region) <= 16) AND
    (city IS NULL OR length(city) <= 100)
  );

CREATE TABLE public.storefront_daily_dimensions (
  store_id           uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  date               date NOT NULL,
  dimension          text NOT NULL,
  key                text NOT NULL,
  sessions           integer NOT NULL DEFAULT 0,
  visitors           integer NOT NULL DEFAULT 0,
  page_views         integer NOT NULL DEFAULT 0,
  converted_sessions integer NOT NULL DEFAULT 0,
  sales              numeric NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, date, dimension, key),
  CONSTRAINT storefront_daily_dimensions_dimension_check CHECK (
    dimension IN ('device', 'source', 'referrer', 'landing_page', 'campaign', 'country', 'region', 'city')
  ),
  CONSTRAINT storefront_daily_dimensions_key_check CHECK (length(key) BETWEEN 1 AND 512),
  CONSTRAINT storefront_daily_dimensions_nonnegative CHECK (
    sessions >= 0 AND visitors >= 0 AND page_views >= 0 AND
    converted_sessions >= 0 AND sales >= 0
  )
);

CREATE INDEX storefront_daily_dimensions_store_dimension_idx
  ON public.storefront_daily_dimensions (store_id, dimension, date);

ALTER TABLE public.storefront_daily_dimensions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.storefront_daily_dimensions FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storefront_daily_dimensions TO app_service;

-- Help: what first-party measurement records now includes device, source and
-- approximate location, and the guide explains the new traffic cards. Each
-- replace() quotes one sentence or heading published by 0011.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$After a visitor allows analytics in the storefront privacy choices, StoreMink records page views and the ordered shopping steps: product viewed, item added to cart, checkout started, and purchase completed.$old$,
  $new$After a visitor allows analytics in the storefront privacy choices, StoreMink records page views and the ordered shopping steps: product viewed, item added to cart, checkout started, and purchase completed. For each visit it also records the type of device (desktop, mobile or tablet), the website that sent the visitor and any campaign tags in the link they followed, and their approximate location (country, state and city) as reported by the network. StoreMink does not store the visitor's IP address, the full address of the page that referred them, or their browser details.$new$),
  $old$<h2>Conversion funnel</h2>$old$,
  $new$<h2>Where visitors come from</h2><p>Each session is credited to the way it started:</p><ul><li><strong>Direct</strong>: the visitor typed your address, used a bookmark, or the link did not say where it came from.</li><li><strong>Search</strong>: a search engine such as Google or Bing.</li><li><strong>Social</strong>: a social app or site such as Instagram, Facebook, WhatsApp or YouTube.</li><li><strong>Email</strong>: a link tagged as email, or from an email service.</li><li><strong>Paid</strong>: a link tagged as a paid ad, for example with <strong>utm_medium=cpc</strong>.</li><li><strong>Referral</strong>: any other website that linked to your store.</li></ul><p>To see your own campaigns by name, add <strong>utm_source</strong>, <strong>utm_medium</strong> and <strong>utm_campaign</strong> to the links you share. The landing page is the first page of the session. Sales by source counts orders attributed to a session that started from that source.</p><h2>Conversion funnel</h2>$new$),
  updated_at = now()
WHERE slug = 'understand-storefront-conversion-analytics' AND status = 'published';
