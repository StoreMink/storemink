import { describe, expect, it } from "vitest";
import { shouldOpenPayment } from "./amount-guard";

describe("shouldOpenPayment (the amount guard, design 7.4)", () => {
  it("opens when the start asks for exactly what the screen showed", () => {
    expect(shouldOpenPayment(177_000, 177_000)).toBe(true);
    expect(shouldOpenPayment(6_962, 6_962)).toBe(true);
  });

  it("★ never opens when the start asks for more than the screen showed", () => {
    // ₹1,500 shown, ₹1,770 asked: GST was added on top since the screen drew.
    expect(shouldOpenPayment(150_000, 177_000)).toBe(false);
  });

  it("never opens when the start asks for less either: the screen must be true", () => {
    expect(shouldOpenPayment(177_000, 150_000)).toBe(false);
    expect(shouldOpenPayment(177_000, 176_999)).toBe(false);
  });

  it("never opens when the screen showed no amount", () => {
    expect(shouldOpenPayment(null, 177_000)).toBe(false);
    expect(shouldOpenPayment(undefined, 177_000)).toBe(false);
  });

  it("never opens on something that is not a whole number of paise", () => {
    expect(shouldOpenPayment(Number.NaN, Number.NaN)).toBe(false);
    expect(shouldOpenPayment(1_500.5, 1_500.5)).toBe(false);
    expect(shouldOpenPayment(-100, -100)).toBe(false);
    expect(
      shouldOpenPayment(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    ).toBe(false);
  });
});
