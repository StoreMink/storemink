/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: (fn: any) => fn(dbHolder.current.db),
}));

import {
  resolveBillingEmail,
  planActivatedTemplate,
  paymentReceiptTemplate,
  paymentFailedTemplate,
  subscriptionCancelledTemplate,
  planDowngradedTemplate,
  renewalDueTemplate,
  renewalOverdueTemplate,
  autopayStoppedTemplate,
  refundTemplate,
  refundSentTemplate,
  refundRecordedTemplate,
  istDate,
  emailTaxFromInvoice,
  invoicesUrl,
  manageUrl,
  type BuiltEmail,
  type EmailTax,
  type CancelledNextInvoice,
  type RefundCreditNote,
  type RefundEmailInput,
} from "./billing-emails";
import { PLATFORM_EMAIL_MARK_URL } from "./platform-brand";
import type { TaxTerms } from "@/lib/billing/tax-terms";

const MANAGE = "https://echos.storemink.com/dashboard/plans";
const INVOICES = `${MANAGE}/invoices`;
const LONG_DASH = /[\u2013\u2014]/;

/** The email's words with every tag removed: inlined styles sit on <strong>. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** A renewal invoice of ₹2,400 in each state the cancellation email names. */
function nextInvoice(status: string, inFlight = false): CancelledNextInvoice {
  return {
    status,
    totalPaise: 240000,
    invoiceRef: "SM/2026-27/000142",
    inFlight,
  };
}

/** The cancellation email's inputs for an ordinary merchant cancellation. */
const CANCEL_BASE = {
  storeName: "Echos",
  planName: "Pro",
  endsAt: "2026-11-07T00:00:00.000Z",
  inGrace: false,
  nextInvoice: null,
  requestedBy: "merchant" as const,
  storeSuspended: false,
  manageUrl: MANAGE,
};

/** Grace ends at 08:30 UTC, which is 14:00 in India. */
const GRACE = { endsAt: "2026-11-01T08:30:00.000Z", inGrace: true };

const CREDIT_NOTE: RefundCreditNote = {
  ref: "CN/2026-27/00001",
  issuedAt: "2026-11-07T06:30:00.000Z",
  invoiceRef: "SM/2026-27/000142",
  invoiceIssuedAt: "2026-11-03T04:30:00.000Z",
  supplier: {
    name: "STOREMINK LLP",
    address: { line1: "Bala ji Colony", city: "Faridkot" },
    gstin: "03ABCDE1234F1Z5",
  },
  recipient: {
    name: "Echos Pvt Ltd",
    address: { line1: "12 MG Road", city: "Bengaluru", postalCode: "560001" },
    gstin: null,
    stateCode: "29",
  },
  placeOfSupply: "29",
  taxablePaise: 203390,
  taxLines: [{ name: "IGST", rateBps: 1800, amountPaise: 36610 }],
  totalPaise: 240000,
};

/** A refund StoreMink sent through Razorpay, to an active store. */
const REFUND_BASE: Omit<RefundEmailInput, "kind"> = {
  storeName: "Echos",
  planName: "Pro",
  amountPaise: 240000,
  invoiceRef: "SM/2026-27/000142",
  method: "razorpay",
  reason: "cycle_not_reached",
  refundReference: "rfnd_Q1a2B3c4D5e6F7",
  creditNote: CREDIT_NOTE,
  storeState: "active",
  invoicesUrl: INVOICES,
};

/** Every builder and every variant, with a hostile store name throughout. */
function everyVariant(storeName: string): Record<string, BuiltEmail> {
  return {
    activatedAutopay: planActivatedTemplate({
      storeName,
      planName: "Basic",
      amountPaise: 50000,
      tax: null,
      period: "monthly",
      renewsOn: "2026-08-12T00:00:00.000Z",
      manageUrl: MANAGE,
    }),
    activatedManual: planActivatedTemplate({
      storeName,
      planName: "Pro",
      amountPaise: 2400000,
      tax: null,
      period: "yearly",
      renewsOn: null,
      manageUrl: MANAGE,
    }),
    receipt: paymentReceiptTemplate({
      storeName,
      planName: "Pro",
      amountPaise: 150000,
      tax: null,
      period: "monthly",
      renewsOn: "2026-08-12T00:00:00.000Z",
      manageUrl: MANAGE,
    }),
    failedRetrying: paymentFailedTemplate({
      storeName,
      planName: "Basic",
      final: false,
      accessUntil: null,
      manageUrl: MANAGE,
    }),
    failedFinal: paymentFailedTemplate({
      storeName,
      planName: "Basic",
      final: true,
      accessUntil: "2026-08-15T00:00:00.000Z",
      manageUrl: MANAGE,
    }),
    failedFinalNoDate: paymentFailedTemplate({
      storeName,
      planName: "Basic",
      final: true,
      accessUntil: null,
      manageUrl: MANAGE,
    }),
    receiptCancelling: paymentReceiptTemplate({
      storeName,
      planName: "Pro",
      amountPaise: 240000,
      tax: null,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
      cancelling: { endsAt: "2026-11-07T00:00:00.000Z", inGrace: false },
    }),
    cancelled: subscriptionCancelledTemplate({ ...CANCEL_BASE, storeName }),
    cancelledNoDate: subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      storeName,
      endsAt: null,
    }),
    cancelledOpen: subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      storeName,
      nextInvoice: nextInvoice("open"),
    }),
    cancelledInFlight: subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      storeName,
      nextInvoice: nextInvoice("processing", true),
    }),
    cancelledPaid: subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      storeName,
      nextInvoice: nextInvoice("paid"),
    }),
    cancelledGrace: subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      ...GRACE,
      storeName,
      nextInvoice: nextInvoice("open"),
    }),
    cancelledGraceInFlight: subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      ...GRACE,
      storeName,
      nextInvoice: nextInvoice("processing", true),
    }),
    cancelledByOperator: subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      storeName,
      requestedBy: "operator",
    }),
    refundSent: refundSentTemplate({ ...REFUND_BASE, storeName }),
    refundRecordedBank: refundRecordedTemplate({
      ...REFUND_BASE,
      storeName,
      method: "bank_transfer",
      refundReference: "HDFCR52026110712345",
    }),
    dueAutopay: renewalDueTemplate({
      storeName,
      planName: "Pro",
      amountPaise: 300000,
      tax: null,
      dueOn: "2026-10-06T00:00:00.000Z",
      invoiceRef: "SM/2026-27/0007",
      autopay: true,
      previousAmountPaise: 240000,
      manageUrl: MANAGE,
    }),
    dueManual: renewalDueTemplate({
      storeName,
      planName: "Pro",
      amountPaise: 2400000,
      tax: null,
      dueOn: "2026-10-06T00:00:00.000Z",
      invoiceRef: null,
      autopay: false,
      previousAmountPaise: 2600000,
      manageUrl: MANAGE,
    }),
    ...gstVariants(storeName),
    overdueAttempted: renewalOverdueTemplate({
      storeName,
      planName: "Pro",
      accessUntil: "2026-11-09T06:30:00.000Z",
      attempted: true,
      manageUrl: MANAGE,
    }),
    overdueUnattempted: renewalOverdueTemplate({
      storeName,
      planName: "Pro",
      accessUntil: "2026-11-09T06:30:00.000Z",
      attempted: false,
      manageUrl: MANAGE,
    }),
    downgraded: planDowngradedTemplate({
      storeName,
      fromPlanName: "Basic",
      manageUrl: MANAGE,
    }),
  };
}

/** GST at 18% added on top of ₹1,500 (design 7.7, ON-EX). */
const GST_ADDED: EmailTax = { taxPaise: 27000, ratePct: 18, inclusive: false };
/** GST at 18% inside ₹1,500 (design 7.7, ON-IN). */
const GST_INCLUDED: EmailTax = {
  taxPaise: 22881,
  ratePct: 18,
  inclusive: true,
};
/** 00:00 IST on 1 December 2026 is 18:30 UTC on 30 November. */
const GST_START = "2026-11-30T18:30:00.000Z";
/** No GST today; GST at 18% added on top from 1 Dec 2026 (SCHED-EX). */
const SCHEDULED: TaxTerms = {
  active: false,
  inclusive: false,
  rateBps: 0,
  upcoming: {
    enabled: true,
    inclusive: false,
    rateBps: 1800,
    startsAt: GST_START,
  },
};

/** The three amount-bearing emails in each GST state (GST Stage 6). */
function gstVariants(storeName: string): Record<string, BuiltEmail> {
  const base = { storeName, planName: "Basic", manageUrl: MANAGE };
  return {
    activatedGstAdded: planActivatedTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
      period: "monthly",
      renewsOn: GST_START,
    }),
    activatedGstIncluded: planActivatedTemplate({
      ...base,
      amountPaise: 150000,
      tax: GST_INCLUDED,
      period: "monthly",
      renewsOn: GST_START,
    }),
    activatedGstScheduled: planActivatedTemplate({
      ...base,
      amountPaise: 150000,
      tax: null,
      taxTerms: SCHEDULED,
      period: "monthly",
      renewsOn: null,
    }),
    receiptGstAdded: paymentReceiptTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
      period: "monthly",
      renewsOn: GST_START,
    }),
    receiptGstIncluded: paymentReceiptTemplate({
      ...base,
      amountPaise: 150000,
      tax: GST_INCLUDED,
      period: "yearly",
      renewsOn: null,
    }),
    dueGstStarted: renewalDueTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
      dueOn: GST_START,
      invoiceRef: "SM/2026-27/00211",
      autopay: true,
      previousAmountPaise: 150000,
      previousTax: null,
    }),
    dueGstBoth: renewalDueTemplate({
      ...base,
      amountPaise: 200600,
      tax: { taxPaise: 30600, ratePct: 18, inclusive: false },
      dueOn: GST_START,
      invoiceRef: "SM/2026-27/00212",
      autopay: false,
      previousAmountPaise: 150000,
      previousTax: null,
    }),
    dueGstIncluded: renewalDueTemplate({
      ...base,
      amountPaise: 150000,
      tax: GST_INCLUDED,
      dueOn: GST_START,
      invoiceRef: "SM/2026-27/00213",
      autopay: false,
      previousAmountPaise: 150000,
      previousTax: GST_INCLUDED,
    }),
  };
}

/**
 * The variants for a store whose dashboard is closed (suspended or deleted):
 * they must link to no dashboard at all.
 */
function closedVariants(storeName: string): Record<string, BuiltEmail> {
  return {
    cancelledSuspended: subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      storeName,
      requestedBy: "operator",
      storeSuspended: true,
    }),
    refundSuspended: refundSentTemplate({
      ...REFUND_BASE,
      storeName,
      storeState: "suspended",
      invoicesUrl: null,
    }),
    refundDeleted: refundSentTemplate({
      ...REFUND_BASE,
      storeName,
      storeState: "deleted",
      invoicesUrl: null,
    }),
    refundDeletedNoNote: refundRecordedTemplate({
      ...REFUND_BASE,
      storeName,
      creditNote: null,
      storeState: "deleted",
      invoicesUrl: null,
    }),
  };
}

function allVariants(storeName: string): Record<string, BuiltEmail> {
  return { ...everyVariant(storeName), ...closedVariants(storeName) };
}

describe("billing email templates", () => {
  it("plan activated: includes plan, price, renewal", () => {
    const e = planActivatedTemplate({
      storeName: "Echos",
      planName: "Basic",
      amountPaise: 50000,
      tax: null,
      period: "monthly",
      renewsOn: "2026-08-12T00:00:00.000Z",
      manageUrl: MANAGE,
    });
    expect(e.subject).toBe("You're on the Basic plan");
    expect(e.html).toContain("₹500/month");
    expect(e.html).toContain("12 Aug 2026");
    expect(e.html).toContain(MANAGE);
    expect(e.html).toContain("renews automatically");
  });

  it("★ plan activated with no renewal date never claims autopay", () => {
    // receipts.ts withholds the date when there is no mandate. Telling that
    // merchant the plan renews automatically is how they do nothing and are
    // downgraded.
    const e = planActivatedTemplate({
      storeName: "Echos",
      planName: "Pro",
      amountPaise: 2400000,
      tax: null,
      period: "yearly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(e.html).toContain("₹24,000/year");
    expect(e.html).not.toMatch(/autopay/i);
    expect(e.html).not.toContain("renews automatically");
    expect(e.html).not.toContain("Renews on");
    expect(e.html).toContain("email you before your next renewal");
  });

  it("the welcome headline carries no emoji", () => {
    const e = planActivatedTemplate({
      storeName: "Echos",
      planName: "Pro",
      amountPaise: 240000,
      tax: null,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(e.html).toContain("Welcome to Pro</h1>");
    expect(e.html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("payment receipt: shows the charged amount", () => {
    const e = paymentReceiptTemplate({
      storeName: "Echos",
      planName: "Pro",
      amountPaise: 150000,
      tax: null,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(e.subject).toBe("Payment received for your Pro plan");
    expect(e.html).toContain("₹1,500");
    expect(e.html).toContain("billed monthly");
    expect(e.html).not.toContain("Renews on");
  });

  it("payment failed: retry vs final wording differ", () => {
    const retry = paymentFailedTemplate({
      storeName: "Echos",
      planName: "Basic",
      final: false,
      accessUntil: null,
      manageUrl: MANAGE,
    });
    const final = paymentFailedTemplate({
      storeName: "Echos",
      planName: "Basic",
      final: true,
      accessUntil: "2026-08-15T00:00:00.000Z",
      manageUrl: MANAGE,
    });
    expect(retry.subject).toBe("We couldn't process your Basic payment");
    expect(retry.html).toMatch(/retry/i);
    expect(retry.html).not.toMatch(/action needed/i);
    expect(final.subject).toBe(
      "Action needed: your Basic plan is about to end",
    );
    expect(final.html).toMatch(/action needed/i);
    expect(final.html).toContain("15 Aug 2026");
    expect(final.html).not.toMatch(/retry/i);
  });

  it("downgrade: reassures data is safe", () => {
    const e = planDowngradedTemplate({
      storeName: "Echos",
      fromPlanName: "Basic",
      manageUrl: MANAGE,
    });
    expect(e.subject).toMatch(/free plan/i);
    expect(e.html).toMatch(/nothing was deleted/i);
  });

  it("escapes HTML in the store name", () => {
    const e = planActivatedTemplate({
      storeName: "<script>x</script>",
      planName: "Basic",
      amountPaise: 50000,
      tax: null,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(e.html).not.toContain("<script>x</script>");
    expect(e.html).toContain("&lt;script&gt;");
  });

  it("★ escapes the store name in every variant, footer included", () => {
    for (const [name, e] of Object.entries(allVariants("<b>Evil</b>"))) {
      expect(e.html, name).not.toContain("<b>Evil</b>");
      expect(e.html, name).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    }
  });

  it("★ every variant wears StoreMink's own header and footer", () => {
    for (const [name, e] of Object.entries(allVariants("Echos"))) {
      expect(e.html, name).toContain('class="sm-email-canvas"');
      expect(e.html, name).toContain(PLATFORM_EMAIL_MARK_URL);
      expect(e.html, name).toContain("Echos's StoreMink subscription");
      expect(e.html, name).toContain("The StoreMink team");
    }
  });

  it("★ a store with an open dashboard gets a link into it", () => {
    for (const [name, e] of Object.entries(everyVariant("Echos"))) {
      expect(e.html, name).toContain(MANAGE);
    }
  });

  it("★★ a closed dashboard is never linked: suspended or deleted", () => {
    for (const [name, e] of Object.entries(closedVariants("Echos"))) {
      expect(e.html, name).not.toContain("/dashboard");
      expect(e.html, name).toContain("support@storemink.com");
    }
  });

  it("★ the billing page has one name everywhere", () => {
    for (const [name, e] of Object.entries(allVariants("Echos"))) {
      expect(e.html, name).not.toContain("Plan &amp; billing");
      expect(e.html, name).not.toContain("Plan & billing");
      expect(e.subject, name).not.toMatch(/plan & billing/i);
    }
  });

  it("★ no long dash in any subject or body", () => {
    for (const [name, e] of Object.entries(allVariants("Echos"))) {
      expect(e.subject, name).not.toMatch(LONG_DASH);
      expect(e.html, name).not.toMatch(LONG_DASH);
      expect(e.html, name).not.toContain("\u2014");
      expect(e.html, name).not.toContain("\u2013");
    }
  });
});

describe("istDate: India time, whatever the server's zone", () => {
  it("names the day in India, not UTC", () => {
    // 20:00 UTC on 31 Oct is already 1 Nov in India.
    expect(istDate("2026-10-31T20:00:00.000Z")).toBe("1 Nov 2026");
  });

  it("adds the time in India with the zone named", () => {
    expect(istDate("2026-11-01T08:30:00.000Z", { time: true })).toBe(
      "1 Nov 2026, 14:00 IST",
    );
  });

  it("returns the input unchanged when it is not a date", () => {
    expect(istDate("not a date")).toBe("not a date");
  });
});

describe("subscriptionCancelledTemplate: what they keep and what comes back", () => {
  it("names the plan, the end date and the button, and turns autopay off", () => {
    const e = subscriptionCancelledTemplate(CANCEL_BASE);
    expect(e.subject).toBe("Your Pro subscription is cancelled");
    expect(e.html).toContain("Your subscription is cancelled</h1>");
    expect(text(e.html)).toContain(
      "Echos's Pro plan is cancelled and won't renew. Autopay is turned off.",
    );
    expect(text(e.html)).toContain(
      "You keep Pro until 7 Nov 2026, then the store moves to the Free plan.",
    );
    expect(e.html).toContain(
      "Changed your mind? Open Plans &amp; Billing and choose Keep my plan before 7 Nov 2026.",
    );
    expect(e.html).toContain("Manage your plan");
    expect(e.html).not.toMatch(/re-subscribe/i);
  });

  it("with no paid cycle, says only that no more payments are taken", () => {
    const e = subscriptionCancelledTemplate({ ...CANCEL_BASE, endsAt: null });
    expect(e.html).toContain("No further payments will be taken.");
    expect(e.html).toContain("choose Keep my plan.</p>");
  });

  it("★ an issued renewal invoice won't be charged, named by its number", () => {
    const e = subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      nextInvoice: nextInvoice("open"),
    });
    expect(e.html).toContain(
      "Your renewal invoice SM/2026-27/000142 won't be charged.",
    );
    expect(e.html).not.toContain("we refund");
  });

  it("★★ a payment under way is refunded if it goes through", () => {
    const e = subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      nextInvoice: nextInvoice("processing", true),
    });
    expect(e.html).toContain(
      "A renewal payment of ₹2,400 was already under way when you cancelled. If it goes through, we refund it after your plan ends, usually within 5 working days.",
    );
  });

  it("★★ a renewal already paid is refunded after the plan ends", () => {
    const e = subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      nextInvoice: nextInvoice("paid"),
    });
    expect(e.html).toContain(
      "We refund your renewal payment of ₹2,400 after your plan ends, usually within 5 working days.",
    );
    expect(e.html).not.toContain("when your plan ends");
  });

  it("an attempt with a known amount in paise keeps its paise", () => {
    const e = subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      nextInvoice: { ...nextInvoice("paid"), totalPaise: 123450 },
    });
    expect(e.html).toContain("₹1,234.50");
  });

  it("a draft or closed invoice is not mentioned at all", () => {
    for (const status of ["draft", "void", "uncollectible"]) {
      const e = subscriptionCancelledTemplate({
        ...CANCEL_BASE,
        nextInvoice: nextInvoice(status),
      });
      expect(text(e.html), status).toContain(
        "You keep Pro until 7 Nov 2026, then the store moves to the Free plan.",
      );
      expect(e.html, status).not.toContain("won't be charged");
      expect(e.html, status).not.toContain("under way");
      expect(e.html, status).not.toContain("we refund");
    }
  });

  it("★★ during grace the plan ends at a time, in India", () => {
    const e = subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      ...GRACE,
      nextInvoice: nextInvoice("open"),
    });
    expect(text(e.html)).toContain(
      "Your renewal hasn't been paid, so Pro ends on 1 Nov 2026, 14:00 IST and the store moves to the Free plan. Your unpaid invoice won't be charged.",
    );
    expect(e.html).toContain("Keep my plan before 1 Nov 2026, 14:00 IST.");
  });

  it("during grace with nothing issued, says the renewal hasn't been paid", () => {
    const e = subscriptionCancelledTemplate({ ...CANCEL_BASE, ...GRACE });
    expect(text(e.html)).toContain(
      "Your renewal hasn't been paid, so Pro ends on 1 Nov 2026, 14:00 IST and the store moves to the Free plan.",
    );
    expect(e.html).not.toContain("won't be charged");
    expect(e.html).not.toContain("we refund");
  });

  it("during grace, a payment under way is refunded if it goes through", () => {
    const e = subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      ...GRACE,
      nextInvoice: nextInvoice("processing", true),
    });
    expect(text(e.html)).toContain(
      "Pro ends on 1 Nov 2026, 14:00 IST and the store moves to the Free plan. A renewal payment of ₹2,400 was already under way when you cancelled. If it goes through, we refund it.",
    );
  });

  it("during grace, a renewal paid since is refunded", () => {
    const e = subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      ...GRACE,
      nextInvoice: nextInvoice("paid"),
    });
    expect(e.html).toContain(
      "We refund your renewal payment of ₹2,400 after your plan ends, usually within 5 working days.",
    );
  });

  it("★ a cancellation StoreMink made says it was the merchant's request", () => {
    const e = subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      requestedBy: "operator",
    });
    expect(text(e.html)).toContain(
      "As you asked, we've cancelled Echos's Pro plan. It won't renew, and autopay is turned off.",
    );
  });

  it("★★ a suspended store is sent to support, with no button", () => {
    const e = subscriptionCancelledTemplate({
      ...CANCEL_BASE,
      requestedBy: "operator",
      storeSuspended: true,
    });
    expect(e.html).toContain(
      "Changed your mind? Write to support@storemink.com before 7 Nov 2026.",
    );
    expect(e.html).not.toContain("Manage your plan");
    expect(e.html).not.toContain("Keep my plan");
    expect(e.html).not.toContain(MANAGE);
  });
});

describe("paymentReceiptTemplate: a payment for a cancelled plan's next cycle", () => {
  const base = {
    storeName: "Echos",
    planName: "Pro",
    amountPaise: 240000,
    tax: null,
    period: "monthly" as const,
    renewsOn: null,
    manageUrl: MANAGE,
  };

  it("★★ says the payment comes back and names no renewal", () => {
    const e = paymentReceiptTemplate({
      ...base,
      cancelling: { endsAt: "2026-11-07T00:00:00.000Z", inGrace: false },
    });
    expect(text(e.html)).toContain(
      "You've cancelled your plan, so we refund this payment after your plan ends on 7 Nov 2026, usually within 5 working days, unless you choose Keep my plan before then.",
    );
    expect(e.html).toContain(
      "Your invoices are in Plans &amp; Billing whenever you need them.",
    );
    expect(e.html).not.toContain("Your plan is active.");
    expect(e.html).not.toContain("Renews on");
  });

  it("a plan cancelled in grace names the time it ends", () => {
    const e = paymentReceiptTemplate({
      ...base,
      cancelling: { endsAt: "2026-11-01T08:30:00.000Z", inGrace: true },
    });
    expect(text(e.html)).toContain("1 Nov 2026, 14:00 IST");
  });

  it("an ordinary receipt is unchanged", () => {
    const e = paymentReceiptTemplate({ ...base, cancelling: null });
    expect(e.html).toContain(
      "Your plan is active. Your invoices are in Plans &amp; Billing whenever you need them.",
    );
    expect(e.html).not.toContain("we refund");
  });
});

describe("refundTemplate: one builder for a refund sent and one recorded", () => {
  it("★ a refund sent through Razorpay is on its way to the card", () => {
    const e = refundSentTemplate(REFUND_BASE);
    expect(e.subject).toBe("Your refund of ₹2,400");
    expect(e.html).toContain("Refund on its way</h1>");
    expect(text(e.html)).toContain(
      "We've refunded ₹2,400 to the account or card you paid with, for invoice SM/2026-27/000142.",
    );
    expect(e.html).toContain(
      "Your bank or card issuer decides when it shows in your account, usually within a few working days.",
    );
    expect(e.html).toContain("rfnd_Q1a2B3c4D5e6F7");
    expect(e.html).toContain("CN/2026-27/00001");
  });

  it("★ a bank transfer recorded is made, with its UTR", () => {
    const e = refundRecordedTemplate({
      ...REFUND_BASE,
      method: "bank_transfer",
      amountPaise: 123450,
      refundReference: "HDFCR52026110712345",
    });
    expect(e.subject).toBe("Your refund of ₹1,234.50");
    expect(e.html).toContain("Refund made</h1>");
    expect(text(e.html)).toContain(
      "We've refunded ₹1,234.50 by bank transfer, reference HDFCR52026110712345, for invoice SM/2026-27/000142.",
    );
    expect(e.html).not.toContain("card issuer");
  });

  it("a Razorpay refund recorded by hand reads like one sent", () => {
    const e = refundRecordedTemplate(REFUND_BASE);
    expect(e.html).toContain("Refund on its way</h1>");
    expect(e.html).toContain("to the account or card you paid with");
  });

  it("sent and recorded are the same builder with a kind", () => {
    expect(refundSentTemplate(REFUND_BASE)).toEqual(
      refundTemplate({ ...REFUND_BASE, kind: "sent" }),
    );
    expect(refundRecordedTemplate(REFUND_BASE)).toEqual(
      refundTemplate({ ...REFUND_BASE, kind: "recorded" }),
    );
  });

  it("★ each reason has its own sentence; goodwill and other have none", () => {
    const sentence = (reason: string) =>
      refundSentTemplate({ ...REFUND_BASE, reason }).html;
    expect(sentence("cycle_not_reached")).toContain(
      "Your Pro plan ended before the period this payment was for, so you aren't charged for it.",
    );
    expect(sentence("feature_removed")).toContain(
      "This refunds the part of your cycle after a main feature of your plan was removed.",
    );
    expect(sentence("suspended_by_mistake")).toContain(
      "This refunds the time your store was suspended by mistake.",
    );
    expect(sentence("declined_terms")).toContain(
      "This refunds the part of your cycle that was left when your plan ended.",
    );
    expect(sentence("duplicate_payment")).toContain(
      "You paid this invoice twice. This returns the extra payment.",
    );
    for (const reason of ["goodwill", "other"]) {
      const html = sentence(reason);
      expect(html, reason).not.toContain("This refunds");
      expect(html, reason).not.toContain("paid this invoice twice");
      expect(html, reason).not.toContain("plan ended before");
    }
  });

  it("an unnamed plan still reads as a sentence", () => {
    const e = refundSentTemplate({ ...REFUND_BASE, planName: null });
    expect(e.html).toContain(
      "Your plan ended before the period this payment was for",
    );
  });

  it("★ an active store is linked to its invoices and gets no particulars", () => {
    const e = refundSentTemplate(REFUND_BASE);
    expect(e.html).toContain(INVOICES);
    expect(e.html).toContain("View your invoices");
    expect(e.html).not.toContain("Total credited");
    expect(e.html).not.toContain("Keep this email");
  });

  it("★★ a suspended store gets the credit note's particulars and no link", () => {
    const e = refundSentTemplate({
      ...REFUND_BASE,
      storeState: "suspended",
      invoicesUrl: INVOICES,
    });
    expect(e.html).not.toContain("/dashboard");
    expect(e.html).not.toContain("View your invoices");
    expect(e.html).toContain(
      "Keep this email as your credit note. Write to support@storemink.com if you have a question.",
    );
    for (const label of [
      "Credit note no.",
      "Against invoice",
      "Invoice date",
      "Taxable value",
      "IGST 18%",
      "Total credited",
    ]) {
      expect(e.html, label).toContain(label);
    }
    expect(e.html).toContain("₹2,033.90");
    expect(e.html).toContain("₹366.10");
    expect(e.html).toContain("STOREMINK LLP");
    expect(e.html).toContain("GSTIN: 03ABCDE1234F1Z5");
    expect(e.html).toContain("State: Punjab (03)");
    expect(e.html).toContain("3 Nov 2026");
  });

  // R2-02: an unregistered customer's State is printed WITH its code (CGST
  // rule 53(1A)(f)) under their name, and the place of supply on its own row,
  // never the customer's State under that name.
  it("an unregistered, taxed note: the customer's State with its code, and the place of supply", () => {
    const e = refundSentTemplate({
      ...REFUND_BASE,
      storeState: "deleted",
      invoicesUrl: null,
    });
    expect(e.html).toContain("State: Karnataka (29)");
    expect(e.html).toMatch(/Place of supply[\s\S]*Karnataka \(29\)/);
    expect(e.html).not.toContain("Place of supply: ");
  });

  it("a supply outside India prints 96 as the place of supply and no customer State", () => {
    const e = refundSentTemplate({
      ...REFUND_BASE,
      storeState: "deleted",
      invoicesUrl: null,
      creditNote: {
        ...CREDIT_NOTE,
        placeOfSupply: "96",
        recipient: { ...CREDIT_NOTE.recipient, stateCode: null },
      },
    });
    expect(e.html).toContain("Outside India (96)");
    expect(e.html).not.toContain("State: Karnataka");
    // The supplier's own State beside its GSTIN is the only State line.
    expect(e.html.match(/State: /g)).toHaveLength(1);
  });

  it("a supplier fallback prints the place of supply but no customer State", () => {
    const e = refundSentTemplate({
      ...REFUND_BASE,
      storeState: "deleted",
      invoicesUrl: null,
      creditNote: {
        ...CREDIT_NOTE,
        placeOfSupply: "03",
        recipient: { ...CREDIT_NOTE.recipient, stateCode: null },
      },
    });
    expect(e.html).toMatch(/Place of supply[\s\S]*Punjab \(03\)/);
    expect(e.html).not.toContain("State: Karnataka");
    expect(e.html.match(/State: /g)).toHaveLength(1);
  });

  it("an untaxed note prints neither the place of supply, a State nor a GSTIN", () => {
    const e = refundSentTemplate({
      ...REFUND_BASE,
      storeState: "deleted",
      invoicesUrl: null,
      creditNote: { ...CREDIT_NOTE, taxLines: [], taxablePaise: 240000 },
    });
    expect(e.html).toContain("Total credited");
    expect(e.html).not.toContain("Place of supply");
    expect(e.html).not.toContain("State: ");
    expect(e.html).not.toContain("GSTIN");
  });

  it("a note built before the place of supply was carried prints no such row", () => {
    const { placeOfSupply: _omit, ...legacy } = CREDIT_NOTE;
    void _omit;
    const e = refundSentTemplate({
      ...REFUND_BASE,
      storeState: "deleted",
      invoicesUrl: null,
      creditNote: legacy,
    });
    expect(e.html).not.toContain("Place of supply");
    expect(e.html).toContain("State: Karnataka (29)");
  });

  it("a recipient with a GSTIN is named by it, not their State", () => {
    const e = refundSentTemplate({
      ...REFUND_BASE,
      storeState: "deleted",
      invoicesUrl: null,
      creditNote: {
        ...CREDIT_NOTE,
        recipient: { ...CREDIT_NOTE.recipient, gstin: "29ABCDE1234F1Z5" },
      },
    });
    expect(e.html).toContain("GSTIN: 29ABCDE1234F1Z5");
    expect(e.html).not.toContain("State: Karnataka");
  });

  // R2-09: the closed-store email carries the sheet's LLP line, escaped, and
  // none without an LLPIN or a recorded legal name.
  it("prints the LLP line the note recorded", () => {
    const e = refundSentTemplate({
      ...REFUND_BASE,
      storeState: "deleted",
      invoicesUrl: null,
      creditNote: {
        ...CREDIT_NOTE,
        supplier: {
          ...CREDIT_NOTE.supplier,
          llpin: "ADC-5432",
          registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
        },
      },
    });
    expect(e.html).toContain(
      "STOREMINK LLP is registered with limited liability. LLPIN ADC-5432. Registered office: Bala ji Colony, Faridkot, Punjab, India.",
    );
    const hostile = refundSentTemplate({
      ...REFUND_BASE,
      storeState: "deleted",
      invoicesUrl: null,
      creditNote: {
        ...CREDIT_NOTE,
        supplier: {
          ...CREDIT_NOTE.supplier,
          llpin: "ADC-5432",
          registeredOffice: "<b>office</b>",
        },
      },
    });
    expect(hostile.html).not.toContain("<b>office</b>");
    expect(hostile.html).toContain("&lt;b&gt;office&lt;/b&gt;");
    expect(
      refundSentTemplate({
        ...REFUND_BASE,
        storeState: "deleted",
        invoicesUrl: null,
      }).html,
    ).not.toContain("registered with limited liability");
    expect(
      refundSentTemplate({
        ...REFUND_BASE,
        storeState: "deleted",
        invoicesUrl: null,
        creditNote: {
          ...CREDIT_NOTE,
          supplier: { ...CREDIT_NOTE.supplier, name: null, llpin: "ADC-5432" },
        },
      }).html,
    ).not.toContain("registered with limited liability");
    // An active store's email links to the sheet and prints no particulars.
    expect(
      refundSentTemplate({
        ...REFUND_BASE,
        creditNote: {
          ...CREDIT_NOTE,
          supplier: { ...CREDIT_NOTE.supplier, llpin: "ADC-5432" },
        },
      }).html,
    ).not.toContain("registered with limited liability");
  });

  it("an intra-state note prints CGST and SGST", () => {
    const e = refundSentTemplate({
      ...REFUND_BASE,
      storeState: "deleted",
      invoicesUrl: null,
      creditNote: {
        ...CREDIT_NOTE,
        taxLines: [
          { name: "CGST", rateBps: 900, amountPaise: 18305 },
          { name: "SGST", rateBps: 900, amountPaise: 18305 },
        ],
      },
    });
    expect(e.html).toContain("CGST 9%");
    expect(e.html).toContain("SGST 9%");
    expect(e.html).not.toContain("IGST");
  });

  it("★ a deleted store with no credit note is pointed at support", () => {
    const e = refundRecordedTemplate({
      ...REFUND_BASE,
      creditNote: null,
      storeState: "deleted",
      invoicesUrl: null,
    });
    expect(e.html).toContain(
      "Write to support@storemink.com if you have a question.",
    );
    expect(e.html).not.toContain("Keep this email");
    expect(e.html).not.toContain("Credit note no.");
  });

  it("escapes every reference it prints", () => {
    const e = refundRecordedTemplate({
      ...REFUND_BASE,
      method: "bank_transfer",
      invoiceRef: "<i>x</i>",
      refundReference: "<b>utr</b>",
      storeState: "deleted",
      invoicesUrl: null,
      creditNote: { ...CREDIT_NOTE, ref: "<u>cn</u>" },
    });
    expect(e.html).not.toContain("<i>x</i>");
    expect(e.html).not.toContain("<b>utr</b>");
    expect(e.html).not.toContain("<u>cn</u>");
    expect(e.html).toContain("&lt;b&gt;utr&lt;/b&gt;");
  });

  it("names no credit figure", () => {
    const e = refundSentTemplate(REFUND_BASE);
    expect(e.html).not.toMatch(/\bcredits?\b(?! note)/i);
  });
});

describe("billing links", () => {
  it("the invoices page sits under Plans & Billing", () => {
    expect(invoicesUrl("echos")).toBe(`${manageUrl("echos")}/invoices`);
  });
});

describe("renewalDueTemplate: autopay is a heads-up, manual is a bill", () => {
  const base = {
    storeName: "Echos",
    planName: "Pro",
    amountPaise: 300000,
    tax: null,
    dueOn: "2026-10-06T00:00:00.000Z",
    invoiceRef: "SM/2026-27/0007",
    manageUrl: MANAGE,
  };

  it("autopay tells the merchant there is nothing to do", () => {
    const e = renewalDueTemplate({ ...base, autopay: true });
    // India time, no leading zero (GST plan default P-2): was "06 Oct 2026".
    expect(e.subject).toBe("Your Pro plan renews on 6 Oct 2026");
    expect(e.html).toContain("nothing you need to do");
    expect(e.html).toContain("Manage your plan");
    expect(e.html).not.toContain("Pay now");
    expect(e.html).toContain("SM/2026-27/0007");
  });

  it("★ autopay says how to stop it, and that a payment taken comes back", () => {
    const e = renewalDueTemplate({ ...base, autopay: true });
    expect(e.html).toContain(
      "Not renewing? If you cancel before 6 Oct 2026, your plan ends that day and we refund any payment we've taken for the next cycle.",
    );
  });

  it("★ the bill says cancelling means it won't be charged", () => {
    const e = renewalDueTemplate({ ...base, autopay: false });
    expect(e.html).toContain(
      "Not renewing? Cancel in Plans &amp; Billing and this invoice won't be charged.",
    );
    expect(e.html).not.toContain("we refund");
  });

  it("★★ manual is a bill with a deadline and the grace warning", () => {
    const e = renewalDueTemplate({ ...base, autopay: false });
    expect(e.subject).toBe("₹3,000 due for your Pro plan");
    expect(e.html).toContain("payable by");
    expect(e.html).toContain("48 hours");
    expect(e.html).toContain("Pay now");
    expect(e.html).not.toContain("nothing you need to do");
  });

  it("escapes the invoice reference and omits it when absent", () => {
    const withRef = renewalDueTemplate({
      ...base,
      autopay: false,
      invoiceRef: "<i>x</i>",
    });
    expect(withRef.html).toContain("&lt;i&gt;x&lt;/i&gt;");
    const withoutRef = renewalDueTemplate({
      ...base,
      autopay: false,
      invoiceRef: null,
    });
    expect(withRef.html).toContain(">Invoice</strong>");
    expect(withoutRef.html).not.toContain(">Invoice</strong>");
  });
});

describe("renewalOverdueTemplate: `attempted` must be truthful", () => {
  const base = {
    storeName: "Echos",
    planName: "Pro",
    accessUntil: "2026-11-09T06:30:00.000Z",
    manageUrl: MANAGE,
  };

  it("names the deadline in IST and the subject has no long dash", () => {
    const e = renewalOverdueTemplate({ ...base, attempted: true });
    expect(e.subject).toBe("Payment overdue: your Pro plan ends in 48 hours");
    // No leading zero, like every other billing date: was "09 Nov".
    expect(e.html).toContain("9 Nov, 12:00 IST");
    expect(e.html).not.toContain("09 Nov");
    expect(e.html).toContain("including POS");
  });

  it("★ only says we couldn't collect when a charge was attempted", () => {
    const attempted = renewalOverdueTemplate({ ...base, attempted: true });
    const unattempted = renewalOverdueTemplate({ ...base, attempted: false });
    expect(attempted.html).toContain("We couldn't collect payment");
    expect(unattempted.html).not.toContain("couldn't collect");
    expect(unattempted.html).toContain("renewal hasn't been paid");
  });
});

describe("autopayStoppedTemplate: automatic collection stopped, pay by hand", () => {
  const base = {
    storeName: "Echos",
    planName: "Pro",
    amountPaise: 240_000,
    tax: null,
    invoiceRef: "SM/2026-27/00042",
    attempts: 3,
    manageUrl: MANAGE,
  };

  it("★★ says how many tries, that no more will be made, and asks for payment by the renewal day", () => {
    const e = autopayStoppedTemplate({
      ...base,
      payBy: "2026-11-07T06:30:00.000Z",
    });
    expect(e.subject).toBe("Action needed: pay ₹2,400 for your Pro plan");
    expect(e.html).toContain("We tried 3 times");
    expect(e.html).toContain("We won't try again automatically");
    expect(e.html).toContain("7 Nov 2026");
    expect(e.html).toContain("48 hours' grace");
    expect(e.html).toContain("SM/2026-27/00042");
    expect(e.html).toContain("Pay now");
    expect(e.html).toContain(MANAGE);
  });

  // 21 Nov 2026: the mandate itself was cancelled or paused at the bank, so
  // counting tries would be untrue (there may have been none).
  it("★★ a mandate that is gone says so, and never counts tries", () => {
    const e = autopayStoppedTemplate({
      ...base,
      attempts: 0,
      cause: "mandate",
      payBy: "2026-11-07T06:30:00.000Z",
    });
    expect(e.subject).toBe("Action needed: pay ₹2,400 for your Pro plan");
    expect(e.html).toContain("Autopay is no longer active");
    expect(e.html).toContain(
      "has been cancelled or paused with your bank or card",
    );
    expect(e.html).not.toContain("We tried");
    expect(e.html).not.toContain("0 times");
    expect(e.html).toContain("7 Nov 2026");
    expect(e.html).toContain("Pay now");
    expect(e.subject + e.html).not.toContain("\u2014");
  });

  it("with no cause given it is the tries-used message", () => {
    const e = autopayStoppedTemplate({ ...base, payBy: null });
    expect(e.html).toContain("Automatic payment didn&#39;t go through");
    expect(e.html).not.toContain("Autopay is no longer active");
  });

  it("★ after the renewal day it names no date, only what an unpaid renewal leads to", () => {
    const e = autopayStoppedTemplate({ ...base, payBy: null });
    expect(e.html).not.toContain("Pay by");
    expect(e.html).toContain("as soon as you can");
    expect(e.html).toContain("48 hours after it falls due");
  });

  it("one try reads as once; the store name is escaped; no long dash anywhere", () => {
    const e = autopayStoppedTemplate({
      ...base,
      storeName: "A<b>",
      attempts: 1,
      payBy: null,
    });
    expect(e.html).toContain("We tried once");
    expect(e.html).not.toContain("A<b>");
    expect(e.subject + e.html).not.toContain("\u2014");
  });
});

/**
 * ★★ THE REGRESSION THIS PINS: no phone, no subscription.
 *
 * `startEnrolment` refuses before Razorpay unless it gets BOTH fields back, so
 * a null phone here is not a cosmetic omission: it is a store that cannot
 * subscribe at all. `admins.phone` was the only source and signup never wrote
 * it, which took every wizard-created store's Subscribe button out of service.
 */
describe("renewalDueTemplate: naming a reprice", () => {
  const base = {
    storeName: "Echos",
    planName: "Pro",
    amountPaise: 300000,
    tax: null,
    dueOn: "2026-10-06T00:00:00.000Z",
    invoiceRef: "SM/2026-27/0007",
    autopay: true,
    manageUrl: MANAGE,
  };

  it("★★ says a rise is a rise, in both the autopay and the bill wording", () => {
    // The amount alone does not tell a merchant it CHANGED; they would have to
    // remember last cycle's figure. An unexplained larger debit is what turns
    // an operator reprice into a chargeback.
    for (const autopay of [true, false]) {
      const e = renewalDueTemplate({
        ...base,
        autopay,
        previousAmountPaise: 240000,
      });
      expect(e.html).toContain("an increase");
      expect(e.html).toContain("₹2,400");
      // The previous amount is set in bold, as before.
      // R2-06: no cause is named; the previous invoice may be a different
      // plan, period or location count.
      expect(text(e.html)).toContain(
        "This is an increase from ₹2,400 last time.",
      );
      expect(e.html).not.toContain("Plan prices changed");
      expect(e.html).toMatch(/<strong[^>]*>₹2,400<\/strong> last time/);
    }
  });

  it("★ calls a reduction a reduction", () => {
    // "Your price has changed" reads as a rise to everyone, so a merchant whose
    // bill went DOWN would write in to ask what went wrong.
    const e = renewalDueTemplate({ ...base, previousAmountPaise: 400000 });
    expect(e.html).toContain("a reduction");
    expect(text(e.html)).toContain(
      "This is a reduction from ₹4,000 last time.",
    );
    expect(e.html).not.toContain("Plan prices changed");
    expect(e.html).not.toContain("an increase");
  });

  it("★ stays silent when the price did not move", () => {
    // Noise on an unchanged bill is what teaches people to stop reading
    // billing email, the one channel that must still be read.
    for (const previousAmountPaise of [300000, null, undefined]) {
      const e = renewalDueTemplate({ ...base, previousAmountPaise });
      expect(e.html).not.toContain("an increase");
      expect(e.html).not.toContain("a reduction");
      expect(e.html).not.toContain("last time");
    }
  });
});

describe("resolveBillingEmail", () => {
  const STORE = "store-1";
  const store = [{ name: "Echos", slug: "echos" }];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function seed(owner: any[], billing: any[]) {
    dbHolder.current = makeDbMock({ selectQueue: [store, owner, billing] });
  }

  it("prefers the owner's own verified number", async () => {
    seed(
      [{ email: "owner@echos.test", phone: "+919000000001" }],
      [{ contact_email: "billing@echos.test", contact_phone: "+919000000002" }],
    );
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      email: "owner@echos.test",
      phone: "+919000000001",
    });
  });

  it("★★ falls back to the invoice contact phone when the admin row has none", async () => {
    seed(
      [{ email: "owner@echos.test", phone: null }],
      [{ contact_email: null, contact_phone: "+919814468834" }],
    );
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      email: "owner@echos.test",
      phone: "+919814468834",
    });
  });

  it("normalises the invoice contact phone to E.164", async () => {
    seed(
      [{ email: "owner@echos.test", phone: null }],
      [{ contact_email: null, contact_phone: "98144 68834" }],
    );
    expect((await resolveBillingEmail(STORE))?.phone).toBe("+919814468834");
  });

  it("★ refuses a landline or placeholder rather than registering an unreachable mandate", async () => {
    seed(
      [{ email: "owner@echos.test", phone: null }],
      [{ contact_email: null, contact_phone: "022-24001234" }],
    );
    expect((await resolveBillingEmail(STORE))?.phone).toBeNull();
  });

  it("never pairs the owner's number with someone else's billing email", async () => {
    seed([], [{ contact_email: "billing@echos.test", contact_phone: null }]);
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      email: "billing@echos.test",
      phone: null,
    });
  });

  it("is null when no email exists at all", async () => {
    seed([], [{ contact_email: null, contact_phone: "+919814468834" }]);
    expect(await resolveBillingEmail(STORE)).toBeNull();
  });

  it("★ reports the store's status, so a suspended store is not linked in", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ name: "Echos", slug: "echos", status: "suspended" }],
        [{ email: "owner@echos.test", phone: null }],
        [],
      ],
    });
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      storeStatus: "suspended",
    });
  });

  it("an unread store status is null, not invented", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[], [{ email: "owner@echos.test", phone: null }], []],
    });
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      storeName: "Your store",
      storeStatus: null,
    });
  });
});

// ── GST Stage 6: paise, the design 7.7 rows, India dates ───────────────────

describe("billing emails quote paise, never whole rupees", () => {
  // ₹433.33: a prorated or GST-carved amount has paise, and rounding it to
  // "₹433" quotes a figure the invoice does not carry.
  const PAISE = 43333;

  it("★★ renewal due keeps the paise in the subject, lead and rows", () => {
    const due = {
      storeName: "Echos",
      planName: "Pro",
      amountPaise: PAISE,
      tax: null,
      dueOn: "2026-10-06T00:00:00.000Z",
      invoiceRef: "SM/2026-27/0007",
      manageUrl: MANAGE,
    };
    const bill = renewalDueTemplate({ ...due, autopay: false });
    expect(bill.subject).toBe("₹433.33 due for your Pro plan");
    expect(text(bill.html)).toContain("₹433.33 is payable by 6 Oct 2026.");
    expect(text(bill.html)).toContain("Amount due₹433.33");
    const auto = renewalDueTemplate({ ...due, autopay: true });
    expect(text(auto.html)).toContain("We'll charge ₹433.33 to your saved");
    expect(text(auto.html)).toContain("Amount₹433.33");
    for (const e of [bill, auto]) expect(e.html).not.toMatch(/₹433(?!\.33)/);
  });

  it("★★ plan activated and the receipt keep the paise", () => {
    const activated = planActivatedTemplate({
      storeName: "Echos",
      planName: "Pro",
      amountPaise: PAISE,
      tax: null,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(text(activated.html)).toContain("Price₹433.33/month");
    const receipt = paymentReceiptTemplate({
      storeName: "Echos",
      planName: "Pro",
      amountPaise: PAISE,
      tax: null,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(text(receipt.html)).toContain("We've received ₹433.33 for");
    expect(text(receipt.html)).toContain("Amount paid₹433.33");
    for (const e of [activated, receipt]) {
      expect(e.html).not.toMatch(/₹433(?!\.33)/);
    }
  });

  it("a reprice from an amount with paise names it to the paisa", () => {
    const e = renewalDueTemplate({
      storeName: "Echos",
      planName: "Pro",
      amountPaise: 50000,
      tax: null,
      dueOn: "2026-10-06T00:00:00.000Z",
      invoiceRef: null,
      autopay: true,
      previousAmountPaise: PAISE,
      manageUrl: MANAGE,
    });
    expect(text(e.html)).toContain("This is an increase from ₹433.33 last");
  });
});

describe("renewalDueTemplate: design 7.7's amount rows", () => {
  const base = {
    storeName: "Echos",
    planName: "Basic",
    dueOn: GST_START,
    invoiceRef: "SM/2026-27/00211",
    manageUrl: MANAGE,
  };

  it("★★ GST added: Price, GST (18%), then Amount (autopay)", () => {
    const e = renewalDueTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
      autopay: true,
    });
    expect(text(e.html)).toContain(
      "Price₹1,500GST (18%)₹270Amount₹1,770Renews on1 Dec 2026",
    );
    expect(e.subject).toBe("Your Basic plan renews on 1 Dec 2026");
    expect(text(e.html)).toContain("We'll charge ₹1,770 to your saved");
  });

  it("★★ GST added: the bill's last row is Amount due", () => {
    const e = renewalDueTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
      autopay: false,
    });
    expect(text(e.html)).toContain(
      "Price₹1,500GST (18%)₹270Amount due₹1,770Due by1 Dec 2026",
    );
    expect(e.subject).toBe("₹1,770 due for your Basic plan");
  });

  it("★★ GST included: the amount, then what of it is GST", () => {
    for (const autopay of [true, false]) {
      const e = renewalDueTemplate({
        ...base,
        amountPaise: 150000,
        tax: GST_INCLUDED,
        autopay,
      });
      const amount = autopay ? "Amount" : "Amount due";
      expect(text(e.html)).toContain(
        `${amount}₹1,500Includes GST (18%)₹228.81`,
      );
      expect(text(e.html)).not.toContain("Price₹");
    }
  });

  it("without GST, the amount row alone, as before", () => {
    const e = renewalDueTemplate({
      ...base,
      amountPaise: 150000,
      tax: null,
      autopay: true,
    });
    expect(text(e.html)).toContain("Amount₹1,500Renews on");
    expect(e.html).not.toContain("GST");
  });
});

describe("renewalDueTemplate: why it costs something else (renewalChange)", () => {
  const base = {
    storeName: "Echos",
    planName: "Basic",
    dueOn: GST_START,
    invoiceRef: null,
    manageUrl: MANAGE,
  };

  it("★★ gst_started: the same price with GST now added", () => {
    const e = renewalDueTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
      autopay: true,
      previousAmountPaise: 150000,
      previousTax: null,
    });
    expect(text(e.html)).toContain(
      "This is more than last time because GST at 18% is now added to our prices. Nothing about your plan changed.",
    );
    expect(e.html).not.toContain("Plan prices changed");
  });

  it("★★ both: a new price and GST newly added", () => {
    const e = renewalDueTemplate({
      ...base,
      amountPaise: 200600,
      tax: { taxPaise: 30600, ratePct: 18, inclusive: false },
      autopay: false,
      previousAmountPaise: 150000,
      previousTax: null,
    });
    expect(text(e.html)).toContain(
      "This is an increase from ₹1,500 last time, and GST at 18% is now added to our prices.",
    );
    expect(e.html).not.toContain("plan prices changed");
    expect(e.html).toMatch(/<strong[^>]*>₹1,500<\/strong> last time,/);
  });

  it("price_changed and lower name no cause (R2-06)", () => {
    const up = renewalDueTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
      autopay: true,
      previousAmountPaise: 141600,
      previousTax: { taxPaise: 21600, ratePct: 18, inclusive: false },
    });
    expect(text(up.html)).toContain(
      "This is an increase from ₹1,416 last time.",
    );
    expect(up.html).not.toContain("Plan prices changed");
    const down = renewalDueTemplate({
      ...base,
      amountPaise: 150000,
      tax: GST_INCLUDED,
      autopay: true,
      previousAmountPaise: 177000,
      previousTax: GST_ADDED,
    });
    expect(text(down.html)).toContain(
      "This is a reduction from ₹1,770 last time.",
    );
    expect(down.html).not.toContain("Plan prices changed");
  });

  it("says nothing when the total did not move, GST or not", () => {
    const e = renewalDueTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
      autopay: true,
      previousAmountPaise: 177000,
      previousTax: GST_ADDED,
    });
    expect(e.html).not.toContain("last time");
  });
});

describe("paymentReceiptTemplate: GST charged", () => {
  const base = {
    storeName: "Echos",
    planName: "Basic",
    period: "monthly" as const,
    renewsOn: GST_START,
    manageUrl: MANAGE,
  };

  it("★★ shows what of the payment was GST, in both modes", () => {
    const added = paymentReceiptTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
    });
    expect(text(added.html)).toContain(
      "Amount paid₹1,770Includes GST (18%)₹270Renews on1 Dec 2026",
    );
    const included = paymentReceiptTemplate({
      ...base,
      amountPaise: 150000,
      tax: GST_INCLUDED,
    });
    expect(text(included.html)).toContain(
      "Amount paid₹1,500Includes GST (18%)₹228.81",
    );
  });

  it("★★ points at the tax invoice in Plans & Billing, escaped", () => {
    const e = paymentReceiptTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
    });
    expect(e.html).toContain(
      "Your plan is active. Your tax invoice is in Plans &amp; Billing whenever you need it.",
    );
    expect(e.html).not.toContain("Plans & Billing");
    expect(e.html).not.toContain("Your invoices are in");
  });

  it("a receipt for a cancelled plan's next cycle keeps its own line", () => {
    const e = paymentReceiptTemplate({
      ...base,
      renewsOn: null,
      amountPaise: 177000,
      tax: GST_ADDED,
      cancelling: { endsAt: GST_START, inGrace: false },
    });
    expect(e.html).toContain(
      "Your invoices are in Plans &amp; Billing whenever you need them.",
    );
    expect(e.html).not.toContain("tax invoice");
    expect(text(e.html)).toContain("Includes GST (18%)₹270");
  });
});

describe("planActivatedTemplate: GST", () => {
  const base = {
    storeName: "Echos",
    planName: "Basic",
    period: "monthly" as const,
    renewsOn: null,
    manageUrl: MANAGE,
  };

  it("★★ a price with GST says it includes GST, in both modes", () => {
    const added = planActivatedTemplate({
      ...base,
      amountPaise: 177000,
      tax: GST_ADDED,
    });
    expect(text(added.html)).toContain("Price₹1,770/month, including GST");
    const included = planActivatedTemplate({
      ...base,
      period: "yearly",
      amountPaise: 1500000,
      tax: { taxPaise: 228814, ratePct: 18, inclusive: true },
    });
    expect(text(included.html)).toContain("Price₹15,000/year, including GST");
  });

  it("★★ SCHED-EX: names the start, the rate and the renewal with GST", () => {
    const e = planActivatedTemplate({
      ...base,
      amountPaise: 150000,
      tax: null,
      taxTerms: SCHEDULED,
    });
    expect(text(e.html)).toContain(
      "From 1 Dec 2026, GST at 18% is added to our prices, so renewals invoiced from then cost ₹1,770 a month including GST.",
    );
    expect(text(e.html)).toContain("Price₹1,500/month");
    expect(text(e.html)).not.toContain("including GSTRenews");
  });

  it("no paragraph without a scheduled switch to GST added on top", () => {
    const off: TaxTerms = {
      active: false,
      inclusive: false,
      rateBps: 0,
      upcoming: null,
    };
    const toIncluded: TaxTerms = {
      ...off,
      upcoming: {
        enabled: true,
        inclusive: true,
        rateBps: 1800,
        startsAt: GST_START,
      },
    };
    for (const taxTerms of [off, toIncluded, null, undefined]) {
      const e = planActivatedTemplate({
        ...base,
        amountPaise: 150000,
        tax: null,
        taxTerms,
      });
      expect(e.html).not.toContain("is added to our prices");
    }
  });
});

describe("emailTaxFromInvoice", () => {
  it("reads the invoice's tax columns as the email's tax", () => {
    expect(
      emailTaxFromInvoice({
        taxPaise: 27000,
        taxRateBps: 1800,
        taxInclusive: false,
      }),
    ).toEqual({ taxPaise: 27000, ratePct: 18, inclusive: false });
    expect(
      emailTaxFromInvoice({
        taxPaise: 22881,
        taxRateBps: 1800,
        taxInclusive: true,
      }),
    ).toEqual({ taxPaise: 22881, ratePct: 18, inclusive: true });
  });

  it("is null for an invoice that charged no GST", () => {
    for (const taxPaise of [0, null, undefined, Number.NaN]) {
      expect(
        emailTaxFromInvoice({
          taxPaise,
          taxRateBps: null,
          taxInclusive: false,
        }),
      ).toBeNull();
    }
  });
});

describe("billing email dates are India dates, whatever the server's zone", () => {
  // 00:00 IST on 1 December is 18:30 UTC on 30 November: a server in UTC that
  // formatted in its own zone would print "30 Nov".
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });
  function withTz<T>(tz: string, fn: () => T): T {
    process.env.TZ = tz;
    return fn();
  }

  it("CONTROL: an unpinned formatter does move with the zone", () => {
    const unpinned = () =>
      new Date(GST_START).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    expect(withTz("UTC", unpinned)).toBe("30 Nov 2026");
    expect(withTz("Asia/Kolkata", unpinned)).toBe("1 Dec 2026");
  });

  it.each(["UTC", "America/Los_Angeles", "Asia/Kolkata"])(
    "★★ prints 1 Dec 2026 in %s",
    (tz) => {
      withTz(tz, () => {
        const due = renewalDueTemplate({
          storeName: "Echos",
          planName: "Basic",
          amountPaise: 150000,
          tax: null,
          dueOn: GST_START,
          invoiceRef: null,
          autopay: true,
          manageUrl: MANAGE,
        });
        expect(due.subject).toBe("Your Basic plan renews on 1 Dec 2026");
        expect(text(due.html)).toContain("If you cancel before 1 Dec 2026");
        const bill = renewalDueTemplate({
          storeName: "Echos",
          planName: "Basic",
          amountPaise: 150000,
          tax: null,
          dueOn: GST_START,
          invoiceRef: null,
          autopay: false,
          manageUrl: MANAGE,
        });
        expect(text(bill.html)).toContain("Due by1 Dec 2026");
        const activated = planActivatedTemplate({
          storeName: "Echos",
          planName: "Basic",
          amountPaise: 150000,
          tax: null,
          period: "monthly",
          renewsOn: GST_START,
          manageUrl: MANAGE,
        });
        expect(text(activated.html)).toContain("Renews on1 Dec 2026");
        const receipt = paymentReceiptTemplate({
          storeName: "Echos",
          planName: "Basic",
          amountPaise: 150000,
          tax: null,
          period: "monthly",
          renewsOn: GST_START,
          manageUrl: MANAGE,
        });
        expect(text(receipt.html)).toContain("Renews on1 Dec 2026");
        const failed = paymentFailedTemplate({
          storeName: "Echos",
          planName: "Basic",
          final: true,
          accessUntil: GST_START,
          manageUrl: MANAGE,
        });
        expect(text(failed.html)).toContain("Access until1 Dec 2026");
        expect(text(failed.html)).toContain(
          "Access continues until 1 Dec 2026",
        );
        const overdue = renewalOverdueTemplate({
          storeName: "Echos",
          planName: "Basic",
          accessUntil: GST_START,
          attempted: false,
          manageUrl: MANAGE,
        });
        expect(text(overdue.html)).toContain("Pay by1 Dec, 00:00 IST");
        const activatedAhead = planActivatedTemplate({
          storeName: "Echos",
          planName: "Basic",
          amountPaise: 150000,
          tax: null,
          taxTerms: SCHEDULED,
          period: "monthly",
          renewsOn: null,
          manageUrl: MANAGE,
        });
        expect(text(activatedAhead.html)).toContain("From 1 Dec 2026, GST");
      });
    },
  );
});
