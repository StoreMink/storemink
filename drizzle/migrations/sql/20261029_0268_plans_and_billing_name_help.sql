-- One name for the billing page in every guide: "Plans &amp; Billing", the
-- page's own heading, the sidebar label from this release and the name in the
-- published Terms (owner decision 11, GST design section 18). Eight mentions
-- in six guides still say "Plan &amp; billing", "Plan & billing" or
-- "Plans &amp; billing". Nothing a merchant does changes; the label they
-- click now reads the same as the text.
--
-- One statement per mention, each quoting the sentence fragment around it so
-- the quote is unique in its guide, each moving updated_at so the Help index
-- re-embeds the guide, each guarded by strpos so an edited quote matches no
-- row (applyVerify then fails the migration). Every quote occurs exactly once
-- in the published body of its guide on storemink_local (checked 30 Oct
-- 2026, after 0267). The coupons guide wrote the ampersand raw; the new text
-- writes &amp; like the rest.

-- ── Understand AI usage and credits ─────────────────────────────────────────
UPDATE public.help_articles
SET body = replace(body,
      $old$<ol><li>Open <strong>Plan &amp; billing</strong>.</li><li>Find <strong>Mink credits &amp; usage</strong>$old$,
      $new$<ol><li>Open <strong>Plans &amp; Billing</strong>.</li><li>Find <strong>Mink credits &amp; usage</strong>$new$),
    updated_at = now()
WHERE slug = 'understand-ai-usage-and-credits' AND status = 'published'
  AND strpos(body, $old$<ol><li>Open <strong>Plan &amp; billing</strong>.</li><li>Find <strong>Mink credits &amp; usage</strong>$old$) > 0;

-- ── View and pay StoreMink invoices (three mentions) ────────────────────────
UPDATE public.help_articles
SET body = replace(body,
      $old$under <strong>Plan &amp; billing</strong>. An amount you currently owe$old$,
      $new$under <strong>Plans &amp; Billing</strong>. An amount you currently owe$new$),
    updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$under <strong>Plan &amp; billing</strong>. An amount you currently owe$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$<ol><li>Open <strong>Plan &amp; billing</strong>.</li><li>Select <strong>View invoices</strong>$old$,
      $new$<ol><li>Open <strong>Plans &amp; Billing</strong>.</li><li>Select <strong>View invoices</strong>$new$),
    updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$<ol><li>Open <strong>Plan &amp; billing</strong>.</li><li>Select <strong>View invoices</strong>$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$<ol><li>Return to <strong>Plan &amp; billing</strong>.</li><li>Find the amber message$old$,
      $new$<ol><li>Return to <strong>Plans &amp; Billing</strong>.</li><li>Find the amber message$new$),
    updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$<ol><li>Return to <strong>Plan &amp; billing</strong>.</li><li>Find the amber message$old$) > 0;

-- ── Create and share customer invoices ──────────────────────────────────────
UPDATE public.help_articles
SET body = replace(body,
      $old$is found under <strong>Plan &amp; billing</strong>. They use separate numbering$old$,
      $new$is found under <strong>Plans &amp; Billing</strong>. They use separate numbering$new$),
    updated_at = now()
WHERE slug = 'create-and-share-customer-invoices' AND status = 'published'
  AND strpos(body, $old$is found under <strong>Plan &amp; billing</strong>. They use separate numbering$old$) > 0;

-- ── Manage your StoreMink plan and subscription (the intro) ─────────────────
UPDATE public.help_articles
SET body = replace(body,
      $old$Open <strong>Plan &amp; billing</strong> to see the effective plan$old$,
      $new$Open <strong>Plans &amp; Billing</strong> to see the effective plan$new$),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$Open <strong>Plan &amp; billing</strong> to see the effective plan$old$) > 0;

-- ── Create and manage coupons (the ampersand was raw) ───────────────────────
UPDATE public.help_articles
SET body = replace(body,
      $old$Open <strong>Plan & billing</strong> for the current allowance and upgrade options.$old$,
      $new$Open <strong>Plans &amp; Billing</strong> for the current allowance and upgrade options.$new$),
    updated_at = now()
WHERE slug = 'create-and-manage-coupons' AND status = 'published'
  AND strpos(body, $old$Open <strong>Plan & billing</strong> for the current allowance and upgrade options.$old$) > 0;

-- ── Create your StoreMink store ─────────────────────────────────────────────
UPDATE public.help_articles
SET body = replace(body,
      $old$Choose a plan any time from <strong>Plans &amp; billing</strong>.</li></ul>$old$,
      $new$Choose a plan any time from <strong>Plans &amp; Billing</strong>.</li></ul>$new$),
    updated_at = now()
WHERE slug = 'create-your-storemink-store' AND status = 'published'
  AND strpos(body, $old$Choose a plan any time from <strong>Plans &amp; billing</strong>.</li></ul>$old$) > 0;
