-- Help: the Analytics Overview shows figures up to a minute old.
--
-- The Overview reuses its figures for one minute (app/dashboard/analytics/
-- cached.ts), so a merchant who places a test order and opens Analytics at
-- once can see a total without it. The troubleshooting checklist for "A sales
-- value is zero" gains one step that says to wait a minute or use Live View,
-- which stays current. The replace() quotes the checklist's last item, which
-- 0008 published and no later migration has edited.

UPDATE public.help_articles
SET body = replace(body,
  $old$<li>Confirm the order was not cancelled.</li></ol>$old$,
  $new$<li>Confirm the order was not cancelled.</li><li>Wait a minute and reload. The Overview updates its figures about once a minute, so a brand-new order can take that long to appear. <strong>Live View</strong> shows orders as they arrive.</li></ol>$new$),
  updated_at = now()
WHERE slug = 'analytics-troubleshooting' AND status = 'published';
