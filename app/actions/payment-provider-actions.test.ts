/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => STORE),
}));
vi.mock("@/lib/payments/crypto", () => ({
  encryptSecret: vi.fn((s: string) => `enc(${s})`),
}));
vi.mock("@/lib/payments/razorpay", () => ({
  validateCredentials: vi.fn(),
}));
vi.mock("@/lib/payments/provider", () => ({
  lookupStoreGateway: vi.fn(),
}));
vi.mock("@/lib/orders/pending-payments", () => ({
  settleBeforeGatewayChange: vi.fn(),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  getChannelState,
  saveRazorpayCredentials,
  setRazorpayEnabled,
  disconnectRazorpay,
} from "./payment-provider-actions";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { validateCredentials } from "@/lib/payments/razorpay";
import { lookupStoreGateway } from "@/lib/payments/provider";
import { settleBeforeGatewayChange } from "@/lib/orders/pending-payments";

const STORE = "a0000000-0000-4000-8000-000000000001";
const KEY_ID = "rzp_live_abc123XYZ";
const SECRET = "super_secret_value";

const storeRow = (plan: string) => ({ plan, plan_expires_at: null });

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock({ returning: [{ store_id: STORE }] });
  vi.mocked(getManagerUserId).mockResolvedValue("admin-1");
  vi.mocked(validateCredentials).mockResolvedValue({
    ok: true,
    data: true,
  } as any);
  // Nothing connected yet, so there is nothing waiting on an old account.
  vi.mocked(lookupStoreGateway).mockResolvedValue({ status: "none" });
  vi.mocked(settleBeforeGatewayChange).mockResolvedValue(CLEAR);
});

const OLD_CREDS = { keyId: "rzp_live_old000000", keySecret: "old_secret" };
const CLEAR = {
  ok: true,
  paid: 0,
  expired: 0,
  waiting: 0,
  unreadable: 0,
  clearBy: null,
};
const connected = (enabled = true) =>
  vi.mocked(lookupStoreGateway).mockResolvedValue({
    status: "connected",
    gateway: { creds: OLD_CREDS, enabled },
  } as any);

// 21 Nov 2026: the keys on file are the only ones that can say whether an
// order still waiting for payment was paid, so they are never removed or
// replaced while one is waiting.
describe("★★ changing the Razorpay account while payments are in progress", () => {
  const WAITING = {
    ...CLEAR,
    ok: false,
    waiting: 2,
    clearBy: "2026-11-21T10:15:00.000Z",
  };
  const basic = () =>
    (dbHolder.current = makeDbMock({
      selectQueue: [[storeRow("basic")]],
      returning: [{ store_id: STORE }],
    }));

  it("disconnect settles the waiting orders with the keys on file, then removes them", async () => {
    connected();
    const res = await disconnectRazorpay();
    expect(res).toEqual({ success: true });
    expect(settleBeforeGatewayChange).toHaveBeenCalledWith(
      STORE,
      OLD_CREDS,
      null,
    );
    expect(dbHolder.current.calls.delete).toHaveLength(1);
  });

  it("★★ disconnect is REFUSED while a payment is in progress, and says until when", async () => {
    connected();
    vi.mocked(settleBeforeGatewayChange).mockResolvedValue(WAITING);
    const res = await disconnectRazorpay();
    expect(res.error).toContain("2 online payments are still in progress");
    expect(res.error).toContain("3:45 pm IST");
    expect(res.error).toContain("Nothing was changed");
    expect(dbHolder.current.calls.delete).toHaveLength(0);
  });

  it("★ the gateway is paused while it checks, and put back as it was on a refusal", async () => {
    connected(true);
    vi.mocked(settleBeforeGatewayChange).mockResolvedValue(WAITING);
    await disconnectRazorpay();
    const switched = dbHolder.current.calls.set.map((s: any) => s.enabled);
    expect(switched).toEqual([false, true]);
  });

  it("a gateway that was already paused is not switched at all", async () => {
    connected(false);
    vi.mocked(settleBeforeGatewayChange).mockResolvedValue(WAITING);
    await disconnectRazorpay();
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("★★ connecting ANOTHER account is refused while a payment is in progress", async () => {
    basic();
    connected();
    vi.mocked(settleBeforeGatewayChange).mockResolvedValue({
      ...WAITING,
      waiting: 1,
    });
    const res = await saveRazorpayCredentials(KEY_ID, SECRET);
    expect(res.error).toContain("1 online payment is still in progress");
    expect(res.error).toContain("a different account can't confirm them");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    // The new keys are handed over so keys on the SAME account pass.
    expect(settleBeforeGatewayChange).toHaveBeenCalledWith(STORE, OLD_CREDS, {
      keyId: KEY_ID,
      keySecret: SECRET,
    });
  });

  it("a key change that can still read the waiting orders is saved", async () => {
    basic();
    connected();
    const res = await saveRazorpayCredentials(KEY_ID, SECRET);
    expect(res).toEqual({ success: true });
    expect(dbHolder.current.calls.insert).toHaveLength(1);
  });

  it("★ fails closed when Razorpay cannot be asked", async () => {
    connected();
    vi.mocked(settleBeforeGatewayChange).mockResolvedValue({
      ...CLEAR,
      ok: false,
      unreadable: 1,
    });
    const res = await disconnectRazorpay();
    expect(res.error).toContain("couldn't check your in-progress payments");
    expect(dbHolder.current.calls.delete).toHaveLength(0);
  });

  it("a connection that cannot be read protects nothing, so it never blocks", async () => {
    vi.mocked(lookupStoreGateway).mockResolvedValue({ status: "error" });
    expect(await disconnectRazorpay()).toEqual({ success: true });
    expect(settleBeforeGatewayChange).not.toHaveBeenCalled();
  });
});

// saveRazorpayCredentials — select #1 = the plan-gate stores read.
describe("saveRazorpayCredentials", () => {
  it("rejects a caller without channels manage permission", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const res = await saveRazorpayCredentials(KEY_ID, SECRET);
    expect(res.error).toMatch(/permission/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("enforces the plan gate server-side (free plan blocked)", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("free")]] });
    const res = await saveRazorpayCredentials(KEY_ID, SECRET);
    expect(res.error).toMatch(/basic plan/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects a malformed key id before calling Razorpay", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("basic")]] });
    const res = await saveRazorpayCredentials("not-a-key", SECRET);
    expect(res.error).toMatch(/key id/i);
    expect(validateCredentials).not.toHaveBeenCalled();
  });

  it("★★ refuses a test-mode key on the production platform, before calling Razorpay", async () => {
    // Test mode accepts test cards and moves no money, so a live store on
    // test keys would mark unpaid orders paid and "refund" nothing.
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("basic")]] });
    const res = await saveRazorpayCredentials("rzp_test_abc123XYZ", SECRET);
    expect(res.error).toMatch(/test-mode key/i);
    expect(res.error).toContain("rzp_live_");
    expect(validateCredentials).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects credentials Razorpay itself refuses", async () => {
    vi.mocked(validateCredentials).mockResolvedValue({
      ok: false,
      error: "Authentication failed",
    } as any);
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("basic")]] });
    const res = await saveRazorpayCredentials(KEY_ID, SECRET);
    expect(res.error).toMatch(/rejected/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("verifies, encrypts the secret, and enables the gateway", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("basic")]] });
    const res = await saveRazorpayCredentials(` ${KEY_ID} `, ` ${SECRET} `);
    expect(res.success).toBe(true);
    expect(validateCredentials).toHaveBeenCalledWith({
      keyId: KEY_ID,
      keySecret: SECRET,
    });
    const upserted = dbHolder.current.calls.values[0];
    expect(upserted.keyId).toBe(KEY_ID);
    // The secret is stored ENCRYPTED, never plaintext.
    expect(upserted.keySecretEnc).toBe(`enc(${SECRET})`);
    expect(upserted).not.toHaveProperty("keySecret");
    expect(upserted.enabled).toBe(true);
    expect(upserted.storeId).toBe(STORE);
    // Reconnecting updates the single per-store row via the conflict clause.
    expect(dbHolder.current.calls.onConflict).toHaveLength(1);
  });
});

describe("setRazorpayEnabled", () => {
  it("blocks enabling on a plan without online payments", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[storeRow("free")]] });
    const res = await setRazorpayEnabled(true);
    expect(res.error).toMatch(/basic plan/i);
  });

  it("allows PAUSING regardless of plan (no upsell wall to turn things off)", async () => {
    // Disabling skips the plan check entirely; the update matches a row.
    dbHolder.current = makeDbMock({ returning: [{ store_id: STORE }] });
    const res = await setRazorpayEnabled(false);
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toMatchObject({ enabled: false });
  });

  it("errors when nothing is connected yet", async () => {
    dbHolder.current = makeDbMock({
      returning: [],
      selectQueue: [[storeRow("basic")]],
    });
    const res = await setRazorpayEnabled(true);
    expect(res.error).toMatch(/connect razorpay first/i);
  });
});

// getChannelState — selects: #1 the provider row, #2 the plan-gate read.
describe("getChannelState", () => {
  it("returns the key id and enabled state — never the secret", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ key_id: KEY_ID, enabled: true }], [storeRow("basic")]],
    });
    const state = await getChannelState();
    expect(state).toEqual({
      connected: true,
      keyId: KEY_ID,
      enabled: true,
      planAllowsOnlinePayments: true,
      // Whether a webhook EXISTS, never its signing secret.
      webhookConfigured: false,
      // And whether Razorpay has ever delivered to it: nothing yet.
      webhookLastEventAt: null,
      webhookUrl: null,
    });
    // The provider-row projection never asks for the encrypted secret column.
    const projectionKeys = Object.keys(dbHolder.current.calls.select[0] ?? {});
    expect(projectionKeys.join(",")).not.toMatch(/secret/i);
  });

  it("reports not-connected for a fresh store", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[], [storeRow("basic")]],
    });
    const state = await getChannelState();
    expect(state.connected).toBe(false);
    expect(state.keyId).toBeNull();
  });
});

describe("disconnectRazorpay", () => {
  it("requires manage permission", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const res = await disconnectRazorpay();
    expect(res.error).toMatch(/permission/i);
  });

  it("deletes the provider row for the acting store", async () => {
    const res = await disconnectRazorpay();
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.delete).toHaveLength(1);
    expect(dbHolder.current.calls.where).toHaveLength(1);
  });
});
