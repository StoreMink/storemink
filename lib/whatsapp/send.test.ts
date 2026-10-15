/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("./graph", () => ({
  sendTemplateMessage: vi.fn(),
  sendTextMessage: vi.fn(),
  sendInteractiveMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  sendInteractiveMessage,
  sendMediaMessage,
  sendTemplateMessage,
} from "./graph";
import {
  sendWhatsAppInteractive,
  sendWhatsAppMedia,
  sendWhatsAppTemplate,
} from "./send";
import { whatsappLogs } from "@/drizzle/schema";

const INPUT = {
  storeId: "store-1",
  to: "+919876543210",
  token: "tok",
  phoneNumberId: "P",
  template: {
    id: "t1",
    name: "sm_order_placed_customer_v1",
    language: "en",
    body: "Thanks for your order with {{1}}. Order {{2}}.",
  },
  values: ["Acme", "ORD1"],
  eventKey: "order.placed",
};

function loggedRow() {
  const idx = dbHolder.current.calls.insert.findIndex(
    (t: any) => t === whatsappLogs,
  );
  return idx === -1 ? null : dbHolder.current.calls.values[idx];
}

beforeEach(() => {
  dbHolder.current = makeDbMock({ returning: [{ id: "log-1" }] });
});

describe("sendWhatsAppTemplate", () => {
  it("sends digits-only, with formatted positional parameters, and logs the id", async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({
      ok: true,
      data: { messages: [{ id: "wamid.1" }] },
    });
    const r = await sendWhatsAppTemplate(INPUT);
    expect(r).toEqual({ sent: true, messageId: "wamid.1", logId: "log-1" });
    expect(sendTemplateMessage).toHaveBeenCalledWith("tok", "P", {
      to: "919876543210",
      name: "sm_order_placed_customer_v1",
      language: "en",
      bodyParams: ["Acme", "ORD1"],
    });
    expect(loggedRow()).toMatchObject({
      status: "sent",
      providerMessageId: "wamid.1",
      toPhone: "+919876543210",
      eventKey: "order.placed",
      body: "Thanks for your order with Acme. Order ORD1.",
    });
  });

  it("never sends an empty parameter — a missing value becomes a dash", async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({
      ok: true,
      data: { messages: [{ id: "wamid.2" }] },
    });
    await sendWhatsAppTemplate({ ...INPUT, values: ["Acme", ""] });
    expect(vi.mocked(sendTemplateMessage).mock.calls[0]![2].bodyParams).toEqual(
      ["Acme", "-"],
    );
  });

  it("reports a rejection with Meta's code and logs it failed", async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "Not a WhatsApp user",
      code: 131026,
    });
    const r = await sendWhatsAppTemplate(INPUT);
    expect(r).toMatchObject({ sent: false, outcome: "rejected", code: 131026 });
    expect(loggedRow()).toMatchObject({
      status: "failed",
      errorCode: 131026,
      error: "Not a WhatsApp user",
    });
  });

  it("★ reports unknown as unknown — logged failed, never retried by the caller", async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({
      ok: false,
      outcome: "unknown",
      error: "Meta 503.",
    });
    const r = await sendWhatsAppTemplate(INPUT);
    expect(r).toMatchObject({ sent: false, outcome: "unknown" });
    expect(loggedRow()).toMatchObject({ status: "failed" });
  });

  it("treats a 200 with no message id as unknown", async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({ ok: true, data: {} });
    const r = await sendWhatsAppTemplate(INPUT);
    expect(r).toMatchObject({ sent: false, outcome: "unknown" });
  });

  it("skips, with a log row, when there is nothing to send to", async () => {
    const r = await sendWhatsAppTemplate({ ...INPUT, to: "" });
    expect(r).toMatchObject({ sent: false, outcome: "skipped" });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(loggedRow()).toMatchObject({ status: "skipped", toPhone: "(none)" });
  });

  it("a failed log write does not turn a delivered message into a failure", async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({
      ok: true,
      data: { messages: [{ id: "wamid.3" }] },
    });
    dbHolder.current = makeDbMock({ failInsertFor: [whatsappLogs] });
    const r = await sendWhatsAppTemplate(INPUT);
    expect(r).toMatchObject({ sent: true, messageId: "wamid.3", logId: null });
  });
});

describe("sendWhatsAppInteractive", () => {
  const MENU = {
    storeId: "store-1",
    to: "+919876543210",
    token: "tok",
    phoneNumberId: "P",
    body: "How can we help?",
    buttons: [{ id: "menu:b1", title: "Check my order" }],
  };

  it("★ sends digits-only with the buttons and logs the id, like any other send", async () => {
    vi.mocked(sendInteractiveMessage).mockResolvedValue({
      ok: true,
      data: { messages: [{ id: "wamid.9" }] },
    });
    const r = await sendWhatsAppInteractive(MENU);
    expect(r).toEqual({ sent: true, messageId: "wamid.9", logId: "log-1" });
    expect(sendInteractiveMessage).toHaveBeenCalledWith("tok", "P", {
      to: "919876543210",
      body: "How can we help?",
      buttons: MENU.buttons,
    });
    expect(loggedRow()).toMatchObject({
      storeId: "store-1",
      toPhone: "+919876543210",
      body: "How can we help?",
      category: "SERVICE",
      status: "sent",
      providerMessageId: "wamid.9",
    });
  });

  it("a rejection is logged failed with Meta's code", async () => {
    vi.mocked(sendInteractiveMessage).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "(#131047) Re-engagement message",
      code: 131047,
    });
    const r = await sendWhatsAppInteractive(MENU);
    expect(r).toMatchObject({ sent: false, outcome: "rejected", code: 131047 });
    expect(loggedRow()).toMatchObject({ status: "failed", errorCode: 131047 });
  });

  it("skips, with a log row, when there is no body or no button", async () => {
    expect(await sendWhatsAppInteractive({ ...MENU, body: " " })).toMatchObject(
      {
        sent: false,
        outcome: "skipped",
      },
    );
    expect(loggedRow()).toMatchObject({ status: "skipped" });
    expect(
      await sendWhatsAppInteractive({ ...MENU, buttons: [] }),
    ).toMatchObject({ sent: false, outcome: "skipped", error: "No buttons." });
    expect(sendInteractiveMessage).not.toHaveBeenCalled();
  });
});

describe("sendWhatsAppMedia (slice 6)", () => {
  const PHOTO = {
    storeId: "store-1",
    to: "+919876543210",
    token: "tok",
    phoneNumberId: "P",
    kind: "image" as const,
    mediaId: "MEDIA1",
    caption: "  Here it is  ",
    replyToProviderId: "wamid.in1",
  };

  it("★ sends by media id with the caption and the quote, and logs the caption as the body", async () => {
    vi.mocked(sendMediaMessage).mockResolvedValue({
      ok: true,
      data: { messages: [{ id: "wamid.img" }] },
    });
    const r = await sendWhatsAppMedia(PHOTO);
    expect(r).toEqual({ sent: true, messageId: "wamid.img", logId: "log-1" });
    expect(sendMediaMessage).toHaveBeenCalledWith("tok", "P", {
      to: "919876543210",
      kind: "image",
      mediaId: "MEDIA1",
      caption: "Here it is",
      filename: null,
      replyToProviderId: "wamid.in1",
    });
    expect(loggedRow()).toMatchObject({
      body: "Here it is",
      category: "SERVICE",
      status: "sent",
      providerMessageId: "wamid.img",
    });
  });

  it("a document with no caption is logged by its name, so the log answers 'did it go?'", async () => {
    vi.mocked(sendMediaMessage).mockResolvedValue({
      ok: true,
      data: { messages: [{ id: "wamid.doc" }] },
    });
    await sendWhatsAppMedia({
      ...PHOTO,
      kind: "document",
      caption: null,
      filename: "size-chart.pdf",
      replyToProviderId: null,
    });
    expect(sendMediaMessage).toHaveBeenCalledWith(
      "tok",
      "P",
      expect.objectContaining({
        kind: "document",
        caption: null,
        filename: "size-chart.pdf",
      }),
    );
    expect(loggedRow()).toMatchObject({
      body: "📄 size-chart.pdf",
      status: "sent",
    });
  });

  it("skips with a log row when there is no file id, and never calls Meta", async () => {
    const r = await sendWhatsAppMedia({ ...PHOTO, mediaId: "" });
    expect(r).toMatchObject({ sent: false, outcome: "skipped" });
    expect(sendMediaMessage).not.toHaveBeenCalled();
    expect(loggedRow()).toMatchObject({ status: "skipped" });
  });

  it("a rejection is logged failed with Meta's code", async () => {
    vi.mocked(sendMediaMessage).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "Unsupported media",
      code: 131053,
    });
    const r = await sendWhatsAppMedia(PHOTO);
    expect(r).toMatchObject({ sent: false, outcome: "rejected", code: 131053 });
    expect(loggedRow()).toMatchObject({ status: "failed", errorCode: 131053 });
  });
});
