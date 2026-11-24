import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { SECTIONS, getSection } from "../../lib/permissions";
import { navIcons } from "../../nav-icons";
import {
  SETTINGS_NAV,
  SETTINGS_NAV_ITEMS,
  activeSettingsItem,
  inSettingsFrame,
  settingsItemMatches,
  settingsOwnerOverride,
} from "./settings-nav";

const APP = join(__dirname, "..", "..", "..");
const GROUP = join(APP, "dashboard", "(settings)");

/** The page under app/dashboard/(settings), the route group whose one layout
 *  mounts the settings frame (a route group adds nothing to the address). */
function pageInGroup(href: string): boolean {
  const parts = href.split("/").filter(Boolean).slice(1); // drop "dashboard"
  return existsSync(join(GROUP, ...parts, "page.tsx"));
}

/** The page anywhere under app/, inside the group or not. */
function pageExists(href: string): boolean {
  const parts = href.split("/").filter(Boolean);
  return existsSync(join(APP, ...parts, "page.tsx")) || pageInGroup(href);
}

describe("settings menu registry", () => {
  it("has unique keys and hrefs", () => {
    const keys = SETTINGS_NAV_ITEMS.map((i) => i.key);
    const hrefs = SETTINGS_NAV_ITEMS.map((i) => i.href);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("points every item at a real page, an existing icon and a real permission", () => {
    for (const item of SETTINGS_NAV_ITEMS) {
      expect(pageExists(item.href), item.href).toBe(true);
      expect(item.icon in navIcons, item.key).toBe(true);
      if (item.section) {
        expect(
          SECTIONS.some((s) => s.key === item.section),
          item.key,
        ).toBe(true);
      }
    }
  });

  it("★ lists every Settings page the sidebar knows", () => {
    // A Settings child, or a section nested under Settings, that the menu
    // forgot would be reachable from nowhere: the sidebar no longer shows a
    // Settings panel on these pages.
    const settings = SECTIONS.find((s) => s.key === "settings")!;
    const expected = [
      ...(settings.children ?? []).map((c) => c.href),
      ...SECTIONS.filter((s) => s.parent === "settings").map((s) => s.href),
    ];
    const hrefs = SETTINGS_NAV_ITEMS.map((i) => i.href);
    for (const href of expected) expect(hrefs, href).toContain(href);
  });

  it("lists the storefront pages: Storefront, Branding, Website settings and the Website Builder", () => {
    const online = SETTINGS_NAV.find((g) => g.label === "Online store")!;
    expect(online.items.map((i) => i.href)).toEqual([
      "/dashboard/storefront",
      "/dashboard/branding",
      "/dashboard/builder/settings",
      "/dashboard/builder",
    ]);
    expect(online.items.find((i) => i.key === "builder")?.newTab).toBe(true);
  });

  it("renders every wrapped page inside the settings frame", () => {
    expect(existsSync(join(GROUP, "layout.tsx"))).toBe(true);
    for (const item of SETTINGS_NAV_ITEMS.filter((i) => i.wrapped)) {
      expect(pageInGroup(item.href), item.href).toBe(true);
    }
  });

  it("never wraps a page that leaves Settings, or a printable page", () => {
    for (const item of SETTINGS_NAV_ITEMS.filter((i) => !i.wrapped)) {
      expect(pageInGroup(item.href), item.href).toBe(false);
    }
    // The printable invoice and credit note stay outside the group, bare.
    expect(
      existsSync(
        join(APP, "dashboard", "plans", "invoices", "[id]", "page.tsx"),
      ),
    ).toBe(true);
    expect(existsSync(join(GROUP, "plans", "invoices", "[id]"))).toBe(false);
  });

  it("takes each section page's label, address and icon from permissions.ts", () => {
    for (const item of SETTINGS_NAV_ITEMS) {
      // General and Website settings are written inline: no section names
      // them (Website settings uses the builder permission, not its page).
      if (item.key === "general" || item.key === "website-settings") continue;
      if (!item.section || item.section === "settings") continue;
      const section = getSection(item.section)!;
      expect(item.label, item.key).toBe(section.label);
      expect(item.href, item.key).toBe(section.href);
      expect(item.icon, item.key).toBe(section.icon);
    }
  });
});

describe("activeSettingsItem", () => {
  it("marks nothing open on the Settings home, which is only the menu", () => {
    expect(activeSettingsItem("/dashboard/settings")).toBeUndefined();
    expect(activeSettingsItem("/dashboard/settings/")).toBeUndefined();
    expect(activeSettingsItem("/dashboard/settings/general")?.key).toBe(
      "general",
    );
  });

  it("picks the longest matching page", () => {
    expect(
      activeSettingsItem("/dashboard/settings/notifications/all")?.key,
    ).toBe("notifications");
    expect(
      activeSettingsItem("/dashboard/channels/whatsapp/templates")?.key,
    ).toBe("channels");
    expect(activeSettingsItem("/dashboard/builder/settings")?.key).toBe(
      "website-settings",
    );
  });

  it("never claims the Website Builder or Logs, which leave Settings", () => {
    expect(activeSettingsItem("/dashboard/builder")).toBeUndefined();
    expect(activeSettingsItem("/dashboard/logs")).toBeUndefined();
    expect(activeSettingsItem("/dashboard/logs/email-logs")).toBeUndefined();
    expect(activeSettingsItem("/dashboard/orders")).toBeUndefined();
    expect(activeSettingsItem("/dashboard/settings/shipping")?.key).toBe(
      "shipping",
    );
  });
});

/** Every page under app/dashboard outside the (settings) route group, as the
 *  address it serves (route groups dropped, a dynamic segment as "x"). */
function pagesOutsideGroup(dir = join(APP, "dashboard")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) {
      if (name === "page.tsx") {
        const parts = relative(APP, dir)
          .split(sep)
          .filter((p) => !p.startsWith("("))
          .map((p) => (p.startsWith("[") ? "x" : p));
        out.push("/" + parts.join("/"));
      }
      continue;
    }
    if (name === "(settings)") continue;
    out.push(...pagesOutsideGroup(path));
  }
  return out;
}

describe("inSettingsFrame", () => {
  it("is true on the Settings pages, wherever their address", () => {
    expect(inSettingsFrame("/dashboard/settings")).toBe(true);
    expect(inSettingsFrame("/dashboard/settings/general")).toBe(true);
    expect(inSettingsFrame("/dashboard/admins")).toBe(true);
    expect(inSettingsFrame("/dashboard/plans/invoices")).toBe(true);
    expect(inSettingsFrame("/dashboard/branding")).toBe(true);
    expect(inSettingsFrame("/dashboard/builder/settings")).toBe(true);
  });

  it("is false for the printable invoice and credit note", () => {
    expect(inSettingsFrame("/dashboard/plans/invoices/abc")).toBe(false);
    expect(inSettingsFrame("/dashboard/plans/credit-notes/abc")).toBe(false);
    expect(activeSettingsItem("/dashboard/plans/invoices/abc")).toBeUndefined();
  });

  it("is false outside Settings", () => {
    expect(inSettingsFrame("/dashboard/products")).toBe(false);
    expect(inSettingsFrame("/dashboard/builder")).toBe(false);
    expect(inSettingsFrame("/dashboard/logs")).toBe(false);
  });

  it("★ claims no page that renders outside the route group", () => {
    // A page below a framed address but outside app/dashboard/(settings) has
    // no frame, so the sidebar must keep its panel there: list it in
    // UNFRAMED_PREFIXES.
    const pages = pagesOutsideGroup();
    expect(pages).toContain("/dashboard/plans/invoices/x");
    expect(pages.filter((p) => inSettingsFrame(p))).toEqual([]);
  });
});

describe("settingsOwnerOverride", () => {
  it("gives Website settings to Storefront", () => {
    expect(settingsOwnerOverride("/dashboard/builder/settings")).toBe(
      "/dashboard/storefront",
    );
  });

  it("is null for every other page", () => {
    expect(settingsOwnerOverride("/dashboard/builder")).toBeNull();
    expect(settingsOwnerOverride("/dashboard/admins")).toBeNull();
    expect(settingsOwnerOverride("/dashboard/branding")).toBeNull();
  });
});

describe("settingsItemMatches", () => {
  const taxes = SETTINGS_NAV_ITEMS.find((i) => i.key === "billing")!;
  const channels = SETTINGS_NAV_ITEMS.find((i) => i.key === "channels")!;

  it("finds a page by a word it does not show (GSTIN, Razorpay)", () => {
    expect(settingsItemMatches(taxes, "gstin")).toBe(true);
    expect(settingsItemMatches(channels, "Razorpay")).toBe(true);
    expect(settingsItemMatches(taxes, "razorpay")).toBe(false);
  });

  it("needs every typed word, and matches everything when empty", () => {
    expect(settingsItemMatches(taxes, "tax invoice")).toBe(true);
    expect(settingsItemMatches(taxes, "tax domain")).toBe(false);
    expect(settingsItemMatches(taxes, "  ")).toBe(true);
  });
});
