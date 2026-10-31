import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PLAN_IDS, PLAN_LIMITS } from "@/lib/plans";
import { PlanTag } from "@/app/dashboard/plan-tag";
import * as summary from "./upgrade-summary";
import { nextPlan, planHighlights, upgradeUnlocks } from "./upgrade-summary";

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
    expect(lines).not.toContain("POS");
    expect(lines).not.toContain("Your own domain");
    expect(PLAN_LIMITS.basic.customDomain).toBe(false);

    const toPro = upgradeUnlocks("basic", "pro");
    expect(toPro).toContain("Unlimited products");
    expect(toPro).toContain("POS");
    expect(toPro).toContain("Your own domain");
    expect(upgradeUnlocks("pro", "pro")).toEqual([]);
  });

  it("describes the current plan in the merchant's units", () => {
    expect(planHighlights("free")).toContain("5 products");
    expect(planHighlights("free")).toContain("Cash on Delivery checkout");
    expect(planHighlights("pro")).toContain("Unlimited products");
  });

  // ★ GST: the compiled PLAN_META price knows neither the operator's price nor
  // GST, so nothing here quotes one any more.
  it("quotes no price", () => {
    expect(Object.keys(summary)).not.toContain("planPriceLine");
    const lines = PLAN_IDS.flatMap((plan) => [
      ...planHighlights(plan),
      ...PLAN_IDS.flatMap((to) => upgradeUnlocks(plan, to)),
    ]);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/₹|\/month/);
  });
});

describe("the dashboard plan tag", () => {
  const titleOf = (html: string) => /title="([^"]*)"/.exec(html)?.[1] ?? null;

  it("names the next plan and what it unlocks, with no price", () => {
    const html = renderToStaticMarkup(
      createElement(PlanTag, { plan: "basic" }),
    );
    expect(html).toContain("You&#x27;re on the Basic plan");
    const title = titleOf(html);
    expect(title).toBe(
      `Pro: ${upgradeUnlocks("basic", "pro").slice(0, 4).join(", ")}`,
    );
    expect(title).not.toMatch(/₹|\/month|·/);
  });

  it("has no way up on the top plan", () => {
    const html = renderToStaticMarkup(createElement(PlanTag, { plan: "pro" }));
    expect(html).toContain("You&#x27;re on the Pro plan");
    expect(html).not.toContain("Upgrade");
    expect(titleOf(html)).toBeNull();
  });
});
