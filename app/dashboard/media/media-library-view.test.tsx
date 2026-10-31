// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any, @next/next/no-img-element */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ITEM } from "@/lib/moderation/copy";

// A file StoreMink blocked and told the store about carries the "Blocked by
// StoreMink" label on its tile and in its view, with "See why" for an admin
// who can open the notices (takedown design 7.3). A block kept from the store
// never reaches the grid (D21), so the file shows nothing.

const R = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => R,
  usePathname: () => "/dashboard/media",
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...p}>
      {children}
    </a>
  ),
}));
vi.mock("next/image", () => ({
  default: ({ src, alt }: any) => <img src={src} alt={alt} />,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/media-actions", () => ({
  uploadMediaAsset: vi.fn(),
  deleteMediaAsset: vi.fn(),
}));
vi.mock("@/app/dashboard/components/list-pagination", () => ({
  ListPagination: () => null,
}));

import { MediaLibraryView } from "./media-library-view";

const URL_A = "https://storage.googleapis.com/sm-media/stores/s1/media/a.webp";
const URL_B = "https://storage.googleapis.com/sm-media/stores/s1/media/b.webp";

function tile(id: string, url: string): any {
  return {
    id,
    url,
    path: `stores/s1/media/${id}.webp`,
    filename: `${id}.webp`,
    content_type: "image/webp",
    size_bytes: 100,
    source: "upload",
    created_at: "2026-10-01T00:00:00Z",
    products: [],
  };
}

const base = {
  tab: "library" as const,
  assets: [tile("a", URL_A), tile("b", URL_B)],
  productImages: [],
  libraryTotal: 2,
  productTotal: 0,
  canSeeProducts: true,
  loadError: false,
  page: 1,
  pageSize: 20,
};

function tileFor(filename: string): HTMLElement {
  const button = screen.getByTitle(filename);
  const card = button.closest(".group");
  if (!card) throw new Error(`no tile for ${filename}`);
  return card as HTMLElement;
}

describe("MediaLibraryView with a file StoreMink blocked", () => {
  it("marks the blocked tile only, with See why to its notice", () => {
    render(
      <MediaLibraryView
        {...base}
        blockedByStoreMink={{ [URL_A]: "blk-a" }}
        canSeeNotices
      />,
    );
    const a = tileFor("a.webp");
    expect(within(a).getByText(ITEM.blocked)).toHaveClass(
      "dash-badge-storemink",
    );
    expect(within(a).getByRole("link", { name: ITEM.seeWhy })).toHaveAttribute(
      "href",
      "/dashboard/settings/notices/blk-a",
    );
    // ★ The other file is untouched.
    expect(within(tileFor("b.webp")).queryByText(ITEM.blocked)).toBeNull();
    expect(screen.getAllByTestId("media-blocked-mark")).toHaveLength(1);
  });

  it("no See why for an admin who cannot open the notices", () => {
    render(
      <MediaLibraryView
        {...base}
        blockedByStoreMink={{ [URL_A]: "blk-a" }}
        canSeeNotices={false}
      />,
    );
    const a = tileFor("a.webp");
    expect(within(a).getByText(ITEM.blocked)).toBeInTheDocument();
    expect(within(a).queryByRole("link")).toBeNull();
  });

  it("says so in the file's view, with See why it is blocked", async () => {
    const user = userEvent.setup();
    render(
      <MediaLibraryView
        {...base}
        blockedByStoreMink={{ [URL_A]: "blk-a" }}
        canSeeNotices
      />,
    );
    await user.click(screen.getByTitle("a.webp"));
    const status = await screen.findByTestId("media-blocked-status");
    expect(status).toHaveAttribute("role", "status");
    expect(within(status).getByText(ITEM.blocked)).toBeInTheDocument();
    expect(
      within(status).getByRole("link", { name: ITEM.seeWhyItIsBlocked }),
    ).toHaveAttribute("href", "/dashboard/settings/notices/blk-a");
  });

  it("the view of a file that is not blocked says nothing about it", async () => {
    const user = userEvent.setup();
    render(
      <MediaLibraryView
        {...base}
        blockedByStoreMink={{ [URL_A]: "blk-a" }}
        canSeeNotices
      />,
    );
    await user.click(screen.getByTitle("b.webp"));
    await screen.findByRole("dialog");
    expect(screen.queryByTestId("media-blocked-status")).toBeNull();
  });

  it("marks a blocked product photo", () => {
    render(
      <MediaLibraryView
        {...base}
        tab="products"
        assets={[]}
        productImages={[
          { url: URL_A, products: [{ id: "p1", name: "Shoe" }] },
          { url: URL_B, products: [{ id: "p2", name: "Bag" }] },
        ]}
        productTotal={2}
        blockedByStoreMink={{ [URL_A]: "blk-a" }}
        canSeeNotices
      />,
    );
    const marks = screen.getAllByTestId("media-blocked-mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].parentElement).toHaveTextContent("Shoe");
    expect(
      within(marks[0]).getByRole("link", { name: ITEM.seeWhy }),
    ).toHaveAttribute("href", "/dashboard/settings/notices/blk-a");
  });

  it("a block kept from the store shows nothing (D21)", () => {
    // An untold block never reaches the grid: nothing is marked.
    render(<MediaLibraryView {...base} canSeeNotices />);
    expect(screen.queryByText(ITEM.blocked)).toBeNull();
    expect(screen.queryByTestId("media-blocked-mark")).toBeNull();
  });
});
