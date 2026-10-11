/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("@/lib/pos/customer-verification", () => ({
  gateCustomerVerification: vi.fn(async () => ({
    ok: true,
    overridden: false,
  })),
  clearCustomerVerification: vi.fn(async () => undefined),
}));
vi.mock("./pos-shift-actions", () => ({
  currentShiftIdFor: vi.fn(async () => "shift-1"),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/pos/audit", () => ({ posAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inventory/alerts", () => ({ reportStockChanges: vi.fn() }));
vi.mock("@/lib/payments/issue-refund", () => ({
  issueRefund: vi.fn(async () => ({ refundId: "rf-1", status: "completed" })),
}));
vi.mock("@/lib/returns/counter-policy", () => ({
  getCounterReturnPolicy: vi.fn(),
}));
vi.mock("@/lib/settings/resolve", () => ({
  getStoreSettings: vi.fn(async () => ({})),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import { emitEvent } from "@/lib/notifications/record";
import { issueRefund } from "@/lib/payments/issue-refund";
import {
  findOrderForReturn,
  getReturnableSale,
  processReturn,
} from "./pos-return-actions";
import { gateCustomerVerification } from "@/lib/pos/customer-verification";
import { posAudit } from "@/lib/pos/audit";
import { getCounterReturnPolicy } from "@/lib/returns/counter-policy";
import { getStoreSettings } from "@/lib/settings/resolve";
import { currentShiftIdFor } from "./pos-shift-actions";
import { orderReturns } from "@/drizzle/schema";

const MANAGER = {
  role: "manager" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "st1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};
const CASHIER = { ...MANAGER, role: "cashier" as const };

/** A sale of 2 × ₹100 (tax ₹10) and 1 × ₹50 (tax ₹2.50), no order discount. */
function seedSale(
  opts: {
    prior?: { order_item_id: string; qty: number }[];
    /** Refunds already recorded, which the in-transaction cap reads. */
    existingRefunds?: { amount: number; status: string; method: string }[];
    storeCreditUsed?: number;
    paymentRows?: Array<{
      method: string;
      amount: number;
      change_due: number | null;
      reference: string | null;
    }>;
    productReturnable?: boolean;
    /** Anything other than a `pos` sale rung at `loc-1` is BORIS. */
    salesChannel?: string;
    locationId?: string | null;
    paymentMethod?: string;
  } = {},
) {
  const order = {
    id: "o1",
    receipt_no: "POS-000007",
    order_ref: "ORD1",
    created_at: "2026-07-30T10:00:00Z",
    total: 262.5,
    discount: 0,
    store_credit_used: opts.storeCreditUsed ?? 0,
    payment_method: opts.paymentMethod ?? "cash",
    payment_status: "paid",
    // Rung at THIS register — the grandfathered path that skips the BORIS
    // gates and, when the store has never switched returns on, the policy too.
    location_id: opts.locationId === undefined ? "loc-1" : opts.locationId,
    sales_channel: opts.salesChannel ?? "pos",
    status: "completed",
    delivered_at: null,
    collected_at: null,
  };
  const items = [
    {
      id: "li-a",
      product_id: "p1",
      variant_id: null,
      name: "Milk",
      variant_name: null,
      quantity: 2,
      price: 100,
      total: 200,
      line_discount: 0,
      tax_amount: 10,
      product_returnable: opts.productReturnable ?? true,
      product_window: null,
    },
    {
      id: "li-b",
      product_id: "p2",
      variant_id: null,
      name: "Salt",
      variant_name: null,
      quantity: 1,
      price: 50,
      total: 50,
      line_discount: 0,
      tax_amount: 2.5,
      product_returnable: true,
      product_window: null,
    },
  ];
  const prior = opts.prior ?? [];
  dbHolder.current = makeDbMock({
    selectQueue: [
      // getReturnableSale
      [order],
      items,
      prior,
      opts.paymentRows ?? [],
      // processReturn's write transaction: FOR UPDATE lock → items → prior
      // → refunds already recorded (the money cap).
      [order],
      items,
      prior,
      opts.existingRefunds ?? [],
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(MANAGER as any);
  vi.mocked(gateCustomerVerification).mockResolvedValue({
    ok: true,
    overridden: false,
  });
  vi.mocked(getCounterReturnPolicy).mockResolvedValue({
    enabled: true,
    allowInStore: true,
    allowExchanges: true,
    requireReason: false,
    windowDays: 365,
    restockingFeePercent: 0,
    locationAccepts: true,
  });
  seedSale();
});

describe("getReturnableSale", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await getReturnableSale("o1")).error).toMatch(/signed in/i);
  });

  it("★ a cashier cannot take returns — refunding is a manager capability", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    expect((await getReturnableSale("o1")).error).toMatch(/permission/i);
  });

  it("reports what is still returnable", async () => {
    const { sale } = await getReturnableSale("o1");
    expect(sale?.lines.map((l) => [l.id, l.remaining])).toEqual([
      ["li-a", 2],
      ["li-b", 1],
    ]);
  });

  it("★ subtracts what earlier returns already took back", async () => {
    seedSale({ prior: [{ order_item_id: "li-a", qty: 1 }] });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.lines[0]).toMatchObject({ returned: 1, remaining: 1 });
  });

  it("★ scopes to the operator's own shop", async () => {
    await getReturnableSale("o1");
    // store AND location equality, alongside the order id.
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  // ★★ `returns.enabled` DEFAULTS OFF and the till has taken returns of its own
  // sales since pos_12, so the master switch must not reach them: gating it
  // there removes a working capability from every existing POS merchant on
  // deploy, with no migration to restore it (roadmap invariant 1).
  describe("★ the master switch governs BORIS, never a sale rung here", () => {
    const OFF = {
      enabled: false,
      allowInStore: false,
      allowExchanges: false,
      requireReason: true,
      windowDays: 7,
      restockingFeePercent: 0,
      locationAccepts: false,
    };

    it("still takes back a sale rung at this counter", async () => {
      vi.mocked(getCounterReturnPolicy).mockResolvedValue(OFF);
      const { sale, error } = await getReturnableSale("o1");
      expect(error).toBeUndefined();
      expect(sale?.lines.map((l) => l.remaining)).toEqual([2, 1]);
    });

    it("runs it under LEGACY semantics, not the registry defaults", async () => {
      vi.mocked(getCounterReturnPolicy).mockResolvedValue({
        ...OFF,
        // Values a merchant never chose. None of them may apply.
        requireReason: true,
        restockingFeePercent: 20,
        allowExchanges: true,
        windowDays: 7,
      });
      const { sale } = await getReturnableSale("o1");
      expect(sale).toMatchObject({
        requireReason: false,
        restockingFeePercent: 0,
        allowExchanges: false,
      });
    });

    it("★ a 7-day default window can't expire a till return it used to accept", async () => {
      vi.mocked(getCounterReturnPolicy).mockResolvedValue(OFF);
      // The seeded sale is from 2026-07-30 — well outside 7 days.
      vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
      const { sale } = await getReturnableSale("o1");
      vi.useRealTimers();
      expect(sale?.lines.every((l) => l.eligible)).toBe(true);
    });

    it("★ but still refuses a BROUGHT-IN order — that capability IS new", async () => {
      vi.mocked(getCounterReturnPolicy).mockResolvedValue(OFF);
      seedSale({ salesChannel: "online", locationId: null });
      expect((await getReturnableSale("o1")).error).toMatch(
        /returns are switched off/i,
      );
    });

    it("★ and the switch still applies in full once it is ON", async () => {
      vi.mocked(getCounterReturnPolicy).mockResolvedValue({
        ...OFF,
        enabled: true,
        allowInStore: true,
        locationAccepts: true,
        requireReason: true,
        restockingFeePercent: 20,
      });
      const { sale } = await getReturnableSale("o1");
      expect(sale).toMatchObject({
        requireReason: true,
        restockingFeePercent: 20,
      });
    });
  });

  it("marks a final-sale product ineligible at the till", async () => {
    seedSale({ productReturnable: false });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.lines[0]).toMatchObject({
      eligible: false,
      blockedCopy: expect.stringMatching(/final sale/i),
    });
  });

  // ★★ placePosSale stamps the SALE's change on every cash tender row, so
  // subtracting it per row deducts it once per row — the double-count
  // lib/pos/shifts.ts already guards with its group-by-order max.
  describe("★ change is deducted once per sale, not once per cash row", () => {
    it("scores two cash legs against the cash that actually stayed", async () => {
      // ₹500 of cash across two legs, ₹100 change: ₹400 stayed in the drawer.
      seedSale({
        paymentRows: [
          { method: "cash", amount: 200, change_due: 100, reference: null },
          { method: "cash", amount: 400, change_due: 100, reference: null },
          { method: "card", amount: 62.5, change_due: null, reference: "T-1" },
        ],
      });
      const { sale } = await getReturnableSale("o1");
      const cash = (sale?.refundTenders ?? []).filter(
        (t) => t.method === "cash",
      );
      expect(cash.reduce((sum, t) => sum + t.amount, 0)).toBe(500);
    });

    it("★ still deducts it for the ordinary single cash tender", async () => {
      seedSale({
        paymentRows: [
          { method: "cash", amount: 300, change_due: 37.5, reference: null },
        ],
      });
      const { sale } = await getReturnableSale("o1");
      expect(sale?.refundTenders).toEqual([
        { method: "cash", amount: 262.5, reference: null },
      ]);
    });

    it("★ never lets change on a cash row reach a card one", async () => {
      seedSale({
        paymentRows: [
          { method: "card", amount: 200, change_due: 50, reference: "T-1" },
          { method: "cash", amount: 112.5, change_due: 50, reference: null },
        ],
      });
      const { sale } = await getReturnableSale("o1");
      expect(sale?.refundTenders).toEqual([
        { method: "card", amount: 200, reference: "T-1" },
        { method: "cash", amount: 62.5, reference: null },
      ]);
    });
  });

  it("reads split tender rows instead of offering an arbitrary cash refund", async () => {
    seedSale({
      paymentRows: [
        { method: "cash", amount: 62.5, change_due: 0, reference: null },
        { method: "card", amount: 200, change_due: null, reference: "T-1" },
      ],
    });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.refundRoute).toMatchObject({
      method: "original",
      counterChoice: false,
    });
    expect(sale?.refundTenders.map((tender) => tender.method)).toEqual([
      "cash",
      "card",
    ]);
  });
});

describe("findOrderForReturn", () => {
  it("returns a customer-linked POS receipt found by the submitted phone", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o1",
            order_ref: "ORD1",
            receipt_no: "POS-000007",
            created_at: "2026-08-29T10:00:00Z",
            total: 262.5,
            payment_method: "cash",
            location_id: "loc-1",
            sales_channel: "pos",
          },
        ],
      ],
    });

    const result = await findOrderForReturn("9814");

    expect(result).toEqual({
      results: [
        expect.objectContaining({
          orderId: "o1",
          label: "ORD1",
          broughtIn: false,
        }),
      ],
    });
    expect(dbHolder.current.calls.leftJoin).toHaveLength(1);
  });
});

describe("processReturn", () => {
  it("requires the server-bound customer OTP proof before loading refund details", async () => {
    vi.mocked(gateCustomerVerification).mockResolvedValue({
      ok: false,
      verificationRequired: true,
      error: "Verify the customer's mobile number before handover.",
    });
    const result = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(result).toMatchObject({ verificationRequired: true });
    expect(result.error).toMatch(/verify.*mobile/i);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("refuses a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toMatch(/permission/i);
  });

  it("refuses an unknown refund method", async () => {
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "gift_card" as never,
    );
    expect(r.error).toMatch(/how the money goes back/i);
  });

  it("refuses an empty return", async () => {
    expect((await processReturn("o1", [], "cash")).error).toMatch(
      /what's coming back/i,
    );
  });

  it("requires a reason when the merchant setting does", async () => {
    vi.mocked(getCounterReturnPolicy).mockResolvedValue({
      enabled: true,
      allowInStore: true,
      allowExchanges: true,
      requireReason: true,
      windowDays: 365,
      restockingFeePercent: 0,
      locationAccepts: true,
    });
    const result = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(result.error).toMatch(/choose why/i);
  });

  it("allocates a split refund over its original tenders", async () => {
    seedSale({
      paymentRows: [
        { method: "cash", amount: 62.5, change_due: 0, reference: null },
        { method: "card", amount: 200, change_due: null, reference: "T-1" },
      ],
    });
    const result = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "original",
    );
    expect(result.error).toBeUndefined();
    expect(
      vi.mocked(issueRefund).mock.calls.map(([input]) => input.method),
    ).toEqual(["cash", "card"]);
    expect(
      vi
        .mocked(issueRefund)
        .mock.calls.reduce((sum, [input]) => sum + Number(input.amount), 0),
    ).toBe(105);
  });

  // The same dead end the hand-over counter had — a return on an order with no
  // textable mobile could not be taken at all.
  it("★ reports an unreachable OTP as unavailable, not as a refusal", async () => {
    vi.mocked(gateCustomerVerification).mockResolvedValue({
      ok: false,
      verificationUnavailable: true,
      canOverride: true,
      error: "This order has no mobile number that can be texted.",
    });
    const res = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(res).toMatchObject({
      verificationUnavailable: true,
      canOverrideVerification: true,
    });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("★ forwards the acknowledgement for the server to judge", async () => {
    await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
      undefined,
      { acknowledgeUnverifiedCustomer: true },
    );
    expect(vi.mocked(gateCustomerVerification).mock.calls[0][0]).toMatchObject({
      acknowledged: true,
      purpose: "return",
    });
  });

  it("★ audits an overridden return separately from the refund itself", async () => {
    vi.mocked(gateCustomerVerification).mockResolvedValue({
      ok: true,
      overridden: true,
    });
    await processReturn("o1", [{ orderItemId: "li-a", quantity: 1 }], "cash");
    const events = vi.mocked(posAudit).mock.calls.map(([e]) => e.event);
    // BOTH — "who gave money back" and "and nobody checked who they were" are
    // different questions, and folding the second into the first's detail
    // hides it from the only query that would ever ask for it.
    expect(events).toContain("refund_issued");
    expect(events).toContain("identity_override");
  });

  it("★ recomputes the amount server-side — a line quantity beyond what remains is clamped", async () => {
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 99 }],
      "cash",
    );
    // 2 units only: 200 + 10 tax.
    expect(r.refunded).toBe(210);
  });

  it("refuses when nothing on the sale is still returnable", async () => {
    seedSale({
      prior: [
        { order_item_id: "li-a", qty: 2 },
        { order_item_id: "li-b", qty: 1 },
      ],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toMatch(/still returnable/i);
  });

  it("emits order.refund_issued with what actually went back", async () => {
    await processReturn("o1", [{ orderItemId: "li-b", quantity: 1 }], "cash");
    // ★ `amount`, not `total`. The catalog declares `amount` for this event and
    // templateValues drops anything undeclared, so `total` meant the customer's
    // refund email carried no figure at all. `paymentMethod` is what keeps the
    // copy from claiming a card was credited when it wasn't.
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "order.refund_issued",
        payload: expect.objectContaining({
          amount: 52.5,
          paymentMethod: "cash",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// BORIS — returning an ONLINE order at a counter (roadmap Step 5)
// ---------------------------------------------------------------------------

/** An order that was NOT rung at this register. */
function seedBroughtIn(opts: {
  paymentMethod?: string;
  storeAllows?: boolean;
  locationAccepts?: boolean;
  locationId?: string | null;
}) {
  const {
    paymentMethod = "razorpay",
    storeAllows = true,
    locationAccepts = true,
    locationId = null,
  } = opts;
  const order = {
    id: "o1",
    receipt_no: null,
    order_ref: "ORD10011027",
    created_at: "2026-07-30T10:00:00Z",
    total: 210,
    discount: 0,
    store_credit_used: 0,
    payment_method: paymentMethod,
    payment_status: "paid",
    // Online is always a brought-in return, even if it was fulfilled by this
    // same shop for pickup.
    location_id: locationId,
    sales_channel: "online",
    status: "delivered",
    delivered_at: "2026-08-28T10:00:00Z",
    collected_at: null,
  };
  const items = [
    {
      id: "li-a",
      product_id: "p1",
      variant_id: null,
      name: "Milk",
      variant_name: null,
      quantity: 2,
      price: 100,
      total: 200,
      line_discount: 0,
      tax_amount: 10,
      product_returnable: true,
      product_window: null,
    },
  ];
  vi.mocked(getCounterReturnPolicy).mockResolvedValue({
    enabled: true,
    allowInStore: storeAllows,
    allowExchanges: true,
    requireReason: false,
    windowDays: 365,
    restockingFeePercent: 0,
    locationAccepts,
  });
  dbHolder.current = makeDbMock({
    selectQueue: [
      [order],
      items,
      [], // prior returns
      [], // original tender rows; payment_method is the legacy source
      [order],
      items,
      [],
      [], // existing refunds
    ],
    returning: [{ id: "ret-1" }],
  });
}

describe("BORIS — an order this counter didn't sell", () => {
  beforeEach(() => {
    vi.mocked(resolvePosOperator).mockResolvedValue(MANAGER as any);
  });

  it("★ is FOUND at all — the lookup is store-scoped, not location-scoped", async () => {
    // The old `location_id = op.locationId` predicate could never match an
    // online order, so BORIS found nothing whatsoever.
    seedBroughtIn({});
    const { sale, error } = await getReturnableSale("o1");
    expect(error).toBeUndefined();
    expect(sale?.broughtIn).toBe(true);
  });

  it("treats an online pickup from this same shop as an in-store return", async () => {
    seedBroughtIn({ locationId: "loc-1", storeAllows: false });
    const { sale, error } = await getReturnableSale("o1");
    expect(sale).toBeUndefined();
    expect(error).toContain("only take back");
  });

  it("★ routes an online order's refund to the GATEWAY, with no counter choice", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.refundRoute.method).toBe("razorpay");
    expect(sale?.refundRoute.counterChoice).toBe(false);
    expect(sale?.refundRoute.affectsDrawer).toBe(false);
  });

  it("offers the counter tenders for a COD order", async () => {
    seedBroughtIn({ paymentMethod: "cash_on_delivery" });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.refundRoute.counterChoice).toBe(true);
    expect(sale?.refundRoute.affectsDrawer).toBe(true);
  });

  it("★ is refused when the store hasn't enabled in-store returns", async () => {
    seedBroughtIn({ storeAllows: false });
    const { sale, error } = await getReturnableSale("o1");
    expect(sale).toBeUndefined();
    expect(error).toContain("only take back");
  });

  it("★ is refused when THIS location lacks the returns capability", async () => {
    seedBroughtIn({ locationAccepts: false });
    const { error } = await getReturnableSale("o1");
    expect(error).toContain("Locations");
  });

  it("★ REFUSES cash for a card order, even called directly", async () => {
    // The till hides the option; this is the server saying no anyway. Cash
    // back for a card sale is the card-not-present laundering path.
    seedBroughtIn({ paymentMethod: "razorpay" });
    const res = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(res.error).toContain("original source");
    expect(issueRefund).not.toHaveBeenCalled();
  });

  it("★ sends a card order's refund through the shared core, with NO shift", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    const res = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    expect(res.error).toBeUndefined();
    expect(issueRefund).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o1", method: "razorpay" }),
    );
    // A gateway refund never touches the drawer — stamping a shift would make
    // the cash report count money that never left the till.
    const call = vi.mocked(issueRefund).mock.calls[0][0] as any;
    expect(call.shiftId).toBeNull();
    expect(call.locationId).toBeNull();
  });

  it("★ keeps the return when the gateway refund fails — the goods ARE back", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    vi.mocked(issueRefund).mockResolvedValueOnce({
      error: "Razorpay isn't connected.",
      code: "gateway_not_connected",
    } as any);
    const res = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    // NOT an error: the customer handed the items over and walked away.
    expect(res.error).toBeUndefined();
    expect(res.returnId).toBeTruthy();
    expect(res.note).toContain("couldn't be sent");
  });

  it("warns without inviting a retry when the gateway hasn't confirmed", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    vi.mocked(issueRefund).mockResolvedValueOnce({
      refundId: "rf-1",
      status: "pending",
      pendingReconcile: true,
    } as any);
    const res = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    expect(res.note).toContain("Do not send it a second time");
  });
});

describe("★ the drawer is capped, not just the goods", () => {
  it("takes a row lock before pricing", async () => {
    // getReturnableSale answered "what may come back" outside any
    // transaction. Two counters — or one double-tapped Confirm — both read it
    // before either wrote: proven on staging as ₹158 refunded against a ₹79
    // sale. The gateway path was safe because issueRefund takes this lock;
    // the cash path wrote its refund row directly and had nothing.
    seedSale();
    await processReturn("o1", [{ orderItemId: "li-a", quantity: 1 }], "cash");
    expect(dbHolder.current.calls.forUpdate).toContain("update");
  });

  it("★ refuses a cash refund beyond what the sale can still give back", async () => {
    // ₹262.50 sale with ₹250 already refunded. The quantity clamp is happy —
    // the goods are still on the order — but the money is not there.
    seedSale({
      existingRefunds: [{ amount: 250, status: "completed", method: "cash" }],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 2 }],
      "cash",
    );
    expect(r.error).toMatch(/at most ₹12\.50/);
    expect(r.returnId).toBeUndefined();
  });

  it("says so plainly when nothing is left", async () => {
    seedSale({
      existingRefunds: [{ amount: 262.5, status: "completed", method: "cash" }],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-b", quantity: 1 }],
      "cash",
    );
    expect(r.error).toMatch(/already been fully refunded/i);
  });

  it("a FAILED refund frees its amount again", async () => {
    seedSale({
      existingRefunds: [{ amount: 250, status: "failed", method: "cash" }],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 2 }],
      "cash",
    );
    expect(r.error).toBeUndefined();
  });

  it("★ won't hand back cash for the part settled with store credit", async () => {
    // ₹262.50 of goods, ₹200 of it paid with credit ⇒ only ₹62.50 of money
    // ever arrived, and that is all the drawer may return.
    seedSale({ storeCreditUsed: 200 });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 2 }],
      "cash",
    );
    expect(r.error).toMatch(/at most ₹62\.50/);
  });

  // ★★ A SPLIT HAS TWO CEILINGS. refundableAmount caps a MONEY method at what
  // money actually paid, so measuring the WHOLE split against that ceiling
  // refuses the credit leg for being money it never was.
  describe("★ a split is capped per destination, not all as cash", () => {
    /** ₹262.50 of goods: ₹200 on store credit, ₹62.50 in cash. */
    const CREDIT_SPLIT = {
      storeCreditUsed: 200,
      paymentRows: [
        {
          method: "store_credit",
          amount: 200,
          change_due: null,
          reference: null,
        },
        { method: "cash", amount: 62.5, change_due: 0, reference: null },
      ],
    };

    it("★ takes back the WHOLE sale that was part-paid with credit", async () => {
      seedSale(CREDIT_SPLIT);
      const r = await processReturn(
        "o1",
        [
          { orderItemId: "li-a", quantity: 2 },
          { orderItemId: "li-b", quantity: 1 },
        ],
        "original",
      );
      // The old cap measured all ₹262.50 against the ₹62.50 money ceiling and
      // refused a legitimate full return outright.
      expect(r.error).toBeUndefined();
      expect(r.refunded).toBe(262.5);
    });

    it("sends each leg to the instrument that actually paid it", async () => {
      seedSale(CREDIT_SPLIT);
      await processReturn(
        "o1",
        [
          { orderItemId: "li-a", quantity: 2 },
          { orderItemId: "li-b", quantity: 1 },
        ],
        "original",
      );
      expect(
        vi.mocked(issueRefund).mock.calls.map(([i]) => [i.method, i.amount]),
      ).toEqual([
        ["store_credit", 200],
        ["cash", 62.5],
      ]);
    });

    it("★ still refuses when the MONEY legs exceed what money paid", async () => {
      // The cash already went back, so only the credit share is left. Asking
      // for it as an all-money split must not pass the overall cap alone.
      seedSale({
        storeCreditUsed: 200,
        paymentRows: [
          { method: "cash", amount: 62.5, change_due: 0, reference: null },
        ],
        existingRefunds: [
          { amount: 62.5, status: "completed", method: "cash" },
        ],
      });
      const r = await processReturn(
        "o1",
        [{ orderItemId: "li-a", quantity: 2 }],
        "cash",
      );
      expect(r.error).toMatch(/at most ₹0\.00|fully refunded/i);
    });
  });

  it("★ can't be multiplied by naming the same line twice", async () => {
    seedSale();
    const r = await processReturn(
      "o1",
      [
        { orderItemId: "li-b", quantity: 1 },
        { orderItemId: "li-b", quantity: 1 },
        { orderItemId: "li-b", quantity: 1 },
      ],
      "cash",
    );
    expect(r.error).toBeUndefined();
    // ₹50 + ₹2.50 tax, once — not three times.
    expect(r.refunded).toBe(52.5);
  });
});

// ★★ AN OFFER'S SHARE BELONGS TO THE LINE THAT GOT IT.
//
// `orders.discount` is the sum of three things: the line markdowns (already
// inside each line's `total`), each line's `offer_discount`, and the genuine
// order-level remainder. Both refund paths subtracted only the markdowns, so an
// offer's share stayed in the figure handed to `refundBreakdown` — which spreads
// it PROPORTIONALLY. For a reward that belonged to one line that is simply the
// wrong allocation, and it moves real money in both directions.
//
// Migration 0059's own header says so: storing a scoped reward only in
// `orders.discount` "over-refunds returns (a Buy-1-Get-1 free line comes back at
// full price)". The column existed; nothing read it.
describe("★★ a scoped offer is refunded from its own line", () => {
  /**
   * "20% off Milk": ₹200 of Milk discounted by ₹40, ₹50 of Salt untouched.
   * `orders.discount` is 40 and all of it sits on line A.
   */
  function seedOfferSale() {
    const order = {
      id: "o1",
      receipt_no: "POS-000007",
      order_ref: "ORD1",
      created_at: "2026-07-30T10:00:00Z",
      total: 222.5,
      discount: 40,
      store_credit_used: 0,
      payment_method: "cash",
      payment_status: "paid",
      location_id: "loc-1",
      sales_channel: "pos",
      status: "completed",
      delivered_at: null,
      collected_at: null,
    };
    const items = [
      {
        id: "li-a",
        product_id: "p1",
        variant_id: null,
        name: "Milk",
        variant_name: null,
        quantity: 2,
        price: 100,
        total: 200,
        line_discount: 0,
        offer_discount: 40,
        tax_amount: 8,
        product_returnable: true,
        product_window: null,
      },
      {
        id: "li-b",
        product_id: "p2",
        variant_id: null,
        name: "Salt",
        variant_name: null,
        quantity: 1,
        price: 50,
        total: 50,
        line_discount: 0,
        offer_discount: 0,
        tax_amount: 2.5,
        product_returnable: true,
        product_window: null,
      },
    ];
    dbHolder.current = makeDbMock({
      selectQueue: [[order], items, [], [], [order], items, [], []],
    });
  }

  /** What the return actually sent to the one refund mechanism, in rupees. */
  const refunded = () =>
    vi
      .mocked(issueRefund)
      .mock.calls.reduce((sum, [input]) => sum + (input.amount ?? 0), 0);

  it("★ the preview keeps the offer on its line and out of the remainder", () => {
    seedOfferSale();
    return getReturnableSale("o1").then(({ sale }) => {
      // 40 − 0 markdowns − 40 offer = nothing genuinely order-level left.
      expect(sale?.orderDiscount).toBe(0);
      expect(sale?.lines.map((l) => l.offerDiscount)).toEqual([40, 0]);
    });
  });

  it("★★ returning the discounted line refunds what was PAID for it", async () => {
    // ₹200 of Milk less its own ₹40 = ₹160 of goods, plus its ₹8 tax.
    // Spreading the ₹40 instead gives the line only ₹32 of it — ₹168 — so the
    // customer walks away with ₹8 the store never charged.
    seedOfferSale();
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 2 }],
      "cash",
    );
    expect(r.error).toBeUndefined();
    expect(refunded()).toBe(168);
  });

  it("★★ and the UNDISCOUNTED line comes back whole", async () => {
    // The mirror image, and the one a customer complains about: ₹50 of Salt
    // carried none of the offer, so it refunds ₹50 + ₹2.50 tax. Spreading the
    // ₹40 charges it ₹8 of a discount it never received.
    seedOfferSale();
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-b", quantity: 1 }],
      "cash",
    );
    expect(r.error).toBeUndefined();
    expect(refunded()).toBe(52.5);
  });
});

// ---------------------------------------------------------------------------
// The money-correctness fixes (2026-10-11 audit)
// ---------------------------------------------------------------------------

/**
 * A sale seeded row by row, for the cases `seedSale` cannot express.
 *
 * The positional select order is fixed by the action: getReturnableSale reads
 * order → items → prior returns → tender rows; processReturn's transaction then
 * reads the FOR UPDATE order → (the retry-key lookup, only when a key is sent)
 * → items → prior returns → recorded refunds (the money cap, skipped only when
 * no money moves at this counter).
 */
function seedRows(opts: {
  order: Record<string, unknown>;
  items: any[];
  paymentRows?: any[];
  prior?: any[];
  /** Present = a retry key is sent; its lookup result. */
  keyLookup?: any[];
  /** null = the route moves no money, so the cap read never happens. */
  existingRefunds?: any[] | null;
  tail?: any[][];
}) {
  const prior = opts.prior ?? [];
  const queue: any[][] = [
    [opts.order],
    opts.items,
    prior,
    opts.paymentRows ?? [],
    [opts.order],
  ];
  if (opts.keyLookup) queue.push(opts.keyLookup);
  queue.push(opts.items, prior);
  if (opts.existingRefunds !== null) queue.push(opts.existingRefunds ?? []);
  queue.push(...(opts.tail ?? []));
  dbHolder.current = makeDbMock({
    selectQueue: queue,
    returning: [{ id: "ret-1" }],
  });
}

const baseOrder = (over: Record<string, unknown> = {}) => ({
  id: "o1",
  receipt_no: "POS-000007",
  order_ref: "ORD1",
  created_at: "2026-07-30T10:00:00Z",
  total: 262.5,
  discount: 0,
  store_credit_used: 0,
  customer_id: null,
  tax_inclusive: false,
  payment_method: "cash",
  payment_status: "paid",
  location_id: "loc-1",
  sales_channel: "pos",
  status: "completed",
  delivered_at: null,
  collected_at: null,
  ...over,
});

const line = (over: Record<string, unknown> = {}) => ({
  id: "li-a",
  product_id: "p1",
  variant_id: null,
  name: "Kurta",
  variant_name: null,
  quantity: 1,
  price: 1180,
  total: 1180,
  line_discount: 0,
  offer_discount: 0,
  tax_amount: 180,
  product_returnable: true,
  product_window: null,
  ...over,
});

const refundedTotal = () =>
  vi
    .mocked(issueRefund)
    .mock.calls.reduce((sum, [input]) => sum + Number(input.amount ?? 0), 0);

describe("★★ fix 1 — a tax-inclusive sale refunds its tax once", () => {
  it("★★ refunds what was paid, not paid + the tax inside it", async () => {
    // ₹1,180 at 18% inclusive. The till used to hand back ₹1,360.
    seedRows({
      order: baseOrder({ total: 1180, tax_inclusive: true }),
      items: [line()],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toBeUndefined();
    expect(r.refunded).toBe(1180);
    expect(refundedTotal()).toBe(1180);
    // The stored return carries the goods and the tax carved out of them.
    const stored = dbHolder.current.calls.values[0];
    expect(stored).toMatchObject({ amount: 1000, tax: 180, total: 1180 });
  });

  it("★ tells the till preview the order was inclusive", async () => {
    seedRows({
      order: baseOrder({ total: 1180, tax_inclusive: true }),
      items: [line()],
    });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.taxInclusive).toBe(true);
  });

  it("an exclusive sale is unchanged", async () => {
    seedRows({
      order: baseOrder({ total: 1180, tax_inclusive: false }),
      items: [line({ price: 1000, total: 1000, tax_amount: 180 })],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.refunded).toBe(1180);
    const { sale } = await (async () => {
      seedRows({
        order: baseOrder({ total: 1180 }),
        items: [line({ price: 1000, total: 1000, tax_amount: 180 })],
      });
      return getReturnableSale("o1");
    })();
    expect(sale?.taxInclusive).toBe(false);
  });
});

describe("★★ fix 2 — an exchange replacement is never cashed out", () => {
  /** A website exchange order: paid by goods that came back, no tender rows. */
  const exchangeOrder = (customerId: string | null) =>
    baseOrder({
      receipt_no: null,
      total: 590,
      payment_method: "exchange",
      payment_status: "paid",
      customer_id: customerId,
      location_id: null,
      sales_channel: "online",
      status: "delivered",
      delivered_at: "2026-08-28T10:00:00Z",
    });
  // createExchangeOrder writes the replacement with no tax of its own.
  const exchangeLine = line({ price: 590, total: 590, tax_amount: 0 });

  it("routes it to store credit when the order has a customer", async () => {
    seedRows({ order: exchangeOrder("cust-1"), items: [exchangeLine] });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.refundRoute).toMatchObject({
      method: "store_credit",
      counterChoice: false,
      affectsDrawer: false,
    });
    expect(sale?.refundTenders).toEqual([
      { method: "store_credit", amount: 590, reference: null },
    ]);
  });

  it("★★ REFUSES cash for it server-side, even when the client asks", async () => {
    for (const asked of ["cash", "card", "upi"] as const) {
      vi.mocked(issueRefund).mockClear();
      seedRows({ order: exchangeOrder("cust-1"), items: [exchangeLine] });
      const r = await processReturn(
        "o1",
        [{ orderItemId: "li-a", quantity: 1 }],
        asked,
      );
      expect(r.error).toContain("original source");
      expect(issueRefund).not.toHaveBeenCalled();
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    }
  });

  it("sends it back as store credit through the shared core", async () => {
    seedRows({ order: exchangeOrder("cust-1"), items: [exchangeLine] });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "store_credit",
    );
    expect(r.error).toBeUndefined();
    expect(issueRefund).toHaveBeenCalledTimes(1);
    expect(vi.mocked(issueRefund).mock.calls[0][0]).toMatchObject({
      method: "store_credit",
      amount: 590,
      shiftId: null,
    });
  });

  it("★ with no customer to credit, takes the goods back and moves NO money", async () => {
    seedRows({
      order: exchangeOrder(null),
      items: [exchangeLine],
      existingRefunds: null,
    });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.refundRoute.method).toBe("none");
    expect(sale?.refundTenders).toEqual([]);

    seedRows({
      order: exchangeOrder(null),
      items: [exchangeLine],
      existingRefunds: null,
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "none",
    );
    expect(r.error).toBeUndefined();
    expect(r.returnId).toBe("ret-1");
    expect(r.refunded).toBe(0);
    expect(r.note).toContain("dashboard");
    expect(issueRefund).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.refund_issued" }),
    );
  });

  it("★ and refuses cash there too", async () => {
    seedRows({
      order: exchangeOrder(null),
      items: [exchangeLine],
      existingRefunds: null,
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toContain("original source");
    expect(issueRefund).not.toHaveBeenCalled();
  });
});

describe("★★ fix 3 — an online order part-paid with store credit", () => {
  /** ₹2,360 of goods: ₹1,000 store credit, ₹1,360 on Razorpay, no tender rows. */
  const creditOrder = (customerId: string | null) =>
    baseOrder({
      receipt_no: null,
      total: 2360,
      store_credit_used: 1000,
      customer_id: customerId,
      payment_method: "razorpay",
      location_id: null,
      sales_channel: "online",
      status: "delivered",
      delivered_at: "2026-08-28T10:00:00Z",
    });
  const twoUnits = line({ quantity: 2, total: 2360, tax_amount: 360 });

  it("★★ builds TWO legs — the money method and store credit", async () => {
    seedRows({
      order: { ...creditOrder("cust-1"), tax_inclusive: true },
      items: [twoUnits],
    });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.refundRoute).toMatchObject({
      method: "original",
      counterChoice: false,
      affectsDrawer: false,
    });
    expect(sale?.refundTenders).toEqual([
      { method: "razorpay", amount: 1360, reference: null },
      { method: "store_credit", amount: 1000, reference: null },
    ]);
  });

  it("★★ a FULL return sends each share back to where it came from", async () => {
    seedRows({
      order: { ...creditOrder("cust-1"), tax_inclusive: true },
      items: [twoUnits],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 2 }],
      "original",
    );
    expect(r.error).toBeUndefined();
    expect(
      vi.mocked(issueRefund).mock.calls.map(([i]) => [i.method, i.amount]),
    ).toEqual([
      ["razorpay", 1360],
      ["store_credit", 1000],
    ]);
  });

  it("★ a PARTIAL return splits proportionally — credit never reaches the card", async () => {
    seedRows({
      order: { ...creditOrder("cust-1"), tax_inclusive: true },
      items: [twoUnits],
    });
    await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "original",
    );
    // ₹1,180 back: 1360/2360 of it to the card, the rest to credit.
    expect(
      vi.mocked(issueRefund).mock.calls.map(([i]) => [i.method, i.amount]),
    ).toEqual([
      ["razorpay", 680],
      ["store_credit", 500],
    ]);
  });

  it("★ with no customer, offers only the money leg, capped at what money paid", async () => {
    seedRows({
      order: { ...creditOrder(null), tax_inclusive: true },
      items: [twoUnits],
    });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.refundRoute.method).toBe("razorpay");
    expect(sale?.refundTenders).toEqual([
      { method: "razorpay", amount: 1360, reference: null },
    ]);
  });

  it("★★ refuses BEFORE writing when the card leg would exceed what money paid", async () => {
    // It used to save the return, restock, then have issueRefund refuse the
    // card leg — goods back, customer paid nothing.
    seedRows({
      order: { ...creditOrder(null), tax_inclusive: true },
      items: [twoUnits],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 2 }],
      "razorpay",
    );
    expect(r.error).toMatch(/at most ₹1360\.00/);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(issueRefund).not.toHaveBeenCalled();
  });

  it("allows a partial return the money leg CAN carry", async () => {
    seedRows({
      order: { ...creditOrder(null), tax_inclusive: true },
      items: [twoUnits],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    expect(r.error).toBeUndefined();
    expect(vi.mocked(issueRefund).mock.calls[0][0]).toMatchObject({
      method: "razorpay",
      amount: 1180,
    });
  });

  it("★ the in-lock cap now covers a pure gateway route too", async () => {
    // ₹1,000 has already gone back to the card, so of the ₹1,360 money paid
    // only ₹360 is left. A ₹1,180 card leg used to pass this point (the check
    // skipped Razorpay) and be refused by issueRefund AFTER the write.
    seedRows({
      order: { ...creditOrder(null), tax_inclusive: true },
      items: [twoUnits],
      existingRefunds: [
        { amount: 1000, status: "completed", method: "razorpay" },
      ],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    expect(r.error).toMatch(/at most ₹360\.00/);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(issueRefund).not.toHaveBeenCalled();
  });
});

describe("★★ fix 4 — only SETTLED money is announced", () => {
  const splitRows = [
    { method: "cash", amount: 62.5, change_due: 0, reference: null },
    { method: "card", amount: 200, change_due: null, reference: "T-1" },
  ];

  it("★★ counts a completed leg and NOT a pending one", async () => {
    seedSale({ paymentRows: splitRows });
    vi.mocked(issueRefund)
      .mockResolvedValueOnce({
        refundId: "rf-1",
        status: "completed",
        amount: 25,
      } as any)
      .mockResolvedValueOnce({
        refundId: "rf-2",
        status: "pending",
        amount: 80,
        pendingReconcile: true,
      } as any);
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "original",
    );
    expect(r.refunded).toBe(25);
    expect(r.note).toContain("Do not send it a second time");
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "order.refund_issued",
        payload: expect.objectContaining({ amount: 25, paymentMethod: "cash" }),
      }),
    );
    const audit = vi
      .mocked(posAudit)
      .mock.calls.find(([e]) => e.event === "refund_issued");
    expect(audit?.[0].amount).toBe(25);
  });

  it("★★ announces NOTHING when no leg settled", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    vi.mocked(issueRefund).mockResolvedValueOnce({
      refundId: "rf-1",
      status: "pending",
      pendingReconcile: true,
    } as any);
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    // The return itself still stands — the goods came back.
    expect(r.returnId).toBeTruthy();
    expect(r.refunded).toBe(0);
    expect(r.note).toContain("Do not send it a second time");
    expect(emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.refund_issued" }),
    );
    expect(
      vi.mocked(posAudit).mock.calls.some(([e]) => e.event === "refund_issued"),
    ).toBe(false);
  });

  it("★ a leg the bank answered FAILED is not money that went back", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    vi.mocked(issueRefund).mockResolvedValueOnce({
      refundId: "rf-1",
      status: "failed",
      amount: 105,
    } as any);
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    expect(r.refunded).toBe(0);
    expect(r.note).toContain("didn't go through");
    expect(emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.refund_issued" }),
    );
  });

  it("a refused leg is a note, never part of the amount", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    vi.mocked(issueRefund).mockResolvedValueOnce({
      error: "Razorpay refused it.",
      code: "gateway_failed",
    } as any);
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    expect(r.refunded).toBe(0);
    expect(r.note).toContain("needs attention");
    expect(emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.refund_issued" }),
    );
  });
});

describe("★★ fix 5 — cash refunds obey pos.requireOpenShift", () => {
  it("★★ refuses cash with no open shift, BEFORE anything is written", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValueOnce(null);
    vi.mocked(getStoreSettings).mockResolvedValueOnce({
      "pos.requireOpenShift": true,
    } as any);
    seedSale();
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toBe("Open a shift before giving cash back.");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(issueRefund).not.toHaveBeenCalled();
  });

  it("★ refuses a split that would take cash out of the drawer", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValueOnce(null);
    vi.mocked(getStoreSettings).mockResolvedValueOnce({
      "pos.requireOpenShift": true,
    } as any);
    seedSale({
      paymentRows: [
        { method: "cash", amount: 62.5, change_due: 0, reference: null },
        { method: "card", amount: 200, change_due: null, reference: "T-1" },
      ],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "original",
    );
    expect(r.error).toContain("Open a shift");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ leaves a non-cash refund alone — it never touches the drawer", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValueOnce(null);
    vi.mocked(getStoreSettings).mockResolvedValue({
      "pos.requireOpenShift": true,
    } as any);
    seedSale({
      paymentRows: [
        { method: "card", amount: 262.5, change_due: null, reference: "T-1" },
      ],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "card",
    );
    expect(r.error).toBeUndefined();
    // The setting is not even consulted for a refund that pays no cash.
    expect(getStoreSettings).not.toHaveBeenCalled();
  });

  it("pays cash with no shift when the setting is OFF", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValueOnce(null);
    vi.mocked(getStoreSettings).mockResolvedValueOnce({
      "pos.requireOpenShift": false,
    } as any);
    seedSale();
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toBeUndefined();
    expect(vi.mocked(issueRefund).mock.calls[0][0].shiftId).toBeNull();
  });

  it("fails OPEN when the setting cannot be read", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValueOnce(null);
    vi.mocked(getStoreSettings).mockRejectedValueOnce(new Error("blip"));
    seedSale();
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toBeUndefined();
  });

  it("an open shift is never refused", async () => {
    vi.mocked(getStoreSettings).mockResolvedValue({
      "pos.requireOpenShift": true,
    } as any);
    seedSale();
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toBeUndefined();
    expect(vi.mocked(issueRefund).mock.calls[0][0].shiftId).toBe("shift-1");
  });
});

describe("★★ fix 6 — a return attempt is recorded once", () => {
  const KEY = "3f2c9a1e-8b7d-4c6e-9f10-2a3b4c5d6e7f";
  const items = [line({ quantity: 2, price: 100, total: 200, tax_amount: 10 })];

  it("★ refuses a malformed key before reading anything", async () => {
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
      undefined,
      { idempotencyKey: "bad key" },
    );
    expect(r.error).toContain("couldn't be sent safely");
    expect(dbHolder.current.calls.select).toHaveLength(0);
    expect(gateCustomerVerification).not.toHaveBeenCalled();
  });

  it("stores the key on the new return", async () => {
    seedRows({ order: baseOrder({ total: 210 }), items, keyLookup: [] });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
      undefined,
      { idempotencyKey: KEY },
    );
    expect(r.error).toBeUndefined();
    expect(r.alreadyRecorded).toBeUndefined();
    expect(dbHolder.current.calls.values[0].idempotencyKey).toBe(KEY);
  });

  it("an older till sends no key — no lookup, a null key, as before", async () => {
    seedSale();
    await processReturn("o1", [{ orderItemId: "li-a", quantity: 1 }], "cash");
    expect(dbHolder.current.calls.values[0].idempotencyKey).toBeNull();
  });

  it("★★ a RETRY answers with the first return and books nothing new", async () => {
    // The first submission committed `ret-first` and refunded ₹105; its
    // response was lost. The retry carries the same key, stops at the lookup
    // (the rest of the transaction never runs), and alreadyRecordedReturn
    // reads the stored return and its refunds.
    dbHolder.current = makeDbMock({
      selectQueue: [
        [baseOrder({ total: 210 })],
        items,
        [],
        [],
        [baseOrder({ total: 210 })],
        [{ id: "ret-first" }],
        [{ id: "ret-first", order_id: "o1" }],
        [{ amount: 105, status: "completed" }],
      ],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
      undefined,
      { idempotencyKey: KEY },
    );
    expect(r).toMatchObject({
      returnId: "ret-first",
      refunded: 105,
      alreadyRecorded: true,
    });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(issueRefund).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
    expect(posAudit).not.toHaveBeenCalled();
  });

  it("★ answers even a FULL return's retry, instead of 'nothing returnable'", async () => {
    // Everything already came back on the first submission.
    dbHolder.current = makeDbMock({
      selectQueue: [
        [baseOrder({ total: 210 })],
        items,
        [{ order_item_id: "li-a", qty: 2 }],
        [],
        [baseOrder({ total: 210 })],
        [{ id: "ret-first" }],
        [{ id: "ret-first", order_id: "o1" }],
        [{ amount: 210, status: "completed" }],
      ],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 2 }],
      "cash",
      undefined,
      { idempotencyKey: KEY },
    );
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ returnId: "ret-first", alreadyRecorded: true });
  });

  it("★ refuses a key reused on a DIFFERENT order", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [baseOrder({ total: 210 })],
        items,
        [],
        [],
        [baseOrder({ total: 210 })],
        [{ id: "ret-elsewhere" }],
        [{ id: "ret-elsewhere", order_id: "o-other" }],
      ],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
      undefined,
      { idempotencyKey: KEY },
    );
    expect(r.error).toContain("couldn't be sent safely");
    expect(r.returnId).toBeUndefined();
    expect(issueRefund).not.toHaveBeenCalled();
  });

  it("★★ maps a unique-key RACE on insert to 'already recorded'", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [baseOrder({ total: 210 })],
        items,
        [],
        [],
        [baseOrder({ total: 210 })],
        [], // the lookup saw nothing — the other submission had not committed
        items,
        [],
        [], // recorded refunds (cap)
        // alreadyRecordedReturn, after the violation:
        [{ id: "ret-winner", order_id: "o1" }],
        [],
      ],
    });
    const db = dbHolder.current.db;
    const realInsert = db.insert;
    db.insert = vi.fn((table: any) => {
      if (table !== orderReturns) return realInsert(table);
      return {
        values: () => ({
          returning: () =>
            Promise.reject(
              Object.assign(new Error("duplicate key"), { code: "23505" }),
            ),
        }),
      };
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
      undefined,
      { idempotencyKey: KEY },
    );
    expect(r).toMatchObject({
      returnId: "ret-winner",
      alreadyRecorded: true,
      refunded: 0,
    });
    expect(issueRefund).not.toHaveBeenCalled();
  });

  it("a unique violation with NO key is still an ordinary error", async () => {
    seedSale();
    const db = dbHolder.current.db;
    db.insert = vi.fn(() => ({
      values: () => ({
        returning: () =>
          Promise.reject(
            Object.assign(new Error("duplicate key"), { code: "23505" }),
          ),
      }),
    }));
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toBeDefined();
    expect(r.alreadyRecorded).toBeUndefined();
  });
});
