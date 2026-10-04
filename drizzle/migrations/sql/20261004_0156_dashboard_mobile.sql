-- Edit the existing task guidance in place for the phone dashboard flows.
UPDATE public.help_articles
SET body = replace(body,
  $old$<li>Open the row to see products, totals, payment, fulfilment, refund, and customer details.</li>$old$,
  $new$<li>Open the order reference or row to see products, totals, payment, fulfilment, refund, and customer details. On a phone, orders appear as labelled cards and details open in a full-screen panel. Close the panel to return to the list. Search and filters remain above the cards; swipe the status strip to reach more filters.</li>$new$),
  updated_at = now()
WHERE slug = 'manage-website-and-pos-orders' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
  $old$<li>Choose the homepage or another page from the page list.</li><li>Select a section in the preview to edit its content and design.</li>$old$,
  $new$<li>Choose the homepage or another page from the page list. On a phone, open <strong>Pages &amp; sections</strong> to choose a page, add a section, or select the header, footer, or brand.</li><li>Select a section in the outline or preview to edit its content and design. On a phone, <strong>Edit</strong> shows the selected settings and <strong>Preview</strong> shows the page. Switching these panels keeps your draft changes.</li>$new$),
  updated_at = now()
WHERE slug = 'use-the-storemink-website-builder' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
  $old$<li>Enter the title, summary, author, cover image, categories, and tags.</li><li>Write the post with headings, links, lists, images, and other editor tools.</li>$old$,
  $new$<li>Enter the title, summary, author, cover image, categories, and tags. On a phone, these fields are in <strong>Post settings</strong>.</li><li>Write the post with headings, links, lists, images, and other editor tools. On a phone, choose <strong>Content</strong> to write and format the post. Switching panels keeps your writing and settings.</li>$new$),
  updated_at = now()
WHERE slug = 'create-publish-and-feature-blog-posts' AND status = 'published';
