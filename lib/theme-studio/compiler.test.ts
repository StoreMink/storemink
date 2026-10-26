import { describe, expect, it } from "vitest";
import { USP_ICONS } from "@/lib/homepage/section-types";
import { basket } from "@/lib/themes/definitions/basket";
import { EXEMPLAR_THEMES } from "@/lib/themes/exemplars";
import {
  defaultTemplates,
  normalizeTemplates,
  templateIssues,
  themeTemplates,
} from "@/lib/themes/templates";
import {
  assemblePackage,
  prepareDraft,
  productSlotBrief,
  productSlotId,
  reservedBriefIssues,
  slotSpec,
  templatesForDraft,
} from "./compiler";
import { createFakeModelClient, runFakeProvider } from "./fake-provider";
import type { ThemeIntent } from "./contracts";
import { THEME_STUDIO_PROMPT_VERSION } from "./prompt-features";
import { TEMPLATES_JSON_EXAMPLE } from "./prompts";

const ASSET_ID_RE = /^[a-z][a-z0-9-]{0,79}$/;

describe("product slot ids", () => {
  it("names a product's slot after its brief and slug, and reads the brief back", () => {
    const id = productSlotId("product-photo", "linen-shirt");
    expect(id).toBe("product-photo--linen-shirt");
    expect(productSlotBrief(id, ["home-hero", "product-photo"])).toBe(
      "product-photo",
    );
  });

  it("prefers the longest brief a slot starts with, and rejects a bare brief", () => {
    const id = productSlotId("photo--studio", "mug");
    expect(productSlotBrief(id, ["photo", "photo--studio"])).toBe(
      "photo--studio",
    );
    expect(productSlotBrief("product-photo", ["product-photo"])).toBeNull();
    expect(productSlotBrief("product-photo--", ["product-photo"])).toBeNull();
    expect(productSlotBrief("home-hero", ["product-photo"])).toBeNull();
  });

  it("keeps a long id within the asset id rule and distinct for slugs sharing a prefix", () => {
    const brief = "catalogue-product-photography-for-the-range";
    const a = productSlotId(brief, `${"handwoven-".repeat(6)}basket-large`);
    const b = productSlotId(brief, `${"handwoven-".repeat(6)}basket-small`);
    for (const id of [a, b]) {
      expect(id.length).toBeLessThanOrEqual(80);
      expect(id).toMatch(ASSET_ID_RE);
    }
    expect(a).not.toBe(b);
    // Deterministic, so a revision that keeps the product keeps the slot.
    expect(productSlotId(brief, `${"handwoven-".repeat(6)}basket-large`)).toBe(
      a,
    );
    expect(productSlotBrief(a, [brief])).toBe(brief);
    // A brief too long to keep whole is shortened the same way both ways.
    const long = `${"range-".repeat(11)}photos`;
    const c = productSlotId(long, "mug");
    expect(c.length).toBeLessThanOrEqual(80);
    expect(c).toMatch(ASSET_ID_RE);
    expect(productSlotBrief(c, ["home-hero", long])).toBe(long);
  });
});

describe("catalog picture slots in storefront content", () => {
  const input = {
    name: "Clay & Co",
    brief: "A calm ceramics shop.",
    industries: ["home" as const],
    catalogSizes: ["small" as const],
    requiredFeatures: [],
    referenceCount: 0,
  };
  async function draftAndIntent() {
    const intent = runFakeProvider(input);
    if (!intent.ok) throw new Error("fake intent failed");
    const result = await createFakeModelClient(input).generate(
      { stage: "draft", content: [] } as never,
      new AbortController().signal,
    );
    if (result.kind !== "ok") throw new Error("fake draft failed");
    return {
      intent: intent.value as ThemeIntent,
      draft: structuredClone(result.value) as Record<string, unknown>,
    };
  }

  it("accepts the offline draft as written", async () => {
    const { intent, draft } = await draftAndIntent();
    expect(prepareDraft(draft, intent).issues).toEqual([]);
  });

  it("refuses a section image that names a catalog screenshot slot, with a repairable reason", async () => {
    const { intent, draft } = await draftAndIntent();
    // Draft sections carry their config as a JSON string (closed schema).
    const sections = (
      draft.pages as { sections: { configJson: string }[] }[]
    ).flatMap((page) => page.sections);
    const withImage = sections.find((section) =>
      Object.entries(JSON.parse(section.configJson)).some(
        ([key, value]) => key.endsWith("_url") && value !== "",
      ),
    );
    expect(withImage).toBeDefined();
    const config = JSON.parse(withImage!.configJson) as Record<string, unknown>;
    const key = Object.keys(config).find(
      (k) => k.endsWith("_url") && config[k] !== "",
    )!;
    config[key] = "theme-asset://screenshot-desktop";
    withImage!.configJson = JSON.stringify(config);
    const { issues } = prepareDraft(draft, intent);
    expect(issues).toEqual([
      expect.stringContaining(
        '"screenshot-desktop", a catalog picture of the finished storefront',
      ),
    ]);
  });

  it("refuses a product or category that names the catalog preview slot", async () => {
    const { intent, draft } = await draftAndIntent();
    const categories = draft.categories as Record<string, unknown>[];
    const imageKey = Object.keys(categories[0]).find((k) => /image/i.test(k))!;
    categories[0][imageKey] = "preview";
    // One precise sentence, not also "needs an imageSlot".
    expect(prepareDraft(draft, intent).issues).toEqual([
      expect.stringContaining('"preview", a catalog picture'),
    ]);
  });
});

describe("reserved catalog slot names", () => {
  it("reserves the catalog slots and screenshot-* names, and nothing inherited from Object", () => {
    const issues = reservedBriefIssues({
      assetBriefs: [
        { id: "preview" },
        { id: "screenshot-hero" },
        { id: "constructor" },
        { id: "home-hero" },
      ],
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('"preview"');
    expect(issues[1]).toContain('"screenshot-hero"');
  });

  it("gives a brief named after an Object.prototype key its own spec, not a system slot's", () => {
    const intent = {
      assetBriefs: [
        { id: "constructor", purpose: "Hero", aspectRatio: "21:9" },
      ],
    } as unknown as ThemeIntent;
    expect(slotSpec("constructor", intent).aspectRatio).toBe("21:9");
  });
});

describe("font pairings (prompt v25)", () => {
  const input = {
    name: "Clay & Co",
    brief: "A calm ceramics shop.",
    industries: ["home" as const],
    catalogSizes: ["small" as const],
    requiredFeatures: [],
    referenceCount: 0,
  };
  async function draftAndIntent() {
    const intent = runFakeProvider(input);
    if (!intent.ok) throw new Error("fake intent failed");
    const result = await createFakeModelClient(input).generate(
      { stage: "draft", content: [] } as never,
      new AbortController().signal,
    );
    if (result.kind !== "ok") throw new Error("fake draft failed");
    return {
      intent: intent.value as ThemeIntent,
      draft: structuredClone(result.value) as Record<string, unknown>,
    };
  }
  const fontsOf = (parts: ReturnType<typeof prepareDraft>["parts"]) =>
    parts?.design?.fonts;

  it("the offline draft names the pairing its faces came from", async () => {
    const { intent, draft } = await draftAndIntent();
    expect(draft.fontPairing).toBe("editorial-fraunces");
    const { issues, parts } = prepareDraft(draft, intent);
    expect(issues).toEqual([]);
    expect(fontsOf(parts)).toEqual({
      body: "var(--font-inter)",
      display: "var(--font-fraunces)",
    });
  });

  it("a pairing wins over the two faces the model also wrote", async () => {
    const { intent, draft } = await draftAndIntent();
    draft.fontPairing = "quiet-serif";
    const { issues, parts } = prepareDraft(draft, intent);
    expect(issues).toEqual([]);
    expect(fontsOf(parts)).toEqual({
      body: "var(--font-jost)",
      display: "var(--font-instrument-serif)",
    });
  });

  it("an unknown pairing is a repair that names the choices; a null one is a free choice", async () => {
    const { intent, draft } = await draftAndIntent();
    draft.fontPairing = "comic-sans-forever";
    expect(prepareDraft(draft, intent).issues).toEqual([
      expect.stringContaining(
        "fontPairing must be null or one of: editorial-fraunces",
      ),
    ]);
    draft.fontPairing = null;
    (draft.design as { fonts: Record<string, string> }).fonts = {
      body: "var(--font-work-sans)",
      display: "var(--font-bebas-neue)",
    };
    const free = prepareDraft(draft, intent);
    expect(free.issues).toEqual([]);
    expect(fontsOf(free.parts)).toEqual({
      body: "var(--font-work-sans)",
      display: "var(--font-bebas-neue)",
    });
  });

  it("refuses a display-only face as the body face, and a face the catalogue lacks", async () => {
    const { intent, draft } = await draftAndIntent();
    draft.fontPairing = null;
    (draft.design as { fonts: Record<string, string> }).fonts = {
      body: "var(--font-bebas-neue)",
      display: "var(--font-bebas-neue)",
    };
    expect(prepareDraft(draft, intent).issues).toEqual([
      "design.fonts.body must be a face suited to body copy; Bebas Neue is display only.",
    ]);
    (draft.design as { fonts: Record<string, string> }).fonts = {
      body: "var(--font-comic)",
      display: "var(--font-fraunces)",
    };
    expect(prepareDraft(draft, intent).issues).toEqual([
      expect.stringContaining(
        "design.fonts.body must be one of the loaded font values: var(--font-inter)",
      ),
    ]);
  });

  it("a draft from before v25 carries no pairing and keeps its faces", async () => {
    const { intent, draft } = await draftAndIntent();
    delete draft.fontPairing;
    const { issues, parts } = prepareDraft(draft, intent);
    expect(issues).toEqual([]);
    expect(fontsOf(parts)).toEqual({
      body: "var(--font-inter)",
      display: "var(--font-fraunces)",
    });
  });
});

// Plan Phase 2e: the offline provider writes the page templates only when the
// request's schema carries them (v33 as a JSON string, v32 as the object), so
// a replay of an earlier revision gets that revision's answer; what the
// compiler makes of them is proved end to end in pipeline.test.ts.
describe("page templates in the offline draft (prompts v32 and v33)", () => {
  const input = {
    name: "Clay & Co",
    brief: "A calm ceramics shop.",
    industries: ["home" as const],
    catalogSizes: ["small" as const],
    requiredFeatures: [],
    referenceCount: 0,
  };
  const draftFor = async (schema: unknown) => {
    const result = await createFakeModelClient(input).generate(
      { stage: "draft", content: [], schema } as never,
      new AbortController().signal,
    );
    if (result.kind !== "ok") throw new Error("fake draft failed");
    return result.value as Record<string, unknown>;
  };

  it("writes templatesJson for a v33 schema, the object for a v32 one and none for an earlier one", async () => {
    const { STAGE_B_DRAFT_SCHEMA, stageBSchemaFor } = await import("./schemas");
    const v33 = await draftFor(STAGE_B_DRAFT_SCHEMA);
    const v32 = await draftFor(
      stageBSchemaFor(
        STAGE_B_DRAFT_SCHEMA,
        true,
        true,
        true,
        true,
        true,
        false,
      ),
    );
    expect(v32.templates).toMatchObject({
      product: { gallery: "thumbs-left" },
      collection: { filters: "top-bar", pagination: "paged" },
    });
    expect(v32.templatesJson).toBeUndefined();
    // v33 writes the same templates, as one JSON string.
    expect(typeof v33.templatesJson).toBe("string");
    expect(v33.templates).toBeUndefined();
    expect(JSON.parse(v33.templatesJson as string)).toEqual(v32.templates);
    // The announcement bar rides the same flag, an object in both.
    expect(v32.announcement).toEqual({
      text: "Free delivery on orders over ₹999, easy 14-day returns",
      href: "/shop",
    });
    expect(v33.announcement).toEqual(v32.announcement);
    const v31 = await draftFor(
      stageBSchemaFor(STAGE_B_DRAFT_SCHEMA, true, true, true, true, false),
    );
    expect(v31.templates).toBeUndefined();
    expect(v31.templatesJson).toBeUndefined();
    expect(v31.announcement).toBeUndefined();
    // The draft still prepares the same way either side of both flags.
    const intent = runFakeProvider(input);
    if (!intent.ok) throw new Error("fake intent failed");
    expect(prepareDraft(v33, intent.value as ThemeIntent).issues).toEqual([]);
    expect(prepareDraft(v32, intent.value as ThemeIntent).issues).toEqual([]);
    expect(prepareDraft(v31, intent.value as ThemeIntent).issues).toEqual([]);
    // An off-site announcement link is a repair issue, like a menu link.
    const offsite = {
      ...v32,
      announcement: { text: "Sale on now", href: "https://example.com" },
    };
    expect(prepareDraft(offsite, intent.value as ThemeIntent).issues).toEqual([
      'announcement.href must be a site path starting with "/".',
    ]);
  });
});

// Prompt v33: the page templates arrive as one JSON string, because v32's
// closed object pushed the revision schemas past what Vertex accepts. The
// compiler parses the string, names every value v32's enums and types used to
// guarantee (the renderer's normaliser would quietly change them), and then
// completes it exactly as v32's object is completed.
describe("page templates as a JSON string (prompt v33)", () => {
  const input = {
    name: "Clay & Co",
    brief: "A calm ceramics shop.",
    industries: ["home" as const],
    catalogSizes: ["small" as const],
    requiredFeatures: [],
    referenceCount: 0,
  };
  type Draft = Record<string, unknown>;
  type Rec = Record<string, unknown>;
  type Templates = Record<string, Rec>;
  async function v33Draft() {
    const { STAGE_B_DRAFT_SCHEMA } = await import("./schemas");
    const intent = runFakeProvider(input);
    if (!intent.ok) throw new Error("fake intent failed");
    const result = await createFakeModelClient(input).generate(
      { stage: "draft", content: [], schema: STAGE_B_DRAFT_SCHEMA } as never,
      new AbortController().signal,
    );
    if (result.kind !== "ok") throw new Error("fake draft failed");
    return {
      intent: intent.value as ThemeIntent,
      draft: structuredClone(result.value) as Draft,
    };
  }
  /** The draft with its templatesJson parsed, changed and written back. */
  const edited = (draft: Draft, change: (templates: Templates) => void) => {
    const templates = JSON.parse(draft.templatesJson as string) as Templates;
    change(templates);
    return { ...draft, templatesJson: JSON.stringify(templates) };
  };
  /** Both compiler passes, with a stored image standing in for every slot. */
  const compile = (draft: Draft, intent: ThemeIntent) => {
    const prepared = prepareDraft(draft, intent);
    if (!prepared.parts) throw new Error(prepared.issues.join(" "));
    return assemblePackage(
      prepared.parts,
      {
        themeId: "clay-co",
        name: "Clay & Co",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        baseEngine: null,
        versionNumber: 1,
        modelKey: "gemini-3.8-flash",
        modelLabel: "Gemini 3.8 Flash",
        promptVersion: THEME_STUDIO_PROMPT_VERSION,
        referenceDigests: [],
      },
      intent,
      new Map(
        prepared.slots.map((slot) => [
          slot,
          { sha256: "a".repeat(64), width: 1600, height: 1200 },
        ]),
      ),
      prepared.issues,
    );
  };

  it("compiles the string into preset.templates, completed exactly as v32's object is", async () => {
    const { intent, draft } = await v33Draft();
    const prepared = prepareDraft(draft, intent);
    expect(prepared.issues).toEqual([]);
    const expected = normalizeTemplates(
      JSON.parse(draft.templatesJson as string),
      defaultTemplates(prepared.parts!.design!.layout),
    );
    expect(prepared.parts!.templatesFromJson).toEqual(expected);
    const compiled = compile(draft, intent);
    expect(compiled.issues).toEqual([]);
    const templates = compiled.package!.definition.preset.templates!;
    expect(templates).toEqual(expected);
    // The offline answer still writes every field on every block, v32's
    // closed shape; the empty carriers are gone once completed.
    expect(templates.product.blocks[0]).toEqual({ type: "price" });
    expect(templates.collection.promoTiles[0]).toMatchObject({
      heading: "The everyday edit",
      background: "",
    });
    expect(templateIssues(templates)).toEqual([]);
    // The same templates as the v32 object path makes of the same value.
    const { templatesJson, ...rest } = draft;
    const v32 = compile(
      { ...rest, templates: JSON.parse(templatesJson as string) },
      intent,
    );
    expect(v32.issues).toEqual([]);
    expect(v32.package!.definition.preset.templates).toEqual(templates);
  });

  it("refuses a string that is not JSON, or not one object, with a sentence the model can act on", async () => {
    const { intent, draft } = await v33Draft();
    const issuesFor = (templatesJson: unknown) => {
      const prepared = prepareDraft({ ...draft, templatesJson }, intent);
      expect(prepared.parts?.templatesFromJson).toBeUndefined();
      return prepared.issues;
    };
    const [broken] = issuesFor('{"product": {"gallery": "grid",');
    expect(broken).toMatch(/^templatesJson is not valid JSON \(.+\)\.$/);
    // The parser's own message is quoted, at most 160 characters of it.
    const [long] = issuesFor(`{"product": ${"x".repeat(400)}}`);
    expect(long).toMatch(/^templatesJson is not valid JSON \(/);
    expect(long.length).toBeLessThanOrEqual(
      "templatesJson is not valid JSON ().".length + 160,
    );
    // A fenced answer: the parser quotes the source with its line breaks,
    // and the sentence stays on the one line a repair turn gives an issue.
    const [fenced] = issuesFor('```json\n{"product": {}}\n```');
    expect(fenced).toMatch(/^templatesJson is not valid JSON \(.+\)\.$/);
    expect(fenced).not.toMatch(/\n/);
    // What the string decoded to, so an array or a twice-encoded object
    // says which mistake it is.
    for (const [value, it] of [
      ["[]", "[]"],
      ['"thumbs-left"', '"thumbs-left"'],
      ["null", "null"],
      ["4", "4"],
      [JSON.stringify(JSON.stringify({ product: {} })), '"{\\"product\\":{}}"'],
    ])
      expect(issuesFor(value)).toEqual([
        `templatesJson must encode one JSON object (it is ${it}).`,
      ]);
    expect(issuesFor({ product: {} })).toEqual([
      "templatesJson must be a string holding one JSON object.",
    ]);
  });

  it("names an unknown gallery or icon by its path rather than letting it become another", async () => {
    const { intent, draft } = await v33Draft();
    const wrong = edited(draft, (templates) => {
      templates.product.gallery = "masonry";
      const blocks = templates.product.blocks as Rec[];
      expect(blocks[3].type).toBe("trust_row");
      (blocks[3].items as Rec[])[1].icon = "rocket";
    });
    expect(prepareDraft(wrong, intent).issues).toEqual([
      'templatesJson.product.gallery must be one of thumbs-bottom, thumbs-left, stacked, carousel, grid (it is "masonry").',
      `templatesJson.product.blocks[3].items[1].icon must be one of ${USP_ICONS.join(", ")} (it is "rocket").`,
    ]);
    // So no version is made with the icon or gallery the normaliser would
    // have put in their place.
    expect(compile(wrong, intent).package).toBeNull();
  });

  it("names every other value v32's enums and types guaranteed, at most eight at a time", async () => {
    const { intent, draft } = await v33Draft();
    const wrong = edited(draft, (templates) => {
      templates.collection.filters = "floating";
      templates.collection.pagination = "endless";
      const tile = (templates.collection.promoTiles as Rec[])[0];
      tile.theme = "purple";
      tile.afterIndex = "4" as never;
      tile.image_url = "https://example.com/tile.jpg" as never;
      templates.blog.index = "masonry";
      templates.account.scheme = "midnight";
      delete (templates as Record<string, unknown>).blog;
      (templates.product.blocks as Rec[])[3] = {
        type: "trust_row",
      } as never;
    });
    expect(prepareDraft(wrong, intent).issues).toEqual([
      "templatesJson.product.blocks[3].items must be a list (it is missing).",
      'templatesJson.collection.filters must be one of sidebar, drawer, top-bar (it is "floating").',
      'templatesJson.collection.pagination must be one of load-more, paged, infinite (it is "endless").',
      'templatesJson.collection.promoTiles[0].afterIndex must be a whole number (it is "4").',
      'templatesJson.collection.promoTiles[0].theme must be one of dark, light (it is "purple").',
      "templatesJson.collection.promoTiles[0].image_url is not a promo tile field: a generated theme's tile is a colour field, so leave it out.",
      "templatesJson.blog must be an object (it is missing).",
      'templatesJson.account.scheme must be null or one of soft, tint, accent, inverse (it is "midnight").',
    ]);
    // Past eight, one sentence counts the rest.
    const more = edited(wrong as Draft, (templates) => {
      templates.account.layout = "drawer";
      templates.product.blocks = { type: "price" } as never;
    });
    const issues = prepareDraft(more, intent).issues;
    expect(issues).toHaveLength(9);
    expect(issues[0]).toBe(
      'templatesJson.product.blocks must be a list (it is {"type":"price"}).',
    );
    expect(issues[8]).toBe(
      "templatesJson has 1 more problem like these; check every value against the Templates rules.",
    );
  });

  it("stays silent where v32 normalised silently, and takes either spelling of the page's own colours", async () => {
    const { intent, draft } = await v33Draft();
    const quiet = edited(draft, (templates) => {
      const blocks = templates.product.blocks as Rec[];
      // No price block, a second description, and eight trust items.
      blocks.splice(0, 1);
      blocks.push({ type: "description" });
      const trust = blocks.find((block) => block.type === "trust_row")!;
      trust.items = Array.from({ length: 8 }, (_, i) => ({
        icon: "truck",
        label: `Promise ${i + 1}`,
      })) as never;
      templates.account.scheme = "";
    });
    const prepared = prepareDraft(quiet, intent);
    expect(prepared.issues).toEqual([]);
    const product = prepared.parts!.templatesFromJson!.product;
    expect(product.blocks.filter((b) => b.type === "description")).toHaveLength(
      1,
    );
    expect(product.blocks.at(-1)).toEqual({ type: "price" });
    const trust = product.blocks.find((b) => b.type === "trust_row");
    expect(trust && "items" in trust && trust.items).toHaveLength(6);
    expect(prepared.parts!.templatesFromJson!.account.scheme).toBe("");
  });

  it("holds a promo tile's link to a site path, like the announcement's", async () => {
    const { intent, draft } = await v33Draft();
    const withHref = (href: string) =>
      edited(draft, (templates) => {
        (templates.collection.promoTiles as Rec[])[0].href = href;
      });
    // The normaliser would turn a bare slug into no link at all and keep an
    // off-site one, so both go back to the model.
    for (const href of [
      "collections/everyday",
      "https://example.com/sale",
      "//example.com",
    ])
      expect(prepareDraft(withHref(href), intent).issues).toEqual([
        `templatesJson.collection.promoTiles[0].href must be "" or a site path starting with "/" (it is ${JSON.stringify(href)}).`,
      ]);
    for (const href of ["", "/shop"])
      expect(prepareDraft(withHref(href), intent).issues).toEqual([]);
  });

  it("holds the sticky_bar block to design.layout.stickyAddToCart, on the string path only", async () => {
    const { intent, draft } = await v33Draft();
    const withSticky = (value: Draft, sticky: boolean | null) => {
      const design = structuredClone(value.design) as Rec;
      (design.layout as Rec).stickyAddToCart = sticky;
      return { ...value, design };
    };
    // The offline draft asks for the bar and its blocks carry it.
    expect(prepareDraft(draft, intent).issues).toEqual([]);
    const noBlock = edited(draft, (templates) => {
      templates.product.blocks = (templates.product.blocks as Rec[]).filter(
        (block) => block.type !== "sticky_bar",
      );
    });
    expect(prepareDraft(noBlock, intent).issues).toEqual([
      'design.layout.stickyAddToCart is true but templatesJson.product.blocks has no "sticky_bar" block. The block is the phone\'s sticky add-to-cart and the storefront shows nothing without it: add {"type":"sticky_bar"} or set the setting false.',
    ]);
    expect(prepareDraft(withSticky(noBlock, false), intent).issues).toEqual([]);
    // Null keeps the shared default, which has no bar.
    for (const sticky of [false, null])
      expect(prepareDraft(withSticky(draft, sticky), intent).issues).toEqual([
        'templatesJson.product.blocks has a "sticky_bar" block but design.layout.stickyAddToCart is not true. The block is the phone\'s sticky add-to-cart, so write it exactly when that setting is true: set the setting true or leave the block out.',
      ]);
    // v32's object was never held to this, and still is not.
    const { templatesJson, ...rest } = noBlock;
    expect(
      prepareDraft(
        { ...rest, templates: JSON.parse(templatesJson as string) },
        intent,
      ).issues,
    ).toEqual([]);
  });

  it("names a size chart written in numbers once per list, not once per cell", async () => {
    const { intent, draft } = await v33Draft();
    const numeric = edited(draft, (templates) => {
      const blocks = templates.product.blocks as Rec[];
      expect(blocks[6].type).toBe("size_guide");
      blocks[6].sizes = [
        { label: "S", values: [92, 76] },
        { label: "M", values: ["97", 81] },
      ] as never;
    });
    // The normaliser would blank every number, so each list goes back once.
    expect(prepareDraft(numeric, intent).issues).toEqual([
      "templatesJson.product.blocks[6].sizes[0].values must be a list of strings (templatesJson.product.blocks[6].sizes[0].values[0] is 92).",
      "templatesJson.product.blocks[6].sizes[1].values must be a list of strings (templatesJson.product.blocks[6].sizes[1].values[1] is 81).",
    ]);
  });

  it("accepts blocks that carry only the fields their type uses, like the prompt's example", async () => {
    const { intent, draft } = await v33Draft();
    const prepared = prepareDraft(
      { ...draft, templatesJson: JSON.stringify(TEMPLATES_JSON_EXAMPLE) },
      intent,
    );
    expect(prepared.issues).toEqual([]);
    const templates = prepared.parts!.templatesFromJson!;
    // The offline draft's design.layout.stickyAddToCart is true, which is
    // the theme the example is written for.
    expect(prepared.parts!.design!.layout?.stickyAddToCart).toBe(true);
    expect(templates.product.blocks.map((b) => b.type)).toEqual([
      "price",
      "variant_picker",
      "buy_box",
      "trust_row",
      "description",
      "reviews",
      "recommendations",
      "sticky_bar",
    ]);
    expect(templates.account).toEqual({ layout: "plain", scheme: "" });
    expect(templateIssues(templates)).toEqual([]);
  });

  it("compiles a stored theme's templates, written as a draft writes them, back to themselves", async () => {
    const { intent, draft } = await v33Draft();
    for (const theme of [...EXEMPLAR_THEMES, basket]) {
      const stored = themeTemplates(theme.preset);
      // The theme's own sticky setting, which its templates agree with.
      const design = structuredClone(draft.design) as Rec;
      (design.layout as Rec).stickyAddToCart =
        theme.preset.design.layout?.stickyAddToCart === true;
      const prepared = prepareDraft(
        {
          ...draft,
          design,
          templatesJson: JSON.stringify(templatesForDraft(stored)),
        },
        intent,
      );
      expect(prepared.issues, theme.id).toEqual([]);
      expect(prepared.parts!.templatesFromJson, theme.id).toEqual(stored);
    }
  });

  it("leaves the v32 object path as it was, and a draft with neither without templates", async () => {
    const { intent, draft } = await v33Draft();
    const { templatesJson, ...rest } = draft;
    const object = JSON.parse(templatesJson as string) as Templates;
    // v32's schema enum kept an unknown icon out; the object path never
    // reported one and still does not.
    ((object.product.blocks as Rec[])[3].items as Rec[])[1].icon = "rocket";
    const v32 = { ...rest, templates: object };
    const prepared = prepareDraft(v32, intent);
    expect(prepared.issues).toEqual([]);
    expect(prepared.parts!.templatesFromJson).toBeUndefined();
    const compiled = compile(v32, intent);
    expect(compiled.package!.definition.preset.templates).toEqual(
      normalizeTemplates(
        object,
        defaultTemplates(prepared.parts!.design!.layout),
      ),
    );
    const neither = compile(rest, intent);
    expect(neither.issues).toEqual([]);
    expect(neither.package!.definition.preset.templates).toBeUndefined();
  });
});
