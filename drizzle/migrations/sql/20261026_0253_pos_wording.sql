-- POS wording (owner's rule, 26 Oct 2026): the in-person selling feature is
-- called POS in everything a merchant, their staff or a shopper reads, never
-- register. Each sentence is edited where it stands; nothing is appended.
-- Every quoted string was checked against the local database first, and an
-- UPDATE whose sentence is not there changes nothing (applyVerify catches it).
-- updated_at moves in every statement so Help search and Mink re-embed.
-- The Help Centre counts as the app, so the category title is POS too; its
-- slug point-of-sale is the URL and stays, as do every guide's slug.

-- The two POS role descriptions (platform_roles, operator-owned). Guarded on
-- the seeded text, so an operator's own later wording is never overwritten.

UPDATE public.platform_roles SET description = $new$Uses POS at their shops: sells, takes returns, moves stock, runs the cash drawer and approves cashier discounts.$new$, updated_at = now()
WHERE slug = 'manager' AND description = $old$Works the register at their shops: sells, takes returns, moves stock, runs the cash drawer and approves cashier discounts.$old$;

UPDATE public.platform_roles SET description = $new$Uses POS at their shops: rings up sales, takes payments and hands over pickup orders.$new$, updated_at = now()
WHERE slug = 'cashier' AND description = $old$Works the register at their shops: rings up sales, takes payments and hands over pickup orders.$old$;

UPDATE public.help_categories SET description = replace(description,
  $old$Set up registers, sell in store, manage tills, stock, pickups, shifts, returns, and receipts.$old$,
  $new$Set up POS, sell in store, manage POS devices, stock, pickups, shifts, returns, and receipts.$new$),
  updated_at = now()
WHERE slug = 'point-of-sale'
  AND strpos(description, $old$Set up registers, sell in store, manage tills, stock, pickups, shifts, returns, and receipts.$old$) > 0;

UPDATE public.help_categories SET title = replace(title,
  $old$Point of Sale$old$,
  $new$POS$new$),
  updated_at = now()
WHERE slug = 'point-of-sale'
  AND strpos(title, $old$Point of Sale$old$) > 0;

-- H01 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$on your website and at the register.$old$,
  $new$on your website and in POS.$new$),
  updated_at = now()
WHERE slug = 'add-product-images-and-variants' AND status = 'published'
  AND strpos(body, $old$on your website and at the register.$old$) > 0;

-- H02 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$or a completed/refunded Point of Sale order.$old$,
  $new$or a completed/refunded POS order.$new$),
  updated_at = now()
WHERE slug = 'analytics-sales-and-orders' AND status = 'published'
  AND strpos(body, $old$or a completed/refunded Point of Sale order.$old$) > 0;

-- H03 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$Splits sales between channels such as online and Point of Sale.$old$,
  $new$Splits sales between channels such as online and POS.$new$),
  updated_at = now()
WHERE slug = 'analytics-sales-and-orders' AND status = 'published'
  AND strpos(body, $old$Splits sales between channels such as online and Point of Sale.$old$) > 0;

-- H04 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$Splits recognized commerce by fulfilment or Point of Sale location.$old$,
  $new$Splits recognized commerce by fulfilment or POS location.$new$),
  updated_at = now()
WHERE slug = 'analytics-sales-and-orders' AND status = 'published'
  AND strpos(body, $old$Splits recognized commerce by fulfilment or Point of Sale location.$old$) > 0;

-- H05 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<p>Splits sales by the recorded payment method. Point of Sale payments can be itemized$old$,
  $new$<p>Splits sales by the recorded payment method. POS payments can be itemized$new$),
  updated_at = now()
WHERE slug = 'analytics-sales-and-orders' AND status = 'published'
  AND strpos(body, $old$<p>Splits sales by the recorded payment method. Point of Sale payments can be itemized$old$) > 0;

-- H06 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$and completed or refunded Point of Sale orders.$old$,
  $new$and completed or refunded POS orders.$new$),
  updated_at = now()
WHERE slug = 'analytics-terms-and-data-sources' AND status = 'published'
  AND strpos(body, $old$and completed or refunded Point of Sale orders.$old$) > 0;

-- H07 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<li>Confirm the order is paid, Cash on Delivery, or completed/refunded Point of Sale.</li>$old$,
  $new$<li>Confirm the order is paid, Cash on Delivery, or a completed/refunded POS order.</li>$new$),
  updated_at = now()
WHERE slug = 'analytics-troubleshooting' AND status = 'published'
  AND strpos(body, $old$<li>Confirm the order is paid, Cash on Delivery, or completed/refunded Point of Sale.</li>$old$) > 0;

-- H08 (T)
UPDATE public.help_articles SET excerpt = replace(excerpt,
  $old$Authorise a desktop, tablet, or phone as a till, use a pairing code, revoke access, and respond to a copied device session.$old$,
  $new$Authorise a desktop, tablet, or phone as a POS device, use a pairing code, revoke access, and respond to a copied device session.$new$),
  updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices' AND status = 'published'
  AND strpos(excerpt, $old$Authorise a desktop, tablet, or phone as a till, use a pairing code, revoke access, and respond to a copied device session.$old$) > 0;

-- H09 (T)
UPDATE public.help_articles SET seo_description = replace(seo_description,
  $old$Learn how to authorise a StoreMink till, use a pairing code, revoke a POS device, and respond to copied browser sessions.$old$,
  $new$Learn how to authorise a StoreMink POS device, use a pairing code, revoke one, and respond to copied browser sessions.$new$),
  updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices' AND status = 'published'
  AND strpos(seo_description, $old$Learn how to authorise a StoreMink till, use a pairing code, revoke a POS device, and respond to copied browser sessions.$old$) > 0;

-- H10 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$<p>StoreMink treats each authorised browser as a till.$old$,
  $new$<p>StoreMink treats each authorised browser as a POS device.$new$),
  updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices' AND status = 'published'
  AND strpos(body, $old$<p>StoreMink treats each authorised browser as a till.$old$) > 0;

-- H11 (C)
UPDATE public.help_articles SET body = replace(body,
  $old$but should still manage shared counter devices carefully.$old$,
  $new$but should still manage shared POS devices carefully.$new$),
  updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices' AND status = 'published'
  AND strpos(body, $old$but should still manage shared counter devices carefully.$old$) > 0;

-- H12 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$<li>Give the till a clear name, such as$old$,
  $new$<li>Give the device a clear name, such as$new$),
  updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices' AND status = 'published'
  AND strpos(body, $old$<li>Give the till a clear name, such as$old$) > 0;

-- H13 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Point of Sale → Devices</strong>$old$,
  $new$<strong>POS → Devices</strong>$new$),
  updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices' AND status = 'published'
  AND strpos(body, $old$<strong>Point of Sale → Devices</strong>$old$) > 0;

-- H14 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$<li>On the till, enter the code at the device prompt.</li>$old$,
  $new$<li>On the new device, enter the code at the device prompt.</li>$new$),
  updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices' AND status = 'published'
  AND strpos(body, $old$<li>On the till, enter the code at the device prompt.</li>$old$) > 0;

-- H15 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$Re-authorise the genuine till only after checking who had access to the browser.$old$,
  $new$Re-authorise the genuine device only after checking who had access to the browser.$new$),
  updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices' AND status = 'published'
  AND strpos(body, $old$Re-authorise the genuine till only after checking who had access to the browser.$old$) > 0;

-- H16 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$<li>Use a separate browser profile for each physical till.</li>$old$,
  $new$<li>Use a separate browser profile for each physical POS device.</li>$new$),
  updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices' AND status = 'published'
  AND strpos(body, $old$<li>Use a separate browser profile for each physical till.</li>$old$) > 0;

-- H17 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$<li>Do not copy browser data between tills.</li>$old$,
  $new$<li>Do not copy browser data between POS devices.</li>$new$),
  updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices' AND status = 'published'
  AND strpos(body, $old$<li>Do not copy browser data between tills.</li>$old$) > 0;

-- H18 (P)
UPDATE public.help_articles SET excerpt = replace(excerpt,
  $old$Understand the payment choices StoreMink can offer at website checkout, pickup checkout, and the Point of Sale counter.$old$,
  $new$Understand the payment choices StoreMink can offer at website checkout, pickup checkout, and in POS.$new$),
  updated_at = now()
WHERE slug = 'choose-online-cod-and-pay-at-store-options' AND status = 'published'
  AND strpos(excerpt, $old$Understand the payment choices StoreMink can offer at website checkout, pickup checkout, and the Point of Sale counter.$old$) > 0;

-- H19 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<p>At Point of Sale, <strong>Card</strong>$old$,
  $new$<p>In POS, <strong>Card</strong>$new$),
  updated_at = now()
WHERE slug = 'choose-online-cod-and-pay-at-store-options' AND status = 'published'
  AND strpos(body, $old$<p>At Point of Sale, <strong>Card</strong>$old$) > 0;

-- H20 (A)
UPDATE public.help_articles SET title = replace(title,
  $old$Configure POS register settings$old$,
  $new$Configure POS settings$new$),
  updated_at = now()
WHERE slug = 'configure-pos-register-settings' AND status = 'published'
  AND strpos(title, $old$Configure POS register settings$old$) > 0;

-- H21 (A)
UPDATE public.help_articles SET excerpt = replace(excerpt,
  $old$cash-variance rules for every register.$old$,
  $new$cash-variance rules for every POS device.$new$),
  updated_at = now()
WHERE slug = 'configure-pos-register-settings' AND status = 'published'
  AND strpos(excerpt, $old$cash-variance rules for every register.$old$) > 0;

-- H22 (A)
UPDATE public.help_articles SET seo_title = replace(seo_title,
  $old$Configure StoreMink POS register settings$old$,
  $new$Configure StoreMink POS settings$new$),
  updated_at = now()
WHERE slug = 'configure-pos-register-settings' AND status = 'published'
  AND strpos(seo_title, $old$Configure StoreMink POS register settings$old$) > 0;

-- H23 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<p>POS Settings control how the register behaves for staff.$old$,
  $new$<p>POS Settings control how POS behaves for staff.$new$),
  updated_at = now()
WHERE slug = 'configure-pos-register-settings' AND status = 'published'
  AND strpos(body, $old$<p>POS Settings control how the register behaves for staff.$old$) > 0;

-- H24 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Point of Sale → Settings</strong>$old$,
  $new$<strong>POS → POS settings</strong>$new$),
  updated_at = now()
WHERE slug = 'configure-pos-register-settings' AND status = 'published'
  AND strpos(body, $old$<strong>Point of Sale → Settings</strong>$old$) > 0;

-- H25 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<h2>Auto-lock the register</h2>$old$,
  $new$<h2>Auto-lock POS</h2>$new$),
  updated_at = now()
WHERE slug = 'configure-pos-register-settings' AND status = 'published'
  AND strpos(body, $old$<h2>Auto-lock the register</h2>$old$) > 0;

-- H26 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Auto-lock the register after</strong> is the number of inactive minutes before the register asks for the operator's PIN again.$old$,
  $new$<strong>Auto-lock POS after</strong> is the number of inactive minutes before POS asks for the operator's PIN again.$new$),
  updated_at = now()
WHERE slug = 'configure-pos-register-settings' AND status = 'published'
  AND strpos(body, $old$<strong>Auto-lock the register after</strong> is the number of inactive minutes before the register asks for the operator's PIN again.$old$) > 0;

-- H27 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$Turn <strong>Allow price overrides at the register</strong> off$old$,
  $new$Turn <strong>Allow price overrides in POS</strong> off$new$),
  updated_at = now()
WHERE slug = 'configure-pos-register-settings' AND status = 'published'
  AND strpos(body, $old$Turn <strong>Allow price overrides at the register</strong> off$old$) > 0;

-- H28 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$where it runs - your online store, your point of sale, or both.$old$,
  $new$where it runs - your online store, POS, or both.$new$),
  updated_at = now()
WHERE slug = 'create-and-manage-offers' AND status = 'published'
  AND strpos(body, $old$where it runs - your online store, your point of sale, or both.$old$) > 0;

-- H29 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$A register sale has nothing to deliver, so an offer using it must be set to your website - you will be told if you try to save one for the register.$old$,
  $new$A POS sale has nothing to deliver, so an offer using it must be set to your website - you will be told if you try to save one for POS.$new$),
  updated_at = now()
WHERE slug = 'create-and-manage-offers' AND status = 'published'
  AND strpos(body, $old$A register sale has nothing to deliver, so an offer using it must be set to your website - you will be told if you try to save one for the register.$old$) > 0;

-- H30 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<p>At the register, the till shows a <strong>"Hand over"</strong> line$old$,
  $new$<p>In POS, the cart shows a <strong>"Hand over"</strong> line$new$),
  updated_at = now()
WHERE slug = 'create-and-manage-offers' AND status = 'published'
  AND strpos(body, $old$<p>At the register, the till shows a <strong>"Hand over"</strong> line$old$) > 0;

-- H31 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$At the register the total is shown before payment is taken, so it cannot change once a method is chosen; and a register sale is neither a delivery nor a collection. You will be told if you try to save one for the register.$old$,
  $new$In POS the total is shown before payment is taken, so it cannot change once a method is chosen; and a POS sale is neither a delivery nor a collection. You will be told if you try to save one for POS.$new$),
  updated_at = now()
WHERE slug = 'create-and-manage-offers' AND status = 'published'
  AND strpos(body, $old$At the register the total is shown before payment is taken, so it cannot change once a method is chosen; and a register sale is neither a delivery nor a collection. You will be told if you try to save one for the register.$old$) > 0;

-- H32 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$online and at your till, with no other change.$old$,
  $new$online and in POS, with no other change.$new$),
  updated_at = now()
WHERE slug = 'create-and-manage-offers' AND status = 'published'
  AND strpos(body, $old$online and at your till, with no other change.$old$) > 0;

-- H33 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$Your choice applies both on your online store and at the register,$old$,
  $new$Your choice applies both on your online store and in POS,$new$),
  updated_at = now()
WHERE slug = 'create-and-manage-offers' AND status = 'published'
  AND strpos(body, $old$Your choice applies both on your online store and at the register,$old$) > 0;

-- H34 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$edit an offer if you want it available at your point of sale too.$old$,
  $new$edit an offer if you want it available in POS too.$new$),
  updated_at = now()
WHERE slug = 'create-and-manage-offers' AND status = 'published'
  AND strpos(body, $old$edit an offer if you want it available at your point of sale too.$old$) > 0;

-- H35 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$StoreMink creates customer-facing order and Point of Sale documents$old$,
  $new$StoreMink creates customer-facing order and POS documents$new$),
  updated_at = now()
WHERE slug = 'create-and-share-customer-invoices' AND status = 'published'
  AND strpos(body, $old$StoreMink creates customer-facing order and Point of Sale documents$old$) > 0;

-- H36 (A)
UPDATE public.help_articles SET title = replace(title,
  $old$Customise the register and scan products$old$,
  $new$Customise the POS layout and scan products$new$),
  updated_at = now()
WHERE slug = 'customize-register-and-scan-products' AND status = 'published'
  AND strpos(title, $old$Customise the register and scan products$old$) > 0;

-- H37 (A)
UPDATE public.help_articles SET seo_title = replace(seo_title,
  $old$Customise the StoreMink POS register and scan products$old$,
  $new$Customise the StoreMink POS layout and scan products$new$),
  updated_at = now()
WHERE slug = 'customize-register-and-scan-products' AND status = 'published'
  AND strpos(seo_title, $old$Customise the StoreMink POS register and scan products$old$) > 0;

-- H38 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$If a location has no saved layout, the register shows the whole catalogue.$old$,
  $new$If a location has no saved layout, POS shows the whole catalogue.$new$),
  updated_at = now()
WHERE slug = 'customize-register-and-scan-products' AND status = 'published'
  AND strpos(body, $old$If a location has no saved layout, the register shows the whole catalogue.$old$) > 0;

-- H39 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<h2>Use the register on a phone or portrait tablet</h2>$old$,
  $new$<h2>Use POS on a phone or portrait tablet</h2>$new$),
  updated_at = now()
WHERE slug = 'customize-register-and-scan-products' AND status = 'published'
  AND strpos(body, $old$<h2>Use the register on a phone or portrait tablet</h2>$old$) > 0;

-- H40 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$On a wider till, the product grid and cart remain side by side.$old$,
  $new$On a wider screen, the product grid and cart remain side by side.$new$),
  updated_at = now()
WHERE slug = 'customize-register-and-scan-products' AND status = 'published'
  AND strpos(body, $old$On a wider till, the product grid and cart remain side by side.$old$) > 0;

-- H41 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$On a touch-first phone or tablet, the register opens the software keyboard$old$,
  $new$On a touch-first phone or tablet, POS opens the software keyboard$new$),
  updated_at = now()
WHERE slug = 'customize-register-and-scan-products' AND status = 'published'
  AND strpos(body, $old$On a touch-first phone or tablet, the register opens the software keyboard$old$) > 0;

-- H42 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$reaching the end does not move the page behind the register.$old$,
  $new$reaching the end does not move the rest of the page.$new$),
  updated_at = now()
WHERE slug = 'customize-register-and-scan-products' AND status = 'published'
  AND strpos(body, $old$reaching the end does not move the page behind the register.$old$) > 0;

-- H43 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$<h2>The cache is not an offline till</h2>$old$,
  $new$<h2>The cache does not make POS work offline</h2>$new$),
  updated_at = now()
WHERE slug = 'customize-register-and-scan-products' AND status = 'published'
  AND strpos(body, $old$<h2>The cache is not an offline till</h2>$old$) > 0;

-- H44 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Point of Sale → Settings</strong>$old$,
  $new$<strong>POS → POS settings</strong>$new$),
  updated_at = now()
WHERE slug = 'discounts-price-overrides-and-manager-approval' AND status = 'published'
  AND strpos(body, $old$<strong>Point of Sale → Settings</strong>$old$) > 0;

-- H45 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$valid only for that store, location, till, operator, cart, and discount$old$,
  $new$valid only for that store, location, POS device, operator, cart, and discount$new$),
  updated_at = now()
WHERE slug = 'discounts-price-overrides-and-manager-approval' AND status = 'published'
  AND strpos(body, $old$valid only for that store, location, till, operator, cart, and discount$old$) > 0;

-- H46 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Allow price overrides at the register</strong> decides$old$,
  $new$<strong>Allow price overrides in POS</strong> decides$new$),
  updated_at = now()
WHERE slug = 'discounts-price-overrides-and-manager-approval' AND status = 'published'
  AND strpos(body, $old$<strong>Allow price overrides at the register</strong> decides$old$) > 0;

-- H47 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Point of Sale → Money</strong>$old$,
  $new$<strong>POS → Money log</strong>$new$),
  updated_at = now()
WHERE slug = 'discounts-price-overrides-and-manager-approval' AND status = 'published'
  AND strpos(body, $old$<strong>Point of Sale → Money</strong>$old$) > 0;

-- H48 (P)
UPDATE public.help_articles SET excerpt = replace(excerpt,
  $old$Turn on Point of Sale, prepare your first shop,$old$,
  $new$Turn on POS, prepare your first shop,$new$),
  updated_at = now()
WHERE slug = 'enable-pos-and-set-up-locations' AND status = 'published'
  AND strpos(excerpt, $old$Turn on Point of Sale, prepare your first shop,$old$) > 0;

-- H49 (P)
UPDATE public.help_articles SET seo_description = replace(seo_description,
  $old$Enable StoreMink Point of Sale, configure selling locations$old$,
  $new$Enable StoreMink POS, configure selling locations$new$),
  updated_at = now()
WHERE slug = 'enable-pos-and-set-up-locations' AND status = 'published'
  AND strpos(seo_description, $old$Enable StoreMink Point of Sale, configure selling locations$old$) > 0;

-- H50 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<p>Point of Sale is enabled once for the store,$old$,
  $new$<p>POS is enabled once for the store,$new$),
  updated_at = now()
WHERE slug = 'enable-pos-and-set-up-locations' AND status = 'published'
  AND strpos(body, $old$<p>Point of Sale is enabled once for the store,$old$) > 0;

-- H51 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<h2>Enable Point of Sale</h2>$old$,
  $new$<h2>Enable POS</h2>$new$),
  updated_at = now()
WHERE slug = 'enable-pos-and-set-up-locations' AND status = 'published'
  AND strpos(body, $old$<h2>Enable Point of Sale</h2>$old$) > 0;

-- H52 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$select <strong>Point of Sale</strong>.</li>$old$,
  $new$select <strong>POS</strong>.</li>$new$),
  updated_at = now()
WHERE slug = 'enable-pos-and-set-up-locations' AND status = 'published'
  AND strpos(body, $old$select <strong>Point of Sale</strong>.</li>$old$) > 0;

-- H53 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$The Point of Sale workspace now shows its POS tools.$old$,
  $new$The POS workspace now shows its tools.$new$),
  updated_at = now()
WHERE slug = 'enable-pos-and-set-up-locations' AND status = 'published'
  AND strpos(body, $old$The Point of Sale workspace now shows its POS tools.$old$) > 0;

-- H54 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$Turning POS off later stops new register work$old$,
  $new$Turning POS off later stops new POS work$new$),
  updated_at = now()
WHERE slug = 'enable-pos-and-set-up-locations' AND status = 'published'
  AND strpos(body, $old$Turning POS off later stops new register work$old$) > 0;

-- H55 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$<h2>Sign in and re-authorise tills on the new address</h2>$old$,
  $new$<h2>Sign in and re-authorise POS devices on the new address</h2>$new$),
  updated_at = now()
WHERE slug = 'how-to-add-custom-domain' AND status = 'published'
  AND strpos(body, $old$<h2>Sign in and re-authorise tills on the new address</h2>$old$) > 0;

-- H56 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$Every paired POS till must also be re-authorised once$old$,
  $new$Every paired POS device must also be re-authorised once$new$),
  updated_at = now()
WHERE slug = 'how-to-add-custom-domain' AND status = 'published'
  AND strpos(body, $old$Every paired POS till must also be re-authorised once$old$) > 0;

-- H57 (A)
UPDATE public.help_articles SET excerpt = replace(excerpt,
  $old$Invite a dashboard admin or register staff member,$old$,
  $new$Invite a dashboard admin or POS staff member,$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(excerpt, $old$Invite a dashboard admin or register staff member,$old$) > 0;

-- H58 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$including the cashiers and managers who work the register, is invited$old$,
  $new$including the cashiers and managers who use POS, is invited$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$including the cashiers and managers who work the register, is invited$old$) > 0;

-- H59 (A+P)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Cashier</strong> for the register. The register roles can be chosen once Point of Sale is switched on.$old$,
  $new$<strong>Cashier</strong> for POS. They can be chosen once POS is switched on.$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$<strong>Cashier</strong> for the register. The register roles can be chosen once Point of Sale is switched on.$old$) > 0;

-- H60 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$For a register role, the email carries a registration link$old$,
  $new$For a POS role, the email carries a registration link$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$For a register role, the email carries a registration link$old$) > 0;

-- H61 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$chooses an 8-digit PIN, then signs in at the register.$old$,
  $new$chooses an 8-digit PIN, then signs in to POS.$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$chooses an 8-digit PIN, then signs in at the register.$old$) > 0;

-- H62 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$Managers and cashiers sign in at the register only and never see the dashboard.$old$,
  $new$Managers and cashiers sign in to POS only and never see the dashboard.$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$Managers and cashiers sign in at the register only and never see the dashboard.$old$) > 0;

-- H63 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$or register work, to those shops.$old$,
  $new$or POS work, to those shops.$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$or register work, to those shops.$old$) > 0;

-- H64 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$(or <strong>Deactivate</strong> for register staff)$old$,
  $new$(or <strong>Deactivate</strong> for POS staff)$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$(or <strong>Deactivate</strong> for register staff)$old$) > 0;

-- H65 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$A register invitation that has not been used yet$old$,
  $new$A POS invitation that has not been used yet$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$A register invitation that has not been used yet$old$) > 0;

-- H66 (A+P)
UPDATE public.help_articles SET body = replace(body,
  $old$Register roles need Point of Sale switched on.$old$,
  $new$Manager and Cashier roles need POS switched on.$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$Register roles need Point of Sale switched on.$old$) > 0;

-- H67 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$If another till sells while you count,$old$,
  $new$If another POS device sells while you count,$new$),
  updated_at = now()
WHERE slug = 'manage-pos-inventory-and-stock-transfers' AND status = 'published'
  AND strpos(body, $old$If another till sells while you count,$old$) > 0;

-- H68 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$website orders and completed Point of Sale sales.$old$,
  $new$website orders and completed POS sales.$new$),
  updated_at = now()
WHERE slug = 'manage-website-and-pos-orders' AND status = 'published'
  AND strpos(body, $old$website orders and completed Point of Sale sales.$old$) > 0;

-- H69 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$gross margin and Point of Sale</td>$old$,
  $new$gross margin and POS</td>$new$),
  updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$gross margin and Point of Sale</td>$old$) > 0;

-- H70 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$<td>Included POS locations and authorised tills</td>$old$,
  $new$<td>Included POS locations and authorised POS devices</td>$new$),
  updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$<td>Included POS locations and authorised tills</td>$old$) > 0;

-- H71 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$<td>2 locations, 5 tills per location</td>$old$,
  $new$<td>2 locations, 5 POS devices per location</td>$new$),
  updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$<td>2 locations, 5 tills per location</td>$old$) > 0;

-- H72 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Point of Sale → Shifts</strong>$old$,
  $new$<strong>POS → Shifts</strong>$new$),
  updated_at = now()
WHERE slug = 'open-close-and-reconcile-cash-shifts' AND status = 'published'
  AND strpos(body, $old$<strong>Point of Sale → Shifts</strong>$old$) > 0;

-- H73 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$is enabled, the register refuses sales,$old$,
  $new$is enabled, POS refuses sales,$new$),
  updated_at = now()
WHERE slug = 'open-close-and-reconcile-cash-shifts' AND status = 'published'
  AND strpos(body, $old$is enabled, the register refuses sales,$old$) > 0;

-- H74 (P)
UPDATE public.help_articles SET title = replace(title,
  $old$Point of Sale overview and requirements$old$,
  $new$POS overview and requirements$new$),
  updated_at = now()
WHERE slug = 'pos-overview-and-requirements' AND status = 'published'
  AND strpos(title, $old$Point of Sale overview and requirements$old$) > 0;

-- H75 (A+P)
UPDATE public.help_articles SET seo_description = replace(seo_description,
  $old$Learn what StoreMink Point of Sale includes, which devices work, plan and location requirements, internet needs, and where to open the register.$old$,
  $new$Learn what StoreMink POS includes, which devices work, plan and location requirements, internet needs, and where to open POS.$new$),
  updated_at = now()
WHERE slug = 'pos-overview-and-requirements' AND status = 'published'
  AND strpos(seo_description, $old$Learn what StoreMink Point of Sale includes, which devices work, plan and location requirements, internet needs, and where to open the register.$old$) > 0;

-- H76 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<p>StoreMink Point of Sale is the in-store register for your StoreMink shop.$old$,
  $new$<p>StoreMink POS (point of sale) is how you sell in person at your StoreMink shop.$new$),
  updated_at = now()
WHERE slug = 'pos-overview-and-requirements' AND status = 'published'
  AND strpos(body, $old$<p>StoreMink Point of Sale is the in-store register for your StoreMink shop.$old$) > 0;

-- H77 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>StoreMink Pro:</strong> Point of Sale is included in Pro.$old$,
  $new$<strong>StoreMink Pro:</strong> POS is included in Pro.$new$),
  updated_at = now()
WHERE slug = 'pos-overview-and-requirements' AND status = 'published'
  AND strpos(body, $old$<strong>StoreMink Pro:</strong> Point of Sale is included in Pro.$old$) > 0;

-- H78 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<h2>Where to open the register</h2>$old$,
  $new$<h2>Where to open POS</h2>$new$),
  updated_at = now()
WHERE slug = 'pos-overview-and-requirements' AND status = 'published'
  AND strpos(body, $old$<h2>Where to open the register</h2>$old$) > 0;

-- H79 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$explains the product; it is not a merchant register.$old$,
  $new$explains the product; it is not your store's POS.$new$),
  updated_at = now()
WHERE slug = 'pos-overview-and-requirements' AND status = 'published'
  AND strpos(body, $old$explains the product; it is not a merchant register.$old$) > 0;

-- H80 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$there is no till override.$old$,
  $new$there is no override in POS.$new$),
  updated_at = now()
WHERE slug = 'prepare-and-hand-over-pickup-orders' AND status = 'published'
  AND strpos(body, $old$there is no till override.$old$) > 0;

-- H81 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$The print view hides the dark register interface$old$,
  $new$The print view hides the dark POS interface$new$),
  updated_at = now()
WHERE slug = 'print-email-and-understand-pos-receipts' AND status = 'published'
  AND strpos(body, $old$The print view hides the dark register interface$old$) > 0;

-- H82 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$<li>The buyer's GSTIN when entered at the till.</li>$old$,
  $new$<li>The buyer's GSTIN when entered in POS.</li>$new$),
  updated_at = now()
WHERE slug = 'print-email-and-understand-pos-receipts' AND status = 'published'
  AND strpos(body, $old$<li>The buyer's GSTIN when entered at the till.</li>$old$) > 0;

-- H83 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$its stock at this register's location, and its SKU,$old$,
  $new$its stock at this location, and its SKU,$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$its stock at this register's location, and its SKU,$old$) > 0;

-- H84 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$counted at this register's location.$old$,
  $new$counted at this location.$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$counted at this register's location.$old$) > 0;

-- H85 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$whether that customer was recorded at the till or created their own account online.$old$,
  $new$whether that customer was recorded in POS or created their own account online.$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$whether that customer was recorded at the till or created their own account online.$old$) > 0;

-- H86 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$A name is required: the register no longer records a number on its own.$old$,
  $new$A name is required: POS does not record a number on its own.$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$A name is required: the register no longer records a number on its own.$old$) > 0;

-- H87 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$A customer recorded at the till keeps their in-store history$old$,
  $new$A customer recorded in POS keeps their in-store history$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$A customer recorded at the till keeps their in-store history$old$) > 0;

-- H88 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$It is shared with other tills at the same location, but one till can claim a particular held sale at a time.$old$,
  $new$It is shared with other POS devices at the same location, but only one device can claim a particular held sale at a time.$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$It is shared with other tills at the same location, but one till can claim a particular held sale at a time.$old$) > 0;

-- H89 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<h2>If the register page reloads</h2>$old$,
  $new$<h2>If the Sell screen reloads</h2>$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$<h2>If the register page reloads</h2>$old$) > 0;

-- H90 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$so reloading the register - or coming back to it$old$,
  $new$so reloading the Sell screen - or coming back to it$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$so reloading the register - or coming back to it$old$) > 0;

-- H91 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$it is cleared when the till locks or anyone signs out,$old$,
  $new$it is cleared when POS locks or anyone signs out,$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$it is cleared when the till locks or anyone signs out,$old$) > 0;

-- H92 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$or between two register tabs.$old$,
  $new$or between two POS tabs.$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$or between two register tabs.$old$) > 0;

-- H93 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$To keep a sale across a lock, a different till or a longer break,$old$,
  $new$To keep a sale across a lock, a different device or a longer break,$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$To keep a sale across a lock, a different till or a longer break,$old$) > 0;

-- H94 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$If your browser blocks site data, the register still works normally;$old$,
  $new$If your browser blocks site data, POS still works normally;$new$),
  updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND strpos(body, $old$If your browser blocks site data, the register still works normally;$old$) > 0;

-- H95 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$Every new register sale has a customer attached$old$,
  $new$Every new POS sale has a customer attached$new$),
  updated_at = now()
WHERE slug = 'refunds-store-credit-exchanges-and-credit-notes' AND status = 'published'
  AND strpos(body, $old$Every new register sale has a customer attached$old$) > 0;

-- H96 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$The till records the return and original-method refund,$old$,
  $new$POS records the return and original-method refund,$new$),
  updated_at = now()
WHERE slug = 'refunds-store-credit-exchanges-and-credit-notes' AND status = 'published'
  AND strpos(body, $old$The till records the return and original-method refund,$old$) > 0;

-- H97 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$both on your website and at the register.$old$,
  $new$both on your website and in POS.$new$),
  updated_at = now()
WHERE slug = 'set-product-pricing-tax-and-shipping-details' AND status = 'published'
  AND strpos(body, $old$both on your website and at the register.$old$) > 0;

-- H98 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$on website orders, Point of Sale receipts, and customer invoices.$old$,
  $new$on website orders, POS receipts, and customer invoices.$new$),
  updated_at = now()
WHERE slug = 'set-up-gst-and-tax-classes' AND status = 'published'
  AND strpos(body, $old$on website orders, Point of Sale receipts, and customer invoices.$old$) > 0;

-- H99 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<p>Point of Sale uses the selling location's state$old$,
  $new$<p>POS uses the selling location's state$new$),
  updated_at = now()
WHERE slug = 'set-up-gst-and-tax-classes' AND status = 'published'
  AND strpos(body, $old$<p>Point of Sale uses the selling location's state$old$) > 0;

-- H100 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$shared by inventory, orders, Point of Sale, pickup, returns, and fulfilment.$old$,
  $new$shared by inventory, orders, POS, pickup, returns, and fulfilment.$new$),
  updated_at = now()
WHERE slug = 'set-up-locations-and-capabilities' AND status = 'published'
  AND strpos(body, $old$shared by inventory, orders, Point of Sale, pickup, returns, and fulfilment.$old$) > 0;

-- H101 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$allows Point of Sale work at the location.$old$,
  $new$allows selling with POS at the location.$new$),
  updated_at = now()
WHERE slug = 'set-up-locations-and-capabilities' AND status = 'published'
  AND strpos(body, $old$allows Point of Sale work at the location.$old$) > 0;

-- H102 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$These two roles work the register;$old$,
  $new$These two roles use POS;$new$),
  updated_at = now()
WHERE slug = 'set-up-pos-staff-and-pins' AND status = 'published'
  AND strpos(body, $old$These two roles work the register;$old$) > 0;

-- H103 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$and edit the register layout.$old$,
  $new$and edit the POS layout.$new$),
  updated_at = now()
WHERE slug = 'set-up-pos-staff-and-pins' AND status = 'published'
  AND strpos(body, $old$and edit the register layout.$old$) > 0;

-- H104 (C)
UPDATE public.help_articles SET body = replace(body,
  $old$for a quick counter login,$old$,
  $new$for a quick POS login,$new$),
  updated_at = now()
WHERE slug = 'set-up-pos-staff-and-pins' AND status = 'published'
  AND strpos(body, $old$for a quick counter login,$old$) > 0;

-- H105 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$The register auto-locks after the configured period$old$,
  $new$POS auto-locks after the configured period$new$),
  updated_at = now()
WHERE slug = 'set-up-pos-staff-and-pins' AND status = 'published'
  AND strpos(body, $old$The register auto-locks after the configured period$old$) > 0;

-- H106 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$If another till sold the final unit during payment,$old$,
  $new$If another POS device sold the final unit during payment,$new$),
  updated_at = now()
WHERE slug = 'take-payments-and-split-tenders' AND status = 'published'
  AND strpos(body, $old$If another till sold the final unit during payment,$old$) > 0;

-- H107 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$the till never offers cash for it.$old$,
  $new$POS never offers cash for it.$new$),
  updated_at = now()
WHERE slug = 'take-returns-at-the-counter' AND status = 'published'
  AND strpos(body, $old$the till never offers cash for it.$old$) > 0;

-- H108 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$With no customer attached, the till takes the items back$old$,
  $new$With no customer attached, POS takes the items back$new$),
  updated_at = now()
WHERE slug = 'take-returns-at-the-counter' AND status = 'published'
  AND strpos(body, $old$With no customer attached, the till takes the items back$old$) > 0;

-- H109 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$so two tills cannot both refund the same remaining unit.$old$,
  $new$so two POS devices cannot both refund the same remaining unit.$new$),
  updated_at = now()
WHERE slug = 'take-returns-at-the-counter' AND status = 'published'
  AND strpos(body, $old$so two tills cannot both refund the same remaining unit.$old$) > 0;

-- H110 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$the return cannot be completed at the till.$old$,
  $new$the return cannot be completed in POS.$new$),
  updated_at = now()
WHERE slug = 'take-returns-at-the-counter' AND status = 'published'
  AND strpos(body, $old$the return cannot be completed at the till.$old$) > 0;

-- H111 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$governs counter returns of orders this till did not sell,$old$,
  $new$governs counter returns of orders this shop did not sell in POS,$new$),
  updated_at = now()
WHERE slug = 'take-returns-at-the-counter' AND status = 'published'
  AND strpos(body, $old$governs counter returns of orders this till did not sell,$old$) > 0;

-- H112 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$A sale rung at this same register stays returnable here$old$,
  $new$A POS sale rung up at this same shop stays returnable here$new$),
  updated_at = now()
WHERE slug = 'take-returns-at-the-counter' AND status = 'published'
  AND strpos(body, $old$A sale rung at this same register stays returnable here$old$) > 0;

-- H113 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$to use the register, open your merchant store domain$old$,
  $new$to use POS, open your merchant store domain$new$),
  updated_at = now()
WHERE slug = 'troubleshoot-pos-and-internet-issues' AND status = 'published'
  AND strpos(body, $old$to use the register, open your merchant store domain$old$) > 0;

-- H114 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<h2>POS opens the product page instead of my register</h2>$old$,
  $new$<h2>POS opens the product page instead of my store</h2>$new$),
  updated_at = now()
WHERE slug = 'troubleshoot-pos-and-internet-issues' AND status = 'published'
  AND strpos(body, $old$<h2>POS opens the product page instead of my register</h2>$old$) > 0;

-- H115 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$Open Dashboard → Point of Sale and make sure POS is enabled.$old$,
  $new$Open Dashboard → POS and make sure POS is enabled.$new$),
  updated_at = now()
WHERE slug = 'troubleshoot-pos-and-internet-issues' AND status = 'published'
  AND strpos(body, $old$Open Dashboard → Point of Sale and make sure POS is enabled.$old$) > 0;

-- H116 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$Generate a new code from Point of Sale → Devices.$old$,
  $new$Generate a new code from POS → Devices.$new$),
  updated_at = now()
WHERE slug = 'troubleshoot-pos-and-internet-issues' AND status = 'published'
  AND strpos(body, $old$Generate a new code from Point of Sale → Devices.$old$) > 0;

-- H117 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<h2>The register asks for an open shift</h2>$old$,
  $new$<h2>POS asks for an open shift</h2>$new$),
  updated_at = now()
WHERE slug = 'troubleshoot-pos-and-internet-issues' AND status = 'published'
  AND strpos(body, $old$<h2>The register asks for an open shift</h2>$old$) > 0;

-- H118 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$If stock was sold on another till during payment,$old$,
  $new$If stock was sold on another POS device during payment,$new$),
  updated_at = now()
WHERE slug = 'troubleshoot-pos-and-internet-issues' AND status = 'published'
  AND strpos(body, $old$If stock was sold on another till during payment,$old$) > 0;

-- H119 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<h2>Point of Sale exception to understand</h2>$old$,
  $new$<h2>A POS exception to understand</h2>$new$),
  updated_at = now()
WHERE slug = 'understand-pending-and-failed-online-payments' AND status = 'published'
  AND strpos(body, $old$<h2>Point of Sale exception to understand</h2>$old$) > 0;

-- H120 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$Another till can sell the last unit during the charge.$old$,
  $new$Another POS device can sell the last unit during the charge.$new$),
  updated_at = now()
WHERE slug = 'understand-pending-and-failed-online-payments' AND status = 'published'
  AND strpos(body, $old$Another till can sell the last unit during the charge.$old$) > 0;

-- H121 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$search or a register scan return the wrong item.$old$,
  $new$search or a POS scan return the wrong item.$new$),
  updated_at = now()
WHERE slug = 'understand-storemink-skus-and-barcodes' AND status = 'published'
  AND strpos(body, $old$search or a register scan return the wrong item.$old$) > 0;

-- H122 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$contains locations and Point of Sale tools when$old$,
  $new$contains locations and POS tools when$new$),
  updated_at = now()
WHERE slug = 'understand-your-storemink-dashboard' AND status = 'published'
  AND strpos(body, $old$contains locations and Point of Sale tools when$old$) > 0;

-- H123 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<li><strong>Point of Sale:</strong> attach the customer,$old$,
  $new$<li><strong>POS:</strong> attach the customer,$new$),
  updated_at = now()
WHERE slug = 'use-and-understand-store-credit' AND status = 'published'
  AND strpos(body, $old$<li><strong>Point of Sale:</strong> attach the customer,$old$) > 0;

-- H124 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$Two tills or checkouts cannot both spend the same value successfully.$old$,
  $new$Two POS devices or checkouts cannot both spend the same value successfully.$new$),
  updated_at = now()
WHERE slug = 'use-and-understand-store-credit' AND status = 'published'
  AND strpos(body, $old$Two tills or checkouts cannot both spend the same value successfully.$old$) > 0;

-- H125 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$later claiming a till-created profile does not create a second balance.$old$,
  $new$later claiming a profile created in POS does not create a second balance.$new$),
  updated_at = now()
WHERE slug = 'use-and-understand-store-credit' AND status = 'published'
  AND strpos(body, $old$later claiming a till-created profile does not create a second balance.$old$) > 0;

-- H126 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$POS sales use the register lifecycle; pickup orders use the collection workflow.$old$,
  $new$POS sales are completed in store; pickup orders use the collection workflow.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$POS sales use the register lifecycle; pickup orders use the collection workflow.$old$) > 0;

-- H127 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$I am on Point of Sale → Devices.$old$,
  $new$I am on POS → Devices.$new$),
  updated_at = now()
WHERE slug = 'use-storemink-help-assistant' AND status = 'published'
  AND strpos(body, $old$I am on Point of Sale → Devices.$old$) > 0;

-- H128 (A)
UPDATE public.help_articles SET seo_description = replace(seo_description,
  $old$review register orders and Z-reports,$old$,
  $new$review POS orders and Z-reports,$new$),
  updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics' AND status = 'published'
  AND strpos(seo_description, $old$review register orders and Z-reports,$old$) > 0;

-- H129 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$<li>Search register receipts and completed in-store pickup orders$old$,
  $new$<li>Search POS receipts and completed in-store pickup orders$new$),
  updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics' AND status = 'published'
  AND strpos(body, $old$<li>Search register receipts and completed in-store pickup orders$old$) > 0;

-- H130 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$A standard register sale shows Sold at location,$old$,
  $new$A standard POS sale shows Sold at location,$new$),
  updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics' AND status = 'published'
  AND strpos(body, $old$A standard register sale shows Sold at location,$old$) > 0;

-- H131 (A)
UPDATE public.help_articles SET body = replace(body,
  $old$because the goods were handed over at the register.$old$,
  $new$because the goods were handed over at the counter.$new$),
  updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics' AND status = 'published'
  AND strpos(body, $old$because the goods were handed over at the register.$old$) > 0;

-- H132 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Point of Sale → Shifts</strong>$old$,
  $new$<strong>POS → Shifts</strong>$new$),
  updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics' AND status = 'published'
  AND strpos(body, $old$<strong>Point of Sale → Shifts</strong>$old$) > 0;

-- H133 (P)
UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Point of Sale → Money</strong>$old$,
  $new$<strong>POS → Money log</strong>$new$),
  updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics' AND status = 'published'
  AND strpos(body, $old$<strong>Point of Sale → Money</strong>$old$) > 0;

-- H134 (T)
UPDATE public.help_articles SET body = replace(body,
  $old$A customer attached at the till sees the sale under$old$,
  $new$A customer attached in POS sees the sale under$new$),
  updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics' AND status = 'published'
  AND strpos(body, $old$A customer attached at the till sees the sale under$old$) > 0;

-- The category title is in every guide's Help search and Mink chunks
-- ("Category: POS"), and a guide is re-embedded only when its updated_at
-- moves, so every published guide in the category moves with it.
UPDATE public.help_articles SET updated_at = now()
WHERE status = 'published'
  AND category_id = (SELECT id FROM public.help_categories WHERE slug = 'point-of-sale');
