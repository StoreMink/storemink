/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("./channel", () => ({
  storeCanSendWhatsApp: vi.fn(),
  whatsAppConsentFor: vi.fn(),
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { storeCanSendWhatsApp, whatsAppConsentFor } from "./channel";
import { recordWhatsAppConsent, storedWhatsAppConsent } from "./consent";
import {
  WHATSAPP_MARKETING_CONSENT,
  WHATSAPP_UPDATES_CONSENT,
} from "./consent-copy";

beforeEach(() => {
  dbHolder.current = makeDbMock({});
  vi.mocked(storeCanSendWhatsApp).mockResolvedValue(true);
});

const norm = (q: any) => sqlText(q).replace(/\s+/g, " ");

describe("recordWhatsAppConsent", () => {
  it("writes the E.164 number, the shopper and the exact words agreed to", async () => {
    const r = await recordWhatsAppConsent({
      storeId: "store-1",
      phone: "9876543210",
      userId: "uid-1",
      verified: true,
      consent: { updates: true, marketing: false },
    });
    expect(r).toEqual({ ok: true });
    const q = dbHolder.current.calls.execute[0];
    expect(sqlText(q)).toMatch(/insert into public\.whatsapp_contacts/);
    const params = sqlParamValues(q);
    expect(params).toContain("+919876543210");
    expect(params).toContain("uid-1");
    expect(params).toContain(WHATSAPP_UPDATES_CONSENT);
    // Offers were NOT ticked: no marketing consent text is recorded.
    expect(params).not.toContain(WHATSAPP_MARKETING_CONSENT);
    expect(sqlText(q)).toMatch(/on conflict \(store_id, phone\)/);
    expect(norm(q)).toMatch(
      /user_id = coalesce\(excluded\.user_id, c\.user_id\)/,
    );
  });

  it("records the offers consent only when that box was ticked", async () => {
    await recordWhatsAppConsent({
      storeId: "store-1",
      phone: "+919876543210",
      userId: null,
      verified: true,
      consent: { updates: true, marketing: true },
    });
    expect(sqlParamValues(dbHolder.current.calls.execute[0])).toContain(
      WHATSAPP_MARKETING_CONSENT,
    );
  });

  it("the owner unticking withdraws only an opt-in in force", async () => {
    await recordWhatsAppConsent({
      storeId: "store-1",
      phone: "+919876543210",
      userId: "uid-1",
      verified: true,
      consent: { updates: false, marketing: false },
    });
    const q = norm(dbHolder.current.calls.execute[0]);
    expect(q).toMatch(
      /updates_opt_out_at = case when c\.updates_opt_in_at is not null/,
    );
    expect(q).toMatch(
      /marketing_opt_out_at = case when c\.marketing_opt_in_at is not null/,
    );
  });

  describe("★★ a number the shopper only typed (a gift, somebody else's phone)", () => {
    it("is never linked to their account", async () => {
      await recordWhatsAppConsent({
        storeId: "store-1",
        phone: "+919123456789",
        userId: "uid-1",
        verified: false,
        consent: { updates: true },
      });
      const q = dbHolder.current.calls.execute[0];
      expect(sqlParamValues(q)).not.toContain("uid-1");
      expect(norm(q)).toMatch(/user_id = c\.user_id,/);
    });

    it("gets order updates only if it never answered either way", async () => {
      await recordWhatsAppConsent({
        storeId: "store-1",
        phone: "+919123456789",
        userId: null,
        verified: false,
        consent: { updates: true },
      });
      expect(norm(dbHolder.current.calls.execute[0])).toMatch(
        /updates_opt_in_at = case when \(c\.updates_opt_in_at is null and c\.updates_opt_out_at is null\) then now\(\)/,
      );
    });

    it("★ cannot switch that person's updates off", async () => {
      await recordWhatsAppConsent({
        storeId: "store-1",
        phone: "+919123456789",
        userId: null,
        verified: false,
        consent: { updates: false },
      });
      expect(norm(dbHolder.current.calls.execute[0])).toMatch(
        /updates_opt_out_at = c\.updates_opt_out_at,/,
      );
    });

    it("★ cannot opt them in to offers, or undo their STOP", async () => {
      await recordWhatsAppConsent({
        storeId: "store-1",
        phone: "+919123456789",
        userId: null,
        verified: false,
        consent: { updates: true, marketing: true },
      });
      const q = dbHolder.current.calls.execute[0];
      expect(sqlParamValues(q)).not.toContain(WHATSAPP_MARKETING_CONSENT);
      expect(norm(q)).toMatch(/marketing_opt_in_at = c\.marketing_opt_in_at,/);
      expect(norm(q)).toMatch(
        /marketing_opt_out_at = c\.marketing_opt_out_at,/,
      );
    });
  });

  it("★ writes nothing for a store that cannot send, and says so", async () => {
    vi.mocked(storeCanSendWhatsApp).mockResolvedValue(false);
    const r = await recordWhatsAppConsent({
      storeId: "store-1",
      phone: "+919876543210",
      userId: "uid-1",
      verified: true,
      consent: { updates: true, marketing: true },
    });
    expect(r).toEqual({ ok: false });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("writes nothing for a number no message could reach", async () => {
    await recordWhatsAppConsent({
      storeId: "store-1",
      phone: "8888888888",
      userId: "uid-1",
      verified: true,
      consent: { updates: true, marketing: false },
    });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
    expect(storeCanSendWhatsApp).not.toHaveBeenCalled();
  });

  it("never throws into the checkout, and reports the failure", async () => {
    dbHolder.current = makeDbMock({});
    dbHolder.current.db.execute.mockRejectedValue(new Error("down"));
    await expect(
      recordWhatsAppConsent({
        storeId: "store-1",
        phone: "+919876543210",
        userId: null,
        verified: true,
        consent: { updates: true, marketing: false },
      }),
    ).resolves.toEqual({ ok: false });
  });
});

describe("storedWhatsAppConsent", () => {
  it("what the number already said, for the checkout boxes", async () => {
    vi.mocked(whatsAppConsentFor).mockResolvedValue(
      new Map([["+919876543210", { updates: false, marketing: true }]]),
    );
    expect(await storedWhatsAppConsent("store-1", "9876543210")).toEqual({
      updates: false,
      marketing: true,
    });
  });

  it("null for a number that never answered, or none at all", async () => {
    vi.mocked(whatsAppConsentFor).mockResolvedValue(new Map());
    expect(await storedWhatsAppConsent("store-1", "+919876543210")).toBeNull();
    expect(await storedWhatsAppConsent("store-1", null)).toBeNull();
  });
});
