-- Website Builder: the Brand row's storefront layout gained the product page's
-- gallery style and blocks, the collection page's filters, paging and
-- promotional tiles, the blog's layouts and the account pages' navigation
-- and colour scheme (the page templates). The branding guide's one step that
-- lists what the layout options are is replaced in place (quoted at list-item
-- level; 0020 published it and no later migration touched the line).

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<li>Choose the available header, product-card, product-detail, cart, and footer layout options.</li>$old$,
      $new$<li>Choose the header, product-card, product-page, cart, and footer layouts, or keep the theme's own. Under <strong>Product page</strong> you can also pick the gallery style and the order of the blocks under the product name, and add a trust row, collapsible rows or a note of your own. Under <strong>Collection page</strong> you can choose where the filters sit, whether the grid loads more, turns pages or keeps scrolling, and add promotional tiles among the products. Under <strong>Blog</strong> you can list posts as a grid, a list or a featured post, and set how wide an article reads. Under <strong>Account pages</strong> you can add tabs or a side navigation to the profile, orders and notifications pages and give them a colour scheme.</li>$new$
    ),
    updated_at = now()
WHERE slug = 'change-your-storefront-branding-and-layout'
  AND status = 'published';
