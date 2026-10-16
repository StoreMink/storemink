-- Move the timestamp on the three WhatsApp guides whose bodies were edited
-- without it, so the Help index re-embeds them.
--
-- lib/help/embedding-worker.ts re-embeds a guide only when
-- help_articles.updated_at no longer matches the chunks it holds
-- (help_article_chunks.source_updated_at). Eight Help edits since the index
-- existed rewrote a body with replace() and left updated_at alone (0178,
-- 0193, 0194, 0196, 0198, 0200, 0201 and 0203), so the public Help
-- assistant and the dashboard's Help tool kept answering from the wording
-- those edits replaced. Verified on staging on 2026-10-14: the new sections
-- were in the bodies and the timestamps still read 11 and 13 October.
--
-- Bodies are not touched. From here on help:lint refuses a statement that
-- writes a body without moving the timestamp (rule index-timestamp).
update public.help_articles
   set updated_at = now()
 where slug in (
   'send-order-updates-on-whatsapp',
   'reply-to-whatsapp-messages',
   'set-up-whatsapp-automatic-replies'
 );
