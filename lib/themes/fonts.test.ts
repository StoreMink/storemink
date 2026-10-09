import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  DESIGN_FONTS,
  DIRECTION_PAIRINGS,
  FONT_PAIRINGS,
  FONT_PAIRING_KEYS,
  LEGACY_DESIGN_FONT_VALUES,
  THEME_FONT_CAP,
  THEME_FONT_FACES,
  fontWeightRange,
  limitedWeightSentence,
  pairingFonts,
  pairingForFonts,
} from "./fonts";
import { DESIGN_DIRECTION_IDS } from "@/lib/theme-studio/design-directions";

const require = createRequire(import.meta.url);
const fontData =
  require("next/dist/compiled/@next/font/dist/google/font-data.json") as Record<
    string,
    { weights: string[]; styles: string[]; subsets: string[] }
  >;
const layoutSource = readFileSync("app/layout.tsx", "utf8");

describe("the font catalogue", () => {
  it("is bounded, unique and starts with the nine legacy faces in their old order", () => {
    expect(THEME_FONT_FACES.length).toBeLessThanOrEqual(THEME_FONT_CAP);
    for (const field of ["key", "family", "export", "variable"] as const) {
      const values = THEME_FONT_FACES.map((face) => face[field]);
      expect(new Set(values).size).toBe(values.length);
    }
    expect(LEGACY_DESIGN_FONT_VALUES).toEqual([
      "var(--font-inter)",
      "var(--font-fraunces)",
      "var(--font-space-grotesk)",
      "var(--font-jakarta)",
      "var(--font-jost)",
      "var(--font-instrument-serif)",
      "var(--font-outfit)",
      "var(--font-roboto)",
      "var(--font-stick-no-bills)",
    ]);
    expect(Object.values(DESIGN_FONTS).slice(0, 9)).toEqual(
      LEGACY_DESIGN_FONT_VALUES,
    );
  });

  it("names only families this Next build can fetch, with the weights and styles it loads", () => {
    for (const face of THEME_FONT_FACES) {
      const data = fontData[face.family];
      expect(data, face.family).toBeDefined();
      expect(data.subsets, face.family).toContain("latin");
      if (face.staticWeights) {
        for (const weight of face.staticWeights) {
          expect(data.weights, `${face.family} ${weight}`).toContain(
            String(weight),
          );
        }
        expect(face.range).toEqual({
          min: Math.min(...face.staticWeights),
          max: Math.max(...face.staticWeights),
        });
      } else {
        expect(data.weights, `${face.family} variable`).toContain("variable");
      }
      if (face.italic) expect(data.styles, face.family).toContain("italic");
    }
  });

  it("matches what app/layout.tsx declares, face by face", () => {
    for (const face of THEME_FONT_FACES) {
      const block = new RegExp(`\\b${face.export}\\(\\{([^}]*)\\}\\)`).exec(
        layoutSource,
      )?.[1];
      expect(
        block,
        `${face.export} is not loaded by app/layout.tsx`,
      ).toBeDefined();
      expect(block).toContain(`variable: "${face.variable}"`);
      expect(block!.includes("preload: false"), `${face.key} preload`).toBe(
        !face.preloaded,
      );
      expect(block!.includes('"italic"'), `${face.key} italic`).toBe(
        face.italic,
      );
      if (face.staticWeights) {
        for (const weight of face.staticWeights) {
          expect(block, `${face.key} weight ${weight}`).toContain(
            `"${weight}"`,
          );
        }
      } else {
        expect(block, `${face.key} must load its variable axis`).not.toContain(
          "weight:",
        );
      }
    }
    const classes =
      /const THEME_FONT_CLASSES = \[([\s\S]*?)\]/.exec(layoutSource)?.[1] ?? "";
    expect(classes.split(",").filter((s) => s.trim()).length).toBe(
      THEME_FONT_FACES.length,
    );
  });

  it("answers the faux-bold check from the catalogue", () => {
    expect(fontWeightRange("var(--font-jost)")).toEqual({ min: 300, max: 500 });
    expect(fontWeightRange(" var(--font-inter) ")).toEqual({
      min: 100,
      max: 900,
    });
    expect(fontWeightRange("var(--font-comic)")).toBeNull();
    expect(limitedWeightSentence()).toContain(
      "Instrument Serif (regular only)",
    );
    expect(limitedWeightSentence()).toContain("Jost (up to medium)");
    expect(limitedWeightSentence()).toContain("Bebas Neue (regular only)");
  });
});

describe("the pairing library", () => {
  it("uses every face at least once, never a display-only face as body", () => {
    const used = new Set<string>();
    for (const key of FONT_PAIRING_KEYS) {
      const pairing = FONT_PAIRINGS[key];
      used.add(pairing.display);
      used.add(pairing.body);
      const body = THEME_FONT_FACES.find((f) => f.key === pairing.body)!;
      expect(body.body, `${key} body ${pairing.body}`).toBe(true);
    }
    for (const face of THEME_FONT_FACES) {
      expect(used.has(face.key), `${face.key} is in no pairing`).toBe(true);
    }
    expect(FONT_PAIRING_KEYS.length).toBeGreaterThanOrEqual(25);
  });

  it("names real design directions and covers every one of them", () => {
    for (const key of FONT_PAIRING_KEYS) {
      for (const direction of FONT_PAIRINGS[key].directions) {
        expect(DESIGN_DIRECTION_IDS, `${key} → ${direction}`).toContain(
          direction,
        );
      }
    }
    for (const direction of DESIGN_DIRECTION_IDS) {
      expect(
        DIRECTION_PAIRINGS[direction]?.length ?? 0,
        direction,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("resolves to stored values and back", () => {
    expect(pairingFonts("quiet-serif")).toEqual({
      body: "var(--font-jost)",
      display: "var(--font-instrument-serif)",
    });
    expect(
      pairingForFonts({
        body: "var(--font-jost)",
        display: "var(--font-instrument-serif)",
      }),
    ).toBe("quiet-serif");
    expect(
      pairingForFonts({
        body: "var(--font-jost)",
        display: "var(--font-jost)",
      }),
    ).toBeNull();
  });
});
