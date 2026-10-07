import "server-only";

import { getStoreBrandById, type StoreBrand } from "@/lib/store/brand";
import { sendEmail } from "./send";
import { fromAddress } from "./sender";
import {
  composeEmail,
  emailDetails,
  emailNote,
  emailParagraph,
  escapeHtml,
} from "./shell";
import { renderOrderSummary, type EmailOrderSummary } from "./line-items";
import { formatMoney } from "@/lib/notifications/format";
import { logError } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// Emailing a till receipt to a walk-in (roadmap Step 4 / Shopify's "receipt
// options").
//
// ── ★★ WHY THIS DOES NOT GO THROUGH THE NOTIFICATION SPINE ─────────────────
// The spine (§24) exists to route an EVENT to IDENTIFIED recipients across
// channels, honouring preferences and digests. A walk-in has no identity: there
// is no `users` row, so there is no inbox to put an in-app row in, no
// preferences to consult and no digest for it to join. Forcing it through would
// mean inventing a recipient id for someone who can never read the notification
// it creates.
//
// So this is a direct send, but still through `sendEmail`, the ONE choke point
// every message leaves by, so it lands in `email_logs` like everything else and
// the CI guard in send-coverage.test.ts stays satisfied.
//
// ── ★ ONE RECEIPT, NEVER TWO ───────────────────────────────────────────────
// An ATTACHED customer with an email already gets an order confirmation from
// the `order.placed` fan-out, because it resolves their address from their
// `users` row. This must only fire where that will not: see
// `shouldSendDirectReceipt`. Two emails for one purchase is the pattern §24
// says teaches people to ignore a channel.
//
// ⚠ NOT STORED ON THE ORDER. `email_logs` is the record of what was sent and to
// whom (§24), and the subject carries the order reference. A future "resend
// receipt" button would want `orders.receipt_email`; nothing needs it yet, and a
// column for a feature that does not exist is a column nobody maintains.
// ---------------------------------------------------------------------------

export interface PosReceiptInput {
  storeId: string;
  /** Where to send it. Already validated by the caller. */
  to: string;
  orderRef: string;
  /** The shop it was rung at, for the line that says where they bought it. */
  locationName?: string | null;
  /** Same summary the thermal receipt prints, so paper and inbox agree. */
  summary: EmailOrderSummary;
  /** What they paid with, in the till's own words ("Cash", "Card", "UPI"). */
  tenderLabels?: string[];
  changeDue?: number | null;
}

/**
 * Should the till send a receipt directly, or will the order's own
 * notification already reach this person?
 *
 * PURE, and separate from the send so the rule can be tested without a mailer.
 * `customerEmail` is the address on the ATTACHED customer's record: the one
 * the fan-out would use.
 */
export function shouldSendDirectReceipt(input: {
  receiptEmail: string | null | undefined;
  customerId: string | null | undefined;
  customerEmail: string | null | undefined;
}): boolean {
  if (!input.receiptEmail) return false;
  // No customer attached: the fan-out has no audience, so nothing else sends.
  if (!input.customerId) return true;
  // Attached but with no address on file: the fan-out resolves nothing, so
  // this is still the only receipt they will get.
  return !input.customerEmail;
}

/**
 * The receipt email itself. PURE: no DB, no network, so the email gallery and
 * the no-long-dash guard render exactly what a customer receives.
 *
 * It is the STORE's mail, so it wears the store's logo or name, never
 * StoreMink's. The headline names the shop they stood in when the till knows
 * it, and the store otherwise.
 */
export function buildPosReceiptEmail(opts: {
  brand: StoreBrand;
  orderRef: string;
  locationName?: string | null;
  summary: EmailOrderSummary;
  tenderLabels?: string[];
  changeDue?: number | null;
}): { subject: string; html: string } {
  const { brand, orderRef, summary } = opts;
  const currency = summary.currency || "INR";
  const location = opts.locationName?.trim();
  const store = brand.name.trim() || "us";

  const paid = (opts.tenderLabels ?? [])
    .map((label) => label?.trim())
    .filter(Boolean);
  const change = Number(opts.changeDue);
  const total = Number(summary.total);
  const totalText =
    summary.total !== null &&
    summary.total !== undefined &&
    Number.isFinite(total)
      ? formatMoney(total, currency)
      : "";

  const html = composeEmail({
    brand,
    eyebrow: "Receipt",
    heading: location
      ? `Thanks for shopping at ${location}`
      : `Thanks for shopping with ${store}`,
    blocks: [
      // Under a location headline the lead names the store, because a branch
      // name alone ("Connaught Place") does not say who sold it.
      emailParagraph(
        location
          ? `Here's your receipt from ${escapeHtml(store)}.`
          : "Here's your receipt for this purchase.",
        { lead: true },
      ),
      renderOrderSummary(summary),
      emailDetails([
        { label: "Receipt", valueHtml: escapeHtml(orderRef) },
        { label: "Paid with", valueHtml: escapeHtml(paid.join(" + ")) },
        {
          label: "Change given",
          valueHtml:
            Number.isFinite(change) && change > 0
              ? escapeHtml(formatMoney(change, currency))
              : "",
        },
      ]),
      emailNote(
        "This is a copy of your in-store receipt. Keep it for your records.",
      ),
    ],
    // Without one, clients grab whatever markup comes first, which here would
    // be the store logo's alt text.
    preheader: `Your receipt from ${store} for ${orderRef}${
      totalText ? `, total ${totalText}` : ""
    }`,
  });

  return { subject: `Your receipt for ${orderRef}`, html };
}

/**
 * NEVER THROWS. A receipt that fails to send must not fail a sale that has
 * already taken money and moved stock: the customer is standing at the counter
 * with the printed copy either way.
 */
export async function sendPosReceipt(input: PosReceiptInput): Promise<void> {
  try {
    const brand = await getStoreBrandById(input.storeId);
    const { subject, html } = buildPosReceiptEmail({
      brand,
      orderRef: input.orderRef,
      locationName: input.locationName,
      summary: input.summary,
      tenderLabels: input.tenderLabels,
      changeDue: input.changeDue,
    });

    await sendEmail({
      storeId: input.storeId,
      to: input.to,
      // The store's own verified sending domain, never a hardcoded one: a
      // merchant on a custom domain would otherwise send from an address Resend
      // has no permission for, and every receipt would bounce.
      from: fromAddress(brand, { suffix: "Receipts" }),
      subject,
      html,
      mailer: "pos_receipt",
    });
  } catch (err) {
    logError("pos receipt send failed", err, {
      storeId: input.storeId,
      orderRef: input.orderRef,
    });
  }
}
