import { USP_ICONS } from "@/lib/homepage/section-types";
import {
  ACCOUNT_LAYOUTS,
  BLOG_ARTICLE_LAYOUTS,
  BLOG_INDEX_LAYOUTS,
  COLLECTION_FILTERS,
  COLLECTION_PAGINATIONS,
  PRODUCT_BLOCK_TYPES,
  PRODUCT_GALLERIES,
} from "@/lib/themes/templates";
import {
  DESIGN_FONTS,
  FONT_PAIRING_KEYS,
  LEGACY_DESIGN_FONT_VALUES,
} from "@/lib/themes/fonts";
import { HOMEPAGE_SECTION_TYPES } from "@/lib/homepage/section-types";
import { SECTION_SCHEMES } from "@/lib/themes/schemes";
import {
  HEADING_CASES,
  HEADING_FONTS,
  HEADING_SCALES,
  HEADING_TRACKINGS,
  HEADING_WEIGHTS,
} from "@/lib/themes/typography";
import {
  BUTTON_CASES,
  BUTTON_HOVERS,
  BUTTON_PRIMARY_STYLES,
  BUTTON_SECONDARY_STYLES,
  BUTTON_SHAPES,
  BUTTON_TRACKINGS,
  BUTTON_WEIGHTS,
} from "@/lib/themes/buttons";
import { MOTION_REVEALS } from "@/lib/themes/motion";
import { GRID_GAPS, PAGE_WIDTHS, SECTION_GAPS } from "@/lib/themes/page";
import { DESIGN_DIRECTION_IDS, PALETTE_FAMILIES } from "./design-directions";
import { REQUIRED_DESIGN_CHOICES } from "./style-choices";
import {
  THEME_STUDIO_FEATURES,
  THEME_STUDIO_INDUSTRIES,
  THEME_STUDIO_LIMITS,
  THEME_INTENT_SCHEMA_VERSION,
} from "./contracts";

// ---------------------------------------------------------------------------
// Provider-facing JSON schemas for structured output.
//
// Gemini's responseJsonSchema accepts a SUBSET of JSON Schema: types including
// `null`, `properties`, `required`, `additionalProperties`, `anyOf`, `enum`,
// `items` and item counts — but not string or numeric bounds,
// `pattern`, `allOf` or `oneOf`, and "very large or deeply nested schemas may be
// rejected". So every object is closed and nothing leans on string rules; these
// are the STRUCTURAL guarantee only. `validateThemeIntent`,
// `validateThemePackageV2` and the compiler remain authoritative for every
// cross-field, registry and length rule; anything they refuse goes back to the
// model through the bounded repair loop.
//
// ★ Optional values are modelled as `anyOf [T, null]` and every property is
// required. A property the model may omit is a property it may silently forget;
// an explicit null is a decision it has to make.
//
// ★ A section's config is carried as a JSON STRING. The 15 renderable section
// types have 15 unrelated config shapes; a closed schema for each would be a
// very large union compiled on every call, and the section registry's own
// `validateSections` is the authority either way. The string is parsed and
// validated server-side.
// ---------------------------------------------------------------------------

/** Section types a generated theme may use: everything renderable except
 * executable custom code, blog feeds (a new store has no blogs) and video (the
 * asset pipeline produces still images only, so a video block could only ever
 * be empty — a request for one is a capability gap). */
export const THEME_STUDIO_SECTION_TYPES = HOMEPAGE_SECTION_TYPES.filter(
  (type) =>
    type !== "custom_code" &&
    type !== "latest_blogs" &&
    type !== "video" &&
    // Builder-only: the image model draws no real press marks (and a mark
    // would be somebody's brand), and a model cannot know a real end date.
    type !== "logo_strip" &&
    type !== "countdown",
);

/** The sections each prompt revision added; a request before that revision
 * never saw them. */
const SECTIONS_BY_REVISION = {
  nestedBlocks: ["accordion", "comparison"],
  moreSections: [
    "multicolumn",
    "image_marquee",
    "image_hotspots",
    "before_after",
    "product_spotlight",
  ],
} as const;

const SECTION_TYPES_BY_FLAGS = new Map<string, typeof HOMEPAGE_SECTION_TYPES>();

/** The section vocabulary a prompt revision prints and its schemas admit,
 * one list per flag pair so callers can compare lists by reference. */
export function themeStudioSectionTypes(
  nestedBlocks: boolean,
  moreSections = false,
) {
  const key = `${nestedBlocks}:${moreSections}`;
  let list = SECTION_TYPES_BY_FLAGS.get(key);
  if (!list) {
    const hidden = new Set<string>([
      ...(nestedBlocks ? [] : SECTIONS_BY_REVISION.nestedBlocks),
      ...(moreSections ? [] : SECTIONS_BY_REVISION.moreSections),
    ]);
    list = hidden.size
      ? THEME_STUDIO_SECTION_TYPES.filter((type) => !hidden.has(type))
      : THEME_STUDIO_SECTION_TYPES;
    SECTION_TYPES_BY_FLAGS.set(key, list);
  }
  return list;
}

/** The section types every request before prompt v29 was keyed on. */
export const LEGACY_THEME_STUDIO_SECTION_TYPES = themeStudioSectionTypes(
  false,
  false,
);

export const THEME_STUDIO_FONT_VALUES = Object.values(DESIGN_FONTS);

const SURFACES = ["home", "shop", "product", "cart", "content", "not_found"];
const GAP_CODES = [
  "missing_section",
  "missing_layout_variant",
  "missing_design_token",
  "unsupported_interaction",
  "unsupported_asset",
  "requires_custom_code",
];

type Schema = Record<string, unknown>;

const str: Schema = { type: "string" };
const strList: Schema = { type: "array", items: str };
/** The header, card and footer layouts a Stage B draft may choose. v31
 * (plan Phase 2d) added transparent, hamburger, stacked and utility headers,
 * centered, soft and wide cards, and centered and compact footers; a request
 * before it is keyed on the shorter lists, which `stageBSchemaFor` narrows
 * every earlier revision's twin back to. */
export const LAYOUT_VARIANT_ENUMS = {
  header: [
    "classic",
    "market",
    "centered",
    "minimal",
    "transparent",
    "hamburger",
    "stacked",
    "utility",
  ],
  card: [
    "classic",
    "quick_add",
    "overlay",
    "framed",
    "grocery",
    "centered",
    "soft",
    "wide",
  ],
  footer: ["rich", "minimal", "editorial", "centered", "compact"],
} as const;
export const LEGACY_LAYOUT_VARIANT_ENUMS = {
  header: ["classic", "market", "centered", "minimal"],
  card: ["classic", "quick_add", "overlay", "framed", "grocery"],
  footer: ["rich", "minimal", "editorial"],
} as const;

const nullable = (schema: Schema): Schema => ({
  anyOf: [schema, { type: "null" }],
});
const enumOf = (values: readonly string[]): Schema => ({
  type: "string",
  enum: [...values],
});
const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const capabilityGap = obj({
  code: enumOf(GAP_CODES),
  requestedCapability: str,
  reason: str,
  blocking: { type: "boolean" },
  suggestedPlatformCapability: nullable(str),
});

const responsiveBreakpoint = obj({
  composition: strList,
  navigation: str,
  media: str,
});

const referenceAnalysis = obj({
  referenceIndex: {
    type: "integer",
    enum: Array.from(
      { length: THEME_STUDIO_LIMITS.referenceImages },
      (_, index) => index,
    ),
  },
  pageKind: enumOf([
    "home",
    "collection",
    "product",
    "cart",
    "content",
    "other",
  ]),
  structure: strList,
  hierarchy: strList,
  palette: strList,
  typography: strList,
  imagery: strList,
  responsiveClues: strList,
  patternsToUse: strList,
  copyingToAvoid: strList,
});

export const STAGE_A_INTENT_SCHEMA: Schema = obj({
  schemaVersion: { type: "integer", enum: [THEME_INTENT_SCHEMA_VERSION] },
  summary: str,
  audiences: strList,
  industries: { type: "array", items: enumOf(THEME_STUDIO_INDUSTRIES) },
  commercialGoals: strList,
  visual: obj({
    moodKeywords: strList,
    paletteDirection: str,
    typographyDirection: str,
    density: enumOf(["airy", "balanced", "dense"]),
    shape: enumOf(["soft", "mixed", "square"]),
    motion: enumOf(["none", "restrained", "expressive"]),
  }),
  pagePlans: {
    type: "array",
    items: obj({
      surface: enumOf(SURFACES),
      purpose: str,
      sectionTypes: {
        type: "array",
        items: enumOf(THEME_STUDIO_SECTION_TYPES),
      },
    }),
  },
  responsive: obj({
    desktop: responsiveBreakpoint,
    tablet: responsiveBreakpoint,
    mobile: responsiveBreakpoint,
  }),
  assetBriefs: {
    type: "array",
    items: obj({
      id: str,
      purpose: str,
      subject: str,
      aspectRatio: enumOf([
        "1:1",
        "4:3",
        "3:2",
        "16:9",
        "21:9",
        "3:4",
        "2:3",
        "4:5",
        "9:16",
      ]),
      artDirection: str,
      source: enumOf(["operator", "curated", "generate"]),
      // v28+: whether this picture may show adults (prompt-features.ts).
      people: enumOf(["none", "adults"]),
    }),
  },
  referenceAnalysis: { type: "array", items: referenceAnalysis },
  assumptions: strList,
  capabilityGaps: { type: "array", items: capabilityGap },
});

/** Stage A's envelope. The model decides first whether it CAN proceed. */
export const STAGE_A_ENVELOPE_SCHEMA: Schema = obj({
  decision: enumOf(["proceed", "clarify", "decline"]),
  questions: strList,
  declineReason: nullable(str),
  intent: nullable(STAGE_A_INTENT_SCHEMA),
});

/** Freeze v1 for queued paid requests; new v21 requests use the additive v2 intent. */
export const STAGE_A_VARIETY_SCHEMA: Schema = (() => {
  const intent = structuredClone(STAGE_A_INTENT_SCHEMA);
  const fields = intent.properties as Record<string, Schema>;
  fields.schemaVersion = { type: "integer", enum: [2] };
  fields.designDirection = enumOf(DESIGN_DIRECTION_IDS);
  fields.paletteFamily = enumOf(PALETTE_FAMILIES);
  intent.required = Object.keys(fields);
  return obj({
    decision: enumOf(["proceed", "clarify", "decline"]),
    questions: strList,
    declineReason: nullable(str),
    intent: nullable(intent),
  });
})();

const link = obj({ label: str, href: str });
// A header item nests two levels (a column, then its links) and may carry a
// mega-menu image. Closed like everything else, so the empty forms are "" and
// []; the compiler's menu cleaner drops them.
const headerColumn = obj({
  label: str,
  href: str,
  children: { type: "array", items: link },
});
const headerItem = obj({
  label: str,
  href: str,
  image_url: str,
  children: { type: "array", items: headerColumn },
});
const hex = str;
const PALETTE_KEYS = [
  "cream",
  "creamDeep",
  "surface",
  "ink",
  "inkSoft",
  "inkFaint",
  "taupe",
  "sand",
  "butter",
  "border",
  "tile",
  "accentWarm",
  "onAccent",
  "onInk",
  "success",
  "successSoft",
  "error",
  "errorSoft",
  "star",
  "highlight",
] as const;

// A band's own colours. Null keys fall back to the derived value
// (lib/themes/schemes.ts), so most themes declare only background + text.
const colorScheme = obj({
  background: hex,
  text: hex,
  surface: nullable(hex),
  accent: nullable(hex),
  onAccent: nullable(hex),
});

/** The product-page layouts a Stage B draft may choose. v32 (plan Phase
 * 2e) added "stacked"; `withoutTemplates` narrows every earlier twin back. */
export const PRODUCT_DETAIL_ENUM = [
  "classic",
  "grocery",
  "editorial",
  "stacked",
] as const;
export const LEGACY_PRODUCT_DETAIL_ENUM = [
  "classic",
  "grocery",
  "editorial",
] as const;

/** v32 (plan Phase 2e): the product and collection page templates
 * (lib/themes/templates.ts). Top level like `fontPairing`, so a targeted
 * repair never edits it; the compiler normalises it into preset.templates.
 * Every block carries every field (a closed schema), unused ones empty.
 * ★ Only v32 requests send it now: `stageBSchemaFor` puts it back in the
 * v32 twin, where v33 sends the same templates as a JSON string. */
export const TEMPLATES_SCHEMA: Schema = obj({
  product: obj({
    gallery: enumOf(PRODUCT_GALLERIES),
    blocks: {
      type: "array",
      items: obj({
        type: enumOf(PRODUCT_BLOCK_TYPES),
        items: {
          type: "array",
          items: obj({ icon: enumOf(USP_ICONS), label: str }),
        },
        rows: { type: "array", items: obj({ heading: str, body: str }) },
        columns: strList,
        sizes: { type: "array", items: obj({ label: str, values: strList }) },
        html: str,
      }),
    },
  }),
  collection: obj({
    filters: enumOf(COLLECTION_FILTERS),
    pagination: enumOf(COLLECTION_PAGINATIONS),
    promoTiles: {
      type: "array",
      items: obj({
        afterIndex: { type: "integer" },
        heading: str,
        body: str,
        cta_label: str,
        href: str,
        theme: enumOf(["dark", "light"]),
        background: nullable(hex),
      }),
    },
  }),
  blog: obj({
    index: enumOf(BLOG_INDEX_LAYOUTS),
    article: enumOf(BLOG_ARTICLE_LAYOUTS),
  }),
  account: obj({
    layout: enumOf(ACCOUNT_LAYOUTS),
    scheme: nullable(enumOf(SECTION_SCHEMES)),
  }),
});

export const STAGE_B_DRAFT_SCHEMA: Schema = obj({
  description: str,
  keywords: strList,
  // v25: the pairing Stage B chose (lib/themes/fonts.ts); null is a free
  // choice of two catalogue faces for a brief that names a typeface. The
  // compiler resolves it into design.fonts; it is never stored. Top level,
  // not under design, so it is not offered as a repair target.
  fontPairing: nullable(enumOf(FONT_PAIRING_KEYS)),
  // v33: the page templates as one JSON string, the way a section's config
  // is carried. The v32 object (TEMPLATES_SCHEMA) pushed the revision
  // schemas past what Vertex accepts; the compiler parses this and names
  // every value the object used to enforce. Same position as v32's
  // `templates`, so the v32 twin puts the object back in its place.
  templatesJson: str,
  // v32 (plan Phase 2c's last chrome candidate): the announcement bar above
  // the header, one line and an optional site path; "" for text means none.
  // Top level like the templates, so it is never a repair target.
  announcement: obj({ text: str, href: str }),
  features: { type: "array", items: enumOf(THEME_STUDIO_FEATURES) },
  brand: obj({ primaryColor: hex, tagline: str, blurb: str }),
  design: obj({
    palette: obj({
      ...Object.fromEntries(PALETTE_KEYS.map((key) => [key, hex])),
      shadowRgb: str,
      accent: nullable(hex),
      accentDeep: nullable(hex),
    }),
    fonts: obj({
      body: enumOf(THEME_STUDIO_FONT_VALUES),
      display: enumOf(THEME_STUDIO_FONT_VALUES),
    }),
    shape: obj({ card: str, control: str, sm: str, pill: str }),
    layout: obj({
      header: nullable(enumOf(LAYOUT_VARIANT_ENUMS.header)),
      headerBackground: nullable(hex),
      headerForeground: nullable(hex),
      card: nullable(enumOf(LAYOUT_VARIANT_ENUMS.card)),
      cardHoverImage: nullable({ type: "boolean" }),
      stickyAddToCart: nullable({ type: "boolean" }),
      gridColumnsMobile: nullable({ type: "integer", enum: [1, 2] }),
      gridColumnsDesktop: nullable({ type: "integer", enum: [3, 4, 5] }),
      shopFilters: nullable({ type: "boolean" }),
      collectionBanner: nullable({ type: "boolean" }),
      productDetail: nullable(enumOf(PRODUCT_DETAIL_ENUM)),
      cart: nullable(enumOf(["classic", "grocery", "compact"])),
      footer: nullable(enumOf(LAYOUT_VARIANT_ENUMS.footer)),
      storefront: nullable(enumOf(["classic", "grocery"])),
    }),
    schemes: obj(
      Object.fromEntries(
        SECTION_SCHEMES.map((id) => [id, nullable(colorScheme)]),
      ),
    ),
    typography: obj({
      headingFont: nullable(enumOf(HEADING_FONTS)),
      headingScale: nullable(enumOf(HEADING_SCALES)),
      headingWeight: nullable(enumOf(HEADING_WEIGHTS)),
      headingCase: nullable(enumOf(HEADING_CASES)),
      headingTracking: nullable(enumOf(HEADING_TRACKINGS)),
    }),
    buttons: obj({
      shape: nullable(enumOf(BUTTON_SHAPES)),
      primary: nullable(enumOf(BUTTON_PRIMARY_STYLES)),
      secondary: nullable(enumOf(BUTTON_SECONDARY_STYLES)),
      case: nullable(enumOf(BUTTON_CASES)),
      weight: nullable(enumOf(BUTTON_WEIGHTS)),
      tracking: nullable(enumOf(BUTTON_TRACKINGS)),
      hover: nullable(enumOf(BUTTON_HOVERS)),
    }),
    page: obj({
      width: nullable(enumOf(PAGE_WIDTHS)),
      sectionGap: nullable(enumOf(SECTION_GAPS)),
      gridGap: nullable(enumOf(GRID_GAPS)),
    }),
    motion: obj({
      reveal: nullable(enumOf(MOTION_REVEALS)),
    }),
  }),
  pages: {
    type: "array",
    items: obj({
      slug: str,
      title: str,
      seoTitle: nullable(str),
      seoDescription: nullable(str),
      sections: {
        type: "array",
        items: obj({
          type: enumOf(THEME_STUDIO_SECTION_TYPES),
          configJson: str,
          style: obj({
            scheme: nullable(enumOf(SECTION_SCHEMES)),
            padding: nullable(enumOf(["sm", "md", "lg"])),
            width: nullable(enumOf(["contained", "full"])),
          }),
        }),
      },
    }),
  },
  menus: obj({
    header: { type: "array", items: headerItem },
    footerGroups: {
      type: "array",
      items: obj({ title: str, links: { type: "array", items: link } }),
    },
    footerLegal: { type: "array", items: link },
  }),
  categories: {
    type: "array",
    items: obj({
      name: str,
      slug: str,
      description: nullable(str),
      imageSlot: str,
    }),
  },
  products: {
    type: "array",
    items: obj({
      name: str,
      slug: str,
      description: str,
      categorySlug: str,
      basePrice: { type: "number" },
      sellingPrice: { type: "number" },
      imageSlot: str,
      featured: { type: "boolean" },
      options: {
        type: "array",
        items: obj({
          name: str,
          values: { type: "array", items: str },
          swatches: {
            type: "array",
            items: obj({ value: str, hex: str }),
          },
        }),
      },
      variants: {
        type: "array",
        items: obj({
          name: str,
          optionValues: { type: "array", items: str },
          basePrice: { type: "number" },
          sellingPrice: { type: "number" },
          stock: { type: "integer" },
        }),
      },
    }),
  },
  capabilityGaps: { type: "array", items: capabilityGap },
});

export { PALETTE_KEYS };

/** Initial v20 drafts omit repeated navigation and variant combinations. The
 * compiler derives those from authored pages/categories/options. Revisions
 * retain the full schema so existing creative choices remain expressible. */
export const STAGE_B_INITIAL_DRAFT_SCHEMA: Schema = (() => {
  const schema = structuredClone(STAGE_B_DRAFT_SCHEMA);
  const properties = schema.properties as Record<string, Schema>;
  delete properties.menus;
  delete properties.features;
  properties.composition = enumOf(["classic", "editorial", "grocery"]);
  properties.navigation = enumOf(["simple", "collections"]);
  const design = properties.design;
  const designProperties = design.properties as Record<string, Schema>;
  delete designProperties.layout;
  designProperties.layoutOverridesJson = str;
  design.required = Object.keys(designProperties);
  const product = properties.products.items as Schema;
  delete (product.properties as Record<string, Schema>).variants;
  product.required = Object.keys(product.properties as object);
  schema.required = Object.keys(properties);
  return schema;
})();

export const STAGE_B_VARIETY_DRAFT_SCHEMA: Schema = (() => {
  const schema = structuredClone(STAGE_B_DRAFT_SCHEMA);
  const design = (schema.properties as Record<string, Schema>).design
    .properties as Record<string, Schema>;
  for (const [group, keys] of Object.entries(REQUIRED_DESIGN_CHOICES)) {
    const fields = design[group].properties as Record<string, Schema>;
    for (const key of keys)
      fields[key] =
        (fields[key].anyOf as Schema[] | undefined)?.find(
          (s) => s.type !== "null",
        ) ?? fields[key];
  }
  const section = (
    ((schema.properties as Record<string, Schema>).pages.items as Schema)
      .properties as Record<string, Schema>
  ).sections.items as Schema;
  const style = (section.properties as Record<string, Schema>).style
    .properties as Record<string, Schema>;
  style.padding = enumOf(["sm", "md", "lg"]);
  style.width = enumOf(["contained", "full"]);
  return schema;
})();

export const STAGE_B_VARIETY_INITIAL_SCHEMA: Schema = (() => {
  const schema = structuredClone(STAGE_B_VARIETY_DRAFT_SCHEMA);
  const fields = schema.properties as Record<string, Schema>;
  delete fields.menus;
  delete fields.features;
  fields.composition = enumOf(["classic", "editorial", "grocery"]);
  fields.navigation = enumOf(["simple", "collections"]);
  const product = fields.products.items as Schema;
  delete (product.properties as Record<string, Schema>).variants;
  product.required = Object.keys(product.properties as object);
  schema.required = Object.keys(fields);
  return schema;
})();

/**
 * The pre-v25 shape of a Stage B schema: no `fontPairing`, and `design.fonts`
 * drawn from the nine faces those prompts enumerated. A persisted paid
 * request is keyed on its exact schema (generation-recovery.ts), so a run
 * recorded under an older prompt revision must be rebuilt byte for byte.
 */
function legacyFontSchema(schema: Schema): Schema {
  const legacy = structuredClone(schema);
  const properties = legacy.properties as Record<string, Schema>;
  delete properties.fontPairing;
  legacy.required = Object.keys(properties);
  const fonts = (properties.design.properties as Record<string, Schema>).fonts
    .properties as Record<string, Schema>;
  fonts.body = enumOf(LEGACY_DESIGN_FONT_VALUES);
  fonts.display = enumOf(LEGACY_DESIGN_FONT_VALUES);
  return legacy;
}

/** The same schema with every section-type enum narrowed to an earlier
 * revision's list, wherever it appears (Stage A page plans, Stage B
 * sections). Matched by value, so the enum helper's shape is not assumed. */
function withSectionTypes(schema: Schema, types: readonly string[]): Schema {
  const twin = structuredClone(schema);
  const full = JSON.stringify(THEME_STUDIO_SECTION_TYPES);
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.enum) && JSON.stringify(record.enum) === full)
      record.enum = [...types];
    Object.values(record).forEach(walk);
  };
  walk(twin);
  return twin;
}

/** The same schema with the three layout enums narrowed to the pre-v31
 * lists, wherever they appear. Matched by value, like `withSectionTypes`. */
function withLegacyLayoutVariants(schema: Schema): Schema {
  const twin = structuredClone(schema);
  const lists = (
    Object.keys(LAYOUT_VARIANT_ENUMS) as (keyof typeof LAYOUT_VARIANT_ENUMS)[]
  ).map((key) => ({
    full: JSON.stringify(LAYOUT_VARIANT_ENUMS[key]),
    legacy: [...LEGACY_LAYOUT_VARIANT_ENUMS[key]],
  }));
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.enum)) {
      const current = JSON.stringify(record.enum);
      const match = lists.find((list) => list.full === current);
      if (match) record.enum = match.legacy;
    }
    Object.values(record).forEach(walk);
  };
  walk(twin);
  return twin;
}

const STAGE_B_SCHEMAS = [
  STAGE_B_DRAFT_SCHEMA,
  STAGE_B_INITIAL_DRAFT_SCHEMA,
  STAGE_B_VARIETY_DRAFT_SCHEMA,
  STAGE_B_VARIETY_INITIAL_SCHEMA,
];
/** Twins keyed by schema and the capabilities that reshape it, built once: a
 * persisted paid request is keyed on the exact schema it was sent. */
const STAGE_B_TWINS = new Map<string, Schema>();

/** The Stage A schema without the brief's `people` field: the shape every
 * request before prompt v28 was keyed on. */
function withoutBriefPeople(schema: Schema): Schema {
  const legacy = structuredClone(schema);
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    const properties = record.properties as Record<string, unknown> | undefined;
    if (properties && "people" in properties && "artDirection" in properties) {
      delete properties.people;
      if (Array.isArray(record.required))
        record.required = record.required.filter((k) => k !== "people");
    }
    Object.values(record).forEach(walk);
  };
  walk(legacy);
  return legacy;
}

const STAGE_A_SCHEMAS = [STAGE_A_ENVELOPE_SCHEMA, STAGE_A_VARIETY_SCHEMA];
const STAGE_A_TWINS = new Map<string, Schema>();

/** The Stage A schema a run of this prompt revision sends: the current one,
 * or a twin without the brief's `people` field (pre-v28) and/or without the
 * nested-block sections (pre-v29), whichever the revision predates. */
export function stageASchemaFor(
  schema: Schema,
  peopleInImagery: boolean,
  nestedBlocks = true,
  moreSections = true,
): Schema {
  if (peopleInImagery && nestedBlocks && moreSections) return schema;
  const index = STAGE_A_SCHEMAS.indexOf(schema);
  if (index < 0) throw new Error("Unknown Stage A schema.");
  const key = `${index}:${peopleInImagery}:${nestedBlocks}:${moreSections}`;
  let twin = STAGE_A_TWINS.get(key);
  if (!twin) {
    twin = schema;
    if (!nestedBlocks || !moreSections)
      twin = withSectionTypes(
        twin,
        themeStudioSectionTypes(nestedBlocks, moreSections),
      );
    if (!peopleInImagery) twin = withoutBriefPeople(twin);
    STAGE_A_TWINS.set(key, twin);
  }
  return twin;
}

/** The pre-v32 shape of a Stage B schema: no top-level templates (as JSON
 * or as the v32 object) or `announcement`, and design.layout.productDetail
 * without "stacked". Matched by value like the other twins; the initial
 * schemas carry no layout enum and lose only the fields. */
function withoutTemplates(schema: Schema): Schema {
  const twin = structuredClone(schema);
  const properties = twin.properties as Record<string, Schema>;
  delete properties.templatesJson;
  delete properties.templates;
  delete properties.announcement;
  twin.required = Object.keys(properties);
  const full = JSON.stringify(PRODUCT_DETAIL_ENUM);
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.enum) && JSON.stringify(record.enum) === full)
      record.enum = [...LEGACY_PRODUCT_DETAIL_ENUM];
    Object.values(record).forEach(walk);
  };
  walk(twin);
  return twin;
}

/** The v32 shape of a Stage B schema: the page templates as the closed
 * object v32 sent (TEMPLATES_SCHEMA), in `templatesJson`'s place among the
 * properties and in `required`, so a persisted v32 request is rebuilt byte
 * for byte. */
function withTemplatesObject(schema: Schema): Schema {
  const twin = structuredClone(schema);
  twin.properties = Object.fromEntries(
    Object.entries(twin.properties as Record<string, Schema>).map(
      ([key, value]) =>
        key === "templatesJson"
          ? ["templates", structuredClone(TEMPLATES_SCHEMA)]
          : [key, value],
    ),
  );
  twin.required = (twin.required as string[]).map((key) =>
    key === "templatesJson" ? "templates" : key,
  );
  return twin;
}

/** The schema a run of this prompt revision sends: the current one, or a
 * twin without font pairings (pre-v25), without the nested-block sections
 * (pre-v29), the v30 sections, the v31 layout variants and/or the v32
 * templates, or with the v32 templates object instead of v33's JSON string,
 * whichever the revision predates. */
export function stageBSchemaFor(
  schema: Schema,
  fontPairings: boolean,
  nestedBlocks = true,
  moreSections = true,
  moreVariants = true,
  templates = true,
  templatesJson = true,
): Schema {
  // A request without templates has neither shape of them, so the JSON flag
  // only counts alongside `templates` (one twin per real shape).
  const asJson = templates && templatesJson;
  if (fontPairings && nestedBlocks && moreSections && moreVariants && asJson)
    return schema;
  const index = STAGE_B_SCHEMAS.indexOf(schema);
  if (index < 0) throw new Error("Unknown Stage B schema.");
  const key = `${index}:${fontPairings}:${nestedBlocks}:${moreSections}:${moreVariants}:${templates}:${asJson}`;
  let twin = STAGE_B_TWINS.get(key);
  if (!twin) {
    twin = schema;
    if (!templates) twin = withoutTemplates(twin);
    else if (!asJson) twin = withTemplatesObject(twin);
    if (!nestedBlocks || !moreSections)
      twin = withSectionTypes(
        twin,
        themeStudioSectionTypes(nestedBlocks, moreSections),
      );
    if (!moreVariants) twin = withLegacyLayoutVariants(twin);
    if (!fontPairings) twin = legacyFontSchema(twin);
    STAGE_B_TWINS.set(key, twin);
  }
  return twin;
}
