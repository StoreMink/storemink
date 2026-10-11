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

-- The header gained an announcement bar (one line above the header, with an
-- optional link; empty text shows the theme's own). The navigation guide's
-- one step that lists what the header row edits is replaced in place (0020
-- published it; 0138 added the sentence AFTER it in the same list item, so
-- the quote is the sentence alone, which 0138 left untouched).

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<li>Edit the menu links, labels, logo treatment, layout, and available contact or social details.</li>$old$,
      $new$<li>Edit the menu links, labels, logo treatment, layout, and available contact or social details. Under <strong>Announcement bar</strong>, switch on a one-line message above the header on every page, such as a delivery promise or a sale, with an optional link; leave the text empty to show your theme's own announcement, when it has one.</li>$new$
    ),
    updated_at = now()
WHERE slug = 'edit-your-header-footer-and-navigation'
  AND status = 'published';
