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
  answersOrderQuestions: vi.fn(async () => true),
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
import { answersOrderQuestions } from "./auto-reply-store";
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
  welcomeEligible: true,
  phone: "+919876543210",
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
    });
    // ★ A welcome or away message does not answer the customer.
    expect(handOverConversation).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "whatsapp.message_received" }),
    );
  });

  it("★ the order-question setting is read only for a message that reads as one", async () => {
    await processPendingInboundEvents();
    expect(answersOrderQuestions).not.toHaveBeenCalled();
    expect(vi.mocked(recordInboundMessage).mock.calls[0][1]).toMatchObject({
      answersOrderQuestions: false,
    });

    setup("where is my order");
    await processPendingInboundEvents();
    expect(answersOrderQuestions).toHaveBeenCalledWith(STORE);
    expect(vi.mocked(recordInboundMessage).mock.calls[1][1]).toMatchObject({
      answersOrderQuestions: true,
    });
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
