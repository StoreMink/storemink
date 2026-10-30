// @vitest-environment jsdom
// The operator console's stores list: Suspend, Activate and Delete per row
// (takedown design 6.7, plan A13).
//
// ★ Suspend asks why in the same dialog the store page uses; refusals are
// in-app (a toast, or the delete dialog's own error line), never a browser
// alert.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformStoreRow } from "@/app/actions/platform";

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  setStoreStatus: vi.fn(),
  deleteStore: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh, push: h.push }),
}));
vi.mock("sonner", () => ({
  toast: {
    success: h.toastSuccess,
    error: h.toastError,
    warning: h.toastWarning,
  },
}));
vi.mock("@/app/actions/platform", () => ({
  setStoreStatus: h.setStoreStatus,
  deleteStore: h.deleteStore,
  setStorePlan: vi.fn(),
  grantAiCredits: vi.fn(),
}));

import { StoresConsole } from "./stores-console";

const HOLD_REFUSAL =
  "This store is on hold for an investigation, so it can't be deleted. Release the hold first.";
const BLOCK_REFUSAL =
  "This store is suspended by a block on a complaint. Lift the block in Complaints.";

function row(over: Partial<PlatformStoreRow> = {}): PlatformStoreRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "echos",
    name: "Echos",
    status: "active",
    plan: "pro",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
    custom_domain: null,
    created_at: "2026-10-01T00:00:00.000Z",
    owner_email: "owner@echos.in",
    ai_used: 0,
    credit_balance: 0,
    gateway: "none",
    ...over,
  };
}

function renderList(stores: PlatformStoreRow[], canManage = true) {
  render(
    <StoresConsole
      stores={stores}
      canManage={canManage}
      email="ops@storemink.com"
      q=""
      rootDomain="storemink.com"
      includedCredits={{ free: 20, basic: 100, pro: 300 }}
    />,
  );
}

let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  alertSpy.mockRestore();
});

describe("StoresConsole", () => {
  it("★ Suspend opens the shared why-dialog and sends nothing yet", () => {
    renderList([row()]);
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Suspend Echos?")).toBeTruthy();
    expect(h.setStoreStatus).not.toHaveBeenCalled();
  });

  it("Activate reactivates the row's store", async () => {
    h.setStoreStatus.mockResolvedValue({ success: true });
    renderList([row({ status: "suspended" })]);
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(h.toastSuccess).toHaveBeenCalledWith("Store reactivated."),
    );
    expect(h.setStoreStatus).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "active",
    );
    expect(h.refresh).toHaveBeenCalled();
  });

  it("★ a refused reactivation is a toast in the server's words, never an alert", async () => {
    h.setStoreStatus.mockResolvedValue({ error: BLOCK_REFUSAL });
    renderList([row({ status: "suspended" })]);
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(BLOCK_REFUSAL),
    );
    expect(alertSpy).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  async function confirmDelete() {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.change(screen.getByPlaceholderText("echos"), {
      target: { value: "echos" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
  }

  it("★ a held store's refusal shows in the delete dialog", async () => {
    h.deleteStore.mockResolvedValue({ error: HOLD_REFUSAL });
    renderList([row()]);
    await confirmDelete();
    await waitFor(() => expect(screen.getByText(HOLD_REFUSAL)).toBeTruthy());
    expect(h.refresh).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("a delete with cleanup left is a warning toast, never an alert", async () => {
    h.deleteStore.mockResolvedValue({
      success: true,
      warning: "The store data was deleted, but cleanup still needs attention.",
    });
    renderList([row()]);
    await confirmDelete();
    await waitFor(() =>
      expect(h.toastWarning).toHaveBeenCalledWith(
        "The store data was deleted, but cleanup still needs attention.",
      ),
    );
    expect(alertSpy).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a member gets no Suspend, Activate or Delete", () => {
    renderList(
      [row(), row({ id: "x", slug: "b", status: "suspended" })],
      false,
    );
    expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
