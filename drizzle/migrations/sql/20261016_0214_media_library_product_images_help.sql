-- Media Library: the Library tab no longer lists Mink chat attachments, a new
-- Product images tab lists every photo products use, an image a product uses
-- cannot be deleted, and the product editor's add-image controls ask whether
-- the photo comes from the computer or the Media Library. Each sentence is
-- edited in place.

-- The Media guide: what each tab shows, picking from the product editor, and
-- the delete rule.
UPDATE public.help_articles
SET body = replace(replace(replace(body,
  $old$<li>Copy the media URL or select the asset from an editor that supports the media library.</li>$old$,
  $new$<li>Copy the image URL, or pick the image straight from the product editor: select the image box and choose <strong>Choose from Media Library</strong>.</li>$new$),
  $old$<h2>How files are handled</h2>$old$,
  $new$<h2>What the library shows</h2>
<p>The <strong>Library</strong> tab lists the images you uploaded here and the pictures Mink AI made or refined for you. Photos you attach to a Mink AI chat are not listed here, although Mink can still use them for what you asked. The <strong>Product images</strong> tab lists every photo your products use, including variant and colour photos, and names the products that use each one. Open a product from there to change or remove its photos.</p>
<h2>How files are handled</h2>$new$),
  $old$<p>Before deleting an asset, remove it from products, pages, branding, blog posts, or other content that still uses its URL. Deleting a library record does not automatically rewrite every place where the URL was pasted.</p>$old$,
  $new$<p>An image that a product still uses cannot be deleted: the library names those products, so remove the image from them first. Before deleting any other image, remove it from pages, branding, blog posts, or other content that still uses its URL, because deleting does not rewrite the places where the URL was pasted.</p>$new$),
  updated_at = now()
WHERE slug = 'upload-and-manage-store-media' AND status = 'published';

-- The product images guide: picking an existing photo, and what removing one
-- does to a library photo.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$<li>Upload any extra gallery images.</li>$old$,
  $new$<li>Upload any extra gallery images.</li><li>Selecting an image box asks where the photo comes from: <strong>Upload from computer</strong>, or <strong>Choose from Media Library</strong> to use a photo you already have. The library lists your Media Library and the photos your other products use; for the gallery you can pick several at once. Variant and colour photos offer the same choice.</li>$new$),
  $old$<li>Remove an image that should no longer appear, then save the product.</li>$old$,
  $new$<li>Remove an image that should no longer appear, then save the product. A photo that came from your Media Library, or that another product also uses, stays where it is.</li>$new$),
  updated_at = now()
WHERE slug = 'add-product-images-and-variants' AND status = 'published';

-- The Mink guide: an attached image is kept for the request but is not listed
-- in the Library.
UPDATE public.help_articles
SET body = replace(body,
  $old$remove its preview before sending if you do not want to keep it.$old$,
  $new$remove its preview before sending if you do not want to keep it. Attached images are not listed in your Media Library; pictures Mink creates for you are.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';
