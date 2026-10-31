// @vitest-environment jsdom
// The plain Suspend, asked why (takedown design 6.7, plan A13).
//
// ★ A complaint never reaches `setStoreStatus`: the dialog sends the operator
// to the block form instead. Any other reason needs a note, which is sent as
// `{ kind: "other", note }`. The sentences the dialog says first are the
// server's own, pinned here to the same words platform.test.ts pins.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  setStoreStatus: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/app/actions/platform", () => ({
  setStoreStatus: h.setStoreStatus,
}));
vi.mock("sonner", () => ({
  toast: { success: h.toastSuccess, error: vi.fn() },
}));

import {
  SUSPEND_DIALOG_TEXT,
  SuspendStoreDialog,
  suspendOnComplaintHref,
} from "./suspend-store-dialog";

const STORE_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function open(over: { onClose?: () => void; onSuspended?: () => void } = {}) {
  const onClose = over.onClose ?? vi.fn();
  const onSuspended = over.onSuspended ?? vi.fn();
  render(
    <SuspendStoreDialog
      storeId={STORE_ID}
      storeName="Echos"
      onClose={onClose}
      onSuspended={onSuspended}
    />,
  );
  return { onClose, onSuspended, dialog: screen.getByRole("dialog") };
}

describe("the sentences", () => {
  it("★ says what setStoreStatus answers, word for word", () => {
    // platform.test.ts pins the server's side to these same literals.
    expect(SUSPEND_DIALOG_TEXT.useBlock).toBe(
      "Use Suspend on a complaint instead, so that StoreMink keeps a copy of the store and tells its owners.",
    );
    expect(SUSPEND_DIALOG_TEXT.noteMissing).toBe(
      "Write why you are suspending this store.",
    );
  });

  it("carries no long dash", () => {
    const words =
      JSON.stringify(SUSPEND_DIALOG_TEXT) + SUSPEND_DIALOG_TEXT.title("Echos");
    expect(words).not.toMatch(/[\u2013\u2014]/);
  });

  it("links Suspend on a complaint to the block form for the whole store", () => {
    expect(suspendOnComplaintHref(STORE_ID)).toBe(
      `/dashboard/complaints/block?store=${STORE_ID}&kind=store`,
    );
    expect(suspendOnComplaintHref("a b&c")).toBe(
      "/dashboard/complaints/block?store=a%20b%26c&kind=store",
    );
  });
});

describe("SuspendStoreDialog", () => {
  it("asks why before it offers anything to press", () => {
    const { dialog } = open();
    expect(within(dialog).getByText("Suspend Echos?")).toBeTruthy();
    expect(
      within(dialog).getByRole("radiogroup", {
        name: SUSPEND_DIALOG_TEXT.question,
      }),
    ).toBeTruthy();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
    expect(
      within(dialog).queryByRole("button", {
        name: SUSPEND_DIALOG_TEXT.confirm,
      }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("link", {
        name: SUSPEND_DIALOG_TEXT.goToBlock,
      }),
    ).toBeNull();
  });

  it("★★ a complaint goes to the block form and never calls the action", () => {
    const { dialog } = open();
    fireEvent.click(
      within(dialog).getByRole("radio", {
        name: SUSPEND_DIALOG_TEXT.complaint,
      }),
    );
    expect(within(dialog).getByText(SUSPEND_DIALOG_TEXT.useBlock)).toBeTruthy();
    const link = within(dialog).getByRole("link", {
      name: SUSPEND_DIALOG_TEXT.goToBlock,
    });
    expect(link.getAttribute("href")).toBe(suspendOnComplaintHref(STORE_ID));
    expect(
      within(dialog).queryByRole("button", {
        name: SUSPEND_DIALOG_TEXT.confirm,
      }),
    ).toBeNull();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(h.setStoreStatus).not.toHaveBeenCalled();
  });

  it("another reason needs a note before anything is sent", () => {
    const { dialog } = open();
    fireEvent.click(
      within(dialog).getByRole("radio", { name: SUSPEND_DIALOG_TEXT.other }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: SUSPEND_DIALOG_TEXT.confirm }),
    );
    expect(within(dialog).getByRole("alert").textContent).toBe(
      SUSPEND_DIALOG_TEXT.noteMissing,
    );
    expect(h.setStoreStatus).not.toHaveBeenCalled();
  });

  it("sends the note as another reason and reports the suspension", async () => {
    h.setStoreStatus.mockResolvedValue({ success: true });
    const { dialog, onSuspended } = open();
    fireEvent.click(
      within(dialog).getByRole("radio", { name: SUSPEND_DIALOG_TEXT.other }),
    );
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note" }), {
      target: { value: "The owner asked us to close it for a month." },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: SUSPEND_DIALOG_TEXT.confirm }),
    );
    await waitFor(() => expect(onSuspended).toHaveBeenCalledTimes(1));
    expect(h.setStoreStatus).toHaveBeenCalledWith(STORE_ID, "suspended", {
      kind: "other",
      note: "The owner asked us to close it for a month.",
    });
    expect(h.toastSuccess).toHaveBeenCalledWith(SUSPEND_DIALOG_TEXT.done);
  });

  it("shows the server's refusal in its own words and stays open", async () => {
    h.setStoreStatus.mockResolvedValue({
      error: "Keep the note under 2,000 characters.",
    });
    const { dialog, onSuspended } = open();
    fireEvent.click(
      within(dialog).getByRole("radio", { name: SUSPEND_DIALOG_TEXT.other }),
    );
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note" }), {
      target: { value: "x" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: SUSPEND_DIALOG_TEXT.confirm }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe(
        "Keep the note under 2,000 characters.",
      ),
    );
    expect(onSuspended).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it("says the request failed when the action throws", async () => {
    h.setStoreStatus.mockRejectedValue(new Error("network"));
    const { dialog, onSuspended } = open();
    fireEvent.click(
      within(dialog).getByRole("radio", { name: SUSPEND_DIALOG_TEXT.other }),
    );
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note" }), {
      target: { value: "Owner asked" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: SUSPEND_DIALOG_TEXT.confirm }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe(
        SUSPEND_DIALOG_TEXT.failed,
      ),
    );
    expect(onSuspended).not.toHaveBeenCalled();
  });

  it("Close closes without sending anything", () => {
    const { dialog, onClose } = open();
    // The footer's Close (the dialog's own corner X is a second "Close").
    const footerClose = within(dialog)
      .getAllByRole("button", { name: "Close" })
      .find((b) => b.textContent === "Close");
    fireEvent.click(footerClose!);
    expect(onClose).toHaveBeenCalled();
    expect(h.setStoreStatus).not.toHaveBeenCalled();
  });
});
