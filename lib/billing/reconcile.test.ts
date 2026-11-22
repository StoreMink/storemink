/* eslint-disable @typescript-eslint/no-explicit-any */
// Settling payments whose outcome we never learned.
//
// The asymmetry is the whole design and it is what these tests protect:
//
//   FINDING MONEY is safe and urgent — a captured payment means the merchant
//   paid, and recording it can only help them.
//   DECLARING FAILURE frees the invoice for a fresh attempt, so doing it to a
//   payment still in flight invites a SECOND CHARGE. It waits three days, and
//   only ever on the gateway's word that nothing was captured.
//
// Nothing here may settle an attempt on a timestamp alone.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { CAPTURED_DRAFT_REPAIR } from "./tax-copy";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const provider = vi.hoisted(() => ({ getPlatformRazorpayCreds: vi.fn() }));
vi.mock("@/lib/payments/provider", () => provider);

// ★ No test here may reach Razorpay: every gateway read is injected, and a
// default reader left in by mistake throws instead of going to the network.
vi.mock("@/lib/payments/razorpay", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/payments/razorpay")>();
  const offline = async () => {
    throw new Error("reconcile.test never calls Razorpay");
  };
  return {
    ...actual,
    rzpFetchOrderPayments: vi.fn(offline),
    rzpFetchPayment: vi.fn(offline),
  };
});

const collect = vi.hoisted(() => ({
  settleAttempt: vi.fn(),
  // RC-F1b: no captured draft purchase to finish unless a test says so.
  capturedDraftPurchases: vi.fn(async (): Promise<unknown[] | null> => []),
  fileRecoveredPurchase: vi.fn(async () => true),
  // A payment on a closed checkout is filed for a person (PR #303 re-review).
  fileClosedAttemptPayment: vi.fn(async (): Promise<boolean> => true),
  readAddonOrderTarget: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("./collect", () => collect);

const worker = vi.hoisted(() => ({
  advanceAfterPayment: vi.fn(),
  announceAutopayStopped: vi.fn(),
}));
vi.mock("./renewal-worker", () => worker);

// The repair pass issues through `issueInvoice` (GST Stage 4); what it does to
// a draft is invoice-store's own business, tested there and in gst.local.
const store = vi.hoisted(() => ({
  issueInvoice: vi.fn(
    async (input: { invoiceId: string }): Promise<unknown> => ({
      invoice: {
        id: input.invoiceId,
        status: "open",
        finalizedAt: "2026-09-10T00:00:00.000Z",
      },
      claimed: true,
      restamp: "unchanged",
    }),
  ),
}));
vi.mock("./invoice-store", () => store);

// The three completions are the purchase modules' own; reconcile only finds
// the purchases and dispatches them.
const enrol = vi.hoisted(() => ({
  completeEnrolmentPurchase: vi.fn(
    async (): Promise<{ status: string }> => ({ status: "completed" }),
  ),
}));
vi.mock("./enrol", () => enrol);
const planChange = vi.hoisted(() => ({
  completePlanChangePurchase: vi.fn(
    async (): Promise<{ status: string }> => ({ status: "completed" }),
  ),
}));
vi.mock("./plan-change", () => planChange);
const locations = vi.hoisted(() => ({
  completeLocationPurchase: vi.fn(
    async (): Promise<{ status: string }> => ({ status: "completed" }),
  ),
}));
vi.mock("./locations", () => locations);

import {
  CAPTURED_DRAFT_WAIT_MINUTES,
  capturedDraftsWhere,
  countOpenReconciliationItems,
  creditDraftsWhere,
  AUTO_NO_PAYMENT_FAIL_AFTER_HOURS,
  FAIL_AFTER_HOURS,
  issueCapturedDrafts,
  listReconciliationItems,
  reconcileStrandedAttempts,
  resolveReconciliationItem,
  STALE_AFTER_MINUTES,
  UNISSUED_ALERT_AFTER_HOURS,
  unissuedSeverity,
} from "./reconcile";

const STORE = "store-1";
const NOW = new Date("2026-09-10T00:00:00.000Z");

/** Older than the stale window, younger than the fail window. */
const STALE = new Date(NOW.getTime() - 60 * 60_000).toISOString();
/** Older than the fail window. */
const ANCIENT = new Date(
  NOW.getTime() - (FAIL_AFTER_HOURS + 1) * 3_600_000,
).toISOString();

function attempt(over: Record<string, unknown> = {}) {
  return {
    id: "att-1",
    storeId: STORE,
    invoiceId: "inv-1",
    providerOrderId: "order_1",
    amountPaise: 500_000,
    state: "processing",
    createdAt: STALE,
    ...over,
  };
}

function seed(rows: any[] = [attempt()]) {
  dbHolder.current = makeDbMock({ selectQueue: [rows] });
}

/** A gateway that reports these payments for any order. */
const gateway = (payments: any[]) =>
  vi.fn(async () => ({ ok: true as const, data: payments }));

const CAPTURED = { id: "pay_1", status: "captured", amount: 500_000 };

beforeEach(() => {
  vi.clearAllMocks();
  provider.getPlatformRazorpayCreds.mockReturnValue({
    keyId: "rzp_1",
    keySecret: "secret",
  });
  collect.settleAttempt.mockResolvedValue("captured");
  worker.advanceAfterPayment.mockResolvedValue(true);
  seed();
});

describe("★★ finding money", () => {
  it("settles an attempt the gateway says was CAPTURED", async () => {
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.recovered).toBe(1);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "captured",
      expect.objectContaining({ providerPaymentId: "pay_1" }),
    );
  });

  it("★★ ADVANCES THE CYCLE, or the merchant is downgraded for a payment they made", async () => {
    // The only thing that moves a cycle is a paid invoice being NOTICED.
    await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(worker.advanceAfterPayment).toHaveBeenCalledWith(STORE, NOW);
  });

  it("★ counts a LOST settle race as recovered — the money is recorded either way", async () => {
    collect.settleAttempt.mockResolvedValue(null);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.recovered).toBe(1);
  });

  it("★★ FLAGS an amount mismatch rather than silently accepting it", async () => {
    // The merchant paid, so the payment is recorded — but a different amount is
    // a question only a human can answer.
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([{ ...CAPTURED, amount: 400_000 }]) as any,
    });
    expect(res.recovered).toBe(1);
    expect(res.flagged).toBe(1);
    const flagged = dbHolder.current.calls.values.find(
      (v: any) => v.kind === "amount_mismatch",
    );
    expect(flagged).toMatchObject({
      expectedPaise: 500_000,
      observedPaise: 400_000,
    });
    // A live store's item names its store; no deleted-store marker.
    expect(flagged.detail).toEqual({
      note: "captured amount differs from the attempt",
    });
  });

  it("does not flag a matching amount", async () => {
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.flagged).toBe(0);
  });

  it("★ ignores a payment that is authorized but NOT captured", async () => {
    // Authorized is not money. Treating it as paid would mark an invoice settled
    // for funds that may never be captured.
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([
        { id: "pay_x", status: "authorized" },
      ]) as any,
    });
    expect(res.recovered).toBe(0);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★★ a payment captured for a DELETED store is recorded and flagged, not advanced", async () => {
    // Migration 0243 keeps a deleted store's attempts with store_id NULL. The
    // money is still recorded, but there is no plan to advance, and holding a
    // payment for a store that no longer exists is a human question.
    seed([attempt({ storeId: null })]);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.recovered).toBe(1);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "captured",
      expect.objectContaining({ providerPaymentId: "pay_1" }),
    );
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
    expect(res.flagged).toBe(1);
    const orphan = dbHolder.current.calls.values.find(
      (v: any) => v.kind === "orphan_payment",
    );
    expect(orphan).toMatchObject({
      storeId: null,
      invoiceId: "inv-1",
      attemptId: "att-1",
      providerPaymentId: "pay_1",
      expectedPaise: 500_000,
      observedPaise: 500_000,
    });
    // ★ Marked, so the queue says "store deleted" rather than pointing the
    //   operator at attributing a payment whose store is gone.
    expect(orphan.detail).toEqual({
      note: "payment captured for a deleted store",
      storeDeleted: true,
    });
  });

  describe("★★ a deleted store's payment on a CLOSED invoice is the refund pass's", () => {
    // deleteStore closes a live plan's unreached invoices before the store
    // goes (renewal-cancel, design 6.9), and the refund pass detects a captured
    // payment on an issued void or uncollectible invoice with no store at all.
    // Filing it as well would give one payment two owners.
    function seedDeleted(invoice: Record<string, unknown> | Error | null) {
      dbHolder.current = makeDbMock({
        selectQueue: [[attempt({ storeId: null })]],
        selectByTable: {
          billing_invoices: [
            invoice instanceof Error ? invoice : invoice ? [invoice] : [],
          ],
        },
      });
    }
    const ISSUED = "2026-09-01T00:00:00.000Z";

    it.each(["void", "uncollectible"])(
      "★★ records the money and files NO orphan item for an issued %s invoice",
      async (status) => {
        seedDeleted({ status, finalizedAt: ISSUED });
        const res = await reconcileStrandedAttempts({
          now: NOW,
          fetchOrderPayments: gateway([CAPTURED]) as any,
        });
        expect(res.recovered).toBe(1);
        expect(res.flagged).toBe(0);
        expect(dbHolder.current.calls.insert).toHaveLength(0);
        expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
        expect(logInfo).toHaveBeenCalledWith(
          "billing.reconcile.recovered_closed",
          { attemptId: "att-1", invoiceId: "inv-1" },
        );
      },
    );

    it("★ reads the invoice AFTER the settle, so it describes where the money landed", async () => {
      seedDeleted({ status: "void", finalizedAt: ISSUED });
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([CAPTURED]) as any,
      });
      const db = dbHolder.current.db;
      // Select #1 is the scan, select #2 the invoice re-read.
      expect(collect.settleAttempt.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(db.select).mock.invocationCallOrder[1]!,
      );
    });

    it.each([
      ["a kept draft", { status: "draft", finalizedAt: null }],
      // A closed DRAFT cannot be refunded (the refund guard refuses an
      // unissued invoice), so only a person can return that money.
      ["a closed draft", { status: "void", finalizedAt: null }],
      ["an open invoice", { status: "open", finalizedAt: ISSUED }],
    ])("★ the orphan flag STAYS for %s", async (_label, invoice) => {
      seedDeleted(invoice);
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([CAPTURED]) as any,
      });
      expect(res.flagged).toBe(1);
      expect(
        dbHolder.current.calls.values.find(
          (v: any) => v.kind === "orphan_payment",
        ),
      ).toBeTruthy();
    });

    it("★ an unreadable invoice is filed for a person, never assumed closed", async () => {
      seedDeleted(new Error("db down"));
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([CAPTURED]) as any,
      });
      expect(res.flagged).toBe(1);
      expect(res.errors).toBe(0);
    });

    it("★ a mismatch on a closed invoice is still flagged for a person", async () => {
      seedDeleted({ status: "void", finalizedAt: ISSUED });
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([{ ...CAPTURED, amount: 400_000 }]) as any,
      });
      expect(res.flagged).toBe(1);
      expect(dbHolder.current.calls.values).toEqual([
        expect.objectContaining({ kind: "amount_mismatch" }),
      ]);
    });

    it("a live store's payment never reads the invoice (the plan advances)", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[attempt()]],
        selectByTable: {
          billing_invoices: [[{ status: "void", finalizedAt: ISSUED }]],
        },
      });
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([CAPTURED]) as any,
      });
      expect(worker.advanceAfterPayment).toHaveBeenCalledWith(STORE, NOW);
      // The scan, the scan for attempts with no gateway order, and the scan
      // for checkouts closed while still payable. Never the invoice.
      expect(dbHolder.current.db.select).toHaveBeenCalledTimes(3);
    });
  });

  it("★ a mismatch on a DELETED store's payment is marked the same way", async () => {
    seed([attempt({ storeId: null })]);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([{ ...CAPTURED, amount: 400_000 }]) as any,
    });
    expect(res.flagged).toBe(2);
    const mismatch = dbHolder.current.calls.values.find(
      (v: any) => v.kind === "amount_mismatch",
    );
    expect(mismatch).toMatchObject({
      storeId: null,
      detail: {
        note: "captured amount differs from the attempt",
        storeDeleted: true,
      },
    });
  });
});

describe("★★ declaring failure", () => {
  it("REFUSES to fail an attempt inside the window, however stale", async () => {
    // It may still land. Failing it frees the invoice and invites a second
    // charge for the same cycle.
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(res.failed).toBe(0);
    expect(res.stillUnknown).toBe(1);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it(`fails one older than ${FAIL_AFTER_HOURS}h with nothing captured`, async () => {
    collect.settleAttempt.mockResolvedValue("failed");
    seed([attempt({ createdAt: ANCIENT })]);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(res.failed).toBe(1);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "failed",
      expect.objectContaining({ failureCode: "reconciled_no_payment" }),
    );
  });

  // 21 Nov 2026: a debit the renewal pass sent, which the gateway itself
  // reports failed, no longer waits 72 hours to count as failed.
  describe("★★ an automatic debit the gateway reports failed", () => {
    const FAILED_PAYMENT = { id: "pay_f", status: "failed", amount: 500_000 };

    it("is failed at once, inside the 72-hour window", async () => {
      collect.settleAttempt.mockResolvedValue("failed");
      seed([attempt({ mode: "automatic" })]);
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([FAILED_PAYMENT]) as any,
      });
      expect(res.failed).toBe(1);
      expect(res.stillUnknown).toBe(0);
      expect(collect.settleAttempt).toHaveBeenCalledWith(
        "att-1",
        "failed",
        expect.objectContaining({ failureCode: "gateway_failed" }),
      );
    });

    it("★ then asks whether that was the last try (the announcement decides)", async () => {
      collect.settleAttempt.mockResolvedValue("failed");
      seed([attempt({ mode: "automatic" })]);
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([FAILED_PAYMENT]) as any,
      });
      expect(worker.announceAutopayStopped).toHaveBeenCalledWith({
        storeId: STORE,
        invoiceId: "inv-1",
        now: NOW,
      });
    });

    it("★★ a MANUAL checkout with a failed try is left alone: its order is still payable", async () => {
      seed([attempt({ mode: "manual" })]);
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([FAILED_PAYMENT]) as any,
      });
      expect(res.failed).toBe(0);
      expect(res.stillUnknown).toBe(1);
      expect(collect.settleAttempt).not.toHaveBeenCalled();
      expect(worker.announceAutopayStopped).not.toHaveBeenCalled();
    });

    it("★ waits while any payment on the order is not failed, or none exists yet", async () => {
      for (const payments of [
        [],
        [FAILED_PAYMENT, { id: "pay_c", status: "created", amount: 500_000 }],
        [{ id: "pay_a", status: "authorized", amount: 500_000 }],
      ]) {
        vi.clearAllMocks();
        provider.getPlatformRazorpayCreds.mockReturnValue({
          keyId: "rzp_1",
          keySecret: "secret",
        });
        seed([attempt({ mode: "automatic" })]);
        const res = await reconcileStrandedAttempts({
          now: NOW,
          fetchOrderPayments: gateway(payments) as any,
        });
        expect(res.failed).toBe(0);
        expect(collect.settleAttempt).not.toHaveBeenCalled();
      }
    });

    it("a failure a concurrent settle recorded is not announced twice", async () => {
      collect.settleAttempt.mockResolvedValue(null);
      seed([attempt({ mode: "automatic" })]);
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([FAILED_PAYMENT]) as any,
      });
      expect(worker.announceAutopayStopped).not.toHaveBeenCalled();
    });

    it("the 72-hour failure of an automatic debit asks too; a deleted store's does not", async () => {
      collect.settleAttempt.mockResolvedValue("failed");
      seed([attempt({ mode: "automatic", createdAt: ANCIENT })]);
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      expect(worker.announceAutopayStopped).toHaveBeenCalledTimes(1);

      vi.mocked(worker.announceAutopayStopped).mockClear();
      seed([attempt({ mode: "automatic", storeId: null })]);
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([FAILED_PAYMENT]) as any,
      });
      expect(worker.announceAutopayStopped).not.toHaveBeenCalled();
    });
  });

  // PR #303 re-review, 22 Nov 2026. Closing an attempt does not close its
  // Razorpay order: a Checkout window left open in another tab can still pay
  // it. The pass read only attempts still in flight, so such a payment was
  // recorded nowhere unless its webhook arrived.
  describe("★★ a payment made on a checkout that had already been closed", () => {
    const closed = (over: Record<string, unknown> = {}) => ({
      id: "att-old",
      storeId: STORE,
      invoiceId: "inv-1",
      providerOrderId: "order_old",
      amountPaise: 500_000,
      state: "cancelled",
      failureCode: "amount_changed",
      mode: "manual",
      ...over,
    });
    /** Select #1 the main scan, #2 the orderless scan, #3 closed checkouts. */
    const seedClosed = (rows: any[] | Error) =>
      (dbHolder.current = makeDbMock({ selectQueue: [[], [], rows] }));

    it("is filed for a person, with what was paid and why the checkout was closed", async () => {
      seedClosed([closed()]);
      const fetchOrderPayments = gateway([CAPTURED]);
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: fetchOrderPayments as any,
      });
      expect(fetchOrderPayments).toHaveBeenCalledWith(
        expect.anything(),
        "order_old",
      );
      expect(collect.fileClosedAttemptPayment).toHaveBeenCalledWith({
        storeId: STORE,
        invoiceId: "inv-1",
        attemptId: "att-old",
        providerPaymentId: "pay_1",
        providerOrderId: "order_old",
        expectedPaise: 500_000,
        observedPaise: 500_000,
        closedAs: "cancelled",
        closedCode: "amount_changed",
        automatic: false,
        source: "reconcile",
        now: NOW,
      });
      expect(res.paidAfterClose).toBe(1);
      // ★ Never applied here: the closed attempt is not settled, and no plan
      // is moved. Whether it settles the invoice or goes back is a person's.
      expect(collect.settleAttempt).not.toHaveBeenCalled();
      expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
    });

    it("★ one already filed (even resolved) is not counted again", async () => {
      collect.fileClosedAttemptPayment.mockResolvedValueOnce(false);
      seedClosed([closed()]);
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([CAPTURED]) as any,
      });
      expect(res.paidAfterClose).toBe(0);
    });

    it("no payment on the order, or a gateway that cannot be read, files nothing", async () => {
      seedClosed([closed()]);
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      seedClosed([closed()]);
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: vi.fn(async () => ({
          ok: false as const,
          error: "timeout",
          outcome: "unknown" as const,
        })) as any,
      });
      expect(collect.fileClosedAttemptPayment).not.toHaveBeenCalled();
    });

    // The next review, same day: "a failed debit is final" is not something
    // Razorpay promises. A renewal debit reported failed can be authorised
    // late by the bank and captured, and with a missed webhook nothing else
    // read it.
    it("★★ a renewal DEBIT recorded as failed and captured later is filed too, as an automatic one", async () => {
      seedClosed([
        closed({
          id: "att-auto",
          mode: "automatic",
          state: "failed",
          failureCode: "gateway_failed",
        }),
      ]);
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([CAPTURED]) as any,
      });
      expect(collect.fileClosedAttemptPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: "att-auto",
          automatic: true,
          closedCode: "gateway_failed",
          source: "reconcile",
        }),
      );
      expect(res.paidAfterClose).toBe(1);
    });

    it("★ asks about closed attempts of the last 72 hours that hold an order: every MANUAL one, and an automatic one only when its debit was SENT", async () => {
      seedClosed([]);
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[2]);
      expect(where.sql).toContain('"state" in');
      expect(where.params).toEqual(
        expect.arrayContaining(["failed", "cancelled", "manual"]),
      );
      // An automatic attempt that ended before its debit cannot be paid.
      expect(where.sql).toMatch(
        /"mode" = \$\d+ or [^)]*"debit_sent_at" is not null or [^)]*"provider_payment_id" is not null/,
      );
      expect(where.sql).toContain('"provider_order_id" is not null');
      expect(where.sql).toContain('"resolved_at" >');
      expect(where.params).toContain(
        new Date(NOW.getTime() - FAIL_AFTER_HOURS * 3_600_000).toISOString(),
      );
    });

    it("a failed scan is one error and stops nothing else", async () => {
      seedClosed(new Error("db down"));
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      expect(res.errors).toBe(1);
      expect(collect.capturedDraftPurchases).toHaveBeenCalled();
    });
  });

  // 21 Nov 2026: an attempt whose gateway order was never recorded used to be
  // skipped for ever, so its invoice read `processing` indefinitely.
  describe("★★ an attempt that never got a gateway order", () => {
    const orderless = (over: Record<string, unknown> = {}) => ({
      id: "att-x",
      storeId: STORE,
      invoiceId: "inv-9",
      mode: "manual",
      ...over,
    });
    /** Select #1 is the main scan (nothing), select #2 the orderless scan. */
    const seedOrderless = (rows: any[]) =>
      (dbHolder.current = makeDbMock({ selectQueue: [[], rows] }));

    it("is closed as failed once it is stale: nothing could ever be paid on it", async () => {
      collect.settleAttempt.mockResolvedValue("failed");
      seedOrderless([orderless()]);
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      expect(res.orderless).toBe(1);
      expect(collect.settleAttempt).toHaveBeenCalledWith(
        "att-x",
        "failed",
        expect.objectContaining({ failureCode: "no_gateway_order" }),
      );
    });

    it("★ asks only about attempts with NO order and NO payment id, older than the stale window", async () => {
      seedOrderless([]);
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[1]);
      expect(where.sql).toContain('"provider_order_id" is null');
      expect(where.sql).toContain('"provider_payment_id" is null');
      expect(where.sql).toContain('"created_at" <');
      expect(where.params).toContain(
        new Date(NOW.getTime() - STALE_AFTER_MINUTES * 60_000).toISOString(),
      );
    });

    it("an automatic one asks whether that was the last try; a manual one does not", async () => {
      collect.settleAttempt.mockResolvedValue("failed");
      seedOrderless([orderless({ mode: "automatic" })]);
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      expect(worker.announceAutopayStopped).toHaveBeenCalledWith({
        storeId: STORE,
        invoiceId: "inv-9",
        now: NOW,
      });

      vi.mocked(worker.announceAutopayStopped).mockClear();
      seedOrderless([orderless()]);
      await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      expect(worker.announceAutopayStopped).not.toHaveBeenCalled();
    });

    it("one a concurrent settle moved is not counted; a failed scan is one error", async () => {
      collect.settleAttempt.mockResolvedValue(null);
      seedOrderless([orderless()]);
      expect(
        (
          await reconcileStrandedAttempts({
            now: NOW,
            fetchOrderPayments: gateway([]) as any,
          })
        ).orderless,
      ).toBe(0);

      dbHolder.current = makeDbMock({
        selectQueue: [[], new Error("db down")],
      });
      expect(
        (
          await reconcileStrandedAttempts({
            now: NOW,
            fetchOrderPayments: gateway([]) as any,
          })
        ).errors,
      ).toBe(1);
    });
  });

  describe("★ an automatic debit whose order never got a payment", () => {
    const hoursOld = (h: number) =>
      new Date(NOW.getTime() - h * 3_600_000).toISOString();

    it(`is failed after ${AUTO_NO_PAYMENT_FAIL_AFTER_HOURS}h, not 72: the merchant can then pay by hand`, async () => {
      collect.settleAttempt.mockResolvedValue("failed");
      seed([
        attempt({
          mode: "automatic",
          state: "unknown",
          createdAt: hoursOld(AUTO_NO_PAYMENT_FAIL_AFTER_HOURS + 1),
        }),
      ]);
      const res = await reconcileStrandedAttempts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      expect(res.failed).toBe(1);
      expect(collect.settleAttempt).toHaveBeenCalledWith(
        "att-1",
        "failed",
        expect.objectContaining({ failureCode: "reconciled_no_payment" }),
      );
    });

    it("waits inside those hours, and a MANUAL checkout keeps the full window", async () => {
      seed([
        attempt({
          mode: "automatic",
          createdAt: hoursOld(AUTO_NO_PAYMENT_FAIL_AFTER_HOURS - 1),
        }),
      ]);
      expect(
        (
          await reconcileStrandedAttempts({
            now: NOW,
            fetchOrderPayments: gateway([]) as any,
          })
        ).failed,
      ).toBe(0);

      seed([
        attempt({
          mode: "manual",
          createdAt: hoursOld(AUTO_NO_PAYMENT_FAIL_AFTER_HOURS + 20),
        }),
      ]);
      expect(
        (
          await reconcileStrandedAttempts({
            now: NOW,
            fetchOrderPayments: gateway([]) as any,
          })
        ).failed,
      ).toBe(0);
      expect(collect.settleAttempt).not.toHaveBeenCalled();
    });

    // 21 Nov 2026: a renewal's order is created a day or more before its
    // debit is sent, and lists no payment for all that time by design.
    describe("★★ a notified renewal: the clocks run from when the DEBIT was sent", () => {
      it("an attempt still waiting out its notice period is not read at all", async () => {
        seed([]);
        await reconcileStrandedAttempts({
          now: NOW,
          fetchOrderPayments: gateway([]) as any,
        });
        const where = new PgDialect().sqlToQuery(
          dbHolder.current.calls.where[0] as never,
        );
        // Either it was never a notified attempt, or its debit has been sent.
        expect(where.sql).toContain(
          '("billing_payment_attempts"."debit_after" is null or "billing_payment_attempts"."debit_sent_at" is not null)',
        );
      });

      it("opened two days ago, debit sent an hour ago: not failed as never sent", async () => {
        seed([
          attempt({
            mode: "automatic",
            createdAt: hoursOld(48),
            debitSentAt: hoursOld(1),
          }),
        ]);
        const res = await reconcileStrandedAttempts({
          now: NOW,
          fetchOrderPayments: gateway([]) as any,
        });
        expect(res.failed).toBe(0);
        expect(collect.settleAttempt).not.toHaveBeenCalled();
      });

      it(`debit sent more than ${AUTO_NO_PAYMENT_FAIL_AFTER_HOURS}h ago with no payment: failed, so the next try can start`, async () => {
        collect.settleAttempt.mockResolvedValue("failed");
        seed([
          attempt({
            mode: "automatic",
            createdAt: hoursOld(48),
            debitSentAt: hoursOld(AUTO_NO_PAYMENT_FAIL_AFTER_HOURS + 1),
          }),
        ]);
        const res = await reconcileStrandedAttempts({
          now: NOW,
          fetchOrderPayments: gateway([]) as any,
        });
        expect(res.failed).toBe(1);
      });

      it(`★ a debit still pending is not given up ${FAIL_AFTER_HOURS}h after the ATTEMPT opened`, async () => {
        // The attempt is older than the long window, but its debit went out
        // two hours ago and the gateway lists a payment still in progress.
        seed([
          attempt({
            mode: "automatic",
            createdAt: hoursOld(FAIL_AFTER_HOURS + 5),
            debitSentAt: hoursOld(2),
          }),
        ]);
        const res = await reconcileStrandedAttempts({
          now: NOW,
          fetchOrderPayments: gateway([
            { id: "pay_1", status: "created", amount: 500_000 },
          ]) as any,
        });
        expect(res.failed).toBe(0);
        expect(collect.settleAttempt).not.toHaveBeenCalledWith(
          "att-1",
          "failed",
          expect.anything(),
        );
      });
    });
  });

  it("★★ an ANCIENT attempt that WAS captured is recovered, never failed", async () => {
    // Age is not evidence. The gateway's answer is.
    seed([attempt({ createdAt: ANCIENT })]);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.recovered).toBe(1);
    expect(res.failed).toBe(0);
  });
});

describe("★★ never guessing", () => {
  it("does NOTHING when the gateway is unreachable", async () => {
    seed([attempt({ createdAt: ANCIENT })]);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: vi.fn(async () => ({
        ok: false as const,
        error: "timeout",
        outcome: "unknown" as const,
      })) as any,
    });
    // Unreachable is not a verdict — especially not for the FAIL path.
    expect(res.stillUnknown).toBe(1);
    expect(res.failed).toBe(0);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★★ does NOTHING with no platform credentials", async () => {
    provider.getPlatformRazorpayCreds.mockReturnValue(null);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.considered).toBe(0);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ does NOTHING with no gateway reader injected", async () => {
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: null,
    });
    expect(res.considered).toBe(0);
  });

  it("★ survives a scan failure without claiming a clean sweep", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.errors).toBe(1);
    expect(res.recovered).toBe(0);
  });

  it("★ one bad attempt does not abort the sweep", async () => {
    seed([attempt({ id: "att-1" }), attempt({ id: "att-2" })]);
    const fetchOrderPayments = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ ok: true, data: [CAPTURED] });
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: fetchOrderPayments as any,
    });
    expect(res.errors).toBe(1);
    expect(res.recovered).toBe(1);
  });

  it("★ the stale window is applied to the QUERY, not after the fact", async () => {
    // Asking the gateway about a live checkout is pointless; the filter keeps a
    // busy sweep cheap and never touches a payment in progress.
    await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(STALE_AFTER_MINUTES).toBeGreaterThan(0);
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Finishing purchases a closed tab left on a draft invoice (RC-F1b).
// ---------------------------------------------------------------------------

function draftPurchase(over: Record<string, unknown> = {}) {
  return {
    attemptId: "att-9",
    invoiceId: "inv-9",
    storeId: STORE,
    kind: "subscription",
    providerOrderId: "order_9",
    providerPaymentId: "pay_9",
    amountPaise: 500_000,
    currency: "INR",
    createdAt: STALE,
    ...over,
  };
}

describe("★★ finishing a purchase whose confirm never came (RC-F1b)", () => {
  beforeEach(() => seed([]));

  it("★★ finishes a captured enrolment through the confirm's own completion", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([draftPurchase()]);
    const fetchOrderPayments = gateway([CAPTURED]);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: fetchOrderPayments as any,
    });
    expect(res.completed).toBe(1);
    expect(enrol.completeEnrolmentPurchase).toHaveBeenCalledWith({
      storeId: STORE,
      invoiceId: "inv-9",
      attemptId: "att-9",
      providerPaymentId: null,
      source: "recovery",
      verifyCapture: true,
      fetchOrderPayments: expect.any(Function),
      // The gateway's answer carries no created_at: the issue reads now.
      paidAt: undefined,
      now: NOW,
    });
    expect(logInfo).toHaveBeenCalledWith(
      "billing.reconcile.purchase_completed",
      expect.objectContaining({ attemptId: "att-9", outcome: "completed" }),
    );
  });

  it("★★ the capture's own time goes into the completion (GST paidAt), from ONE gateway read", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([draftPurchase()]);
    const answer = {
      ok: true as const,
      data: [{ ...CAPTURED, id: "pay_9", created_at: 1_757_440_800 }],
    };
    const fetchOrderPayments = vi.fn(async () => answer);
    await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: fetchOrderPayments as any,
    });
    const input = (enrol.completeEnrolmentPurchase.mock.calls[0] as any[])[0];
    expect(input.paidAt).toEqual(new Date(1_757_440_800 * 1000));
    // The completion is handed the same answer: the gateway is not asked
    // again for this order.
    expect(await input.fetchOrderPayments({}, "order_9")).toBe(answer);
    expect(fetchOrderPayments).toHaveBeenCalledTimes(1);
  });

  it("★ a read that fails is not shared: the completion asks again itself", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([draftPurchase()]);
    const fetchOrderPayments = vi.fn(async () => ({
      ok: false as const,
      error: "timeout",
      outcome: "unknown" as const,
    }));
    await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: fetchOrderPayments as any,
    });
    expect(enrol.completeEnrolmentPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ fetchOrderPayments, paidAt: undefined }),
    );
  });

  it("★ looks only at captures older than the stale window and not held by a person", async () => {
    await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(collect.capturedDraftPurchases).toHaveBeenCalledWith({
      createdBefore: new Date(
        NOW.getTime() - STALE_AFTER_MINUTES * 60_000,
      ).toISOString(),
      excludeHeld: true,
      limit: 50,
    });
  });

  it("★★ an add-on order that names a plan change goes to the plan change, with the ORDER's target", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([
      draftPurchase({ kind: "addon" }),
    ]);
    collect.readAddonOrderTarget.mockResolvedValue({
      kind: "plan_change",
      plan: "pro",
      period: "yearly",
    });
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(res.completed).toBe(1);
    expect(planChange.completePlanChangePurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "att-9",
        source: "recovery",
        verifyCapture: true,
        target: { plan: "pro", period: "yearly" },
      }),
    );
    expect(locations.completeLocationPurchase).not.toHaveBeenCalled();
  });

  it("★★ an add-on order that names locations goes to the location purchase", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([
      draftPurchase({ kind: "addon" }),
    ]);
    collect.readAddonOrderTarget.mockResolvedValue({
      kind: "locations",
      count: 3,
    });
    await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(locations.completeLocationPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "att-9", source: "recovery" }),
    );
  });

  it("★ an add-on order that names neither is filed for a person, nothing applied", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([
      draftPurchase({ kind: "addon" }),
    ]);
    collect.readAddonOrderTarget.mockResolvedValue({ kind: "unknown" });
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(res.flagged).toBe(1);
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        repairKey: "purchase_refused:att-9",
        purchase: "unknown",
        kind: "state_conflict",
      }),
    );
    expect(planChange.completePlanChangePurchase).not.toHaveBeenCalled();
    expect(locations.completeLocationPurchase).not.toHaveBeenCalled();
  });

  it("★ an unreadable add-on order is left for the next pass", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([
      draftPurchase({ kind: "addon" }),
    ]);
    collect.readAddonOrderTarget.mockResolvedValue(null);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(res.stillUnknown).toBe(1);
    expect(res.completed).toBe(0);
    expect(collect.fileRecoveredPurchase).not.toHaveBeenCalled();
  });

  it("★ a refused completion counts as flagged; a waiting one as still unknown", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([
      draftPurchase({ attemptId: "att-a" }),
      draftPurchase({ attemptId: "att-b" }),
    ]);
    enrol.completeEnrolmentPurchase
      .mockResolvedValueOnce({ status: "refused" })
      .mockResolvedValueOnce({ status: "not_ready" });
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(res.flagged).toBe(1);
    expect(res.stillUnknown).toBe(1);
    expect(res.completed).toBe(0);
  });

  it("★ one completion that throws does not stop the next", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([
      draftPurchase({ attemptId: "att-a" }),
      draftPurchase({ attemptId: "att-b" }),
    ]);
    enrol.completeEnrolmentPurchase
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "already_complete" });
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(res.errors).toBe(1);
    expect(res.completed).toBe(1);
  });

  it("★ an unreadable scan is an error, never a clean sweep", async () => {
    collect.capturedDraftPurchases.mockResolvedValue(null);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(res.errors).toBe(1);
  });

  it("★★ runs after the in-flight attempts are settled, in the same pass", async () => {
    seed([attempt()]);
    collect.capturedDraftPurchases.mockResolvedValue([draftPurchase()]);
    await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(collect.settleAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      collect.capturedDraftPurchases.mock.invocationCallOrder[0],
    );
  });

  it("★★ nothing is finished without platform credentials", async () => {
    provider.getPlatformRazorpayCreds.mockReturnValue(null);
    collect.capturedDraftPurchases.mockResolvedValue([draftPurchase()]);
    await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(collect.capturedDraftPurchases).not.toHaveBeenCalled();
    expect(enrol.completeEnrolmentPurchase).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The repair pass: a captured payment's invoice left as a draft (GST A4).
// ---------------------------------------------------------------------------

/** A capture an hour and more old: the pass's to repair. */
const TWO_HOURS_AGO = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
/** Razorpay's created_at for that payment, in seconds. */
const PAID_SECONDS = Math.floor(
  (NOW.getTime() - 2 * 3_600_000 - 60_000) / 1000,
);
const PAID_AT = new Date(PAID_SECONDS * 1000);

function purchaseDraft(over: Record<string, unknown> = {}) {
  return {
    attemptId: "att-5",
    invoiceId: "inv-5",
    storeId: STORE,
    kind: "subscription",
    providerOrderId: "order_5",
    providerPaymentId: "pay_5",
    amountPaise: 500_000,
    currency: "INR",
    createdAt: TWO_HOURS_AGO,
    resolvedAt: TWO_HOURS_AGO,
    held: false,
    ...over,
  };
}

function creditDraft(over: Record<string, unknown> = {}) {
  return {
    purchaseId: "purchase-1",
    invoiceId: "inv-c",
    storeId: STORE,
    rzpPaymentId: "pay_c",
    updatedAt: TWO_HOURS_AGO,
    ...over,
  };
}

/** The pass's reads, by table: the drafts, the credit receipts, and (each
 *  time it is about to file) whether a person already holds the payment. */
function seedDrafts(
  opts: {
    purchases?: unknown[];
    credits?: unknown[];
    items?: unknown[][];
  } = {},
) {
  dbHolder.current = makeDbMock({
    selectByTable: {
      billing_payment_attempts: [opts.purchases ?? []],
      ai_credit_purchases: [opts.credits ?? []],
      billing_reconciliation_items: opts.items ?? [[]],
    },
  });
}

/** The gateway's payment, with the moment it was made. */
const paymentRead = () =>
  vi.fn(async () => ({
    ok: true as const,
    data: { id: "pay_5", created_at: PAID_SECONDS },
  }));

/** The rendered SQL and parameters of every WHERE the pass ran. */
const renderedWheres = () =>
  dbHolder.current.calls.where.map((clause: any) =>
    new PgDialect().sqlToQuery(clause),
  );

describe("★★ the repair pass: a captured payment's invoice left as a draft", () => {
  beforeEach(() => seedDrafts());

  describe("which drafts it takes", () => {
    it("★★ waits an hour from the capture, IN THE QUERY, for the confirm and the completion to go first", () => {
      const cutoff = new Date(
        NOW.getTime() - CAPTURED_DRAFT_WAIT_MINUTES * 60_000,
      ).toISOString();
      const purchases = new PgDialect().sqlToQuery(
        capturedDraftsWhere({ now: NOW, storeId: null })!,
      );
      expect(CAPTURED_DRAFT_WAIT_MINUTES).toBe(60);
      expect(purchases.sql).toContain(
        '"billing_payment_attempts"."resolved_at" < $',
      );
      expect(purchases.params).toContain(cutoff);
      expect(purchases.sql).toContain('"billing_payment_attempts"."state" = $');
      expect(purchases.params).toContain("captured");
      expect(purchases.sql).toContain('"billing_invoices"."status" = $');
      expect(purchases.params).toContain("draft");
      expect(purchases.sql).toContain(
        '"billing_invoices"."finalized_at" is null',
      );
      const credits = new PgDialect().sqlToQuery(
        creditDraftsWhere({ now: NOW, storeId: null })!,
      );
      expect(credits.sql).toContain('"ai_credit_purchases"."updated_at" < $');
      expect(credits.params).toContain(cutoff);
      expect(credits.params).toContain("ai_credits");
    });

    it("★★ the pass runs those very conditions", async () => {
      await issueCapturedDrafts({ now: NOW });
      const sqls = renderedWheres().map((q: { sql: string }) => q.sql);
      expect(sqls).toContain(
        new PgDialect().sqlToQuery(
          capturedDraftsWhere({ now: NOW, storeId: null })!,
        ).sql,
      );
      expect(sqls).toContain(
        new PgDialect().sqlToQuery(
          creditDraftsWhere({ now: NOW, storeId: null })!,
        ).sql,
      );
    });

    it("★★ with storeId: that one store's drafts, and no wait", () => {
      const purchases = new PgDialect().sqlToQuery(
        capturedDraftsWhere({ now: NOW, storeId: "store-9" })!,
      );
      expect(purchases.sql).toContain(
        '"billing_payment_attempts"."store_id" = $',
      );
      expect(purchases.params).toContain("store-9");
      expect(purchases.sql).not.toContain("resolved_at");
      const credits = new PgDialect().sqlToQuery(
        creditDraftsWhere({ now: NOW, storeId: "store-9" })!,
      );
      expect(credits.sql).toContain('"ai_credit_purchases"."store_id" = $');
      expect(credits.params).toContain("store-9");
      expect(credits.sql).not.toContain("updated_at");
    });
  });

  describe("a subscription or add-on draft", () => {
    it("★★ goes to the purchase's own completion first, with the capture's time", async () => {
      seedDrafts({ purchases: [purchaseDraft()] });
      const res = await issueCapturedDrafts({
        now: NOW,
        fetchOrderPayments: vi.fn(async () => ({
          ok: true as const,
          data: [
            {
              ...CAPTURED,
              id: "pay_5",
              order_id: "order_5",
              created_at: PAID_SECONDS,
            },
          ],
        })) as any,
        fetchPayment: paymentRead() as any,
      });
      expect(res).toMatchObject({ considered: 1, completed: 1, issued: 0 });
      expect(enrol.completeEnrolmentPurchase).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: STORE,
          invoiceId: "inv-5",
          attemptId: "att-5",
          source: "recovery",
          verifyCapture: true,
          paidAt: PAID_AT,
        }),
      );
      // Completed means issued, paid and applied: nothing left to do here.
      expect(store.issueInvoice).not.toHaveBeenCalled();
      expect(collect.settleAttempt).not.toHaveBeenCalled();
      expect(collect.fileRecoveredPurchase).not.toHaveBeenCalled();
    });

    it("★★ the completion declined: issued alone at the capture's time, settled (paid, NO receipt), filed once", async () => {
      seedDrafts({ purchases: [purchaseDraft()], items: [[]] });
      enrol.completeEnrolmentPurchase.mockResolvedValue({ status: "refused" });
      const res = await issueCapturedDrafts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
        fetchPayment: paymentRead() as any,
      });
      expect(store.issueInvoice).toHaveBeenCalledWith({
        invoiceId: "inv-5",
        now: NOW,
        paidAt: PAID_AT,
      });
      // The capture is recorded already; settling it again makes the issued
      // invoice paid (RC-F1). ★★ R1-04: with NO receipt: the purchase was not
      // applied and a person is checking it, so "Your plan is active" is untrue.
      expect(collect.settleAttempt).toHaveBeenCalledTimes(1);
      expect(collect.settleAttempt).toHaveBeenCalledWith("att-5", "captured", {
        now: NOW,
        notify: false,
      });
      expect(store.issueInvoice.mock.invocationCallOrder[0]).toBeLessThan(
        collect.settleAttempt.mock.invocationCallOrder[0],
      );
      expect(collect.fileRecoveredPurchase).toHaveBeenCalledTimes(1);
      expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith({
        storeId: STORE,
        kind: "state_conflict",
        repairKey: "captured_draft:inv-5",
        note: CAPTURED_DRAFT_REPAIR.detail,
        invoiceId: "inv-5",
        attemptId: "att-5",
        providerPaymentId: "pay_5",
        providerOrderId: "order_5",
        expectedPaise: 500_000,
        purchase: "enrolment",
        now: NOW,
      });
      expect(res).toMatchObject({ issued: 1, filed: 1, completed: 0 });
    });

    it("★★ never applies what was bought: no plan, no plan change, no location", async () => {
      seedDrafts({ purchases: [purchaseDraft({ kind: "addon" })] });
      collect.readAddonOrderTarget.mockResolvedValue({ kind: "unknown" });
      await issueCapturedDrafts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
        fetchPayment: paymentRead() as any,
      });
      // The completion's own refusal (an order naming neither) was filed,
      // and the draft was then issued alone.
      expect(store.issueInvoice).toHaveBeenCalledTimes(1);
      expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
      expect(planChange.completePlanChangePurchase).not.toHaveBeenCalled();
      expect(locations.completeLocationPurchase).not.toHaveBeenCalled();
    });

    it("★★ none filed when RC-F1b (or anyone) already holds the payment", async () => {
      seedDrafts({ purchases: [purchaseDraft()], items: [[{ id: "item-1" }]] });
      enrol.completeEnrolmentPurchase.mockResolvedValue({ status: "refused" });
      const res = await issueCapturedDrafts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
        fetchPayment: paymentRead() as any,
      });
      expect(store.issueInvoice).toHaveBeenCalledTimes(1);
      expect(collect.settleAttempt).toHaveBeenCalledTimes(1);
      expect(collect.fileRecoveredPurchase).not.toHaveBeenCalled();
      expect(res).toMatchObject({ issued: 1, filed: 0 });
      // The question asked: an open or in-review item about this attempt or
      // this payment.
      const held = renderedWheres().find((q: { sql: string }) =>
        q.sql.includes('"billing_reconciliation_items"."status"'),
      );
      expect(held.params).toEqual(
        expect.arrayContaining(["open", "manual_review", "att-5", "pay_5"]),
      );
    });

    it("★★ a payment a person already holds skips the completion and is issued alone", async () => {
      seedDrafts({ purchases: [purchaseDraft({ held: true })], items: [[]] });
      const res = await issueCapturedDrafts({
        now: NOW,
        fetchPayment: paymentRead() as any,
      });
      expect(enrol.completeEnrolmentPurchase).not.toHaveBeenCalled();
      expect(store.issueInvoice).toHaveBeenCalledTimes(1);
      expect(collect.settleAttempt).toHaveBeenCalledTimes(1);
      expect(res.issued).toBe(1);
    });

    it("★★ with storeId (deleteStore): issued only, never completed", async () => {
      seedDrafts({ purchases: [purchaseDraft()], items: [[]] });
      const res = await issueCapturedDrafts({
        now: NOW,
        storeId: STORE,
        fetchOrderPayments: gateway([CAPTURED]) as any,
        fetchPayment: paymentRead() as any,
      });
      expect(enrol.completeEnrolmentPurchase).not.toHaveBeenCalled();
      expect(planChange.completePlanChangePurchase).not.toHaveBeenCalled();
      expect(locations.completeLocationPurchase).not.toHaveBeenCalled();
      expect(store.issueInvoice).toHaveBeenCalledWith({
        invoiceId: "inv-5",
        now: NOW,
        paidAt: PAID_AT,
      });
      expect(collect.settleAttempt).toHaveBeenCalledWith("att-5", "captured", {
        now: NOW,
        notify: false,
      });
      expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
        expect.objectContaining({ repairKey: "captured_draft:inv-5" }),
      );
      expect(res).toMatchObject({ issued: 1, filed: 1, completed: 0 });
    });

    it("★★ a completion that is not ready changes nothing and is reported as still a draft", async () => {
      seedDrafts({ purchases: [purchaseDraft()] });
      enrol.completeEnrolmentPurchase.mockResolvedValue({
        status: "not_ready",
      });
      const res = await issueCapturedDrafts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      // Issuing it alone would take it out of every completion's reach.
      expect(store.issueInvoice).not.toHaveBeenCalled();
      expect(collect.settleAttempt).not.toHaveBeenCalled();
      expect(res).toMatchObject({ deferred: 1, unissued: 1, issued: 0 });
      // ★ R1-14: two hours in, it is retried next pass: a WARNING, never an
      // ERROR that pages for a gateway blip.
      expect(logWarn).toHaveBeenCalledWith("billing.captured_draft_unissued", {
        invoiceId: "inv-5",
        attemptId: "att-5",
        storeId: STORE,
        reason: "its completion was not ready",
        waitedHours: 2,
      });
      expect(logError).not.toHaveBeenCalledWith(
        "billing.captured_draft_unissued",
        expect.anything(),
        expect.anything(),
      );
    });

    it("★★ R1-14: still a draft six hours after the capture, it is an ERROR, with how long it waited", async () => {
      const SEVEN_HOURS_AGO = new Date(
        NOW.getTime() - 7 * 3_600_000,
      ).toISOString();
      seedDrafts({
        purchases: [
          purchaseDraft({
            createdAt: SEVEN_HOURS_AGO,
            resolvedAt: SEVEN_HOURS_AGO,
          }),
        ],
      });
      enrol.completeEnrolmentPurchase.mockResolvedValue({
        status: "not_ready",
      });
      await issueCapturedDrafts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      expect(logError).toHaveBeenCalledWith(
        "billing.captured_draft_unissued",
        expect.objectContaining({ message: "its completion was not ready" }),
        {
          invoiceId: "inv-5",
          attemptId: "att-5",
          storeId: STORE,
          waitedHours: 7,
        },
      );
      expect(logWarn).not.toHaveBeenCalledWith(
        "billing.captured_draft_unissued",
        expect.anything(),
      );
    });

    it("★ with no platform credentials it cannot finish, so it waits and says so", async () => {
      provider.getPlatformRazorpayCreds.mockReturnValue(null);
      seedDrafts({ purchases: [purchaseDraft()] });
      const res = await issueCapturedDrafts({ now: NOW });
      expect(enrol.completeEnrolmentPurchase).not.toHaveBeenCalled();
      expect(store.issueInvoice).not.toHaveBeenCalled();
      expect(res).toMatchObject({ deferred: 1, unissued: 1 });
    });

    it("★ the settle saying it is not captured any more: nothing issued, nothing filed", async () => {
      seedDrafts({ purchases: [purchaseDraft()] });
      enrol.completeEnrolmentPurchase.mockResolvedValue({
        status: "not_captured",
      });
      const res = await issueCapturedDrafts({
        now: NOW,
        fetchOrderPayments: gateway([]) as any,
      });
      expect(store.issueInvoice).not.toHaveBeenCalled();
      expect(collect.fileRecoveredPurchase).not.toHaveBeenCalled();
      expect(res).toMatchObject({ issued: 0, unissued: 0, deferred: 0 });
    });

    it("★★ an issue that fails is reported as still a draft, never settled or filed", async () => {
      seedDrafts({ purchases: [purchaseDraft({ held: true })] });
      store.issueInvoice.mockResolvedValue({
        invoice: null,
        claimed: false,
        restamp: "unchanged",
      });
      const res = await issueCapturedDrafts({
        now: NOW,
        fetchPayment: paymentRead() as any,
      });
      expect(collect.settleAttempt).not.toHaveBeenCalled();
      expect(collect.fileRecoveredPurchase).not.toHaveBeenCalled();
      expect(res).toMatchObject({ unissued: 1, issued: 0 });
      expect(logWarn).toHaveBeenCalledWith(
        "billing.captured_draft_unissued",
        expect.objectContaining({
          invoiceId: "inv-5",
          reason: "the invoice could not be issued",
        }),
      );
    });

    it("★ someone else issued it first: settled, never filed by this pass", async () => {
      seedDrafts({ purchases: [purchaseDraft({ held: true })] });
      store.issueInvoice.mockResolvedValue({
        invoice: {
          id: "inv-5",
          status: "open",
          finalizedAt: "2026-09-09T23:00:00.000Z",
        },
        claimed: false,
        restamp: "unchanged",
      });
      const res = await issueCapturedDrafts({
        now: NOW,
        fetchPayment: paymentRead() as any,
      });
      expect(collect.settleAttempt).toHaveBeenCalledTimes(1);
      expect(collect.fileRecoveredPurchase).not.toHaveBeenCalled();
      expect(res).toMatchObject({ issued: 0, filed: 0, unissued: 0 });
    });

    it("★ the capture's time falls back to the attempt's own record when the gateway has none", async () => {
      seedDrafts({ purchases: [purchaseDraft({ held: true })], items: [[]] });
      await issueCapturedDrafts({
        now: NOW,
        fetchPayment: vi.fn(async () => ({
          ok: false as const,
          error: "timeout",
          outcome: "unknown" as const,
        })) as any,
      });
      expect(store.issueInvoice).toHaveBeenCalledWith({
        invoiceId: "inv-5",
        now: NOW,
        paidAt: new Date(TWO_HOURS_AGO),
      });
    });

    it("★ an add-on's item says what its order bought", async () => {
      seedDrafts({
        purchases: [purchaseDraft({ kind: "addon", held: true })],
        items: [[]],
      });
      collect.readAddonOrderTarget.mockResolvedValue({
        kind: "plan_change",
        plan: "pro",
        period: "yearly",
      });
      await issueCapturedDrafts({
        now: NOW,
        fetchPayment: paymentRead() as any,
      });
      expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
        expect.objectContaining({ purchase: "plan_change" }),
      );
    });

    it("★ one draft that throws does not stop the next", async () => {
      seedDrafts({
        purchases: [
          purchaseDraft({ held: true }),
          purchaseDraft({ held: true, invoiceId: "inv-6", attemptId: "att-6" }),
        ],
        items: [[], []],
      });
      store.issueInvoice.mockRejectedValueOnce(new Error("boom"));
      const res = await issueCapturedDrafts({
        now: NOW,
        fetchPayment: paymentRead() as any,
      });
      expect(res).toMatchObject({ considered: 2, errors: 1, issued: 1 });
    });
  });

  describe("a credit pack's receipt", () => {
    it("★★ is issued straight to paid, at the payment's time; nothing settled or filed", async () => {
      seedDrafts({ credits: [creditDraft()] });
      const res = await issueCapturedDrafts({
        now: NOW,
        fetchPayment: paymentRead() as any,
      });
      expect(store.issueInvoice).toHaveBeenCalledWith({
        invoiceId: "inv-c",
        now: NOW,
        paid: true,
        paidAt: PAID_AT,
      });
      expect(collect.settleAttempt).not.toHaveBeenCalled();
      expect(collect.fileRecoveredPurchase).not.toHaveBeenCalled();
      expect(res).toMatchObject({ considered: 1, issued: 1 });
    });

    it("★★ R1-14: a receipt that will not issue is a WARNING while young, an ERROR after six hours", async () => {
      store.issueInvoice.mockResolvedValue({
        invoice: null,
        claimed: false,
        restamp: "unchanged",
      });
      seedDrafts({ credits: [creditDraft()] });
      await issueCapturedDrafts({
        now: NOW,
        fetchPayment: paymentRead() as any,
      });
      expect(logWarn).toHaveBeenCalledWith("billing.captured_draft_unissued", {
        invoiceId: "inv-c",
        purchaseId: "purchase-1",
        storeId: STORE,
        reason: "the credit pack's invoice could not be issued",
        waitedHours: 2,
      });

      const NINE_HOURS_AGO = new Date(
        NOW.getTime() - 9 * 3_600_000,
      ).toISOString();
      seedDrafts({ credits: [creditDraft({ updatedAt: NINE_HOURS_AGO })] });
      await issueCapturedDrafts({
        now: NOW,
        fetchPayment: paymentRead() as any,
      });
      expect(logError).toHaveBeenCalledWith(
        "billing.captured_draft_unissued",
        expect.objectContaining({
          message: "the credit pack's invoice could not be issued",
        }),
        {
          invoiceId: "inv-c",
          purchaseId: "purchase-1",
          storeId: STORE,
          waitedHours: 9,
        },
      );
    });

    it("★ falls back to the purchase's own record of the payment", async () => {
      seedDrafts({ credits: [creditDraft({ rzpPaymentId: null })] });
      await issueCapturedDrafts({
        now: NOW,
        fetchPayment: paymentRead() as any,
      });
      expect(store.issueInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ paidAt: new Date(TWO_HOURS_AGO) }),
      );
    });
  });

  describe("the pass as a whole", () => {
    it("★ a scan that fails is one error, never a clean pass", async () => {
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = () => {
        throw new Error("db down");
      };
      const res = await issueCapturedDrafts({ now: NOW });
      expect(res).toMatchObject({ errors: 1, considered: 0 });
      expect(store.issueInvoice).not.toHaveBeenCalled();
    });

    it("★ says when a batch came back full", async () => {
      seedDrafts({ purchases: [purchaseDraft({ held: true })], items: [[]] });
      const res = await issueCapturedDrafts({
        now: NOW,
        limit: 1,
        fetchPayment: paymentRead() as any,
      });
      expect(res.more).toBe(true);
    });

    it("★ nothing waiting: nothing done", async () => {
      const res = await issueCapturedDrafts({ now: NOW });
      expect(res).toEqual({
        considered: 0,
        issued: 0,
        completed: 0,
        filed: 0,
        deferred: 0,
        unissued: 0,
        errors: 0,
        more: false,
      });
    });
  });
});

describe("★★ R1-14: unissuedSeverity", () => {
  const at = (hours: number) =>
    new Date(NOW.getTime() - hours * 3_600_000).toISOString();

  it("a WARNING while the capture is younger than the alert line", () => {
    expect(unissuedSeverity(at(1.5), NOW)).toEqual({
      level: "warn",
      waitedHours: 1.5,
    });
    expect(unissuedSeverity(at(5.9), NOW).level).toBe("warn");
  });

  it("an ERROR from the alert line on", () => {
    expect(UNISSUED_ALERT_AFTER_HOURS).toBe(6);
    expect(unissuedSeverity(at(6), NOW)).toEqual({
      level: "error",
      waitedHours: 6,
    });
    expect(unissuedSeverity(at(48), NOW).level).toBe("error");
  });

  it("★ an ERROR when there is nothing to measure the wait against", () => {
    expect(unissuedSeverity(null, NOW)).toEqual({
      level: "error",
      waitedHours: null,
    });
    expect(unissuedSeverity("not a date", NOW)).toEqual({
      level: "error",
      waitedHours: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The operator queue.
// ---------------------------------------------------------------------------

describe("★★ closing an item", () => {
  const base = {
    id: "item-1",
    note: "Refunded the ₹100 difference",
    actor: "op@storemink.com",
  };

  it("records the outcome, who, when and why", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "item-1" }] });
    const res = await resolveReconciliationItem({
      ...base,
      status: "resolved",
      now: NOW,
    });
    expect(res.ok).toBe(true);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      status: "resolved",
      resolvedBy: "op@storemink.com",
      resolutionNote: "Refunded the ₹100 difference",
    });
  });

  it("★★ MOVES NO MONEY — only the item row is touched", async () => {
    // Closing records a judgement. Refunding a difference or issuing a credit
    // happens elsewhere, deliberately, by someone who chose it.
    dbHolder.current = makeDbMock({ returning: [{ id: "item-1" }] });
    await resolveReconciliationItem({ ...base, status: "resolved", now: NOW });
    expect(dbHolder.current.calls.update).toHaveLength(1);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★★ REQUIRES a note — this is the audit trail for a money discrepancy", async () => {
    // "Resolved" with no reason is indistinguishable from someone clearing a
    // queue they never read.
    dbHolder.current = makeDbMock({ returning: [{ id: "item-1" }] });
    const res = await resolveReconciliationItem({
      ...base,
      note: "   ",
      status: "resolved",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★ refuses when someone else already closed it", async () => {
    // The claim is on `open`, so two operators working the queue cannot
    // overwrite each other's note.
    dbHolder.current = makeDbMock({ returning: [] });
    const res = await resolveReconciliationItem({
      ...base,
      status: "resolved",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already closed/i);
  });

  it.each([
    ["resolved", NOW.toISOString()],
    ["manual_review", null],
    ["ignored", null],
  ] as const)(
    "★★ accepts the %s outcome, stamping resolved_at only when resolved",
    async (status, resolvedAt) => {
      // billing_reconciliation_resolved_shape: (status = 'resolved') =
      // (resolved_at is not null). The mock evaluates no CHECK, so the shape
      // is pinned here and the constraint itself in
      // invoice-retention.local.test.ts.
      dbHolder.current = makeDbMock({ returning: [{ id: "item-1" }] });
      expect(
        (await resolveReconciliationItem({ ...base, status, now: NOW })).ok,
      ).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({
        status,
        resolvedBy: "op@storemink.com",
        resolvedAt,
        resolutionNote: "Refunded the ₹100 difference",
        updatedAt: NOW.toISOString(),
      });
    },
  );

  it("★ reports a write failure rather than claiming success", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "item-1" }] });
    dbHolder.current.db.update = () => {
      throw new Error("db down");
    };
    expect(
      (
        await resolveReconciliationItem({
          ...base,
          status: "resolved",
          now: NOW,
        })
      ).ok,
    ).toBe(false);
  });
});

describe("the queue readers", () => {
  it("lists open items by default", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ id: "item-1" }]] });
    expect(await listReconciliationItems()).toHaveLength(1);
  });

  it("★ returns [] on a read failure rather than throwing", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    expect(await listReconciliationItems()).toEqual([]);
  });

  it("★★ the count fails to ZERO — a badge must not cost the page", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    expect(await countOpenReconciliationItems()).toBe(0);
  });
});
