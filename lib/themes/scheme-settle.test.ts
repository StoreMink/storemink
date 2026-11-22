// Settling section colour schemes by shade (22 Nov 2026): the first live
// build under prompt v34 failed a whole theme on "Muted text in the Brand
// scheme is hard to read (4.35:1, needs 4.5:1)".
import { describe, expect, it } from "vitest";
import { studio } from "@/lib/themes/definitions/studio";
import { schemeProblems, settleSchemeContrast } from "./scheme-settle";
import {
  SECTION_SCHEMES,
  resolveScheme,
  schemeContrast,
  type SectionScheme,
  type ThemeColorSchemes,
} from "./schemes";
import type { ThemeDesign } from "./types";
import { validateThemeDefinition } from "./validation";

const base = studio.preset.design;
const design = (
  palette: Partial<ThemeDesign["palette"]> = {},
  schemes?: ThemeColorSchemes,
  buttons?: ThemeDesign["buttons"],
): ThemeDesign => ({
  ...base,
  palette: { ...base.palette, ...palette },
  ...(schemes ? { schemes } : { schemes: undefined }),
  ...(buttons ? { buttons } : {}),
});
const used = (...ids: SectionScheme[]) => new Set<SectionScheme>(ids);
const channels = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The palette of the build that failed: burnt orange, white on it. */
const roast = design({
  cream: "#ffffff",
  creamDeep: "#f5ead2",
  surface: "#faf3e2",
  ink: "#271f2f",
  onInk: "#ffffff",
  accent: "#a63e0d",
  onAccent: "#ffffff",
});

describe("★★ the build that failed", () => {
  it("is the failure: muted text on its Brand band read 4.35:1", () => {
    expect(schemeProblems("accent", roast, "#a63e0d")).toEqual([
      "Muted text in the Brand scheme is hard to read (4.35:1, needs 4.5:1).",
    ]);
  });

  it("is settled by darkening that one band, and nothing else", () => {
    const { design: settled, changes } = settleSchemeContrast(
      roast,
      "#a63e0d",
      used("accent", "soft"),
    );
    expect(schemeProblems("accent", settled, "#a63e0d")).toEqual([]);
    const band = settled.schemes!.accent!;
    expect(band.text).toBe("#ffffff");
    // The same orange, a shade deeper: every channel moved toward black,
    // by a few per cent.
    const [before, after] = [channels("#a63e0d"), channels(band.background)];
    after.forEach((value, i) => {
      expect(value).toBeLessThanOrEqual(before[i]);
      expect(value).toBeGreaterThanOrEqual(before[i] * 0.85);
    });
    // The palette (so every button and link elsewhere) is as written, and a
    // band that already read is not declared at all.
    expect(settled.palette).toEqual(roast.palette);
    expect(settled.schemes?.soft).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^schemes\.accent: background #a63e0d to #/);
  });
});

describe("what it settles", () => {
  it("moves a band's text toward the pole that reads", () => {
    const grey = design(
      {},
      {
        inverse: { background: "#20262a", text: "#8a8f93" },
      },
    );
    expect(schemeProblems("inverse", grey, "#000000")).not.toEqual([]);
    const { design: settled } = settleSchemeContrast(grey, "#000000", used());
    expect(schemeProblems("inverse", settled, "#000000")).toEqual([]);
    expect(settled.schemes!.inverse!.background).toBe("#20262a");
    expect(
      schemeContrast(settled.schemes!.inverse!.text, "#20262a"),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("drops a card colour the text does not read on (text on cards 1.00:1)", () => {
    const hole = design(
      {},
      {
        accent: { background: "#7a2e0a", text: "#ffffff", surface: "#ffffff" },
      },
    );
    expect(schemeProblems("accent", hole, "#7a2e0a").join(" ")).toContain(
      "Text on cards in the Brand scheme is hard to read (1.00:1",
    );
    const { design: settled } = settleSchemeContrast(hole, "#7a2e0a", used());
    expect(schemeProblems("accent", settled, "#7a2e0a")).toEqual([]);
    expect(settled.schemes!.accent!.surface).not.toBe("#ffffff");
    expect(settled.schemes!.accent!.background).toBe("#7a2e0a");
  });

  it("replaces button colours whose label does not read, and a ringed button that does not read on the band", () => {
    const weak = design(
      {},
      {
        inverse: {
          background: "#271f2f",
          text: "#ffffff",
          accent: "#ca6641",
          onAccent: "#ffffff",
        },
      },
    );
    expect(schemeProblems("inverse", weak, "#a63e0d").join(" ")).toContain(
      "button labels are hard to read",
    );
    const { design: settled } = settleSchemeContrast(weak, "#a63e0d", used());
    expect(schemeProblems("inverse", settled, "#a63e0d")).toEqual([]);

    // Outline buttons draw their colour as text on the band.
    // An accent that passes as a button's fill on the band (3:1) and not as
    // text on it (4.5:1): the build's own "Ringed buttons in the Dark scheme
    // are hard to read (4.15:1)".
    const ringed = design(
      { accent: "#ca6641", onAccent: "#1a1208" },
      { inverse: { background: "#271f2f", text: "#ffffff" } },
      { ...base.buttons, primary: "outline" },
    );
    expect(schemeProblems("inverse", ringed, "#ca6641").join(" ")).toContain(
      "Ringed buttons",
    );
    const fixed = settleSchemeContrast(ringed, "#ca6641", used()).design;
    expect(schemeProblems("inverse", fixed, "#ca6641")).toEqual([]);
    const band = resolveScheme("inverse", fixed, "#ca6641");
    expect(schemeContrast(band.accent, band.background)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("keeps a written card and button colour that already read", () => {
    const fine = design(
      {},
      {
        inverse: {
          background: "#3a3340",
          text: "#9a9aa0",
          surface: "#4a4350",
          accent: "#ffffff",
          onAccent: "#1a1a1a",
        },
      },
    );
    const { design: settled } = settleSchemeContrast(fine, "#000000", used());
    expect(schemeProblems("inverse", settled, "#000000")).toEqual([]);
    expect(settled.schemes!.inverse).toMatchObject({
      accent: "#ffffff",
      onAccent: "#1a1a1a",
    });
  });
});

describe("what it leaves alone", () => {
  it("returns the very design when everything reads", () => {
    const { design: same, changes } = settleSchemeContrast(
      base,
      studio.preset.brand.primaryColor,
      used(...SECTION_SCHEMES),
    );
    expect(changes).toEqual([]);
    expect(same).toBe(base);
  });

  it("does not judge a scheme no section uses and nothing declares", () => {
    const { design: same } = settleSchemeContrast(roast, "#a63e0d", used());
    expect(same).toBe(roast);
  });

  it("leaves a malformed declaration, and a palette that is not whole, to the validator", () => {
    const malformed = design(
      {},
      {
        accent: { background: "orange", text: "#ffffff" },
      },
    );
    expect(settleSchemeContrast(malformed, "#a63e0d", used()).design).toBe(
      malformed,
    );
    const partial = design({ onInk: "white" });
    expect(
      settleSchemeContrast(partial, "#a63e0d", used("accent")).design,
    ).toBe(partial);
  });
});

describe("★ over a thousand random palettes", () => {
  // A small deterministic generator: the same thousand every run.
  let seed = 22112026;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const hex = () =>
    `#${Array.from({ length: 3 }, () =>
      Math.floor(next() * 256)
        .toString(16)
        .padStart(2, "0"),
    ).join("")}`;

  it("every scheme reads afterwards, by the validator's own rules, and the palette is never touched", () => {
    let settledCount = 0;
    for (let i = 0; i < 1000; i++) {
      const palette = {
        cream: hex(),
        creamDeep: hex(),
        surface: hex(),
        ink: hex(),
        onInk: hex(),
        accent: hex(),
        onAccent: hex(),
      };
      const declared: ThemeColorSchemes =
        i % 3 === 0
          ? {
              soft: { background: hex(), text: hex(), surface: hex() },
              inverse: {
                background: hex(),
                text: hex(),
                accent: hex(),
                onAccent: hex(),
              },
            }
          : {};
      const before = design(
        palette,
        declared,
        i % 2 ? { ...base.buttons, secondary: "outline" } : base.buttons,
      );
      const { design: after, changes } = settleSchemeContrast(
        before,
        palette.accent,
        used(...SECTION_SCHEMES),
      );
      if (changes.length) settledCount += 1;
      expect(after.palette, `case ${i}`).toEqual(before.palette);
      for (const id of SECTION_SCHEMES)
        expect(
          schemeProblems(id, after, palette.accent),
          `case ${i} ${id}`,
        ).toEqual([]);
    }
    // Random colours almost never read by themselves: the test is not vacuous.
    expect(settledCount).toBeGreaterThan(900);
  });

  it("agrees with the theme validator on a settled theme", () => {
    const { design: settled } = settleSchemeContrast(
      roast,
      "#a63e0d",
      used(...SECTION_SCHEMES),
    );
    const theme = {
      ...studio,
      preset: {
        ...studio.preset,
        brand: { ...studio.preset.brand, primaryColor: "#a63e0d" },
        design: settled,
      },
    };
    const findings = validateThemeDefinition(theme, {
      knownThemeIds: [studio.id],
    } as never).filter((f) => /scheme/i.test(`${f.code} ${f.message}`));
    expect(findings).toEqual([]);
  });
});
