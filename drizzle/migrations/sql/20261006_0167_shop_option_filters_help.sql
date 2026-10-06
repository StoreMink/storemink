-- Shop filters: categories, product options (Size, Colour) and per-value
-- counts, in a sidebar on larger screens. Edits the existing sentences in
-- place.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$Select Filter to choose <strong>In stock only</strong> or a minimum and maximum price, review the matching product count, then press the button showing that count to apply your choices. On a phone the same controls open in a panel at the bottom of the screen.$old$,
  $new$On a computer the filters sit in a column beside the products and apply as soon as a shopper ticks one; on a phone or tablet, select <strong>Filter</strong>, make choices, then press the button showing the matching product count. Shoppers can filter by <strong>Category</strong> (on the full shop and search results), <strong>In stock only</strong>, price, and your product options such as <strong>Size</strong> and <strong>Colour</strong>. Each choice shows how many products it would leave, and a choice that would leave none is greyed out. Size and Colour filters come from the options you set on each product, so give products options (for example Size: S, M, L) for them to appear; colour swatches use the colours you set for each value. A size or colour filter matches only products with a variant in that option that can be bought, so "M" with In stock only shows products whose M is in stock.$new$),
  $old$Clear that filter and any price limits when checking whether a published product is missing.$old$,
  $new$Clear all filters when checking whether a published product is missing.$new$),
  updated_at = now()
WHERE slug = 'publish-feature-and-improve-a-product-for-search'
  AND status = 'published';
