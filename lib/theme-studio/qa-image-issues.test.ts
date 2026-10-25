import { expect, it } from "vitest";
import { operatorImagePackage } from "./_test-helpers";
import { describeSlots } from "./slot-images-core";
import {
  imageAssessmentsComplete,
  imageIssueFindings,
  qaImageIssues,
} from "./qa-image-issues";
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
it("carries the photo check's problems for a flagged photo, bound to its bytes", () => {
  const { pkg, asset } = fixture();
  expect(
    qaImageIssues(pkg, [
      {
        sha256: asset.sha256,
        review: "flagged",
        note: "Lettering on the jar",
        problems: ["text_or_logo", 7, "off_style"],
      },
    ]),
  ).toEqual([
    {
      slotId: asset.id,
      sha256: asset.sha256,
      review: "flagged",
      note: "Lettering on the jar",
      problems: ["text_or_logo", "off_style"],
    },
  ]);
  // An unchecked photo carries none, whatever its history row says.
  expect(
    qaImageIssues(pkg, [
      { sha256: asset.sha256, review: "unreviewed", problems: ["malformed"] },
    ])[0],
  ).not.toHaveProperty("problems");
});
it("keeps an unchecked or hard-flagged photo serious whatever the design review says", () => {
  const { pkg, asset } = fixture();
  const approved = [{ slotId: asset.id, approved: true, reason: "Fine" }];
  const unchecked = qaImageIssues(pkg, []);
  expect(imageIssueFindings(unchecked, approved)).toEqual({
    serious: [{ code: "image_unchecked", slotId: asset.id }],
    warnings: [],
  });
  for (const hard of [
    "wrong_subject",
    "text_or_logo",
    "person",
    "malformed",
    "multiple_subjects",
  ])
    expect(
      imageIssueFindings(
        qaImageIssues(pkg, [
          { sha256: asset.sha256, review: "flagged", problems: [hard] },
        ]),
        approved,
      ),
    ).toEqual({
      serious: [{ code: "image_hard_problem", slotId: asset.id }],
      warnings: [],
    });
  // Small problems: the review's approval clears them, its refusal warns.
  const small = qaImageIssues(pkg, [
    {
      sha256: asset.sha256,
      review: "flagged",
      problems: ["off_style", "staging_mismatch", "poor_crop"],
    },
  ]);
  expect(imageIssueFindings(small, approved)).toEqual({
    serious: [],
    warnings: [],
  });
  expect(
    imageIssueFindings(small, [{ ...approved[0], approved: false }]),
  ).toEqual({
    serious: [],
    warnings: [{ code: "image_redraw", slotId: asset.id }],
  });
  // A flag recorded before problems were kept is a small one: the photo run
  // never keeps a photo with a hard problem.
  expect(
    imageIssueFindings(
      qaImageIssues(pkg, [{ sha256: asset.sha256, review: "flagged" }]),
      approved,
    ),
  ).toEqual({ serious: [], warnings: [] });
});
it("treats a problem the photo check does not know as hard: what nobody classified is serious", () => {
  const { pkg, asset } = fixture();
  expect(
    imageIssueFindings(
      qaImageIssues(pkg, [
        { sha256: asset.sha256, review: "flagged", problems: ["glitter"] },
      ]),
      [{ slotId: asset.id, approved: true, reason: "Fine" }],
    ).serious,
  ).toEqual([{ code: "image_hard_problem", slotId: asset.id }]);
});
