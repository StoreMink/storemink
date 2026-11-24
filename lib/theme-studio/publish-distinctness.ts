import "server-only";

/**
 * The public catalogue as a theme about to be published is compared with it
 * (fingerprint.ts `publicationSimilarityBlocker`): every publicly listed
 * release other than the theme's own, and the bundled themes a new store can
 * choose. Read inside the caller's transaction; fingerprints only, never
 * copy, artwork or a store's data.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { THEME_DEFINITIONS } from "@/lib/themes";
import { validateThemePackageV2 } from "./contracts";
import {
  themeFingerprint,
  type PublishedThemeFingerprint,
} from "./fingerprint";

/** The most catalogue themes one publish is compared with. */
export const PUBLISHED_COMPARISON_LIMIT = 200;

export async function publishedThemeFingerprints(
  db: Db,
  themeId: string,
): Promise<PublishedThemeFingerprint[]> {
  const rows = await db.execute(sql`
    SELECT c.theme_id, r.package_json
      FROM theme_catalog_entries c
      JOIN theme_releases r ON r.id = c.current_release_id
     WHERE c.visibility = 'public'
       AND r.release_status = 'published'
       AND c.theme_id <> ${themeId}
     ORDER BY c.updated_at DESC, c.theme_id
     LIMIT ${PUBLISHED_COMPARISON_LIMIT}
  `);
  const entries = new Map<string, PublishedThemeFingerprint>();
  for (const row of rows.rows as {
    theme_id: string;
    package_json: unknown;
  }[]) {
    const pkg = validateThemePackageV2(row.package_json);
    // A release this build cannot read is not rendered either (the runtime
    // registry refuses it), so it is nothing a shopper could confuse with.
    if (!pkg.ok || entries.has(row.theme_id)) continue;
    entries.set(row.theme_id, {
      themeId: row.theme_id,
      name: pkg.value.definition.name,
      fingerprint: themeFingerprint(pkg.value.definition, { styling: true }),
    });
  }
  for (const theme of THEME_DEFINITIONS) {
    if (
      theme.id === themeId ||
      entries.has(theme.id) ||
      theme.catalog.visibility !== "public"
    )
      continue;
    entries.set(theme.id, {
      themeId: theme.id,
      name: theme.name,
      fingerprint: themeFingerprint(theme, { styling: true }),
    });
  }
  return [...entries.values()];
}
