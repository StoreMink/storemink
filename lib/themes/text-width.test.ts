import { describe, expect, it } from "vitest";
import table from "./font-widths.json";
import { DESIGN_FONTS, THEME_FONT_FACES } from "./fonts";
import { hasTextWidths, measuredFamilies, textWidth } from "./text-width";

const style = { font: "Inter", weight: 600, sizePx: 15 };

describe("the font width table", () => {
  it("★ measures every catalogue font, so a font added to fonts.ts needs scripts/theme-font-widths.mjs again", () => {
    const missing = THEME_FONT_FACES.map((face) => face.family).filter(
      (family) => !measuredFamilies().includes(family),
    );
    expect(missing).toEqual([]);
    for (const value of Object.values(DESIGN_FONTS))
      expect(hasTextWidths(value), value).toBe(true);
  });

  it("holds every printable ASCII character at every weight from 300 to 900", () => {
    expect(table.first).toBe(32);
    expect(table.weights).toEqual([300, 400, 500, 600, 700, 800, 900]);
    for (const [family, rows] of Object.entries(table.families))
      for (const weight of table.weights) {
        const row = (rows as Record<string, number[]>)[String(weight)];
        expect(row, `${family} ${weight}`).toHaveLength(95);
        expect(row.every((w) => w >= 0 && w < 2000)).toBe(true);
      }
  });
});

describe("textWidth", () => {
  it("adds each character's advance at the size", () => {
    const shop = textWidth("Shop", style)!;
    expect(shop).toBeGreaterThan(30);
    expect(shop).toBeLessThan(45);
    expect(textWidth("Shop Shop", style)).toBeCloseTo(
      2 * shop + textWidth(" ", style)!,
      6,
    );
    expect(textWidth("Shop", { ...style, sizePx: 30 })).toBeCloseTo(
      2 * shop,
      6,
    );
  });

  it("sets capitals wider and adds letter-spacing after every character, as Chrome does", () => {
    const plain = textWidth("Our Story", style)!;
    const caps = textWidth("Our Story", { ...style, transform: "uppercase" })!;
    expect(caps).toBeGreaterThan(plain * 1.15);
    expect(caps).toBeCloseTo(textWidth("OUR STORY", style)!, 6);
    expect(
      textWidth("Our Story", { ...style, letterSpacingEm: 0.1 })! - plain,
    ).toBeCloseTo(9 * 0.1 * 15, 6);
    expect(
      textWidth("our story", { ...style, transform: "capitalize" }),
    ).toBeCloseTo(plain, 6);
  });

  it("interpolates between measured weights, and keeps to 300 to 900", () => {
    const at = (weight: number) => textWidth("Lookbook", { ...style, weight })!;
    expect(at(650)).toBeCloseTo((at(600) + at(700)) / 2, 6);
    expect(at(200)).toBeCloseTo(at(300), 6);
    expect(at(950)).toBeCloseTo(at(900), 6);
    expect(at(800)).toBeGreaterThan(at(400));
  });

  it("reads a stored font value, counts other characters as an average letter, and refuses a font it has not measured", () => {
    expect(textWidth("Shop", { ...style, font: DESIGN_FONTS.inter })).toBe(
      textWidth("Shop", style),
    );
    const accented = textWidth("Café", style)!;
    expect(accented).toBeGreaterThan(textWidth("Caf", style)!);
    expect(textWidth("Shop", { ...style, font: "Comic Sans MS" })).toBeNull();
  });
});
