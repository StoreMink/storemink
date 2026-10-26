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
  paymentFailedTemplate,
  paymentReceiptTemplate,
  planActivatedTemplate,
  planDowngradedTemplate,
  renewalDueTemplate,
  renewalOverdueTemplate,
  subscriptionCancelledTemplate,
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
        amountInr: 2400,
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
        amountInr: 2400,
        period: "monthly",
        renewsOn: "2026-11-07T00:00:00.000Z",
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
    {
      id: "billing-subscription-cancelled",
      group,
      label: "Subscription cancelled",
      ...subscriptionCancelledTemplate({
        ...base,
        accessUntil: "2026-11-07T00:00:00.000Z",
      }),
    },
    {
      id: "billing-renewal-due-autopay",
      group,
      label: "Renewal due, autopay",
      ...renewalDueTemplate({
        ...base,
        amountInr: 2400,
        dueOn: "2026-11-07T00:00:00.000Z",
        invoiceRef: "SM/2026-27/000142",
        autopay: true,
        previousAmountInr: 2000,
      }),
    },
    {
      id: "billing-renewal-due-manual",
      group,
      label: "Renewal due, pay manually",
      ...renewalDueTemplate({
        ...base,
        amountInr: 24000,
        dueOn: "2026-11-07T00:00:00.000Z",
        invoiceRef: "SM/2026-27/000143",
        autopay: false,
        previousAmountInr: 26000,
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
export function renderEmailSamples(): EmailSample[] {
  return [
    ...accessSamples(),
    ...billingSamples(),
    ...storeSamples(),
    ...logoSamples(),
    ...announcementSamples(),
    ...notificationSamples(),
  ];
}
