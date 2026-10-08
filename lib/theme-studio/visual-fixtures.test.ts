import { describe, expect, it } from "vitest";
import { THEME_DEFINITIONS } from "@/lib/themes";
import {
  VISUAL_FIXTURES,
  VISUAL_FIXTURE_BAR,
  fixtureBenchmarkSummary,
  fixtureDocument,
  placeholderImage,
  subjectImage,
} from "./visual-fixtures";

const theme = THEME_DEFINITIONS[0];
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("visual reviewer fixtures", () => {
  it("is ten known-defect pages and ten clean pages with unique ids", () => {
    expect(VISUAL_FIXTURES).toHaveLength(20);
    expect(VISUAL_FIXTURES.filter((f) => f.expected === "revise")).toHaveLength(
      10,
    );
    expect(VISUAL_FIXTURES.filter((f) => f.expected === "pass")).toHaveLength(
      10,
    );
    expect(new Set(VISUAL_FIXTURES.map((f) => f.id)).size).toBe(20);
    for (const fixture of VISUAL_FIXTURES) {
      expect(fixture.defect === null).toBe(fixture.expected === "pass");
    }
  });

  it("every clean page is a whole homepage with one signup form and no scaffolding", () => {
    for (const fixture of VISUAL_FIXTURES.filter(
      (f) => f.expected === "pass",
    )) {
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

  it("the bar is nine of ten in both directions, and an unanswered fixture is a miss", () => {
    const perfect = VISUAL_FIXTURES.map((f) => ({
      id: f.id,
      expected: f.expected,
      verdict: f.expected,
    }));
    expect(fixtureBenchmarkSummary(perfect).ok).toBe(true);
    const oneMiss = perfect.map((r, i) =>
      i === 10 ? { ...r, verdict: "pass" as const } : r,
    );
    const one = fixtureBenchmarkSummary(oneMiss);
    expect(one.catchRate).toBe(VISUAL_FIXTURE_BAR);
    expect(one.ok).toBe(true);
    const twoMisses = oneMiss.map((r, i) =>
      i === 11 ? { ...r, verdict: null } : r,
    );
    const two = fixtureBenchmarkSummary(twoMisses);
    expect(two.ok).toBe(false);
    expect(two.defects.missed).toHaveLength(2);
    expect(two.unanswered).toEqual([twoMisses[11].id]);
    const falseFails = perfect.map((r, i) =>
      i < 2 ? { ...r, verdict: "revise" as const } : r,
    );
    expect(fixtureBenchmarkSummary(falseFails).ok).toBe(false);
    expect(fixtureBenchmarkSummary([]).ok).toBe(false);
  });
});
