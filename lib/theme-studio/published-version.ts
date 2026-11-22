import "server-only";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { themeStudioProjects, themeStudioPublications } from "@/drizzle/schema";
import type { Db } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// A published theme can be changed (owner, 22 Nov 2026; migration 0288).
//
// A project is `published` exactly while the design it shows (its current
// version) is one a publication published. So a live theme that takes a
// change leaves `published` for the ordinary working states, and comes back
// to it in two ways: the change is published (the theme's next release), or
// nothing new became current (the change failed or was stopped, or the
// published design was made current again). These two helpers are that
// second way, so every place a theme comes to rest asks the same question.
//
// ★ The release a store installed is never touched by any of this: releases
//   are immutable rows and stores pin theirs. Only the project moves.
// ---------------------------------------------------------------------------

/** The release a design was published as ("1.0.0"), or null when that design
 * never was. */
export async function publishedReleaseOf(
  db: Db,
  projectId: string,
  versionId: string | null,
): Promise<string | null> {
  if (!versionId) return null;
  const [row] = await db
    .select({ releaseVersion: themeStudioPublications.releaseVersion })
    .from(themeStudioPublications)
    .where(
      and(
        eq(themeStudioPublications.projectId, projectId),
        eq(themeStudioPublications.versionId, versionId),
        eq(themeStudioPublications.status, "published"),
      ),
    )
    .limit(1);
  return row?.releaseVersion ?? null;
}

/**
 * Where a project that stopped working WITHOUT a new current version comes
 * to rest, as SQL for an UPDATE of `theme_studio_projects`: `failed` with no
 * design at all, `published` when the design it kept is a published one,
 * else `ready`.
 */
export function restingStatusSql(): SQL {
  return sql`CASE
    WHEN ${themeStudioProjects.currentVersionId} IS NULL THEN 'failed'
    WHEN EXISTS (
      SELECT 1 FROM theme_studio_publications pub
       WHERE pub.project_id = ${themeStudioProjects.id}
         AND pub.version_id = ${themeStudioProjects.currentVersionId}
         AND pub.status = 'published'
    ) THEN 'published'
    ELSE 'ready'
  END`;
}
