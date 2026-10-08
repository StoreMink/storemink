import { describe, expect, it } from "vitest";
import { THEME_DEFINITIONS } from "@/lib/themes";
import type { ThemePackageV2 } from "./contracts";
import { unsupportedClaimIssues } from "./claims";

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

  it("a revision's evidence includes the base copy, so an old claim is not re-flagged", () => {
    const pkg = pkgWith((def) => setHeading(def, "Dermatologist-tested daily"));
    const baseCopy = "Dermatologist-tested daily";
    expect(unsupportedClaimIssues(pkg, `make it bluer\n${baseCopy}`)).toEqual(
      [],
    );
  });
});
