-- Website Builder sections hold blocks (slides, tiles, items, stories, rows)
-- under one shared block list, and nine sections joined the library:
-- collapsible content, a comparison table, multi-column, image marquee, image
-- with hotspots, before and after, product spotlight, logo strip and
-- countdown. Media with text can carry further stories and a tile grid can be
-- a collage. The section guide's list of types is the one place a merchant
-- reads what can be added, so the sentence is replaced in place (quoted at
-- sentence level: 0135 appended a paragraph after it and left the sentence
-- itself untouched) and one paragraph on blocks follows it.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>You can add a hero, hero carousel, featured products, shop by category, promotional banner, tile grid, media with text, gallery, testimonials, video, newsletter form, USP bar, ticker, FAQ accordion, latest blogs, rich text, or custom code.</p>$old$,
      $new$<p>You can add a hero, hero carousel, featured products, shop by category, promotional banner, tile grid, media with text, gallery, testimonials, video, newsletter form, USP bar, ticker, FAQ accordion, collapsible content, comparison table, multi-column, image marquee, image with hotspots, before and after, product spotlight, logo strip, countdown, latest blogs, rich text, or custom code.</p>
<p>Some sections are built from blocks you add one at a time: slides, tiles, items, stories, rows or hotspots. Each block has its own settings under the section, and you can reorder or remove a block without touching the others. Media with text can carry extra stories, which alternate the image side down the page. Collapsible content holds rows a shopper opens as needed, such as shipping, care or sizing, and a row can show a picture. A comparison table puts two to four products, sizes or plans side by side, feature by feature, as a table or as cards. An image with hotspots is one picture with dots that open a note and a link to what is in it. A product spotlight shows one product large, with its photo, name and price from your catalogue beside your own words. A countdown counts to the moment you set and shows your message once it passes. A tile grid can be arranged as a collage, where a tile may cover two cells across or down.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'add-and-arrange-storefront-sections'
  AND status = 'published';
