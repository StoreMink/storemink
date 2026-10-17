-- Change background gains a soft shadow under the product and scenes (a
-- marble counter, linen, a beach) drawn empty by Mink AI with the real
-- product placed in them. The product-images guide's Change background step
-- is edited in place: two sentences, no new section.

UPDATE public.help_articles SET body=replace(body, $old$to put your product on white, a colour or a transparent background. Your product$old$, $new$to put your product on white, a colour, a transparent background or a scene such as a marble counter or linen. Your product$new$), updated_at=now() WHERE slug='add-product-images-and-variants' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$nothing is charged if no product can be found in the photo. A photo$old$, $new$nothing is charged if no product can be found in the photo. On white or a colour a soft shadow is added under the product; untick <strong>Soft shadow under the product</strong> to leave it out. Choose <strong>Scene</strong> to place the product in one of eight scenes: Mink AI draws only the empty scene, never your product. A new scene uses 5 Mink credits and is saved, so placing your other products in it is free and your photos match. Select <strong>Draw a new one</strong> to replace a saved scene. A photo$new$), updated_at=now() WHERE slug='add-product-images-and-variants' AND status='published';
