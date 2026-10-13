/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// What processing does for the store's automatic replies: the order-question
// setting is read only for a message that reads as one, and outside the
// filing transaction; the replies run once the message is filed; a question
// the system could not answer goes to a person with the bell. The replies
// themselves are answer-automatically.test.ts; the filing is inbox.test.ts.
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
vi.mock("@/lib/notifications/record", () => ({
  recordEvent: vi.fn(async () => undefined),
}));
vi.mock("./cod-confirmation", () => ({ handleCodReply: vi.fn() }));
vi.mock("./opt-out-reply", () => ({
  answerOptOut: vi.fn(async () => undefined),
}));
vi.mock("./answer-automatically", () => ({
  answerAutomatically: vi.fn(async () => ({ handOver: false, sent: [] })),
}));
vi.mock("./auto-reply-store", () => ({
  loadAutoReplyFlags: vi.fn(async () => ({
    orderStatus: true,
    menu: true,
    minkMode: "off",
  })),
}));
vi.mock("./menu-reply", () => ({
  handleMenuReply: vi.fn(async () => ({
    outcome: "text",
    needsHuman: false,
  })),
}));
vi.mock("./mink-answer", () => ({
  answerWithMink: vi.fn(async () => ({
    outcome: "sent",
    needsHuman: false,
    answerId: "a1",
    reason: "",
  })),
}));
vi.mock("./inbox", () => ({
  applyStatusToMessage: vi.fn(),
  handOverConversation: vi.fn(async () => true),
  hasMedia: vi.fn(() => false),
  recordEchoMessage: vi.fn(),
  recordInboundMessage: vi.fn(),
  storeInboundMedia: vi.fn(),
}));

import { processPendingInboundEvents } from "./inbound";
import { answerAutomatically } from "./answer-automatically";
import { loadAutoReplyFlags } from "./auto-reply-store";
import { handleMenuReply } from "./menu-reply";
import { answerWithMink } from "./mink-answer";
import { handOverConversation, recordInboundMessage } from "./inbox";
import { recordEvent } from "@/lib/notifications/record";

const STORE = "11111111-1111-4111-8111-111111111111";

const FILED = {
  inserted: true,
  contactId: "k1",
  conversationId: "c1",
  messageId: "m1",
  userId: "u1",
  needsNotify: true,
  kind: "text",
  preview: "Is it in stock?",
  contactLabel: "Rohan",
  media: null,
  codReply: null,
  optOut: null,
  orderQuestion: false,
  menuReply: null,
  welcomeEligible: true,
  phone: "+919876543210",
  minkAnswer: null,
  body: "Is it in stock?",
};

function setup(body: string, filed: Record<string, unknown> = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [
        {
          id: "ev1",
          storeId: STORE,
          wabaId: "W",
          phoneNumberId: "P",
          field: "messages",
          payload: {
            kind: "message",
            message: { type: "text", text: { body } },
          },
        },
      ],
    ],
  });
  vi.mocked(recordInboundMessage).mockResolvedValue({
    ...FILED,
    ...filed,
  } as any);
}

beforeEach(() => setup("Is it in stock?"));

describe("automatic replies after filing", () => {
  it("an ordinary message: the replies run, and the bell rings as before", async () => {
    await processPendingInboundEvents();
    expect(answerAutomatically).toHaveBeenCalledWith({
      storeId: STORE,
      conversationId: "c1",
      phone: "+919876543210",
      userId: "u1",
      kind: "text",
      orderQuestion: false,
      welcomeEligible: true,
      menuRequest: false,
    });
    // ★ A welcome or away message does not answer the customer.
    expect(handOverConversation).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "whatsapp.message_received" }),
    );
  });

  it("★ the settings are read once for every text message (Mink may be on), and never for a photo", async () => {
    await processPendingInboundEvents();
    expect(loadAutoReplyFlags).toHaveBeenCalledTimes(1);
    expect(loadAutoReplyFlags).toHaveBeenCalledWith(STORE);
    expect(vi.mocked(recordInboundMessage).mock.calls[0][1]).toMatchObject({
      answersOrderQuestions: true,
      hasMenu: true,
      minkMode: "off",
    });

    // A photo carries no words: nothing to answer, nothing read.
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "ev2",
            storeId: STORE,
            wabaId: "W",
            phoneNumberId: "P",
            field: "messages",
            payload: {
              kind: "message",
              message: { type: "image", image: { id: "img" } },
            },
          },
        ],
      ],
    });
    vi.mocked(loadAutoReplyFlags).mockClear();
    await processPendingInboundEvents();
    expect(loadAutoReplyFlags).not.toHaveBeenCalled();
    expect(vi.mocked(recordInboundMessage).mock.calls[1][1]).toMatchObject({
      answersOrderQuestions: false,
      hasMenu: false,
      minkMode: "off",
    });

    setup("menu");
    vi.mocked(loadAutoReplyFlags).mockResolvedValueOnce({
      orderStatus: true,
      menu: true,
      minkMode: "helps",
    });
    await processPendingInboundEvents();
    expect(vi.mocked(recordInboundMessage).mock.calls[2][1]).toMatchObject({
      answersOrderQuestions: true,
      hasMenu: true,
      minkMode: "helps",
    });
  });

  it("★ a question Mink answers (helps): asked after the replies, no hand-over, no bell", async () => {
    setup("Do you have it in blue?", {
      minkAnswer: "helps",
      body: "Do you have it in blue?",
      needsNotify: false,
    });
    await processPendingInboundEvents();
    expect(answerAutomatically).toHaveBeenCalled();
    expect(answerWithMink).toHaveBeenCalledWith({
      storeId: STORE,
      conversationId: "c1",
      messageId: "m1",
      phone: "+919876543210",
      userId: "u1",
      mode: "helps",
      text: "Do you have it in blue?",
    });
    expect(handOverConversation).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("★ what Mink could not answer (helps) goes to a person, with the bell", async () => {
    setup("Do you have it in blue?", {
      minkAnswer: "helps",
      body: "Do you have it in blue?",
      needsNotify: false,
    });
    vi.mocked(answerWithMink).mockResolvedValueOnce({
      outcome: "draft",
      needsHuman: true,
      answerId: "a1",
      reason: "not in facts",
    });
    await processPendingInboundEvents();
    expect(handOverConversation).toHaveBeenCalledWith(
      expect.anything(),
      STORE,
      "c1",
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "whatsapp.message_received" }),
    );

    // A failure in Mink is a hand-over too, never a failed event.
    setup("Do you have it in blue?", {
      minkAnswer: "helps",
      body: "Do you have it in blue?",
      needsNotify: false,
    });
    vi.mocked(answerWithMink).mockRejectedValueOnce(new Error("boom"));
    const r = await processPendingInboundEvents();
    expect(r).toMatchObject({ processed: 1, failed: 0 });
    expect(handOverConversation).toHaveBeenCalled();
  });

  it("★ a draft (drafts mode) is asked for, and the message rings as it always did", async () => {
    setup("Do you have it in blue?", {
      minkAnswer: "drafts",
      body: "Do you have it in blue?",
      needsNotify: true,
    });
    vi.mocked(answerWithMink).mockResolvedValueOnce({
      outcome: "draft",
      needsHuman: false,
      answerId: "a1",
      reason: "",
    });
    await processPendingInboundEvents();
    expect(answerWithMink).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "drafts" }),
    );
    expect(handOverConversation).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it("★ a menu request goes to the replies as one, and a dead reply hands over", async () => {
    setup("menu", { menuReply: "menu", needsNotify: false });
    await processPendingInboundEvents();
    expect(answerAutomatically).toHaveBeenCalledWith(
      expect.objectContaining({ menuRequest: true }),
    );
    expect(handleMenuReply).not.toHaveBeenCalled();
    expect(handOverConversation).not.toHaveBeenCalled();

    setup("menu", { menuReply: "menu", needsNotify: false });
    vi.mocked(answerAutomatically).mockRejectedValueOnce(new Error("boom"));
    await processPendingInboundEvents();
    expect(handOverConversation).toHaveBeenCalled();
  });

  it("★ a tap on a menu button is handled by the menu, and hands over only when it says so", async () => {
    setup("Check my order", {
      menuReply: "b1",
      kind: "interactive",
      needsNotify: false,
    });
    await processPendingInboundEvents();
    expect(handleMenuReply).toHaveBeenCalledWith({
      storeId: STORE,
      conversationId: "c1",
      phone: "+919876543210",
      userId: "u1",
      buttonId: "b1",
    });
    expect(answerAutomatically).not.toHaveBeenCalled();
    expect(handOverConversation).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();

    setup("Talk to a person", {
      menuReply: "b2",
      kind: "interactive",
      needsNotify: false,
    });
    vi.mocked(handleMenuReply).mockResolvedValueOnce({
      outcome: "person",
      needsHuman: true,
    });
    await processPendingInboundEvents();
    expect(handOverConversation).toHaveBeenCalledWith(
      expect.anything(),
      STORE,
      "c1",
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "whatsapp.message_received" }),
    );
  });

  it("★ an order question answered by the system: no hand-over, no bell", async () => {
    setup("where is my order", { orderQuestion: true, needsNotify: false });
    await processPendingInboundEvents();
    expect(handOverConversation).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("★ one the system could not answer goes to a person, with the bell", async () => {
    setup("where is my order", { orderQuestion: true, needsNotify: false });
    vi.mocked(answerAutomatically).mockResolvedValueOnce({
      handOver: true,
      sent: ["order_status"],
    });
    await processPendingInboundEvents();
    expect(handOverConversation).toHaveBeenCalledWith(
      expect.anything(),
      STORE,
      "c1",
    );
    expect(recordEvent).toHaveBeenCalled();
  });

  it("a failure in the replies hands an order question to a person, and never fails the event", async () => {
    setup("where is my order", { orderQuestion: true, needsNotify: false });
    vi.mocked(answerAutomatically).mockRejectedValueOnce(new Error("boom"));
    const r = await processPendingInboundEvents();
    expect(r).toMatchObject({ processed: 1, failed: 0 });
    expect(handOverConversation).toHaveBeenCalled();
  });

  it("a STOP gets its own answer and no automatic reply on top", async () => {
    setup("STOP", { optOut: "stop", needsNotify: false });
    await processPendingInboundEvents();
    expect(answerAutomatically).not.toHaveBeenCalled();
  });
});
