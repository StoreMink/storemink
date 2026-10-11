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
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => ({
    name: "Acme",
    primaryColor: "#123456",
    logoUrl: null,
  })),
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
