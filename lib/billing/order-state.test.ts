// "Nobody has paid this order": the one rule that lets an unfinished checkout
// be freed (enrolment, a plan change) or reopened (a renewal paid by hand).
// Getting it wrong in the generous direction abandons, or reopens beside, an
// order somebody has already paid.

import { describe, it, expect, vi, beforeEach } from "vitest";

const rzp = vi.hoisted(() => ({ rzpFetchOrderPayments: vi.fn() }));
vi.mock("@/lib/payments/razorpay", () => rzp);

import { orderIsUntouched } from "./order-state";

const CREDS = { keyId: "rzp_1", keySecret: "secret" };
const order = (data: Record<string, unknown>) => ({
  ok: true as const,
  data: {
    id: "order_1",
    amount: 500_000,
    currency: "INR",
    receipt: null,
    status: "created",
    ...data,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  rzp.rzpFetchOrderPayments.mockResolvedValue({ ok: true, data: [] });
});

describe("orderIsUntouched", () => {
  it("★ created with no attempts: untouched, and nothing more is asked", async () => {
    expect(await orderIsUntouched(CREDS, order({ attempts: 0 }))).toBe(true);
    expect(rzp.rzpFetchOrderPayments).not.toHaveBeenCalled();
  });

  it("★★ an order that could not be read is never untouched", async () => {
    expect(
      await orderIsUntouched(CREDS, {
        ok: false,
        outcome: "unknown",
        error: "timeout",
      }),
    ).toBe(false);
  });

  it("★★ anything paid on it: not untouched", async () => {
    expect(
      await orderIsUntouched(
        CREDS,
        order({ status: "paid", amount_paid: 500_000 }),
      ),
    ).toBe(false);
    expect(rzp.rzpFetchOrderPayments).not.toHaveBeenCalled();
  });

  it("★ tried, and every try FAILED: as safe as one nobody opened", async () => {
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [{ status: "failed" }, { status: "failed" }],
    });
    expect(
      await orderIsUntouched(
        CREDS,
        order({ status: "attempted", attempts: 2 }),
      ),
    ).toBe(true);
    expect(rzp.rzpFetchOrderPayments).toHaveBeenCalledWith(CREDS, "order_1");
  });

  it.each(["created", "authorized", "captured"])(
    "★★ a payment that is %s: not untouched",
    async (status) => {
      rzp.rzpFetchOrderPayments.mockResolvedValue({
        ok: true,
        data: [{ status: "failed" }, { status }],
      });
      expect(
        await orderIsUntouched(
          CREDS,
          order({ status: "attempted", attempts: 2 }),
        ),
      ).toBe(false);
    },
  );

  it("★★ payments that could not be read: not untouched", async () => {
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: false,
      outcome: "unknown",
      error: "timeout",
    });
    expect(
      await orderIsUntouched(
        CREDS,
        order({ status: "attempted", attempts: 1 }),
      ),
    ).toBe(false);
  });
});
