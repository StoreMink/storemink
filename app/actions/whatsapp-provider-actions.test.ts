/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/whatsapp/config", () => ({
  whatsappConfig: vi.fn(() => ({
    appId: "APP",
    appSecret: "SECRET",
    verifyToken: "V",
    configId: "CFG",
    graphVersion: "v26.0",
  })),
  whatsappConnectConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/whatsapp/connect", () => ({
  connectWhatsAppAccount: vi.fn(),
  disconnectWhatsAppAccount: vi.fn(async () => undefined),
  refreshWhatsAppAccount: vi.fn(async () => ({ ok: true })),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getManagerUserId } from "@/app/dashboard/lib/access";
import { whatsappConnectConfigured } from "@/lib/whatsapp/config";
import { connectWhatsAppAccount } from "@/lib/whatsapp/connect";
import {
  connectWhatsApp,
  disconnectWhatsApp,
  getWhatsAppChannelState,
  setWhatsAppEnabled,
} from "./whatsapp-provider-actions";

const BASIC_STORE = [
  {
    plan: "basic",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
  },
];
const FREE_STORE = [
  {
    plan: "free",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
  },
];
const ACCOUNT = [
  {
    enabled: true,
    status: "connected",
    displayPhone: "+91 98765 43210",
    verifiedName: "Echos",
    nameStatus: "APPROVED",
    messagingTier: "TIER_1K",
    qualityRating: "GREEN",
    coexistence: false,
    lastError: null,
  },
];
const POPUP = {
  code: "CODE",
  wabaId: "2323545385144849",
  phoneNumberId: "1280649011808874",
  coexistence: false,
};

beforeEach(() => {
  vi.mocked(getManagerUserId).mockResolvedValue("admin-1");
  vi.mocked(whatsappConnectConfigured).mockReturnValue(true);
  vi.mocked(connectWhatsAppAccount).mockResolvedValue({
    ok: true,
    displayPhone: "+91 98765 43210",
    verifiedName: "Echos",
  });
  dbHolder.current = makeDbMock({
    selectByTable: {
      store_whatsapp_accounts: [ACCOUNT],
      stores: [BASIC_STORE],
    },
  });
});

describe("permissions", () => {
  it.each([
    ["connectWhatsApp", () => connectWhatsApp(POPUP)],
    ["setWhatsAppEnabled", () => setWhatsAppEnabled(true)],
    ["disconnectWhatsApp", () => disconnectWhatsApp()],
  ])("%s refuses without the channels grant", async (_n, call) => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    expect((await call()).error).toMatch(/permission/i);
    expect(connectWhatsAppAccount).not.toHaveBeenCalled();
  });

  it("getWhatsAppChannelState reports nothing without the grant", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const s = await getWhatsAppChannelState();
    expect(s.connected).toBe(false);
    expect(s.planAllows).toBe(false);
  });
});

describe("getWhatsAppChannelState", () => {
  it("returns Meta's facts, the plan gate and the public SDK ids — never a token", async () => {
    const s = await getWhatsAppChannelState();
    expect(s).toMatchObject({
      connected: true,
      enabled: true,
      status: "connected",
      displayPhone: "+91 98765 43210",
      messagingTier: "TIER_1K",
      planAllows: true,
      configured: true,
      appId: "APP",
      configId: "CFG",
    });
    expect(JSON.stringify(s)).not.toMatch(/token|pin/i);
  });

  it("withholds the SDK ids when the platform is not configured", async () => {
    vi.mocked(whatsappConnectConfigured).mockReturnValue(false);
    const s = await getWhatsAppChannelState();
    expect(s.configured).toBe(false);
    expect(s.appId).toBe("");
    expect(s.configId).toBe("");
  });
});

describe("connectWhatsApp", () => {
  it("hands the popup's values to the connect flow for the acting store", async () => {
    const r = await connectWhatsApp(POPUP);
    expect(r).toEqual({ success: true, displayPhone: "+91 98765 43210" });
    expect(connectWhatsAppAccount).toHaveBeenCalledWith({
      storeId: "store-1",
      ...POPUP,
    });
  });

  it("★ refuses on Free before calling Meta — the plan gate is server-side", async () => {
    dbHolder.current = makeDbMock({ selectByTable: { stores: [FREE_STORE] } });
    const r = await connectWhatsApp(POPUP);
    expect(r.error).toMatch(/Basic plan/);
    expect(connectWhatsAppAccount).not.toHaveBeenCalled();
  });

  it("refuses when the platform has no Embedded Signup configuration", async () => {
    vi.mocked(whatsappConnectConfigured).mockReturnValue(false);
    const r = await connectWhatsApp(POPUP);
    expect(r.error).toMatch(/isn't available/);
    expect(connectWhatsAppAccount).not.toHaveBeenCalled();
  });

  it("refuses an empty code without a lookup", async () => {
    const r = await connectWhatsApp({ ...POPUP, code: "  " });
    expect(r.error).toMatch(/sign-in code/);
    expect(connectWhatsAppAccount).not.toHaveBeenCalled();
  });

  it("surfaces the connect flow's own error", async () => {
    vi.mocked(connectWhatsAppAccount).mockResolvedValue({
      ok: false,
      error: "Meta refused while x: y",
    });
    expect((await connectWhatsApp(POPUP)).error).toBe(
      "Meta refused while x: y",
    );
  });
});

describe("setWhatsAppEnabled", () => {
  it("resuming is plan-gated; pausing never is", async () => {
    dbHolder.current = makeDbMock({ selectByTable: { stores: [FREE_STORE] } });
    expect((await setWhatsAppEnabled(true)).error).toMatch(/Basic plan/);
    expect((await setWhatsAppEnabled(false)).success).toBe(true);
  });
});
