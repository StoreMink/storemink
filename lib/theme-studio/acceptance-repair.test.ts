import { describe, expect, it } from "vitest";
import {
  PHOTO_REVIEW_CODES,
  THEME_FIX_CHECKS,
  acceptanceRepairDraft,
  describeFixDraft,
} from "./acceptance-repair";
import { GATE_LABELS, gate, type GateId } from "./acceptance-gates";
import type { ThemeStudioAcceptanceRunView } from "./acceptance";
import { THEME_STUDIO_LIMITS } from "./contracts";
import type { ReviewSeverity } from "./scorecard";

// "Describe a fix" (wave TS-2, plan section 4): a draft the operator reads
// and sends, built from serious findings only, in Design-N words, with no
// run id, and with package.security among the checks it describes.

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

const version = { id: "v8", versionNumber: 8, packageDigest: "digest" };
const RUN_ID = "4f0c2a8e-1b7d-4c55-9a77-0d4f6e2b9c11";

function run(
  gates: ThemeStudioAcceptanceRunView["gates"],
  overrides: Partial<ThemeStudioAcceptanceRunView> = {},
): ThemeStudioAcceptanceRunView {
  return {
    id: RUN_ID,
    versionId: "v8",
    packageDigest: "digest",
    assetsDigest: "assets",
    buildId: "build",
    currentBuild: true,
    evidenceDigest: "evidence",
    status: "failed",
    createdByEmail: "operator@example.com",
    createdAt: "2026-09-29",
    completedAt: "2026-09-29",
    userAgent: null,
    gates,
    ...overrides,
  };
}

const contrast = gate("browser.accessibility", [
  {
    code: "color-contrast",
    where: "phone390 · product",
    message: "Low contrast in .hero-title",
    targets: [".hero-title"],
    contrast: [{ target: ".hero-title", ratio: 3.91, required: 4.5 }],
  },
  {
    code: "color-contrast",
    where: "phone360 · home",
    message: "Low contrast in .hero-title",
    targets: [".hero-title"],
    contrast: [{ target: ".hero-title", ratio: 3.91, required: 4.5 }],
  },
]);

const security = gate("package.security", [
  {
    code: "handler",
    where: "preset.pages.0.sections.1.settings.html",
    message: "Contains an inline event handler.",
  },
]);

describe("describeFixDraft", () => {
  it("★ describes a security problem: package.security joins the draft", () => {
    expect(THEME_FIX_CHECKS).toContain("package.security");
    const draft = describeFixDraft({
      run: run([security], { status: "blocked" }),
      version,
      review: null,
    })!;
    expect(draft).toContain("Security:");
    expect(draft).toContain(
      "The theme contains code that would run when a shopper clicks, taps or hovers.",
    );
    // The model is told where, from the finding as it was measured.
    expect(draft).toContain("preset.pages.0.sections.1.settings.html");
  });

  it("names the design in Design-N words and carries no run id", () => {
    const draft = describeFixDraft({
      run: run([contrast]),
      version,
      review: null,
    })!;
    expect(draft).toContain("Design 8");
    expect(draft).not.toMatch(/version 8/i);
    expect(draft).not.toContain(RUN_ID);
    expect(draft).not.toMatch(/acceptance run|run id/i);
  });

  it("groups a kind of problem once, with every place it was found", () => {
    const draft = describeFixDraft({
      run: run([contrast]),
      version,
      review: null,
    })!;
    const bullets = draft.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toContain(
      "Readable text: Some text is hard to read (3.9 to 1, needs 4.5 to 1).",
    );
    expect(bullets[0]).toContain("Where: Product at 390 px; Home at 360 px.");
  });

  it("is built from serious findings only, never from warnings", () => {
    const mixed = gate("browser.clipped_text", [
      {
        code: "clipped_text",
        where: "phone390 · shop",
        message: "Text is clipped by 9px horizontally and 0px vertically.",
        clipped: { x: 9, y: 0 },
      },
      {
        code: "clipped_text",
        where: "phone360 · home",
        message: "Text is clipped by 1px horizontally and 0px vertically.",
        clipped: { x: 1, y: 0 },
      },
    ]);
    const draft = describeFixDraft({
      run: run([mixed]),
      version,
      review: null,
    })!;
    expect(draft).toContain("Some text is cut off by 9 px.");
    expect(draft).not.toContain("cut off by 1 px");
    expect(draft).not.toContain("Home at 360 px");
    // A check that holds only warnings describes nothing.
    const warningsOnly = gate("browser.tap_targets", [
      {
        code: "small_target",
        where: "phone390 · shop",
        message: "20×20px interactive target (.chip); minimum is 24×24px.",
      },
    ]);
    expect(
      describeFixDraft({ run: run([warningsOnly]), version, review: null }),
    ).toBeNull();
    expect(
      describeFixDraft({
        run: null,
        version,
        review: {
          outcome: "taste",
          serious: [],
          warnings: [
            { code: "palette_only" },
            { code: "low_total", score: 31 },
          ],
        },
      }),
    ).toBeNull();
  });

  it("describes only a check that stops Publish, never findings stored on one that passed", () => {
    // Stored before severity-v1: no severity, so each finding reads serious,
    // but the check itself passed.
    const passedWithOldFindings = {
      ...gate("routes.links", []),
      findings: [{ code: "broken", where: "/sale", message: "Returned 404." }],
    };
    expect(
      describeFixDraft({
        run: run([passedWithOldFindings]),
        version,
        review: null,
      }),
    ).toBeNull();
  });

  it("leaves out what no change to the theme can fix: StoreMink's own code, pictures and checks that could not run", () => {
    const shared = gate("browser.accessibility", [
      {
        code: "color-contrast",
        where: "phone390 · product",
        message: "Low contrast in .pdp-price-base",
        targets: [".pdp-price-base"],
        contrast: [{ target: ".pdp-price-base", ratio: 2.1, required: 4.5 }],
      },
    ]);
    const placeholder = gate("assets.provenance", [
      { code: "placeholder", message: "3 artwork images are placeholders." },
    ]);
    const coverage = gate("browser.coverage", [
      { code: "missing", where: "phone390 · cart", message: "Not measured." },
    ]);
    expect(
      describeFixDraft({
        run: run([shared, placeholder, coverage]),
        version,
        review: null,
      }),
    ).toBeNull();
    const draft = describeFixDraft({
      run: run([shared, placeholder, coverage, contrast]),
      version,
      review: null,
    })!;
    expect(draft).not.toContain("struck price");
    expect(draft).not.toMatch(/placeholder|not measured/i);
  });

  it("adds the design review's serious findings, never its photos or warnings", () => {
    const review: ReviewSeverity = {
      outcome: "serious",
      serious: [
        { code: "inaccessible_copy" },
        { code: "very_low_score", row: "responsiveComposition", score: 2 },
        { code: "image_hard_problem", slotId: "hero-main" },
      ],
      warnings: [{ code: "generic_surface" }],
    };
    const draft = describeFixDraft({ run: null, version, review })!;
    expect(draft).toContain(
      "Design review: Some words are hard or impossible to read",
    );
    expect(draft).toContain(
      "The design review scored the phone layout 2 of 5, too low for a store to work well.",
    );
    expect(draft).not.toMatch(/lettering|hero main/i);
    expect(draft).not.toContain("generic");
    expect(PHOTO_REVIEW_CODES).toEqual(
      expect.arrayContaining(["image_unchecked", "image_hard_problem"]),
    );
  });

  it("falls back to the review's own words only when nothing else is serious", () => {
    const notes = [
      `The hero headline ${EM} over the photo ${EN} is unreadable.`,
    ];
    const fallback = describeFixDraft({
      run: null,
      version,
      review: null,
      notes,
    })!;
    expect(fallback).toContain(
      "Design review: The hero headline, over the photo, is unreadable.",
    );
    const structured = describeFixDraft({
      run: run([contrast]),
      version,
      review: null,
      notes,
    })!;
    expect(structured).not.toContain("hero headline");
    expect(
      describeFixDraft({ run: null, version, review: null, notes: [] }),
    ).toBeNull();
  });

  it("reads only a check run of this exact design", () => {
    for (const patch of [
      { versionId: "another" },
      { packageDigest: "old" },
    ] as Partial<ThemeStudioAcceptanceRunView>[])
      expect(
        describeFixDraft({
          run: run([contrast], patch),
          version,
          review: null,
        }),
      ).toBeNull();
    expect(
      describeFixDraft({
        run: run([contrast]),
        version: { ...version, packageDigest: null },
        review: null,
      }),
    ).toBeNull();
  });

  it("never carries a long dash, and stays a short summary within the message limit", () => {
    const noisy = gate(
      "package.content",
      Array.from({ length: 30 }, (_, i) => ({
        code: `pages.custom_${i}`,
        where: `preset.pages.${i}`,
        message: `Section ${i} ${EM} unfinished ${EN} ${"x".repeat(900)}`,
      })),
    );
    const draft = describeFixDraft({
      run: run([noisy]),
      version,
      review: null,
    })!;
    expect(draft.includes(EM) || draft.includes(EN)).toBe(false);
    expect(draft.length).toBeLessThanOrEqual(
      THEME_STUDIO_LIMITS.promptChars - 2000,
    );
    expect(draft.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(
      13,
    );
    expect(draft).toContain("- And 18 more kinds of problem.");
  });
});

describe("★ every check is classified for Describe a fix", () => {
  // A check left out of THEME_FIX_CHECKS is one no change to the theme can
  // clear; each says why here, so a new check is never left out silently.
  const NOT_A_THEME_CHANGE: Record<string, string> = {
    "assets.integrity": "a picture file: Redraw or replace it",
    "assets.provenance": "a picture or its licence note: Pictures tab",
    "demo.materialize": "the demo store StoreMink builds",
    "routes.render": "a page that did not open: checked again",
    "browser.coverage": "a check that could not run: Check again",
    "browser.media": "a picture that did not load: Redraw",
    "browser.performance": "speed is a warning",
  };

  it("puts every check id in exactly one list", () => {
    const all = Object.keys(GATE_LABELS) as GateId[];
    for (const id of all)
      expect(
        Number(THEME_FIX_CHECKS.includes(id)) +
          Number(Object.hasOwn(NOT_A_THEME_CHANGE, id)),
        id,
      ).toBe(1);
    for (const id of [...THEME_FIX_CHECKS, ...Object.keys(NOT_A_THEME_CHANGE)])
      expect(all, id).toContain(id);
  });
});

describe("acceptanceRepairDraft (kept for its importers)", () => {
  it("drafts a failed run of this design on today's build, in the same words", () => {
    const draft = acceptanceRepairDraft(run([contrast]), version)!;
    expect(draft).toBe(
      describeFixDraft({ run: run([contrast]), version, review: null }),
    );
    expect(draft).toContain("Design 8");
  });

  it("drafts a security block too", () => {
    expect(
      acceptanceRepairDraft(run([security], { status: "blocked" }), version),
    ).toContain("Security:");
  });

  it("refuses stale, mismatched, incomplete and successful evidence", () => {
    for (const patch of [
      { currentBuild: false },
      { versionId: "another" },
      { packageDigest: "old" },
      { status: "awaiting_browser" as const },
      { status: "passed" as const },
    ])
      expect(acceptanceRepairDraft(run([contrast], patch), version)).toBeNull();
  });
});
