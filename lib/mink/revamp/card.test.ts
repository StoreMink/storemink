import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMinkDraftProposal, imageCreditHeadroom } = vi.hoisted(() => ({
  createMinkDraftProposal: vi.fn(),
  imageCreditHeadroom: vi.fn(),
}));
vi.mock("../drafts", () => ({ createMinkDraftProposal }));
vi.mock("../image-credits", () => ({ imageCreditHeadroom }));
vi.mock("../config", () => ({
  getMinkConfig: () => ({ chargeCredits: true }),
}));

import { MinkToolInputError } from "../errors";
import { digestMinkStorefrontValue } from "../storefront-code-contract";
import type { MinkActorContext } from "../types";
import {
  REVAMP_CARD_EXPLANATION_MAX,
  clipExplanation,
  createRevampCard,
  readRevampCreditBalance,
} from "./card";
import { REVAMP_ERROR_MESSAGES, type RevampStoredPlan } from "./contract";
import {
  RevampOutOfCreditsError,
  RevampStepError,
  type RevampStepContext,
} from "./ports";

const STORE = "33333333-3333-4333-8333-333333333333";
const DRAFT = "55555555-5555-4555-8555-555555555555";

const ctx = {
  revampId: "11111111-1111-4111-8111-111111111111",
  actor: { storeId: STORE, adminId: "admin", runId: "run" },
  signal: new AbortController().signal,
  deadline: Date.now() + 60_000,
  report: async () => {},
} as unknown as RevampStepContext & { actor: MinkActorContext };

const planWith = (total: number, explanation = "A calmer, warmer shop.") =>
  ({
    schemaVersion: 2,
    revampId: ctx.revampId,
    summary: "Redesign",
    explanation,
    credits: {
      pages: 0,
      photos: 0,
      design: 0,
      chrome: 0,
      categories: 0,
      productPhotos: 0,
      total,
    },
    free: false,
  }) as unknown as RevampStoredPlan;

const proposal = (chargedCredits: number) => ({
  type: "proposal",
  draftId: DRAFT,
  chargedCredits,
  expectedCredits: chargedCredits,
  creditSource: chargedCredits ? "plan" : "free",
});

beforeEach(() => {
  createMinkDraftProposal.mockImplementation(async () => proposal(40));
});

describe("createRevampCard", () => {
  it("writes the whole plan, its digest and the explanation", async () => {
    const plan = planWith(40);
    await createRevampCard(ctx, { plan, free: false });
    const [input] = createMinkDraftProposal.mock.calls[0];
    expect(input).toMatchObject({
      actor: ctx.actor,
      kind: "storefront_personalization",
      title: "Your redesigned storefront",
      destinationType: "storefront",
      destinationLabel: "Whole storefront",
      destinationPath: "/dashboard/builder",
    });
    // ★ mink_drafts_storefront_personalization_target_check requires a NULL
    //   destination id; a store id there refused every card's insert.
    expect(input).not.toHaveProperty("destinationId");
    expect(input.content).toEqual({
      plan_json: JSON.stringify(plan),
      plan_digest: digestMinkStorefrontValue(plan),
      explanation: "A calmer, warmer shop.",
    });
    expect(input.content.plan_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(input.content.plan_json)).toEqual(plan);
  });

  it("gives the draft the revamp's own id, so a re-run cannot charge twice", async () => {
    await createRevampCard(ctx, { plan: planWith(40), free: false });
    await createRevampCard(ctx, { plan: planWith(0), free: true });
    expect(createMinkDraftProposal.mock.calls[0][0]).toMatchObject({
      draftId: ctx.revampId,
    });
    expect(createMinkDraftProposal.mock.calls[1][0]).toMatchObject({
      draftId: ctx.revampId,
    });
  });

  it("charges a paid card its total, capped at the revamp ceiling", async () => {
    const paid = await createRevampCard(ctx, {
      plan: planWith(40),
      free: false,
    });
    expect(createMinkDraftProposal.mock.calls[0][0]).toMatchObject({
      expectedCredits: 40,
    });
    expect(createMinkDraftProposal.mock.calls[0][0]).not.toHaveProperty("free");
    expect(paid).toEqual({ draftId: DRAFT, credits: 40 });

    await createRevampCard(ctx, { plan: planWith(900), free: false });
    expect(createMinkDraftProposal.mock.calls[1][0]).toMatchObject({
      expectedCredits: 200,
    });
  });

  it.each([
    ["a free revamp", 40, true],
    ["a paid total of zero", 0, false],
  ])("makes %s a free draft", async (_label, total, free) => {
    createMinkDraftProposal.mockImplementation(async () => proposal(0));
    const card = await createRevampCard(ctx, { plan: planWith(total), free });
    const [input] = createMinkDraftProposal.mock.calls[0];
    expect(input.free).toBe(true);
    expect(input).not.toHaveProperty("expectedCredits");
    expect(card).toEqual({ draftId: DRAFT, credits: 0 });
  });

  it.each([[-1], [1.5], [Number.NaN]])(
    "refuses an unreadable credit total %s rather than giving it away",
    async (total) => {
      await expect(
        createRevampCard(ctx, { plan: planWith(total), free: false }),
      ).rejects.toMatchObject({ code: "internal", transient: false });
      expect(createMinkDraftProposal).not.toHaveBeenCalled();
    },
  );

  it("★★ turns a credit refusal into the out-of-credits verdict, never internal (f-4)", async () => {
    createMinkDraftProposal.mockImplementation(async () => {
      throw new MinkToolInputError(
        "This store doesn't have enough Mink credits left for this personalised storefront. Buy Mink credits or upgrade under Plans & Billing.",
      );
    });
    const error = await createRevampCard(ctx, {
      plan: planWith(40),
      free: false,
    }).catch((e: unknown) => e);
    // ★ The job fails with the code whose sentence tells the merchant to buy
    //   credits; "something went wrong" sends them to support instead.
    expect(error).toBeInstanceOf(RevampOutOfCreditsError);
    expect(error).toBeInstanceOf(RevampStepError);
    expect(error).toMatchObject({
      jobCode: "out_of_credits",
      message: "insufficient credits",
      transient: false,
    });
    expect(REVAMP_ERROR_MESSAGES.out_of_credits).toMatch(/Mink credits/);
    // ★ The merchant's sentence names no number.
    expect(REVAMP_ERROR_MESSAGES.out_of_credits).not.toMatch(/\d/);
  });

  it("keeps any other tool refusal final, and rethrows anything else", async () => {
    createMinkDraftProposal.mockImplementation(async () => {
      throw new MinkToolInputError(
        "The draft run is not available. Try again.",
      );
    });
    const refusal = await createRevampCard(ctx, {
      plan: planWith(40),
      free: false,
    }).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "internal", transient: false });
    expect(refusal).not.toBeInstanceOf(RevampOutOfCreditsError);

    const boom = new Error("connection reset");
    createMinkDraftProposal.mockImplementation(async () => {
      throw boom;
    });
    await expect(
      createRevampCard(ctx, { plan: planWith(40), free: false }),
    ).rejects.toBe(boom);
  });
});

describe("readRevampCreditBalance (f-4)", () => {
  it("reads the balance the start tool budgets from, for the requester's store", async () => {
    imageCreditHeadroom.mockResolvedValue({
      period: "p",
      planCap: 300,
      remaining: 42,
    });
    expect(await readRevampCreditBalance(ctx)).toBe(42);
    expect(imageCreditHeadroom).toHaveBeenCalledWith(ctx.actor, true);
  });

  it("is null on an unmetered plan", async () => {
    imageCreditHeadroom.mockResolvedValue({
      period: "p",
      planCap: null,
      remaining: null,
    });
    expect(await readRevampCreditBalance(ctx)).toBeNull();
  });
});

describe("clipExplanation", () => {
  it("clips to the draft field's limit without splitting a character", () => {
    expect(clipExplanation("x".repeat(1_500))).toHaveLength(
      REVAMP_CARD_EXPLANATION_MAX,
    );
    const emoji = "a".repeat(REVAMP_CARD_EXPLANATION_MAX - 1) + "😀tail";
    const clipped = clipExplanation(emoji);
    expect(clipped).toBe("a".repeat(REVAMP_CARD_EXPLANATION_MAX - 1));
  });

  it("falls back to a plain sentence when there is no explanation", () => {
    expect(clipExplanation("   ")).toMatch(/redesigned your storefront/);
    expect(clipExplanation(undefined)).toMatch(/redesigned your storefront/);
  });
});
