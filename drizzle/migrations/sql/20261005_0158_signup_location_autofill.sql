UPDATE public.help_articles
SET body=replace(body,
  $old$<li>Add the complete business location. You can type every field even when map or location suggestions are unavailable.</li>$old$,
  $new$<li>Add the complete business location. Select <strong>Use my current location</strong> and allow your browser to share it to fill the address details that can be detected, including the street, area, city, state and postal/PIN code. Review these suggestions before continuing; detection may identify a nearby building. If a field cannot be detected, the form tells you which details to check and complete. You can type or correct every field, and enter your floor, suite or landmark yourself.</li>$new$),
  updated_at=now()
WHERE slug='create-your-storemink-store' AND status='published';
