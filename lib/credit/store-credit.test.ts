/* eslint-disable @typescript-eslint/no-explicit-any */
// Store credit — the ONE way a balance moves.
//
// ── Why this file is exhaustive ────────────────────────────────────────────
// A balance is money pointed the other way: everything true of refunds is true
// here. The invariants this module exists to hold — issuing is idempotent per
// ref, a balance can't go negative, the ledger stays a complete explanation of
// it — all live inside the two RPCs, so what these tests can prove is the
// layer around them: that the right RPC is called with the right amount, that
// a "no" from one is read correctly, and that NOTHING here ever throws into a
// caller who is in the middle of taking a payment.
//
// ⚠ WHAT THIS CANNOT COVER. `add_customer_credit` and
// `try_spend_customer_credit` are plpgsql. The conditional UPDATE that makes
// spending safe under concurrency, the CHECK that forbids a negative balance,
// and the UNIQUE index behind idempotency are all verified against a real
// database by hand (a two-session race, proven on staging) and by
// scripts/audit-returns-integrity.sql — never here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  // `async` rather than Promise.resolve(fn(db)): the real withService is an
  // async function, so a throw inside the callback arrives as a REJECTION. The
  // synchronous form lets it escape past an inner .catch(), which is exactly
  // the path the reinstate offset guard depends on.
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

import { logError } from "@/lib/observability/logger";
import {
  creditReinstatedForOrder,
  getCreditBalance,
  getCreditLedger,
  issueCredit,
  reinstateCreditForOrder,
  spendCredit,
  syncOrderCashback,
} from "./store-credit";

const STORE = "store-1";
const CUST = "cust-1";
const ORDER = "order-1";

function seed(opts: { selects?: any[][]; rpc?: any[][] } = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: opts.selects ?? [],
    executeQueue: opts.rpc ?? [],
  });
}

/** A db whose every read throws — the transient-outage case. */
function brokenDb() {
  dbHolder.current = {
    db: {
      select: () => {
        throw new Error("connection reset");
      },
      execute: () => {
        throw new Error("connection reset");
      },
    },
    calls: { execute: [], select: [] },
  };
}

/** The literal text of a Drizzle `sql` fragment, for asserting RPC arguments.
 *  Its chunks alternate strings and bound params, and a param can hold a
 *  Column that points back at its table — so JSON.stringify hits the cycle. */
function rpcText(fragment: unknown): string {
  const chunks = (fragment as any)?.queryChunks ?? [];
  return chunks
    .flatMap((c: any) =>
      Array.isArray(c?.value)
        ? c.value
        : typeof c?.value === "string"
          ? [c.value]
          : [],
    )
    .join("");
}

/**
 * The values bound into an RPC call, in order.
 *
 * Drizzle interleaves StringChunk objects (whose `value` is a string ARRAY)
 * with the bound values themselves, which are raw primitives — a string, a
 * number, or null — not wrapped in anything. So the literal text and the
 * parameters are told apart by that array, and nothing else.
 */
function rpcParams(fragment: unknown): unknown[] {
  const chunks = (fragment as any)?.queryChunks ?? [];
  return chunks.filter((c: any) => !Array.isArray(c?.value));
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

// ---------------------------------------------------------------------------
// getCreditBalance
// ---------------------------------------------------------------------------

describe("getCreditBalance", () => {
  it("reports what the customer holds", async () => {
    seed({ selects: [[{ balance: 250.5 }]] });
    expect(await getCreditBalance(STORE, CUST)).toBe(250.5);
  });

  it("reports zero for a customer with no row yet", async () => {
    seed({ selects: [[]] });
    expect(await getCreditBalance(STORE, CUST)).toBe(0);
  });

  it("reads a numeric string as a number", async () => {
    // Postgres numeric comes back as a string through the driver.
    seed({ selects: [[{ balance: "99.99" }]] });
    expect(await getCreditBalance(STORE, CUST)).toBe(99.99);
  });

  it("never reports a negative balance", async () => {
    // The CHECK makes this impossible in the database; the floor here means a
    // corrupt row can't turn into a negative discount at checkout.
    seed({ selects: [[{ balance: -50 }]] });
    expect(await getCreditBalance(STORE, CUST)).toBe(0);
  });

  it("treats a null balance as zero", async () => {
    seed({ selects: [[{ balance: null }]] });
    expect(await getCreditBalance(STORE, CUST)).toBe(0);
  });

  it.each([
    ["no store", "", CUST],
    ["no customer", STORE, ""],
  ])("returns 0 with %s, without asking the DB", async (_l, s, c) => {
    seed({ selects: [[{ balance: 500 }]] });
    expect(await getCreditBalance(s, c)).toBe(0);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("★ returns 0 rather than throwing when the DB is down", async () => {
    // A balance is an OFFER at checkout. A blip must never stop someone
    // paying — the worst case is they don't get to spend it this time.
    brokenDb();
    expect(await getCreditBalance(STORE, CUST)).toBe(0);
    expect(logError).toHaveBeenCalledWith("credit.balance", expect.any(Error), {
      storeId: STORE,
      customerId: CUST,
    });
  });
});

// ---------------------------------------------------------------------------
// issueCredit
// ---------------------------------------------------------------------------

describe("issueCredit", () => {
  it("credits the customer through the RPC", async () => {
    seed({ rpc: [[{ ok: true }]] });
    const res = await issueCredit({
      storeId: STORE,
      customerId: CUST,
      amount: 500,
      kind: "refund",
      ref: "rf-1",
    });
    expect(res).toEqual({ ok: true });
    const call = dbHolder.current.calls.execute[0];
    expect(rpcText(call)).toContain("add_customer_credit");
    expect(rpcParams(call)).toEqual([
      STORE,
      CUST,
      500,
      "refund",
      "rf-1",
      null,
      null,
    ]);
  });

  it("★ reports an already-credited ref as SUCCESS, not failure", async () => {
    // The RPC returns false when the (kind, ref) has been credited before —
    // a refund confirmed twice, say, by the client callback AND the reconcile
    // sweep. From the caller's point of view that is success: the customer
    // has the money. Treating it as an error would make a retry look broken.
    seed({ rpc: [[{ ok: false }]] });
    const res = await issueCredit({
      storeId: STORE,
      customerId: CUST,
      amount: 500,
      kind: "refund",
      ref: "rf-1",
    });
    expect(res).toEqual({ ok: true, alreadyIssued: true });
  });

  it("treats a silent RPC (no row back) as already issued", async () => {
    seed({ rpc: [[]] });
    const res = await issueCredit({
      storeId: STORE,
      customerId: CUST,
      amount: 500,
      kind: "grant",
    });
    expect(res).toEqual({ ok: true, alreadyIssued: true });
  });

  it("passes note and actor through, and nulls the ones not given", async () => {
    seed({ rpc: [[{ ok: true }]] });
    await issueCredit({
      storeId: STORE,
      customerId: CUST,
      amount: 100,
      kind: "grant",
      note: "goodwill",
      actor: "owner@shop.test",
    });
    expect(rpcParams(dbHolder.current.calls.execute[0])).toEqual([
      STORE,
      CUST,
      100,
      "grant",
      null,
      "goodwill",
      "owner@shop.test",
    ]);
  });

  it("rounds to paise before it reaches the ledger", async () => {
    // Float arithmetic upstream can produce 33.333…; a ledger that stores it
    // makes the balance disagree with the sum of its own rows.
    seed({ rpc: [[{ ok: true }]] });
    await issueCredit({
      storeId: STORE,
      customerId: CUST,
      amount: 33.333333,
      kind: "refund",
      ref: "r",
    });
    expect(rpcParams(dbHolder.current.calls.execute[0])[2]).toBe(33.33);
  });

  it.each([0, -5, Number.NaN, 0.001])(
    "★ refuses %s — a ledger row must move the balance",
    async (amount) => {
      // 0.001 rounds to zero paise, which is the same thing: an entry that
      // changes nothing but claims something happened.
      seed({ rpc: [[{ ok: true }]] });
      const res = await issueCredit({
        storeId: STORE,
        customerId: CUST,
        amount,
        kind: "refund",
        ref: "r",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("more than zero");
      expect(dbHolder.current.calls.execute).toHaveLength(0);
    },
  );

  it.each([
    ["no store", "", CUST],
    ["no customer", STORE, ""],
  ])("refuses with %s — there is nobody to credit", async (_l, s, c) => {
    const res = await issueCredit({
      storeId: s,
      customerId: c,
      amount: 100,
      kind: "grant",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Missing store or customer");
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("★ reports a failure rather than pretending it worked", async () => {
    // Unlike getCreditBalance, this one must NOT swallow: the caller is
    // issuing a refund and has to know the money didn't land, so it can fail
    // the refund row instead of telling a customer they have a balance.
    brokenDb();
    const res = await issueCredit({
      storeId: STORE,
      customerId: CUST,
      amount: 100,
      kind: "refund",
      ref: "r",
    });
    expect(res).toEqual({ ok: false, error: "Couldn't add store credit." });
    expect(logError).toHaveBeenCalledWith("credit.issue", expect.any(Error), {
      storeId: STORE,
      customerId: CUST,
    });
  });
});

// ---------------------------------------------------------------------------
// spendCredit
// ---------------------------------------------------------------------------

describe("spendCredit", () => {
  it("spends through the conditional RPC and reports success", async () => {
    seed({ rpc: [[{ ok: true }]] });
    expect(
      await spendCredit({
        storeId: STORE,
        customerId: CUST,
        amount: 200,
        orderId: ORDER,
      }),
    ).toBe(true);
    const call = dbHolder.current.calls.execute[0];
    expect(rpcText(call)).toContain("try_spend_customer_credit");
    expect(rpcParams(call)).toEqual([STORE, CUST, 200, ORDER, null]);
  });

  it("★ reports false when the balance moved underneath us", async () => {
    // A normal race, not an error. The RPC's `balance >= amount` lives INSIDE
    // its UPDATE, so two checkouts can't both pass a prior check-then-act.
    // The caller charges the full amount instead of failing the sale.
    seed({ rpc: [[{ ok: false }]] });
    expect(
      await spendCredit({
        storeId: STORE,
        customerId: CUST,
        amount: 200,
        orderId: ORDER,
      }),
    ).toBe(false);
  });

  it("reports false when the RPC says nothing at all", async () => {
    seed({ rpc: [[]] });
    expect(
      await spendCredit({
        storeId: STORE,
        customerId: CUST,
        amount: 200,
        orderId: ORDER,
      }),
    ).toBe(false);
  });

  it("carries a note when given one", async () => {
    seed({ rpc: [[{ ok: true }]] });
    await spendCredit({
      storeId: STORE,
      customerId: CUST,
      amount: 50,
      orderId: ORDER,
      note: "Order 123",
    });
    expect(rpcParams(dbHolder.current.calls.execute[0])[4]).toBe("Order 123");
  });

  it("rounds to paise", async () => {
    seed({ rpc: [[{ ok: true }]] });
    await spendCredit({
      storeId: STORE,
      customerId: CUST,
      amount: 10.006,
      orderId: ORDER,
    });
    expect(rpcParams(dbHolder.current.calls.execute[0])[2]).toBe(10.01);
  });

  it.each([0, -1, Number.NaN])("refuses to spend %s", async (amount) => {
    seed({ rpc: [[{ ok: true }]] });
    expect(
      await spendCredit({
        storeId: STORE,
        customerId: CUST,
        amount,
        orderId: ORDER,
      }),
    ).toBe(false);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("★ returns false rather than throwing — spending never refuses a sale", async () => {
    // Invariant 6. A balance that can't be reached means they pay the full
    // amount, not that checkout dies.
    brokenDb();
    expect(
      await spendCredit({
        storeId: STORE,
        customerId: CUST,
        amount: 200,
        orderId: ORDER,
      }),
    ).toBe(false);
    expect(logError).toHaveBeenCalledWith("credit.spend", expect.any(Error), {
      storeId: STORE,
      orderId: ORDER,
    });
  });
});

// ---------------------------------------------------------------------------
// reinstateCreditForOrder
// ---------------------------------------------------------------------------

describe("reinstateCreditForOrder", () => {
  /**
   * @param spends   the ledger's `spend` rows for this order
   * @param credited what has already gone back as a store_credit refund
   * @param rpcs     one result per issueCredit the loop will make
   */
  function seedReinstate(spends: any[], credited: string, rpcs: any[][] = []) {
    seed({
      selects: [spends, [{ total: credited }]],
      rpc: rpcs.length ? rpcs : [[{ ok: true }]],
    });
  }

  it("gives the whole balance back when nothing was refunded as credit", async () => {
    seedReinstate([{ customer_id: CUST, delta: -500 }], "0");
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(500);
    expect(rpcParams(dbHolder.current.calls.execute[0])).toEqual([
      STORE,
      CUST,
      500,
      "reinstate",
      ORDER,
      "Order cancelled",
      null,
    ]);
  });

  it("★ gives back NOTHING when a credit refund already covered it", async () => {
    // Refund-then-cancel is an ordinary sequence, and the per-(kind, ref)
    // idempotency can't see it: one row is a `refund` keyed on the refund, the
    // other a `reinstate` keyed on the order. A ₹500 order paid entirely with
    // credit used to leave the customer holding ₹1,000.
    seedReinstate([{ customer_id: CUST, delta: -500 }], "500");
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(0);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("gives back only the uncovered part", async () => {
    seedReinstate([{ customer_id: CUST, delta: -500 }], "200");
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(300);
  });

  it("an over-covering refund doesn't reinstate a negative amount", async () => {
    seedReinstate([{ customer_id: CUST, delta: -200 }], "500");
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(0);
  });

  it("★ a CASH refund does not swallow the credit still owed", async () => {
    // The offset query only sums method='store_credit'. Refunding the money
    // half says nothing about the credit half — netting it off would take back
    // a balance the customer is still owed.
    seedReinstate([{ customer_id: CUST, delta: -200 }], "0");
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(200);
  });

  it("spreads the offset across several spend rows", async () => {
    seedReinstate(
      [
        { customer_id: CUST, delta: -100 },
        { customer_id: CUST, delta: -100 },
      ],
      "150",
      [[{ ok: true }]],
    );
    // 150 offset eats the first 100 entirely and half the second.
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(50);
    expect(dbHolder.current.calls.execute).toHaveLength(1);
  });

  it("returns 0 for an order that never used credit", async () => {
    seed({ selects: [[]] });
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(0);
    // It never even asks what was refunded — there is nothing to offset.
    expect(dbHolder.current.calls.select).toHaveLength(1);
  });

  it("skips a zero-delta ledger row", async () => {
    seedReinstate([{ customer_id: CUST, delta: 0 }], "0");
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(0);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("★ doesn't count a reinstatement that was already made", async () => {
    // The second cancel of one order. The RPC says "already credited", and
    // reporting that as money returned would overstate what the store gave
    // back — the number goes into the merchant's own messaging.
    seedReinstate([{ customer_id: CUST, delta: -500 }], "0", [[{ ok: false }]]);
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(0);
  });

  it("doesn't count a reinstatement that failed", async () => {
    seed({ selects: [[{ customer_id: CUST, delta: -500 }], [{ total: "0" }]] });
    dbHolder.current.db.execute = vi.fn(async () => {
      throw new Error("rpc down");
    });
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(0);
  });

  it("★ fails TOWARD reinstating when the offset query breaks", async () => {
    // A customer silently losing a balance they paid with is worse than a
    // visible over-credit, and the ledger makes the latter obvious.
    // The RPC must succeed, or the reinstatement reads as already-issued and
    // reports 0 for a completely different reason than the one under test.
    seed({
      selects: [[{ customer_id: CUST, delta: -500 }]],
      rpc: [[{ ok: true }]],
    });
    let call = 0;
    const realSelect = dbHolder.current.db.select;
    dbHolder.current.db.select = vi.fn((...args: any[]) => {
      call += 1;
      if (call === 2) throw new Error("offset query failed");
      return realSelect(...args);
    });
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(500);
    expect(logError).toHaveBeenCalledWith(
      "credit.reinstate_offset",
      expect.any(Error),
      { storeId: STORE, orderId: ORDER },
    );
  });

  it("treats a missing offset row as nothing refunded", async () => {
    // The SUM query always returns one row, so an empty result means the query
    // shape changed under us. Reading that as "nothing has gone back" keeps a
    // customer's balance intact, which is the safe direction here.
    seed({
      selects: [[{ customer_id: CUST, delta: -500 }], []],
      rpc: [[{ ok: true }]],
    });
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(500);
  });

  it("★ returns 0 rather than throwing — cancelling must still complete", async () => {
    brokenDb();
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(0);
    expect(logError).toHaveBeenCalledWith(
      "credit.reinstate",
      expect.any(Error),
      { storeId: STORE, orderId: ORDER },
    );
  });
});

// ---------------------------------------------------------------------------
// getCreditLedger
// ---------------------------------------------------------------------------

describe("getCreditLedger", () => {
  const row = {
    id: "l1",
    delta: "-200.00",
    kind: "spend",
    ref: ORDER,
    note: null,
    createdAt: "2026-08-01T00:00:00Z",
  };

  it("returns the movements with numeric deltas", async () => {
    seed({ selects: [[row]] });
    const out = await getCreditLedger(STORE, CUST);
    expect(out).toHaveLength(1);
    expect(out[0]!.delta).toBe(-200);
    expect(out[0]!.kind).toBe("spend");
  });

  it("treats a null delta as zero", async () => {
    seed({ selects: [[{ ...row, delta: null }]] });
    expect((await getCreditLedger(STORE, CUST))[0]!.delta).toBe(0);
  });

  it("defaults to the 50 most recent", async () => {
    seed({ selects: [[]] });
    await getCreditLedger(STORE, CUST);
    expect(dbHolder.current.calls.limit).toContain(50);
  });

  it("honours an explicit limit", async () => {
    seed({ selects: [[]] });
    await getCreditLedger(STORE, CUST, 5);
    expect(dbHolder.current.calls.limit).toContain(5);
  });

  it.each([
    ["no store", "", CUST],
    ["no customer", STORE, ""],
  ])("returns [] with %s, without asking the DB", async (_l, s, c) => {
    seed({ selects: [[row]] });
    expect(await getCreditLedger(s, c)).toEqual([]);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("returns [] rather than throwing", async () => {
    brokenDb();
    expect(await getCreditLedger(STORE, CUST)).toEqual([]);
    expect(logError).toHaveBeenCalledWith("credit.ledger", expect.any(Error), {
      storeId: STORE,
      customerId: CUST,
    });
  });
});

// ---------------------------------------------------------------------------
// The refund/cancel integrity additions (migration 0185)
// ---------------------------------------------------------------------------

describe("issueCredit inside the caller's transaction", () => {
  it("★ runs on the handle it is given, so a failure rolls the caller back", async () => {
    // A store-credit refund writes its order_refunds row and this ledger row
    // in ONE transaction; opening a second one would let the row commit while
    // the credit did not.
    seed({ rpc: [[{ ok: true }]] });
    const { withService } = await import("@/lib/db/client");
    vi.mocked(withService).mockClear();
    const res = await issueCredit(
      {
        storeId: STORE,
        customerId: CUST,
        amount: 100,
        kind: "refund",
        ref: "rf-9",
      },
      dbHolder.current.db,
    );
    expect(res).toEqual({ ok: true });
    expect(withService).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.execute).toHaveLength(1);
  });
});

describe("reinstateCreditForOrder, several spends", () => {
  it("★ sums two spends by one customer into ONE reinstatement", async () => {
    // Checkout spent ₹100 and the pickup counter spent ₹50 more. The
    // reinstate row is keyed on the order, so one row per spend would have
    // the second collide with the first and silently keep ₹50.
    seed({
      selects: [
        [
          { customer_id: CUST, delta: -100 },
          { customer_id: CUST, delta: -50 },
        ],
        [{ total: "0" }],
      ],
      rpc: [[{ ok: true }]],
    });
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(150);
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    expect(rpcParams(dbHolder.current.calls.execute[0])[2]).toBe(150);
  });

  it("gives each customer back their own spend", async () => {
    seed({
      selects: [
        [
          { customer_id: "a", delta: -100 },
          { customer_id: "b", delta: -40 },
        ],
        [{ total: "0" }],
      ],
      rpc: [[{ ok: true }], [{ ok: true }]],
    });
    expect(await reinstateCreditForOrder(STORE, ORDER)).toBe(140);
    const params = dbHolder.current.calls.execute.map(rpcParams);
    expect(params.map((p: unknown[]) => [p[1], p[2]])).toEqual([
      ["a", 100],
      ["b", 40],
    ]);
  });
});

describe("creditReinstatedForOrder", () => {
  it("reports what a cancellation already gave back", async () => {
    seed({ selects: [[{ total: "120.50" }]] });
    expect(await creditReinstatedForOrder(STORE, ORDER)).toBe(120.5);
  });

  it("never reports a negative amount", async () => {
    seed({ selects: [[{ total: "-5" }]] });
    expect(await creditReinstatedForOrder(STORE, ORDER)).toBe(0);
  });

  it("reads through the caller's transaction when given one", async () => {
    seed({ selects: [[{ total: "30" }]] });
    const { withService } = await import("@/lib/db/client");
    vi.mocked(withService).mockClear();
    expect(
      await creditReinstatedForOrder(STORE, ORDER, dbHolder.current.db),
    ).toBe(30);
    expect(withService).not.toHaveBeenCalled();
  });
});

describe("syncOrderCashback", () => {
  const paidOrder = {
    storeId: STORE,
    customerId: CUST,
    total: 1000,
    status: "processing",
    paymentStatus: "paid",
    paymentMethod: "razorpay",
    deliveredAt: null,
    storeCreditUsed: 0,
  };

  function seedCashback(opts: {
    order?: Record<string, unknown> | null;
    ledger?: any[];
    refunded?: string;
    taken?: number;
  }) {
    const selects: any[][] = [
      opts.order === null ? [] : [{ ...paidOrder, ...(opts.order ?? {}) }],
      opts.ledger ?? [],
    ];
    if (opts.refunded !== undefined) selects.push([{ total: opts.refunded }]);
    seed({
      selects,
      rpc: [[{ taken: opts.taken ?? 0 }]],
    });
  }

  it("does nothing for an order with no customer", async () => {
    seedCashback({ order: { customerId: null } });
    expect(await syncOrderCashback(ORDER)).toBe(0);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("does nothing when no cashback was ever issued", async () => {
    seedCashback({ ledger: [] });
    expect(await syncOrderCashback(ORDER)).toBe(0);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("★★ a CANCELLED order takes back all the cashback it earned", async () => {
    seedCashback({
      order: { status: "cancelled" },
      ledger: [{ kind: "cashback", delta: 100 }],
      taken: 100,
    });
    expect(await syncOrderCashback(ORDER)).toBe(100);
    const call = dbHolder.current.calls.execute[0];
    expect(rpcText(call)).toContain("reverse_customer_cashback");
    const params = rpcParams(call);
    expect(params[2]).toBe(100);
    // Keyed on the TARGET, so a re-run that wants the same total is a no-op
    // at the unique index rather than a second deduction.
    expect(params[3]).toBe(`${ORDER}:10000`);
    expect(params[4]).toBe("Order cancelled");
  });

  it("★ a half-refunded order takes back half", async () => {
    seedCashback({
      ledger: [{ kind: "cashback", delta: 100 }],
      refunded: "500",
      taken: 50,
    });
    expect(await syncOrderCashback(ORDER)).toBe(50);
    expect(rpcParams(dbHolder.current.calls.execute[0])[2]).toBe(50);
  });

  it("only takes the part not already reversed", async () => {
    seedCashback({
      ledger: [
        { kind: "cashback", delta: 100 },
        { kind: "cashback_reversal", delta: -50 },
      ],
      refunded: "1000",
      taken: 50,
    });
    await syncOrderCashback(ORDER);
    expect(rpcParams(dbHolder.current.calls.execute[0])[2]).toBe(50);
  });

  it("does nothing once the reversal has caught up", async () => {
    seedCashback({
      ledger: [
        { kind: "cashback", delta: 100 },
        { kind: "cashback_reversal", delta: -50 },
      ],
      refunded: "500",
    });
    expect(await syncOrderCashback(ORDER)).toBe(0);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("counts store credit the order was paid with as part of its value", async () => {
    // ₹1,000 order: ₹600 card + ₹400 credit. Refunding the ₹600 card part
    // is 60% of the value, so 60% of the cashback comes back.
    seedCashback({
      order: { storeCreditUsed: 400 },
      ledger: [{ kind: "cashback", delta: 100 }],
      refunded: "600",
      taken: 60,
    });
    await syncOrderCashback(ORDER);
    expect(rpcParams(dbHolder.current.calls.execute[0])[2]).toBe(60);
  });

  it("★ logs when the customer already spent the cashback", async () => {
    seedCashback({
      order: { status: "cancelled" },
      ledger: [{ kind: "cashback", delta: 100 }],
      taken: 30,
    });
    expect(await syncOrderCashback(ORDER)).toBe(30);
    expect(logError).toHaveBeenCalledWith(
      "credit.cashback_reversal_short",
      expect.any(Error),
      expect.objectContaining({ orderId: ORDER, wanted: 100, taken: 30 }),
    );
  });

  it("is silent before migration 0185 creates the function", async () => {
    seedCashback({
      order: { status: "cancelled" },
      ledger: [{ kind: "cashback", delta: 100 }],
    });
    dbHolder.current.db.execute = vi.fn(async () => {
      throw Object.assign(new Error("function does not exist"), {
        code: "42883",
      });
    });
    expect(await syncOrderCashback(ORDER)).toBe(0);
    expect(logError).not.toHaveBeenCalled();
  });

  it("★ never throws into the refund or cancel that called it", async () => {
    brokenDb();
    expect(await syncOrderCashback(ORDER)).toBe(0);
    expect(logError).toHaveBeenCalledWith(
      "credit.cashback_reversal",
      expect.any(Error),
      { orderId: ORDER },
    );
  });
});
