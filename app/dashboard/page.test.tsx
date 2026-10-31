import {
  Suspense,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Dashboard Home's StoreMink notice banner sits in its own Suspense boundary
// (takedown fix pass, must-do 24): the rest of Home streams at once and never
// waits for the banner's one query. The page is an async server component, so
// these tests build its element tree and read it; nothing is rendered, which
// is also how they show the page itself never runs the banner's read.

const A = vi.hoisted(() => ({
  settings: true,
}));

vi.mock("./lib/access", () => ({
  getViewerContext: vi.fn(async () => ({
    profile: { first_name: "Asha" },
    dbError: false,
    userId: "u1",
    userEmail: "asha@example.com",
    permissions: {},
    isSuperadmin: true,
  })),
  getViewerAccess: vi.fn(async () => ({
    can: (section: string) => (section === "settings" ? A.settings : true),
  })),
}));
vi.mock("./store-notice-banner", () => ({
  StoreNoticeBanner: vi.fn(() => null),
}));
vi.mock("./ask-anything", () => ({ AskAnything: vi.fn(() => null) }));
vi.mock("./components/mink-suggestions", () => ({
  MinkSuggestions: vi.fn(() => null),
}));
vi.mock("./launch-checklist", () => ({
  LaunchChecklistCard: vi.fn(() => null),
}));
vi.mock("./plan-tag", () => ({ PlanTag: vi.fn(() => null) }));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStore: vi.fn(async () => ({
    id: "s1",
    plan: "pro",
    settings: {},
  })),
}));
vi.mock("@/lib/plans", () => ({ effectivePlan: vi.fn(() => "pro") }));
vi.mock("@/lib/store/launch-state", () => ({
  isStoreLaunched: vi.fn(() => false),
}));
vi.mock("@/lib/analytics/range", () => ({
  normalizeAnalyticsTimeZone: vi.fn(() => "Asia/Kolkata"),
}));
vi.mock("@/lib/locations/scope", () => ({
  getViewerLocations: vi.fn(async () => null),
}));
vi.mock("@/lib/mink/access", () => ({
  isMinkStoreInvited: vi.fn(async () => true),
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: true, betaRequireInvite: false })),
}));
vi.mock("@/lib/mink/home-suggestions", () => ({
  loadMinkHomeSuggestions: vi.fn(async () => []),
}));
vi.mock("@/lib/settings/registry", () => ({
  resolveStoreSettings: vi.fn(() => ({})),
}));

import DashboardHomePage from "./page";
import { StoreNoticeBanner } from "./store-notice-banner";

type Found = { element: ReactElement; parents: ReactElement[] };

/** Every element in the tree, with the elements above it. */
function walk(
  node: ReactNode,
  parents: ReactElement[] = [],
  out: Found[] = [],
): Found[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, parents, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push({ element: node, parents });
  const props = node.props as { children?: ReactNode };
  walk(props.children, [...parents, node], out);
  return out;
}

function bannersIn(tree: ReactNode): Found[] {
  return walk(tree).filter(({ element }) => element.type === StoreNoticeBanner);
}

describe("Dashboard Home's StoreMink notice banner", () => {
  beforeEach(() => {
    A.settings = true;
  });

  it("sits in its own Suspense boundary with an empty fallback", async () => {
    const tree = await DashboardHomePage();
    const banners = bannersIn(tree);
    expect(banners).toHaveLength(1);

    const [{ element, parents }] = banners;
    expect((element.props as { storeId: string }).storeId).toBe("s1");

    // ★ The nearest element above the banner is its Suspense boundary, and
    // that boundary holds the banner alone: a slow read holds back nothing
    // else on Home.
    const boundary = parents[parents.length - 1];
    expect(boundary.type).toBe(Suspense);
    expect((boundary.props as { fallback: unknown }).fallback).toBeNull();
    expect((boundary.props as { children: unknown }).children).toBe(element);
  });

  it("never runs the banner's read while building the page", async () => {
    await DashboardHomePage();
    // React renders the banner later, inside its boundary; the page itself
    // awaits nothing of it.
    expect(StoreNoticeBanner).not.toHaveBeenCalled();
  });

  it("shows no banner (and no boundary for one) without Settings view", async () => {
    A.settings = false;
    const tree = await DashboardHomePage();
    expect(bannersIn(tree)).toHaveLength(0);
    expect(walk(tree).some(({ element }) => element.type === Suspense)).toBe(
      false,
    );
  });
});
