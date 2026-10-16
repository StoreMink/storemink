-- Where a Media Library row came from, so the Library can stop listing the
-- photos a merchant attached to a Mink AI chat (lib/media/sources.ts).
--
-- ★★ THE ROWS STAY. Mink's ownership checks accept an image because a
--    media_assets row says this store owns it, so a chat attachment without
--    its row could no longer become a product photo or a banner. This only
--    labels rows; the Library page decides what to list.
--
-- Additive: the old revision inserts without `source` and gets 'upload',
-- which is what every row it writes was until now.

ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'upload';

ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS media_assets_source_check;
ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_source_check
  CHECK (source = ANY (ARRAY[
    'upload'::text,
    'mink_attachment'::text,
    'mink_generated'::text,
    'mink_refined'::text,
    'mink_prepared'::text
  ]));

-- Backfill by object path: each Mink writer has always used its own folder.
UPDATE public.media_assets
SET source = 'mink_generated'
WHERE source = 'upload' AND path LIKE 'stores/%/mink-generated/%';

UPDATE public.media_assets
SET source = 'mink_refined'
WHERE source = 'upload' AND path LIKE 'stores/%/refined/%';

UPDATE public.media_assets
SET source = 'mink_prepared'
WHERE source = 'upload' AND path LIKE 'stores/%/media/mink-prepared/%';

-- A chat attachment was uploaded to the same folder as a Library upload, so
-- the path cannot tell them apart. The sent message can: the composer appends
-- a fixed marker and the saved image as JSON (addSavedMinkMediaReference in
-- lib/mink/media-attachment.ts). Matching the marker and the exact "url" key,
-- not the bare URL, keeps a Library image the merchant merely pasted into a
-- message listed. Conversations already pruned leave their attachments listed,
-- which is the old behaviour.
UPDATE public.media_assets ma
SET source = 'mink_attachment'
WHERE ma.source = 'upload'
  AND EXISTS (
    SELECT 1
    FROM public.mink_messages m
    WHERE m.store_id = ma.store_id
      AND m.role = 'user'
      AND strpos(m.content_json ->> 'text', 'Saved to the store''s Media Library') > 0
      AND strpos(m.content_json ->> 'text', '"url":"' || ma.url || '"') > 0
  );
