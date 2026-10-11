/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(async () => ({
    uid: "owner-1",
    email: "owner@example.com",
  })),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

function meta(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    description: "",
    engine: { id: "classic", version: 1 },
    release: { version: "1.0.0", status: "published", notes: [] },
    catalog: {
      visibility: "public",
      industries: [],
      catalogSizes: [],
      features: [],
      keywords: [],
      previewImage: "/themes/x.webp",
      screenshots: [],
      ...extra,
    },
    demo: { slug: `demo-${id}`, status: "healthy" },
  };
}

vi.mock("@/lib/themes/runtime-registry", () => ({
  getThemeCatalog: vi.fn(async () => [
    meta("vitrine"),
    meta("luxe", { minPlan: "pro" }),
    meta("draft-theme", { visibility: "hidden" }),
  ]),
  resolveThemeDefinition: vi.fn(async (id: string) => ({
    id,
    name: id[0].toUpperCase() + id.slice(1),
  })),
}));
vi.mock("@/lib/themes/switch", () => ({
  switchStoreThemeTo: vi.fn(async () => ({
    ok: true,
    plan: {
      firstTheme: false,
      homepage: "replace",
      addMissingPages: true,
      catalogue: "swap-samples",
      menus: "replace",
      brandColor: "theme",
    },
    warnings: [],
  })),
}));

import { revalidatePath, updateTag } from "next/cache";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { emitEvent } from "@/lib/notifications/record";
import { resolveThemeDefinition } from "@/lib/themes/runtime-registry";
import { switchStoreThemeTo } from "@/lib/themes/switch";
import { switchStoreTheme } from "./theme-actions";

describe("switchStoreTheme", () => {
  beforeEach(() => {
    vi.mocked(getManagerIdentity).mockImplementation(async () => ({
      uid: "owner-1",
      email: "owner@example.com",
    }));
  });

  it("★ refuses anyone without the Themes manage permission, before reading anything", async () => {
    vi.mocked(getManagerIdentity).mockImplementation(async () => null);
    const result = await switchStoreTheme("vitrine");
    expect(result).toEqual({
      ok: false,
      error: "You don't have permission to change the theme.",
    });
    expect(getManagerIdentity).toHaveBeenCalledWith("themes");
    expect(switchStoreThemeTo).not.toHaveBeenCalled();
  });

  it("refuses a malformed id", async () => {
    expect(await switchStoreTheme("../etc")).toEqual({
      ok: false,
      error: "Choose a theme.",
    });
    expect(await switchStoreTheme(42)).toEqual({
      ok: false,
      error: "Choose a theme.",
    });
  });

  it("★ refuses a hidden or unknown theme, so posting around the page installs nothing", async () => {
    for (const id of ["draft-theme", "not-a-theme"]) {
      expect(await switchStoreTheme(id)).toEqual({
        ok: false,
        error: "That theme isn't available.",
      });
    }
    expect(switchStoreThemeTo).not.toHaveBeenCalled();
  });

  it("refuses when the registry would substitute another theme", async () => {
    vi.mocked(resolveThemeDefinition).mockImplementation(
      async () => ({ id: "basket", name: "Basket" }) as any,
    );
    expect(await switchStoreTheme("vitrine")).toEqual({
      ok: false,
      error: "That theme isn't available.",
    });
    expect(switchStoreThemeTo).not.toHaveBeenCalled();
  });

  it("passes what the dialog described only when it is a real boolean", async () => {
    await switchStoreTheme("luxe", { expectFirstTheme: true });
    expect(switchStoreThemeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectFirstTheme: true }),
    );
    await switchStoreTheme("luxe", { expectFirstTheme: "yes" });
    expect(
      vi.mocked(switchStoreThemeTo).mock.calls.at(-1)?.[0].expectFirstTheme,
    ).toBeUndefined();
  });

  it("switches the acting store, passing the theme's plan gate and the actor", async () => {
    const result = await switchStoreTheme("luxe");
    expect(switchStoreThemeTo).toHaveBeenCalledWith({
      storeId: "store-1",
      theme: { id: "luxe", name: "Luxe" },
      minPlan: "pro",
      replaceEditedHomepage: false,
      actorUserId: "owner-1",
    });
    expect(result).toMatchObject({ ok: true, themeName: "Luxe", warnings: [] });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/storefront");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/builder");
    // A switch on a store that already has a theme keeps the existing
    // stale-while-revalidate refresh (revalidateThemeSeed).
    expect(updateTag).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith({
      type: "settings.changed",
      storeId: "store-1",
      actor: { type: "admin", id: "owner-1" },
      payload: { settings: "Theme (Luxe)", count: 1 },
    });
  });

  it("★ a first install expires the store cache at once, so the storefront stops showing the in-progress page", async () => {
    vi.mocked(switchStoreThemeTo).mockImplementation(async () => ({
      ok: true,
      plan: {
        firstTheme: true,
        homepage: "replace",
        addMissingPages: true,
        catalogue: "seed-samples",
        menus: "replace",
        brandColor: "theme",
      },
      warnings: [],
    }));
    const result = await switchStoreTheme("vitrine");
    expect(result).toMatchObject({
      ok: true,
      themeName: "Vitrine",
      plan: { firstTheme: true },
    });
    expect(updateTag).toHaveBeenCalledWith("stores");
  });

  it("replaces an edited homepage only when asked with exactly true", async () => {
    await switchStoreTheme("vitrine", { replaceEditedHomepage: "yes" });
    expect(vi.mocked(switchStoreThemeTo).mock.calls[0][0]).toMatchObject({
      replaceEditedHomepage: false,
    });
    await switchStoreTheme("vitrine", { replaceEditedHomepage: true });
    expect(vi.mocked(switchStoreThemeTo).mock.calls[1][0]).toMatchObject({
      replaceEditedHomepage: true,
    });
  });

  it("passes a refusal through without revalidating or recording", async () => {
    vi.mocked(switchStoreThemeTo).mockImplementation(async () => ({
      ok: false,
      error: "Vitrine is already your theme.",
    }));
    expect(await switchStoreTheme("vitrine")).toEqual({
      ok: false,
      error: "Vitrine is already your theme.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(updateTag).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
