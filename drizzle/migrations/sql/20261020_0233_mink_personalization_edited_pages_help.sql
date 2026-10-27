-- A storefront personalisation leaves a page the merchant changed alone
-- unless they agree, the homepage included, and on any page it rewrites only
-- what is still the theme's own: a section the merchant wrote keeps their
-- words. The guide's personalisation paragraph (0232) said what Mink rewrites
-- and not what it leaves, so a merchant who had edited their homepage would
-- not know to ask for it. One sentence is added inside that paragraph, after
-- the sentence it qualifies; nothing is appended to the guide. The quoted
-- sentence occurs once in the guide (checked against the local database
-- before writing this).

UPDATE public.help_articles SET body=replace(body, $old$suggests colours and fonts, and can take the theme's sample products off your shop.$old$, $new$suggests colours and fonts, and can take the theme's sample products off your shop. A page you have changed yourself, your homepage included, is left as it is unless you ask Mink to include it, and text you wrote yourself always stays as you wrote it.$new$), updated_at=now() WHERE slug='manage-your-website-with-mink-ai' AND status='published';
