"use client";

import { useRef } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// The Themes page's two tabs, Catalog and Theme Studio (wave TS-2, builder
// 2D; plan section 4, "Three screens instead of nine").
//
// ★ EACH TAB IS AN ADDRESS. Catalog is /dashboard/themes and Theme Studio is
// /dashboard/themes/studio (the list's old address, which operator notices
// link to), so a tab is a link that loads its own page and the open tab
// survives a reload. The tab list still behaves like one: the arrow keys,
// Home and End move between the tabs, and Enter or Space opens one.
// ---------------------------------------------------------------------------

export type ThemesTabKey = "catalog" | "studio";

const TABS: { key: ThemesTabKey; label: string; href: string }[] = [
  { key: "catalog", label: "Catalog", href: "/dashboard/themes" },
  { key: "studio", label: "Theme Studio", href: "/dashboard/themes/studio" },
];

export function ThemesTabs({
  selected,
  counts,
  panelId,
  tabId,
}: {
  selected: ThemesTabKey;
  /** A tab's count, or null when it could not be read (no number shown). */
  counts: Record<ThemesTabKey, number | null>;
  /** The id of the open tab's panel, which each page renders. */
  panelId: string;
  /** The id of each tab, which the panel names as its label. */
  tabId: Record<ThemesTabKey, string>;
}) {
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);

  function onKeyDown(
    event: React.KeyboardEvent<HTMLAnchorElement>,
    index: number,
  ) {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else if (event.key === " ") {
      // A link opens on Enter by itself; a tab opens on Space too.
      event.preventDefault();
      event.currentTarget.click();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
  }

  return (
    <div role="tablist" aria-label="Themes" className="studio-tabs">
      {TABS.map((tab, index) => {
        const on = tab.key === selected;
        const count = counts[tab.key];
        return (
          <Link
            key={tab.key}
            ref={(node) => {
              refs.current[index] = node;
            }}
            href={tab.href}
            id={tabId[tab.key]}
            role="tab"
            aria-selected={on}
            aria-controls={on ? panelId : undefined}
            tabIndex={on ? 0 : -1}
            className="studio-tab"
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
            {count !== null ? (
              <span className="studio-tab-count">{count}</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
