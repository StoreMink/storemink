-- Card colours are retired from the product editor and the dashboard: every
-- product card style paints its own background, so the shade changed nothing.
-- Removes the steps that told merchants to create and assign one, in place.
-- The article keeps its slug so existing links still resolve.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$<h2>Create a card colour</h2>
<ol><li>Open <strong>Products → Colours</strong>.</li><li>Add a clear internal name and choose the colour value.</li><li>Save it.</li></ol>
$old$, ''),
  $old$<li>On <strong>Visibility</strong>, choose the optional card colour.</li>$old$, ''),
  title = 'Organise products with categories',
  excerpt = 'Create reusable catalogue categories, then assign them to products.',
  seo_title = 'Organise StoreMink products with categories',
  seo_description = 'Create StoreMink product categories, assign them in the product editor, and understand handles and CSV matching.',
  updated_at = now()
WHERE slug = 'organize-products-with-categories-and-card-colours' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
  $old$<li>Open <strong>Visibility</strong> and choose an optional product-card colour.</li>$old$, ''),
  seo_description = 'Publish and feature a StoreMink product, assign its category, write SEO details, and troubleshoot missing storefront products.',
  updated_at = now()
WHERE slug = 'publish-feature-and-improve-a-product-for-search' AND status = 'published';
