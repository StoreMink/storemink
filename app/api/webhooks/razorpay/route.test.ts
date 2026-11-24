/* eslint-disable @typescript-eslint/no-explicit-any */
// StoreMink's own Razorpay webhook: verified, deduplicated, and acting only on
// payment.captured and payment.failed (21 Nov 2026).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/billing/webhook", () => ({
  applyBillingPaymentEvent: vi.fn(async () => "settled"),
}));
vi.mock("@/lib/ai/credit-purchase", () => ({
  settleCreditPurchaseByOrder: vi.fn(async () => "settled"),
}));

import { POST } from "./route";
import { applyBillingPaymentEvent } from "@/lib/billing/webhook";
import { settleCreditPurchaseByOrder } from "@/lib/ai/credit-purchase";
import { withService } from "@/lib/db/client";

const SECRET = "whsec_platform";

function post(body: unknown, opts: { sign?: boolean; eventId?: string } = {}) {
  const raw = JSON.stringify(body);
  const signature =
    opts.sign === false
      ? "nope"
      : createHmac("sha256", SECRET).update(raw).digest("hex");
  return POST(
    new Request("https://storemink.com/api/webhooks/razorpay", {
      method: "POST",
      body: raw,
      headers: {
        "x-razorpay-signature": signature,
        "x-razorpay-event-id": opts.eventId ?? "evt_1",
      },
    }),
  );
}

const paymentEvent = (event: string, over: Record<string, unknown> = {}) => ({
  event,
  created_at: 1,
  payload: {
    payment: {
      entity: {
        id: "pay_1",
        order_id: "order_1",
        amount: 240000,
        currency: "INR",
        ...over,
      },
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
  dbHolder.current = makeDbMock();
  vi.mocked(withService).mockImplementation((fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  );
});
afterEach(() => {
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
});

describe("authorisation", () => {
  it("★★ a bad signature is refused and nothing is applied", async () => {
    const res = await post(paymentEvent("payment.captured"), { sign: false });
    expect(res.status).toBe(401);
    expect(applyBillingPaymentEvent).not.toHaveBeenCalled();
  });

  it("500 with no secret configured, so Razorpay retries", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    expect((await post(paymentEvent("payment.captured"))).status).toBe(500);
    expect(applyBillingPaymentEvent).not.toHaveBeenCalled();
  });
});

describe("the two events it acts on", () => {
  it("★★ payment.captured goes to the billing settle with the payment's own figures", async () => {
    const res = await post(paymentEvent("payment.captured"));
    expect(res.status).toBe(200);
    expect(applyBillingPaymentEvent).toHaveBeenCalledWith({
      result: "captured",
      providerOrderId: "order_1",
      providerPaymentId: "pay_1",
      amountPaise: 240000,
      currency: "INR",
      failureReason: null,
    });
    expect(await res.json()).toMatchObject({ ok: true, outcome: "settled" });
  });

  it("payment.failed carries the gateway's reason", async () => {
    await post(
      paymentEvent("payment.failed", { error_description: "Card declined" }),
    );
    expect(applyBillingPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "failed",
        failureReason: "Card declined",
      }),
    );
  });

  it("★ a payment with no order (not one of ours to settle) is not applied", async () => {
    await post(paymentEvent("payment.captured", { order_id: undefined }));
    expect(applyBillingPaymentEvent).not.toHaveBeenCalled();
  });

  it("★★ still 200 when applying failed: the hourly reconcile settles it", async () => {
    vi.mocked(applyBillingPaymentEvent).mockResolvedValueOnce("error");
    const res = await post(paymentEvent("payment.captured"));
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("error");
  });
});

describe("everything else is recorded and ignored", () => {
  it("★ a subscription event is never applied", async () => {
    const res = await post({
      event: "subscription.charged",
      created_at: 1,
      payload: { subscription: { entity: { id: "sub_1" } } },
    });
    expect(res.status).toBe(200);
    expect(applyBillingPaymentEvent).not.toHaveBeenCalled();
  });

  it("★★ a delivery seen before is acknowledged and NOT applied again", async () => {
    vi.mocked(withService).mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    );
    const res = await post(paymentEvent("payment.captured"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(applyBillingPaymentEvent).not.toHaveBeenCalled();
  });

  it("500 when the delivery could not be recorded, and nothing is applied", async () => {
    vi.mocked(withService).mockRejectedValueOnce(new Error("db down"));
    const res = await post(paymentEvent("payment.captured"));
    expect(res.status).toBe(500);
    expect(applyBillingPaymentEvent).not.toHaveBeenCalled();
  });
});

// 21 Nov 2026: a Mink credit pack has its own Razorpay order and no billing
// payment attempt, so the billing settle answers "unmatched" for it.
describe("★★ a captured payment that is a Mink credit pack", () => {
  it("is offered to the credit pack settle when no billing attempt owns it", async () => {
    vi.mocked(applyBillingPaymentEvent).mockResolvedValueOnce("unmatched");
    const res = await post(
      paymentEvent("payment.captured", { created_at: 1_790_000_000 }),
    );
    expect(settleCreditPurchaseByOrder).toHaveBeenCalledWith({
      providerOrderId: "order_1",
      providerPaymentId: "pay_1",
      amountPaise: 240000,
      currency: "INR",
      paidAtSeconds: 1_790_000_000,
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      outcome: "unmatched",
      credits: "settled",
    });
  });

  it("★ a payment a billing attempt owns never reaches it", async () => {
    await post(paymentEvent("payment.captured"));
    expect(settleCreditPurchaseByOrder).not.toHaveBeenCalled();
  });

  it("★ a FAILED payment grants nothing: only a capture is offered", async () => {
    vi.mocked(applyBillingPaymentEvent).mockResolvedValueOnce("unmatched");
    await post(paymentEvent("payment.failed"));
    expect(settleCreditPurchaseByOrder).not.toHaveBeenCalled();
  });

  it("still 200 when the settle could not run: the hourly pass settles it", async () => {
    vi.mocked(applyBillingPaymentEvent).mockResolvedValueOnce("unmatched");
    vi.mocked(settleCreditPurchaseByOrder).mockResolvedValueOnce("error");
    const res = await post(paymentEvent("payment.captured"));
    expect(res.status).toBe(200);
    expect((await res.json()).credits).toBe("error");
  });
});
