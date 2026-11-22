import { describe, expect, it } from "vitest";
import {
  THEME_STUDIO_PROMPT_VERSION,
  themePromptFeatures,
} from "./prompt-features";
import {
  STAGE_A_ENVELOPE_SCHEMA,
  STAGE_B_DRAFT_SCHEMA,
  STAGE_B_INITIAL_DRAFT_SCHEMA,
  STAGE_B_VARIETY_DRAFT_SCHEMA,
  STAGE_B_VARIETY_INITIAL_SCHEMA,
  THEME_STUDIO_SECTION_TYPES,
  stageBSchemaFor,
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
    expect(themeStudioSectionTypes(false, false)).toBe(
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
      const legacy = sectionEnums(stageBSchemaFor(schema, true, false, false));
      expect(legacy.length).toBe(current.length);
      for (const list of legacy)
        expect(list).toEqual(LEGACY_THEME_STUDIO_SECTION_TYPES);
      // Both capabilities absent: the pre-v25 twin over the pre-v29 list.
      const oldest = stageBSchemaFor(schema, false, false, false) as {
        properties: Record<string, unknown>;
      };
      expect(oldest.properties.fontPairing).toBeUndefined();
      for (const list of sectionEnums(oldest))
        expect(list).toEqual(LEGACY_THEME_STUDIO_SECTION_TYPES);
      // Twins are built once and reused.
      expect(stageBSchemaFor(schema, true, false, false)).toBe(
        stageBSchemaFor(schema, true, false, false),
      );
    }
    for (const schema of [STAGE_A_ENVELOPE_SCHEMA, STAGE_A_VARIETY_SCHEMA]) {
      for (const list of sectionEnums(stageASchemaFor(schema, true, true)))
        expect(list).toEqual(THEME_STUDIO_SECTION_TYPES);
      for (const list of sectionEnums(
        stageASchemaFor(schema, true, false, false),
      ))
        expect(list).toEqual(LEGACY_THEME_STUDIO_SECTION_TYPES);
      const oldest = JSON.stringify(
        stageASchemaFor(schema, false, false, false),
      );
      expect(oldest).not.toContain('"people"');
      expect(oldest).not.toContain('"comparison"');
    }
  });
});

describe("the v30 sections in the Studio schemas", () => {
  const enums = (schema: unknown): string[][] => {
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

  it("admits them only when both v29 and v30 capabilities are on, and never the builder-only sections", async () => {
    const {
      stageBSchemaFor,
      stageASchemaFor,
      STAGE_A_ENVELOPE_SCHEMA,
      THEME_STUDIO_SECTION_TYPES,
      themeStudioSectionTypes,
    } = await import("./schemas");
    for (const type of [
      "multicolumn",
      "image_marquee",
      "image_hotspots",
      "before_after",
      "product_spotlight",
    ]) {
      expect(THEME_STUDIO_SECTION_TYPES).toContain(type);
      expect(themeStudioSectionTypes(true, false)).not.toContain(type);
      expect(themeStudioSectionTypes(false, false)).not.toContain(type);
    }
    expect(THEME_STUDIO_SECTION_TYPES).not.toContain("logo_strip");
    expect(THEME_STUDIO_SECTION_TYPES).not.toContain("countdown");
    // v30 implies v29: the v29-only list keeps accordion and comparison.
    expect(themeStudioSectionTypes(true, false)).toContain("comparison");
    for (const list of enums(
      stageBSchemaFor(STAGE_B_DRAFT_SCHEMA, true, true, false),
    ))
      expect(list).toEqual(themeStudioSectionTypes(true, false));
    for (const list of enums(
      stageBSchemaFor(STAGE_B_DRAFT_SCHEMA, true, true, true),
    ))
      expect(list).toEqual(THEME_STUDIO_SECTION_TYPES);
    for (const list of enums(
      stageASchemaFor(STAGE_A_ENVELOPE_SCHEMA, true, true, false),
    ))
      expect(list).not.toContain("multicolumn");
    expect(stageASchemaFor(STAGE_A_ENVELOPE_SCHEMA, true, true, true)).toBe(
      STAGE_A_ENVELOPE_SCHEMA,
    );
  });
});

describe("the v31 layout variants in the Stage B schemas", () => {
  // Every enum that names a header, card or footer variant, wherever it sits.
  const layoutEnums = (schema: unknown) => {
    const found: Record<"header" | "card" | "footer", string[][]> = {
      header: [],
      card: [],
      footer: [],
    };
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.enum)) {
        const list = record.enum as string[];
        if (list.includes("market")) found.header.push(list);
        if (list.includes("framed")) found.card.push(list);
        if (list.includes("rich")) found.footer.push(list);
      }
      Object.values(record).forEach(walk);
    };
    walk(schema);
    return found;
  };

  it("admits them from v31 and narrows every earlier request's enums back, once per twin", async () => {
    const {
      stageBSchemaFor,
      LAYOUT_VARIANT_ENUMS,
      LEGACY_LAYOUT_VARIANT_ENUMS,
      STAGE_B_DRAFT_SCHEMA,
      STAGE_B_INITIAL_DRAFT_SCHEMA,
      STAGE_B_VARIETY_DRAFT_SCHEMA,
      STAGE_B_VARIETY_INITIAL_SCHEMA,
    } = await import("./schemas");
    for (const key of ["header", "card", "footer"] as const)
      for (const legacy of LEGACY_LAYOUT_VARIANT_ENUMS[key])
        expect(LAYOUT_VARIANT_ENUMS[key]).toContain(legacy);
    expect(LAYOUT_VARIANT_ENUMS.header).toContain("transparent");
    expect(LAYOUT_VARIANT_ENUMS.card).toContain("soft");
    expect(LAYOUT_VARIANT_ENUMS.footer).toContain("compact");
    // The compact initial draft asks for layoutOverridesJson instead of
    // design.layout, so it carries no layout enum; the other three do.
    for (const schema of [
      STAGE_B_DRAFT_SCHEMA,
      STAGE_B_INITIAL_DRAFT_SCHEMA,
      STAGE_B_VARIETY_DRAFT_SCHEMA,
      STAGE_B_VARIETY_INITIAL_SCHEMA,
    ]) {
      expect(stageBSchemaFor(schema, true, true, true, true)).toBe(schema);
      const current = layoutEnums(schema);
      const legacy = layoutEnums(
        stageBSchemaFor(schema, true, true, true, false),
      );
      for (const key of ["header", "card", "footer"] as const) {
        if (schema === STAGE_B_INITIAL_DRAFT_SCHEMA)
          expect(current[key]).toHaveLength(0);
        else expect(current[key].length).toBeGreaterThan(0);
        expect(legacy[key]).toHaveLength(current[key].length);
        for (const list of current[key])
          expect(list).toEqual([...LAYOUT_VARIANT_ENUMS[key]]);
        for (const list of legacy[key])
          expect(list).toEqual([...LEGACY_LAYOUT_VARIANT_ENUMS[key]]);
      }
      // A v30 request predates the variants as well as nothing else; a v29
      // one also the v30 sections. Each twin is built once.
      const v30 = stageBSchemaFor(schema, true, true, true, false);
      expect(stageBSchemaFor(schema, true, true, true, false)).toBe(v30);
      const v29 = stageBSchemaFor(schema, true, true, false, false);
      if (schema !== STAGE_B_INITIAL_DRAFT_SCHEMA)
        expect(layoutEnums(v29).header[0]).toEqual([
          ...LEGACY_LAYOUT_VARIANT_ENUMS.header,
        ]);
      expect(v29).not.toBe(v30);
    }
  });
});

// Plan Phase 2e: the page templates and the stacked product page from v32;
// every earlier request's twin has neither, built once per key. From v33 the
// templates travel as one JSON string (prompt-features.ts), and the v32 twin
// puts v32's closed object back in that string's place.
describe("the page templates in the Stage B schemas", () => {
  it("sends them as a JSON string from v33, as the v32 object in the v32 twin, and removes them from every earlier twin", async () => {
    const {
      stageBSchemaFor,
      PRODUCT_DETAIL_ENUM,
      LEGACY_PRODUCT_DETAIL_ENUM,
      STAGE_B_DRAFT_SCHEMA,
      STAGE_B_INITIAL_DRAFT_SCHEMA,
      STAGE_B_VARIETY_DRAFT_SCHEMA,
      STAGE_B_VARIETY_INITIAL_SCHEMA,
      TEMPLATES_SCHEMA,
    } = await import("./schemas");
    const { PRODUCT_BLOCK_TYPES, PRODUCT_GALLERIES } =
      await import("@/lib/themes/templates");
    expect(PRODUCT_DETAIL_ENUM).toContain("stacked");
    expect(LEGACY_PRODUCT_DETAIL_ENUM).not.toContain("stacked");
    const productDetailEnums = (schema: unknown): string[][] => {
      const found: string[][] = [];
      const walk = (node: unknown, key?: string) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach((n) => walk(n));
        const record = node as Record<string, unknown>;
        if (key === "productDetail") {
          const list = (
            record.anyOf as { enum?: string[] }[] | undefined
          )?.find((s) => s.enum)?.enum;
          if (list) found.push(list);
        }
        for (const [k, v] of Object.entries(record)) walk(v, k);
      };
      walk(schema);
      return found;
    };
    for (const schema of [
      STAGE_B_DRAFT_SCHEMA,
      STAGE_B_INITIAL_DRAFT_SCHEMA,
      STAGE_B_VARIETY_DRAFT_SCHEMA,
      STAGE_B_VARIETY_INITIAL_SCHEMA,
    ]) {
      const current = schema as {
        properties: Record<string, { properties?: Record<string, unknown> }>;
        required: string[];
      };
      expect(stageBSchemaFor(schema, true, true, true, true, true)).toBe(
        schema,
      );
      expect(stageBSchemaFor(schema, true, true, true, true, true, true)).toBe(
        schema,
      );
      // v33: one plain string, required, in the place v32's object held
      // (straight after fontPairing).
      const keys = Object.keys(current.properties);
      expect(current.properties.templatesJson).toEqual({ type: "string" });
      expect(keys[keys.indexOf("fontPairing") + 1]).toBe("templatesJson");
      expect(current.required).toContain("templatesJson");
      expect(current.properties.templates).toBeUndefined();
      expect(current.required).not.toContain("templates");
      // The v32 twin: v32's closed object at the same key position and the
      // same place in required, and nothing else different.
      const v32 = stageBSchemaFor(
        schema,
        true,
        true,
        true,
        true,
        true,
        false,
      ) as typeof current;
      expect(stageBSchemaFor(schema, true, true, true, true, true, false)).toBe(
        v32,
      );
      expect(v32).not.toBe(schema);
      const asV32 = (key: string) =>
        key === "templatesJson" ? "templates" : key;
      // v34's stylesheetJson came after v32, so a v32 request has none.
      const beforeV34 = (key: string) => key !== "stylesheetJson";
      expect(Object.keys(v32.properties)).toEqual(
        keys.filter(beforeV34).map(asV32),
      );
      expect(v32.required).toEqual(
        current.required.filter(beforeV34).map(asV32),
      );
      expect(v32.properties.stylesheetJson).toBeUndefined();
      expect(v32.properties.templatesJson).toBeUndefined();
      expect(v32.properties.templates).toEqual(TEMPLATES_SCHEMA);
      const without = (properties: object, key: string) =>
        Object.fromEntries(
          Object.entries(properties).filter(([name]) => name !== key),
        );
      expect(without(v32.properties, "templates")).toEqual(
        without(without(current.properties, "templatesJson"), "stylesheetJson"),
      );
      // The v32 object, required, with the whole vocabulary of blocks and
      // galleries.
      expect(v32.required).toContain("templates");
      const product = v32.properties.templates.properties!.product as {
        properties: {
          gallery: { enum: string[] };
          blocks: { items: { properties: { type: { enum: string[] } } } };
        };
      };
      expect(product.properties.gallery.enum).toEqual([...PRODUCT_GALLERIES]);
      expect(product.properties.blocks.items.properties.type.enum).toEqual([
        ...PRODUCT_BLOCK_TYPES,
      ]);
      // Second slice: the blog and account pages, every block carrying its
      // size-guide columns and sizes beside its items, rows and html.
      const templatesProps = v32.properties.templates.properties!;
      expect(Object.keys(templatesProps)).toEqual([
        "product",
        "collection",
        "blog",
        "account",
      ]);
      expect(
        Object.keys(product.properties.blocks.items.properties as object),
      ).toEqual(["type", "items", "rows", "columns", "sizes", "html"]);
      for (const list of productDetailEnums(schema))
        expect(list).toEqual([...PRODUCT_DETAIL_ENUM]);
      for (const list of productDetailEnums(v32))
        expect(list).toEqual([...PRODUCT_DETAIL_ENUM]);
      // The pre-v32 twin has no templates in either shape and no stacked
      // product page, and is otherwise the v31 schema (the initial schema has
      // no layout enum). The JSON flag means nothing without templates, so a
      // request without them has one twin.
      const v31 = stageBSchemaFor(
        schema,
        true,
        true,
        true,
        true,
        false,
      ) as typeof current;
      expect(stageBSchemaFor(schema, true, true, true, true, false)).toBe(v31);
      expect(
        stageBSchemaFor(schema, true, true, true, true, false, false),
      ).toBe(v31);
      expect(v31.properties.templates).toBeUndefined();
      expect(v31.properties.templatesJson).toBeUndefined();
      expect(v31.required).not.toContain("templates");
      expect(v31.required).not.toContain("templatesJson");
      // The announcement bar (plan Phase 2c's last chrome candidate) rides
      // the templates flag, a closed {text, href} object at the top level in
      // both v32 and v33.
      expect(current.required).toContain("announcement");
      expect(Object.keys(current.properties.announcement.properties!)).toEqual([
        "text",
        "href",
      ]);
      expect(v32.properties.announcement).toEqual(
        current.properties.announcement,
      );
      expect(v31.properties.announcement).toBeUndefined();
      expect(v31.required).toEqual(
        current.required.filter(
          (key) =>
            key !== "templatesJson" &&
            key !== "announcement" &&
            key !== "stylesheetJson",
        ),
      );
      const legacyLists = productDetailEnums(v31);
      expect(legacyLists).toHaveLength(productDetailEnums(schema).length);
      for (const list of legacyLists)
        expect(list).toEqual([...LEGACY_PRODUCT_DETAIL_ENUM]);
      // Older twins drop them too, and stay distinct from the v31 twin.
      const v30 = stageBSchemaFor(
        schema,
        true,
        true,
        true,
        false,
        false,
      ) as typeof current;
      expect(v30.properties.templates).toBeUndefined();
      expect(v30.properties.templatesJson).toBeUndefined();
      expect(v30).not.toBe(v31);
    }
  });
});

// Vertex structured output refuses a schema past an undocumented size or
// complexity ceiling with 400 INVALID_ARGUMENT, before the model runs. On 25
// Oct 2026 (storemink-staging) the largest Stage B schema it accepted was
// 14,240 bytes (v32's variety initial schema); v32's revision schemas, 15,893
// (variety draft) and 16,733 bytes (draft), were refused, so every operator
// change that reached Stage B failed until v33 moved the templates into a
// string. At v33 the four measure: draft 14,161, initial 11,025, variety
// draft 13,321 and variety initial 11,668 bytes. v34's stylesheetJson adds
// one more string to each (about 50 bytes), which is why the theme's style
// rules travel as a string too and not as a closed schema.
const LARGEST_ACCEPTED_SCHEMA_BYTES = 14_240;

describe("the theme stylesheet in the Stage B schemas (v34)", () => {
  it.each([
    ["draft", STAGE_B_DRAFT_SCHEMA],
    ["initial draft", STAGE_B_INITIAL_DRAFT_SCHEMA],
    ["variety draft", STAGE_B_VARIETY_DRAFT_SCHEMA],
    ["variety initial", STAGE_B_VARIETY_INITIAL_SCHEMA],
  ] as const)(
    "%s: one required JSON string from v34, and a v33 request has none and is otherwise the same",
    (_name, schema) => {
      const current = schema as {
        properties: Record<string, unknown>;
        required: string[];
      };
      const keys = Object.keys(current.properties);
      // A string, like the templates: the rules are checked by the compiler,
      // and the schema stays small.
      expect(current.properties.stylesheetJson).toEqual({ type: "string" });
      expect(keys[keys.indexOf("templatesJson") + 1]).toBe("stylesheetJson");
      expect(current.required).toContain("stylesheetJson");
      const v33 = stageBSchemaFor(
        schema,
        true,
        true,
        true,
        true,
        true,
        true,
        false,
      ) as typeof current;
      expect(v33).not.toBe(schema);
      // Built once per shape.
      expect(
        stageBSchemaFor(schema, true, true, true, true, true, true, false),
      ).toBe(v33);
      expect(Object.keys(v33.properties)).toEqual(
        keys.filter((key) => key !== "stylesheetJson"),
      );
      expect(v33.required).toEqual(
        current.required.filter((key) => key !== "stylesheetJson"),
      );
      expect(v33.properties).toEqual(
        Object.fromEntries(
          Object.entries(current.properties).filter(
            ([key]) => key !== "stylesheetJson",
          ),
        ),
      );
      // Every earlier shape has none either.
      for (const earlier of [
        stageBSchemaFor(schema, true, true, true, true, true, false),
        stageBSchemaFor(schema, true, true, true, true, false, false),
        stageBSchemaFor(schema, false, false, false, false, false, false),
      ])
        expect(
          (earlier as typeof current).properties.stylesheetJson,
        ).toBeUndefined();
    },
  );
});

describe("the Stage B schemas stay within what Vertex accepted", () => {
  const current = themePromptFeatures(THEME_STUDIO_PROMPT_VERSION);
  const atCurrentVersion = (schema: Record<string, unknown>) =>
    stageBSchemaFor(
      schema,
      current.fontPairings,
      current.nestedBlocks,
      current.moreSections,
      current.moreVariants,
      current.templates,
      current.templatesJson,
      current.stylesheet,
    );
  it.each(
    (
      [
        ["draft", STAGE_B_DRAFT_SCHEMA],
        ["initial draft", STAGE_B_INITIAL_DRAFT_SCHEMA],
        ["variety draft", STAGE_B_VARIETY_DRAFT_SCHEMA],
        ["variety initial", STAGE_B_VARIETY_INITIAL_SCHEMA],
      ] as const
    ).map(([name, schema]) => {
      const bytes = JSON.stringify(atCurrentVersion(schema)).length;
      return [`${name} (${bytes.toLocaleString("en")} bytes)`, bytes] as const;
    }),
  )("%s", (_name, bytes) => {
    expect(
      bytes,
      `The largest Stage B schema Vertex accepted on 25 Oct 2026 (storemink-staging) was ${LARGEST_ACCEPTED_SCHEMA_BYTES.toLocaleString("en")} bytes; the v32 revision schemas of 15,893 and 16,733 bytes were refused with 400 INVALID_ARGUMENT. A schema growing past it must be probed live against Vertex before it ships.`,
    ).toBeLessThanOrEqual(LARGEST_ACCEPTED_SCHEMA_BYTES);
  });
});
