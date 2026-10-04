// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrdersManagementView } from "./orders-management-view";
import type { OrderRow } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard/orders",
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("./order-detail-drawer", () => ({
  OrderDetailDrawer: ({ onClose }: { onClose: () => void }) => (
    <div>
      <p>Order detail contents</p>
      <button onClick={onClose}>Close detail</button>
    </div>
  ),
}));
vi.mock("@/app/dashboard/components/import-export-menu", () => ({
  ImportExportMenu: () => null,
}));
const order: OrderRow = {
  id: "o1",
  order_no: 123,
  order_ref: "ORD123",
  created_at: "2026-09-20T12:00:00Z",
  total: 999,
  payment_method: "cod",
  payment_status: "pending",
  status: "processing",
  shipping_address: {
    firstName: "Sample",
    lastName: "Customer",
    city: "Bengaluru",
    state: "Karnataka",
  },
  sales_channel: "website",
  receipt_no: null,
  cashier_name: null,
  customer_first_name: null,
  customer_last_name: null,
  customer_phone: null,
  customer_email: null,
  location_name: null,
  fulfilment_type: "delivery",
  pickup_status: null,
};
const props = {
  orders: [order],
  total: 1,
  counts: {
    all: 1,
    pending: 0,
    processing: 1,
    shipped: 0,
    delivered: 0,
    completed: 0,
    cancelled: 0,
  },
  channelCounts: { all: 1, website: 1, pos: 0 },
  page: 1,
  pageSize: 50,
  query: "",
  status: "",
  paymentStatus: "",
  paymentMethod: "",
  dateRange: "",
  channel: "all" as const,
  supportsPos: true,
};
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: innerWidth < 768,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});
describe("responsive order detail", () => {
  it("opens a phone dialog from an accessible reference and returns to the list", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    render(<OrdersManagementView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "View order ORD123" }));
    expect(
      await screen.findByRole("dialog", { name: "Order ORD123" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "View order ORD123" }),
    ).toBeInTheDocument();
  });
  it("keeps the desktop detail docked beside the list", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    const { container } = render(<OrdersManagementView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "View order ORD123" }));
    expect(
      container.querySelector("aside[data-mink-resource-id='o1']"),
    ).toHaveTextContent("Order detail contents");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
