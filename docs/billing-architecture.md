# Billing & Payments — Phase 1 architecture

> **Status:** draft v1 (2026-08-11) · **Owner:** Vansh · **Purpose:** the design
> StoreMink's billing system is built to, per the production-grade billing spec.
> No production customers exist, so this replaces the current Razorpay
> Subscriptions design rather than migrating it.

> **Free grants layered over a paid subscription** (an operator comping a month
> of Pro to a store already paying for Basic) are specified separately in
> **`docs/comped-plans-spec.md`**. That case does not belong here because the
> correct answer is to keep it OUT of the billing tables entirely: a comp is an
> entitlement overlay resolved at read time, never a cycle, an invoice or a
> mutation of `stores.plan`.

**Decisions already settled by the owner** (2026-08-11) and treated as fixed
inputs below:

1. **A 30-day cycle means exactly 30 days.** Never a calendar month.
2. **Automatic downgrade to Free after the 2-day buffer**, as specified.
3. **GST is operator-configured**, not merchant-facing. There is no platform
   GSTIN yet; the system must work without one and start charging tax when one
   is entered in the operator dashboard.
4. **Yearly is 365 days**, held in the same period config as monthly's 30.
   ⚠ Consequence, and it is the 30-day rule's logic applied consistently: a
   365-day cycle is a DURATION, not an anniversary, so it drifts by a day across
   every leap year. A cycle starting 1 Jan 2028 ends 31 Dec 2028. Pinned by a
   test so nobody "fixes" it into an anniversary later.
5. **Downgrade force-closes an open POS shift with a system note.** `posEnabled`
   goes false at downgrade, so the till stops; an open shift holds uncounted
   cash, and leaving it open strands the drawer with no way to reconcile it.
   The close is part of the downgrade transaction, attributed to the system
   rather than to a cashier, with `counted = expected` and a note naming the
   downgrade — a variance invented by a billing event would otherwise read as a
   cashier being short.

---

## 1. The core seam

```
        StoreMink Billing                    Razorpay
    (source of truth for WHAT              (collects money,
      is owed and WHEN)                     reports outcomes)
              │                                   │
      invoice + line items  ──────────▶  order + recurring payment
              ▲                                   │
              └──────── webhook / verification ───┘
```

StoreMink owns: plan, entitlement, pricing, cycle, locations, invoices, line
items, payment obligations, grace, downgrade. Razorpay owns: mandates, tokens,
and the movement of money. **A Razorpay Plan is never the source of truth for an
amount**, which is what today's design gets wrong (§2).

---

## 2. Why the current design is replaced, not migrated

Verified against Razorpay's live documentation, August 2026:

| Finding                                                                                                               | Consequence                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "You can only update a Subscription authorised using cards and not via UPI and Emandate."                             | Every amount change — tier, period, locations — is impossible for a UPI or e-mandate subscriber. Both `changePlan` and `changeBilledLocations` call the same `rzpUpdateSubscription`, so both are dead on those methods. |
| Add-ons are deprecated ("You are unable to use the Add-Ons feature since it is deprecated.")                          | The usual mid-cycle-charge escape hatch is closed.                                                                                                                                                                       |
| AFA-exempt limit is **₹15,000 per debit**, UPI and cards alike (see §2a)                                              | Most bills auto-collect. Yearly plans do not.                                                                                                                                                                            |
| Recurring payments are created by us, per charge: create order → create recurring payment against a `confirmed` token | The amount is ours to decide at charge time. Nothing provider-side needs updating when the bill changes.                                                                                                                 |

So the collection model becomes **token-based recurring**: authorise once,
then charge the amount StoreMink computed, every cycle.

The first-cycle Checkout is part of that authorisation, not a separate ordinary
sale. The server creates a customer-bound authorisation order and Standard
Checkout receives `order_id`, the same `customer_id`, and explicit
`recurring: true` (Razorpay's default is false). If StoreMink cannot prepare
those terms it refuses enrolment before Checkout opens; it does not collect a
one-time first cycle and call that an autopay subscription. AI credits and
immediate location/plan-change invoices remain deliberately one-time.

### 2a. ★★ Two different ceilings — do not conflate them

This is the most misquoted pair of numbers in Indian recurring payments, and the
design depends on keeping them apart.

1. **The mandate's registered `max_amount`** — the most a mandate may ever be
   debited for. Set once at authorisation. Card e-mandates have "no practical
   upper transaction cap"; UPI mandates are registered up to a ceiling that can
   reach ₹1,00,000+.
2. **The AFA-exempt per-debit threshold** — the most that can be taken
   **without the customer authenticating that specific debit**. Under the RBI
   _Digital Payments — E-mandate Framework, 2026_ (effective 21 April 2026):
   **"Recurring transactions up to Rs. 15,000 per transaction may be processed
   without AFA."** Raised from ₹5,000 on 16 June 2022. It applies to UPI, cards
   and PPIs equally.

A mandate registered for ₹2,00,000 does **not** mean ₹2,00,000 can be silently
collected. It means debits are _permitted_ up to that, and every debit over
₹15,000 requires the merchant to obtain AFA from the customer that cycle — which
is not "automatic" in any sense the merchant or the billing worker cares about.

**The ₹1,00,000 AFA-exempt limit is real but StoreMink does not qualify.** The
framework grants it to exactly three transaction types: _"Payment of insurance
premiums, subscription to mutual funds, and credit card bill payments may be
processed without AFA up to Rs. 1,00,000 per transaction."_ (NPCI circular
UPI/OC-151A, Dec 2023, carried into the 2026 framework.) A SaaS subscription is
none of those. If StoreMink ever believes it qualifies, that is a question for
the acquirer and the MCC, not an assumption to build on.

**So the rule for automatic collection is a conjunction, not a single check:**

```
autoCollectable(invoice, mandate) =
      mandate.status === 'active'
  &&  invoice.total_paise <= mandate.max_amount_paise    // what was authorised
  &&  invoice.total_paise <= AFA_EXEMPT_LIMIT_PAISE      // 15_00_000 — what needs no customer action
```

Both conditions, always. `AFA_EXEMPT_LIMIT_PAISE` is a named constant, because
it has moved twice (₹5,000 → ₹15,000) and will move again.

### 2b. What this means for the catalog

Against `PLAN_META` (basic ₹1,500/mo · ₹15,000/yr, pro ₹5,000/mo · ₹50,000/yr),
with the AFA-exempt limit at ₹15,000:

| Charge                     | Amount  | Auto-collects?                |
| -------------------------- | ------- | ----------------------------- |
| Basic monthly              | ₹1,500  | ✓                             |
| Pro monthly                | ₹5,000  | ✓                             |
| Pro monthly + 5 locations  | ₹10,000 | ✓                             |
| Pro monthly + 10 locations | ₹15,000 | ✓ (at the line)               |
| Basic yearly               | ₹15,000 | ✓ (at the line)               |
| Pro yearly                 | ₹50,000 | ✗ — AFA or manual every cycle |

**Every monthly plan auto-collects, including Pro with a realistic number of
locations.** The manual path (§18 of the spec) is genuinely a fallback for
monthly billing — but it is the _only_ path for **Pro yearly**, and Basic yearly
sits exactly on the threshold with no headroom for a single added location.

Two consequences worth deciding on deliberately:

- **Yearly billing is structurally harder to collect than monthly**, which
  inverts the usual assumption that annual prepay is the safer revenue. If
  yearly matters commercially, the answer is either AFA-at-renewal as a designed
  flow, or splitting a yearly commitment into monthly debits.
- **`mandateMaxPaise()`'s ₹2,00,000 is not wrong as a ceiling** — a mandate is a
  ceiling, not a charge, and headroom costs nothing. It was only ever wrong as a
  _proxy for what can be collected_. The AFA check above is what that guard
  should have been.

### 2b-i. ★★ How large a mandate to ask for

`mandateMaxPaise()` today takes **no arguments** and returns one global number —
Pro yearly × 2 + ten locations = **₹2,00,000** — for every merchant regardless of
what they signed up for. A Basic-yearly merchant (₹15,000/yr) is asked to
authorise 13× their bill, and over half of that ceiling provisions for extra
locations, which a Basic plan cannot buy at all (`posLocationsIncluded: 0`, and
`validateBilledLocations` refuses outright when that is zero).

**The governing principle: the mandate must always cover the RENEWAL. It need
not cover every possible future purchase.**

- A renewal that fails costs a grace period, a downgrade, and possibly the
  merchant. Unacceptable.
- An upgrade or a location purchase that needs re-authorisation happens while the
  merchant is on screen taking a deliberate action. Perfectly acceptable — put
  the friction there.

That inverts the current design, which loads all the headroom onto signup (where
it costs conversion) to avoid friction on discretionary purchases (where nobody
would mind it).

**★ And headroom above ₹15,000 buys almost nothing anyway.** Per §2a, any debit
over the AFA-exempt limit needs the customer to authenticate that cycle — so a
₹2,00,000 ceiling does not make a ₹50,000 renewal automatic, it merely makes it
_permitted_. The "keep room for upgrades" rationale largely collapses once that
is understood.

So: size on `plan amount + currently-billed locations`, provision for tax, add
modest room for a reprice, round to something a human reads without alarm.

```
mandateMaxPaise(plan, period, billedLocations) =
  roundUpToNiceNumber(
      (planAmount + billedLocations × locationPrice)   // what renewal will actually cost
    × TAX_PROVISION      // 1.18 — see the trap below
    × REPRICE_HEADROOM   // 1.5
  )
```

| Signup                          | Renewal cost | Mandate to ask for |
| ------------------------------- | ------------ | ------------------ |
| Basic monthly                   | ₹1,500       | **₹3,000**         |
| **Basic yearly**                | **₹15,000**  | **₹27,000**        |
| Pro monthly, no extra locations | ₹5,000       | **₹9,000**         |
| Pro yearly, no extra locations  | ₹50,000      | **₹89,000**        |

**★★ The tax provision is not optional, and this is the trap.** GST is off today
and will be switched on from the operator dashboard later (owner decision).
Basic yearly then becomes ₹15,000 + 18% = **₹17,700**. A mandate registered at
₹15,000 — the bare plan price — would be **refused outright** at the first
post-GST renewal, for every merchant who signed up before the switch, with no way
to raise it except re-authorising. Size every mandate tax-inclusive from day one
even while `tax_enabled = false`.

**★ And note what ₹17,700 means for Basic yearly specifically:** it is over the
₹15,000 AFA-exempt limit, so once GST is on, **Basic yearly renewals need AFA
every cycle regardless of the mandate**. Generalised — with GST at 18%, any
pre-tax charge above **₹12,711** crosses the line:

| Pre-tax                           | With GST | Auto-collects post-GST? |
| --------------------------------- | -------- | ----------------------- |
| Basic monthly ₹1,500              | ₹1,770   | ✓                       |
| Pro monthly ₹5,000                | ₹5,900   | ✓                       |
| Pro monthly + 6 locations ₹11,000 | ₹12,980  | ✓                       |
| Pro monthly + 8 locations ₹13,000 | ₹15,340  | ✗                       |
| Basic yearly ₹15,000              | ₹17,700  | ✗                       |
| Pro yearly ₹50,000                | ₹59,000  | ✗                       |

Monthly billing survives GST up to roughly seven extra locations. **No yearly
plan does.** That is worth knowing before yearly is marketed as the default.

### 2c. ★★ The X+3 rule reshapes the renewal timeline

RBI requires a pre-debit notification **at least 24 hours before every debit**,
carrying the amount, date and mandate reference. Razorpay's guidance is to
expect recurring payments to take **X+3 days** to confirm — a payment scheduled
for the 1st is processed on the 4th. For e-mandate, same-day debit requires the
request to reach Razorpay by **08:59 on a bank working day**.

This is the single most important operational fact in the document, because the
naive loop — _cycle starts → create invoice → charge → 2 days → downgrade_ —
would expire the grace period **before the payment result is even known**, and
downgrade merchants whose money is still in flight. That directly violates
Rule 6 and §69.

**The fix is to move collection earlier, not to weaken the 2-day rule:**

```
T-4d    finalize invoice (amount frozen, number allocated)
        └─ pre-debit notification goes out
        └─ create Razorpay order + recurring payment
T-4d→T0 payment confirms inside the X+3 window
T0      cycle start — the answer is already known
        ├─ captured  → new cycle begins, nothing to do
        ├─ failed    → past_due; grace starts; grace_ends_at = T0 + 48h
        └─ unknown   → NO grace, NO clock. Reconciliation. (Rule 6)
T0+48h  downgrade worker — conditional claim, only if still unpaid
```

The merchant still gets exactly the 2-day buffer from the moment their payment
is known to have failed. They simply do not get punished for the settlement
window.

**A consequence worth stating, because it resolves an ambiguity:** the amount is
frozen at T-4d, so a location added at T-2d bills on the **next** invoice. That
is deterministic and it is what the merchant is told.

---

## 2d. Current state — what exists today

Per spec §75 items 1–7. Everything here is replaced unless §9 says otherwise.

**Billing flow.** `startPlanSubscription` → `rzpCreateSubscription` against a
Razorpay Plan resolved from `razorpay_plans` (composite PK `(plan, period,
amount_paise)`, so a reprice mints a new plan id and grandfathers subscribers) →
merchant authorises in the checkout modal → `confirmSubscription` verifies the
signature and writes `stores.plan`, `plan_expires_at`, `plan_source='paid'`.
Renewals are Razorpay's job; we learn about them from `subscription.charged`.
**There is no invoice, no line item, no payment attempt, and no payment record
of any kind** — the entire billing history is `plan_events`, an audit log with
no idempotency key.

**Razorpay flow.** `lib/payments/razorpay.ts` — plain `fetch`, Basic auth, no
SDK. Subscription surface: `rzpCreatePlan`, `rzpCreateSubscription`,
`rzpFetchSubscription`, `rzpCancelSubscription`, `rzpUpdateSubscription`
(`PATCH`, the call UPI/e-mandate refuses). Platform credentials only —
subscription billing never touches a store's BYO gateway.

**Models.** `store_subscriptions` (one row per store, Razorpay's status
vocabulary in a CHECK), `razorpay_plans` (the plan-id cache), `plan_events`
(audit), `plan_prices` (operator pricing, in **rupees** deliberately),
`billing_webhook_events` (`event_id` PK only), and `stores.plan` /
`plan_source` / `plan_expires_at` as the actual entitlement.

**Webhook flow.** `POST /api/webhooks/razorpay` — raw-body HMAC, event-id
insert-first dedup, then **six sequential `withService` transactions** processed
synchronously inside the request, including outbound email and
`revalidateTag`. Handles `subscription.*` only. **There is no `payment.captured`
handler anywhere in the codebase**; AI credits and storefront orders both rely on
client callback plus reconcile-on-read.

**Plan change.** `changePlan` → `decidePlanChange` (dearer = now, cheaper or
equal = cycle end) → `rzpUpdateSubscription`.

**Location billing.** `changeBilledLocations` folds the location cost into the
subscription _amount_ by swapping to a different Razorpay plan id — the design
that cannot work on UPI or e-mandate.

**AI credits.** Already close to correct: pending row inserted before the
gateway call, settlement is a conditional `WHERE status='pending'` claim, and
the real guarantee is a **unique partial index on `ai_credit_ledger (kind, ref)
WHERE kind='purchase'`**. Three gaps (§8).

**Test coverage.** `plan-change.ts`, `location-billing.ts`, `renewal.ts` and
`pricing.ts` are pure and tested. The action layer, the webhook and the
reconcile paths are not.

### 13 defects found while mapping — and why that argues for the rebuild

Two are live revenue bugs. **`confirmSubscription` writes `stores.plan`
unconditionally**, bypassing `billingMayApplyPlan` — so a comped store that
subscribes can have its comp overwritten _downward_ (comped Pro + subscribes
Basic ⇒ store drops to Basic), which is the exact failure that rule exists to
prevent, in the one path that skips it. And **a scheduled location release never
lands**: `billed_locations` is written only on the immediate branch, the webhook
never writes it, so Razorpay bills the cheaper plan while `locationAllowance`
keeps granting the released slots free — indefinitely. A third,
**re-subscribing after a cancel keeps `billed_locations` while resolving the
bare tier price**, giving away every paid location.

The rest: asymmetric amount comparison on the `amountForRzpPlan` fallback path
(a downgrade misread as an increase and charged now); stale
`current_end`/`scheduled_*` surviving a re-subscribe; `expired` being a status
Razorpay emits that the CHECK constraint forbids, which poisons the webhook into
an infinite 500-retry loop; healthy autopay subscribers receiving "your plan is
expiring" 7 days and 1 day before **every** renewal because the expiry cron never
consults `hasLiveMandate`; and `plan_source` surviving expiry so stores nobody
ever comped are treated as comped.

**Ten of the thirteen live in code this rebuild deletes outright.** Fixing them
in place costs nearly what replacing them costs, and leaves the UPI dead end
untouched.

---

## 3. Billing timebase

- **All timestamps are `timestamptz`, computed server-side, stored UTC.**
  Displayed in `Asia/Kolkata`. Never derived from the browser.
- **A cycle is `period_start + interval '30 days'`.** Exactly. February, leap
  years and 31-day months have no special behaviour, and the tests assert
  precisely that — a cycle starting 31 Jan ends 2 Mar in a non-leap year, and
  nothing anywhere clamps a day-of-month.
- **Anchor drift is intended.** A cycle starting 1 Aug renews on the 31st, then
  the 30th. Accepted consequence of the 30-day rule; the merchant is shown their
  actual next billing date, never "the 1st of each month".
- **12.17 cycles per year.** A ₹1,500 "monthly" plan collects ₹18,250 across a
  year, and some calendar years contain 13 charges. Say so in the pricing copy.
- **Yearly is `duration_days = 365`**, held in the same period config as
  monthly's 30 rather than inferred. ⚠ Confirm: 365 vs 12 × 30 = 360.

---

## 4. State machines

### Payment attempt — monotonic, which is what makes out-of-order webhooks safe

```
created ──▶ processing ──▶ authorized ──▶ captured ──▶ refunded
   │            │              │          (terminal)   partially_refunded
   │            │              │
   └────────────┴──────────────┴──▶ failed / cancelled
                │
                └──▶ unknown ──(verification)──▶ captured | failed
```

**Rank the states and permit forward transitions only.** `captured` is terminal,
so a late `payment.failed` is rejected by the machine itself — deterministically,
with no timestamps and no argument about whose clock is right. This is a
stronger answer to §26 than "latest valid state wins".

`unknown` is a first-class state, not an error. It is what a timeout produces,
and the only exit is provider verification.

A refund StoreMink sends its merchant does not move the attempt: the refund
pass (`lib/billing/refunds.ts`) leaves it `captured` and records the refund in
`billing_refunds` (§5). An attempt that does reach `refunded` still counts as
paid (`invoiceStatusForAttempts` agrees with `isSettled`), so it never reopens
its invoice.

### Invoice

```
draft ──▶ open ──▶ processing ──▶ paid
            │  ▲        │
            │  └────────┴──▶ failed ──┐
            │                          │ (retry creates a NEW attempt)
            │◀─────────────────────────┘
            │
            └──▶ uncollectible   (grace expired → downgrade)

draft | open | processing | paid ──▶ void
        (a plan end closes every cycle it did not reach; the refund pass's
         repair closes an unpaid leftover, never a draft)
```

**`void` is written in two places only:** when a plan ends,
`closeUnreachedInvoices` (`lib/billing/close-cycle.ts`) closes every
subscription invoice above the last cycle the plan reached, whatever its
status, in the same transaction as the end; and the hourly refund pass's repair
closes an issued, unpaid `open` invoice above an ended plan's cycle or below a
live plan's, issued over an hour ago, with no payment in flight or captured.
**`refunded` and `partially_refunded` are never written** (rule R9): a refund
never changes its invoice, so a refunded `void` invoice stays `void`, a paid
invoice whose duplicate payment was returned stays `paid`, and the refunds are
read from `billing_refunds` by invoice. A captured payment on a `void` or
`uncollectible` subscription invoice is money for a cycle the plan does not
reach, and the refund pass returns it (§7). The attempts' claim moves an
invoice to paid, open or processing only from `open` or `processing`, so
neither a closed nor a paid invoice is ever moved by its attempts.

### Subscription

```
free ──▶ active ──▶ past_due ──▶ grace ──┬──▶ active      (paid in time)
           ▲                              └──▶ downgraded ──▶ free
           │
           └── cancelled (at period end, or at grace end when cancelled in grace)
```

Subscription state is **derived and stored**, never a boolean. `active` requires
a paid invoice for the current `cycle_seq`; the downgrade claim re-checks that
rather than trusting the column.

**A cancelling subscription (`cancel_at_period_end`) never enters another
cycle** (rule R2): not at the cycle turn, not at grace end, not when a payment
lands. It ends as `cancelled` at the period end, or, when it was cancelled in
`past_due` or `grace`, when grace ends; it is never downgraded. Keep my plan
clears the flag in any live state and then advances the cycle if the renewal
was paid meanwhile.

### Mandate

```
pending ──▶ active ──┬──▶ expired
                     ├──▶ revoked
                     └──▶ failed
unknown ──(verification)──▶ active | failed
```

**`unknown` triggers verification, never an assumption.** A newly created
mandate is `pending` until the token reports `confirmed`.

---

## 5. Schema

Integer paise everywhere. No floats, ever.

### `platform_billing_settings` — singleton, operator-managed

The owner's GST decision lives here.

```sql
create table platform_billing_settings (
  id              boolean primary key default true check (id),  -- one row, enforced
  legal_name      text,
  gstin           text,                    -- NULL until StoreMink has one
  address         jsonb,
  state_code      text,                    -- place of supply origin
  tax_enabled     boolean not null default false,
  tax_inclusive   boolean not null default false,  -- billing_05_tax_mode.sql
  tax_rate_bps    integer not null default 1800,   -- 18.00%
  invoice_prefix  text not null default 'SM',   -- 1 or 2 letters or digits since 0266
  updated_at      timestamptz not null default now(),
  updated_by      text,
  -- 20261029_0266_gst_on_storemink_fees:
  next_tax_enabled   boolean,      -- one scheduled change: all four set, or all NULL
  next_tax_inclusive boolean,
  next_tax_rate_bps  integer,
  next_tax_starts_at timestamptz,
  next_tax_notice_id uuid references platform_announcements(id) on delete set null,
  sac_code           text,         -- ^99[0-9]{4}$, printed on every tax invoice
  llpin              text,         -- ^[A-Z]{3}-[0-9]{4}$, LLP Act section 21
  registered_office  text          -- printed with the LLPIN on every invoice
);
```

- **★★ THE IN-FORCE COLUMNS AND ONE SCHEDULED CHANGE.** `tax_enabled`,
  `tax_inclusive` and `tax_rate_bps` are the GST in force; the four `next_tax_*`
  columns hold at most one change still to come
  (`platform_billing_next_tax_shape`). `termsAt(settings, instant)`
  (`lib/billing/tax-terms.ts`, pure) applies a started change BY TIME, so an
  invoice built at or after `next_tax_starts_at` uses the new values even if the
  hourly billing run has not yet copied them into the in-force columns
  (`promoteDueTaxChange`, the run's first step, docs/cron-jobs.md). Nothing a
  merchant pays depends on when that run fires.
- **★★ WHAT GST NEEDS BEFORE IT CAN BE ON.** `platform_billing_tax_needs_invoice_identity`
  refuses `tax_enabled = true` without the SAC code, state, legal name, LLPIN,
  registered office, address line 1 and a 6-digit PIN;
  `platform_billing_next_tax_needs_invoice_identity` asks the same, plus the
  GSTIN, before a switch-on can even be scheduled. The older
  `platform_billing_tax_needs_gstin` still stands.
- **★★ A RISE NEEDS A MONTH'S NOTICE** (`scheduleTaxChange`,
  `lib/billing/platform-settings.ts`). A change that raises what merchants pay
  (`raisesPayable`: switching GST on under prices that exclude it, or a higher
  rate under them) can only be scheduled, at least 1 calendar month in India
  time after an Operational email announcement that reached every store owner
  (`noticeQualifies`: Operational, sent or partly sent with at least one
  delivery, email among its channels, aimed at all owners with no plan, status,
  age or launch filter). The notice is read from `platform_announcements` in the
  same transaction as the write, never taken from the browser. "Now" is allowed
  only when nothing anyone pays goes up. A start must be at least 5 minutes and
  at most 400 days ahead. `LAW_SET_RATE_RISE_WITHOUT_NOTICE` stays `false`
  until the published Terms say a rate set by law applies from the date the law
  sets.
  ⚠ **A notice whose status is `partial` counts as given** (review R1-12,
  coordinator's decision, recorded as the owner's choice): one bounced address
  must not block a lawful tax change. The owners whose email failed got no
  notice; the owner may resend to them before the start, or change the rule to
  require `sent` with no failures.
- **★ CANCELLING** (`cancelScheduledTaxChange`) promotes a change that has
  already started first, then clears the schedule, with one clock for both
  (review R1-13); a change that started while the page was open is refused.
- **★★ NEVER `INSERT .. ON CONFLICT` THE SINGLETON.** A CHECK judges the
  PROPOSED insert row before the conflict is detected, and the proposed row has
  no GSTIN or SAC code, so an upsert of the singleton is refused by the new
  identity CHECKs whenever GST is on (found by `gst.local` case 10). The three
  tax saves (`saveTaxIdentity`, `scheduleTaxChange`, `cancelScheduledTaxChange`,
  through `writeTaxColumns`) update the locked row and insert only when none
  exists. ⚠ `savePlatformAutoRefunds` still upserts: it is safe only because its
  insert never meets a row with GST on, and a CHECK violation (SQLSTATE 23514)
  there is mapped to "Couldn't save this switch: StoreMink's tax identity is
  incomplete. Save StoreMink's tax identity first, then try again."

- **★ `tax_inclusive` is the operator's choice, and it changes more than the
  arithmetic.** EXCLUSIVE (the default) means ₹15,000 + 18% = ₹17,700 charged;
  INCLUSIVE means ₹15,000 charged, of which ₹2,288.14 is GST — carved out as
  `gross × r / (1 + r)`, **not** `gross × r`. Three consequences:
  - **Under inclusive, switching GST on later changes nothing a merchant pays.**
    Under exclusive the same switch raises every bill 18%, against a mandate
    ceiling authorised before it — which is the entire reason
    `mandateSizePaise` provisions ×1.18, and that provision is dropped in
    inclusive mode (`taxInclusive: true`).
  - **Inclusive keeps more plans auto-collectable.** Basic yearly stays at
    ₹15,000, on the AFA line, instead of ₹17,700, over it (§2a).
  - **The pricing pages read this setting, so they cannot disagree with it.**
    The storemink.com pricing page, homepage and POS page read the tax terms
    through `getPublicTaxSource()` (`lib/billing/public-tax.ts`: only the seven
    columns that decide which GST applies, cached 300 s under the tag
    `platform-tax`) and call `termsAt` at render, so "plus GST" and the
    footnote follow the setting, and a scheduled start shows within one
    revalidation without a deploy. The three console saves and the hourly
    promote bust the tag after they commit (`bustPlatformTax`). A failed read
    shows the prices with no GST wording and logs
    `billing.public_tax.read_failed`; it is never read as "GST off".
    Anything followed by a payment (the dashboard, signup, every quote) reads
    live (`getTaxTermsLive`), never this cache. Exclusive is the ordinary
    Indian B2B convention and lets merchants claim input tax credit cleanly;
    inclusive is the honest-headline-price option.
- **`tax_enabled = false` until StoreMink's identity is complete** (above).
  Invoices then carry `tax_paise = 0`, render no GSTIN block, and state that
  tax is not applicable. The release ships with GST off.
- **Turning tax on is never retroactive.** It applies to invoices finalized
  after the change. Historical invoices are immutable (§23), so a merchant's
  April invoice does not sprout GST in September.
- Edited from the operator console, Billing & tax (docs/operator-console.md):
  the identity card (`saveTaxIdentity`), the Charging GST card
  (`scheduleTaxChange`, with an impact preview from `lib/billing/gst-impact.ts`)
  and the status card (`cancelScheduledTaxChange`), superadmin only. A
  scheduled change the hourly run applies is recorded as
  `system: scheduled GST change` in `updated_by`.
- **`auto_refunds`** (default false) and **`automatic_refunds_from`** (the
  moment migration 0264 ran) belong to the refunds below: the switch that lets
  the refund pass send its own refunds, and the line before which a payment
  kept on an `uncollectible` invoice is history for a person.

### `billing_accounts` — one per store

`store_id` PK, billing email, legal name, address, `state_code`, and the
**merchant's** `gstin` (nullable; they need it on the invoice to claim input
tax credit).

- **Merchant-editable now**, under Billing details on Plans & Billing
  (`lib/billing/billing-details.ts`, `saveBillingDetails`): business name, the
  address, the country, and either a GSTIN (whose first two digits give the
  state) or a state. A business outside India chooses its country instead
  (`address.country`, with `countryName` for "Other"). The form is prefilled
  from Taxes & invoices, the default location and the signup answers, but only
  the billing account is written, and never `billing_email`.
- **0266 checks** (added NOT VALID, then validated): `billing_accounts_gstin_format`
  (a well-formed GSTIN or none) and `billing_accounts_gstin_matches_state` (a
  GSTIN's first two digits equal `state_code`).
- **★ The place of supply comes from the merchant's own records, first match
  winning** (`placeOfSupplyFor`, `lib/billing/gst.ts`): the Billing details
  GSTIN, a Billing details country outside India (place of supply 96), the
  Billing details state, the Taxes & invoices GSTIN, then state, the default
  location's GSTIN, then state, the state named in the typed business address,
  the signup state, a signup country outside India (96), and only while GST is
  charged StoreMink's own state. The invoice records which with
  `place_of_supply_basis`, and only a `recipient` basis prints a State for the
  merchant: an invoice never says a merchant is in Punjab because StoreMink is.

### `subscriptions`

`store_id` PK, `plan`, `period`, `state`, `current_cycle_seq int`,
`current_period_start/end`, `billed_locations`, `scheduled_plan`,
`scheduled_period`, `cancel_at_period_end`, `grace_started_at`, `grace_ends_at`,
`mandate_id`, and the **existing** `plan_source` / `plan_expires_at`, which are
load-bearing (§8 below). `cancel_requested_at` and `cancel_requested_by`
(`merchant:<uid>` or `operator:<email>`, never blank) record who asked to
cancel; they stay when the plan ends and clear only on Keep my plan.

### `mandates`

`provider`, `provider_customer_id`, `provider_token_id`, `method`
(`card|upi|emandate|nach|unknown`), `status`, `max_amount_paise`,
`authenticated_at`, `expires_at`, `revoked_at`, `provider_metadata jsonb`.
**No card data, ever.**

`max_amount_paise` is copied from the exact server-computed `token.max_amount`
persisted on the payment attempt before Checkout (`billing_09`). Razorpay's
payment response returns the token id but not its ceiling; recomputing after a
reprice or accepting a browser value would record something other than what the
merchant authorised.

### `invoices`

```sql
kind            text not null check (kind in ('subscription','ai_credits','addon')),
number          text,          -- allocated on finalize, never on draft
number_seq      integer,
status          text not null,
subtotal_paise  bigint not null,
discount_paise  bigint not null default 0,
tax_paise       bigint not null default 0,
total_paise     bigint not null,
currency        text not null default 'INR',
cycle_seq       integer,       -- subscription only
period_start    timestamptz,
period_end      timestamptz,
finalized_at    timestamptz,
due_at          timestamptz,
paid_at         timestamptz,
-- 20261029_0266_gst_on_storemink_fees:
sac_code              text,      -- StoreMink's SAC code, stamped with the GST
tax_inclusive         boolean not null default false,  -- line amounts include GST
place_of_supply_basis text,      -- recipient | supplier | outside_india (96)

constraint invoice_one_per_cycle
  unique (store_id, kind, cycle_seq)      -- NULLs don't collide, so ai_credits is unaffected
```

**That unique constraint is the whole answer to §35.** Two renewal workers
cannot both create an invoice, regardless of transaction isolation or worker
coordination. `cycle_seq` — not a timestamp — is the idempotency key.

**GST particulars (0266).** Every invoice is stamped from ONE tax reading
(`readTaxSnapshot`, one statement with the settings row and the billing account
locked `for share`; pure resolver `lib/billing/tax-snapshot.ts`): StoreMink's
GSTIN and SAC code while GST is charged, the merchant's GSTIN when it is well
formed, and the place of supply with its basis (never missing while GST is
charged). There is no tax-off fallback: a reading
that fails, or settings that charge GST without StoreMink's identity, leave the
invoice unbuilt rather than issued on a guess.

- `billing_invoices_sac_code_format`, `billing_invoices_place_of_supply_numeric`
  and `billing_invoices_place_of_supply_basis` (96 only with `outside_india`,
  a State code only with `recipient` or `supplier`).
- **★★ The issuing trigger** `billing_invoices_tax_invoice_complete`
  (`billing_invoices_guard_tax_invoice`, BEFORE INSERT OR UPDATE OF
  `finalized_at`) refuses to issue an invoice charging GST without the supplier
  GSTIN, the place of supply and its basis, the SAC code and a rate. It judges
  only the transition to issued, so an older invoice can still be paid, voided
  or refunded, and only once `platform_billing_settings.sac_code` is set, so a
  revision that issued taxed invoices before this release keeps working during
  the rollout.
- `tax_inclusive` is frozen with the money once issued; the migration marked
  existing invoices whose GST line reads "(included)" before the guard froze it.
- The 0243 parties snapshot now records StoreMink's LLPIN and registered office,
  and the customer's country and signup address.
- **The document** (`/dashboard/plans/invoices/[id]`) is titled "Tax invoice"
  while it charges GST, with the place of supply (`Outside India (96)` for 96),
  reverse charge No, both GSTINs and States, a SAC column, "Amount (GST
  included)" under inclusive prices, the GST split from `platformInvoiceGst`
  (CGST and SGST in StoreMink's state, IGST elsewhere and for 96) and the LLP
  line. A no-tax invoice is titled "Invoice" and prints no GST line.
- **The monthly invoice list** (`lib/billing/invoice-list.ts`,
  `buildInvoiceList`): every invoice and credit note issued in one India-time
  month, credit notes as negative lines, every fact from the document itself,
  at most `MAX_INVOICE_LIST_ROWS` (50,000) rows (never a cut file; above it
  `too_many`). Downloaded by a superadmin from Billing & tax.

### `invoice_line_items`

`kind` ∈ `base_plan | location | addon | proration | discount | tax |
account_credit`, with description, quantity, `unit_amount_paise`, `amount_paise`.
A trigger rejects INSERT/UPDATE/DELETE once the parent invoice is finalized —
immutability enforced by the database, not by convention.

### `payment_attempts`

```sql
idempotency_key  text not null unique,   -- OURS, minted before calling Razorpay
mode             text not null check (mode in ('automatic','manual')),
state            text not null,
amount_paise     bigint not null,
provider_order_id, provider_payment_id, provider_token_id  text,
mandate_max_paise bigint,              -- exact token.max_amount at checkout
failure_code, failure_reason  text,

create unique index one_attempt_in_flight on payment_attempts (invoice_id)
  where state in ('created','processing','authorized');
```

**That partial index is the whole answer to §28 and §36.** Three clicks, or an
automatic retry racing a manual payment, cannot produce two in-flight attempts —
the second INSERT fails at the database.

**★ This is `lib/payments/issue-refund.ts` generalised, not a new invention.**
That module is the only path in the codebase that already handles "we never
learned the outcome" correctly, and every element transfers:

| `issue-refund.ts`                                                                                           | Here                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| INSERT `order_refunds` `pending` with our `idempotencyKey`, inside one transaction with the amount check    | INSERT `payment_attempts` `created` before any gateway call                                                                 |
| Key sent as **both** `X-Refund-Idempotency` and `notes.sm_refund_key`                                       | The recurring API documents no equivalent header: persist its provider order **before debit** and copy the key into `notes` |
| Settlement is `UPDATE … WHERE status = 'pending'`, and a lost claim reports `pending` rather than asserting | Identical claim on `payment_attempts`                                                                                       |
| `outcome: "unknown"` → **do not fail, do not retry**, return `pendingReconcile`                             | Identical — this is Rule 6's primitive                                                                                      |

And `RzpResult` **already** carries the distinction the spec asks for
(`lib/payments/razorpay.ts:47`): `status >= 500 → "unknown"`, a network throw →
`"unknown"`, 4xx and own-precondition failures → `"rejected"`. §43/§69 do not
need new plumbing; they need every caller to respect what is already there.

### `billing_webhook_events` — extend, do not replace

**This table already exists** (`subscriptions_01_schema.sql`): `event_id text
primary key`, `event_type`, `received_at`. The dedup idea is right and the unique
key is the right one. Four things are missing or wrong:

1. **The marker and the work are in different transactions.** The marker is
   inserted and committed, then processing runs; on a throw the marker is
   _deleted_ as compensation — and that delete is `.catch(() => {})`. If it
   fails, the event is permanently marked processed and never applied. Silent
   loss.
2. **Processing is fully synchronous inside the request**, including outbound
   email and `revalidateTag`. Razorpay's timeout is the effective budget, and a
   DB blip inside the suppression lookup returns 500 and makes Razorpay redeliver
   the whole plan-activation path.
3. **No payload is stored**, so an event cannot be replayed — only re-received.
4. **No retention path** — text PK, no `received_at` index, no pruning job. It
   grows forever.

Add: `payload jsonb`, `signature_verified`, `status` ∈
`received | processed | failed | ignored`, `attempts`, `last_error`,
`processed_at`, and an index on `received_at` plus a §32 retention entry.

**Persist first, process asynchronously.** The endpoint verifies the signature
against the raw body, inserts (conflict ⇒ already seen ⇒ 200), and returns.
A worker processes — the `data_jobs` lease pattern (`SELECT … FOR UPDATE SKIP
LOCKED` + lease write in **one** transaction) is already in the codebase and is
the template. That removes the compensating-delete hazard entirely: the marker
_is_ the queue row, and failure just leaves it claimable again.

⚠ **`withService` is one transaction per call.** Sequential `withService` calls
are separate transactions — which is precisely why the current webhook (six of
them) and `settlePurchase` (two) are non-atomic. Anything that must be atomic
goes in a single callback.

### `reconciliation_items`

`kind` ∈ `unknown_payment | orphan_payment | amount_mismatch | missing_webhook |
state_conflict | wrong_association`, with `provider_payment_id`, optional
`invoice_id`, `detail jsonb`, `status`, and resolution attribution. Nothing is
ever guessed; ambiguity lands here.

### `billing_credits` — append-only ledger

Mirrors `customer_credit_ledger` (§29), which already solves this shape. It was
planned for the post-downgrade rule in §7 and stays unused: money that arrives
after a downgrade is refunded, not credited.

### `billing_refunds`: money StoreMink returns, one row per refund

Migration `20261028_0264_billing_refunds_and_credit_notes`. The obligation and
its execution in one row, written BEFORE any gateway call with an idempotency
key we mint (the `issue-refund.ts` pattern): `invoice_id`, `attempt_id`,
`reason`, `status`, `method` (`razorpay` | `bank_transfer`), `amount_paise`,
`idempotency_key`, the provider ids, `external_reference` (a UTR),
`requested_by` (`system` for the refund pass, else the operator's email),
`note`, `failure_reason`, `resolution_note`, `sent_at`, `resolved_at`,
`notified_at`.

- **Statuses:** `owed` (decided, not sent) moves to `pending` (sent, or its
  answer was never read), `processed`, `failed` or `cancelled`; `pending` moves
  to `processed` or `failed`; those three are final, and `recorded` is inserted
  final for a refund made outside the tool (a bank transfer, or one made by
  hand in the Razorpay dashboard). **Reasons:** `cycle_not_reached`,
  `feature_removed`, `suspended_by_mistake`, `declined_terms`,
  `duplicate_payment`, `goodwill`, `other`.
- **A refund never exceeds the payment it reverses.** `billing_refunds_guard`
  locks the attempt row and refuses a row that would take the payment's live
  and finished refunds (every status but `failed` and `cancelled`) past its
  amount, refuses an unissued invoice or a payment that was not captured,
  freezes what a refund IS once written, and allows only those moves.
  `billing_refunds_keep` refuses every DELETE. A Razorpay refund still to be
  sent is at least ₹1 (100 paise).
- **One automatic refund per payment, ever** (`billing_refunds_one_automatic`,
  unique on `attempt_id` where `requested_by = 'system'`). A failed one is
  retried by a person as a new row with the same reason.
- `notified_at` is written once, when the merchant is told.

### `billing_credit_notes`: StoreMink's own credit notes

A gapless series per Indian financial year, `CN/2026-27/00001` (at most 16
characters, the GST serial limit), allocated with
`billing_next_credit_note_no` from `billing_credit_note_counters` by the
`billing_credit_notes_issue` trigger, which also copies the tax rate, both
GSTINs, the place of supply and the parties from the invoice. The code decides
only the amounts (`taxable_paise`, `tax_paise`, `total_paise`; a partial note
takes tax in proportion, rounded down, and the last takes what is left).
`billing_credit_notes_guard` refuses an edit, a delete, and notes that would
take an invoice past its total or its tax. One note per refund (`refund_id`
unique), never for `duplicate_payment` (returning an excess reduces no supply),
and one `invoice_cancelled` note, with no refund, for a closed unpaid invoice
that charged GST.

Neither table has a store column: a refund and a credit note belong to one
invoice, and the invoice carries the store (SET NULL when the store is
deleted), so store deletion never touches them. `app_service` may SELECT,
INSERT and UPDATE refunds and SELECT and INSERT notes; nothing else.

---

## 6. Invoice numbering

GST requires a gapless consecutive series per financial year. This codebase has
already paid for getting serials wrong twice, so reuse both lessons rather than
re-deriving them:

- **Allocated by a trigger on finalization**, never on draft creation — the same
  reason the credit-note serial is allocated on settlement (§28): a draft that is
  never finalized would otherwise burn a number, and _a gap is what an audit
  flags_.
- **Routed through `sm_pad()`**, never bare `lpad()`, which truncates as well as
  pads and silently produced duplicate order references past 9999
  (`identifiers_05_no_truncate.sql`).
- **One series across both invoice kinds.** Multiple series are permitted but
  each must be independently consecutive; one is simpler and there is no reason
  for two.
- The counter is **platform-level**, not `store_counters` — StoreMink is the
  supplier here, not the merchant.

---

## 7. The billing rules, as implemented

### Renewal

Per §2a: finalize at T-4d, collect, evaluate at T0.

- **★★ ONE TAX READING PER RENEWAL INVOICE, AND NO GUESS.** Pass 1 reads the
  tax at the moment it builds the invoice (`loadTaxSnapshot(storeId, now)`). A
  read that fails (`reason` `read_failed`) or settings that charge GST without
  StoreMink's GSTIN, state or SAC code (`settings_incomplete`) leave the renewal
  for the next hourly run: nothing is written, the summary counts it in
  `pendingReconcile`, the run answers 200, and `billing.renewal_tax_snapshot`
  is logged at ERROR. No invoice means no grace, so a read that keeps failing
  past the cycle end leaves the store on its plan, unbilled (review R1-09, no
  code change): alert 23 in docs/monitoring.md watches that line.
- **⚠ A renewal can be issued up to an hour after T-4d** (review R1-08,
  documented, not changed). The run is hourly, so the invoice is built at the
  run's `now`, while the screens' next-renewal figure (`quoteNextRenewal`,
  `quoteLocationRenewal`) reads the terms at T-4d (`termsLater(...,
collectionStartsAt(cycleStart))`). A scheduled GST start that falls inside
  that hour gives the invoice the other terms from the ones quoted; the total
  differs only under prices that exclude GST. Schedule a start well away from a
  renewal's T-4d if a merchant's quote matters to the minute.
- When the place of supply falls back to StoreMink's own state, or the
  merchant is outside India, the issued renewal logs
  `billing.renewal_place_of_supply_fallback` or `billing.renewal_outside_india`
  (WARNING): each is a store to contact.

### Issuing an invoice: the GST in force at issue

Every issue goes through `issueInvoice` (`lib/billing/invoice-store.ts`;
`finalizeInvoice`, `finalizeInvoiceClaimed` and `finalizePaidAiCreditsInvoice`
wrap it). One transaction: lock the invoice; read the tax at the payment's
instant for an invoice whose total is already fixed by a payment or an order
(time of supply), else now; bring the draft up to that GST (`restamp`:
`unchanged`, `rebuilt` for a draft no payment fixes, `carved` when only the
split of a fixed total changes, `kept_draft` when the payment fixed a total
the new GST would change); then claim it only while `status = 'draft'` and
`finalized_at` is null, which fires the triggers that number it, record the
parties and refuse an incomplete tax invoice. It never throws; a failure is
logged and the repair pass below issues the draft later.

- **★ `kept_draft` is still issued, with the draft's own figures,** because the
  merchant has paid that total. It logs `billing.issue_kept_draft_tax`
  (WARNING) and, after the commit, files one `state_conflict` reconciliation
  item with the repair key `kept_draft:<invoice>` (`detail`: the draft's rate
  and mode, the rate and mode in force, the total, the payment id and a note
  saying a person decides on a credit note or a refund;
  `billing.issue_kept_draft_filed`, or `billing.issue_kept_draft_file` at
  ERROR when the item could not be filed). The reconciliation queue shows it as
  "Invoice issued with the GST it was priced with".
- An invoice is never collected while it is unissued (the renewal worker's
  rule), and a `kept_draft` issue keeps that rule.
- The browser confirms of a first payment, a plan change and a location
  purchase issue at the payment's own time (best effort; the repair pass covers
  a failure).

### The closed tab: the purchase's own completion, then the repair pass

Two passes in the hourly run make sure money taken always ends in a numbered,
paid invoice and, where it still applies, the purchase the merchant paid for.

1. **The completion** (RC-F1b, inside reconcile, from 15 minutes after the
   attempt). A first payment, plan change or location purchase whose merchant
   closed the tab before the browser confirmed is finished by its own
   completion (`completeEnrolmentPurchase`, `completePlanChangePurchase`,
   `completeLocationPurchase`, sharing `PurchaseCompletion` with
   `lib/billing/collect.ts`): finalize the draft, settle the capture (one
   receipt), check the invoice is paid, apply the plan or locations through a
   conditional claim, then the welcome email and the audit row. Whoever arrives
   second (the browser's confirm, another pass, a repeated start) changes
   nothing and sends nothing. A purchase that no longer applies, or whose
   captured amount or currency differs from the attempt's
   (`verifyRecoveredCapture`), is filed for a person (`purchase_refused:` or
   `purchase_unapplied:`); nothing is refunded or applied automatically.
   Buying again finishes the earlier payment instead of charging twice.
2. **The repair pass** (`issueCapturedDrafts`, `lib/billing/reconcile.ts`, the
   GST release; after reconcile, before evaluate). A subscription or add-on
   draft whose attempt was captured more than an hour ago
   (`CAPTURED_DRAFT_WAIT_MINUTES`), or a credit pack whose purchase is paid, at
   most 100 of each a pass. A subscription or add-on draft goes to its
   completion first; when the completion declines (its guards, or a person
   already holds the payment), the pass issues the invoice alone at the
   capture time (`issueInvoice({ invoiceId, paidAt })`), settles the payment
   with `notify: false` (no "Your plan is active" receipt for a purchase a
   person is checking, review R1-04) and files one `captured_draft:<invoice>`
   item, unless the payment is already held. It never applies a plan or a
   location by itself. A credit pack's invoice is issued as paid. With a
   `storeId` (`deleteStore`) it issues only, with no wait. The filed item also
   keeps the refund pass's repair away from that payment while a person checks
   it.
   - A draft it could not issue logs `billing.captured_draft_unissued`, a
     WARNING for the first six hours after the capture
     (`UNISSUED_ALERT_AFTER_HOURS`, review R1-14) and an ERROR after, or at once
     when the capture time is unknown; alert 24 watches the ERROR. It is not an
     error of the run.
   - **⚠ The invoice's `paid_at` and `finalized_at` are the pass's time**
     (review R1-10). The GST is read at the capture time (`paidAt`), but the
     settle stamps the moment it ran, up to an hour or more later. Read a
     repaired invoice's "paid on" date as when it was recorded, not when the
     merchant paid; the payment's own time is in the attempt and at Razorpay.
   - **⚠ Staging only** (review R1-11): a taxed draft written before the
     release on a database where GST was already on, with no SAC stamp, is
     kept as drafted and then refused by the issuing trigger once `sac_code` is
     set, so the pass logs `captured_draft_unissued` for it every run. Clear or
     re-stamp such drafts once by hand on that database. Production never had
     GST on (the 27 Oct checks), so it has none.

### Grace and downgrade: one conditional claim

`billing_claim_downgrade(p_store uuid, p_now timestamptz default now())`, as
migration 0205 left it (SECURITY DEFINER):

```sql
update public.billing_subscriptions s
   set state = 'downgraded', plan = 'free', billed_locations = 0,
       scheduled_plan = null, scheduled_period = null, scheduled_locations = null,
       grace_started_at = null, grace_ends_at = null,
       downgraded_at = p_now, updated_at = p_now
 where s.store_id = p_store
   and s.state in ('past_due', 'grace')
   and s.grace_ends_at is not null
   and s.grace_ends_at < p_now          -- strictly past the 48 hours promised
   and not exists (
     select 1 from public.billing_invoices i
      where i.store_id = s.store_id and i.kind = 'subscription'
        and i.cycle_seq = s.current_cycle_seq + 1      -- the cycle being entered
        and i.status in ('paid', 'processing'))
returning s.store_id, s.current_cycle_seq;
-- then, when a row was claimed:
update public.billing_invoices set status = 'uncollectible', updated_at = p_now
 where store_id = <store> and kind = 'subscription'
   and cycle_seq = <current_cycle_seq> + 1 and status = 'open';
```

It checks the invoice of the cycle being ENTERED: the cycle advances only once
that invoice is paid, so the current cycle's own invoice is always settled and
says nothing about grace (checking it, as the first version did, matched
nothing and never downgraded anyone). Zero rows means already downgraded, paid,
or a payment still processing. **§11, §37 and §39 all fall out of this single
statement**: no lock, no second query, no read-then-write window. It is the
codebase's established exactly-once pattern (`increment_coupon_usage`, the
reserved to released stock claim, `pickup_warned_at`).

There is no comp exemption any more (migration 0078): a comp is an overlay on
the store, and the plan underneath it is still collected. A cancelling
subscription never reaches this claim at grace end: `downgradeExpired` ends it
through `endSubscription` instead, and a non-cancelling one whose next invoice
was paid in grace is advanced by the safety net (§4, CODEBASE.md §34).

### Payment after downgrade

Per the review and unchanged by the owner's clarifications: once downgraded, the
invoice is **`uncollectible` and no longer payable**. It stays fully recorded
with its amount, attempts, failure reasons and grace timestamps — §8 is satisfied
because the outcome is _stated_, not hidden. Re-subscribing creates a fresh
invoice.

If money arrives anyway (a late settlement, a race), it is **refunded** in full
to the payment it came from by the hourly refund pass, with a credit note, and
not credited: `billing_credits` stays unused. The plan is **not** reactivated.
This keeps the owner's "no phantom reactivation" rule while never keeping money
for a service period that was not delivered. A capture recorded on an
`uncollectible` invoice before `automatic_refunds_from` was kept by older code;
the pass files it for a person (`kept_before_refunds:`) instead of refunding
history by itself.

### Cancellation: a flag, and no money kept for a cycle not reached

Cancelling sets `cancel_at_period_end` and revokes the mandate; it is allowed at
any time, including after T-4d with the renewal invoice issued, its payment
under way or already paid. The plan runs to the end of the cycle (or of grace)
and then ends: `endSubscription` closes every invoice above the last cycle
reached as `void` in the same transaction (§4), and the refund pass, which runs
last in the same hourly job, owes a refund (`cycle_not_reached`) for each
captured payment on them, sends it through StoreMink's own Razorpay account,
matches it back by the key it planted (never by amount), issues the credit note
and tells the merchant once. Automatic sending ships off (`auto_refunds`): until
an operator turns it on, those refunds wait on the console's Refunds page for
Send. A failed refund is never retried by the pass; a person retries it, or pays
by bank transfer and records it.

### Plan and location changes

Settled, following the reasoning the codebase already committed to in §15b —
keep refunds out of the system entirely:

| Change          | When                                     | Money                                                              |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Upgrade         | Immediate                                | Prorated charge on its own immediate invoice; new cycle starts now |
| Downgrade       | Next cycle boundary                      | None. They keep what they paid for                                 |
| Add location    | Next invoice (forced by the T-4d freeze) | None now                                                           |
| Remove location | Next cycle                               | None                                                               |

No negative invoices, no partial refunds, no duplicate credits in the
subscription path — which removes most of §20's worry list by construction.

Refunds stay out of plan and location changes. The two exceptions are not
changes: a renewal received for a cycle a cancelled or downgraded plan does not
reach goes back automatically (above), and an operator may refund from the
console, for a removed feature, a suspension made by mistake, declined terms
(End the plan now, the unused part of the cycle), a duplicate payment, goodwill
or another stated reason. Each is a `billing_refunds` row with its credit note,
and none changes the invoice.

### GST release: checks around the deploy

What the owner runs or reads around the release that adds GST on StoreMink's
fees (migrations 0266 to 0268). Every query is read-only; nothing here is run
by the build.

- **Before the merge to main, on staging and production** (Cloud SQL Studio,
  the right database), count the rows that would leave one of 0266's checks NOT
  VALID (review R3-04). A NOT VALID check still applies to every later write of
  the breaking row, and an issued invoice cannot be repaired (its place of
  supply is frozen), so every later status change of it would fail. Expect 0
  in every column except `tax_on`, which is 1 only where GST is already on;
  then the identity check stays NOT VALID until StoreMink's tax identity is
  saved in the console, straight after the deploy. The columns named exist
  before 0266.

  ```sql
  BEGIN READ ONLY;
  select
    (select count(*) from platform_billing_settings where tax_enabled) as tax_on,
    (select count(*) from platform_billing_settings
      where not (invoice_prefix ~ '^[A-Z0-9]{1,2}$')) as prefix_too_long,
    (select count(*) from billing_accounts
      where not (gstin is null
                 or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'))
      as account_gstin_malformed,
    (select count(*) from billing_accounts
      where not (gstin is null
                 or (state_code is not null and left(gstin, 2) = state_code)))
      as account_gstin_state_mismatch,
    (select count(*) from billing_invoices
      where not (place_of_supply is null or place_of_supply ~ '^[0-9]{2}$'))
      as invoice_place_not_numeric,
    (select count(*) from billing_invoices where place_of_supply = '96')
      as invoice_place_96;
  ROLLBACK;
  ```

  After the deploy, the same question by constraint (expect no rows where GST
  was off):

  ```sql
  BEGIN READ ONLY;
  select conrelid::regclass as tbl, conname from pg_constraint
   where conname in (
     'platform_billing_sac_code_format', 'platform_billing_llpin_format',
     'platform_billing_invoice_prefix_length', 'platform_billing_next_tax_shape',
     'platform_billing_tax_needs_invoice_identity',
     'platform_billing_next_tax_needs_invoice_identity',
     'billing_accounts_gstin_format', 'billing_accounts_gstin_matches_state',
     'billing_invoices_sac_code_format',
     'billing_invoices_place_of_supply_numeric',
     'billing_invoices_place_of_supply_basis')
     and not convalidated;
  ROLLBACK;
  ```

  A settings row that breaks one is fixed by the next identity save in the
  console; a billing account by the merchant's Billing details save; an issued
  invoice only by a person (it cannot be edited).

- **Before the merge, on staging and production:** the read-only quote probe of
  the two Help migrations (each `replace()` quote of 0267 and 0268 must occur
  exactly once in the guide it edits; a Help console edit since then makes the
  migration's `applyVerify` fail the deploy). It was checked on the local
  database only. `npm run help:audit:staging` and `:prod` read the same guides.
- **Run the migrate away from the billing run's minute** (review R3-12). 0266
  is one transaction whose ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE
  locks on `platform_billing_settings`, `billing_accounts`,
  `ai_credit_purchases` and `billing_invoices` (and SHARE ROW EXCLUSIVE on
  `platform_announcements` for the notice key) until COMMIT. The tables are
  small and the runner's 5-second `lock_timeout` turns a wait into a refused
  build, not an outage, but the hourly billing run (minute 20 UTC) holds row
  locks on `billing_invoices` while it works. Push away from roughly :15 to :30
  past the hour; a refused migrate is retried by re-running the build.
- **Only if GST was already on when 0266 ran** (review R3-11): the
  migration marked invoices whose GST line reads "(included)" as
  `tax_inclusive` before the guard froze the column, but an invoice the
  replaced revision issues after that commit and before the new revision serves
  is frozen with `tax_inclusive = false`. After the deploy, list them for a
  person to note (they cannot be edited):

  ```sql
  BEGIN READ ONLY;
  select i.id, i.invoice_no, i.finalized_at from billing_invoices i
   where i.finalized_at is not null and i.tax_paise > 0
     and i.tax_inclusive = false
     and exists (select 1 from billing_invoice_items it
                  where it.invoice_id = i.id and it.kind = 'tax'
                    and it.description like '%(included)');
  ROLLBACK;
  ```

  The migration is replay-safe only up to step 7 (the guard); the ledger never
  replays an applied migration, so this matters only to someone re-running it
  by hand.

### Comped and operator-granted plans

`plan_source = 'comp'` stores have **no mandate and no invoice**. They must be
skipped by the renewal worker entirely and are excluded from the downgrade claim
above. `plan_expires_at` and the plan-expiry cron remain a separate, parallel
route to Free and must not double-fire with this one. The existing
`billingMayApplyPlan` rule — _a comp is a floor, not a ceiling_ — survives
unchanged; it exists because a comped store that later paid for Pro had all
three webhooks discarded.

---

## 8. AI credits — separate domain, shared infrastructure

An AI credit purchase is an `invoices` row with `kind = 'ai_credits'`, its own
payment attempt, and **never** a line on a subscription invoice.

The plan-purchase UI follows the same boundary: AI credits are the only add-on
offered, but the review explicitly presents them as a second, one-time checkout
and invoice after the subscription succeeds. Cancelling that optional checkout
does not roll back or disguise the plan payment.

- `cycle_seq` is NULL, so the one-invoice-per-cycle constraint does not apply.
- The credit grant is keyed on `invoice_id`, **unique in the ledger** — three
  identical webhooks grant once (§53). The existing `ai_credit_ledger` already
  has a unique partial index on `(kind, ref) WHERE kind='purchase'` and
  `try_spend_ai_credit` is already a single conditional UPDATE, so this is an
  extension of a working design rather than a new one.
- Subscription state is never consulted when granting, and credits are never
  revoked by a subscription downgrade.
- **★ `ai_credit_purchases.amount_paise` is what the merchant is charged**
  (0266, `ai_credit_purchases_amount_paise_check`: NULL or above 0). The pack's
  invoice is built at checkout (`buildAiCreditsInvoice`, one tax reading) and
  its total, GST included when prices exclude GST, is the Razorpay order amount
  and this column; `amount_inr` stays the listed pack price. The confirm
  verifies the captured payment against `amount_paise`, falling back to
  `amount_inr * 100` for purchases made before it existed. The invoice is
  issued as paid at the payment's time. While GST is charged, a merchant with
  no state on record, or outside India, cannot start a pack payment
  (`readTaxForPayment`, the rule every payment shares).
- Purchases succeed while a subscription is in grace, and vice versa. There is
  no code path where one reads the other.

**Three concrete gaps to close, all narrow:**

1. **The unreconcilable window.** `startCreditPurchase` inserts the pending row,
   then creates the Razorpay order, then writes `rzp_order_id` back. If that last
   write fails, the row is `pending` with a null order id — and
   `reconcilePendingPurchases` _skips exactly those_ (`if (!p.rzp_order_id)
continue`). A merchant who paid in that window can never be credited by any
   automated path. Fix: mint our own `idempotency_key` first and pass it in
   `notes`, so reconciliation can find the order without needing the id round
   trip — the `issue-refund.ts` pattern again.
2. **The claim and the grant are separate transactions.** `settlePurchase`
   claims `pending → paid`, then calls `add_ai_credits`. If the second fails, the
   purchase is `paid` with no credits, and reconcile filters on
   `status='pending'` so nothing ever retries it. Fix: one transaction, or a
   `credit_granted_at` column that reconciliation targets.
3. **No `payment.captured` webhook.** Everything rests on the merchant's browser
   returning plus a reconcile-on-page-load. Adding the webhook removes both the
   window and the dependence on a page nobody may visit.

---

## 9. What is reused, and what goes

**Reused as-is:**

- `lib/plans.ts` — catalog, `PLAN_LIMITS`, `PLAN_RANK`, `effectivePlan`,
  `normalizePlan`, `expiryWarnWindow`. Pure and tested.
- `lib/plans/pricing.ts` — the cached/live split is exactly right and already
  observed: **`getPlanPricingLive` wherever the number decides a charge**,
  cached elsewhere. Keep the discipline.
- `billingMayApplyPlan` — the comp-is-a-floor rule, unchanged.
- `plan_events` — the audit log, plus a dedup key it currently lacks.
- `lib/payments/razorpay.ts` transport: `rzpFetch`, `rzpCreateOrder`,
  `verifyWebhookSignature`, `verifyCheckoutSignature`, and **`RzpResult`'s
  `rejected` / `unknown` discrimination**, which is Rule 6's primitive already
  built.
- `lib/payments/issue-refund.ts` — the template for `payment_attempts` (§5).
- The AI credit ledger, `add_ai_credits`, `try_spend_ai_credit`.
- The `data_jobs` lease/cursor worker (`SELECT … FOR UPDATE SKIP LOCKED` +
  lease in one transaction) as the webhook processor and renewal worker.
- `splitGst`'s remainder trick — **re-implemented in paise**. The existing one
  rounds to two decimals (rupees) and must not be called directly from invoices.
- `lib/plans/renewal.ts` — and it should finally be _used_ by the expiry warning
  path, which is bug 7 above.

**Removed:** Razorpay Subscriptions entirely. `rzpCreatePlan`,
`rzpCreateSubscription`, `rzpUpdateSubscription`, `rzpCancelSubscription`,
`resolveRazorpayPlanId`, the `razorpay_plans` cache table, every `subscription.*`
webhook case, `mandateMaxPaise()`'s computed ceiling, `totalCyclesFor`,
`reconcileStaleSubscription`, and the half of `decidePlanChange` that exists only
because the price lives in a provider-side plan id. `store_subscriptions`'
Razorpay status CHECK goes with it — our own vocabulary replaces it.

**Kept but rewritten:** `cancelSubscription`, now `cancelAtPeriodEnd` in
`lib/billing/cancel.ts` (no gateway subscription to cancel: it sets
`cancel_at_period_end`, lets the cycle run out, and the plan's end closes and
refunds any renewal already issued or paid for the cycle it does not reach,
§7), and the plan-expiry cron, which must not double-fire with the new
downgrade claim.

---

## 10. Still to verify before Phase 3

Recorded honestly rather than guessed. The flow, methods, limits and timing above
are verified; these are not:

- The exact endpoint and request body for creating a subsequent recurring
  payment (the docs index references it without reproducing the signature).
  Confirm against the API reference **and a test-mode dry run**.
- The exact webhook event names for token-based recurring, and whether
  `token.confirmed` / `token.cancelled` are emitted.
- The largest `max_amount` Razorpay will actually register for a **UPI** mandate
  (cards have no practical cap). §2c settles the AFA threshold at ₹15,000; the
  registration ceiling is a gateway/acquirer question, not a regulatory one.
- Whether StoreMink's MCC could ever qualify for the ₹1,00,000 AFA-exempt
  category. Assume **no** until the acquirer says otherwise in writing.
- MCC restrictions on the platform's own Razorpay account for recurring.
- Who sends the pre-debit notification for token-based recurring on **cards**
  (confirmed for UPI AutoPay), and whether `sms_notify` / `email_notify` are
  sufficient.
- Whether `duration_days` for yearly is 365 or 360.

---

## 11. Non-negotiables

1. Never charge twice because a status is uncertain.
2. Never mark an invoice paid without verified payment.
3. Never grant AI credits without verified successful payment.
4. Never trust the frontend for amount or state.
5. Never delete a financial record.
6. Never downgrade on an unknown payment state caused by a provider outage.
7. After the 2-day grace, an unpaid subscription moves to Free automatically.
8. A payment after downgrade never reactivates the plan.
9. AI credits are completely separate from subscription billing.
10. When state is ambiguous, reconcile — never guess.
