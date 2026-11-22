-- Help: what the upper limit in the payment window means (22 Nov 2026).
--
-- An autopay mandate is registered so that a renewal can be collected
-- whenever it falls due, where it used to be registered for one payment a
-- calendar month (or year). StoreMink's billing cycles are 30 and 365 days and
-- do not line up with a calendar, so sooner or later two renewals fell in one
-- month and the second was refused.
--
-- What a merchant sees differently: Razorpay's payment window states the
-- limit as an amount that can be charged at any time. The plan guide's section
-- on how renewals are charged gains one paragraph saying what that limit is
-- and what StoreMink actually charges.
--
-- Content only; no schema changes.

UPDATE public.help_articles SET body = replace(body,
  $old$The choice applies to the first payment and to every renewal after it.</p>$old$,
  $new$The choice applies to the first payment and to every renewal after it.</p><p>The payment window shows an upper limit for automatic payments. It is a ceiling, not what you pay: StoreMink charges only your renewal amount, once in each billing cycle, and your bank or card issuer sends you a notice before each charge.</p>$new$),
  updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription' AND status = 'published'
  AND strpos(body, $old$The choice applies to the first payment and to every renewal after it.</p>$old$) > 0
  AND strpos(body, 'The payment window shows an upper limit for automatic payments.') = 0;
