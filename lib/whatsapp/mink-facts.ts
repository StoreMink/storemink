// ---------------------------------------------------------------------------
// The facts sheet customer-facing Mink answers from, and the shape its answer
// must come back in (docs/whatsapp-commerce-plan.md §13). Pure and
// client-safe: no database, no provider, so the eval harness and the tests
// render the same sheet the live path sends.
//
// ★ ONLY WHAT A SHOPPER COULD SEE. Every fact here is something the storefront
// already shows that phone's owner: their own orders (the order-status rule),
// published products with the card's price and stock, the public policies,
// the store's hours, running offers. Nothing about costs, margins, other
// customers or staff ever enters the sheet, so there is nothing for a crafted
// message to extract.
//
// ★ THE ANSWER IS PARSED, NOT TRUSTED. `parseMinkWhatsAppAnswer` holds the
// model to the JSON shape, the reply length and the links the sheet gave it:
// a reply carrying a link that was not in the facts is a hand-over, because
// an invented URL on WhatsApp is a phishing message with the shop's name on
// it.
//
// ★ A READ THAT FAILED IS SAID TO HAVE FAILED. "No orders" and "we could not
// look" are different facts: the first lets the model tell a customer they
// have no order, the second makes it hand over, as order-status-reply.ts
// does on the same failure.
//
// ★ NO LONG DASH REACHES A CUSTOMER (CODEBASE §40). The model is called
// directly, not through callGemini, so its reply is rewritten here with
// `withoutLongDashes` before any rule below judges it.
// ---------------------------------------------------------------------------

import { effectivePricing, formatPrice } from "@/lib/pricing";
import { isSoldOut } from "@/lib/inventory/status";
import { withoutLongDashes } from "@/lib/text/long-dashes";
import {
  WEEK_DAYS,
  WEEK_DAY_LABELS,
  isAllDay,
  type BusinessHours,
} from "./business-hours";

/** The longest reply Mink may send: WhatsApp allows 4,096, a chat reads
 *  about four sentences. */
export const MINK_REPLY_MAX_CHARS = 1000;

/** How many products the sheet names. More is a catalogue, not an answer. */
export const MINK_MAX_PRODUCTS = 5;
/** How much of each policy goes in. */
export const MINK_POLICY_MAX_CHARS = 1200;
/** Recent messages shown for context, both directions. */
export const MINK_RECENT_MESSAGES = 6;
const RECENT_MESSAGE_MAX_CHARS = 300;
const DESCRIPTION_MAX_CHARS = 220;

// ── Products ────────────────────────────────────────────────────────────

export interface MinkProductLike {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  base_price: number;
  selling_price: number;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  returnable: boolean;
  options?: unknown;
  variants: {
    id: string;
    base_price: number;
    selling_price: number;
    special_price: number | null;
    track_inventory: boolean;
    stock: number;
    low_stock_threshold: number | null;
    allow_backorder: boolean;
    option_values: string[];
  }[];
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "you",
  "your",
  "have",
  "has",
  "this",
  "that",
  "with",
  "are",
  "can",
  "could",
  "would",
  "will",
  "any",
  "there",
  "what",
  "which",
  "when",
  "where",
  "how",
  "much",
  "many",
  "price",
  "cost",
  "rate",
  "stock",
  "available",
  "availability",
  "delivery",
  "deliver",
  "order",
  "please",
  "pls",
  "want",
  "need",
  "buy",
  "get",
  "sell",
  "selling",
  "kya",
  "hai",
  "hain",
  "mein",
  "main",
  "mujhe",
  "chahiye",
  "milega",
  "kitna",
  "kitne",
  "kaise",
  "aur",
  "the",
  "size",
  "ml",
  "kg",
  "gm",
  "pack",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Loose singular, applied to both sides, so "shakes" finds "Almond Shake"
 *  and "cookies" finds "Oat Cookies". */
function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * The products a message is about: scored by the words it shares with each
 * product's name (counted most), category and description. Pure.
 */
export function matchProducts<T extends MinkProductLike>(
  text: string,
  products: T[],
  limit = MINK_MAX_PRODUCTS,
): T[] {
  const query = tokens(text).map(stem);
  if (query.length === 0) return [];
  const lower = text.toLowerCase();
  const scored: { p: T; score: number }[] = [];
  for (const p of products) {
    const name = tokens(p.name).map(stem);
    const category = tokens(p.category ?? "").map(stem);
    const description = tokens(p.description ?? "").map(stem);
    let score = 0;
    for (const q of query) {
      if (name.includes(q)) score += 3;
      else if (category.includes(q)) score += 2;
      else if (description.includes(q)) score += 1;
    }
    if (lower.includes(p.name.toLowerCase())) score += 4;
    if (score > 0) scored.push({ p, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map((s) => s.p);
}

function stockWord(sku: {
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
}): string {
  return isSoldOut(sku) ? "sold out" : "in stock";
}

type MinkVariantLike = MinkProductLike["variants"][number];

/** "500 ml / Blue": an option as the sheet names it. Pure. */
export function optionLabel(v: MinkVariantLike): string {
  return v.option_values.filter(Boolean).join(" / ") || "option";
}

/**
 * The option a "can you deliver it to my PIN?" question is checked with, or
 * null for a product without options. Pure.
 *
 * ★ A PRODUCT WITH OPTIONS IS CHECKED THROUGH ONE OF THEM. Its own row's
 * online stock sums only the levels with no option (normally zero), and its
 * stock switch is hidden in the editor once options exist, so checking the
 * product row could call a product with options in stock "out of stock for
 * online delivery", or a sold-out one "available". The first option that is
 * not sold out answers for the product; when every one is, the first does,
 * and the answer is the honest "out of stock".
 */
export function deliveryCheckVariant<V extends MinkVariantLike>(p: {
  variants: V[];
}): V | null {
  if (p.variants.length === 0) return null;
  return p.variants.find((v) => !isSoldOut(v)) ?? p.variants[0];
}

/** One product as a line of facts. Pure. */
export function renderProductFact(
  p: MinkProductLike,
  storeUrl: string | null,
): string {
  const pricing = effectivePricing(p);
  const parts: string[] = [];
  const price =
    pricing.discount > 0
      ? `${formatPrice(pricing.selling)} (was ${formatPrice(pricing.base)})`
      : formatPrice(pricing.selling);
  const fromWord = p.variants.length > 1 ? "from " : "";
  parts.push(`${p.name}: ${fromWord}${price}`);
  if (p.variants.length > 0) {
    const options = p.variants.slice(0, 12).map((v) => {
      const label = optionLabel(v);
      const selling =
        v.special_price != null && v.special_price > 0
          ? v.special_price
          : v.selling_price;
      return `${label} ${formatPrice(selling)} ${stockWord(v)}`;
    });
    parts.push(`options: ${options.join("; ")}`);
  } else {
    parts.push(stockWord(p));
  }
  if (p.category) parts.push(`category ${p.category}`);
  parts.push(p.returnable ? "returnable" : "final sale, not returnable");
  if (p.description) {
    const text = htmlToText(p.description, DESCRIPTION_MAX_CHARS);
    if (text) parts.push(`about: ${text}`);
  }
  if (storeUrl) parts.push(`link ${storeUrl}/shop/${p.slug}`);
  return parts.join(". ");
}

// ── Text helpers ────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&#8377;": "₹",
  "&#x20b9;": "₹",
};

/** Plain words from HTML, collapsed, cut on a word. Pure. */
export function htmlToText(html: string, max: number): string {
  const text = html
    .replace(/<\s*(?:br|\/p|\/li|\/h[1-6]|\/div|\/tr)\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${at > max * 0.6 ? cut.slice(0, at) : cut}…`;
}

/** The week's hours as one line per day. Pure. */
export function renderHours(
  hours: BusinessHours,
  timeZone: string,
  openNow: boolean | null,
): string {
  const days = WEEK_DAYS.map((day) => {
    const h = hours[day];
    const label = WEEK_DAY_LABELS[day].slice(0, 3);
    if (!h) return `${label} closed`;
    if (isAllDay(h)) return `${label} open all day`;
    return `${label} ${h.open} to ${h.close}`;
  });
  const now =
    openNow === null
      ? ""
      : `. Right now the shop is ${openNow ? "open" : "closed"}`;
  return `${days.join("; ")}. Times in ${timeZone}${now}.`;
}

// ── The sheet ───────────────────────────────────────────────────────────

export interface MinkRecentMessage {
  /** "customer", "shop" (a person or an automatic reply). */
  who: "customer" | "shop";
  text: string;
}

export interface MinkFacts {
  store: { name: string; url: string | null; email: string | null };
  /** The hours line, when the merchant set any. */
  hours: string | null;
  /** The customer's own orders, one line each (order-status-reply's words). */
  orders: string[];
  /** The order lookup failed: nothing is known about their orders, which is
   *  not the same as their having none. Absent = the lookup answered. */
  ordersUnavailable?: boolean;
  /** Matched products, one line each. */
  products: string[];
  /** Delivery to the PIN the customer named, when they named one. */
  delivery: string | null;
  /** Running offers a shopper could see, one line each. */
  offers: string[];
  /** The offers read failed: nothing is known, not "none running". */
  offersUnavailable?: boolean;
  policies: { title: string; text: string }[];
  recent: MinkRecentMessage[];
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

/** Every link the sheet contains: the only links a reply may carry. Pure. */
export function allowedUrlsIn(facts: MinkFacts): Set<string> {
  const text = renderMinkFacts(facts);
  return new Set((text.match(URL_PATTERN) ?? []).map(cleanUrl));
}

function cleanUrl(url: string): string {
  return url.replace(/[.,;:!?)]+$/, "");
}

/** The sheet as the model reads it. Pure. */
export function renderMinkFacts(facts: MinkFacts): string {
  const lines: string[] = [];
  lines.push(`Shop: ${facts.store.name}.`);
  if (facts.store.url) lines.push(`Website: ${facts.store.url}`);
  if (facts.store.email) lines.push(`Contact email: ${facts.store.email}`);
  if (facts.hours) lines.push(`Business hours: ${facts.hours}`);
  lines.push("");
  lines.push(
    facts.orders.length > 0
      ? `THIS CUSTOMER'S ORDERS (placed with the number they are writing from):\n${facts.orders.map((o) => `- ${o}`).join("\n")}`
      : facts.ordersUnavailable
        ? "THIS CUSTOMER'S ORDERS: could not be looked up just now, so nothing is known about them."
        : "THIS CUSTOMER'S ORDERS: none found for the number they are writing from.",
  );
  lines.push("");
  lines.push(
    facts.products.length > 0
      ? `PRODUCTS THAT MAY MATCH THE QUESTION:\n${facts.products.map((p) => `- ${p}`).join("\n")}`
      : "PRODUCTS THAT MAY MATCH THE QUESTION: none matched by name.",
  );
  if (facts.delivery) {
    lines.push("");
    lines.push(`DELIVERY: ${facts.delivery}`);
  }
  lines.push("");
  lines.push(
    facts.offers.length > 0
      ? `OFFERS RUNNING NOW:\n${facts.offers.map((o) => `- ${o}`).join("\n")}`
      : facts.offersUnavailable
        ? "OFFERS RUNNING NOW: could not be checked just now, so nothing is known about them."
        : "OFFERS RUNNING NOW: none.",
  );
  if (facts.policies.length > 0) {
    lines.push("");
    lines.push("STORE POLICIES (the shop's own words):");
    for (const p of facts.policies) lines.push(`${p.title}: ${p.text}`);
  }
  return lines.join("\n");
}

/** The recent exchange, oldest first, as the model reads it. Pure. */
export function renderRecentMessages(recent: MinkRecentMessage[]): string {
  if (recent.length === 0) return "(none)";
  return recent
    .slice(-MINK_RECENT_MESSAGES)
    .map(
      (m) =>
        `${m.who === "customer" ? "Customer" : "Shop"}: ${m.text
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, RECENT_MESSAGE_MAX_CHARS)}`,
    )
    .join("\n");
}

/**
 * What the staff card says the draft was based on: short labels, no amounts,
 * no customer details. Pure.
 */
export function factsSummary(facts: MinkFacts): string[] {
  const out: string[] = [];
  for (const o of facts.orders) {
    const ref = o.match(/Order\s+(\S+?)[,:]/)?.[1];
    if (ref) out.push(`Order ${ref}`);
  }
  for (const p of facts.products) {
    const name = p.split(":")[0]?.trim();
    if (name) out.push(name);
  }
  if (facts.delivery) out.push("Delivery check");
  if (facts.offers.length > 0) out.push("Current offers");
  for (const p of facts.policies) out.push(p.title);
  if (facts.hours) out.push("Business hours");
  return out.slice(0, 8);
}

// ── The answer ──────────────────────────────────────────────────────────

/** The closed shape the model must return. */
export const MINK_WHATSAPP_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["answer", "hand_over"] },
    reply: { type: "string" },
    reason: { type: "string" },
  },
  required: ["outcome", "reply", "reason"],
  additionalProperties: false,
} as const;

export interface MinkWhatsAppAnswer {
  outcome: "answer" | "hand_over";
  /** Trimmed; empty is allowed on a hand-over only. */
  reply: string;
  /** A few words; shown to staff on the draft card. */
  reason: string;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Hold the model to the contract. Returns null for anything that is not the
 * shape; turns an answer into a hand-over when the reply breaks a rule it
 * cannot be allowed to break (a link not in the facts, a template token, a
 * reply too long to be a chat message). Pure.
 *
 * ★ The reply and the reason are rewritten without long dashes FIRST, so the
 * length and link rules judge exactly the words a customer (or the staff card)
 * will read.
 */
export function parseMinkWhatsAppAnswer(
  raw: unknown,
  allowedUrls: Set<string>,
): MinkWhatsAppAnswer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const outcome =
    r.outcome === "answer"
      ? "answer"
      : r.outcome === "hand_over"
        ? "hand_over"
        : null;
  if (!outcome) return null;
  if (typeof r.reply !== "string") return null;
  const reason =
    typeof r.reason === "string"
      ? withoutLongDashes(r.reason).replace(/\s+/g, " ").trim().slice(0, 120)
      : "";
  let reply = withoutLongDashes(
    r.reply.replace(/\r\n?/g, "\n").replace(/\*\*|__|^#+\s*/gm, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (CONTROL_CHARS.test(reply)) return null;
  if (outcome === "answer" && !reply) return null;

  const handOver = (why: string): MinkWhatsAppAnswer => ({
    outcome: "hand_over",
    reply: "",
    reason: why,
  });
  if (reply.length > MINK_REPLY_MAX_CHARS) return handOver("reply too long");
  if (reply.includes("{{") || reply.includes("}}")) {
    return handOver("reply carried a template token");
  }
  for (const url of reply.match(URL_PATTERN) ?? []) {
    if (!allowedUrls.has(cleanUrl(url))) {
      return handOver("reply carried a link not in the facts");
    }
  }
  if (outcome === "hand_over" && reply.length > MINK_REPLY_MAX_CHARS) {
    reply = "";
  }
  return { outcome, reply, reason };
}

/** The six-digit Indian PIN a message names, if any. Pure. */
export function pinCodeIn(text: string): string | null {
  const m = text.match(/(?<!\d)(\d{6})(?!\d)/);
  return m ? m[1] : null;
}
