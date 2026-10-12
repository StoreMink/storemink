-- Help: Live View, targets, insights and custom reports in Analytics.
--
-- Three new guides (a merchant now does three new things: watches the store
-- live, sets targets, and builds and saves reports), and the dashboard guide
-- gains one section for Insights and Targets plus links to the new guides.
-- Each replace() quotes one heading or list opening published by 0008.

INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT category.id, document.slug, document.title, document.excerpt,
       document.body, 'published', document.seo_title,
       document.seo_description, document.position, now()
FROM public.help_categories AS category
CROSS JOIN (
  VALUES
  (
    'use-analytics-live-view',
    'Watch your store live',
    'See today''s sales and orders as they happen and, on Pro, who is shopping on your storefront right now.',
    $article$<p>Live View shows what is happening in your store right now. Open <strong>Analytics</strong> and select the <strong>Live View</strong> tab. The page updates itself every 15 seconds while it is open.</p>
<h2>What every plan sees</h2>
<ul><li><strong>Total sales today</strong> and <strong>Orders today</strong>, counted from midnight in your business time zone with the same rules as the Analytics dashboard.</li><li><strong>Latest orders</strong>, today's newest orders. Select one to find it in <strong>Orders</strong>.</li></ul>
<h2>What Pro adds</h2>
<ul><li><strong>Visitors right now</strong>: visitors active on your storefront in the last 5 minutes, and <strong>Visitors today</strong>.</li><li><strong>Customer behaviour</strong> in the last 10 minutes: <strong>Active carts</strong> (added to cart, not yet at checkout), <strong>Checking out</strong> (started checkout, not yet paid) and <strong>Purchased</strong>. Each shopper is counted once, at the furthest step they reached.</li><li><strong>Top locations</strong> and <strong>Top products</strong> in the last 30 minutes.</li><li><strong>Live activity</strong>: views, carts, checkouts and orders as they happen, with the shopper's approximate city.</li></ul>
<p>Visitors are counted only after they allow analytics in your storefront's privacy choices, so Live View can show fewer visitors than are really browsing.</p>$article$,
    'Watch your StoreMink store live',
    'Use StoreMink Live View to see sales and orders today, visitors right now, active carts, checkouts and live shopping activity.',
    13
  ),
  (
    'set-analytics-targets',
    'Set and track targets',
    'Set a goal for sales, orders, average order value or new customers and track your progress on the Analytics dashboard.',
    $article$<p>A target is a goal for one number over a period you choose, such as 1,00,000 rupees of sales in October. Targets are available on the Basic and Pro plans and appear at the top of <strong>Analytics</strong> for everyone who can view it.</p>
<h2>Create a target</h2>
<ol><li>Open <strong>Analytics</strong> and select <strong>Create target</strong>. Once you have targets, the button reads <strong>Manage targets</strong>.</li><li>Choose what to measure: <strong>Total sales</strong>, <strong>Orders</strong>, <strong>Average order value</strong> or <strong>New customers</strong>. Pro stores can also choose <strong>Storefront sessions</strong> or <strong>Conversion rate</strong>.</li><li>Choose a period: <strong>This month</strong>, <strong>Next month</strong>, <strong>This quarter</strong>, <strong>This year</strong> or <strong>Custom dates</strong>.</li><li>Enter the target and select <strong>Save target</strong>.</li></ol>
<p>Creating or changing targets needs the Analytics manage permission. The store owner has it; other staff need it added to their role.</p>
<h2>Read a target</h2>
<p>Each target shows how much of the goal you have reached, the current value, the target, the period and the days left. Targets use their own dates, so the dashboard's date filter does not change them.</p>
<ul><li><strong>On track</strong>: for totals such as sales or orders, you have reached at least the share of the target that matches the share of the period gone by. Halfway through the month, half the target is on track.</li><li><strong>Behind</strong>: you are below that pace. For an average or a rate, behind means below the target right now.</li><li><strong>Achieved</strong> or <strong>Missed</strong>: the result once the period ends. Finished targets stay visible for a month.</li><li><strong>Not started</strong>: the period has not begun yet.</li></ul>
<h2>Change or delete a target</h2>
<p>Select <strong>Manage targets</strong>, then the pencil to change a target or the bin to delete it. A store can have up to 20 targets.</p>$article$,
    'Set and track targets in StoreMink Analytics',
    'Create StoreMink Analytics targets for sales, orders, average order value, new customers or traffic, and read on track, behind and achieved.',
    14
  ),
  (
    'build-custom-analytics-reports',
    'Build, save and export your own reports',
    'Choose what to measure and how to group it, save the reports you use, and export them to CSV.',
    $article$<p>On the Basic and Pro plans you can build your own reports in <strong>Analytics</strong> under the <strong>Reports</strong> tab. The tab also lists ready-made reports by category, such as sales by channel, sales by discount code and orders over time. Open any of them to see it in the report builder and change it.</p>
<h2>Build a report</h2>
<ol><li>Open the <strong>Reports</strong> tab and select <strong>New report</strong>, or open a ready-made report.</li><li>Under <strong>Data</strong>, choose <strong>Sales and orders</strong>. Pro stores can also choose <strong>Storefront traffic</strong>.</li><li>Under <strong>Group by</strong>, choose how to split the numbers: by day, week or month, product, product category, sales channel, location, discount code, region, or new and returning customers. Traffic can be grouped by source, device, landing page, referring site, campaign, country, region or city.</li><li>Select up to four <strong>Measures</strong>, such as total sales, orders, discounts or average order value.</li><li>Show the result as a <strong>Line</strong>, <strong>Bar</strong> chart or <strong>Table</strong>.</li></ol>
<p>Use the date range, comparison and location buttons at the top to change the period. The table starts with a <strong>Summary</strong> row and shows the change against the comparison period in every cell. Product and category reports measure order lines, so they offer gross sales, units and orders only: shipping and order discounts do not belong to one product.</p>
<h2>Save a report</h2>
<p>Select <strong>Save report</strong> and give it a name. Saved reports appear at the top of the Reports tab for everyone who can view Analytics, and keep their measures and grouping. The dates follow whatever range you pick when you open them. Saving needs the Analytics manage permission. A store can save up to 50 reports.</p>
<h2>Export to CSV</h2>
<p>Select <strong>Export CSV</strong> to download the table, including the comparison values. The file opens in Excel or Google Sheets, and text that looks like a formula is written as plain text so it cannot run.</p>$article$,
    'Build, save and export StoreMink Analytics reports',
    'Build custom StoreMink Analytics reports by choosing measures and groupings, save them for your team, and export to CSV.',
    15
  )
) AS document(slug, title, excerpt, body, seo_title, seo_description, position)
WHERE category.slug = 'analytics'
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  excerpt = EXCLUDED.excerpt,
  body = EXCLUDED.body,
  status = 'published',
  seo_title = EXCLUDED.seo_title,
  seo_description = EXCLUDED.seo_description,
  position = EXCLUDED.position,
  published_at = COALESCE(help_articles.published_at, now()),
  updated_at = now();

-- The dashboard guide: Insights and Targets, and links to the new guides.
UPDATE public.help_articles
SET body = replace(replace(body,
  $old$<h2>Customize your page</h2>$old$,
  $new$<h2>Insights and targets</h2>
<p><strong>Insights</strong> at the top of the page point out what changed, such as sales rising, a product selling faster or this month's pace against last month. They come from the same numbers as the cards and appear only when a change is large enough to matter. Select <strong>Ask Mink why</strong> to ask Mink to explain one, which uses your Mink credits. On the Basic and Pro plans, <strong>Targets</strong> show your progress towards goals you set. See <a href="/help/analytics/set-analytics-targets">Set and track targets</a>.</p>
<h2>Customize your page</h2>$new$),
  $old$<h2>Choose the right guide</h2>
<ul>$old$,
  $new$<h2>Choose the right guide</h2>
<ul><li><a href="/help/analytics/use-analytics-live-view">Watch your store live</a></li><li><a href="/help/analytics/build-custom-analytics-reports">Build, save and export your own reports</a></li>$new$),
  updated_at = now()
WHERE slug = 'understand-analytics-dashboard' AND status = 'published';
