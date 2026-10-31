-- drizzle/migrations/sql/20261030_0270_content_takedown_help.sql (requires 20261030_0269_content_takedown).
--
-- Merchant-visible: StoreMink can now block one product, page, blog post,
-- collection, review, comment or image on a store, or suspend a whole store
-- after a complaint (the operator takedown tool,
-- 20261030_0269_content_takedown). The merchant is told by email and under
-- Settings, Notices from StoreMink, sees "Blocked by StoreMink" on the item
-- ("Removed by StoreMink" on a review or comment), can reply and edit it, and
-- cannot make it visible again. One new guide for that task, and the reviews
-- guide's "contact support" step is replaced in place now that StoreMink can
-- remove a single review or comment at the store's request. Nothing is
-- appended.
--
-- The guide says "POS" for the selling feature, never the old word, and
-- promises the re-upload refusal for images only: a video goes from the
-- browser straight to storage, so no server sees its bytes.
--
-- The guide goes last in Setting up your store (positions 0 to 12 are taken
-- on storemink_local, checked 30 Oct 2026). ON CONFLICT (slug) DO NOTHING
-- makes a second run insert nothing. The reviews guide's quote occurs exactly
-- once in its published body (checked the same day); the old step does not
-- survive the replacement, so the strpos guard makes a second run update
-- nothing.

INSERT INTO public.help_articles (category_id, slug, title, excerpt, body, status, seo_title, seo_description, position, published_at)
SELECT id,
  'if-storemink-blocks-something-on-your-store',
  'If StoreMink blocks something on your store',
  'What it means when StoreMink blocks a product, page, blog post, collection, review, comment or image on your store, or suspends your store, what your shoppers see, and how to reply.',
  $article$<p>StoreMink sometimes has to block one thing on a store: after a court or government order, after a complaint that it breaks the law or our Acceptable Use Policy, when we find a breach ourselves, or when you ask us to remove a review or comment. We block only that item, not your store.</p>
<h2>How you find out</h2>
<p>We email your store's owners, and the block appears under <strong>Settings</strong>, <strong>Notices from StoreMink</strong>, with our reason. The item itself shows <strong>Blocked by StoreMink</strong> in your dashboard (a review or comment shows <strong>Removed by StoreMink</strong>), and your dashboard home shows a notice until someone opens it. If a court or government order says we must not tell you yet, we tell you as soon as it allows.</p>
<h2>What your shoppers see</h2>
<ul><li>A blocked product, page, blog post or collection disappears from your store, its search and its sitemap, as if it had never been published.</li><li>A blocked review or comment disappears from its page, and a blocked review no longer counts towards the product's stars. Its author can't post another one on the same product or post while it is blocked.</li><li>A blocked image shows as a grey <strong>Image not available</strong> picture on your store.</li></ul>
<h2>What you can do</h2>
<ul><li>Read why in the notice, and reply to tell us your side. If you have fixed the problem, tick <strong>I have fixed this. Please review it again.</strong></li><li>Edit the item while it is blocked. It stays hidden until StoreMink lifts the block. For a page, publish your fixed version, so that it is what shows if the block is lifted.</li><li>Delete the item if you no longer want it.</li><li>If we removed a review or comment because you asked us to and you want it back, reply in the notice and tick <strong>Please show it again</strong>.</li></ul>
<p>You can't make a blocked item visible again yourself, and you can't put a blocked image back on your store, whether you upload it or Mink AI saves it. Anyone who can view <strong>Settings</strong> can read the notices; replying needs permission to manage Settings.</p>
<h2>If we suspend your store</h2>
<p>For a serious breach, such as selling goods the law does not allow, StoreMink can suspend the whole store after a complaint. Your store then closes to shoppers, and you and your staff can't open its dashboard or POS. We email your store's owners with our reason. Reply to that email to tell us your side.</p>
<h2>When a block is lifted</h2>
<p>We tell you by email and in the notice. The item shows again as you last saved it, if it is published.</p>
<h2>The copy StoreMink keeps</h2>
<p>The law requires us to keep a copy of anything we block, with its records, for at least 180 days, and longer if a court or an authority asks. You can't see or change that copy, and deleting the item or your store does not delete it.</p>
<h2>If you disagree</h2>
<p>Reply in the notice. If the block followed a complaint and you are not satisfied with our decision, you can appeal to the Grievance Appellate Committee at gac.gov.in within 30 days. If we blocked it without a complaint, write to our Grievance Officer at support@storemink.com first; you can appeal to the committee within 30 days of the Grievance Officer's decision. A block that follows a court or government order can be lifted only when the order allows it.</p>$article$,
  'published',
  'If StoreMink blocks something on your store',
  'What it means when StoreMink blocks a product, page, blog post, collection, review, comment or image on your store, or suspends your store, what your shoppers see, and how to reply.',
  15,
  now()
FROM public.help_categories WHERE slug = 'storefront'
ON CONFLICT (slug) DO NOTHING;

-- Reviews guide: StoreMink can now remove a single review or comment for the
-- store, so the "contact support" step says what to send and where the
-- answer appears.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$<li>Contact StoreMink support with the store domain and exact content location.</li>$old$,
      $new$<li>Write to support@storemink.com with the page address and which review or comment it is. StoreMink can remove a single review or comment for you, and keeps you informed under <strong>Settings</strong>, <strong>Notices from StoreMink</strong>.</li>$new$
    ),
    updated_at = now()
WHERE slug = 'understand-blog-comments-reactions-and-product-reviews' AND status = 'published'
  AND strpos(body, $old$<li>Contact StoreMink support with the store domain and exact content location.</li>$old$) > 0;
