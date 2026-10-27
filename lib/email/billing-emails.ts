import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";
import {
  composeEmail,
  emailButton,
  emailDetails,
  emailParagraph,
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

// Transactional BILLING emails. These come from the platform (StoreMink), not
// the merchant's store brand: a plan receipt, renewal or dunning notice is
// from "StoreMink Billing" and wears StoreMink's own logo (platformEmailBrand).
// Every one is composed through the standard layout in shell.ts, and sending
// is best-effort: a mail failure never throws into the billing flow.

const BILLING_FROM = `StoreMink Billing <billing@${PLATFORM_EMAIL_DOMAIN}>`;

function money(inr: number): string {
  return `₹${inr.toLocaleString("en-IN")}`;
}

function shortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function perPeriod(period: "monthly" | "yearly"): string {
  return period === "yearly" ? "year" : "month";
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
    footerReasonHtml: `This is an automated message about ${escapeHtml(opts.storeName)}'s StoreMink subscription. Questions? Reply to this email and our team will help.`,
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
 */
export function planActivatedTemplate(d: {
  storeName: string;
  planName: string;
  amountInr: number;
  period: "monthly" | "yearly";
  renewsOn: string | null;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
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
            valueHtml: `${money(d.amountInr)}/${perPeriod(d.period)}`,
          },
          {
            label: "Renews on",
            valueHtml: d.renewsOn ? shortDate(d.renewsOn) : "",
          },
        ]),
        emailParagraph(
          d.renewsOn
            ? `Autopay is set up, so your plan renews automatically. You can change or cancel your plan anytime.`
            : `We'll email you before your next renewal. You can change or cancel your plan anytime.`,
        ),
        emailButton(d.manageUrl, "Manage your plan"),
      ],
    }),
  };
}

export function paymentReceiptTemplate(d: {
  storeName: string;
  planName: string;
  amountInr: number;
  period: "monthly" | "yearly";
  renewsOn: string | null;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  return {
    subject: `Payment received for your ${d.planName} plan`,
    html: billingEmail({
      storeName: d.storeName,
      eyebrow: "Receipt",
      heading: "Payment received",
      preheader: `${money(d.amountInr)} received for ${d.storeName}'s ${d.planName} plan.`,
      blocks: [
        emailParagraph(
          `Thank you. We've received <strong>${money(d.amountInr)}</strong> for <strong>${store}</strong>'s ${plan} plan.`,
          { lead: true },
        ),
        emailDetails([
          { label: "Store", valueHtml: store },
          {
            label: "Plan",
            valueHtml: `${plan}, billed ${d.period === "yearly" ? "yearly" : "monthly"}`,
          },
          { label: "Amount paid", valueHtml: money(d.amountInr) },
          {
            label: "Renews on",
            valueHtml: d.renewsOn ? shortDate(d.renewsOn) : "",
          },
        ]),
        emailParagraph(
          `Your plan is active. Your invoices are in Plans &amp; Billing whenever you need them.`,
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
              valueHtml: d.accessUntil ? shortDate(d.accessUntil) : "",
            },
          ]),
          emailParagraph(
            d.accessUntil
              ? `Please update your payment method to keep your plan. Access continues until <strong>${shortDate(d.accessUntil)}</strong>, after which the store moves to the Free plan.`
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

export function subscriptionCancelledTemplate(d: {
  storeName: string;
  planName: string;
  accessUntil: string | null;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  return {
    subject: `Your ${d.planName} subscription is cancelled`,
    html: billingEmail({
      storeName: d.storeName,
      heading: "Your subscription is cancelled",
      preheader: `Autopay for ${d.storeName}'s ${d.planName} plan is cancelled. No further payments will be taken.`,
      blocks: [
        emailParagraph(
          `Autopay for <strong>${store}</strong>'s ${plan} plan is cancelled. No further payments will be taken.`,
          { lead: true },
        ),
        emailDetails([
          ...storeAndPlan(d.storeName, d.planName),
          {
            label: "Access until",
            valueHtml: d.accessUntil
              ? shortDate(d.accessUntil)
              : "The end of the current cycle",
          },
        ]),
        emailParagraph(
          `You keep ${plan}${d.accessUntil ? ` until <strong>${shortDate(d.accessUntil)}</strong>` : " until the current cycle ends"}, then the store moves to the Free plan. Changed your mind? You can re-subscribe anytime.`,
        ),
        emailButton(d.manageUrl, "Re-subscribe"),
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
 */
export function renewalDueTemplate(d: {
  storeName: string;
  planName: string;
  amountInr: number;
  dueOn: string;
  invoiceRef: string | null;
  autopay: boolean;
  /** Last cycle's amount, when it differed from this one. */
  previousAmountInr?: number | null;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  const due = shortDate(d.dueOn);
  const invoiceRow: EmailDetail = {
    label: "Invoice",
    valueHtml: d.invoiceRef ? escapeHtml(d.invoiceRef) : "",
  };
  // ★ Named, and named in the RIGHT DIRECTION. "Your price has changed" reads
  // as a rise to everyone, so a merchant whose bill went DOWN would write in
  // to ask what happened.
  const repriced =
    d.previousAmountInr != null && d.previousAmountInr !== d.amountInr
      ? emailParagraph(
          `This is ${d.amountInr > d.previousAmountInr ? "an increase" : "a reduction"} from <strong>${money(d.previousAmountInr)}</strong> last time. Plan prices changed; nothing about your subscription was altered.`,
        )
      : "";

  if (d.autopay) {
    return {
      subject: `Your ${d.planName} plan renews on ${due}`,
      html: billingEmail({
        storeName: d.storeName,
        heading: "Your plan renews soon",
        preheader: `We'll charge ${money(d.amountInr)} on ${due}. There's nothing you need to do.`,
        blocks: [
          emailParagraph(
            `<strong>${store}</strong>'s ${plan} plan renews on <strong>${due}</strong>. We'll charge <strong>${money(d.amountInr)}</strong> to your saved payment method, so there's nothing you need to do.`,
            { lead: true },
          ),
          emailDetails([
            ...storeAndPlan(d.storeName, d.planName),
            { label: "Amount", valueHtml: money(d.amountInr) },
            { label: "Renews on", valueHtml: due },
            invoiceRow,
          ]),
          repriced,
          emailParagraph(
            `Want to change or cancel first? You can, any time before then.`,
          ),
          emailButton(d.manageUrl, "Manage your plan"),
        ],
      }),
    };
  }
  return {
    subject: `${money(d.amountInr)} due for your ${d.planName} plan`,
    html: billingEmail({
      storeName: d.storeName,
      eyebrow: "Invoice",
      heading: "Time to renew",
      preheader: `${money(d.amountInr)} is payable by ${due} to keep ${d.storeName}'s ${d.planName} plan.`,
      blocks: [
        emailParagraph(
          `<strong>${store}</strong>'s ${plan} plan is due for renewal. <strong>${money(d.amountInr)}</strong> is payable by <strong>${due}</strong>.`,
          { lead: true },
        ),
        emailDetails([
          ...storeAndPlan(d.storeName, d.planName),
          { label: "Amount due", valueHtml: money(d.amountInr) },
          { label: "Due by", valueHtml: due },
          invoiceRow,
        ]),
        repriced,
        emailParagraph(
          `Pay from your dashboard in a couple of taps. If it's not paid by the renewal date you'll get 48 hours' grace, then the store moves to the Free plan.`,
        ),
        emailButton(d.manageUrl, "Pay now"),
      ],
    }),
  };
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
  const deadline = new Date(d.accessUntil).toLocaleString("en-GB", {
    day: "2-digit",
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

// ── Recipient + send (best-effort) ──────────────────────────────────────────

const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "storemink.com")
  .trim()
  .toLowerCase();

/** The Plans & Billing URL for a store, for the email CTA. */
export function manageUrl(slug: string): string {
  return `https://${slug}.${ROOT_DOMAIN}/dashboard/plans`;
}

export interface BillingRecipient {
  email: string;
  /** Present only when the owner has a recurring-charge-capable contact. */
  phone?: string | null;
  storeName: string;
  slug: string;
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
  let store: { name: string; slug: string } | undefined;
  let ownerEmail: string | null = null;
  let ownerPhone: string | null = null;
  let billingEmail: string | null = null;
  let billingPhone: string | null = null;
  try {
    ({ store, ownerEmail, ownerPhone, billingEmail, billingPhone } =
      await withService(async (db) => {
        const [storeRows, ownerRows, billingRows] = await Promise.all([
          db
            .select({ name: stores.name, slug: stores.slug })
            .from(stores)
            .where(eq(stores.id, storeId))
            .limit(1),
          db
            .select({ email: admins.email, phone: admins.phone })
            .from(admins)
            .where(
              and(
                eq(admins.storeId, storeId),
                eq(admins.role, "superadmin"),
                isNotNull(admins.email),
              ),
            )
            .limit(1),
          db
            .select({
              contact_email: storeBillingSettings.contactEmail,
              contact_phone: storeBillingSettings.contactPhone,
            })
            .from(storeBillingSettings)
            .where(eq(storeBillingSettings.storeId, storeId))
            .limit(1),
        ]);
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
