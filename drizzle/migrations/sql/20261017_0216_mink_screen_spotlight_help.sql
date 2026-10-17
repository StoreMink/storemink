-- Mink AI guide: three sentences edited in place for the second Sidekick
-- parity pass. No schema change.
--
-- "Saying remember this does not save anything" stopped being true with the
-- Remember this? card (0215's work shipped it without this edit); the
-- open-a-page item gained pointing at a control and prefilled forms; and the
-- chat-header menu that holds Memories now also sets the reply language.

UPDATE public.help_articles SET body=replace(body, $old$Saying &quot;remember this&quot; in chat does not save anything; Mink directs you to these controls.$old$, $new$When something you write reads as a lasting preference or a fact about your business, Mink offers a <strong>Remember this?</strong> card under its answer showing the exact sentence it would keep; <strong>Save</strong> keeps it for 90 days under the same rules as a memory added here, and <strong>Not now</strong> discards it.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$<li>Open a dashboard page for me, such as a product, an order or Inventory.</li>$old$, $new$<li>Open a dashboard page for me, such as a product, an order or Inventory; show me where a control is, so the page opens with that control pointed out; or open a form (a new product, offer, category or blog post, or delivery settings) already filled in from our conversation, which you review and save yourself.</li>$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$Open Mink AI and choose Memories in the chat header.$old$, $new$Open Mink AI and choose Memories from the options menu in the chat header; the same menu sets the language Mink replies in.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
