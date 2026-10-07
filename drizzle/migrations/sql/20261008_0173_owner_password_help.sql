-- The store password now applies to the owner as well: nobody, signed in or
-- not, sees the storefront before Go live without entering it. The setup guide
-- said otherwise (0171), so that sentence is corrected in place.
UPDATE public.help_articles
SET body = replace(body,
  $old$Visitors who reach your store address see a password page; you and your staff can browse the real shop by signing in, and anyone you share the password with can preview it. Dashboard Home shows a go-live checklist and the password.$old$,
  $new$Everyone who reaches your store address — you included — sees a password page until then. Dashboard Home shows the password next to <strong>Go live</strong>: enter it to preview the shop exactly as a customer will, and share it with anyone who should see the store early.$new$),
  updated_at = now()
WHERE slug = 'complete-your-store-setup' AND status = 'published';
