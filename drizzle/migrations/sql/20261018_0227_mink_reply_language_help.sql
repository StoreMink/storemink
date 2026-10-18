-- The Reply language option is gone from the Mink AI chat menu (owner's
-- request, 2026-10-18): Mink answers in the language and script the merchant
-- writes or speaks in, so there is nothing to set. The Mink guide's one
-- sentence about the menu setting the reply language is replaced in place.

UPDATE public.help_articles SET body=replace(body, $old$Open Mink AI and choose Memories from the options menu in the chat header; the same menu sets the language Mink replies in.$old$, $new$Open Mink AI and choose Memories from the options menu in the chat header. Mink replies in the language you write or speak in, so there is no language to set.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
