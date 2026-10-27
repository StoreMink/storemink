import { describe, expect, it } from "vitest";
import {
  PRODUCT_FIDELITY_RULES,
  PRODUCT_PHOTO_EXCLUSIONS,
  PRODUCT_SCENE_RULES,
} from "./product-photo-rules";

const all = [
  PRODUCT_FIDELITY_RULES,
  PRODUCT_SCENE_RULES,
  PRODUCT_PHOTO_EXCLUSIONS,
].join("\n");

describe("product photo rules", () => {
  it("spend their words on keeping the product the same item", () => {
    expect(all).toContain("KEEP THE PRODUCT EXACTLY THE SAME");
    expect(all).toMatch(/label, print, logo or lettering/);
    expect(all).toMatch(/Do not restyle, simplify, recolour/);
  });

  it("ask for a real photograph, never a pasted product", () => {
    expect(all).toMatch(/never pasted in/);
    expect(all).toMatch(/folds and weight/);
  });

  it("add a person only when asked, and only an adult who is not famous", () => {
    expect(all).toMatch(/Include a person only if the request asks/);
    expect(all).toMatch(/must be an adult/);
    expect(all).toMatch(/not be a real or famous person/);
  });

  it("forbid words and marks, and use no long dash", () => {
    expect(all).toMatch(/Add text, words, prices, watermarks/);
    expect(all).not.toMatch(/[–—]/);
  });
});
