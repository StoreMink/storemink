import { redirect } from "next/navigation";
import { listDemoStoreSlugs } from "@/app/actions/platform";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { listThemeStudioProjectsForConsole } from "@/lib/theme-studio/progress";
import { getThemeCatalog } from "@/lib/themes/runtime-registry";
import { ThemesPanel } from "../themes-panel";
import { canManage, requireOperator } from "../require-operator";
import { THEMES_PANEL_ID, THEMES_TAB_IDS, ThemesHeader } from "./themes-header";

export const metadata = { title: "Themes · StoreMink Admin" };

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";

// Themes, Catalog tab (wave TS-2, builder 2D; plan section 4): today's
// catalog panel, unchanged in what it offers, beside the Theme Studio tab
// (themes/studio/page.tsx).
//
// Seeding a demo store writes real rows, so this stays superadmin-only: a
// member is redirected rather than shown a panel whose every button fails.
// (The read-only-view rule in require-operator.ts applies where there IS a
// useful read-only view; a seeder has none.)

/** How many Studio themes there are, for the Theme Studio tab's count; null
 * when it can't be read, so the Catalog tab never fails on it. */
async function studioThemeCount(): Promise<number | null> {
  if (!(await getThemeStudioActor())) return null;
  try {
    const list = await withService((db) =>
      listThemeStudioProjectsForConsole(db, { filter: "all" }),
    );
    return list.counts.all;
  } catch (error) {
    logError("theme studio: count for the themes page failed", error);
    return null;
  }
}

export default async function ThemesPage() {
  const viewer = await requireOperator();
  if (!canManage(viewer)) redirect("/dashboard");

  // Which theme demos actually exist right now, so the panel can show "seed"
  // vs "reseed" honestly rather than offering a Preview link to a 404. Demo
  // stores are not merchants, so the Stores list no longer carries them.
  const [liveSlugs, themes, studioCount] = await Promise.all([
    listDemoStoreSlugs(),
    getThemeCatalog(),
    studioThemeCount(),
  ]);
  const demoSlugs = new Set(themes.map((t) => t.demo.slug));
  const demoSlugsLive = liveSlugs.filter((slug) => demoSlugs.has(slug));

  return (
    <div className="studio-root w-full max-w-6xl space-y-6">
      <ThemesHeader
        tab="catalog"
        catalogCount={themes.length}
        studioCount={studioCount}
      />
      <section
        role="tabpanel"
        id={THEMES_PANEL_ID}
        aria-labelledby={THEMES_TAB_IDS.catalog}
        className="studio-tabpanel"
      >
        <ThemesPanel
          rootDomain={ROOT_DOMAIN}
          demoSlugsLive={demoSlugsLive}
          themes={themes}
        />
      </section>
    </div>
  );
}
