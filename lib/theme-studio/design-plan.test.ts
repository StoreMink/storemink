// The design plan (owner, 22 Nov 2026): decided, completed and checked
// against the published catalogue before anything is built, and the build
// held to it. The pipeline's use of it is in design-plan-pipeline.test.ts.
import { describe, expect, it } from "vitest";
import { studio } from "@/lib/themes/definitions/studio";
import { FONT_PAIRING_KEYS, pairingFonts } from "@/lib/themes/fonts";
import { themeDefinitionToPackageV2 } from "./contracts";
import { layoutCommitments } from "./commitments";
import {
  PLAN_DISTINCTNESS_FLOOR,
  PLAN_LAYOUT_VALUES,
  completeDesignPlan,
  designPlanBuildPrompt,
  designPlanDepartures,
  designPlanIssues,
  designPlanPlanningPrompt,
  parseDesignPlan,
  parseDesignPlanJson,
  planAlikeness,
  planContrast,
  planDistance,
  type DesignPlan,
} from "./design-plan";
import {
  colourBand,
  readVarietyContext,
  themeFingerprint,
  type ExistingThemeFingerprint,
} from "./fingerprint";

const raw = {
  colours: {
    page: "#FBFAF7",
    surface: "#ffffff",
    ink: "#1f2a24",
    accent: "#2f5d50",
  },
  fontPairing: "editorial-fraunces",
  buttons: { shape: "pill", primary: "outline" },
  layout: null,
  styling: [
    "  Product names in the   body face, medium weight. ",
    "Prices a size up from the name.",
  ],
  setsApart: ["A pill outline button where the catalogue uses solid ones."],
};
const layout = {
  header: "centered",
  card: "framed",
  productDetail: "editorial",
  footer: "minimal",
  pageWidth: "narrow",
  gridColumnsDesktop: 3,
  cardHoverImage: true,
} as const;
const read = (value: unknown = raw) => {
  const issues: string[] = [];
  return { plan: parseDesignPlan(value, "designPlan", issues), issues };
};
const plan = (over: Partial<typeof raw> | Record<string, unknown> = {}) => {
  const { plan: parsed, issues } = read({ ...raw, ...over });
  if (!parsed) throw new Error(issues.join(" | "));
  return parsed;
};

describe("reading a plan", () => {
  it("whitelists and bounds every field", () => {
    const parsed = plan({ extra: "ignored", layoutSource: "reference" });
    expect(parsed).toEqual({
      version: 1,
      colours: {
        page: "#fbfaf7",
        surface: "#ffffff",
        ink: "#1f2a24",
        accent: "#2f5d50",
      },
      fontPairing: "editorial-fraunces",
      buttons: { shape: "pill", primary: "outline" },
      layout: null,
      // No layout, so nothing decided one, whatever was claimed.
      layoutSource: "none",
      styling: [
        "Product names in the body face, medium weight.",
        "Prices a size up from the name.",
      ],
      setsApart: ["A pill outline button where the catalogue uses solid ones."],
    });
    expect(plan({ layout }).layout).toEqual(layout);
    expect(
      plan({ styling: Array.from({ length: 12 }, (_, i) => `Line ${i}`) })
        .styling,
    ).toHaveLength(6);
    expect(plan({ styling: ["a", "x".repeat(900)] }).styling[1]).toHaveLength(
      200,
    );
  });

  it("names what is wrong, in words a model can repair from", () => {
    const bad = read({
      ...raw,
      colours: { ...raw.colours, page: "cream", accent: "#12" },
      fontPairing: "comic",
      buttons: { shape: "blob", primary: "ghost" },
      layout: { ...layout, header: "floating", gridColumnsDesktop: 9 },
      styling: ["only one"],
      setsApart: [],
    });
    expect(bad.plan).toBeNull();
    const text = bad.issues.join("\n");
    expect(text).toContain("designPlan.colours.page must be a #rrggbb colour");
    expect(text).toContain(
      "designPlan.colours.accent must be a #rrggbb colour",
    );
    expect(text).toContain("designPlan.fontPairing must be one of");
    expect(text).toContain("designPlan.buttons.shape must be one of");
    expect(text).toContain("designPlan.buttons.primary must be one of");
    expect(text).toContain("designPlan.layout.header must be one of");
    expect(text).toContain(
      "designPlan.layout.gridColumnsDesktop must be one of",
    );
    expect(text).toContain("designPlan.styling needs at least 2 lines");
    expect(text).toContain("designPlan.setsApart needs at least 1 line");
  });

  it("★ refuses a text colour that does not read on the page or on cards", () => {
    expect(planContrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    const grey = read({
      ...raw,
      colours: { ...raw.colours, ink: "#9a9a9a" },
    });
    expect(grey.plan).toBeNull();
    expect(grey.issues.join("\n")).toMatch(
      /colours\.ink reads \d\.\d\d:1 on the page .* body text needs 4\.5:1/,
    );
    // Reads on the page, not on a dark card.
    const split = read({
      ...raw,
      colours: { ...raw.colours, surface: "#20262a" },
    });
    expect(split.plan).toBeNull();
    expect(split.issues).toHaveLength(1);
    expect(split.issues[0]).toContain("on cards (#20262a)");
  });

  it("reads the model's JSON string, and says so when it is not one", () => {
    const issues: string[] = [];
    expect(parseDesignPlanJson(JSON.stringify(raw), issues)?.fontPairing).toBe(
      "editorial-fraunces",
    );
    expect(issues).toEqual([]);
    for (const [value, words] of [
      [undefined, "must be a JSON string"],
      ["", "must be a JSON string"],
      ["{not json", "is not valid JSON"],
      ["[]", "designPlan must be an object"],
    ] as const) {
      const found: string[] = [];
      expect(parseDesignPlanJson(value, found)).toBeNull();
      expect(found.join(" ")).toContain(words);
    }
  });

  it("offers only layouts a design direction allows, and every pairing", () => {
    expect(PLAN_LAYOUT_VALUES.header).toContain("transparent");
    expect(PLAN_LAYOUT_VALUES.card).not.toContain("grocery");
    expect(PLAN_LAYOUT_VALUES.productDetail).not.toContain("grocery");
    const prompt = designPlanPlanningPrompt();
    for (const key of FONT_PAIRING_KEYS) expect(prompt).toContain(key);
    expect(prompt).toContain("designPlanJson");
    expect(prompt).toContain(
      "Never plan to reproduce a reference's logo, brand name, wording or photographs",
    );
    expect(prompt).toContain("measured from each screenshot's pixels");
  });
});

describe("completing a plan", () => {
  const committed = layoutCommitments("luxury-minimal", "new-theme", [])!;

  it("assigns the catalogue's least-used layout to a theme with no screenshots, whatever the model wrote", () => {
    const done = completeDesignPlan(plan({ layout }), committed, false);
    expect(done.layout).toEqual(committed);
    expect(done.layoutSource).toBe("catalogue");
    // A direction with no signature commits nothing.
    const none = completeDesignPlan(plan({ layout }), null, false);
    expect(none.layout).toBeNull();
    expect(none.layoutSource).toBe("none");
  });

  it("keeps the layout read from screenshots", () => {
    const done = completeDesignPlan(plan({ layout }), committed, true);
    expect(done.layout).toEqual(layout);
    expect(done.layoutSource).toBe("reference");
    expect(completeDesignPlan(plan(), committed, true).layoutSource).toBe(
      "none",
    );
  });
});

describe("★★ a plan's alikeness to the published catalogue", () => {
  const fonts = pairingFonts("editorial-fraunces");
  /** A published theme that shares everything the plan decides. */
  const twin = (over: Record<string, unknown> = {}): ExistingThemeFingerprint =>
    ({
      themeId: "twin",
      direction: null,
      published: true,
      name: "Twin",
      fingerprint: {
        ...themeFingerprint(studio),
        composition: "centered/editorial/classic/minimal/classic",
        card: "framed",
        pageColour: colourBand("#fbfaf7"),
        accentHue: colourBand("#2f5d50"),
        bodyFont: fonts.body,
        displayFont: fonts.display,
        buttons: "pill/outline/text",
        width: "narrow",
        ...over,
      },
    }) as ExistingThemeFingerprint;
  const planned = plan({ layout });

  it("is the weighted share of what the plan decides that differs", () => {
    expect(planDistance(planned, twin().fingerprint)).toBe(0);
    // The card is 10 of the 58 the plan decides.
    expect(planDistance(planned, twin({ card: "overlay" }).fingerprint)).toBe(
      0.172,
    );
    // Any one of header, product page or footer changes the layout axis.
    expect(
      planDistance(
        planned,
        twin({ composition: "centered/editorial/classic/rich/classic" })
          .fingerprint,
      ),
    ).toBe(0.172);
    // The cart is not something the plan decides.
    expect(
      planDistance(
        planned,
        twin({ composition: "centered/editorial/compact/minimal/classic" })
          .fingerprint,
      ),
    ).toBe(0);
    // With no layout, only colours, fonts and buttons are compared (34).
    expect(planDistance(plan(), twin({ card: "overlay" }).fingerprint)).toBe(0);
    expect(
      planDistance(plan(), twin({ pageColour: "near-black" }).fingerprint),
    ).toBe(0.353);
  });

  it("is measured against published themes only, and names the nearest", () => {
    const draft = { ...twin(), themeId: "draft", published: undefined };
    expect(planAlikeness(planned, [draft])).toBeNull();
    const nearest = planAlikeness(planned, [
      draft,
      twin({ card: "overlay", width: "full" }),
      {
        ...twin({ pageColour: "near-black" }),
        themeId: "other",
        name: "Other",
      },
    ])!;
    expect(nearest).toMatchObject({ themeId: "other", name: "Other" });
    expect(nearest.score).toBe(0.207);
    expect(nearest.shared).toContain("the product card");
    expect(nearest.shared).not.toContain("the page colour");
  });

  it("sends a plan too close to a published theme back, naming it and what they share", () => {
    const [issue] = designPlanIssues(planned, "light", [twin()], false);
    expect(issue).toContain('too close to "Twin"');
    expect(issue).toContain("the header, product page and footer layouts");
    expect(issue).toContain("the heading font");
    expect(issue).toContain("or another design direction");
    expect(issue).not.toContain("reference screenshots");
    // A theme built from screenshots is told what to keep.
    expect(designPlanIssues(planned, "light", [twin()], true)[0]).toContain(
      "Keep what the reference screenshots show most clearly",
    );
    // Half of what it decides differs: clear.
    const apart = twin({
      composition: "market/classic/classic/rich/classic",
      card: "overlay",
      pageColour: "near-black",
    });
    expect(planDistance(planned, apart.fingerprint)).toBeGreaterThanOrEqual(
      PLAN_DISTINCTNESS_FLOOR,
    );
    expect(designPlanIssues(planned, "light", [apart], false)).toEqual([]);
    // And an unpublished look-alike is nobody's business at this stage.
    expect(
      designPlanIssues(
        planned,
        "light",
        [{ ...twin(), published: undefined }],
        false,
      ),
    ).toEqual([]);
  });

  it("holds the page colour to the palette family", () => {
    const issues = designPlanIssues(planned, "dark", [], false);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Design plan colours.page:");
    expect(issues[0]).toContain("dark page background");
  });

  it("a frozen catalogue context keeps which themes are published, and their names", () => {
    const stored = readVarietyContext([
      { ...twin(), name: `Twin${String.fromCharCode(7)} Theme` },
      { ...twin(), themeId: "draft", published: undefined, name: "Draft" },
      // Written before the flag existed.
      { themeId: "old", direction: null, fingerprint: twin().fingerprint },
    ])!;
    expect(stored[0]).toMatchObject({ published: true, name: "Twin Theme" });
    // A name is kept only for a published theme.
    expect(stored[1]).not.toHaveProperty("published");
    expect(stored[1]).not.toHaveProperty("name");
    expect(stored[2]).not.toHaveProperty("published");
    expect(readVarietyContext([{ ...twin(), published: "yes" }])).toBeNull();
    expect(
      readVarietyContext([{ ...twin(), name: "x".repeat(121) }]),
    ).toBeNull();
  });
});

describe("holding the build to the plan", () => {
  const pkg = themeDefinitionToPackageV2(studio);
  const design = studio.preset.design;
  const own: DesignPlan = {
    version: 1,
    colours: {
      page: design.palette.cream,
      surface: design.palette.surface,
      ink: design.palette.ink,
      accent: design.palette.accent ?? design.palette.ink,
    },
    fontPairing: FONT_PAIRING_KEYS.find((key) => {
      const pair = pairingFonts(key);
      return (
        pair.body === design.fonts.body && pair.display === design.fonts.display
      );
    })!,
    buttons: {
      shape: design.buttons?.shape ?? "rounded",
      primary: design.buttons?.primary ?? "solid",
    },
    layout: {
      header: (design.layout?.header ?? "classic") as never,
      card: (design.layout?.card ?? "classic") as never,
      productDetail: (design.layout?.productDetail ?? "classic") as never,
      footer: (design.layout?.footer ?? "rich") as never,
      pageWidth: (design.page?.width ?? "standard") as never,
      gridColumnsDesktop: (design.layout?.gridColumnsDesktop ?? 4) as never,
      cardHoverImage: design.layout?.cardHoverImage === true,
    },
    layoutSource: "catalogue",
    styling: ["Names in the body face.", "Prices in the text colour."],
    setsApart: ["Its own."],
  };

  it("finds nothing in a theme built to its plan", () => {
    expect(own.fontPairing).toBeTruthy();
    expect(designPlanDepartures(pkg, own)).toEqual([]);
  });

  it("names every departure: layout, colour family, fonts and buttons", () => {
    const other = FONT_PAIRING_KEYS.find((key) => key !== own.fontPairing)!;
    const issues = designPlanDepartures(pkg, {
      ...own,
      colours: { ...own.colours, page: "#101114", accent: "#d81b60" },
      fontPairing: other,
      buttons: {
        shape: own.buttons.shape === "pill" ? "square" : "pill",
        primary: own.buttons.primary === "solid" ? "outline" : "solid",
      },
      layout: {
        ...own.layout!,
        pageWidth: own.layout!.pageWidth === "full" ? "narrow" : "full",
      },
    }).join("\n");
    expect(issues).toContain("Design plan: design.page.width is");
    expect(issues).not.toContain("Layout commitment:");
    expect(issues).toContain("design.palette.cream is " + design.palette.cream);
    expect(issues).toContain(
      "in another colour family than the planned #101114",
    );
    expect(issues).toContain(`Set fontPairing to "${other}"`);
    expect(issues).toContain("design.buttons.shape is");
    expect(issues).toContain("design.buttons.primary is");
  });

  it("★ lets a shade move, never a colour family", () => {
    // The same band as the theme's own page colour, another hex.
    const nudged = design.palette.cream.replace(/.$/, (c) =>
      c === "0" ? "1" : "0",
    );
    expect(colourBand(nudged)).toBe(colourBand(design.palette.cream));
    expect(
      designPlanDepartures(pkg, {
        ...own,
        colours: { ...own.colours, page: nudged },
      }),
    ).toEqual([]);
  });

  it("hands the build stage the plan as values to write", () => {
    const prompt = designPlanBuildPrompt(own);
    expect(prompt).toContain(`design.palette.cream = ${own.colours.page}`);
    expect(prompt).toContain(`fontPairing = "${own.fontPairing}"`);
    expect(prompt).toContain(
      `design.layout.header = ${JSON.stringify(own.layout!.header)}`,
    );
    expect(prompt).toContain("the layout the catalogue uses least");
    expect(prompt).toContain(
      "Names in the body face. | Prices in the text colour.",
    );
    expect(
      designPlanBuildPrompt({ ...own, layoutSource: "reference" }),
    ).toContain("read from the reference screenshots");
    expect(
      designPlanBuildPrompt({ ...own, layout: null, layoutSource: "none" }),
    ).not.toContain("design.layout.header");
  });
});
