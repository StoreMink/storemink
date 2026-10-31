// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  setStoreStatus: vi.fn(),
  deleteStore: vi.fn(),
}));
vi.mock("@/app/actions/platform", () => ({
  deleteStore: h.deleteStore,
  grantAiCredits: vi.fn(),
  setStorePlan: vi.fn(),
  setStoreStatus: h.setStoreStatus,
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
import { STORE_MANAGE_TEXT, StoreManageBar } from "./store-manage";
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

// ---------------------------------------------------------------------------
// StoreMink's holds and blocks (takedown design 6.7, plan A13).
// ---------------------------------------------------------------------------

describe("the sentences", () => {
  it("★ match the server's, word for word", () => {
    // setStoreStatus's refusal of a block-suspended store (platform.test.ts).
    expect(STORE_MANAGE_TEXT.suspendedByBlock).toBe(
      "This store is suspended by a block on a complaint. Lift the block in Complaints.",
    );
    // STORE_DELETE_REFUSALS.archive in lib/moderation/holds.ts.
    expect(STORE_MANAGE_TEXT.deleteBlocked.archive).toBe(
      "StoreMink is still keeping a copy of something blocked on this store. Try again in a few minutes.",
    );
    expect(JSON.stringify(STORE_MANAGE_TEXT)).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("Suspend and Activate", () => {
  it("★ Suspend asks why first and sends nothing yet", () => {
    render(<StoreManageBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Suspend Echos?")).toBeTruthy();
    expect(h.setStoreStatus).not.toHaveBeenCalled();
  });

  it("Activate reactivates a store that was suspended by hand", async () => {
    h.setStoreStatus.mockResolvedValue({ success: true });
    render(<StoreManageBar {...props} status="suspended" />);
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(h.toastSuccess).toHaveBeenCalledWith("Store reactivated."),
    );
    expect(h.setStoreStatus).toHaveBeenCalledWith(props.storeId, "active");
    expect(h.refresh).toHaveBeenCalled();
  });

  it("shows the server's refusal of a reactivation in its own words", async () => {
    h.setStoreStatus.mockResolvedValue({
      error: STORE_MANAGE_TEXT.suspendedByBlock,
    });
    render(<StoreManageBar {...props} status="suspended" />);
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(
        STORE_MANAGE_TEXT.suspendedByBlock,
      ),
    );
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("★★ Activate is off, with the reason under it, while a block suspends the store", () => {
    render(<StoreManageBar {...props} status="suspended" suspendedByBlock />);
    const activate = screen.getByRole("button", {
      name: "Activate",
    }) as HTMLButtonElement;
    expect(activate.disabled).toBe(true);
    const why = document.getElementById(
      activate.getAttribute("aria-describedby") ?? "",
    );
    expect(why?.textContent).toBe(STORE_MANAGE_TEXT.suspendedByBlock);
    fireEvent.click(activate);
    expect(h.setStoreStatus).not.toHaveBeenCalled();
  });

  it("a block on an active store does not stop Suspend", () => {
    render(<StoreManageBar {...props} suspendedByBlock />);
    const suspend = screen.getByRole("button", {
      name: "Suspend",
    }) as HTMLButtonElement;
    expect(suspend.disabled).toBe(false);
  });
});

describe("Delete", () => {
  it.each(["hold", "archive", "unchecked"] as const)(
    "★★ is off with its reason while the store %s blocks it",
    (blocker) => {
      render(<StoreManageBar {...props} deleteBlocker={blocker} />);
      const del = screen.getByRole("button", {
        name: "Delete",
      }) as HTMLButtonElement;
      expect(del.disabled).toBe(true);
      const why = document.getElementById(
        del.getAttribute("aria-describedby") ?? "",
      );
      expect(why?.textContent).toBe(STORE_MANAGE_TEXT.deleteBlocked[blocker]);
      fireEvent.click(del);
      expect(screen.queryByText("Delete Echos?")).toBeNull();
    },
  );

  it("is on when nothing blocks it", () => {
    render(<StoreManageBar {...props} />);
    const del = screen.getByRole("button", {
      name: "Delete",
    }) as HTMLButtonElement;
    expect(del.disabled).toBe(false);
    expect(del.getAttribute("aria-describedby")).toBeNull();
  });

  async function confirmDelete() {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: props.slug },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  }

  it("★ a refusal the server gives (a hold set since the page was drawn) is a toast and the page stays", async () => {
    h.deleteStore.mockResolvedValue({
      error:
        "This store is on hold for an investigation, so it can't be deleted. Release the hold first.",
    });
    render(<StoreManageBar {...props} />);
    await confirmDelete();
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(
        "This store is on hold for an investigation, so it can't be deleted. Release the hold first.",
      ),
    );
    expect(h.push).not.toHaveBeenCalled();
  });

  it("a delete that left cleanup to do is a warning, then back to the list", async () => {
    h.deleteStore.mockResolvedValue({
      success: true,
      warning: "The store data was deleted, but cleanup still needs attention.",
    });
    render(<StoreManageBar {...props} />);
    await confirmDelete();
    await waitFor(() =>
      expect(h.push).toHaveBeenCalledWith("/dashboard/stores"),
    );
    expect(h.toastWarning).toHaveBeenCalledWith(
      "The store data was deleted, but cleanup still needs attention.",
    );
  });

  it("says the delete failed when the request throws", async () => {
    h.deleteStore.mockRejectedValue(new Error("network"));
    render(<StoreManageBar {...props} />);
    await confirmDelete();
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(
        "Could not delete the store. Please try again.",
      ),
    );
    expect(h.push).not.toHaveBeenCalled();
  });
});
