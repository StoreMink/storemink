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
vi.mock("./channel", () => ({ storeCanSendWhatsApp: vi.fn() }));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { storeCanSendWhatsApp } from "./channel";
import { recordWhatsAppConsent } from "./consent";
import {
  WHATSAPP_MARKETING_CONSENT,
  WHATSAPP_UPDATES_CONSENT,
} from "./consent-copy";

beforeEach(() => {
  dbHolder.current = makeDbMock({});
  vi.mocked(storeCanSendWhatsApp).mockResolvedValue(true);
});

describe("recordWhatsAppConsent", () => {
  it("writes the E.164 number, the shopper and the exact words agreed to", async () => {
    await recordWhatsAppConsent({
      storeId: "store-1",
      phone: "9876543210",
      userId: "uid-1",
      consent: { updates: true, marketing: false },
    });
    const q = dbHolder.current.calls.execute[0];
    expect(sqlText(q)).toMatch(/insert into public\.whatsapp_contacts/);
    const params = sqlParamValues(q);
    expect(params).toContain("+919876543210");
    expect(params).toContain("uid-1");
    expect(params).toContain(WHATSAPP_UPDATES_CONSENT);
    // Offers were NOT ticked: no marketing consent text is recorded.
    expect(params).not.toContain(WHATSAPP_MARKETING_CONSENT);
    expect(sqlText(q)).toMatch(/on conflict \(store_id, phone\)/);
  });

  it("records the offers consent only when that box was ticked", async () => {
    await recordWhatsAppConsent({
      storeId: "store-1",
      phone: "+919876543210",
      userId: null,
      consent: { updates: true, marketing: true },
    });
    expect(sqlParamValues(dbHolder.current.calls.execute[0])).toContain(
      WHATSAPP_MARKETING_CONSENT,
    );
  });

  it("★ writes nothing for a store that cannot send", async () => {
    vi.mocked(storeCanSendWhatsApp).mockResolvedValue(false);
    await recordWhatsAppConsent({
      storeId: "store-1",
      phone: "+919876543210",
      userId: "uid-1",
      consent: { updates: true, marketing: true },
    });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("writes nothing for a number no message could reach", async () => {
    await recordWhatsAppConsent({
      storeId: "store-1",
      phone: "8888888888",
      userId: "uid-1",
      consent: { updates: true, marketing: false },
    });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
    expect(storeCanSendWhatsApp).not.toHaveBeenCalled();
  });

  it("never throws into the checkout", async () => {
    dbHolder.current = makeDbMock({});
    dbHolder.current.db.execute.mockRejectedValue(new Error("down"));
    await expect(
      recordWhatsAppConsent({
        storeId: "store-1",
        phone: "+919876543210",
        userId: null,
        consent: { updates: true, marketing: false },
      }),
    ).resolves.toBeUndefined();
  });
});
