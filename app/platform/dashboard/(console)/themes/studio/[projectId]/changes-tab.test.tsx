// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { ThemeDiff } from "@/lib/theme-studio/diff";
import {
  EM,
  EN,
  PROJECT_ID,
  V1,
  V2,
  projectDetail,
  versionView,
} from "./_test-helpers";

// The Changes tab (wave TS-2, builder 2C): today's compare view inside the
// tab, comparing the design shown with the nearest design in the Design list
// it was made from, past the automatic fixes' hidden drafts.

const data = vi.hoisted(() => ({
  project: null as unknown,
  ancestor: null as unknown,
  packages: [] as unknown[],
  diff: null as unknown,
}));
vi.mock("./tab-reads", () => ({
  readStudioProject: vi.fn(async () => data.project),
  readStudioShownAncestor: vi.fn(async () => data.ancestor),
}));
vi.mock("@/lib/theme-studio/repository", () => ({
  getThemeStudioVersionPackages: vi.fn(async () => data.packages),
}));
vi.mock("@/lib/theme-studio/diff", () => ({
  diffThemePackages: vi.fn(() => data.diff),
}));
import { getThemeStudioVersionPackages } from "@/lib/theme-studio/repository";
import { ChangesTab, ChangesView } from "./changes-tab";

const props = { projectId: PROJECT_ID, versionId: V2, revision: 7 };

const diff: ThemeDiff = {
  identical: false,
  tokens: [
    { group: "palette", key: "accent", before: "#112233", after: "#445566" },
  ],
  pages: [
    {
      slug: "about",
      title: `About ${EM} us`,
      change: "changed",
      before: ["hero", "text"],
      after: ["hero", "gallery"],
    },
  ],
  products: { added: ["Mug"], removed: [], changed: [] },
  categories: { added: [], removed: [], changed: [] },
  navigationChanged: true,
  gaps: { added: [], removed: [`Gift ${EN} wrap`] },
} as unknown as ThemeDiff;

async function show(element: Promise<ReactElement>) {
  return render(await element);
}

beforeEach(() => {
  data.project = projectDetail();
  data.ancestor = { id: V1, versionNumber: 1, between: 2 };
  data.packages = [
    { id: V1, versionNumber: 1, summary: "First idea.", package: {} },
    { id: V2, versionNumber: 2, summary: "Warmer.", package: {} },
  ];
  data.diff = diff;
});
afterEach(() => cleanup());

describe("the Changes tab", () => {
  it("compares the design shown with the design it was made from, past the automatic fixes", async () => {
    const view = await show(ChangesTab(props));
    expect(
      screen.getByRole("heading", { name: "Design 2, compared with Design 1" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Design 2 was made from Design 1\. Theme Studio's automatic fixes made 2 drafts in between/,
      ),
    ).toBeTruthy();
    expect(getThemeStudioVersionPackages).toHaveBeenCalledWith(PROJECT_ID, [
      V1,
      V2,
    ]);
    expect(screen.getByText("Design settings (1)")).toBeTruthy();
    expect(screen.getByText("Navigation changed.")).toBeTruthy();
    expect(screen.getByText("Mug")).toBeTruthy();
    const text = view.container.textContent ?? "";
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
    expect(text).not.toMatch(/version \d/i);
  });

  it("says a picture change in words", async () => {
    data.project = projectDetail({
      versions: [versionView({ origin: "asset_edit" })],
    });
    data.ancestor = { id: V1, versionNumber: 1, between: 0 };
    await show(ChangesTab(props));
    expect(
      screen.getByText("Design 2 was made by replacing pictures in Design 1."),
    ).toBeTruthy();
  });

  it("has nothing to compare for the first design, or no design", async () => {
    data.ancestor = null;
    let view = await show(ChangesTab(props));
    expect(view.container.textContent).toMatch(
      /Design 2 is where this theme started/,
    );
    expect(getThemeStudioVersionPackages).not.toHaveBeenCalled();
    cleanup();
    view = await show(ChangesTab({ ...props, versionId: null }));
    expect(view.container.textContent).toMatch(/nothing has changed/);
  });

  it("says so when a theme file can't be read", async () => {
    data.packages = [
      { id: V1, versionNumber: 1, summary: "", package: null },
      { id: V2, versionNumber: 2, summary: "", package: {} },
    ];
    await show(ChangesTab(props));
    expect(screen.getByText(/can no longer be read/)).toBeTruthy();
  });
});

describe("ChangesView", () => {
  it("says when two designs make the same theme", () => {
    render(<ChangesView diff={{ ...diff, identical: true }} />);
    expect(
      screen.getByText("These two designs make the same theme."),
    ).toBeTruthy();
  });
});
