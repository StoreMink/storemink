import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  listThemeStudioAcceptanceRuns,
  readReviewSeverity,
} from "@/lib/theme-studio/acceptance";
import { listThemeStudioCheckScreenshots } from "@/lib/theme-studio/progress";
import { getThemeStudioReleaseState } from "@/lib/theme-studio/publication";
import { getThemeStudioProject, isUuid } from "@/lib/theme-studio/repository";
import type { ReviewSeverity } from "@/lib/theme-studio/scorecard";

// ---------------------------------------------------------------------------
// What the theme page's tabs and release controls read (wave TS-2, builder
// 2C). Server only: every caller is an async server component that
// [projectId]/page.tsx renders after its superadmin gate.
//
// ★ ONE READ PER REQUEST. React's `cache` shares an answer between the
// theme page, the release controls and the open tab within one render, so
// the whole project is read once (page.tsx reads it here too, with the id
// as the progress read returns it, so every caller hits the same entry).
//
// ★ NARROW. The two reads written here select single columns and JSON paths:
// the newest final design review's own split of what it found (a short list
// of codes, never the model's whole answer), and the nearest design the
// operator can see that a design was made from. Never picture bytes.
// ---------------------------------------------------------------------------

/** The project, as the theme page reads it (repository.ts). */
export const readStudioProject = cache((projectId: string) =>
  getThemeStudioProject(projectId),
);

/** The project's recent check runs, newest first (acceptance.ts). */
export const readStudioCheckRuns = cache((projectId: string) =>
  listThemeStudioAcceptanceRuns(projectId),
);

/** What Publish would do now, the releases and the catalog audit
 * (publication.ts). */
export const readStudioReleaseState = cache((projectId: string) =>
  getThemeStudioReleaseState(projectId),
);

/** The screenshots of a design's newest final check (progress.ts, the
 * owner-approved check screenshots): which pages and widths, never bytes. */
export const readStudioCheckScreenshots = cache(
  (projectId: string, versionId: string) =>
    withService((db) =>
      listThemeStudioCheckScreenshots(db, { projectId, versionId }),
    ),
);

/** A design's newest final design review: its state, the check run it is
 * bound to and the build, and what it found split by severity. */
export interface StudioDesignReview {
  id: string;
  status: "queued" | "running" | "passed" | "failed" | "revision_queued";
  errorCode: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  /** The check run the review judged (`browser_report.acceptanceRunId`). */
  checkRunId: string | null;
  build: string | null;
  severity: ReviewSeverity | null;
}

const REVIEW_STATES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "passed",
  "failed",
  "revision_queued",
]);

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The newest FINAL design review of one design (a layout check has none),
 * or null. Reads the review's split of what it found by JSON path only. */
export const readStudioDesignReview = cache(
  async (
    projectId: string,
    versionId: string,
  ): Promise<StudioDesignReview | null> => {
    if (!isUuid(projectId) || !isUuid(versionId)) return null;
    const result = await withService((db) =>
      db.execute(sql`
        SELECT q.id, q.status, q.error_code AS "errorCode",
          q.created_at AS "createdAt", q.finished_at AS "finishedAt",
          q.browser_report ->> 'acceptanceRunId' AS "checkRunId",
          q.browser_report ->> 'buildId' AS "build",
          q.vision_report -> 'reviewSeverity' AS "reviewSeverity"
          FROM theme_studio_visual_qa_runs q
         WHERE q.project_id = ${projectId}::uuid
           AND q.version_id = ${versionId}::uuid
           AND coalesce(q.browser_report ->> 'phase', 'final') = 'final'
         ORDER BY q.created_at DESC, q.id DESC
         LIMIT 1
      `),
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || typeof row.id !== "string") return null;
    const status = String(row.status);
    return {
      id: row.id,
      status: (REVIEW_STATES.has(status)
        ? status
        : "failed") as StudioDesignReview["status"],
      errorCode: text(row.errorCode),
      createdAt: iso(row.createdAt),
      finishedAt: iso(row.finishedAt),
      checkRunId: text(row.checkRunId),
      build: text(row.build),
      severity: readReviewSeverity({ reviewSeverity: row.reviewSeverity }),
    };
  },
);

/** The nearest earlier design the operator can see, with a theme, that a
 * design was made from, and how many hidden drafts (the automatic fixes)
 * lie between them. */
export interface StudioShownAncestor {
  id: string;
  versionNumber: number;
  /** Hidden drafts between the two: 0 when it is the direct parent. */
  between: number;
}

/** At most this many steps back (repository.ts walks a version's image runs
 * the same way). */
const MAX_LINEAGE = 50;

/** The design a design was made from, skipping the hidden drafts the
 * automatic fixes made in between; null for where a theme started. */
export const readStudioShownAncestor = cache(
  async (
    projectId: string,
    versionId: string,
  ): Promise<StudioShownAncestor | null> => {
    if (!isUuid(projectId) || !isUuid(versionId)) return null;
    const result = await withService((db) =>
      db.execute(sql`
        WITH RECURSIVE chain(id, parent, visibility, number, packaged, depth) AS (
          SELECT v.id, v.parent_version_id, v.visibility, v.version_number,
                 v.package_digest IS NOT NULL, 0
            FROM theme_studio_versions v
           WHERE v.id = ${versionId}::uuid AND v.project_id = ${projectId}::uuid
          UNION ALL
          SELECT v.id, v.parent_version_id, v.visibility, v.version_number,
                 v.package_digest IS NOT NULL, c.depth + 1
            FROM theme_studio_versions v
            JOIN chain c ON v.id = c.parent
           WHERE c.depth < ${MAX_LINEAGE} AND v.project_id = ${projectId}::uuid
        )
        SELECT id, number AS "versionNumber", depth
          FROM chain
         WHERE depth > 0 AND visibility = 'operator' AND packaged
         ORDER BY depth
         LIMIT 1
      `),
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || typeof row.id !== "string") return null;
    const depth = Number(row.depth);
    return {
      id: row.id,
      versionNumber: Number(row.versionNumber),
      between: Number.isFinite(depth) ? Math.max(0, depth - 1) : 0,
    };
  },
);
