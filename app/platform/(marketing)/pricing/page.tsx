import { ChevronDown, CircleCheck } from "lucide-react";
import { allowanceLabel, includedMinkCredits } from "@/lib/plans";
import { getPlanPricing } from "@/lib/plans/pricing";
import { getPlanAllowances } from "@/lib/plans/allowances";
import { getMinkConfig } from "@/lib/mink/config";
import { SUPPORT_EMAIL } from "@/lib/seo/brand-identity";
import { PricingCards, type PricingCard } from "../../pricing-cards";
import { FAQS, PLANS, PlanComparison } from "../../pricing-content";
import { CtaBand, PageHero, marketingMetadata } from "../blocks";

export const metadata = marketingMetadata({
  path: "/pricing",
  title: "Pricing",
  description:
    "StoreMink plans in rupees: start free, then Basic or Pro with 0% StoreMink transaction fee. Compare every feature on every plan.",
});

const priceInr = (value: number) => `₹${value.toLocaleString("en-IN")}`;

// The full pricing page: the same cards the homepage shows, the complete
// feature matrix and the FAQ. Prices and the included Mink allowance resolve
// live from the canonical catalogue, exactly as the homepage's do, so the two
// pages cannot quote different numbers.
export default async function PricingPage() {
  const [pricing, allowances] = await Promise.all([
    getPlanPricing(),
    getPlanAllowances(),
  ]);
  const included = includedMinkCredits(
    allowances,
    getMinkConfig().chargeCredits,
  );
  const cheapestPaidInr = Math.min(
    ...PLANS.map((plan) => pricing[plan.meta.id].monthlyInr).filter(
      (price) => price > 0,
    ),
  );
  const pricingCards: PricingCard[] = PLANS.map((plan) => ({
    id: plan.meta.id,
    name: plan.meta.name,
    who: plan.who,
    features: [
      ...plan.features,
      `${allowanceLabel(included[plan.meta.id])} Mink credits a month`,
    ],
    cta: plan.cta,
    popular: plan.popular,
    ...pricing[plan.meta.id],
  }));

  return (
    <div className="smm-pricing">
      <PageHero
        label="Simple pricing"
        title={
          <>
            Start free. <em>Grow for less.</em>
          </>
        }
        lead={`Every plan includes a real storefront and 0% StoreMink transaction fees. Paid plans start at ${priceInr(cheapestPaidInr)} per month, with two months free when billed yearly.`}
        primary={null}
      />

      <section className="smh-pricing-area" id="pricing">
        <div className="smh-container">
          <div className="smh-pricing-component">
            <PricingCards
              plans={pricingCards}
              aside={
                <a href="#compare" className="smh-text-link">
                  Compare all features
                </a>
              }
            />
          </div>
          <p className="smh-pricing-foot">
            <CircleCheck size={16} /> Your store data is never deleted by a plan
            downgrade or failed payment.
          </p>
          <div id="compare">
            <PlanComparison included={included} />
          </div>
        </div>
      </section>

      <section className="smm-pricing-faq" id="faq">
        <div className="smh-container smh-faq-grid">
          <div className="smh-faq-copy">
            <p className="smh-section-label">Good to know</p>
            <h2>Questions before you begin?</h2>
            <p>
              Find step-by-step guides in the{" "}
              <a href="https://help.storemink.com">StoreMink Help Centre</a>, or
              email us at{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
            </p>
          </div>
          <div className="smh-faq-list">
            {FAQS.map((faq) => (
              <details key={faq.q}>
                <summary>
                  {faq.q}
                  <ChevronDown size={19} />
                </summary>
                <p>{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <CtaBand secondary={null} />
    </div>
  );
}
