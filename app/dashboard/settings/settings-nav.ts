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
// ★ `wrapped` SAYS THE PAGE RENDERS INSIDE THE SETTINGS FRAME (its route has
// the settings layout). Logs keeps its own rail and the Website Builder opens
// full screen in a new tab, so both are links out of Settings and never count
// as "inside Settings" for the sidebar.

import type { NavIconKey } from "../nav-icons";
import { NOTICES } from "@/lib/moderation/copy";

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
  /** The main sidebar item kept highlighted while this page is open. */
  owner: string;
  /** Extra words the menu's search matches, beside the label. */
  keywords: string[];
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

const SETTINGS_OWNER = "/dashboard/settings";
const STOREFRONT_OWNER = "/dashboard/storefront";

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
      {
        key: "domain",
        label: "Domain",
        href: "/dashboard/settings/domain",
        icon: "globe",
        section: "settings",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["custom domain", "dns", "url", "web address"],
      },
      {
        key: "policies",
        label: "Policies",
        href: "/dashboard/settings/policies",
        icon: "billing",
        section: "settings",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["terms", "refund", "privacy", "shipping policy"],
      },
    ],
  },
  {
    label: "Online store",
    items: [
      {
        key: "storefront",
        label: "Storefront",
        href: "/dashboard/storefront",
        icon: "themes",
        section: "themes",
        wrapped: true,
        owner: STOREFRONT_OWNER,
        keywords: ["theme", "customise", "customize", "design"],
      },
      {
        key: "branding",
        label: "Branding",
        href: "/dashboard/branding",
        icon: "colors",
        section: "branding",
        wrapped: true,
        owner: STOREFRONT_OWNER,
        keywords: ["logo", "colour", "color", "brand voice", "social links"],
      },
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
      {
        key: "builder",
        label: "Website Builder",
        href: "/dashboard/builder",
        icon: "homepage",
        section: "builder",
        wrapped: false,
        newTab: true,
        owner: STOREFRONT_OWNER,
        keywords: ["pages", "homepage", "header", "footer", "menu"],
      },
    ],
  },
  {
    label: "Selling",
    items: [
      {
        key: "shipping",
        label: "Shipping & delivery",
        href: "/dashboard/settings/shipping",
        icon: "shipping",
        section: "settings",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["delivery", "rates", "courier", "free shipping"],
      },
      {
        key: "channels",
        label: "Channels",
        href: "/dashboard/channels",
        icon: "channels",
        section: "channels",
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
      },
      {
        key: "billing",
        label: "Taxes & invoices",
        href: "/dashboard/billing",
        icon: "billing",
        section: "billing",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["gst", "gstin", "tax", "invoice"],
      },
    ],
  },
  {
    label: "People",
    items: [
      {
        key: "admins",
        label: "Staff",
        href: "/dashboard/admins",
        icon: "users",
        section: "admins",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["team", "invite", "cashier", "manager"],
      },
      {
        key: "roles",
        label: "Roles & permissions",
        href: "/dashboard/roles",
        icon: "roles",
        section: "roles",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["access", "permissions"],
      },
    ],
  },
  {
    label: "Messages",
    items: [
      {
        key: "notifications",
        label: "Notifications",
        href: "/dashboard/settings/notifications",
        icon: "notifications",
        section: "notifications",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["email", "sms", "alerts", "templates"],
      },
      {
        key: "notices",
        label: NOTICES.navLabel,
        href: "/dashboard/settings/notices",
        icon: "mail",
        section: "settings",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["blocked", "takedown", "notice"],
      },
    ],
  },
  {
    label: "Data",
    items: [
      {
        key: "analytics",
        label: "Analytics tracking",
        href: "/dashboard/settings/analytics",
        icon: "analytics",
        section: "settings",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["google analytics", "ga4", "meta pixel", "tracking"],
      },
      {
        key: "logs",
        label: "Logs",
        href: "/dashboard/logs",
        icon: "activity",
        section: "activity",
        wrapped: false,
        owner: "/dashboard/logs",
        keywords: ["activity", "email logs", "failures", "import", "export"],
      },
    ],
  },
  {
    label: "You and your plan",
    items: [
      {
        key: "account",
        label: "Account",
        href: "/dashboard/settings/account",
        icon: "settings",
        section: null,
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: ["password", "profile", "mobile", "phone", "name"],
      },
      {
        key: "plans",
        label: "Plans & Billing",
        href: "/dashboard/plans",
        icon: "plans",
        section: "ai",
        wrapped: true,
        owner: SETTINGS_OWNER,
        keywords: [
          "plan",
          "upgrade",
          "subscription",
          "mink credits",
          "invoices",
        ],
      },
    ],
  },
];

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = SETTINGS_NAV.flatMap(
  (g) => g.items,
);

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The menu item for this path: the longest wrapped href that matches, and
 * General on the Settings home (which shows General beside the menu).
 */
export function activeSettingsItem(
  pathname: string,
  items: SettingsNavItem[] = SETTINGS_NAV_ITEMS,
): SettingsNavItem | undefined {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === SETTINGS_HOME) {
    return items.find((i) => i.href === SETTINGS_GENERAL);
  }
  return items
    .filter((i) => i.wrapped && matches(path, i.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

/** True when this path renders inside the settings frame. */
export function isSettingsPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return matches(path, SETTINGS_HOME) || activeSettingsItem(path) !== undefined;
}

/** The main sidebar item to keep highlighted on a settings page, or null. */
export function settingsOwnerHref(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (matches(path, SETTINGS_HOME)) return SETTINGS_OWNER;
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
