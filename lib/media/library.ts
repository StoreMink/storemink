import "server-only";

import { and, count, desc, eq, notInArray } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { mediaAssets } from "@/drizzle/schema";
import { LIBRARY_HIDDEN_SOURCES } from "./sources";
import type { MediaAsset } from "./library-types";

// Aliased to the snake_case shape the view/page expect (Drizzle keys are camel).
export const MEDIA_ASSET_COLUMNS = {
  id: mediaAssets.id,
  url: mediaAssets.url,
  path: mediaAssets.path,
  filename: mediaAssets.filename,
  content_type: mediaAssets.contentType,
  size_bytes: mediaAssets.sizeBytes,
  source: mediaAssets.source,
  created_at: mediaAssets.createdAt,
};

/**
 * One page of the images the Library lists, newest first.
 *
 * ★ HIDDEN SOURCES ARE FILTERED HERE, IN ONE PLACE, so the Library page and
 *   the product editor's picker cannot disagree about what "the library" is.
 *   Throws on a read failure; the caller says so instead of showing an empty
 *   library.
 */
export async function listLibraryAssets(
  storeId: string,
  { page, pageSize }: { page: number; pageSize: number },
): Promise<{ assets: MediaAsset[]; total: number }> {
  const listed = and(
    eq(mediaAssets.storeId, storeId),
    notInArray(mediaAssets.source, [...LIBRARY_HIDDEN_SOURCES]),
  );
  return withService(async (db) => {
    // Sequential (not Promise.all): one pooled connection serialises queries
    // anyway, so parallelising only trips pg's in-flight-query deprecation.
    const rows = await db
      .select(MEDIA_ASSET_COLUMNS)
      .from(mediaAssets)
      .where(listed)
      .orderBy(desc(mediaAssets.createdAt))
      .limit(pageSize)
      .offset(Math.max(0, (page - 1) * pageSize));
    const countRows = await db
      .select({ n: count() })
      .from(mediaAssets)
      .where(listed);
    return {
      assets: rows as unknown as MediaAsset[],
      total: countRows[0]?.n ?? 0,
    };
  });
}

/** How many images the Library lists (the Library tab's count). */
export async function countLibraryAssets(storeId: string): Promise<number> {
  const rows = await withService((db) =>
    db
      .select({ n: count() })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.storeId, storeId),
          notInArray(mediaAssets.source, [...LIBRARY_HIDDEN_SOURCES]),
        ),
      ),
  );
  return rows[0]?.n ?? 0;
}
