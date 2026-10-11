-- No em dash in the Help Centre (owner's rule, 2026-10-11). The product's own
-- text dropped them in the same change (app/long-dash-coverage.test.ts); this
-- does the same for every Help article and category, published or draft,
-- including anything an operator wrote in the Help console.
--
-- One generic pass rather than a replace() per sentence: the dashes sit in
-- dozens of sentences across several guides, and quoting each one would make
-- this migration depend on the exact wording every earlier migration and every
-- console edit left behind. A pattern rewrite needs none of that, and running
-- it twice changes nothing.
--
-- In order, so each rule sees the text the one before it left:
--   1. A table cell holding only a dash is the "not included" mark in a plan
--      comparison. It becomes "-", the mark the dashboard uses.
--   2. A dash in a heading becomes a colon ("Bundles: any few items...").
--   3. A dash straight after bold text is a term and its definition
--      ("<strong>Payment method</strong>: for example...").
--   4. Every other dash becomes " - ", the dashboard's sentence form, so a
--      quoted button label still matches the button.
--
-- updated_at moves only on rows that change, which also re-indexes those
-- guides for Mink's help search on its next pass.

UPDATE public.help_articles
SET body = regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(body,
            '(<t[dh][^>]*>)\s*—\s*(</t[dh]>)', '\1-\2', 'g'),
          '(<h[1-6][^>]*>[^<—]*[^<—\s])\s*—\s*', '\1: ', 'g'),
        '</strong>\s*—\s*', '</strong>: ', 'g'),
      '\s*—\s*', ' - ', 'g'),
    title = regexp_replace(title, '\s*—\s*', ' - ', 'g'),
    excerpt = regexp_replace(excerpt, '\s*—\s*', ' - ', 'g'),
    seo_title = regexp_replace(seo_title, '\s*—\s*', ' - ', 'g'),
    seo_description = regexp_replace(seo_description, '\s*—\s*', ' - ', 'g'),
    updated_at = now()
WHERE coalesce(body, '') LIKE '%—%'
   OR title LIKE '%—%'
   OR coalesce(excerpt, '') LIKE '%—%'
   OR coalesce(seo_title, '') LIKE '%—%'
   OR coalesce(seo_description, '') LIKE '%—%';

UPDATE public.help_categories
SET title = regexp_replace(title, '\s*—\s*', ' - ', 'g'),
    description = regexp_replace(description, '\s*—\s*', ' - ', 'g'),
    updated_at = now()
WHERE title LIKE '%—%'
   OR coalesce(description, '') LIKE '%—%';
