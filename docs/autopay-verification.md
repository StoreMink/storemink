# Autopay — enabled verification rollout

Autopay means StoreMink debits a merchant's registered mandate at renewal
instead of issuing an invoice they pay by hand. It is **enabled in code** as of
2026-08-16 for test-mode staging and an empty production account.

The verification run below is now the rollout checklist. Complete it before
onboarding a real merchant. If any provider shape differs, immediately set
`RECURRING_CHARGE_VERIFIED` back to false; invoice issuance and manual payment
continue without automatic debits.

---

## What "built" covers

| Piece                                       | State                                                         |
| ------------------------------------------- | ------------------------------------------------------------- |
| Customer creation                           | `rzpCreateCustomer` — idempotent via `fail_existing: "0"`     |
| Authorisation order (registers the mandate) | `rzpCreateAuthorizationOrder`                                 |
| Subsequent charge                           | `rzpChargeMandate` + `chargeMandateViaRazorpay`               |
| Mandate recording                           | `activateMandate` in `lib/billing/enrol.ts` (already existed) |
| Collection routing                          | `collectionRoute` — mandate ceiling AND the AFA limit         |
| Unknown-outcome handling                    | `collect.ts` + `lib/billing/reconcile.ts`                     |
| Checkout token capture                      | `ensureRzpCustomer` + `readMandateFromPayment`                |
| Checkout recurring binding                  | `customer_id` + `recurring: true` on Standard Checkout        |
| Authorised ceiling persistence              | `billing_payment_attempts.mandate_max_paise` → mandate        |
| On-session capture verification             | HMAC + payment order/amount/currency/status cross-check       |

The API shapes were taken from Razorpay's published reference on **2026-08-14**,
not inferred:

- `POST /customers` — `{name, email, contact, fail_existing: "0"}`
- `POST /orders` — `{amount, currency, customer_id, method, token: {max_amount, expire_at, frequency}}`
- `POST /payments/create/recurring` — `{email, contact, amount, currency, order_id, customer_id, token, recurring}`

What is **not** verified is live behaviour: what a real decline looks like, what
arrives on a retry, and how UPI mandate confirmation is timed.

---

## Two things that shaped the design

**A recurring charge is TWO calls.** `/payments/create/recurring` requires an
`order_id`, so the implementation creates an order and then charges it. The gap
between them is the risk: an order created and a charge we never got an answer
to is indistinguishable from a charge that worked. Every failure in
`chargeMandateViaRazorpay` therefore maps deliberately, and the default is
`unknown` — never `failed`. `collect.ts` never retries an unknown and never
opens a grace window for one.

**₹99,999 is Razorpay's ceiling on `token.max_amount`.** A Pro-yearly merchant
with five extra locations provisions to ₹1,16,000, and their _authorisation
order_ would be rejected — they could not set autopay up at all, with an opaque
gateway error. `mandateFitsGateway()` answers that instead of clamping: a
clamped mandate would be created, never usable, and the merchant would be told
autopay was on. Offering nothing is honest; offering a mandate we cannot charge
is the "promise a charge that never comes" failure again.

---

## How the mandate is captured

Paid enrolment begins only from a store's **Plans & Billing** dashboard; signup
always creates a Free store and never opens Razorpay. `startEnrolment` creates a
Razorpay customer and an AUTHORISATION order instead of a plain one. All three
of these must hold:

- `RECURRING_CHARGE_VERIFIED` is true (we can actually collect),
- `mandateFitsGateway(size)` — above ₹99,999 the authorisation order itself is
  rejected,
- the owner has both an email and phone, since the authorisation customer and
  subsequent recurring debit require them.

Fail any one and enrolment stops **before Checkout opens**, with an explicit
"No payment was taken" message. A paid subscription is an autopay product; it
must never silently degrade to a one-time first cycle. Manual payments remain
available for already-issued renewal invoices, and AI credits remain one-time.

**★★ `confirmEnrolment` then reads the token from the PAYMENT, not from the
browser.** Razorpay Checkout's success handler returns a payment id, an order id
and a signature — never a token — so a client-supplied `token_id` would be a
value the browser chose, and attaching a mandate is standing permission to debit
that merchant every cycle. `GET /payments/:id` returns `token_id` and
`customer_id`, and we have just verified that payment's signature.

The same server-created customer id is supplied to Checkout **together with
`recurring: true`**. Razorpay Standard Checkout defaults `recurring` to false;
the retired 2026-08-16 signup payment flow supplied only `customer_id`, so
Checkout legitimately collected the first invoice as a one-time payment. A regression test now pins
both fields for mandate orders and their absence for AI-credit/other one-time
orders. Resuming a dismissed authorisation checkout also restores both fields.

Before an entitlement is granted, StoreMink fetches the returned payment id and
requires its `order_id`, amount, currency and `captured` status to match the
durable attempt. If Razorpay's read endpoint is temporarily unavailable, the
cryptographically verified checkout HMAC remains the availability fallback and
the existing reconciliation sweep remains the after-the-fact source of truth.

A failed lookup returns null and the plan is still granted: the money is already
captured, so losing autopay is the acceptable half of that trade.

The exact `token.max_amount` sent in the authorisation order is written to the
payment attempt before checkout (`billing_09`) and copied into the mandate on
confirmation. It is never accepted from the browser or recomputed after a
pricing/tax change.

---

## The verification run

Use a **test-mode** account (`rzp_test_…`) and a store you do not mind billing.

### 1. Charge shape

With test-mode platform credentials configured, subscribe a disposable staging
store and confirm:

- [x] `POST /customers` returns a `cust_…` id, and calling it twice with the
      same email returns the **same** id rather than an error. (21 Nov 2026,
      test mode.)
- [x] `POST /orders` with a `token` block returns an order (not a 400 about
      unexpected fields). (21 Nov 2026, test mode, card rail.)
- [x] Standard Checkout receives the same `customer_id` and explicit
      `recurring: true` for a mandate order (pinned by client regression test).
- [x] `POST /orders` with `payment_capture` and `notification` returns an
      order whose notice is delivered about a minute later. (21 Nov 2026,
      test mode, through `razorpayRecurringGateway.notify`.)
- [ ] `POST /payments/create/recurring` on that order, once its notice period
      has passed, returns `razorpay_payment_id`. **★★ NOT YET PROVEN: the
      first notified test orders can be debited from 23 Nov 2026, 11:28 IST.
      See the run below.**
- [ ] Note the exact `status` values you see. If any is outside
      `mapGatewayStatus`'s list, add it there — an unrecognised status resolves
      to `unknown`, which is safe but leaves the invoice for reconciliation.

### The 21 Nov 2026 test-mode run: what was seen

Run against the test account in `.env` (`rzp_test_…`), through StoreMink's own
gateway functions (`lib/payments/razorpay.ts`) and Razorpay's real test
Checkout. No real money moved.

**What worked, exactly as built:**

- `rzpCreateCustomer` created a customer and returned the same id when called
  again with the same contact.
- `rzpCreateAuthorizationOrder` (card rail, ₹100 now, ceiling ₹5,000,
  monthly, five-year expiry) was accepted.
- Checkout opened with the options `openRazorpayModal` passes (`customer_id`
  with `recurring: true`) and showed the mandate terms correctly: "a payment
  of ₹100 will be charged now. StoreMink may then charge up to ₹5,000 per
  month until 20 Nov 2031". It offered cards only, as the order's rail said.
- The test card authorised, the success handler returned a payment id, an
  order id and a signature, and `verifyCheckoutSignature` accepted it.
- `verifyCapturedCheckoutPayment` passed (order, amount, currency, captured,
  read from the gateway).
- `GET /payments/:id` returned `status: captured`, `method: card`, a
  `token_id` and the `customer_id`: everything `readMandateFromPayment` needs.
  The token read back as `recurring: true`,
  `recurring_details.status: confirmed`, `max_amount: 500000`.

**★★ What did not: the renewal debit, and why (corrected the same day).**
`POST /payments/create/recurring`, sent the way `chargeMandateViaRazorpay`
sends it at every renewal, was refused with HTTP 400, `BAD_REQUEST_ERROR`,
"The requested URL was not found on the server.", and no payment was created.

The first reading was that Razorpay had not enabled the Recurring Payments API
on the account. **That was wrong, or at least not the whole story.** Razorpay's
"create subsequent payments" pages (cards and UPI) describe a step StoreMink
does not take: the ORDER for a subsequent payment carries `payment_capture`
and a `notification` object (`token_id`, optionally `payment_after`), which is
the pre-debit notification Razorpay sends the customer. Re-run with the order
built that way, the same endpoint answered with real business rules:

| Order sent                                             | What the debit call answered                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| As StoreMink sends it (no `notification`)              | 400 "The requested URL was not found on the server."                           |
| With `payment_capture: true` only                      | the same                                                                       |
| With `payment_capture` and `notification`              | 400 `pre_debit_notification_failed` (the notice was not delivered yet)         |
| The same order a minute later (notification delivered) | 400 "Debit can be attempted 36 hours after sending the pre-debit notification" |
| An order asking for a debit two minutes ahead          | refused at ORDER creation with that same 36-hour rule                          |

So the endpoint is live on this account. **What is missing is in StoreMink's
own flow:** a renewal has to be two steps at least 36 hours apart for a card
(the UPI page says 24 hours), not one:

1. Create the order with its `notification` (Razorpay sends the pre-debit
   notice). `payment_after` defaulted to 36 hours 5 minutes ahead.
2. At or after `payment_after`, call `POST /payments/create/recurring` on that
   order.

`chargeMandateViaRazorpay` creates a plain order and debits it in the same
breath, which is the path Razorpay answers with "URL not found".

**Not yet proven:** that the debit then SUCCEEDS once the 36 hours have
passed. The order `order_U2tkdTXDXc6hig` was created with its notification on
21 Nov 2026 (delivered 16:54 UTC) and may be debited from
**23 Nov 2026, 05:53 UTC (11:23 IST)**:

```bash
node scripts/autopay-test-debit.mjs \
  --customer cust_U2tCpF6i2o1LPF --token token_U2tEUgvp4hWNEV \
  --order order_U2tkdTXDXc6hig
```

The script refuses anything but an `rzp_test_` key. `--notify true` creates a
fresh notified order when that one has been used.

**What it meant on 21 Nov.** A merchant could subscribe and authorise
autopay, and the first payment was taken. At renewal every automatic debit was
refused before it reached a bank, and after three refused tries the merchant
was emailed to pay the invoice by hand. Nobody was charged twice and nobody
lost a plan they paid for, but autopay collected nothing.

### 21 Nov 2026: the renewal rebuilt as Razorpay's two steps

Built on branch `fixes` (migration `0281`), from Razorpay's "create subsequent
payments" pages for cards and UPI.

**Step 1, the collect pass (`collectInvoice`, `lib/billing/collect.ts`).**
Four days before the cycle begins the hourly job issues the invoice and, when
it can be collected automatically, creates the order with
`payment_capture: true` and `notification { token_id, payment_after }`. That
is the pre-debit notice: Razorpay sends it to the customer. The attempt is
recorded as `processing` with the order id and `debit_after`, the earliest
instant the debit may be sent. No money moves.

**Step 2, the debit pass (`sendDueDebits`, `lib/billing/debit-pass.ts`).** The
same hourly job comes back once `debit_after` has passed and, in this order:

1. checks the invoice is still owed and its cycle is one the store will enter
   (a cancelled plan's is not);
2. checks StoreMink still holds the mandate as `active`;
3. asks the gateway whether the mandate is still chargeable (`verifyMandate`:
   only a `confirmed` token may be debited);
4. reads the order's `notification` back: delivered, and the notice period
   passed by the gateway's own clock (36 hours 5 minutes after delivery for a
   card, 24 hours for UPI, plus a 5 minute margin);
5. claims the debit (one conditional write of `debit_sent_at`) and only then
   calls `POST /payments/create/recurring`.

**The rules it holds:**

| Rule                                                    | How                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One attempt gets at most one debit                      | `debit_sent_at` is set only while it is null; two runs cannot both win it                                                                                                                                                                   |
| A cancelled plan is never debited                       | cancelling withdraws the scheduled debit at once, and the debit pass re-reads the cancellation, the invoice and the mandate before every debit                                                                                              |
| A mandate the customer cancelled or paused is not tried | the gateway is asked before the invoice is issued (so the one issue notice says "pay this", not "nothing to do"), before every retry and before every debit; StoreMink's record follows (`revoked`, `expired`, `failed`, paused: `unknown`) |
| An unknown outcome is never a failure                   | a throw, a timeout or a 5xx on the debit leaves the attempt `unknown`; reconciliation reads the order                                                                                                                                       |
| An attempt is never closed over a debit in flight       | every write that ends a notified attempt without debiting it is conditional on `debit_sent_at` still being null                                                                                                                             |
| Waiting ends                                            | a gateway silent for 24 hours fails the try (debit pass) or issues the invoice to pay by hand (collect pass); a notice undelivered 12 hours past its debit time fails the try                                                               |
| Reconciliation does not fail a waiting attempt          | attempts still inside their notice period are not read; its clocks run from `debit_sent_at`                                                                                                                                                 |

**Retries.** Still three automatic tries, then the merchant is asked to pay by
hand (owner's rule, 21 Nov). Each try now needs its own notice, so for a card
the tries fall about a day and a half apart, not 24 hours: notice at T-4d and
debit at about T-2.5d, a second debit at about T-1d, and the third just after
the cycle turns. The invoice is `processing` while a try is under way, so no
grace starts on a payment still in flight.

**What the merchant sees.** Plans & Billing shows "Your renewal is scheduled"
with "Autopay on or after <date>" while a debit is waiting out its notice,
where it used to say "Payment in progress". The renewal email says the bank or
card issuer will send a notice first. A mandate cancelled at the bank gets the
"Autopay is no longer active" email once.

**Paying a scheduled renewal by hand (22 Nov 2026, owner's request).** The
scheduled row carries **Pay now instead**. After a confirmation that names the
amount and says the scheduled automatic payment will be cancelled,
`startInvoicePayment` (called with `insteadOfAutopay`) withdraws the scheduled
debit (`withdrawUnsentDebits`, the same guarded write a cancellation uses, so
a debit already sent to the bank is never replaced and the start is refused)
and opens an ordinary checkout. Every refusal that applies to any invoice is
checked before the withdrawal, so nothing is withdrawn for a payment that
would be refused anyway.

A payment window that is opened and closed without paying is no longer a dead
end. The row shows **Continue payment**, and the start reopens the SAME
gateway order after reading it: never an order that is paid, never one with a
payment still waiting for approval (`orderIsUntouched`,
`lib/billing/order-state.ts`), never one that could not be read. Before, such
an invoice read "Payment in progress" until reconciliation gave the attempt up
72 hours later. If the merchant never comes back, that still happens, and the
next automatic try then starts by itself with a new notice.

**Checked in test mode on 21 Nov 2026, through the real gateway functions:**

- `checkMandate` on the confirmed test token: `chargeable`.
- `notify`: an order with its notification, `debit_after` 36.5 hours ahead
  (the request asks 36 h 30 min so Razorpay's own 36 h 5 min floor is never
  missed).
- `readNotice` at once: `undelivered`. After 75 seconds: `wait` until
  delivery + 36 h 5 min + the 5 minute margin.
- A token id that does not exist: HTTP 400 "The id provided does not exist".
  `checkMandate` reads that as `unknown`, on purpose: a wrong key or account
  answers the same for every mandate, and acting on it as "cancelled" would
  switch autopay off for every store at once. The bounded waits above are what
  end it.

**★★ Still not proven: that the debit SUCCEEDS after the notice period.** Two
notified test orders are waiting:

| Order                  | May be debited from               |
| ---------------------- | --------------------------------- |
| `order_U2tkdTXDXc6hig` | 23 Nov 2026 05:58 UTC (11:28 IST) |
| `order_U2uKXBRjzCck0D` | 23 Nov 2026 06:02 UTC (11:32 IST) |

```bash
node scripts/autopay-test-debit.mjs \
  --customer cust_U2tCpF6i2o1LPF --token token_U2tEUgvp4hWNEV \
  --order order_U2tkdTXDXc6hig
```

The script refuses anything but an `rzp_test_` key. `--notify true` creates a
fresh notified order when both have been used. If the debit answers with a
status `mapGatewayStatus` does not list, add it there.

**Left as the owner's decision:**

- **The mandate's frequency.** Mandates are registered `monthly` (or `yearly`),
  and StoreMink's cycle is 30 days, so over the years two renewals can fall in
  one calendar month of the mandate. Razorpay's UPI page says NPCI allows one
  successful debit on a token per billing cycle. Test mode accepts
  `as_presented` on both rails, which removes that limit, but Checkout then
  tells the merchant "StoreMink may charge up to ₹5,000 anytime" where it now
  says "per month". Not changed. Existing mandates keep the frequency they
  were registered with either way.
- **The Razorpay support ticket** is no longer needed for enabling anything.
  The one useful question left for them is why an order with no `notification`
  is answered "URL not found" where a plain validation error would do.

**Seen and not yet explained (check again once debits work):**

- The token's own top-level `status` read `failed` although
  `recurring_details.status` was `confirmed`, and its `expired_at` was the end
  of the current month, not the five years asked for. Both may be artefacts of
  test mode.
- Checkout refused the prefilled contact `9876543210` as an invalid mobile
  number and asked for one. A real merchant's number is not affected, but a
  placeholder number in a test will stop at that screen.

Not exercised, because no debit has been allowed through yet: a real decline,
a debit over the mandate ceiling, and a timeout.

### 2. The outcomes that matter more than the happy path

- [ ] **Decline** — force one (test cards documented by Razorpay). Confirm the
      result maps to `rejected`, and that `collect.ts` records a failed attempt
      and opens the grace window rather than retrying.
- [ ] **Over the mandate ceiling** — charge more than `max_amount`. Confirm the
      gateway refuses and that `collectionRoute` would have routed it to manual
      first.
- [ ] **Over the AFA limit** (₹15,000) — confirm `collectionRoute` returns
      `over_afa_limit` and no charge is attempted.
- [ ] **Timeout** — kill the network mid-charge. Confirm the attempt lands in
      `unknown` and that `lib/billing/reconcile.ts` settles it on the next
      sweep by asking Razorpay directly. Inspect the attempt first: its
      `provider_order_id` must already be present, because the implementation
      now persists that handle before submitting the debit.

### 3. Idempotency

- [ ] Run the same collection twice. The partial unique index on
      `billing_payment_attempts` must refuse the second, and the merchant must
      be charged **once**.
- [ ] Confirm `idempotency_key` appears in the payment's `notes` at Razorpay —
      that copy connects the provider object to our durable attempt.
- [ ] Ask Razorpay support/test mode whether `/payments/create/recurring`
      supports a provider-side idempotency header. The published recurring API
      reference does not promise one; do not reuse the refund-only
      `X-Refund-Idempotency` header without confirmation.

### 4. Release status

- [x] `RECURRING_CHARGE_VERIFIED` enabled for staging / empty-production
      verification on 2026-08-16.
- [ ] Apply `billing_09_attempt_mandate_ceiling.sql` to staging and
      production before deploying this code.
- [ ] Watch the first live renewal cycle end to end before trusting it.

---

## If it goes wrong after the flip

Set it back to `false`. The renewal worker returns to issuing invoices merchants
pay by hand — a complete billing path that has been the only one in use all
along. Nothing is lost but automation, and no merchant loses their plan for it:
`collect.ts` treats an absent charge function as `manualRequired`, never as a
failure, so no grace clock starts.
