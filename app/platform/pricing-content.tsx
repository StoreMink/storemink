import { Check, Minus } from "lucide-react";
import {
  allowanceLabel,
  planFeatureMatrix,
  type IncludedMinkCredits,
  type Plan,
  PLAN_LIMITS,
  PLAN_META,
  type PlanMatrixValue,
} from "@/lib/plans";
import {
  gstFaq,
  pricingCardNote,
  pricingPriceSuffix,
} from "@/lib/billing/tax-copy";
import type { TaxTerms } from "@/lib/billing/tax-terms";
import type { PricingCard } from "./pricing-cards";

// The plan cards' copy, the comparison matrix and the FAQ, shared by the
// homepage (cards + a short FAQ) and /pricing (everything). One source so the
// two pages can never advertise different plans.
//
// Each feature line is written to fit ONE row of the card at its narrowest
// width, the way shopify.com/pricing keeps its rows to a few words. Anything
// longer belongs in the comparison matrix, which /pricing renders in full.
//
// ★ GST (GST design 7.1). The cards' notes and the FAQ follow the GST terms the
// page rendered with (`termsAt` on the cached public source), and every GST
// sentence comes from lib/billing/tax-copy.ts. `terms` is null when
// StoreMink's GST settings could not be read: the prices are then shown with no
// GST words at all, neither "plus GST" nor anything that says GST is off.

export const PLANS = [
  {
    meta: PLAN_META.free,
    who: "For your first store",
    features: [
      "Storefront on your own subdomain",
      "Visual website builder",
      `Up to ${PLAN_LIMITS.free.maxProducts} products`,
      "Blogs, reviews and enquiries",
      "GST invoices and tax classes",
      "Cash on delivery checkout",
    ],
    cta: "Start free",
    popular: false,
  },
  {
    meta: PLAN_META.basic,
    who: "For new brands",
    features: [
      "Everything in Free",
      "Online payments, 0% to StoreMink",
      `${PLAN_LIMITS.basic.maxProducts} products`,
      `${PLAN_LIMITS.basic.maxStaff} staff accounts`,
      "Customer groups",
      "Shiprocket and custom code",
    ],
    cta: `Choose ${PLAN_META.basic.name}`,
    popular: true,
  },
  {
    meta: PLAN_META.pro,
    who: "For growing brands",
    features: [
      `Everything in ${PLAN_META.basic.name}`,
      `Point of Sale (POS), ${PLAN_LIMITS.pro.posLocationsIncluded} locations`,
      "Buy online, collect in store",
      "Email campaigns",
      "Your own domain",
      "Advanced analytics",
      "Unlimited products and staff",
    ],
    cta: `Choose ${PLAN_META.pro.name}`,
    popular: false,
  },
];

/** A plan's resolved prices, in rupees (lib/plans/pricing.ts `PlanPrice`). */
type CardPrices = Pick<
  PricingCard,
  "monthlyInr" | "yearlyInr" | "baseMonthlyInr" | "baseYearlyInr"
>;

/**
 * The price cards of the homepage and /pricing: PLANS with the resolved
 * prices, the included Mink allowance and the GST words for `terms`.
 *
 * The notes come from `pricingCardNote` for both billing periods ("₹1,500
 * billed every month, plus GST from 1 Dec 2026"), and "plus GST" follows "/mo"
 * on a paid card while GST is added on top. With `terms` null, `notes` and
 * `priceSuffix` are null and each card states its amount alone.
 */
export function pricingCards(
  prices: Record<Plan, CardPrices>,
  included: IncludedMinkCredits,
  terms: TaxTerms | null,
): PricingCard[] {
  return PLANS.map((plan) => {
    const price = prices[plan.meta.id];
    const free = price.monthlyInr === 0 && price.yearlyInr === 0;
    return {
      id: plan.meta.id,
      name: plan.meta.name,
      who: plan.who,
      features: [
        ...plan.features,
        `${allowanceLabel(included[plan.meta.id])} Mink credits a month`,
      ],
      cta: plan.cta,
      popular: plan.popular,
      monthlyInr: price.monthlyInr,
      yearlyInr: price.yearlyInr,
      baseMonthlyInr: price.baseMonthlyInr,
      baseYearlyInr: price.baseYearlyInr,
      notes: terms
        ? {
            monthly: pricingCardNote(
              terms,
              "monthly",
              Math.round(price.monthlyInr * 100),
            ),
            yearly: pricingCardNote(
              terms,
              "yearly",
              Math.round(price.yearlyInr * 100),
            ),
          }
        : null,
      priceSuffix: terms && !free ? pricingPriceSuffix(terms) : null,
    };
  });
}

function MatrixValue({ value }: { value: PlanMatrixValue }) {
  if (value === true) {
    return (
      <span className="smh-matrix-yes" aria-label="Included">
        <Check size={17} aria-hidden="true" />
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="smh-matrix-no" aria-label="Not included">
        <Minus size={15} aria-hidden="true" />
      </span>
    );
  }
  return <span>{value}</span>;
}

export function PlanComparison({
  included,
}: {
  included: IncludedMinkCredits;
}) {
  return (
    <div className="smh-matrix-wrap">
      <h3>Compare every feature</h3>
      <div className="smh-matrix-scroll">
        <table className="smh-matrix">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">Free</th>
              <th scope="col">Basic</th>
              <th scope="col">Pro</th>
            </tr>
          </thead>
          <tbody>
            {planFeatureMatrix(included).flatMap((section) => [
              <tr className="smh-matrix-section" key={section.title}>
                <th colSpan={4} scope="colgroup">
                  {section.title}
                </th>
              </tr>,
              ...section.rows.map((row) => (
                <tr key={`${section.title}-${row.label}`}>
                  <th scope="row">{row.label}</th>
                  <td>
                    <MatrixValue value={row.free} />
                  </td>
                  <td>
                    <MatrixValue value={row.basic} />
                  </td>
                  <td>
                    <MatrixValue value={row.pro} />
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <p className="smh-matrix-note">
        If a payment fails or you downgrade, StoreMink keeps your existing
        products, settings, content and history. Lower-plan limits only pause
        gated features and new over-limit additions; upgrading restores access.
      </p>
    </div>
  );
}

export interface PricingFaq {
  q: string;
  a: string;
}

const FAQS: PricingFaq[] = [
  {
    q: "Can I start without paying?",
    a: "Yes. The Free plan lets you build and publish a working StoreMink storefront without a credit card. When you need your own domain, online payments, more products or Point of Sale, you can upgrade without rebuilding anything.",
  },
  {
    q: "Does StoreMink charge a transaction fee?",
    a: "No. Connect your own supported payment gateway and customer payments settle directly to you. StoreMink charges the plan price, not a percentage of your sales.",
  },
  {
    q: "Can my website and physical shop share inventory?",
    a: "Yes. StoreMink Point of Sale uses the same catalogue, customer records and location-aware inventory as your online store. Sales, returns, pickup orders and stock transfers stay connected.",
  },
  {
    q: "Do I need a developer to design my store?",
    a: "No. Choose a theme, add your brand, and arrange ready-made sections in the visual website builder. You can preview changes before publishing them.",
  },
  {
    q: "Can I sell both D2C and B2B?",
    a: "Yes. A single StoreMink store can handle regular online purchases alongside enquiry-based and wholesale selling, so your catalogue and customer data do not split into separate systems.",
  },
  {
    q: "Is StoreMink built for Indian businesses?",
    a: "Yes. Plans are priced in rupees, GST tax classes and invoices are built in, and StoreMink supports the payment and fulfilment workflows Indian brands use every day.",
  },
  {
    q: "What can Mink AI do?",
    a: "Mink AI is StoreMink's built-in assistant, currently in beta. It can answer permission-aware questions from your store data and prepare private, editable content drafts. Guarded dashboard actions will expand as their approval controls are ready.",
  },
];

/** The question the GST entry follows (GST design 7.1). */
const GST_FAQ_FOLLOWS = "Does StoreMink charge a transaction fee?";

/**
 * The FAQ for the homepage and /pricing.
 *
 * "Do your prices include GST?" follows the transaction-fee question only
 * while GST is charged or a switch to prices that exclude GST is scheduled
 * (`gstFaq`). With GST off, or `terms` null (the GST settings could not be
 * read), there is no GST entry: nothing is claimed either way.
 */
export function pricingFaqs(terms: TaxTerms | null): PricingFaq[] {
  const gst = terms ? gstFaq(terms) : null;
  if (!gst) return [...FAQS];
  const after = FAQS.findIndex((faq) => faq.q === GST_FAQ_FOLLOWS) + 1;
  return [
    ...FAQS.slice(0, after),
    { q: gst.question, a: gst.answer },
    ...FAQS.slice(after),
  ];
}
