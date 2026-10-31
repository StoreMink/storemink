-- The plan guide and the signup guide: GST on StoreMink's fees and the Billing
-- details card (GST design section 11; the code is
-- 20261029_0266_gst_on_storemink_fees and the screens of the same release).
-- What a merchant now does differently:
--   * when StoreMink charges GST, they see the total with GST before paying,
--     and the payment window asks for exactly that amount;
--   * they can add their GSTIN, business name, address and state, or their
--     country outside India, under Billing details on Plans & Billing;
--   * signup and the payment step ask for their state when none is on record
--     (signup asks a business in India for its state, or a GSTIN that gives
--     it, before a paid plan while GST is charged or a start is scheduled);
--   * while GST is charged, a business outside India cannot start a new
--     payment (owner decision 5).
-- Every new sentence starts from "When StoreMink charges GST" or "While
-- StoreMink charges GST", so the guides stay true while GST is off, which is
-- how this release ships.
--
-- New text names the page "Plans &amp; Billing" (owner decision 11). The
-- plan guide's older mention in its intro, and the signup guide's, are
-- renamed with the other guides by 20261029_0268_plans_and_billing_name_help.
--
-- Three statements, each quoting only the text it changes, each moving
-- updated_at so the Help index re-embeds the guide, each guarded by strpos so
-- a quote an operator has since edited matches no row (applyVerify then fails
-- the migration), and each refusing to run when its new text is already
-- there. Every quote occurs exactly once in the published body of its guide on
-- storemink_local (checked 30 Oct 2026, after 0266). Nothing is appended to
-- the signup guide: its one sentence about choosing a paid plan is rewritten
-- where it stands.

-- ── Plan guide: what a paid plan needs before you can pay ───────────────────
UPDATE public.help_articles
SET body = replace(
      body,
      $old$<li>Your own verified number under <strong>Settings &rarr; Account</strong> is used first when it is present.</li></ul>$old$,
      $new$<li>Your own verified number under <strong>Settings &rarr; Account</strong> is used first when it is present.</li><li>When StoreMink charges GST on its fees, your invoices must show your state. StoreMink reads it from your GSTIN or the details you have already given. If it can't find one, signup and the payment step ask you to choose it. You can check it at any time under <strong>Billing details</strong> on <strong>Plans &amp; Billing</strong>.</li><li>While StoreMink charges GST, a business outside India can't start a new payment yet. Write to support@storemink.com and we'll help.</li></ul>$new$
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$<li>Your own verified number under <strong>Settings &rarr; Account</strong> is used first when it is present.</li></ul>$old$) > 0
  AND body NOT LIKE '%your invoices must show your state%';

-- ── Plan guide: a task section before "Choose how renewals are charged" ─────
UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>Choose how renewals are charged</h2>$old$,
      $new$<h2>GST and your billing details</h2><p>When StoreMink charges GST on its fees, you see the total with GST before you pay: on <strong>Plans &amp; Billing</strong> for a plan, a plan change or a Mink credit pack, and on the <strong>Locations</strong> page for an extra location. The payment window asks for exactly that amount, and the invoice for it is a tax invoice that shows the GST.</p><p>Under <strong>Billing details</strong> on <strong>Plans &amp; Billing</strong> you can add:</p><ul><li><strong>Your GSTIN</strong>, so it is printed on your invoices and you can claim the GST as input tax credit. Your state is then taken from it.</li><li><strong>Your business name, address and state.</strong> Your state decides whether the invoice shows CGST and SGST or IGST. The card shows which state your invoices use and where it came from.</li><li><strong>Your country</strong>, if your business is outside India.</li></ul><p>Details you save apply to invoices issued after you save them. <strong>An invoice that has already been issued can't be changed</strong>, so add your GSTIN before you pay.</p><h2>Choose how renewals are charged</h2>$new$
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$<h2>Choose how renewals are charged</h2>$old$) > 0
  AND body NOT LIKE '%<h2>GST and your billing details</h2>%';

-- ── Signup guide: the state a paid plan asks for while GST is charged ───────
-- The plan step shows the state (and an optional GSTIN that sets it) above
-- the amount to pay, and Continue waits for it, so the sentence about
-- choosing Basic or Pro is rewritten in the order the screen asks. A business
-- outside India is told on the same screen why only Free is offered while GST
-- is charged; the plan guide's list above says the same.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$For Basic or Pro, choose monthly or yearly billing, select the plan, then select <strong>Continue</strong>.$old$,
      $new$For Basic or Pro, choose monthly or yearly billing and select the plan. When StoreMink charges GST, also choose your business's state, or enter your GSTIN and the state is taken from it. Then select <strong>Continue</strong>.$new$
    ),
    updated_at = now()
WHERE slug = 'create-your-storemink-store' AND status = 'published'
  AND strpos(body, $old$For Basic or Pro, choose monthly or yearly billing, select the plan, then select <strong>Continue</strong>.$old$) > 0
  AND body NOT LIKE '%or enter your GSTIN and the state is taken from it%';
