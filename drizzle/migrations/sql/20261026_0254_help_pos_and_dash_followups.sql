-- Help follow-ups from the POS rename review (26 Oct 2026), and two en
-- dashes the long-dash rule could not see.
--
-- invite-and-manage-dashboard-staff: after a sentence naming all five roles,
-- "They can be chosen once POS is switched on." (written by 0253) read as if
-- Owner, Admin and Staff needed POS too. It names Manager and Cashier now.
--
-- troubleshoot-pos-and-internet-issues: 0253 made the heading "POS opens the
-- product page instead of my store", but "store" usually means the
-- storefront. The section is about pos.storemink.com showing the product site
-- where the merchant expected their own POS, so the heading says that.
--
-- connect-google-analytics-4 (0008) wrote two en dashes in time ranges. They
-- render as the dashes the owner's rule forbids, and the long-dash rule only
-- knew the em dash character, so 0184 left them. The ranges say "to" now,
-- and scripts/help-content-lint.mjs holds every Help migration after this one
-- to publishing no en dash and no dash written as an HTML entity.
--
-- Each sentence is edited where it stands; nothing is appended. Every quoted
-- string occurs once (checked against the local database before writing
-- this), and an UPDATE whose sentence is not there changes nothing.

UPDATE public.help_articles SET body = replace(body,
  $old$They can be chosen once POS is switched on.$old$,
  $new$Manager and Cashier can be chosen once POS is switched on.$new$),
  updated_at = now()
WHERE slug = 'invite-and-manage-dashboard-staff' AND status = 'published'
  AND strpos(body, $old$They can be chosen once POS is switched on.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$<h2>POS opens the product page instead of my store</h2>$old$,
  $new$<h2>pos.storemink.com shows the product page, not my POS</h2>$new$),
  updated_at = now()
WHERE slug = 'troubleshoot-pos-and-internet-issues' AND status = 'published'
  AND strpos(body, $old$<h2>POS opens the product page instead of my store</h2>$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$Initial Realtime data can take roughly 10–30 minutes. Standard reports commonly need 24–48 hours.$old$,
  $new$Initial Realtime data can take roughly 10 to 30 minutes. Standard reports commonly need 24 to 48 hours.$new$),
  updated_at = now()
WHERE slug = 'connect-google-analytics-4' AND status = 'published'
  AND strpos(body, $old$Initial Realtime data can take roughly 10–30 minutes. Standard reports commonly need 24–48 hours.$old$) > 0;
