// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ITEM, itemBlockedBanner } from "@/lib/moderation/copy";

// A product StoreMink blocked and told the store about opens with the editor
// banner and the "Blocked by StoreMink" label in place of its status, with
// "See why" for an admin who can open the notices (takedown design 7.3). The
// product stays editable. A block kept from the store never reaches the
// editor (D21), so it shows nothing.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...p}>
      {children}
    </a>
  ),
}));
vi.mock("./product-editor-form", async () => {
  const React = await import("react");
  return {
    ProductEditorForm: React.forwardRef(function FormStub() {
      return <div data-testid="product-form">form</div>;
    }),
  };
});

import { ProductEditorPanel } from "./product-edit-panel";
import type { Product } from "./page";

function product(over: Partial<Product> = {}): Product {
  return {
    id: "p1",
    name: "Shoe",
    slug: "shoe",
    status: "published",
    ...over,
  } as Product;
}

function renderPanel(p: Product | null) {
  return render(
    <ProductEditorPanel product={p} categories={[]} taxClasses={[]} />,
  );
}

describe("ProductEditorPanel and StoreMink's block", () => {
  it("shows the banner and the label, with See why to the notice", () => {
    renderPanel(
      product({
        blockedByStoreMink: { blockId: "blk-1", canSeeNotices: true },
      }),
    );
    const banner = screen.getByTestId("product-blocked-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent(
      `${ITEM.blocked}. ${itemBlockedBanner("product")}`,
    );
    expect(
      within(banner).getByRole("link", { name: ITEM.seeWhy }),
    ).toHaveAttribute("href", "/dashboard/settings/notices/blk-1");

    const header = screen.getByRole("banner");
    expect(within(header).getByText(ITEM.blocked)).toHaveClass(
      "dash-badge-storemink",
    );
    expect(within(header).queryByText("Published")).toBeNull();
    // A blocked product's page is not found for shoppers.
    expect(screen.queryByText("View in store")).toBeNull();
    // Editing stays open.
    expect(screen.getByTestId("product-form")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save changes" }),
    ).not.toBeDisabled();
  });

  it("no See why for an admin who cannot open the notices", () => {
    renderPanel(
      product({
        blockedByStoreMink: { blockId: "blk-1", canSeeNotices: false },
      }),
    );
    const banner = screen.getByTestId("product-blocked-banner");
    expect(within(banner).queryByRole("link")).toBeNull();
  });

  it("a product with no told block shows nothing (D21)", () => {
    renderPanel(product());
    expect(screen.queryByTestId("product-blocked-banner")).toBeNull();
    expect(screen.queryByText(ITEM.blocked)).toBeNull();
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.getByText("View in store")).toBeInTheDocument();
  });

  it("a new product shows nothing", () => {
    renderPanel(null);
    expect(screen.queryByTestId("product-blocked-banner")).toBeNull();
    expect(screen.queryByText(ITEM.blocked)).toBeNull();
  });
});
