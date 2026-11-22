import { describe, expect, it } from "vitest";
import { THEME_DEFINITIONS } from "@/lib/themes";
import { EXEMPLAR_THEMES } from "@/lib/themes/exemplars";
import { defaultTemplates } from "@/lib/themes/templates";
import type { ThemePackageV2 } from "./contracts";
import { customerCopy, unsupportedClaimIssues } from "./claims";

// A package is only read for its definition here; the rest is irrelevant.
function pkgWith(mutate: (def: ThemePackageV2["definition"]) => void) {
  const definition = structuredClone(THEME_DEFINITIONS[0]);
  mutate(definition);
  return { definition } as unknown as ThemePackageV2;
}

function setHeading(def: ThemePackageV2["definition"], heading: string) {
  const home = def.preset.pages.find((p) => p.slug === "")!;
  const first = home.sections.find((s) => s.enabled)!;
  (first.config as unknown as Record<string, unknown>).heading = heading;
}

describe("unsupported claims", () => {
  it("a bundled theme makes no unsupported claim against an empty brief", () => {
    for (const theme of THEME_DEFINITIONS) {
      expect(
        unsupportedClaimIssues(
          { definition: theme } as unknown as ThemePackageV2,
          "",
        ),
      ).toEqual([]);
    }
  });

  it("an award the brief never mentioned is reported once, with an excerpt", () => {
    const pkg = pkgWith((def) => {
      setHeading(def, "Award-winning serums for every skin");
      def.preset.brand.tagline = "Our award-winning formulas";
    });
    const issues = unsupportedClaimIssues(
      pkg,
      "A calm botanical skincare store.",
    );
    expect(issues).toHaveLength(2);
    expect(issues.every((m) => m.includes("an award"))).toBe(true);
    expect(issues.some((m) => m.includes("Award-winning serums"))).toBe(true);
  });

  it('★ "organic" is a claim by itself, as the first live review found, unless the brief says so', () => {
    const pkg = pkgWith((def) =>
      setHeading(def, "Only the good stuff. Organic beans, craft roasted."),
    );
    const issues = unsupportedClaimIssues(pkg, "A bold coffee brand.");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("an organic claim");
    expect(
      unsupportedClaimIssues(pkg, "We sell organic, shade-grown coffee."),
    ).toEqual([]);
  });

  it("★ the organic rule can be left out, for a run on a prompt version older than the one that states it; every other rule still applies", () => {
    const pkg = pkgWith((def) =>
      setHeading(def, "Organic beans, craft roasted. Est. 2021"),
    );
    const brief = "A bold coffee brand.";
    expect(unsupportedClaimIssues(pkg, brief).join(" ")).toContain(
      "an organic claim",
    );
    const older = unsupportedClaimIssues(pkg, brief, { organic: false });
    expect(older.join(" ")).not.toContain("an organic claim");
    expect(older.join(" ")).toContain("a founding year");
  });

  it("the same claim passes when the brief supports it", () => {
    const pkg = pkgWith((def) =>
      setHeading(def, "Award-winning serums for every skin"),
    );
    expect(
      unsupportedClaimIssues(pkg, "We won the 2025 Beauty Insider award."),
    ).toEqual([]);
  });

  it("numeric claims need their numbers in the brief, not just the topic", () => {
    const pkg = pkgWith((def) =>
      setHeading(def, "Trusted by 40,000 customers since 1998"),
    );
    expect(
      unsupportedClaimIssues(pkg, "Family business, many customers."),
    ).toEqual([
      expect.stringContaining("a customer count"),
      expect.stringContaining("a founding year"),
    ]);
    expect(
      unsupportedClaimIssues(pkg, "Founded 1998; 40000+ customers served."),
    ).toEqual([]);
  });

  it("press, #1, certification and clinical claims are each caught", () => {
    const pkg = pkgWith((def) => {
      setHeading(
        def,
        "As seen in Vogue. #1 in India. Certified organic. Clinically proven.",
      );
    });
    const labels = unsupportedClaimIssues(pkg, "Organic skincare.").map(
      (m) => /claims ([^(]+) \(/.exec(m)?.[1],
    );
    expect(labels).toEqual([
      "press coverage",
      "a #1 ranking",
      "clinical testing",
      "a certification",
    ]);
  });

  it("reads the page templates and the announcement bar as copy too", () => {
    for (const theme of EXEMPLAR_THEMES)
      expect(
        unsupportedClaimIssues(
          { definition: theme } as unknown as ThemePackageV2,
          "",
        ),
        theme.id,
      ).toEqual([]);
    const pkg = pkgWith((def) => {
      const templates = defaultTemplates(def.preset.design.layout);
      templates.product.blocks.push({
        type: "trust_row",
        items: [{ icon: "star", label: "As seen in Vogue" }],
      });
      templates.collection.promoTiles.push({
        afterIndex: 4,
        heading: "Voted the best mugs",
        body: "",
        cta_label: "",
        href: "/shop",
        image_url: "",
        image_alt: "",
        theme: "dark",
        background: "",
      });
      def.preset.templates = templates;
      def.preset.announcement = { text: "Award-winning since 1998" };
    });
    const labels = unsupportedClaimIssues(pkg, "A calm ceramics shop.").map(
      (m) => /claims ([^(]+) \(/.exec(m)?.[1],
    );
    expect(labels).toEqual([
      "press coverage",
      "a vote or poll result",
      "an award",
      "a founding year",
    ]);
    // A revision that keeps them has them as evidence, like any base copy.
    expect(unsupportedClaimIssues(pkg, customerCopy(pkg).join("\n"))).toEqual(
      [],
    );
  });

  it("a revision's evidence includes the base copy, so an old claim is not re-flagged", () => {
    const pkg = pkgWith((def) => setHeading(def, "Dermatologist-tested daily"));
    const baseCopy = "Dermatologist-tested daily";
    expect(unsupportedClaimIssues(pkg, `make it bluer\n${baseCopy}`)).toEqual(
      [],
    );
  });
});
