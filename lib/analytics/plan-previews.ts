import { planAllows, type Plan } from "@/lib/plans";
import type { AnalyticsFeatureSettings } from "./features";
import type { PlanGatedSectionId } from "./layout";
import type { AnalyticsRangePreset } from "./range";

// Locked Analytics sections shown as previews to stores below their plan.
//
// Pure module (no server or React imports) so the page can decide what to
// show and the client card can share the cookie name and copy.
//
// ★ Only a feature StoreMink has switched ON platform-wide is ever previewed:
// selling something the merchant could not get even after upgrading would be
// a broken promise.

export const PREVIEW_HIDE_DAYS = 30;

export function previewHiddenCookie(id: PlanGatedSectionId): string {
  return `sm_an_preview_hidden_${id.replace(/-/g, "_")}`;
}

export interface PlanPreviewData {
  id: PlanGatedSectionId;
  title: string;
  plan: "basic" | "pro";
  headline: string;
  pitch: string;
  points: string[];
  canUpgrade: boolean;
}

interface PreviewSpec {
  feature: keyof AnalyticsFeatureSettings;
  plan: "basic" | "pro";
  title: string;
}

const SPECS: Record<PlanGatedSectionId, PreviewSpec> = {
  profit: { feature: "grossMargin", plan: "pro", title: "Profit" },
  "google-search": {
    feature: "googleSearchConsole",
    plan: "basic",
    title: "Google Search",
  },
  "storefront-traffic": {
    feature: "storefrontConversion",
    plan: "pro",
    title: "Storefront traffic",
  },
};

/** Which plan sections this store should see as a preview right now. */
export function lockedPreviewIds(input: {
  plan: Plan;
  platform: AnalyticsFeatureSettings;
  hidden: ReadonlySet<PlanGatedSectionId>;
}): PlanGatedSectionId[] {
  return (Object.keys(SPECS) as PlanGatedSectionId[]).filter((id) => {
    const spec = SPECS[id];
    return (
      input.platform[spec.feature] &&
      !planAllows(input.plan, spec.plan) &&
      !input.hidden.has(id)
    );
  });
}

const RANGE_PHRASE: Record<Exclude<AnalyticsRangePreset, "custom">, string> = {
  today: "today",
  yesterday: "yesterday",
  "7d": "in the last 7 days",
  "30d": "in the last 30 days",
  "90d": "in the last 90 days",
  mtd: "this month",
  ytd: "this year",
  "12m": "in the last 12 months",
};

export function rangePhrase(preset: AnalyticsRangePreset, label: string) {
  return preset === "custom" ? `from ${label}` : RANGE_PHRASE[preset];
}

function count(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

function rupees(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * The copy for one preview. `search` and `sales` are the store's REAL figures
 * where StoreMink already has them (Search Console data is collected for
 * every active store; sales are the store's own orders); without them the
 * headline falls back to a general line rather than a made-up number.
 */
export function planPreviewData(
  id: PlanGatedSectionId,
  input: {
    canUpgrade: boolean;
    phrase: string;
    search?: { impressions: number; clicks: number } | null;
    sales?: number | null;
  },
): PlanPreviewData {
  const spec = SPECS[id];
  const base = {
    id,
    title: spec.title,
    plan: spec.plan,
    canUpgrade: input.canUpgrade,
  };
  if (id === "google-search") {
    const search = input.search;
    return {
      ...base,
      headline:
        search && search.impressions > 0
          ? `Google showed your store ${count(search.impressions)} ${
              search.impressions === 1 ? "time" : "times"
            } ${input.phrase}, and shoppers clicked through ${count(
              search.clicks,
            )} ${search.clicks === 1 ? "time" : "times"}.`
          : "See how shoppers find your store on Google.",
      pitch:
        "Basic shows which searches bring shoppers to your store, the pages they land on, and how your Google ranking moves over time.",
      points: [
        "Clicks, impressions and click-through rate",
        "Your top Google searches and landing pages",
        "Average position, tracked over time",
      ],
    };
  }
  if (id === "profit") {
    const sales = input.sales ?? 0;
    return {
      ...base,
      headline:
        sales > 0
          ? `You sold ${rupees(sales)} ${input.phrase}. See how much of it was profit.`
          : "Know your profit, not just your sales.",
      pitch:
        "Pro adds product costs to Analytics, so every sale shows its gross profit and margin.",
      points: [
        "Gross profit and margin for any date range",
        "Cost of goods from the costs you add to products",
        "Coverage that shows which products still need a cost",
      ],
    };
  }
  return {
    ...base,
    headline: "See where your visitors come from, and how many of them buy.",
    pitch:
      "Pro counts storefront visitors and sessions, shows the source, device and city behind each visit, and follows it from product page to purchase.",
    points: [
      "Sessions and conversion rate over time",
      "Traffic and sales by source, device and location",
      "A funnel from product view to purchase",
    ],
  };
}
