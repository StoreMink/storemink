-- The Mink website guide's storefront redesign paragraphs (written by
-- 20261021_0235) after the robustness audit's second wave
-- (docs/mink-storefront-revamp.md sections 4.3, 8 and 11):
--   * a redesign is no longer cancelled when the chat reply that started it
--     is stopped or interrupted: lib/mink/persistence.ts failMinkRun keeps it
--     (queued, running or ready), saves its card to the chat, and the merchant
--     stops it with Stop on the card, which charges nothing before the card is
--     ready (B4). A reply already stopped never starts one (B6). The sentence
--     0235 published says the opposite, so it is replaced in place;
--   * a redesign's new photographs show the merchant's own products, drawn
--     from their own product photos, or a setting with no products at all,
--     never invented goods (B16: site-compiler.ts revampGoodsCatalogue,
--     photos.ts resolveShotGoods): the photographs clause says which;
--   * the ready notice opens the chat that holds the card (B20:
--     lib/mink/revamp/ready-notice.ts revampReadyUrl, app/dashboard/
--     chat-context.tsx), so the guide says a merchant may leave while it is
--     made and how they get back to it.
-- One statement, three replace() calls, each quoting one sentence or clause
-- that occurs once in the guide (checked against storemink_local's body),
-- and updated_at moves so the Help index re-embeds the guide. Nothing is
-- appended. A failed redesign giving its day's start back (B5) needs no
-- edit: the guide never states the daily limit.
--
-- A second statement corrects the general Mink guide
-- (use-mink-ai-in-your-dashboard, written by 20260830_0040 and kept by
-- 20260910_0093): its draft troubleshooting sentence says a failed or
-- stopped reply discards every unseen proposal and gives its credits back,
-- which B4 made untrue for a storefront redesign (failMinkRun keeps it and
-- its card, charged when a paid card is made). The one sentence is replaced
-- in place, in the merchant's words, linking to the website guide.
UPDATE public.help_articles
SET body = replace(
      replace(
        replace(
          body,
          $old$If Mink's reply is stopped or interrupted before the card appears, the redesign does not go ahead and uses no Mink credits; to start it, ask Mink again in a minute.$old$,
          $new$If Mink's reply is stopped or interrupted after the redesign has started, the redesign still goes ahead and its card stays in the chat. To stop it, use Stop on the card; a redesign stopped before its card is ready uses no Mink credits. If the reply stopped before the redesign started, ask Mink again.$new$
        ),
        $old$and one set of new photographs in place of the theme's photos.$old$,
        $new$and one set of new photographs in place of the theme's photos, showing your own products as they look in your product photos, or a setting with no products in it.$new$
      ),
      $old$A card in the chat shows the progress and, when the redesign is ready, a preview of every page on a phone and on a computer.$old$,
      $new$A card in the chat shows the progress and, when the redesign is ready, a preview of every page on a phone and on a computer. You can leave while it is being made: when it is ready, Mink AI tells you in your notifications, and opening that notification takes you to the chat with the card.$new$
    ),
    updated_at = now()
WHERE slug = 'manage-your-website-with-mink-ai' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$If the enclosing Mink run fails or is cancelled after creating a proposal, StoreMink discards the unseen proposal and restores its exact plan and purchased-credit amounts.$old$,
      $new$If Mink's reply fails or is stopped after it created a proposal, StoreMink discards the unseen proposal and restores its exact plan and purchased-credit amounts. A storefront redesign the reply started is the exception: it carries on, its card stays in the chat, and Stop on the card ends it (see <a href="/help/storefront/manage-your-website-with-mink-ai">Manage your website with Mink AI</a>).$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';
