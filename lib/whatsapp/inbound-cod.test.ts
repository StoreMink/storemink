/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// What processing does with a COD button tap once the message is filed: act on
// it, and only when that cannot be done hand the conversation to a person and
// ring the bell. The filing itself is inbox.test.ts; the action is
// cod-confirmation.test.ts.
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
  answersOrderQuestions: vi.fn(async () => false),
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
import { handleCodReply } from "./cod-confirmation";
import { answerOptOut } from "./opt-out-reply";
import { handOverConversation, recordInboundMessage } from "./inbox";
import { answerAutomatically } from "./answer-automatically";
import { recordEvent } from "@/lib/notifications/record";

const STORE = "11111111-1111-4111-8111-111111111111";
const ORDER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const FILED = {
  inserted: true,
  contactId: "k1",
  conversationId: "c1",
  messageId: "m1",
  userId: null,
  needsNotify: false,
  kind: "button",
  preview: "Cancel order",
  contactLabel: "Rohan",
  media: null,
  codReply: { action: "cancel", orderId: ORDER },
  phone: "+919876543210",
};

function setup() {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [
        {
          id: "ev1",
          storeId: STORE,
          wabaId: "W",
          phoneNumberId: "P",
          field: "messages",
          payload: { kind: "message" },
        },
      ],
    ],
  });
  vi.mocked(recordInboundMessage).mockResolvedValue(FILED as any);
  return dbHolder.current;
}

beforeEach(() => setup());

describe("a COD tap after filing", () => {
  it("★ handled: no hand-over and no bell", async () => {
    vi.mocked(handleCodReply).mockResolvedValue({
      outcome: "cancelled",
      needsHuman: false,
    });
    const mock = dbHolder.current;
    await processPendingInboundEvents();
    expect(handleCodReply).toHaveBeenCalledWith({
      storeId: STORE,
      conversationId: "c1",
      phone: "+919876543210",
      contactLabel: "Rohan",
      reply: { action: "cancel", orderId: ORDER },
    });
    expect(mock.calls.execute).toHaveLength(0);
    expect(handOverConversation).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    // ★ A COD tap has its own answer: no welcome or away message on top.
    expect(answerAutomatically).not.toHaveBeenCalled();
  });

  it("★ refused or too late: the conversation needs a reply and the team is told", async () => {
    vi.mocked(handleCodReply).mockResolvedValue({
      outcome: "too_late",
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

  it("★ a hand-over of a conversation already waiting does not ring again", async () => {
    vi.mocked(handleCodReply).mockResolvedValue({
      outcome: "too_late",
      needsHuman: true,
    });
    vi.mocked(handOverConversation).mockResolvedValueOnce(false);
    await processPendingInboundEvents();
    expect(handOverConversation).toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("a handler that throws is treated as needing a person", async () => {
    vi.mocked(handleCodReply).mockRejectedValue(new Error("boom"));
    const r = await processPendingInboundEvents();
    expect(r).toMatchObject({ processed: 1, failed: 0 });
    expect(recordEvent).toHaveBeenCalled();
  });

  it("a redelivered tap does nothing at all", async () => {
    vi.mocked(recordInboundMessage).mockResolvedValue({
      ...FILED,
      inserted: false,
    } as any);
    await processPendingInboundEvents();
    expect(handleCodReply).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

describe("a STOP after filing", () => {
  it("★ is acknowledged in the chat, without the bell", async () => {
    vi.mocked(recordInboundMessage).mockResolvedValue({
      ...FILED,
      kind: "text",
      preview: "STOP",
      codReply: null,
      optOut: "stop",
    } as any);
    await processPendingInboundEvents();
    expect(answerOptOut).toHaveBeenCalledWith({
      storeId: STORE,
      conversationId: "c1",
      phone: "+919876543210",
      intent: "stop",
    });
    expect(handleCodReply).not.toHaveBeenCalled();
    expect(answerAutomatically).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("an ordinary message gets no opt-out answer", async () => {
    vi.mocked(recordInboundMessage).mockResolvedValue({
      ...FILED,
      kind: "text",
      codReply: null,
      optOut: null,
      needsNotify: true,
    } as any);
    await processPendingInboundEvents();
    expect(answerOptOut).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalled();
  });
});
