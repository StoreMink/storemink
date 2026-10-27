// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeMeta } from "@/lib/themes/meta";

// ---------------------------------------------------------------------------
// The Themes page's Catalog tab panel (wave TS-2, builder 2D): what it
// offers is unchanged (name, industry, release and version, demo status,
// Open, Seed or Reseed); a result is a note on the row, never a browser
// alert box, and a release's state is a plain word.
// ---------------------------------------------------------------------------

const seed = vi.hoisted(() => ({
  result: { success: true, slug: "demo-vitrine" } as {
    success?: boolean;
    error?: string;
    slug?: string;
    warnings?: string[];
  },
}));
vi.mock("@/app/actions/platform", () => ({
  seedDemoStore: vi.fn(async () => seed.result),
}));

import { ThemesPanel } from "./themes-panel";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

function theme(
  id: string,
  name: string,
  overrides: Partial<{
    status: ThemeMeta["release"]["status"];
    demo: ThemeMeta["demo"]["status"];
    industry: string;
  }> = {},
): ThemeMeta {
  return {
    id,
    name,
    description: "",
    engine: { id: "storefront-classic", version: 1 },
    release: {
      version: "1.0.0",
      status: overrides.status ?? "published",
      notes: [],
    },
    catalog: {
      visibility: "public",
      industries: [(overrides.industry ?? "clothing") as never],
      catalogSizes: ["small"],
      features: [],
      keywords: [],
      previewImage: "",
      screenshots: [],
    },
    demo: { slug: `demo-${id}`, status: overrides.demo ?? "healthy" },
  };
}

const themes = [
  theme("basket", "Basket", { industry: "food-and-drink" }),
  theme("vitrine", "Vitrine", { status: "candidate", demo: "unavailable" }),
];

function renderPanel() {
  return render(
    <ThemesPanel
      rootDomain="storemink.com"
      demoSlugsLive={["demo-basket"]}
      themes={themes}
    />,
  );
}

let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  alertSpy.mockRestore();
  seed.result = { success: true, slug: "demo-vitrine" };
});

function row(name: string) {
  return screen.getByText(name).closest("li") as HTMLElement;
}

describe("the Catalog tab's panel", () => {
  it("shows each theme's industry, release, version and demo in plain words", () => {
    const view = renderPanel();
    const basket = row("Basket");
    expect(within(basket).getByText("Food & Beverages")).toBeTruthy();
    expect(within(basket).getByText("Published · v1.0.0")).toBeTruthy();
    expect(within(basket).getByText("demo-basket.storemink.com")).toBeTruthy();
    expect(
      within(basket)
        .getByRole("link", { name: /Open the Basket demo/ })
        .getAttribute("href"),
    ).toBe("https://demo-basket.storemink.com");
    const vitrine = row("Vitrine");
    expect(within(vitrine).getByText("Not published · v1.0.0")).toBeTruthy();
    expect(
      within(vitrine).getByText(
        /demo-vitrine\.storemink\.com - not seeded yet/,
      ),
    ).toBeTruthy();
    expect(
      within(vitrine).getByText("Its demo is marked unavailable."),
    ).toBeTruthy();
    const text = view.container.textContent ?? "";
    expect(text).not.toMatch(/\b(candidate|approved|blocked)\b/i);
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
  });

  it("seeds a demo and says so on its row; the demo can then be opened", async () => {
    renderPanel();
    fireEvent.click(
      within(row("Vitrine")).getByRole("button", { name: /Seed the Vitrine/ }),
    );
    expect(await within(row("Vitrine")).findByText("Seeded.")).toBeTruthy();
    expect(
      within(row("Vitrine")).getByRole("button", {
        name: /Reseed the Vitrine/,
      }),
    ).toBeTruthy();
    expect(
      within(row("Vitrine")).getByRole("link", {
        name: /Open the Vitrine demo/,
      }),
    ).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("a failed seed is a note on the row, never an alert box", async () => {
    seed.result = { error: "Only a platform superadmin can seed demo stores." };
    renderPanel();
    fireEvent.click(
      within(row("Basket")).getByRole("button", { name: /Reseed the Basket/ }),
    );
    const note = await within(row("Basket")).findByRole("alert");
    expect(note.textContent).toBe(
      "Only a platform superadmin can seed demo stores.",
    );
    expect(note.className).toContain("studio-error");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("warnings are listed on the row", async () => {
    seed.result = {
      success: true,
      slug: "demo-basket",
      warnings: ["2 products had no image.", "The blog was skipped."],
    };
    renderPanel();
    fireEvent.click(
      within(row("Basket")).getByRole("button", { name: /Reseed the Basket/ }),
    );
    await waitFor(() =>
      expect(
        within(row("Basket")).getByText("Reseeded, with warnings:"),
      ).toBeTruthy(),
    );
    expect(
      within(row("Basket")).getByText("2 products had no image."),
    ).toBeTruthy();
    expect(
      within(row("Basket")).getByText("The blog was skipped."),
    ).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
