/* eslint-disable @typescript-eslint/no-explicit-any */
// Telling the merchant.
//
// The invariant that matters most here is the DULLEST one: none of these may
// throw. They are called from the renewal worker between a finalize and a
// charge, and after a downgrade claim has already committed — so a mail provider
// having a bad afternoon must never fail a collection, block a cycle, or abort a
// downgrade. Everything else is about not lying to the merchant.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const mail = vi.hoisted(() => ({
  resolveBillingEmail: vi.fn(),
  sendBillingEmail: vi.fn(),
  manageUrl: vi.fn<(slug: string) => string>(
    () => "https://acme.storemink.com/dashboard/plans",
  ),
  // Typed args so `mock.calls[0][0]` is reachable — these tests assert on what
  // the templates were ASKED for, which is where the honesty lives.
  renewalDueTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "due",
    html: "<p>d</p>",
  })),
  renewalOverdueTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "late",
    html: "<p>l</p>",
  })),
  planDowngradedTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "free",
    html: "<p>f</p>",
  })),
  autopayStoppedTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "stopped",
    html: "<p>s</p>",
  })),
  // The real conversion is tested in billing-emails.test.ts; this stand-in
  // keeps its shape so the test can see what dunning hands the template.
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

const notif = vi.hoisted(() => ({ recordEvent: vi.fn() }));
vi.mock("@/lib/notifications/record", () => notif);

import {
  notifyAutopayStopped,
  notifyDowngraded,
  notifyGraceStarted,
  notifyInvoiceIssued,
} from "./dunning";

const STORE = "store-1";
const DUE = new Date("2026-09-05T00:00:00.000Z");

beforeEach(() => {
  // ⚠ clearAllMocks clears CALLS, not implementations — so a mockRejectedValue
  // set by one test leaks into every test after it. The happy path is restored
  // explicitly here rather than with resetAllMocks(), which would also wipe the
  // template stubs' return values.
  vi.clearAllMocks();
  mail.sendBillingEmail.mockResolvedValue(undefined);
  notif.recordEvent.mockResolvedValue(null);
  mail.resolveBillingEmail.mockResolvedValue({
    email: "owner@acme.test",
    storeName: "Acme",
    slug: "acme",
  });
});

describe("notifyInvoiceIssued", () => {
  const args = {
    storeId: STORE,
    plan: "pro",
    amountPaise: 7_000_00,
    dueAt: DUE,
    invoiceRef: "SM/2026-27/00004",
    autopay: false,
  };

  it("mails the billing contact and logs the event", async () => {
    await notifyInvoiceIssued(args);
    expect(mail.sendBillingEmail).toHaveBeenCalledWith(
      "owner@acme.test",
      expect.objectContaining({ subject: "due" }),
      STORE,
    );
    expect(notif.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "subscription.invoice_due" }),
    );
  });

  it("★ quotes the amount in PAISE, resolved from the plan id", async () => {
    await notifyInvoiceIssued(args);
    expect(mail.renewalDueTemplate.mock.calls[0][0]).toMatchObject({
      amountPaise: 7_000_00,
      tax: null,
      planName: "Pro",
      autopay: false,
    });
  });

  it("★★ never rounds an amount with paise to whole rupees", async () => {
    // ₹433.33 used to reach the email as "₹433".
    await notifyInvoiceIssued({
      ...args,
      amountPaise: 43_333,
      previousAmountPaise: 40_001,
    });
    expect(mail.renewalDueTemplate.mock.calls[0][0]).toMatchObject({
      amountPaise: 43_333,
      previousAmountPaise: 40_001,
    });
  });

  it("★★ passes the issued invoice's and the previous cycle's GST", async () => {
    await notifyInvoiceIssued({
      ...args,
      amountPaise: 1_770_00,
      previousAmountPaise: 1_500_00,
      tax: { taxPaise: 270_00, taxRateBps: 1800, taxInclusive: false },
      previousTax: { taxPaise: 0, taxRateBps: null, taxInclusive: false },
    });
    expect(mail.renewalDueTemplate.mock.calls[0][0]).toMatchObject({
      amountPaise: 1_770_00,
      tax: { taxPaise: 270_00, ratePct: 18, inclusive: false },
      previousAmountPaise: 1_500_00,
      // No GST last cycle: the template reads the rise as "GST started".
      previousTax: null,
    });
  });

  it("a previous cycle passes through even when the amount is unchanged", async () => {
    // The template decides there is nothing to say (tax-copy's renewalChange).
    await notifyInvoiceIssued({ ...args, previousAmountPaise: 7_000_00 });
    expect(mail.renewalDueTemplate.mock.calls[0][0].previousAmountPaise).toBe(
      7_000_00,
    );
  });

  it("★★ passes autopay through unchanged — it decides what the email IS", async () => {
    await notifyInvoiceIssued({ ...args, autopay: true });
    expect(mail.renewalDueTemplate.mock.calls[0][0].autopay).toBe(true);
  });

  it("★ does nothing when the store has no billing contact", async () => {
    mail.resolveBillingEmail.mockResolvedValue(null);
    await notifyInvoiceIssued(args);
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★★ NEVER throws — a mail outage must not fail a collection", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    await expect(notifyInvoiceIssued(args)).resolves.toBeUndefined();
  });

  it("★ never throws when the recipient lookup itself fails", async () => {
    mail.resolveBillingEmail.mockRejectedValue(new Error("db down"));
    await expect(notifyInvoiceIssued(args)).resolves.toBeUndefined();
  });
});

describe("notifyGraceStarted", () => {
  const args = {
    storeId: STORE,
    plan: "basic",
    graceEndsAt: DUE,
    autopayAttempted: false,
  };

  it("★★ does not claim an attempt that never happened", async () => {
    await notifyGraceStarted(args);
    expect(mail.renewalOverdueTemplate.mock.calls[0][0]).toMatchObject({
      attempted: false,
      planName: "Basic",
    });
  });

  it("reports a real attempt when autopay ran", async () => {
    await notifyGraceStarted({ ...args, autopayAttempted: true });
    expect(mail.renewalOverdueTemplate.mock.calls[0][0].attempted).toBe(true);
  });

  it("logs it in-app as a payment failure", async () => {
    await notifyGraceStarted(args);
    expect(notif.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "subscription.payment_failed" }),
    );
  });

  it("★★ NEVER throws — grace has already started in the database", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    await expect(notifyGraceStarted(args)).resolves.toBeUndefined();
  });
});

describe("notifyAutopayStopped: asking the merchant to pay by hand", () => {
  const NOW = new Date("2026-09-03T00:00:00.000Z");
  const args = {
    storeId: STORE,
    plan: "pro",
    amountPaise: 240_000,
    tax: null,
    dueAt: DUE,
    invoiceRef: "SM/2026-27/00007",
    attempts: 3,
    now: NOW,
  };

  it("★★ names the amount, the invoice, the tries and the day to pay by", async () => {
    await notifyAutopayStopped(args);
    expect(mail.autopayStoppedTemplate.mock.calls[0][0]).toMatchObject({
      storeName: "Acme",
      planName: "Pro",
      amountPaise: 240_000,
      invoiceRef: "SM/2026-27/00007",
      attempts: 3,
      payBy: DUE.toISOString(),
      manageUrl: "https://acme.storemink.com/dashboard/plans",
    });
    expect(mail.sendBillingEmail).toHaveBeenCalledTimes(1);
  });

  it("★ names no pay-by day once the cycle has already turned", async () => {
    await notifyAutopayStopped({
      ...args,
      now: new Date("2026-09-06T00:00:00.000Z"),
    });
    expect(mail.autopayStoppedTemplate.mock.calls[0][0].payBy).toBeNull();
  });

  it("logs it in-app as an invoice that is due", async () => {
    await notifyAutopayStopped(args);
    expect(notif.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "subscription.invoice_due",
        storeId: STORE,
        payload: expect.objectContaining({
          amount: 2400,
          reference: "SM/2026-27/00007",
        }),
      }),
    );
  });

  it("says nothing when there is nobody to tell", async () => {
    mail.resolveBillingEmail.mockResolvedValue(null);
    await notifyAutopayStopped(args);
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★★ NEVER throws: the invoice stays payable whatever the mail does", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    await expect(notifyAutopayStopped(args)).resolves.toBeUndefined();
  });
});

describe("notifyDowngraded", () => {
  const args = { storeId: STORE, fromPlan: "pro" };

  it("names the plan that was lost", async () => {
    await notifyDowngraded(args);
    expect(mail.planDowngradedTemplate.mock.calls[0][0]).toMatchObject({
      fromPlanName: "Pro",
      storeName: "Acme",
    });
  });

  it("★★ NEVER throws — the downgrade is already committed", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    await expect(notifyDowngraded(args)).resolves.toBeUndefined();
  });

  it("★ never throws when the event write fails", async () => {
    notif.recordEvent.mockRejectedValue(new Error("db down"));
    await expect(notifyDowngraded(args)).resolves.toBeUndefined();
  });
});
