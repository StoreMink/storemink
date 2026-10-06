-- Refine with Mink AI costs 2 Mink credits. Edits the one sentence in place.
UPDATE public.help_articles
SET body = replace(body,
  $old$It uses 3 Mink credits, taken only when a refined photo comes back.$old$,
  $new$It uses 2 Mink credits, taken only when a refined photo comes back.$new$),
  updated_at = now()
WHERE slug = 'add-product-images-and-variants' AND status = 'published';
