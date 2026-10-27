-- The Mink website guide describes the storefront redesign that replaces the
-- personalisation card (docs/mink-storefront-revamp.md, section 13): the short
-- interview (categories that came with the theme included), what a redesign
-- changes and what it keeps of the merchant's own sections (their words and
-- links; only theme, earlier Mink and broken photos in them are redrawn,
-- lib/mink/revamp/site-compiler.ts keepMerchantSection), the studio photo
-- check against the merchant's own photo, products
-- the store already has, the preview and the three buttons, what changes on the
-- live store at once (and the tagline left alone for a role without Branding
-- manage), photos joining the Media Library at Apply, newer versions (Apply
-- refused while one is being made, Undo newest first), a stopped chat reply,
-- the chat that cannot be deleted, and Mink credits (never a figure). The
-- paragraph 0232 published (with 0233's sentence inside it) is replaced whole,
-- in place, by three paragraphs.
UPDATE public.help_articles SET body=replace(body, $old$<p>To make your theme feel like your own shop, ask Mink to <strong>personalise my storefront</strong>. Mink asks a few questions about what you sell and how your store should look, then prepares one card. It rewrites the theme's sample text on your pages, draws new photos in place of the theme's own photos (photos you uploaded stay as they are), suggests colours and fonts, and can take the theme's sample products off your shop. A page you have changed yourself, your homepage included, is left as it is unless you ask Mink to include it, and text you wrote yourself always stays as you wrote it. Store policies are never rewritten, and sample customer quotes and press logos are switched off rather than rewritten. Mink changes a category only after you agree to that change. Applying the card saves your pages, header and footer to the Website Builder draft for you to publish; category, sample product, tagline and footer description changes apply to your live store straight away, and the card lists them before you apply. One card makes up to 12 new photos, the most visible first. When photos are left over, or your Mink credits run low, the card says so; after you apply it, ask Mink to make the rest of the photos.</p>$old$, $new$<p>To make your store your own, ask Mink to <strong>customise my store for my business</strong>. Mink asks up to three short questions, only about what it cannot already see in your store: what you sell and who buys it, the look you want, and your real products (the name, sizes, prices and a phone photo of each). If some of your categories came with the theme or do not fit what you sell, it asks in the same message whether to hide, rename or replace them. It then redesigns what your customers see while you carry on working: a homepage built for your business, your other pages rewritten from your own facts, new colours and fonts, a new header, footer and menus, and one set of new photographs in place of the theme's photos. Your products are added at the prices you gave, with a clean studio photo made from each photo you sent. Mink checks each studio photo against your photo; when one does not show your product as it really is, or cannot be made, your own photo is used and the card says why. A product your store already has is not added again, and the card says so. Mink never invents products, prices, reviews or claims, and changes a category only after you agree to that change. It never rewrites your store policies. In a page section you added yourself, or whose words or pictures you changed, it keeps your words and links and changes only the photos that came with the theme, that Mink made earlier or that no longer load.</p>

<p>A card in the chat shows the progress and, when the redesign is ready, a preview of every page on a phone and on a computer. <strong>Apply to Website Builder draft</strong> saves the pages, header and footer to your draft; your new products, your categories, the theme's sample products, your tagline and your footer description change on your live store straight away, and the card lists them before you apply. If your role cannot change your store's branding, the redesign leaves your tagline and footer description as they are, and the card says so. Applying also adds the redesign's new photos to your Media Library. <strong>Publish to your store</strong> makes the redesign live, and <strong>Undo</strong> puts back what you had before, keeping anything you changed yourself since; the card names what it kept. To adjust the result, tell Mink what to change, for example "make it warmer" or "redo the opening photo", and Mink makes a new version of the card. While a newer version is being made, the card before it cannot be applied. If you applied a newer version, undo it before you undo an earlier one.</p>

<p>If Mink's reply is stopped or interrupted before the card appears, the redesign does not go ahead and uses no Mink credits; to start it, ask Mink again in a minute. The chat that holds a redesign's card cannot be deleted while the redesign is being made or once its card is ready. The first full redesign of each store uses no Mink credits. Later redesigns, and changes to a redesign, use Mink credits for what they make. When your credits do not cover everything, Mink leaves some of it out and the card lists what it left out. When there are not enough credits for a redesign at all, Mink says so before it starts, or stops the redesign if they run out while it is being made, and nothing on your store changes. Buy Mink credits or upgrade under <strong>Plans &amp; Billing</strong>, then ask Mink again.</p>$new$), updated_at=now() WHERE slug='manage-your-website-with-mink-ai' AND status='published';

-- The Media guide: a redesign's photos are hidden from the Library until its
-- card is applied (lib/mink/revamp/image-store.ts, apply-v2.ts), and the
-- delete guard refuses an image a product, a page, a category, the header or
-- footer, or a pending redesign uses (lib/media/image-usage.ts; the logo and
-- blog posts are not checked). Both sentences 0214 published are replaced in
-- place.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$the pictures Mink AI made or refined for you.$old$,
  $new$the pictures Mink AI made or refined for you. The photos a storefront redesign uses are listed once you apply it.$new$),
  $old$<p>An image that a product still uses cannot be deleted: the library names those products, so remove the image from them first. Before deleting any other image, remove it from pages, branding, blog posts, or other content that still uses its URL, because deleting does not rewrite the places where the URL was pasted.</p>$old$,
  $new$<p>An image that a product, a page, a category or your header and footer still uses cannot be deleted, and neither can one used by a storefront redesign that Mink AI is still making or that you have not applied yet. The library says what uses the image and what to do first. Before deleting any other image, remove it from branding, blog posts, or other content that still uses its URL, because deleting does not rewrite the places where the URL was pasted.</p>$new$),
  updated_at = now()
WHERE slug = 'upload-and-manage-store-media' AND status = 'published';

-- The general Mink guide's Media Library sentence (0214) gets the same
-- qualification as the Media guide: a redesign's photos are filed hidden
-- (lib/mink/revamp/image-store.ts) and Apply reveals the ones its card uses
-- (lib/mink/revamp/apply-v2.ts revealRevampPhotos), so they are listed once
-- it is applied. The sentence occurs once in the guide.
UPDATE public.help_articles
SET body = replace(body,
  $old$Attached images are not listed in your Media Library; pictures Mink creates for you are.$old$,
  $new$Attached images are not listed in your Media Library; pictures Mink creates for you are, and the photos a storefront redesign uses are listed once you apply it.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';
