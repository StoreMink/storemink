import { describe, it, expect } from "vitest";
import {
  exchangeSettlement,
  isExchange,
  returnRequestSettlement,
} from "./exchange";

describe("exchangeSettlement", () => {
  it("★ an even swap settles to nothing — the 80% case", () => {
    // Medium for large, same price. No money moves in either direction, which
    // is exactly why this is the case worth making effortless.
    const s = exchangeSettlement({ returnValue: 500, replacementValue: 500 });
    expect(s.even).toBe(true);
    expect(s.storeOwes).toBe(0);
    expect(s.customerOwes).toBe(0);
    expect(s.allowed).toBe(true);
  });

  it("the store owes the difference on a cheaper replacement", () => {
    const s = exchangeSettlement({ returnValue: 500, replacementValue: 350 });
    expect(s.storeOwes).toBe(150);
    expect(s.customerOwes).toBe(0);
    expect(s.even).toBe(false);
    expect(s.allowed).toBe(true);
  });

  it("★ REFUSES a dearer replacement, with a sentence that says what to do", () => {
    // Collecting the difference is a payment flow that doesn't exist outside
    // checkout. Half-building it leaves replacement orders unpaid forever.
    const s = exchangeSettlement({ returnValue: 500, replacementValue: 800 });
    expect(s.customerOwes).toBe(300);
    expect(s.allowed).toBe(false);
    expect(s.blockedCopy).toContain("300.00");
    expect(s.blockedCopy).toContain("new order");
  });

  it("★ still COMPUTES what's owed even when it refuses", () => {
    // The day a payment-link flow exists, this is the number to charge — the
    // arithmetic is the boundary, not a flag that hides it.
    expect(
      exchangeSettlement({ returnValue: 100, replacementValue: 250 })
        .customerOwes,
    ).toBe(150);
  });

  it("works in paise, so a rupee of float drift can't flip 'even'", () => {
    const s = exchangeSettlement({
      returnValue: 0.1 + 0.2, // 0.30000000000000004
      replacementValue: 0.3,
    });
    expect(s.even).toBe(true);
    expect(s.allowed).toBe(true);
  });

  it("treats a free replacement as the store owing everything", () => {
    const s = exchangeSettlement({ returnValue: 500, replacementValue: 0 });
    expect(s.storeOwes).toBe(500);
    expect(s.allowed).toBe(true);
  });

  it("never produces a negative anything from junk input", () => {
    const s = exchangeSettlement({
      returnValue: -100,
      replacementValue: Number.NaN,
    });
    expect(s.returnValue).toBe(0);
    expect(s.replacementValue).toBe(0);
    expect(s.storeOwes).toBe(0);
    expect(s.customerOwes).toBe(0);
  });
});

describe("isExchange", () => {
  it("is true when any line asks for a swap", () => {
    expect(
      isExchange([
        { orderItemId: "a", quantity: 1 },
        { orderItemId: "b", quantity: 1, exchangeVariantId: "v2" },
      ]),
    ).toBe(true);
  });

  it("is false for a plain refund request", () => {
    expect(
      isExchange([
        { orderItemId: "a", quantity: 1 },
        { orderItemId: "b", quantity: 2, exchangeVariantId: null },
      ]),
    ).toBe(false);
  });

  it("counts a product-level swap too", () => {
    expect(
      isExchange([{ orderItemId: "a", quantity: 1, exchangeProductId: "p9" }]),
    ).toBe(true);
  });
});

// ★★ A MIXED RETURN SETTLES EACH HALF ON ITS OWN TERMS.
//
// Refunded lines owe everything paid for them, tax included; swapped lines owe
// only what the replacement costs less than them. The old single formula
// compared the GOODS value of every line against the replacements, so a
// refunded line lost its tax whenever anything else in the request was swapped.
describe("★★ returnRequestSettlement", () => {
  // Line A: ₹1,000 + ₹180 tax. Line B: ₹500 + ₹90 tax. Exclusive pricing.
  const A = { id: "a", amount: 1000, tax: 180, total: 1180 };
  const B = { id: "b", amount: 500, tax: 90, total: 590 };

  it("★★ a refunded line keeps its tax beside an EVEN swap", () => {
    const r = returnRequestSettlement({
      lines: [A, B],
      replacementValueByLine: new Map([["b", 500]]),
    });
    expect(r.swapping).toBe(true);
    expect(r.settlement.even).toBe(true);
    // Was ₹1,000: the old formula dropped line A's ₹180 of tax.
    expect(r.owed).toBe(1180);
    expect(r.refundedTotal).toBe(1180);
  });

  it("adds a cheaper swap's difference on top of the refunded line", () => {
    const r = returnRequestSettlement({
      lines: [A, B],
      replacementValueByLine: new Map([["b", 400]]),
    });
    expect(r.settlement.storeOwes).toBe(100);
    expect(r.owed).toBe(1280);
  });

  it("★ judges 'a replacement may not cost more' on the SWAPPED lines alone", () => {
    // Line A's refund would 'cover' a ₹200 upgrade on B — but nobody priced
    // that upgrade, and max(0, …) would give it away. Refused instead.
    const r = returnRequestSettlement({
      lines: [A, B],
      replacementValueByLine: new Map([["b", 700]]),
    });
    expect(r.settlement.allowed).toBe(false);
    expect(r.settlement.customerOwes).toBe(200);
    expect(r.settlement.blockedCopy).toContain("new order");
  });

  it("a plain return owes every line's total, as it always did", () => {
    const r = returnRequestSettlement({
      lines: [A, B],
      replacementValueByLine: new Map(),
    });
    expect(r.swapping).toBe(false);
    expect(r.owed).toBe(1770);
    // A refund-only request has nothing to refuse.
    expect(r.settlement.allowed).toBe(true);
  });

  it("an all-swap request owes only the swap difference", () => {
    const r = returnRequestSettlement({
      lines: [B],
      replacementValueByLine: new Map([["b", 450]]),
    });
    expect(r.owed).toBe(50);
  });

  it("takes the fees off, and never goes below zero", () => {
    const withFee = returnRequestSettlement({
      lines: [A, B],
      replacementValueByLine: new Map([["b", 500]]),
      deduction: 100,
    });
    expect(withFee.owed).toBe(1080);

    const evenSwapWithFee = returnRequestSettlement({
      lines: [B],
      replacementValueByLine: new Map([["b", 500]]),
      deduction: 50,
    });
    expect(evenSwapWithFee.owed).toBe(0);
  });

  it("★ a tax-INCLUSIVE store compares the swap on its inclusive price", () => {
    // ₹590 shelf price, tax inside it. A same-price swap is EVEN — comparing
    // the ₹500 goods value against a ₹590 shelf price would refuse it for
    // 'costing ₹90 more', on every like-for-like swap in the store.
    const inclusiveB = { id: "b", amount: 500, tax: 90, total: 590 };
    const inclusive = returnRequestSettlement({
      lines: [inclusiveB],
      replacementValueByLine: new Map([["b", 590]]),
      taxInclusive: true,
    });
    expect(inclusive.settlement.allowed).toBe(true);
    expect(inclusive.settlement.even).toBe(true);
    expect(inclusive.owed).toBe(0);

    const exclusiveBasis = returnRequestSettlement({
      lines: [inclusiveB],
      replacementValueByLine: new Map([["b", 590]]),
    });
    expect(exclusiveBasis.settlement.allowed).toBe(false);
  });

  it("a null replacement means the line is refunded, not swapped for nothing", () => {
    const r = returnRequestSettlement({
      lines: [A],
      replacementValueByLine: new Map([["a", null]]),
    });
    expect(r.swapping).toBe(false);
    expect(r.owed).toBe(1180);
  });
});
