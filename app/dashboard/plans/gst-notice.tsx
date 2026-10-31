"use client";

/**
 * The GST banners at the top of Plans & Billing (GST design 7.3), after the
 * invoice to pay and the refunds notice: the GST notice while a change that
 * raises this merchant's bills is scheduled, then the "add your state" banner
 * (or the outside-India sentence) for a store with a live paid plan.
 *
 * ★ Every sentence comes from lib/billing/tax-copy.ts and is rendered as
 * plain text; nothing here writes its own wording.
 * ★ It renders NOTHING when there is nothing to say, and nothing at all when
 * the GST terms could not be read: a banner guessed from a failed read is
 * worse than no banner.
 */

import { AlertCircle, Info } from "lucide-react";
import {
  gstNoticeBanner,
  stateBanner,
  type NoticeRenewal,
} from "@/lib/billing/tax-copy";
import type { RenewalQuote } from "@/lib/billing/quote-types";
import type { TaxTerms } from "@/lib/billing/tax-terms";

/** The Billing details card's id, and its state select's. */
export const BILLING_DETAILS_ID = "billing-details";
export const BILLING_DETAILS_STATE_ID = "billing-details-state";

/** Scroll to the Billing details card and put the cursor on its state. */
export function goToBillingState(): void {
  if (typeof document === "undefined") return;
  const card = document.getElementById(BILLING_DETAILS_ID);
  card?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  const select = document.getElementById(BILLING_DETAILS_STATE_ID);
  if (select instanceof HTMLElement) select.focus({ preventScroll: true });
}

function noticeRenewalOf(renewal: RenewalQuote | null): NoticeRenewal | null {
  if (!renewal) return null;
  return {
    renewsOn: renewal.renewsOn,
    amount: renewal.amount,
    route: renewal.route,
    mandateMaxPaise: renewal.mandateMaxPaise,
  };
}

export function GstNotice({
  terms,
  renewal,
  canManage,
}: {
  /** Read live (`getTaxTermsLive`); null when the read failed. */
  terms: TaxTerms | null;
  /** The store's next renewal; null without a live paid plan. */
  renewal: RenewalQuote | null;
  /**
   * Billing permission. Without it the Billing details card shows no fields,
   * so the banner offers no button that leads to them (R2-10); the banner's
   * words still say what is needed.
   */
  canManage: boolean;
}) {
  if (!terms) return null;
  const notice = gstNoticeBanner(terms, noticeRenewalOf(renewal));
  // Only a store with a live paid plan has a next renewal, and the state
  // banner is for exactly those stores (design 7.3).
  const state = renewal
    ? stateBanner(terms, renewal.placeOfSupply.basis)
    : null;
  if (!notice && !state) return null;

  return (
    <div className="space-y-4">
      {notice && (
        <section
          aria-label={notice.title}
          className="rounded-xl border border-indigo-200 bg-indigo-50 p-5"
        >
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-indigo-950">
                {notice.title}
              </h2>
              {notice.lines.map((line) => (
                <p key={line} className="mt-1 text-sm text-indigo-900">
                  {line}
                </p>
              ))}
            </div>
          </div>
        </section>
      )}
      {state && (
        <section
          aria-label={state.title ?? undefined}
          className="rounded-xl border border-amber-300 bg-amber-50 p-5"
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              {state.title && (
                <h2 className="text-base font-semibold text-amber-900">
                  {state.title}
                </h2>
              )}
              <p className="mt-1 text-sm text-amber-900">{state.body}</p>
              {state.action && canManage && (
                <button
                  type="button"
                  onClick={goToBillingState}
                  className="mt-3 inline-flex items-center rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-black"
                >
                  {state.action}
                </button>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
