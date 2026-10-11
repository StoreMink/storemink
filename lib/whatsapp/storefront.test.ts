/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({ logWarn: vi.fn() }));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getStorefrontWhatsAppChat } from "./storefront";
import { withService } from "@/lib/db/client";

const store = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  name: "Echos",
  plan: "basic",
  plan_expires_at: null,
  comp_plan: null,
  comp_expires_at: null,
  settings: {},
  ...over,
});

beforeEach(() => {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [{ enabled: true, status: "connected", displayPhone: "+91 98765 43210" }],
    ],
  });
});

describe("getStorefrontWhatsAppChat", () => {
  it("a connected, live number on Basic gets a button", async () => {
    const r = await getStorefrontWhatsAppChat(store());
    expect(r?.href).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
  });

  it("★ the switch off costs no query at all", async () => {
    const r = await getStorefrontWhatsAppChat(
      store({ settings: { features: { "whatsapp.chatButton": false } } }),
    );
    expect(r).toBeNull();
    expect(withService).not.toHaveBeenCalled();
  });

  it("Free has no WhatsApp, so no button, and no query", async () => {
    expect(await getStorefrontWhatsAppChat(store({ plan: "free" }))).toBeNull();
    expect(withService).not.toHaveBeenCalled();
  });

  it("a paused or reconnecting number shows nothing", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            enabled: false,
            status: "connected",
            displayPhone: "+919876543210",
          },
        ],
      ],
    });
    expect(await getStorefrontWhatsAppChat(store())).toBeNull();
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            enabled: true,
            status: "needs_reauth",
            displayPhone: "+919876543210",
          },
        ],
      ],
    });
    expect(await getStorefrontWhatsAppChat(store())).toBeNull();
  });

  it("a read failure renders the page without the button", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("down")] });
    expect(await getStorefrontWhatsAppChat(store())).toBeNull();
  });
});
