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
