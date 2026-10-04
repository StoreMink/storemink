// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
const h = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/app/actions/platform", () => ({
  deleteStore: vi.fn(),
  grantAiCredits: vi.fn(),
  setStorePlan: vi.fn(),
  setStoreStatus: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { StoreManageBar } from "./store-manage";
const props = {
  storeId: "11111111-1111-4111-8111-111111111111",
  slug: "echos",
  name: "Echos",
  status: "active",
  plan: "pro" as const,
  canManage: true,
};
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(cleanup);
it("does not offer store-level Mink availability switches", () => {
  render(<StoreManageBar {...props} />);
  expect(
    screen.queryByRole("button", { name: /enable Mink|disable Mink/i }),
  ).toBeNull();
});
it("does not expose management controls to a read-only operator", () => {
  render(<StoreManageBar {...props} canManage={false} />);
  expect(screen.queryByRole("button")).toBeNull();
});
