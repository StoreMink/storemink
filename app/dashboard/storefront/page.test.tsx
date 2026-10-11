/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  context: null as any,
  contextError: null as Error | null,
  canManage: true,
}));

vi.mock("../lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({
    can: (_key: string, action: string) =>
      action === "view" ? true : h.canManage,
  })),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn(() => {}) }));
vi.mock("@/lib/themes/runtime-registry", async () => {
  const meta = await import("@/lib/themes/meta");
  return { getThemeCatalog: vi.fn(async () => meta.THEME_META) };
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

import { requireSectionAccess } from "../lib/access";
import { StorefrontClient } from "./storefront-client";
import StorefrontPage, { metadata } from "./page";

const FACTS = {
  firstTheme: false,
  launched: false,
  homepage: "seeded",
  catalogueIsSampleOnly: true,
  catalogueIsEmpty: false,
  hasBuilderChrome: false,
  brandColorIsTheme: true,
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
  });

  it("is titled Storefront and still gated on the `themes` permission key", async () => {
    // ★ Saved roles store the KEY, so renaming the page must not rename it.
    expect(metadata.title).toBe("Storefront");
    h.context = contextFor({ theme: { presetId: "basket" } }, false);
    await renderedProps();
    expect(requireSectionAccess).toHaveBeenCalledWith("themes", "view");
  });

  it("a store on a theme gets its card, and that theme leaves the library", async () => {
    // Vitrine, not Basket: Basket is a legacy theme and never in the library.
    h.context = contextFor({ theme: { presetId: "vitrine" } }, false);
    const props = await renderedProps();
    expect(props.currentId).toBe("vitrine");
    expect(props.current?.name).toBe("Vitrine");
    expect(props.library.map((t) => t.id)).not.toContain("vitrine");
    expect(props.canManage).toBe(true);
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
  });

  it("an unreadable store is reported, not presented as theme-less", async () => {
    h.contextError = new Error("db down");
    const props = await renderedProps();
    expect(props.unavailable).toBe(true);
    expect(props.facts).toBeNull();
    expect(props.currentId).toBeNull();
    expect(props.canManage).toBe(false);
  });

  it("view-only staff cannot choose a theme", async () => {
    h.canManage = false;
    h.context = contextFor({ themePending: true }, true);
    const props = await renderedProps();
    expect(props.canManage).toBe(false);
  });
});
