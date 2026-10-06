-- Keep the existing register guide accurate about photo cards.
UPDATE public.help_articles
SET body = replace(body,
  $old$The Sell screen is designed for quick taps and scans. The product grid shows the complete photo in a portrait card, including on a phone. The product grid can be arranged for each location without hiding the rest of the catalogue.$old$,
  $new$The Sell screen is designed for quick taps and scans. Compact product cards show the complete main product photo, name, price and stock, leaving room for two full rows on standard tablet and desktop screens. POS uses the main product photo even when an option has its own photo; a product without a main photo shows a placeholder. Options keep their own names, prices and stock. Long names use up to two lines and option labels stay on one line. Scroll the product area to reach more products or when using a very short window. The product grid can be arranged for each location without hiding the rest of the catalogue.$new$),
  updated_at = now()
WHERE slug = 'customize-register-and-scan-products' AND status = 'published';
