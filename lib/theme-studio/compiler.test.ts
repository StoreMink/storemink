import { describe, expect, it } from "vitest";
import {
  prepareDraft,
  productSlotBrief,
  productSlotId,
  reservedBriefIssues,
  slotSpec,
} from "./compiler";
import { createFakeModelClient, runFakeProvider } from "./fake-provider";
import type { ThemeIntent } from "./contracts";

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
// request's schema carries them, so a pre-v32 replay gets a pre-v32 answer;
// what the compiler makes of them is proved end to end in pipeline.test.ts.
describe("page templates in the offline draft (prompt v32)", () => {
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

  it("writes templates for a v32 schema and none for an earlier one", async () => {
    const { STAGE_B_DRAFT_SCHEMA, stageBSchemaFor } = await import("./schemas");
    const v32 = await draftFor(STAGE_B_DRAFT_SCHEMA);
    expect(v32.templates).toMatchObject({
      product: { gallery: "thumbs-left" },
      collection: { filters: "top-bar", pagination: "paged" },
    });
    const v31 = await draftFor(
      stageBSchemaFor(STAGE_B_DRAFT_SCHEMA, true, true, true, true, false),
    );
    expect(v31.templates).toBeUndefined();
    // The draft still prepares the same way either side of the flag.
    const intent = runFakeProvider(input);
    if (!intent.ok) throw new Error("fake intent failed");
    expect(prepareDraft(v32, intent.value as ThemeIntent).issues).toEqual([]);
    expect(prepareDraft(v31, intent.value as ThemeIntent).issues).toEqual([]);
  });
});
