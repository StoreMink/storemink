// Fourteen design directions for Theme Studio from prompt v34, and exactly
// the first seven everywhere they were before (design-directions.ts).

import { describe, expect, it } from "vitest";
import { FONT_PAIRING_KEYS } from "@/lib/themes/fonts";
import { INDUSTRY_LABELS } from "@/lib/themes/meta";
import { validateThemeIntent } from "./contracts";
import {
  DESIGN_DIRECTIONS,
  DESIGN_DIRECTION_IDS,
  EXTENDED_DESIGN_DIRECTIONS,
  EXTENDED_DIRECTION_PAIRINGS,
  PALETTE_FAMILIES,
  STUDIO_DESIGN_DIRECTIONS,
  STUDIO_DESIGN_DIRECTION_IDS,
  recommendedDirection,
  studioDirectionIds,
} from "./design-directions";
import { stageAVarietySystemPrompt } from "./prompts";
import {
  STAGE_A_ENVELOPE_SCHEMA,
  STAGE_A_VARIETY_SCHEMA,
  stageASchemaFor,
} from "./schemas";

const directionEnum = (schema: unknown): string[] | null => {
  let found: string[] | null = null;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.enum) && record.enum.includes("luxury-minimal"))
      found = record.enum as string[];
    Object.values(record).forEach(walk);
  };
  walk(schema);
  return found;
};

describe("the fourteen directions", () => {
  it("★★ the redesign's seven are untouched, and the seven later ones follow them", () => {
    expect(DESIGN_DIRECTION_IDS).toEqual([
      "luxury-minimal",
      "bold-and-loud",
      "magazine-editorial",
      "dense-catalogue",
      "soft-and-natural",
      "playful-and-colourful",
      "classic-and-trusted",
    ]);
    expect(STUDIO_DESIGN_DIRECTION_IDS).toHaveLength(14);
    expect(STUDIO_DESIGN_DIRECTION_IDS.slice(0, 7)).toEqual(
      DESIGN_DIRECTION_IDS,
    );
    expect(Object.keys(EXTENDED_DESIGN_DIRECTIONS)).toEqual([
      "brutalist",
      "scandinavian-utility",
      "maximal-pattern",
      "dark-luxury",
      "retro-catalogue",
      "tech-spec",
      "artisan-craft",
    ]);
    expect(studioDirectionIds(false)).toEqual(DESIGN_DIRECTION_IDS);
    expect(studioDirectionIds(true)).toEqual(STUDIO_DESIGN_DIRECTION_IDS);
  });

  it("every direction names real palette families, real industries and its own look", () => {
    const styles = new Set<string>();
    for (const [id, direction] of Object.entries(STUDIO_DESIGN_DIRECTIONS)) {
      expect(direction.palettes.length, id).toBeGreaterThan(0);
      for (const palette of direction.palettes)
        expect(PALETTE_FAMILIES, id).toContain(palette);
      for (const industry of direction.industries)
        expect(Object.keys(INDUSTRY_LABELS), `${id}: ${industry}`).toContain(
          industry,
        );
      expect(direction.styles.length, id).toBeGreaterThan(60);
      styles.add(direction.styles);
      // Product text never carries a long dash.
      expect(JSON.stringify(direction)).not.toContain("—");
    }
    expect(styles.size).toBe(14);
  });

  it("each later direction has font pairings from the library, and none is added to the library's own lists", () => {
    for (const [id, keys] of Object.entries(EXTENDED_DIRECTION_PAIRINGS)) {
      expect(keys.length, id).toBeGreaterThanOrEqual(3);
      for (const key of keys) expect(FONT_PAIRING_KEYS, id).toContain(key);
    }
  });

  it("an intent may name any of the fourteen", () => {
    expect(STUDIO_DESIGN_DIRECTION_IDS).toContain("dark-luxury");
    // The validator's own list is the fourteen (an unknown one is refused).
    const refused = validateThemeIntent({
      schemaVersion: 2,
      designDirection: "vaporwave",
      paletteFamily: "light",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.issues.join("\n")).toMatch(/designDirection/);
    const accepted = validateThemeIntent({
      schemaVersion: 2,
      designDirection: "dark-luxury",
      paletteFamily: "dark",
    });
    if (!accepted.ok)
      expect(accepted.issues.join("\n")).not.toMatch(/designDirection/);
  });
});

describe("★★ what each prompt revision is offered", () => {
  it("Stage A's schema lists fourteen from v34, and the first seven in the twin every earlier request gets", () => {
    expect(directionEnum(STAGE_A_VARIETY_SCHEMA)).toEqual(
      STUDIO_DESIGN_DIRECTION_IDS,
    );
    const earlier = stageASchemaFor(
      STAGE_A_VARIETY_SCHEMA,
      true,
      true,
      true,
      false,
    );
    expect(earlier).not.toBe(STAGE_A_VARIETY_SCHEMA);
    expect(directionEnum(earlier)).toEqual(DESIGN_DIRECTION_IDS);
    // Nothing else differs.
    expect(
      JSON.stringify(earlier).replace(
        JSON.stringify(DESIGN_DIRECTION_IDS),
        JSON.stringify(STUDIO_DESIGN_DIRECTION_IDS),
      ),
    ).toBe(JSON.stringify(STAGE_A_VARIETY_SCHEMA));
    // Built once; composes with the older twins; the plain envelope has no
    // direction and is returned as it is.
    expect(
      stageASchemaFor(STAGE_A_VARIETY_SCHEMA, true, true, true, false),
    ).toBe(earlier);
    expect(
      directionEnum(
        stageASchemaFor(STAGE_A_VARIETY_SCHEMA, false, false, false, false),
      ),
    ).toEqual(DESIGN_DIRECTION_IDS);
    expect(
      stageASchemaFor(STAGE_A_ENVELOPE_SCHEMA, true, true, true, false),
    ).toBe(STAGE_A_ENVELOPE_SCHEMA);
  });

  it("Stage A's prompt names fourteen from v34, and is the earlier text without the flag", () => {
    const before = stageAVarietySystemPrompt(
      true,
      true,
      true,
      true,
      true,
      true,
    );
    const after = stageAVarietySystemPrompt(
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    );
    expect(before).toContain(
      `The seven native directions are:\n${JSON.stringify(DESIGN_DIRECTIONS)}`,
    );
    expect(before).not.toContain("brutalist");
    expect(after).toContain(
      `The fourteen native directions are:\n${JSON.stringify(STUDIO_DESIGN_DIRECTIONS)}`,
    );
    // The only difference is that one sentence and its list.
    expect(
      after.replace(
        `The fourteen native directions are:\n${JSON.stringify(STUDIO_DESIGN_DIRECTIONS)}`,
        `The seven native directions are:\n${JSON.stringify(DESIGN_DIRECTIONS)}`,
      ),
    ).toBe(before);
  });

  it("the suggested direction is the least used one that suits the industry, among those on offer", () => {
    // Before v34 only the first seven are ever suggested.
    expect(DESIGN_DIRECTION_IDS).toContain(
      recommendedDirection(["electronics"], []),
    );
    // Dense catalogue suits electronics; once it is used, a later direction
    // that suits it too is preferred to repeating it.
    const used = ["dense-catalogue" as const];
    expect(recommendedDirection(["electronics"], used, true)).toBe("brutalist");
    expect(
      recommendedDirection(["electronics"], [...used, "brutalist"], true),
    ).toBe("tech-spec");
    expect(recommendedDirection(["electronics"], used)).toBe("dense-catalogue");
  });
});
