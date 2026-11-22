-- The renewal debit as Razorpay requires it: a notice, then the debit
-- (22 Nov 2026).
--
-- The 21 Nov test-mode run (docs/autopay-verification.md) showed that
-- `POST /payments/create/recurring` is accepted only for an order created
-- with a pre-debit `notification`, and only once the notice period has passed
-- since that notice was delivered: 36 hours 5 minutes for a card, 24 hours for
-- UPI. StoreMink created a plain order and debited it in the same breath, so
-- every automatic renewal was refused. A renewal is now two steps a day or
-- more apart, and the attempt has to remember where it is between them.
--
-- 1. `billing_payment_attempts.debit_after`: the earliest instant the debit
--    may be sent, written when the notified order is created.
--    `billing_payment_attempts.debit_sent_at`: the claim taken immediately
--    before the debit call. It is set by one conditional UPDATE (only while it
--    is null), which is what makes "one attempt, at most one debit" a property
--    of the database, not of the worker's timing. Both nullable with no
--    default: a manual checkout never sets either.
--
-- 2. A partial index for the debit pass, which each hour reads the attempts
--    that were notified and are due.
--
-- 3. Help: the invoices guide said the tries are "a day apart". A card's
--    notice period makes them about a day and a half apart, so the sentence
--    now says what a merchant actually sees. Corrected in place.
--
-- Expand only. The revision being replaced never names the columns.

ALTER TABLE public.billing_payment_attempts
  ADD COLUMN IF NOT EXISTS debit_after timestamptz,
  ADD COLUMN IF NOT EXISTS debit_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS billing_payment_attempts_debit_due_idx
  ON public.billing_payment_attempts (debit_after)
  WHERE debit_after IS NOT NULL
    AND debit_sent_at IS NULL
    AND state = 'processing';

UPDATE public.help_articles SET body = replace(body,
  $old$If a renewal cannot be collected from your saved payment method, StoreMink tries up to three times, a day apart, then emails you to pay that invoice here yourself.$old$,
  $new$Before each automatic renewal, your bank or card issuer sends you a notice of the amount and date. If the renewal cannot be collected from your saved payment method, StoreMink tries up to three times over the following days, with a new notice each time, then emails you to pay that invoice here yourself.$new$),
  updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$If a renewal cannot be collected from your saved payment method, StoreMink tries up to three times, a day apart, then emails you to pay that invoice here yourself.$old$) > 0;
