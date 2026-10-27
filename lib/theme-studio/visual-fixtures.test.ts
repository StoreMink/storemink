import { describe, expect, it } from "vitest";
import { THEME_DEFINITIONS } from "@/lib/themes";
import {
  REJECTION_CONDITIONS,
  SCORECARD_DIMENSIONS,
  type RejectionCondition,
} from "./scorecard";
import type { VisualQaReport } from "./visual-qa-request";
import {
  VISUAL_FIXTURES,
  VISUAL_FIXTURE_BAR,
  fixtureBenchmarkSummary,
  fixtureCaught,
  fixtureDocument,
  placeholderImage,
  subjectImage,
  type FixtureResult,
} from "./visual-fixtures";

const theme = THEME_DEFINITIONS[0];
const count = (html: string, needle: string) => html.split(needle).length - 1;

/** A parsed review: a clean pass unless told otherwise. */
function review(input: {
  verdict?: "pass" | "revise";
  scores?: Partial<VisualQaReport["scores"]>;
  rejections?: VisualQaReport["rejections"];
}): VisualQaReport {
  const scores = Object.fromEntries(
    SCORECARD_DIMENSIONS.map((d) => [d.key, 5]),
  ) as VisualQaReport["scores"];
  return {
    verdict:
      input.verdict ??
      (input.rejections?.length || input.scores ? "revise" : "pass"),
    scores: { ...scores, ...input.scores },
    rejections: input.rejections ?? [],
    findings: [],
    revisionBrief: null,
    repairs: [],
    imageAssessments: [],
  };
}

function result(id: string): FixtureResult {
  const fixture = VISUAL_FIXTURES.find((f) => f.id === id)!;
  return {
    id,
    expected: fixture.expected,
    finding: fixture.finding,
    report: null,
  };
}

/** What a perfect reviewer answers on each page. */
function answer(fixture: (typeof VISUAL_FIXTURES)[number]): FixtureResult {
  return {
    ...result(fixture.id),
    report:
      fixture.expected === "clean"
        ? review({})
        : fixture.expected === "warning"
          ? review({ verdict: "revise", scores: { detailQuality: 3 } })
          : review({ rejections: [fixture.finding!] }),
  };
}

describe("visual reviewer fixtures", () => {
  it("is eight serious pages, two warning pages and ten clean pages with unique ids", () => {
    expect(VISUAL_FIXTURES).toHaveLength(20);
    const of = (expected: string) =>
      VISUAL_FIXTURES.filter((f) => f.expected === expected).map((f) => f.id);
    expect(of("serious")).toHaveLength(8);
    expect(of("warning")).toEqual([
      "defect-duplicate-newsletter",
      "defect-off-brief-palette",
    ]);
    expect(of("clean")).toHaveLength(10);
    expect(new Set(VISUAL_FIXTURES.map((f) => f.id)).size).toBe(20);
    for (const fixture of VISUAL_FIXTURES) {
      expect(fixture.defect === null).toBe(fixture.expected === "clean");
      expect(fixture.finding !== null).toBe(fixture.expected === "serious");
    }
  });

  it("names the serious finding each serious page must produce (TS-1B)", () => {
    expect(
      Object.fromEntries(
        VISUAL_FIXTURES.filter((f) => f.expected === "serious").map((f) => [
          f.id,
          f.finding,
        ]),
      ),
    ).toEqual({
      "defect-placeholder-copy": "placeholder_copy",
      "defect-invented-claims": "unsupported_claim",
      "defect-placeholder-art": "unfinished_surface",
      "defect-empty-sections": "unfinished_surface",
      "defect-hero-contrast": "inaccessible_copy",
      "defect-overlapping-copy": "inaccessible_copy",
      "defect-illegible-text": "inaccessible_copy",
      "defect-clipped-copy": "inaccessible_copy",
    });
    const serious = new Set<RejectionCondition>(
      REJECTION_CONDITIONS.filter((c) => c.serious).map((c) => c.key),
    );
    for (const fixture of VISUAL_FIXTURES)
      if (fixture.finding) expect(serious.has(fixture.finding)).toBe(true);
  });

  it("every clean page is a whole homepage with one signup form and no scaffolding", () => {
    const clean = VISUAL_FIXTURES.filter((f) => f.expected === "clean");
    // The clean pages the 90% bar counts (9 of 10): never vacuous.
    expect(clean).toHaveLength(10);
    for (const fixture of clean) {
      const html = fixture.render(theme);
      expect(
        count(html, '<section class="home-section'),
      ).toBeGreaterThanOrEqual(5);
      expect(count(html, "home-newsletter-form")).toBe(1);
      expect(html.toLowerCase()).not.toContain("lorem");
      expect(html).not.toMatch(/award|as seen in|rated \d/i);
      expect(count(html, 'class="shop-card"')).toBeGreaterThan(0);
    }
  });

  it("each defect page carries exactly the fault it is named for", () => {
    const by = Object.fromEntries(
      VISUAL_FIXTURES.map((f) => [f.id, f.render(theme)]),
    );
    expect(
      count(by["defect-duplicate-newsletter"], "home-newsletter-form"),
    ).toBe(2);
    expect(by["defect-placeholder-copy"]).toContain("Lorem ipsum");
    expect(by["defect-placeholder-copy"]).toContain("Product name here");
    expect(by["defect-invented-claims"]).toContain("Award-winning");
    expect(by["defect-invented-claims"]).toContain("Rated 4.9/5");
    expect(by["defect-hero-contrast"]).toContain("theme-light");
    expect(by["defect-hero-contrast"]).toContain("background:#f5d061");
    // Images are base64 data URIs, so compare the deterministic URIs.
    expect(by["defect-placeholder-art"]).toContain(placeholderImage(600, 800));
    expect(by["defect-placeholder-art"]).not.toContain(
      subjectImage(600, 800, 0),
    );
    expect(by["defect-empty-sections"]).toContain(
      'home-product-scroll"></div>',
    );
    expect(by["defect-overlapping-copy"]).toContain("top:64px");
    expect(by["defect-illegible-text"]).toContain("font-size:9px");
    expect(by["defect-off-brief-palette"]).toContain("--sm-cream:#39ff14");
    expect(by["defect-clipped-copy"]).toContain("white-space:nowrap");
    // and the clean baseline shares none of them
    const clean = by["clean-baseline"];
    for (const marker of [
      "Lorem",
      "Award",
      "#f5d061",
      "top:64px",
      "font-size:9px",
      "#39ff14",
      "white-space:nowrap",
    ]) {
      expect(clean).not.toContain(marker);
    }
    expect(clean).toContain(subjectImage(600, 800, 0));
    expect(clean).not.toContain(placeholderImage(600, 800));
  });

  it("the document carries the theme's own tokens, the root classes and the closing-newsletter mark", () => {
    const baseline = VISUAL_FIXTURES.find((f) => f.id === "clean-baseline")!;
    const html = fixtureDocument(baseline, theme, "/* css */");
    expect(html).toContain(
      'class="storefront-root sm-themed-type sm-page-width sm-card-classic"',
    );
    expect(html).toContain("--sm-cream:");
    expect(html).toContain('data-sm="footer-newsletter"');
    expect(html).toContain(
      '<div class="home-sections" data-sm-closing="newsletter">',
    );
    const promo = VISUAL_FIXTURES.find((f) => f.id === "clean-promo")!;
    expect(fixtureDocument(promo, theme, "")).toContain(
      '<div class="home-sections">',
    );
  });

  it("grades findings, not the verdict: a serious page needs its named serious finding", () => {
    const placeholder = result("defect-placeholder-copy");
    // A "revise" with only lower scores no longer counts as a catch.
    expect(
      fixtureCaught({
        ...placeholder,
        report: review({ verdict: "revise", scores: { detailQuality: 3 } }),
      }),
    ).toBe(false);
    // Another serious finding is not the one this page names.
    expect(
      fixtureCaught({
        ...placeholder,
        report: review({ rejections: ["unfinished_surface"] }),
      }),
    ).toBe(false);
    expect(
      fixtureCaught({
        ...placeholder,
        report: review({ rejections: ["placeholder_copy"] }),
      }),
    ).toBe(true);
    // Copy the reviewer could not read, scored down instead of named, is a miss.
    expect(
      fixtureCaught({
        ...result("defect-illegible-text"),
        report: review({ scores: { typography: 3, detailQuality: 3 } }),
      }),
    ).toBe(false);
  });

  it("a warning page needs at least a warning; a clean page fails only on a serious finding", () => {
    const newsletter = result("defect-duplicate-newsletter");
    expect(fixtureCaught({ ...newsletter, report: review({}) })).toBe(false);
    expect(
      fixtureCaught({
        ...newsletter,
        report: review({ verdict: "revise", scores: { detailQuality: 3 } }),
      }),
    ).toBe(true);
    expect(
      fixtureCaught({
        ...newsletter,
        report: review({ rejections: ["inaccessible_copy"] }),
      }),
    ).toBe(true);
    const clean = result("clean-baseline");
    expect(
      fixtureCaught({
        ...clean,
        report: review({ verdict: "revise", scores: { artDirection: 3 } }),
      }),
    ).toBe(true);
    expect(
      fixtureCaught({
        ...clean,
        report: review({ scores: { commerceClarity: 2 } }),
      }),
    ).toBe(false);
    expect(fixtureCaught({ ...clean, report: null })).toBe(false);
  });

  it("the bar: all eight serious pages, both warning pages, nine of ten clean pages; an unanswered page is a miss", () => {
    const perfect = VISUAL_FIXTURES.map(answer);
    const all = fixtureBenchmarkSummary(perfect);
    expect(all).toMatchObject({
      ok: true,
      serious: { total: 8, caught: 8, missed: [] },
      warnings: { total: 2, caught: 2, missed: [] },
      clean: { total: 10, passed: 10, falseFails: [] },
      unanswered: [],
    });
    const swap = (id: string, report: VisualQaReport | null) =>
      perfect.map((r) => (r.id === id ? { ...r, report } : r));
    // One serious page without its finding: 7 of 8 is under 90%.
    const oneSerious = fixtureBenchmarkSummary(
      swap("defect-clipped-copy", review({ scores: { detailQuality: 3 } })),
    );
    expect(oneSerious.catchRate).toBe(7 / 8);
    expect(oneSerious.serious.missed).toEqual(["defect-clipped-copy"]);
    expect(oneSerious.ok).toBe(false);
    // One quiet warning page fails the set.
    const oneWarning = fixtureBenchmarkSummary(
      swap("defect-off-brief-palette", review({})),
    );
    expect(oneWarning.warningRate).toBe(0.5);
    expect(oneWarning.ok).toBe(false);
    // One clean page blocked is still 90%; two is not.
    const blocked = review({ rejections: ["inaccessible_copy"] });
    const oneClean = fixtureBenchmarkSummary(swap("clean-promo", blocked));
    expect(oneClean.passRate).toBe(VISUAL_FIXTURE_BAR);
    expect(oneClean.ok).toBe(true);
    const twoClean = fixtureBenchmarkSummary(
      swap("clean-promo", blocked).map((r) =>
        r.id === "clean-compact" ? { ...r, report: null } : r,
      ),
    );
    expect(twoClean.ok).toBe(false);
    expect(twoClean.clean.falseFails).toEqual(["clean-promo", "clean-compact"]);
    expect(twoClean.unanswered).toEqual(["clean-compact"]);
    // Taste on a clean page is not a false block.
    expect(
      fixtureBenchmarkSummary(
        swap(
          "clean-baseline",
          review({ verdict: "revise", scores: { imagery: 3 } }),
        ),
      ).ok,
    ).toBe(true);
    expect(fixtureBenchmarkSummary([]).ok).toBe(false);
  });
});
