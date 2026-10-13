-- Merchant-visible: a customer who replies STOP (or START, having agreed to
-- offers before) now gets an automatic WhatsApp reply confirming it, and the
-- conversation no longer lands in Needs reply or rings the bell, because the
-- system has already dealt with it. One sentence in the inbox guide's STOP
-- section is extended in place.
UPDATE public.help_articles
SET body = replace(
  body,
  $old$Order updates continue, because they are about that customer's own orders.$old$,
  $new$Order updates continue, because they are about that customer's own orders. The customer gets an automatic reply on WhatsApp confirming it, so the conversation does not wait for you in <strong>Needs reply</strong>.$new$
)
WHERE slug = 'reply-to-whatsapp-messages';
