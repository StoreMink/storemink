"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { PLAN_IDS, PLAN_META, type Plan } from "@/lib/plans";
import {
  chargeFor,
  firstRenewalPaise,
  formatInr,
  listPricePaise,
  signupAmount,
  yearlySavingLabel,
  type BillingPeriod,
  type SignupPlanQuote,
} from "@/lib/plans/signup-quote";
import {
  autopayRailFor,
  type MandateMethod,
} from "@/lib/billing/mandate-types";
import {
  pricingPriceSuffix,
  signupPayNowLine,
  signupYearlyLine,
} from "@/lib/billing/tax-copy";
import { PLANS } from "../pricing-content";

/** How many of a plan's feature lines a signup card shows. The full list
 *  lives on /pricing; a card only has to say what each plan is FOR. */
const FEATURE_LINES = 5;

export function periodWord(period: BillingPeriod): string {
  return period === "yearly" ? "year" : "month";
}

/**
 * The signup wizard's plan cards: a billing-period switch, Free / Basic / Pro,
 * and how renewals will be paid for the plan chosen.
 *
 * Presentational only. Every price comes from the live quote the wizard
 * fetched (never `PLAN_META`'s compiled defaults), and nothing here charges
 * anyone: the wizard re-reads the price and the server computes the amount.
 *
 * GST (design 7.2) comes from the quote's live terms through the one copy
 * module (lib/billing/tax-copy.ts): the card price stays the list price, with
 * "plus GST" beside it while GST is added on top; the yearly line and the
 * pay-now line quote what the invoice builder works out. An answer with no
 * terms (an older API) shows list prices and promises the exact amount before
 * payment.
 */
export function PlanPicker({
  quote,
  quotedAt,
  plan,
  period,
  mandateMethod,
  disabled,
  outsideIndia = false,
  stateStep,
  onPlanChange,
  onPeriodChange,
  onMandateMethodChange,
}: {
  quote: SignupPlanQuote;
  /** When the quote was read (ms), for the first renewal's GST terms. */
  quotedAt: number;
  plan: Plan;
  period: BillingPeriod;
  mandateMethod: MandateMethod;
  disabled: boolean;
  /**
   * A business outside India while GST is charged now: the paid plans stay
   * visible with their prices but cannot be chosen (design 7.2).
   */
  outsideIndia?: boolean;
  /** The state and GSTIN fields, shown above the pay-now line. */
  stateStep?: ReactNode;
  onPlanChange: (plan: Plan) => void;
  onPeriodChange: (period: BillingPeriod) => void;
  onMandateMethodChange: (method: MandateMethod) => void;
}) {
  const saving = yearlySavingLabel(quote.plans);
  const terms = quote.tax;
  const paidSelected = quote.paidCheckout && !outsideIndia && plan !== "free";
  const suffix = terms ? pricingPriceSuffix(terms) : null;
  // ⚠ An ESTIMATE: the first renewal's total under the GST terms in force when
  // it is collected (`termsLater`), as enrolment decides the rail. The server
  // decides authoritatively when payment starts; this only chooses which
  // explanation to show.
  const autopay =
    paidSelected &&
    autopayRailFor(
      firstRenewalPaise(quote.plans[plan], period, terms, new Date(quotedAt)),
    ) !== null;

  return (
    <div className="sgn-plan-picker">
      <div className="sgn-period" role="group" aria-label="Billing period">
        <button
          type="button"
          aria-pressed={period === "monthly"}
          disabled={disabled}
          onClick={() => onPeriodChange("monthly")}
        >
          Monthly
        </button>
        <button
          type="button"
          aria-pressed={period === "yearly"}
          disabled={disabled}
          onClick={() => onPeriodChange("yearly")}
        >
          Yearly
          {saving && <span className="sgn-period-save">{saving}</span>}
        </button>
      </div>

      <fieldset className="sgn-plans" disabled={disabled}>
        <legend className="sgn-sr">Plan</legend>
        {PLAN_IDS.map((id) => {
          const copy = PLANS.find((entry) => entry.meta.id === id);
          const price = quote.plans[id];
          const amount = chargeFor(price, period);
          const base =
            period === "yearly" ? price.baseYearlyInr : price.baseMonthlyInr;
          // Paying needs the platform's own gateway. Without it a paid card is
          // shown for comparison and cannot be chosen here. A business outside
          // India while GST is charged sees the prices but cannot choose one.
          const noCheckout = id !== "free" && !quote.paidCheckout;
          const locked = noCheckout || (id !== "free" && outsideIndia);
          const selected = plan === id;
          return (
            <label
              key={id}
              className={`sgn-plan${selected ? " is-selected" : ""}${
                locked ? " is-locked" : ""
              }`}
            >
              {/* ★ Named explicitly: wrapped by the whole card, the radio's
                  name would otherwise be every word on it, features
                  included. */}
              <input
                type="radio"
                name="signup-plan"
                value={id}
                checked={selected}
                disabled={locked}
                aria-label={`${PLAN_META[id].name}, ${formatInr(amount)} a ${periodWord(period)}${
                  suffix && amount > 0 ? ` ${suffix}` : ""
                }`}
                onChange={() => onPlanChange(id)}
              />
              <span className="sgn-plan-head">
                <span className="sgn-plan-name">{PLAN_META[id].name}</span>
                {copy?.popular && !locked && (
                  <span className="sgn-plan-badge">Most popular</span>
                )}
                <span className="sgn-plan-radio" aria-hidden="true" />
              </span>
              {copy && <span className="sgn-plan-who">{copy.who}</span>}
              <span className="sgn-plan-price">
                {base !== null && base > amount && (
                  <s className="sgn-plan-was">{formatInr(base)}</s>
                )}
                <strong>{formatInr(amount)}</strong>
                <span>/{periodWord(period)}</span>
                {suffix && amount > 0 && <span>{suffix}</span>}
              </span>
              <span className="sgn-plan-billing">
                {noCheckout
                  ? "Choose this from your dashboard after signup"
                  : amount === 0
                    ? "No card needed"
                    : period === "yearly"
                      ? signupYearlyLine(terms, listPricePaise(price, period))
                      : "Billed monthly"}
              </span>
              {/* Spans, not ul/li: a label may hold phrasing content only. */}
              {copy && (
                <span className="sgn-plan-features" role="list">
                  {copy.features.slice(0, FEATURE_LINES).map((feature) => (
                    <span key={feature} role="listitem">
                      <Check size={15} aria-hidden="true" />
                      {feature}
                    </span>
                  ))}
                </span>
              )}
            </label>
          );
        })}
      </fieldset>

      {/* ★★ THE AMOUNT PICKS THE RAIL, NOT THE MERCHANT (lib/billing/
          mandate-types.ts). RBI's AFA-exempt limit is ₹15,000 on cards and
          UPI alike, so above it no supported rail can auto-debit and the
          server asks for no mandate at all. The card link is the one escape:
          Checkout shows only the rail on the order, so someone with no UPI
          app could otherwise not subscribe. */}
      {paidSelected && (
        <div className="sgn-plan-rail">
          {autopay ? (
            <>
              <p>
                <strong>
                  {mandateMethod === "card"
                    ? "Renewals are charged to your card."
                    : "Renewals are charged by UPI Autopay."}
                </strong>{" "}
                {mandateMethod === "card"
                  ? "Your card is saved under RBI e-mandate rules."
                  : "You approve it once in your UPI app; no card details are stored."}
              </p>
              <button
                type="button"
                className="sgn-link"
                disabled={disabled}
                onClick={() =>
                  onMandateMethodChange(
                    mandateMethod === "card" ? "upi" : "card",
                  )
                }
              >
                {mandateMethod === "card"
                  ? "Use UPI Autopay instead"
                  : "Pay by card instead"}
              </button>
            </>
          ) : (
            <p>
              <strong>Renewals for this plan are invoiced.</strong> Automatic
              debits in India are capped at ₹15,000 per charge, so before each
              renewal we email you an invoice to pay. Nothing is auto-debited.
            </p>
          )}
          {stateStep}
          <p className={terms ? undefined : "sgn-plan-rail-quiet"}>
            {signupPayNowLine(
              terms,
              period,
              signupAmount(quote.plans[plan], period, terms),
            )}
          </p>
        </div>
      )}
    </div>
  );
}
