/* eslint-disable @typescript-eslint/no-explicit-any */
// The Razorpay REST client — the NETWORK surface.
//
// The pure helpers in this module (verifyCheckoutSignature,
// verifyWebhookSignature, capturedPayment) are
// covered in payments.test.ts alongside the AES helpers. This file is
// everything that talks to Razorpay, which had no tests at all.
//
// ── The one thing this module decides ──────────────────────────────────────
// ★ `outcome` — whether a failure is a VERDICT or an UNKNOWN.
//
// Exactly one caller cares (refunds), and it is the difference between failing
// a refund row and leaving it pending. A 4xx means the request was rejected and
// nothing happened, so the amount can be freed. A 5xx or a network throw means
// the write MAY have landed, and calling that a failure is how a customer gets
// refunded twice. Everything else here is request shaping, but that shaping is
// what carries the idempotency key, so it is asserted literally.
//
// ⚠ WHAT THIS CANNOT COVER. `fetch` is stubbed, so nothing here proves
// Razorpay accepts these bodies or honours the idempotency header — only that
// we send what we intend to. Against the real test account the refund endpoint
// has never returned a success (it refuses that account's payment), so the
// happy path remains unproven end to end.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  failureOutcome,
  rzpCreateOrder,
  rzpFetchOrderPayments,
  rzpFetchToken,
  rzpFetchPaymentRefunds,
  rzpRefund,
  validateCredentials,
  verifyCapturedCheckoutPayment,
} from "./razorpay";

const CREDS = { keyId: "rzp_test_abc", keySecret: "s3cret" };

/** Stub one fetch outcome. */
function respond(opts: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  jsonThrows?: boolean;
  reject?: unknown;
}) {
  const fn = vi.fn(async () => {
    if (opts.reject !== undefined) throw opts.reject;
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => {
        if (opts.jsonThrows) throw new Error("not json");
        return opts.json ?? {};
      },
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The (url, init) the client actually sent. */
function sent(fn: any) {
  const [url, init] = fn.mock.calls[0]!;
  return { url, init, body: init?.body ? JSON.parse(init.body) : undefined };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// The shared transport
// ---------------------------------------------------------------------------

describe("★ every request", () => {
  it("authenticates with basic auth over the key pair", async () => {
    const fetchMock = respond({ json: { id: "order_1" } });
    await rzpCreateOrder(CREDS, { amountPaise: 50000 });
    const { init } = sent(fetchMock);
    const expected = Buffer.from("rzp_test_abc:s3cret").toString("base64");
    expect(init.headers.Authorization).toBe(`Basic ${expected}`);
  });

  it("goes to the live Razorpay host", async () => {
    const fetchMock = respond({ json: {} });
    await rzpCreateOrder(CREDS, { amountPaise: 50000 });
    expect(sent(fetchMock).url).toBe("https://api.razorpay.com/v1/orders");
  });

  it("★ never serves a cached answer", async () => {
    // Every call here is either taking money or asking what the truth is;
    // a cached reconciliation read would be worse than no read.
    const fetchMock = respond({ json: {} });
    await rzpCreateOrder(CREDS, { amountPaise: 50000 });
    expect(sent(fetchMock).init.cache).toBe("no-store");
  });

  it("keeps a caller's own headers alongside the defaults", async () => {
    const fetchMock = respond({ json: {} });
    await rzpRefund(CREDS, {
      paymentId: "pay_1",
      amountPaise: 50000,
      idempotencyKey: "refund-key-1",
    });
    const { init } = sent(fetchMock);
    expect(init.headers["X-Refund-Idempotency"]).toBe("refund-key-1");
    expect(init.headers["X-Razorpay-Idempotency-Key"]).toBeUndefined();
    expect(init.headers.Authorization).toContain("Basic ");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });
});

describe("★ a failure is classified, not just reported", () => {
  it.each([400, 401, 403, 404, 422, 499])(
    "%s is a VERDICT — nothing happened, so the amount can be freed",
    async (status) => {
      respond({ ok: false, status, json: { error: { description: "no" } } });
      const res = await rzpRefund(CREDS, {
        paymentId: "pay_1",
        amountPaise: 50000,
        idempotencyKey: "refund-test-key",
      });
      expect(res).toMatchObject({ ok: false, outcome: "rejected" });
    },
  );

  it.each([500, 502, 503, 504])(
    "★ %s is UNKNOWN — their side broke partway and the write may have landed",
    async (status) => {
      respond({ ok: false, status, json: { error: { description: "boom" } } });
      const res = await rzpRefund(CREDS, {
        paymentId: "pay_1",
        amountPaise: 50000,
        idempotencyKey: "refund-test-key",
      });
      expect(res).toMatchObject({ ok: false, outcome: "unknown" });
    },
  );

  // PR #303 re-review, 22 Nov 2026. A rejected READ is taken to mean "these
  // keys cannot read this order" (revoked, or another account's), and a
  // store may then disconnect its gateway with that order unchecked. A 429
  // says none of that, so a paid order read in a busy minute was skipped and
  // later cancelled.
  it.each([408, 425, 429])(
    "★★ %s on a READ is UNKNOWN: Razorpay was busy, the keys were not refused",
    async (status) => {
      respond({ ok: false, status, json: { error: { description: "slow" } } });
      expect(await rzpFetchOrderPayments(CREDS, "order_1")).toMatchObject({
        ok: false,
        outcome: "unknown",
      });
    },
  );

  it.each([400, 401, 403, 404])(
    "%s on a read is still a refusal of the keys or the order",
    async (status) => {
      respond({ ok: false, status, json: { error: { description: "no" } } });
      expect(await rzpFetchOrderPayments(CREDS, "order_1")).toMatchObject({
        ok: false,
        outcome: "rejected",
      });
    },
  );

  it("★ a 429 on a WRITE stays a verdict: it was turned away before anything was created", async () => {
    respond({
      ok: false,
      status: 429,
      json: { error: { description: "slow" } },
    });
    const res = await rzpCreateOrder(CREDS, { amountPaise: 50000 });
    expect(res).toMatchObject({ ok: false, outcome: "rejected" });
  });

  it("the rule itself, by status and method", () => {
    expect(failureOutcome(429, undefined)).toBe("unknown");
    expect(failureOutcome(429, "get")).toBe("unknown");
    expect(failureOutcome(429, "POST")).toBe("rejected");
    expect(failureOutcome(408, "PATCH")).toBe("rejected");
    expect(failureOutcome(404, "GET")).toBe("rejected");
    expect(failureOutcome(503, "POST")).toBe("unknown");
  });

  it("★ a network throw is UNKNOWN — a timeout is a success we never read", async () => {
    respond({ reject: new Error("socket hang up") });
    const res = await rzpRefund(CREDS, {
      paymentId: "pay_1",
      amountPaise: 50000,
      idempotencyKey: "refund-test-key",
    });
    expect(res).toEqual({
      ok: false,
      error: "socket hang up",
      outcome: "unknown",
    });
  });

  it("survives something thrown that isn't an Error", async () => {
    respond({ reject: "just a string" });
    const res = await rzpCreateOrder(CREDS, { amountPaise: 50000 });
    expect(res).toEqual({
      ok: false,
      error: "Razorpay request failed",
      outcome: "unknown",
    });
  });

  it("surfaces Razorpay's own description when it gives one", async () => {
    respond({
      ok: false,
      status: 400,
      json: {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "invalid request sent",
        },
      },
    });
    const res = await rzpCreateOrder(CREDS, { amountPaise: 50000 });
    expect(res).toMatchObject({ error: "invalid request sent" });
  });

  it("falls back to the status when the body has no description", async () => {
    respond({ ok: false, status: 418, json: { error: {} } });
    const res = await rzpCreateOrder(CREDS, { amountPaise: 50000 });
    expect(res).toMatchObject({ error: "Razorpay request failed (418)" });
  });

  it("falls back to the status when the body isn't JSON at all", async () => {
    // An HTML error page from a proxy in front of them, say.
    respond({ ok: false, status: 502, jsonThrows: true });
    const res = await rzpCreateOrder(CREDS, { amountPaise: 50000 });
    expect(res).toEqual({
      ok: false,
      error: "Razorpay request failed (502)",
      outcome: "unknown",
    });
  });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

describe("rzpCreateOrder", () => {
  it("posts the server-computed amount in paise", async () => {
    const fetchMock = respond({ json: { id: "order_1", amount: 50000 } });
    const res = await rzpCreateOrder(CREDS, {
      amountPaise: 50000,
      receipt: "ORD10011027",
      notes: { sm_store_id: "s1" },
    });
    expect(res).toEqual({ ok: true, data: { id: "order_1", amount: 50000 } });
    const { init, body } = sent(fetchMock);
    expect(init.method).toBe("POST");
    expect(body).toEqual({
      amount: 50000,
      currency: "INR",
      receipt: "ORD10011027",
      notes: { sm_store_id: "s1" },
    });
  });

  it("omits receipt and notes when not given", async () => {
    const fetchMock = respond({ json: {} });
    await rzpCreateOrder(CREDS, { amountPaise: 50000 });
    expect(sent(fetchMock).body).toEqual({ amount: 50000, currency: "INR" });
  });

  it.each([99, 0, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "★ refuses %s locally rather than letting Razorpay reject it",
    async (amountPaise) => {
      // Below their ₹1 floor, or not a whole number of paise. Refusing here
      // keeps a doomed request off the wire, and `rejected` lets the caller
      // treat it as the non-event it is.
      const fetchMock = respond({ json: {} });
      const res = await rzpCreateOrder(CREDS, { amountPaise });
      expect(res).toEqual({
        ok: false,
        error: "Amount too small for an online payment.",
        outcome: "rejected",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("accepts exactly the ₹1 minimum", async () => {
    respond({ json: { id: "order_1" } });
    expect((await rzpCreateOrder(CREDS, { amountPaise: 100 })).ok).toBe(true);
  });
});

// 21 Nov 2026: the order of a renewal debit. Razorpay answers the debit call
// "The requested URL was not found on the server" unless the order was created
// with the pre-debit notification (docs/autopay-verification.md).
describe("★★ rzpCreateOrder for a subsequent (recurring) payment", () => {
  it("sends payment_capture and the notification, in Razorpay's own field names", async () => {
    const fetchMock = respond({ json: { id: "order_1" } });
    await rzpCreateOrder(CREDS, {
      amountPaise: 177000,
      receipt: "sm_bill_att-1",
      paymentCapture: true,
      notification: { tokenId: "token_1", paymentAfterUnix: 1795413211 },
    });
    expect(sent(fetchMock).body).toEqual({
      amount: 177000,
      currency: "INR",
      receipt: "sm_bill_att-1",
      payment_capture: true,
      notification: { token_id: "token_1", payment_after: 1795413211 },
    });
  });

  it("★ an ordinary checkout order carries neither: capture stays the account's own setting", async () => {
    const fetchMock = respond({ json: {} });
    await rzpCreateOrder(CREDS, { amountPaise: 50000, receipt: "r1" });
    const body = sent(fetchMock).body;
    expect(body).not.toHaveProperty("payment_capture");
    expect(body).not.toHaveProperty("notification");
  });

  it("payment_capture false is sent as false, not dropped", async () => {
    const fetchMock = respond({ json: {} });
    await rzpCreateOrder(CREDS, { amountPaise: 50000, paymentCapture: false });
    expect(sent(fetchMock).body.payment_capture).toBe(false);
  });
});

describe("rzpFetchToken: a mandate's state at the gateway", () => {
  it("reads the customer's token", async () => {
    const fetchMock = respond({
      json: { id: "token_1", recurring_details: { status: "confirmed" } },
    });
    const res = await rzpFetchToken(CREDS, "cust_1", "token_1");
    expect(sent(fetchMock).url).toBe(
      "https://api.razorpay.com/v1/customers/cust_1/tokens/token_1",
    );
    expect(sent(fetchMock).init.method).toBe("GET");
    expect(res).toMatchObject({
      ok: true,
      data: { recurring_details: { status: "confirmed" } },
    });
  });

  it("★ ids are encoded, so neither can rewrite the path", async () => {
    const fetchMock = respond({ json: {} });
    await rzpFetchToken(CREDS, "cust/../x", "token?y=1");
    expect(sent(fetchMock).url).toBe(
      "https://api.razorpay.com/v1/customers/cust%2F..%2Fx/tokens/token%3Fy%3D1",
    );
  });
});

describe("rzpFetchOrderPayments", () => {
  it("unwraps the items list", async () => {
    respond({ json: { items: [{ id: "pay_1", status: "captured" }] } });
    const res = await rzpFetchOrderPayments(CREDS, "order_1");
    expect(res).toEqual({
      ok: true,
      data: [{ id: "pay_1", status: "captured" }],
    });
  });

  it("reads a missing items list as no payments", async () => {
    respond({ json: {} });
    expect(await rzpFetchOrderPayments(CREDS, "order_1")).toEqual({
      ok: true,
      data: [],
    });
  });

  it("passes a failure straight through, outcome intact", async () => {
    respond({ ok: false, status: 500, json: {} });
    const res = await rzpFetchOrderPayments(CREDS, "order_1");
    expect(res).toMatchObject({ ok: false, outcome: "unknown" });
  });

  it("★ escapes the id into the path", async () => {
    const fetchMock = respond({ json: { items: [] } });
    await rzpFetchOrderPayments(CREDS, "order/../../evil?x=1");
    expect(sent(fetchMock).url).toBe(
      "https://api.razorpay.com/v1/orders/order%2F..%2F..%2Fevil%3Fx%3D1/payments",
    );
  });
});

describe("verifyCapturedCheckoutPayment", () => {
  const expected = {
    paymentId: "pay_1",
    orderId: "order_1",
    amountPaise: 50_000,
  };

  it("accepts only the captured INR payment for the exact order and amount", async () => {
    respond({
      json: {
        id: "pay_1",
        order_id: "order_1",
        amount: 50_000,
        currency: "INR",
        status: "captured",
      },
    });
    expect(await verifyCapturedCheckoutPayment(CREDS, expected)).toEqual({
      ok: true,
      gatewayRead: true,
    });
  });

  it.each([
    ["wrong order", { order_id: "order_other" }],
    ["wrong amount", { amount: 49_900 }],
    ["wrong currency", { currency: "USD" }],
    ["not captured", { status: "authorized" }],
  ])("refuses a contradictory gateway record: %s", async (_label, override) => {
    respond({
      json: {
        id: "pay_1",
        order_id: "order_1",
        amount: 50_000,
        currency: "INR",
        status: "captured",
        ...override,
      },
    });
    expect((await verifyCapturedCheckoutPayment(CREDS, expected)).ok).toBe(
      false,
    );
  });

  it("falls back to the already-verified HMAC during a gateway read outage", async () => {
    respond({ ok: false, status: 503, json: {} });
    expect(await verifyCapturedCheckoutPayment(CREDS, expected)).toEqual({
      ok: true,
      gatewayRead: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Refunds — the dangerous one
// ---------------------------------------------------------------------------

describe("rzpRefund", () => {
  const ok = () => respond({ json: { id: "rfnd_1", status: "processed" } });

  it("★ sends the key BOTH as the header and inside notes", async () => {
    // The notes copy is the load-bearing half: it is the one that still works
    // if the header is ever unsupported, renamed, or silently ignored, and it
    // is what reconcile matches on.
    const fetchMock = ok();
    await rzpRefund(CREDS, {
      paymentId: "pay_1",
      amountPaise: 25000,
      idempotencyKey: "refund-key-abc",
      notes: { sm_order_ref: "ORD1" },
    });
    const { url, init, body } = sent(fetchMock);
    expect(url).toBe("https://api.razorpay.com/v1/payments/pay_1/refund");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Refund-Idempotency"]).toBe("refund-key-abc");
    expect(init.headers["X-Razorpay-Idempotency-Key"]).toBeUndefined();
    expect(body).toEqual({
      amount: 25000,
      notes: { sm_order_ref: "ORD1", sm_refund_key: "refund-key-abc" },
    });
  });

  it("★ a caller's notes cannot overwrite the refund key", async () => {
    // The key is spread LAST for exactly this reason — a caller passing
    // sm_refund_key would otherwise break the only link reconcile has back to
    // the row that asked for the refund.
    const fetchMock = ok();
    await rzpRefund(CREDS, {
      paymentId: "pay_1",
      amountPaise: 25000,
      idempotencyKey: "refund-real-key",
      notes: { sm_refund_key: "spoofed" } as any,
    });
    expect(sent(fetchMock).body.notes.sm_refund_key).toBe("refund-real-key");
  });

  it("works with no caller notes at all", async () => {
    const fetchMock = ok();
    await rzpRefund(CREDS, {
      paymentId: "pay_1",
      amountPaise: 25000,
      idempotencyKey: "refund-test-key",
    });
    expect(sent(fetchMock).body.notes).toEqual({
      sm_refund_key: "refund-test-key",
    });
  });

  it("★ refuses an empty payment id as REJECTED, not unknown", async () => {
    // Our own precondition: nothing was sent, so nothing happened. Saying
    // "unknown" would strand the refund row pending against a call that was
    // never made, and only the 30-minute sweep would ever free it.
    const fetchMock = respond({ json: {} });
    const res = await rzpRefund(CREDS, {
      paymentId: "",
      amountPaise: 25000,
      idempotencyKey: "refund-test-key",
    });
    expect(res).toEqual({
      ok: false,
      error: "No payment to refund.",
      outcome: "rejected",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([99, 0, -1, 12.5, Number.NaN])(
    "refuses %s paise before it reaches the wire",
    async (amountPaise) => {
      const fetchMock = respond({ json: {} });
      const res = await rzpRefund(CREDS, {
        paymentId: "pay_1",
        amountPaise,
        idempotencyKey: "refund-test-key",
      });
      expect(res).toEqual({
        ok: false,
        error: "Amount too small to refund online.",
        outcome: "rejected",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("escapes the payment id into the path", async () => {
    const fetchMock = ok();
    await rzpRefund(CREDS, {
      paymentId: "pay/1",
      amountPaise: 25000,
      idempotencyKey: "refund-test-key",
    });
    expect(sent(fetchMock).url).toContain("/payments/pay%2F1/refund");
  });

  it.each(["", "too-short", "refund key with spaces", "refund.key.bad"])(
    "rejects an invalid idempotency key (%j) before it reaches the wire",
    async (idempotencyKey) => {
      const fetchMock = respond({ json: {} });
      const res = await rzpRefund(CREDS, {
        paymentId: "pay_1",
        amountPaise: 25000,
        idempotencyKey,
      });
      expect(res).toEqual({
        ok: false,
        error: "Invalid refund idempotency key.",
        outcome: "rejected",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("rzpFetchPaymentRefunds", () => {
  it("unwraps the items list", async () => {
    respond({ json: { items: [{ id: "rfnd_1" }] } });
    expect(await rzpFetchPaymentRefunds(CREDS, "pay_1")).toEqual({
      ok: true,
      data: [{ id: "rfnd_1" }],
    });
  });

  it("reads a missing list as no refunds", async () => {
    respond({ json: {} });
    expect(await rzpFetchPaymentRefunds(CREDS, "pay_1")).toEqual({
      ok: true,
      data: [],
    });
  });

  it("★ passes a failure through rather than reporting 'no refunds'", async () => {
    // Reconcile treats an empty list as evidence the refund never landed, so
    // a failed lookup that returned [] would eventually fail a live refund.
    respond({ ok: false, status: 503, json: {} });
    expect(await rzpFetchPaymentRefunds(CREDS, "pay_1")).toMatchObject({
      ok: false,
      outcome: "unknown",
    });
  });
});

// ---------------------------------------------------------------------------
// Credential check
// ---------------------------------------------------------------------------

describe("validateCredentials", () => {
  it("proves a working pair with the cheapest authenticated call", async () => {
    const fetchMock = respond({ json: { items: [] } });
    expect(await validateCredentials(CREDS)).toEqual({ ok: true, data: true });
    expect(sent(fetchMock).url).toBe(
      "https://api.razorpay.com/v1/orders?count=1",
    );
  });

  it("reports a bad pair as rejected", async () => {
    respond({
      ok: false,
      status: 401,
      json: { error: { description: "Authentication failed" } },
    });
    expect(await validateCredentials(CREDS)).toEqual({
      ok: false,
      error: "Authentication failed",
      outcome: "rejected",
    });
  });

  it("does NOT report an outage as a bad pair", async () => {
    // "Verify & save" refusing valid credentials during a Razorpay incident
    // would have a merchant re-typing keys that were always correct.
    respond({ ok: false, status: 503, json: {} });
    expect(await validateCredentials(CREDS)).toMatchObject({
      outcome: "unknown",
    });
  });
});
