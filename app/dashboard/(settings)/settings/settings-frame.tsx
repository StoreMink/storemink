"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ExternalLink, Search, X } from "lucide-react";
import { navIcons, type NavIconKey } from "../../nav-icons";
import { normalizePath } from "../../nav-path";
import {
  STORE_NOTICES_HREF,
  unreadBadge,
  useUnreadCounts,
} from "../../components/unread-counts-context";
import {
  SETTINGS_HOME,
  activeSettingsItem,
  settingsItemMatches,
} from "./settings-nav";
import "./settings-shell.css";

export interface SettingsRailItem {
  key: string;
  label: string;
  href: string;
  icon: NavIconKey;
  newTab: boolean;
  viewOnly: boolean;
  keywords: string[];
}

export interface SettingsRailGroup {
  label: string;
  items: SettingsRailItem[];
}

/**
 * The Settings frame: the settings menu, and the open page beside it.
 *
 * ★ IT FOLLOWS THE FRAME'S OWN WIDTH, NOT THE WINDOW'S (a container query in
 * settings-shell.css), because the Mink panel and the resizable sidebar both
 * narrow it. When it is narrow, the Settings home shows only the menu and a
 * settings page shows only itself, with a link back to the menu.
 */
export function SettingsFrame({
  groups,
  children,
}: {
  groups: SettingsRailGroup[];
  children: ReactNode;
}) {
  const pathname = usePathname() ?? SETTINGS_HOME;
  const isHome = normalizePath(pathname) === SETTINGS_HOME;

  return (
    <div className="sm-settings" data-home={isHome ? "true" : "false"}>
      <div className="sm-settings-grid">
        <SettingsRail groups={groups} pathname={pathname} />
        <div className="sm-settings-main">
          <Link href={SETTINGS_HOME} className="sm-settings-back">
            <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
            Settings
          </Link>
          {children}
        </div>
      </div>
    </div>
  );
}

export function SettingsRail({
  groups,
  pathname,
}: {
  groups: SettingsRailGroup[];
  pathname: string;
}) {
  const [query, setQuery] = useState("");
  const { storemink } = useUnreadCounts();
  const noticesBadge = unreadBadge(storemink);
  const activeKey = activeSettingsItem(pathname)?.key;

  const shown = useMemo(() => {
    if (!query.trim()) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((item) => settingsItemMatches(item, query)),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, query]);

  return (
    <aside className="sm-settings-rail">
      <div className="sm-settings-rail-inner">
        <div className="sm-settings-rail-title">Settings</div>
        <div className="sm-settings-search">
          <Search className="sm-settings-search-icon" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Search settings"
            aria-label="Search settings"
          />
          {query ? (
            <button
              type="button"
              className="sm-settings-search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>

        <nav aria-label="Settings">
          {shown.length === 0 ? (
            <p className="sm-settings-empty">No settings match.</p>
          ) : (
            shown.map((group) => (
              <div key={group.label} className="sm-settings-group">
                <div className="sm-settings-group-label">{group.label}</div>
                <ul>
                  {group.items.map((item) => {
                    const Icon = navIcons[item.icon];
                    const active = item.key === activeKey;
                    const badge =
                      item.href === STORE_NOTICES_HREF ? noticesBadge : null;
                    return (
                      <li key={item.key}>
                        <Link
                          href={item.href}
                          className={`sm-settings-item ${active ? "active" : ""}`}
                          aria-current={active ? "page" : undefined}
                          {...(item.newTab
                            ? { target: "_blank", rel: "noopener noreferrer" }
                            : {})}
                        >
                          <Icon
                            className="sm-settings-item-icon"
                            strokeWidth={2}
                            aria-hidden
                          />
                          <span className="sm-settings-item-label">
                            {item.label}
                            {item.newTab ? (
                              <span className="sr-only">
                                {" "}
                                (opens in a new tab)
                              </span>
                            ) : null}
                          </span>
                          {badge ? (
                            <span
                              className="sm-settings-badge"
                              aria-label={`${badge} unread`}
                            >
                              {badge}
                            </span>
                          ) : item.viewOnly ? (
                            <span className="sm-settings-viewonly">
                              View only
                            </span>
                          ) : item.newTab ? (
                            <ExternalLink
                              className="sm-settings-item-out"
                              aria-hidden
                            />
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </nav>
      </div>
    </aside>
  );
}
