// ---------------------------------------------------------------------------
// "What does my plan include, and what would the next one unlock?" — derived
// from PLAN_LIMITS so the dashboard's plan card can never advertise something
// enforcement does not deliver (the same rule that makes the public pricing
// page derive its table from the catalogue). Pure and client-safe.
// ---------------------------------------------------------------------------

import {
  PLAN_IDS,
  PLAN_LIMITS,
  PLAN_META,
  type Plan,
  type PlanLimits,
} from "@/lib/plans";

type BooleanFeature = {
  [K in keyof PlanLimits]: PlanLimits[K] extends boolean ? K : never;
}[keyof PlanLimits];

/** Merchant-facing names for the boolean entitlements, in the order they are
 *  listed. Omits the two Mink credit numbers (shown by Plans itself) and the
 *  legacy coupon cap (folded into offers). */
const FEATURE_LABELS: Record<BooleanFeature, string> = {
  onlinePayments: "Online payments through your own Razorpay",
  shippingIntegration: "Shiprocket rates, labels and tracking",
  customDomain: "Your own domain",
  customerGroups: "Customer groups",
  customCode: "Custom code sections",
  customerBlogSubmissions: "Customer blog submissions",
  analyticsCustomization: "Customisable analytics dashboard",
  detailedAnalytics: "Detailed reports and CSV export",
  emailCampaigns: "Coupon email campaigns",
  advancedAnalytics: "GA4, Meta Pixel and gross margin",
  removeBadge: 'No "Powered by StoreMink" badge',
  posEnabled: "Point of Sale",
  aiCreditTopUps: "Mink credit top-ups",
};

const FEATURE_ORDER = Object.keys(FEATURE_LABELS) as BooleanFeature[];

function countLabel(value: number | null, singular: string, plural: string) {
  if (value === null) return `Unlimited ${plural}`;
  return `${value} ${value === 1 ? singular : plural}`;
}

/** What the plan a store is on gives it, in a handful of lines. */
export function planHighlights(plan: Plan): string[] {
  const l = PLAN_LIMITS[plan];
  const lines = [
    countLabel(l.maxProducts, "product", "products"),
    countLabel(l.maxStaff, "staff account", "staff accounts"),
    countLabel(l.maxActiveOffers, "active offer", "active offers"),
    "Cash on Delivery checkout",
  ];
  for (const key of FEATURE_ORDER) {
    if (l[key]) lines.push(FEATURE_LABELS[key]);
  }
  return lines;
}

/** The plan one rank above, or null on the top tier. */
export function nextPlan(plan: Plan): Plan | null {
  const i = PLAN_IDS.indexOf(plan);
  return i >= 0 && i < PLAN_IDS.length - 1 ? PLAN_IDS[i + 1] : null;
}

/** Everything `to` has that `from` does not — raised caps first, then the
 *  features that switch on. */
export function upgradeUnlocks(from: Plan, to: Plan): string[] {
  const a = PLAN_LIMITS[from];
  const b = PLAN_LIMITS[to];
  const lines: string[] = [];
  const raised = (
    x: number | null,
    y: number | null,
    singular: string,
    plural: string,
  ) => {
    if (x === y) return;
    if (y === null || (x !== null && y > x)) {
      lines.push(countLabel(y, singular, plural));
    }
  };
  raised(a.maxProducts, b.maxProducts, "product", "products");
  raised(a.maxStaff, b.maxStaff, "staff account", "staff accounts");
  raised(a.maxActiveOffers, b.maxActiveOffers, "active offer", "active offers");
  for (const key of FEATURE_ORDER) {
    if (!a[key] && b[key]) lines.push(FEATURE_LABELS[key]);
  }
  return lines;
}

export function planPriceLine(plan: Plan): string {
  const meta = PLAN_META[plan];
  if (meta.monthlyInr === 0) return "₹0/month";
  return `₹${meta.monthlyInr.toLocaleString("en-IN")}/month`;
}
