import { expect, it } from "vitest";
import { operatorImagePackage } from "./_test-helpers";
import { describeSlots } from "./slot-images-core";
import { imageAssessmentsComplete, qaImageIssues } from "./qa-image-issues";
function fixture() {
  const pkg = operatorImagePackage();
  const slot = describeSlots(pkg).find(
    (s) => !s.catalogPreview && !s.catalogScreenshot,
  )!;
  const asset = pkg.assets.find((a) => a.id === slot.id)!;
  asset.source = "generated";
  return { pkg, asset };
}
it("requires explicit assessment for missing and flagged reviews bound to current bytes", () => {
  const { pkg, asset } = fixture();
  expect(
    qaImageIssues(pkg, [{ sha256: "stale", review: "passed" }]),
  ).toMatchObject([{ slotId: asset.id, review: "unreviewed" }]);
  expect(
    qaImageIssues(pkg, [
      {
        sha256: asset.sha256,
        review: "flagged",
        note: "Warm lighting differs from the brief",
      },
    ]),
  ).toMatchObject([
    {
      slotId: asset.id,
      review: "flagged",
      note: "Warm lighting differs from the brief",
    },
  ]);
  expect(
    qaImageIssues(pkg, [{ sha256: asset.sha256, review: "passed" }]),
  ).toEqual([]);
});
it("does not redraw owned artwork or let an older pass override the nearest flagged result", () => {
  const { pkg, asset } = fixture();
  expect(
    qaImageIssues(pkg, [
      { sha256: asset.sha256, review: "flagged" },
      { sha256: asset.sha256, review: "passed" },
    ]),
  ).toHaveLength(1);
  asset.source = "operator-owned";
  expect(qaImageIssues(pkg, [])).toEqual([]);
});
it("refuses a passing verdict that omits, duplicates or disapproves an unresolved slot", () => {
  const { pkg, asset } = fixture();
  const issues = qaImageIssues(pkg, []);
  const assessment = {
    slotId: asset.id,
    approved: true,
    reason: "Matches the supplied brief and staging",
  };
  expect(imageAssessmentsComplete(issues, { verdict: "pass" })).toBe(false);
  expect(
    imageAssessmentsComplete(issues, {
      verdict: "pass",
      imageAssessments: [assessment],
    }),
  ).toBe(true);
  expect(
    imageAssessmentsComplete(issues, {
      verdict: "pass",
      imageAssessments: [assessment, assessment],
    }),
  ).toBe(false);
  expect(
    imageAssessmentsComplete(issues, {
      verdict: "pass",
      imageAssessments: [{ ...assessment, approved: false }],
    }),
  ).toBe(false);
  expect(
    imageAssessmentsComplete(issues, {
      verdict: "revise",
      imageAssessments: [{ ...assessment, approved: false }],
      repairs: [{ kind: "image", target: asset.id, reason: "Fix the staging" }],
    }),
  ).toBe(true);
  expect(
    imageAssessmentsComplete(issues, {
      verdict: "revise",
      imageAssessments: [{ ...assessment, approved: false }],
      repairs: [{ kind: "image", target: "other", reason: "Fix it" }],
    }),
  ).toBe(false);
});
