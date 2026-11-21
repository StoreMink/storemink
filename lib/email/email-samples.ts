// ---------------------------------------------------------------------------
// Every email StoreMink sends, rendered with sample data.
//
// Two readers, one list, so neither can quietly miss a mailer:
//   * scripts/email-gallery.ts writes them to .email-gallery/ to LOOK at
//     (`npm run email:gallery`), which is how a design change is reviewed
//     across every message at once rather than one inbox at a time;
//   * no-long-dash.test.ts asserts every one wears the standard frame and
//     carries no long dash in its subject or body.
//
// A new mailer belongs here. It is pure string building: no DB, no network.
// ---------------------------------------------------------------------------

import type { StoreBrand } from "@/lib/store/brand";
import { EVENTS } from "@/lib/notifications/events";
import { defaultEmailTemplate } from "@/lib/notifications/default-templates";
import { renderTemplate } from "@/lib/notifications/template";
import { sampleValuesFor } from "@/lib/notifications/variables";
import { formatVariable } from "@/lib/notifications/format";
import { renderNotification } from "@/lib/notifications/render";
import {
  platformBrand,
  renderNotificationDigest,
  renderNotificationEmail,
} from "./notification-emails";
import type { EmailOrderSummary } from "./line-items";
import {
  autopayStoppedTemplate,
  paymentFailedTemplate,
  paymentReceiptTemplate,
  planActivatedTemplate,
  planDowngradedTemplate,
  refundRecordedTemplate,
  refundSentTemplate,
  renewalDueTemplate,
  renewalOverdueTemplate,
  subscriptionCancelledTemplate,
  type RefundCreditNote,
} from "./billing-emails";
import { buildOperatorOtpEmail } from "./operator-otp";
import { buildSignupOtpEmail } from "./signup-otp";
import { buildEnquiryAcknowledgementEmail } from "./enquiry-notifications";
import { renderCouponEmail } from "./coupon-campaign";
import {
  buildPasswordResetEmail,
  buildPosCredentialResetEmail,
  buildPosStaffInviteEmail,
  buildStaffInviteEmail,
} from "./account-emails";
import { renderAnnouncementEmail } from "./announcement-email";
import { buildPosReceiptEmail } from "./pos-receipt";
import {
  buildAcknowledgementEmail,
  buildBlockLiftedEmail,
  buildBlockNoticeEmail,
  buildOutcomeEmail,
  buildStoreMinkRepliedEmail,
  buildStoreSuspendedEmail,
} from "./takedown-emails";
import { defaultStoreMessage } from "@/lib/moderation/copy";
import type { TaxTerms } from "@/lib/billing/tax-terms";

export interface EmailSample {
  /** File-safe id, unique across the list. */
  id: string;
  /** Who sends it, for grouping in the gallery. */
  group: string;
  label: string;
  subject: string;
  html: string;
}

/** A store with no logo, so the serif wordmark is what the header shows. */
export const SAMPLE_STORE_BRAND: StoreBrand = {
  name: "Acme Juice",
  logoUrl: null,
  primaryColor: "#2f6b3a",
  tagline: null,
  blurb: null,
  legalName: "Acme Juice Pvt Ltd",
  creditLine: null,
  email: "hello@acmejuice.in",
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: "storemink.com",
};

const STORE_URL = "https://acme.storemink.com";

const SAMPLE_SUMMARY: EmailOrderSummary = {
  currency: "INR",
  items: [
    {
      name: "Cold-pressed Orange",
      variant: "500 ml",
      quantity: 2,
      total: 380,
    },
    { name: "Almond Shake", quantity: 1, total: 220 },
  ],
  subtotal: 600,
  discount: 60,
  tax: 27,
  shipping: 40,
  total: 607,
};

/**
 * The console's sample values, formatted the way a real send formats them
 * (lib/notifications/template.ts templateValues): "cod" reads "Cash on
 * delivery", "pickup" reads "Pick up in store". Only the enum-like values are
 * formatted; the samples for money and dates are already display strings.
 */
function sampleValues(key: string): Record<string, string> {
  const values = sampleValuesFor(key);
  for (const name of [
    "payment_method",
    "fulfilment",
    "status",
    "payment_status",
  ]) {
    if (values[name]) values[name] = formatVariable(name, values[name]);
  }
  return values;
}

function notificationSamples(): EmailSample[] {
  const out: EmailSample[] = [];
  for (const def of EVENTS) {
    const audiences: { key: "team" | "customer"; brand: StoreBrand }[] = [];
    // Every audience the event has, whether or not email is on by default:
    // a merchant can switch email on for any of them.
    if (def.audiences["store-admins"]) {
      audiences.push({ key: "team", brand: SAMPLE_STORE_BRAND });
    }
    if (def.audiences.customer) {
      audiences.push({ key: "customer", brand: SAMPLE_STORE_BRAND });
    }
    if (def.audiences.operators) {
      audiences.push({ key: "team", brand: platformBrand() });
    }
    for (const audience of audiences) {
      const platform = audience.brand !== SAMPLE_STORE_BRAND;
      const values = sampleValues(def.key);
      const template = defaultEmailTemplate(def.key, audience.key, values);
      // Operators have no email template of their own: a real operator email
      // carries the in-app copy (record.ts emailFor), so the sample does too.
      const operatorCopy = platform
        ? renderNotification(
            {
              type: def.key,
              actorLabel: values.actor_name,
              subjectLabel: values.subject_label,
              payload: values,
            },
            "operators",
          )
        : null;
      const rendered = renderNotificationEmail({
        item: {
          eventKey: def.key,
          title:
            operatorCopy?.title ??
            renderTemplate(template.subject, values, "text"),
          body:
            operatorCopy?.body ?? renderTemplate(template.body, values, "html"),
          url: audience.key === "customer" ? "/orders/sample" : "/dashboard",
          severity: def.severity,
          summary: def.key === "order.placed" ? SAMPLE_SUMMARY : null,
        },
        brand: audience.brand,
        baseUrl: STORE_URL,
        isTeam: audience.key === "team",
      });
      out.push({
        id: `notification-${def.key.replace(/\./g, "-")}-${platform ? "operators" : audience.key}`,
        group: platform
          ? "Notifications: StoreMink operators"
          : audience.key === "team"
            ? "Notifications: store team"
            : "Notifications: shoppers",
        label: `${def.label} (${platform ? "operators" : audience.key})`,
        ...rendered,
      });
    }
  }

  out.push({
    id: "notification-digest",
    group: "Notifications: store team",
    label: "Daily digest",
    ...renderNotificationDigest({
      items: [
        {
          title: "New order ORD10010004 · ₹1,240",
          body: "<p>A new order is ready for review.</p>",
          url: "/dashboard/orders",
          severity: "info",
        },
        {
          title: "Low stock: Almond Shake · 3 left",
          body: "<p>This item has reached its low-stock threshold.</p>",
          url: "/dashboard/inventory",
          severity: "warning",
        },
        {
          title: "Return request · ORD10010001",
          body: "<p>A customer is waiting for you to review a return request.</p>",
          url: "/dashboard/orders/returns",
          severity: "warning",
        },
      ],
      brand: SAMPLE_STORE_BRAND,
      baseUrl: STORE_URL,
      digest: "daily",
    }),
  });
  return out;
}

/** A credit note as the refund email prints it for a closed dashboard. */
const SAMPLE_CREDIT_NOTE: RefundCreditNote = {
  ref: "CN/2026-27/00001",
  issuedAt: "2026-11-07T06:30:00.000Z",
  invoiceRef: "SM/2026-27/000142",
  invoiceIssuedAt: "2026-11-03T04:30:00.000Z",
  supplier: {
    name: "STOREMINK LLP",
    address: {
      line1: "Bala ji Colony",
      city: "Faridkot",
      postalCode: "151203",
    },
    gstin: "03ABCDE1234F1Z5",
    llpin: "ADC-5432",
    registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
  },
  recipient: {
    name: "Acme Juice Pvt Ltd",
    address: { line1: "12 MG Road", city: "Bengaluru", postalCode: "560001" },
    gstin: null,
    stateCode: "29",
  },
  placeOfSupply: "29",
  taxablePaise: 203390,
  taxLines: [{ name: "IGST", rateBps: 1800, amountPaise: 36610 }],
  totalPaise: 240000,
};

function cancellationSamples(group: string, manageUrl: string): EmailSample[] {
  const base = {
    storeName: "Acme Juice",
    planName: "Pro",
    manageUrl,
    endsAt: "2026-11-07T00:00:00.000Z",
    inGrace: false,
    nextInvoice: null,
    requestedBy: "merchant" as const,
    storeSuspended: false,
  };
  const next = (status: string, inFlight = false) => ({
    status,
    totalPaise: 240000,
    invoiceRef: "SM/2026-27/000142",
    inFlight,
  });
  const grace = { endsAt: "2026-11-09T08:30:00.000Z", inGrace: true };
  return [
    {
      id: "billing-subscription-cancelled",
      group,
      label: "Subscription cancelled",
      ...subscriptionCancelledTemplate(base),
    },
    {
      id: "billing-subscription-cancelled-open-invoice",
      group,
      label: "Subscription cancelled, renewal invoice issued",
      ...subscriptionCancelledTemplate({ ...base, nextInvoice: next("open") }),
    },
    {
      id: "billing-subscription-cancelled-payment-under-way",
      group,
      label: "Subscription cancelled, renewal payment under way",
      ...subscriptionCancelledTemplate({
        ...base,
        nextInvoice: next("processing", true),
      }),
    },
    {
      id: "billing-subscription-cancelled-renewal-paid",
      group,
      label: "Subscription cancelled, renewal already paid",
      ...subscriptionCancelledTemplate({ ...base, nextInvoice: next("paid") }),
    },
    {
      id: "billing-subscription-cancelled-grace",
      group,
      label: "Subscription cancelled during grace",
      ...subscriptionCancelledTemplate({
        ...base,
        ...grace,
        nextInvoice: next("open"),
      }),
    },
    {
      id: "billing-subscription-cancelled-grace-payment-under-way",
      group,
      label: "Subscription cancelled during grace, payment under way",
      ...subscriptionCancelledTemplate({
        ...base,
        ...grace,
        nextInvoice: next("processing", true),
      }),
    },
    {
      id: "billing-subscription-cancelled-by-storemink",
      group,
      label: "Subscription cancelled by StoreMink at the merchant's request",
      ...subscriptionCancelledTemplate({ ...base, requestedBy: "operator" }),
    },
    {
      id: "billing-subscription-cancelled-suspended-store",
      group,
      label: "Subscription cancelled, store suspended",
      ...subscriptionCancelledTemplate({
        ...base,
        requestedBy: "operator",
        storeSuspended: true,
      }),
    },
  ];
}

function refundSamples(group: string): EmailSample[] {
  const base = {
    storeName: "Acme Juice",
    planName: "Pro",
    amountPaise: 240000,
    invoiceRef: "SM/2026-27/000142",
    method: "razorpay" as const,
    reason: "cycle_not_reached",
    refundReference: "rfnd_Q1a2B3c4D5e6F7",
    creditNote: SAMPLE_CREDIT_NOTE,
    storeState: "active" as const,
    invoicesUrl: `${STORE_URL}/dashboard/plans/invoices`,
  };
  return [
    {
      id: "billing-refund-sent",
      group,
      label: "Refund sent",
      ...refundSentTemplate(base),
    },
    {
      id: "billing-refund-sent-suspended-store",
      group,
      label: "Refund sent, store suspended",
      ...refundSentTemplate({
        ...base,
        storeState: "suspended",
        invoicesUrl: null,
      }),
    },
    {
      id: "billing-refund-sent-deleted-store",
      group,
      label: "Refund sent, store deleted",
      ...refundSentTemplate({
        ...base,
        storeName: "Acme Juice Pvt Ltd",
        planName: null,
        storeState: "deleted",
        invoicesUrl: null,
      }),
    },
    {
      id: "billing-refund-sent-duplicate-payment",
      group,
      label: "Refund sent, paid twice",
      ...refundSentTemplate({
        ...base,
        reason: "duplicate_payment",
        creditNote: null,
      }),
    },
    {
      id: "billing-refund-recorded-bank-transfer",
      group,
      label: "Refund recorded, bank transfer",
      ...refundRecordedTemplate({
        ...base,
        method: "bank_transfer",
        amountPaise: 123450,
        reason: "feature_removed",
        refundReference: "HDFCR52026110712345",
      }),
    },
    {
      id: "billing-refund-recorded-razorpay",
      group,
      label: "Refund recorded, made in Razorpay",
      ...refundRecordedTemplate({ ...base, reason: "goodwill" }),
    },
  ];
}

/** GST at 18% added on top of a ₹1,500 price (design 7.7, ON-EX). */
const GST_ADDED = { taxPaise: 27000, ratePct: 18, inclusive: false };
/** GST at 18% inside a ₹1,500 price (design 7.7, ON-IN). */
const GST_INCLUDED = { taxPaise: 22881, ratePct: 18, inclusive: true };
/** No GST today; GST at 18% added on top from 1 Dec 2026 (SCHED-EX). */
const GST_SCHEDULED: TaxTerms = {
  active: false,
  inclusive: false,
  rateBps: 0,
  upcoming: {
    enabled: true,
    inclusive: false,
    rateBps: 1800,
    startsAt: "2026-11-30T18:30:00.000Z",
  },
};

/**
 * The billing emails in each GST state (GST Stage 6): GST added on top
 * (ON-EX), included (ON-IN), scheduled (SCHED-EX), and a renewal that costs
 * more because GST started, or because the price changed as GST started.
 */
function gstSamples(group: string, manageUrl: string): EmailSample[] {
  const base = { storeName: "Acme Juice", planName: "Basic", manageUrl };
  const renews = "2026-12-14T18:30:00.000Z";
  return [
    {
      id: "billing-plan-activated-gst-added",
      group,
      label: "Plan activated, GST added on top",
      ...planActivatedTemplate({
        ...base,
        amountPaise: 177000,
        tax: GST_ADDED,
        period: "monthly",
        renewsOn: renews,
      }),
    },
    {
      id: "billing-plan-activated-gst-included",
      group,
      label: "Plan activated, GST included",
      ...planActivatedTemplate({
        ...base,
        amountPaise: 150000,
        tax: GST_INCLUDED,
        period: "monthly",
        renewsOn: renews,
      }),
    },
    {
      id: "billing-plan-activated-gst-scheduled",
      group,
      label: "Plan activated, GST added from a later date",
      ...planActivatedTemplate({
        ...base,
        amountPaise: 150000,
        tax: null,
        taxTerms: GST_SCHEDULED,
        period: "monthly",
        renewsOn: renews,
      }),
    },
    {
      id: "billing-payment-receipt-gst-added",
      group,
      label: "Payment received, GST added on top",
      ...paymentReceiptTemplate({
        ...base,
        amountPaise: 177000,
        tax: GST_ADDED,
        period: "monthly",
        renewsOn: renews,
      }),
    },
    {
      id: "billing-payment-receipt-gst-included",
      group,
      label: "Payment received, GST included",
      ...paymentReceiptTemplate({
        ...base,
        amountPaise: 150000,
        tax: GST_INCLUDED,
        period: "monthly",
        renewsOn: renews,
      }),
    },
    {
      id: "billing-renewal-due-gst-added",
      group,
      label: "Renewal due, autopay, GST added on top",
      ...renewalDueTemplate({
        ...base,
        amountPaise: 177000,
        tax: GST_ADDED,
        dueOn: renews,
        invoiceRef: "SM/2026-27/00211",
        autopay: true,
        previousAmountPaise: 177000,
        previousTax: GST_ADDED,
      }),
    },
    {
      id: "billing-renewal-due-gst-included",
      group,
      label: "Renewal due, pay manually, GST included",
      ...renewalDueTemplate({
        ...base,
        amountPaise: 150000,
        tax: GST_INCLUDED,
        dueOn: renews,
        invoiceRef: "SM/2026-27/00212",
        autopay: false,
        previousAmountPaise: 150000,
        previousTax: GST_INCLUDED,
      }),
    },
    {
      id: "billing-renewal-due-gst-started",
      group,
      label: "Renewal due, costs more because GST started",
      ...renewalDueTemplate({
        ...base,
        amountPaise: 177000,
        tax: GST_ADDED,
        dueOn: renews,
        invoiceRef: "SM/2026-27/00213",
        autopay: true,
        previousAmountPaise: 150000,
        previousTax: null,
      }),
    },
    {
      id: "billing-renewal-due-gst-and-price",
      group,
      label: "Renewal due, new price and GST started together",
      ...renewalDueTemplate({
        ...base,
        amountPaise: 200600,
        tax: { taxPaise: 30600, ratePct: 18, inclusive: false },
        dueOn: renews,
        invoiceRef: "SM/2026-27/00214",
        autopay: false,
        previousAmountPaise: 150000,
        previousTax: null,
      }),
    },
  ];
}

function billingSamples(): EmailSample[] {
  const manageUrl = `${STORE_URL}/dashboard/plans`;
  const group = "Billing (StoreMink)";
  const base = { storeName: "Acme Juice", planName: "Pro", manageUrl };
  return [
    {
      id: "billing-plan-activated",
      group,
      label: "Plan activated",
      ...planActivatedTemplate({
        ...base,
        amountPaise: 240000,
        tax: null,
        period: "monthly",
        renewsOn: "2026-11-07T00:00:00.000Z",
      }),
    },
    {
      id: "billing-payment-receipt",
      group,
      label: "Payment received",
      ...paymentReceiptTemplate({
        ...base,
        amountPaise: 240000,
        tax: null,
        period: "monthly",
        renewsOn: "2026-11-07T00:00:00.000Z",
      }),
    },
    {
      id: "billing-payment-receipt-cancelling",
      group,
      label: "Payment received for a cancelled plan's next cycle",
      ...paymentReceiptTemplate({
        ...base,
        amountPaise: 240000,
        tax: null,
        period: "monthly",
        renewsOn: null,
        cancelling: { endsAt: "2026-11-07T00:00:00.000Z", inGrace: false },
      }),
    },
    {
      id: "billing-payment-failed-retrying",
      group,
      label: "Payment failed, retrying",
      ...paymentFailedTemplate({ ...base, final: false, accessUntil: null }),
    },
    {
      id: "billing-payment-failed-final",
      group,
      label: "Payment failed, final",
      ...paymentFailedTemplate({
        ...base,
        final: true,
        accessUntil: "2026-10-10T00:00:00.000Z",
      }),
    },
    ...cancellationSamples(group, manageUrl),
    ...refundSamples(group),
    {
      id: "billing-renewal-due-autopay",
      group,
      label: "Renewal due, autopay",
      ...renewalDueTemplate({
        ...base,
        amountPaise: 240000,
        tax: null,
        dueOn: "2026-11-07T00:00:00.000Z",
        invoiceRef: "SM/2026-27/000142",
        autopay: true,
        previousAmountPaise: 200000,
      }),
    },
    {
      id: "billing-renewal-due-manual",
      group,
      label: "Renewal due, pay manually",
      ...renewalDueTemplate({
        ...base,
        amountPaise: 2400000,
        tax: null,
        dueOn: "2026-11-07T00:00:00.000Z",
        invoiceRef: "SM/2026-27/000143",
        autopay: false,
        previousAmountPaise: 2600000,
      }),
    },
    ...gstSamples(group, manageUrl),
    {
      id: "billing-autopay-stopped",
      group,
      label: "Automatic payment stopped, pay by hand",
      ...autopayStoppedTemplate({
        ...base,
        amountPaise: 240000,
        tax: null,
        payBy: "2026-11-07T06:30:00.000Z",
        invoiceRef: "SM/2026-27/00042",
        attempts: 3,
      }),
    },
    {
      id: "billing-renewal-overdue",
      group,
      label: "Renewal overdue",
      ...renewalOverdueTemplate({
        ...base,
        accessUntil: "2026-11-09T06:30:00.000Z",
        attempted: true,
      }),
    },
    {
      id: "billing-plan-downgraded",
      group,
      label: "Moved to Free",
      ...planDowngradedTemplate({
        storeName: "Acme Juice",
        fromPlanName: "Pro",
        manageUrl,
      }),
    },
  ];
}

function accessSamples(): EmailSample[] {
  return [
    {
      id: "code-operator-sign-in",
      group: "Sign-in codes (StoreMink)",
      label: "Operator sign-in code",
      ...buildOperatorOtpEmail("482913"),
    },
    {
      id: "code-signup-verification",
      group: "Sign-in codes (StoreMink)",
      label: "Signup verification code",
      ...buildSignupOtpEmail("482913"),
    },
    {
      id: "account-staff-invite",
      group: "Accounts and staff",
      label: "Dashboard staff invite",
      ...buildStaffInviteEmail({
        brand: SAMPLE_STORE_BRAND,
        firstName: "Priya",
        lastName: "Sharma",
        email: "priya@acmejuice.in",
        role: "manager",
        tempPassword: "Tq7#mZ2pLx",
        signInUrl: `${STORE_URL}/dashboard`,
      }),
    },
    {
      id: "account-password-reset",
      group: "Accounts and staff",
      label: "Password reset",
      ...buildPasswordResetEmail({
        brand: SAMPLE_STORE_BRAND,
        link: "https://auth.storemink.com/reset?oobCode=sample-code",
      }),
    },
    {
      id: "account-pos-invite",
      group: "Accounts and staff",
      label: "POS staff invite",
      ...buildPosStaffInviteEmail({
        brand: SAMPLE_STORE_BRAND,
        name: "Rohan",
        role: "cashier",
        link: `${STORE_URL}/pos/register?token=sample`,
      }),
    },
    {
      id: "account-pos-reset",
      group: "Accounts and staff",
      label: "POS PIN or password reset",
      ...buildPosCredentialResetEmail({
        brand: SAMPLE_STORE_BRAND,
        name: "Rohan",
        link: `${STORE_URL}/pos/reset?token=sample`,
      }),
    },
  ];
}

function storeSamples(): EmailSample[] {
  const coupon = renderCouponEmail({
    body: "Hi {{first_name}},\n\nThanks for being one of our regulars. Here is something to make your next bottle a little sweeter.\n\nSee you soon!",
    firstName: "Priya",
    code: "WELCOME20",
    discountLabel: "20% off",
    validUntilLabel: "31 October 2026",
    brand: SAMPLE_STORE_BRAND,
  });
  return [
    {
      id: "store-enquiry-acknowledgement",
      group: "Store to shopper",
      label: "Enquiry received",
      ...buildEnquiryAcknowledgementEmail({
        name: "Priya",
        subject: "Bulk order for an office party",
        message:
          "Hi! Could you do 40 bottles for a Friday event?\nHappy to pick them up.",
        brand: SAMPLE_STORE_BRAND,
      }),
    },
    {
      id: "store-coupon-campaign",
      group: "Store to shopper",
      label: "Coupon campaign",
      subject: "A little something for you",
      html: coupon,
    },
    {
      id: "store-pos-receipt",
      group: "Store to shopper",
      label: "In-store receipt",
      ...buildPosReceiptEmail({
        brand: SAMPLE_STORE_BRAND,
        orderRef: "ORD10010004",
        locationName: "Connaught Place",
        summary: SAMPLE_SUMMARY,
        tenderLabels: ["Cash", "UPI"],
        changeDue: 13,
      }),
    },
  ];
}

function announcementSamples(): EmailSample[] {
  const body =
    "<p>You can now sell in person with StoreMink POS. It shares stock, customers and offers with your online store.</p><ul><li>Scan barcodes with any phone camera</li><li>Split a payment across cash and UPI</li></ul>";
  return [
    {
      id: "announcement-feature",
      group: "Announcements (StoreMink)",
      label: "Product update",
      ...renderAnnouncementEmail({
        brand: platformBrand(),
        subject: "Meet StoreMink POS",
        bodyHtml: body,
        ctaLabel: "Try POS",
        ctaUrl: "https://storemink.com/pos",
        category: "feature",
        preferencesUrl: `${STORE_URL}/dashboard/settings/account`,
        recipientName: "Priya",
      }),
    },
    {
      id: "announcement-operational",
      group: "Announcements (StoreMink)",
      label: "Service notice",
      ...renderAnnouncementEmail({
        brand: platformBrand(),
        subject: "Scheduled maintenance on Sunday",
        bodyHtml:
          "<p>Dashboards will be read-only for about twenty minutes on Sunday at 2:00 am IST. Your storefront stays open throughout.</p>",
        ctaLabel: null,
        ctaUrl: null,
        category: "operational",
        preferencesUrl: `${STORE_URL}/dashboard/settings/account`,
        recipientName: null,
      }),
    },
  ];
}

/**
 * The same shopper email under three logo shapes, so the header's logo fitting
 * (lib/email/shell.ts merchantLogo) can be checked by eye. The files are
 * written next to the gallery by scripts/email-gallery.ts (SAMPLE_LOGOS).
 */
export const SAMPLE_LOGOS = {
  wide: "sample-logo-wide.svg",
  square: "sample-logo-square.svg",
  tall: "sample-logo-tall.svg",
} as const;

function logoSamples(): EmailSample[] {
  return (Object.keys(SAMPLE_LOGOS) as (keyof typeof SAMPLE_LOGOS)[]).map(
    (shape) => {
      const brand: StoreBrand = {
        ...SAMPLE_STORE_BRAND,
        logoUrl: SAMPLE_LOGOS[shape],
      };
      const values = sampleValues("order.placed");
      const template = defaultEmailTemplate("order.placed", "customer", values);
      return {
        id: `logo-${shape}`,
        group: "Store logo sizing",
        label: `${shape[0].toUpperCase()}${shape.slice(1)} logo`,
        ...renderNotificationEmail({
          item: {
            eventKey: "order.placed",
            title: renderTemplate(template.subject, values, "text"),
            body: renderTemplate(template.body, values, "html"),
            url: "/orders/sample",
            severity: "info",
            summary: SAMPLE_SUMMARY,
          },
          brand,
          baseUrl: STORE_URL,
          isTeam: false,
        }),
      };
    },
  );
}

/** Every mailer, rendered with sample data. */
/** A block id and store slug for the takedown notices' buttons. */
const SAMPLE_NOTICE = {
  slug: "acme",
  blockId: "0f9b5c1e-4a7d-4c2b-9e1f-3a2b1c0d9e8f",
};

/** The takedown emails (design 7.6): StoreMink to a store, and to a complainant. */
function takedownSamples(): EmailSample[] {
  const group = "StoreMink: takedowns";
  return [
    {
      id: "takedown-block-notice",
      group,
      label: "Block notice (a product, after a complaint)",
      ...buildBlockNoticeEmail(
        {
          storeName: "Acme Juice",
          kind: "product",
          itemLabel: "Almond Shake",
          blockedOn: "30 Oct 2026",
          reasonKind: "listed_content",
          reference: "SM-000123",
          storeMessage:
            defaultStoreMessage("listed_content", "product") ??
            "We blocked this product.",
          complaintId: "c",
        },
        SAMPLE_NOTICE,
      ),
    },
    {
      id: "takedown-block-notice-terms",
      group,
      label: "Block notice (an image, a breach of our policies)",
      ...buildBlockNoticeEmail(
        {
          storeName: "Acme Juice",
          kind: "file",
          contentType: "image/webp",
          itemLabel: "almond-shake-hero.webp",
          blockedOn: "30 Oct 2026",
          reasonKind: "terms_breach",
          reference: null,
          storeMessage:
            defaultStoreMessage("terms_breach", "file", "image/webp") ??
            "We blocked this image.",
          complaintId: null,
        },
        SAMPLE_NOTICE,
      ),
    },
    {
      id: "takedown-block-notice-store-request",
      group,
      label: "Block notice (a review, at the store's request)",
      ...buildBlockNoticeEmail(
        {
          storeName: "Acme Juice",
          kind: "review",
          itemLabel: "Rahul S., 12 Oct 2026",
          blockedOn: "30 Oct 2026",
          reasonKind: "store_request",
          reference: null,
          storeMessage:
            defaultStoreMessage("store_request", "review") ??
            "We hid this review, as you asked.",
          complaintId: null,
        },
        SAMPLE_NOTICE,
      ),
    },
    {
      id: "takedown-store-suspended",
      group,
      label: "Store suspended",
      ...buildStoreSuspendedEmail({
        storeName: "Acme Juice",
        suspendedOn: "30 Oct 2026",
        reasonKind: "court_order",
        reference: "SM-000124",
        storeMessage:
          defaultStoreMessage("court_order", "store") ??
          "We suspended your store.",
        complaintId: "c",
      }),
    },
    {
      id: "takedown-block-lifted",
      group,
      label: "Block lifted (a product)",
      ...buildBlockLiftedEmail(
        {
          storeName: "Acme Juice",
          kind: "product",
          itemLabel: "Almond Shake",
          liftNote: "We looked again and the listing meets our policies.",
        },
        SAMPLE_NOTICE,
      ),
    },
    {
      id: "takedown-suspension-lifted",
      group,
      label: "Suspension lifted",
      ...buildBlockLiftedEmail(
        { storeName: "Acme Juice", kind: "store", itemLabel: "" },
        SAMPLE_NOTICE,
      ),
    },
    {
      id: "takedown-replied",
      group,
      label: "StoreMink replied (a product)",
      ...buildStoreMinkRepliedEmail(
        {
          storeName: "Acme Juice",
          kind: "product",
          itemLabel: "Almond Shake",
          reply:
            "Thank you for the invoice. We are checking it with the person who complained and will write again within 2 days.",
          storeSuspended: false,
        },
        SAMPLE_NOTICE,
      ),
    },
    {
      id: "takedown-replied-suspended",
      group,
      label: "StoreMink replied (a suspended store)",
      ...buildStoreMinkRepliedEmail(
        {
          storeName: "Acme Juice",
          kind: "store",
          itemLabel: "",
          reply: "We received your letter and are reviewing the order.",
          storeSuspended: true,
        },
        SAMPLE_NOTICE,
      ),
    },
    {
      id: "takedown-complaint-acknowledgement",
      group,
      label: "Complaint acknowledged",
      ...buildAcknowledgementEmail({
        name: "Asha",
        receivedAt: "30 Oct 2026, 14:05 IST",
        reference: "SM-000123",
        kind: "intimate_or_impersonation",
        recorded: {
          summary:
            "A product page uses a photo of me without my permission and names me as the seller.",
          addresses: ["https://acme.storemink.com/shop/almond-shake"],
        },
      }),
    },
    {
      id: "takedown-complaint-outcome",
      group,
      label: "Complaint decision",
      ...buildOutcomeEmail({
        name: "Asha",
        reference: "SM-000123",
        outcome: "removed",
        note: "We blocked the product page and the photo on 30 Oct 2026.",
      }),
    },
  ];
}

export function renderEmailSamples(): EmailSample[] {
  return [
    ...accessSamples(),
    ...billingSamples(),
    ...storeSamples(),
    ...logoSamples(),
    ...announcementSamples(),
    ...takedownSamples(),
    ...notificationSamples(),
  ];
}
