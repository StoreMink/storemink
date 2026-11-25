// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ITEM } from "@/lib/moderation/copy";

// A review StoreMink removed and told the store about reads "Removed by
// StoreMink" on the customer's page, with See why for an admin who can open
// the notices (takedown design 7.3). Every other review is unchanged.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...p}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/customer-actions", () => ({
  deleteCustomer: vi.fn(),
  updateCustomer: vi.fn(),
}));

import { CustomerDetail } from "./customer-detail";
import type { CustomerDetail as CustomerDetailType } from "./shared";

function customer(reviews: CustomerDetailType["reviews"]): CustomerDetailType {
  return {
    id: "u1",
    phone: "+919876543210",
    email: "a@example.com",
    first_name: "Asha",
    last_name: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    review_count: reviews.length,
    blog_count: 0,
    reviews,
    blogs: [],
  };
}

const removed = {
  id: "r1",
  rating: 2,
  comment: "Removed words",
  created_at: "2026-10-01T00:00:00Z",
  product_id: "p1",
  product_name: "Almond shake",
  storemink_block_id: "b1",
};
const kept = {
  id: "r2",
  rating: 5,
  comment: "Kept words",
  created_at: "2026-10-02T00:00:00Z",
  product_id: "p2",
  product_name: "Oat shake",
  storemink_block_id: null,
};

function itemFor(text: string): HTMLElement {
  const item = screen.getByText(text).closest("li");
  if (!item) throw new Error(`no review for ${text}`);
  return item;
}

describe("CustomerDetail and reviews removed by StoreMink", () => {
  it("reads Removed by StoreMink with See why on the removed review only", () => {
    render(
      <CustomerDetail
        customer={customer([removed, kept])}
        canManage={false}
        canSeeNotices
      />,
    );

    const gone = itemFor("Removed words");
    expect(within(gone).getByText(ITEM.removed)).toHaveClass(
      "dash-badge-storemink",
    );
    expect(
      within(gone).getByRole("link", { name: ITEM.seeWhy }),
    ).toHaveAttribute("href", "/dashboard/settings/notices/b1");

    // ★ The other review is untouched.
    const other = itemFor("Kept words");
    expect(within(other).queryByText(ITEM.removed)).toBeNull();
    expect(within(other).queryByRole("link")).toBeNull();
  });

  it("shows no See why to an admin who cannot open the notices", () => {
    render(<CustomerDetail customer={customer([removed])} canManage={false} />);
    const gone = itemFor("Removed words");
    expect(within(gone).getByText(ITEM.removed)).toBeInTheDocument();
    expect(within(gone).queryByRole("link")).toBeNull();
  });

  it("★ shows nothing for reviews with no told block (D21)", () => {
    render(
      <CustomerDetail
        customer={customer([
          kept,
          { ...removed, storemink_block_id: undefined },
        ])}
        canManage={false}
        canSeeNotices
      />,
    );
    expect(screen.queryByText(ITEM.removed)).toBeNull();
  });
});

// The delete guard: a customer the server would refuse shows the reason and
// a disabled Delete; unknown counts leave Delete available.
describe("CustomerDetail delete guard", () => {
  it("disables Delete and says why when the customer has orders", () => {
    render(
      <CustomerDetail
        customer={{ ...customer([]), order_count: 2, has_orders: true }}
        canManage
      />,
    );
    expect(
      screen.getByRole("button", { name: /delete customer/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "This customer has 2 orders, so they can't be deleted. Their order history is part of your records.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 orders ·/)).toBeInTheDocument();
  });

  it("disables Delete for a customer holding store credit, and shows it", () => {
    render(
      <CustomerDetail
        customer={{
          ...customer([]),
          order_count: 0,
          has_orders: false,
          store_credit: 75,
        }}
        canManage
      />,
    );
    expect(
      screen.getByRole("button", { name: /delete customer/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/of store credit, so they can't/),
    ).toBeInTheDocument();
    expect(screen.getByText("Store credit")).toBeInTheDocument();
  });

  it("leaves Delete available when the counts are unknown", () => {
    render(
      <CustomerDetail
        customer={{ ...customer([]), order_count: null, has_orders: null }}
        canManage
      />,
    );
    expect(
      screen.getByRole("button", { name: /delete customer/i }),
    ).toBeEnabled();
    expect(screen.queryByText(/can't be deleted/)).toBeNull();
  });
});
