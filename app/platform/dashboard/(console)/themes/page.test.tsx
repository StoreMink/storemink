// @vitest-environment jsdom
import type { ReactElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Themes, Catalog tab (wave TS-2, builder 2D): today's panel, superadmin
// only (a member is redirected, as before), beside the Theme Studio tab; the
// Studio count is read behind the Studio's own gate and never breaks the
// catalog when it can't be read.
// ---------------------------------------------------------------------------

const data = vi.hoisted(() => ({
  viewer: { email: "op@storemink.com", role: "superadmin" as string },
  actor: { id: "a-1", email: "op@storemink.com" } as {
    id: string;
    email: string;
  } | null,
  countFails: false,
  reads: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock("../require-operator", () => ({
  requireOperator: vi.fn(async () => data.viewer),
  canManage: (viewer: { role: string }) => viewer.role === "superadmin",
}));
vi.mock("@/app/actions/platform", () => ({
  listDemoStoreSlugs: vi.fn(async () => {
    data.reads.push("slugs");
    return ["demo-basket", "some-merchant"];
  }),
  seedDemoStore: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/lib/themes/runtime-registry", () => ({
  getThemeCatalog: vi.fn(async () => {
    data.reads.push("catalog");
    return [
      {
        id: "basket",
        name: "Basket",
        release: { status: "published", version: "1.0.0" },
        catalog: { industries: ["food-and-drink"] },
        demo: { slug: "demo-basket", status: "healthy" },
      },
      {
        id: "vitrine",
        name: "Vitrine",
        release: { status: "published", version: "1.2.0" },
        catalog: { industries: ["clothing"] },
        demo: { slug: "demo-vitrine", status: "healthy" },
      },
    ];
  }),
}));
vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => data.actor),
}));
vi.mock("@/lib/theme-studio/progress", () => ({
  listThemeStudioProjectsForConsole: vi.fn(async () => {
    data.reads.push("studio");
    if (data.countFails) throw new Error("db down");
    return {
      rows: [],
      counts: {
        all: 12,
        needs_you: 2,
        building: 1,
        ready: 2,
        live: 3,
        archived: 4,
      },
    };
  }),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) => fn({})),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import ThemesPage from "./page";
import { logError } from "@/lib/observability/logger";

async function open() {
  return render((await ThemesPage()) as ReactElement);
}

afterEach(() => {
  cleanup();
  data.viewer = { email: "op@storemink.com", role: "superadmin" };
  data.actor = { id: "a-1", email: "op@storemink.com" };
  data.countFails = false;
  data.reads = [];
});

describe("Themes, Catalog tab", () => {
  it("redirects a member, as before, and reads nothing", async () => {
    data.viewer = { email: "m@storemink.com", role: "member" };
    await expect(ThemesPage()).rejects.toThrow("redirect:/dashboard");
    expect(data.reads).toEqual([]);
  });

  it("opens on the Catalog tab with today's panel and both counts", async () => {
    const view = await open();
    // The Studio's root class: 44 px controls on touch screens of any width.
    expect(
      view.container.firstElementChild?.classList.contains("studio-root"),
    ).toBe(true);
    const tabs = within(screen.getByRole("tablist", { name: "Themes" }));
    const catalog = tabs.getByRole("tab", { name: /Catalog/ });
    const studio = tabs.getByRole("tab", { name: /Theme Studio/ });
    expect(catalog.getAttribute("aria-selected")).toBe("true");
    expect(catalog.textContent).toBe("Catalog2");
    expect(studio.textContent).toBe("Theme Studio12");
    expect(studio.getAttribute("href")).toBe("/dashboard/themes/studio");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(catalog.id);
    // Today's panel: each theme, its demo, Seed or Reseed.
    expect(within(panel).getByText("Theme demo stores")).toBeTruthy();
    expect(within(panel).getByText("Basket")).toBeTruthy();
    expect(within(panel).getByText("Vitrine")).toBeTruthy();
    expect(
      within(panel).getByRole("button", { name: /Reseed the Basket/ }),
    ).toBeTruthy();
    expect(
      within(panel).getByRole("button", { name: /^Seed the Vitrine/ }),
    ).toBeTruthy();
    // No Hide or Show on the catalog.
    expect(
      within(panel).queryByRole("button", { name: /Hide|Show/ }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: /New theme/ }).getAttribute("href"),
    ).toBe("/dashboard/themes/studio/new");
  });

  it("still shows the catalog when the Studio count can't be read", async () => {
    data.countFails = true;
    await open();
    expect(screen.getByRole("tab", { name: /Theme Studio/ }).textContent).toBe(
      "Theme Studio",
    );
    expect(screen.getByText("Theme demo stores")).toBeTruthy();
    expect(logError).toHaveBeenCalled();
  });

  it("reads the Studio count only behind the Studio's own gate", async () => {
    data.actor = null;
    await open();
    expect(data.reads).not.toContain("studio");
    expect(screen.getByRole("tab", { name: /Theme Studio/ }).textContent).toBe(
      "Theme Studio",
    );
  });
});
