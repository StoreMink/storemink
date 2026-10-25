import { describe, expect, it } from "vitest";
import { operatorImagePackage } from "./_test-helpers";
import { REJECTION_CONDITIONS, SCORECARD_DIMENSIONS } from "./scorecard";
import {
  buildVisualQaRequest,
  classifyVisualQaReport,
  parseVisualQaReport,
  VISUAL_QA_PROMPT_VERSION,
  VISUAL_QA_SCHEMA,
  VISUAL_QA_SYSTEM_PROMPT,
  visualQaContext,
  visualQaImageIssueText,
  type VisualQaReport,
} from "./visual-qa-request";

const issue = {
  slotId: "hero-main",
  sha256: "a".repeat(64),
  review: "flagged" as const,
  note: "cut-off chandelier",
};

describe("visual QA request", () => {
  it("is the production shape: one context block, then evidence, then issue pairs", () => {
    const request = buildVisualQaRequest({
      modelKey: "gemini-3.8-flash",
      providerModel: "fake",
      projectName: "Atelier",
      originalBrief: "A calm linen store.",
      packageJson: operatorImagePackage(),
      browserReport: { evidence: { samples: [] } },
      issues: [issue],
      evidence: [
        { type: "text", text: "Layout overview for phone390" },
        { type: "image", mediaType: "image/webp", base64: "AAAA" },
      ],
      images: [{ issue, base64: "BBBB" }],
    });
    expect(request.stage).toBe("visual_qa");
    expect(request.effort).toBe("high");
    expect(request.system).toBe(VISUAL_QA_SYSTEM_PROMPT);
    expect(request.content.map((b) => b.type)).toEqual([
      "text",
      "text",
      "image",
      "text",
      "image",
    ]);
    const context = request.content[0];
    if (context.type !== "text") throw new Error("context must be text");
    expect(context.text.startsWith("Project: Atelier\n")).toBe(true);
    expect(context.text).toContain(JSON.stringify("A calm linen store."));
    expect(context.text).toContain(
      `Image slots needing explicit assessments: ["hero-main"]`,
    );
    expect(request.content[3]).toEqual({
      type: "text",
      text: visualQaImageIssueText(issue),
    });
    expect(request.content[4]).toEqual({
      type: "image",
      mediaType: "image/webp",
      base64: "BBBB",
    });
  });

  it("holds the reviewer to every scorecard row, every rejection, and the two defects the benchmark found", () => {
    for (const dimension of SCORECARD_DIMENSIONS) {
      expect(VISUAL_QA_SYSTEM_PROMPT).toContain(
        `${dimension.key}: ${dimension.question}`,
      );
    }
    for (const condition of REJECTION_CONDITIONS) {
      expect(VISUAL_QA_SYSTEM_PROMPT).toContain(
        `Reject ${condition.key}: ${condition.label}.`,
      );
    }
    // The 2026-10-04 benchmark: duplicate newsletter modules and invented
    // endorsements both scored 5/5. The instructions name them explicitly.
    expect(VISUAL_QA_SYSTEM_PROMPT).toMatch(/redundant full newsletter signup/);
    expect(VISUAL_QA_SYSTEM_PROMPT).toMatch(/invented awards/);
    expect(VISUAL_QA_SYSTEM_PROMPT).toContain(
      "Approval requires every score >=4, total >=34",
    );
  });

  it("prompt v7: no chair, and every serious defect named as its rejection, never only a score", () => {
    expect(VISUAL_QA_PROMPT_VERSION).toBe("theme-studio-visual-qa-v7");
    expect(VISUAL_QA_SYSTEM_PROMPT).not.toMatch(/chair|pre-review/i);
    expect(VISUAL_QA_SYSTEM_PROMPT).toContain(
      "Name every serious defect as its rejection condition, never only as a lower score",
    );
    for (const phrase of [
      "copy a shopper cannot read is inaccessible_copy",
      "the original brief does not support is unsupported_claim",
      "a headed section with nothing under it",
      "is unfinished_surface",
      "lorem ipsum or template text is placeholder_copy",
      "is copied",
      "merely generic is generic_surface",
      // Any copy it cannot read, not only text the probe flagged.
      "Any copy you cannot read comfortably, anywhere on any page",
      "behind or under another layer, clipped or cut off mid-word, or too small or too faint), is inaccessible_copy",
      "never only a lower typography or detail-quality score",
      // The duplicate newsletter stays taste: a 3, not a blocking score.
      "score detailQuality 3",
    ])
      expect(VISUAL_QA_SYSTEM_PROMPT).toContain(phrase);
    // The reviewer may name every condition, the two new ones included.
    expect(VISUAL_QA_SCHEMA.properties.rejections.items.enum).toEqual(
      REJECTION_CONDITIONS.map((c) => c.key),
    );
    expect(VISUAL_QA_SCHEMA.properties.rejections.maxItems).toBe(8);
  });

  it("round-trips a passing report through the parser", () => {
    const scores = Object.fromEntries(
      SCORECARD_DIMENSIONS.map((d) => [d.key, 5]),
    );
    expect(
      parseVisualQaReport({
        verdict: "pass",
        scores,
        rejections: [],
        findings: [],
        revisionBrief: null,
        repairs: [],
        imageAssessments: [],
      })?.verdict,
    ).toBe("pass");
  });
});

const fives = () =>
  Object.fromEntries(
    SCORECARD_DIMENSIONS.map((d) => [d.key, 5]),
  ) as VisualQaReport["scores"];
const reviewOf = (input: Partial<VisualQaReport> = {}): VisualQaReport => ({
  verdict: "pass",
  scores: fives(),
  rejections: [],
  findings: [],
  revisionBrief: null,
  repairs: [],
  imageAssessments: [],
  ...input,
});

describe("what a review does to Publish", () => {
  it("parses every rejection, the new ones included, up to all eight at once", () => {
    const all = REJECTION_CONDITIONS.map((c) => c.key);
    expect(
      parseVisualQaReport({
        ...reviewOf({ verdict: "revise" }),
        rejections: all,
      })?.rejections,
    ).toEqual(all);
    expect(
      parseVisualQaReport({
        ...reviewOf({ verdict: "revise" }),
        rejections: [...all, "copied"],
      }),
    ).toBeNull();
  });

  it("a clean pass is a pass; a bare revise is taste", () => {
    expect(classifyVisualQaReport(reviewOf(), [])).toEqual({
      outcome: "pass",
      serious: [],
      warnings: [],
    });
    expect(classifyVisualQaReport(reviewOf({ verdict: "revise" }), [])).toEqual(
      {
        outcome: "taste",
        serious: [],
        warnings: [{ code: "revise_requested" }],
      },
    );
    expect(
      classifyVisualQaReport(
        reviewOf({
          repairs: [{ kind: "settings", target: null, reason: "Tighten" }],
        }),
        [],
      ).outcome,
    ).toBe("taste");
  });

  it("serious rejections and decision 3's very low scores are serious; the rest is taste", () => {
    for (const key of [
      "copied",
      "unfinished_surface",
      "placeholder_copy",
      "inaccessible_copy",
      "unsupported_claim",
    ] as const)
      expect(
        classifyVisualQaReport(
          reviewOf({ verdict: "revise", rejections: [key] }),
          [],
        ),
      ).toMatchObject({ outcome: "serious", serious: [{ code: key }] });
    for (const key of [
      "palette_only",
      "generic_surface",
      "needs_custom_code",
    ] as const)
      expect(
        classifyVisualQaReport(
          reviewOf({ verdict: "revise", rejections: [key] }),
          [],
        ),
      ).toMatchObject({ outcome: "taste", warnings: [{ code: key }] });
    const scored = (row: keyof VisualQaReport["scores"], score: number) =>
      classifyVisualQaReport(
        reviewOf({ verdict: "revise", scores: { ...fives(), [row]: score } }),
        [],
      );
    for (const row of [
      "commerceClarity",
      "responsiveComposition",
      "brandAdaptability",
      "typography",
      "detailQuality",
    ] as const) {
      expect(scored(row, 2)).toMatchObject({
        outcome: "serious",
        serious: [{ code: "very_low_score", row, score: 2 }],
      });
      expect(scored(row, 3)).toMatchObject({
        outcome: "taste",
        warnings: [{ code: "low_score", row, score: 3 }],
      });
    }
    // Art direction, distinctness and imagery are taste at any score.
    for (const row of ["artDirection", "distinctness", "imagery"] as const)
      expect(scored(row, 1)).toMatchObject({
        outcome: "taste",
        serious: [],
        warnings: [{ code: "low_score", row, score: 1 }],
      });
  });

  it("an unchecked photo stays serious even when the review approves it; a small flag it approves is cleared", () => {
    const unchecked = {
      slotId: "hero-main",
      sha256: "a".repeat(64),
      review: "unreviewed" as const,
      note: "No completed per-image review for these bytes.",
    };
    const approved = {
      slotId: "hero-main",
      approved: true,
      reason: "Matches the art direction.",
    };
    expect(
      classifyVisualQaReport(reviewOf({ imageAssessments: [approved] }), [
        unchecked,
      ]),
    ).toEqual({
      outcome: "serious",
      serious: [{ code: "image_unchecked", slotId: "hero-main" }],
      warnings: [],
    });
    const small = {
      ...unchecked,
      review: "flagged" as const,
      problems: ["off_style" as const],
    };
    expect(
      classifyVisualQaReport(reviewOf({ imageAssessments: [approved] }), [
        small,
      ]).outcome,
    ).toBe("pass");
    expect(
      classifyVisualQaReport(
        reviewOf({
          verdict: "revise",
          imageAssessments: [{ ...approved, approved: false }],
          repairs: [{ kind: "image", target: "hero-main", reason: "Redraw" }],
        }),
        [small],
      ),
    ).toEqual({
      outcome: "taste",
      serious: [],
      warnings: [{ code: "image_redraw", slotId: "hero-main" }],
    });
    expect(
      classifyVisualQaReport(reviewOf({ imageAssessments: [approved] }), [
        { ...small, problems: ["text_or_logo"] },
      ]),
    ).toMatchObject({
      outcome: "serious",
      serious: [{ code: "image_hard_problem", slotId: "hero-main" }],
    });
  });
});

describe("visual QA context", () => {
  it("names the text the probe could not judge and the chrome states it opened", () => {
    const context = visualQaContext(operatorImagePackage(), {
      evidence: {
        samples: [
          {
            viewport: "phone390",
            path: "/",
            width: 390,
            height: 844,
            contrastUnresolved: [
              { target: ".home-hero-heading", reason: "bgImage" },
            ],
            states: [
              {
                state: "menu",
                measured: true,
                contrastUnresolved: [
                  { target: ".drawer a", reason: "bgOverlap" },
                ],
              },
              { state: "cart", measured: false, reason: "unopened" },
            ],
          },
          { viewport: "desktop1440", path: "/shop", width: 1440, height: 900 },
        ],
      },
    });
    expect(context.pages).toEqual([
      {
        viewport: "phone390",
        path: "/",
        width: 390,
        height: 844,
        unresolvedContrast: [
          { target: ".home-hero-heading", reason: "bgImage" },
        ],
        states: [
          {
            state: "menu",
            measured: true,
            unresolvedContrast: [{ target: ".drawer a", reason: "bgOverlap" }],
          },
          { state: "cart", measured: false, reason: "unopened" },
        ],
      },
      { viewport: "desktop1440", path: "/shop", width: 1440, height: 900 },
    ]);
  });

  it("tells the reviewer to judge unresolved contrast itself", () => {
    expect(VISUAL_QA_SYSTEM_PROMPT).toContain("unresolvedContrast");
    expect(VISUAL_QA_SYSTEM_PROMPT).toContain("unopened or stuck");
  });
});
