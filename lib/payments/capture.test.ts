import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./razorpay", async (importOriginal) => {
  const real = await importOriginal<typeof import("./razorpay")>();
  return {
    // The pure picker stays real: which payment counts as "captured" is the
    // thing under test, not something to stub.
    capturedPayment: real.capturedPayment,
    rzpCapturePayment: vi.fn(),
    rzpFetchOrderPayments: vi.fn(),
    rzpFetchPayment: vi.fn(),
  };
});
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { settleOrderPayment, verifyCallbackPayment } from "./capture";
import {
  rzpCapturePayment,
  rzpFetchOrderPayments,
  rzpFetchPayment,
} from "./razorpay";

const creds = { keyId: "rzp_live_x", keySecret: "s" };

function payment(over: Record<string, unknown> = {}) {
  return {
    id: "pay_1",
    order_id: "order_1",
    amount: 50000,
    currency: "INR",
    status: "captured",
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
    ok: true,
    data: [],
  } as never);
  vi.mocked(rzpFetchPayment).mockResolvedValue({
    ok: true,
    data: payment(),
  } as never);
  vi.mocked(rzpCapturePayment).mockResolvedValue({
    ok: true,
    data: payment(),
  } as never);
});

describe("settleOrderPayment", () => {
  it("reports a captured payment without capturing anything", async () => {
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [payment({ status: "failed", id: "pay_0" }), payment()],
    } as never);
    const res = await settleOrderPayment(creds, "order_1", 50000, {
      capture: true,
    });
    expect(res).toEqual({
      kind: "captured",
      paymentId: "pay_1",
      amountPaise: 50000,
    });
    expect(rzpCapturePayment).not.toHaveBeenCalled();
  });

  it("decides nothing when the gateway cannot be read", async () => {
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: false,
      error: "down",
      outcome: "unknown",
    } as never);
    const res = await settleOrderPayment(creds, "order_1", 50000, {
      capture: true,
    });
    expect(res).toEqual({ kind: "unknown" });
  });

  it("★★ captures an AUTHORIZED payment of the exact amount (manual-capture accounts)", async () => {
    // The bug this closes: on a manual-capture account the money is only
    // held, the order was marked paid, and Razorpay voided the hold.
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [payment({ status: "authorized" })],
    } as never);
    const res = await settleOrderPayment(creds, "order_1", 50000, {
      capture: true,
    });
    expect(rzpCapturePayment).toHaveBeenCalledWith(creds, "pay_1", 50000);
    expect(res).toEqual({
      kind: "captured",
      paymentId: "pay_1",
      amountPaise: 50000,
    });
  });

  it("★ never captures a hold on a dead order (capture: false)", async () => {
    // Leaving it lets Razorpay void the hold, which gives the money back.
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [payment({ status: "authorized" })],
    } as never);
    const res = await settleOrderPayment(creds, "order_1", 50000, {
      capture: false,
    });
    expect(res).toEqual({ kind: "none" });
    expect(rzpCapturePayment).not.toHaveBeenCalled();
  });

  it("★ refuses to capture an authorized payment for a different amount", async () => {
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [payment({ status: "authorized", amount: 100 })],
    } as never);
    const res = await settleOrderPayment(creds, "order_1", 50000, {
      capture: true,
    });
    expect(res).toEqual({ kind: "none" });
    expect(rzpCapturePayment).not.toHaveBeenCalled();
  });

  it("refuses to capture a non-INR authorization", async () => {
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [payment({ status: "authorized", currency: "USD" })],
    } as never);
    const res = await settleOrderPayment(creds, "order_1", 50000, {
      capture: true,
    });
    expect(res).toEqual({ kind: "none" });
  });

  it("★ a capture whose answer was lost is confirmed by re-reading", async () => {
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [payment({ status: "authorized" })],
    } as never);
    vi.mocked(rzpCapturePayment).mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    } as never);
    vi.mocked(rzpFetchPayment).mockResolvedValue({
      ok: true,
      data: payment({ status: "captured" }),
    } as never);
    const res = await settleOrderPayment(creds, "order_1", 50000, {
      capture: true,
    });
    expect(res.kind).toBe("captured");
  });

  it("★ a capture that cannot be confirmed is UNKNOWN, never `none`", async () => {
    // `none` would let the reaper cancel and restock an order whose money
    // may have been taken.
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [payment({ status: "authorized" })],
    } as never);
    vi.mocked(rzpCapturePayment).mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    } as never);
    vi.mocked(rzpFetchPayment).mockResolvedValue({
      ok: true,
      data: payment({ status: "authorized" }),
    } as never);
    const res = await settleOrderPayment(creds, "order_1", 50000, {
      capture: true,
    });
    expect(res).toEqual({ kind: "unknown" });
  });
});

describe("verifyCallbackPayment", () => {
  const input = {
    paymentId: "pay_1",
    rzpOrderId: "order_1",
    expectedPaise: 50000,
  };

  it("accepts a captured payment for this order and amount", async () => {
    expect(await verifyCallbackPayment(creds, input)).toEqual({
      ok: true,
      verified: true,
    });
  });

  it("★ falls back to the signature when the gateway cannot be read", async () => {
    vi.mocked(rzpFetchPayment).mockResolvedValue({
      ok: false,
      error: "down",
      outcome: "unknown",
    } as never);
    expect(await verifyCallbackPayment(creds, input)).toEqual({
      ok: true,
      verified: false,
    });
  });

  it("★ refuses a payment that belongs to a different order", async () => {
    vi.mocked(rzpFetchPayment).mockResolvedValue({
      ok: true,
      data: payment({ order_id: "order_other" }),
    } as never);
    const res = await verifyCallbackPayment(creds, input);
    expect(res.ok).toBe(false);
  });

  it("★ refuses a payment for a different amount", async () => {
    vi.mocked(rzpFetchPayment).mockResolvedValue({
      ok: true,
      data: payment({ amount: 100 }),
    } as never);
    const res = await verifyCallbackPayment(creds, input);
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toContain("amount");
  });

  it("refuses a non-INR payment", async () => {
    vi.mocked(rzpFetchPayment).mockResolvedValue({
      ok: true,
      data: payment({ currency: "USD" }),
    } as never);
    expect((await verifyCallbackPayment(creds, input)).ok).toBe(false);
  });

  it("★★ captures an authorized payment before calling it paid", async () => {
    vi.mocked(rzpFetchPayment).mockResolvedValue({
      ok: true,
      data: payment({ status: "authorized" }),
    } as never);
    const res = await verifyCallbackPayment(creds, input);
    expect(rzpCapturePayment).toHaveBeenCalledWith(creds, "pay_1", 50000);
    expect(res).toEqual({ ok: true, verified: true });
  });

  it("★ an authorization that will not capture is NOT marked paid", async () => {
    vi.mocked(rzpFetchPayment).mockResolvedValue({
      ok: true,
      data: payment({ status: "authorized" }),
    } as never);
    vi.mocked(rzpCapturePayment).mockResolvedValue({
      ok: false,
      error: "nope",
      outcome: "rejected",
    } as never);
    const res = await verifyCallbackPayment(creds, input);
    expect(res.ok).toBe(false);
    // The shopper is told not to pay again: the money may still land.
    expect((res as { error: string }).error).toContain("Don't pay again");
  });

  it("refuses a failed payment", async () => {
    vi.mocked(rzpFetchPayment).mockResolvedValue({
      ok: true,
      data: payment({ status: "failed" }),
    } as never);
    const res = await verifyCallbackPayment(creds, input);
    expect(res).toEqual({
      ok: false,
      error: "This payment didn't go through.",
    });
  });
});
