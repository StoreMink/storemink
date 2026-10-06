-- Product images: state the size the storefront shows, and how Refine with
-- Mink AI works. Edits the existing upload steps in place.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$<li>Upload the primary image used as the storefront thumbnail.</li>$old$,
  $new$<li>Upload the primary image used as the storefront thumbnail. Product cards show it edge to edge in a 3:4 portrait frame, so a photo of <strong>1200 × 1600 px</strong> fits exactly. If your photos are square, choose <strong>Square</strong> under <strong>Website Builder → Brand → Storefront layout → Card photo shape</strong>; the frame and the recommended size become 1200 × 1200 px. The editor shows the size under the upload box and warns when a photo will be cropped or is too small.</li>$new$),
  $old$<li>Upload any extra gallery images.</li>$old$,
  $new$<li>Upload any extra gallery images.</li><li>Optional: select <strong>Refine with Mink AI</strong> under an uploaded photo. Mink AI retouches the lighting and background and returns a copy at exactly the size shown under the upload box. It uses 3 Mink credits, taken only when a refined photo comes back. Compare the original and the refined photo, then choose <strong>Use refined photo</strong> or <strong>Keep original</strong>. Check that the product looks exactly like the real item, because a retouch can change small details. The refined copy is also saved in your Media Library. Refining needs Media manage permission.</li>$new$),
  updated_at = now()
WHERE slug = 'add-product-images-and-variants' AND status = 'published';
