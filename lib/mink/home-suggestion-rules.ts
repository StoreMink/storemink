// "Mink suggests": the ranked next-best-actions card on the dashboard Home page
// (a Shopify Sidekick Pulse shape).
//
// ★ RULE-BASED, NO MODEL CALL, NO CREDITS (owner's decision, 2026-10-17, the
// same shape as lib/analytics/insights.ts): every suggestion is computed from
// counts the dashboard already shows, with fixed thresholds, so the card is
// instant, free and never claims something the numbers do not. "Ask Mink"
// hands a pre-written question to the chat, which spends the store's normal
// credits only when the merchant presses it.
//
// Pure module: NO imports, so the client component, the server loader and a
// unit test can all use it, and every threshold edge is testable in node.
//
// ★ SEVERITY ORDER IS FIXED AND MONEY COMES FIRST. A suggestion earns its
// place by what it costs the merchant to ignore, not by how recent it is:
//
//   1. sales_down        net sales down >= SALES_DROP_PERCENT on the last 7
//                        complete local days against the 7 before, with a
//                        baseline of at least SALES_MIN_BASELINE_ORDERS orders
//                        (the baseline, not the current week: a week that
//                        collapsed to zero orders is exactly the case to flag)
//   2. stale_orders      pending or processing orders older than
//                        STALE_ORDER_HOURS
//   3. out_of_stock      tracked items at zero stock
//   4. low_stock         tracked items at or below their threshold
//   5. inbox_needs_reply WhatsApp conversations waiting on the store
//   6. enquiries_new     storefront enquiries nobody has opened
//   7. product_gaps      published products with no photo or no description
//   8. sample_products   theme "(Sample)" products still in the catalogue
//   9. offers_attention  offers ending within OFFER_ENDING_SOON_DAYS, or still
//                        switched on after ending / hitting their limit or budget
//  10. credits_low       Mink credits left under CREDITS_LOW_FRACTION of the
//                        plan's monthly allowance
//
// At most MAX_MINK_HOME_SUGGESTIONS survive, taken from the top of that order.

export interface MinkHomeSuggestion {
  id: string;
  title: string;
  detail: string;
  href: string;
  /** The question Mink is asked when the merchant presses "Ask Mink". */
  askMink: string;
}

/** Every signal is null when the viewer may not see it or its read failed. */
export interface MinkHomeSignals {
  /** ISO 4217 code used for money in the wording ("INR"). */
  currency: string;
  sales: {
    current: number;
    previous: number;
    currentOrders: number;
    previousOrders: number;
  } | null;
  staleOrders: { pending: number; processing: number } | null;
  stock: { out: number; low: number } | null;
  inbox: { needsReply: number } | null;
  enquiries: { unread: number } | null;
  catalogue: {
    /** Distinct published products missing a photo OR a description. */
    gaps: number;
    missingDescription: number;
    missingImage: number;
    samples: number;
  } | null;
  offers: { endingSoon: number; finished: number } | null;
  credits: { remaining: number; cap: number } | null;
}

export const MAX_MINK_HOME_SUGGESTIONS = 5;
export const SALES_DROP_PERCENT = 15;
export const SALES_MIN_BASELINE_ORDERS = 5;
export const STALE_ORDER_HOURS = 48;
export const OFFER_ENDING_SOON_DAYS = 3;
export const CREDITS_LOW_FRACTION = 0.1;

/** The fixed severity order, most urgent first (see the header comment). */
export const MINK_HOME_SUGGESTION_ORDER = [
  "sales_down",
  "stale_orders",
  "out_of_stock",
  "low_stock",
  "inbox_needs_reply",
  "enquiries_new",
  "product_gaps",
  "sample_products",
  "offers_attention",
  "credits_low",
] as const;

export type MinkHomeSuggestionId = (typeof MINK_HOME_SUGGESTION_ORDER)[number];

// Bounded lengths: the card never has to cope with a runaway string, and the
// Mink composer gets a question, not an essay.
export const SUGGESTION_TITLE_MAX = 80;
export const SUGGESTION_DETAIL_MAX = 200;
export const SUGGESTION_HREF_MAX = 200;
export const SUGGESTION_ASK_MAX = 320;

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    // An unknown currency code throws a RangeError; the number still reads.
    return `${currency} ${Math.round(value).toLocaleString("en-IN")}`;
  }
}

/** "1 order" / "3 orders", with an explicit plural when it is not just an s. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function suggestion(input: {
  id: MinkHomeSuggestionId;
  title: string;
  detail: string;
  href: string;
  askMink: string;
}): MinkHomeSuggestion {
  return {
    id: input.id,
    title: clip(input.title, SUGGESTION_TITLE_MAX),
    detail: clip(input.detail, SUGGESTION_DETAIL_MAX),
    href: clip(input.href, SUGGESTION_HREF_MAX),
    askMink: clip(input.askMink, SUGGESTION_ASK_MAX),
  };
}

/**
 * Turn the signals into at most five suggestions, in the fixed severity
 * order. Deterministic: the same signals always give the same list.
 */
export function rankMinkHomeSuggestions(
  signals: MinkHomeSignals,
): MinkHomeSuggestion[] {
  const out: MinkHomeSuggestion[] = [];
  const currency = signals.currency || "INR";

  // 1. Money at risk: sales fell against the previous seven days.
  const sales = signals.sales;
  if (
    sales &&
    sales.previous > 0 &&
    sales.previousOrders >= SALES_MIN_BASELINE_ORDERS
  ) {
    const drop = Math.round(
      ((sales.previous - sales.current) / sales.previous) * 100,
    );
    if (drop >= SALES_DROP_PERCENT) {
      out.push(
        suggestion({
          id: "sales_down",
          title: `Sales are down ${drop}% on the week before`,
          detail: `${money(sales.current, currency)} from ${count(sales.currentOrders, "order")} in the last 7 days, against ${money(sales.previous, currency)} from ${count(sales.previousOrders, "order")} in the 7 days before.`,
          href: "/dashboard/analytics?range=7d&compare=previous",
          askMink: `My sales are down ${drop}% over the last 7 days compared with the 7 days before (${money(sales.current, currency)} against ${money(sales.previous, currency)}). What changed, and what should I do first? Look at products, customers, discounts and traffic.`,
        }),
      );
    }
  }

  // 2. Orders that have gone quiet.
  const stale = signals.staleOrders;
  const staleTotal = (stale?.pending ?? 0) + (stale?.processing ?? 0);
  if (stale && staleTotal > 0) {
    const parts = [
      stale.pending > 0 ? `${stale.pending} still pending` : "",
      stale.processing > 0 ? `${stale.processing} still processing` : "",
    ].filter(Boolean);
    out.push(
      suggestion({
        id: "stale_orders",
        title: `${count(staleTotal, "order has", "orders have")} waited over ${STALE_ORDER_HOURS} hours`,
        detail: `${parts.join(" and ")}, placed more than ${STALE_ORDER_HOURS} hours ago and not shipped yet. Ship them or tell the customer what is happening.`,
        href:
          stale.pending > 0
            ? "/dashboard/orders?status=pending"
            : "/dashboard/orders?status=processing",
        askMink: `Which of my orders have been pending or processing for more than ${STALE_ORDER_HOURS} hours, and what is holding each one up?`,
      }),
    );
  }

  // 3 and 4. Stock.
  const stock = signals.stock;
  if (stock && stock.out > 0) {
    out.push(
      suggestion({
        id: "out_of_stock",
        title: `${count(stock.out, "item is", "items are")} out of stock`,
        detail:
          "Nobody can buy an item at zero stock. Restock it, allow backorders or unpublish it until stock returns.",
        href: "/dashboard/inventory?filter=out",
        askMink:
          "Which items are out of stock right now, and which of them sold best in the last 30 days so I know what to restock first?",
      }),
    );
  }
  if (stock && stock.low > 0) {
    out.push(
      suggestion({
        id: "low_stock",
        title: `${count(stock.low, "item is", "items are")} running low`,
        detail:
          "At or below the low-stock threshold. Reorder now so they do not sell out mid-week.",
        href: "/dashboard/inventory?filter=low",
        askMink:
          "Which items are low on stock, and roughly how many days of stock does each have left at its current rate of sales?",
      }),
    );
  }

  // 5. Customers waiting on WhatsApp.
  const inbox = signals.inbox;
  if (inbox && inbox.needsReply > 0) {
    out.push(
      suggestion({
        id: "inbox_needs_reply",
        title: `${count(inbox.needsReply, "WhatsApp chat needs", "WhatsApp chats need")} a reply`,
        detail:
          "Customers have messaged your store and not heard back yet. A quick answer now is worth more than a perfect one later.",
        href: "/dashboard/inbox",
        askMink:
          "Which WhatsApp conversations are still waiting for a reply, and what is each customer asking for?",
      }),
    );
  }

  // 6. Enquiries nobody has opened.
  const enquiries = signals.enquiries;
  if (enquiries && enquiries.unread > 0) {
    out.push(
      suggestion({
        id: "enquiries_new",
        title: `${count(enquiries.unread, "new enquiry is", "new enquiries are")} waiting`,
        detail:
          "Sent through your storefront's contact form and not opened yet. Reply while the question is still fresh.",
        href: "/dashboard/enquiries?status=new",
        askMink:
          "What are my new enquiries about, and which ones should I answer first?",
      }),
    );
  }

  // 7 and 8. Catalogue quality.
  const catalogue = signals.catalogue;
  if (catalogue && catalogue.gaps > 0) {
    const parts = [
      catalogue.missingImage > 0
        ? `${catalogue.missingImage} without a photo`
        : "",
      catalogue.missingDescription > 0
        ? `${catalogue.missingDescription} without a description`
        : "",
    ].filter(Boolean);
    out.push(
      suggestion({
        id: "product_gaps",
        title: `${count(catalogue.gaps, "published product is", "published products are")} missing a photo or description`,
        detail: `${parts.join(" and ")}. Listings with both sell better and rank better in search.`,
        href: "/dashboard/products?filter=published",
        askMink:
          "Which of my published products have no photo or no description? Draft a short description for each one that is missing one.",
      }),
    );
  }
  if (catalogue && catalogue.samples > 0) {
    out.push(
      suggestion({
        id: "sample_products",
        title: `${count(catalogue.samples, "sample product is", "sample products are")} still in your catalogue`,
        detail:
          "Theme samples are placeholders. Delete them or replace them with products of your own.",
        href: "/dashboard/products?q=Sample",
        askMink:
          "Which products in my catalogue are theme sample products, and how do I remove them safely?",
      }),
    );
  }

  // 9. Offers that need a decision.
  const offers = signals.offers;
  const offersTotal = (offers?.endingSoon ?? 0) + (offers?.finished ?? 0);
  if (offers && offersTotal > 0) {
    const title =
      offers.finished === 0
        ? `${count(offers.endingSoon, "offer ends", "offers end")} within ${OFFER_ENDING_SOON_DAYS} days`
        : offers.endingSoon === 0
          ? `${count(offers.finished, "offer has", "offers have")} run out but ${offers.finished === 1 ? "is" : "are"} still on`
          : `${count(offersTotal, "offer needs", "offers need")} a decision`;
    const parts = [
      offers.endingSoon > 0
        ? `${offers.endingSoon} ending within ${OFFER_ENDING_SOON_DAYS} days`
        : "",
      offers.finished > 0
        ? `${offers.finished} past the end date, redemption limit or budget but still switched on`
        : "",
    ].filter(Boolean);
    out.push(
      suggestion({
        id: "offers_attention",
        title,
        detail: `${parts.join(" and ")}. Extend, replace or switch them off.`,
        href: "/dashboard/offers",
        askMink:
          "Which of my offers are ending soon or have run out, and did each one actually bring in sales?",
      }),
    );
  }

  // 10. Mink itself is about to stop answering.
  const credits = signals.credits;
  if (credits && credits.cap > 0) {
    const fraction = credits.remaining / credits.cap;
    if (fraction < CREDITS_LOW_FRACTION) {
      const percent = Math.max(0, Math.floor(fraction * 100));
      out.push(
        suggestion({
          id: "credits_low",
          title: "Mink credits are nearly used up",
          detail: `${credits.remaining} of ${credits.cap} credits left this cycle (${percent}%). Top up to keep drafts and answers running until the monthly reset.`,
          href: "/dashboard/plans",
          askMink:
            "How many Mink credits do I have left, when do they reset, and what are my options to add more?",
        }),
      );
    }
  }

  return out.slice(0, MAX_MINK_HOME_SUGGESTIONS);
}

const LINK_LABELS: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ["/dashboard/analytics", "Open analytics"],
  ["/dashboard/orders", "Open orders"],
  ["/dashboard/inventory", "Open inventory"],
  ["/dashboard/inbox", "Open inbox"],
  ["/dashboard/enquiries", "Open enquiries"],
  ["/dashboard/products", "Open products"],
  ["/dashboard/offers", "Open offers"],
  ["/dashboard/plans", "Open plan"],
];

/** The short verb on a suggestion's link: "Open inventory", "Open orders". */
export function minkHomeSuggestionLinkLabel(href: string): string {
  const path = href.split(/[?#]/)[0] ?? "";
  for (const [prefix, label] of LINK_LABELS) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return label;
  }
  return "Open";
}
