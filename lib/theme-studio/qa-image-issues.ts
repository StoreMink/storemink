import type { ThemePackageV2 } from "./contracts";
import { describeSlots } from "./slot-images-core";
import type { QaRepair } from "./qa-diagnosis";

export interface QaImageIssue {
  slotId: string;
  sha256: string;
  review: "flagged" | "unreviewed";
  note: string;
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
    return [
      {
        slotId: slot.id,
        sha256,
        review:
          review?.review === "flagged"
            ? ("flagged" as const)
            : ("unreviewed" as const),
        note: (
          review?.note || "No completed per-image review for these bytes."
        ).slice(0, 800),
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
