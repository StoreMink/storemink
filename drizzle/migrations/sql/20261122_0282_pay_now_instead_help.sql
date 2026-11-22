-- Help: paying a scheduled renewal yourself, and going back to an unfinished
-- payment (22 Nov 2026).
--
-- Plans & Billing gained two buttons on an invoice that is not simply due:
--
--   * "Pay now instead", while an automatic renewal is scheduled (the bank's
--     notice has gone out and the payment has not been taken yet). Choosing it
--     cancels the scheduled automatic payment and opens the ordinary payment
--     window.
--   * "Continue payment", when the payment window was opened and closed
--     without paying. It reopens the same payment, so the invoice cannot be
--     paid twice. That state used to show "Processing" with no button.
--
-- The invoices guide said a Processing invoice never offers a button, and
-- told the reader to wait. Three sentences are corrected in place.
--
-- Content only; no schema changes.

UPDATE public.help_articles SET body = replace(body,
  $old$Before each automatic renewal, your bank or card issuer sends you a notice of the amount and date.$old$,
  $new$Before each automatic renewal, your bank or card issuer sends you a notice of the amount and date. While a renewal is scheduled, the page shows the date it will be taken, and you can choose <strong>Pay now instead</strong> to pay it yourself. The scheduled automatic payment is then cancelled, so you are not charged twice.$new$),
  updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$Before each automatic renewal, your bank or card issuer sends you a notice of the amount and date.$old$) > 0
  AND strpos(body, 'While a renewal is scheduled, the page shows the date it will be taken') = 0;

UPDATE public.help_articles SET body = replace(body,
  $old$<strong>Processing</strong> means a payment is already with the gateway. StoreMink does not offer a second Pay button.$old$,
  $new$<strong>Processing</strong> means a payment is already with the gateway, so there is no Pay button. If you opened the payment window and closed it without paying, the invoice shows <strong>Continue payment</strong>, which reopens that same payment.$new$),
  updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$<strong>Processing</strong> means a payment is already with the gateway. StoreMink does not offer a second Pay button.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$<li>Wait when the invoice says payment is already processing.</li>$old$,
  $new$<li>Wait when the invoice says payment is already processing, or choose <strong>Continue payment</strong> when it is offered.</li>$new$),
  updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$<li>Wait when the invoice says payment is already processing.</li>$old$) > 0;
