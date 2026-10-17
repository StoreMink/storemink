-- Mink AI can now make a catalogue product photo (owner's decision,
-- 2026-10-17): a clean studio shot of an existing item, grounded in a real
-- photo of it, proposed as the product's photo for approval. Campaign art is
-- still never a product photo. Four sentences edited in place; no schema
-- change.

UPDATE public.help_articles SET body=replace(body, $old$The result is AI-generated storefront artwork, not the original catalogue photograph, and Mink cannot replace a product's saved images with it.$old$, $new$A hero, banner, gallery, feature or blog-cover picture is AI-generated storefront artwork, not a catalogue photograph, and Mink cannot replace a product's saved images with it. A catalogue product photo is different: ask for one and Mink makes a clean studio shot from a real photo of the item (the product's existing photo or one you attach), never from a description alone, and proposes it as the product's photo for your approval.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$To replace a product photo, attach your own image and name the product.$old$, $new$To replace a product photo, attach your own image and name the product, or ask Mink for a new catalogue photo of a product that already has one.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$automatically prepares a square Media copy when its shape does not suit a product card$old$, $new$automatically prepares a Media copy in the shape of your product cards when its shape does not suit them$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';

UPDATE public.help_articles SET body=replace(body, $old$It uses 2 Mink credits, taken only when a refined photo comes back.$old$, $new$It uses 2 Mink credits, taken only when a refined photo comes back. In the Mink AI chat you can also ask for a new catalogue photo of a product: Mink makes it from the product's existing photo, keeps it under Media and proposes it as the product's photo for your approval (3 Mink credits for the picture and 1 for the photo change).$new$), updated_at=now() WHERE slug='add-product-images-and-variants' AND status='published';
