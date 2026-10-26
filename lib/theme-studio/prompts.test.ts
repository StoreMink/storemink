import { describe, expect, it } from "vitest";
import { USP_ICONS } from "@/lib/homepage/section-types";
import { basket } from "@/lib/themes/definitions/basket";
import { EXEMPLAR_THEMES } from "@/lib/themes/exemplars";
import { SECTION_SCHEMES } from "@/lib/themes/schemes";
import {
  ACCOUNT_LAYOUTS,
  BLOG_ARTICLE_LAYOUTS,
  BLOG_INDEX_LAYOUTS,
  COLLECTION_FILTERS,
  COLLECTION_PAGINATIONS,
  PRODUCT_BLOCK_TYPES,
  PRODUCT_GALLERIES,
  defaultTemplates,
  normalizeTemplates,
} from "@/lib/themes/templates";
import { templatesForDraft } from "./compiler";
import { themeDefinitionToPackageV2, type ThemeIntent } from "./contracts";
import { DESIGN_DIRECTION_IDS } from "./design-directions";
import { runFakeProvider } from "./fake-provider";
import {
  TEMPLATES_JSON_EXAMPLE,
  currentThemeForRevision,
  stageBInitialSystemPrompt,
  stageBSystemPrompt,
  stageBUserText,
  stageBVarietySystemPrompt,
  type ProjectFacts,
} from "./prompts";

// Prompt v33: Stage B writes the page templates as one JSON string,
// `templatesJson`, because v32's closed object pushed the revision schemas
// past what Vertex accepts. The schema no longer says what goes inside the
// string, so the Templates bullet has to, and a revision is shown the
// templates and the announcement bar it is asked to keep. Every earlier
// revision's text is pinned byte for byte in stage-b-request.golden.test.ts.

const LONG_DASHES = /[\u2013\u2014]/;

/** fontPairings, fullBleedOpening, carouselOpening, nestedBlocks,
 * moreSections, moreVariants and templates: everything v32 had. */
const V32 = [true, true, true, true, true, true, true] as const;

/** The Templates bullet of a Stage B system prompt. */
function templatesBullet(prompt: string): string {
  const start = prompt.indexOf("\n- Templates:");
  const end = prompt.indexOf("\n- Announcement bar:");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

const withoutBullet = (prompt: string) =>
  prompt.replace(templatesBullet(prompt), "");

/** A closed list as the bullet prints it: every value quoted, in order. */
const quotedList = (values: readonly string[]) =>
  `${values
    .slice(0, -1)
    .map((value) => `"${value}"`)
    .join(", ")} or "${values[values.length - 1]}"`;

const brief = runFakeProvider({
  name: "Clay & Co",
  brief: "A calm ceramics shop selling handmade mugs and bowls.",
  industries: ["home"],
  catalogSizes: ["small"],
  requiredFeatures: [],
  referenceCount: 0,
});
if (!brief.ok) throw new Error("fake intent failed");
const intent = brief.value as ThemeIntent;
const varietyIntent = {
  ...intent,
  schemaVersion: 2,
  designDirection: DESIGN_DIRECTION_IDS[0],
  paletteFamily: "light",
} as unknown as ThemeIntent;

describe("the v33 Templates bullet", () => {
  const v33 = stageBSystemPrompt(true, ...V32, true);
  const v32 = stageBSystemPrompt(true, ...V32);
  const bullet = templatesBullet(v33);

  it("asks for one JSON string and lists every value of every closed list from the renderer's own vocabularies", () => {
    expect(bullet).toContain(
      '- Templates: write a top-level "templatesJson" string that holds exactly one JSON object',
    );
    expect(bullet).not.toContain('"templates" object');
    expect(bullet).toContain(
      '{"product":{"gallery":"...","blocks":[...]},"collection":{"filters":"...","pagination":"...","promoTiles":[...]},"blog":{"index":"...","article":"..."},"account":{"layout":"...","scheme":null}}',
    );
    // The trust-bar icons are read from USP_ICONS, so the list a model is
    // shown is the one the renderer draws.
    expect(bullet).toContain(`where icon is ${quotedList(USP_ICONS)} and`);
    expect(bullet).toContain(`"type" is ${quotedList(PRODUCT_BLOCK_TYPES)}.`);
    for (const list of [
      PRODUCT_GALLERIES,
      COLLECTION_FILTERS,
      COLLECTION_PAGINATIONS,
      BLOG_INDEX_LAYOUTS,
      BLOG_ARTICLE_LAYOUTS,
      ACCOUNT_LAYOUTS,
      SECTION_SCHEMES,
    ])
      for (const value of list) expect(bullet).toContain(`"${value}"`);
    for (const gallery of PRODUCT_GALLERIES)
      expect(bullet).toContain(`"${gallery}" (`);
    // Each block's fields, the ranges and the rules the schema used to
    // enforce or v32 stated.
    for (const words of [
      'a "trust_row" has "items", 2 to 6 objects with "icon" and "label"',
      'an "accordion" has "rows", 1 to 8 objects with "heading" and "body"',
      'a "rich_text" has "html"',
      'a "size_guide" has "columns", 2 to 8 measurement names',
      '"sizes", one object per size with "label" and "values"',
      "belongs on a garment or footwear range and nowhere else",
      'every other block is {"type":"..."} and nothing more',
      '"price" and "buy_box" (quantity and the two buttons) are required',
      "each type appears at most once",
      '"reviews" and "recommendations" render under the grid in this order',
      "exactly when design.layout.stickyAddToCart is true",
      "holds 0 to 4 editorial tiles",
      '"afterIndex", "heading", "body", "cta_label", "href", "theme" and "background"',
      "afterIndex is a whole number from 1 to 48",
      'theme is "dark" or "light"',
      "background is a palette hex the copy reads on, or null",
      "a grocery theme none",
      'design.layout.productDetail may also be "stacked"',
      // Said outright because the schema no longer types or checks them.
      "choose that setting first and make the two agree",
      "label is a short promise such as free delivery, easy returns or secure checkout, never a claim the brief does not support;",
      "in the brand's voice and never a claim the brief does not support;",
      '"values", a list of strings, one per column in column order, in centimetres (such as ["96","76","70"] under Chest, Waist and Length)',
      'href is "" or a site path starting with "/" that reaches something you seed',
    ])
      expect(bullet).toContain(words);
    // The example is the common case, a theme with the phone's sticky bar,
    // and says it is a shape rather than an answer.
    expect(TEMPLATES_JSON_EXAMPLE.product.blocks.at(-1)).toEqual({
      type: "sticky_bar",
    });
    expect(bullet).toContain(
      `For example, a theme whose design.layout.stickyAddToCart is true could write this object in templatesJson; it shows the shape, so choose every value for this theme and its brief: ${JSON.stringify(TEMPLATES_JSON_EXAMPLE)}.`,
    );
  });

  it("is the only text v33 changes, and writes no long dash", () => {
    // A model copies its prompt's punctuation into storefront copy. v32's
    // bullet, kept byte for byte, still has its dashes; v33's has none.
    expect(bullet).not.toMatch(LONG_DASHES);
    expect(templatesBullet(v32)).toMatch(LONG_DASHES);
    expect(v32).toBe(stageBSystemPrompt(true, ...V32, false));
    expect(templatesBullet(v32)).toContain(
      '- Templates: write a top-level "templates" object',
    );
    // The announcement and collection-list bullets after it are v32's.
    expect(withoutBullet(v33)).toBe(withoutBullet(v32));
  });

  it("reaches the initial and variety prompts", () => {
    const pairs = [
      [
        stageBInitialSystemPrompt(intent, ...V32, true),
        stageBInitialSystemPrompt(intent, ...V32),
      ],
      [
        stageBVarietySystemPrompt(varietyIntent, true, ...V32, true),
        stageBVarietySystemPrompt(varietyIntent, true, ...V32),
      ],
      [
        stageBVarietySystemPrompt(varietyIntent, false, ...V32, true),
        stageBVarietySystemPrompt(varietyIntent, false, ...V32),
      ],
    ];
    for (const [current, previous] of pairs) {
      expect(templatesBullet(current)).toBe(bullet);
      expect(templatesBullet(previous)).toBe(templatesBullet(v32));
      expect(withoutBullet(current)).toBe(withoutBullet(previous));
    }
  });
});

describe("a v33 revision's current theme", () => {
  const without = (value: Record<string, unknown>, ...keys: string[]) =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => !keys.includes(key)),
    );

  it("carries the base theme's templates and announcement bar, in the shape a draft writes them", () => {
    expect(EXEMPLAR_THEMES.length).toBeGreaterThan(0);
    for (const theme of EXEMPLAR_THEMES) {
      const stored = theme.preset.templates!;
      expect(stored, theme.id).toBeDefined();
      const pkg = themeDefinitionToPackageV2(theme);
      const before = currentThemeForRevision(pkg, varietyIntent, true);
      expect(currentThemeForRevision(pkg, varietyIntent, true, false)).toBe(
        before,
      );
      const current = JSON.parse(
        currentThemeForRevision(pkg, varietyIntent, true, true),
      ) as Record<string, unknown>;
      // Right after fontPairing, and nothing else in the context moves.
      expect(Object.keys(current).slice(2, 5)).toEqual([
        "fontPairing",
        "templatesJson",
        "announcement",
      ]);
      expect(
        JSON.stringify(without(current, "templatesJson", "announcement")),
      ).toBe(before);
      expect(current.announcement).toEqual({
        text: theme.preset.announcement?.text ?? "",
        href: theme.preset.announcement?.href ?? "",
      });
      expect(typeof current.templatesJson).toBe("string");
      const written = JSON.parse(current.templatesJson as string);
      expect(current.templatesJson).toBe(
        JSON.stringify(templatesForDraft(stored)),
      );
      // The draft's spelling: a promo tile has no picture fields, and the
      // page's own colours or field are null where the stored value says "".
      expect(written.product).toEqual(stored.product);
      expect(written.blog).toEqual(stored.blog);
      expect(written.collection.promoTiles).toEqual(
        stored.collection.promoTiles.map((tile) => ({
          ...without({ ...tile }, "image_url", "image_alt"),
          background: tile.background || null,
        })),
      );
      expect(written.account).toEqual({
        layout: stored.account.layout,
        scheme: stored.account.scheme || null,
      });
      // So a revision that copies it keeps exactly what the storefront
      // renders today.
      expect(
        normalizeTemplates(
          written,
          defaultTemplates(theme.preset.design.layout),
        ),
      ).toEqual(stored);
    }
  });

  it("shows a theme without templates the composition its storefront renders, and an empty announcement", () => {
    expect(basket.preset.templates).toBeUndefined();
    expect(basket.preset.announcement).toBeUndefined();
    const current = JSON.parse(
      currentThemeForRevision(
        themeDefinitionToPackageV2(basket),
        intent,
        true,
        true,
      ),
    ) as Record<string, unknown>;
    expect(current.templatesJson).toBe(
      JSON.stringify(
        templatesForDraft(defaultTemplates(basket.preset.design.layout)),
      ),
    );
    expect(current.announcement).toEqual({ text: "", href: "" });
  });

  it("is named, with the announcement bar, among what a revision keeps", () => {
    const facts: ProjectFacts = {
      name: "Clay & Co",
      themeId: "clay-co",
      industries: ["home"],
      catalogSizes: ["small"],
      requiredFeatures: [],
      baseThemeName: null,
    };
    const pkg = themeDefinitionToPackageV2(EXEMPLAR_THEMES[0]);
    const context = currentThemeForRevision(pkg, varietyIntent, true, true);
    const text = stageBUserText(
      facts,
      varietyIntent,
      context,
      undefined,
      true,
      true,
    );
    const sentence = text
      .split("\n")
      .find((line) => line.startsWith("This is a REVISION."))!;
    expect(sentence).toContain(
      "except its templatesJson and announcement, which are written exactly as your answer writes them and show what its storefront renders today",
    );
    expect(sentence).toContain(
      "Keep its copy, sections, navigation, catalogue, page templates (templatesJson) and announcement bar wherever the revised intent does not change them",
    );
    // A theme made before either existed shows an empty bar and no tiles,
    // and the system prompt's advice for a new theme must not fill them in.
    expect(sentence).toContain(
      'An announcement whose text is "" means the theme has no bar, and an empty promoTiles list means no tiles: keep them that way unless the revised intent asks for them, whatever the Templates and Announcement bar rules say a new theme usually carries.',
    );
    expect(sentence).not.toMatch(LONG_DASHES);
    expect(text).toContain(`<current_theme>\n${context}\n</current_theme>`);
    // Without the flag the v32 sentence stands, and a new build (no current
    // theme) reads the same either way.
    const before = stageBUserText(
      facts,
      varietyIntent,
      context,
      undefined,
      true,
    );
    expect(before).toBe(
      stageBUserText(facts, varietyIntent, context, undefined, true, false),
    );
    expect(before).not.toContain("templatesJson) and announcement bar");
    const messages = [{ kind: "brief" as const, body: "A calm shop." }];
    expect(
      stageBUserText(facts, varietyIntent, undefined, messages, true, true),
    ).toBe(stageBUserText(facts, varietyIntent, undefined, messages, true));
  });
});
