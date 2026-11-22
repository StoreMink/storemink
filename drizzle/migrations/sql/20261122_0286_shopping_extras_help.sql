-- Help: the three shopping extras a store has, and where to switch one off
-- (22 Nov 2026).
--
-- Every storefront shows three things a shopper can use, unless the merchant
-- switches one off in the Website Builder's Brand row, under Shopping extras:
--
--   * Saved items: a heart on every product card and on the product page,
--     and a Saved items page in the account menu. The list is kept on the
--     shopper's own device, so it needs no sign-in.
--   * Recently viewed: under a product, the products that shopper looked at
--     before.
--   * Our stores: a page listing the store's shop locations with their
--     addresses and a directions link, linked from the footer once the store
--     has a shop location. A warehouse is never listed.
--
-- The branding and layout guide's builder steps listed every other choice in
-- the Brand row and not these. One step is added to that list in place.
--
-- Content only; no schema changes.

UPDATE public.help_articles SET body = replace(body,
  $old$give them a colour scheme.</li><li>Preview desktop, tablet, and mobile widths.</li>$old$,
  $new$give them a colour scheme.</li><li>Under <strong>Shopping extras</strong>, keep or switch off three things your shoppers see. <strong>Saved items</strong> puts a heart on every product so a shopper can keep it for later; their list stays on their own device and needs no sign-in. <strong>Recently viewed</strong> shows, under a product, the products that shopper looked at before. <strong>Our stores page</strong> lists your shop locations with their addresses and a directions link, and is linked from the footer once you have a shop location; a warehouse is never listed.</li><li>Preview desktop, tablet, and mobile widths.</li>$new$),
  updated_at = now()
WHERE slug = 'change-your-storefront-branding-and-layout' AND status = 'published'
  AND strpos(body, $old$give them a colour scheme.</li><li>Preview desktop, tablet, and mobile widths.</li>$old$) > 0
  AND strpos(body, 'Under <strong>Shopping extras</strong>') = 0;
