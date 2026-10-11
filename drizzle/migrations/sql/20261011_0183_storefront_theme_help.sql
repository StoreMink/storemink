-- A new store starts with no theme. Until its owner chooses one, everyone who
-- gets past the store password (the owner included) sees a "Store in
-- progress" page. The dashboard page for themes is called Storefront and sits
-- in the sidebar group Online store, and choosing a theme is one of the five
-- grouped go-live tasks on Dashboard Home.
--
-- Edits five guides in place: signup, setup, the theme guide, the dashboard
-- guide's navigation list and the first-product guide's troubleshooting list.
-- The theme guide gains one section, "What your first theme adds", because a
-- first install follows its own rules (it never overwrites a page, product or
-- colour the merchant already made) and the switch section does not cover it.
--
-- Each replace() quotes one sentence or one list item of the text published
-- by 0019 / 0171 / 0173 / 0182, never a paragraph, so a later edit elsewhere
-- in the same paragraph cannot turn it into a no-op; applyVerify fails if any
-- of them does not land.

-- The signup guide: the store starts without a theme.
UPDATE public.help_articles
SET body = replace(body,
  $old$Every store starts on a ready-made theme. You can choose a different one from <strong>Themes</strong> in your dashboard at any time;$old$,
  $new$Your store starts without a theme, so anyone who enters its password sees a <strong>Store in progress</strong> page until you choose one. Choose it from <strong>Storefront</strong> in your dashboard, under <strong>Online store</strong>, and change it whenever you like;$new$),
  updated_at = now()
WHERE slug = 'create-your-storemink-store' AND status = 'published';

-- The setup guide: the go-live checklist is five grouped tasks, choosing a
-- theme among them, and the website step starts by choosing a theme.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$The required items are: the store owner's mobile number, verified with a code we text to it, at least one published product of your own, your business name, address, email and mobile under <strong>Taxes &amp; invoices</strong>, a published Terms &amp; Conditions, Refund &amp; Cancellation, Shipping and Privacy policy under <strong>Settings</strong> → <strong>Policies</strong>, and saved delivery charges under <strong>Settings</strong> → <strong>Shipping &amp; delivery</strong>. Each item links to the page where you complete it and ticks itself off when the page is saved.$old$,
  $new$There are five required tasks:</p>
<ol><li><strong>Verify your mobile number</strong>: the store owner's mobile, confirmed with a code we text to it.</li><li><strong>Choose your storefront theme</strong> under <strong>Storefront</strong>. Until you do, anyone who enters your store password sees a <strong>Store in progress</strong> page. You can change the theme any time.</li><li><strong>Add your first product</strong>: at least one published product of your own. The theme's sample products don't count.</li><li><strong>Add your business and delivery details</strong>: your business name, address, email and mobile under <strong>Taxes &amp; invoices</strong>, and your delivery charges, saved once under <strong>Settings</strong> → <strong>Shipping &amp; delivery</strong>.</li><li><strong>Publish your store policies</strong>: Terms &amp; Conditions, Refund &amp; Cancellation, Shipping and Privacy, all under <strong>Settings</strong> → <strong>Policies</strong>.</li></ol>
<p>Each task links to the page where you complete it and ticks itself off when the page is saved. The business and policies tasks list their parts, each with its own tick, and count as done when every part is.$new$),
  $old$<li>Open <strong>Website Builder</strong>.</li>$old$,
  $new$<li>Open <strong>Storefront</strong>, preview the themes on their demo stores, and choose one with <strong>Use this theme</strong>.</li><li>Open <strong>Website Builder</strong>.</li>$new$),
  excerpt = 'Complete the go-live checklist (verify your mobile, choose a theme, add a product, add your business and delivery details, and publish your policies), then open your password-protected store.',
  seo_description = 'Complete the StoreMink go-live checklist: verify your mobile, choose a theme, add products, business and delivery details and policies, then open your password-protected store.',
  updated_at = now()
WHERE slug = 'complete-your-store-setup' AND status = 'published';

-- The theme guide: the page is Storefront under Online store, the first theme
-- is chosen there, and a first install adds content only where the store has
-- none of its own (lib/themes/switch-rules.ts planThemeSwitch, firstTheme).
UPDATE public.help_articles
SET body = replace(replace(replace(replace(replace(replace(body,
  $old$Every new store starts on a ready-made theme, and you can switch to another at any time from <strong>Themes</strong> in your dashboard.$old$,
  $new$You choose it from <strong>Storefront</strong> in your dashboard, under <strong>Online store</strong>, and you can switch to another at any time. Until you choose your first theme, everyone who gets past your store password, you included, sees a <strong>Store in progress</strong> page.$new$),
  $old$Open <strong>Themes</strong>. Your current theme is at the top and the theme library is below it.$old$,
  $new$Open <strong>Storefront</strong>. <strong>Your theme</strong> is at the top and the <strong>Theme library</strong> is below it.$new$),
  $old$<h2>Switch themes</h2>$old$,
  $new$<h2>Choose or switch themes</h2>$new$),
  $old$<li>Select <strong>Switch theme</strong>.</li>$old$,
  $new$<li>Select <strong>Switch theme</strong>. When you are choosing your first theme, the button reads <strong>Use</strong> followed by the theme's name.</li>$new$),
  $old$<h2>What changes when you switch</h2>$old$,
  $new$<h2>What your first theme adds</h2>
<p>Your first theme brings its design and starting content without overwriting anything you have already made.</p>
<ul><li>Your storefront gets the theme's colours, fonts and layouts, and the <strong>Store in progress</strong> page goes away.</li><li>Your homepage is created from the theme's starting design. If your store already has a homepage of your own, it keeps its sections unless you tick <strong>Also replace my edited homepage</strong>, and then it is first saved as a draft page.</li><li>The theme's other starting pages are added only where your store doesn't have a page yet. Policies you wrote under <strong>Settings</strong> → <strong>Policies</strong> stay exactly as they are.</li><li>If your store has no products or categories, has never taken an order, and has no header and footer set in the Website Builder, the theme adds its sample products and categories as examples and sets up your header and footer menus. The sample products are drafts, so customers don't see them.</li><li>Your brand colour starts as the theme's, unless you have already chosen your own.</li></ul>
<h2>What changes when you switch</h2>$new$),
  $old$Select <strong>Customize</strong> on your current theme to open the Website Builder,$old$,
  $new$The Website Builder opens once your store has a theme. Select <strong>Customize</strong> under <strong>Your theme</strong> to open it,$new$),
  excerpt = 'Preview themes on their demo stores, choose the one that fits your store, and switch whenever you like. Your products, pages and settings stay yours.',
  seo_description = 'Preview StoreMink themes on their demo stores, choose your store''s first theme or switch to another, and see exactly what changes and what stays.',
  updated_at = now()
WHERE slug = 'change-your-storefront-theme' AND status = 'published';

-- The dashboard guide: the sidebar group that holds the storefront's pages is
-- Online store, and Storefront is the theme page inside it.
UPDATE public.help_articles
SET body = replace(body,
  $old$<li><strong>Storefront</strong> contains the Website Builder, blogs, branding, and media.</li>$old$,
  $new$<li><strong>Online store</strong> contains <strong>Storefront</strong>, where you choose your theme, and the Website Builder, blogs, branding, and media.</li>$new$),
  updated_at = now()
WHERE slug = 'understand-your-storemink-dashboard' AND status = 'published';

-- The first-product guide: checking the product on a new store meets the
-- password page and, until a theme is chosen, the store-in-progress page.
UPDATE public.help_articles
SET body = replace(body,
  $old$<li>Confirm the product was saved and is available to the storefront.</li>$old$,
  $new$<li>If you see a password page, enter the store password shown on Dashboard Home. If you then see <strong>Store in progress</strong>, choose a theme under <strong>Storefront</strong> first.</li><li>Confirm the product was saved and is available to the storefront.</li>$new$),
  updated_at = now()
WHERE slug = 'add-your-first-product-and-check-the-storefront' AND status = 'published';
