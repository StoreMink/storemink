/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

// The acting store every query must be scoped to (matches the getActingStoreId
// mock below).
const STORE = "a0000000-0000-4000-8000-000000000001";

vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => STORE),
}));
vi.mock("@/lib/ai/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/gemini")>()),
  callGemini: vi.fn(),
  brandSystemText: vi.fn((b: string) => `SYSTEM:${b}`),
}));
vi.mock("@/lib/ai/brand-voice", () => ({
  getBrandSoulForStore: vi.fn(async () => "brand soul"),
}));
// What consumeAiQuota took; refundAiQuota must be handed exactly this back.
const AI_TAKE = vi.hoisted(() => ({
  source: "plan" as const,
  takeId: "33333333-3333-4333-8333-333333333333",
  period: "2026-10",
}));
vi.mock("@/lib/ai/quota", () => ({
  consumeAiQuota: vi.fn(async () => ({ allowed: true, taken: AI_TAKE })),
  refundAiQuota: vi.fn(async () => "refunded"),
}));
vi.mock("@/lib/plans/entitlements", () => ({
  storeAllowsPlanFeature: vi.fn(async () => true),
}));
vi.mock("@/lib/email/coupon-campaign", async () => {
  // The dash normaliser is pure, so the real one runs: the AI draft test below
  // asserts what the merchant actually receives.
  const actual = await vi.importActual<
    typeof import("@/lib/email/coupon-campaign")
  >("@/lib/email/coupon-campaign");
  return {
    mergeTokens: vi.fn((t: string) => t),
    renderCouponEmail: vi.fn(() => "<html>"),
    withoutLongDashes: actual.withoutLongDashes,
  };
});
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/email/trigger-worker", () => ({
  triggerEmailWorker: vi.fn(),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => ({
    name: "WholeSip",
    logoUrl: null,
    primaryColor: "#000000",
    tagline: null,
    blurb: null,
    legalName: null,
    creditLine: null,
    email: null,
    phone: null,
    hours: null,
    social: { instagram: null, youtube: null, whatsapp: null },
    badges: [],
    domain: "wholesip.com",
  })),
}));

// getResend() still constructs a Resend client to verify config is present.
const { batchSend } = vi.hoisted(() => ({ batchSend: vi.fn() }));
vi.mock("resend", () => {
  class Resend {
    batch = { send: batchSend };
    constructor() {}
  }
  return { Resend };
});

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  listEmailRecipients,
  generateCouponEmail,
  renderCouponEmailPreview,
  sendCouponEmail,
} from "./coupon-email-actions";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { AI_UNUSABLE_MESSAGE, callGemini } from "@/lib/ai/gemini";
import { consumeAiQuota, refundAiQuota } from "@/lib/ai/quota";
import { storeAllowsPlanFeature } from "@/lib/plans/entitlements";
import { mergeTokens, renderCouponEmail } from "@/lib/email/coupon-campaign";

const genInput = {
  code: "SAVE10",
  description: "Ten off",
  discountLabel: "10% off",
  validUntilLabel: "Dec 31",
  audienceLabel: "VIP shoppers",
  instructions: "be cheerful",
};

const previewInput = {
  subject: "Hi {{first_name}}",
  body: "Body copy",
  code: "SAVE10",
  discountLabel: "10% off",
  validUntilLabel: "Dec 31",
};

const sendInput = {
  subject: "Hi {{first_name}}",
  body: "Body copy",
  code: "SAVE10",
  discountLabel: "10% off",
  validUntilLabel: "Dec 31",
  audience: { mode: "all" as const },
};

// Build a users row in the aliased snake_case shape RECIPIENT_COLUMNS returns.
const u = (id: string, email: string | null) => ({
  id,
  first_name: id.toUpperCase(),
  last_name: null,
  email,
  phone: "1",
});

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock({ returning: [{ id: "camp1" }] });
  vi.mocked(getManagerUserId).mockResolvedValue("user-1");
  vi.mocked(consumeAiQuota).mockResolvedValue({
    allowed: true,
    taken: AI_TAKE,
  });
  vi.mocked(callGemini).mockResolvedValue({
    text: JSON.stringify({ subject: "S", body: "B" }),
  });
  vi.mocked(mergeTokens).mockImplementation((t: string) => t);
  vi.mocked(renderCouponEmail).mockReturnValue("<html>");
  batchSend.mockResolvedValue({ data: { data: [{ id: "1" }] }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// listEmailRecipients — select #1 = the emailable count, #2 = the page rows.
describe("listEmailRecipients", () => {
  it("rejects unauthenticated callers", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const result = await listEmailRecipients();
    expect(result.error).toMatch(/not authenticated/i);
    expect(result.customers).toEqual([]);
  });

  it("returns a friendly error on DB failure", async () => {
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("boom");
    });
    const result = await listEmailRecipients();
    expect(result.error).toMatch(/could not load customers/i);
    expect(result.customers).toEqual([]);
  });

  it("maps rows into RecipientOptions and returns the emailable total", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ n: 7 }],
        [
          {
            id: "c1",
            first_name: "Ada",
            last_name: "Lovelace",
            email: "ada@x.com",
            phone: "+1",
          },
          {
            id: "c2",
            first_name: null,
            last_name: null,
            email: null,
            phone: null,
          },
        ],
      ],
    });
    const result = await listEmailRecipients();
    expect(result.error).toBeUndefined();
    expect(result.total).toBe(7);
    expect(result.customers).toEqual([
      {
        id: "c1",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@x.com",
        phone: "+1",
      },
      { id: "c2", first_name: "", last_name: null, email: null, phone: "" },
    ]);
  });

  it("filters by the search term (where carries an OR of ilikes)", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ n: 0 }], []] });
    await listEmailRecipients("ada");
    // count query (store + isNotNull) + list query (store AND isNotNull AND or(...)).
    expect(dbHolder.current.calls.where).toHaveLength(2);
  });

  it("scopes BOTH the count and the list query to the acting store", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ n: 0 }], []] });
    await listEmailRecipients("ada");
    expect(getActingStoreId).toHaveBeenCalled();
    // The store id is bound into both where clauses — no cross-tenant leak.
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(STORE);
    expect(sqlParamValues(dbHolder.current.calls.where[1])).toContain(STORE);
  });
});

describe("generateCouponEmail", () => {
  it("rejects unauthenticated callers", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const result = await generateCouponEmail(genInput);
    expect(result.error).toMatch(/not authenticated/i);
  });

  it("blocks the generation when the monthly AI quota is spent", async () => {
    vi.mocked(consumeAiQuota).mockResolvedValueOnce({
      allowed: false,
      error: "You've used all 10 AI generations…",
    });
    const result = await generateCouponEmail(genInput);
    expect(result.error).toMatch(/AI generations/i);
    expect(callGemini).not.toHaveBeenCalled();
  });

  // ★★ B1: the credit was taken first, so every failure gives it back.
  it("surfaces a callGemini error and gives the credit back", async () => {
    vi.mocked(callGemini).mockResolvedValue({ error: "AI busy" });
    const result = await generateCouponEmail(genInput);
    expect(result.error).toBe("AI busy");
    expect(refundAiQuota).toHaveBeenCalledTimes(1);
    expect(refundAiQuota).toHaveBeenCalledWith(STORE, AI_TAKE);
  });

  it("gives the credit back when the AI response is not valid JSON", async () => {
    vi.mocked(callGemini).mockResolvedValue({ text: "not json {{{" });
    const result = await generateCouponEmail(genInput);
    expect(result.error).toBe(AI_UNUSABLE_MESSAGE);
    expect(refundAiQuota).toHaveBeenCalledTimes(1);
  });

  it("gives the credit back when the JSON is incomplete (missing body)", async () => {
    vi.mocked(callGemini).mockResolvedValue({
      text: JSON.stringify({ subject: "Hi" }),
    });
    const result = await generateCouponEmail(genInput);
    expect(result.error).toBe(AI_UNUSABLE_MESSAGE);
    expect(refundAiQuota).toHaveBeenCalledTimes(1);
  });

  it("gives the credit back when the brand voice read throws", async () => {
    const { getBrandSoulForStore } = await import("@/lib/ai/brand-voice");
    vi.mocked(getBrandSoulForStore).mockRejectedValueOnce(new Error("db down"));
    await expect(generateCouponEmail(genInput)).rejects.toThrow("db down");
    expect(refundAiQuota).toHaveBeenCalledWith(STORE, AI_TAKE);
  });

  // ★ The rates are per store AND per admin, so the take names who asked.
  it("takes the credit for the admin who asked", async () => {
    await generateCouponEmail(genInput);
    expect(consumeAiQuota).toHaveBeenCalledWith(STORE, { actorId: "user-1" });
  });

  // ★★ A server action is reachable without its form: what reaches the model
  //    is bounded here, never by the browser.
  it("cuts the team's direction and the note to their bound", async () => {
    await generateCouponEmail({
      ...genInput,
      code: "X".repeat(1_000),
      description: "n".repeat(10_000),
      instructions: "i".repeat(10_000),
    });
    const [, userText] = vi.mocked(callGemini).mock.calls[0];
    expect(userText).toContain(`Coupon code: ${"X".repeat(300)}\n`);
    expect(userText.match(/n{4000}/)).not.toBeNull();
    expect(userText).not.toMatch(/n{4001}/);
    expect(userText.match(/i{4000}/)).not.toBeNull();
    expect(userText).not.toMatch(/i{4001}/);
  });

  it("refunds nothing when the plan or the quota refused it", async () => {
    vi.mocked(consumeAiQuota).mockResolvedValueOnce({
      allowed: false,
      error: "You've used all 10 AI generations…",
    });
    await generateCouponEmail(genInput);
    vi.mocked(storeAllowsPlanFeature).mockResolvedValueOnce(false);
    await generateCouponEmail(genInput);
    expect(refundAiQuota).not.toHaveBeenCalled();
  });

  it("returns the trimmed subject + body on success and keeps the credit", async () => {
    vi.mocked(callGemini).mockResolvedValue({
      text: JSON.stringify({ subject: "  Sub  ", body: "  Bod  " }),
    });
    const result = await generateCouponEmail(genInput);
    expect(result.subject).toBe("Sub");
    expect(result.body).toBe("Bod");
    expect(result.error).toBeUndefined();
    expect(refundAiQuota).not.toHaveBeenCalled();
  });

  // ★ The schema is sent the way lib/mink sends one: JSON Schema, lowercase.
  it("asks for JSON through responseJsonSchema", async () => {
    await generateCouponEmail(genInput);
    const options = vi.mocked(callGemini).mock.calls[0][2]!;
    expect(options.responseMimeType).toBe("application/json");
    expect(options.responseJsonSchema).toMatchObject({
      type: "object",
      required: ["subject", "body"],
      additionalProperties: false,
    });
    expect(options).not.toHaveProperty("responseSchema");
  });

  // The draft is StoreMink-written email copy, so a long dash the model slips
  // in despite the prompt is rewritten before the merchant ever sees it.
  it("rewrites long dashes in the AI draft", async () => {
    vi.mocked(callGemini).mockResolvedValue({
      text: JSON.stringify({
        subject: "A treat for you \u2014 {{first_name}}",
        body: "Hi {{first_name}} \u2014\n\nShakes for 2\u20134 people \u2014 on us.",
      }),
    });
    const result = await generateCouponEmail(genInput);
    expect(result.subject).toBe("A treat for you, {{first_name}}");
    expect(result.body).toBe(
      "Hi {{first_name}},\n\nShakes for 2 to 4 people, on us.",
    );
    expect(`${result.subject}${result.body}`).not.toMatch(/[\u2013\u2014]/);
  });

  // The prompt itself must not promise the old sign-off or model long dashes.
  it("asks for dash-free copy and names the current sign-off", async () => {
    vi.mocked(callGemini).mockResolvedValue({
      text: JSON.stringify({ subject: "S", body: "B" }),
    });
    await generateCouponEmail(genInput);
    const prompt = vi.mocked(callGemini).mock.calls[0][1] as string;
    expect(prompt).toContain('"The {store name} team"');
    expect(prompt).not.toContain("Team {store name}");
    expect(prompt).toMatch(/never use an em dash or an en dash/i);
    expect(prompt).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("renderCouponEmailPreview", () => {
  it("rejects unauthenticated callers", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const result = await renderCouponEmailPreview(previewInput);
    expect(result.error).toMatch(/not authenticated/i);
  });

  it("renders HTML and merges the subject with the sample name", async () => {
    const result = await renderCouponEmailPreview({
      ...previewInput,
      sampleName: "Ada",
    });
    expect(result.html).toBe("<html>");
    expect(renderCouponEmail).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Ada", body: "Body copy" }),
    );
    expect(mergeTokens).toHaveBeenCalledWith("Hi {{first_name}}", "Ada");
  });
});

// sendCouponEmail — resolve audience (select), then ENQUEUE a campaign (insert
// + returning) and recipient rows (chunked insert).
describe("sendCouponEmail (enqueue)", () => {
  it("blocks campaigns below Pro before creating any records", async () => {
    vi.mocked(storeAllowsPlanFeature).mockResolvedValueOnce(false);
    const result = await sendCouponEmail(sendInput);
    expect(result.error).toMatch(/available on Pro/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_realkey");
  });

  it("rejects unauthenticated callers", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    const result = await sendCouponEmail(sendInput);
    expect(result.error).toMatch(/not authenticated/i);
  });

  it("rejects an empty subject", async () => {
    const result = await sendCouponEmail({ ...sendInput, subject: "   " });
    expect(result.error).toMatch(/subject and body/i);
  });

  it("rejects an empty body", async () => {
    const result = await sendCouponEmail({ ...sendInput, body: "   " });
    expect(result.error).toMatch(/subject and body/i);
  });

  it("errors when RESEND_API_KEY is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const result = await sendCouponEmail(sendInput);
    expect(result.error).toMatch(/isn.?t configured/i);
  });

  it("errors when RESEND_API_KEY is a placeholder", async () => {
    vi.stubEnv("RESEND_API_KEY", "placeholder-key");
    const result = await sendCouponEmail(sendInput);
    expect(result.error).toMatch(/isn.?t configured/i);
  });

  it("queues all customers (mode: all)", async () => {
    // audience select → 2 emailable users.
    dbHolder.current = makeDbMock({
      returning: [{ id: "camp1" }],
      selectQueue: [[u("a", "ada@x.com"), u("b", "bob@x.com")]],
    });
    const result = await sendCouponEmail({
      ...sendInput,
      audience: { mode: "all" },
    });
    expect(result.error).toBeUndefined();
    expect(result.queued).toBe(2);
    expect(result.skippedNoEmail).toBe(0);
    // values[0] = the campaign, values[1] = the recipient chunk.
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      subject: "Hi {{first_name}}",
      total: 2,
      storeId: "a0000000-0000-4000-8000-000000000001",
    });
    expect(dbHolder.current.calls.values[1]).toHaveLength(2);
    expect(dbHolder.current.calls.values[1][0]).toMatchObject({
      campaignId: "camp1",
      email: "ada@x.com",
    });
  });

  it("resolves group members (mode: group)", async () => {
    // select #1 = group members, #2 = users by id.
    dbHolder.current = makeDbMock({
      returning: [{ id: "camp1" }],
      selectQueue: [
        [{ user_id: "a" }, { user_id: "b" }],
        [u("a", "ada@x.com"), u("b", "bob@x.com")],
      ],
    });
    const result = await sendCouponEmail({
      ...sendInput,
      audience: { mode: "group", groupId: "g1" },
    });
    expect(result.queued).toBe(2);
  });

  it("scopes the audience resolution to the acting store (all/group/specific)", async () => {
    // mode: all — single users select, filtered by store.
    dbHolder.current = makeDbMock({
      returning: [{ id: "camp1" }],
      selectQueue: [[u("a", "ada@x.com")]],
    });
    await sendCouponEmail({ ...sendInput, audience: { mode: "all" } });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(STORE);

    // mode: group — membership (group + store) then users-by-id (+ store).
    dbHolder.current = makeDbMock({
      returning: [{ id: "camp1" }],
      selectQueue: [[{ user_id: "a" }], [u("a", "ada@x.com")]],
    });
    await sendCouponEmail({
      ...sendInput,
      audience: { mode: "group", groupId: "g1" },
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(STORE);
    expect(sqlParamValues(dbHolder.current.calls.where[1])).toContain(STORE);

    // mode: specific — users-by-id filtered by store (a crafted foreign id
    // can't resolve another store's customer).
    dbHolder.current = makeDbMock({
      returning: [{ id: "camp1" }],
      selectQueue: [[u("a", "ada@x.com")]],
    });
    await sendCouponEmail({
      ...sendInput,
      audience: { mode: "specific", customerIds: ["a"] },
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(STORE);
  });

  it("returns no-email error for an empty group (nothing enqueued)", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] }); // no members
    const result = await sendCouponEmail({
      ...sendInput,
      audience: { mode: "group", groupId: "g1" },
    });
    expect(result.queued).toBe(0);
    expect(result.error).toMatch(/none of the selected customers/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("resolves specific customers (mode: specific)", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ id: "camp1" }],
      selectQueue: [[u("a", "ada@x.com")]],
    });
    const result = await sendCouponEmail({
      ...sendInput,
      audience: { mode: "specific", customerIds: ["a"] },
    });
    expect(result.queued).toBe(1);
  });

  it("returns no-email error for empty specific list", async () => {
    const result = await sendCouponEmail({
      ...sendInput,
      audience: { mode: "specific", customerIds: [] },
    });
    expect(result.queued).toBe(0);
    expect(result.error).toMatch(/none of the selected customers/i);
  });

  it("counts recipients with no email as skipped", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ id: "camp1" }],
      selectQueue: [[u("a", "ada@x.com"), u("b", null), u("c", null)]],
    });
    const result = await sendCouponEmail({
      ...sendInput,
      audience: { mode: "all" },
    });
    expect(result.queued).toBe(1);
    expect(result.skippedNoEmail).toBe(2);
  });

  it("errors (and enqueues nothing) when nobody has an email", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[u("b", null)]] });
    const result = await sendCouponEmail({
      ...sendInput,
      audience: { mode: "all" },
    });
    expect(result.queued).toBe(0);
    expect(result.skippedNoEmail).toBe(1);
    expect(result.error).toMatch(/none of the selected customers/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("errors when the campaign row can't be created", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[u("a", "ada@x.com")]] });
    dbHolder.current.db.insert = vi.fn(() => {
      throw new Error("no table");
    });
    const result = await sendCouponEmail({
      ...sendInput,
      audience: { mode: "all" },
    });
    expect(result.error).toMatch(/could not queue the campaign/i);
  });

  it("errors when recipient rows can't be enqueued", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ id: "camp1" }],
      selectQueue: [[u("a", "ada@x.com")]],
    });
    // First insert (campaign) succeeds; the second (recipients) throws.
    let inserts = 0;
    const realInsert = dbHolder.current.db.insert;
    dbHolder.current.db.insert = vi.fn((t: any) => {
      if (inserts++ === 0) return realInsert(t);
      throw new Error("boom");
    });
    const result = await sendCouponEmail({
      ...sendInput,
      audience: { mode: "all" },
    });
    expect(result.error).toMatch(/could not queue all recipients/i);
  });
});
