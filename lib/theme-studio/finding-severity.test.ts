import { describe, expect, it } from "vitest";
import { GATE_LABELS, type GateId } from "./acceptance-gates";
import {
  CLIPPED_TEXT_WARNING_PX,
  CONTRAST_AA_LINE,
  SEVERITY_RULES_VERSION,
  findingSeverity,
  isPlatformFinding,
  isSeriousFinding,
  isSharedSelector,
  stricterSeverity,
  type SeverityFinding,
} from "./finding-severity";

const severity = (gateId: string, code: string, extra = {}) =>
  findingSeverity(gateId, { code, ...extra });

// Real selectors from the 4 Oct benchmark (evals/theme-studio/full-live-2026-10-04.json).
const DELIVERY_TRIGGER =
  '.delivery-location-module__HXOnpW__trigger[type="button"][aria-haspopup="dialog"] > .delivery-location-module__HXOnpW__triggerCopy > small';
const CARD_DISCOUNT =
  ".shop-card:nth-child(2) > .shop-card-body > .shop-card-price > .shop-card-deal > .shop-card-off";

describe("severity rules version", () => {
  it("is severity-v1", () => {
    expect(SEVERITY_RULES_VERSION).toBe("severity-v1");
  });
});

/**
 * Section 3 of the plan (revamp-handoff/tasks/theme-studio-plan.md, "What
 * blocks, what warns, what is automatic"), one row at a time, for every row
 * that names a check or a finding code. Rows that name only design-review
 * codes are classified by the review's caller (visual-qa.ts) and reach the
 * policy as a review outcome (automatic-qa-policy.test.ts).
 */
describe("section 3, row by row", () => {
  const rows: {
    row: string;
    serious: [string, string, object?][];
    minor?: [string, string, object?][];
  }[] = [
    {
      row: "Security (package.security; routes.markup external_resource): blocks, no override",
      serious: [
        ["package.security", "markup"],
        ["package.security", "handler"],
        ["package.security", "scheme"],
        ["package.security", "external_asset"],
        ["package.security", "external_link"],
        ["package.security", "css"],
        ["package.security", "custom_code"],
        ["package.security", "capability"],
        ["routes.markup", "external_resource"],
      ],
    },
    {
      row: "Theme file (package.schema): blocks",
      serious: [["package.schema", "contract"]],
    },
    {
      row: "Pages open (routes.render status, unthemed, fetch, token; demo.materialize): blocks",
      serious: [
        ["routes.render", "status"],
        ["routes.render", "unthemed"],
        ["routes.render", "fetch"],
        ["routes.render", "token"],
        ["demo.materialize", "materialize"],
        ["demo.materialize", "skipped"],
      ],
    },
    {
      row: "Links (routes.links): blocks after the repair rounds",
      serious: [
        ["routes.links", "broken"],
        ["routes.links", "fetch"],
        ["package.content", "links.page"],
        ["package.content", "links.product"],
      ],
    },
    {
      row: "Readable text (axe colour contrast; package.design contrast): blocks whatever the cause",
      serious: [
        ["package.design", "design.contrast"],
        ["package.design", "design.hero_contrast"],
        ["package.design", "design.button_label_contrast"],
        [
          "browser.accessibility",
          "color-contrast",
          {
            impact: "serious",
            contrast: [{ target: "h1", ratio: 4.39, required: 4.5 }],
          },
        ],
        ["browser.accessibility", "color-contrast", { impact: "serious" }],
      ],
    },
    {
      row: "Cut-off text (browser.clipped_text): part of a word blocks, a pixel or two warns",
      serious: [
        ["browser.clipped_text", "clipped_text", { clipped: { x: 12, y: 0 } }],
      ],
      minor: [
        ["browser.clipped_text", "clipped_text", { clipped: { x: 2, y: 0 } }],
      ],
    },
    {
      row: "Fits the screen (browser.overflow): blocks after repairs",
      serious: [["browser.overflow", "horizontal_overflow"]],
    },
    {
      row: "Pictures (browser.media; assets.integrity missing, digest, purpose, format, too small; artwork placeholders): blocks; the size code split",
      serious: [
        ["browser.media", "broken_image"],
        ["assets.integrity", "missing"],
        ["assets.integrity", "digest"],
        ["assets.integrity", "purpose"],
        ["assets.integrity", "format"],
        ["assets.integrity", "dimensions"],
        ["assets.integrity", "wrong_format"],
        ["assets.integrity", "too_small"],
        ["assets.integrity", "preview_too_small"],
        ["assets.integrity", "preview_shape"],
        ["assets.integrity", "size"],
        ["assets.provenance", "placeholder"],
        ["assets.provenance", "source"],
      ],
      minor: [
        ["assets.integrity", "over_budget"],
        ["assets.integrity", "preview_over_budget"],
      ],
    },
    {
      row: "A photo smaller than its slot (section 7): a warning above the minimum width",
      serious: [["assets.integrity", "too_small"]],
      minor: [["assets.integrity", "below_target"]],
    },
    {
      row: "Placeholder words and invented claims (validateThemeCopy): blocks after repairs",
      serious: [
        ["package.content", "pages.placeholder"],
        ["package.content", "pages.duplicate_newsletter"],
        ["package.content", "catalog.name_placeholder"],
      ],
    },
    {
      row: "Menus, search, cart, account and sign-in that do not open or close (browser.coverage state_unopened, state_stuck): blocks",
      serious: [
        ["browser.coverage", "state_unopened"],
        ["browser.coverage", "state_stuck"],
      ],
    },
    {
      row: "Could every page be checked (browser.coverage: skipped, missing, budget, timeout, token, unmeasured): never a pass",
      serious: [
        ["browser.coverage", "skipped"],
        ["browser.coverage", "missing"],
        ["browser.coverage", "viewport"],
        ["browser.coverage", "states_missing"],
        ["browser.coverage", "state_missing"],
        ["browser.coverage", "budget"],
        ["browser.coverage", "timeout"],
        ["browser.coverage", "token"],
        ["browser.coverage", "unmeasured"],
        ["routes.render", "budget"],
        ["routes.render", "timeout"],
        ["routes.links", "budget"],
        ["routes.links", "timeout"],
        ["browser.performance", "unmeasured"],
      ],
    },
    {
      row: "Missing feature (blocking capability gap): blocks",
      serious: [["package.content", "capability_gap"]],
    },
    {
      row: "Other accessibility findings (browser.accessibility, rules other than contrast): serious or critical blocks, moderate or minor warns",
      serious: [
        ["browser.accessibility", "button-name", { impact: "serious" }],
        [
          "browser.accessibility",
          "aria-required-children",
          { impact: "critical" },
        ],
      ],
      minor: [
        ["browser.accessibility", "region", { impact: "moderate" }],
        ["browser.accessibility", "landmark-unique", { impact: "minor" }],
      ],
    },
    {
      row: "Small tap targets (browser.tap_targets, under 24 px): warning",
      serious: [],
      minor: [["browser.tap_targets", "small_target"]],
    },
    {
      row: "Tight crops (browser.image_crops): warning",
      serious: [],
      minor: [["browser.image_crops", "extreme_crop"]],
    },
    {
      row: "Speed (browser.performance): warning",
      serious: [],
      minor: [
        ["browser.performance", "lcp"],
        ["browser.performance", "cls"],
      ],
    },
    {
      row: "Alt text: automatic; a picture still without one is a defect a shopper meets",
      serious: [["assets.provenance", "alt"]],
    },
    {
      row: "Licence notes: never automatic; an upload without one blocks",
      serious: [["assets.provenance", "license"]],
    },
    {
      row: "Preview noindex, page language, image alt attribute in our markup (routes.render indexable, routes.markup lang and img_alt): warning",
      serious: [],
      minor: [
        ["routes.render", "indexable"],
        ["routes.markup", "lang"],
        ["routes.markup", "img_alt"],
      ],
    },
    {
      row: "Image byte budget, unused files: warning",
      serious: [],
      minor: [
        ["assets.integrity", "over_budget"],
        ["assets.integrity", "unused"],
      ],
    },
  ];

  for (const { row, serious, minor = [] } of rows) {
    it(row, () => {
      for (const [gateId, code, extra] of serious) {
        expect(severity(gateId, code, extra), `${gateId} ${code}`).toBe(
          "serious",
        );
      }
      for (const [gateId, code, extra] of minor) {
        expect(severity(gateId, code, extra), `${gateId} ${code}`).toBe(
          "minor",
        );
      }
    });
  }
});

describe("findingSeverity", () => {
  it("counts every code nobody classified as serious, in every gate", () => {
    for (const gateId of Object.keys(GATE_LABELS) as GateId[]) {
      expect(severity(gateId, "something_new"), gateId).toBe("serious");
    }
    expect(severity("browser.someday", "indexable")).toBe("serious");
    expect(severity("", "")).toBe("serious");
  });

  it("never lets a check that could not run pass, even in a gate that holds warnings", () => {
    for (const gateId of Object.keys(GATE_LABELS)) {
      expect(severity(gateId, "skipped"), gateId).toBe("serious");
      expect(severity(gateId, "unmeasured"), gateId).toBe("serious");
      // Whatever else the finding says about itself.
      for (const extra of [
        { impact: "minor" },
        { impact: "moderate" },
        { clipped: { x: 1, y: 0 } },
        { severity: "minor" },
      ]) {
        expect(severity(gateId, "skipped", extra), gateId).toBe("serious");
        expect(severity(gateId, "unmeasured", extra), gateId).toBe("serious");
      }
    }
  });

  it("holds text to the AA line the browser recorded, one constant (decision 1)", () => {
    expect(CONTRAST_AA_LINE).toEqual({ normalText: 4.5, largeText: 3 });
    const contrast = (ratio: number, required: number, extra = {}) =>
      severity("browser.accessibility", "color-contrast", {
        impact: "serious",
        contrast: [{ target: ".x", ratio, required }],
        ...extra,
      });
    // Normal text below 4.5, large text below 3: serious.
    expect(contrast(4.39, 4.5)).toBe("serious");
    expect(contrast(2.9, 3)).toBe("serious");
    // axe's own test: at the line is not above it.
    expect(contrast(4.5, 4.5)).toBe("serious");
    // Whatever its impact.
    expect(contrast(4.39, 4.5, { impact: "moderate" })).toBe("serious");
    expect(contrast(4.39, 4.5, { impact: null })).toBe("serious");
    // A line stricter than AA (7 to 1) is held at AA only: 5 to 1 clears it,
    // 4.4 to 1 does not.
    expect(contrast(5, 7)).toBe("minor");
    expect(contrast(4.4, 7)).toBe("serious");
    // A line looser than large text's is held at large text's.
    expect(contrast(2.5, 2)).toBe("serious");
    expect(contrast(3.1, 2)).toBe("minor");
    // The legacy code is the same rule.
    expect(
      severity("browser.accessibility", "contrast", {
        contrast: [{ target: ".x", ratio: 5, required: 7 }],
      }),
    ).toBe("minor");
  });

  it("counts a contrast finding whose ratio cannot be read as serious", () => {
    const base = { code: "color-contrast", impact: "serious" as const };
    expect(findingSeverity("browser.accessibility", base)).toBe("serious");
    expect(
      findingSeverity("browser.accessibility", { ...base, contrast: [] }),
    ).toBe("serious");
    expect(
      findingSeverity("browser.accessibility", {
        ...base,
        contrast: [{ target: ".x", ratio: Number.NaN, required: 7 }],
      }),
    ).toBe("serious");
    // Some elements were never measured.
    expect(
      findingSeverity("browser.accessibility", {
        ...base,
        nodes: 3,
        contrast: [{ target: ".x", ratio: 5, required: 7 }],
      }),
    ).toBe("serious");
    expect(
      findingSeverity("browser.accessibility", {
        ...base,
        nodes: 1,
        contrast: [{ target: ".x", ratio: 5, required: 7 }],
      }),
    ).toBe("minor");
  });

  it("judges other axe rules by impact, and an impact axe did not give as serious", () => {
    for (const impact of [
      "serious",
      "critical",
      null,
      undefined,
      "catastrophic",
    ]) {
      expect(
        severity("browser.accessibility", "button-name", { impact }),
        String(impact),
      ).toBe("serious");
    }
    for (const impact of ["moderate", "minor"]) {
      expect(severity("browser.accessibility", "region", { impact })).toBe(
        "minor",
      );
    }
  });

  it("warns on a clip of a pixel or two and blocks one that hides part of a glyph", () => {
    expect(CLIPPED_TEXT_WARNING_PX).toBe(2);
    const clip = (x: number, y: number) =>
      severity("browser.clipped_text", "clipped_text", { clipped: { x, y } });
    expect(clip(2, 0)).toBe("minor");
    expect(clip(0, 2)).toBe("minor");
    expect(clip(2, 2)).toBe("minor");
    expect(clip(3, 0)).toBe("serious");
    expect(clip(0, 3)).toBe("serious");
    expect(clip(1, 40)).toBe("serious");
    // An unmeasured clip is serious.
    expect(severity("browser.clipped_text", "clipped_text")).toBe("serious");
    expect(clip(Number.NaN, 0)).toBe("serious");
    expect(severity("browser.clipped_text", "something_else")).toBe("serious");
  });
});

describe("stored severities", () => {
  it("counts a finding with no recognised severity as serious", () => {
    expect(isSeriousFinding({})).toBe(true);
    expect(isSeriousFinding({ severity: undefined })).toBe(true);
    expect(isSeriousFinding({ severity: "serious" })).toBe(true);
    expect(isSeriousFinding({ severity: "bogus" })).toBe(true);
    expect(isSeriousFinding({ severity: "minor" })).toBe(false);
  });

  it("raises a severity, never lowers one", () => {
    expect(stricterSeverity(undefined, "minor")).toBe("minor");
    expect(stricterSeverity(undefined, "serious")).toBe("serious");
    expect(stricterSeverity("serious", "minor")).toBe("serious");
    expect(stricterSeverity("minor", "serious")).toBe("serious");
    expect(stricterSeverity("minor", "minor")).toBe("minor");
  });
});

describe("platform findings", () => {
  const platform = (gateId: string, finding: SeverityFinding) =>
    isPlatformFinding(gateId, finding);

  it("names StoreMink's own markup and hit areas from a closed list of codes", () => {
    expect(platform("routes.render", { code: "indexable" })).toBe(true);
    expect(platform("routes.markup", { code: "lang" })).toBe(true);
    expect(platform("routes.markup", { code: "img_alt" })).toBe(true);
    expect(platform("browser.tap_targets", { code: "small_target" })).toBe(
      true,
    );
    // Every axe rule but contrast judges markup only the renderer writes.
    expect(
      platform("browser.accessibility", {
        code: "aria-required-children",
        impact: "critical",
      }),
    ).toBe(true);
  });

  it("keeps security-like markup the theme's, though repairs file it as renderer work", () => {
    expect(platform("routes.markup", { code: "external_resource" })).toBe(
      false,
    );
    expect(
      findingSeverity("routes.markup", { code: "external_resource" }),
    ).toBe("serious");
  });

  it("never labels a check that could not finish, so Check again stays on offer", () => {
    for (const code of [
      "missing",
      "states_missing",
      "state_unopened",
      "state_stuck",
      "skipped",
    ]) {
      expect(
        platform("browser.coverage", {
          code,
          where: "phone360 · home · menu drawer",
        }),
        code,
      ).toBe(false);
    }
    expect(platform("routes.render", { code: "timeout" })).toBe(false);
    expect(platform("browser.accessibility", { code: "skipped" })).toBe(false);
  });

  it("labels what was measured inside the shared chrome states", () => {
    expect(
      platform("browser.accessibility", {
        code: "color-contrast",
        where: "phone390 · home · menu drawer",
        contrast: [{ target: "a.anything", ratio: 1.37, required: 4.5 }],
      }),
    ).toBe(true);
    expect(
      platform("browser.clipped_text", {
        code: "clipped_text",
        where: "phone360 · home · sign-in dialog",
      }),
    ).toBe(true);
  });

  it("labels contrast on the 4 Oct shared surfaces, and leaves the theme's own copy to the theme", () => {
    const contrast = (...targets: string[]) =>
      platform("browser.accessibility", {
        code: "color-contrast",
        where: "phone390 · product",
        contrast: targets.map((target) => ({
          target,
          ratio: 2,
          required: 4.5,
        })),
      });
    expect(contrast(".pdp-price-base")).toBe(true);
    expect(contrast(CARD_DISCOUNT)).toBe(true);
    expect(contrast(DELIVERY_TRIGGER)).toBe(true);
    expect(contrast(".pdp-price-base", DELIVERY_TRIGGER)).toBe(true);
    // The hero's copy and the theme's sections are the theme's settings.
    expect(contrast("h1")).toBe(false);
    expect(contrast(".home-hero-sub")).toBe(false);
    expect(
      contrast(
        ".home-usp-item:nth-child(1) > .home-usp-text > .home-usp-title",
      ),
    ).toBe(false);
    // Mixed: the theme can still fix its part.
    expect(contrast(".pdp-price-base", "h1")).toBe(false);
    // No selector at all: the theme's.
    expect(contrast()).toBe(false);
    // The axe examples name the elements when no ratio was recorded.
    expect(
      platform("browser.accessibility", {
        code: "color-contrast",
        targets: [".shop-card-off"],
      }),
    ).toBe(true);
  });

  it("labels overflow and clipped text by the element the browser named", () => {
    expect(
      platform("browser.overflow", {
        code: "horizontal_overflow",
        targets: ["span.sr-only"],
      }),
    ).toBe(true);
    expect(
      platform("browser.overflow", {
        code: "horizontal_overflow",
        targets: ["div.hero"],
      }),
    ).toBe(false);
    expect(
      platform("browser.clipped_text", {
        code: "clipped_text",
        targets: ["span.Header-module__a1B2c3__brandNameText"],
      }),
    ).toBe(true);
    expect(platform("browser.image_crops", { code: "extreme_crop" })).toBe(
      false,
    );
    expect(platform("browser.media", { code: "broken_image" })).toBe(false);
    expect(platform("package.design", { code: "design.contrast" })).toBe(false);
  });

  it("matches shared selectors exactly, never a longer class name", () => {
    expect(isSharedSelector(".shop-card-off")).toBe(true);
    expect(isSharedSelector("a > .shop-card-off:hover")).toBe(true);
    expect(isSharedSelector(".shop-card-offer")).toBe(false);
    expect(isSharedSelector(".pdp-price-base-extra")).toBe(false);
    expect(isSharedSelector("#profile-dropdown > a")).toBe(true);
    expect(isSharedSelector("#profile-dropdowns")).toBe(false);
    expect(isSharedSelector(DELIVERY_TRIGGER)).toBe(true);
    expect(isSharedSelector(".module__x")).toBe(false);
  });

  it("changes the words only: the severity of a platform finding is its rule's", () => {
    const menu = {
      code: "color-contrast",
      where: "phone390 · home · menu drawer",
      contrast: [{ target: ".x", ratio: 1.37, required: 4.5 }],
    };
    expect(isPlatformFinding("browser.accessibility", menu)).toBe(true);
    expect(findingSeverity("browser.accessibility", menu)).toBe("serious");
    expect(isPlatformFinding("routes.render", { code: "indexable" })).toBe(
      true,
    );
    expect(findingSeverity("routes.render", { code: "indexable" })).toBe(
      "minor",
    );
  });
});
