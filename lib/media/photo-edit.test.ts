import { describe, expect, it } from "vitest";
import { IMAGE_SPECS } from "./image-specs";
import {
  PHOTO_EDIT_INSTRUCTION_MAX,
  normalizeEditInstruction,
  photoEditPrompt,
} from "./photo-edit";

describe("normalizeEditInstruction", () => {
  it("keeps the merchant's words, tidied", () => {
    expect(
      normalizeEditInstruction("  hanging from a tree\n\n in a   garden "),
    ).toBe("hanging from a tree in a garden");
  });

  it("drops control characters and refuses what is too short or not text", () => {
    expect(normalizeEditInstruction("on\u0000 marble\u0007")).toBe("on marble");
    expect(normalizeEditInstruction("  ")).toBeNull();
    expect(normalizeEditInstruction("ab")).toBeNull();
    expect(normalizeEditInstruction(42)).toBeNull();
    expect(normalizeEditInstruction(null)).toBeNull();
  });

  it("caps a long request", () => {
    const long = "on a beach ".repeat(100);
    const cleaned = normalizeEditInstruction(long)!;
    expect(cleaned.length).toBeLessThanOrEqual(PHOTO_EDIT_INSTRUCTION_MAX);
  });
});

describe("photoEditPrompt", () => {
  const prompt = photoEditPrompt(
    "hanging from a tree in a garden",
    IMAGE_SPECS.product,
  );

  it("carries the request and the slot's shape", () => {
    expect(prompt).toContain("hanging from a tree in a garden");
    expect(prompt).toContain("3:4 aspect ratio");
  });

  it("spends its words on keeping the product the same item", () => {
    expect(prompt).toContain("KEEP THE PRODUCT EXACTLY THE SAME");
    expect(prompt).toMatch(/label, print, logo or lettering/);
    expect(prompt).toMatch(/Do not restyle, simplify, recolour/);
  });

  it("asks for a real photograph, never a pasted product", () => {
    expect(prompt).toMatch(/never pasted in/);
    expect(prompt).toMatch(/folds and weight/);
  });

  it("adds a person only when asked, and only an adult who is not famous", () => {
    expect(prompt).toMatch(/Include a person only if the request asks/);
    expect(prompt).toMatch(/must be an adult/);
    expect(prompt).toMatch(/not be a real or famous person/);
  });

  it("forbids words and marks, and uses no long dash", () => {
    expect(prompt).toMatch(/Add text, words, prices, watermarks/);
    expect(prompt).not.toMatch(/[–—]/);
  });
});
