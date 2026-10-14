/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Customer-facing Mink, end to end with the model mocked: the gate runs
// again, the headroom is checked before the model, the facts are read for
// the phone that wrote, an answer is charged and sent, a hand-over leaves a
// draft, drafts mode never sends, and nothing here ever throws.
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
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/site", () => ({
  storeOrigin: vi.fn(() => "https://echoss.storemink.com"),
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({
    enabled: true,
    projectId: "proj",
    location: "global",
    model: "gemini-test",
    chargeCredits: true,
  })),
}));
vi.mock("@/lib/mink/offers-read", () => ({
  readMinkCurrentOffers: vi.fn(async () => ({
    offers: [
      {
        name: "Diwali 10",
        availability: "running",
        delivery: "code",
        code: "DIWALI10",
        reward: "10% off",
        trigger: "on any order",
        appliesTo: { products: [], variants: [], categories: [] },
        validUntil: "2026-10-31T00:00:00Z",
      },
      {
        name: "Old",
        availability: "ended",
        delivery: "automatic",
        reward: "5% off",
        trigger: "on any order",
        appliesTo: { products: [], variants: [], categories: [] },
        validUntil: null,
      },
    ],
  })),
}));
vi.mock("@/lib/storefront/queries", () => ({
  getPublishedProducts: vi.fn(async () => [
    {
      id: "p1",
      name: "Almond Shake",
      slug: "almond-shake",
      description: "Creamy.",
      category: "Shakes",
      base_price: 150,
      selling_price: 120,
      track_inventory: true,
      stock: 4,
      low_stock_threshold: null,
      allow_backorder: false,
      returnable: true,
      variants: [],
    },
  ]),
}));
vi.mock("@/lib/legal/store-consent", () => ({
  getLivePolicies: vi.fn(async () => [
    {
      slug: "refund-policy",
      title: "Refund Policy",
      shortLabel: "Refund Policy",
      html: "<p>Returns within 7 days.</p>",
    },
  ]),
}));
vi.mock("@/lib/shipping/product-delivery", () => ({
  estimateProductDelivery: vi.fn(async () => ({
    available: true,
    postalCode: "560001",
    kind: "physical",
    option: {
      amount: 0,
      estimatedDeliveryMinDays: 2,
      estimatedDeliveryMaxDays: 4,
      courierName: "Delhivery",
    },
  })),
}));
vi.mock("./channel", () => ({
  loadWhatsAppSender: vi.fn(async () => ({ token: "tok", phoneNumberId: "P" })),
}));
vi.mock("./auto-reply", () => ({ replyInChat: vi.fn(async () => true) }));
vi.mock("./mink-drafts", () => ({
  minkChargeContext: vi.fn(async () => ({ period: "2026-10", planCap: 20 })),
  minkCreditHeadroom: vi.fn(async () => 5),
  chargeMinkAnswer: vi.fn(async () => "plan"),
}));
vi.mock("./mink-model", () => ({
  MINK_WHATSAPP_MODEL_TIMEOUT_MS: 25_000,
  MINK_WHATSAPP_MODEL_ATTEMPTS: 2,
  callMinkWhatsAppModelWithRetry: vi.fn(),
}));
vi.mock("./order-status-reply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./order-status-reply")>()),
  lookupOrdersForPhone: vi.fn(async () => ({
    ok: true,
    orders: [
      {
        id: "o1",
        orderRef: "ORD10011027",
        createdAt: "2026-10-12T05:00:00Z",
        status: "processing",
        fulfilmentType: "delivery",
        pickupStatus: null,
        pickupReadyAt: null,
        pickupExpiresAt: null,
        pickupLocationName: null,
        deliveredAt: null,
        shipment: null,
      },
    ],
  })),
}));

import { answerWithMink } from "./mink-answer";
import { callMinkWhatsAppModelWithRetry } from "./mink-model";
import { replyInChat } from "./auto-reply";
import { chargeMinkAnswer, minkCreditHeadroom } from "./mink-drafts";
import { rateLimit } from "@/lib/rate-limit";
import { getMinkConfig } from "@/lib/mink/config";
import { estimateProductDelivery } from "@/lib/shipping/product-delivery";
import { logWarn } from "@/lib/observability/logger";

const STORE = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";

function storeRow(over: Record<string, unknown> = {}) {
  return {
    name: "Echoss",
    slug: "echoss",
    customDomain: null,
    settings: { brand: { email: "hi@echoss.in" } },
    plan: "basic",
    planExpiresAt: null,
    compPlan: null,
    compExpiresAt: null,
    businessHours: { mon: { open: "10:00", close: "19:00" } },
    minkMode: "helps",
    savedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function setup(over: Record<string, unknown> = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [storeRow(over)],
      // recent messages
      [
        { id: "m0", direction: "in", kind: "text", body: "hi" },
        { id: "m1", direction: "in", kind: "text", body: "the question" },
      ],
      // the sent message's id, after a send
      [{ id: "out-1" }],
    ],
  });
}

const model = (parsed: unknown, finishReason = "STOP") =>
  vi.mocked(callMinkWhatsAppModelWithRetry).mockResolvedValue({
    parsed,
    finishReason,
    model: "gemini-test",
    inputTokens: 900,
    outputTokens: 40,
    attempts: 1,
  });

const input = (over: Record<string, unknown> = {}) => ({
  storeId: STORE,
  conversationId: CONV,
  messageId: "m1",
  phone: "+919876543210",
  userId: "u1",
  mode: "helps" as const,
  text: "Do you have the almond shake? Deliver to 560001?",
  now: new Date("2026-10-14T06:30:00Z"),
  ...over,
});

beforeEach(() => {
  setup();
  model({
    outcome: "answer",
    reply: "Yes, ₹120 and in stock.",
    reason: "in facts",
  });
});

describe("answerWithMink: helps", () => {
  it("★ reads the facts for the phone that wrote, asks once, charges, sends and records", async () => {
    const r = await answerWithMink(input());
    expect(r).toMatchObject({ outcome: "sent", needsHuman: false });
    expect(r.answerId).toMatch(/^[0-9a-f-]{36}$/);

    // The sheet the model saw.
    const call = vi.mocked(callMinkWhatsAppModelWithRetry).mock.calls[0];
    const facts = call[1].facts;
    expect(facts.store).toEqual({
      name: "Echoss",
      url: "https://echoss.storemink.com",
      email: "hi@echoss.in",
    });
    expect(facts.orders[0]).toContain("Order ORD10011027");
    expect(facts.products[0]).toContain("Almond Shake: ₹120 (was ₹150)");
    expect(facts.offers).toEqual([
      "Diwali 10: 10% off, on any order, with code DIWALI10 until 2026-10-31",
    ]);
    expect(facts.policies).toEqual([
      { title: "Refund Policy", text: "Returns within 7 days." },
    ]);
    expect(facts.hours).toContain("Mon 10:00 to 19:00");
    expect(facts.delivery).toBe(
      "Almond Shake to 560001: available, free delivery, 2 to 4 days by Delhivery.",
    );
    // The current message is not its own context.
    expect(facts.recent).toEqual([{ who: "customer", text: "hi" }]);
    expect(estimateProductDelivery).toHaveBeenCalledWith(STORE, {
      productId: "p1",
      variantId: null,
      quantity: 1,
      postalCode: "560001",
    });
    expect(call[1].message).toBe(input().text);

    // The row first, then the charge keyed on it, then the send marked as Mink's.
    const { calls } = dbHolder.current;
    expect(calls.values[0]).toMatchObject({
      storeId: STORE,
      conversationId: CONV,
      messageId: "m1",
      mode: "helps",
      outcome: "draft",
      answer: "Yes, ₹120 and in stock.",
      model: "gemini-test",
      inputTokens: 900,
      outputTokens: 40,
    });
    expect(calls.values[0].facts).toEqual(
      expect.arrayContaining([
        "Order ORD10011027",
        "Almond Shake",
        "Refund Policy",
      ]),
    );
    expect(chargeMinkAnswer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ answerId: r.answerId, storeId: STORE }),
    );
    expect(replyInChat).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Yes, ₹120 and in stock.",
        reason: "mink:answer",
        extraPayload: { mink: true, answerId: r.answerId },
      }),
    );
    expect(calls.set[0]).toMatchObject({
      outcome: "sent",
      sentMessageId: "out-1",
    });
  });

  it("★ the model's hand-over leaves its words as a draft and asks for a person", async () => {
    model({
      outcome: "hand_over",
      reply: "Sorry about that, someone will reply here.",
      reason: "complaint",
    });
    const r = await answerWithMink(input());
    expect(r).toMatchObject({
      outcome: "draft",
      needsHuman: true,
      reason: "complaint",
    });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      outcome: "draft",
      answer: "Sorry about that, someone will reply here.",
    });
    expect(chargeMinkAnswer).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("a hand-over with nothing to say is recorded as one, with no draft", async () => {
    model({ outcome: "hand_over", reply: "", reason: "not in facts" });
    const r = await answerWithMink(input());
    expect(r).toMatchObject({ outcome: "handed_over", needsHuman: true });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      outcome: "handed_over",
    });
  });

  it("★ a link the facts never gave is never sent", async () => {
    model({
      outcome: "answer",
      reply: "Pay at https://evil.example",
      reason: "",
    });
    const r = await answerWithMink(input());
    expect(r.outcome).toBe("handed_over");
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("★ the gate runs again here, so a caller cannot route a refund to the model", async () => {
    const r = await answerWithMink(input({ text: "I want a refund" }));
    expect(r).toMatchObject({ outcome: "handed_over", reason: "complaint" });
    expect(callMinkWhatsAppModelWithRetry).not.toHaveBeenCalled();
  });

  it("★ a store with no credits costs nothing: no model call, a person reads it", async () => {
    vi.mocked(minkCreditHeadroom).mockResolvedValueOnce(0);
    const r = await answerWithMink(input());
    expect(r).toMatchObject({
      outcome: "skipped",
      needsHuman: true,
      reason: "no_credits",
    });
    expect(callMinkWhatsAppModelWithRetry).not.toHaveBeenCalled();
  });

  it("★ 'insufficient' at the charge keeps the answer as a draft and hands over", async () => {
    vi.mocked(chargeMinkAnswer).mockResolvedValueOnce("insufficient");
    const r = await answerWithMink(input());
    expect(r).toMatchObject({
      outcome: "draft",
      needsHuman: true,
      reason: "no_credits",
    });
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("a send Meta refused keeps the (charged) draft for a person to send free", async () => {
    vi.mocked(replyInChat).mockResolvedValueOnce(false);
    const r = await answerWithMink(input());
    expect(r).toMatchObject({
      outcome: "draft",
      needsHuman: true,
      reason: "send_failed",
    });
  });

  it("rate limits, a switched-off mode, and an unavailable Mink all skip to a person", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false });
    expect(await answerWithMink(input())).toMatchObject({
      outcome: "skipped",
      reason: "rate_limited",
    });
    expect(callMinkWhatsAppModelWithRetry).not.toHaveBeenCalled();

    setup({ minkMode: "off" });
    expect(await answerWithMink(input())).toMatchObject({
      outcome: "skipped",
      reason: "mode_changed",
    });

    vi.mocked(getMinkConfig).mockReturnValueOnce({
      enabled: false,
      projectId: "proj",
    } as any);
    expect(await answerWithMink(input())).toMatchObject({
      outcome: "skipped",
      reason: "mink_unavailable",
    });
  });

  it("a model answer that is not the shape, or not finished, is a failure a person reads", async () => {
    model({ outcome: "answer", reply: "cut off" }, "MAX_TOKENS");
    expect(await answerWithMink(input())).toMatchObject({
      outcome: "failed",
      needsHuman: true,
    });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      outcome: "failed",
    });
    setup();
    model("not json at all");
    expect(await answerWithMink(input())).toMatchObject({ outcome: "failed" });
  });

  it("never throws: a provider error is a failure, a timeout is reported as one", async () => {
    vi.mocked(callMinkWhatsAppModelWithRetry).mockRejectedValueOnce(
      new Error("boom"),
    );
    expect(await answerWithMink(input())).toMatchObject({
      outcome: "failed",
      needsHuman: true,
      reason: "error",
    });
    setup();
    const stalled = Object.assign(new Error("stalled twice"), {
      name: "MinkWhatsAppModelStalled",
      attempts: 2,
    });
    vi.mocked(callMinkWhatsAppModelWithRetry).mockRejectedValueOnce(stalled);
    expect(await answerWithMink(input())).toMatchObject({
      outcome: "failed",
      needsHuman: true,
      reason: "timeout",
    });
    expect(chargeMinkAnswer).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      "whatsapp mink: model timed out",
      expect.objectContaining({ attempts: 2 }),
    );
  });

  it("★ an answer that needed the second attempt is sent, charged once and logged", async () => {
    vi.mocked(callMinkWhatsAppModelWithRetry).mockResolvedValueOnce({
      parsed: { outcome: "answer", reply: "₹120, in stock.", reason: "facts" },
      finishReason: "STOP",
      model: "gemini-test",
      inputTokens: 900,
      outputTokens: 40,
      attempts: 2,
    });
    const r = await answerWithMink(input());
    expect(r).toMatchObject({ outcome: "sent", needsHuman: false });
    expect(chargeMinkAnswer).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "whatsapp mink: model stalled once, answered on the retry",
      expect.objectContaining({ attempts: 2 }),
    );
  });
});

describe("answerWithMink: drafts", () => {
  it("★ never sends and never charges: every answer is a draft for a person", async () => {
    setup({ minkMode: "drafts" });
    const r = await answerWithMink(input({ mode: "drafts" }));
    expect(r).toMatchObject({ outcome: "draft", needsHuman: false });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      mode: "drafts",
      outcome: "draft",
      answer: "Yes, ₹120 and in stock.",
    });
    expect(chargeMinkAnswer).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("still needs headroom: a draft nobody could afford to send is not written", async () => {
    setup({ minkMode: "drafts" });
    vi.mocked(minkCreditHeadroom).mockResolvedValueOnce(0);
    const r = await answerWithMink(input({ mode: "drafts" }));
    expect(r.outcome).toBe("skipped");
    expect(callMinkWhatsAppModelWithRetry).not.toHaveBeenCalled();
  });
});
