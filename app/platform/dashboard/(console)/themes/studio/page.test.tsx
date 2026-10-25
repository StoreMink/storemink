// @vitest-environment jsdom
import type { ReactElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ThemeStudioList,
  ThemeStudioListFilter,
} from "@/lib/theme-studio/progress";

// ---------------------------------------------------------------------------
// Themes, Theme Studio tab (wave TS-2, builder 2D): the old list address
// opens this tab; superadmin before any read (a member sees today's notice);
// ?filter= reaches the list read; the switched-off and offline banners; a
// failed read says so instead of showing an empty list.
// ---------------------------------------------------------------------------

const data = vi.hoisted(() => ({
  actor: { id: "a-1", email: "op@storemink.com" } as {
    id: string;
    email: string;
  } | null,
  config: { generationEnabled: true, provider: "vertex-gemini" as string },
  list: null as unknown,
  listFails: false,
  catalogFails: false,
  reads: [] as string[],
  listProps: null as { list: unknown; filter: ThemeStudioListFilter } | null,
}));

vi.mock("../../require-operator", () => ({
  requireOperator: vi.fn(async () => ({
    email: "op@storemink.com",
    role: "superadmin",
  })),
}));
vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => data.actor),
}));
vi.mock("@/lib/theme-studio/config", () => ({
  getThemeStudioConfig: () => data.config,
}));
vi.mock("@/lib/theme-studio/progress", () => ({
  listThemeStudioProjectsForConsole: vi.fn(
    async (_db: unknown, input: { filter: ThemeStudioListFilter }) => {
      data.reads.push(`list:${input.filter}`);
      if (data.listFails) throw new Error("db down");
      return data.list;
    },
  ),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) => fn({})),
}));
vi.mock("@/lib/themes/runtime-registry", () => ({
  getThemeCatalog: vi.fn(async () => {
    data.reads.push("catalog");
    if (data.catalogFails) throw new Error("registry down");
    return Array.from({ length: 7 }, (_, i) => ({ id: `t${i}` }));
  }),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("./studio-ui", () => ({
  SuperadminOnly: () => <p>Theme Studio is limited to superadmins</p>,
}));
vi.mock("./studio-list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./studio-list")>()),
  StudioList: (props: { list: unknown; filter: ThemeStudioListFilter }) => {
    data.listProps = props;
    return <div data-testid="studio-list" />;
  },
}));

import ThemeStudioPage from "./page";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

const LIST: ThemeStudioList = {
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

async function open(search: Record<string, string> = {}) {
  const page = (await ThemeStudioPage({
    searchParams: Promise.resolve(search),
  })) as ReactElement;
  return render(page);
}

afterEach(() => {
  cleanup();
  data.actor = { id: "a-1", email: "op@storemink.com" };
  data.config = { generationEnabled: true, provider: "vertex-gemini" };
  data.list = LIST;
  data.listFails = false;
  data.catalogFails = false;
  data.reads = [];
  data.listProps = null;
});

describe("Themes, Theme Studio tab", () => {
  it("shows a member today's notice and reads nothing", async () => {
    data.actor = null;
    data.list = LIST;
    const notice = await open({ filter: "needs_you" });
    expect(
      notice.container.firstElementChild?.classList.contains("studio-root"),
    ).toBe(true);
    expect(
      screen.getByText("Theme Studio is limited to superadmins"),
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("link", { name: /New theme/ })).toBeNull();
    expect(data.reads).toEqual([]);
  });

  it("opens the Theme Studio tab, with both tabs' counts and New theme", async () => {
    data.list = LIST;
    const view = await open();
    // The Studio's root class: 44 px controls on touch screens of any width.
    expect(
      view.container.firstElementChild?.classList.contains("studio-root"),
    ).toBe(true);
    const tabs = within(screen.getByRole("tablist", { name: "Themes" }));
    const catalog = tabs.getByRole("tab", { name: /Catalog/ });
    const studio = tabs.getByRole("tab", { name: /Theme Studio/ });
    expect(catalog.textContent).toBe("Catalog7");
    expect(studio.textContent).toBe("Theme Studio12");
    expect(studio.getAttribute("aria-selected")).toBe("true");
    expect(catalog.getAttribute("aria-selected")).toBe("false");
    expect(catalog.getAttribute("href")).toBe("/dashboard/themes");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(studio.id);
    expect(studio.getAttribute("aria-controls")).toBe(panel.id);
    expect(
      screen.getByRole("link", { name: /New theme/ }).getAttribute("href"),
    ).toBe("/dashboard/themes/studio/new");
    expect(within(panel).getByTestId("studio-list")).toBeTruthy();
    expect(data.listProps).toEqual({ list: LIST, filter: "all" });
    const text = view.container.textContent ?? "";
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
  });

  it("passes ?filter= to the list read, and an unknown one as All", async () => {
    data.list = LIST;
    await open({ filter: "archived" });
    expect(data.reads).toContain("list:archived");
    expect(data.listProps?.filter).toBe("archived");
    cleanup();
    data.reads = [];
    await open({ filter: "everything" });
    expect(data.reads).toContain("list:all");
    expect(data.listProps?.filter).toBe("all");
  });

  it("says when building is switched off", async () => {
    data.list = LIST;
    data.config = { generationEnabled: false, provider: "vertex-gemini" };
    await open();
    const notice = screen.getByText(
      /Building is switched off on this deployment/,
    );
    expect(notice.className).toContain("studio-notice");
    expect(notice.getAttribute("data-tone")).toBe("warning");
  });

  it("says when the offline test provider builds", async () => {
    data.list = LIST;
    data.config = { generationEnabled: true, provider: "fake" };
    await open();
    expect(
      screen.getByText(/This deployment uses the offline test provider/),
    ).toBeTruthy();
  });

  it("a list that can't be read says so, and the tab shows no count", async () => {
    data.listFails = true;
    await open();
    expect(screen.getByRole("alert").textContent).toMatch(
      /The theme list couldn.t be read just now/,
    );
    expect(screen.queryByTestId("studio-list")).toBeNull();
    expect(screen.getByRole("tab", { name: /Theme Studio/ }).textContent).toBe(
      "Theme Studio",
    );
  });

  it("a catalogue that can't be read leaves the Catalog tab without a count", async () => {
    data.list = LIST;
    data.catalogFails = true;
    await open();
    expect(screen.getByRole("tab", { name: /Catalog/ }).textContent).toBe(
      "Catalog",
    );
    expect(screen.getByTestId("studio-list")).toBeTruthy();
  });
});
