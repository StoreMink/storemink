-- Signup is three short steps: an account (email and password on one screen),
-- the store, and a plan. The plan step starts the store on Free or takes the
-- first payment for Basic or Pro, with a Skip beside it. Signup no longer asks
-- for a phone or a theme: the owner verifies their mobile from the go-live
-- checklist (or just before paying for a plan), and every store starts on a
-- ready-made theme its owner can change from Themes in the dashboard.
--
-- Edits four guides in place (signup, setup, account, plans) and publishes one
-- task guide, "Change your storefront theme".
--
-- Each replace() quotes one sentence or one list item, never a paragraph, so a
-- later edit elsewhere in the same paragraph cannot turn it into a no-op.

-- The signup guide.
UPDATE public.help_articles
SET body = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(body,
  $old$You create the store on the Free plan first, so you do not need to enter payment details during signup.$old$,
  $new$Your store is created on the Free plan first. You can then choose a paid plan and pay for it straight away, or skip that step and upgrade whenever you like.$new$),
  $old$<li>Use an email address and phone number that you can verify now.</li>$old$,
  $new$<li>Use an email address that you can verify now.</li>$new$),
  $old$<li>Your business address is added later, from the dashboard, before you open the store.</li>$old$,
  $new$<li>Your business address and verified mobile number are added later, from the dashboard, before you open the store. If you choose a paid plan during signup, you verify your mobile just before paying.</li>$new$),
  $old$<li>Enter your email address.</li><li>Create a password, or select <strong>Continue with Google</strong>.</li>$old$,
  $new$<li>Enter your email address and a password of at least eight characters, then select <strong>Create account</strong>. You can select <strong>Continue with Google</strong> instead.</li>$new$),
  $old$<li>Verify your phone number with the SMS code.</li>$old$,
  ''),
  $old$<p>A Google account with a verified email skips only the email-code step. Phone verification is still required. Never share an email or phone code with anyone.</p>$old$,
  $new$<p>A Google account with a verified email skips the email-code step. Never share a verification code with anyone.</p>$new$),
  $old$<li>Enter your name, the store name and the country you sell from, then check the suggested StoreMink address.</li>$old$,
  $new$<li>Enter your name, the store name and the country you sell from, check the suggested StoreMink address, then select <strong>Continue</strong>.</li>$new$),
  $old$<li>Choose a starting theme. The theme gives you an editable starting design; it does not lock your future changes.</li>$old$,
  $new$<li>Choose a plan. To start on the Free plan, select <strong>Skip, start on Free</strong>. For Basic or Pro, choose monthly or yearly billing, select the plan, then select <strong>Continue</strong>.</li>$new$),
  $old$<li>Select <strong>Create my free store</strong>.</li>$old$,
  $new$<li>For a paid plan, verify your mobile number with the six-digit code we text to it, then pay in the secure payment window. It shows the exact amount, including any GST, before you pay.</li>$new$),
  $old$<h2>If signup stops</h2>$old$,
  $new$<p>Every store starts on a ready-made theme. You can choose a different one from <strong>Themes</strong> in your dashboard at any time; see <a href="/help/storefront/change-your-storefront-theme">Change your storefront theme</a>.</p>

<h2>If signup stops</h2>$new$),
  $old$<li>Allow pop-ups for Google sign-in and complete the phone reCAPTCHA when asked.</li>$old$,
  $new$<li>Allow pop-ups for Google sign-in.</li>$new$),
  $old$<li>Do not repeatedly request codes. Temporary sending and attempt limits protect the account.</li>$old$,
  $new$<li>Do not repeatedly request codes. Temporary sending and attempt limits protect the account.</li><li>If you close the payment window, your store is still created on the Free plan. Choose a plan any time from <strong>Plans &amp; billing</strong>.</li>$new$),
  excerpt = 'Create a StoreMink account, verify your email, name your store, choose a plan, and open your store dashboard.',
  seo_title = 'Create your StoreMink store',
  seo_description = 'Create a StoreMink account, verify your email, name your store, start on Free or pay for a plan, and open your store dashboard.',
  updated_at = now()
WHERE slug = 'create-your-storemink-store' AND status = 'published';

-- The setup guide: the owner's verified mobile is a required checklist item,
-- done in place on Dashboard Home.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$The required items are: at least one published product of your own,$old$,
  $new$The required items are: the store owner's mobile number, verified with a code we text to it, at least one published product of your own,$new$),
  $old$Each item links to the page where you complete it and ticks itself off when the page is saved.</p>$old$,
  $new$Each item links to the page where you complete it and ticks itself off when the page is saved. The store owner verifies their mobile right in the checklist: enter the number, then the six-digit code we text to it. If your invoice details have no mobile yet, the verified number is added there too, and you can change it under <strong>Taxes &amp; invoices</strong>.</p>$new$),
  excerpt = 'Complete the go-live checklist (your verified mobile, products, business details, policies and delivery), then open your password-protected store to customers.',
  seo_description = 'Complete the StoreMink go-live checklist: verify your mobile, add products, business details, policies and delivery, then open your password-protected store.',
  updated_at = now()
WHERE slug = 'complete-your-store-setup' AND status = 'published';

-- The account guide: verifying a mobile saves it to the profile; nothing is
-- linked to the login.
UPDATE public.help_articles
SET body = replace(body,
  $old$<h2>Change your verified phone</h2>
<ol><li>On the <strong>Security</strong> tab, edit the phone number.</li><li>Choose the correct country code and request the SMS code.</li><li>Enter the code to link the number to the account.</li><li>Wait for the dashboard session to refresh with the verified phone.</li></ol>$old$,
  $new$<h2>Change your verified mobile number</h2>
<ol><li>On the <strong>Security</strong> tab, select <strong>Add number</strong>, <strong>Verify</strong> or <strong>Change</strong> next to your mobile number.</li><li>Choose the correct country code, enter the number and select <strong>Send code</strong>.</li><li>Enter the six-digit code. StoreMink checks it as soon as you type the last digit and saves the number to your profile as verified.</li></ol>
<p>Verifying a number does not change how you sign in. You can keep using the same number to shop on StoreMink stores.</p>$new$),
  updated_at = now()
WHERE slug = 'update-your-account-profile-and-security' AND status = 'published';

-- The plans guide: a plan can be bought as the last step of signup, and the
-- mobile number comes from a verification, not from signup itself.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$StoreMink creates every new store on <strong>Free</strong>.$old$,
  $new$StoreMink creates every new store on <strong>Free</strong>. You can choose Basic or Pro and pay for it as the last step of signup, or skip that step and upgrade later.$new$),
  $old$<li>Both are saved during signup from the email and phone number you verified.</li>$old$,
  $new$<li>The email address is saved during signup. The mobile number is saved when you verify it: on the go-live checklist on Dashboard Home, under Account settings, or just before paying if you choose a plan during signup.</li>$new$),
  updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published';

-- A task guide for choosing and switching themes, the first storefront task a
-- new store has.
INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT id,
  'change-your-storefront-theme',
  'Change your storefront theme',
  'Preview themes on their demo stores and switch your store to the one that fits. Your products, pages and settings stay yours.',
  $article$<p>Your theme sets how your store looks: its colours, fonts and layouts. Every new store starts on a ready-made theme, and you can switch to another at any time from <strong>Themes</strong> in your dashboard. Your products, pages, orders and settings stay yours when you switch.</p>
<h2>Preview a theme</h2>
<p>Open <strong>Themes</strong>. Your current theme is at the top and the theme library is below it. Filter the library by industry, then select <strong>Preview</strong> to open a theme's demo store in a new tab. A theme marked with a plan name needs that plan or above; select <strong>Upgrade</strong> on it to see your options.</p>
<h2>Switch themes</h2>
<ol><li>Select <strong>Use this theme</strong> on the theme you want.</li><li>Read the summary. It lists exactly what changes and what stays.</li><li>Select <strong>Switch theme</strong>.</li></ol>
<p>The new design applies straight away. If your store is open, shoppers see it at once.</p>
<h2>What changes when you switch</h2>
<ul><li>Your storefront's colours, fonts and layouts always change to the new theme's.</li><li>If you haven't edited your homepage yet, it is replaced with the new theme's starting homepage, and the theme's other starting pages are added where your store doesn't have one. Pages you already have are not changed.</li><li>If you have edited your homepage, it keeps its sections. To use the new theme's homepage, tick <strong>Also replace my edited homepage</strong>: your edited homepage is first saved as a draft page called "Homepage before" followed by the theme's name.</li><li>While your catalogue holds only the theme's sample products, they are swapped for the new theme's samples, which stay drafts. Products and categories you added are never changed.</li><li>Your brand colour follows the theme until you choose your own. Colours, fonts, layouts, and a header and footer you set in the Website Builder stay as they are.</li></ul>
<h2>Customize your theme</h2>
<p>Select <strong>Customize</strong> on your current theme to open the Website Builder, where you edit your pages, header and footer, and adjust colours, fonts and layouts.</p>$article$,
  'published',
  'Change your StoreMink storefront theme',
  'Preview StoreMink themes on their demo stores, switch your store to a new theme, and see exactly what changes and what stays.',
  0, now()
FROM public.help_categories WHERE slug = 'storefront'
ON CONFLICT (slug) DO NOTHING;
