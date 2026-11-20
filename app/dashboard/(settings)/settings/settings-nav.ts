// The Settings menu: every page the in-page settings menu lists, grouped the
// way a merchant looks for them (Shopify admin's settings shape).
//
// Pure and client-safe (no server imports), so the dashboard sidebar can ask
// whether a path belongs to Settings, and the menu can be tested without a
// database.
//
// ★ A PAGE'S PERMISSION IS ITS OWN SECTION KEY, from lib/permissions.ts. The
// menu is filtered with the same `can()` the sidebar and every page use, so it
// never lists a page the viewer cannot open. `section: null` is a page anyone
// signed in may open (their own account).
//
// ★ `wrapped` SAYS THE PAGE RENDERS INSIDE THE SETTINGS FRAME (it lives in
// the app/dashboard/(settings) route group). Logs keeps its own rail and the
// Website Builder opens full screen in a new tab, so both are links out of
// Settings and never count as "inside Settings" for the sidebar.
//
// ★ LABEL, HREF AND ICON COME FROM lib/permissions.ts, the single source of
// truth for the dashboard's pages: a section (`fromSection`) or a child of
// the Settings section (`fromSettingsChild`). So a rename there reaches the
// sidebar, the search, the role editor and this menu together. Only the two
// pages no section names (General and Website settings) are written here.
// This file keeps the grouping, the search keywords and `wrapped`.

import type { NavIconKey } from "../../nav-icons";
import { getSection } from "../../lib/permissions";
import { normalizePath, pathMatches } from "../../nav-path";

export const SETTINGS_HOME = "/dashboard/settings";
export const SETTINGS_GENERAL = "/dashboard/settings/general";

export interface SettingsNavItem {
  key: string;
  label: string;
  href: string;
  icon: NavIconKey;
  /** The permission section that opens the page; null = every signed-in admin. */
  section: string | null;
  /** Renders inside the settings frame. False for links that leave Settings. */
  wrapped: boolean;
  /** Opens in a new tab (the Website Builder). */
  newTab?: boolean;
  /** The main sidebar item kept highlighted while this page is open (only
   *  wrapped pages have one: the others are not inside Settings). */
  owner?: string;
  /** Extra words the menu's search matches, beside the label. */
  keywords: string[];
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

const SETTINGS_OWNER = "/dashboard/settings";
const STOREFRONT_OWNER = "/dashboard/storefront";

type ItemExtras = Pick<SettingsNavItem, "key" | "wrapped" | "keywords"> &
  Partial<Pick<SettingsNavItem, "owner">>;

/** A page that is a dashboard section: its label, href, icon and permission. */
function fromSection(sectionKey: string, extras: ItemExtras): SettingsNavItem {
  const section = getSection(sectionKey);
  if (!section) throw new Error(`settings menu: no section "${sectionKey}"`);
  return {
    label: section.label,
    href: section.href,
    icon: section.icon,
    section: section.key,
    ...(section.openInNewTab ? { newTab: true } : {}),
    ...extras,
  };
}

/** A page listed as a child of the Settings section (Settings permission,
 *  or none for Account, which every signed-in admin may open). */
function fromSettingsChild(
  href: string,
  extras: ItemExtras & { section?: string | null },
): SettingsNavItem {
  const child = getSection("settings")?.children?.find((c) => c.href === href);
  if (!child) throw new Error(`settings menu: no Settings child "${href}"`);
  return {
    label: child.label,
    href: child.href,
    icon: child.icon ?? "settings",
    section: "settings",
    ...extras,
  };
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: "Store",
    items: [
      {
        key: "general",
        label: "General",
        href: SETTINGS_GENERAL,
        icon: "settings",
        section: "settings",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["store name", "address", "time zone", "timezone", "plan"],
      },
      fromSettingsChild("/dashboard/settings/domain", {
        key: "domain",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["custom domain", "dns", "url", "web address"],
      }),
      fromSettingsChild("/dashboard/settings/policies", {
        key: "policies",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["terms", "refund", "privacy", "shipping policy"],
      }),
    ],
  },
  {
    label: "Online store",
    items: [
      fromSection("themes", {
        key: "storefront",
        wrapped: true,
        owner: STOREFRONT_OWNER,
        keywords: ["theme", "customise", "customize", "design"],
      }),
      fromSection("branding", {
        key: "branding",
        wrapped: true,
        owner: STOREFRONT_OWNER,
        keywords: ["logo", "colour", "color", "brand voice", "social links"],
      }),
      {
        key: "website-settings",
        label: "Website settings",
        href: "/dashboard/builder/settings",
        icon: "custom_code",
        section: "builder",
        wrapped: true,
        owner: STOREFRONT_OWNER,
        keywords: ["custom code", "html", "storefront settings"],
      },
      fromSection("builder", {
        key: "builder",
        wrapped: false,
        keywords: ["pages", "homepage", "header", "footer", "menu"],
      }),
    ],
  },
  {
    label: "Selling",
    items: [
      fromSettingsChild("/dashboard/settings/shipping", {
        key: "shipping",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["delivery", "rates", "courier", "free shipping"],
      }),
      fromSection("channels", {
        key: "channels",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: [
          "razorpay",
          "shiprocket",
          "whatsapp",
          "twilio",
          "sms",
          "payments",
        ],
      }),
      fromSection("billing", {
        key: "billing",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["gst", "gstin", "tax", "invoice"],
      }),
    ],
  },
  {
    label: "People",
    items: [
      fromSection("admins", {
        key: "admins",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["team", "invite", "cashier", "manager"],
      }),
      fromSection("roles", {
        key: "roles",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["access", "permissions"],
      }),
    ],
  },
  {
    label: "Messages",
    items: [
      fromSection("notifications", {
        key: "notifications",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["email", "sms", "alerts", "templates"],
      }),
      fromSettingsChild("/dashboard/settings/notices", {
        key: "notices",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["blocked", "takedown", "notice"],
      }),
    ],
  },
  {
    label: "Data",
    items: [
      fromSettingsChild("/dashboard/settings/analytics", {
        key: "analytics",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["google analytics", "ga4", "meta pixel", "tracking"],
      }),
      fromSection("activity", {
        key: "logs",
        wrapped: false,
        keywords: ["activity", "email logs", "failures", "import", "export"],
      }),
    ],
  },
  {
    label: "You and your plan",
    items: [
      fromSettingsChild("/dashboard/settings/account", {
        key: "account",
        // Every signed-in admin may change their own account.
        section: null,
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["password", "profile", "mobile", "phone", "name"],
      }),
      fromSection("ai", {
        key: "plans",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: [
          "plan",
          "upgrade",
          "subscription",
          "mink credits",
          "invoices",
        ],
      }),
    ],
  },
];

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = SETTINGS_NAV.flatMap(
  (g) => g.items,
);

/**
 * The menu item for this path: the longest wrapped href that matches, and
 * General on the Settings home (which shows General beside the menu).
 */
export function activeSettingsItem(
  pathname: string,
  items: SettingsNavItem[] = SETTINGS_NAV_ITEMS,
): SettingsNavItem | undefined {
  const path = normalizePath(pathname);
  if (path === SETTINGS_HOME) {
    return items.find((i) => i.href === SETTINGS_GENERAL);
  }
  return items
    .filter((i) => i.wrapped && pathMatches(path, i.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

/** The main sidebar item to keep highlighted on a settings page, or null. */
export function settingsOwnerHref(pathname: string): string | null {
  const path = normalizePath(pathname);
  if (pathMatches(path, SETTINGS_HOME)) return SETTINGS_OWNER;
  return activeSettingsItem(path)?.owner ?? null;
}

/** Search: the label or one of the keywords contains every typed word. */
export function settingsItemMatches(
  item: Pick<SettingsNavItem, "label" | "keywords">,
  query: string,
): boolean {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [item.label, ...item.keywords].join(" ").toLowerCase();
  return words.every((w) => haystack.includes(w));
}
