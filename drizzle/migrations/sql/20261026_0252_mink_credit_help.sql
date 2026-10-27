-- The Mink guide stops saying that questions are free (release check, 26 Oct
-- 2026). Every request to Mink has used credits since 0122 (21 Sep), and the
-- guide's credits paragraph says so ("Every request you send to Mink uses
-- credits from your store's balance ..."), but the paragraph beside Stop
-- still said "Asking questions does not spend AI credits." (written by 0093;
-- 0251 removed only its promise of a rate shown before confirming). It now
-- says what the guide's troubleshooting section has said since 0122: every
-- request uses credits, and a reply that does not finish uses none (a stopped
-- reply is never charged, lib/mink/run-stop.ts).
-- Two clauses about the private-draft proposal card go as well: the card has
-- never shown an expected credit weight or the amount it charged (the
-- dashboard shows no credit price, app/dashboard/no-credit-prices.test.ts).
-- Each sentence is edited where it stands; no section is appended. Every
-- quoted string occurs once (checked against the local database before
-- writing this), and an UPDATE whose sentence is not there changes nothing.

UPDATE public.help_articles SET body = replace(body,
  $old$ Asking questions does not spend AI credits. Asking Mink to draft or propose something does.$old$,
  $new$ Every request you send to Mink uses Mink credits, and a reply that does not finish uses none.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$ Asking questions does not spend AI credits. Asking Mink to draft or propose something does.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$a proposal card with the current text, proposed text, destination and expected credit weight.$old$,
  $new$a proposal card with the current text, proposed text and destination.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$a proposal card with the current text, proposed text, destination and expected credit weight.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$ exactly once when it creates the proposal, and the proposal card reports the amount it charged.$old$,
  $new$ exactly once when it creates the proposal.$new$),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND strpos(body, $old$ exactly once when it creates the proposal, and the proposal card reports the amount it charged.$old$) > 0;
