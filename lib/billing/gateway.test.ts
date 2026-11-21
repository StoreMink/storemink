/* eslint-disable @typescript-eslint/no-explicit-any */
// The gateway seam of an automatic renewal (rebuilt 21 Nov 2026).
//
// Razorpay accepts a renewal debit only for an order created with a pre-debit
// notification, and only once the notice period has passed since the notice
// was delivered. So the seam is four questions: is the mandate chargeable
// (`checkMandate`), create the notified order (`notify`), has the period
// passed (`readNotice`), and send the debit (`debit`).
//
// Almost every test here is about which failures are decisions (`rejected`:
// nothing happened) and which are missing information (`unknown`), because a
// rejection ends a try and an unknown must never be retried.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logWarn } from "@/lib/observability/logger";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/lib/payments/provider", () => ({
  getPlatformRazorpayCreds: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => ({
  rzpCreateOrder: vi.fn(),
  rzpChargeMandate: vi.fn(),
  rzpFetchOrder: vi.fn(),
  rzpFetchToken: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ rows: [] as any[], throws: false }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => {
    if (dbHolder.throws) throw new Error("db down");
    return fn({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => dbHolder.rows }) }),
      }),
    });
  }),
}));

import {
  NOTICE_PERIOD_MS,
  NOTICE_READY_MARGIN_MS,
  NOTICE_REQUEST_MARGIN_MS,
  RECURRING_CHARGE_VERIFIED,
  chargeUnavailableReason,
  getRecurringGateway,
  razorpayRecurringGateway as gateway,
} from "./gateway";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  rzpChargeMandate,
  rzpCreateOrder,
  rzpFetchOrder,
  rzpFetchToken,
} from "@/lib/payments/razorpay";

const CREDS = { keyId: "rzp_test", keySecret: "s" };
const NOW = new Date("2026-11-22T06:00:00.000Z");
const HOUR = 3_600_000;
const MIN = 60_000;
const secs = (d: Date | number) =>
  Math.floor((typeof d === "number" ? d : d.getTime()) / 1000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPlatformRazorpayCreds).mockReturnValue(CREDS as any);
  dbHolder.rows = [{ email: "owner@example.com", phone: "9311456722" }];
  dbHolder.throws = false;
});

describe("the release gate", () => {
  it("★★ automatic collection is enabled when the platform account is configured", () => {
    expect(RECURRING_CHARGE_VERIFIED).toBe(true);
    expect(getRecurringGateway()).toBe(gateway);
    expect(chargeUnavailableReason()).toBeNull();
  });

  it("★ still fails safe when platform credentials are missing", () => {
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null);
    expect(getRecurringGateway()).toBeNull();
    expect(chargeUnavailableReason()).toMatch(/credentials/i);
  });
});

describe("the notice periods are what Razorpay enforces", () => {
  it("a card waits 36 hours 5 minutes", () => {
    expect(NOTICE_PERIOD_MS.card).toBe(36 * HOUR + 5 * MIN);
  });

  // Razorpay's reference says 24 hours for UPI. Its API, asked on a UPI
  // Autopay mandate in test mode on 22 Nov 2026, refused 24 h 25 min and
  // exactly 25 h ("Debit can be attempted 25 hours after sending the
  // pre-debit notification") and accepted 25 h 01 min. With 24 here every UPI
  // renewal was refused at its first step.
  it("★★ UPI waits MORE than 25 hours, not the 24 the reference states", () => {
    expect(NOTICE_PERIOD_MS.upi).toBe(25 * HOUR + 5 * MIN);
    expect(NOTICE_PERIOD_MS.upi).toBeGreaterThan(25 * HOUR);
  });

  it("★★ what a UPI order asks for clears the 25 hours even before delivery is counted", () => {
    expect(
      NOTICE_PERIOD_MS.upi + NOTICE_REQUEST_MARGIN_MS,
    ).toBeGreaterThanOrEqual(25 * HOUR + 30 * MIN);
  });

  it("★ a rail this code does not know gets the LONGER period, never the shorter", () => {
    for (const rail of ["emandate", "nach", "unknown"] as const) {
      expect(NOTICE_PERIOD_MS[rail]).toBeGreaterThanOrEqual(
        NOTICE_PERIOD_MS.card,
      );
    }
  });
});

describe("checkMandate: only a confirmed token may be debited", () => {
  const ask = () =>
    gateway.checkMandate({
      providerCustomerId: "cust_1",
      providerTokenId: "token_1",
    });
  const token = (recurring_details: any, extra: any = {}) =>
    vi.mocked(rzpFetchToken).mockResolvedValue({
      ok: true,
      data: { id: "token_1", recurring_details, ...extra },
    } as any);

  it("confirmed is chargeable, read for this customer and token", async () => {
    token({ status: "confirmed" });
    expect(await ask()).toEqual({ state: "chargeable" });
    expect(rzpFetchToken).toHaveBeenCalledWith(CREDS, "cust_1", "token_1");
  });

  it("★ paused (and not yet approved) is not chargeable NOW, and not gone", async () => {
    for (const status of ["paused", "initiated"]) {
      token({ status });
      expect(await ask()).toEqual({ state: "paused", detail: status });
    }
  });

  it("★★ cancelled, being cancelled and rejected are gone for good", async () => {
    for (const status of ["cancelled", "cancellation_initiated", "rejected"]) {
      token({ status });
      expect((await ask()).state).toBe("ended");
    }
    token({ status: "rejected", failure_reason: "customer declined" });
    expect(await ask()).toEqual({
      state: "ended",
      detail: "rejected: customer declined",
    });
  });

  it("a confirmed UPI mandate past its expiry is ended", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    token(
      { status: "confirmed" },
      { method: "upi", expired_at: secs(NOW) - 60 },
    );
    expect(await ask()).toEqual({ state: "ended", detail: "expired" });
    token(
      { status: "confirmed" },
      { method: "upi", expired_at: secs(NOW) + 86_400 },
    );
    expect(await ask()).toEqual({ state: "chargeable" });
    vi.useRealTimers();
  });

  // Measured in test mode, 21 and 22 Nov 2026: a card token registered for
  // five years reads `expired_at` = the last second of the CURRENT MONTH while
  // its status is `confirmed`. Ending a mandate on that date would mark every
  // card mandate expired on the 1st of the next month, for good.
  it("★★ a confirmed CARD token is never ended on its expired_at: the status is the only word taken", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    token(
      { status: "confirmed" },
      { method: "card", expired_at: secs(NOW) - 60 },
    );
    expect(await ask()).toEqual({ state: "chargeable" });
    // Logged, so the first real month end shows what the date means.
    expect(logWarn).toHaveBeenCalledWith(
      "billing.mandate_token_past_expiry",
      expect.objectContaining({ tokenId: "token_1", method: "card" }),
    );
    vi.useRealTimers();
  });

  it("★ nor one whose rail the token does not name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    token({ status: "confirmed" }, { expired_at: secs(NOW) - 60 });
    expect(await ask()).toEqual({ state: "chargeable" });
    vi.useRealTimers();
  });

  it("★ a card token whose status says it is gone is still gone", async () => {
    token(
      { status: "cancelled" },
      { method: "card", expired_at: secs(NOW) + 86_400 },
    );
    expect((await ask()).state).toBe("ended");
  });

  it("★★ a read that failed, or a state it does not know, decides NOTHING", async () => {
    vi.mocked(rzpFetchToken).mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    } as any);
    expect(await ask()).toEqual({ state: "unknown" });
    // Even a 4xx: a mandate is never ended because a read was refused.
    vi.mocked(rzpFetchToken).mockResolvedValue({
      ok: false,
      error: "not found",
      outcome: "rejected",
    } as any);
    expect(await ask()).toEqual({ state: "unknown" });
    token({ status: "something_new" });
    expect(await ask()).toEqual({ state: "unknown" });
    token(null);
    expect(await ask()).toEqual({ state: "unknown" });
  });

  it("no credentials decides nothing", async () => {
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null);
    expect(await ask()).toEqual({ state: "unknown" });
    expect(rzpFetchToken).not.toHaveBeenCalled();
  });
});

describe("notify: the order with its pre-debit notice (no money moves)", () => {
  const INPUT = {
    amountPaise: 500_00,
    idempotencyKey: "idem-1",
    providerTokenId: "token_1",
    rail: "card" as const,
    now: NOW,
  };
  const requested = (rail: keyof typeof NOTICE_PERIOD_MS) =>
    NOW.getTime() + NOTICE_PERIOD_MS[rail] + NOTICE_REQUEST_MARGIN_MS;
  const orderWith = (notification: any) =>
    vi.mocked(rzpCreateOrder).mockResolvedValue({
      ok: true,
      data: { id: "order_1", notification },
    } as any);

  it("★★ creates the order with payment_capture and the notification for THIS token", async () => {
    orderWith({ id: "notification_1", payment_after: secs(requested("card")) });
    const res = await gateway.notify(INPUT);
    expect(res).toEqual({
      ok: true,
      data: {
        providerOrderId: "order_1",
        debitAfter: new Date(requested("card")),
      },
    });
    expect(rzpCreateOrder).toHaveBeenCalledWith(CREDS, {
      amountPaise: 500_00,
      receipt: "idem-1",
      notes: { idempotency_key: "idem-1", kind: "subscription" },
      paymentCapture: true,
      notification: {
        tokenId: "token_1",
        paymentAfterUnix: secs(requested("card")),
      },
    });
    // ★ The debit is NOT sent here: that is the whole point of the rebuild.
    expect(rzpChargeMandate).not.toHaveBeenCalled();
  });

  it("asks for the rail's own notice period: UPI just over 25 hours, a card a day and a half", async () => {
    orderWith({ payment_after: 1 });
    await gateway.notify({ ...INPUT, rail: "upi" });
    const upi = vi.mocked(rzpCreateOrder).mock.calls[0][1].notification!;
    expect(upi.paymentAfterUnix).toBe(secs(requested("upi")));
    expect(requested("card") - requested("upi")).toBe(11 * HOUR);
    // 25 h 30 min ahead: inside what the API accepts (more than 25 h).
    expect(requested("upi") - NOW.getTime()).toBe(25 * HOUR + 30 * MIN);
  });

  it("★★ keeps the GATEWAY's debit time when it is later, and never an earlier one", async () => {
    const later = requested("card") + 2 * HOUR;
    orderWith({ payment_after: secs(later) });
    const a = await gateway.notify(INPUT);
    expect(a.ok && a.data.debitAfter).toEqual(new Date(secs(later) * 1000));

    orderWith({ payment_after: secs(NOW) + 60 });
    const b = await gateway.notify(INPUT);
    expect(b.ok && b.data.debitAfter).toEqual(new Date(requested("card")));

    // No time echoed at all: our own request stands.
    orderWith({ id: "notification_1" });
    const c = await gateway.notify(INPUT);
    expect(c.ok && c.data.debitAfter).toEqual(new Date(requested("card")));
  });

  it("★★ an order that came back WITHOUT its notification is refused here, not 36 hours later", async () => {
    orderWith(undefined);
    const res = await gateway.notify(INPUT);
    expect(res).toMatchObject({ ok: false, outcome: "rejected" });
  });

  it("★ passes the gateway's own outcome through: a 4xx is rejected, a timeout unknown", async () => {
    vi.mocked(rzpCreateOrder).mockResolvedValue({
      ok: false,
      error:
        "Debit can be attempted 36 hours after sending the pre-debit notification",
      outcome: "rejected",
    } as any);
    expect(await gateway.notify(INPUT)).toMatchObject({ outcome: "rejected" });
    vi.mocked(rzpCreateOrder).mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    } as any);
    expect(await gateway.notify(INPUT)).toMatchObject({ outcome: "unknown" });
  });

  it("refuses when platform credentials are absent, sending nothing", async () => {
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null);
    expect(await gateway.notify(INPUT)).toMatchObject({
      ok: false,
      outcome: "rejected",
    });
    expect(rzpCreateOrder).not.toHaveBeenCalled();
  });
});

describe("readNotice: has the period passed, by the gateway's own record?", () => {
  const read = (rail: "card" | "upi" = "card", now = NOW) =>
    gateway.readNotice({ providerOrderId: "order_1", rail, now });
  const notice = (notification: any) =>
    vi.mocked(rzpFetchOrder).mockResolvedValue({
      ok: true,
      data: { id: "order_1", notification },
    } as any);

  it("★★ not delivered yet is `undelivered`, never ready", async () => {
    notice({ status: "created", delivered_at: null, payment_after: 1 });
    expect(await read()).toEqual({ state: "undelivered" });
    notice(undefined);
    expect(await read()).toEqual({ state: "undelivered" });
  });

  it("★★ the period runs from DELIVERY: 36h05m for a card, plus a small margin", async () => {
    const delivered = NOW.getTime() - (36 * HOUR + 5 * MIN);
    notice({ status: "delivered", delivered_at: secs(delivered) });
    // Exactly at the period's end: the margin is still to run.
    expect(await read()).toEqual({
      state: "wait",
      until: new Date(
        secs(delivered) * 1000 + NOTICE_PERIOD_MS.card + NOTICE_READY_MARGIN_MS,
      ),
    });
    expect(
      await read("card", new Date(NOW.getTime() + NOTICE_READY_MARGIN_MS)),
    ).toEqual({ state: "ready" });
  });

  it("UPI is ready 25 hours 5 minutes after delivery, and not at 24", async () => {
    notice({
      status: "delivered",
      delivered_at: secs(NOW.getTime() - 24 * HOUR - 6 * MIN),
    });
    expect((await read("upi")).state).toBe("wait");
    notice({
      status: "delivered",
      delivered_at: secs(NOW.getTime() - 25 * HOUR - 11 * MIN),
    });
    expect(await read("upi")).toEqual({ state: "ready" });
    expect((await read("card")).state).toBe("wait");
  });

  it("★ never before the gateway's own payment_after, even when delivery was long ago", async () => {
    const after = NOW.getTime() + 3 * HOUR;
    notice({
      status: "delivered",
      delivered_at: secs(NOW.getTime() - 100 * HOUR),
      payment_after: secs(after),
    });
    expect(await read()).toEqual({
      state: "wait",
      until: new Date(secs(after) * 1000 + NOTICE_READY_MARGIN_MS),
    });
  });

  it("★★ an order that could not be read decides NOTHING", async () => {
    vi.mocked(rzpFetchOrder).mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    } as any);
    expect(await read()).toEqual({ state: "unknown" });
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null);
    expect(await read()).toEqual({ state: "unknown" });
  });
});

describe("debit: the second step, sent once per attempt by its caller", () => {
  const INPUT = {
    amountPaise: 500_00,
    idempotencyKey: "idem-1",
    providerOrderId: "order_1",
    providerTokenId: "token_1",
    providerCustomerId: "cust_1",
    storeId: "store-1",
    description: "StoreMink renewal SM/2026-27/00007",
  };
  beforeEach(() => {
    vi.mocked(rzpChargeMandate).mockResolvedValue({
      ok: true,
      data: { razorpay_payment_id: "pay_1" },
    } as any);
  });
  afterEach(() => vi.useRealTimers());

  it("★★ debits the NOTIFIED order with the token, the customer and the billing contact", async () => {
    const res = await gateway.debit(INPUT);
    expect(res).toEqual({
      ok: true,
      data: { providerPaymentId: "pay_1", status: "created" },
    });
    expect(rzpChargeMandate).toHaveBeenCalledWith(CREDS, {
      amountPaise: 500_00,
      orderId: "order_1",
      customerId: "cust_1",
      tokenId: "token_1",
      email: "owner@example.com",
      contact: "9311456722",
      description: "StoreMink renewal SM/2026-27/00007",
      notes: { idempotency_key: "idem-1" },
    });
    // ★ It creates NO order of its own: the order is the notified one.
    expect(rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ a MISSING status is 'created', not 'captured'", async () => {
    // The documented success body is the payment id alone.
    const res = await gateway.debit(INPUT);
    expect(res.ok && res.data.status).toBe("created");
    vi.mocked(rzpChargeMandate).mockResolvedValue({
      ok: true,
      data: { razorpay_payment_id: "pay_1", status: "captured" },
    } as any);
    const captured = await gateway.debit(INPUT);
    expect(captured.ok && captured.data.status).toBe("captured");
  });

  it("★★ a 200 with NO payment id is UNKNOWN, never success", async () => {
    vi.mocked(rzpChargeMandate).mockResolvedValue({
      ok: true,
      data: {},
    } as any);
    expect(await gateway.debit(INPUT)).toMatchObject({
      ok: false,
      outcome: "unknown",
    });
  });

  it("★ passes the gateway's own outcome through on a refused or unanswered debit", async () => {
    vi.mocked(rzpChargeMandate).mockResolvedValue({
      ok: false,
      error:
        "The payment request failed as the pre-debit notification was not sent to the customer",
      outcome: "rejected",
    } as any);
    expect(await gateway.debit(INPUT)).toMatchObject({ outcome: "rejected" });
    vi.mocked(rzpChargeMandate).mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    } as any);
    expect(await gateway.debit(INPUT)).toMatchObject({ outcome: "unknown" });
  });

  it("★★ no billing contact is a rejection, not a guess: nothing is sent", async () => {
    dbHolder.rows = [];
    expect(await gateway.debit(INPUT)).toMatchObject({
      ok: false,
      outcome: "rejected",
    });
    dbHolder.rows = [{ email: "owner@example.com", phone: null }];
    expect(await gateway.debit(INPUT)).toMatchObject({ outcome: "rejected" });
    expect(rzpChargeMandate).not.toHaveBeenCalled();
  });

  it("★ a contact lookup that THROWS does not become a debit either", async () => {
    dbHolder.throws = true;
    expect(await gateway.debit(INPUT)).toMatchObject({ outcome: "rejected" });
    expect(rzpChargeMandate).not.toHaveBeenCalled();
  });

  it("refuses when platform credentials are absent", async () => {
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null);
    expect(await gateway.debit(INPUT)).toMatchObject({
      ok: false,
      outcome: "rejected",
    });
    expect(rzpChargeMandate).not.toHaveBeenCalled();
  });
});
