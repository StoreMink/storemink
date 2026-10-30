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
  attention: {} as Record<string, number>,
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
      complaintsDue: 0,
      storeReplies: 0,
      filesToFinish: 0,
      holdsToReview: 0,
      ...data.attention,
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

import Link from "next/link";
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

  // ── The takedown queues (design 6.1) ─────────────────────────────────────

  type QueueProps = {
    label: string;
    count: number;
    href: string;
    hint: string;
  };

  function queues(tree: ReactElement[]) {
    return named(tree, "Queue").map(
      (element) => element as ReactElement<QueueProps>,
    );
  }

  /** Every string in a tree, joined. */
  function textOf(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number") {
      return String(node);
    }
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (!node || typeof node !== "object" || !("props" in node)) return "";
    return textOf(
      (node as ReactElement<{ children?: ReactNode }>).props.children,
    );
  }

  it("shows the four takedown queues first, with the design's words and links", async () => {
    data.attention = {};
    const tree = elements(await PlatformDashboard());
    const cards = queues(tree).map(({ props }) => ({
      label: props.label,
      href: props.href,
      hint: props.hint,
    }));
    expect(cards.slice(0, 4)).toEqual([
      {
        label: "Complaints due",
        href: "/dashboard/complaints?view=due",
        hint: "Next deadline within 6 hours or passed",
      },
      {
        label: "Store replies",
        href: "/dashboard/complaints?view=replies",
        hint: "Stores waiting for an answer about a block",
      },
      {
        label: "Files to finish",
        href: "/dashboard/complaints?view=files",
        hint: "A blocked file is still in storage, or must be removed by hand",
      },
      {
        label: "Holds to review",
        href: "/dashboard/complaints?view=holds",
        hint: "A store hold has reached its review date",
      },
    ]);
    // The six queues that were there stay.
    expect(cards).toHaveLength(10);
  });

  it("shows a takedown queue at zero greyed, not hidden and not a link", async () => {
    data.attention = {};
    const tree = elements(await PlatformDashboard());
    for (const card of queues(tree).slice(0, 4)) {
      expect(card.props.count).toBe(0);
      const rendered = (card.type as (props: QueueProps) => ReactElement)(
        card.props,
      );
      expect(rendered.type).not.toBe(Link);
      expect(textOf(rendered)).toContain(card.props.label);
    }
  });

  it("links a takedown queue that has something in it, and counts it in the total", async () => {
    data.attention = {
      complaintsDue: 2,
      storeReplies: 1,
      filesToFinish: 3,
      holdsToReview: 1,
    };
    const tree = elements(await PlatformDashboard());
    const four = queues(tree).slice(0, 4);
    expect(four.map((card) => card.props.count)).toEqual([2, 1, 3, 1]);
    for (const card of four) {
      const rendered = (card.type as (props: QueueProps) => ReactElement)(
        card.props,
      );
      expect(rendered.type).toBe(Link);
      expect((rendered.props as { href: string }).href).toBe(card.props.href);
    }
    expect(textOf(tree[0])).toContain("7 items need attention.");
    expect(textOf(tree[0])).toContain("7 open");
    data.attention = {};
  });
});
