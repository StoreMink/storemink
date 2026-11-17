-- The dashboard's Mink AI pop-out (10 Nov 2026). An "Ask Mink AI" tab now
-- hangs under the Mink AI face in the top bar; pointing at it or tabbing to
-- it opens a bar where the merchant types a question, and asking opens the
-- side panel. The face itself is the yellow Mink AI face (since 31 Oct 2026),
-- not the purple robot, and inside the Website Builder the Mink AI button is
-- in the builder's own top bar (since 26 Oct 2026). Four sentences of the
-- dashboard Mink AI guide are corrected in place, one UPDATE each; nothing is
-- appended. Content only; no schema changes.

UPDATE public.help_articles SET body = replace(body,
  $old$Select the Mink AI button in the top bar, or use <strong>Ask anything</strong> on Home.$old$,
  $new$Select the Mink AI face in the top bar, or, on a computer, point at <strong>Ask Mink AI</strong> under it and type your question, or use <strong>Ask anything</strong> on Home.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$Select the Mink AI button in the top bar, or use <strong>Ask anything</strong> on Home.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$The purple robot mark in the dashboard header opens Mink AI.$old$,
  $new$The yellow Mink AI face in the top bar opens Mink AI.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$The purple robot mark in the dashboard header opens Mink AI.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$Open Website Builder and click the purple Mink AI icon in the shared top header.$old$,
  $new$Open Website Builder and select the Mink AI button in the builder's top bar.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$Open Website Builder and click the purple Mink AI icon in the shared top header.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$If chat does not appear, refresh after saving any pending editor work and try the top-header icon again.$old$,
  $new$If chat does not appear, refresh after saving any pending editor work and select the Mink AI button in the builder's top bar again.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$If chat does not appear, refresh after saving any pending editor work and try the top-header icon again.$old$) > 0;
