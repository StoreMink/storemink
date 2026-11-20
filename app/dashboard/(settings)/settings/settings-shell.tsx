import type { ReactNode } from "react";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import { getSection } from "@/app/dashboard/lib/permissions";
import { SETTINGS_NAV } from "./settings-nav";
import { SettingsFrame, type SettingsRailGroup } from "./settings-frame";

/**
 * Wraps a settings page in the Settings frame: the settings menu on the left,
 * the page beside it (Shopify admin's layout).
 *
 * Every route the menu lists as `wrapped` renders through this, from the one
 * layout of the app/dashboard/(settings) route group, so the frame mounts once
 * across every settings page.
 *
 * The menu is filtered on the server with the viewer's `can()`, the same check
 * every page and the sidebar use, so it never shows a page they cannot open.
 * A page someone can see but not change is marked "View only".
 */
export async function SettingsShell({ children }: { children: ReactNode }) {
  const access = await getViewerAccess();
  if (!access) return <>{children}</>;

  const groups: SettingsRailGroup[] = SETTINGS_NAV.map((group) => ({
    label: group.label,
    items: group.items
      .filter((item) => !item.section || access.can(item.section, "view"))
      .map((item) => {
        const actions = item.section
          ? (getSection(item.section)?.actions ?? [])
          : [];
        return {
          key: item.key,
          label: item.label,
          href: item.href,
          icon: item.icon,
          newTab: item.newTab ?? false,
          keywords: item.keywords,
          viewOnly:
            !!item.section &&
            actions.includes("manage") &&
            !access.can(item.section, "manage"),
        };
      }),
  })).filter((group) => group.items.length > 0);

  return <SettingsFrame groups={groups}>{children}</SettingsFrame>;
}
