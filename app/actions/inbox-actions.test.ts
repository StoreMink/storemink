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
  templateHasButtons: (c: unknown) =>
    Array.isArray(c) && c.some((x: any) => x?.type === "BUTTONS"),
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
vi.mock("@/lib/whatsapp/mink-drafts", () => ({
  minkChargeContext: vi.fn(async () => ({ period: "2026-10", planCap: 20 })),
  claimMinkDraft: vi.fn(async () => ({ id: DRAFT_ID, charged: false })),
  chargeMinkAnswer: vi.fn(async () => "plan"),
  markMinkAnswerSent: vi.fn(async () => undefined),
  discardMinkDrafts: vi.fn(async () => 1),
}));
const DRAFT_ID = vi.hoisted(() => "44444444-4444-4444-8444-444444444444");

import {
  discardMinkDraft,
  getInboxConversations,
  markInboxRead,
  sendInboxReply,
  sendInboxTemplate,
  sendMinkDraft,
  setInboxConversationStatus,
} from "./inbox-actions";
import {
  chargeMinkAnswer,
  claimMinkDraft,
  discardMinkDrafts,
  markMinkAnswerSent,
} from "@/lib/whatsapp/mink-drafts";
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
    codConfirmation: false,
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

  it("★ refuses a template with buttons, which only the order flow can send", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: TPL,
            name: "sm_order_placed_customer_cod_confirm_v1",
            language: "en",
            variables: ["customer_name", "subject_label"],
            components: [
              { type: "BODY", text: "x" },
              { type: "BUTTONS", buttons: [] },
            ],
            audience: "customer",
            category: "UTILITY",
          },
        ],
      ],
    });
    const r = await sendInboxTemplate({
      conversationId: CONV,
      templateId: TPL,
      values: ["Rohan", "ORD1"],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/buttons/);
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("★ a merchant's own template with quick replies IS sendable, each reply carrying its label", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: TPL,
            name: "delivery_delay",
            language: "en",
            variables: ["customer_name"],
            components: [
              { type: "HEADER", format: "TEXT", text: "Update" },
              { type: "BODY", text: "Hi {{1}}, your order is late." },
              {
                type: "BUTTONS",
                buttons: [
                  { type: "QUICK_REPLY", text: "Okay" },
                  { type: "URL", text: "Track", url: "https://x.y/orders" },
                ],
              },
            ],
            audience: "customer",
            category: "UTILITY",
            eventKey: null,
          },
        ],
      ],
    });
    const r = await sendInboxTemplate({
      conversationId: CONV,
      templateId: TPL,
      values: ["Rohan"],
    });
    expect(r).toEqual({ ok: true, messageId: "m-out" });
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        template: expect.objectContaining({ name: "delivery_delay" }),
        values: ["Rohan"],
        buttonPayloads: ["custom:Okay"],
      }),
    );
  });

  it("★ a merchant's template needing a value at send time is refused like one with order buttons", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: TPL,
            name: "promo_code",
            language: "en",
            variables: [],
            components: [
              { type: "BODY", text: "Your code" },
              {
                type: "BUTTONS",
                buttons: [{ type: "COPY_CODE", text: "Copy" }],
              },
            ],
            audience: "customer",
            category: "MARKETING",
            eventKey: null,
          },
        ],
      ],
    });
    const r = await sendInboxTemplate({
      conversationId: CONV,
      templateId: TPL,
      values: [],
    });
    expect(r.ok).toBe(false);
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

describe("sendMinkDraft", () => {
  it("★ claims the draft, charges one credit, sends as the person, and marks it sent", async () => {
    const r = await sendMinkDraft({
      conversationId: CONV,
      draftId: DRAFT_ID,
      text: "  Yes, in stock, ₹120.  ",
    });
    expect(r).toEqual({ ok: true, messageId: "m-out" });
    expect(claimMinkDraft).toHaveBeenCalledWith(expect.anything(), {
      storeId: "s1",
      conversationId: CONV,
      draftId: DRAFT_ID,
    });
    expect(chargeMinkAnswer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ answerId: DRAFT_ID, storeId: "s1" }),
    );
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Yes, in stock, ₹120." }),
    );
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: "dashboard",
        payload: { mink: true, answerId: DRAFT_ID },
        sentByAdminId: "admin-1",
      }),
    );
    expect(markMinkAnswerSent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        answerId: DRAFT_ID,
        answer: "Yes, in stock, ₹120.",
        sentMessageId: "m-out",
        sentByAdminId: "admin-1",
      }),
    );
  });

  it("★ no credits: refused with the reason, nothing sent, the draft stays", async () => {
    vi.mocked(chargeMinkAnswer).mockResolvedValueOnce("insufficient");
    const r = await sendMinkDraft({
      conversationId: CONV,
      draftId: DRAFT_ID,
      text: "x",
    });
    expect(r).toMatchObject({ ok: false, code: "no_credits" });
    expect(r.error).toMatch(/1 Mink credit/);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(markMinkAnswerSent).not.toHaveBeenCalled();
  });

  it("a draft already sent or discarded is gone; a closed window and a viewer are refused", async () => {
    vi.mocked(claimMinkDraft).mockResolvedValueOnce(null);
    expect(
      await sendMinkDraft({
        conversationId: CONV,
        draftId: DRAFT_ID,
        text: "x",
      }),
    ).toMatchObject({ ok: false, code: "gone" });
    expect(chargeMinkAnswer).not.toHaveBeenCalled();

    vi.mocked(loadConversation).mockResolvedValue(
      core(new Date(Date.now() - 25 * 3600_000).toISOString()) as any,
    );
    expect(
      await sendMinkDraft({
        conversationId: CONV,
        draftId: DRAFT_ID,
        text: "x",
      }),
    ).toMatchObject({ ok: false, code: "window_closed" });

    access(true, false);
    expect(
      (
        await sendMinkDraft({
          conversationId: CONV,
          draftId: DRAFT_ID,
          text: "x",
        })
      ).error,
    ).toMatch(/permission/);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("a refusal from Meta after the charge keeps the draft and says so", async () => {
    vi.mocked(sendWhatsAppText).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "131047",
      code: 131047,
    });
    const r = await sendMinkDraft({
      conversationId: CONV,
      draftId: DRAFT_ID,
      text: "x",
    });
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(markMinkAnswerSent).not.toHaveBeenCalled();
  });
});

describe("discardMinkDraft, and a reply by hand", () => {
  it("discards the named draft with Inbox: manage", async () => {
    expect(
      await discardMinkDraft({ conversationId: CONV, draftId: DRAFT_ID }),
    ).toEqual({
      ok: true,
    });
    expect(discardMinkDrafts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        storeId: "s1",
        conversationId: CONV,
        draftId: DRAFT_ID,
      }),
    );
    access(true, false);
    expect(
      (await discardMinkDraft({ conversationId: CONV, draftId: DRAFT_ID })).ok,
    ).toBe(false);
  });

  it("★ a person's own reply discards whatever Mink had drafted for the conversation", async () => {
    await sendInboxReply({
      conversationId: CONV,
      text: "I'll check and get back",
    });
    expect(discardMinkDrafts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: CONV,
        reason: "a person replied",
      }),
    );
    expect(vi.mocked(discardMinkDrafts).mock.calls[0][1]).not.toHaveProperty(
      "draftId",
    );
  });
});
