/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("./channel", () => ({
  loadWhatsAppSender: vi.fn(),
  loadWhatsAppTemplateById: vi.fn(),
  whatsAppConsentFor: vi.fn(),
}));
vi.mock("./send", () => ({ sendWhatsAppTemplate: vi.fn() }));
vi.mock("./cod-confirmation", () => ({
  markCodConfirmationRequested: vi.fn(async () => undefined),
}));
vi.mock("./inbox", () => ({
  fileTemplateInThread: vi.fn(async () => "m-thread"),
}));
vi.mock("./templates", () => ({
  markNeedsReauth: vi.fn(async () => undefined),
}));
vi.mock("./sms-fallback", () => ({
  releaseHeldSms: vi.fn(async () => true),
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  loadWhatsAppSender,
  loadWhatsAppTemplateById,
  whatsAppConsentFor,
} from "./channel";
import { sendWhatsAppTemplate } from "./send";
import { markCodConfirmationRequested } from "./cod-confirmation";
import { fileTemplateInThread } from "./inbox";
import { markNeedsReauth } from "./templates";
import { releaseHeldSms } from "./sms-fallback";
import { RETRYABLE_META_CODES, runWhatsAppWorker } from "./worker";

const ROW = {
  id: "q1",
  store_id: "store-1",
  recipient_id: "cust-1",
  recipient_type: "customer",
  phone: "+919876543210",
  event_key: "order.placed",
  audience: "customer",
  template_id: "t1",
  values: ["Acme", "ORD1"],
  attempts: 1,
};
const SENDER = {
  token: "tok",
  wabaId: "W",
  phoneNumberId: "P",
  displayPhone: "+91",
  precedence: "whatsapp_first" as const,
  codConfirmation: false,
};
const TEMPLATE = {
  id: "t1",
  audience: "customer",
  name: "sm_order_placed_customer_v1",
  language: "en",
  variables: ["store_name", "subject_label"],
  body: "Thanks {{1}} {{2}}",
};

function setup(rows: any[] = [ROW]) {
  dbHolder.current = makeDbMock({ executeQueue: [rows] });
  vi.mocked(loadWhatsAppSender).mockResolvedValue(SENDER);
  vi.mocked(loadWhatsAppTemplateById).mockResolvedValue(TEMPLATE);
  vi.mocked(whatsAppConsentFor).mockResolvedValue(
    new Map([["+919876543210", { updates: true, marketing: false }]]),
  );
}

/** The settle/requeue statements, as text, after the claim. */
function settlements(): string[] {
  return dbHolder.current.calls.execute.slice(1).map(sqlText);
}

beforeEach(() => setup());

describe("runWhatsAppWorker", () => {
  it("sends a claimed row through the choke point and settles it sent", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: true,
      messageId: "wamid.1",
      logId: "l1",
    });
    const r = await runWhatsAppWorker();
    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        to: "+919876543210",
        template: expect.objectContaining({ id: "t1" }),
        values: ["Acme", "ORD1"],
      }),
    );
    expect(settlements()[0]).toMatch(
      /update public\.notification_whatsapp_queue/,
    );
    expect(sqlParamValues(dbHolder.current.calls.execute[1])).toContain("sent");
  });

  it("★ a sent customer template is filed in the thread, rendered, quietly", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: true,
      messageId: "wamid.1",
      logId: "l1",
    });
    await runWhatsAppWorker();
    expect(fileTemplateInThread).toHaveBeenCalledWith(expect.anything(), {
      storeId: "store-1",
      phone: "+919876543210",
      templateId: "t1",
      body: "Thanks Acme ORD1",
      providerMessageId: "wamid.1",
    });
  });

  it("a team template is addressed to staff and is filed in no thread", async () => {
    setup([{ ...ROW, audience: "team" }]);
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: true,
      messageId: "wamid.1",
      logId: "l1",
    });
    await runWhatsAppWorker();
    expect(fileTemplateInThread).not.toHaveBeenCalled();
  });

  it("★ a failed filing never fails the send or re-sends: the row is settled sent", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: true,
      messageId: "wamid.1",
      logId: "l1",
    });
    vi.mocked(fileTemplateInThread).mockRejectedValueOnce(new Error("db"));
    const r = await runWhatsAppWorker();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(sqlParamValues(dbHolder.current.calls.execute[1])).toContain("sent");
  });

  it("a refused send files nothing", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "no",
      code: 131026,
    });
    await runWhatsAppWorker();
    expect(fileTemplateInThread).not.toHaveBeenCalled();
  });

  it("does nothing when the queue is empty", async () => {
    setup([]);
    expect(await runWhatsAppWorker()).toMatchObject({ claimed: 0 });
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("fails a row whose store is no longer connected, without sending", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(null);
    const r = await runWhatsAppWorker();
    expect(r.failed).toBe(1);
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("★ re-checks a customer's consent at send and skips a withdrawn one", async () => {
    vi.mocked(whatsAppConsentFor).mockResolvedValue(new Map());
    const r = await runWhatsAppWorker();
    expect(r.skipped).toBe(1);
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("needs no consent for a team row", async () => {
    setup([{ ...ROW, audience: "team", recipient_type: "admin" }]);
    vi.mocked(loadWhatsAppTemplateById).mockResolvedValue({
      ...TEMPLATE,
      audience: "team",
    });
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: true,
      messageId: "m",
      logId: null,
    });
    await runWhatsAppWorker();
    expect(whatsAppConsentFor).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate).toHaveBeenCalled();
  });

  it("refuses a template Meta has since paused", async () => {
    vi.mocked(loadWhatsAppTemplateById).mockResolvedValue(null);
    const r = await runWhatsAppWorker();
    expect(r.failed).toBe(1);
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("★ re-reads exactly the template that was queued, by id in its store", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: true,
      messageId: "m",
      logId: null,
    });
    await runWhatsAppWorker();
    expect(loadWhatsAppTemplateById).toHaveBeenCalledWith(
      expect.anything(),
      "store-1",
      "t1",
      { strict: true },
    );
  });

  it("★ a COD row sends its button payloads and marks the order asked, once sent", async () => {
    const ORDER = "11111111-2222-4333-8444-555555555555";
    const payloads = [`cod:confirm:${ORDER}`, `cod:cancel:${ORDER}`];
    setup([{ ...ROW, button_payloads: payloads }]);
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: true,
      messageId: "m",
      logId: null,
    });
    await runWhatsAppWorker();
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ buttonPayloads: payloads }),
    );
    expect(markCodConfirmationRequested).toHaveBeenCalledWith("store-1", ORDER);
  });

  it("★ a COD row that did not send leaves the order unasked", async () => {
    const ORDER = "11111111-2222-4333-8444-555555555555";
    setup([
      {
        ...ROW,
        button_payloads: [`cod:confirm:${ORDER}`, `cod:cancel:${ORDER}`],
      },
    ]);
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Not a WhatsApp user",
      code: 131026,
    });
    await runWhatsAppWorker();
    expect(markCodConfirmationRequested).not.toHaveBeenCalled();
  });

  it("a row without buttons sends none and marks nothing", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: true,
      messageId: "m",
      logId: null,
    });
    await runWhatsAppWorker();
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(
      expect.not.objectContaining({ buttonPayloads: expect.anything() }),
    );
    expect(markCodConfirmationRequested).not.toHaveBeenCalled();
  });

  it("★ an unknown outcome is terminal — settled failed, never requeued", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "unknown",
      error: "Meta 503.",
    });
    const r = await runWhatsAppWorker();
    expect(r.unknown).toBe(1);
    expect(settlements()).toHaveLength(1);
    expect(settlements()[0]).not.toMatch(/next_attempt_at/);
  });

  it("requeues only a throttle, with backoff", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Rate limit",
      code: 130429,
    });
    await runWhatsAppWorker();
    expect(settlements()[0]).toMatch(/next_attempt_at/);
    expect(RETRYABLE_META_CODES.has(130429)).toBe(true);
  });

  it("fails a non-throttle rejection outright — the number will not be on WhatsApp in five minutes", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Not a WhatsApp user",
      code: 131026,
    });
    const r = await runWhatsAppWorker();
    expect(r.failed).toBe(1);
    expect(settlements()[0]).not.toMatch(/next_attempt_at/);
  });

  it("stops retrying a throttle after the last attempt", async () => {
    setup([{ ...ROW, attempts: 3 }]);
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Rate limit",
      code: 130429,
    });
    await runWhatsAppWorker();
    expect(settlements()[0]).not.toMatch(/next_attempt_at/);
  });
});

describe("the held SMS and Meta's id", () => {
  it("★ a sent row keeps Meta's message id, so a later status can find it", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: true,
      messageId: "wamid.1",
      logId: "l1",
    });
    await runWhatsAppWorker();
    expect(settlements()[0]).toMatch(/provider_message_id = /);
    expect(sqlParamValues(dbHolder.current.calls.execute[1])).toContain(
      "wamid.1",
    );
    // Delivered or not is the status webhook's to say: nothing released yet.
    expect(releaseHeldSms).not.toHaveBeenCalled();
  });

  it("★★ a definite refusal releases the SMS held behind the message", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Not a WhatsApp user",
      code: 131026,
    });
    const r = await runWhatsAppWorker();
    expect(releaseHeldSms).toHaveBeenCalledWith(expect.anything(), "q1");
    expect(r.smsReleased).toBe(1);
  });

  it("…and so does a store that can no longer send, or a withdrawn consent", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(null);
    await runWhatsAppWorker();
    expect(releaseHeldSms).toHaveBeenCalledTimes(1);

    setup();
    vi.mocked(releaseHeldSms).mockClear();
    vi.mocked(whatsAppConsentFor).mockResolvedValue(new Map());
    await runWhatsAppWorker();
    expect(releaseHeldSms).toHaveBeenCalledTimes(1);
  });

  it("★ an unknown outcome keeps the SMS held: the WhatsApp may have arrived", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "unknown",
      error: "Meta 503.",
    });
    await runWhatsAppWorker();
    expect(releaseHeldSms).not.toHaveBeenCalled();
  });

  it("a throttle that will be retried keeps the SMS held", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Rate limit",
      code: 130429,
    });
    await runWhatsAppWorker();
    expect(releaseHeldSms).not.toHaveBeenCalled();
  });
});

describe("a dead token", () => {
  it("★★ Meta's 190 marks the account needs_reauth and stops using it for the batch", async () => {
    setup([ROW, { ...ROW, id: "q2" }]);
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Invalid OAuth access token",
      code: 190,
    });
    const r = await runWhatsAppWorker();
    expect(markNeedsReauth).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markNeedsReauth).mock.calls[0]![0]).toBe("store-1");
    // The second row is not sent with a token Meta just refused.
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(r.failed).toBe(2);
    expect(releaseHeldSms).toHaveBeenCalledTimes(2);
  });

  it("another refusal leaves the account alone", async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Not a WhatsApp user",
      code: 131026,
    });
    await runWhatsAppWorker();
    expect(markNeedsReauth).not.toHaveBeenCalled();
  });
});

describe("our own read failing", () => {
  it("★★ is not a verdict: the row is requeued, nothing is settled or released", async () => {
    vi.mocked(loadWhatsAppSender).mockRejectedValue(new Error("57P01"));
    const r = await runWhatsAppWorker();
    expect(r).toMatchObject({ requeued: 1, failed: 0 });
    expect(settlements()[0]).toMatch(/next_attempt_at/);
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(releaseHeldSms).not.toHaveBeenCalled();
    expect(loadWhatsAppSender).toHaveBeenCalledWith(
      expect.anything(),
      "store-1",
      { strict: true },
    );
  });

  it("the consent and template reads are strict too", async () => {
    vi.mocked(whatsAppConsentFor).mockRejectedValue(new Error("reset"));
    expect((await runWhatsAppWorker()).requeued).toBe(1);

    setup();
    vi.mocked(loadWhatsAppTemplateById).mockRejectedValue(new Error("reset"));
    expect((await runWhatsAppWorker()).requeued).toBe(1);
  });

  it("gives up after the last attempt, and only then lets the SMS go", async () => {
    setup([{ ...ROW, attempts: 3 }]);
    vi.mocked(loadWhatsAppSender).mockRejectedValue(new Error("57P01"));
    const r = await runWhatsAppWorker();
    expect(r).toMatchObject({ requeued: 0, failed: 1 });
    expect(settlements()[0]).not.toMatch(/next_attempt_at/);
    expect(releaseHeldSms).toHaveBeenCalledTimes(1);
  });
});
