-- A merchant's store no longer gets a theme's sample products and categories:
-- choosing a theme adds none, its menus and page buttons leave out links to
-- them, and switching themes removes the previous theme's untouched samples
-- instead of swapping in new ones. A Mink AI storefront redesign's header,
-- footer and announcement bar now link only to pages it writes and the
-- store's own pages, never to a theme page left in the theme's own words.
-- Two guides are edited sentence by sentence where they are now wrong;
-- nothing is appended. No schema changes.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$If your store has no products or categories, has never taken an order, and has no header and footer set in the Website Builder, the theme adds its sample products and categories as examples and sets up your header and footer menus. The sample products are drafts, so customers don't see them.$old$,
  $new$No sample products or categories are added, so your dashboard shows only the products and categories you add. Unless your header and footer are set in the Website Builder, the theme sets up your header and footer menus, without links to products or categories your store doesn't have.$new$),
  $old$While your catalogue holds only the theme's sample products, they are swapped for the new theme's samples, which stay drafts. Products and categories you added are never changed.$old$,
  $new$If your catalogue still holds nothing but your previous theme's untouched sample products and categories, and your store has never taken an order, they are removed and the new theme adds none. Products and categories you added or changed are never touched.$new$),
  updated_at = now()
WHERE slug = 'change-your-storefront-theme' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
  $old$a new header, footer and menus,$old$,
  $new$a new header, footer and menus that lead only to pages it writes and your own pages, categories and products,$new$),
  updated_at = now()
WHERE slug = 'manage-your-website-with-mink-ai' AND status = 'published';
