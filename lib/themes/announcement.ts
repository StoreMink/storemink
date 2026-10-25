// ---------------------------------------------------------------------------
// The announcement bar — one line of copy above the header, the way Shopify
// themes carry a delivery promise, a sale or a season's opening line.
//
// A theme may ship one (`preset.announcement`, plan Phase 2c's last chrome
// candidate), and a merchant owns the bar from the Website Builder
// (`HeaderConfig.announcement`): enabled with empty text shows the theme's,
// text of their own replaces it, disabled shows none. Pure: no DB, no React,
// so the storefront layout, the header, the builder and the package contract
// all read the same rule. A type-only import from lib/chrome/types keeps this
// free of a cycle (that module imports `announcementHref` from here).
// ---------------------------------------------------------------------------

import type { StoreChrome } from "@/lib/chrome/types";
import type { ThemeDefinition } from "./types";

export interface ThemeAnnouncement {
  /** The bar's one line, 1–160 characters. */
  text: string;
  /** "" or a site path the bar links to (`/shop`, `/collections/sale`). */
  href?: string;
}

export const ANNOUNCEMENT_MAX_TEXT = 160;

/** The bar's link rule: a site path, or nothing. Never off-site, never a
 *  script — it renders as an `<a href>` on every page of the store. */
export function announcementHref(value: unknown): string {
  const href = typeof value === "string" ? value.trim().slice(0, 2048) : "";
  if (!href) return "";
  return href.startsWith("/") && !href.startsWith("//") ? href : "";
}

/** A theme's announcement as the storefront renders it, or undefined when
 *  the value holds no usable text (so a theme without one stores nothing). */
export function normalizeAnnouncement(
  raw: unknown,
): ThemeAnnouncement | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const text =
    typeof r.text === "string"
      ? r.text.trim().slice(0, ANNOUNCEMENT_MAX_TEXT)
      : "";
  if (!text) return undefined;
  const href = announcementHref(r.href);
  return href ? { text, href } : { text };
}

/** The package contract's strict report: what normalising would change. */
export function announcementIssues(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return ["definition.preset.announcement must be an object."];
  const issues: string[] = [];
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (key !== "text" && key !== "href")
      issues.push(
        `definition.preset.announcement.${key} is not an announcement field.`,
      );
  }
  const text = typeof r.text === "string" ? r.text.trim() : "";
  if (!text) issues.push("definition.preset.announcement.text is required.");
  else if (text.length > ANNOUNCEMENT_MAX_TEXT)
    issues.push(
      `definition.preset.announcement.text exceeds ${ANNOUNCEMENT_MAX_TEXT} characters.`,
    );
  else if (text !== r.text)
    issues.push(
      "definition.preset.announcement.text carries surrounding whitespace.",
    );
  if (r.href !== undefined) {
    if (typeof r.href !== "string" || r.href !== announcementHref(r.href))
      issues.push(
        'definition.preset.announcement.href must be "" or a site path starting with "/".',
      );
    if (r.href === "")
      issues.push(
        "definition.preset.announcement.href is empty; omit it instead.",
      );
  }
  return issues;
}

/**
 * Carry a theme's announcement line onto a store whose bar is enabled and
 * empty (every row saved before the field existed, and a merchant who has
 * not written one). Merchant text wins; a disabled bar stays disabled; a
 * theme without an announcement changes nothing.
 *
 * ★ `line` is the theme's `preset.announcement`, or the copy of it the
 *   storefront layout handed a preview frame (`themeChromeDefaults` in
 *   ./footer): read with the same rule either way, because the frame receives
 *   it over the wire. ★ A chrome with no bar at all (one a preview frame was
 *   sent by an older sender) is left as it is rather than read through.
 */
export function withAnnouncementLine(
  chrome: StoreChrome,
  line: unknown,
): StoreChrome {
  const current = chrome.header?.announcement;
  if (!current?.enabled || current.text) return chrome;
  const themed = normalizeAnnouncement(line);
  if (!themed) return chrome;
  return {
    ...chrome,
    header: {
      ...chrome.header,
      announcement: {
        enabled: true,
        text: themed.text,
        href: themed.href ?? "",
      },
    },
  };
}

/** `withAnnouncementLine` with the pinned theme's own bar. */
export function withThemeAnnouncement(
  chrome: StoreChrome,
  theme: ThemeDefinition | null,
): StoreChrome {
  return withAnnouncementLine(chrome, theme?.preset.announcement);
}

/** The bar the storefront shows for this chrome, or null for none. */
export function activeAnnouncement(
  chrome: Pick<StoreChrome, "header">,
): { text: string; href: string } | null {
  const a = chrome.header.announcement;
  if (!a?.enabled || !a.text) return null;
  return { text: a.text, href: a.href };
}
