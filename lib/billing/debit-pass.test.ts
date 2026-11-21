/* eslint-disable @typescript-eslint/no-explicit-any */
// STEP 2 of an automatic renewal: the debit of a notified order.
//
// Razorpay accepts a renewal debit only for an order created with a pre-debit
// notification, and only once the notice period has passed. So the debit is
// sent by a later run than the one that created the order, and everything that
// can change in between (the plan, the invoice, the mandate, the notice) is
// read again first. The rules these tests hold:
//
//   • one attempt gets at most one debit (the claim);
//   • nothing is debited for a plan that was cancelled, an invoice that was
//     closed, or a mandate that is gone;
//   • "the gateway could not be asked" decides nothing and writes nothing;
//   • an attempt is ended WITHOUT a debit only while no debit has been sent.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";

const logger = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => logger);

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const collector = vi.hoisted(() => ({ settleAttempt: vi.fn() }));
vi.mock("./collect", async (original) => ({
  ...(await original<typeof import("./collect")>()),
  settleAttempt: collector.settleAttempt,
}));

const mandates = vi.hoisted(() => ({ verifyMandate: vi.fn() }));
vi.mock("./mandate-check", () => mandates);

const worker = vi.hoisted(() => ({
  advanceAfterPayment: vi.fn<(...args: any[]) => Promise<boolean>>(
    async () => true,
  ),
  announceAutopayStopped: vi.fn<(...args: any[]) => Promise<boolean>>(
    async () => true,
  ),
}));
vi.mock("./renewal-worker", () => worker);

// `cycleRefusal` (./manual-pay) is deliberately NOT mocked: it is the one rule
// for "a cycle the store will not enter", and the debit pass must agree with
// what paying by hand refuses.

import {
  DEBIT_BATCH,
  GATEWAY_SILENCE_DEADLINE_HOURS,
  NOTICE_DELIVERY_DEADLINE_HOURS,
  sendDueDebits,
} from "./debit-pass";

const STORE = "store-1";
const NOW = new Date("2026-09-01T12:00:00.000Z");
const DUE_AT = "2026-09-01T11:30:00.000Z";

function dueRow(over: Record<string, unknown> = {}) {
  return {
    id: "att-1",
    storeId: STORE,
    invoiceId: "inv-1",
    amountPaise: 1_770_00,
    idempotencyKey: "sm_bill_att-1",
    providerOrderId: "order_1",
    debitAfter: DUE_AT,
    invoiceStatus: "processing",
    invoiceRef: "SM/2026-27/00042",
    invoiceCycleSeq: 4,
    subState: "active",
    subCycleSeq: 3,
    subCancelling: false,
    mandateId: "man-1",
    mandateStatus: "active",
    mandateMaxPaise: 5_000_00,
    providerTokenId: "token_1",
    providerCustomerId: "cust_1",
    method: "card",
    ...over,
  };
}

function gatewayOk() {
  return {
    checkMandate: vi.fn(),
    notify: vi.fn(),
    readNotice: vi.fn(async () => ({ state: "ready" as const })),
    debit: vi.fn(async () => ({
      ok: true as const,
      data: { providerPaymentId: "pay_1", status: "captured" },
    })),
  } as any;
}

/** The scan's rows, then one `.returning()` result per guarded write. */
function seed(rows: unknown[], returningQueue: unknown[][] = [[{ id: "x" }]]) {
  dbHolder.current = makeDbMock({ selectQueue: [rows], returningQueue });
}

function render(query: unknown) {
  const q = new PgDialect().sqlToQuery(query as any);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

beforeEach(() => {
  vi.clearAllMocks();
  collector.settleAttempt.mockImplementation(
    async (_id: string, state: string) => state,
  );
  mandates.verifyMandate.mockResolvedValue({ result: "usable", mandate: {} });
});

describe("which attempts are due", () => {
  it("★★ automatic, notified, unsent, and past their debit time, longest due first", async () => {
    seed([]);
    await sendDueDebits({ gateway: gatewayOk(), now: NOW });
    const where = render(dbHolder.current.calls.where[0]);
    expect(where.sql).toBe(
      '("billing_payment_attempts"."mode" = $1 and "billing_payment_attempts"."state" = $2 and "billing_payment_attempts"."provider_order_id" is not null and "billing_payment_attempts"."debit_after" is not null and "billing_payment_attempts"."debit_sent_at" is null and "billing_payment_attempts"."debit_after" <= $3)',
    );
    expect(where.params).toEqual([
      "automatic",
      "processing",
      NOW.toISOString(),
    ]);
    expect(dbHolder.current.calls.limit).toEqual([DEBIT_BATCH]);
  });

  it("an empty page sends nothing", async () => {
    seed([]);
    const gateway = gatewayOk();
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(s).toEqual({
      considered: 0,
      sent: 0,
      waiting: 0,
      failed: 0,
      cancelled: 0,
      errors: 0,
    });
    expect(gateway.debit).not.toHaveBeenCalled();
  });

  it("★ a scan that fails is an error, and nothing is sent", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
    const gateway = gatewayOk();
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(s.errors).toBe(1);
    expect(gateway.debit).not.toHaveBeenCalled();
  });
});

describe("★★ the debit: claimed once, then sent", () => {
  it("sends the notified order's debit with the attempt's own amount and key", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(s).toMatchObject({ considered: 1, sent: 1, errors: 0 });
    expect(gateway.debit).toHaveBeenCalledTimes(1);
    expect(gateway.debit).toHaveBeenCalledWith({
      amountPaise: 1_770_00,
      idempotencyKey: "sm_bill_att-1",
      providerOrderId: "order_1",
      providerTokenId: "token_1",
      providerCustomerId: "cust_1",
      storeId: STORE,
      description: "StoreMink renewal SM/2026-27/00042",
    });
  });

  it("★★ the claim is one conditional write, made BEFORE the debit", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    await sendDueDebits({ gateway, now: NOW });
    // Sets `debit_sent_at` only while it is still null on a notified,
    // processing attempt: exactly one caller gets a row back.
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      debitSentAt: NOW.toISOString(),
    });
    const where = render(dbHolder.current.calls.where[1]);
    expect(where.sql).toBe(
      '("billing_payment_attempts"."id" = $1 and "billing_payment_attempts"."state" = $2 and "billing_payment_attempts"."debit_after" is not null and "billing_payment_attempts"."debit_sent_at" is null)',
    );
    expect(where.params).toEqual(["att-1", "processing"]);
  });

  it("★★ a LOST claim sends no debit: another run has it", async () => {
    seed([dueRow()], [[]]);
    const gateway = gatewayOk();
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(gateway.debit).not.toHaveBeenCalled();
    expect(collector.settleAttempt).not.toHaveBeenCalled();
    expect(s).toMatchObject({ sent: 0, waiting: 1 });
  });

  it("★ a captured debit is recorded with its payment, and the plan follows the money", async () => {
    seed([dueRow()]);
    await sendDueDebits({ gateway: gatewayOk(), now: NOW });
    expect(collector.settleAttempt).toHaveBeenCalledWith("att-1", "captured", {
      providerPaymentId: "pay_1",
      now: NOW,
    });
    expect(worker.advanceAfterPayment).toHaveBeenCalledWith(STORE, NOW);
  });

  it("a debit accepted but not yet captured keeps the attempt in flight, and advances nothing", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.debit.mockResolvedValue({
      ok: true,
      data: { providerPaymentId: "pay_1", status: "created" },
    });
    // The machine never moves `processing` back to `created`.
    collector.settleAttempt.mockResolvedValue("processing");
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(collector.settleAttempt.mock.calls[0][2]).toMatchObject({
      providerPaymentId: "pay_1",
    });
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
    expect(s.sent).toBe(1);
  });

  it("★★ a THROW is an unknown, never a failure: the request may have arrived", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.debit.mockRejectedValue(new Error("socket hang up"));
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(collector.settleAttempt).toHaveBeenCalledWith("att-1", "unknown", {
      now: NOW,
    });
    expect(worker.announceAutopayStopped).not.toHaveBeenCalled();
    expect(s).toMatchObject({ sent: 1, failed: 0, errors: 0 });
  });

  it("★★ a timeout or a 5xx is an unknown too", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.debit.mockResolvedValue({
      ok: false,
      outcome: "unknown",
      error: "timeout",
    });
    await sendDueDebits({ gateway, now: NOW });
    expect(collector.settleAttempt).toHaveBeenCalledWith("att-1", "unknown", {
      now: NOW,
    });
  });

  it("★ a refusal is a verdict: this try failed, and the last one says so", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.debit.mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "Insufficient balance",
    });
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(collector.settleAttempt).toHaveBeenCalledWith("att-1", "failed", {
      failureCode: "gateway_rejected",
      failureReason: "Insufficient balance",
      // Our own claimed debit: recorded whatever `debit_sent_at` says.
      onlyIfUnsent: false,
      now: NOW,
    });
    // It decides by itself whether this was the last of the three.
    expect(worker.announceAutopayStopped).toHaveBeenCalledWith({
      storeId: STORE,
      invoiceId: "inv-1",
      now: NOW,
    });
    expect(s).toMatchObject({ failed: 1, sent: 0 });
  });

  it("a refusal that could not be recorded is logged, and nobody is told yet", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.debit.mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "declined",
    });
    collector.settleAttempt.mockResolvedValue(null);
    await sendDueDebits({ gateway, now: NOW });
    expect(logger.logError).toHaveBeenCalledWith(
      "billing.debit_pass.failure_unrecorded",
      expect.any(Error),
      expect.objectContaining({ attemptId: "att-1" }),
    );
    expect(worker.announceAutopayStopped).not.toHaveBeenCalled();
  });

  it("an invoice with no number still gets a description", async () => {
    seed([dueRow({ invoiceRef: null })]);
    const gateway = gatewayOk();
    await sendDueDebits({ gateway, now: NOW });
    expect(gateway.debit.mock.calls[0][0].description).toBe(
      "StoreMink renewal",
    );
  });
});

describe("★★ nothing is debited for a plan, invoice or mandate that no longer stands", () => {
  /** Withdrawn: closed as cancelled, only while unsent, and nobody is told. */
  async function expectWithdrawn(row: Record<string, unknown>, code: string) {
    seed([dueRow(row)]);
    const gateway = gatewayOk();
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(gateway.debit).not.toHaveBeenCalled();
    expect(gateway.readNotice).not.toHaveBeenCalled();
    expect(mandates.verifyMandate).not.toHaveBeenCalled();
    expect(collector.settleAttempt).toHaveBeenCalledTimes(1);
    expect(collector.settleAttempt.mock.calls[0].slice(0, 2)).toEqual([
      "att-1",
      "cancelled",
    ]);
    expect(collector.settleAttempt.mock.calls[0][2]).toMatchObject({
      failureCode: code,
      onlyIfUnsent: true,
    });
    expect(worker.announceAutopayStopped).not.toHaveBeenCalled();
    expect(s).toMatchObject({ cancelled: 1, sent: 0 });
  }

  it.each(["void", "uncollectible", "paid", "draft"])(
    "an invoice that is %s",
    async (invoiceStatus) => {
      await expectWithdrawn({ invoiceStatus }, "invoice_closed");
    },
  );

  it("an invoice that is open is still owed", async () => {
    seed([dueRow({ invoiceStatus: "open" })]);
    const gateway = gatewayOk();
    await sendDueDebits({ gateway, now: NOW });
    expect(gateway.debit).toHaveBeenCalledTimes(1);
  });

  it("★★ a plan the merchant CANCELLED, even when its mandate is still on record as active", async () => {
    // Cancelling revokes the mandate, but that write is best-effort. The
    // cancellation itself must stop the debit.
    await expectWithdrawn({ subCancelling: true }, "plan_cancelled");
  });

  it("a plan that has ended", async () => {
    await expectWithdrawn({ subState: "downgraded" }, "cycle_unreachable");
  });

  it("a cycle the store has already passed", async () => {
    await expectWithdrawn({ subCycleSeq: 5 }, "cycle_unreachable");
  });

  it("a store with no subscription row is judged by its invoice and mandate alone", async () => {
    seed([dueRow({ subState: null, subCycleSeq: null, subCancelling: null })]);
    const gateway = gatewayOk();
    await sendDueDebits({ gateway, now: NOW });
    expect(gateway.debit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["revoked", { mandateStatus: "revoked" }],
    ["paused (unknown)", { mandateStatus: "unknown" }],
    ["missing", { mandateId: null, mandateStatus: null }],
    ["without a token", { providerTokenId: null }],
    ["without a customer", { providerCustomerId: null }],
  ])("a mandate that is %s", async (_name, over) => {
    await expectWithdrawn(over, "mandate_withdrawn");
  });

  it("★★ a withdrawal that moved nothing (another run sent the debit) changes nothing", async () => {
    seed([dueRow({ subCancelling: true })]);
    collector.settleAttempt.mockResolvedValue(null);
    const s = await sendDueDebits({ gateway: gatewayOk(), now: NOW });
    expect(s).toMatchObject({ cancelled: 0, waiting: 1 });
  });
});

describe("★★ the mandate is asked about at the gateway before the debit", () => {
  it("is asked with the mandate on the attempt", async () => {
    seed([dueRow({ method: "upi" })]);
    const gateway = gatewayOk();
    await sendDueDebits({ gateway, now: NOW });
    expect(mandates.verifyMandate).toHaveBeenCalledWith(
      {
        id: "man-1",
        status: "active",
        maxAmountPaise: 5_000_00,
        providerTokenId: "token_1",
        providerCustomerId: "cust_1",
        method: "upi",
      },
      gateway,
      NOW,
    );
  });

  it("★★ a gateway that could not be asked decides nothing and writes nothing", async () => {
    seed([dueRow()]);
    mandates.verifyMandate.mockResolvedValue({ result: "unknown" });
    const gateway = gatewayOk();
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(gateway.debit).not.toHaveBeenCalled();
    expect(collector.settleAttempt).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(s).toMatchObject({ waiting: 1, errors: 0 });
  });

  it("★★ a mandate the customer cancelled since the notice: the try ends, and the merchant is asked to pay", async () => {
    seed([dueRow()]);
    mandates.verifyMandate.mockResolvedValue({
      result: "unusable",
      mandate: {},
      changed: true,
      reason: "ended",
    });
    const gateway = gatewayOk();
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(gateway.debit).not.toHaveBeenCalled();
    expect(collector.settleAttempt).toHaveBeenCalledWith("att-1", "failed", {
      failureCode: "mandate_unusable",
      failureReason: "the mandate is ended at the gateway",
      onlyIfUnsent: true,
      now: NOW,
    });
    expect(worker.announceAutopayStopped).toHaveBeenCalledWith({
      storeId: STORE,
      invoiceId: "inv-1",
      cause: "mandate",
      now: NOW,
    });
    expect(s).toMatchObject({ failed: 1 });
  });

  it("★ when that write moved nothing, nobody is told", async () => {
    seed([dueRow()]);
    mandates.verifyMandate.mockResolvedValue({
      result: "unusable",
      mandate: {},
      changed: false,
      reason: "paused",
    });
    collector.settleAttempt.mockResolvedValue(null);
    const s = await sendDueDebits({ gateway: gatewayOk(), now: NOW });
    expect(worker.announceAutopayStopped).not.toHaveBeenCalled();
    expect(s).toMatchObject({ waiting: 1, failed: 0 });
  });
});

describe("★★ the notice period is read from the gateway, not assumed", () => {
  it("asks about this order on this rail", async () => {
    seed([dueRow({ method: "upi" })]);
    const gateway = gatewayOk();
    await sendDueDebits({ gateway, now: NOW });
    expect(gateway.readNotice).toHaveBeenCalledWith({
      providerOrderId: "order_1",
      rail: "upi",
      now: NOW,
    });
  });

  it("a mandate with no recorded rail is read with the longest notice period", async () => {
    seed([dueRow({ method: null })]);
    const gateway = gatewayOk();
    await sendDueDebits({ gateway, now: NOW });
    expect(gateway.readNotice.mock.calls[0][0].rail).toBe("unknown");
  });

  it("★★ a notice that could not be read sends nothing and writes nothing", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.readNotice.mockResolvedValue({ state: "unknown" });
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(gateway.debit).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(s.waiting).toBe(1);
  });

  it("★ a period still running moves the debit time to the gateway's own", async () => {
    const until = new Date("2026-09-01T18:00:00.000Z");
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.readNotice.mockResolvedValue({ state: "wait", until });
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(gateway.debit).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.set).toEqual([
      { debitAfter: until.toISOString(), updatedAt: NOW.toISOString() },
    ]);
    // Only while unsent and processing: never over a debit already sent.
    const where = render(dbHolder.current.calls.where[1]);
    expect(where.sql).toBe(
      '("billing_payment_attempts"."id" = $1 and "billing_payment_attempts"."state" = $2 and "billing_payment_attempts"."debit_sent_at" is null)',
    );
    expect(s.waiting).toBe(1);
  });

  it("a notice not delivered yet waits", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.readNotice.mockResolvedValue({ state: "undelivered" });
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(collector.settleAttempt).not.toHaveBeenCalled();
    expect(s.waiting).toBe(1);
  });

  it("★ one still undelivered half a day past its debit time ends the try", async () => {
    const late = new Date(
      Date.parse(DUE_AT) + NOTICE_DELIVERY_DEADLINE_HOURS * 3_600_000,
    );
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.readNotice.mockResolvedValue({ state: "undelivered" });
    const s = await sendDueDebits({ gateway, now: late });
    expect(gateway.debit).not.toHaveBeenCalled();
    expect(collector.settleAttempt).toHaveBeenCalledWith("att-1", "failed", {
      failureCode: "notice_undelivered",
      failureReason: "the pre-debit notice was never delivered",
      onlyIfUnsent: true,
      now: late,
    });
    expect(worker.announceAutopayStopped).toHaveBeenCalledTimes(1);
    expect(s.failed).toBe(1);
  });

  it("a minute before that deadline it still waits", async () => {
    const almost = new Date(
      Date.parse(DUE_AT) + NOTICE_DELIVERY_DEADLINE_HOURS * 3_600_000 - 60_000,
    );
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.readNotice.mockResolvedValue({ state: "undelivered" });
    const s = await sendDueDebits({ gateway, now: almost });
    expect(collector.settleAttempt).not.toHaveBeenCalled();
    expect(s.waiting).toBe(1);
  });
});

// A notified attempt keeps its invoice `processing`, and no grace opens on an
// invoice with a payment in flight. So waiting on a silent gateway must end,
// or the store keeps its plan for nothing.
describe("★★ a gateway that stays silent does not hold the invoice for ever", () => {
  const hoursPastDue = (h: number) =>
    new Date(Date.parse(DUE_AT) + h * 3_600_000);

  it(`the mandate could not be asked about for ${GATEWAY_SILENCE_DEADLINE_HOURS}h: the try ends, with no debit`, async () => {
    seed([dueRow()]);
    mandates.verifyMandate.mockResolvedValue({ result: "unknown" });
    const gateway = gatewayOk();
    const at = hoursPastDue(GATEWAY_SILENCE_DEADLINE_HOURS);
    const s = await sendDueDebits({ gateway, now: at });
    expect(gateway.debit).not.toHaveBeenCalled();
    expect(collector.settleAttempt).toHaveBeenCalledWith("att-1", "failed", {
      failureCode: "gateway_unreachable",
      failureReason:
        "the gateway would not say whether the mandate still stands",
      onlyIfUnsent: true,
      now: at,
    });
    // It decides by itself whether this was the last of the three tries.
    expect(worker.announceAutopayStopped).toHaveBeenCalledWith({
      storeId: STORE,
      invoiceId: "inv-1",
      now: at,
    });
    expect(s).toMatchObject({ failed: 1, waiting: 0 });
  });

  it("the notice could not be read for that long: the same", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    gateway.readNotice.mockResolvedValue({ state: "unknown" });
    const at = hoursPastDue(GATEWAY_SILENCE_DEADLINE_HOURS + 3);
    const s = await sendDueDebits({ gateway, now: at });
    expect(gateway.debit).not.toHaveBeenCalled();
    expect(collector.settleAttempt.mock.calls[0][2]).toMatchObject({
      failureCode: "gateway_unreachable",
      onlyIfUnsent: true,
    });
    expect(s.failed).toBe(1);
  });

  it("★ an hour short of it, both still wait and write nothing", async () => {
    const at = hoursPastDue(GATEWAY_SILENCE_DEADLINE_HOURS - 1);
    seed([dueRow()]);
    mandates.verifyMandate.mockResolvedValue({ result: "unknown" });
    expect(
      (await sendDueDebits({ gateway: gatewayOk(), now: at })).waiting,
    ).toBe(1);

    seed([dueRow()]);
    mandates.verifyMandate.mockResolvedValue({ result: "usable", mandate: {} });
    const gateway = gatewayOk();
    gateway.readNotice.mockResolvedValue({ state: "unknown" });
    expect((await sendDueDebits({ gateway, now: at })).waiting).toBe(1);
    expect(collector.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ the mandate's own record is never touched by silence", async () => {
    seed([dueRow()]);
    mandates.verifyMandate.mockResolvedValue({ result: "unknown" });
    await sendDueDebits({
      gateway: gatewayOk(),
      now: hoursPastDue(GATEWAY_SILENCE_DEADLINE_HOURS),
    });
    // Asked to pay as for any failed try, never told "autopay was cancelled".
    expect(worker.announceAutopayStopped.mock.calls[0][0]).not.toHaveProperty(
      "cause",
    );
  });
});

describe("the order of the checks", () => {
  it("★ mandate, then notice, then claim, then debit", async () => {
    seed([dueRow()]);
    const gateway = gatewayOk();
    const order: string[] = [];
    mandates.verifyMandate.mockImplementation(async () => {
      order.push("mandate");
      return { result: "usable", mandate: {} };
    });
    gateway.readNotice.mockImplementation(async () => {
      order.push("notice");
      return { state: "ready" };
    });
    gateway.debit.mockImplementation(async () => {
      order.push(
        dbHolder.current.calls.set.length === 1 ? "debit-after-claim" : "debit",
      );
      return {
        ok: true,
        data: { providerPaymentId: "pay_1", status: "captured" },
      };
    });
    await sendDueDebits({ gateway, now: NOW });
    expect(order).toEqual(["mandate", "notice", "debit-after-claim"]);
  });
});

describe("one attempt's trouble never stops the page", () => {
  it("★ an attempt that throws is counted, and the next one is still handled", async () => {
    seed(
      [
        dueRow(),
        dueRow({
          id: "att-2",
          invoiceId: "inv-2",
          idempotencyKey: "sm_bill_att-2",
        }),
      ],
      [[{ id: "x" }]],
    );
    mandates.verifyMandate
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ result: "usable", mandate: {} });
    const gateway = gatewayOk();
    const s = await sendDueDebits({ gateway, now: NOW });
    expect(s).toMatchObject({ considered: 2, errors: 1, sent: 1 });
    expect(gateway.debit).toHaveBeenCalledTimes(1);
    expect(gateway.debit.mock.calls[0][0].idempotencyKey).toBe("sm_bill_att-2");
  });
});
