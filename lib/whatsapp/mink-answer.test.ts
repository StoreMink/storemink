/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Customer-facing Mink, end to end with the model mocked: the gate runs
// again, a `helps` store with no number to send from spends nothing, the
// headroom is checked before the model, the facts are read for the phone
// that wrote (and only the offers a shopper could see), a person who replied
// first wins, an answer is claimed, charged and sent, a hand-over leaves a
// draft, drafts mode never sends, and nothing here ever throws.
// ---------------------------------------------------------------------------

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
  // ★ The SHOPPER read (offers-read.ts), never the merchant's own list: what
  // it filters is pinned in offers-read.test.ts.
  readMinkShopperOffers: vi.fn(async () => ({
    offers: [
      {
        name: "Diwali 10",
        code: "DIWALI10",
        reward: "10% off",
        on: null,
        when: "on any order",
        conditions: [],
        validUntil: "2026-10-31T00:00:00Z",
      },
    ],
    truncated: false,
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
  claimMinkDraft: vi.fn(async (_db: unknown, input: { draftId: string }) => ({
    id: input.draftId,
    charged: false,
  })),
  releaseMinkDraftClaim: vi.fn(async () => undefined),
  markMinkAnswerSent: vi.fn(async () => undefined),
  personRepliedSince: vi.fn(async () => false),
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
import { loadWhatsAppSender } from "./channel";
import {
  chargeMinkAnswer,
  claimMinkDraft,
  markMinkAnswerSent,
  minkCreditHeadroom,
  personRepliedSince,
  releaseMinkDraftClaim,
} from "./mink-drafts";
import { lookupOrdersForPhone } from "./order-status-reply";
import { rateLimit } from "@/lib/rate-limit";
import { getMinkConfig } from "@/lib/mink/config";
import { readMinkShopperOffers } from "@/lib/mink/offers-read";
import {
  getPublishedProducts,
  type ProductCardRow,
} from "@/lib/storefront/queries";
import { estimateProductDelivery } from "@/lib/shipping/product-delivery";
import { logError, logWarn } from "@/lib/observability/logger";

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
    // ★★ Claimed (the same lease a person's Send takes), then charged, then
    // sent, with the sender loaded before anything was spent.
    expect(claimMinkDraft).toHaveBeenCalledWith(expect.anything(), {
      storeId: STORE,
      conversationId: CONV,
      draftId: r.answerId,
    });
    expect(chargeMinkAnswer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ answerId: r.answerId, storeId: STORE }),
    );
    expect(vi.mocked(claimMinkDraft).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(chargeMinkAnswer).mock.invocationCallOrder[0],
    );
    expect(
      vi.mocked(loadWhatsAppSender).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(callMinkWhatsAppModelWithRetry).mock.invocationCallOrder[0],
    );
    expect(replyInChat).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Yes, ₹120 and in stock.",
        reason: "mink:answer",
        sender: { token: "tok", phoneNumberId: "P" },
        extraPayload: { mink: true, answerId: r.answerId },
      }),
    );
    expect(markMinkAnswerSent).toHaveBeenCalledWith(expect.anything(), {
      storeId: STORE,
      answerId: r.answerId,
      answer: "Yes, ₹120 and in stock.",
      sentMessageId: "out-1",
      sentByAdminId: null,
    });
    expect(releaseMinkDraftClaim).not.toHaveBeenCalled();
  });

  it("★★ a store whose number cannot send pays for nothing: no model call, no charge, a person reads it", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValueOnce(null);
    const r = await answerWithMink(input());
    expect(r).toMatchObject({
      outcome: "skipped",
      needsHuman: true,
      reason: "no_sender",
    });
    expect(callMinkWhatsAppModelWithRetry).not.toHaveBeenCalled();
    expect(minkCreditHeadroom).not.toHaveBeenCalled();
    expect(chargeMinkAnswer).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  it("★★ a person who replied while the model was thinking wins: nothing sent, charged or drafted", async () => {
    vi.mocked(personRepliedSince).mockResolvedValueOnce(true);
    const r = await answerWithMink(input());
    expect(r).toMatchObject({
      outcome: "skipped",
      needsHuman: false,
      reason: "person_replied",
    });
    expect(personRepliedSince).toHaveBeenCalledWith(expect.anything(), {
      storeId: STORE,
      conversationId: CONV,
      messageId: "m1",
    });
    // Kept on the ledger with what it cost, as discarded, never as a draft.
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      outcome: "discarded",
      reason: "a person replied first",
      answer: "Yes, ₹120 and in stock.",
      inputTokens: 900,
    });
    expect(claimMinkDraft).not.toHaveBeenCalled();
    expect(chargeMinkAnswer).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("★ the person check comes after the model, so a reply during the call is seen", async () => {
    await answerWithMink(input());
    expect(
      vi.mocked(callMinkWhatsAppModelWithRetry).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(personRepliedSince).mock.invocationCallOrder[0]);
  });

  it("★★ a draft somebody else took (a Send on the card, a person's reply) is not sent by Mink", async () => {
    vi.mocked(claimMinkDraft).mockResolvedValueOnce(null);
    const r = await answerWithMink(input());
    expect(r).toMatchObject({
      outcome: "skipped",
      needsHuman: false,
      reason: "draft_taken",
    });
    expect(chargeMinkAnswer).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
    expect(markMinkAnswerSent).not.toHaveBeenCalled();
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

  it("★ 'insufficient' at the charge keeps the answer as a draft, gives the lease back and hands over", async () => {
    vi.mocked(chargeMinkAnswer).mockResolvedValueOnce("insufficient");
    const r = await answerWithMink(input());
    expect(r).toMatchObject({
      outcome: "draft",
      needsHuman: true,
      reason: "no_credits",
    });
    expect(replyInChat).not.toHaveBeenCalled();
    // Nothing was charged or sent, so a person may send it after a top-up.
    expect(releaseMinkDraftClaim).toHaveBeenCalledWith(expect.anything(), {
      storeId: STORE,
      answerId: r.answerId,
    });
    const note = dbHolder.current.calls.execute.find((q: unknown) =>
      sqlText(q).includes("set reason"),
    );
    expect(sqlText(note)).toContain("and outcome = 'draft'");
    expect(sqlParamValues(note)).toContain("no credits left to send");
  });

  it("a send Meta refused keeps the (charged) draft for a person to send free, the lease left to run out", async () => {
    vi.mocked(replyInChat).mockResolvedValueOnce(false);
    const r = await answerWithMink(input());
    expect(r).toMatchObject({
      outcome: "draft",
      needsHuman: true,
      reason: "send_failed",
    });
    // replyInChat cannot tell a refusal from no answer: a message that may
    // have reached the customer is not free to send again at once.
    expect(releaseMinkDraftClaim).not.toHaveBeenCalled();
    expect(markMinkAnswerSent).not.toHaveBeenCalled();
    const note = dbHolder.current.calls.execute.find((q: unknown) =>
      sqlText(q).includes("set reason"),
    );
    expect(sqlParamValues(note)).toContain("could not be sent");
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

  it("★ an answer that needed a retry is sent, charged once and logged with the model that answered", async () => {
    vi.mocked(callMinkWhatsAppModelWithRetry).mockResolvedValueOnce({
      parsed: { outcome: "answer", reply: "₹120, in stock.", reason: "facts" },
      finishReason: "STOP",
      // The Mink fallback answered, on the third attempt.
      model: "gemini-3.5-flash",
      inputTokens: 900,
      outputTokens: 40,
      attempts: 3,
    });
    const r = await answerWithMink(input());
    expect(r).toMatchObject({ outcome: "sent", needsHuman: false });
    expect(chargeMinkAnswer).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "whatsapp mink: answered after a retry",
      {
        storeId: STORE,
        conversationId: CONV,
        attempts: 3,
        model: "gemini-3.5-flash",
      },
    );
  });

  it("★★ a 429 or a 5xx still there after every attempt is 'busy', a warning and not a bug", async () => {
    for (const status of [429, 503]) {
      setup();
      vi.mocked(logWarn).mockClear();
      vi.mocked(logError).mockClear();
      vi.mocked(callMinkWhatsAppModelWithRetry).mockRejectedValueOnce(
        Object.assign(new Error(`provider said ${status}: quota text`), {
          status,
        }),
      );
      expect(await answerWithMink(input())).toEqual({
        outcome: "failed",
        needsHuman: true,
        answerId: null,
        reason: "busy",
      });
      // Content-free: the status, never the provider's words.
      expect(logWarn).toHaveBeenCalledWith("whatsapp mink: model busy", {
        storeId: STORE,
        conversationId: CONV,
        status,
      });
      expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain(
        "quota text",
      );
      expect(logError).not.toHaveBeenCalled();
    }
    expect(chargeMinkAnswer).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("★ a refusal of the request, a dropped connection, or a 5xx from anything but the model stays an error", async () => {
    const cases: Array<() => void> = [
      () =>
        vi
          .mocked(callMinkWhatsAppModelWithRetry)
          .mockRejectedValueOnce(
            Object.assign(new Error("bad request"), { status: 400 }),
          ),
      () =>
        vi
          .mocked(callMinkWhatsAppModelWithRetry)
          .mockRejectedValueOnce(new TypeError("fetch failed")),
      // The model answered; a later step failed with a status of its own.
      () =>
        vi
          .mocked(personRepliedSince)
          .mockRejectedValueOnce(
            Object.assign(new Error("upstream"), { status: 503 }),
          ),
    ];
    for (const arrange of cases) {
      setup();
      vi.mocked(logError).mockClear();
      arrange();
      expect(await answerWithMink(input())).toMatchObject({
        outcome: "failed",
        needsHuman: true,
        reason: "error",
      });
      expect(logError).toHaveBeenCalledWith(
        "whatsapp mink: answer failed",
        expect.anything(),
        { storeId: STORE, conversationId: CONV },
      );
    }
  });
});

describe("answerWithMink: the facts sheet", () => {
  const sheet = async (over: Record<string, unknown> = {}) => {
    await answerWithMink(input(over));
    return vi.mocked(callMinkWhatsAppModelWithRetry).mock.calls[0][1].facts;
  };

  it("★★ offers come from the shopper read, with their conditions and what they are on", async () => {
    vi.mocked(readMinkShopperOffers).mockResolvedValueOnce({
      offers: [
        {
          name: "Shake week",
          code: null,
          reward: "20% off chosen items",
          on: "Almond Shake",
          when: "on any order",
          conditions: ["first order only", "only when paying online"],
          validUntil: null,
        },
      ],
      truncated: false,
    });
    const facts = await sheet();
    expect(readMinkShopperOffers).toHaveBeenCalledWith(
      { storeId: STORE, effectivePlan: "basic" },
      { limit: 5, now: input().now },
    );
    expect(facts.offers).toEqual([
      "Shake week: 20% off chosen items on Almond Shake, on any order, first order only, only when paying online, applied automatically at checkout",
    ]);
    expect(facts.offersUnavailable).toBeUndefined();
  });

  it("★ a failed offers read says so, never 'none running'", async () => {
    vi.mocked(readMinkShopperOffers).mockRejectedValueOnce(new Error("down"));
    const facts = await sheet();
    expect(facts.offers).toEqual([]);
    expect(facts.offersUnavailable).toBe(true);
  });

  it("★ a failed order lookup says so, never 'no orders'", async () => {
    vi.mocked(lookupOrdersForPhone).mockResolvedValueOnce({ ok: false });
    const facts = await sheet();
    expect(facts.orders).toEqual([]);
    expect(facts.ordersUnavailable).toBe(true);
    // An answered lookup carries no flag at all.
    setup();
    vi.mocked(callMinkWhatsAppModelWithRetry).mockClear();
    model({ outcome: "answer", reply: "ok", reason: "" });
    expect((await sheet()).ordersUnavailable).toBeUndefined();
  });

  it("★★ a product with options is checked for delivery through one in stock, and names it", async () => {
    const variant = (id: string, label: string, stock: number) => ({
      id,
      base_price: 150,
      selling_price: 120,
      special_price: null,
      sort_order: 0,
      track_inventory: true,
      stock,
      low_stock_threshold: null,
      allow_backorder: false,
      option_values: [label],
      images: [],
    });
    const shake: ProductCardRow = {
      id: "p1",
      name: "Almond Shake",
      slug: "almond-shake",
      description: "Creamy.",
      category_id: null,
      category: "Shakes",
      base_price: 150,
      selling_price: 120,
      image_url: null,
      images: null,
      status: "published",
      featured: false,
      sort_order: 0,
      card_color: null,
      // The product row's own stock: none, as for any product with options.
      track_inventory: true,
      stock: 0,
      low_stock_threshold: null,
      allow_backorder: false,
      returnable: true,
      content_updated_at: "2026-10-01T00:00:00Z",
      created_at: "2026-10-01T00:00:00Z",
      options: [],
      variants: [variant("v1", "250 ml", 0), variant("v2", "500 ml", 6)],
    };
    vi.mocked(getPublishedProducts).mockResolvedValueOnce([shake]);
    const facts = await sheet();
    expect(estimateProductDelivery).toHaveBeenCalledWith(STORE, {
      productId: "p1",
      variantId: "v2",
      quantity: 1,
      postalCode: "560001",
    });
    expect(facts.delivery).toBe(
      "Almond Shake (500 ml) to 560001: available, free delivery, 2 to 4 days by Delhivery.",
    );
  });

  it("an unavailable delivery reads as one sentence, not two full stops", async () => {
    vi.mocked(estimateProductDelivery).mockResolvedValueOnce({
      available: false,
      postalCode: "560001",
      kind: "physical",
      error: "This item is currently out of stock for online delivery.",
    });
    const facts = await sheet();
    expect(facts.delivery).toBe(
      "Almond Shake to 560001: This item is currently out of stock for online delivery.",
    );
  });

  it("★ a long dash the model wrote never reaches the customer", async () => {
    model({
      outcome: "answer",
      reply: "Yes — ₹120, delivered in 2—4 days.",
      reason: "facts — price",
    });
    await answerWithMink(input());
    expect(replyInChat).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Yes, ₹120, delivered in 2 to 4 days." }),
    );
    expect(dbHolder.current.calls.values[0].reason).toBe("facts, price");
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
    expect(claimMinkDraft).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
    // A draft needs no number to send from yet: none is loaded.
    expect(loadWhatsAppSender).not.toHaveBeenCalled();
  });

  it("★ leaves no draft for a message a person already answered", async () => {
    setup({ minkMode: "drafts" });
    vi.mocked(personRepliedSince).mockResolvedValueOnce(true);
    const r = await answerWithMink(input({ mode: "drafts" }));
    expect(r).toMatchObject({
      outcome: "skipped",
      needsHuman: false,
      reason: "person_replied",
    });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      mode: "drafts",
      outcome: "discarded",
    });
  });

  it("still needs headroom: a draft nobody could afford to send is not written", async () => {
    setup({ minkMode: "drafts" });
    vi.mocked(minkCreditHeadroom).mockResolvedValueOnce(0);
    const r = await answerWithMink(input({ mode: "drafts" }));
    expect(r.outcome).toBe("skipped");
    expect(callMinkWhatsAppModelWithRetry).not.toHaveBeenCalled();
  });
});
