// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderClient } from "./builder-client";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import { themeDesignDefaults } from "@/lib/chrome/design";
import { schemeDesignFor } from "@/lib/themes/schemes";
import { ITEM, itemBlockedBanner } from "@/lib/moderation/copy";

// A page StoreMink blocked and told the store about (takedown design 7.3):
// the open page's status and its dot in the rail read "Blocked by StoreMink",
// a banner explains it with See why, and nothing about editing, saving or
// publishing changes. The autosave status `blocked` (a stale tab) is a
// different thing and keeps its own dialog.

const H = vi.hoisted(() => ({ status: "saved" as string }));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("@/app/actions/page-actions", () => ({
  getPageDraft: vi.fn(async (id: string) => ({
    id,
    slug: id === "home" ? "" : id,
    title: id === "home" ? "Home" : "About",
    status: "published",
    updated_at: "2026-10-30",
    sections: [],
  })),
  createPage: vi.fn(),
  deletePage: vi.fn(),
  publishPage: vi.fn(),
  unpublishPage: vi.fn(),
  updatePageMeta: vi.fn(),
}));
vi.mock("@/app/actions/chrome-actions", () => ({
  saveChromeDraft: vi.fn(),
  publishChrome: vi.fn(),
}));
vi.mock("@/app/actions/store-branding", () => ({
  saveBrandAppearance: vi.fn(),
}));
vi.mock("./use-autosave", () => ({
  useAutosave: () => ({
    status: H.status,
    markDirty: vi.fn(),
    flush: vi.fn(),
    unblock: vi.fn(),
  }),
}));
vi.mock("./inspector-panel", () => ({
  InspectorPanel: () => null,
  PageSettingsForm: () => null,
}));
vi.mock("./section-library", () => ({ SectionLibrary: () => null }));

const pages = [
  {
    id: "home",
    slug: "",
    title: "Home",
    status: "published" as const,
    updated_at: "2026-10-30",
    published_at: "2026-10-30",
  },
  {
    id: "about",
    slug: "about",
    title: "About",
    status: "published" as const,
    updated_at: "2026-10-30",
    published_at: "2026-10-30",
  },
];

const base = {
  initialPages: pages,
  products: [],
  categories: [],
  blogs: [],
  storeName: "Test store",
  initialChrome: DEFAULT_CHROME,
  initialBrand: { name: "Test store", primaryColor: "#4f46e5", logoUrl: null },
  themeDefaults: themeDesignDefaults(null),
  schemeDesign: schemeDesignFor(null),
};

beforeEach(() => {
  H.status = "saved";
});

async function openBuilder(
  props: Partial<React.ComponentProps<typeof BuilderClient>>,
) {
  render(<BuilderClient {...base} {...props} />);
  // The homepage opens by itself; the top bar fills in once it has loaded.
  await screen.findByRole("button", { name: "Publish" });
}

describe("Builder page blocked by StoreMink", () => {
  it("shows the status and banner, links See why, and keeps Publish", async () => {
    await openBuilder({
      blockedByStoreMink: { home: "b1" },
      canSeeNotices: true,
    });

    const header = screen.getByRole("banner");
    // ★ The takedown mark's own class (its words read at 4.5:1 or more),
    // never the shared dash-badge-red pair.
    expect(within(header).getByText(ITEM.blocked)).toHaveClass(
      "sm-builder-status",
      "dash-badge-storemink",
    );
    expect(within(header).getByText(ITEM.blocked)).not.toHaveClass(
      "dash-badge-red",
    );
    expect(within(header).queryByText("Live")).toBeNull();

    const banner = screen.getByTestId("builder-blocked-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent(itemBlockedBanner("page"));
    expect(
      within(banner).getByRole("link", { name: ITEM.seeWhy }),
    ).toHaveAttribute("href", "/dashboard/settings/notices/b1");

    // ★ Publishing stays possible: what is published shows when the block
    // is lifted. Unpublish too.
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeEnabled();
    // And the stale-tab dialog is not what a StoreMink block opens.
    expect(screen.queryByText("This page changed somewhere else")).toBeNull();
  });

  it("marks the blocked page in the pages rail, and only that page", async () => {
    await openBuilder({ blockedByStoreMink: { about: "b2" } });

    fireEvent.click(screen.getByRole("button", { name: /^Pages\s*2$/ }));
    const about = screen.getByRole("button", { name: /About/ });
    expect(within(about).getByText(ITEM.blocked)).toBeInTheDocument();
    expect(about.querySelector(".sm-builder-dot")).toHaveAttribute(
      "title",
      ITEM.blocked,
    );
    const home = screen.getByRole("button", { name: /Homepage/ });
    expect(within(home).queryByText(ITEM.blocked)).toBeNull();

    // The open page (home) is not blocked, so no banner and the usual pill.
    expect(screen.queryByTestId("builder-blocked-banner")).toBeNull();
    expect(
      within(screen.getByRole("banner")).getByText("Live"),
    ).toBeInTheDocument();
  });

  it("★ shows nothing for a page with no told block (D21)", async () => {
    await openBuilder({ blockedByStoreMink: {} });

    expect(screen.queryByTestId("builder-blocked-banner")).toBeNull();
    expect(screen.queryByText(ITEM.blocked)).toBeNull();
    expect(
      within(screen.getByRole("banner")).getByText("Live"),
    ).toBeInTheDocument();
  });

  it("shows no See why to an admin who cannot open the notices", async () => {
    await openBuilder({ blockedByStoreMink: { home: "b1" } });

    const banner = screen.getByTestId("builder-blocked-banner");
    expect(banner).toHaveTextContent(itemBlockedBanner("page"));
    expect(within(banner).queryByRole("link")).toBeNull();
  });
});

describe("the autosave status `blocked` is a different thing", () => {
  it("still opens the stale-tab dialog and reads Paused, with no StoreMink banner", async () => {
    H.status = "blocked";
    render(<BuilderClient {...base} />);

    expect(
      await screen.findByText("This page changed somewhere else"),
    ).toBeInTheDocument();
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.queryByTestId("builder-blocked-banner")).toBeNull();
    expect(screen.queryByText(ITEM.blocked)).toBeNull();
  });
});
