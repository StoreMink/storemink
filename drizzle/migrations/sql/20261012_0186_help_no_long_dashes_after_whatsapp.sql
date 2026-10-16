-- The 0184 em dash rewrite, again, for Help copy that reaches a database after
-- it. 20261008_0176_whatsapp_notify_help publishes "Send order updates on
-- WhatsApp" with one em dash ("cannot deliver, for example when ..."), and it
-- was merged from the whatsapp branch after 0184:
--
--   * staging (dev's database) applied 0176 BEFORE 0184, so 0184 already
--     rewrote it there and this finds nothing to change;
--   * production applies 0176 AFTER 0184, so the dash would stay published
--     without this.
--
-- 0176 cannot be edited instead: staging recorded its checksum, so it is
-- grandfathered in help-content-lint.mjs (GRANDFATHERED_LONG_DASH).
--
-- Same rules, same order and same idempotence as 0184; read that file for why
-- each one exists. The dash is written as chr(8212) so this file, like every
-- Help migration after 0184, holds none itself.

UPDATE public.help_articles
SET body = regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(body,
            '(<t[dh][^>]*>)\s*' || chr(8212) || '\s*(</t[dh]>)', '\1-\2', 'g'),
          '(<h[1-6][^>]*>[^<' || chr(8212) || ']*[^<' || chr(8212) || '\s])\s*' || chr(8212) || '\s*', '\1: ', 'g'),
        '</strong>\s*' || chr(8212) || '\s*', '</strong>: ', 'g'),
      '\s*' || chr(8212) || '\s*', ' - ', 'g'),
    title = regexp_replace(title, '\s*' || chr(8212) || '\s*', ' - ', 'g'),
    excerpt = regexp_replace(excerpt, '\s*' || chr(8212) || '\s*', ' - ', 'g'),
    seo_title = regexp_replace(seo_title, '\s*' || chr(8212) || '\s*', ' - ', 'g'),
    seo_description = regexp_replace(seo_description, '\s*' || chr(8212) || '\s*', ' - ', 'g'),
    updated_at = now()
WHERE strpos(coalesce(body, ''), chr(8212)) > 0
   OR strpos(title, chr(8212)) > 0
   OR strpos(coalesce(excerpt, ''), chr(8212)) > 0
   OR strpos(coalesce(seo_title, ''), chr(8212)) > 0
   OR strpos(coalesce(seo_description, ''), chr(8212)) > 0;

UPDATE public.help_categories
SET title = regexp_replace(title, '\s*' || chr(8212) || '\s*', ' - ', 'g'),
    description = regexp_replace(description, '\s*' || chr(8212) || '\s*', ' - ', 'g'),
    updated_at = now()
WHERE strpos(title, chr(8212)) > 0
   OR strpos(coalesce(description, ''), chr(8212)) > 0;
