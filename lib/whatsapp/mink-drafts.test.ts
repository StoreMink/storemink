/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// The whatsapp_mink_answers ledger: the draft a thread shows, the claim (a
// send lease), the charge (through the one database function), the headroom
// check, and the "a person already replied" rule they share.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
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
  MINK_SEND_LEASE_MINUTES,
  chargeMinkAnswer,
  claimMinkDraft,
  discardMinkDrafts,
  loadMinkDraft,
  markMinkAnswerSent,
  minkChargeContext,
  minkCreditHeadroom,
  personRepliedSince,
  releaseMinkDraftClaim,
} from "./mink-drafts";

/** One statement as Postgres receives it, whitespace collapsed. */
const flat = (text: string) => text.replace(/\s+/g, " ");

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

  it("★ shows no card while the draft is being sent, or once a person answered", async () => {
    const pending = {
      id: ANSWER,
      answer: "Yes, in stock.",
      reason: "",
      facts: [],
      mode: "helps",
      creditSource: null,
      createdAt: "2026-10-14T10:00:00Z",
    };
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...pending, sending: true, answered: false }]],
    });
    expect(await loadMinkDraft(STORE, CONV)).toBeNull();
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...pending, sending: false, answered: true }]],
    });
    expect(await loadMinkDraft(STORE, CONV)).toBeNull();
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...pending, sending: false, answered: false }]],
    });
    expect(await loadMinkDraft(STORE, CONV)).toMatchObject({ id: ANSWER });

    // The two flags are computed by the database, from the same rules the
    // claim applies.
    const projection = dbHolder.current.calls.select[0];
    const dialect = new PgDialect();
    const sending = flat(dialect.sqlToQuery(projection.sending).sql);
    expect(sending).toContain(
      '"whatsapp_mink_answers"."sending_started_at" is not null',
    );
    expect(sending).toContain(">= now() - make_interval(mins => $1)");
    const answered = flat(dialect.sqlToQuery(projection.answered).sql);
    expect(answered).toContain("m.source in ('dashboard', 'phone_app')");
    expect(answered).toContain('q.id = "whatsapp_mink_answers"."message_id"');
  });
});

describe("the send lease: claim, release, sent, discard", () => {
  const claim = () =>
    claimMinkDraft(dbHolder.current.db, {
      storeId: STORE,
      conversationId: CONV,
      draftId: ANSWER,
    });

  it("★★ the claim TAKES the draft (a conditional update), not a lock released at commit", async () => {
    dbHolder.current = makeDbMock({
      executeQueue: [[{ id: ANSWER, credit_source: "credit" }]],
    });
    expect(await claim()).toEqual({ id: ANSWER, charged: true });
    const q = dbHolder.current.calls.execute[0];
    const text = flat(sqlText(q));
    expect(text).toContain(
      "update public.whatsapp_mink_answers a set sending_started_at = now()",
    );
    expect(text).toContain("a.outcome = 'draft'");
    // Not while somebody else holds a lease that has not run out.
    expect(text).toContain(
      "and not (a.sending_started_at is not null and a.sending_started_at >= now() - make_interval(mins =>",
    );
    // Not once a person has answered the customer's message.
    expect(text).toContain(
      "and not exists ( select 1 from public.whatsapp_messages m",
    );
    expect(text).toContain("returning a.id, a.credit_source");
    expect(text).not.toContain("for update");
    expect(sqlParamValues(q)).toEqual(
      expect.arrayContaining([ANSWER, STORE, CONV, MINK_SEND_LEASE_MINUTES]),
    );
    expect(MINK_SEND_LEASE_MINUTES).toBe(2);
  });

  it("★ a second claim finds the draft taken: null, so the caller sends nothing", async () => {
    dbHolder.current = makeDbMock({
      executeQueue: [[{ id: ANSWER, credit_source: null }], []],
    });
    expect(await claim()).toEqual({ id: ANSWER, charged: false });
    expect(await claim()).toBeNull();
  });

  it("a release gives a still-pending draft back, and only that", async () => {
    await releaseMinkDraftClaim(dbHolder.current.db, {
      storeId: STORE,
      answerId: ANSWER,
    });
    const q = dbHolder.current.calls.execute[0];
    const text = flat(sqlText(q));
    expect(text).toContain("set sending_started_at = null");
    expect(text).toContain("and outcome = 'draft'");
    expect(sqlParamValues(q)).toEqual([ANSWER, STORE]);
  });

  it("★ marks a draft sent with the message and the person, only while it is pending, and ends the lease", async () => {
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
      sendingStartedAt: null,
    });
    const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[0]);
    expect(where.sql).toContain('"whatsapp_mink_answers"."outcome" = $3');
    expect(where.params).toEqual([ANSWER, STORE, "draft"]);
  });

  it("★ discards one named draft, or every pending one, but never one being sent", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ id: ANSWER }]] });
    const n = await discardMinkDrafts(dbHolder.current.db, {
      storeId: STORE,
      conversationId: CONV,
      draftId: ANSWER,
      reason: "discarded by a person",
    });
    expect(n).toBe(1);
    const one = flat(sqlText(dbHolder.current.calls.execute[0]));
    expect(one).toContain("outcome = 'discarded'");
    expect(one).toContain("and a.id =");
    expect(one).toContain(
      "and not (a.sending_started_at is not null and a.sending_started_at >= now() - make_interval(mins =>",
    );
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
      "and a.id =",
    );
  });
});

describe("personRepliedSince", () => {
  it("★ asks whether a person answered after the customer's message", async () => {
    dbHolder.current = makeDbMock({
      executeQueue: [[{ replied: true }], [{ replied: false }], []],
    });
    const ask = () =>
      personRepliedSince(dbHolder.current.db, {
        storeId: STORE,
        conversationId: CONV,
        messageId: ANSWER,
      });
    expect(await ask()).toBe(true);
    expect(await ask()).toBe(false);
    expect(await ask()).toBe(false);

    const q = dbHolder.current.calls.execute[0];
    const text = flat(sqlText(q));
    // A person: the dashboard, the WhatsApp Business app, or any staff send
    // (a template reply carries sent_by_admin_id). A refused send answered
    // nobody.
    expect(text).toContain("m.direction = 'out'");
    expect(text).toContain(
      "(m.source in ('dashboard', 'phone_app') or m.sent_by_admin_id is not null)",
    );
    expect(text).toContain("m.status is distinct from 'failed'");
    expect(text).toContain("m.sent_at > (select q.sent_at");
    expect(sqlParamValues(q)).toEqual([STORE, CONV, ANSWER, STORE]);
  });
});
