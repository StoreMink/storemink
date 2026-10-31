// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeMinkPrefill, takeMinkPrefill } from "@/lib/mink/form-prefill";
import { ITEM, itemBlockedBanner } from "@/lib/moderation/copy";
import { CategoriesManagementView } from "./categories-management-view";
import type { Category } from "./page";

const R = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => R,
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...p}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/category-actions", () => ({
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
}));
vi.mock("@/components/ui/image-upload", () => ({
  ImageUpload: () => <div data-testid="image-upload" />,
}));
vi.mock("@/app/dashboard/components/import-export-menu", () => ({
  ImportExportMenu: () => null,
}));

const category: Category = {
  id: "cat-1",
  name: "Coffee",
  slug: "coffee",
  description: null,
  image_url: null,
  sort_order: 0,
  status: "active",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  product_count: 2,
};

const NOTICE = "Filled in by Mink AI. Review every field before saving.";

describe("CategoriesManagementView with a Mink prefill", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/dashboard/categories");
  });

  it("opens the editor as a new category with the fields filled", async () => {
    storeMinkPrefill({
      kind: "category",
      fields: {
        name: "Winter Wear",
        slug: "winter-wear",
        description: "Coats, scarves and gloves",
        status: "hidden",
      },
    });
    window.history.replaceState(null, "", "?prefill=mink");
    render(<CategoriesManagementView categories={[category]} canManage />);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New category")).toBeInTheDocument();
    expect(within(dialog).getByText(NOTICE)).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Winter Wear")).toBeInTheDocument();
    expect(screen.getByDisplayValue("winter-wear")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("Coats, scarves and gloves"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Hidden")).toBeInTheDocument();
    // The merchant saves it; Mink did not.
    expect(
      screen.getByRole("button", { name: "Create category" }),
    ).toBeInTheDocument();
    expect(takeMinkPrefill("category")).toBeNull();
    expect(window.location.search).not.toContain("prefill");
  });

  it("derives the slug from the name when the prefill has none", async () => {
    storeMinkPrefill({ kind: "category", fields: { name: "Gift Boxes" } });
    window.history.replaceState(null, "", "?prefill=mink");
    render(<CategoriesManagementView categories={[]} canManage />);
    expect(await screen.findByDisplayValue("Gift Boxes")).toBeInTheDocument();
    expect(screen.getByDisplayValue("gift-boxes")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Active")).toBeInTheDocument();
  });

  it("renders the plain list when no prefill is waiting", () => {
    storeMinkPrefill({ kind: "category", fields: { name: "Stale" } });
    render(<CategoriesManagementView categories={[category]} canManage />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Stale")).not.toBeInTheDocument();
    expect(screen.getByText("Coffee")).toBeInTheDocument();
    expect(takeMinkPrefill("category")).toEqual({ name: "Stale" });
  });
});

// ── Blocked by StoreMink (takedown design 7.3) ──────────────

const tea: Category = { ...category, id: "cat-2", name: "Tea", slug: "tea" };

function rowFor(name: string): HTMLElement {
  const row = screen
    .getByText(name, { selector: ".dash-cell-title" })
    .closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

async function openMenu(name: string) {
  const user = userEvent.setup();
  await user.click(
    within(rowFor(name)).getByRole("button", { name: "Actions" }),
  );
  await screen.findAllByRole("menuitem");
  return user;
}

describe("CategoriesManagementView with a collection StoreMink blocked", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/dashboard/categories");
  });

  const blockedView = (over: Record<string, unknown> = {}) => (
    <CategoriesManagementView
      categories={[category, tea]}
      canManage
      blockedByStoreMink={{ "cat-1": "block-1" }}
      canSeeNotices
      {...over}
    />
  );

  it("reads Blocked by StoreMink in place of the collection's status", () => {
    render(blockedView());
    expect(within(rowFor("Coffee")).getByText(ITEM.blocked)).toHaveClass(
      "dash-badge-storemink",
    );
    expect(within(rowFor("Coffee")).queryByText("Active")).toBeNull();
    // ★ The other collection is untouched.
    expect(within(rowFor("Tea")).getByText("Active")).toBeInTheDocument();
    expect(within(rowFor("Tea")).queryByText(ITEM.blocked)).toBeNull();
  });

  it("shows the editor banner for the blocked collection, with See why", () => {
    render(blockedView());
    const banners = screen.getAllByTestId("category-blocked-banner");
    expect(banners).toHaveLength(1);
    expect(banners[0]).toHaveAttribute("role", "status");
    expect(banners[0]).toHaveTextContent("Coffee");
    expect(banners[0]).toHaveTextContent(
      `${ITEM.blocked}. ${itemBlockedBanner("collection")}`,
    );
    expect(
      within(banners[0]).getByRole("link", { name: ITEM.seeWhy }),
    ).toHaveAttribute("href", "/dashboard/settings/notices/block-1");
  });

  it("offers See why in the row menu and keeps Edit and Delete", async () => {
    render(blockedView());
    const user = await openMenu("Coffee");
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: ITEM.seeWhyItIsBlocked }),
    );
    expect(R.push).toHaveBeenCalledWith("/dashboard/settings/notices/block-1");
  });

  it("no See why for an admin who cannot open the notices", async () => {
    render(blockedView({ canSeeNotices: false }));
    const banner = screen.getByTestId("category-blocked-banner");
    expect(within(banner).queryByRole("link")).toBeNull();
    await openMenu("Coffee");
    expect(
      screen.queryByRole("menuitem", { name: ITEM.seeWhyItIsBlocked }),
    ).toBeNull();
  });

  it("a block kept from the store shows nothing (D21)", async () => {
    // An untold block never reaches the list: nothing is marked.
    render(blockedView({ blockedByStoreMink: {} }));
    expect(screen.queryByText(ITEM.blocked)).toBeNull();
    expect(screen.queryByTestId("category-blocked-banner")).toBeNull();
    await openMenu("Coffee");
    expect(
      screen.queryByRole("menuitem", { name: ITEM.seeWhyItIsBlocked }),
    ).toBeNull();
  });
});

describe("the collection editor while StoreMink blocks the collection", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/dashboard/categories");
  });

  async function openEditor(name: string, over: Record<string, unknown> = {}) {
    render(
      <CategoriesManagementView
        categories={[category, tea]}
        canManage
        blockedByStoreMink={{ "cat-1": "block-1" }}
        canSeeNotices
        {...over}
      />,
    );
    const user = await openMenu(name);
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await screen.findByRole("dialog");
    return user;
  }

  it("shows the notice banner and keeps the status, with the reason under it", async () => {
    const actions = await import("@/app/actions/category-actions");
    vi.mocked(actions.updateCategory).mockResolvedValue({ success: true });
    const user = await openEditor("Coffee");

    const banner = screen.getByTestId("category-editor-blocked-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent(
      `${ITEM.blocked}. ${itemBlockedBanner("collection")}`,
    );
    expect(
      within(banner).getByRole("link", { name: ITEM.seeWhy }),
    ).toHaveAttribute("href", "/dashboard/settings/notices/block-1");

    // ★ The status cannot be changed while the block stands, and the
    // reason is written under the select, not hidden in a tooltip.
    const status = screen.getByLabelText("Status");
    expect(status).toBeDisabled();
    expect(status).toHaveValue("active");
    expect(status).toHaveAccessibleDescription(ITEM.blocked);

    // Every other field stays open, and a save keeps the saved status.
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(actions.updateCategory).toHaveBeenCalledWith(
      "cat-1",
      expect.objectContaining({ status: "active" }),
    );
  });

  it("no See why in the editor for an admin who cannot open the notices", async () => {
    await openEditor("Coffee", { canSeeNotices: false });
    const banner = screen.getByTestId("category-editor-blocked-banner");
    expect(within(banner).queryByRole("link")).toBeNull();
    expect(screen.getByLabelText("Status")).toBeDisabled();
  });

  it("a collection with no block edits as before", async () => {
    const user = await openEditor("Tea");
    expect(screen.queryByTestId("category-editor-blocked-banner")).toBeNull();
    const status = screen.getByLabelText("Status");
    expect(status).toBeEnabled();
    expect(status).not.toHaveAttribute("aria-describedby");
    await user.selectOptions(status, "hidden");
    expect(status).toHaveValue("hidden");
  });

  it("a block kept from the store shows nothing in the editor (D21)", async () => {
    const user = await openEditor("Coffee", { blockedByStoreMink: {} });
    expect(screen.queryByTestId("category-editor-blocked-banner")).toBeNull();
    const status = screen.getByLabelText("Status");
    expect(status).toBeEnabled();
    await user.selectOptions(status, "hidden");
    expect(status).toHaveValue("hidden");
  });
});
