// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeMinkPrefill, takeMinkPrefill } from "@/lib/mink/form-prefill";
import { CategoriesManagementView } from "./categories-management-view";
import type { Category } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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
