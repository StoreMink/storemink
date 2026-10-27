import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

import { operatorImagePackage, placeholderPackage } from "./_test-helpers";
import { gate, type GateFinding, type GateResult } from "./acceptance-gates";
import { validateThemePackageV2 } from "./contracts";
import { SEVERITY_RULES_VERSION } from "./finding-severity";
import {
  buildPublishedPackage,
  nextReleaseVersion,
  PUBLICATION_WARNING_LOG_KINDS,
  PUBLICATION_WARNING_PLACES,
  publicationBlockers,
  publicationWarningLog,
  publicationWarnings,
  releaseDate,
  validateCatalogChange,
  type PublicationWarning,
} from "./publication-core";
import type { ReviewSeverity } from "./scorecard";
import { jsonbTextBytes } from "@/lib/themes/runtime-registry";

describe("release versions", () => {
  it.each([
    [[], "1.0.0"],
    [["1.0.0"], "1.1.0"],
    [["1.0.0", "1.4.2", "1.10.0"], "1.11.0"],
    [["0.3.0"], "1.0.0"],
    [["2.0.0", "1.9.0", "not-a-version"], "2.1.0"],
  ])("after %j comes %s", (existing, next) => {
    expect(nextReleaseVersion(existing)).toBe(next);
  });
});

describe("the published package", () => {
  const url = (path: string) =>
    `https://storage.googleapis.com/storemink-media/${path}`;

  it("refuses a version that still has placeholders", () => {
    const pkg = placeholderPackage();
    expect(publicationBlockers(pkg).blocking[0]).toMatch(/placeholder/);
    const built = buildPublishedPackage(pkg, {
      version: "1.0.0",
      releasedAt: "2026-09-25",
      sourceVersionNumber: 3,
      publicUrl: url,
    });
    expect(!built.ok && built.error).toMatch(/placeholder/);
  });

  it("points every slot at its immutable object and publishes the release", () => {
    const draft = operatorImagePackage();
    const built = buildPublishedPackage(draft, {
      version: "1.0.0",
      releasedAt: "2026-09-25",
      sourceVersionNumber: 3,
      publicUrl: url,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { pkg, objects } = built.value;
    const id = draft.definition.id;
    expect(objects).toHaveLength(draft.assets.length);
    for (const object of objects) {
      expect(object.objectPath).toBe(
        `theme-releases/${id}/1.0.0/${object.assetId}-${object.sha256.slice(0, 16)}.webp`,
      );
    }
    expect(
      pkg.assets.every((a) => a.path.startsWith(url("theme-releases/"))),
    ).toBe(true);
    expect(JSON.stringify(pkg.definition)).not.toContain("theme-asset://");
    expect(pkg.definition.release).toEqual({
      version: "1.0.0",
      status: "published",
      releasedAt: "2026-09-25",
      notes: ["Published from Theme Studio version 3."],
    });
    expect(pkg.definition.catalog.visibility).toBe("public");
    expect(pkg.definition.demo).toEqual({
      slug: `demo-${id}`,
      status: "healthy",
    });
    // The draft is untouched.
    expect(draft.definition.release.status).not.toBe("published");
  });

  it("refuses a bad version or date", () => {
    const draft = operatorImagePackage();
    const base = {
      releasedAt: "2026-09-25",
      sourceVersionNumber: 1,
      publicUrl: url,
    };
    expect(buildPublishedPackage(draft, { ...base, version: "1.0" }).ok).toBe(
      false,
    );
    expect(
      buildPublishedPackage(draft, {
        ...base,
        version: "1.0.0",
        releasedAt: "25/09/2026",
      }).ok,
    ).toBe(false);
  });
});

describe("published image paths in the contract", () => {
  function published() {
    const built = buildPublishedPackage(operatorImagePackage(), {
      version: "1.0.0",
      releasedAt: "2026-09-25",
      sourceVersionNumber: 1,
      publicUrl: (p) => `https://storage.googleapis.com/bucket-x/${p}`,
    });
    if (!built.ok) throw new Error(built.error);
    return built.value.pkg;
  }

  it("accepts the release's own images", () => {
    expect(validateThemePackageV2(published()).ok).toBe(true);
  });

  it.each([
    [
      "another theme's image",
      (p: string) =>
        p.replace(/\/theme-releases\/[^/]+\//, "/theme-releases/other-theme/"),
    ],
    ["another release's image", (p: string) => p.replace("/1.0.0/", "/2.0.0/")],
    [
      "an image whose digest does not match",
      (p: string) =>
        p.replace(/-[a-f0-9]{16}\.webp$/, "-0000000000000000.webp"),
    ],
    [
      "an arbitrary URL",
      () => "https://evil.example.com/theme-releases/x.webp",
    ],
  ])("refuses %s", (_label, mutate) => {
    const pkg = published();
    const asset = pkg.assets[0];
    const moved = mutate(asset.path);
    const tampered = JSON.parse(
      JSON.stringify(pkg).split(asset.path).join(moved),
    );
    expect(validateThemePackageV2(tampered).ok).toBe(false);
  });
});

describe("catalog changes", () => {
  it("needs no reason: a blank one gets a plain sentence for the audit", () => {
    const hide = validateCatalogChange({ action: "hide" });
    expect(hide).toEqual({
      ok: true,
      value: { action: "hide", reason: "Hidden from new stores." },
    });
    const show = validateCatalogChange({ action: "show", reason: "  " });
    expect(show.ok && show.value.reason).toBe("Shown in the catalog again.");
    const typed = validateCatalogChange({
      action: "hide",
      reason: "Broken PDP",
    });
    expect(typed.ok && typed.value.reason).toBe("Broken PDP");
  });

  it("accepts hide, show and a release selection", () => {
    expect(
      validateCatalogChange({ action: "hide", reason: "Broken PDP" }).ok,
    ).toBe(true);
    expect(
      validateCatalogChange({
        action: "select_release",
        version: "1.0.0",
        reason: "Roll back",
      }),
    ).toEqual({
      ok: true,
      value: {
        action: "select_release",
        version: "1.0.0",
        reason: "Roll back",
      },
    });
    expect(
      validateCatalogChange({ action: "select_release", reason: "x".repeat(4) })
        .ok,
    ).toBe(false);
    expect(validateCatalogChange({ action: "delete", reason: "nope" }).ok).toBe(
      false,
    );
  });
});

describe("release dates", () => {
  it("dates a release in India time", () => {
    // 20:00 UTC on the 24th is 01:30 IST on the 25th.
    expect(releaseDate(new Date("2026-09-24T20:00:00Z"))).toBe("2026-09-25");
  });
});

// "Fix it, then allow Publish": what still refuses Publish is the package
// itself; the check run's and the design review's warnings go live with it.
describe("publication blockers and warnings", () => {
  const tap = (where: string): GateFinding => ({
    code: "small_target",
    message: "A 20x20 tap target.",
    where,
    targets: [".shop-card-base"],
  });
  /** A passed run's gates: one required gate that holds only warnings, the
   * advisory speed gate, and a clean one. */
  const passedWithWarnings = (): GateResult[] => [
    gate("routes.render", []),
    gate("browser.tap_targets", [
      tap("phone390 · home"),
      tap("phone390 · shop"),
      tap("phone390 · home"),
    ]),
    gate("browser.performance", [{ code: "lcp", message: "LCP 4.2 s." }], {
      required: false,
    }),
  ];
  const review: ReviewSeverity = {
    outcome: "taste",
    serious: [],
    warnings: [
      { code: "low_score", row: "artDirection", score: 3 },
      { code: "low_score", row: "distinctness", score: 3 },
      { code: "palette_only" },
      { code: "image_redraw", slotId: "slot-2" },
      { code: "low_total", score: 31 },
    ],
  };

  it("lets only the package refuse, and lists no warnings without evidence", () => {
    expect(publicationBlockers(operatorImagePackage())).toEqual({
      blocking: [],
      warnings: [],
    });
    const refused = publicationBlockers(placeholderPackage(), {
      gates: passedWithWarnings(),
      review,
    });
    expect(refused.blocking).toHaveLength(1);
    expect(refused.blocking[0]).toMatch(/placeholder/);
    // The warnings are still listed: refusing is the package's job alone.
    expect(refused.warnings.length).toBeGreaterThan(0);
  });

  it("never turns a warning into a blocker: a run's stored findings are not judged again", () => {
    const { blocking } = publicationBlockers(operatorImagePackage(), {
      gates: [
        ...passedWithWarnings(),
        // Even a gate that would stop a run is not re-judged here: whether
        // the run passed is its own verdict (currentPublishEvidence).
        gate("browser.overflow", [
          { code: "overflow", message: "Scrolls sideways.", where: "phone360" },
        ]),
      ],
      review: { ...review, outcome: "serious" },
    });
    expect(blocking).toEqual([]);
  });

  it("groups the check run's warnings by check and code, then the review's, in the order found", () => {
    const warnings = publicationWarnings(passedWithWarnings(), review);
    expect(warnings).toEqual<PublicationWarning[]>([
      {
        source: "checks",
        gate: "browser.tap_targets",
        code: "small_target",
        count: 3,
        message: "A 20x20 tap target.",
        where: ["phone390 · home", "phone390 · shop"],
        platform: true,
      },
      {
        source: "checks",
        gate: "browser.performance",
        code: "lcp",
        count: 1,
        message: "LCP 4.2 s.",
        where: [],
        platform: false,
      },
      {
        source: "review",
        gate: null,
        code: "low_score",
        count: 2,
        message: null,
        where: ["artDirection 3 of 5", "distinctness 3 of 5"],
        platform: false,
      },
      {
        source: "review",
        gate: null,
        code: "palette_only",
        count: 1,
        message: null,
        where: [],
        platform: false,
      },
      {
        source: "review",
        gate: null,
        code: "image_redraw",
        count: 1,
        message: null,
        where: ["slot-2"],
        platform: false,
      },
      {
        source: "review",
        gate: null,
        code: "low_total",
        count: 1,
        message: null,
        where: ["31 of 40"],
        platform: false,
      },
    ]);
  });

  it("lists nothing from a gate that stops a run, or from a clean pass", () => {
    const serious = gate("browser.overflow", [
      { code: "overflow", message: "Scrolls sideways.", where: "phone360" },
    ]);
    expect(serious.findings[0].severity).toBe("serious");
    expect(
      publicationWarnings([serious, gate("routes.links", [])], null),
    ).toEqual([]);
    expect(
      publicationWarnings([], { outcome: "pass", serious: [], warnings: [] }),
    ).toEqual([]);
  });

  it("calls a kind StoreMink's only when every finding of it is", () => {
    const mixed = publicationWarnings(
      [
        gate("browser.tap_targets", [
          tap("phone390 · home"),
          // small_target is StoreMink's markup whatever its selector.
          { ...tap("phone390 · shop"), targets: [".theme-hero-cta"] },
        ]),
        gate("browser.clipped_text", [
          {
            code: "clipped_text",
            message: "Clipped by 1px.",
            where: "phone360 · home",
            clipped: { x: 1, y: 0 },
            targets: [".theme-own-heading"],
          },
          {
            code: "clipped_text",
            message: "Clipped by 2px.",
            where: "phone360 · shop",
            clipped: { x: 0, y: 2 },
            targets: [".shop-card-base"],
          },
        ]),
      ],
      null,
    );
    expect(mixed.map((w) => [w.code, w.platform])).toEqual([
      ["small_target", true],
      ["clipped_text", false],
    ]);
  });

  it("never passes a long dash on from evidence stored before severity-v1", () => {
    const [warning] = publicationWarnings(
      [
        gate("browser.tap_targets", [
          {
            ...tap("phone390 · home"),
            message:
              "Targets too small \u2014 examples: .a, .b (needs 24\u201344 px)",
          },
        ]),
      ],
      null,
    );
    expect(warning.message).toBe(
      "Targets too small; examples: .a, .b (needs 24 to 44 px)",
    );
    expect(warning.message).not.toMatch(/[\u2013\u2014]/);
  });

  it("keeps at most a few places for each kind, each once", () => {
    const many = gate(
      "browser.tap_targets",
      Array.from({ length: 12 }, (_, i) => tap(`phone390 · page ${i % 8}`)),
    );
    const [warning] = publicationWarnings([many], null);
    expect(warning.count).toBe(12);
    expect(warning.where).toHaveLength(PUBLICATION_WARNING_PLACES);
    expect(new Set(warning.where).size).toBe(PUBLICATION_WARNING_PLACES);
  });
});

describe("the warnings a publish event records", () => {
  const kind = (i: number, code = `rule-${i}`): PublicationWarning => ({
    source: i % 2 ? "checks" : "review",
    gate: i % 2 ? "browser.accessibility" : null,
    code,
    count: i + 1,
    message: "A long message that must never reach the event. ".repeat(20),
    where: ["phone390 · home", "desktop1440 · shop"],
    platform: false,
  });

  it("records kinds and counts only, never messages or places", () => {
    const log = publicationWarningLog([kind(1), kind(2)]);
    expect(log).toEqual({
      count: 5,
      kinds: [
        {
          source: "checks",
          gate: "browser.accessibility",
          code: "rule-1",
          count: 2,
        },
        { source: "review", gate: null, code: "rule-2", count: 3 },
      ],
      omitted: 0,
    });
    expect(JSON.stringify(log)).not.toContain("message");
    expect(JSON.stringify(log)).not.toContain("phone390");
  });

  it("stays inside the 4 KiB event detail however many warnings there are", () => {
    const warnings = Array.from({ length: 60 }, (_, i) =>
      kind(i, `${"x".repeat(90)}${i}`),
    );
    const log = publicationWarningLog(warnings);
    expect(log.kinds).toHaveLength(PUBLICATION_WARNING_LOG_KINDS);
    expect(log.omitted).toBe(60 - PUBLICATION_WARNING_LOG_KINDS);
    expect(log.kinds.every((k) => k.code.length <= 64)).toBe(true);
    // The largest detail a publish event writes (publication.ts
    // theme_published), measured the way the database CHECK measures it
    // (octet_length(detail::text) <= 4096).
    const uuid = "00000000-0000-4000-8000-000000000000";
    const detail = {
      publicationId: uuid,
      releaseId: uuid,
      themeId: "t".repeat(80),
      releaseVersion: "10.100.1000",
      manifestDigest: "a".repeat(64),
      acceptanceRunId: uuid,
      severityRules: SEVERITY_RULES_VERSION,
      measuredUnder: SEVERITY_RULES_VERSION,
      designReview: "not_configured",
      designReviewId: uuid,
      warnings: log,
    };
    expect(jsonbTextBytes(detail)).toBeLessThan(4096);
  });
});
