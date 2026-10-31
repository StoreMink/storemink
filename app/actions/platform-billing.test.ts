/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDbMock, sqlParamValues, sqlText } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("./platform", () => ({ getPlatformViewer: vi.fn() }));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

// The refund helpers are the money rules; this file must only pass to them.
// The real module supplies the exported messages, so a test that compares a
// message compares it with the helper's own words.
vi.mock("@/lib/billing/refunds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/refunds")>();
  return {
    ...actual,
    createOperatorRefund: vi.fn(),
    sendRefundNow: vi.fn(),
    retryRefund: vi.fn(),
    cancelOwedRefund: vi.fn(),
    recordRefundMadeOutside: vi.fn(),
    refundableForInvoice: vi.fn(),
    countRefundsNeedingAction: vi.fn(),
    listRefunds: vi.fn(),
    listConsoleCreditNotes: vi.fn(),
  };
});
vi.mock("@/lib/billing/cancel", () => ({
  cancelAtPeriodEnd: vi.fn(),
  resumeSubscription: vi.fn(),
}));
vi.mock("@/lib/billing/renewal-worker", () => ({ endSubscription: vi.fn() }));
vi.mock("@/lib/billing/dunning", () => ({ notifyDowngraded: vi.fn() }));
vi.mock("@/lib/billing/credit-note-store", () => ({
  listCreditNotes: vi.fn(),
}));
vi.mock("@/lib/billing/platform-settings", () => ({
  savePlatformAutoRefunds: vi.fn(),
}));

import {
  cancelPlanAtCycleEnd,
  cancelRefund,
  countRefundsNeedingAction,
  endPlanNow,
  getRefundQueue,
  issueRefund,
  listStoreBilling,
  recordRefundMadeOutside,
  retryRefund,
  sendRefund,
  setAutoRefunds,
  undoPlanCancellation,
} from "./platform-billing";
import { getPlatformViewer } from "./platform";
import * as refunds from "@/lib/billing/refunds";
import { cancelAtPeriodEnd, resumeSubscription } from "@/lib/billing/cancel";
import { endSubscription } from "@/lib/billing/renewal-worker";
import { notifyDowngraded } from "@/lib/billing/dunning";
import { listCreditNotes } from "@/lib/billing/credit-note-store";
import { savePlatformAutoRefunds } from "@/lib/billing/platform-settings";
import { revalidatePath, revalidateTag } from "next/cache";
import { emitEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";
import {
  billingMandates,
  billingSubscriptions,
  planEvents,
} from "@/drizzle/schema";

const STORE = "11111111-1111-4111-8111-111111111111";
const INV1 = "22222222-2222-4222-8222-222222222222";
const INV2 = "33333333-3333-4333-8333-333333333333";
const ATT1 = "44444444-4444-4444-8444-444444444444";
const ATT2 = "55555555-5555-4555-8555-555555555555";
const REFUND1 = "66666666-6666-4666-8666-666666666666";
const MANDATE = "77777777-7777-4777-8777-777777777777";

const SUPERADMIN = {
  role: "superadmin",
  email: "ops@storemink.com",
  id: "op-1",
} as any;
const MEMBER = {
  role: "member",
  email: "help@storemink.com",
  id: "op-2",
} as any;

// 12:00 IST on 29 Oct 2026. The cycle began 15 days earlier and runs 30.
const NOW = new Date("2026-10-29T06:30:00.000Z");
const PERIOD_START = "2026-10-14T06:30:00.000Z";
const PERIOD_END = "2026-11-13T06:30:00.000Z";

function payment(attemptId: string, leftPaise: number) {
  return {
    attemptId,
    providerPaymentId: `pay_${attemptId.slice(0, 4)}`,
    amountPaise: leftPaise,
    refundedPaise: 0,
    inProgressPaise: 0,
    leftPaise,
  };
}

function liveSub(over: Record<string, unknown> = {}) {
  return {
    plan: "pro",
    state: "active",
    currentCycleSeq: 3,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    mandateId: null,
    ...over,
  };
}

function cycleInvoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: INV1,
    invoice_ref: "SM/2026-27/00012",
    kind: "subscription",
    total_paise: "300000",
    finalized_at: PERIOD_START,
    ...over,
  };
}

/** A db for endPlanNow: the locked subscription, the flag's returning, and
 *  the paid invoices of the cycle for the unused-part read. */
function endNowDb(
  opts: {
    sub?: Record<string, unknown> | null;
    flagged?: any[];
    lines?: any[];
  } = {},
) {
  return makeDbMock({
    selectByTable: {
      billing_subscriptions: [opts.sub === null ? [] : [opts.sub ?? liveSub()]],
    },
    returningQueue: [opts.flagged ?? [{ currentCycleSeq: 3 }]],
    executeQueue: [opts.lines ?? [cycleInvoiceRow()]],
  });
}

function endInput(over: Record<string, unknown> = {}) {
  return {
    storeId: STORE,
    reason: "declined_terms",
    refundUnused: true,
    note: "Merchant emailed on 28 Oct declining the new Terms.",
    ...over,
  } as any;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  dbHolder.current = makeDbMock();
  vi.mocked(getPlatformViewer).mockResolvedValue(SUPERADMIN);
  vi.mocked(endSubscription).mockImplementation(async (_db, input) => {
    input.audit?.push({
      storeId: input.storeId,
      fromPlan: "pro",
      toPlan: "free",
      note: "",
    });
    return true;
  });
  vi.mocked(notifyDowngraded).mockResolvedValue(undefined);
  vi.mocked(refunds.refundableForInvoice).mockResolvedValue({
    payments: [payment(ATT1, 300000)],
    leftPaise: 300000,
  });
  vi.mocked(refunds.createOperatorRefund).mockResolvedValue({
    ok: true,
    refundId: REFUND1,
    status: "pending",
  });
  // Every write helper answers success by default, so a gate that lets the
  // wrong person through shows up as a success, not as a crash.
  for (const fn of [
    refunds.sendRefundNow,
    refunds.retryRefund,
    refunds.cancelOwedRefund,
    refunds.recordRefundMadeOutside,
  ]) {
    vi.mocked(fn).mockResolvedValue({
      ok: true,
      refundId: REFUND1,
      status: "processed",
    });
  }
  vi.mocked(savePlatformAutoRefunds).mockResolvedValue({ ok: true });
  vi.mocked(cancelAtPeriodEnd).mockResolvedValue({
    ok: true,
    data: { accessUntil: PERIOD_END, mandateRevoked: true } as any,
  });
  vi.mocked(resumeSubscription).mockResolvedValue({
    ok: true,
    data: { autopay: false, advanced: false } as any,
  });
  vi.mocked(refunds.listRefunds).mockResolvedValue([]);
  vi.mocked(refunds.listConsoleCreditNotes).mockResolvedValue([]);
  vi.mocked(listCreditNotes).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── The superadmin gate ─────────────────────────────────────────────────────

describe("every write is a platform superadmin's", () => {
  const writes: [string, () => Promise<any>, string][] = [
    [
      "setAutoRefunds",
      () => setAutoRefunds(true),
      "Only a platform superadmin can change refund settings.",
    ],
    [
      "sendRefund",
      () => sendRefund(REFUND1),
      "Only a platform superadmin can send refunds.",
    ],
    [
      "retryRefund",
      () => retryRefund(REFUND1, "Bank was closed."),
      "Only a platform superadmin can send refunds.",
    ],
    [
      "cancelRefund",
      () => cancelRefund(REFUND1, "Paid by hand already."),
      "Only a platform superadmin can send refunds.",
    ],
    [
      "recordRefundMadeOutside",
      () =>
        recordRefundMadeOutside({
          invoiceId: INV1,
          attemptId: ATT1,
          amountInr: 100,
          method: "bank_transfer",
          reference: "UTR123456",
          note: "Sent by NEFT.",
        }),
      "Only a platform superadmin can send refunds.",
    ],
    [
      "issueRefund",
      () =>
        issueRefund({
          storeId: STORE,
          invoiceId: INV1,
          attemptId: ATT1,
          amountInr: 100,
          reason: "duplicate_payment",
          note: "Paid twice.",
        } as any),
      "Only a platform superadmin can send refunds.",
    ],
    [
      "cancelPlanAtCycleEnd",
      () => cancelPlanAtCycleEnd(STORE, "Asked by email."),
      "Only a platform superadmin can change store plans.",
    ],
    [
      "undoPlanCancellation",
      () => undoPlanCancellation(STORE, "Asked by email."),
      "Only a platform superadmin can change store plans.",
    ],
    [
      "endPlanNow",
      () => endPlanNow(endInput()),
      "Only a platform superadmin can change store plans.",
    ],
  ];

  for (const [name, call, message] of writes) {
    it(`${name} refuses a platform member`, async () => {
      vi.mocked(getPlatformViewer).mockResolvedValue(MEMBER);
      expect(await call()).toEqual({ error: message });
    });

    it(`${name} refuses someone who is not an operator`, async () => {
      vi.mocked(getPlatformViewer).mockResolvedValue(null);
      expect(await call()).toEqual({ error: message });
    });
  }

  it("a refused write reaches no helper and writes nothing", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue(MEMBER);
    for (const [, call] of writes) await call();
    expect(savePlatformAutoRefunds).not.toHaveBeenCalled();
    expect(refunds.sendRefundNow).not.toHaveBeenCalled();
    expect(refunds.retryRefund).not.toHaveBeenCalled();
    expect(refunds.cancelOwedRefund).not.toHaveBeenCalled();
    expect(refunds.recordRefundMadeOutside).not.toHaveBeenCalled();
    expect(refunds.createOperatorRefund).not.toHaveBeenCalled();
    expect(cancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(resumeSubscription).not.toHaveBeenCalled();
    expect(endSubscription).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });
});

// ── Reads: any operator ─────────────────────────────────────────────────────

describe("reads are any operator's", () => {
  it("getRefundQueue serves a member the tab asked for", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue(MEMBER);
    const row = { id: REFUND1 } as any;
    vi.mocked(refunds.listRefunds).mockResolvedValue([row]);
    const queue = await getRefundQueue("in_progress");
    expect(queue).toEqual({
      tab: "in_progress",
      refunds: [row],
      creditNotes: [],
    });
    expect(refunds.listRefunds).toHaveBeenCalledWith({ tab: "in_progress" });
  });

  it("getRefundQueue reads credit notes on their own tab", async () => {
    const note = { id: "cn-1" } as any;
    vi.mocked(refunds.listConsoleCreditNotes).mockResolvedValue([note]);
    const queue = await getRefundQueue("credit_notes");
    expect(queue.creditNotes).toEqual([note]);
    expect(queue.refunds).toEqual([]);
    expect(refunds.listRefunds).not.toHaveBeenCalled();
  });

  it("getRefundQueue treats an unknown tab as Needs a person", async () => {
    const queue = await getRefundQueue("everything");
    expect(queue.tab).toBe("needs_person");
    expect(refunds.listRefunds).toHaveBeenCalledWith({ tab: "needs_person" });
  });

  it("getRefundQueue gives a non-operator nothing and reads nothing", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue(null);
    expect(await getRefundQueue("done")).toEqual({
      tab: "done",
      refunds: [],
      creditNotes: [],
    });
    expect(refunds.listRefunds).not.toHaveBeenCalled();
  });

  it("countRefundsNeedingAction serves a member", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue(MEMBER);
    const counts = { total: 2 } as any;
    vi.mocked(refunds.countRefundsNeedingAction).mockResolvedValue(counts);
    expect(await countRefundsNeedingAction()).toBe(counts);
  });

  it("countRefundsNeedingAction is null for a failed read, never a wrong zero", async () => {
    vi.mocked(refunds.countRefundsNeedingAction).mockRejectedValue(
      new Error("settings unreadable"),
    );
    expect(await countRefundsNeedingAction()).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "billing.console.refunds_count",
      expect.any(Error),
    );
  });

  it("countRefundsNeedingAction is null for a non-operator", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue(null);
    expect(await countRefundsNeedingAction()).toBeNull();
    expect(refunds.countRefundsNeedingAction).not.toHaveBeenCalled();
  });
});

// ── Refund writes pass to the helpers ───────────────────────────────────────

describe("refund writes go through the shared helpers", () => {
  it("setAutoRefunds passes the value and the operator's email", async () => {
    vi.mocked(savePlatformAutoRefunds).mockResolvedValue({ ok: true });
    expect(await setAutoRefunds(false)).toEqual({ success: true });
    expect(savePlatformAutoRefunds).toHaveBeenCalledWith(
      false,
      "ops@storemink.com",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/billing");
  });

  it("setAutoRefunds returns the setting's own refusal", async () => {
    vi.mocked(savePlatformAutoRefunds).mockResolvedValue({
      ok: false,
      error: "Choose on or off.",
    });
    expect(await setAutoRefunds("yes")).toEqual({
      error: "Choose on or off.",
    });
  });

  it("sendRefund names the operator and returns the row's new status", async () => {
    vi.mocked(refunds.sendRefundNow).mockResolvedValue({
      ok: true,
      refundId: REFUND1,
      status: "processed",
    });
    expect(await sendRefund(REFUND1)).toEqual({
      success: true,
      refundId: REFUND1,
      status: "processed",
    });
    expect(refunds.sendRefundNow).toHaveBeenCalledWith({
      refundId: REFUND1,
      operator: "ops@storemink.com",
    });
  });

  it("sendRefund returns the helper's message exactly", async () => {
    vi.mocked(refunds.sendRefundNow).mockResolvedValue({
      ok: false,
      error: refunds.MOVED_ON_MESSAGE,
      refundId: REFUND1,
    });
    expect(await sendRefund(REFUND1)).toEqual({
      error: "That refund has already moved on. Refresh the page.",
      refundId: REFUND1,
    });
  });

  it("retryRefund passes the note and returns the helper's message exactly", async () => {
    vi.mocked(refunds.retryRefund).mockResolvedValue({
      ok: false,
      error: refunds.NOTE_REQUIRED_MESSAGE,
    });
    expect(await retryRefund(REFUND1, "  ")).toEqual({
      error: "Say why, for the record.",
    });
    expect(refunds.retryRefund).toHaveBeenCalledWith({
      refundId: REFUND1,
      note: "  ",
      operator: "ops@storemink.com",
    });
  });

  it("cancelRefund passes the note and the operator", async () => {
    vi.mocked(refunds.cancelOwedRefund).mockResolvedValue({
      ok: true,
      refundId: REFUND1,
      status: "cancelled",
    });
    expect(await cancelRefund(REFUND1, "Merchant asked for credit.")).toEqual({
      success: true,
      refundId: REFUND1,
      status: "cancelled",
    });
    expect(refunds.cancelOwedRefund).toHaveBeenCalledWith({
      refundId: REFUND1,
      note: "Merchant asked for credit.",
      operator: "ops@storemink.com",
    });
  });

  it("recordRefundMadeOutside converts rupees with Math.round and omits an absent store", async () => {
    vi.mocked(refunds.recordRefundMadeOutside).mockResolvedValue({
      ok: true,
      refundId: REFUND1,
      status: "recorded",
    });
    await recordRefundMadeOutside({
      invoiceId: INV1,
      attemptId: ATT1,
      amountInr: 19.99,
      method: "bank_transfer",
      reference: "UTR123456",
      note: "Sent by NEFT.",
    });
    const sent = vi.mocked(refunds.recordRefundMadeOutside).mock.calls[0][0];
    // 19.99 * 100 is 1998.9999999999998 in floating point.
    expect(sent.amountPaise).toBe(1999);
    expect("storeId" in sent).toBe(false);
    expect(sent.refundId).toBeNull();
    expect(sent.operator).toBe("ops@storemink.com");
    expect(sent.method).toBe("bank_transfer");
  });

  it("recordRefundMadeOutside keeps a null store (a deleted store's invoice)", async () => {
    vi.mocked(refunds.recordRefundMadeOutside).mockResolvedValue({
      ok: true,
      refundId: REFUND1,
      status: "recorded",
    });
    await recordRefundMadeOutside({
      refundId: REFUND1,
      storeId: null,
      invoiceId: INV1,
      attemptId: ATT1,
      amountInr: "₹1,200.50",
      method: "razorpay",
      reference: "rfnd_ABC",
      note: "Made in the Razorpay dashboard.",
      reason: "duplicate_payment",
    });
    const sent = vi.mocked(refunds.recordRefundMadeOutside).mock.calls[0][0];
    expect(sent.storeId).toBeNull();
    expect(sent.refundId).toBe(REFUND1);
    expect(sent.amountPaise).toBe(120050);
    expect(sent.reason).toBe("duplicate_payment");
  });

  it("recordRefundMadeOutside hands an unreadable amount to the helper to refuse", async () => {
    vi.mocked(refunds.recordRefundMadeOutside).mockResolvedValue({
      ok: false,
      error: "Enter the amount refunded.",
    });
    expect(
      await recordRefundMadeOutside({
        invoiceId: INV1,
        attemptId: ATT1,
        amountInr: "abc",
        method: "bank_transfer",
        reference: "UTR123456",
        note: "Sent.",
      }),
    ).toEqual({ error: "Enter the amount refunded." });
    const sent = vi.mocked(refunds.recordRefundMadeOutside).mock.calls[0][0];
    expect(Number.isNaN(sent.amountPaise)).toBe(true);
  });

  it("issueRefund converts rupees, keeps the store and names the operator", async () => {
    await issueRefund({
      storeId: STORE,
      invoiceId: INV1,
      attemptId: ATT1,
      amountInr: 19.99,
      reason: "duplicate_payment",
      note: "Paid twice on 12 Oct.",
    });
    expect(refunds.createOperatorRefund).toHaveBeenCalledWith({
      storeId: STORE,
      invoiceId: INV1,
      attemptId: ATT1,
      amountPaise: 1999,
      reason: "duplicate_payment",
      note: "Paid twice on 12 Oct.",
      operator: "ops@storemink.com",
    });
  });

  it("issueRefund keeps a null store for a deleted store's invoice", async () => {
    await issueRefund({
      storeId: null,
      invoiceId: INV1,
      attemptId: ATT1,
      amountInr: "₹1,200.50",
      reason: "cycle_not_reached",
      note: "From the reconciliation queue.",
    });
    const sent = vi.mocked(refunds.createOperatorRefund).mock.calls[0][0];
    expect(sent.storeId).toBeNull();
    expect(sent.amountPaise).toBe(120050);
  });

  it("issueRefund picks the payment with the most left when none is named", async () => {
    vi.mocked(refunds.refundableForInvoice).mockResolvedValue({
      payments: [payment(ATT1, 1000), payment(ATT2, 250000)],
      leftPaise: 251000,
    });
    await issueRefund({
      storeId: STORE,
      invoiceId: INV1,
      amountInr: 100,
      reason: "other",
      note: "Goodwill.",
    });
    expect(
      vi.mocked(refunds.createOperatorRefund).mock.calls[0][0].attemptId,
    ).toBe(ATT2);
  });

  const helperRefusals: [string, string][] = [
    [
      "over the cap",
      "That's more than is left to refund on this payment (₹50).",
    ],
    [
      "under ₹1 through Razorpay",
      "A refund through Razorpay must be at least ₹1.",
    ],
    ["another store's invoice", "That invoice belongs to another store."],
    [
      "Plan ended before this cycle where it does not fit",
      "Plan ended before this cycle fits only an invoice for a cycle the plan did not reach.",
    ],
  ];
  for (const [what, message] of helperRefusals) {
    it(`issueRefund returns the helper's refusal for ${what} exactly`, async () => {
      vi.mocked(refunds.createOperatorRefund).mockResolvedValue({
        ok: false,
        error: message,
      });
      expect(
        await issueRefund({
          storeId: STORE,
          invoiceId: INV1,
          attemptId: ATT1,
          amountInr: 1000,
          reason: "cycle_not_reached",
          note: "Check.",
        }),
      ).toEqual({ error: message });
    });
  }

  it("the over-cap message is the helper's own", () => {
    expect(refunds.overCapMessage(5000)).toBe(helperRefusals[0][1]);
    expect(refunds.BELOW_MINIMUM_MESSAGE).toBe(helperRefusals[1][1]);
  });
});

// ── Cancel and undo ─────────────────────────────────────────────────────────

describe("cancelPlanAtCycleEnd and undoPlanCancellation", () => {
  it("cancels through the merchant's path as the operator", async () => {
    vi.mocked(cancelAtPeriodEnd).mockResolvedValue({
      ok: true,
      data: {
        accessUntil: PERIOD_END,
        mandateRevoked: true,
      } as any,
    });
    expect(
      await cancelPlanAtCycleEnd(STORE, "Asked by email on 28 Oct."),
    ).toEqual({ success: true, accessUntil: PERIOD_END, mandateRevoked: true });
    expect(cancelAtPeriodEnd).toHaveBeenCalledWith({
      storeId: STORE,
      requestedBy: "operator:ops@storemink.com",
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "platform.plan_changed",
        subject: { type: "store", id: STORE },
        actor: { type: "operator", label: "ops@storemink.com" },
      }),
    );
  });

  it("needs a note before anything happens", async () => {
    expect(await cancelPlanAtCycleEnd(STORE, "   ")).toEqual({
      error: "Say why, for the record.",
    });
    expect(await undoPlanCancellation(STORE, "")).toEqual({
      error: "Say why, for the record.",
    });
    expect(cancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(resumeSubscription).not.toHaveBeenCalled();
  });

  it("returns the cancellation's own refusal and emits nothing", async () => {
    vi.mocked(cancelAtPeriodEnd).mockResolvedValue({
      ok: false,
      error: "Your plan is already set to end.",
    });
    expect(await cancelPlanAtCycleEnd(STORE, "Asked.")).toEqual({
      error: "Your plan is already set to end.",
    });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("refuses a store id that is not a uuid", async () => {
    expect(await cancelPlanAtCycleEnd("store-1", "Asked.")).toEqual({
      error: "Store not found.",
    });
    expect(cancelAtPeriodEnd).not.toHaveBeenCalled();
  });

  it("undoes through resumeSubscription as the operator", async () => {
    vi.mocked(resumeSubscription).mockResolvedValue({
      ok: true,
      data: { autopay: false, advanced: true } as any,
    });
    expect(await undoPlanCancellation(STORE, "Changed their mind.")).toEqual({
      success: true,
      advanced: true,
      autopay: false,
    });
    expect(resumeSubscription).toHaveBeenCalledWith({
      storeId: STORE,
      requestedBy: "operator:ops@storemink.com",
    });
  });
});

// ── End the plan now ────────────────────────────────────────────────────────

describe("endPlanNow", () => {
  it("locks, sets the flag, ends, audits, notifies, refreshes, then refunds, in that order", async () => {
    dbHolder.current = endNowDb();
    const res = await endPlanNow(endInput());
    expect(res).toEqual({
      success: true,
      refunds: [
        {
          invoiceRef: "SM/2026-27/00012",
          amountPaise: 150000,
          status: "pending",
          error: null,
        },
      ],
      skipped: [],
    });

    const { db, calls } = dbHolder.current;
    expect(calls.forUpdate).toEqual(["update"]);
    const lock = db.select.mock.invocationCallOrder[0];
    const flag = db.update.mock.invocationCallOrder[0];
    const end = vi.mocked(endSubscription).mock.invocationCallOrder[0];
    const audit = db.insert.mock.invocationCallOrder[0];
    const notice = vi.mocked(notifyDowngraded).mock.invocationCallOrder[0];
    const cache = vi.mocked(revalidateTag).mock.invocationCallOrder[0];
    const refund = vi.mocked(refunds.createOperatorRefund).mock
      .invocationCallOrder[0];
    expect(lock).toBeLessThan(flag);
    expect(flag).toBeLessThan(end);
    expect(end).toBeLessThan(audit);
    expect(audit).toBeLessThan(notice);
    expect(notice).toBeLessThan(cache);
    expect(cache).toBeLessThan(refund);
  });

  it("sets the cancel flag with the operator as who asked, then ends from the cycle it claimed", async () => {
    dbHolder.current = endNowDb();
    await endPlanNow(endInput());
    const { calls } = dbHolder.current;
    expect(calls.update[0]).toBe(billingSubscriptions);
    expect(calls.set[0]).toMatchObject({
      cancelAtPeriodEnd: true,
      cancelRequestedBy: "operator:ops@storemink.com",
      cancelRequestedAt: NOW.toISOString(),
    });
    expect(endSubscription).toHaveBeenCalledWith(
      dbHolder.current.db,
      expect.objectContaining({ storeId: STORE, fromCycleSeq: 3, now: NOW }),
    );
    expect(notifyDowngraded).toHaveBeenCalledWith({
      storeId: STORE,
      fromPlan: "pro",
    });
    expect(revalidateTag).toHaveBeenCalledWith("stores", "max");
  });

  it("writes the plan change to plan_events as the operator, with the reason", async () => {
    dbHolder.current = endNowDb();
    await endPlanNow(endInput({ refundUnused: false }));
    const { calls } = dbHolder.current;
    expect(calls.insert).toEqual([planEvents]);
    expect(calls.values[0]).toEqual([
      expect.objectContaining({
        storeId: STORE,
        fromPlan: "pro",
        toPlan: "free",
        source: "operator",
        actor: "ops@storemink.com",
        note: "Ended now by StoreMink (Declined new Terms). Merchant emailed on 28 Oct declining the new Terms.",
      }),
    ]);
  });

  it("withdraws an active mandate in the same transaction", async () => {
    dbHolder.current = endNowDb({ sub: liveSub({ mandateId: MANDATE }) });
    await endPlanNow(endInput({ refundUnused: false }));
    const { calls } = dbHolder.current;
    expect(calls.update).toEqual([billingSubscriptions, billingMandates]);
    expect(calls.set[1]).toMatchObject({ status: "revoked" });
  });

  it("refunds with the operator's reason, never Plan ended before this cycle", async () => {
    for (const reason of ["declined_terms", "other"]) {
      vi.mocked(refunds.createOperatorRefund).mockClear();
      dbHolder.current = endNowDb();
      await endPlanNow(endInput({ reason }));
      const sent = vi.mocked(refunds.createOperatorRefund).mock.calls[0][0];
      expect(sent.reason).toBe(reason);
      expect(sent.reason).not.toBe("cycle_not_reached");
      expect(sent).toMatchObject({
        storeId: STORE,
        invoiceId: INV1,
        attemptId: ATT1,
        operator: "ops@storemink.com",
        note: "Merchant emailed on 28 Oct declining the new Terms.",
      });
    }
  });

  it("reads only the paid invoices of the cycle that ended, for this store", async () => {
    dbHolder.current = endNowDb();
    await endPlanNow(endInput());
    const query = dbHolder.current.calls.execute[0];
    const text = sqlText(query);
    expect(text).toContain("i.status = 'paid'");
    expect(text).toContain("i.finalized_at is not null");
    expect(sqlParamValues(query)).toEqual([STORE, 3, PERIOD_START]);
  });

  it("counts a removed feature from the date given, 00:00 IST", async () => {
    dbHolder.current = endNowDb();
    const res = await endPlanNow(
      endInput({ reason: "feature_removed", refundFrom: "2026-10-24" }),
    );
    // From 18:30 UTC on 23 Oct to the cycle end: 20.5 of 30 days of ₹3,000.
    expect(res).toMatchObject({
      success: true,
      refunds: [{ amountPaise: 205000, error: null }],
    });
    expect(dbHolder.current.calls.values[0][0].note).toBe(
      "Ended now by StoreMink (Main feature removed from 24 Oct 2026). Merchant emailed on 28 Oct declining the new Terms.",
    );
  });

  it("requires the date for a removed feature, before anything is written", async () => {
    dbHolder.current = endNowDb();
    expect(await endPlanNow(endInput({ reason: "feature_removed" }))).toEqual({
      error: "Give the date the feature was removed or reduced.",
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(endSubscription).not.toHaveBeenCalled();
  });

  const badDates: [string, string][] = [
    ["2026-10-30", "The date can't be in the future."],
    ["2026-10-29T08:00:00.000Z", "The date can't be in the future."],
    ["2026-02-30", "That date couldn't be read."],
    ["not a date", "That date couldn't be read."],
    [
      "2026-10-10",
      "The date must fall in the current cycle, which began on 14 Oct 2026.",
    ],
  ];
  for (const [date, message] of badDates) {
    it(`refuses the date ${date} and writes nothing`, async () => {
      dbHolder.current = endNowDb();
      expect(
        await endPlanNow(
          endInput({ reason: "feature_removed", refundFrom: date }),
        ),
      ).toEqual({ error: message });
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });
  }

  it("needs a reason and a note", async () => {
    expect(await endPlanNow(endInput({ reason: "cycle_not_reached" }))).toEqual(
      { error: "Choose a reason." },
    );
    expect(await endPlanNow(endInput({ note: " " }))).toEqual({
      error: "Say why, for the record.",
    });
    expect(endSubscription).not.toHaveBeenCalled();
  });

  it("says there is nothing to end when no paid plan runs", async () => {
    for (const sub of [null, liveSub({ state: "cancelled" })]) {
      dbHolder.current = endNowDb({ sub });
      expect(await endPlanNow(endInput())).toEqual({
        error:
          "This store has no paid plan running, so there is nothing to end.",
      });
      expect(dbHolder.current.calls.update).toHaveLength(0);
    }
    expect(notifyDowngraded).not.toHaveBeenCalled();
  });

  it("reports a plan that moved underneath when the flag or the end claim is lost", async () => {
    dbHolder.current = endNowDb({ flagged: [] });
    expect(await endPlanNow(endInput())).toEqual({
      error: "That plan changed while you were looking. Refresh the page.",
    });
    expect(endSubscription).not.toHaveBeenCalled();

    dbHolder.current = endNowDb();
    vi.mocked(endSubscription).mockResolvedValue(false);
    expect(await endPlanNow(endInput())).toEqual({
      error: "That plan changed while you were looking. Refresh the page.",
    });
    expect(notifyDowngraded).not.toHaveBeenCalled();
    expect(refunds.createOperatorRefund).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("skips and names an invoice with less than ₹1 to refund, and never writes 0", async () => {
    dbHolder.current = endNowDb({
      lines: [cycleInvoiceRow({ total_paise: "100" })],
    });
    expect(await endPlanNow(endInput())).toEqual({
      success: true,
      refunds: [],
      skipped: [
        {
          invoiceRef: "SM/2026-27/00012",
          why: "SM/2026-27/00012: less than ₹1 is left, so nothing is refunded.",
        },
      ],
    });
    expect(refunds.createOperatorRefund).not.toHaveBeenCalled();
  });

  it("refunds no more than is left on the invoice", async () => {
    dbHolder.current = endNowDb();
    vi.mocked(refunds.refundableForInvoice).mockResolvedValue({
      payments: [payment(ATT1, 40000)],
      leftPaise: 40000,
    });
    await endPlanNow(endInput());
    expect(
      vi.mocked(refunds.createOperatorRefund).mock.calls[0][0].amountPaise,
    ).toBe(40000);
  });

  it("splits across payments, the one with the most left first", async () => {
    dbHolder.current = endNowDb();
    vi.mocked(refunds.refundableForInvoice).mockResolvedValue({
      payments: [payment(ATT2, 80000), payment(ATT1, 100000)],
      leftPaise: 180000,
    });
    const res = await endPlanNow(endInput());
    const calls = vi.mocked(refunds.createOperatorRefund).mock.calls;
    expect(calls.map((c) => [c[0].attemptId, c[0].amountPaise])).toEqual([
      [ATT1, 100000],
      [ATT2, 50000],
    ]);
    expect(res).toMatchObject({ success: true, skipped: [] });
  });

  it("does not send a part under ₹1 and names it", async () => {
    dbHolder.current = endNowDb();
    vi.mocked(refunds.refundableForInvoice).mockResolvedValue({
      payments: [payment(ATT1, 149950), payment(ATT2, 1000)],
      leftPaise: 150950,
    });
    const res = await endPlanNow(endInput());
    const calls = vi.mocked(refunds.createOperatorRefund).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].amountPaise).toBe(149950);
    expect(res).toMatchObject({
      skipped: [
        {
          why: "SM/2026-27/00012: part of it is less than ₹1 on one payment, so that part is not refunded.",
        },
      ],
    });
    for (const call of calls) expect(call[0].amountPaise).toBeGreaterThan(0);
  });

  it("a refund the helper refuses is reported and the plan stays ended", async () => {
    dbHolder.current = endNowDb();
    vi.mocked(refunds.createOperatorRefund).mockResolvedValue({
      ok: false,
      error:
        "StoreMink's Razorpay account isn't set up here, so nothing can be sent right now.",
    });
    const res = await endPlanNow(endInput());
    expect(res).toEqual({
      success: true,
      refunds: [
        {
          invoiceRef: "SM/2026-27/00012",
          amountPaise: 150000,
          status: null,
          error:
            "StoreMink's Razorpay account isn't set up here, so nothing can be sent right now.",
        },
      ],
      skipped: [],
    });
    expect(endSubscription).toHaveBeenCalledTimes(1);
    expect(notifyDowngraded).toHaveBeenCalledTimes(1);
  });

  it("a refund that throws is reported and the plan stays ended", async () => {
    dbHolder.current = endNowDb();
    vi.mocked(refunds.createOperatorRefund).mockRejectedValue(
      new Error("pool timeout"),
    );
    const res = await endPlanNow(endInput());
    expect(res).toMatchObject({
      success: true,
      refunds: [
        { status: null, error: "Couldn't save that refund. Please try again." },
      ],
    });
    expect(notifyDowngraded).toHaveBeenCalledTimes(1);
  });

  it("refunds nothing when not asked to", async () => {
    dbHolder.current = endNowDb();
    expect(await endPlanNow(endInput({ refundUnused: false }))).toEqual({
      success: true,
      refunds: [],
      skipped: [],
    });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
    expect(refunds.createOperatorRefund).not.toHaveBeenCalled();
  });
});

// ── The store page's billing block ──────────────────────────────────────────

describe("listStoreBilling", () => {
  function headRow(over: Record<string, unknown> = {}) {
    return {
      id: STORE,
      name: "Acme",
      slug: "acme",
      status: "active",
      plan: "pro",
      period: "monthly",
      state: "active",
      current_cycle_seq: "3",
      current_period_start: PERIOD_START,
      current_period_end: PERIOD_END,
      grace_ends_at: null,
      cancel_at_period_end: false,
      cancel_requested_at: null,
      cancel_requested_by: null,
      ...over,
    };
  }

  function billingDb(head: any, invoices: any[] = [], lines: any[] = []) {
    return makeDbMock({ executeQueue: [[head], invoices, lines] });
  }

  it("serves a member the subscription, invoices, refunds and credit notes", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue(MEMBER);
    const refund = { id: REFUND1 } as any;
    const note = { id: "cn-1" } as any;
    vi.mocked(refunds.listRefunds).mockResolvedValue([refund]);
    vi.mocked(listCreditNotes).mockResolvedValue([note]);
    dbHolder.current = billingDb(
      headRow(),
      [
        {
          id: INV1,
          invoice_ref: "SM/2026-27/00012",
          kind: "subscription",
          status: "paid",
          cycle_seq: "3",
          period_start: PERIOD_START,
          period_end: PERIOD_END,
          total_paise: "300000",
          finalized_at: PERIOD_START,
        },
      ],
      [cycleInvoiceRow()],
    );
    const billing = await listStoreBilling(STORE);
    expect(billing).toMatchObject({
      storeId: STORE,
      storeName: "Acme",
      storeSlug: "acme",
      subscription: {
        plan: "pro",
        live: true,
        currentCycleSeq: 3,
        cancelRequestedBy: null,
      },
      invoices: [
        {
          id: INV1,
          cycleSeq: 3,
          leftPaise: 300000,
          refundedPaise: 0,
          cycleNotReachedFits: false,
        },
      ],
      endNow: {
        from: NOW.toISOString(),
        totalPaise: 150000,
        error: null,
        lines: [
          {
            invoiceId: INV1,
            amountPaise: 150000,
            daysLeft: 15,
            daysTotal: 30,
            skippedWhy: null,
          },
        ],
      },
      refunds: [refund],
      creditNotes: [note],
    });
    expect(refunds.listRefunds).toHaveBeenCalledWith({ storeId: STORE });
    expect(listCreditNotes).toHaveBeenCalledWith(STORE);
    expect((billing as any).endNow.lines[0]).not.toHaveProperty("payments");
  });

  it("shows a merchant's cancellation by kind and an operator's by email", async () => {
    dbHolder.current = billingDb(
      headRow({
        cancel_at_period_end: true,
        cancel_requested_by: "merchant:uid-123",
      }),
    );
    expect(
      (await listStoreBilling(STORE))?.subscription?.cancelRequestedBy,
    ).toEqual({ kind: "merchant" });

    dbHolder.current = billingDb(
      headRow({ cancel_requested_by: "operator:ops@storemink.com" }),
    );
    expect(
      (await listStoreBilling(STORE))?.subscription?.cancelRequestedBy,
    ).toEqual({ kind: "operator", email: "ops@storemink.com" });
  });

  it("hints Plan ended before this cycle only for a closed or unreached invoice", async () => {
    const invoice = (id: string, status: string, cycle: string) => ({
      id,
      invoice_ref: null,
      kind: "subscription",
      status,
      cycle_seq: cycle,
      period_start: null,
      period_end: null,
      total_paise: "100000",
      finalized_at: PERIOD_START,
    });
    dbHolder.current = billingDb(headRow({ state: "cancelled" }), [
      invoice(INV1, "void", "4"),
      invoice(INV2, "paid", "4"),
      invoice(ATT1, "paid", "3"),
    ]);
    const billing = await listStoreBilling(STORE);
    expect(billing?.invoices.map((i) => i.cycleNotReachedFits)).toEqual([
      true,
      true,
      false,
    ]);
    expect(billing?.endNow).toBeNull();
  });

  it("previews with the end's own date rules", async () => {
    dbHolder.current = billingDb(headRow());
    expect(
      (await listStoreBilling(STORE, { refundFrom: "2026-10-30" }))?.endNow,
    ).toEqual({
      from: null,
      lines: [],
      totalPaise: 0,
      error: "The date can't be in the future.",
    });

    dbHolder.current = billingDb(headRow(), [], [cycleInvoiceRow()]);
    expect(
      (await listStoreBilling(STORE, { reason: "feature_removed" }))?.endNow
        ?.error,
    ).toBe("Give the date the feature was removed or reduced.");
  });

  it("is null for a non-operator, a bad id or an unknown store", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue(null);
    expect(await listStoreBilling(STORE)).toBeNull();
    vi.mocked(getPlatformViewer).mockResolvedValue(SUPERADMIN);
    expect(await listStoreBilling("acme")).toBeNull();
    dbHolder.current = makeDbMock({ executeQueue: [[]] });
    expect(await listStoreBilling(STORE)).toBeNull();
    expect(refunds.listRefunds).not.toHaveBeenCalled();
  });
});
