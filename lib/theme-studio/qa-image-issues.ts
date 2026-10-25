import type { ThemePackageV2 } from "./contracts";
import {
  isBlocking,
  THEME_IMAGE_PROBLEMS,
  type ThemeImageProblem,
} from "./image-review";
import { describeSlots } from "./slot-images-core";
import type { QaRepair } from "./qa-diagnosis";
import type { ReviewFinding } from "./scorecard";

export interface QaImageIssue {
  slotId: string;
  sha256: string;
  review: "flagged" | "unreviewed";
  note: string;
  /** For a flagged photo, the problems its photo check named. Absent on
   * rows recorded before problems were kept. */
  problems?: string[];
}
export interface QaImageAssessment {
  slotId: string;
  approved: boolean;
  reason: string;
}

/** Metadata only, in nearest-ancestor order. Bind reviews to bytes, including
 * unchanged art carried through renamed slots, never to a stale slot name. */
export function qaImageIssues(
  pkg: ThemePackageV2,
  history: readonly {
    sha256: string | null;
    review: string;
    note?: string | null;
    problems?: unknown;
  }[],
): QaImageIssue[] {
  const reviews = new Map<string, (typeof history)[number]>();
  for (const row of history)
    if (row.sha256 && !reviews.has(row.sha256)) reviews.set(row.sha256, row);
  const assets = new Map(pkg.assets.map((asset) => [asset.id, asset]));
  return describeSlots(pkg).flatMap((slot) => {
    if (
      slot.placeholder ||
      slot.catalogPreview ||
      slot.catalogScreenshot ||
      slot.source !== "generated"
    )
      return [];
    const sha256 = assets.get(slot.id)?.sha256;
    if (!sha256) return [];
    const review = reviews.get(sha256);
    if (review?.review === "passed") return [];
    const flagged = review?.review === "flagged";
    const recorded: unknown = review?.problems;
    const problems =
      flagged && Array.isArray(recorded)
        ? recorded.filter((p): p is string => typeof p === "string")
        : [];
    return [
      {
        slotId: slot.id,
        sha256,
        review: flagged ? ("flagged" as const) : ("unreviewed" as const),
        note: (
          review?.note || "No completed per-image review for these bytes."
        ).slice(0, 800),
        ...(problems.length ? { problems } : {}),
      },
    ];
  });
}

export function imageAssessmentsComplete(
  issues: readonly QaImageIssue[],
  report: {
    verdict: string;
    imageAssessments?: QaImageAssessment[];
    repairs?: QaRepair[];
  },
): boolean {
  const assessments = report.imageAssessments ?? [];
  if (
    assessments.length !== issues.length ||
    new Set(assessments.map((a) => a.slotId)).size !== assessments.length
  )
    return false;
  return issues.every((issue) => {
    const assessment = assessments.find((a) => a.slotId === issue.slotId);
    return (
      assessment &&
      (assessment.approved ||
        (report.verdict === "revise" &&
          report.repairs?.some(
            (r) => r.kind === "image" && r.target === issue.slotId,
          )))
    );
  });
}

const KNOWN_PROBLEMS: ReadonlySet<string> = new Set(THEME_IMAGE_PROBLEMS);

/** A problem on the photo check's hard list, or one it does not know: what
 * nobody classified counts as serious. */
function hardProblem(problem: string): boolean {
  return (
    !KNOWN_PROBLEMS.has(problem) || isBlocking([problem as ThemeImageProblem])
  );
}

/**
 * What each unresolved photo does to Publish.
 *
 * ★ The design review judges art direction, not the photo check's list of
 * hard problems (lettering or a logo, a person where none is allowed, a
 * malformed object, the wrong or several products). So its approval never
 * clears a photo whose own check has not passed on these exact bytes, nor one
 * the check flagged with a hard problem: both stay serious until the photo
 * check itself passes on the bytes (a redraw is checked as it is drawn). Its
 * approval clears only a photo flagged for small things (off style, staging,
 * crop); one it does not approve is a warning with a redraw.
 */
export function imageIssueFindings(
  issues: readonly QaImageIssue[],
  assessments: readonly QaImageAssessment[] = [],
): { serious: ReviewFinding[]; warnings: ReviewFinding[] } {
  const serious: ReviewFinding[] = [];
  const warnings: ReviewFinding[] = [];
  for (const issue of issues) {
    if (issue.review === "unreviewed") {
      serious.push({ code: "image_unchecked", slotId: issue.slotId });
    } else if ((issue.problems ?? []).some(hardProblem)) {
      serious.push({ code: "image_hard_problem", slotId: issue.slotId });
    } else if (
      !assessments.some((a) => a.slotId === issue.slotId && a.approved)
    ) {
      warnings.push({ code: "image_redraw", slotId: issue.slotId });
    }
  }
  return { serious, warnings };
}
