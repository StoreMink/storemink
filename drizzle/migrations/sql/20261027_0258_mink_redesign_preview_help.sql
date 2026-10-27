-- Edit the redesign task in place. Preview is read only until the final
-- checks finish; photos may be shared between pages, not invented goods.
UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        $old$A card in the chat shows the progress and, when the redesign is ready, a preview of every page on a phone and on a computer. You can leave while it is being made: when it is ready, Mink AI tells you in your notifications, and opening that notification takes you to the chat with the card.$old$,
        $new$A card in the chat shows the progress. Choose Preview design when the layout, words and colours are prepared to see every page on a phone and on a computer. Frames marked Photo on its way fill as photographs pass their checks. Previewing does not change your store: Apply to Website Builder draft becomes available only when the redesign and its required checks are finished. You can leave while it is being made: when it is ready, Mink AI tells you in your notifications, and opening that notification takes you to the chat with the card. If the photo service cannot finish the required work, the card explains what happened and you are not charged.$new$
      ),
      $old$and one set of new photographs in place of the theme's photos, showing your own products as they look in your product photos, or a setting with no products in it.$old$,
      $new$and a coordinated set of new photographs in place of the theme's photos, showing your own products as they look in your product photos, or a setting with no products in it. Suitable photographs can be shared between different pages and cropped to fit a phone or computer. New products use the photographs you supplied; ask Mink separately when you want a studio photograph. The finished card lists any photographs that could not be completed.$new$
    ),
    updated_at = now()
WHERE slug = 'manage-your-website-with-mink-ai' AND status = 'published';
