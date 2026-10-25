import Link from "next/link";
import { Plus } from "lucide-react";
import { ThemesTabs, type ThemesTabKey } from "./themes-tabs";

// ---------------------------------------------------------------------------
// The Themes page's heading, its "New theme" button and its two tabs, shared
// by the Catalog tab (themes/page.tsx) and the Theme Studio tab
// (themes/studio/page.tsx). A server component: the ids below are plain
// strings here, which a constant exported from the client tabs module would
// not be in a server component.
// ---------------------------------------------------------------------------

/** The open tab's panel; each page renders it with these ids. */
export const THEMES_PANEL_ID = "themes-tabpanel";

export const THEMES_TAB_IDS: Record<ThemesTabKey, string> = {
  catalog: "themes-tab-catalog",
  studio: "themes-tab-studio",
};

export function ThemesHeader({
  tab,
  catalogCount,
  studioCount,
}: {
  tab: ThemesTabKey;
  catalogCount: number | null;
  studioCount: number | null;
}) {
  return (
    <div className="space-y-4">
      <header className="dash-page-header row flex-wrap">
        <div className="min-w-0">
          <h1>Themes</h1>
          <p>
            The catalog merchants pick from in their store&apos;s Theme library,
            and Theme Studio, where new themes are designed, checked and
            published.
          </p>
        </div>
        <Link
          href="/dashboard/themes/studio/new"
          className="dash-btn dash-btn-primary shrink-0 pointer-coarse:min-h-11"
        >
          <Plus aria-hidden className="h-4 w-4" /> New theme
        </Link>
      </header>
      <ThemesTabs
        selected={tab}
        counts={{ catalog: catalogCount, studio: studioCount }}
        panelId={THEMES_PANEL_ID}
        tabId={THEMES_TAB_IDS}
      />
    </div>
  );
}
