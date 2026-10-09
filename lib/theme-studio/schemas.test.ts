import { describe, expect, it } from "vitest";
import {
  STAGE_A_ENVELOPE_SCHEMA,
  STAGE_B_DRAFT_SCHEMA,
  STAGE_B_INITIAL_DRAFT_SCHEMA,
  THEME_STUDIO_SECTION_TYPES,
} from "./schemas";

// Structured outputs reject a schema outright if any object is open, and
// silently cannot enforce length/numeric constraints. These walk every node so
// a schema edit that breaks either rule fails here instead of as a provider
// 400 on the first paid call.

const UNSUPPORTED = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "minItems",
  "maxItems",
];

function walk(node: unknown, path: string, problems: string[]) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, `${path}[${i}]`, problems));
    return;
  }
  if (!node || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  for (const key of UNSUPPORTED)
    if (key in schema) problems.push(`${path} uses ${key}`);
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) problems.push(`${path} is open`);
    const props = Object.keys((schema.properties ?? {}) as object).sort();
    const required = [...((schema.required ?? []) as string[])].sort();
    if (JSON.stringify(props) !== JSON.stringify(required))
      problems.push(`${path} has optional properties`);
  }
  for (const [key, value] of Object.entries(schema))
    walk(value, `${path}.${key}`, problems);
}

describe("provider schemas", () => {
  it.each([
    ["stage A", STAGE_A_ENVELOPE_SCHEMA],
    ["stage B", STAGE_B_DRAFT_SCHEMA],
    ["initial draft", STAGE_B_INITIAL_DRAFT_SCHEMA],
  ])("%s is closed and uses only supported keywords", (_name, schema) => {
    const problems: string[] = [];
    walk(schema, "$", problems);
    expect(problems).toEqual([]);
  });

  it("never offers executable code, blog feeds or video to the model", () => {
    expect(THEME_STUDIO_SECTION_TYPES).not.toContain("custom_code");
    expect(THEME_STUDIO_SECTION_TYPES).not.toContain("latest_blogs");
    expect(THEME_STUDIO_SECTION_TYPES).not.toContain("video");
    expect(JSON.stringify(STAGE_B_DRAFT_SCHEMA)).not.toContain('"custom_code"');
  });
});

describe("font pairings in the Stage B schemas", () => {
  it("every current schema offers fontPairing and the whole catalogue; the legacy twin neither", async () => {
    const {
      stageBSchemaFor,
      STAGE_B_INITIAL_DRAFT_SCHEMA,
      STAGE_B_VARIETY_DRAFT_SCHEMA,
      STAGE_B_VARIETY_INITIAL_SCHEMA,
    } = await import("./schemas");
    const { FONT_PAIRING_KEYS, THEME_FONT_VALUES, LEGACY_DESIGN_FONT_VALUES } =
      await import("@/lib/themes/fonts");
    for (const schema of [
      STAGE_B_DRAFT_SCHEMA,
      STAGE_B_INITIAL_DRAFT_SCHEMA,
      STAGE_B_VARIETY_DRAFT_SCHEMA,
      STAGE_B_VARIETY_INITIAL_SCHEMA,
    ]) {
      const current = stageBSchemaFor(schema, true) as {
        required: string[];
        properties: Record<
          string,
          {
            anyOf?: { enum?: string[] }[];
            properties?: Record<
              string,
              { properties: Record<string, { enum: string[] }> }
            >;
          }
        >;
      };
      expect(current.required).toContain("fontPairing");
      expect(current.properties.fontPairing.anyOf?.[0].enum).toEqual(
        FONT_PAIRING_KEYS,
      );
      expect(
        current.properties.design.properties!.fonts.properties.body.enum,
      ).toEqual([...THEME_FONT_VALUES]);
      const legacy = stageBSchemaFor(schema, false) as typeof current;
      expect(legacy.required).not.toContain("fontPairing");
      expect(legacy.properties.fontPairing).toBeUndefined();
      expect(
        legacy.properties.design.properties!.fonts.properties.display.enum,
      ).toEqual([...LEGACY_DESIGN_FONT_VALUES]);
      expect(
        legacy.properties.design.properties!.fonts.properties.display.enum,
      ).toHaveLength(9);
    }
  });
});

describe("nested-block sections in the Studio schemas (v29)", () => {
  // Every enum that names a section type, wherever it sits in the schema.
  const sectionEnums = (schema: unknown): string[][] => {
    const found: string[][] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.enum) && record.enum.includes("faq_accordion"))
        found.push(record.enum as string[]);
      Object.values(record).forEach(walk);
    };
    walk(schema);
    return found;
  };

  it("the current Stage A and B schemas admit accordion and comparison; the pre-v29 twins do not", async () => {
    const {
      stageASchemaFor,
      stageBSchemaFor,
      STAGE_A_ENVELOPE_SCHEMA,
      STAGE_A_VARIETY_SCHEMA,
      STAGE_B_INITIAL_DRAFT_SCHEMA,
      STAGE_B_VARIETY_DRAFT_SCHEMA,
      STAGE_B_VARIETY_INITIAL_SCHEMA,
      THEME_STUDIO_SECTION_TYPES,
      LEGACY_THEME_STUDIO_SECTION_TYPES,
      themeStudioSectionTypes,
    } = await import("./schemas");
    expect(THEME_STUDIO_SECTION_TYPES).toContain("accordion");
    expect(THEME_STUDIO_SECTION_TYPES).toContain("comparison");
    expect(LEGACY_THEME_STUDIO_SECTION_TYPES).not.toContain("accordion");
    expect(LEGACY_THEME_STUDIO_SECTION_TYPES).not.toContain("comparison");
    expect(themeStudioSectionTypes(false)).toBe(
      LEGACY_THEME_STUDIO_SECTION_TYPES,
    );
    for (const schema of [
      STAGE_B_DRAFT_SCHEMA,
      STAGE_B_INITIAL_DRAFT_SCHEMA,
      STAGE_B_VARIETY_DRAFT_SCHEMA,
      STAGE_B_VARIETY_INITIAL_SCHEMA,
    ]) {
      const current = sectionEnums(stageBSchemaFor(schema, true, true));
      expect(current.length).toBeGreaterThan(0);
      for (const list of current)
        expect(list).toEqual(THEME_STUDIO_SECTION_TYPES);
      const legacy = sectionEnums(stageBSchemaFor(schema, true, false));
      expect(legacy.length).toBe(current.length);
      for (const list of legacy)
        expect(list).toEqual(LEGACY_THEME_STUDIO_SECTION_TYPES);
      // Both capabilities absent: the pre-v25 twin over the pre-v29 list.
      const oldest = stageBSchemaFor(schema, false, false) as {
        properties: Record<string, unknown>;
      };
      expect(oldest.properties.fontPairing).toBeUndefined();
      for (const list of sectionEnums(oldest))
        expect(list).toEqual(LEGACY_THEME_STUDIO_SECTION_TYPES);
      // Twins are built once and reused.
      expect(stageBSchemaFor(schema, true, false)).toBe(
        stageBSchemaFor(schema, true, false),
      );
    }
    for (const schema of [STAGE_A_ENVELOPE_SCHEMA, STAGE_A_VARIETY_SCHEMA]) {
      for (const list of sectionEnums(stageASchemaFor(schema, true, true)))
        expect(list).toEqual(THEME_STUDIO_SECTION_TYPES);
      for (const list of sectionEnums(stageASchemaFor(schema, true, false)))
        expect(list).toEqual(LEGACY_THEME_STUDIO_SECTION_TYPES);
      const oldest = JSON.stringify(stageASchemaFor(schema, false, false));
      expect(oldest).not.toContain('"people"');
      expect(oldest).not.toContain('"comparison"');
    }
  });
});
