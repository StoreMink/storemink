// @vitest-environment jsdom
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The console Overview's Theme Studio tile (wave TS-2, builder 2D):
// superadmin only, from the Studio list's counts, each count a link to its
// filter; a failed read says so rather than showing zeroes.
// ---------------------------------------------------------------------------

const data = vi.hoisted(() => ({
  actor: { id: "a-1", email: "op@storemink.com" } as {
    id: string;
    email: string;
  } | null,
  counts: {
    all: 9,
    needs_you: 1,
    building: 0,
    ready: 2,
    live: 3,
    archived: 3,
  },
  fails: false,
  reads: 0,
}));
vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => data.actor),
}));
vi.mock("@/lib/theme-studio/progress", () => ({
  listThemeStudioProjectsForConsole: vi.fn(async () => {
    data.reads += 1;
    if (data.fails) throw new Error("db down");
    return { rows: [], counts: data.counts };
  }),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) => fn({})),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import {
  ThemeStudioTile,
  ThemeStudioTileFallback,
  themeStudioTileWords,
} from "./theme-studio-tile";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

async function open() {
  const tile = (await ThemeStudioTile()) as ReactElement | null;
  return tile ? render(tile) : null;
}

afterEach(() => {
  cleanup();
  data.actor = { id: "a-1", email: "op@storemink.com" };
  data.counts = {
    all: 9,
    needs_you: 1,
    building: 0,
    ready: 2,
    live: 3,
    archived: 3,
  };
  data.fails = false;
  data.reads = 0;
});

describe("the Overview's Theme Studio tile", () => {
  it("is shown only to a superadmin, and reads nothing for anyone else", async () => {
    data.actor = null;
    expect(await open()).toBeNull();
    expect(data.reads).toBe(0);
  });

  it("says what needs the operator and what is ready, each a link to its filter", async () => {
    const view = await open();
    expect(
      screen.getByText("Theme Studio: 1 needs you, 2 ready to publish."),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Needs you (1)" }).getAttribute("href"),
    ).toBe("/dashboard/themes/studio?filter=needs_you");
    expect(
      screen
        .getByRole("link", { name: "Ready to publish (2)" })
        .getAttribute("href"),
    ).toBe("/dashboard/themes/studio?filter=ready");
    expect(
      screen
        .getByRole("link", { name: "Open Theme Studio" })
        .getAttribute("href"),
    ).toBe("/dashboard/themes/studio");
    const text = view?.container.textContent ?? "";
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
    // Never a raw palette colour: the console home has only dash tokens.
    expect(view?.container.innerHTML).not.toMatch(
      /\b(?:text|bg|border)-(?:slate|gray|amber|violet|indigo|sky|emerald|red)-\d/,
    );
  });

  it("says plainly when nothing needs the operator", () => {
    expect(themeStudioTileWords({ needs_you: 0, ready: 0, building: 0 })).toBe(
      "Theme Studio: nothing needs you.",
    );
    expect(themeStudioTileWords({ needs_you: 3, ready: 0, building: 1 })).toBe(
      "Theme Studio: 3 need you, 1 building.",
    );
  });

  it("a failed read says so rather than showing zeroes", async () => {
    data.fails = true;
    await open();
    expect(screen.getByRole("alert").textContent).toMatch(
      /Theme Studio figures are unavailable/,
    );
    expect(screen.queryByText(/needs you|nothing needs you/)).toBeNull();
  });

  it("holds its place while it counts", () => {
    render(<ThemeStudioTileFallback />);
    expect(screen.getByText("Theme Studio")).toBeTruthy();
    expect(screen.getByText("Counting themes.")).toBeTruthy();
  });
});
