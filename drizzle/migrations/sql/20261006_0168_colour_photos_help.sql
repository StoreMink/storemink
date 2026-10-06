-- Photos per colour, photo tiles on the product page, and one shop-grid card
-- per colour. Edits the existing colour step and shopper paragraph in place.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$<li>For a colour option, tick <strong>Show as colour swatches on the storefront</strong> and pick the colour for each value.</li>$old$,
  $new$<li>For a colour option, tick <strong>Show as colour swatches on the storefront</strong> and pick the colour for each value. Under <strong>Photos for each colour</strong>, add photos for each colour once; every size of that colour uses them, and the first photo is the one on product cards. A photo added to a single variant still takes priority for that variant.</li>$new$),
  $old$Shoppers choose each option separately on the product page.$old$,
  $new$Shoppers choose each option separately on the product page; a colour with its own photos is shown as a small photo, and picking it shows that colour's photos. Product cards show a row of the product's colours. To show each colour as its own card in the shop, as many fashion stores do, choose <strong>One card per colour</strong> under <strong>Website Builder → Brand → Storefront layout → Colours in the shop grid</strong>; it applies to products with photos for each colour.$new$),
  updated_at = now()
WHERE slug = 'add-product-images-and-variants' AND status = 'published';
