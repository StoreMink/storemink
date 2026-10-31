import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { getThemeStudioConfig } from "@/lib/theme-studio/config";
import {
  listThemeStudioProjectsForConsole,
  type ThemeStudioList,
  type ThemeStudioListFilter,
} from "@/lib/theme-studio/progress";
import { getThemeCatalog } from "@/lib/themes/runtime-registry";
import { requireOperator } from "../../require-operator";
import {
  THEMES_PANEL_ID,
  THEMES_TAB_IDS,
  ThemesHeader,
} from "../themes-header";
import { parseListFilter, StudioList } from "./studio-list";
import { SuperadminOnly } from "./studio-ui";

export const metadata = { title: "Theme Studio · StoreMink Admin" };

// ---------------------------------------------------------------------------
// Themes, Theme Studio tab (wave TS-2, builder 2D; plan section 4). The old
// list address, /dashboard/themes/studio, opens this tab: operator notices
// link here (lib/notifications/render.ts themeStudioUrl).
//
// ★ Every Studio page gates itself (require-operator.ts explains why the
// layout's redirect is not enough), and then gates AGAIN on superadmin: a
// platform member is an operator but must not see Studio prompts, references
// or drafts, so a member sees today's notice and nothing is read for them.
// The reads below run under service scope, so this is the boundary.
// ---------------------------------------------------------------------------

async function readList(
  filter: ThemeStudioListFilter,
): Promise<ThemeStudioList | null> {
  try {
    return await withService((db) =>
      listThemeStudioProjectsForConsole(db, { filter }),
    );
  } catch (error) {
    logError("theme studio: list read failed", error, { filter });
    return null;
  }
}

async function catalogCount(): Promise<number | null> {
  try {
    return (await getThemeCatalog()).length;
  } catch {
    return null;
  }
}

export default async function ThemeStudioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const actor = await getThemeStudioActor();
  if (!actor) {
    return (
      <div className="studio-root w-full max-w-6xl space-y-6">
        <header className="dash-page-header">
          <h1>Themes</h1>
        </header>
        <SuperadminOnly />
      </div>
    );
  }

  const filter = parseListFilter((await searchParams).filter);
  const config = getThemeStudioConfig();
  const [list, catalog] = await Promise.all([readList(filter), catalogCount()]);

  return (
    <div className="studio-root w-full max-w-6xl space-y-6">
      <ThemesHeader
        tab="studio"
        catalogCount={catalog}
        studioCount={list?.counts.all ?? null}
      />
      <section
        role="tabpanel"
        id={THEMES_PANEL_ID}
        aria-labelledby={THEMES_TAB_IDS.studio}
        className="studio-tabpanel space-y-5"
      >
        {!config.generationEnabled ? (
          <p className="studio-notice" data-tone="warning">
            Building is switched off on this deployment. You can still create
            themes; nothing builds until it is back on.
          </p>
        ) : config.provider === "fake" ? (
          <p className="studio-notice" data-tone="info">
            This deployment uses the offline test provider: builds make no model
            call and produce a placeholder design.
          </p>
        ) : null}
        {list ? (
          <StudioList list={list} filter={filter} />
        ) : (
          <p className="studio-notice" data-tone="warning" role="alert">
            The theme list couldn&apos;t be read just now. Reload the page to
            try again.
          </p>
        )}
      </section>
    </div>
  );
}
