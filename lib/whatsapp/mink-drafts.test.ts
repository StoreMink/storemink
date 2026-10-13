/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// The whatsapp_mink_answers ledger: the draft a thread shows, the claim, the
// charge (through the one database function) and the headroom check.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ chargeCredits: true })),
}));
vi.mock("@/lib/ai/quota", () => ({
  getMinkCreditCycle: vi.fn(async () => ({
    period: "cycle:2026-10-01T00:00:00.000Z",
    resetsAt: "2026-10-31T00:00:00.000Z",
  })),
}));
vi.mock("@/lib/plans/allowances", () => ({
  getPlanAllowancesLive: vi.fn(async () => ({
    free: null,
    basic: null,
    pro: null,
  })),
}));

import {
  chargeMinkAnswer,
  claimMinkDraft,
  discardMinkDrafts,
  loadMinkDraft,
  markMinkAnswerSent,
  minkChargeContext,
  minkCreditHeadroom,
} from "./mink-drafts";

const STORE = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const ANSWER = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  dbHolder.current = makeDbMock();
});

describe("minkChargeContext", () => {
  it("reads the cycle and the plan's cap, with charging on", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            plan: "basic",
            plan_expires_at: null,
            comp_plan: null,
            comp_expires_at: null,
          },
        ],
      ],
    });
    const ctx = await minkChargeContext(STORE);
    expect(ctx).toEqual({
      period: "cycle:2026-10-01T00:00:00.000Z",
      planCap: 100,
    });
  });
});

describe("minkCreditHeadroom", () => {
  it("sums what is left of the cycle and the top-ups; an unmetered plan is null", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ remaining: "7" }]] });
    expect(
      await minkCreditHeadroom(STORE, { period: "2026-10", planCap: 20 }),
    ).toBe(7);
    expect(sqlParamValues(dbHolder.current.calls.execute[0])).toContain(20);
    expect(
      await minkCreditHeadroom(STORE, { period: "2026-10", planCap: null }),
    ).toBeNull();
  });
});

describe("chargeMinkAnswer", () => {
  it("★ calls the one database function with the answer's id and returns its verdict", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ source: "plan" }]] });
    const source = await chargeMinkAnswer(dbHolder.current.db, {
      answerId: ANSWER,
      storeId: STORE,
      ctx: { period: "2026-10", planCap: 20 },
    });
    expect(source).toBe("plan");
    const q = dbHolder.current.calls.execute[0];
    expect(sqlText(q)).toContain("consume_mink_whatsapp_answer");
    expect(sqlParamValues(q)).toEqual(
      expect.arrayContaining([ANSWER, STORE, "2026-10", 20, 1]),
    );
  });

  it("throws when the function answers nothing, so a caller never sends unpaid", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[]] });
    await expect(
      chargeMinkAnswer(dbHolder.current.db, {
        answerId: ANSWER,
        storeId: STORE,
        ctx: { period: "2026-10", planCap: 20 },
      }),
    ).rejects.toThrow(/returned nothing/);
  });
});

describe("loadMinkDraft", () => {
  it("returns the newest pending draft with its facts, or null", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: ANSWER,
            answer: "Yes, in stock.",
            reason: "price in facts",
            facts: ["Almond Shake", 3, "Refund policy"],
            mode: "drafts",
            creditSource: null,
            createdAt: "2026-10-14T10:00:00Z",
          },
        ],
      ],
    });
    expect(await loadMinkDraft(STORE, CONV)).toEqual({
      id: ANSWER,
      text: "Yes, in stock.",
      reason: "price in facts",
      facts: ["Almond Shake", "Refund policy"],
      mode: "drafts",
      charged: false,
      createdAt: "2026-10-14T10:00:00Z",
    });
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await loadMinkDraft(STORE, CONV)).toBeNull();
  });
});

describe("claimMinkDraft / markMinkAnswerSent / discardMinkDrafts", () => {
  it("claims a pending draft under a row lock and reports whether it was charged", async () => {
    dbHolder.current = makeDbMock({
      executeQueue: [[{ id: ANSWER, credit_source: "credit" }]],
    });
    const claim = await claimMinkDraft(dbHolder.current.db, {
      storeId: STORE,
      conversationId: CONV,
      draftId: ANSWER,
    });
    expect(claim).toEqual({ id: ANSWER, charged: true });
    const q = sqlText(dbHolder.current.calls.execute[0]);
    expect(q).toContain("outcome = 'draft'");
    expect(q).toContain("for update");
    dbHolder.current = makeDbMock({ executeQueue: [[]] });
    expect(
      await claimMinkDraft(dbHolder.current.db, {
        storeId: STORE,
        conversationId: CONV,
        draftId: ANSWER,
      }),
    ).toBeNull();
  });

  it("marks a draft sent with the message and the person", async () => {
    await markMinkAnswerSent(dbHolder.current.db, {
      storeId: STORE,
      answerId: ANSWER,
      answer: "edited",
      sentMessageId: "m1",
      sentByAdminId: "admin-1",
    });
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      outcome: "sent",
      answer: "edited",
      sentMessageId: "m1",
      sentByAdminId: "admin-1",
    });
  });

  it("★ discards one named draft, or every pending one on the conversation", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ id: ANSWER }]] });
    const n = await discardMinkDrafts(dbHolder.current.db, {
      storeId: STORE,
      conversationId: CONV,
      draftId: ANSWER,
      reason: "discarded by a person",
    });
    expect(n).toBe(1);
    const one = sqlText(dbHolder.current.calls.execute[0]);
    expect(one).toContain("outcome = 'discarded'");
    expect(one).toContain("and id =");
    dbHolder.current = makeDbMock({
      executeQueue: [[{ id: "a" }, { id: "b" }]],
    });
    expect(
      await discardMinkDrafts(dbHolder.current.db, {
        storeId: STORE,
        conversationId: CONV,
        reason: "a person replied",
      }),
    ).toBe(2);
    expect(sqlText(dbHolder.current.calls.execute[0])).not.toContain(
      "and id =",
    );
  });
});
