// ---------------------------------------------------------------------------
// The signup wizard's Plan step: what /api/plans/pricing answers, and the
// small amount of arithmetic the step does with it. Pure and client-safe.
//
// ★ A PRICE IS SERVER STATE. The step never quotes `PLAN_META`'s compiled
// defaults: an operator may have repriced, and a card that shows one amount
// while Razorpay asks for another is how a signup ends in a dispute. When the
// live quote cannot be read the step offers Free only.
//
// ★ GST IS SERVER STATE TOO (GST design 7.2). The answer carries the GST terms
// in force now (`tax`, read live), and every amount the step shows is worked
// out with the invoice builder the server charges with
// (`buildSubscriptionInvoice` and `taxContextFor`), so the line on screen is
// the total the server will ask for unless something changes in between,
// which the amount guard then catches. An answer with no `tax` (an older
// revision of the API, during a rollout) still parses: the step then shows
// list prices and promises the exact amount before payment.
// ---------------------------------------------------------------------------

import { PLAN_IDS } from "@/lib/plans";
import { collectionStartsAt, cycleFrom } from "@/lib/billing/cycle";
import { buildSubscriptionInvoice } from "@/lib/billing/invoice";
import type { CopyAmount } from "@/lib/billing/tax-copy";
import {
  taxContextFor,
  termsLater,
  type TaxTerms,
} from "@/lib/billing/tax-terms";
import type { PlanPrice, PlanPricing } from "./pricing";

export type BillingPeriod = "monthly" | "yearly";

export interface SignupPlanQuote {
  plans: PlanPricing;
  /** The platform can take a card at all (its own Razorpay keys are set). */
  paidCheckout: boolean;
  /**
   * The GST terms in force when the answer was made, read live; null when the
   * answer carried none (an older API during a rollout).
   */
  tax: TaxTerms | null;
}

function isPrice(value: unknown): value is PlanPrice {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  const money = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  const base = (v: unknown) => v === null || money(v);
  return (
    money(p.monthlyInr) &&
    money(p.yearlyInr) &&
    base(p.baseMonthlyInr) &&
    base(p.baseYearlyInr)
  );
}

const MAX_RATE_BPS = 10_000;

function isRateBps(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_RATE_BPS
  );
}

/**
 * The answer's GST terms: `undefined` when the answer has none (an older API,
 * read as no terms), null when it has something that is not a whole
 * `TaxTerms` (the quote is then unavailable: a guessed "no GST" would quote
 * the wrong amount).
 */
function parseTax(value: unknown): TaxTerms | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (
    typeof t.active !== "boolean" ||
    typeof t.inclusive !== "boolean" ||
    !isRateBps(t.rateBps)
  ) {
    return null;
  }
  let upcoming: TaxTerms["upcoming"] = null;
  if (t.upcoming !== null && t.upcoming !== undefined) {
    if (typeof t.upcoming !== "object") return null;
    const u = t.upcoming as Record<string, unknown>;
    if (
      typeof u.enabled !== "boolean" ||
      typeof u.inclusive !== "boolean" ||
      !isRateBps(u.rateBps) ||
      typeof u.startsAt !== "string" ||
      !Number.isFinite(Date.parse(u.startsAt))
    ) {
      return null;
    }
    upcoming = {
      enabled: u.enabled,
      inclusive: u.inclusive,
      rateBps: u.rateBps,
      startsAt: u.startsAt,
    };
  }
  return {
    active: t.active,
    inclusive: t.inclusive,
    rateBps: t.rateBps,
    upcoming,
  };
}

/** Accept only a complete quote; anything else reads as "unavailable". */
export function parseSignupPlanQuote(value: unknown): SignupPlanQuote | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const plans = record.plans;
  if (!plans || typeof plans !== "object") return null;
  for (const plan of PLAN_IDS) {
    if (!isPrice((plans as Record<string, unknown>)[plan])) return null;
  }
  const tax = parseTax(record.tax);
  if (tax === null) return null;
  return {
    plans: plans as PlanPricing,
    paidCheckout: record.paidCheckout === true,
    tax: tax ?? null,
  };
}

/** What a plan charges for the period chosen (a yearly price is the total). */
export function chargeFor(price: PlanPrice, period: BillingPeriod): number {
  return period === "yearly" ? price.yearlyInr : price.monthlyInr;
}

/** The same list price, in paise (no GST). */
export function listPricePaise(
  price: PlanPrice,
  period: BillingPeriod,
): number {
  return Math.round(chargeFor(price, period) * 100);
}

const NO_GST: TaxTerms = {
  active: false,
  inclusive: false,
  rateBps: 0,
  upcoming: null,
};

/**
 * What a paid plan's first cycle costs under these GST terms: the invoice
 * builder the server charges with, on the list price with no discount and no
 * locations (enrolment bills none). Intra or inter State changes the split,
 * never the total, so no state is needed. With no terms (an older API) it is
 * the list price, which is also the amount the step then shows.
 */
export function signupAmount(
  price: PlanPrice,
  period: BillingPeriod,
  terms: TaxTerms | null,
): CopyAmount {
  const built = buildSubscriptionInvoice({
    planLabel: "Plan",
    period,
    planPaise: listPricePaise(price, period),
    tax: taxContextFor(terms ?? NO_GST, null, null),
  });
  return {
    totalPaise: built.totalPaise,
    taxPaise: built.taxPaise,
    rateBps: built.taxRateBps,
    inclusive: built.inclusive,
  };
}

/**
 * The first renewal's total, under the terms in force when it is collected:
 * four days before the first cycle ends (`collectionStartsAt`), the moment
 * enrolment decides the autopay rail from (lib/billing/enrol.ts). A scheduled
 * GST start before then is in it. `now` is when the quote was read. An
 * ESTIMATE for the explanation only: the server decides the rail.
 */
export function firstRenewalPaise(
  price: PlanPrice,
  period: BillingPeriod,
  terms: TaxTerms | null,
  now: Date,
): number {
  if (!terms) return listPricePaise(price, period);
  const cycle = cycleFrom(now, period, 1);
  const renewal = termsLater(terms, collectionStartsAt(cycle.end));
  return signupAmount(price, period, renewal).totalPaise;
}

/**
 * The yearly toggle's label, derived from the live prices rather than
 * promised in copy: "2 months free" only while every paid plan's yearly price
 * is exactly that many months cheaper, otherwise a plain "Save with yearly",
 * and nothing when yearly saves nothing.
 */
export function yearlySavingLabel(plans: PlanPricing): string | null {
  const paid = PLAN_IDS.filter((plan) => plans[plan].monthlyInr > 0).map(
    (plan) => plans[plan],
  );
  if (paid.length === 0) return null;
  const months = paid.map(
    (row) => (row.monthlyInr * 12 - row.yearlyInr) / row.monthlyInr,
  );
  if (
    months.every((m) => m > 0 && Number.isInteger(m)) &&
    months.every((m) => m === months[0])
  ) {
    return `${months[0]} ${months[0] === 1 ? "month" : "months"} free`;
  }
  return paid.some((row) => row.yearlyInr < row.monthlyInr * 12)
    ? "Save with yearly"
    : null;
}

export function formatInr(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}
