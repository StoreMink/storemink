// @vitest-environment jsdom
import { Suspense, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The console Overview (wave TS-2, builder 2D): the Theme Studio tile is
// rendered for a superadmin only, inside its own Suspense boundary so the
// rest of the Overview never waits on the Studio list.
// ---------------------------------------------------------------------------

const data = vi.hoisted(() => ({
  role: "superadmin" as "superadmin" | "member",
}));
vi.mock("@/lib/auth/server-user", () => ({
  getServerUser: vi.fn(async () => ({ email: "op@storemink.com" })),
}));
vi.mock("@/app/actions/platform", () => ({
  getPlatformViewer: vi.fn(async () => ({
    email: "op@storemink.com",
    role: data.role,
  })),
}));
vi.mock("@/lib/platform/overview", () => ({
  getPlatformInsights: vi.fn(async () => ({
    ok: true,
    totals: {
      stores: 0,
      active: 0,
      paid: 0,
      launched: 0,
      new7d: 0,
      new30d: 0,
    },
    signups: [],
    planMix: { pro: 0, basic: 0, free: 0 },
    attention: {
      suspendedStores: 0,
      billingGrace: 0,
      stuckDomains: 0,
      emailFailures24h: 0,
      smsFailures24h: 0,
      openReconciliation: 0,
    },
    recent: [],
  })),
}));
vi.mock("./theme-studio-tile", () => ({
  ThemeStudioTile: function ThemeStudioTile() {
    return null;
  },
  ThemeStudioTileFallback: function ThemeStudioTileFallback() {
    return null;
  },
}));

import PlatformDashboard from "./page";

/** Every element in the tree, depth first. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...elements(element.props.children)];
}

function named(tree: ReactElement[], name: string) {
  return tree.filter(
    (element) =>
      typeof element.type === "function" &&
      (element.type as { name: string }).name === name,
  );
}

describe("the console Overview", () => {
  it("gives a superadmin the Theme Studio tile, streamed in its own boundary", async () => {
    data.role = "superadmin";
    const tree = elements(await PlatformDashboard());
    const tiles = named(tree, "ThemeStudioTile");
    expect(tiles).toHaveLength(1);
    const boundary = tree.find(
      (element) =>
        element.type === Suspense &&
        elements((element.props as { children?: ReactNode }).children).includes(
          tiles[0],
        ),
    );
    expect(boundary).toBeTruthy();
    expect(
      named(
        [(boundary!.props as { fallback: ReactElement }).fallback],
        "ThemeStudioTileFallback",
      ),
    ).toHaveLength(1);
  });

  it("never gives a member the tile", async () => {
    data.role = "member";
    const tree = elements(await PlatformDashboard());
    expect(named(tree, "ThemeStudioTile")).toHaveLength(0);
    expect(named(tree, "ThemeStudioTileFallback")).toHaveLength(0);
  });
});
