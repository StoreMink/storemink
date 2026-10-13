/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// What a tap on a menu button does: the button is read from the store's
// CURRENT settings, the three actions answer or hand over as documented, and
// nothing here ever throws into the webhook's drain.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/site", () => ({
  storeOrigin: vi.fn(() => "https://echoss.storemink.com"),
}));
vi.mock("./channel", () => ({
  loadWhatsAppSender: vi.fn(async () => ({ token: "tok", phoneNumberId: "P" })),
}));
vi.mock("./auto-reply", () => ({ replyInChat: vi.fn(async () => true) }));
vi.mock("./order-status-reply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./order-status-reply")>()),
  lookupOrdersForPhone: vi.fn(async () => ({ ok: true, orders: [] })),
}));

import { handleMenuReply } from "./menu-reply";
import { loadWhatsAppSender } from "./channel";
import { replyInChat } from "./auto-reply";
import { lookupOrdersForPhone } from "./order-status-reply";

const STORE = "11111111-1111-4111-8111-111111111111";

const BUTTONS = [
  { id: "b1", title: "Check my order", action: "order_status", text: "" },
  { id: "b2", title: "Talk to a person", action: "person", text: "" },
  { id: "b3", title: "Hours", action: "text", text: "Open 10 to 7." },
];

function setup(over: Record<string, unknown> = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [
        {
          name: "Echoss",
          slug: "echoss",
          customDomain: null,
          settings: {},
          plan: "basic",
          planExpiresAt: null,
          compPlan: null,
          compExpiresAt: null,
          menuEnabled: true,
          menuButtons: BUTTONS,
          ...over,
        },
      ],
    ],
  });
}

const input = (buttonId: string) => ({
  storeId: STORE,
  conversationId: "c1",
  phone: "+919876543210",
  userId: "u1",
  buttonId,
  now: new Date("2026-10-14T10:00:00+05:30"),
});

beforeEach(() => {
  vi.mocked(replyInChat).mockResolvedValue(true);
  vi.mocked(loadWhatsAppSender).mockResolvedValue({
    token: "tok",
    phoneNumberId: "P",
  } as any);
});

describe("handleMenuReply", () => {
  it("a message button sends the merchant's text and needs nobody", async () => {
    setup();
    const r = await handleMenuReply(input("b3"));
    expect(r).toEqual({ outcome: "text", needsHuman: false });
    expect(replyInChat).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE,
        conversationId: "c1",
        to: "+919876543210",
        body: "Open 10 to 7.",
        reason: "menu:text",
      }),
    );
  });

  it("★ 'Talk to a person' acknowledges and hands over, whatever the send did", async () => {
    setup();
    expect(await handleMenuReply(input("b2"))).toEqual({
      outcome: "person",
      needsHuman: true,
    });
    expect(vi.mocked(replyInChat).mock.calls[0][0].body).toBe(
      "Sure. Someone from our team will reply here shortly.",
    );
    setup();
    vi.mocked(replyInChat).mockResolvedValueOnce(false);
    expect((await handleMenuReply(input("b2"))).needsHuman).toBe(true);
  });

  it("a person button with its own words sends them", async () => {
    setup({
      menuButtons: [
        {
          id: "b2",
          title: "Talk to a person",
          action: "person",
          text: "On it!",
        },
      ],
    });
    await handleMenuReply(input("b2"));
    expect(vi.mocked(replyInChat).mock.calls[0][0].body).toBe("On it!");
  });

  it("★ 'Check my order' answers from the phone's own orders, and hands over when there are none", async () => {
    setup();
    const r = await handleMenuReply(input("b1"));
    expect(lookupOrdersForPhone).toHaveBeenCalledWith({
      storeId: STORE,
      phone: "+919876543210",
      userId: "u1",
    });
    expect(r).toEqual({ outcome: "order_status", needsHuman: true });
    expect(vi.mocked(replyInChat).mock.calls[0][0].reason).toBe(
      "menu:order_status",
    );
  });

  it("an answer that could not be sent hands over too", async () => {
    setup();
    vi.mocked(replyInChat).mockResolvedValueOnce(false);
    expect(await handleMenuReply(input("b3"))).toEqual({
      outcome: "text",
      needsHuman: true,
    });
  });

  it("★ a button that no longer exists, or a menu switched off, goes to a person without a reply", async () => {
    setup();
    expect(await handleMenuReply(input("gone"))).toEqual({
      outcome: "unknown_button",
      needsHuman: true,
    });
    setup({ menuEnabled: false });
    expect(await handleMenuReply(input("b3"))).toEqual({
      outcome: "unknown_button",
      needsHuman: true,
    });
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("a paused number cannot answer, so a person must", async () => {
    setup();
    vi.mocked(loadWhatsAppSender).mockResolvedValueOnce(null);
    expect(await handleMenuReply(input("b3"))).toEqual({
      outcome: "no_sender",
      needsHuman: true,
    });
  });

  it("unreadable settings are a failure that hands over, never a throw", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("down");
        },
      },
    };
    expect(await handleMenuReply(input("b3"))).toEqual({
      outcome: "failed",
      needsHuman: true,
    });
  });
});
