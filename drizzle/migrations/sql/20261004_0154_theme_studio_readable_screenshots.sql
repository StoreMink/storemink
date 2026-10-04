-- Full-page QA evidence preserves native phone width. The older 4096px
-- asset-height constraint required shrinking long pages into unreadable strips.
-- Only QA sources may be tall or PNG; storefront artwork retains its limits.
ALTER TABLE public.theme_studio_assets
  DROP CONSTRAINT theme_studio_assets_media_type_check;
ALTER TABLE public.theme_studio_assets
  ADD CONSTRAINT theme_studio_assets_media_type_check
  CHECK (media_type = 'image/webp'
         OR (purpose = 'qa_screenshot' AND media_type = 'image/png'));

ALTER TABLE public.theme_studio_assets
  DROP CONSTRAINT theme_studio_assets_dimensions_check;
ALTER TABLE public.theme_studio_assets
  ADD CONSTRAINT theme_studio_assets_dimensions_check
  CHECK ((purpose = 'qa_screenshot'
          AND width BETWEEN 1 AND 1440 AND height BETWEEN 1 AND 100000
          AND width::bigint * height <= 50000000)
         OR (purpose <> 'qa_screenshot'
             AND width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096));
