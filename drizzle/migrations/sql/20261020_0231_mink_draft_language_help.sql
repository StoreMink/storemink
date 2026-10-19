-- What Mink AI writes for the store is in English (owner's request,
-- 2026-10-20): a merchant may talk to Mink in Punjabi, Hindi or any other
-- language and Mink answers in it, but the products, blog posts, page text,
-- offers, emails and social posts it drafts are in English, so customers
-- across India can read them. A merchant who wants another language asks for
-- it; Mink reminds them once of why English helps, then writes it that way.
--
-- The Mink guide's one sentence about language covered only Mink's replies;
-- it is replaced where it stands, nothing is appended. The quoted sentence
-- occurs once in the guide (checked against the local database before
-- writing this).

UPDATE public.help_articles SET body=replace(body, $old$Mink replies in the language you write or speak in, so there is no language to set.$old$, $new$Mink replies in the language you write or speak in, so there is no language to set. What it writes for your store, such as products, blog posts, page text, offers, emails and social posts, is in English so customers across India can read it; ask for another language and Mink reminds you of that, then writes it the way you asked.$new$), updated_at=now() WHERE slug='use-mink-ai-in-your-dashboard' AND status='published';
