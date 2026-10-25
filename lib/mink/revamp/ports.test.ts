import { describe, expect, it } from "vitest";
import {
  ZERO_REVAMP_USAGE,
  addRevampUsage,
  revampCallUsage,
  type RevampUsage,
} from "./ports";

const usage = (patch: Partial<RevampUsage>): RevampUsage => ({
  ...ZERO_REVAMP_USAGE,
  ...patch,
});

describe("addRevampUsage", () => {
  it("sums every paid figure", () => {
    expect(
      addRevampUsage(
        usage({ inputTokens: 5, images: 1, estimatedCostMicroUsd: 10 }),
        usage({ outputTokens: 2, reviews: 1, estimatedCostMicroUsd: 3 }),
      ),
    ).toEqual(
      usage({
        inputTokens: 5,
        outputTokens: 2,
        images: 1,
        reviews: 1,
        estimatedCostMicroUsd: 13,
      }),
    );
  });

  it("★ sums each model's tries that got no answer, model by model (P0)", () => {
    const sum = addRevampUsage(
      usage({
        calls: {
          "gemini-3-pro-image": { rateLimited: 2, timeouts: 0 },
          "gemini-3.8-flash": { rateLimited: 0, timeouts: 1 },
        },
      }),
      usage({
        images: 1,
        calls: { "gemini-3-pro-image": { rateLimited: 1, timeouts: 1 } },
      }),
    );
    expect(sum).toEqual(
      usage({
        images: 1,
        calls: {
          "gemini-3-pro-image": { rateLimited: 3, timeouts: 1 },
          "gemini-3.8-flash": { rateLimited: 0, timeouts: 1 },
        },
      }),
    );
  });

  it("keeps the counts of one side when the other has none, and adds no key when neither has any", () => {
    const counted = usage({
      calls: { "gemini-3-pro-image": { rateLimited: 1, timeouts: 0 } },
    });
    expect(addRevampUsage(ZERO_REVAMP_USAGE, counted)).toEqual(counted);
    expect(addRevampUsage(counted, ZERO_REVAMP_USAGE)).toEqual(counted);
    // ★ A record with nothing refused stays the shape it always had.
    expect("calls" in addRevampUsage(ZERO_REVAMP_USAGE, usage({}))).toBe(false);
  });

  it("never changes either input", () => {
    const a = usage({
      calls: { "gemini-3-pro-image": { rateLimited: 1, timeouts: 0 } },
    });
    const b = usage({
      calls: { "gemini-3-pro-image": { rateLimited: 1, timeouts: 0 } },
    });
    addRevampUsage(a, b);
    expect(a.calls).toEqual({
      "gemini-3-pro-image": { rateLimited: 1, timeouts: 0 },
    });
    expect(b.calls).toEqual({
      "gemini-3-pro-image": { rateLimited: 1, timeouts: 0 },
    });
  });
});

describe("revampCallUsage", () => {
  it("is one model's counts and nothing else", () => {
    expect(revampCallUsage("gemini-3.8-flash", { rateLimited: 2 })).toEqual(
      usage({ calls: { "gemini-3.8-flash": { rateLimited: 2, timeouts: 0 } } }),
    );
    expect(revampCallUsage("gemini-3.8-flash", { timeouts: 1 })).toEqual(
      usage({ calls: { "gemini-3.8-flash": { rateLimited: 0, timeouts: 1 } } }),
    );
  });

  it("is null when nothing was refused or cut off, or no model is named", () => {
    expect(revampCallUsage("gemini-3.8-flash", {})).toBeNull();
    expect(
      revampCallUsage("gemini-3.8-flash", { rateLimited: 0, timeouts: 0 }),
    ).toBeNull();
    expect(revampCallUsage("", { rateLimited: 1 })).toBeNull();
  });

  it("counts whole tries only, never a negative one", () => {
    expect(
      revampCallUsage("gemini-3-pro-image", { rateLimited: 2.7, timeouts: -3 }),
    ).toEqual(
      usage({
        calls: { "gemini-3-pro-image": { rateLimited: 2, timeouts: 0 } },
      }),
    );
  });
});
