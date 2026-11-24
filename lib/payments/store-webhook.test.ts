/* eslint-disable @typescript-eslint/no-explicit-any */
// What the dashboard may say about a store's payment webhook (21 Nov 2026).
// A generated secret is not a working webhook: only a delivery whose signature
// verified proves Razorpay has both the address and the secret.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));
vi.mock("@/lib/payments/crypto", () => ({
  encryptSecret: vi.fn((s: string) => `enc(${s})`),
  decryptSecret: vi.fn((s: string) => s),
}));
vi.mock("@/lib/site", () => ({
  storeOrigin: vi.fn(() => "https://acme.storemink.com"),
}));

import {
  markPaymentWebhookReceived,
  paymentWebhookStatus,
  rotatePaymentWebhookSecret,
} from "./store-webhook";
import { withService } from "@/lib/db/client";

const STORE = "a0000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-21T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withService).mockImplementation(async (fn: any) =>
    fn(dbHolder.current.db),
  );
});

describe("paymentWebhookStatus", () => {
  const rows = (row?: Record<string, unknown>) =>
    (dbHolder.current = makeDbMock({ selectQueue: [row ? [row] : []] }));

  it("no secret generated: not configured", async () => {
    rows({ enc: null, lastEventAt: null });
    expect(await paymentWebhookStatus(STORE)).toEqual({
      configured: false,
      lastEventAt: null,
    });
    rows();
    expect((await paymentWebhookStatus(STORE)).configured).toBe(false);
  });

  it("★★ a secret with no delivery yet is configured but NOT proved", async () => {
    rows({ enc: "enc(secret)", lastEventAt: null });
    expect(await paymentWebhookStatus(STORE)).toEqual({
      configured: true,
      lastEventAt: null,
    });
  });

  it("a verified delivery gives its time", async () => {
    rows({ enc: "enc(secret)", lastEventAt: "2026-11-20 10:00:00+00" });
    expect(await paymentWebhookStatus(STORE)).toEqual({
      configured: true,
      lastEventAt: "2026-11-20 10:00:00+00",
    });
  });

  it("never returns the secret itself", async () => {
    rows({ enc: "enc(secret)", lastEventAt: null });
    expect(JSON.stringify(await paymentWebhookStatus(STORE))).not.toContain(
      "secret",
    );
  });
});

describe("markPaymentWebhookReceived", () => {
  it("stamps now, but only over a missing stamp or one older than an hour", async () => {
    dbHolder.current = makeDbMock();
    await markPaymentWebhookReceived(STORE, NOW);
    expect(dbHolder.current.calls.set[0]).toEqual({
      webhookLastEventAt: NOW.toISOString(),
    });
    const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[0]);
    expect(where.sql).toContain('"webhook_last_event_at" is null');
    expect(where.sql).toContain('"webhook_last_event_at" <');
    // One hour before `now`: a busy store writes at most once an hour.
    expect(where.params).toContain("2026-11-21T11:00:00.000Z");
    expect(where.params).toContain(STORE);
  });

  it("★★ never throws: a missed stamp must not cost the delivery it rides on", async () => {
    vi.mocked(withService).mockRejectedValue(new Error("db down"));
    await expect(
      markPaymentWebhookReceived(STORE, NOW),
    ).resolves.toBeUndefined();
  });
});

describe("rotatePaymentWebhookSecret", () => {
  it("★ a new secret starts unproved: the last-event time is cleared with it", async () => {
    dbHolder.current = makeDbMock({ returning: [{ storeId: STORE }] });
    const secret = await rotatePaymentWebhookSecret(STORE);
    expect(secret).toBeTruthy();
    expect(dbHolder.current.calls.set[0]).toEqual({
      webhookSecretEnc: `enc(${secret})`,
      webhookLastEventAt: null,
    });
  });

  it("nothing connected: no secret, and nothing is created", async () => {
    dbHolder.current = makeDbMock({ returning: [] });
    expect(await rotatePaymentWebhookSecret(STORE)).toBeNull();
  });
});

describe("loadPaymentWebhookSecret", () => {
  it("★★ a PAUSED gateway's webhook is still honoured: an order placed while it was on can still be paid", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ enc: "the-secret" }]] });
    const { loadPaymentWebhookSecret } = await import("./store-webhook");
    expect(await loadPaymentWebhookSecret(STORE)).toBe("the-secret");
    // The lookup is by store and provider only: not by whether it is enabled.
    const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[0]);
    expect(where.sql).not.toContain('"enabled"');
    expect(where.params).toEqual([STORE, "razorpay"]);
  });

  it("no secret, or a failed read, is null (the route answers 503 so Razorpay retries)", async () => {
    const { loadPaymentWebhookSecret } = await import("./store-webhook");
    dbHolder.current = makeDbMock({ selectQueue: [[{ enc: null }]] });
    expect(await loadPaymentWebhookSecret(STORE)).toBeNull();
    vi.mocked(withService).mockRejectedValueOnce(new Error("db down"));
    expect(await loadPaymentWebhookSecret(STORE)).toBeNull();
  });
});
