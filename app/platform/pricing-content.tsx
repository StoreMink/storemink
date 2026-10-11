import { Check, Minus } from "lucide-react";
import {
  planFeatureMatrix,
  type IncludedMinkCredits,
  PLAN_LIMITS,
  PLAN_META,
  type PlanMatrixValue,
} from "@/lib/plans";

// The plan cards' copy, the comparison matrix and the FAQ, shared by the
// homepage (cards + a short FAQ) and /pricing (everything). One source so the
// two pages can never advertise different plans.
//
// Each feature line is written to fit ONE row of the card at its narrowest
// width, the way shopify.com/pricing keeps its rows to a few words. Anything
// longer belongs in the comparison matrix, which /pricing renders in full.

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
      `Point of Sale, ${PLAN_LIMITS.pro.posLocationsIncluded} locations`,
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

export const FAQS = [
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
