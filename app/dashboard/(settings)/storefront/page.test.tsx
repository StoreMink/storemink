/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  context: null as any,
  contextError: null as Error | null,
  canManage: true,
  canBuild: true,
  canBrand: true,
  installed: null as any,
  installedError: null as Error | null,
}));

vi.mock("../../lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({
    can: (key: string, action: string) => {
      if (key === "builder") return action === "view" || h.canBuild;
      if (key === "branding") return h.canBrand;
      return action === "view" ? true : h.canManage;
    },
  })),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn(() => {}) }));
vi.mock("@/lib/themes/runtime-registry", async () => {
  const meta = await import("@/lib/themes/meta");
  return {
    getThemeCatalog: vi.fn(async () => meta.THEME_META),
    resolveInstalledThemeDefinition: vi.fn(async () => {
      if (h.installedError) throw h.installedError;
      return h.installed;
    }),
  };
});
vi.mock("@/lib/themes/switch", () => ({
  loadThemeSwitchContext: vi.fn(async () => {
    if (h.contextError) throw h.contextError;
    return h.context;
  }),
}));
vi.mock("./storefront-client", () => ({
  StorefrontClient: vi.fn(() => null),
}));

import { requireSectionAccess } from "../../lib/access";
import { resolveInstalledThemeDefinition } from "@/lib/themes/runtime-registry";
import { StorefrontClient } from "./storefront-client";
import StorefrontPage, { metadata } from "./page";

const FACTS = {
  firstTheme: false,
  launched: false,
  homepage: "missing",
  hasBuilderChrome: false,
  brandColorUnset: false,
  hasDesignOverrides: false,
};

function contextFor(settings: Record<string, unknown>, firstTheme: boolean) {
  return {
    settings,
    plan: "free",
    managedByOperators: false,
    facts: { ...FACTS, firstTheme },
  };
}

async function renderedProps() {
  const element = (await StorefrontPage()) as any;
  return element.props as Parameters<typeof StorefrontClient>[0];
}

describe("Storefront page (server)", () => {
  beforeEach(() => {
    h.context = null;
    h.contextError = null;
    h.canManage = true;
    h.canBuild = true;
    h.canBrand = true;
    h.installed = null;
    h.installedError = null;
    vi.mocked(resolveInstalledThemeDefinition).mockClear();
  });

  it("is titled Storefront and still gated on the `themes` permission key", async () => {
    // ★ Saved roles store the KEY, so renaming the page must not rename it.
    expect(metadata.title).toBe("Storefront");
    h.context = contextFor({ theme: { presetId: "basket" } }, false);
    await renderedProps();
    expect(requireSectionAccess).toHaveBeenCalledWith("themes", "view");
  });

  it("★★ a store on a theme gets its card and NO library: a theme is chosen once", async () => {
    h.context = contextFor({ theme: { presetId: "vitrine" } }, false);
    const props = await renderedProps();
    expect(props.currentId).toBe("vitrine");
    expect(props.current?.name).toBe("Vitrine");
    expect(props.library).toEqual([]);
    expect(props.canCustomise).toBe(true);
    expect(props.canEditBranding).toBe(true);
  });

  it("a theme in the library is read from the library, not the store's release", async () => {
    h.context = contextFor(
      { theme: { presetId: "vitrine", presetVersion: "1.0.0" } },
      false,
    );
    await renderedProps();
    expect(resolveInstalledThemeDefinition).not.toHaveBeenCalled();
  });

  it("★ a theme deleted from the library shows its own name and picture from the release the store kept", async () => {
    h.installed = {
      id: "vanta",
      name: "Vanta",
      catalog: {
        previewImage: "https://storage.googleapis.com/x/vanta.webp",
        industries: ["fashion"],
        minPlan: "pro",
      },
    };
    h.context = contextFor(
      { theme: { presetId: "vanta", presetVersion: "1.0.0" } },
      false,
    );
    const props = await renderedProps();
    expect(resolveInstalledThemeDefinition).toHaveBeenCalledWith({
      id: "vanta",
      version: "1.0.0",
    });
    expect(props.currentId).toBe("vanta");
    expect(props.current).toEqual({
      id: "vanta",
      name: "Vanta",
      description:
        "Your store uses a theme that is no longer in the library. It keeps working.",
      previewImage: "https://storage.googleapis.com/x/vanta.webp",
      industries: ["fashion"],
      minPlanName: null,
      locked: false,
      previewSlug: null,
      previewUnavailableReason: null,
    });
    expect(props.library).toEqual([]);
    expect(props.canCustomise).toBe(true);
  });

  it("a failed read of that release keeps the page, naming the theme by its id", async () => {
    h.installedError = new Error("db down");
    h.context = contextFor(
      { theme: { presetId: "vanta", presetVersion: "1.0.0" } },
      false,
    );
    const props = await renderedProps();
    expect(props.currentId).toBe("vanta");
    expect(props.current).toBeNull();
  });

  it("Customise storefront needs Website Builder manage", async () => {
    h.canBuild = false;
    h.context = contextFor({ theme: { presetId: "vitrine" } }, false);
    expect((await renderedProps()).canCustomise).toBe(false);
  });

  it("the Branding card needs Branding view", async () => {
    h.canBrand = false;
    h.context = contextFor({ theme: { presetId: "vitrine" } }, false);
    expect((await renderedProps()).canEditBranding).toBe(false);
  });

  it("a demo or preview store offers neither the library nor a redesign", async () => {
    h.context = {
      ...contextFor({ theme: { presetId: "vitrine" }, demo: true }, false),
      managedByOperators: true,
    };
    const props = await renderedProps();
    expect(props.canCustomise).toBe(false);
    expect(props.canManage).toBe(false);
    expect(props.managedByOperators).toBe(true);
  });

  it("★ a pending store has no current theme, even with a stray settings.theme", async () => {
    h.context = contextFor(
      { themePending: true, theme: { presetId: "vitrine" } },
      true,
    );
    const props = await renderedProps();
    expect(props.currentId).toBeNull();
    expect(props.current).toBeNull();
    // The stray key must not hide that theme from the owner's first choice.
    expect(props.library.map((t) => t.id)).toContain("vitrine");
    // The facts reach the dialog unchanged, so it describes a first install.
    expect(props.facts?.firstTheme).toBe(true);
    expect(props.library.length).toBeGreaterThan(0);
    // Nothing to redesign yet.
    expect(props.canCustomise).toBe(false);
  });

  it("an unreadable store is reported, not presented as theme-less", async () => {
    h.contextError = new Error("db down");
    const props = await renderedProps();
    expect(props.unavailable).toBe(true);
    expect(props.facts).toBeNull();
    expect(props.currentId).toBeNull();
    expect(props.canManage).toBe(false);
    expect(props.canCustomise).toBe(false);
    expect(props.library).toEqual([]);
  });

  it("view-only staff cannot choose a theme", async () => {
    h.canManage = false;
    h.context = contextFor({ themePending: true }, true);
    const props = await renderedProps();
    expect(props.canManage).toBe(false);
  });
});
