/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({ getCurrentStoreOrNull: vi.fn() }));
vi.mock("@/lib/whatsapp/channel", () => ({
  storeCanSendWhatsApp: vi.fn(),
  consented: (a: string | null, b: string | null) =>
    Boolean(a) && (!b || new Date(b).getTime() < new Date(a!).getTime()),
}));
vi.mock("@/lib/whatsapp/consent", () => ({ recordWhatsAppConsent: vi.fn() }));

import {
  getMyWhatsAppPreferences,
  setMyWhatsAppPreferences,
} from "./customer-whatsapp-actions";
import { getServerUser } from "@/lib/auth/server-user";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { storeCanSendWhatsApp } from "@/lib/whatsapp/channel";
import { recordWhatsAppConsent } from "@/lib/whatsapp/consent";

beforeEach(() => {
  vi.mocked(getServerUser).mockResolvedValue({
    id: "u1",
    email: "a@b.c",
    phone: "+919876543210",
  } as any);
  vi.mocked(getCurrentStoreOrNull).mockResolvedValue({ id: "s1" } as any);
  vi.mocked(storeCanSendWhatsApp).mockResolvedValue(true);
  dbHolder.current = makeDbMock({
    selectQueue: [
      [
        {
          updatesIn: "2026-01-01T00:00:00Z",
          updatesOut: null,
          marketingIn: "2026-01-01T00:00:00Z",
          marketingOut: "2026-02-01T00:00:00Z",
        },
      ],
    ],
  });
});

describe("getMyWhatsAppPreferences", () => {
  it("reads the shopper's own choices on the host store", async () => {
    const p = await getMyWhatsAppPreferences();
    expect(p).toMatchObject({
      available: true,
      phoneLabel: "+919876543210",
      updates: true,
      marketing: false,
    });
    expect(p.copy.updates).toMatch(/Order updates on WhatsApp/);
  });

  it("★ unavailable on a store that cannot message — the card hides", async () => {
    vi.mocked(storeCanSendWhatsApp).mockResolvedValue(false);
    expect((await getMyWhatsAppPreferences()).available).toBe(false);
  });

  it("unavailable when signed out, or with no textable number", async () => {
    vi.mocked(getServerUser).mockResolvedValueOnce(null);
    expect((await getMyWhatsAppPreferences()).available).toBe(false);
    vi.mocked(getServerUser).mockResolvedValueOnce({
      id: "u1",
      phone: "8888888888",
    } as any);
    expect((await getMyWhatsAppPreferences()).available).toBe(false);
  });
});

describe("setMyWhatsAppPreferences", () => {
  it("writes through the one consent recorder, with the account page's words", async () => {
    const r = await setMyWhatsAppPreferences({
      updates: false,
      marketing: true,
    });
    expect(r).toEqual({ ok: true });
    expect(recordWhatsAppConsent).toHaveBeenCalledWith({
      storeId: "s1",
      phone: "+919876543210",
      userId: "u1",
      consent: { updates: false, marketing: true },
      surface: "account",
    });
  });
  it("refuses when signed out", async () => {
    vi.mocked(getServerUser).mockResolvedValueOnce(null);
    expect(
      (await setMyWhatsAppPreferences({ updates: true, marketing: false })).ok,
    ).toBe(false);
    expect(recordWhatsAppConsent).not.toHaveBeenCalled();
  });
});
