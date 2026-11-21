import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";
import {
  composeEmail,
  emailButton,
  emailDetails,
  emailNote,
  emailParagraph,
  emailSection,
  emailSignoff,
  escapeHtml,
  type EmailDetail,
} from "./shell";
import { platformEmailBrand } from "./platform-brand";
import { PLATFORM_EMAIL_DOMAIN } from "./sender";
import { sendEmail } from "./send";
import { withService } from "@/lib/db/client";
import { admins, storeBillingSettings, stores } from "@/drizzle/schema";
import { formatIndianMobile } from "@/lib/phone";
import { placeOfSupplyLabel, stateCodeFromGstin } from "@/lib/billing/gst";
import type { InvoiceAddress } from "@/lib/billing/invoice-types";
import {
  BILLING_PAGE,
  SUPPORT_EMAIL,
  amountFor,
  formatRupees,
  invoiceGstinLine,
  invoiceStateLine,
  istShortDate,
  istTime,
  llpLine,
  planActivatedGstParagraph,
  planActivatedPrice,
  receiptAmountRows,
  receiptClosingLine,
  renewalAmountRows,
  renewalChangeSentence,
  upcomingAddedGst,
  type CopyAmount,
  type EmailRow,
} from "@/lib/billing/tax-copy";
import { termsLater, type TaxTerms } from "@/lib/billing/tax-terms";

// Transactional BILLING emails. These come from the platform (StoreMink), not
// the merchant's store brand: a plan receipt, renewal or dunning notice is
// from "StoreMink Billing" and wears StoreMink's own logo (platformEmailBrand).
// Every one is composed through the standard layout in shell.ts, and sending
// is best-effort: a mail failure never throws into the billing flow.
//
// Every merchant sentence about GST, every amount and every date comes from
// lib/billing/tax-copy.ts (GST Stage 6): amounts in paise ("₹433.33" keeps its
// paise), dates in India time with no leading zero ("6 Oct 2026"). Those
// strings are plain text, so they are escaped here before they reach HTML.

const BILLING_FROM = `StoreMink Billing <billing@${PLATFORM_EMAIL_DOMAIN}>`;

/** The billing page, by its one name (HTML: the ampersand is escaped). */
const PLANS_PAGE_HTML = escapeHtml(BILLING_PAGE);

/** When an owed refund reaches the merchant. Refunds may be sent by hand
 *  until automatic sending is switched on, so the sentence promises the
 *  usual time rather than the moment the plan ends. */
const REFUND_TIMING = "after your plan ends, usually within 5 working days";

/**
 * An amount held in paise: whole rupees without decimals ("₹2,400"),
 * anything else to the paisa ("₹1,234.50"). tax-copy's `formatRupees`, the
 * one implementation.
 */
const moneyPaise = formatRupees;

/**
 * A date as a merchant in India reads it: "30 Oct 2026", or with the time
 * "1 Nov 2026, 14:00 IST" (a plan cancelled during grace ends at a moment, not
 * at the end of a day). Pinned to India time, never the server's UTC; built
 * from tax-copy's `istShortDate` and `istTime`.
 */
export function istDate(iso: string, opts: { time?: boolean } = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = istShortDate(date);
  if (!opts.time) return day;
  return `${day}, ${istTime(date)} IST`;
}

/**
 * The GST in an amount a billing email quotes, from the invoice it is about:
 * the tax in paise, the rate in per cent (18 for 18%) and whether the GST is
 * inside the total (prices include GST). Null when no GST was charged.
 */
export interface EmailTax {
  taxPaise: number;
  ratePct: number;
  inclusive: boolean;
}

/** An invoice's tax columns, as `billing_invoices` stores them. */
export interface InvoiceTaxColumns {
  taxPaise: number | null | undefined;
  taxRateBps: number | null | undefined;
  taxInclusive: boolean | null | undefined;
}

/**
 * An invoice's tax columns as an email's `tax`: null when the invoice
 * charged no GST, so every template prints today's untaxed email.
 */
export function emailTaxFromInvoice(
  invoice: InvoiceTaxColumns,
): EmailTax | null {
  const taxPaise = Number(invoice.taxPaise ?? 0);
  if (!Number.isFinite(taxPaise) || taxPaise <= 0) return null;
  const rateBps = Number(invoice.taxRateBps ?? 0);
  return {
    taxPaise: Math.round(taxPaise),
    ratePct: Number.isFinite(rateBps) ? rateBps / 100 : 0,
    inclusive: invoice.taxInclusive === true,
  };
}

/** An amount and its GST as tax-copy's `CopyAmount`. */
function copyAmount(amountPaise: number, tax: EmailTax | null): CopyAmount {
  const totalPaise = Math.round(amountPaise);
  if (!tax || !(tax.taxPaise > 0)) {
    return { totalPaise, taxPaise: 0, rateBps: 0, inclusive: false };
  }
  return {
    totalPaise,
    taxPaise: Math.round(tax.taxPaise),
    rateBps: Math.round(tax.ratePct * 100),
    inclusive: tax.inclusive,
  };
}

/** tax-copy's plain-text rows as escaped detail rows. */
function detailRows(rows: EmailRow[]): EmailDetail[] {
  return rows.map((row) => ({
    label: row.label,
    valueHtml: escapeHtml(row.value),
  }));
}

/**
 * One frame for every billing email: StoreMink's own header, the headline, the
 * blocks, a sign-off, and a footer explaining why it arrived. Keeping it in one
 * place is what stops eight templates drifting into eight looks.
 */
function billingEmail(opts: {
  storeName: string;
  heading: string;
  blocks: string[];
  preheader: string;
  eyebrow?: string;
  tone?: "default" | "danger";
}): string {
  return composeEmail({
    brand: platformEmailBrand(),
    heading: opts.heading,
    eyebrow: opts.eyebrow,
    tone: opts.tone,
    preheader: opts.preheader,
    blocks: [...opts.blocks, emailSignoff("StoreMink")],
    footerReasonHtml: `This is an automated message about ${escapeHtml(opts.storeName)}'s StoreMink subscription. Questions? Write to <a href="mailto:support@storemink.com">support@storemink.com</a> and our team will help.`,
  });
}

/** The facts every billing email leads with, so a reader can scan them. */
function storeAndPlan(storeName: string, planName: string): EmailDetail[] {
  return [
    { label: "Store", valueHtml: escapeHtml(storeName) },
    { label: "Plan", valueHtml: escapeHtml(planName) },
  ];
}

// ── Pure template builders (subject + html), unit-tested ───────────────────

export interface BuiltEmail {
  subject: string;
  html: string;
}

/**
 * A merchant has just subscribed.
 *
 * ★ The renewal date doubles as the autopay signal. The caller withholds it
 * when there is no mandate (lib/billing/receipts.ts), and this copy only says
 * the plan "renews automatically" when it has a date to name. Without one it
 * promises an email before the renewal instead, which dunning sends either
 * way, so a merchant with no mandate is never told there is nothing to do.
 *
 * ★ `taxTerms` (today's GST terms) adds design 7.7's SCHED-EX paragraph while
 * a switch to prices that exclude GST is scheduled, so a merchant who signs
 * up after the notice went out still hears of it. Null or absent: no
 * paragraph.
 */
export function planActivatedTemplate(d: {
  storeName: string;
  planName: string;
  /** What the first payment was, in paise (the invoice's total). */
  amountPaise: number;
  /** The GST in it (the invoice's tax columns), or null when none. */
  tax: EmailTax | null;
  period: "monthly" | "yearly";
  renewsOn: string | null;
  manageUrl: string;
  taxTerms?: TaxTerms | null;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  const amount = copyAmount(d.amountPaise, d.tax);
  return {
    subject: `You're on the ${d.planName} plan`,
    html: billingEmail({
      storeName: d.storeName,
      heading: `Welcome to ${d.planName}`,
      preheader: `${d.storeName} is now on the ${d.planName} plan.`,
      blocks: [
        emailParagraph(
          `<strong>${store}</strong> is now on the <strong>${plan}</strong> plan. Thanks for choosing StoreMink.`,
          { lead: true },
        ),
        emailDetails([
          ...storeAndPlan(d.storeName, d.planName),
          {
            label: "Price",
            valueHtml: escapeHtml(planActivatedPrice(amount, d.period)),
          },
          {
            label: "Renews on",
            valueHtml: d.renewsOn ? escapeHtml(istShortDate(d.renewsOn)) : "",
          },
        ]),
        emailParagraph(
          d.renewsOn
            ? `Autopay is set up, so your plan renews automatically. You can change or cancel your plan anytime.`
            : `We'll email you before your next renewal. You can change or cancel your plan anytime.`,
        ),
        gstAheadParagraph(amount, d.period, d.taxTerms ?? null),
        emailButton(d.manageUrl, "Manage your plan"),
      ],
    }),
  };
}

/**
 * Design 7.7's plan-activated paragraph while GST added on top of prices is
 * scheduled: "From 1 Dec 2026, GST at 18% is added to our prices, so
 * renewals invoiced from then cost ₹1,770 a month including GST." The
 * renewal is the plan's price before any GST, priced under the terms that
 * apply from the start. Empty otherwise.
 */
function gstAheadParagraph(
  amount: CopyAmount,
  period: "monthly" | "yearly",
  terms: TaxTerms | null,
): string {
  if (!terms) return "";
  const ahead = upcomingAddedGst(terms);
  if (!ahead) return "";
  const startsAt = new Date(ahead.startsAt);
  if (Number.isNaN(startsAt.getTime())) return "";
  const listPaise =
    amount.taxPaise > 0 && !amount.inclusive
      ? amount.totalPaise - amount.taxPaise
      : amount.totalPaise;
  const renewal = amountFor(listPaise, termsLater(terms, startsAt));
  const sentence = planActivatedGstParagraph(terms, renewal, period);
  return sentence ? emailParagraph(escapeHtml(sentence)) : "";
}

/**
 * A payment was received.
 *
 * ★ `cancelling` is set when the payment was for the NEXT cycle of a plan the
 * merchant has cancelled (an autopay debit or a checkout opened before they
 * cancelled). The receipt stays true, the money did arrive, but that cycle will
 * not happen, so the receipt says the payment comes back, and names no renewal
 * date (the caller withholds it).
 *
 * ★ With GST charged (`tax`), the rows add "Includes GST (18%)" and the
 * closing line points at the tax invoice (design 7.7).
 */
export function paymentReceiptTemplate(d: {
  storeName: string;
  planName: string;
  /** What was paid, in paise (the invoice's total). */
  amountPaise: number;
  /** The GST in it (the invoice's tax columns), or null when none. */
  tax: EmailTax | null;
  period: "monthly" | "yearly";
  renewsOn: string | null;
  manageUrl: string;
  /** When the cancelled plan ends; the time is shown when it ends in grace. */
  cancelling?: { endsAt: string; inGrace: boolean } | null;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  const amount = copyAmount(d.amountPaise, d.tax);
  const paid = escapeHtml(moneyPaise(amount.totalPaise));
  const cancelling = d.cancelling
    ? escapeHtml(istDate(d.cancelling.endsAt, { time: d.cancelling.inGrace }))
    : null;
  const taxInvoiceLine = receiptClosingLine(amount.taxPaise);
  return {
    subject: `Payment received for your ${d.planName} plan`,
    html: billingEmail({
      storeName: d.storeName,
      eyebrow: "Receipt",
      heading: "Payment received",
      preheader: `${moneyPaise(amount.totalPaise)} received for ${d.storeName}'s ${d.planName} plan.`,
      blocks: [
        emailParagraph(
          `Thank you. We've received <strong>${paid}</strong> for <strong>${store}</strong>'s ${plan} plan.`,
          { lead: true },
        ),
        emailDetails([
          { label: "Store", valueHtml: store },
          {
            label: "Plan",
            valueHtml: `${plan}, billed ${d.period === "yearly" ? "yearly" : "monthly"}`,
          },
          ...detailRows(receiptAmountRows(amount)),
          {
            label: "Renews on",
            valueHtml: d.renewsOn ? escapeHtml(istShortDate(d.renewsOn)) : "",
          },
        ]),
        cancelling
          ? emailParagraph(
              `You've cancelled your plan, so we refund this payment after your plan ends on <strong>${cancelling}</strong>, usually within 5 working days, unless you choose Keep my plan before then.`,
            )
          : "",
        emailParagraph(
          cancelling
            ? `Your invoices are in ${PLANS_PAGE_HTML} whenever you need them.`
            : taxInvoiceLine
              ? escapeHtml(taxInvoiceLine)
              : `Your plan is active. Your invoices are in ${PLANS_PAGE_HTML} whenever you need them.`,
        ),
        emailButton(d.manageUrl, "View billing"),
      ],
    }),
  };
}

/**
 * A charge failed. `final` is the difference between "we'll try again" and
 * "the plan is about to end"; the two must never be confused, so they are two
 * complete variants rather than one message with a clause swapped.
 */
export function paymentFailedTemplate(d: {
  storeName: string;
  planName: string;
  final: boolean;
  accessUntil: string | null;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  if (d.final) {
    return {
      subject: `Action needed: your ${d.planName} plan is about to end`,
      html: billingEmail({
        storeName: d.storeName,
        eyebrow: "Action needed",
        tone: "danger",
        heading: "Your plan is about to end",
        preheader: `We couldn't collect payment for ${d.storeName}'s ${d.planName} plan.`,
        blocks: [
          emailParagraph(
            `We couldn't collect payment for <strong>${store}</strong>'s ${plan} plan after several attempts.`,
            { lead: true },
          ),
          emailDetails([
            ...storeAndPlan(d.storeName, d.planName),
            {
              label: "Access until",
              valueHtml: d.accessUntil
                ? escapeHtml(istShortDate(d.accessUntil))
                : "",
            },
          ]),
          emailParagraph(
            d.accessUntil
              ? `Please update your payment method to keep your plan. Access continues until <strong>${escapeHtml(istShortDate(d.accessUntil))}</strong>, after which the store moves to the Free plan.`
              : `Please update your payment method to keep your plan. Otherwise the store moves to the Free plan.`,
          ),
          emailButton(d.manageUrl, "Update payment method"),
        ],
      }),
    };
  }
  return {
    subject: `We couldn't process your ${d.planName} payment`,
    html: billingEmail({
      storeName: d.storeName,
      heading: "Payment didn't go through",
      preheader: `A charge for ${d.storeName}'s ${d.planName} plan failed. We'll retry automatically.`,
      blocks: [
        emailParagraph(
          `A charge for <strong>${store}</strong>'s ${plan} plan failed. We'll retry automatically over the next few days.`,
          { lead: true },
        ),
        emailDetails(storeAndPlan(d.storeName, d.planName)),
        emailParagraph(
          `To avoid any interruption, please make sure your payment method is up to date.`,
        ),
        emailButton(d.manageUrl, "Check billing"),
      ],
    }),
  };
}

/**
 * The next cycle's invoice at the moment a plan was cancelled: what the
 * cancellation email has to say about money already on its way.
 */
export interface CancelledNextInvoice {
  status: string;
  totalPaise: number;
  invoiceRef: string | null;
  /** A payment attempt on it is created, processing, authorized or unknown. */
  inFlight: boolean;
}

/** What the next invoice means for the merchant who has just cancelled. */
function nextInvoiceCase(
  next: CancelledNextInvoice | null,
): "none" | "open" | "in_flight" | "paid" {
  if (!next) return "none";
  if (next.status === "paid") return "paid";
  if (next.inFlight || next.status === "processing") return "in_flight";
  if (next.status === "open") return "open";
  // A draft was never issued to them, and a closed invoice is owed by nobody.
  return "none";
}

/**
 * A plan has been cancelled: what they keep, until when, and what happens to
 * a renewal payment already made or under way.
 *
 * ★ EVERY SENTENCE HERE MUST STAY TRUE. Cancelling never keeps money for a
 * cycle the plan does not reach: an unpaid renewal invoice is closed when the
 * plan ends, and a renewal payment that arrives is refunded. A merchant who
 * cancels during grace keeps the plan only until grace ends, so that date
 * carries its time.
 *
 * ★ A SUSPENDED STORE'S DASHBOARD IS CLOSED, so its email links nowhere and
 * names the support address instead of Keep my plan.
 */
export function subscriptionCancelledTemplate(d: {
  storeName: string;
  planName: string;
  /** When the plan stops: the paid period's end, or the grace deadline.
   *  Null when no cycle was ever paid for. */
  endsAt: string | null;
  /** Cancelled during grace: the plan ends when grace ends. */
  inGrace: boolean;
  nextInvoice: CancelledNextInvoice | null;
  requestedBy: "merchant" | "operator";
  storeSuspended: boolean;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  const when = d.endsAt
    ? escapeHtml(istDate(d.endsAt, { time: d.inGrace }))
    : null;
  const next = d.nextInvoice;
  const nextCase = nextInvoiceCase(next);
  const amount = next ? moneyPaise(next.totalPaise) : "";
  const ref = next?.invoiceRef ? ` ${escapeHtml(next.invoiceRef)}` : "";

  let body: string;
  if (!when) {
    body = "No further payments will be taken.";
  } else if (d.inGrace) {
    const ends = `${plan} ends on <strong>${when}</strong> and the store moves to the Free plan.`;
    if (nextCase === "in_flight") {
      body = `${ends} A renewal payment of ${amount} was already under way when you cancelled. If it goes through, we refund it.`;
    } else if (nextCase === "paid") {
      body = `${ends} We refund your renewal payment of ${amount} ${REFUND_TIMING}.`;
    } else {
      body = `Your renewal hasn't been paid, so ${plan} ends on <strong>${when}</strong> and the store moves to the Free plan.${nextCase === "open" ? " Your unpaid invoice won't be charged." : ""}`;
    }
  } else {
    const keep = `You keep ${plan} until <strong>${when}</strong>, then the store moves to the Free plan.`;
    if (nextCase === "open") {
      body = `${keep} Your renewal invoice${ref} won't be charged.`;
    } else if (nextCase === "in_flight") {
      body = `${keep} A renewal payment of ${amount} was already under way when you cancelled. If it goes through, we refund it ${REFUND_TIMING}.`;
    } else if (nextCase === "paid") {
      body = `${keep} We refund your renewal payment of ${amount} ${REFUND_TIMING}.`;
    } else {
      body = keep;
    }
  }

  const before = when ? ` before ${when}` : "";
  return {
    subject: `Your ${d.planName} subscription is cancelled`,
    html: billingEmail({
      storeName: d.storeName,
      heading: "Your subscription is cancelled",
      preheader: `${d.storeName}'s ${d.planName} plan won't renew.`,
      blocks: [
        emailParagraph(
          d.requestedBy === "operator"
            ? `As you asked, we've cancelled <strong>${store}</strong>'s ${plan} plan. It won't renew, and autopay is turned off.`
            : `<strong>${store}</strong>'s ${plan} plan is cancelled and won't renew. Autopay is turned off.`,
          { lead: true },
        ),
        emailDetails([
          ...storeAndPlan(d.storeName, d.planName),
          { label: "Plan ends", valueHtml: when ?? "" },
        ]),
        emailParagraph(body),
        emailParagraph(
          d.storeSuspended
            ? `Changed your mind? Write to ${SUPPORT_EMAIL}${before}.`
            : `Changed your mind? Open ${PLANS_PAGE_HTML} and choose Keep my plan${before}.`,
        ),
        d.storeSuspended ? "" : emailButton(d.manageUrl, "Manage your plan"),
      ],
    }),
  };
}

/**
 * A renewal invoice has been issued for the next cycle.
 *
 * ★★ `autopay` CHANGES WHAT THIS MESSAGE IS, not just its wording. With a
 * mandate it is a courtesy heads-up before a debit the merchant need do nothing
 * about; without one it is a BILL, and doing nothing loses them their plan. Send
 * the wrong variant and a merchant reasonably ignores it and is downgraded,
 * which is why the flag is required rather than defaulted.
 *
 * ★ The amount rows are design 7.7's: with GST added, "Price", "GST (18%)"
 * and the amount; with GST included, the amount and "Includes GST (18%)";
 * without GST, the amount alone.
 */
export function renewalDueTemplate(d: {
  storeName: string;
  planName: string;
  /** The issued invoice's total, in paise. */
  amountPaise: number;
  /** The GST in it (the invoice's tax columns), or null when none. */
  tax: EmailTax | null;
  dueOn: string;
  invoiceRef: string | null;
  autopay: boolean;
  /** Last cycle's total, in paise, when there was one. */
  previousAmountPaise?: number | null;
  /** Last cycle's GST (its invoice's tax columns), or null when none. */
  previousTax?: EmailTax | null;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  const amount = copyAmount(d.amountPaise, d.tax);
  const total = moneyPaise(amount.totalPaise);
  const totalHtml = escapeHtml(total);
  const due = istShortDate(d.dueOn);
  const dueHtml = escapeHtml(due);
  const invoiceRow: EmailDetail = {
    label: "Invoice",
    valueHtml: d.invoiceRef ? escapeHtml(d.invoiceRef) : "",
  };
  const changed = changeParagraph(
    d.previousAmountPaise != null
      ? copyAmount(d.previousAmountPaise, d.previousTax ?? null)
      : null,
    amount,
  );

  if (d.autopay) {
    return {
      subject: `Your ${d.planName} plan renews on ${due}`,
      html: billingEmail({
        storeName: d.storeName,
        heading: "Your plan renews soon",
        preheader: `We'll charge ${total} on ${due}. There's nothing you need to do.`,
        blocks: [
          emailParagraph(
            `<strong>${store}</strong>'s ${plan} plan renews on <strong>${dueHtml}</strong>. We'll charge <strong>${totalHtml}</strong> to your saved payment method, so there's nothing you need to do.`,
            { lead: true },
          ),
          emailDetails([
            ...storeAndPlan(d.storeName, d.planName),
            ...detailRows(renewalAmountRows(amount, true)),
            { label: "Renews on", valueHtml: dueHtml },
            invoiceRow,
          ]),
          changed,
          // ★ True only because cancelling never keeps money for a cycle the
          // plan does not reach: a payment taken for the next cycle comes back.
          emailParagraph(
            `Not renewing? If you cancel before ${dueHtml}, your plan ends that day and we refund any payment we've taken for the next cycle.`,
          ),
          emailButton(d.manageUrl, "Manage your plan"),
        ],
      }),
    };
  }
  return {
    subject: `${total} due for your ${d.planName} plan`,
    html: billingEmail({
      storeName: d.storeName,
      eyebrow: "Invoice",
      heading: "Time to renew",
      preheader: `${total} is payable by ${due} to keep ${d.storeName}'s ${d.planName} plan.`,
      blocks: [
        emailParagraph(
          `<strong>${store}</strong>'s ${plan} plan is due for renewal. <strong>${totalHtml}</strong> is payable by <strong>${dueHtml}</strong>.`,
          { lead: true },
        ),
        emailDetails([
          ...storeAndPlan(d.storeName, d.planName),
          ...detailRows(renewalAmountRows(amount, false)),
          { label: "Due by", valueHtml: dueHtml },
          invoiceRow,
        ]),
        changed,
        emailParagraph(
          `Pay from your dashboard in a couple of taps. If it's not paid by the renewal date you'll get 48 hours' grace, then the store moves to the Free plan. Not renewing? Cancel in ${PLANS_PAGE_HTML} and this invoice won't be charged.`,
        ),
        emailButton(d.manageUrl, "Pay now"),
      ],
    }),
  };
}

/**
 * Automatic collection has stopped trying (three tries, 24 hours apart, owner
 * decision 21 Nov 2026): the merchant is asked to pay the renewal by hand.
 *
 * `payBy` is the day the new cycle begins, given only while it is still
 * ahead. After it the overdue notice carries the 48-hour deadline, so this
 * one names no date it cannot keep.
 */
export function autopayStoppedTemplate(d: {
  storeName: string;
  planName: string;
  /** The issued invoice's total, in paise. */
  amountPaise: number;
  /** The GST in it (the invoice's tax columns), or null when none. */
  tax: EmailTax | null;
  payBy: string | null;
  invoiceRef: string | null;
  /** How many automatic tries were made. */
  attempts: number;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  const amount = copyAmount(d.amountPaise, d.tax);
  const total = moneyPaise(amount.totalPaise);
  const totalHtml = escapeHtml(total);
  const payByHtml = d.payBy ? escapeHtml(istShortDate(d.payBy)) : null;
  const tries = d.attempts === 1 ? "once" : `${d.attempts} times`;
  return {
    subject: `Action needed: pay ${total} for your ${d.planName} plan`,
    html: billingEmail({
      storeName: d.storeName,
      eyebrow: "Action needed",
      tone: "danger",
      heading: "Automatic payment didn't go through",
      preheader: `We couldn't collect ${total} for ${d.storeName}'s ${d.planName} plan. Please pay it from your dashboard.`,
      blocks: [
        emailParagraph(
          `We tried ${tries} to collect <strong>${totalHtml}</strong> for <strong>${store}</strong>'s ${plan} renewal from your saved payment method, and it didn't go through. We won't try again automatically.`,
          { lead: true },
        ),
        emailDetails([
          ...storeAndPlan(d.storeName, d.planName),
          ...detailRows(renewalAmountRows(amount, false)),
          ...(payByHtml ? [{ label: "Pay by", valueHtml: payByHtml }] : []),
          {
            label: "Invoice",
            valueHtml: d.invoiceRef ? escapeHtml(d.invoiceRef) : "",
          },
        ]),
        emailParagraph(
          payByHtml
            ? `Please pay this invoice from ${PLANS_PAGE_HTML} by <strong>${payByHtml}</strong> to keep your plan. If it's not paid by then you'll get 48 hours' grace, then the store moves to the Free plan.`
            : `Please pay this invoice from ${PLANS_PAGE_HTML} as soon as you can to keep your plan. An unpaid renewal moves the store to the Free plan 48 hours after it falls due.`,
        ),
        emailButton(d.manageUrl, "Pay now"),
      ],
    }),
  };
}

/**
 * ★ Why this renewal costs something other than last time, named and named in
 * the RIGHT DIRECTION (tax-copy's `renewalChangeSentence`): "Your price has
 * changed" reads as a rise to everyone, so a merchant whose bill went DOWN
 * would write in to ask what happened, and one whose bill rose only because
 * GST started is told that, not that a plan price moved. The previous amount
 * is set in bold, as before. Empty when nothing changed.
 */
function changeParagraph(prev: CopyAmount | null, cur: CopyAmount): string {
  const sentence = renewalChangeSentence(prev, cur);
  if (!sentence || !prev) return "";
  const html = escapeHtml(sentence);
  const last = escapeHtml(moneyPaise(prev.totalPaise));
  return emailParagraph(html.replace(last, `<strong>${last}</strong>`));
}

/**
 * The cycle turned unpaid: the 48-hour grace clock is running.
 *
 * ★ `attempted` must be truthful. With automatic collection gated, "we couldn't
 * take payment" describes a charge that never happened and sends the merchant
 * to check a card nobody touched.
 */
export function renewalOverdueTemplate(d: {
  storeName: string;
  planName: string;
  accessUntil: string;
  attempted: boolean;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  // Day without a leading zero, India time ("9 Nov, 12:00"), like every other
  // billing date (GST Stage 6).
  const deadline = new Date(d.accessUntil).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
  return {
    subject: `Payment overdue: your ${d.planName} plan ends in 48 hours`,
    html: billingEmail({
      storeName: d.storeName,
      eyebrow: "Action needed",
      tone: "danger",
      heading: "Your plan ends in 48 hours",
      preheader: `Pay by ${deadline} IST to keep ${d.storeName}'s ${d.planName} plan.`,
      blocks: [
        emailParagraph(
          d.attempted
            ? `We couldn't collect payment for <strong>${store}</strong>'s ${plan} plan.`
            : `<strong>${store}</strong>'s ${plan} renewal hasn't been paid.`,
          { lead: true },
        ),
        emailDetails([
          ...storeAndPlan(d.storeName, d.planName),
          { label: "Pay by", valueHtml: `${deadline} IST` },
        ]),
        emailParagraph(
          `Pay by <strong>${deadline} IST</strong> to keep everything running. After that the store moves to the Free plan. Your data is safe, but paid features pause, including POS.`,
        ),
        emailButton(d.manageUrl, "Pay now"),
      ],
    }),
  };
}

export function planDowngradedTemplate(d: {
  storeName: string;
  fromPlanName: string;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const from = escapeHtml(d.fromPlanName);
  return {
    subject: `Your store is now on the Free plan`,
    html: billingEmail({
      storeName: d.storeName,
      heading: "Moved to the Free plan",
      preheader: `${d.storeName}'s ${d.fromPlanName} plan has ended. Your data is safe.`,
      blocks: [
        emailParagraph(
          `<strong>${store}</strong>'s ${from} plan has ended, so the store is now on <strong>Free</strong>.`,
          { lead: true },
        ),
        emailDetails([
          { label: "Store", valueHtml: store },
          { label: "Previous plan", valueHtml: from },
          { label: "Current plan", valueHtml: "Free" },
        ]),
        emailParagraph(
          `Your data is safe. Nothing was deleted. Some paid features are paused until you upgrade again.`,
        ),
        emailButton(d.manageUrl, "Upgrade again"),
      ],
    }),
  };
}

/**
 * A StoreMink credit note, as a refund email prints it for a store whose
 * dashboard is closed (suspended or deleted), so the merchant still holds the
 * document. The same particulars as the credit note sheet. Supplied by the
 * credit note store; this module only prints them.
 */
export interface RefundCreditNote {
  /** "CN/2026-27/00001". */
  ref: string;
  issuedAt: string;
  /** The invoice the note reduces, and when that invoice was issued. */
  invoiceRef: string | null;
  invoiceIssuedAt: string | null;
  supplier: {
    name: string | null;
    address: InvoiceAddress;
    gstin: string | null;
    /** The LLPIN the note recorded, or null (none without a recorded legal
     *  name). Optional for a note built before it was carried. */
    llpin?: string | null;
    /** The LLP's registered office the note recorded, or null. */
    registeredOffice?: string | null;
  };
  recipient: {
    name: string | null;
    address: InvoiceAddress;
    gstin: string | null;
    /** The customer's State (never the place of supply), printed with its
     *  code when the note credits tax and the recipient has no GSTIN. */
    stateCode: string | null;
  };
  /** The invoice's place of supply: a GST state code, or 96. Printed as its
   *  own row when the note credits tax. Optional for a note built before it
   *  was carried, which prints no such row. */
  placeOfSupply?: string | null;
  taxablePaise: number;
  /** CGST and SGST, or IGST. Empty when the invoice charged no tax. */
  taxLines: {
    name: "CGST" | "SGST" | "IGST";
    rateBps: number;
    amountPaise: number;
  }[];
  totalPaise: number;
}

export interface RefundEmailInput {
  /** `sent`: a refund StoreMink sent through Razorpay. `recorded`: one made
   *  outside the tool (a bank transfer, or by hand in Razorpay) and recorded. */
  kind: "sent" | "recorded";
  storeName: string;
  planName: string | null;
  amountPaise: number;
  invoiceRef: string | null;
  method: "razorpay" | "bank_transfer";
  /** billing_refunds.reason. */
  reason: string;
  /** The Razorpay refund id, or the bank transfer's UTR. */
  refundReference: string | null;
  creditNote: RefundCreditNote | null;
  /** A suspended or deleted store's dashboard is closed: no link, and the
   *  credit note's particulars are printed instead. */
  storeState: "active" | "suspended" | "deleted";
  /** The store's invoices page; used only for an active store. */
  invoicesUrl: string | null;
}

/** Why the refund was made, in the merchant's words. Goodwill and other
 *  adjustments carry no paragraph. */
function refundReasonText(reason: string, planName: string | null): string {
  switch (reason) {
    case "cycle_not_reached":
      return `Your ${planName ? `${escapeHtml(planName)} ` : ""}plan ended before the period this payment was for, so you aren't charged for it.`;
    case "feature_removed":
      return "This refunds the part of your cycle after a main feature of your plan was removed.";
    case "suspended_by_mistake":
      return "This refunds the time your store was suspended by mistake.";
    case "declined_terms":
      return "This refunds the part of your cycle that was left when your plan ended.";
    case "duplicate_payment":
      return "You paid this invoice twice. This returns the extra payment.";
    default:
      return "";
  }
}

function addressLine(address: InvoiceAddress): string {
  return [address.line1, address.line2, address.city, address.postalCode]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

/** "18" for 1800 basis points, "2.5" for 250. */
function ratePercent(bps: number): string {
  return String(Math.round(bps) / 100);
}

/** The credit note's particulars as detail rows (the sheet's fields). */
function creditNoteRows(note: RefundCreditNote): EmailDetail[] {
  const lines = (parts: (string | null)[]): string =>
    parts
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .map(escapeHtml)
      .join("<br />");
  // ★ The sheet's rules (credit-note-sheet.tsx): GSTINs and States only on a
  // note that credits tax; for an unregistered customer their State WITH its
  // code (CGST rule 53(1A)(f)), and the place of supply on its own row, never
  // the customer's State under that name.
  const hasTax = note.taxLines.length > 0;
  const recipientTax = note.recipient.gstin
    ? invoiceGstinLine(note.recipient.gstin)
    : hasTax
      ? invoiceStateLine(note.recipient.stateCode)
      : null;
  const placeOfSupply = hasTax
    ? placeOfSupplyLabel(note.placeOfSupply ?? null)
    : null;
  const supplierGstin = hasTax ? note.supplier.gstin : null;
  return [
    { label: "Credit note no.", valueHtml: escapeHtml(note.ref) },
    { label: "Date", valueHtml: escapeHtml(istDate(note.issuedAt)) },
    {
      label: "Against invoice",
      valueHtml: note.invoiceRef ? escapeHtml(note.invoiceRef) : "",
    },
    {
      label: "Invoice date",
      valueHtml: note.invoiceIssuedAt
        ? escapeHtml(istDate(note.invoiceIssuedAt))
        : "",
    },
    ...(placeOfSupply
      ? [{ label: "Place of supply", valueHtml: escapeHtml(placeOfSupply) }]
      : []),
    {
      label: "From",
      valueHtml: lines([
        note.supplier.name,
        addressLine(note.supplier.address),
        supplierGstin ? invoiceGstinLine(supplierGstin) : null,
        supplierGstin
          ? invoiceStateLine(stateCodeFromGstin(supplierGstin))
          : null,
      ]),
    },
    {
      label: "To",
      valueHtml: lines([
        note.recipient.name,
        addressLine(note.recipient.address),
        recipientTax,
      ]),
    },
    { label: "Taxable value", valueHtml: moneyPaise(note.taxablePaise) },
    ...note.taxLines.map((tax) => ({
      label: `${tax.name} ${ratePercent(tax.rateBps)}%`,
      valueHtml: moneyPaise(tax.amountPaise),
    })),
    { label: "Total credited", valueHtml: moneyPaise(note.totalPaise) },
  ];
}

/** The note's LLP line (owner decision 7), as the sheet's footer prints it;
 *  "" with no LLPIN or no recorded legal name. */
function creditNoteLlpNote(note: RefundCreditNote): string {
  const line = note.supplier.name
    ? llpLine({
        legalName: note.supplier.name,
        llpin: note.supplier.llpin ?? null,
        registeredOffice: note.supplier.registeredOffice ?? null,
      })
    : null;
  return line ? emailNote(escapeHtml(line)) : "";
}

/**
 * A refund reached the merchant: one builder for a refund StoreMink sent and
 * one recorded after it was made outside the tool.
 *
 * ★ Sent only once a refund has actually reached them (processed, or
 * recorded), never while it is still on its way through Razorpay, so the lead
 * can say "we've refunded".
 *
 * ★ A STORE WHOSE DASHBOARD IS CLOSED (suspended, or deleted) cannot open its
 * credit note, so the email carries the note's particulars and says to keep
 * it, and links to no dashboard. An active store gets a link to its invoices,
 * where the note opens and prints.
 */
export function refundTemplate(d: RefundEmailInput): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const amount = moneyPaise(d.amountPaise);
  const ref = d.invoiceRef ? escapeHtml(d.invoiceRef) : null;
  const byBank = d.kind === "recorded" && d.method === "bank_transfer";
  const reference = d.refundReference ? escapeHtml(d.refundReference) : null;
  const forInvoice = ref ? `, for invoice ${ref}` : "";
  const closed = d.storeState !== "active";
  const reason = refundReasonText(d.reason, d.planName);

  return {
    subject: `Your refund of ${amount}`,
    html: billingEmail({
      storeName: d.storeName,
      heading: byBank ? "Refund made" : "Refund on its way",
      preheader: d.invoiceRef
        ? `We've refunded ${amount} for invoice ${d.invoiceRef}.`
        : `We've refunded ${amount}.`,
      blocks: [
        emailParagraph(
          byBank
            ? `We've refunded <strong>${amount}</strong> by bank transfer${reference ? `, reference ${reference}` : ""}${forInvoice}.`
            : `We've refunded <strong>${amount}</strong> to the account or card you paid with${forInvoice}.`,
          { lead: true },
        ),
        emailDetails([
          { label: "Store", valueHtml: store },
          { label: "Invoice", valueHtml: ref ?? "" },
          { label: "Amount", valueHtml: amount },
          {
            label: "Credit note",
            valueHtml: d.creditNote ? escapeHtml(d.creditNote.ref) : "",
          },
          { label: "Refund reference", valueHtml: reference ?? "" },
        ]),
        reason ? emailParagraph(reason) : "",
        byBank
          ? ""
          : emailParagraph(
              "Your bank or card issuer decides when it shows in your account, usually within a few working days.",
            ),
        closed && d.creditNote ? emailSection("Credit note") : "",
        closed && d.creditNote
          ? emailDetails(creditNoteRows(d.creditNote))
          : "",
        closed && d.creditNote ? creditNoteLlpNote(d.creditNote) : "",
        closed
          ? emailParagraph(
              d.creditNote
                ? `Keep this email as your credit note. Write to ${SUPPORT_EMAIL} if you have a question.`
                : `Write to ${SUPPORT_EMAIL} if you have a question.`,
            )
          : "",
        !closed && d.invoicesUrl
          ? emailButton(d.invoicesUrl, "View your invoices")
          : "",
      ],
    }),
  };
}

/** A refund StoreMink sent through Razorpay has been processed. */
export function refundSentTemplate(
  d: Omit<RefundEmailInput, "kind">,
): BuiltEmail {
  return refundTemplate({ ...d, kind: "sent" });
}

/** A refund made outside the tool has been recorded. */
export function refundRecordedTemplate(
  d: Omit<RefundEmailInput, "kind">,
): BuiltEmail {
  return refundTemplate({ ...d, kind: "recorded" });
}

// ── Recipient + send (best-effort) ──────────────────────────────────────────

const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "storemink.com")
  .trim()
  .toLowerCase();

/** The Plans & Billing URL for a store, for the email CTA. */
export function manageUrl(slug: string): string {
  return `https://${slug}.${ROOT_DOMAIN}/dashboard/plans`;
}

/** The store's invoices page, where an invoice or a credit note prints. */
export function invoicesUrl(slug: string): string {
  return `${manageUrl(slug)}/invoices`;
}

export interface BillingRecipient {
  email: string;
  /** Present only when the owner has a recurring-charge-capable contact. */
  phone?: string | null;
  storeName: string;
  slug: string;
  /** `stores.status` ("active", "suspended"). A suspended store's dashboard
   *  is closed, so an email to it must not send them there. */
  storeStatus?: string | null;
}

/**
 * The billing contact for a store: its owner (superadmin) admin email, else
 * the invoice contact email. Null when neither is set.
 *
 * ★★ THE PHONE HAS TWO SOURCES, AND READING ONLY THE FIRST BLOCKED EVERY
 * SUBSCRIPTION. `startEnrolment` refuses before Checkout unless it has BOTH an
 * email and a phone (Razorpay's subsequent-charge endpoint needs both), and the
 * only source here was `admins.phone`, which the signup wizard NEVER WROTE.
 * The owner OTP-verifies a number during signup and `createStore` put it in
 * `store_billing_settings.contact_phone` only, so every wizard-created store had
 * `admins.phone = NULL` and answered Subscribe with "We couldn't prepare
 * autopay" forever, without a single Razorpay call being made. Measured on
 * production 2026-09-06: 2 of 3 superadmins had no phone, both with a perfectly
 * good verified number sitting one table away.
 *
 * `createStore` now records the verified number on the admin row too, but the
 * fallback is what fixes the stores that already exist, and the invoice contact
 * phone is the store's OWN stated billing contact, which is exactly the right
 * number for a pre-debit notification.
 *
 * ★ The fallback is VALIDATED (`formatIndianMobile`), the owner's is not: an
 * `admins.phone` was written from a verified Identity Platform identity, while
 * the invoice contact is free text a merchant typed on Taxes & invoices and may
 * be a landline or a placeholder. Handing Razorpay one of those registers a
 * mandate whose pre-debit notice reaches nobody.
 */
export async function resolveBillingEmail(
  storeId: string,
): Promise<BillingRecipient | null> {
  let store: { name: string; slug: string; status?: string } | undefined;
  let ownerEmail: string | null = null;
  let ownerPhone: string | null = null;
  let billingEmail: string | null = null;
  let billingPhone: string | null = null;
  try {
    ({ store, ownerEmail, ownerPhone, billingEmail, billingPhone } =
      await withService(async (db) => {
        // One after another: the three reads share this scope's one client,
        // and pg refuses (today it warns) a query sent while another runs.
        const storeRows = await db
          .select({
            name: stores.name,
            slug: stores.slug,
            status: stores.status,
          })
          .from(stores)
          .where(eq(stores.id, storeId))
          .limit(1);
        const ownerRows = await db
          .select({ email: admins.email, phone: admins.phone })
          .from(admins)
          .where(
            and(
              eq(admins.storeId, storeId),
              eq(admins.role, "superadmin"),
              isNotNull(admins.email),
            ),
          )
          .limit(1);
        const billingRows = await db
          .select({
            contact_email: storeBillingSettings.contactEmail,
            contact_phone: storeBillingSettings.contactPhone,
          })
          .from(storeBillingSettings)
          .where(eq(storeBillingSettings.storeId, storeId))
          .limit(1);
        return {
          store: storeRows[0],
          ownerEmail: ownerRows[0]?.email ?? null,
          ownerPhone: ownerRows[0]?.phone ?? null,
          billingEmail: billingRows[0]?.contact_email ?? null,
          billingPhone: billingRows[0]?.contact_phone ?? null,
        };
      }));
  } catch (err) {
    console.error(
      "resolveBillingEmail:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const email = ownerEmail || billingEmail || null;
  if (!email) return null;
  // The owner's own verified number belongs to the owner's email; pairing it
  // with an invoice contact email would mix two identities. The store's stated
  // invoice contact phone pairs with either.
  const verifiedOwnerPhone = ownerEmail === email ? ownerPhone : null;
  return {
    email,
    phone: verifiedOwnerPhone || formatIndianMobile(billingPhone),
    storeName: store?.name || "Your store",
    slug: store?.slug || "",
    storeStatus: store?.status ?? null,
  };
}

/**
 * Send a built billing email to a recipient. Best-effort: never throws.
 *
 * `storeId` is optional only because some callers have the recipient before
 * they have the store; pass it whenever you can, or the send lands in the
 * platform log instead of the merchant's own.
 */
export async function sendBillingEmail(
  to: string,
  built: BuiltEmail,
  storeId?: string | null,
): Promise<void> {
  await sendEmail({
    storeId: storeId ?? null,
    to,
    from: BILLING_FROM,
    subject: built.subject,
    html: built.html,
    mailer: "billing",
  });
}
