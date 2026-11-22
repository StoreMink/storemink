import { describe, expect, it } from "vitest";
import {
  NANO_BANANA_PICTURE_TOKENS,
  NON_GLOBAL_PRICE_FACTOR,
  THEME_STUDIO_IMAGE_PRICING_VERSION,
  THEME_STUDIO_PRICING_VERSION,
  estimateCostMicroUsd,
  estimateImageCostMicroUsd,
  imageRatesFor,
  imageThinkingTokens,
  locationPriceFactor,
  markServedLocation,
  ratesFor,
  servedLocationOf,
} from "./cost";
import { ZERO_USAGE, type ProviderUsage } from "./provider";

/** 10,000 prompt tokens (2,000 cached), 500 out and 1,500 thinking. */
const usage = (): ProviderUsage => ({
  inputTokens: 10_000,
  cachedTokens: 2_000,
  outputTokens: 500,
  thinkingTokens: 1_500,
});

const BEFORE_2027 = new Date("2026-10-25T00:00:00Z");

describe("the price of one request by where it was served (TS-3D)", () => {
  it("★★ names a new pricing version for the table with the US in it", () => {
    expect(THEME_STUDIO_PRICING_VERSION).toBe(
      "gemini-api-list-2026-09-us-1.1x",
    );
    expect(THEME_STUDIO_PRICING_VERSION).not.toBe("gemini-api-list-2026-09");
  });

  it("★ a request no client marked is priced at global, exactly as before", () => {
    // 3.8 Flash before 2027: $0.75 in, $0.075 cached, $3.75 out (and
    // thinking): 8,000 x 0.75 + 2,000 x 0.075 + 2,000 x 3.75 = $0.01365.
    expect(estimateCostMicroUsd("gemini-3.8-flash", usage(), BEFORE_2027)).toBe(
      13_650,
    );
    expect(ratesFor("gemini-3.8-flash", 10_000, BEFORE_2027)).toEqual({
      input: 0.75,
      output: 3.75,
      cached: 0.075,
    });
  });

  it("★★ a request served at the US is priced at 1.1 times", () => {
    const atUs = markServedLocation(usage(), "us");
    expect(servedLocationOf(atUs)).toBe("us");
    expect(estimateCostMicroUsd("gemini-3.8-flash", atUs, BEFORE_2027)).toBe(
      15_015,
    );
    // The token counts are untouched: the mark lives beside them.
    expect(atUs).toEqual(usage());
    expect(Object.keys(atUs)).toEqual([
      "inputTokens",
      "cachedTokens",
      "outputTokens",
      "thinkingTokens",
    ]);
    expect(JSON.stringify(atUs)).toBe(JSON.stringify(usage()));
  });

  it("a request served at global, or a copy of a US one, is priced at global", () => {
    const atGlobal = markServedLocation(usage(), "global");
    expect(servedLocationOf(atGlobal)).toBe("global");
    expect(
      estimateCostMicroUsd("gemini-3.8-flash", atGlobal, BEFORE_2027),
    ).toBe(13_650);
    const copy = { ...markServedLocation(usage(), "us") };
    expect(servedLocationOf(copy)).toBeNull();
    expect(estimateCostMicroUsd("gemini-3.8-flash", copy, BEFORE_2027)).toBe(
      13_650,
    );
  });

  it("prices every location but global at 1.1 times, Pro's per-request tier included", () => {
    expect(NON_GLOBAL_PRICE_FACTOR).toBe(1.1);
    expect(locationPriceFactor("global")).toBe(1);
    expect(locationPriceFactor("us")).toBe(1.1);
    expect(locationPriceFactor("eu")).toBe(1.1);
    expect(locationPriceFactor("us-central1")).toBe(1.1);
    // Gemini 3.1 Pro under 200k: $2 in, $0.2 cached, $12 out.
    const pro = markServedLocation(usage(), "us");
    expect(estimateCostMicroUsd("gemini-3.1-pro", usage())).toBe(40_400);
    expect(estimateCostMicroUsd("gemini-3.1-pro", pro)).toBe(44_440);
  });

  it("never marks the shared zero usage, which every unanswered call returns", () => {
    expect(markServedLocation(ZERO_USAGE, "us")).toBe(ZERO_USAGE);
    expect(servedLocationOf(ZERO_USAGE)).toBeNull();
    expect(estimateCostMicroUsd("gemini-3.8-flash", ZERO_USAGE)).toBe(0);
  });

  it("leaves the price of a photo usage that names no model alone: Pro's", () => {
    expect(
      estimateImageCostMicroUsd({ inputTokens: 1_000, outputTokens: 1_120 }),
    ).toBe(136_400);
  });

  it("★ takes the stated price of a provider that bills by the picture (ElevenLabs, 22 Nov 2026)", () => {
    // No tokens to price: Google's rates would call the picture free.
    expect(
      estimateImageCostMicroUsd({
        inputTokens: 0,
        outputTokens: 0,
        model: "gpt-image-2.5-sunburst",
        flatCostMicroUsd: 78_850,
      }),
    ).toBe(78_850);
    // A reused picture's price was the original run's: zero stays zero.
    expect(
      estimateImageCostMicroUsd({
        inputTokens: 0,
        outputTokens: 0,
        flatCostMicroUsd: 0,
      }),
    ).toBe(0);
  });
});

const NB21 = "gemini-nano-banana-2.1";

describe("the price of one picture, by the model that drew it (25 Oct 2026)", () => {
  it("★★ names a new image pricing version for the table with Nano Banana 2.1 in it", () => {
    expect(THEME_STUDIO_IMAGE_PRICING_VERSION).toBe(
      "gemini-image-list-2026-10",
    );
    expect(THEME_STUDIO_IMAGE_PRICING_VERSION).not.toBe(
      "gemini-pro-image-list-2026-09",
    );
  });

  it("★★ prices a 2.1 picture by its size: 1K about $0.0336, 2K about $0.0504, 4K about $0.113", () => {
    const picture = (size: keyof typeof NANO_BANANA_PICTURE_TOKENS) =>
      estimateImageCostMicroUsd({
        inputTokens: 0,
        outputTokens: NANO_BANANA_PICTURE_TOKENS[size],
        model: NB21,
      });
    expect(NANO_BANANA_PICTURE_TOKENS).toEqual({
      "1K": 1_120,
      "2K": 1_680,
      "4K": 3_780,
    });
    expect(picture("1K")).toBe(33_600);
    expect(picture("2K")).toBe(50_400);
    expect(picture("4K")).toBe(113_400);
    // A published version of 2.1 is priced the same.
    expect(imageRatesFor(`${NB21}-001`)).toEqual(imageRatesFor(NB21));
    expect(imageRatesFor(NB21)).toEqual({ input: 1.5, picture: 30, text: 7.5 });
  });

  it("★★ prices 2.1's input at $1.50 and its thinking at $7.50 a million: the smoke test's answers of 25 Oct", () => {
    // usageMetadata of three answers on storemink-staging (25 Oct 2026);
    // the test priced them the same way: $0.0608, $0.0624 and $0.1246.
    const styleHigh = {
      inputTokens: 83,
      outputTokens: 1_698,
      thinkingTokens: 1_349,
      model: NB21,
    };
    const packShotHigh = {
      inputTokens: 1_213,
      outputTokens: 1_680,
      thinkingTokens: 1_356,
      model: NB21,
    };
    const hero4kHigh = {
      inputTokens: 1_203,
      outputTokens: 3_780,
      thinkingTokens: 1_254,
      model: NB21,
    };
    // The 18 text tokens beside the style photo's picture are priced as
    // picture tokens: 18 x ($30 - $7.50) a million more, the safe direction.
    expect(estimateImageCostMicroUsd(styleHigh)).toBe(61_182);
    expect(estimateImageCostMicroUsd(packShotHigh)).toBe(62_390);
    expect(estimateImageCostMicroUsd(hero4kHigh)).toBe(124_610);
    // At MINIMAL thinking the usage reported none.
    expect(
      estimateImageCostMicroUsd({
        inputTokens: 77,
        outputTokens: 1_680,
        model: NB21,
      }),
    ).toBe(50_516);
  });

  it("★★ prices the Pro rollback and 3.1 Flash at their own rates, thinking included", () => {
    expect(imageRatesFor("gemini-3-pro-image")).toEqual({
      input: 2,
      picture: 120,
      text: 12,
    });
    expect(imageRatesFor("gemini-3-pro-image-001")).toEqual(
      imageRatesFor("gemini-3-pro-image"),
    );
    expect(imageRatesFor("gemini-3.1-flash-image")).toEqual({
      input: 0.5,
      picture: 60,
      text: 3,
    });
    expect(
      estimateImageCostMicroUsd({
        inputTokens: 1_000,
        outputTokens: 1_120,
        thinkingTokens: 300,
        model: "gemini-3-pro-image",
      }),
    ).toBe(2_000 + 134_400 + 3_600);
    expect(
      estimateImageCostMicroUsd({
        inputTokens: 2_000,
        outputTokens: 1_680,
        model: "gemini-3.1-flash-image",
      }),
    ).toBe(101_800);
  });

  it("★ a usage that names no model, or one this table does not know, is priced at Pro's rates, the dearest", () => {
    for (const model of [undefined, "", "gemini-9-image", "fake"]) {
      expect(imageRatesFor(model)).toEqual(imageRatesFor("gemini-3-pro-image"));
    }
    expect(
      estimateImageCostMicroUsd({
        inputTokens: 1_000,
        outputTokens: 1_680,
        model: "gemini-9-image",
      }),
    ).toBeGreaterThan(
      estimateImageCostMicroUsd({
        inputTokens: 1_000,
        outputTokens: 1_680,
        model: NB21,
      }),
    );
  });

  it("★ thinking counts only when it is a positive number, as stored usage may hold anything", () => {
    expect(imageThinkingTokens({ inputTokens: 1, outputTokens: 1 })).toBe(0);
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        imageThinkingTokens({
          inputTokens: 1,
          outputTokens: 1,
          thinkingTokens: value,
        }),
      ).toBe(0);
    }
    expect(
      imageThinkingTokens({
        inputTokens: 1,
        outputTokens: 1,
        thinkingTokens: 9,
      }),
    ).toBe(9);
    // A stored call read back from JSON still knows its model and thinking.
    const stored = JSON.parse(
      JSON.stringify({
        inputTokens: 1_213,
        outputTokens: 1_680,
        thinkingTokens: 1_356,
        model: NB21,
      }),
    );
    expect(estimateImageCostMicroUsd(stored)).toBe(62_390);
  });
});
