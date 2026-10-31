-- The plan guide and the invoices guide after cancelling near a renewal
-- refunds (renewal-cancel design section 12; the code is
-- 20261028_0264_billing_refunds_and_credit_notes and the screens of the same
-- release). What a merchant now does differently:
--   * cancel at any time with Cancel subscription on Plans & Billing; the
--     confirmation names the date the plan ends and what happens to the next
--     renewal, and the plan stays until that date;
--   * an issued renewal they pay themselves is not charged; a renewal payment
--     already taken, or under way and then taken, is refunded after the plan
--     ends, usually within 5 working days (automatic sending ships switched
--     off, decision D2, so the guide promises the usual time, not the moment
--     the plan ends), shown under Refunds on Plans & Billing, with a credit
--     note under View invoices;
--   * Keep my plan works until the plan ends, in grace too;
--   * the invoice list names the statuses the page shows (Due, not Open;
--     Unpaid; Cancelled), the refund line under the status, and the Credit
--     notes table; Pay is not offered for the next renewal while a
--     cancellation stands; an Unpaid invoice can no longer be paid, so the
--     sentence that said the store waits on Free "until payment is settled"
--     is replaced where it stands.
-- The plan guide also loses its five &mdash; entities (owner's no-long-dash
-- rule, decision D8), each rewritten in place.
--
-- New text names the page "Plans &amp; Billing", the page's own heading. The
-- guides' existing mentions of "Plan &amp; billing" are left as they are:
-- the GST release renames them all at once and quotes today's text.
--
-- One statement per sentence that changes, each quoting only that sentence
-- (or list item), each moving updated_at so the Help index re-embeds the
-- guide, and each guarded by strpos so a quote an operator has since edited
-- matches no row; applyVerify then fails the migration rather than leave a
-- guide saying both things. Every quoted string occurs exactly once in the
-- published body on storemink_local (checked 29 Oct 2026 before writing this).
-- Nothing is appended as a new section.
--
-- If the refund code is ever reverted after this has been applied, the Help
-- rollback kept beside the design (not enrolled) puts back what a merchant
-- could then rely on.

-- ── Plan guide: the one inaccurate cancellation item ────────────────────────
UPDATE public.help_articles
SET body = replace(
      body,
      $old$<li>Before a scheduled cancellation takes effect, use <strong>Keep my plan</strong> to resume.</li>$old$,
      $new$<li>You can cancel at any time with <strong>Cancel subscription</strong> on <strong>Plans &amp; Billing</strong>. Before you confirm, the page tells you the date your plan ends and what happens to your next renewal. You keep your plan until that date, usually the end of the cycle you're in, then your store moves to Free.</li><li>If you pay renewals yourself and your renewal invoice is already issued, it won't be charged. If a renewal payment was already taken, or was under way and goes through, StoreMink refunds it after your plan ends, usually within 5 working days, to the account or card you paid with. You can follow it under <strong>Refunds</strong> on <strong>Plans &amp; Billing</strong>, and once it is refunded you can open its credit note from <strong>View invoices</strong>.</li><li>Before your plan ends, choose <strong>Keep my plan</strong> to undo the cancellation, even if a renewal is overdue. If your renewal is already paid, your plan carries on with that payment; if it is overdue, pay it by the date shown to keep your plan. Autopay stays off, so you pay each renewal yourself.</li><li>Your UPI app or bank may still list the autopay mandate after you cancel. StoreMink won't use it, and you can remove it in your app.</li>$new$
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$<li>Before a scheduled cancellation takes effect, use <strong>Keep my plan</strong> to resume.</li>$old$) > 0;

-- ── Plan guide: no long dashes (D8) ─────────────────────────────────────────
UPDATE public.help_articles
SET body = replace(
      body,
      $old$<strong>Card</strong> &mdash; renewals$old$,
      $new$<strong>Card</strong>: renewals$new$
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$<strong>Card</strong> &mdash; renewals$old$) > 0;

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<strong>UPI Autopay</strong> &mdash; renewals$old$,
      $new$<strong>UPI Autopay</strong>: renewals$new$
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$<strong>UPI Autopay</strong> &mdash; renewals$old$) > 0;

UPDATE public.help_articles
SET body = replace(
      body,
      $old$already been tried in the old window &mdash; in which case$old$,
      $new$already been tried in the old window, in which case$new$
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$already been tried in the old window &mdash; in which case$old$) > 0;

UPDATE public.help_articles
SET body = replace(
      body,
      $old$A payment you started and abandoned &mdash; a UPI request you never approved, for example &mdash; does not hold you up$old$,
      $new$A payment you started and abandoned, for example a UPI request you never approved, does not hold you up$new$
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$A payment you started and abandoned &mdash; a UPI request you never approved, for example &mdash; does not hold you up$old$) > 0;

-- ── Invoices guide: an Unpaid invoice can no longer be paid ─────────────────
-- Paying a closed invoice is refused (lib/billing/manual-pay.ts), and money
-- that reaches one anyway is refunded, so the store does not wait on Free for
-- a payment that would restore the plan.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$If an invoice stays unpaid after its due date, the store can move to the Free plan until payment is settled.$old$,
      $new$If an invoice stays unpaid after its due date, the store can move to the Free plan. To return to a paid plan after that, subscribe again.$new$
    ),
    updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$If an invoice stays unpaid after its due date, the store can move to the Free plan until payment is settled.$old$) > 0;

-- ── Invoices guide: the statuses a merchant sees ────────────────────────────
-- The list said "Open" where the page says "Due" (invoices/page.tsx), and had
-- no Unpaid, Cancelled, refund line or credit note. The page's refund lines,
-- first match wins: Refund on its way, Refund delayed, Refunded in full,
-- Refunded {amount}, Extra payment of {amount} returned. A returned duplicate
-- payment never has a credit note (decision D3).
UPDATE public.help_articles
SET body = replace(
      body,
      $old$<li><strong>Open</strong> means payment is due.</li>$old$,
      $new$<li><strong>Due</strong> means payment is due.</li>$new$
    ),
    updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$<li><strong>Open</strong> means payment is due.</li>$old$) > 0;

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<li><strong>Paid</strong> means the invoice is settled.</li>$old$,
      $new$<li><strong>Paid</strong> means the invoice is settled.</li><li><strong>Unpaid</strong> means your plan ended before the invoice was paid. It can no longer be paid; to return to a paid plan, subscribe again.</li><li><strong>Cancelled</strong> means your plan ended before the period the invoice covers, so it won't be charged. If a payment for it was taken, StoreMink refunds it, usually within 5 working days.</li><li>A line under the status shows a refund: <strong>Refund on its way</strong>, <strong>Refunded in full</strong>, <strong>Refunded</strong> with the amount, or <strong>Refund delayed</strong> while our team sorts it out. If you paid an invoice twice, the line shows the extra payment returned.</li><li>Each completed refund has a credit note, listed under <strong>Credit notes</strong> below your invoices and on the invoice it belongs to. A returned extra payment has no credit note.</li>$new$
    ),
    updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$<li><strong>Paid</strong> means the invoice is settled.</li>$old$) > 0;

-- ── Invoices guide: Pay is not offered while a cancellation stands ──────────
-- The refusal's own words (manual-pay.ts CANCELLING_INVOICE_MESSAGE).
UPDATE public.help_articles
SET body = replace(
      body,
      $old$<li>Confirm the invoice belongs to the current store before sharing its reference with support.</li>$old$,
      $new$<li>Confirm the invoice belongs to the current store before sharing its reference with support.</li><li>If you've cancelled your plan, your next renewal invoice can't be paid. To keep your plan, choose <strong>Keep my plan</strong> on <strong>Plans &amp; Billing</strong> first.</li>$new$
    ),
    updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$<li>Confirm the invoice belongs to the current store before sharing its reference with support.</li>$old$) > 0;
