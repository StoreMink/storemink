import { requireSectionAccess } from "../lib/access";
import { getAiUsagePageData } from "@/app/actions/ai-credit-actions";
import {
  getMyBillingDetails,
  getMyNextRenewal,
  getMySubscription,
  getPayableInvoices,
} from "@/app/actions/subscribe-actions";
import { getTaxTermsLive } from "@/lib/billing/platform-settings";
import type { TaxTerms } from "@/lib/billing/tax-terms";
import { logError } from "@/lib/observability/logger";
import { getMinkCreditPacksLive } from "@/lib/ai/credit-pricing";
import { getPlanPricingLive } from "@/lib/plans/pricing";
import { getPlanAllowancesLive } from "@/lib/plans/allowances";
import { getMinkConfig } from "@/lib/mink/config";
import { PLAN_META, includedMinkCredits, normalizePlan } from "@/lib/plans";
import { PlansBillingClient } from "./plans-client";
import { OpenInvoices } from "./open-invoices";
import { RefundsNotice } from "./refunds-notice";
import { CompActiveNotice, CompOfferCard } from "./comp-offer";
import { GstNotice } from "./gst-notice";
import { BillingDetailsCard } from "./billing-details-card";
import { SettingsShell } from "../settings/settings-shell";

/**
 * The GST terms in force now, read LIVE: this page quotes a price and then
 * charges it, so never the cached reader (GST design 5.4).
 *
 * ★ A read that fails is NOT GST off: it gives null, the page shows list
 * prices with no GST words and no GST banner, and every payment is still
 * quoted and guarded on its own (the checkout summary from `quoteCheckout`,
 * the amount guard on every button).
 */
async function readTaxTerms(): Promise<TaxTerms | null> {
  try {
    return await getTaxTermsLive();
  } catch (err) {
    logError("billing.plans_page.tax_terms", err);
    return null;
  }
}

export const metadata = { title: "Plans & Billing" };

// Permission section is still "ai" (the credit/AI actions gate on it) — only the
// nav label + route changed to "Plans & Billing".
export default async function PlansBillingPage() {
  const access = await requireSectionAccess("ai", "view");
  // LIVE, not the cached read: this page quotes a price and then charges it.
  // Reading through a cache a reprice had not yet reached would show one number
  // in the upgrade dialog and take a different one from the card.
  const [
    data,
    subscription,
    pricing,
    invoices,
    packs,
    allowances,
    terms,
    nextRenewal,
    billingDetails,
  ] = await Promise.all([
    getAiUsagePageData(),
    getMySubscription(),
    getPlanPricingLive(),
    // ★ What they OWE, above everything else on the page. Manual collection is
    // still required for amounts above the AFA limit, revoked mandates and
    // provider incidents, so burying it would downgrade merchants who never
    // knew there was a bill.
    getPayableInvoices(),
    getMinkCreditPacksLive(),
    getPlanAllowancesLive(),
    readTaxTerms(),
    // Both null for someone who cannot manage billing, and on a read
    // failure (they gate on the manage permission).
    getMyNextRenewal(),
    getMyBillingDetails(),
  ]);
  const includedCredits = includedMinkCredits(
    allowances,
    getMinkConfig().chargeCredits,
  );
  const canManage = access.can("ai", "manage");
  const paidPlanName = PLAN_META[normalizePlan(data.paidPlan)].name;
  // Wrapped here rather than in a layout, so the printable invoice and credit
  // note pages under /dashboard/plans stay bare (no settings menu).
  return (
    <SettingsShell>
      <div className="space-y-6">
        {/* Banner order (GST design 7.3): the invoice to pay, refunds, then
          GST and the merchant's state. */}
        <OpenInvoices invoices={invoices} canManage={canManage} />
        <RefundsNotice />
        <GstNotice terms={terms} renewal={nextRenewal} canManage={canManage} />
        {/* A comped plan is a gift, not a bill — it sits below what they OWE and
          above the rest of the page. Offer and active state are mutually
          exclusive (docs/comped-plans-spec.md). */}
        {data.compActive ? (
          <CompActiveNotice
            comp={data.compActive}
            paidPlanName={paidPlanName}
          />
        ) : data.compOffer ? (
          <CompOfferCard
            offer={data.compOffer}
            currentPlanName={paidPlanName}
            canManage={canManage}
          />
        ) : null}
        <PlansBillingClient
          initialData={data}
          subscription={subscription}
          packs={packs}
          canManage={canManage}
          pricing={pricing}
          includedCredits={includedCredits}
          terms={terms}
          nextRenewal={nextRenewal}
          billingDetails={billingDetails}
        />
        <BillingDetailsCard details={billingDetails} canManage={canManage} />
      </div>
    </SettingsShell>
  );
}
