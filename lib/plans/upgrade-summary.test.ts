import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "@/lib/plans";
import {
  nextPlan,
  planHighlights,
  planPriceLine,
  upgradeUnlocks,
} from "./upgrade-summary";

describe("upgrade summary", () => {
  it("walks the plan ladder", () => {
    expect(nextPlan("free")).toBe("basic");
    expect(nextPlan("basic")).toBe("pro");
    expect(nextPlan("pro")).toBeNull();
  });

  it("★ derives every unlock from PLAN_LIMITS, so it cannot promise what enforcement withholds", () => {
    const lines = upgradeUnlocks("free", "basic");
    expect(lines).toContain("50 products");
    expect(lines).toContain("Online payments through your own Razorpay");
    // Pro-only features are NOT advertised for Basic.
    expect(lines).not.toContain("Point of Sale");
    expect(lines).not.toContain("Your own domain");
    expect(PLAN_LIMITS.basic.customDomain).toBe(false);

    const toPro = upgradeUnlocks("basic", "pro");
    expect(toPro).toContain("Unlimited products");
    expect(toPro).toContain("Point of Sale");
    expect(toPro).toContain("Your own domain");
    expect(upgradeUnlocks("pro", "pro")).toEqual([]);
  });

  it("describes the current plan in the merchant's units", () => {
    expect(planHighlights("free")).toContain("5 products");
    expect(planHighlights("free")).toContain("Cash on Delivery checkout");
    expect(planHighlights("pro")).toContain("Unlimited products");
    expect(planPriceLine("free")).toBe("₹0/month");
    expect(planPriceLine("basic")).toBe("₹1,500/month");
  });
});
