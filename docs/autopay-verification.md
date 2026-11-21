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
- [ ] `POST /payments/create/recurring` against a confirmed token returns
      `razorpay_payment_id`. **★★ BLOCKED, 21 Nov 2026: Razorpay answers HTTP
      400 `BAD_REQUEST_ERROR`, "The requested URL was not found on the
      server." See the run below.**
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

**★★ What did not: the renewal debit.** `POST /payments/create/recurring`
(the call `chargeMandateViaRazorpay` makes at every renewal) was refused with
HTTP 400, `BAD_REQUEST_ERROR`, "The requested URL was not found on the
server.", and no payment was created on the order. The path and the request
body match Razorpay's published reference. Razorpay labels its Recurring
Payments API "an on-demand feature. Please raise a request with our Support
team to get this feature activated on your Razorpay account", and it documents
this same message for a feature that is not enabled. So **the account can
register a mandate but is not allowed to debit one.**

**What that means today.** A merchant can subscribe and authorise autopay, and
the first payment is taken. At renewal every automatic debit is refused before
it reaches a bank. With the retry rule that is three refused tries (four,
three and two days before the cycle turns) and then the "Automatic payment
didn't go through" email asking them to pay the invoice by hand, which works.
Nobody is charged twice and nobody loses a plan they pay for, but **autopay
does not collect anything until Razorpay enables the feature**, on the LIVE
account as well as the test one (the live account has not been checked).

**To do, in order:**

1. Ask Razorpay support to enable the **Recurring Payments API** (subsequent
   payments, `POST /v1/payments/create/recurring`, for cards and UPI Autopay)
   on both the test and the live account.
2. Re-run the debit in test mode. The mandate from this run is still
   registered, so it is one command and needs no browser:

   ```bash
   node scripts/autopay-test-debit.mjs \
     --customer cust_U2tCpF6i2o1LPF --token token_U2tEUgvp4hWNEV
   ```

   The script refuses anything but an `rzp_test_` key. Then force a decline by
   asking for more than the mandate's ₹5,000 ceiling (`--amount 600000`) and
   note the status and error it returns.

3. Only then tick the remaining boxes below.

**Seen and not yet explained (check again once debits work):**

- The token's own top-level `status` read `failed` although
  `recurring_details.status` was `confirmed`, and its `expired_at` was the end
  of the current month, not the five years asked for. Both may be artefacts of
  test mode.
- Checkout refused the prefilled contact `9876543210` as an invalid mobile
  number and asked for one. A real merchant's number is not affected, but a
  placeholder number in a test will stop at that screen.

Not exercised, because the debit call is refused before it does anything: a
real decline, a debit over the mandate ceiling, and a timeout.

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
