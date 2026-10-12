// Analytics Insights: short notes that point out what changed, so a seller
// doesn't have to dig through every chart (Shopify's Insights panel).
//
// ★ RULE-BASED BY DECISION (owner, 2026-10-12): every insight is computed from
// the same figures the dashboard cards show, with fixed thresholds, so it is
// instant, free and never says something the numbers don't. "Ask Mink why"
// hands the question to Mink, which spends the seller's normal credits.
//
// Pure module: the page gathers the figures, this decides what is worth saying.

import type {
  AnalyticsValueFormat,
  TrendPoint,
} from "@/app/dashboard/components/analytics-format";

export type InsightTone = "good" | "bad" | "neutral";

export interface Insight {
  id: string;
  tone: InsightTone;
  title: string;
  detail: string;
  /** The question Mink is asked when the seller wants to know why. */
  askMink: string;
  series?: TrendPoint[];
  format?: AnalyticsValueFormat;
}

export interface InsightInput {
  rangeLabel: string;
  comparisonLabel: string | null;
  sales: {
    current: number;
    previous: number | null;
    orders: number;
    previousOrders: number | null;
    aov: number;
    previousAov: number | null;
    series: TrendPoint[];
  };
  /** Month to date against the same days last month (null early in a month). */
  monthPace: {
    monthName: string;
    current: number;
    lastMonthSameDays: number;
    projected: number;
    dayOfMonth: number;
  } | null;
  products: Array<{
    name: string;
    units: number;
    previousUnits: number | null;
  }>;
  customers: {
    total: number;
    returningRate: number;
    previousTotal: number | null;
    previousReturningRate: number | null;
  };
  refunds: { current: number; previous: number | null; grossSales: number };
  discounts: {
    current: number;
    previous: number | null;
    grossSales: number;
    previousGrossSales: number | null;
  };
  traffic: {
    conversionRate: number;
    previousConversionRate: number | null;
    sources: Array<{ label: string; sessions: number; converted: number }>;
  } | null;
}

const MIN_ORDERS = 5;
const MAX_INSIGHTS = 5;

function pct(current: number, previous: number): number {
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

function rupees(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 0,
  }).format(value);
}

export function buildInsights(input: InsightInput): Insight[] {
  const out: Insight[] = [];
  const { sales } = input;
  const enoughOrders =
    sales.orders >= MIN_ORDERS &&
    (sales.previousOrders === null || sales.previousOrders >= MIN_ORDERS);
  const versus = input.comparisonLabel
    ? `the previous period (${input.comparisonLabel})`
    : "the previous period";

  // 1. Sales moved meaningfully.
  if (enoughOrders && sales.previous !== null && sales.previous > 0) {
    const change = pct(sales.current, sales.previous);
    if (Math.abs(change) >= 15) {
      const up = change > 0;
      out.push({
        id: "sales_change",
        tone: up ? "good" : "bad",
        title: `Sales are ${up ? "up" : "down"} ${Math.abs(change)}% on the previous period`,
        detail: `You sold ${rupees(sales.current)} in ${input.rangeLabel}, against ${rupees(sales.previous)} in ${versus}.`,
        askMink: `Why did my total sales go ${up ? "up" : "down"} ${Math.abs(change)}% in ${input.rangeLabel} compared with ${input.comparisonLabel ?? "the previous period"}? Look at products, customers, discounts and traffic.`,
        series: sales.series,
        format: "currency",
      });
    }
  }

  // 2. This month's pace against last month.
  const pace = input.monthPace;
  if (pace && pace.dayOfMonth >= 5 && pace.lastMonthSameDays > 0) {
    const change = pct(pace.current, pace.lastMonthSameDays);
    if (Math.abs(change) >= 10) {
      const ahead = change > 0;
      out.push({
        id: "month_pace",
        tone: ahead ? "good" : "bad",
        title: ahead
          ? `${pace.monthName} is on track to beat last month`
          : `${pace.monthName} is behind last month so far`,
        detail: `${rupees(pace.current)} so far, ${Math.abs(change)}% ${ahead ? "ahead of" : "behind"} the same days last month. At this pace ${pace.monthName} ends near ${rupees(pace.projected)}.`,
        askMink: `My sales this month are ${Math.abs(change)}% ${ahead ? "ahead of" : "behind"} the same days last month. What is driving that, and what should I do next?`,
      });
    }
  }

  // 3. Refunds climbing (worth flagging early).
  const refunds = input.refunds;
  if (
    enoughOrders &&
    refunds.previous !== null &&
    refunds.grossSales > 0 &&
    refunds.current / refunds.grossSales >= 0.05 &&
    refunds.current >= refunds.previous * 1.5 &&
    refunds.current - refunds.previous >= 500
  ) {
    out.push({
      id: "refunds_rising",
      tone: "bad",
      title: "Refunds are rising",
      detail: `${rupees(refunds.current)} refunded in ${input.rangeLabel}, ${Math.round((refunds.current / refunds.grossSales) * 100)}% of gross sales, up from ${rupees(refunds.previous)}.`,
      askMink: `My refunds rose to ${rupees(refunds.current)} in ${input.rangeLabel}. Which products and orders are being refunded, and why?`,
    });
  }

  // 4. A product selling much faster than before.
  const riser = input.products
    .filter(
      (product) =>
        product.previousUnits !== null &&
        product.previousUnits >= 3 &&
        product.units >= 5,
    )
    .map((product) => ({
      ...product,
      change: pct(product.units, product.previousUnits as number),
    }))
    .filter((product) => product.change >= 30)
    .sort((a, b) => b.change - a.change)[0];
  if (riser) {
    out.push({
      id: "product_riser",
      tone: "good",
      title: `${riser.name} is selling faster`,
      detail: `${riser.units.toLocaleString("en-IN")} sold in ${input.rangeLabel}, up ${riser.change}% on ${versus}.`,
      askMink: `Why is ${riser.name} selling ${riser.change}% more than before? Should I stock more or promote it?`,
    });
  }

  // 5. Storefront conversion moved (Pro).
  const traffic = input.traffic;
  if (
    traffic &&
    traffic.previousConversionRate !== null &&
    traffic.previousConversionRate > 0
  ) {
    const change = pct(traffic.conversionRate, traffic.previousConversionRate);
    if (Math.abs(change) >= 15) {
      const up = change > 0;
      out.push({
        id: "conversion_change",
        tone: up ? "good" : "bad",
        title: `Conversion rate is ${up ? "up" : "down"} ${Math.abs(change)}%`,
        detail: `${traffic.conversionRate.toFixed(1)}% of storefront sessions ended in a purchase, against ${traffic.previousConversionRate.toFixed(1)}% in ${versus}.`,
        askMink: `My storefront conversion rate went ${up ? "up" : "down"} from ${traffic.previousConversionRate.toFixed(1)}% to ${traffic.conversionRate.toFixed(1)}%. What changed?`,
      });
    }
  }

  // 6. The traffic source that converts best (Pro).
  if (traffic && traffic.conversionRate > 0) {
    const best = traffic.sources
      .filter((source) => source.sessions >= 20)
      .map((source) => ({
        ...source,
        rate: (source.converted / source.sessions) * 100,
      }))
      .sort((a, b) => b.rate - a.rate)[0];
    if (best && best.rate >= traffic.conversionRate * 1.3) {
      out.push({
        id: "best_source",
        tone: "neutral",
        title: `Visitors from ${best.label} convert best`,
        detail: `${best.rate.toFixed(1)}% of sessions from ${best.label} ended in a purchase, against ${traffic.conversionRate.toFixed(1)}% overall.`,
        askMink: `Visitors from ${best.label} convert at ${best.rate.toFixed(1)}%, well above my average. How can I get more of them?`,
      });
    }
  }

  // 7. Basket size moved.
  if (enoughOrders && sales.previousAov !== null && sales.previousAov > 0) {
    const change = pct(sales.aov, sales.previousAov);
    if (Math.abs(change) >= 10) {
      const up = change > 0;
      out.push({
        id: "aov_change",
        tone: up ? "good" : "bad",
        title: `Average order value ${up ? "rose" : "fell"} ${Math.abs(change)}%`,
        detail: `Shoppers spent ${rupees(sales.aov)} per order, against ${rupees(sales.previousAov)} in ${versus}.`,
        askMink: `My average order value ${up ? "rose" : "fell"} from ${rupees(sales.previousAov)} to ${rupees(sales.aov)}. What is behind it?`,
      });
    }
  }

  // 8. Loyalty moved.
  const customers = input.customers;
  if (
    customers.total >= MIN_ORDERS &&
    customers.previousTotal !== null &&
    customers.previousTotal >= MIN_ORDERS &&
    customers.previousReturningRate !== null
  ) {
    const points = customers.returningRate - customers.previousReturningRate;
    if (Math.abs(points) >= 10) {
      const up = points > 0;
      out.push({
        id: "returning_change",
        tone: up ? "good" : "neutral",
        title: up
          ? "More of your customers are coming back"
          : "Fewer customers are coming back",
        detail: `${customers.returningRate.toFixed(0)}% of customers who ordered had ordered before, against ${customers.previousReturningRate.toFixed(0)}% in ${versus}.`,
        askMink: `My returning customer rate moved from ${customers.previousReturningRate.toFixed(0)}% to ${customers.returningRate.toFixed(0)}%. What can I do to keep customers coming back?`,
      });
    }
  }

  // 9. Discounts eating into sales.
  const discounts = input.discounts;
  if (
    enoughOrders &&
    discounts.grossSales > 0 &&
    discounts.previous !== null &&
    discounts.previousGrossSales !== null &&
    discounts.previousGrossSales > 0
  ) {
    const share = (discounts.current / discounts.grossSales) * 100;
    const previousShare =
      (discounts.previous / discounts.previousGrossSales) * 100;
    if (share >= 10 && share - previousShare >= 5) {
      out.push({
        id: "discount_share",
        tone: "neutral",
        title: "Discounts are taking a bigger share of sales",
        detail: `Discounts were ${share.toFixed(0)}% of gross sales in ${input.rangeLabel}, up from ${previousShare.toFixed(0)}%.`,
        askMink: `Discounts rose to ${share.toFixed(0)}% of my gross sales. Which discounts are driving that, and are they paying off?`,
      });
    }
  }

  return out.slice(0, MAX_INSIGHTS);
}
