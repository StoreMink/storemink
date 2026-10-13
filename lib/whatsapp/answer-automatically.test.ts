/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// The store's automatic replies: which apply, that each is claimed before it
// is sent, that they go as ONE message, and when the chat goes to a person.
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
vi.mock("@/lib/site", () => ({
  storeOrigin: vi.fn(() => "https://echoss.storemink.com"),
}));
vi.mock("./channel", () => ({
  loadWhatsAppSender: vi.fn(async () => ({
    token: "tok",
    phoneNumberId: "P",
  })),
}));
vi.mock("./auto-reply", () => ({ replyInChat: vi.fn(async () => true) }));
vi.mock("./order-status-reply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./order-status-reply")>()),
  lookupOrdersForPhone: vi.fn(async () => ({ ok: true, orders: [] })),
}));

import { answerAutomatically } from "./answer-automatically";
import { loadWhatsAppSender } from "./channel";
import { replyInChat } from "./auto-reply";
import { lookupOrdersForPhone } from "./order-status-reply";

const STORE = "11111111-1111-4111-8111-111111111111";
// Monday 2026-10-12 in Kolkata; the default hours are 10:00 to 19:00.
const OPEN_NOW = new Date("2026-10-12T12:00:00+05:30");
const CLOSED_NOW = new Date("2026-10-12T21:00:00+05:30");

function configRow(over: Record<string, unknown> = {}) {
  return {
    name: "Echoss",
    slug: "echoss",
    customDomain: null,
    settings: {},
    plan: "basic",
    planExpiresAt: null,
    compPlan: null,
    compExpiresAt: null,
    welcomeEnabled: false,
    welcomeText: "Hi, thanks for messaging Echoss!",
    awayEnabled: false,
    awayText: "We're closed right now.",
    businessHours: {
      mon: { open: "10:00", close: "19:00" },
      tue: { open: "10:00", close: "19:00" },
    },
    orderStatusEnabled: false,
    savedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function setup(
  row: Record<string, unknown> | null,
  executeQueue: any[][] = [],
) {
  dbHolder.current = makeDbMock({
    selectQueue: [row ? [row] : []],
    executeQueue,
  });
  return dbHolder.current;
}

const input = (over: Record<string, unknown> = {}) => ({
  storeId: STORE,
  conversationId: "c1",
  phone: "+919876543210",
  userId: null,
  kind: "text" as const,
  orderQuestion: false,
  welcomeEligible: true,
  now: OPEN_NOW,
  ...over,
});

const sentBody = () => vi.mocked(replyInChat).mock.calls.at(-1)?.[0].body;

beforeEach(() => {
  vi.mocked(replyInChat).mockResolvedValue(true);
});

describe("answerAutomatically: the welcome", () => {
  it("nothing switched on sends nothing and loads no sender", async () => {
    setup(configRow());
    const r = await answerAutomatically(input());
    expect(r).toEqual({ handOver: false, sent: [] });
    expect(loadWhatsAppSender).not.toHaveBeenCalled();
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("★ greets a first message once, claimed before it is sent", async () => {
    const mock = setup(configRow({ welcomeEnabled: true }), [[{ id: "c1" }]]);
    const r = await answerAutomatically(input());
    expect(r).toEqual({ handOver: false, sent: ["welcome"] });
    expect(sentBody()).toBe("Hi, thanks for messaging Echoss!");
    const claim = sqlText(mock.calls.execute[0]);
    expect(claim).toContain("set welcome_sent_at = now()");
    expect(claim).toContain("welcome_sent_at is null");
    expect(sqlParamValues(mock.calls.execute[0])).toEqual(
      expect.arrayContaining([STORE, 14]),
    );
    // Filed through the choke point with the sender already loaded.
    expect(vi.mocked(replyInChat).mock.calls[0][0]).toMatchObject({
      storeId: STORE,
      conversationId: "c1",
      to: "+919876543210",
      sender: expect.objectContaining({ phoneNumberId: "P" }),
    });
  });

  it("★ a claim another message already won sends nothing", async () => {
    setup(configRow({ welcomeEnabled: true }), [[]]);
    const r = await answerAutomatically(input());
    expect(r.sent).toEqual([]);
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("an ongoing conversation is not greeted, and nothing is claimed", async () => {
    const mock = setup(configRow({ welcomeEnabled: true }));
    await answerAutomatically(input({ welcomeEligible: false }));
    expect(mock.calls.execute).toHaveLength(0);
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("a reaction is not somebody starting a chat", async () => {
    const mock = setup(configRow({ welcomeEnabled: true }));
    await answerAutomatically(input({ kind: "reaction" }));
    expect(mock.calls.select).toHaveLength(0);
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("★ a paused number claims nothing, so the welcome is not lost", async () => {
    const mock = setup(configRow({ welcomeEnabled: true }));
    vi.mocked(loadWhatsAppSender).mockResolvedValueOnce(null);
    const r = await answerAutomatically(input());
    expect(r).toEqual({ handOver: false, sent: [] });
    expect(mock.calls.execute).toHaveLength(0);
  });
});

describe("answerAutomatically: the away message", () => {
  it("is not sent while the store is open", async () => {
    const mock = setup(configRow({ awayEnabled: true }));
    await answerAutomatically(input({ welcomeEligible: false }));
    expect(mock.calls.execute).toHaveLength(0);
    expect(replyInChat).not.toHaveBeenCalled();
  });

  it("★ outside hours: claimed by compare-and-set, then sent", async () => {
    const mock = setup(configRow({ awayEnabled: true }), [
      [{ away_sent_at: null, human_recent: false }],
      [{ id: "c1" }],
    ]);
    const r = await answerAutomatically(
      input({ welcomeEligible: false, now: CLOSED_NOW }),
    );
    expect(r).toEqual({ handOver: false, sent: ["away"] });
    expect(sentBody()).toBe("We're closed right now.");
    const cas = sqlText(mock.calls.execute[1]);
    expect(cas).toContain("set away_sent_at = ");
    expect(cas).toContain("away_sent_at is not distinct from ");
  });

  it("★ once per closed spell: not again before the store has opened", async () => {
    const mock = setup(configRow({ awayEnabled: true }), [
      // Sent at 19:30 the same evening; no opening since.
      [{ away_sent_at: "2026-10-12T14:00:00Z", human_recent: false }],
    ]);
    const r = await answerAutomatically(
      input({ welcomeEligible: false, now: CLOSED_NOW }),
    );
    expect(r.sent).toEqual([]);
    expect(mock.calls.execute).toHaveLength(1);
  });

  it("goes again once the store has opened since the last one", async () => {
    const mock = setup(configRow({ awayEnabled: true }), [
      // Sent the evening before; the store opened at 10:00 since.
      [{ away_sent_at: "2026-10-11T15:00:00Z", human_recent: false }],
      [{ id: "c1" }],
    ]);
    const r = await answerAutomatically(
      input({ welcomeEligible: false, now: CLOSED_NOW }),
    );
    expect(r.sent).toEqual(["away"]);
    // The CAS matches only the value that was read.
    expect(sqlParamValues(mock.calls.execute[1])).toContain(
      "2026-10-11T15:00:00Z",
    );
  });

  it("★ not straight after a person on the team replied", async () => {
    const mock = setup(configRow({ awayEnabled: true }), [
      [{ away_sent_at: null, human_recent: true }],
    ]);
    const r = await answerAutomatically(
      input({ welcomeEligible: false, now: CLOSED_NOW }),
    );
    expect(r.sent).toEqual([]);
    expect(mock.calls.execute).toHaveLength(1);
  });

  it("★ welcome and away go as ONE message, welcome first", async () => {
    setup(configRow({ welcomeEnabled: true, awayEnabled: true }), [
      [{ id: "c1" }],
      [{ away_sent_at: null, human_recent: false }],
      [{ id: "c1" }],
    ]);
    const r = await answerAutomatically(input({ now: CLOSED_NOW }));
    expect(r.sent).toEqual(["welcome", "away"]);
    expect(replyInChat).toHaveBeenCalledTimes(1);
    expect(sentBody()).toBe(
      "Hi, thanks for messaging Echoss!\n\nWe're closed right now.",
    );
  });
});

describe("answerAutomatically: where is my order", () => {
  const anOrder = {
    id: "o1",
    orderRef: "ORD1",
    createdAt: "2026-10-12T09:00:00+05:30",
    status: "processing",
    fulfilmentType: "delivery",
    pickupStatus: null,
    pickupReadyAt: null,
    pickupExpiresAt: null,
    pickupLocationName: null,
    deliveredAt: null,
    shipment: null,
  };

  it("★ answered with the customer's order: no greeting, no away, nobody needed", async () => {
    const mock = setup(
      configRow({
        orderStatusEnabled: true,
        welcomeEnabled: true,
        awayEnabled: true,
      }),
    );
    vi.mocked(lookupOrdersForPhone).mockResolvedValueOnce({
      ok: true,
      orders: [anOrder],
    });
    const r = await answerAutomatically(
      input({ orderQuestion: true, userId: "u1", now: CLOSED_NOW }),
    );
    expect(r).toEqual({ handOver: false, sent: ["order_status"] });
    expect(lookupOrdersForPhone).toHaveBeenCalledWith({
      storeId: STORE,
      phone: "+919876543210",
      userId: "u1",
    });
    expect(mock.calls.execute).toHaveLength(0);
    expect(sentBody()).toContain("Order ORD1, placed 12 Oct: Being prepared.");
    expect(sentBody()).toContain(
      "See all your orders: https://echoss.storemink.com/orders",
    );
  });

  it("★ nothing found: says so, keeps the welcome and away, and hands over", async () => {
    setup(configRow({ welcomeEnabled: true, awayEnabled: true }), [
      [{ id: "c1" }],
      [{ away_sent_at: null, human_recent: false }],
      [{ id: "c1" }],
    ]);
    const r = await answerAutomatically(
      input({ orderQuestion: true, now: CLOSED_NOW }),
    );
    expect(r).toEqual({
      handOver: true,
      sent: ["welcome", "order_status", "away"],
    });
    expect(sentBody()).toBe(
      [
        "Hi, thanks for messaging Echoss!",
        "We couldn't find a recent order placed with this number. Someone from Echoss will reply here.",
        "We're closed right now.",
      ].join("\n\n"),
    );
  });

  it("★ an answer that could not be sent hands the chat to a person", async () => {
    setup(configRow());
    vi.mocked(lookupOrdersForPhone).mockResolvedValueOnce({
      ok: true,
      orders: [anOrder],
    });
    vi.mocked(replyInChat).mockResolvedValueOnce(false);
    const r = await answerAutomatically(input({ orderQuestion: true }));
    expect(r).toEqual({ handOver: true, sent: [] });
  });

  it("no number to answer from: the question waits for a person", async () => {
    setup(configRow());
    vi.mocked(loadWhatsAppSender).mockResolvedValueOnce(null);
    const r = await answerAutomatically(input({ orderQuestion: true }));
    expect(r).toEqual({ handOver: true, sent: [] });
    expect(lookupOrdersForPhone).not.toHaveBeenCalled();
  });

  it("unreadable settings: the question waits for a person", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("down")] });
    const r = await answerAutomatically(input({ orderQuestion: true }));
    expect(r).toEqual({ handOver: true, sent: [] });
  });

  it("no order link while the store is still closed to the public", async () => {
    setup(configRow({ settings: { launched: false } }));
    vi.mocked(lookupOrdersForPhone).mockResolvedValueOnce({
      ok: true,
      orders: [anOrder],
    });
    await answerAutomatically(input({ orderQuestion: true }));
    expect(sentBody()).not.toContain("See all your orders");
  });
});
