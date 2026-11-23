/* eslint-disable @typescript-eslint/no-explicit-any */
// Cancelling, resuming, and reading the subscription.
//
// The old path's cancel could fail for the PROVIDER's reasons — most often
// "Subscription cannot be cancelled since no billing cycle is going on", which
// hit anyone cancelling before their first charge and left them stuck. Here it is
// a flag, so the interesting cases are all ours: cancel once, keep what was paid
// for, withdraw the standing permission to debit, and never claim autopay is back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
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

const receipts = vi.hoisted(() => ({ notifySubscriptionCancelled: vi.fn() }));
vi.mock("./receipts", () => receipts);

// The cycle advance is the renewal worker's, proved by its own suite; here it
// is a seam, so a test can say whether Keep my plan advanced the cycle.
const worker = vi.hoisted(() => ({
  advanceAfterPayment: vi.fn(async () => false),
}));
vi.mock("./renewal-worker", () => worker);

// Withdrawing a scheduled debit is the collect module's, proved by its own
// suite; here it is a seam, so a test can say what the cancel asked for.
const collector = vi.hoisted(() => ({
  withdrawUnsentDebits: vi.fn(async (): Promise<number | null> => 0),
}));
vi.mock("./collect", () => collector);

import {
  cancelAtPeriodEnd,
  getSubscriptionView,
  resumeSubscription,
} from "./cancel";

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const PERIOD_END = "2026-09-16T00:00:00.000Z";
const GRACE_END = "2026-09-03T08:30:00.000Z";

function seed(rows: any[][], returning?: any[]) {
  dbHolder.current = makeDbMock({
    selectQueue: rows,
    ...(returning ? { returning } : {}),
  });
}

/** A Drizzle condition or fragment, as Postgres would receive it. */
function render(query: unknown) {
  const q = new PgDialect().sqlToQuery(query as any);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

/** The next cycle's invoice as the read returns it. */
function nextInvoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: "inv-4",
    status: "open",
    totalPaise: 240000,
    invoiceRef: "SM/2026-27/00004",
    inFlight: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cancelAtPeriodEnd", () => {
  const args = { storeId: STORE, now: NOW };

  /**
   * The pre-read, the claim (returning the row as it then stands, current cycle
   * 3) and the next-cycle invoice read that follows it, in that order.
   */
  function seedActive(over: Record<string, unknown> = {}, next: any[] = []) {
    const sub = {
      plan: "pro",
      state: "active",
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      mandateId: "mand-1",
      graceEndsAt: null,
      ...over,
    };
    dbHolder.current = makeDbMock({
      selectQueue: [[sub], next],
      returningQueue: [
        [
          {
            state: sub.state,
            graceEndsAt: sub.graceEndsAt,
            currentPeriodEnd: sub.currentPeriodEnd,
            currentCycleSeq: 3,
          },
        ],
      ],
    });
  }

  it("★★ sets the flag rather than calling a gateway, and keeps the paid period", async () => {
    seedActive();
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.accessUntil).toBe(PERIOD_END);
    expect(dbHolder.current.calls.set[0].cancelAtPeriodEnd).toBe(true);
  });

  it("★★ WITHDRAWS the standing permission to debit", async () => {
    // A live mandate is permission to take money. Someone who cancelled has
    // withdrawn it, and "it doesn't matter, nothing will charge it" is the
    // reasoning that turns one bug into a debit.
    seedActive();
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mandateRevoked).toBe(true);
    expect(
      dbHolder.current.calls.set.some((s: any) => s.status === "revoked"),
    ).toBe(true);
  });

  it("★★ CONFIRMS it, naming the plan and what they keep", async () => {
    // A cancellation with no acknowledgement leaves the merchant unsure it took.
    seedActive({ plan: "pro" });
    await cancelAtPeriodEnd(args);
    expect(receipts.notifySubscriptionCancelled).toHaveBeenCalledWith({
      storeId: STORE,
      plan: "pro",
      accessUntil: PERIOD_END,
      state: "active",
      graceEndsAt: null,
      nextInvoice: null,
      requestedBy: null,
    });
  });

  it("★★ the confirmation carries the claim's facts: the next invoice and who asked", async () => {
    // What the email says depends on them: an open renewal invoice "won't be
    // charged", a paid one is refunded, one in flight may still land; and an
    // operator's cancellation opens "As you asked".
    seedActive({}, [nextInvoiceRow({ status: "paid" })]);
    await cancelAtPeriodEnd({ ...args, requestedBy: "operator:ops@x.com" });
    expect(receipts.notifySubscriptionCancelled).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "active",
        nextInvoice: nextInvoiceRow({ status: "paid" }),
        requestedBy: "operator:ops@x.com",
      }),
    );
  });

  it("★★ is NEVER refused for timing: three days before the renewal, invoice issued", async () => {
    // R1. The T-4d pass has already issued the next invoice; cancelling now is
    // allowed, the invoice is closed when the plan ends, and the merchant is
    // told it won't be charged.
    const threeDaysBefore = new Date("2026-09-13T00:00:00.000Z");
    seedActive({}, [nextInvoiceRow({ status: "open" })]);
    const res = await cancelAtPeriodEnd({
      storeId: STORE,
      now: threeDaysBefore,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({
      accessUntil: PERIOD_END,
      mandateRevoked: true,
      state: "active",
      graceEndsAt: null,
      nextInvoice: nextInvoiceRow({ status: "open" }),
    });
  });

  it("★★ RECORDS who asked and when, in the claim itself", async () => {
    seedActive();
    await cancelAtPeriodEnd({ ...args, requestedBy: "merchant:user-1" });
    const set = dbHolder.current.calls.set[0];
    expect(set.cancelAtPeriodEnd).toBe(true);
    expect(set.cancelRequestedAt).toBe(NOW.toISOString());
    expect(set.cancelRequestedBy).toBe("merchant:user-1");
  });

  it("★ a blank requester is stored as null (the column refuses a blank one)", async () => {
    seedActive();
    await cancelAtPeriodEnd({ ...args, requestedBy: "   " });
    expect(dbHolder.current.calls.set[0].cancelRequestedBy).toBeNull();
    expect(dbHolder.current.calls.set[0].cancelRequestedAt).toBe(
      NOW.toISOString(),
    );
  });

  it("★★ the claim requires a LIVE subscription that is not already cancelling", async () => {
    // The read above checks it too; the claim is what decides when the plan
    // ends between the two. Pinned by rendering, as the mock does not evaluate
    // a WHERE.
    seedActive();
    await cancelAtPeriodEnd(args);
    const claimWhere = render(dbHolder.current.calls.where[1]);
    expect(claimWhere.sql).toBe(
      '("billing_subscriptions"."store_id" = $1 and "billing_subscriptions"."cancel_at_period_end" = $2 and "billing_subscriptions"."state" in ($3, $4, $5))',
    );
    expect(claimWhere.params).toEqual([
      STORE,
      false,
      "active",
      "past_due",
      "grace",
    ]);
  });

  it("★★ in grace: returns the grace end, and a payment under way is reported", async () => {
    // A merchant who cancels in grace loses the plan when grace ends, not at a
    // cycle end that is already behind them.
    seedActive({ state: "past_due", graceEndsAt: GRACE_END }, [
      nextInvoiceRow({ status: "processing", inFlight: true }),
    ]);
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.state).toBe("past_due");
    expect(res.data.graceEndsAt).toBe(GRACE_END);
    expect(res.data.nextInvoice?.inFlight).toBe(true);
    expect(receipts.notifySubscriptionCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ state: "past_due", graceEndsAt: GRACE_END }),
    );
  });

  it("★★ reads the NEXT cycle's subscription invoice, with its in-flight attempts", async () => {
    seedActive({}, [nextInvoiceRow()]);
    await cancelAtPeriodEnd(args);
    // The second select is the next-invoice read (the first is the pre-read).
    const where = render(dbHolder.current.calls.where[2]);
    expect(where.sql).toBe(
      '("billing_invoices"."store_id" = $1 and "billing_invoices"."kind" = $2 and "billing_invoices"."cycle_seq" = $3)',
    );
    // The claim returned cycle 3, so the next one is 4.
    expect(where.params).toEqual([STORE, "subscription", 4]);
    const inFlight = render(dbHolder.current.calls.select[1].inFlight);
    // ★ The outer table named by hand: a bare "id" would be the attempt's own.
    // ★ A notified automatic attempt whose debit has not been sent is not a
    // payment in flight: no money can move until it is.
    expect(inFlight.sql).toBe(
      "exists ( select 1 from public.billing_payment_attempts a where a.invoice_id = \"billing_invoices\".\"id\" and a.state in ('created', 'processing', 'authorized', 'unknown') and not (a.mode = 'automatic' and a.state = 'processing' and a.debit_after is not null and a.debit_sent_at is null))",
    );
    const scheduled = render(dbHolder.current.calls.select[1].scheduled);
    expect(scheduled.sql).toBe(
      "exists ( select 1 from public.billing_payment_attempts a where a.invoice_id = \"billing_invoices\".\"id\" and a.mode = 'automatic' and a.state = 'processing' and a.debit_after is not null and a.debit_sent_at is null)",
    );
  });

  // 21 Nov 2026: an automatic renewal waits a day or more between its bank
  // notice and its debit, so a merchant can cancel in between.
  describe("★★ a renewal whose debit is scheduled but not sent", () => {
    it("reads as an unpaid invoice with nothing in flight: it won't be charged", async () => {
      seedActive({}, [
        nextInvoiceRow({
          status: "processing",
          inFlight: false,
          scheduled: true,
        }),
      ]);
      const res = await cancelAtPeriodEnd(args);
      expect(res.ok && res.data.nextInvoice).toMatchObject({
        status: "open",
        inFlight: false,
      });
      expect(receipts.notifySubscriptionCancelled).toHaveBeenCalledWith(
        expect.objectContaining({
          nextInvoice: expect.objectContaining({
            status: "open",
            inFlight: false,
          }),
        }),
      );
    });

    it("★ a debit already SENT is still a payment in flight", async () => {
      seedActive({}, [
        nextInvoiceRow({
          status: "processing",
          inFlight: true,
          scheduled: false,
        }),
      ]);
      const res = await cancelAtPeriodEnd(args);
      expect(res.ok && res.data.nextInvoice).toMatchObject({
        status: "processing",
        inFlight: true,
      });
    });

    it("★★ the scheduled debit is withdrawn at once, for that invoice", async () => {
      seedActive({}, [
        nextInvoiceRow({ status: "processing", scheduled: true }),
      ]);
      await cancelAtPeriodEnd(args);
      expect(collector.withdrawUnsentDebits).toHaveBeenCalledTimes(1);
      expect(collector.withdrawUnsentDebits).toHaveBeenCalledWith({
        invoiceId: "inv-4",
        code: "plan_cancelled",
        reason: "the plan was cancelled before the debit",
        now: NOW,
      });
    });

    it("a withdrawal that could not be made does not fail the cancel", async () => {
      // The debit pass refuses a cancelled plan's debit by itself.
      collector.withdrawUnsentDebits.mockResolvedValueOnce(null);
      seedActive({}, [
        nextInvoiceRow({ status: "processing", scheduled: true }),
      ]);
      expect((await cancelAtPeriodEnd(args)).ok).toBe(true);
    });

    it("nothing is withdrawn with no next invoice, or when the claim was lost", async () => {
      seedActive();
      await cancelAtPeriodEnd(args);
      seedActive({ cancelAtPeriodEnd: true });
      await cancelAtPeriodEnd(args);
      expect(collector.withdrawUnsentDebits).not.toHaveBeenCalled();
    });
  });

  it("★ a lost claim reads nothing more and says nothing", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            plan: "pro",
            state: "active",
            currentPeriodEnd: PERIOD_END,
            cancelAtPeriodEnd: false,
            mandateId: null,
          },
        ],
      ],
      returning: [],
    });
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(false);
    expect(dbHolder.current.calls.select).toHaveLength(1);
    expect(receipts.notifySubscriptionCancelled).not.toHaveBeenCalled();
  });

  it("★ says nothing when there was nothing to cancel", async () => {
    seed([[]]);
    await cancelAtPeriodEnd(args);
    expect(receipts.notifySubscriptionCancelled).not.toHaveBeenCalled();
  });

  it("★ clears any booked change — it is moot once they are leaving", async () => {
    seedActive();
    await cancelAtPeriodEnd(args);
    const set = dbHolder.current.calls.set[0];
    expect(set.scheduledPlan).toBeNull();
    expect(set.scheduledPeriod).toBeNull();
    expect(set.scheduledLocations).toBeNull();
  });

  it("★ refuses a second cancel", async () => {
    seedActive({ cancelAtPeriodEnd: true });
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(false);
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★★ refuses when the CLAIM finds nothing, not just when the read said so", async () => {
    // Two clicks racing: the read passes for both, and the conditional update is
    // what decides. Without it the second would report a fresh cancellation.
    seed([
      [
        {
          state: "active",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          mandateId: null,
        },
      ],
    ]);
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            state: "active",
            currentPeriodEnd: PERIOD_END,
            cancelAtPeriodEnd: false,
            mandateId: null,
          },
        ],
      ],
      returning: [], // the claim matched no rows
    });
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already cancelling/i);
  });

  it("refuses when there is nothing to cancel", async () => {
    seed([[]]);
    expect((await cancelAtPeriodEnd(args)).ok).toBe(false);
  });

  it("★ refuses a subscription that already ended", async () => {
    seedActive({ state: "cancelled" });
    expect((await cancelAtPeriodEnd(args)).ok).toBe(false);
  });

  it("★ cancels a PAST_DUE subscription too — they are still entitled to stop", async () => {
    seedActive({ state: "past_due" });
    expect((await cancelAtPeriodEnd(args)).ok).toBe(true);
  });

  it("★ no cycle yet means no promise of access", async () => {
    // Between authorising and the first charge there is nothing paid for, so
    // promising a plan until a date would be untrue.
    seedActive({ currentPeriodEnd: null, state: "active" });
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.accessUntil).toBeNull();
  });

  it("★ refuses on a read failure rather than guessing", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    expect((await cancelAtPeriodEnd(args)).ok).toBe(false);
  });
});

describe("resumeSubscription", () => {
  const args = { storeId: STORE, now: NOW };

  /**
   * The claim (returning the row as resumed, current cycle 3), then the
   * next-cycle invoice read, then the mandate read, each by its table.
   */
  function seedResume(
    claimed: Record<string, unknown> | null,
    opts: { next?: any[]; mandate?: any[] } = {},
  ) {
    dbHolder.current = makeDbMock({
      returning: claimed
        ? [
            {
              mandateId: null,
              state: "active",
              graceEndsAt: null,
              currentPeriodEnd: PERIOD_END,
              currentCycleSeq: 3,
              ...claimed,
            },
          ]
        : [],
      selectByTable: {
        billing_invoices: [opts.next ?? []],
        billing_mandates: [opts.mandate ?? []],
      },
    });
  }

  it("clears the flag", async () => {
    seedResume({});
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(true);
    expect(dbHolder.current.calls.set[0].cancelAtPeriodEnd).toBe(false);
  });

  it("★★ CLEARS who asked and when: no cancellation stands any more", async () => {
    seedResume({});
    await resumeSubscription({ ...args, requestedBy: "merchant:user-1" });
    const set = dbHolder.current.calls.set[0];
    expect(set.cancelRequestedAt).toBeNull();
    expect(set.cancelRequestedBy).toBeNull();
  });

  it("★★ does NOT claim autopay is back — the mandate was revoked", async () => {
    // Saying otherwise has the merchant expect a charge that never comes, and be
    // downgraded for it.
    seedResume({ mandateId: "mand-1" }, { mandate: [] });
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.autopay).toBe(false);
  });

  it("reports autopay when a mandate really is active", async () => {
    seedResume({ mandateId: "mand-1" }, { mandate: [{ id: "mand-1" }] });
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.autopay).toBe(true);
  });

  it("★★ refuses one that already ENDED, rather than reviving a dead plan", async () => {
    // Past `endSubscription` the state is `cancelled` and the cycle is gone;
    // flipping the flag back would leave a paid state with no period (which the
    // cycle_present CHECK forbids) and claim to restore a plan already taken.
    seedResume(null);
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Subscribe again/i);
    // Nothing to advance: the claim was lost.
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("★★ is allowed in PAST_DUE and GRACE, never once the plan has ended", async () => {
    // D4: a merchant who cancelled in grace may keep the plan before grace
    // ends. The claim's WHERE is the rule; the mock does not evaluate it, so it
    // is pinned as Postgres receives it.
    seedResume({ state: "past_due", graceEndsAt: GRACE_END });
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.state).toBe("past_due");
    expect(res.data.graceEndsAt).toBe(GRACE_END);
    const claimWhere = render(dbHolder.current.calls.where[0]);
    expect(claimWhere.sql).toBe(
      '("billing_subscriptions"."store_id" = $1 and "billing_subscriptions"."cancel_at_period_end" = $2 and "billing_subscriptions"."state" in ($3, $4, $5))',
    );
    expect(claimWhere.params).toEqual([
      STORE,
      true,
      "active",
      "past_due",
      "grace",
    ]);
  });

  it("★★ calls advanceAfterPayment AFTER the claim and reports `advanced`", async () => {
    // A renewal paid during grace while the cancellation stood could not advance
    // the cycle (advanceAfterPayment refuses a cancelling subscription). With
    // the flag cleared it can, at once: state active, the next cycle begun.
    worker.advanceAfterPayment.mockResolvedValue(true);
    seedResume(
      { state: "grace", graceEndsAt: GRACE_END },
      { next: [nextInvoiceRow({ status: "paid" })] },
    );
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.advanced).toBe(true);
    expect(worker.advanceAfterPayment).toHaveBeenCalledWith(STORE, NOW);
    const claimAt = dbHolder.current.db.update.mock.invocationCallOrder[0];
    const advanceAt = worker.advanceAfterPayment.mock.invocationCallOrder[0];
    expect(claimAt).toBeLessThan(advanceAt);
    expect(res.data.nextInvoice).toEqual(nextInvoiceRow({ status: "paid" }));
  });

  it("★ reports `advanced: false` before the cycle end: the turn happens at T0", async () => {
    worker.advanceAfterPayment.mockResolvedValue(false);
    seedResume({}, { next: [nextInvoiceRow({ status: "paid" })] });
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.advanced).toBe(false);
    expect(res.data.currentEnd).toBe(PERIOD_END);
  });

  it("★ reports the next invoice, so the message can say what is owed", async () => {
    seedResume(
      {},
      { next: [nextInvoiceRow({ status: "processing", inFlight: true })] },
    );
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.nextInvoice).toEqual(
      nextInvoiceRow({ status: "processing", inFlight: true }),
    );
  });

  it("★ a failed claim reports the failure and advances nothing", async () => {
    dbHolder.current = makeDbMock();
    dbHolder.current.db.update = () => {
      throw new Error("db down");
    };
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Couldn't resume/i);
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });
});

describe("getSubscriptionView", () => {
  it("★★ autopay is FALSE for a mandate above the AFA-exempt limit", async () => {
    // The reassuring half of the Plans page. A ₹43,000 ceiling looks like the
    // strongest possible autopay and is the opposite: RBI caps an unattended
    // debit at ₹15,000 on cards and UPI alike, so a mandate sized past it can
    // never carry a renewal at all. Every yearly subscriber saw autopay ON
    // while each renewal quietly went to a manual invoice.
    seed([
      [
        {
          plan: "pro",
          period: "yearly",
          state: "active",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          mandateId: "mand-1",
          mandateStatus: "active",
          mandateMaxPaise: 43_000_00,
        },
      ],
    ]);
    expect((await getSubscriptionView(STORE)).autopay).toBe(false);
  });

  it("★ autopay is FALSE for a revoked mandate, whatever its ceiling", async () => {
    seed([
      [
        {
          plan: "pro",
          period: "monthly",
          state: "active",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          mandateId: "mand-1",
          mandateStatus: "revoked",
          mandateMaxPaise: 5_000_00,
        },
      ],
    ]);
    expect((await getSubscriptionView(STORE)).autopay).toBe(false);
  });

  it("maps our state vocabulary through, not Razorpay's", async () => {
    seed([
      [
        {
          plan: "pro",
          period: "yearly",
          state: "past_due",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          scheduledPlan: "basic",
          scheduledPeriod: "monthly",
          scheduledLocations: 1,
          mandateId: "mand-1",
          mandateStatus: "active",
          mandateMaxPaise: 5_000_00,
        },
      ],
    ]);
    const v = await getSubscriptionView(STORE);
    expect(v).toMatchObject({
      plan: "pro",
      period: "yearly",
      status: "past_due",
      currentEnd: PERIOD_END,
      scheduledPlan: "basic",
      scheduledPeriod: "monthly",
      scheduledLocations: 1,
      autopay: true,
      active: true,
    });
  });

  it("★ autopay is FALSE when the mandate is not active", async () => {
    seed([
      [
        {
          plan: "pro",
          period: "monthly",
          state: "active",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          mandateId: "mand-1",
          mandateStatus: "revoked",
        },
      ],
    ]);
    expect((await getSubscriptionView(STORE)).autopay).toBe(false);
  });

  it("★ a CANCELLED subscription is not `active` — no controls to offer", async () => {
    seed([
      [
        {
          plan: "pro",
          period: "monthly",
          state: "cancelled",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          mandateId: null,
          mandateStatus: null,
        },
      ],
    ]);
    expect((await getSubscriptionView(STORE)).active).toBe(false);
  });

  it("★★ returns a NEUTRAL view on a read failure, never throws", async () => {
    // The page also renders AI usage and the plan list; a billing hiccup should
    // cost the subscription card, not the whole page.
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const v = await getSubscriptionView(STORE);
    expect(v.active).toBe(false);
    expect(v.plan).toBeNull();
  });

  it("returns a neutral view when there is no subscription", async () => {
    seed([[]]);
    expect((await getSubscriptionView(STORE)).status).toBeNull();
  });

  describe("★★ the renewal-cancel fields (design 6.3)", () => {
    const LIVE_ROW = {
      plan: "pro",
      period: "monthly",
      state: "active",
      currentPeriodEnd: PERIOD_END,
      currentCycleSeq: 3,
      graceEndsAt: null,
      cancelAtPeriodEnd: true,
      cancelRequestedAt: "2026-08-30T10:00:00.000Z",
      cancelRequestedBy: "merchant:user-1",
      scheduledPlan: null,
      scheduledPeriod: null,
      scheduledLocations: null,
      mandateId: null,
      mandateStatus: null,
      mandateMaxPaise: null,
    };

    function seedView(row: Record<string, unknown>, next: any[] = []) {
      dbHolder.current = makeDbMock({
        selectByTable: {
          billing_subscriptions: [[row]],
          billing_invoices: [next],
        },
      });
    }

    it("★★ carries the next invoice, with whether a payment on it is in flight", async () => {
      // A bigint can reach here as text; the view always says a number.
      seedView(LIVE_ROW, [
        nextInvoiceRow({
          status: "processing",
          totalPaise: "240000",
          inFlight: true,
        }),
      ]);
      const v = await getSubscriptionView(STORE);
      expect(v.nextInvoice).toEqual(
        nextInvoiceRow({
          status: "processing",
          totalPaise: 240000,
          inFlight: true,
        }),
      );
      const where = render(dbHolder.current.calls.where[1]);
      expect(where.params).toEqual([STORE, "subscription", 4]);
    });

    it("★ no next invoice yet reads as null", async () => {
      seedView(LIVE_ROW, []);
      expect((await getSubscriptionView(STORE)).nextInvoice).toBeNull();
    });

    it("★★ an ENDED subscription has no next cycle: nothing is read for it", async () => {
      seedView({ ...LIVE_ROW, state: "cancelled", cancelAtPeriodEnd: false }, [
        nextInvoiceRow({ status: "void" }),
      ]);
      const v = await getSubscriptionView(STORE);
      expect(v.nextInvoice).toBeNull();
      expect(dbHolder.current.calls.select).toHaveLength(1);
    });

    it("★ the grace end only while in grace", async () => {
      seedView({ ...LIVE_ROW, state: "past_due", graceEndsAt: GRACE_END });
      expect((await getSubscriptionView(STORE)).graceEndsAt).toBe(GRACE_END);
      seedView({ ...LIVE_ROW, state: "active", graceEndsAt: GRACE_END });
      expect((await getSubscriptionView(STORE)).graceEndsAt).toBeNull();
    });

    it("★★ who asked, by KIND only: never the user id or the operator's email", async () => {
      seedView({
        ...LIVE_ROW,
        cancelRequestedBy: "operator:ops@storemink.com",
      });
      const v = await getSubscriptionView(STORE);
      expect(v.cancelRequestedBy).toBe("operator");
      expect(v.cancelRequestedAt).toBe("2026-08-30T10:00:00.000Z");
      expect(JSON.stringify(v)).not.toContain("ops@storemink.com");

      seedView(LIVE_ROW);
      const m = await getSubscriptionView(STORE);
      expect(m.cancelRequestedBy).toBe("merchant");
      expect(JSON.stringify(m)).not.toContain("user-1");

      seedView({
        ...LIVE_ROW,
        cancelRequestedBy: null,
        cancelRequestedAt: null,
      });
      expect((await getSubscriptionView(STORE)).cancelRequestedBy).toBeNull();
    });

    it("★ the neutral view carries the new fields as null", async () => {
      seed([[]]);
      expect(await getSubscriptionView(STORE)).toMatchObject({
        nextInvoice: null,
        graceEndsAt: null,
        cancelRequestedBy: null,
        cancelRequestedAt: null,
      });
    });
  });
});
