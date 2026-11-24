-- Help: Quick view joins the Shopping extras a merchant can keep or switch
-- off (22 Nov 2026).
--
-- Every storefront shows an eye on each product photo unless the merchant
-- switches it off in the Website Builder's Brand row, under Shopping extras.
-- It opens the product over the page the shopper is on: its photos, price,
-- the size and colour choices and Add to cart.
--
-- The branding and layout guide's Shopping extras step named three things.
-- That step is edited in place to name four.
--
-- Content only; no schema changes.

UPDATE public.help_articles SET body = replace(replace(body,
  $old$keep or switch off three things your shoppers see.$old$,
  $new$keep or switch off four things your shoppers see.$new$),
  $old$their list stays on their own device and needs no sign-in. <strong>Recently viewed</strong>$old$,
  $new$their list stays on their own device and needs no sign-in. <strong>Quick view</strong> puts an eye on every product photo; it opens the product in a pop-up where a shopper can see its photos, pick a size or colour and add it to the cart without leaving the page. <strong>Recently viewed</strong>$new$),
  updated_at = now()
WHERE slug = 'change-your-storefront-branding-and-layout' AND status = 'published'
  AND strpos(body, $old$keep or switch off three things your shoppers see.$old$) > 0
  AND strpos(body, $old$their list stays on their own device and needs no sign-in. <strong>Recently viewed</strong>$old$) > 0
  AND strpos(body, '<strong>Quick view</strong>') = 0;
