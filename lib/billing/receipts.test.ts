/* eslint-disable @typescript-eslint/no-explicit-any */
// Telling the merchant something good happened.
//
// All three of these were sent by the old Razorpay-Subscriptions path and lost
// when it was deleted, so for a few days a merchant could subscribe, pay
// ₹50,000 and hear nothing. The tests worth having are about not repeating that
// and not over-promising: an activation must not claim autopay a merchant does
// not have, and a credit purchase must not get a subscription receipt.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const mail = vi.hoisted(() => ({
  resolveBillingEmail: vi.fn(),
  sendBillingEmail: vi.fn(),
  manageUrl: vi.fn<(slug: string) => string>(() => "https://acme/plans"),
  paymentReceiptTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "receipt",
    html: "<p>r</p>",
  })),
  planActivatedTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "welcome",
    html: "<p>w</p>",
  })),
  subscriptionCancelledTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "cancelled",
    html: "<p>c</p>",
  })),
  invoicesUrl: vi.fn<(slug: string) => string>(
    (slug) => `https://${slug}/plans/invoices`,
  ),
  refundTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "refund",
    html: "<p>refund</p>",
  })),
  // The real conversion is tested in billing-emails.test.ts; this stand-in
  // keeps its shape so the tests can see what receipts hands the templates.
  emailTaxFromInvoice: vi.fn((inv: any) =>
    inv.taxPaise > 0
      ? {
          taxPaise: inv.taxPaise,
          ratePct: (inv.taxRateBps ?? 0) / 100,
          inclusive: inv.taxInclusive === true,
        }
      : null,
  ),
}));
vi.mock("@/lib/email/billing-emails", () => mail);

/** No GST now, none scheduled. */
const OFF_TERMS = {
  active: false,
  inclusive: false,
  rateBps: 0,
  upcoming: null,
};
/** No GST now; GST at 18% added on top from 1 Dec 2026 (SCHED-EX). */
const SCHEDULED_TERMS = {
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
const settings = vi.hoisted(() => ({
  getTaxTermsLive: vi.fn(
    async (): Promise<any> => ({
      active: false,
      inclusive: false,
      rateBps: 0,
      upcoming: null,
    }),
  ),
}));
vi.mock("./platform-settings", () => settings);

import { logWarn, logError } from "@/lib/observability/logger";
import {
  notifyInvoicePaid,
  notifyPlanActivated,
  notifyRefundRecorded,
  notifyRefundSent,
  notifySubscriptionCancelled,
} from "./receipts";

const STORE = "store-1";

const SUB = {
  plan: "pro",
  period: "yearly",
  currentPeriodEnd: "2027-09-01T00:00:00.000Z",
};

/** invoice, then subscription. */
function seed(invoice: any = null, sub: any = SUB) {
  dbHolder.current = makeDbMock({
    selectQueue: [invoice ? [invoice] : [], sub ? [sub] : []],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ clearAllMocks clears CALLS, not implementations: restore the happy path.
  mail.sendBillingEmail.mockResolvedValue(undefined);
  mail.resolveBillingEmail.mockResolvedValue({
    email: "owner@acme.test",
    storeName: "Acme",
    slug: "acme",
    storeStatus: "active",
  });
});

describe("notifyInvoicePaid", () => {
  const invoice = {
    kind: "subscription",
    totalPaise: 5_900_000,
    periodEnd: "2027-09-01T00:00:00.000Z",
  };

  it("sends a receipt for the amount on the document", async () => {
    seed(invoice);
    await notifyInvoicePaid(STORE, "inv-1");
    expect(mail.paymentReceiptTemplate.mock.calls[0][0]).toMatchObject({
      amountPaise: 5_900_000,
      tax: null,
      planName: "Pro",
      period: "yearly",
    });
    expect(mail.sendBillingEmail).toHaveBeenCalled();
  });

  it("★★ keeps the paise: ₹433.33 is never rounded to ₹433", async () => {
    seed({ ...invoice, totalPaise: 43_333 });
    await notifyInvoicePaid(STORE, "inv-1");
    expect(mail.paymentReceiptTemplate.mock.calls[0][0].amountPaise).toBe(
      43_333,
    );
  });

  it("★★ reads the invoice's tax columns into the receipt", async () => {
    seed({
      ...invoice,
      totalPaise: 177_000,
      taxPaise: 27_000,
      taxRateBps: 1800,
      taxInclusive: false,
    });
    await notifyInvoicePaid(STORE, "inv-1");
    expect(mail.paymentReceiptTemplate.mock.calls[0][0]).toMatchObject({
      amountPaise: 177_000,
      tax: { taxPaise: 27_000, ratePct: 18, inclusive: false },
    });
    // A receipt never asks for the live GST terms.
    expect(settings.getTaxTermsLive).not.toHaveBeenCalled();
  });

  it("★★ says NOTHING for an AI credit purchase", async () => {
    // A receipt reading "your Pro plan is active" for a ₹59 credit pack is
    // wrong; credits have their own confirmation.
    seed({ ...invoice, kind: "ai_credits" });
    await notifyInvoicePaid(STORE, "inv-1");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★ says nothing when there is no billing contact", async () => {
    mail.resolveBillingEmail.mockResolvedValue(null);
    seed(invoice);
    await notifyInvoicePaid(STORE, "inv-1");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★ says nothing when the invoice cannot be read", async () => {
    seed(null);
    await notifyInvoicePaid(STORE, "inv-1");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★★ NEVER throws: the money is already recorded", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    seed(invoice);
    await expect(notifyInvoicePaid(STORE, "inv-1")).resolves.toBeUndefined();
  });
});

describe("notifyInvoicePaid: a payment for a cancelled plan's next cycle", () => {
  const nextCycle = {
    kind: "subscription",
    totalPaise: 240_000,
    periodEnd: "2026-12-07T00:00:00.000Z",
    cycleSeq: 4,
  };
  const cancelling = {
    plan: "pro",
    period: "monthly",
    currentPeriodEnd: "2026-11-07T00:00:00.000Z",
    state: "active",
    cancelAtPeriodEnd: true,
    currentCycleSeq: 3,
    graceEndsAt: null,
  };

  it("★★ says it comes back, and names no renewal", async () => {
    seed(nextCycle, cancelling);
    await notifyInvoicePaid(STORE, "inv-4");
    const input = mail.paymentReceiptTemplate.mock.calls[0][0];
    expect(input.renewsOn).toBeNull();
    expect(input.cancelling).toEqual({
      endsAt: "2026-11-07T00:00:00.000Z",
      inGrace: false,
    });
  });

  it("★ a plan cancelled in grace ends when grace ends", async () => {
    seed(nextCycle, {
      ...cancelling,
      state: "past_due",
      graceEndsAt: "2026-11-09T08:30:00.000Z",
    });
    await notifyInvoicePaid(STORE, "inv-4");
    expect(mail.paymentReceiptTemplate.mock.calls[0][0].cancelling).toEqual({
      endsAt: "2026-11-09T08:30:00.000Z",
      inGrace: true,
    });
  });

  it("a plan that is not cancelling gets an ordinary receipt", async () => {
    seed(nextCycle, { ...cancelling, cancelAtPeriodEnd: false });
    await notifyInvoicePaid(STORE, "inv-4");
    const input = mail.paymentReceiptTemplate.mock.calls[0][0];
    expect(input.cancelling).toBeNull();
    expect(input.renewsOn).toBe(nextCycle.periodEnd);
  });

  it("★ the cycle being paid for now is not the cycle that won't happen", async () => {
    seed({ ...nextCycle, cycleSeq: 3 }, cancelling);
    await notifyInvoicePaid(STORE, "inv-3");
    expect(mail.paymentReceiptTemplate.mock.calls[0][0].cancelling).toBeNull();
  });

  it("a subscription that has already ended is not cancelling", async () => {
    seed(nextCycle, { ...cancelling, state: "cancelled" });
    await notifyInvoicePaid(STORE, "inv-4");
    expect(mail.paymentReceiptTemplate.mock.calls[0][0].cancelling).toBeNull();
  });

  it("an add-on purchase is never the cancelled cycle", async () => {
    seed({ ...nextCycle, kind: "addon", cycleSeq: null }, cancelling);
    await notifyInvoicePaid(STORE, "inv-a");
    expect(mail.paymentReceiptTemplate.mock.calls[0][0].cancelling).toBeNull();
  });
});

describe("notifyPlanActivated", () => {
  const invoice = {
    kind: "subscription",
    totalPaise: 5_000_00,
    periodEnd: null,
  };

  it("welcomes them onto the plan they paid for", async () => {
    seed(invoice);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: true,
    });
    expect(mail.planActivatedTemplate.mock.calls[0][0]).toMatchObject({
      planName: "Pro",
      amountPaise: 5_000_00,
      tax: null,
      taxTerms: OFF_TERMS,
      period: "yearly",
    });
  });

  it("★★ reads the invoice's tax columns into the welcome", async () => {
    seed({
      ...invoice,
      totalPaise: 150_000,
      taxPaise: 22_881,
      taxRateBps: 1800,
      taxInclusive: true,
    });
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: true,
    });
    expect(mail.planActivatedTemplate.mock.calls[0][0]).toMatchObject({
      amountPaise: 150_000,
      tax: { taxPaise: 22_881, ratePct: 18, inclusive: true },
    });
  });

  it("★★ hands the template today's GST terms, for the SCHED-EX paragraph", async () => {
    settings.getTaxTermsLive.mockResolvedValue(SCHEDULED_TERMS);
    seed(invoice);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: true,
    });
    expect(settings.getTaxTermsLive).toHaveBeenCalledTimes(1);
    expect(mail.planActivatedTemplate.mock.calls[0][0].taxTerms).toEqual(
      SCHEDULED_TERMS,
    );
  });

  it("★ unreadable GST terms cost the paragraph, never the welcome", async () => {
    settings.getTaxTermsLive.mockRejectedValue(new Error("db down"));
    seed(invoice);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: true,
    });
    expect(mail.planActivatedTemplate.mock.calls[0][0].taxTerms).toBeNull();
    expect(mail.sendBillingEmail).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "billing.notify_plan_activated_tax_terms",
      expect.objectContaining({ storeId: STORE }),
    );
  });

  it("no invoice read: the welcome quotes nothing rather than a guess", async () => {
    seed(null);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: true,
    });
    expect(mail.planActivatedTemplate.mock.calls[0][0]).toMatchObject({
      amountPaise: 0,
      tax: null,
    });
  });

  it("★★ WITHHOLDS the renewal date when there is no autopay", async () => {
    // The template's copy says autopay is set up. Naming a date beside that,
    // for a merchant with no mandate, promises a charge that never comes, and
    // they are downgraded for waiting.
    seed(invoice);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: false,
    });
    expect(mail.planActivatedTemplate.mock.calls[0][0].renewsOn).toBeNull();
  });

  it("names the date when autopay really is on", async () => {
    seed(invoice);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: true,
    });
    expect(mail.planActivatedTemplate.mock.calls[0][0].renewsOn).toBe(
      SUB.currentPeriodEnd,
    );
  });

  it("★ says nothing when there is no subscription to describe", async () => {
    seed(invoice, null);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: true,
    });
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★★ NEVER throws: the plan is already active", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    seed(invoice);
    await expect(
      notifyPlanActivated({
        storeId: STORE,
        invoiceId: "inv-1",
        autopay: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("notifySubscriptionCancelled", () => {
  it("★ confirms it, naming what they keep and until when", async () => {
    await notifySubscriptionCancelled({
      storeId: STORE,
      plan: "pro",
      accessUntil: "2026-10-01T00:00:00.000Z",
    });
    expect(mail.subscriptionCancelledTemplate.mock.calls[0][0]).toMatchObject({
      planName: "Pro",
      endsAt: "2026-10-01T00:00:00.000Z",
      inGrace: false,
      nextInvoice: null,
      requestedBy: "merchant",
      storeSuspended: false,
      manageUrl: "https://acme/plans",
    });
  });

  it("★ survives having no cycle to name", async () => {
    // Cancelling between authorising and the first charge: nothing was paid
    // for, so there is no date to promise.
    await notifySubscriptionCancelled({
      storeId: STORE,
      plan: "pro",
      accessUntil: null,
    });
    expect(
      mail.subscriptionCancelledTemplate.mock.calls[0][0].endsAt,
    ).toBeNull();
  });

  it("★★ a plan cancelled in grace ends when grace ends, not at the paid end", async () => {
    for (const state of ["past_due", "grace"]) {
      vi.clearAllMocks();
      mail.resolveBillingEmail.mockResolvedValue({
        email: "owner@acme.test",
        storeName: "Acme",
        slug: "acme",
        storeStatus: "active",
      });
      await notifySubscriptionCancelled({
        storeId: STORE,
        plan: "pro",
        accessUntil: "2026-10-01T00:00:00.000Z",
        state,
        graceEndsAt: "2026-10-03T08:30:00.000Z",
      });
      expect(
        mail.subscriptionCancelledTemplate.mock.calls[0][0],
        state,
      ).toMatchObject({ endsAt: "2026-10-03T08:30:00.000Z", inGrace: true });
    }
  });

  it("an active subscription keeps its paid period's end", async () => {
    await notifySubscriptionCancelled({
      storeId: STORE,
      plan: "pro",
      accessUntil: "2026-10-01T00:00:00.000Z",
      state: "active",
      graceEndsAt: null,
    });
    expect(mail.subscriptionCancelledTemplate.mock.calls[0][0]).toMatchObject({
      endsAt: "2026-10-01T00:00:00.000Z",
      inGrace: false,
    });
  });

  it("passes the next invoice's facts through unchanged", async () => {
    const nextInvoice = {
      status: "processing",
      totalPaise: 240_000,
      invoiceRef: "SM/2026-27/000142",
      inFlight: true,
    };
    await notifySubscriptionCancelled({
      storeId: STORE,
      plan: "pro",
      accessUntil: "2026-10-01T00:00:00.000Z",
      nextInvoice,
    });
    expect(
      mail.subscriptionCancelledTemplate.mock.calls[0][0].nextInvoice,
    ).toEqual(nextInvoice);
  });

  it("★ who asked comes from cancel_requested_by", async () => {
    await notifySubscriptionCancelled({
      storeId: STORE,
      plan: "pro",
      accessUntil: null,
      requestedBy: "operator:ops@storemink.com",
    });
    await notifySubscriptionCancelled({
      storeId: STORE,
      plan: "pro",
      accessUntil: null,
      requestedBy: "merchant:uid-1",
    });
    const calls = mail.subscriptionCancelledTemplate.mock.calls;
    expect(calls[0][0].requestedBy).toBe("operator");
    expect(calls[1][0].requestedBy).toBe("merchant");
  });

  it("★★ a suspended store gets the variant with no dashboard link", async () => {
    mail.resolveBillingEmail.mockResolvedValue({
      email: "owner@acme.test",
      storeName: "Acme",
      slug: "acme",
      storeStatus: "suspended",
    });
    await notifySubscriptionCancelled({
      storeId: STORE,
      plan: "pro",
      accessUntil: "2026-10-01T00:00:00.000Z",
    });
    expect(
      mail.subscriptionCancelledTemplate.mock.calls[0][0].storeSuspended,
    ).toBe(true);
  });

  it("★ says nothing when there is no billing contact", async () => {
    mail.resolveBillingEmail.mockResolvedValue(null);
    await notifySubscriptionCancelled({
      storeId: STORE,
      plan: "pro",
      accessUntil: null,
    });
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★★ NEVER throws: the cancellation is already committed", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    await expect(
      notifySubscriptionCancelled({
        storeId: STORE,
        plan: "pro",
        accessUntil: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("refund notices", () => {
  /** The refund joined with its invoice, as `loadRefund` reads it. */
  const REFUND = {
    status: "processed",
    method: "razorpay",
    reason: "cycle_not_reached",
    amountPaise: 240_000,
    providerRefundId: "rfnd_Q1a2B3c4D5e6F7",
    externalReference: null,
    invoiceId: "inv-142",
    storeId: STORE,
    invoiceRef: "SM/2026-27/000142",
    parties: null,
  };
  const BASE_LINE = { description: "Pro plan · 1 month" };
  const PARTIES = {
    version: 1,
    capturedAt: "2026-11-03T04:30:00.000Z",
    supplier: {
      name: "STOREMINK LLP",
      gstin: null,
      stateCode: "03",
      address: {},
    },
    customer: {
      name: "Acme Pvt Ltd",
      gstin: null,
      stateCode: "29",
      address: { line1: "12 MG Road" },
      email: "billing@acme.test",
    },
  };

  function seedRefund(refund: any, line: any = BASE_LINE, sub: any = SUB) {
    dbHolder.current = makeDbMock({
      selectByTable: {
        billing_refunds: [refund ? [refund] : []],
        billing_invoice_items: [line ? [line] : []],
        billing_subscriptions: [sub ? [sub] : []],
      },
    });
  }

  function refundInput() {
    return mail.refundTemplate.mock.calls[0][0];
  }

  it("★ a processed Razorpay refund is announced, linked to the invoices", async () => {
    seedRefund(REFUND);
    await notifyRefundSent("rf-1");
    expect(refundInput()).toEqual({
      kind: "sent",
      storeName: "Acme",
      planName: "Pro",
      amountPaise: 240_000,
      invoiceRef: "SM/2026-27/000142",
      method: "razorpay",
      reason: "cycle_not_reached",
      refundReference: "rfnd_Q1a2B3c4D5e6F7",
      creditNote: null,
      storeState: "active",
      invoicesUrl: "https://acme/plans/invoices",
    });
    expect(mail.resolveBillingEmail).toHaveBeenCalledWith(STORE);
    expect(mail.sendBillingEmail).toHaveBeenCalledWith(
      "owner@acme.test",
      { subject: "refund", html: "<p>refund</p>" },
      STORE,
    );
  });

  it("★★ never says 'we've refunded' while a refund is still on its way", async () => {
    for (const status of [
      "owed",
      "pending",
      "failed",
      "cancelled",
      "recorded",
    ]) {
      vi.clearAllMocks();
      seedRefund({ ...REFUND, status });
      await notifyRefundSent("rf-1");
      expect(mail.sendBillingEmail, status).not.toHaveBeenCalled();
      expect(logWarn, status).toHaveBeenCalledWith(
        "billing.refund_notice_wrong_status",
        { refundId: "rf-1", kind: "sent", status },
      );
    }
  });

  it("★ a bank transfer recorded is announced with its UTR", async () => {
    seedRefund({
      ...REFUND,
      status: "recorded",
      method: "bank_transfer",
      providerRefundId: null,
      externalReference: "HDFCR52026110712345",
    });
    await notifyRefundRecorded("rf-2");
    expect(refundInput()).toMatchObject({
      kind: "recorded",
      method: "bank_transfer",
      refundReference: "HDFCR52026110712345",
    });
  });

  it("a Razorpay refund made by hand is recorded under its typed id", async () => {
    seedRefund({
      ...REFUND,
      status: "recorded",
      providerRefundId: null,
      externalReference: "rfnd_manual",
    });
    await notifyRefundRecorded("rf-3");
    expect(refundInput()).toMatchObject({
      kind: "recorded",
      method: "razorpay",
      refundReference: "rfnd_manual",
    });
  });

  it("a recorded notice refuses a refund that was sent", async () => {
    seedRefund(REFUND);
    await notifyRefundRecorded("rf-1");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★ a refund that cannot be found is logged, not guessed at", async () => {
    seedRefund(null);
    await notifyRefundSent("rf-404");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith("billing.refund_notice_missing", {
      refundId: "rf-404",
      kind: "sent",
    });
  });

  it("★★ a suspended store gets the particulars variant", async () => {
    mail.resolveBillingEmail.mockResolvedValue({
      email: "owner@acme.test",
      storeName: "Acme",
      slug: "acme",
      storeStatus: "suspended",
    });
    seedRefund(REFUND);
    await notifyRefundSent("rf-1");
    expect(refundInput().storeState).toBe("suspended");
  });

  it("★★ a deleted store's notice goes to the email on its invoice", async () => {
    seedRefund({ ...REFUND, storeId: null, parties: PARTIES }, BASE_LINE, null);
    await notifyRefundSent("rf-1");
    expect(mail.resolveBillingEmail).not.toHaveBeenCalled();
    expect(refundInput()).toMatchObject({
      storeName: "Acme Pvt Ltd",
      planName: "Pro",
      storeState: "deleted",
      invoicesUrl: null,
    });
    expect(mail.sendBillingEmail).toHaveBeenCalledWith(
      "billing@acme.test",
      expect.anything(),
      null,
    );
  });

  it("a deleted store's parties stored as text are read the same way", async () => {
    seedRefund(
      { ...REFUND, storeId: null, parties: JSON.stringify(PARTIES) },
      BASE_LINE,
      null,
    );
    await notifyRefundSent("rf-1");
    expect(mail.sendBillingEmail.mock.calls[0][0]).toBe("billing@acme.test");
  });

  it("★★ with no address anywhere, nothing is sent and it is logged", async () => {
    const noEmail = {
      ...PARTIES,
      customer: { ...PARTIES.customer, email: null },
    };
    seedRefund({ ...REFUND, storeId: null, parties: noEmail }, BASE_LINE, null);
    await notifyRefundSent("rf-1");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith("billing.refund_notice_no_address", {
      refundId: "rf-1",
      invoiceId: "inv-142",
      storeDeleted: true,
    });
  });

  it("an unreadable parties record is no address, not a guess", async () => {
    seedRefund(
      { ...REFUND, storeId: null, parties: { version: 2 } },
      BASE_LINE,
      null,
    );
    await notifyRefundSent("rf-1");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★ a live store with no billing contact is not sent to the invoice's old one", async () => {
    mail.resolveBillingEmail.mockResolvedValue(null);
    seedRefund({ ...REFUND, parties: PARTIES });
    await notifyRefundSent("rf-1");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith("billing.refund_notice_no_address", {
      refundId: "rf-1",
      invoiceId: "inv-142",
      storeDeleted: false,
    });
  });

  it("passes the credit note the caller supplies", async () => {
    const creditNote = { ref: "CN/2026-27/00001" } as any;
    seedRefund(REFUND);
    await notifyRefundSent("rf-1", { creditNote });
    expect(refundInput().creditNote).toBe(creditNote);
  });

  it("★ with no base plan line, the plan comes from the subscription", async () => {
    seedRefund(REFUND, null, { ...SUB, plan: "basic" });
    await notifyRefundSent("rf-1");
    expect(refundInput().planName).toBe("Basic");
  });

  it("a deleted store with no base plan line names no plan", async () => {
    seedRefund({ ...REFUND, storeId: null, parties: PARTIES }, null, null);
    await notifyRefundSent("rf-1");
    expect(refundInput().planName).toBeNull();
  });

  it("★★ NEVER throws, and logs the failure", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    seedRefund(REFUND);
    await expect(notifyRefundSent("rf-1")).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "billing.notify_refund",
      expect.any(Error),
      { refundId: "rf-1", kind: "sent" },
    );
  });
});
