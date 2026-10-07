-- Signup no longer asks for the business address, and a new store stays
-- behind a password until its owner completes the go-live checklist on the
-- dashboard Home and presses Go live. Edits the two Getting-started guides
-- in place: the signup guide's steps, and the setup guide's closing section,
-- which told merchants to "call the store ready" by looking at it.

-- The signup guide: the address is no longer collected during signup, and
-- name + store name are one step.
UPDATE public.help_articles
SET body = replace(replace(replace(replace(body,
  $old$<li>Keep your complete business address ready, including state and PIN code.</li>$old$,
  $new$<li>Your business address is added later, from the dashboard, before you open the store.</li>$new$),
  $old$<li>Verify your phone number with the SMS code.</li><li>Enter your first and last name.</li></ol>$old$,
  $new$<li>Verify your phone number with the SMS code.</li></ol>$new$),
  $old$<li>Enter the store name and check the suggested StoreMink address.</li>$old$,
  $new$<li>Enter your name, the store name and the country you sell from, then check the suggested StoreMink address.</li>$new$),
  $old$<li>Add the complete business location. Select <strong>Use my current location</strong> and allow your browser to share it to fill the address details that can be detected, including the street, area, city, state and postal/PIN code. Review these suggestions before continuing; detection may identify a nearby building. If a field cannot be detected, the form tells you which details to check and complete. You can type or correct every field, and enter your floor, suite or landmark yourself.</li>$old$,
  ''),
  excerpt = 'Create a StoreMink account, verify email and phone, name your store, choose a theme, and open your free store dashboard.',
  seo_description = 'Create a StoreMink account, verify email and phone, name your store, choose a theme, and open your free store dashboard.',
  updated_at = now()
WHERE slug = 'create-your-storemink-store' AND status = 'published';

-- The setup guide: the closing section becomes the go-live checklist and the
-- password that protects the store until then.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$<p>Your store is usable as soon as signup finishes, but a few setup checks prevent most first-order problems. Complete the jobs below in order and save each page before moving on.</p>$old$,
  $new$<p>Your dashboard is ready as soon as signup finishes, but your storefront stays private until you open it. Visitors who reach your store address see a password page; you and your staff can browse the real shop by signing in, and anyone you share the password with can preview it. Dashboard Home shows a go-live checklist and the password.</p>$new$),
  $old$<h2>Before calling the store ready</h2>
<p>Open <strong>My Store</strong> and check the complete shopping journey as a customer. Verify prices, stock, delivery information, policy links, contact details, and mobile layout. Features that require a higher plan remain unavailable until the plan is active; StoreMink does not delete existing data when a plan is lowered.</p>$old$,
  $new$<h2>Open your store</h2>
<p>Dashboard Home lists what must be in place before customers can shop. The required items are: at least one published product of your own, your business name, address, email and mobile under <strong>Taxes &amp; invoices</strong>, a published Terms &amp; Conditions, Refund &amp; Cancellation, Shipping and Privacy policy under <strong>Settings</strong> → <strong>Policies</strong>, and saved delivery charges under <strong>Settings</strong> → <strong>Shipping &amp; delivery</strong>. Each item links to the page where you complete it and ticks itself off when the page is saved.</p>
<p>Recommended items — your logo, a personalised homepage, removing the sample products, online payments, your GSTIN and your own domain — improve the store but do not hold it back.</p>
<p>When every required item is done, the store owner presses <strong>Go live</strong>. The password page comes down, search engines are told about the store, and your <strong>My Store</strong> link opens the public shop. Before that, use <strong>Preview store</strong> on Dashboard Home (or share the password with a colleague) and check the complete shopping journey as a customer: prices, stock, delivery information, policy links, contact details, and mobile layout. Features that require a higher plan remain unavailable until the plan is active; StoreMink does not delete existing data when a plan is lowered.</p>$new$),
  excerpt = 'Complete the go-live checklist — products, business details, policies and delivery — then open your password-protected store to customers.',
  seo_description = 'Complete the StoreMink go-live checklist for products, business details, policies, delivery and branding, then open your password-protected store.',
  updated_at = now()
WHERE slug = 'complete-your-store-setup' AND status = 'published';
