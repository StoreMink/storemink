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
  // The real rule: opted in, and not opted out since.
  consented: (inAt: string | null, outAt: string | null) =>
    Boolean(inAt) &&
    (!outAt || new Date(outAt).getTime() < new Date(inAt!).getTime()),
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
  loadQuotableProviderId: vi.fn(async () => null),
  loadInboxChannelState: vi.fn(async () => ({
    connected: true,
    live: true,
    planAllows: true,
  })),
  listInboxLabels: vi.fn(async () => [
    { id: "l1", name: "VIP", color: "purple" },
  ]),
  listInboxAssignees: vi.fn(async () => [
    { id: "admin-1", name: "Priya" },
    { id: "admin-2", name: "Arjun" },
  ]),
  listCannedReplies: vi.fn(async () => []),
}));
vi.mock("@/lib/whatsapp/inbox-team", () => ({
  assignConversation: vi.fn(async () => ({
    ok: true,
    value: { changed: true, previous: null },
  })),
  setConversationLabel: vi.fn(
    async (_db: unknown, i: { labelId: string; on: boolean }) => ({
      ok: true,
      value: { labelIds: i.on ? [i.labelId] : [] },
    }),
  ),
  saveLabel: vi.fn(async () => ({ ok: true, value: { id: "l-new" } })),
  deleteLabel: vi.fn(async () => ({ ok: true, value: null })),
  addNote: vi.fn(async () => ({ ok: true, value: { id: "n1" } })),
  deleteNote: vi.fn(async () => ({ ok: true, value: null })),
  saveCannedReply: vi.fn(async () => ({ ok: true, value: { id: "r1" } })),
  deleteCannedReply: vi.fn(async () => ({ ok: true, value: null })),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/whatsapp/send", () => ({
  sendWhatsAppText: vi.fn(),
  sendWhatsAppTemplate: vi.fn(),
}));
vi.mock("@/lib/whatsapp/mink-drafts", () => ({
  minkChargeContext: vi.fn(async () => ({ period: "2026-10", planCap: 20 })),
  claimMinkDraft: vi.fn(async () => ({ id: DRAFT_ID, charged: false })),
  chargeMinkAnswer: vi.fn(async () => "plan"),
  markMinkAnswerSent: vi.fn(async () => undefined),
  releaseMinkDraftClaim: vi.fn(async () => undefined),
  discardMinkDrafts: vi.fn(async () => 1),
}));
const DRAFT_ID = vi.hoisted(() => "44444444-4444-4444-8444-444444444444");

import {
  addInboxNote,
  assignInboxConversation,
  discardMinkDraft,
  getInboxChannelState,
  getInboxConversations,
  getInboxWorkspace,
  markInboxRead,
  saveInboxCannedReply,
  saveInboxLabel,
  sendInboxReply,
  sendInboxTemplate,
  sendMinkDraft,
  setInboxConversationLabel,
  setInboxConversationStatus,
} from "./inbox-actions";
import { withService } from "@/lib/db/client";
import { emitEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";
import {
  addNote,
  assignConversation,
  saveCannedReply,
  saveLabel,
  setConversationLabel,
} from "@/lib/whatsapp/inbox-team";
import {
  chargeMinkAnswer,
  claimMinkDraft,
  discardMinkDrafts,
  markMinkAnswerSent,
  releaseMinkDraftClaim,
} from "@/lib/whatsapp/mink-drafts";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import { loadWhatsAppSender } from "@/lib/whatsapp/channel";
import { recordOutboundMessage } from "@/lib/whatsapp/inbox";
import {
  listConversations,
  loadConversation,
  loadInboxChannelState,
  loadQuotableProviderId,
} from "@/lib/whatsapp/inbox-read";
import { sendWhatsAppTemplate, sendWhatsAppText } from "@/lib/whatsapp/send";

const CONV = "22222222-2222-4222-8222-222222222222";
const TPL = "33333333-3333-4333-8333-333333333333";

const core = (
  lastInboundAt: string | null,
  consent: {
    marketingOptInAt?: string | null;
    marketingOptOutAt?: string | null;
  } = {},
) => ({
  id: CONV,
  status: "needs_reply",
  unreadCount: 1,
  lastMessageAt: lastInboundAt,
  lastInboundAt,
  lastPreview: "hi",
  assignedAdminId: null,
  labelIds: [],
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
    ...consent,
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
      replyToProviderId: null,
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

  describe("★ a MARKETING template and the customer's yes to offers", () => {
    const promo = () =>
      makeDbMock({
        selectQueue: [
          [
            {
              id: TPL,
              name: "diwali_offer",
              language: "en",
              variables: ["customer_name"],
              components: [{ type: "BODY", text: "Hi {{1}}, 20% off." }],
              audience: "customer",
              category: "MARKETING",
              eventKey: null,
            },
          ],
        ],
      });
    const send = () =>
      sendInboxTemplate({
        conversationId: CONV,
        templateId: TPL,
        values: ["Rohan"],
      });
    const now = Date.now();
    const at = (hoursAgo: number) =>
      new Date(now - hoursAgo * 3600_000).toISOString();

    it("refuses a customer who replied STOP, and sends nothing", async () => {
      dbHolder.current = promo();
      vi.mocked(loadConversation).mockResolvedValue(
        core(at(1), {
          marketingOptInAt: at(48),
          marketingOptOutAt: at(2),
        }) as any,
      );
      const r = await send();
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/opted out of offers/);
      expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(recordOutboundMessage).not.toHaveBeenCalled();
    });

    it("refuses a customer who never agreed to offers", async () => {
      dbHolder.current = promo();
      const r = await send();
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/hasn't agreed to receive offers/);
      expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
    });

    it("sends to a customer whose yes is in force, an opt-out before it included", async () => {
      dbHolder.current = promo();
      vi.mocked(loadConversation).mockResolvedValue(
        core(at(1), {
          marketingOptInAt: at(3),
          marketingOptOutAt: at(30),
        }) as any,
      );
      expect(await send()).toEqual({ ok: true, messageId: "m-out" });
      expect(sendWhatsAppTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ category: "MARKETING" }),
      );
    });

    it("a UTILITY template needs no offers consent", async () => {
      // The default row is UTILITY and the contact has agreed to nothing.
      vi.mocked(loadConversation).mockResolvedValue(
        core(at(1), { marketingOptOutAt: at(2) }) as any,
      );
      const r = await sendInboxTemplate({
        conversationId: CONV,
        templateId: TPL,
        values: ["Rohan", "ORD1"],
      });
      expect(r.ok).toBe(true);
    });
  });
});

describe("sendMinkDraft", () => {
  // ★ The default mock hands every withService call the SAME db, so "the same
  // transaction" could not fail. Here each call gets its own handle.
  function separateTransactions() {
    vi.mocked(withService).mockImplementation(((fn: any) =>
      Promise.resolve(fn(Object.create(dbHolder.current.db)))) as any);
  }

  it("★ claims the draft, charges one credit, sends as the person, and marks it sent", async () => {
    separateTransactions();
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
    // The claim and the charge are one transaction; filing is a later one.
    const claimTx = vi.mocked(claimMinkDraft).mock.calls[0][0];
    expect(vi.mocked(chargeMinkAnswer).mock.calls[0][0]).toBe(claimTx);
    expect(vi.mocked(markMinkAnswerSent).mock.calls[0][0]).not.toBe(claimTx);
    expect(releaseMinkDraftClaim).not.toHaveBeenCalled();
  });

  it("★ no credits: refused with the reason, nothing sent, the draft stays", async () => {
    separateTransactions();
    vi.mocked(chargeMinkAnswer).mockResolvedValueOnce("insufficient");
    const r = await sendMinkDraft({
      conversationId: CONV,
      draftId: DRAFT_ID,
      text: "x",
    });
    expect(r).toMatchObject({ ok: false, code: "no_credits" });
    expect(r.error).toMatch(/no Mink credits left/);
    expect(r.error).not.toMatch(/\d+\s*Mink credits?/);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(markMinkAnswerSent).not.toHaveBeenCalled();
    // ★ The send lease the claim took is given back in the SAME transaction,
    // or the draft stays taken, and off the screen, until it runs out.
    expect(releaseMinkDraftClaim).toHaveBeenCalledTimes(1);
    expect(releaseMinkDraftClaim).toHaveBeenCalledWith(expect.anything(), {
      storeId: "s1",
      answerId: DRAFT_ID,
    });
    // Identity, not equality: two transaction handles are deep-equal.
    expect(vi.mocked(releaseMinkDraftClaim).mock.calls[0][0]).toBe(
      vi.mocked(claimMinkDraft).mock.calls[0][0],
    );
  });

  it("★ a draft that went out but could not be filed is still marked sent, so it cannot go twice", async () => {
    vi.mocked(recordOutboundMessage).mockRejectedValueOnce(new Error("db"));
    const r = await sendMinkDraft({
      conversationId: CONV,
      draftId: DRAFT_ID,
      text: "Yes",
    });
    expect(r.ok).toBe(true);
    expect(markMinkAnswerSent).toHaveBeenCalledTimes(1);
    expect(markMinkAnswerSent).toHaveBeenCalledWith(expect.anything(), {
      storeId: "s1",
      answerId: DRAFT_ID,
      answer: "Yes",
      sentMessageId: null,
      sentByAdminId: "admin-1",
    });
    expect(releaseMinkDraftClaim).not.toHaveBeenCalled();
  });

  it("a draft that went out keeps its lease until it is marked sent", async () => {
    await sendMinkDraft({ conversationId: CONV, draftId: DRAFT_ID, text: "x" });
    expect(markMinkAnswerSent).toHaveBeenCalled();
    expect(releaseMinkDraftClaim).not.toHaveBeenCalled();
  });

  it("a draft already sent or discarded is gone; a closed window and a viewer are refused", async () => {
    // ★ A refused claim now also means a send in flight (its lease is live)
    // or a person who answered since, and the copy says all three.
    vi.mocked(claimMinkDraft).mockResolvedValueOnce(null);
    expect(
      await sendMinkDraft({
        conversationId: CONV,
        draftId: DRAFT_ID,
        text: "x",
      }),
    ).toEqual({
      ok: false,
      code: "gone",
      error:
        "This draft is being sent, was already sent or discarded, or someone replied since.",
    });
    expect(chargeMinkAnswer).not.toHaveBeenCalled();
    expect(releaseMinkDraftClaim).not.toHaveBeenCalled();

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

  it("★ a refusal from Meta keeps the draft, gives its send lease back and says so", async () => {
    separateTransactions();
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
    expect(releaseMinkDraftClaim).toHaveBeenCalledWith(expect.anything(), {
      storeId: "s1",
      answerId: DRAFT_ID,
    });
    // The claim's transaction committed long ago: the release has its own.
    expect(vi.mocked(releaseMinkDraftClaim).mock.calls[0][0]).not.toBe(
      vi.mocked(claimMinkDraft).mock.calls[0][0],
    );
  });

  it("nothing to send (skipped) gives the lease back too", async () => {
    vi.mocked(sendWhatsAppText).mockResolvedValue({
      sent: false,
      outcome: "skipped",
      error: "No phone number.",
    });
    await sendMinkDraft({ conversationId: CONV, draftId: DRAFT_ID, text: "x" });
    expect(releaseMinkDraftClaim).toHaveBeenCalledTimes(1);
  });

  it("★ an UNKNOWN outcome keeps the lease: the message may have gone, so no second Send yet", async () => {
    vi.mocked(sendWhatsAppText).mockResolvedValue({
      sent: false,
      outcome: "unknown",
      error: "timeout",
    });
    const r = await sendMinkDraft({
      conversationId: CONV,
      draftId: DRAFT_ID,
      text: "x",
    });
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(r.error).toMatch(/didn't confirm/);
    expect(releaseMinkDraftClaim).not.toHaveBeenCalled();
  });

  it("a release that fails is logged and changes nothing the person is told", async () => {
    vi.mocked(sendWhatsAppText).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "131047",
      code: 131047,
    });
    vi.mocked(releaseMinkDraftClaim).mockRejectedValueOnce(new Error("db"));
    const r = await sendMinkDraft({
      conversationId: CONV,
      draftId: DRAFT_ID,
      text: "x",
    });
    expect(r).toMatchObject({
      ok: false,
      code: "refused",
      error: "Meta refused the message: 131047",
    });
    expect(logError).toHaveBeenCalledWith(
      "inbox: release mink draft failed",
      expect.any(Error),
      { storeId: "s1" },
    );
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

describe("working as a team (slice 6)", () => {
  const MSG = "55555555-5555-4555-8555-555555555555";
  const LABEL = "66666666-6666-4666-8666-666666666666";

  it("the list passes the assignee and label filters and who is asking", async () => {
    await getInboxConversations({
      filter: "open",
      assignee: "me",
      label: LABEL,
    });
    expect(listConversations).toHaveBeenCalledWith("s1", {
      filter: "open",
      q: "",
      page: 1,
      assignee: "me",
      label: LABEL,
      viewerId: "admin-1",
    });
  });

  it("the workspace names the viewer among the store's people", async () => {
    const r = await getInboxWorkspace();
    expect(r.workspace.me).toEqual({ id: "admin-1", name: "Priya" });
    expect(r.workspace.labels).toHaveLength(1);
  });

  it("★ a reply that quotes a message looks the message up in ITS conversation and sends the quote", async () => {
    vi.mocked(loadQuotableProviderId).mockResolvedValue("wamid.in1");
    const r = await sendInboxReply({
      conversationId: CONV,
      text: "Yes",
      replyToMessageId: MSG,
    });
    expect(r.ok).toBe(true);
    expect(loadQuotableProviderId).toHaveBeenCalledWith("s1", CONV, MSG);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({ replyToProviderId: "wamid.in1" }),
    );
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quotedProviderId: "wamid.in1" }),
    );
  });

  it("a quote of a message that is not in the thread quotes nothing rather than failing", async () => {
    vi.mocked(loadQuotableProviderId).mockResolvedValue(null);
    const r = await sendInboxReply({
      conversationId: CONV,
      text: "Yes",
      replyToMessageId: MSG,
    });
    expect(r.ok).toBe(true);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({ replyToProviderId: null }),
    );
  });

  it("★ assigning tells only the person it was given to, never the whole team, and not yourself", async () => {
    const r = await assignInboxConversation({
      conversationId: CONV,
      adminId: "admin-2",
    });
    expect(r).toEqual({ ok: true, assignedAdminId: "admin-2" });
    expect(assignConversation).toHaveBeenCalledWith(expect.anything(), {
      storeId: "s1",
      conversationId: CONV,
      adminId: "admin-2",
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "whatsapp.conversation_assigned",
        storeId: "s1",
        restrictToAdminIds: ["admin-2"],
        payload: { assignedBy: "Priya" },
        subject: expect.objectContaining({ id: CONV, label: "Rohan" }),
      }),
    );
    vi.mocked(emitEvent).mockClear();
    await assignInboxConversation({ conversationId: CONV, adminId: "admin-1" });
    expect(emitEvent).not.toHaveBeenCalled();
    await assignInboxConversation({ conversationId: CONV, adminId: null });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("assignment needs Inbox manage, and a refused assignee is reported", async () => {
    access(true, false);
    expect(
      (await assignInboxConversation({ conversationId: CONV, adminId: "x" }))
        .ok,
    ).toBe(false);
    access(true, true);
    vi.mocked(assignConversation).mockResolvedValueOnce({
      ok: false,
      code: "not_found",
      error: "That person is not on this store.",
    });
    const r = await assignInboxConversation({
      conversationId: CONV,
      adminId: "x",
    });
    expect(r).toMatchObject({
      ok: false,
      error: "That person is not on this store.",
    });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("★ labels change ONE at a time: the write gets the label and the direction, never a set", async () => {
    const r = await setInboxConversationLabel({
      conversationId: CONV,
      labelId: LABEL,
      on: true,
    });
    expect(r).toEqual({ ok: true, labelIds: [LABEL] });
    expect(setConversationLabel).toHaveBeenCalledWith(expect.anything(), {
      storeId: "s1",
      conversationId: CONV,
      labelId: LABEL,
      on: true,
    });
    expect(
      await setInboxConversationLabel({
        conversationId: CONV,
        labelId: LABEL,
        on: false,
      }),
    ).toEqual({ ok: true, labelIds: [] });
  });

  it("labels: a malformed id or direction never reaches the write, and a viewer cannot label", async () => {
    expect(
      (
        await setInboxConversationLabel({
          conversationId: CONV,
          labelId: "junk",
          on: true,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await setInboxConversationLabel({
          conversationId: CONV,
          labelId: LABEL,
          on: "yes" as any,
        })
      ).ok,
    ).toBe(false);
    access(true, false);
    expect(
      (
        await setInboxConversationLabel({
          conversationId: CONV,
          labelId: LABEL,
          on: true,
        })
      ).error,
    ).toMatch(/permission/);
    expect(setConversationLabel).not.toHaveBeenCalled();
  });

  it("labels: a refusal from the write (a label deleted meanwhile) is reported", async () => {
    vi.mocked(setConversationLabel).mockResolvedValueOnce({
      ok: false,
      code: "not_found",
      error: "That label no longer exists.",
    });
    expect(
      await setInboxConversationLabel({
        conversationId: CONV,
        labelId: LABEL,
        on: true,
      }),
    ).toEqual({ ok: false, error: "That label no longer exists." });
  });

  it("a note is written under the person who wrote it", async () => {
    const r = await addInboxNote({ conversationId: CONV, body: "Bulk buyer" });
    expect(r).toEqual({ ok: true, id: "n1" });
    expect(addNote).toHaveBeenCalledWith(expect.anything(), {
      storeId: "s1",
      conversationId: CONV,
      adminId: "admin-1",
      body: "Bulk buyer",
    });
  });

  it("labels and saved replies are saved under the store, and a bad id is refused before any write", async () => {
    await saveInboxLabel({ name: "VIP", color: "purple" });
    expect(saveLabel).toHaveBeenCalledWith(expect.anything(), {
      storeId: "s1",
      id: null,
      name: "VIP",
      color: "purple",
    });
    expect(
      (await saveInboxLabel({ id: "nope", name: "x", color: "red" })).ok,
    ).toBe(false);
    await saveInboxCannedReply({
      shortcut: "hours",
      title: "Hours",
      body: "10 to 7",
    });
    expect(saveCannedReply).toHaveBeenCalledWith(expect.anything(), {
      storeId: "s1",
      id: null,
      adminId: "admin-1",
      shortcut: "hours",
      title: "Hours",
      body: "10 to 7",
    });
    // A duplicate name is the unique index speaking, in merchant words.
    vi.mocked(saveLabel).mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "23505" }),
    );
    expect(
      await saveInboxLabel({ name: "VIP", color: "purple" }),
    ).toMatchObject({
      ok: false,
      error: "A label with that name already exists.",
    });
  });

  // drizzle-orm wraps every pg error in a DrizzleQueryError whose own message
  // is "Failed query: …"; the SQLSTATE is on `.cause`.
  const wrapped = (code: string) =>
    Object.assign(new Error("Failed query: insert …"), {
      cause: Object.assign(new Error("duplicate key"), { code }),
    });

  it("★ a duplicate label name is recognised through drizzle's wrapper, not logged as a failure", async () => {
    vi.mocked(saveLabel).mockRejectedValueOnce(wrapped("23505"));
    expect(await saveInboxLabel({ name: "vip", color: "red" })).toEqual({
      ok: false,
      error: "A label with that name already exists.",
    });
    expect(logError).not.toHaveBeenCalled();
    // Any other database failure is still a logged failure.
    vi.mocked(saveLabel).mockRejectedValueOnce(wrapped("40001"));
    expect(await saveInboxLabel({ name: "vip", color: "red" })).toEqual({
      ok: false,
      error: "Couldn't save the label.",
    });
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("★ a taken shortcut is recognised through drizzle's wrapper too", async () => {
    vi.mocked(saveCannedReply).mockRejectedValueOnce(wrapped("23505"));
    expect(
      await saveInboxCannedReply({
        shortcut: "hours",
        title: "Hours",
        body: "10 to 7",
      }),
    ).toEqual({ ok: false, error: "That shortcut is already in use." });
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("getInboxChannelState", () => {
  it("★ answers anyone with Inbox view, from the store's own row, with no Channels permission asked", async () => {
    access(true, false);
    vi.mocked(loadInboxChannelState).mockResolvedValueOnce({
      connected: true,
      live: false,
      planAllows: true,
    });
    expect(await getInboxChannelState()).toEqual({
      channel: { connected: true, live: false, planAllows: true },
    });
    expect(loadInboxChannelState).toHaveBeenCalledWith("s1");
  });

  it("an unreadable state is an error, never 'not connected'; no Inbox view, no answer", async () => {
    vi.mocked(loadInboxChannelState).mockRejectedValueOnce(new Error("db"));
    const r = await getInboxChannelState();
    expect(r.channel).toBeNull();
    expect(r.error).toMatch(/Couldn't check your WhatsApp number/);
    access(false, false);
    expect((await getInboxChannelState()).error).toMatch(/permission/);
  });
});
