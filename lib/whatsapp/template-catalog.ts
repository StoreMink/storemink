// ---------------------------------------------------------------------------
// The templates StoreMink registers on a merchant's behalf — one per
// notification event and audience (docs/whatsapp-commerce-plan.md §8).
//
// ── ★ WHY A CATALOGUE AND NOT A MERCHANT EDITOR ────────────────────────────
// Meta approves a template's exact wording, with its variables marked, and
// drops anything else. The SMS channel (§37) makes the merchant mirror an
// approval they obtained elsewhere; here StoreMink holds the approval, so the
// wording is ours to write once and submit for every store that connects. A
// merchant who wants different copy can later author a template in WhatsApp
// Manager and point an event at it — that is Phase 2's template manager, not
// this file.
//
// ── ★ POSITIONAL, LIKE A DLT BODY ──────────────────────────────────────────
// `{{1}}`, `{{2}}` … map onto named event values in the order `variables`
// lists them, exactly as renderDltBody maps `{#var#}`. The named values come
// from `templateValues`, so a message prints "₹1,240.00" and "28 July 2026",
// never a raw number and an ISO string (§24).
//
// ── ★ EVERY RULE META APPLIES AT REVIEW IS PINNED BY A TEST ────────────────
// Names are lowercase with underscores; placeholders are numbered in the order
// they appear and never adjacent; no body starts or ends with one; every
// placeholder has an example value (Meta refuses review without one). A
// template refused at submission is a store whose updates silently never
// send, which is what the catalogue test exists to prevent.
//
// Pure and client-safe: the notification console renders a template's wording
// from this file, so it must not import anything server-only.
// ---------------------------------------------------------------------------

import type { EventKey } from "@/lib/notifications/events";

export type WhatsAppAudience = "team" | "customer";

export interface WhatsAppTemplateDef {
  eventKey: EventKey;
  audience: WhatsAppAudience;
  /** Meta's template name: `sm_<event>_<audience>_v<n>`. */
  name: string;
  language: "en";
  category: "UTILITY";
  /** Meta's body text, with `{{1}}`… placeholders. */
  body: string;
  /** Which named event value fills each placeholder, in order. */
  variables: string[];
  /** One example per placeholder, for Meta's review. */
  examples: string[];
}

/** Bump when a body changes: Meta treats a name as immutable once approved, so
 *  changed copy is a NEW template name, and the old one stays approved for
 *  stores that have not re-synced. */
export const WHATSAPP_TEMPLATE_VERSION = 1;

function def(
  eventKey: EventKey,
  audience: WhatsAppAudience,
  body: string,
  variables: string[],
  examples: string[],
): WhatsAppTemplateDef {
  return {
    eventKey,
    audience,
    name: `sm_${eventKey.replace(/\./g, "_")}_${audience}_v${WHATSAPP_TEMPLATE_VERSION}`,
    language: "en",
    category: "UTILITY",
    body,
    variables,
    examples,
  };
}

export const WHATSAPP_TEMPLATE_CATALOG: readonly WhatsAppTemplateDef[] = [
  // ── Customer ──────────────────────────────────────────────────────────────
  def(
    "order.placed",
    "customer",
    "Thanks for your order with {{1}}. Order {{2}} has been received. Total: {{3}}, payment: {{4}}. We will keep you updated as it moves forward.",
    ["store_name", "subject_label", "total", "payment_method"],
    ["Acme Juice", "ORD10010004", "₹1,240.00", "Cash on delivery"],
  ),
  def(
    "order.ready_for_pickup",
    "customer",
    "Good news from {{1}}: order {{2}} is ready to collect at {{3}}, {{4}}. Show the code {{5}} at the counter.",
    [
      "store_name",
      "subject_label",
      "pickup_location",
      "pickup_address",
      "collection_code",
    ],
    [
      "Acme Juice",
      "ORD10010004",
      "Connaught Place",
      "12 Radial Road, New Delhi",
      "PK0M-3T9V",
    ],
  ),
  def(
    "order.collected",
    "customer",
    "Order {{1}} was collected from {{2}} at {{3}}. Thank you for shopping with us.",
    ["subject_label", "store_name", "pickup_location"],
    ["ORD10010004", "Acme Juice", "Connaught Place"],
  ),
  def(
    "order.pickup_expiring",
    "customer",
    "A reminder from {{1}}: order {{2}} is waiting for you at {{3}} until {{4}}. Please collect it before then.",
    ["store_name", "subject_label", "pickup_location", "expires_on"],
    [
      "Acme Juice",
      "ORD10010004",
      "Connaught Place",
      "2 August 2026 at 5:50 pm",
    ],
  ),
  def(
    "order.pickup_expired",
    "customer",
    "Order {{1}} was not collected from {{2}} by its deadline, so {{3}} has cancelled it. If you paid in advance, a refund is on its way back to you.",
    ["subject_label", "pickup_location", "store_name"],
    ["ORD10010004", "Connaught Place", "Acme Juice"],
  ),
  def(
    "order.status_changed",
    "customer",
    "An update from {{1}}: order {{2}} is now {{3}}. Open your account on our website to see the full timeline.",
    ["store_name", "subject_label", "status"],
    ["Acme Juice", "ORD10010004", "Shipped"],
  ),
  def(
    "order.cancelled",
    "customer",
    "Order {{1}} with {{2}} has been cancelled. If you paid in advance, a refund is on its way back to you. Reply here if you have a question.",
    ["subject_label", "store_name"],
    ["ORD10010004", "Acme Juice"],
  ),
  def(
    "order.cancellation_declined",
    "customer",
    "A message from {{1}} about order {{2}}: we could not cancel it. Reason: {{3}}. The order remains active and will continue as planned.",
    ["store_name", "subject_label", "reason"],
    ["Acme Juice", "ORD10010004", "The parcel has already left the warehouse"],
  ),
  def(
    "order.refund_issued",
    "customer",
    "Refund update from {{1}}: {{2}} for order {{3}} is on its way back to you. Please allow a few days for it to show.",
    ["store_name", "amount", "subject_label"],
    ["Acme Juice", "₹1,240.00", "ORD10010004"],
  ),
  def(
    "order.return_approved",
    "customer",
    "Your return for order {{1}} has been approved by {{2}}. Once the items reach us you will receive {{3}}, with {{4}} deducted in fees. Thank you for your patience.",
    ["subject_label", "store_name", "refund_amount", "fees"],
    ["ORD10010004", "Acme Juice", "₹840.00", "₹0.00"],
  ),
  def(
    "order.return_rejected",
    "customer",
    "Your return request for order {{1}} was reviewed by {{2}} and could not be approved. Reason: {{3}}. Reply here if you would like to talk it through.",
    ["subject_label", "store_name", "note"],
    ["ORD10010004", "Acme Juice", "This item is past its 7-day return window"],
  ),
  def(
    "order.exchange_ready",
    "customer",
    "Your exchange for order {{1}} is on its way from {{2}} as replacement order {{3}}. Thank you for your patience.",
    ["subject_label", "store_name", "exchange_ref"],
    ["ORD10010004", "Acme Juice", "ORD10011031"],
  ),

  // ── Team ──────────────────────────────────────────────────────────────────
  def(
    "order.placed",
    "team",
    "New order at {{1}}: {{2}} for {{3}}, placed by {{4}}. Items: {{5}}. Open it in your dashboard to prepare it.",
    ["store_name", "subject_label", "total", "actor_name", "items"],
    [
      "Acme Juice",
      "ORD10010004",
      "₹1,240.00",
      "Priya S.",
      "3 items: Amul Taaza Milk, Tata Salt x 2",
    ],
  ),
  def(
    "order.cancellation_requested",
    "team",
    "A customer asked to cancel order {{1}} at {{2}}. Reason: {{3}}. Review it in your dashboard.",
    ["subject_label", "store_name", "reason"],
    ["ORD10010004", "Acme Juice", "Ordered by mistake"],
  ),
  def(
    "order.return_requested",
    "team",
    "A return was requested on order {{1}} at {{2}}: {{3}}. Reason: {{4}}. Review it in your dashboard.",
    ["subject_label", "store_name", "items", "reason"],
    [
      "ORD10010004",
      "Acme Juice",
      "2 items: Amul Taaza Toned Milk (1 L)",
      "Arrived damaged",
    ],
  ),
  def(
    "order.payment_failed",
    "team",
    "Payment failed on order {{1}} at {{2}}. Reason: {{3}}. The order stays unpaid until the customer retries.",
    ["subject_label", "store_name", "reason"],
    ["ORD10010004", "Acme Juice", "Card declined"],
  ),
  def(
    "inventory.low_stock",
    "team",
    "Low stock at {{1}}: {{2}} has {{3}} left. Restock soon to keep it on sale.",
    ["store_name", "subject_label", "stock"],
    ["Acme Juice", "Amul Taaza Toned Milk (1 L)", "4"],
  ),
  def(
    "inventory.out_of_stock",
    "team",
    "Out of stock at {{1}}: {{2}} has sold out. It shows as sold out on your website until you restock it.",
    ["store_name", "subject_label"],
    ["Acme Juice", "Amul Taaza Toned Milk (1 L)"],
  ),
  def(
    "enquiry.received",
    "team",
    "New enquiry at {{1}} from {{2}}: {{3}}. Reply from your dashboard.",
    ["store_name", "actor_name", "subject"],
    ["Acme Juice", "Priya S.", "Bulk order question"],
  ),
];

const BY_KEY = new Map(
  WHATSAPP_TEMPLATE_CATALOG.map((t) => [`${t.eventKey}:${t.audience}`, t]),
);

export function catalogTemplateFor(
  eventKey: string,
  audience: string,
): WhatsAppTemplateDef | undefined {
  return BY_KEY.get(`${eventKey}:${audience}`);
}

/** The `{{n}}` placeholders in a body, in order of appearance. */
export function bodyPlaceholders(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) out.push(Number(m[1]));
  return out;
}

/**
 * A value as Meta accepts it in a text parameter: no newline, no tab, never
 * more than four spaces in a row, never empty. An empty parameter is REFUSED
 * by the API ("parameter text cannot be empty"), which would fail the whole
 * message over an optional fact the event did not carry — so an absent value
 * prints as a dash, the way an empty cell does in a table.
 */
export function whatsAppParameterText(value: unknown): string {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {5,}/g, "    ")
    .trim();
  return text || "-";
}

/** The message as the customer will read it — for the log, not the send. */
export function renderWhatsAppBody(body: string, values: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) =>
    whatsAppParameterText(values[Number(n) - 1]),
  );
}

/** Meta's `components` array for a text-only body template. */
export function templateComponentsFor(t: WhatsAppTemplateDef): unknown[] {
  const component: Record<string, unknown> = { type: "BODY", text: t.body };
  if (t.examples.length > 0) {
    component.example = { body_text: [t.examples] };
  }
  return [component];
}
