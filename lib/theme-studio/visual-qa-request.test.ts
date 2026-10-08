import { describe, expect, it } from "vitest";
import { operatorImagePackage } from "./_test-helpers";
import { REJECTION_CONDITIONS, SCORECARD_DIMENSIONS } from "./scorecard";
import {
  buildVisualQaRequest,
  parseVisualQaReport,
  VISUAL_QA_SYSTEM_PROMPT,
  visualQaImageIssueText,
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
