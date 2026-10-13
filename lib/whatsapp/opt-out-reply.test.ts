/* eslint-disable @typescript-eslint/no-explicit-any */
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
vi.mock("./channel", () => ({ loadWhatsAppSender: vi.fn() }));
vi.mock("./send", () => ({ sendWhatsAppText: vi.fn() }));
vi.mock("./inbox", () => ({ recordOutboundMessage: vi.fn(async () => "m") }));

import { answerOptOut, optOutReplyText } from "./opt-out-reply";
import { loadWhatsAppSender } from "./channel";
import { sendWhatsAppText } from "./send";
import { recordOutboundMessage } from "./inbox";

const STORE = "11111111-1111-4111-8111-111111111111";
const PHONE = "+919876543210";

beforeEach(() => {
  dbHolder.current = makeDbMock({ selectQueue: [[{ name: "Acme Juice" }]] });
  vi.mocked(loadWhatsAppSender).mockResolvedValue({
    token: "tok",
    wabaId: "W",
    phoneNumberId: "P",
    displayPhone: "+91",
    precedence: "whatsapp_first",
    codConfirmation: false,
  });
  vi.mocked(sendWhatsAppText).mockResolvedValue({
    sent: true,
    messageId: "wamid.r",
    logId: null,
  });
});

describe("optOutReplyText", () => {
  it("★ STOP says offers end and order updates do not", () => {
    const t = optOutReplyText("stop", "Acme Juice");
    expect(t).toContain("Acme Juice");
    expect(t).toContain("still get updates about your orders");
    // START works only for somebody who agreed to offers before, so the reply
    // must not promise it to everyone.
    expect(t).not.toContain("START");
    expect(t).not.toMatch(/[—–]/);
  });

  it("START says offers are back and how to stop them", () => {
    const t = optOutReplyText("start", null);
    expect(t).toContain("this shop");
    expect(t).toContain("STOP");
    expect(t).not.toMatch(/[—–]/);
  });
});

describe("answerOptOut", () => {
  it("answers in the chat, through the choke point, filed as automation", async () => {
    await answerOptOut({
      storeId: STORE,
      conversationId: "conv-1",
      phone: PHONE,
      intent: "stop",
    });
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE,
        to: PHONE,
        body: expect.stringContaining("offers from Acme Juice"),
      }),
    );
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: "conv-1",
        source: "automation",
        status: "sent",
        providerMessageId: "wamid.r",
      }),
    );
  });

  it("a paused number cannot answer, and nothing is filed", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(null);
    await answerOptOut({
      storeId: STORE,
      conversationId: "conv-1",
      phone: PHONE,
      intent: "stop",
    });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(recordOutboundMessage).not.toHaveBeenCalled();
  });

  it("a failed send is filed as failed with Meta's reason, and never throws", async () => {
    vi.mocked(sendWhatsAppText).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Outside window",
    });
    await expect(
      answerOptOut({
        storeId: STORE,
        conversationId: "conv-1",
        phone: PHONE,
        intent: "start",
      }),
    ).resolves.toBeUndefined();
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", error: "Outside window" }),
    );
  });
});
