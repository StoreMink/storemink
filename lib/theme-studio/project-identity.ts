import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { isBundledThemeId } from "@/lib/themes";

/** Caller holds the project-ID allocation lock until the insert commits. */
export async function resolveRecreatedThemeId(
  db: Db,
  requestedId: string,
): Promise<string | null> {
  // Deleted identities remain tombstoned: a new design must never inherit an
  // old release URL/version. The display name can stay exactly the same.
  const result = await db.execute<{ theme_id: string; deleted: boolean }>(sql`
    select theme_id, true as deleted from theme_studio_deletion_audit
      where theme_id like ${requestedId.slice(0, 70) + "%"}
    union all
    select theme_id, false from theme_studio_projects
      where theme_id like ${requestedId.slice(0, 70) + "%"}
    union all
    select theme_id, false from theme_releases
      where theme_id like ${requestedId.slice(0, 70) + "%"}
    union all
    select theme_id, false from theme_catalog_entries
      where theme_id like ${requestedId.slice(0, 70) + "%"}
  `);
  if (!result.rows.some((row) => row.deleted && row.theme_id === requestedId)) {
    return requestedId;
  }
  const reserved = new Set(result.rows.map((row) => row.theme_id));
  for (let suffix = 2; suffix <= 10_000; suffix++) {
    const ending = `-${suffix}`;
    const candidate =
      requestedId.slice(0, 80 - ending.length).replace(/-+$/, "") + ending;
    if (!reserved.has(candidate) && !isBundledThemeId(candidate)) {
      return candidate;
    }
  }
  return null;
}
