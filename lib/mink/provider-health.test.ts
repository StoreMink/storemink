import { beforeEach, describe, expect, it } from "vitest";
import {
  markMinkModelAnswered,
  markMinkModelUnavailable,
  minkModelLooksAvailable,
  resetMinkModelHealth,
} from "./provider-health";

const MAIN = { model: "gemini-3.7-flash", location: "global" };
const FALLBACK = { model: "gemini-3.5-flash", location: "asia-south1" };

beforeEach(() => resetMinkModelHealth());

describe("provider health", () => {
  it("a model nobody has seen fail looks available", () => {
    expect(minkModelLooksAvailable(MAIN)).toBe(true);
  });

  it("★ a failure (a busy pool or a refusal alike) is remembered for 60 s, then forgotten", () => {
    const now = 1_000_000;
    markMinkModelUnavailable(MAIN, now);
    expect(minkModelLooksAvailable(MAIN, now + 59_999)).toBe(false);
    expect(minkModelLooksAvailable(MAIN, now + 60_000)).toBe(true);
    // Forgotten, not merely expired: a later look still says available.
    expect(minkModelLooksAvailable(MAIN, now + 1)).toBe(true);
  });

  it("one answer clears the mark at once", () => {
    markMinkModelUnavailable(MAIN);
    markMinkModelAnswered(MAIN);
    expect(minkModelLooksAvailable(MAIN)).toBe(true);
  });

  it("is kept per model and location", () => {
    markMinkModelUnavailable(MAIN);
    expect(minkModelLooksAvailable(FALLBACK)).toBe(true);
    expect(
      minkModelLooksAvailable({ model: MAIN.model, location: "asia-south1" }),
    ).toBe(true);
    expect(minkModelLooksAvailable(MAIN)).toBe(false);
  });
});
