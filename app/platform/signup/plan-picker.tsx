"use client";

import { Check } from "lucide-react";
import { PLAN_IDS, PLAN_META, type Plan } from "@/lib/plans";
import {
  chargeFor,
  formatInr,
  yearlySavingLabel,
  type BillingPeriod,
  type SignupPlanQuote,
} from "@/lib/plans/signup-quote";
import {
  autopayRailFor,
  type MandateMethod,
} from "@/lib/billing/mandate-types";
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
 */
export function PlanPicker({
  quote,
  plan,
  period,
  mandateMethod,
  disabled,
  onPlanChange,
  onPeriodChange,
  onMandateMethodChange,
}: {
  quote: SignupPlanQuote;
  plan: Plan;
  period: BillingPeriod;
  mandateMethod: MandateMethod;
  disabled: boolean;
  onPlanChange: (plan: Plan) => void;
  onPeriodChange: (period: BillingPeriod) => void;
  onMandateMethodChange: (method: MandateMethod) => void;
}) {
  const saving = yearlySavingLabel(quote.plans);
  const paidSelected = quote.paidCheckout && plan !== "free";
  // ⚠ An ESTIMATE: it cannot see tax, so near the ₹15,000 line it can read a
  // shade low. The server decides the rail authoritatively when payment
  // starts; this only chooses which explanation to show.
  const autopay =
    paidSelected &&
    autopayRailFor(Math.round(chargeFor(quote.plans[plan], period) * 100)) !==
      null;

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
          // shown for comparison and cannot be chosen here.
          const locked = id !== "free" && !quote.paidCheckout;
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
                aria-label={`${PLAN_META[id].name}, ${formatInr(amount)} a ${periodWord(period)}`}
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
              </span>
              <span className="sgn-plan-billing">
                {locked
                  ? "Choose this from your dashboard after signup"
                  : amount === 0
                    ? "No card needed"
                    : period === "yearly"
                      ? `${formatInr(Math.round(amount / 12))} a month, billed yearly`
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
          <p className="sgn-plan-rail-quiet">
            You&apos;ll see the exact amount, including any GST, before you pay.
          </p>
        </div>
      )}
    </div>
  );
}
