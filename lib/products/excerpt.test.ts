import { describe, expect, it } from "vitest";
import { PRODUCT_EXCERPT_MAX, productExcerpt } from "./excerpt";

describe("productExcerpt", () => {
  it("answers nothing for a missing or blank description", () => {
    expect(productExcerpt(null)).toBeNull();
    expect(productExcerpt(undefined)).toBeNull();
    expect(productExcerpt("  \n\t ")).toBeNull();
  });

  it("keeps a short description whole, with its line breaks folded", () => {
    expect(productExcerpt("Hand thrown.\n\nGlazed  twice.")).toBe(
      "Hand thrown. Glazed twice.",
    );
  });

  it("cuts a long description on a word and marks the cut", () => {
    const text = "A stoneware jug, thrown by hand in small batches. ".repeat(
      12,
    );
    const excerpt = productExcerpt(text)!;
    expect(excerpt.length).toBeLessThanOrEqual(PRODUCT_EXCERPT_MAX + 1);
    expect(excerpt.endsWith("…")).toBe(true);
    // Never mid-word: what is kept is a prefix that ends where a word does.
    const kept = excerpt.slice(0, -1);
    expect(text.startsWith(kept)).toBe(true);
    expect(text.charAt(kept.length)).toMatch(/[\s,.]/);
  });

  it("leaves no punctuation hanging before the ellipsis", () => {
    expect(productExcerpt("Soft cotton, breathable weave", 12)).toBe(
      "Soft cotton…",
    );
  });

  it("cuts one very long word at the limit", () => {
    expect(productExcerpt("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });
});
