"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// The pricing cards, with the monthly/yearly switch.
//
// DEFAULTS TO YEARLY, deliberately: it is the cheaper per-month number and the
// one we want anchored in someone's head, and it is what Claude, Hostinger and
// most SaaS pricing pages do.
//
// A yearly plan is quoted PER MONTH ("₹1,250 /mo, billed annually") because
// that is the number a buyer compares against a competitor's monthly price.
// The full amount they will actually be charged is stated on the same card.
// Quoting only the per-month figure and surprising someone at checkout is the
// oldest trick on a pricing page and we are not doing it.
//
// The card is shopify.com/pricing's shape: the name and a short tagline on the
// left with the price on the right, one outline button, then a list of short
// rows separated by hairlines, with no icons. The copy in PLANS is written to
// fit one line per row.
//
// Prices arrive resolved from the server (lib/plans/pricing.ts): code defaults
// with any operator override folded in. This component never computes a price,
// so it cannot disagree with what billing charges.
//
// ★ THE GST WORDS ARRIVE WRITTEN TOO (GST design 7.1). The line under each
// price and the small "plus GST" after "/mo" are worked out on the server for
// the GST terms of that render (`pricingCards`, pricing-content.tsx, from
// lib/billing/tax-copy.ts), so a total with GST is never computed here and no
// date is formatted in the visitor's time zone. With no notes (StoreMink's GST
// settings could not be read), a card states its amount alone, with no GST
// words at all: a failed read is never shown as "GST is off".
// ---------------------------------------------------------------------------

export interface PricingCard {
  id: string;
  name: string;
  who: string;
  features: string[];
  cta: string;
  popular: boolean;
  monthlyInr: number;
  yearlyInr: number;
  /** Struck-through list price, or null when no offer is running. */
  baseMonthlyInr: number | null;
  baseYearlyInr: number | null;
  /**
   * The line under the price for each billing period, GST words included
   * ("₹1,770 billed every month, including GST"). Null when the GST settings
   * could not be read: the card then states the amount alone.
   */
  notes: { monthly: string; yearly: string } | null;
  /** Small words after "/mo" while GST is added on top ("plus GST"), or null. */
  priceSuffix: string | null;
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export function PricingCards({
  plans,
  aside,
}: {
  plans: PricingCard[];
  /** Rendered at the right of the billing switch, e.g. a compare link. */
  aside?: ReactNode;
}) {
  const [yearly, setYearly] = useState(true);
  const switchLabelId = useId();

  // Only worth showing the switch if something actually differs. On an
  // all-free catalogue a toggle that changes nothing is just a control that
  // makes people wonder what they missed.
  const hasPaid = plans.some((p) => p.monthlyInr > 0 || p.yearlyInr > 0);

  return (
    <>
      {(hasPaid || aside) && (
        <div className="stq-pricing-bar">
          {hasPaid && (
            <div className="stq-billing-switch">
              <button
                type="button"
                role="switch"
                aria-checked={yearly}
                aria-labelledby={switchLabelId}
                onClick={() => setYearly((on) => !on)}
                className={`stq-switch${yearly ? " is-on" : ""}`}
              >
                <span />
              </button>
              <span id={switchLabelId}>
                Pay yearly <small>2 months free</small>
              </span>
            </div>
          )}
          {aside && <div className="stq-pricing-aside">{aside}</div>}
        </div>
      )}

      <div className="stq-pricing">
        {plans.map((p) => {
          const free = p.monthlyInr === 0 && p.yearlyInr === 0;
          // The headline is always a MONTHLY figure: on yearly it is the
          // annual total divided by twelve, so the two states are comparable.
          const shown = free
            ? 0
            : yearly
              ? Math.round(p.yearlyInr / 12)
              : p.monthlyInr;
          const base = yearly ? p.baseYearlyInr : p.baseMonthlyInr;
          const shownBase =
            base === null || free
              ? null
              : yearly
                ? Math.round(base / 12)
                : base;

          return (
            <div
              className={`stq-price-card${p.popular ? " popular" : ""}`}
              key={p.id}
            >
              <div className="stq-price-top">
                <div>
                  <h3>{p.name}</h3>
                  <p className="who">{p.who}</p>
                </div>
                <div className="stq-price">
                  {shownBase !== null && (
                    <s aria-label={`Was ${inr(shownBase)} per month`}>
                      {inr(shownBase)}
                    </s>
                  )}
                  <b>{inr(shown)}</b>
                  <sub>{p.priceSuffix ? `/mo ${p.priceSuffix}` : "/mo"}</sub>
                </div>
              </div>

              {/* What they are actually charged, and when. */}
              <p className="stq-card-note">
                {p.notes
                  ? yearly
                    ? p.notes.yearly
                    : p.notes.monthly
                  : free
                    ? "No card needed"
                    : yearly
                      ? `${inr(p.yearlyInr)} billed once a year`
                      : `${inr(p.monthlyInr)} billed every month`}
              </p>

              <Link
                href="/signup"
                className={`stq-btn ${
                  p.popular ? "stq-btn-primary" : "stq-btn-ghost"
                } stq-btn-block`}
              >
                {p.cta}
              </Link>

              <ul>
                {p.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </>
  );
}
