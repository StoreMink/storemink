import { describe, expect, it } from "vitest";
import {
  basePromptTokens,
  CACHED_INPUT_RATE_MULTIPLIER,
  cachedPromptTokens,
  estimateMinkCost,
} from "./cost";

const usage = {
  promptTokens: 1_000,
  outputTokens: 200,
  thoughtTokens: 50,
  totalTokens: 1_250,
  cachedTokens: 0,
  basePromptTokens: 0,
};

describe("estimateMinkCost", () => {
  it("prices Gemini 3.7 Flash response and thought tokens as output", () => {
    expect(
      estimateMinkCost({
        model: "gemini-3.7-flash",
        location: "global",
        usage,
        at: new Date("2026-08-29T00:00:00Z"),
      }),
    ).toEqual({
      estimatedCostMicrousd: 1_688,
      pricingVersion: `gemini-3.7-flash-global-2026-intro-c${CACHED_INPUT_RATE_MULTIPLIER}`,
    });
  });

  it("uses the documented standard rate from 2027", () => {
    expect(
      estimateMinkCost({
        model: "gemini-3.7-flash",
        location: "global",
        usage,
        at: new Date("2027-01-01T00:00:00Z"),
      }).estimatedCostMicrousd,
    ).toBe(3_375);
  });

  it("keeps unknown models visibly unpriced instead of treating them as free", () => {
    expect(
      estimateMinkCost({
        model: "future-model",
        location: "global",
        usage,
      }),
    ).toEqual({ estimatedCostMicrousd: null, pricingVersion: null });
  });

  it("charges a cached prompt token at the reduced rate, not the full one", () => {
    // Same 1,000 prompt tokens, 400 of them served from cache. Only the input
    // side moves: 600 fresh + 400 × 0.25 = 700 effective input tokens.
    const cached = estimateMinkCost({
      model: "gemini-3.7-flash",
      location: "global",
      usage: { ...usage, cachedTokens: 400 },
      at: new Date("2026-08-29T00:00:00Z"),
    });
    const uncached = estimateMinkCost({
      model: "gemini-3.7-flash",
      location: "global",
      usage,
      at: new Date("2026-08-29T00:00:00Z"),
    });
    expect(cached.estimatedCostMicrousd).toBe(1_463);
    expect(cached.estimatedCostMicrousd).toBeLessThan(
      uncached.estimatedCostMicrousd!,
    );
  });

  it("never counts a cached token twice — it is a subset of the prompt count", () => {
    // A fully-cached prompt must cost the cached rate on every prompt token,
    // not the full rate plus a cached surcharge. Adding cachedTokens to
    // promptTokens instead of subtracting it is the misreading this pins.
    expect(
      estimateMinkCost({
        model: "gemini-3.7-flash",
        location: "global",
        usage: { ...usage, cachedTokens: 1_000 },
        at: new Date("2026-08-29T00:00:00Z"),
      }).estimatedCostMicrousd,
    ).toBe(1_125); // 1,000 × 0.75 × 0.25 + 250 × 3.75
  });

  it("stamps the cached multiplier into the pricing version so rows can be repriced", () => {
    // The multiplier is an ASSUMPTION. A ledger row is only recomputable
    // against a corrected rate if it records which rate produced it.
    expect(
      estimateMinkCost({ model: "gemini-3.7-flash", location: "global", usage })
        .pricingVersion,
    ).toContain(`-c${CACHED_INPUT_RATE_MULTIPLIER}`);
  });
});

describe("the lite model", () => {
  it("prices Gemini 3.5 Flash-Lite at its list rate, thought tokens as output", () => {
    // 1,000 × 0.30 + 250 × 2.50 = 925 micro-USD.
    expect(
      estimateMinkCost({
        model: "gemini-3.5-flash-lite",
        location: "global",
        usage,
      }),
    ).toEqual({
      estimatedCostMicrousd: 925,
      pricingVersion: `gemini-3.5-flash-lite-global-2026-list-c${CACHED_INPUT_RATE_MULTIPLIER}`,
    });
  });

  it("charges its cached prompt tokens at the same reduced share", () => {
    const cached = estimateMinkCost({
      model: "publishers/google/models/gemini-3.5-flash-lite",
      location: "global",
      usage: { ...usage, cachedTokens: 800 },
    }).estimatedCostMicrousd;
    expect(cached).toBe(
      Math.round(
        200 * 0.3 + 800 * 0.3 * CACHED_INPUT_RATE_MULTIPLIER + 250 * 2.5,
      ),
    );
  });

  it("★ leaves a regional or other lite model unpriced rather than guessing", () => {
    expect(
      estimateMinkCost({
        model: "gemini-3.5-flash-lite",
        location: "asia-south1",
        usage,
      }).estimatedCostMicrousd,
    ).toBeNull();
    expect(
      estimateMinkCost({
        model: "gemini-3.1-flash-lite",
        location: "global",
        usage,
      }).estimatedCostMicrousd,
    ).toBeNull();
  });
});

// ★★ B24: the fallback, where voice turns start and a busy main model's turns
// go, recorded an unknown cost for every run it answered.
describe("the fallback model, Gemini 3.5 Flash", () => {
  it("prices a run at asia-south1, where Mink calls it, at the regional rate", () => {
    // 1,000 × 1.65 + 250 × 9.90 = 1,650 + 2,475 = 4,125 micro-USD.
    expect(
      estimateMinkCost({
        model: "gemini-3.5-flash",
        location: "asia-south1",
        usage,
      }),
    ).toEqual({
      estimatedCostMicrousd: 4_125,
      pricingVersion: `gemini-3.5-flash-regional-2026-list-c${CACHED_INPUT_RATE_MULTIPLIER}`,
    });
  });

  it("prices a run at global at the list rate", () => {
    // 1,000 × 1.50 + 250 × 9.00 = 1,500 + 2,250 = 3,750 micro-USD.
    expect(
      estimateMinkCost({
        model: "publishers/google/models/gemini-3.5-flash",
        location: "global",
        usage,
      }),
    ).toEqual({
      estimatedCostMicrousd: 3_750,
      pricingVersion: `gemini-3.5-flash-global-2026-list-c${CACHED_INPUT_RATE_MULTIPLIER}`,
    });
  });

  it("charges its cached prompt tokens at the same reduced share", () => {
    // 600 × 1.65 + 400 × 1.65 × 0.25 + 250 × 9.90 = 990 + 165 + 2,475.
    expect(
      estimateMinkCost({
        model: "gemini-3.5-flash",
        location: "asia-south1",
        usage: { ...usage, cachedTokens: 400 },
      }).estimatedCostMicrousd,
    ).toBe(3_630);
  });

  it("★ a run priced here is told apart from the rows written before the price existed", () => {
    const version = estimateMinkCost({
      model: "gemini-3.5-flash",
      location: "asia-south1",
      usage,
    }).pricingVersion;
    // Earlier rows carry null; nor may it read as the lite model's version.
    expect(version).not.toBeNull();
    expect(version).not.toContain("flash-lite");
  });

  it("leaves a pinned or other 3.5 model unpriced rather than guessing", () => {
    for (const model of ["gemini-3.5-flash-001", "gemini-3.5-pro"]) {
      expect(
        estimateMinkCost({ model, location: "asia-south1", usage })
          .estimatedCostMicrousd,
      ).toBeNull();
    }
  });
});

describe("cachedPromptTokens", () => {
  it("clamps a provider count that exceeds the prompt it is a subset of", () => {
    // This value is written to a column whose CHECK sits in the SAME
    // transaction as the run completion and the assistant message, so an
    // unclamped provider oddity would roll back a reply already shown.
    expect(
      cachedPromptTokens({ ...usage, promptTokens: 100, cachedTokens: 900 }),
    ).toBe(100);
  });

  it("clamps a negative count to zero", () => {
    expect(cachedPromptTokens({ ...usage, cachedTokens: -5 })).toBe(0);
  });

  it("passes an ordinary count through untouched", () => {
    expect(cachedPromptTokens({ ...usage, cachedTokens: 400 })).toBe(400);
  });
});

// ★★ THE LEDGER'S base_prompt_tokens CHECK SHARES A TRANSACTION WITH THE
// MERCHANT'S REPLY, exactly as cached_tokens does. A value that tripped it
// would roll back an answer already on screen, so the clamp is not cosmetic.
describe("basePromptTokens", () => {
  it("never exceeds the prompt total it is a share of", () => {
    expect(
      basePromptTokens({ ...usage, promptTokens: 100, basePromptTokens: 900 }),
    ).toBe(100);
  });

  it("never goes negative", () => {
    expect(basePromptTokens({ ...usage, basePromptTokens: -5 })).toBe(0);
  });

  it("passes an ordinary value through untouched", () => {
    expect(basePromptTokens({ ...usage, basePromptTokens: 400 })).toBe(400);
  });
});
