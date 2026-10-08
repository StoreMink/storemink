/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerAccess: vi.fn(),
  getActingStoreId: vi.fn(async () => "s1"),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/whatsapp/channel", () => ({
  loadWhatsAppSender: vi.fn(),
  bodyFromComponents: vi.fn(() => "Hi {{1}}, your order {{2}} is ready."),
}));
vi.mock("@/lib/whatsapp/inbox", () => ({
  needsReplyCount: vi.fn(async () => 2),
  recordOutboundMessage: vi.fn(async () => "m-out"),
  serviceWindow: (at: string | null) => {
    const open =
      Boolean(at) && Date.now() - new Date(at!).getTime() < 86_400_000;
    return {
      open,
      closesAt: open
        ? new Date(new Date(at!).getTime() + 86_400_000).toISOString()
        : null,
    };
  },
}));
vi.mock("@/lib/whatsapp/inbox-read", () => ({
  listConversations: vi.fn(),
  listReplyTemplates: vi.fn(async () => []),
  loadConversation: vi.fn(),
  loadThread: vi.fn(),
}));
vi.mock("@/lib/whatsapp/send", () => ({
  sendWhatsAppText: vi.fn(),
  sendWhatsAppTemplate: vi.fn(),
}));

import {
  getInboxConversations,
  markInboxRead,
  sendInboxReply,
  sendInboxTemplate,
  setInboxConversationStatus,
} from "./inbox-actions";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import { loadWhatsAppSender } from "@/lib/whatsapp/channel";
import { recordOutboundMessage } from "@/lib/whatsapp/inbox";
import { listConversations, loadConversation } from "@/lib/whatsapp/inbox-read";
import { sendWhatsAppTemplate, sendWhatsAppText } from "@/lib/whatsapp/send";

const CONV = "22222222-2222-4222-8222-222222222222";
const TPL = "33333333-3333-4333-8333-333333333333";

const core = (lastInboundAt: string | null) => ({
  id: CONV,
  status: "needs_reply",
  unreadCount: 1,
  lastMessageAt: lastInboundAt,
  lastInboundAt,
  lastPreview: "hi",
  contact: {
    id: "k1",
    phone: "+919876543210",
    name: "Rohan",
    userId: null,
    lastInboundAt,
    updatesOptInAt: null,
    updatesOptOutAt: null,
    marketingOptInAt: null,
    marketingOptOutAt: null,
  },
});

function access(view: boolean, manage: boolean) {
  vi.mocked(getViewerAccess).mockResolvedValue({
    userId: "admin-1",
    can: (_s: string, a: string) => (a === "manage" ? manage : view),
  } as any);
}

beforeEach(() => {
  access(true, true);
  dbHolder.current = makeDbMock({ returning: [{ id: CONV }] });
  vi.mocked(loadWhatsAppSender).mockResolvedValue({
    token: "tok",
    wabaId: "W",
    phoneNumberId: "PN",
    displayPhone: "+91",
    precedence: "whatsapp_first",
  });
  vi.mocked(loadConversation).mockResolvedValue(
    core(new Date().toISOString()) as any,
  );
  vi.mocked(sendWhatsAppText).mockResolvedValue({
    sent: true,
    messageId: "wamid.o",
    logId: "l1",
  });
  vi.mocked(listConversations).mockResolvedValue({
    rows: [],
    total: 0,
    counts: { needs_reply: 0, open: 0, closed: 0, all: 0 },
  });
});

describe("gates", () => {
  it("view reads, manage replies — and nothing without either", async () => {
    access(false, false);
    expect((await getInboxConversations({})).error).toMatch(/permission/);
    access(true, false);
    expect((await getInboxConversations({})).error).toBeUndefined();
    expect(
      (await sendInboxReply({ conversationId: CONV, text: "hi" })).error,
    ).toMatch(/permission/);
    expect((await setInboxConversationStatus(CONV, "closed")).ok).toBe(false);
    expect((await markInboxRead(CONV)).ok).toBe(true);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("a conversation id is only a claim — one not on this store is 'not found'", async () => {
    vi.mocked(loadConversation).mockResolvedValue(null);
    const r = await sendInboxReply({ conversationId: CONV, text: "hi" });
    expect(r).toMatchObject({ ok: false, error: "Not found." });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect((await markInboxRead("not-a-uuid")).ok).toBe(false);
  });
});

describe("sendInboxReply", () => {
  it("inside the window: sends through the choke point and files the reply", async () => {
    const r = await sendInboxReply({
      conversationId: CONV,
      text: "  Yes, in stock  ",
    });
    expect(r).toEqual({ ok: true, messageId: "m-out" });
    expect(sendWhatsAppText).toHaveBeenCalledWith({
      storeId: "s1",
      to: "+919876543210",
      token: "tok",
      phoneNumberId: "PN",
      body: "Yes, in stock",
    });
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: CONV,
        source: "dashboard",
        kind: "text",
        body: "Yes, in stock",
        providerMessageId: "wamid.o",
        status: "sent",
        sentByAdminId: "admin-1",
      }),
    );
  });

  it("★ outside the window: refused with window_closed, nothing sent", async () => {
    vi.mocked(loadConversation).mockResolvedValue(
      core(new Date(Date.now() - 25 * 3600_000).toISOString()) as any,
    );
    const r = await sendInboxReply({ conversationId: CONV, text: "hi" });
    expect(r).toMatchObject({ ok: false, code: "window_closed" });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(recordOutboundMessage).not.toHaveBeenCalled();
  });

  it("a paused or lapsed number is refused before any send", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(null);
    const r = await sendInboxReply({ conversationId: CONV, text: "hi" });
    expect(r).toMatchObject({ ok: false, code: "not_connected" });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("a refusal from Meta is filed as a failed message and reported", async () => {
    vi.mocked(sendWhatsAppText).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "131047 re-engagement",
      code: 131047,
    });
    const r = await sendInboxReply({ conversationId: CONV, text: "hi" });
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(r.error).toContain("131047");
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", providerMessageId: null }),
    );
  });

  it("an empty or oversized message never reaches the gate", async () => {
    expect(
      (await sendInboxReply({ conversationId: CONV, text: "   " })).ok,
    ).toBe(false);
    expect(
      (await sendInboxReply({ conversationId: CONV, text: "x".repeat(5000) }))
        .ok,
    ).toBe(false);
    expect(loadConversation).not.toHaveBeenCalled();
  });
});

describe("sendInboxTemplate", () => {
  beforeEach(() => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: TPL,
            name: "sm_order_ready_customer_v1",
            language: "en",
            variables: ["customer_name", "subject_label"],
            components: [],
            audience: "customer",
            category: "UTILITY",
          },
        ],
      ],
    });
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: true,
      messageId: "wamid.t",
      logId: "l2",
    });
  });

  it("sends an approved customer template with every value filled", async () => {
    const r = await sendInboxTemplate({
      conversationId: CONV,
      templateId: TPL,
      values: ["Rohan", "ORD1"],
    });
    expect(r).toEqual({ ok: true, messageId: "m-out" });
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+919876543210",
        template: expect.objectContaining({
          id: TPL,
          name: "sm_order_ready_customer_v1",
        }),
        values: ["Rohan", "ORD1"],
      }),
    );
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: "template",
        kind: "template",
        body: "Hi Rohan, your order ORD1 is ready.",
        templateId: TPL,
      }),
    );
  });

  it("★ refuses a missing or extra value rather than sending a template with a hole", async () => {
    expect(
      (
        await sendInboxTemplate({
          conversationId: CONV,
          templateId: TPL,
          values: ["Rohan"],
        })
      ).ok,
    ).toBe(false);
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("an unapproved template reads as not available", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const r = await sendInboxTemplate({
      conversationId: CONV,
      templateId: TPL,
      values: [],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/approved/);
  });
});
