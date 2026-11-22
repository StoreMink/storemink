-- Payment robustness (21 Nov 2026): one column, and the Help sentences the
-- same release makes untrue.
--
-- 1. `store_payment_providers.webhook_last_event_at`: when Razorpay last
--    delivered an event whose signature verified against this store's webhook
--    secret. The dashboard used to read "active" as soon as a secret was
--    generated, although the merchant still had to paste the address and the
--    secret into Razorpay by hand, so a store that never did was told its
--    orders were being confirmed instantly while nothing was arriving. The
--    webhook route stamps this column (at most once an hour per store) and
--    the panel says "receiving events" only when it is set. Nullable, no
--    default: every existing store starts as "not confirmed yet" until its
--    next delivery, which is the truth. Expand only; the revision being
--    replaced never names the column.
--
-- 2. Help, each sentence corrected in place:
--    - Razorpay guide: what the webhook status means, and that the account
--      cannot be disconnected or replaced while an online payment is still in
--      progress (its keys are the only ones that can confirm that payment).
--    - Pending payments guide: an expired unpaid order now gives its offer
--      use back as well, and a returning customer's unfinished payment is
--      checked before a second order can be started.
--    - Invoices guide: a renewal that cannot be collected automatically is
--      tried three times, a day apart, and then the merchant is emailed to
--      pay it by hand.

ALTER TABLE public.store_payment_providers
  ADD COLUMN IF NOT EXISTS webhook_last_event_at timestamptz;

UPDATE public.help_articles SET body = replace(body,
  $old$StoreMink later shows connection state and the webhook URL, but it does not reveal either saved secret again.$old$,
  $new$StoreMink later shows connection state and the webhook URL, but it does not reveal either saved secret again. The webhook reads <strong>not confirmed yet</strong> until Razorpay delivers its first event, usually your next online payment, and <strong>receiving events</strong> after that.$new$),
  updated_at = now()
WHERE slug = 'connect-razorpay-and-accept-online-payments' AND status = 'published'
  AND strpos(body, $old$StoreMink later shows connection state and the webhook URL, but it does not reveal either saved secret again.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$Disconnecting removes StoreMink's saved credentials; it does not close or alter the Razorpay account.$old$,
  $new$Disconnecting removes StoreMink's saved credentials; it does not close or alter the Razorpay account. You cannot disconnect, or connect a different Razorpay account, while a customer's online payment is still in progress: pause online payments first, then try again at the time the message shows, at most 45 minutes later. New keys for the same Razorpay account can be saved at any time.$new$),
  updated_at = now()
WHERE slug = 'connect-razorpay-and-accept-online-payments' AND status = 'published'
  AND strpos(body, $old$Disconnecting removes StoreMink's saved credentials; it does not close or alter the Razorpay account.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$Reserved stock and coupon use are released through the order workflow.$old$,
  $new$Reserved stock, coupon use and offer use are released through the order workflow.$new$),
  updated_at = now()
WHERE slug = 'understand-pending-and-failed-online-payments' AND status = 'published'
  AND strpos(body, $old$Reserved stock and coupon use are released through the order workflow.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$StoreMink therefore treats the browser result as one signal, not the only source of truth.$old$,
  $new$StoreMink therefore treats the browser result as one signal, not the only source of truth. When that customer opens checkout again, StoreMink checks their unfinished payment with Razorpay first: a payment that went through confirms the order, and no second order is started.$new$),
  updated_at = now()
WHERE slug = 'understand-pending-and-failed-online-payments' AND status = 'published'
  AND strpos(body, $old$StoreMink therefore treats the browser result as one signal, not the only source of truth.$old$) > 0;

UPDATE public.help_articles SET body = replace(body,
  $old$An amount you currently owe appears above the rest of the page so it is not missed.$old$,
  $new$An amount you currently owe appears above the rest of the page so it is not missed. If a renewal cannot be collected from your saved payment method, StoreMink tries up to three times, a day apart, then emails you to pay that invoice here yourself.$new$),
  updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices' AND status = 'published'
  AND strpos(body, $old$An amount you currently owe appears above the rest of the page so it is not missed.$old$) > 0;
