import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECTIONS } from "../lib/permissions";
import { navIcons } from "../nav-icons";
import {
  SETTINGS_NAV,
  SETTINGS_NAV_ITEMS,
  activeSettingsItem,
  isSettingsPath,
  settingsItemMatches,
  settingsOwnerHref,
} from "./settings-nav";

const APP = join(__dirname, "..", "..");

function pageExists(href: string): boolean {
  return existsSync(join(APP, ...href.split("/").filter(Boolean), "page.tsx"));
}

/** A layout.tsx in the page's folder or a folder above it, below /dashboard. */
function layoutWraps(href: string): boolean {
  const parts = href.split("/").filter(Boolean);
  for (let i = parts.length; i >= 2; i--) {
    if (existsSync(join(APP, ...parts.slice(0, i), "layout.tsx"))) return true;
  }
  return false;
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
    for (const item of SETTINGS_NAV_ITEMS.filter((i) => i.wrapped)) {
      // Plans & Billing wraps itself in its page, so the printable invoice
      // and credit note under it stay bare.
      if (item.href.startsWith("/dashboard/plans")) continue;
      expect(layoutWraps(item.href), item.href).toBe(true);
    }
  });
});

describe("activeSettingsItem", () => {
  it("shows General as open on the Settings home", () => {
    expect(activeSettingsItem("/dashboard/settings")?.key).toBe("general");
    expect(activeSettingsItem("/dashboard/settings/")?.key).toBe("general");
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
    expect(isSettingsPath("/dashboard/builder")).toBe(false);
    expect(isSettingsPath("/dashboard/logs/email-logs")).toBe(false);
    expect(isSettingsPath("/dashboard/orders")).toBe(false);
    expect(isSettingsPath("/dashboard/settings/shipping")).toBe(true);
  });
});

describe("settingsOwnerHref", () => {
  it("keeps Settings highlighted for settings pages at other addresses", () => {
    expect(settingsOwnerHref("/dashboard/admins")).toBe("/dashboard/settings");
    expect(settingsOwnerHref("/dashboard/plans/invoices")).toBe(
      "/dashboard/settings",
    );
    expect(settingsOwnerHref("/dashboard/settings/general")).toBe(
      "/dashboard/settings",
    );
  });

  it("keeps Storefront highlighted for the storefront pages", () => {
    expect(settingsOwnerHref("/dashboard/branding")).toBe(
      "/dashboard/storefront",
    );
    expect(settingsOwnerHref("/dashboard/builder/settings")).toBe(
      "/dashboard/storefront",
    );
  });

  it("is null outside Settings", () => {
    expect(settingsOwnerHref("/dashboard/products")).toBeNull();
    expect(settingsOwnerHref("/dashboard/builder")).toBeNull();
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
