// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Website Builder on a store that has not chosen a theme yet: a prompt to
// choose one, not the editor — and no blank homepage row created on the way.

const H = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

vi.mock("../lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({ can: () => true })),
  getActingStoreId: vi.fn(async () => "s1"),
}));
vi.mock("@/lib/db/client", () => {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: async () => [],
    limit: async () => [{ settings: H.settings }],
  };
  return {
    withService: vi.fn(async (fn: (db: any) => Promise<any>) =>
      fn({ select: () => chain }),
    ),
  };
});
vi.mock("@/app/actions/page-actions", () => ({
  ensureHomepage: vi.fn(async () => ({ id: "home", slug: "" })),
  listPages: vi.fn(async () => []),
}));
// ★ The builder loads the brand AS SAVED (takedown): the Brand panel saves
// `logoUrl` back with every brand change, so a masked brand (a blocked logo
// reads null) would erase a blocked logo for good. Both readers are mocked so
// a test can tell which one the page called.
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => ({
    name: "Acme",
    primaryColor: "#123456",
    logoUrl: null,
  })),
  getStoreBrandForEditing: vi.fn(async () => ({
    name: "Acme",
    primaryColor: "#123456",
    logoUrl: "https://storage.googleapis.com/b/stores/s1/logo.webp",
  })),
}));
vi.mock("@/lib/moderation/merchant", () => ({
  blockedItemIds: vi.fn(async () => new Map<string, string>()),
}));
vi.mock("@/lib/chrome/queries", () => ({
  getDraftChromeForEditor: vi.fn(async () => null),
}));
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveInstalledThemeDefinition: vi.fn(async () => null),
}));
vi.mock("./builder-client", () => ({
  BuilderClient: vi.fn(() => "builder editor"),
}));

import { ensureHomepage, listPages } from "@/app/actions/page-actions";
import { getStoreBrand, getStoreBrandForEditing } from "@/lib/store/brand";
import { blockedItemIds } from "@/lib/moderation/merchant";
import { requireSectionAccess } from "../lib/access";
import { BuilderClient } from "./builder-client";
import BuilderPage from "./page";

beforeEach(() => {
  H.settings = {};
});

describe("Website Builder while no theme is chosen", () => {
  it("shows a prompt to choose a theme instead of the editor", async () => {
    H.settings = { launched: false, themePending: true };
    render(await BuilderPage());

    expect(
      screen.getByRole("heading", { name: "Choose a theme first" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Choose a theme" }),
    ).toHaveAttribute("href", "/dashboard/storefront");
    expect(BuilderClient).not.toHaveBeenCalled();
    // ★ No blank homepage row for the first theme install to find.
    expect(ensureHomepage).not.toHaveBeenCalled();
    expect(listPages).not.toHaveBeenCalled();
  });

  it("★ shows no button to staff who can't open the Storefront page", async () => {
    H.settings = { launched: false, themePending: true };
    vi.mocked(requireSectionAccess).mockResolvedValueOnce({
      can: (section: string) => section !== "themes",
    } as any);
    render(await BuilderPage());

    expect(
      screen.getByRole("heading", { name: "Choose a theme first" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Choose a theme" })).toBeNull();
    expect(screen.getByText(/Ask the store owner/)).toBeInTheDocument();
  });

  it("opens the editor once a theme is chosen", async () => {
    H.settings = { launched: false, theme: { presetId: "basket" } };
    render(await BuilderPage());

    expect(screen.getByText("builder editor")).toBeInTheDocument();
    expect(screen.queryByText("Choose a theme first")).toBeNull();
    expect(ensureHomepage).toHaveBeenCalledTimes(1);
  });

  it("opens the editor for a legacy store with no themePending key", async () => {
    render(await BuilderPage());
    expect(screen.getByText("builder editor")).toBeInTheDocument();
  });
});

/** The props the page handed BuilderClient on its latest render. */
function builderProps(): Record<string, any> {
  const calls = vi.mocked(BuilderClient).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Record<string, any>;
}

describe("Website Builder brand (takedown must-ship)", () => {
  it("★ loads the brand as saved, never the masked reader", async () => {
    H.settings = { theme: { presetId: "basket" } };
    render(await BuilderPage());

    expect(getStoreBrandForEditing).toHaveBeenCalledTimes(1);
    expect(getStoreBrand).not.toHaveBeenCalled();
    // The stored logo reaches the Brand panel, so saving the brand cannot
    // write a blocked logo away.
    expect(builderProps().initialBrand).toEqual({
      name: "Acme",
      primaryColor: "#123456",
      logoUrl: "https://storage.googleapis.com/b/stores/s1/logo.webp",
    });
    expect(builderProps().storeName).toBe("Acme");
  });
});

describe("Website Builder pages blocked by StoreMink", () => {
  it("reads the store's blocked pages once and hands them to the editor", async () => {
    H.settings = { theme: { presetId: "basket" } };
    vi.mocked(blockedItemIds).mockResolvedValueOnce(new Map([["p1", "b1"]]));
    render(await BuilderPage());

    expect(blockedItemIds).toHaveBeenCalledTimes(1);
    expect(blockedItemIds).toHaveBeenCalledWith("s1", "page");
    expect(builderProps().blockedByStoreMink).toEqual({ p1: "b1" });
    expect(builderProps().canSeeNotices).toBe(true);
  });

  it("a failed read marks nothing and the editor still opens", async () => {
    H.settings = { theme: { presetId: "basket" } };
    vi.mocked(blockedItemIds).mockRejectedValueOnce(new Error("db down"));
    render(await BuilderPage());

    expect(screen.getByText("builder editor")).toBeInTheDocument();
    expect(builderProps().blockedByStoreMink).toEqual({});
  });

  it("no See why for an admin who cannot open the notices", async () => {
    H.settings = { theme: { presetId: "basket" } };
    vi.mocked(requireSectionAccess).mockResolvedValueOnce({
      can: (section: string) => section !== "settings",
    } as any);
    render(await BuilderPage());

    expect(builderProps().canSeeNotices).toBe(false);
  });

  it("reads nothing while the store has no theme", async () => {
    H.settings = { themePending: true };
    render(await BuilderPage());

    expect(blockedItemIds).not.toHaveBeenCalled();
    expect(getStoreBrandForEditing).not.toHaveBeenCalled();
  });
});
