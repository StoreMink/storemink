// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any, @next/next/no-img-element */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ITEM } from "@/lib/moderation/copy";

// A product StoreMink blocked and told the store about reads "Blocked by
// StoreMink" in place of its status; Publish and Unpublish wait (in its row
// menu and in the bulk bar, with the reason written under the bulk buttons),
// while Edit and Delete stay open, and "See why it is blocked" opens the
// notice for an admin who can read it (takedown design 7.3). A block kept from
// the store never reaches the list (D21), so the product shows nothing.

const R = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => R,
  usePathname: () => "/dashboard/products",
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
vi.mock("@/app/actions/product-actions", () => ({
  deleteProduct: vi.fn(async () => ({ success: true })),
  toggleProductPublish: vi.fn(async () => ({ success: true })),
  bulkToggleProductPublish: vi.fn(async () => ({ success: true })),
  bulkSetProductFeatured: vi.fn(async () => ({ success: true })),
  bulkDeleteProducts: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/app/dashboard/components/import-export-menu", () => ({
  ImportExportMenu: () => null,
}));
vi.mock("@/app/dashboard/components/list-pagination", () => ({
  ListPagination: () => null,
}));

import { ProductsManagementView } from "./products-management-view";
import {
  bulkToggleProductPublish,
  toggleProductPublish,
} from "@/app/actions/product-actions";

function item(id: string, over: Record<string, unknown> = {}): any {
  return {
    id,
    name: `Product ${id}`,
    slug: `product-${id}`,
    description: null,
    category_id: null,
    base_price: 100,
    selling_price: 100,
    cost_price: null,
    image_url: null,
    images: [],
    status: "published",
    featured: false,
    sort_order: 0,
    card_color: null,
    seo_title: null,
    seo_description: null,
    published_at: null,
    track_inventory: false,
    stock: 0,
    low_stock_threshold: null,
    allow_backorder: false,
    sku: null,
    barcode: null,
    tax_class_id: null,
    hsn_code: null,
    returnable: true,
    return_window_days: null,
    requires_shipping: true,
    weight_grams: null,
    length_cm: null,
    width_cm: null,
    height_cm: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    category: null,
    variants: [],
    ...over,
  };
}

const base = {
  products: [item("a"), item("b")],
  categories: [],
  canManage: true,
  counts: { all: 2, published: 2, drafts: 0, featured: 0 },
  total: 2,
  page: 1,
  pageSize: 20,
  query: "",
  filter: "all" as const,
  categoryFilter: "all",
};

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
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

const blockedView = (over: Record<string, unknown> = {}) => (
  <ProductsManagementView
    {...base}
    blockedByStoreMink={{ a: "blk-a" }}
    canSeeNotices
    {...over}
  />
);

describe("ProductsManagementView with a product StoreMink blocked", () => {
  it("reads Blocked by StoreMink in place of the product's status", () => {
    render(blockedView());
    expect(within(rowFor("Product a")).getByText(ITEM.blocked)).toHaveClass(
      "dash-badge-storemink",
    );
    expect(within(rowFor("Product a")).queryByText("Published")).toBeNull();
    // ★ The other product is untouched.
    expect(
      within(rowFor("Product b")).getByText("Published"),
    ).toBeInTheDocument();
    expect(within(rowFor("Product b")).queryByText(ITEM.blocked)).toBeNull();
  });

  it("disables Publish or Unpublish and offers See why in place of Preview", async () => {
    render(blockedView());
    const user = await openMenu("Product a");

    const blockedItem = screen.getByRole("menuitem", { name: ITEM.blocked });
    expect(blockedItem).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: "Unpublish" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Preview" })).toBeNull();
    // Editing and deleting stay open.
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("menuitem", { name: ITEM.seeWhyItIsBlocked }),
    );
    expect(R.push).toHaveBeenCalledWith("/dashboard/settings/notices/blk-a");
  });

  it("the disabled item changes nothing when pressed", async () => {
    render(blockedView());
    const user = await openMenu("Product a");
    await user.click(screen.getByRole("menuitem", { name: ITEM.blocked }));
    expect(toggleProductPublish).not.toHaveBeenCalled();
  });

  it("no See why for an admin who cannot open the notices", async () => {
    render(blockedView({ canSeeNotices: false }));
    await openMenu("Product a");
    expect(
      screen.getByRole("menuitem", { name: ITEM.blocked }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByRole("menuitem", { name: ITEM.seeWhyItIsBlocked }),
    ).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Preview" })).toBeNull();
  });

  it("a product that is not blocked keeps Unpublish and Preview", async () => {
    render(blockedView());
    await openMenu("Product b");
    expect(
      screen.getByRole("menuitem", { name: "Unpublish" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: "Preview" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: ITEM.blocked })).toBeNull();
  });

  it("a block kept from the store shows nothing (D21)", async () => {
    // An untold block never reaches the list: nothing is marked.
    render(blockedView({ blockedByStoreMink: {} }));
    expect(screen.queryByText(ITEM.blocked)).toBeNull();
    await openMenu("Product a");
    expect(
      screen.getByRole("menuitem", { name: "Unpublish" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: ITEM.blocked })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: ITEM.seeWhyItIsBlocked }),
    ).toBeNull();
  });
});

describe("the bulk bar with a blocked product selected", () => {
  function bulkButton(name: string): HTMLElement {
    const bar = screen.getByRole("region", { name: "Bulk actions" });
    return within(bar).getByRole("button", { name: new RegExp(`^${name}`) });
  }

  it("Publish and Unpublish wait, with the reason under them", async () => {
    const user = userEvent.setup();
    render(blockedView());
    await user.click(screen.getByLabelText("Select Product a"));

    for (const name of ["Publish", "Unpublish"]) {
      const button = bulkButton(name);
      expect(button).toBeDisabled();
      expect(within(button).getByText(ITEM.blocked)).toBeInTheDocument();
    }
    // The rest of the bar stays open.
    expect(bulkButton("Feature")).not.toBeDisabled();
    expect(bulkButton("Delete")).not.toBeDisabled();
    expect(bulkToggleProductPublish).not.toHaveBeenCalled();
  });

  it("a selection with no blocked product publishes as before", async () => {
    const user = userEvent.setup();
    render(blockedView());
    await user.click(screen.getByLabelText("Select Product b"));

    const publish = bulkButton("Publish");
    expect(publish).not.toBeDisabled();
    expect(within(publish).queryByText(ITEM.blocked)).toBeNull();
    await user.click(publish);
    expect(bulkToggleProductPublish).toHaveBeenCalledWith(["b"], true);
  });
});
