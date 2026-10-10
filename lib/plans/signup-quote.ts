// ---------------------------------------------------------------------------
// The signup wizard's Plan step: what /api/plans/pricing answers, and the
// small amount of arithmetic the step does with it. Pure and client-safe.
//
// ★ A PRICE IS SERVER STATE. The step never quotes `PLAN_META`'s compiled
// defaults: an operator may have repriced, and a card that shows one amount
// while Razorpay asks for another is how a signup ends in a dispute. When the
// live quote cannot be read the step offers Free only.
// ---------------------------------------------------------------------------

import { PLAN_IDS } from "@/lib/plans";
import type { PlanPrice, PlanPricing } from "./pricing";

export type BillingPeriod = "monthly" | "yearly";

export interface SignupPlanQuote {
  plans: PlanPricing;
  /** The platform can take a card at all (its own Razorpay keys are set). */
  paidCheckout: boolean;
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

/** Accept only a complete quote; anything else reads as "unavailable". */
export function parseSignupPlanQuote(value: unknown): SignupPlanQuote | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const plans = record.plans;
  if (!plans || typeof plans !== "object") return null;
  for (const plan of PLAN_IDS) {
    if (!isPrice((plans as Record<string, unknown>)[plan])) return null;
  }
  return {
    plans: plans as PlanPricing,
    paidCheckout: record.paidCheckout === true,
  };
}

/** What a plan charges for the period chosen (a yearly price is the total). */
export function chargeFor(price: PlanPrice, period: BillingPeriod): number {
  return period === "yearly" ? price.yearlyInr : price.monthlyInr;
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
