-- A store's theme is chosen once (owner, 31 Oct 2026). While a store has
-- no theme, Storefront shows the theme library; once it has one, the library
-- is gone and the store keeps its theme. Storefront instead offers Customise
-- storefront (a short form whose answers go to Mink AI in a new chat, where
-- the redesign starts) and Edit in Website Builder, and Branding now sits
-- under Storefront in the sidebar. The theme guide is edited where it said a
-- merchant can switch themes, its switch section is removed, and five other
-- guides are corrected sentence by sentence. Nothing is appended. Content
-- only; no schema changes.

UPDATE public.help_articles
SET title = 'Choose your storefront theme',
  excerpt = replace(excerpt,
    $old$, choose the one that fits your store, and switch whenever you like.$old$,
    $new$ and choose the one that fits your store. You choose it once.$new$),
  seo_title = replace(seo_title,
    $old$Change your StoreMink storefront theme$old$,
    $new$Choose your StoreMink storefront theme$new$),
  seo_description = replace(seo_description,
    $old$choose your store's first theme or switch to another, and see exactly what changes and what stays.$old$,
    $new$choose your store's theme once, see exactly what it adds, and change your store's look afterwards with Customise storefront and the Website Builder.$new$),
  body = replace(replace(replace(replace(replace(replace(replace(replace(replace(body,
  $old$and you can switch to another at any time.$old$,
  $new$and you choose it once: after that you change how your store looks with <strong>Customise storefront</strong> and the Website Builder, not by switching themes.$new$),
  $old$Your products, pages, orders and settings stay yours when you switch.</p>$old$,
  $new$Your products, pages, orders and settings stay yours.</p>$new$),
  $old$Open <strong>Storefront</strong>. <strong>Your theme</strong> is at the top and the <strong>Theme library</strong> is below it.$old$,
  $new$Open <strong>Storefront</strong>. Until your store has a theme, the <strong>Theme library</strong> is shown below <strong>Your theme</strong>; once you have chosen one, the library is no longer shown.$new$),
  $old$<h2>Choose or switch themes</h2>$old$,
  $new$<h2>Choose your theme</h2>$new$),
  $old$<li>Select <strong>Switch theme</strong>. When you are choosing your first theme, the button reads <strong>Use</strong> followed by the theme's name.</li>$old$,
  $new$<li>Select <strong>Use</strong> followed by the theme's name.</li>$new$),
  $old$<p>The new design applies straight away. If your store is open, shoppers see it at once.</p>$old$,
  $new$<p>The theme applies straight away. You can't switch to another theme afterwards.</p>$new$),
  $old$<h2>What your first theme adds</h2>
<p>Your first theme brings its design$old$,
  $new$<h2>What your theme adds</h2>
<p>Your theme brings its design$new$),
  $old$<h2>What changes when you switch</h2>
<ul><li>Your storefront's colours, fonts and layouts always change to the new theme's.</li><li>If you haven't edited your homepage yet, it is replaced with the new theme's starting homepage, and the theme's other starting pages are added where your store doesn't have one. Pages you already have are not changed.</li><li>If you have edited your homepage, it keeps its sections. To use the new theme's homepage, tick <strong>Also replace my edited homepage</strong>: your edited homepage is first saved as a draft page called "Homepage before" followed by the theme's name.</li><li>If your catalogue still holds nothing but your previous theme's untouched sample products and categories, and your store has never taken an order, they are removed and the new theme adds none. Products and categories you added or changed are never touched.</li><li>Your brand colour follows the theme until you choose your own. Colours, fonts, layouts, and a header and footer you set in the Website Builder stay as they are.</li></ul>
$old$,
  $new$$new$),
  $old$<h2>Customize your theme</h2>
<p>The Website Builder opens once your store has a theme. Select <strong>Customize</strong> under <strong>Your theme</strong> to open it, where you edit your pages, header and footer, and adjust colours, fonts and layouts.</p>$old$,
  $new$<h2>Change how your store looks</h2>
<p>Once your store has its theme, <strong>Your theme</strong> on the <strong>Storefront</strong> page offers two ways to change how it looks. Select <strong>Customise storefront</strong>, tell Mink AI what you sell, the look you want, facts about your business and anything to avoid, and select <strong>Customise</strong>: Mink AI redesigns your pages, header and footer in a new chat and shows you everything to review before anything changes on your store (see <a href="/help/storefront/manage-your-website-with-mink-ai">Manage your website with Mink AI</a>). Or select <strong>Edit in Website Builder</strong> to edit your pages, header and footer yourself and adjust colours, fonts and layouts. Your logo, store name, colours and contact details are under <strong>Branding</strong>, which sits under <strong>Storefront</strong>.</p>$new$),
  updated_at = now()
WHERE slug = 'change-your-storefront-theme' AND status = 'published';

UPDATE public.help_articles
SET body = replace(replace(body,
  $old$<li>Open <strong>Branding</strong>.</li>$old$,
  $new$<li>Open <strong>Storefront</strong>, then <strong>Branding</strong>.</li>$new$),
  $old$You can change the theme any time.$old$,
  $new$You choose it once; afterwards you change how your store looks with <strong>Customise storefront</strong> and the Website Builder.$new$),
  updated_at = now()
WHERE slug = 'complete-your-store-setup' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
  $old$<li>Open <strong>Branding</strong>.</li>$old$,
  $new$<li>Open <strong>Storefront</strong>, then <strong>Branding</strong>.</li>$new$),
  updated_at = now()
WHERE slug = 'create-or-edit-your-brand-voice' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
  $old$<li>From the dashboard, open <strong>Branding</strong>.</li>$old$,
  $new$<li>From the dashboard, open <strong>Storefront</strong>, then <strong>Branding</strong>.</li>$new$),
  updated_at = now()
WHERE slug = 'change-your-storefront-branding-and-layout' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
  $old$, and change it whenever you like; see <a href="/help/storefront/change-your-storefront-theme">Change your storefront theme</a>.$old$,
  $new$. You choose it once; afterwards you change how your store looks with <strong>Customise storefront</strong> and the Website Builder. See <a href="/help/storefront/change-your-storefront-theme">Choose your storefront theme</a>.$new$),
  updated_at = now()
WHERE slug = 'create-your-storemink-store' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
  $old$<li><strong>Online store</strong> contains <strong>Storefront</strong>, where you choose your theme, and the Website Builder, blogs, branding, and media.</li>$old$,
  $new$<li><strong>Online store</strong> contains <strong>Storefront</strong>, where you choose your theme, customise how your store looks and edit your branding, and the Website Builder, blogs, and media.</li>$new$),
  updated_at = now()
WHERE slug = 'understand-your-storemink-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
  $old$<p>To make your store your own, ask Mink to <strong>customise my store for my business</strong>. Mink asks up to three short questions,$old$,
  $new$<p>To make your store your own, select <strong>Customise storefront</strong> on the <strong>Storefront</strong> page, tell Mink AI what you sell, the look you want, facts about your business and anything to avoid, and select <strong>Customise</strong>. Mink AI starts the redesign in a new chat, using the products already in your store and keeping your categories as they are. You can also ask Mink to <strong>customise my store for my business</strong> in the chat. Mink then asks up to three short questions,$new$),
  updated_at = now()
WHERE slug = 'manage-your-website-with-mink-ai' AND status = 'published';
