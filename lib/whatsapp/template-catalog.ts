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

/** A second wording for one event and audience, chosen at send time from the
 *  event's facts. `cod_confirm` replaces the order-placed message for a
 *  website cash-on-delivery order when the store asks customers to confirm. */
export type WhatsAppTemplateVariant = "cod_confirm";

export const COD_CONFIRM_VARIANT: WhatsAppTemplateVariant = "cod_confirm";

export interface WhatsAppTemplateDef {
  eventKey: EventKey;
  audience: WhatsAppAudience;
  /** Meta's template name: `sm_<event>_<audience>[_<variant>]_v<n>`. */
  name: string;
  language: "en";
  category: "UTILITY";
  /** Meta's body text, with `{{1}}`… placeholders. */
  body: string;
  /** Which named event value fills each placeholder, in order. */
  variables: string[];
  /** One example per placeholder, for Meta's review. */
  examples: string[];
  variant?: WhatsAppTemplateVariant;
  /** Quick-reply button labels, in order. Each tap comes back with the
   *  payload the send attached to that button (send.ts). */
  quickReplies?: string[];
}

/** The version every template starts at. Meta treats a name as immutable once
 *  submitted, so changed copy is a NEW template name: bump the `version` of
 *  THAT entry, never this constant, which would rename and resubmit all of
 *  them. An older version Meta approved keeps sending until the new one is
 *  approved (`pickTemplateRow`). */
export const WHATSAPP_TEMPLATE_VERSION = 1;

function def(
  eventKey: EventKey,
  audience: WhatsAppAudience,
  body: string,
  variables: string[],
  examples: string[],
  opts: {
    version?: number;
    variant?: WhatsAppTemplateVariant;
    quickReplies?: string[];
  } = {},
): WhatsAppTemplateDef {
  const version = opts.version ?? WHATSAPP_TEMPLATE_VERSION;
  const variant = opts.variant ? `_${opts.variant}` : "";
  return {
    eventKey,
    audience,
    name: `sm_${eventKey.replace(/\./g, "_")}_${audience}${variant}_v${version}`,
    language: "en",
    category: "UTILITY",
    body,
    variables,
    examples,
    ...(opts.variant ? { variant: opts.variant } : {}),
    ...(opts.quickReplies ? { quickReplies: opts.quickReplies } : {}),
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
  // ★ COD CONFIRMATION (WhatsApp Phase 2). Sent INSTEAD of the message above
  // for a website cash-on-delivery order when the store has
  // `whatsapp.codConfirmation` on, so the customer gets one message, not two.
  // The buttons come back as `cod:confirm:<order>` / `cod:cancel:<order>`
  // (cod-payload.ts). Probed on the dev test account before shipping: Meta
  // accepted this exact body with both buttons as UTILITY.
  def(
    "order.placed",
    "customer",
    "Please confirm your cash on delivery order {{1}} from {{2}}. Amount to pay on delivery: {{3}}. Tap Confirm order and we will prepare it, or Cancel order if you no longer want it.",
    ["subject_label", "store_name", "total"],
    ["ORD10010004", "Acme Juice", "₹1,240.00"],
    {
      variant: COD_CONFIRM_VARIANT,
      quickReplies: ["Confirm order", "Cancel order"],
    },
  ),
  // ★ v3 (2026-10-13). Meta rejected v1 and v2 as INCORRECT_CATEGORY for
  // UTILITY, both times at submission. v1 opened with "Good news from …"
  // (marketing) and asked to "Show the code …"; v2 dropped the opener but
  // still carried the collection code as a "pickup reference", and was
  // refused the same way. Probes on the test account (same body without the
  // code, and with the order number instead) were accepted as UTILITY, so the
  // code itself reads as AUTHENTICATION to Meta however it is worded. The
  // counter accepts the order number as well as the code, and hand-over is
  // verified by an OTP to the order's phone (CODEBASE §23), so the message
  // names the order number; the code stays in the email and on the collect
  // page.
  def(
    "order.ready_for_pickup",
    "customer",
    "Order {{1}} from {{2}} is ready for pickup at {{3}}, {{4}}. Please give your order number at the counter when you collect it.",
    ["subject_label", "store_name", "pickup_location", "pickup_address"],
    [
      "ORD10010004",
      "Acme Juice",
      "Connaught Place",
      "12 Radial Road, New Delhi",
    ],
    { version: 3 },
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

const keyOf = (eventKey: string, audience: string, variant?: string) =>
  `${eventKey}:${audience}:${variant ?? ""}`;

const BY_KEY = new Map(
  WHATSAPP_TEMPLATE_CATALOG.map((t) => [
    keyOf(t.eventKey, t.audience, t.variant),
    t,
  ]),
);

/** The catalogue entry for an event and audience; the plain wording unless a
 *  `variant` is asked for. */
export function catalogTemplateFor(
  eventKey: string,
  audience: string,
  variant?: WhatsAppTemplateVariant,
): WhatsAppTemplateDef | undefined {
  return BY_KEY.get(keyOf(eventKey, audience, variant));
}

/** A template name without its `_v<n>`: every version of one catalogue entry
 *  shares it. */
export function templateFamily(name: string): string {
  return name.replace(/_v\d+$/, "");
}

const BY_FAMILY = new Map(
  WHATSAPP_TEMPLATE_CATALOG.map((t) => [templateFamily(t.name), t]),
);

/** The catalogue entry a stored template row belongs to, whatever its
 *  version; undefined for a template the merchant authored elsewhere. */
export function catalogEntryForName(
  name: string,
): WhatsAppTemplateDef | undefined {
  return BY_FAMILY.get(templateFamily(name));
}

/** The `_v<n>` a template name ends in; 0 when it carries none (a template
 *  a merchant authored in WhatsApp Manager). */
export function templateNameVersion(name: string): number {
  const m = /_v(\d+)$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * Which of a store's rows for ONE event and audience counts: the current
 * catalogue version once Meta approves it; until then an older APPROVED
 * version, which keeps sending because Meta never withdraws an approval when
 * we submit new wording; failing both, the current row (in review, rejected)
 * so the console shows what is being waited on. The newest version breaks
 * ties. Shared by the send path, the counts and the console, so the three
 * cannot disagree about which wording is live.
 */
export function pickTemplateRow<T extends { name: string; status: string }>(
  rows: readonly T[],
  currentName: string | undefined,
): T | undefined {
  const newestFirst = [...rows].sort(
    (a, b) => templateNameVersion(b.name) - templateNameVersion(a.name),
  );
  const current = currentName
    ? rows.find((r) => r.name === currentName)
    : undefined;
  if (current?.status === "APPROVED") return current;
  return (
    newestFirst.find((r) => r.status === "APPROVED") ??
    current ??
    newestFirst[0]
  );
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

/** Meta's `components` array: the body, then any quick-reply buttons. */
export function templateComponentsFor(t: WhatsAppTemplateDef): unknown[] {
  const component: Record<string, unknown> = { type: "BODY", text: t.body };
  if (t.examples.length > 0) {
    component.example = { body_text: [t.examples] };
  }
  const out: unknown[] = [component];
  if (t.quickReplies && t.quickReplies.length > 0) {
    out.push({
      type: "BUTTONS",
      buttons: t.quickReplies.map((text) => ({ type: "QUICK_REPLY", text })),
    });
  }
  return out;
}

/** Meta's template statuses the 0174 CHECK admits. */
export const KNOWN_TEMPLATE_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PAUSED",
  "DISABLED",
  "IN_APPEAL",
  "PENDING_DELETION",
  "DELETED",
  "LIMIT_EXCEEDED",
] as const;

const KNOWN_STATUS_SET: ReadonlySet<string> = new Set(KNOWN_TEMPLATE_STATUSES);

/** A status word as Meta sent it, upper-cased, when it is one the row can
 *  hold; null for anything else (FLAGGED, ARCHIVED, a typo), so a caller can
 *  leave the stored status alone rather than fail on the CHECK. */
export function knownTemplateStatus(status: unknown): string | null {
  const s = String(status ?? "").toUpperCase();
  return KNOWN_STATUS_SET.has(s) ? s : null;
}

/** Meta's limit on a template body. */
export const TEMPLATE_BODY_MAX_CHARS = 1024;

/**
 * The rules Meta applies to a template body at review, as one check shared
 * by the catalogue (its test asserts every entry passes) and a merchant's own
 * template (custom-template.ts refuses before submitting). A refused
 * submission is a template that silently never sends, so the words are
 * checked here, where the reason can be shown, rather than learned from
 * Meta's error.
 *
 * Returns the problem in the merchant's words, or null when the body is fine.
 */
export function templateBodyProblem(
  body: string,
  examples: readonly string[],
): string | null {
  if (!body.trim()) return "Write the message.";
  if (body.length > TEMPLATE_BODY_MAX_CHARS) {
    return `The message can be at most ${TEMPLATE_BODY_MAX_CHARS} characters.`;
  }
  if (/[\t]/.test(body)) return "The message cannot contain a tab.";
  if (/\{\{(?!\d+\}\})|(?<!\{\{\d+)\}\}/.test(body)) {
    return "Placeholders are written {{1}}, {{2}} and so on.";
  }
  const slots = bodyPlaceholders(body);
  for (const [i, n] of slots.entries()) {
    if (n !== i + 1) {
      return "Number the placeholders {{1}}, {{2}}, {{3}} in the order they appear, with none missing or repeated.";
    }
  }
  if (/^\{\{\d+\}\}/.test(body.trim())) {
    return "The message cannot start with a placeholder; add a word before it.";
  }
  if (/\{\{\d+\}\}\.?$/.test(body.trim())) {
    return "The message cannot end with a placeholder; add a word after it.";
  }
  if (/\}\}\s*\{\{/.test(body)) {
    return "Two placeholders cannot sit next to each other; put a word between them.";
  }
  if (examples.length !== slots.length) {
    return "Give every placeholder a sample value.";
  }
  if (examples.some((e) => !e.trim())) {
    return "Give every placeholder a sample value.";
  }
  return null;
}
