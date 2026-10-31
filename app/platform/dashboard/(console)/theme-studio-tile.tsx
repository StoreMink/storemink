import Link from "next/link";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import {
  listThemeStudioProjectsForConsole,
  type ThemeStudioList,
} from "@/lib/theme-studio/progress";

// ---------------------------------------------------------------------------
// The console Overview's Theme Studio tile (wave TS-2, builder 2D; plan
// section 9, Wave TS-2 table): "Theme Studio: 1 needs you, 2 ready to
// publish", each count a link to that filter of the Theme Studio list.
//
// ★ SUPERADMIN ONLY. Studio data is superadmin data (access.ts), so the tile
// checks the Studio's own gate before it reads anything, whatever its parent
// decided, and renders nothing for anyone else.
//
// ★ A READ THAT FAILS SAYS SO. The Overview's rule: zeroes are never shown
// as though they were the answer.
//
// ★ ONLY DASHBOARD CLASSES AND TOKENS. The console home is not under the
// Themes layout that loads the Studio's own stylesheet, so nothing here uses
// a `studio-` class.
// ---------------------------------------------------------------------------

type TileCounts = Pick<
  ThemeStudioList["counts"],
  "needs_you" | "ready" | "building"
>;

/** The tile's sentence. */
export function themeStudioTileWords(counts: TileCounts): string {
  const parts: string[] = [];
  if (counts.needs_you > 0) {
    parts.push(
      `${counts.needs_you} ${counts.needs_you === 1 ? "needs" : "need"} you`,
    );
  }
  if (counts.ready > 0) parts.push(`${counts.ready} ready to publish`);
  if (counts.building > 0) parts.push(`${counts.building} building`);
  return parts.length > 0
    ? `Theme Studio: ${parts.join(", ")}.`
    : "Theme Studio: nothing needs you.";
}

const LINK = "dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11";

/** What the tile shows while the list is read (the page streams around it). */
export function ThemeStudioTileFallback() {
  return (
    <section className="dash-card" aria-busy="true">
      <div className="dash-card-header">
        <h2 className="dash-card-title">Theme Studio</h2>
      </div>
      <p className="dash-card-body text-sm text-[var(--dash-text-2)]">
        Counting themes.
      </p>
    </section>
  );
}

export async function ThemeStudioTile() {
  const actor = await getThemeStudioActor();
  if (!actor) return null;

  let counts: TileCounts | null = null;
  try {
    const list = await withService((db) =>
      listThemeStudioProjectsForConsole(db, { filter: "all" }),
    );
    counts = list.counts;
  } catch (error) {
    logError("theme studio: overview tile read failed", error);
  }

  return (
    <section className="dash-card" aria-labelledby="theme-studio-tile-title">
      <div className="dash-card-header flex-wrap">
        <h2 id="theme-studio-tile-title" className="dash-card-title">
          Theme Studio
        </h2>
        <Link href="/dashboard/themes/studio" className={LINK}>
          Open Theme Studio
        </Link>
      </div>
      <div className="dash-card-body space-y-3">
        {counts ? (
          <>
            <p className="text-sm text-[var(--dash-text)]">
              {themeStudioTileWords(counts)}
            </p>
            {counts.needs_you > 0 || counts.ready > 0 ? (
              <div className="flex flex-wrap gap-2">
                {counts.needs_you > 0 ? (
                  <Link
                    href="/dashboard/themes/studio?filter=needs_you"
                    className={LINK}
                  >
                    Needs you ({counts.needs_you})
                  </Link>
                ) : null}
                {counts.ready > 0 ? (
                  <Link
                    href="/dashboard/themes/studio?filter=ready"
                    className={LINK}
                  >
                    Ready to publish ({counts.ready})
                  </Link>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <p role="alert" className="text-sm text-[var(--dash-text)]">
            Theme Studio figures are unavailable. Open Theme Studio to see each
            theme.
          </p>
        )}
      </div>
    </section>
  );
}
