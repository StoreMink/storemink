// @vitest-environment jsdom
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The console's navigation (wave TS-2, builder 2D): Themes, the way into
// Theme Studio, is a superadmin entry. A member never sees it in the sidebar
// or the search, because both of its tabs refuse a member.
// ---------------------------------------------------------------------------

const data = vi.hoisted(() => ({
  viewer: { email: "op@storemink.com", role: "superadmin" } as {
    email: string;
    role: string;
  } | null,
}));
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "font-dash" }),
  JetBrains_Mono: () => ({ variable: "font-dash-mono" }),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock("@/app/actions/platform", () => ({
  getPlatformViewer: vi.fn(async () => data.viewer),
}));
vi.mock("@/components/ui/sonner", () => ({
  Toaster: function Toaster() {
    return null;
  },
}));
vi.mock("@/app/dashboard/dashboard-topbar", () => ({
  DashboardTopbar: function DashboardTopbar() {
    return null;
  },
}));
vi.mock("@/app/dashboard/dashboard-sidebar", () => ({
  DashboardSidebar: function DashboardSidebar() {
    return null;
  },
}));
vi.mock("@/app/dashboard/dashboard-mobile-nav", () => ({
  MobileNavProvider: function MobileNavProvider({
    children,
  }: {
    children: ReactNode;
  }) {
    return children;
  },
}));

import PlatformDashboardLayout from "./layout";

type NavGroups = {
  group: string;
  items: { href: string; label: string; searchAliases?: string[] }[];
}[];

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...elements(element.props.children)];
}

async function nav() {
  const tree = elements(await PlatformDashboardLayout({ children: null }));
  const prop = (name: string, key: string) =>
    (
      tree.find(
        (element) =>
          typeof element.type === "function" &&
          (element.type as { name: string }).name === name,
      )!.props as Record<string, NavGroups>
    )[key];
  return {
    sidebar: prop("DashboardSidebar", "groups"),
    search: prop("DashboardTopbar", "searchGroups"),
  };
}

function hrefs(groups: NavGroups) {
  return groups.flatMap((group) => group.items.map((item) => item.href));
}

afterEach(() => {
  data.viewer = { email: "op@storemink.com", role: "superadmin" };
});

describe("the console navigation", () => {
  it("gives a superadmin Themes, found by Theme Studio in the search too", async () => {
    const { sidebar, search } = await nav();
    expect(hrefs(sidebar)).toContain("/dashboard/themes");
    expect(search).toBe(sidebar);
    const themes = sidebar
      .flatMap((group) => group.items)
      .find((item) => item.href === "/dashboard/themes")!;
    expect(themes.label).toBe("Themes");
    expect(themes.searchAliases).toContain("Theme Studio");
  });

  it("never shows a member the Themes entry", async () => {
    data.viewer = { email: "m@storemink.com", role: "member" };
    const { sidebar, search } = await nav();
    expect(hrefs(sidebar)).not.toContain("/dashboard/themes");
    expect(hrefs(search)).not.toContain("/dashboard/themes");
    // Everything else a member had is still there.
    expect(hrefs(sidebar)).toEqual(
      expect.arrayContaining([
        "/dashboard",
        "/dashboard/stores",
        "/dashboard/help",
        "/dashboard/pricing",
      ]),
    );
  });

  it("sends someone who is not an operator to sign in", async () => {
    data.viewer = null;
    await expect(PlatformDashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/dashboard/login",
    );
  });
});
