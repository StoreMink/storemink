import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import type { ThemeStudioActor } from "./access";
import { isUuid, ThemeStudioError } from "./repository";

export interface DeleteThemeStudioProjectInput {
  projectId: string;
  expectedRevision: number;
  confirmation: string;
}

/** The database checks active work under locks and removes the complete
 * protected history atomically. Only a session-derived actor enters.
 *
 * ★ A theme stores use is deleted too (owner, 23 Nov 2026), and each of those
 *   stores keeps the release it pinned (migration 0289): `storesKept` says how
 *   many. The database still refuses when a store uses the theme without a
 *   pinned release, because deleting it would change that store. */
export async function deleteThemeStudioProject(
  actor: ThemeStudioActor,
  input: DeleteThemeStudioProjectInput,
): Promise<{ themeId: string; storesKept: number }> {
  if (
    !isUuid(input.projectId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    typeof input.confirmation !== "string" ||
    input.confirmation.length > 80
  ) {
    throw new ThemeStudioError(
      "invalid_input",
      "The request is malformed. Reload and try again.",
    );
  }
  const result = await withService((db) =>
    db.execute(sql`
    select public.theme_studio_delete_project(${input.projectId}::uuid,
      ${input.expectedRevision}::integer, ${input.confirmation}::text,
      ${actor.id}::uuid) as result
  `),
  );
  const removed = result.rows[0]?.result as
    | { ok: boolean; error?: string; themeId?: string; storesKept?: unknown }
    | undefined;
  if (!removed?.ok || !removed.themeId) {
    throw new ThemeStudioError(
      "illegal_state",
      removed?.error ?? "The theme could not be deleted.",
    );
  }
  // The revision before 0289 answers without the count: no store kept it.
  const storesKept =
    typeof removed.storesKept === "number" &&
    Number.isSafeInteger(removed.storesKept) &&
    removed.storesKept > 0
      ? removed.storesKept
      : 0;
  return { themeId: removed.themeId, storesKept };
}
