import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/plans/pricing", () => ({ getPlanPricingLive: vi.fn() }));
vi.mock("@/lib/billing/platform-settings", () => ({
  getTaxTermsLive: vi.fn(),
}));
vi.mock("@/lib/payments/provider", () => ({
  getPlatformRazorpayCreds: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { getPlanPricingLive } from "@/lib/plans/pricing";
import { getTaxTermsLive } from "@/lib/billing/platform-settings";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import { logError } from "@/lib/observability/logger";
import { parseSignupPlanQuote } from "@/lib/plans/signup-quote";
import { GET } from "./route";

const PRICING = {
  free: {
    monthlyInr: 0,
    yearlyInr: 0,
    baseMonthlyInr: null,
    baseYearlyInr: null,
  },
  basic: {
    monthlyInr: 1500,
    yearlyInr: 15000,
    baseMonthlyInr: 2000,
    baseYearlyInr: 20000,
  },
  pro: {
    monthlyInr: 2400,
    yearlyInr: 24000,
    baseMonthlyInr: 5000,
    baseYearlyInr: 50000,
  },
};

const NO_GST = { active: false, inclusive: false, rateBps: 0, upcoming: null };
const GST_ADDED = {
  active: true,
  inclusive: false,
  rateBps: 1800,
  upcoming: null,
};

describe("GET /api/plans/pricing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTaxTermsLive).mockResolvedValue(NO_GST);
  });

  it("returns the uncached operator-managed quote, the live GST terms and whether a card can be taken", async () => {
    vi.mocked(getPlanPricingLive).mockResolvedValue(PRICING);
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue({
      keyId: "rzp_test",
      keySecret: "secret",
    });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      plans: PRICING,
      paidCheckout: true,
      tax: NO_GST,
    });
  });

  it("★ carries the GST terms in force now, read live, and the step can read them", async () => {
    vi.mocked(getPlanPricingLive).mockResolvedValue(PRICING);
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null);
    vi.mocked(getTaxTermsLive).mockResolvedValue(GST_ADDED);
    const body = await (await GET()).json();
    expect(getTaxTermsLive).toHaveBeenCalledTimes(1);
    expect(body.tax).toEqual(GST_ADDED);
    expect(parseSignupPlanQuote(body)?.tax).toEqual(GST_ADDED);
  });

  it("★ says paid checkout is off when the platform has no Razorpay keys", async () => {
    vi.mocked(getPlanPricingLive).mockResolvedValue(PRICING);
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null);
    const body = await (await GET()).json();
    expect(body.paidCheckout).toBe(false);
    // The keys themselves never leave the server.
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("fails closed instead of quoting compiled defaults when the DB is down", async () => {
    vi.mocked(getPlanPricingLive).mockRejectedValue(new Error("offline"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Current plan pricing is temporarily unavailable.",
    });
  });

  it("★ a GST read that fails is a 503 too, never a guessed 'no GST'", async () => {
    vi.mocked(getPlanPricingLive).mockResolvedValue(PRICING);
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null);
    vi.mocked(getTaxTermsLive).mockRejectedValue(new Error("offline"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Current plan pricing is temporarily unavailable.",
    });
    expect(logError).toHaveBeenCalledWith(
      "signup pricing: live read failed",
      expect.any(Error),
    );
  });
});
