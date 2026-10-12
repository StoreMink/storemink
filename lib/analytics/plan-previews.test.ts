import { describe, expect, it } from "vitest";
import { DEFAULT_ANALYTICS_FEATURE_SETTINGS } from "./features";
import {
  lockedPreviewIds,
  planPreviewData,
  previewHiddenCookie,
  rangePhrase,
} from "./plan-previews";

const allOn = {
  ...DEFAULT_ANALYTICS_FEATURE_SETTINGS,
  googleSearchConsole: true,
  grossMargin: true,
  storefrontConversion: true,
};

describe("analytics plan previews", () => {
  it("previews what the plan lacks, never what it already has", () => {
    const none = new Set<never>();
    expect(
      lockedPreviewIds({ plan: "free", platform: allOn, hidden: none }),
    ).toEqual(["profit", "google-search", "storefront-traffic"]);
    expect(
      lockedPreviewIds({ plan: "basic", platform: allOn, hidden: none }),
    ).toEqual(["profit", "storefront-traffic"]);
    expect(
      lockedPreviewIds({ plan: "pro", platform: allOn, hidden: none }),
    ).toEqual([]);
  });

  it("never sells a module StoreMink has switched off", () => {
    expect(
      lockedPreviewIds({
        plan: "free",
        platform: { ...allOn, grossMargin: false, storefrontConversion: false },
        hidden: new Set(),
      }),
    ).toEqual(["google-search"]);
  });

  it("leaves out a preview the merchant hid", () => {
    expect(
      lockedPreviewIds({
        plan: "basic",
        platform: allOn,
        hidden: new Set(["profit"] as const),
      }),
    ).toEqual(["storefront-traffic"]);
    expect(previewHiddenCookie("storefront-traffic")).toBe(
      "sm_an_preview_hidden_storefront_traffic",
    );
  });

  it("headlines the store's own numbers when it has them", () => {
    const phrase = rangePhrase("30d", "ignored");
    expect(
      planPreviewData("google-search", {
        canUpgrade: true,
        phrase,
        search: { impressions: 1240, clicks: 37 },
      }).headline,
    ).toBe(
      "Google showed your store 1,240 times in the last 30 days, and shoppers clicked through 37 times.",
    );
    expect(
      planPreviewData("profit", { canUpgrade: true, phrase, sales: 48200 })
        .headline,
    ).toBe(
      "You sold ₹48,200 in the last 30 days. See how much of it was profit.",
    );
  });

  it("falls back to a general line instead of inventing a number", () => {
    const phrase = rangePhrase("custom", "1 Aug 2026 – 18 Aug 2026");
    expect(phrase).toBe("from 1 Aug 2026 – 18 Aug 2026");
    expect(
      planPreviewData("google-search", { canUpgrade: false, phrase }).headline,
    ).toBe("See how shoppers find your store on Google.");
    expect(
      planPreviewData("profit", { canUpgrade: false, phrase, sales: 0 })
        .headline,
    ).toBe("Know your profit, not just your sales.");
  });
});
