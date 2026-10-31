// @vitest-environment jsdom
// The Refunds page's table and its dialogs (renewal-cancel, design 7.2).
//
// Three things matter more than the layout: a member sees the refunds and
// no button, every dialog shows the action's own refusal word for word, and
// each button calls the action it names with the refund it is on.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConsoleCreditNoteRow,
  RefundListRow,
} from "@/lib/billing/refunds";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  sendRefund: vi.fn(),
  retryRefund: vi.fn(),
  cancelRefund: vi.fn(),
  recordRefundMadeOutside: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: state.refresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: state.toastSuccess, error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/platform-billing", () => ({
  sendRefund: state.sendRefund,
  retryRefund: state.retryRefund,
  cancelRefund: state.cancelRefund,
  recordRefundMadeOutside: state.recordRefundMadeOutside,
}));

import {
  CreditNotesTable,
  REFUND_REASON_LABEL,
  REFUND_STATUS_LABEL,
  REQUEST_FAILED_MESSAGE,
  RecordRefundDialog,
  RefundTabs,
  RefundsTable,
  reasonLabel,
} from "./refunds-table";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function refund(over: Partial<RefundListRow> = {}): RefundListRow {
  return {
    id: "ref-1",
    invoiceId: "inv-1",
    invoiceRef: "SM/2026-27/000123",
    storeId: "store-1",
    storeName: "Acme Retail",
    storeSlug: "acme",
    attemptId: "att-1",
    providerPaymentId: "pay_1",
    reason: "cycle_not_reached",
    status: "owed",
    method: "razorpay",
    amountPaise: 240_000,
    providerRefundId: null,
    externalReference: null,
    failureReason: null,
    requestedBy: "system",
    note: null,
    resolutionNote: null,
    createdAt: "2026-10-28T06:30:00.000Z",
    sentAt: null,
    resolvedAt: null,
    notifiedAt: null,
    needsPerson: true,
    ...over,
  };
}

function note(over: Partial<ConsoleCreditNoteRow> = {}): ConsoleCreditNoteRow {
  return {
    id: "cn-1",
    creditNoteRef: "SMCN/2026-27/000004",
    issuedAt: "2026-10-28T06:30:00.000Z",
    reason: "cycle_not_reached",
    totalPaise: 240_000,
    invoiceId: "inv-1",
    invoiceRef: "SM/2026-27/000123",
    storeId: "store-1",
    storeName: "Acme Retail",
    storeSlug: "acme",
    ...over,
  };
}

describe("the tabs", () => {
  it("links each tab and marks the open one", () => {
    render(<RefundTabs tab="done" needsPerson={2} />);
    const done = screen.getByRole("link", { name: "Done" });
    expect(done.getAttribute("href")).toBe(
      "/dashboard/billing/refunds?tab=done",
    );
    expect(done.getAttribute("aria-current")).toBe("page");
    expect(
      screen.getByRole("link", { name: "Credit notes" }).getAttribute("href"),
    ).toBe("/dashboard/billing/refunds?tab=credit_notes");
  });

  it("★ shows the count at zero too, and leaves it off when it was not read", () => {
    const { rerender } = render(
      <RefundTabs tab="needs_person" needsPerson={0} />,
    );
    const tab = screen.getByRole("link", { name: /Needs a person/ });
    expect(within(tab).getByText("0")).toBeTruthy();
    expect(tab.className).not.toContain("has-alert");
    rerender(<RefundTabs tab="needs_person" needsPerson={3} />);
    expect(
      screen.getByRole("link", { name: /Needs a person/ }).className,
    ).toContain("has-alert");
    rerender(<RefundTabs tab="needs_person" needsPerson={null} />);
    expect(
      within(screen.getByRole("link", { name: /Needs a person/ })).queryByText(
        /\d/,
      ),
    ).toBeNull();
  });
});

describe("the table", () => {
  it("names the store, the invoice, the reason, the amount and the status", () => {
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[refund()]}
        creditNotes={[]}
        canManage
      />,
    );
    expect(screen.getByText("Acme Retail")).toBeTruthy();
    expect(
      screen.getByText("Acme Retail").closest("a")?.getAttribute("href"),
    ).toBe("/dashboard/stores/store-1");
    expect(screen.getByText("SM/2026-27/000123")).toBeTruthy();
    expect(screen.getByText("Plan ended before this cycle")).toBeTruthy();
    expect(screen.getByText("₹2,400")).toBeTruthy();
    expect(screen.getByText("Owed")).toBeTruthy();
    expect(screen.getByText("Asked by the billing run")).toBeTruthy();
  });

  it("says Deleted store when the store is gone", () => {
    render(
      <RefundsTable
        tab="done"
        refunds={[
          refund({ storeId: null, storeName: null, status: "processed" }),
        ]}
        creditNotes={[]}
        canManage
      />,
    );
    expect(screen.getByText("Deleted store")).toBeTruthy();
  });

  it("★★ a member sees the refunds and no button at all", () => {
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[
          refund(),
          refund({ id: "ref-2", status: "failed", failureReason: "Too old" }),
        ]}
        creditNotes={[]}
        canManage={false}
      />,
    );
    expect(screen.getAllByText("Acme Retail")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Actions")).toBeNull();
    expect(
      screen.getByText(
        "Only a platform superadmin can send, cancel or record refunds.",
      ),
    ).toBeTruthy();
  });

  it("offers Send, Cancel and Record on an owed refund", () => {
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[refund()]}
        creditNotes={[]}
        canManage
      />,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Record a refund made outside StoreMink",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers Try again and Record on a failed one, and nothing on a finished one", () => {
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[
          refund({ status: "failed", failureReason: "Payment too old" }),
          refund({ id: "ref-2", status: "processed", needsPerson: false }),
        ]}
        creditNotes={[]}
        canManage
      />,
    );
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByText("Why it failed: Payment too old")).toBeTruthy();
  });

  it("shows an empty state that says what lands on the tab", () => {
    render(
      <RefundsTable
        tab="in_progress"
        refunds={[]}
        creditNotes={[]}
        canManage
      />,
    );
    expect(screen.getByText("Nothing in progress")).toBeTruthy();
  });
});

describe("Send", () => {
  it("calls sendRefund with the refund and refreshes on success", async () => {
    state.sendRefund.mockResolvedValue({
      success: true,
      refundId: "ref-1",
      status: "processed",
    });
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[refund()]}
        creditNotes={[]}
        canManage
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(state.sendRefund).toHaveBeenCalledWith("ref-1"));
    await waitFor(() => expect(state.refresh).toHaveBeenCalled());
    expect(state.toastSuccess).toHaveBeenCalledWith("Refunded.");
  });

  it("★★ shows the action's own refusal under the row", async () => {
    state.sendRefund.mockResolvedValue({
      error: "That refund has already moved on. Refresh the page.",
      refundId: "ref-1",
    });
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[refund()]}
        creditNotes={[]}
        canManage
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That refund has already moved on. Refresh the page.",
    );
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("says the request failed only when the call itself threw", async () => {
    state.sendRefund.mockRejectedValue(new Error("network"));
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[refund()]}
        creditNotes={[]}
        canManage
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      REQUEST_FAILED_MESSAGE,
    );
  });
});

describe("Cancel", () => {
  it("asks for a reason and sends it with the refund", async () => {
    state.cancelRefund.mockResolvedValue({
      success: true,
      refundId: "ref-1",
      status: "cancelled",
    });
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[refund()]}
        creditNotes={[]}
        canManage
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Cancel this refund?")).toBeTruthy();
    expect(
      screen.getByText("₹2,400 for invoice SM/2026-27/000123, Acme Retail"),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Paid by bank transfer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel refund" }));
    await waitFor(() =>
      expect(state.cancelRefund).toHaveBeenCalledWith(
        "ref-1",
        "Paid by bank transfer",
      ),
    );
    await waitFor(() => expect(state.refresh).toHaveBeenCalled());
  });

  it("★★ shows the action's refusal, not a sentence of its own", async () => {
    state.cancelRefund.mockResolvedValue({
      error: "Write why this refund is being cancelled.",
      refundId: "ref-1",
    });
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[refund()]}
        creditNotes={[]}
        canManage
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel refund" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Write why this refund is being cancelled.",
    );
    expect(screen.getByText("Cancel this refund?")).toBeTruthy();
  });
});

describe("Try again", () => {
  it("names why the last one failed and retries with the note", async () => {
    state.retryRefund.mockResolvedValue({
      success: true,
      refundId: "ref-9",
      status: "pending",
    });
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[refund({ status: "failed", failureReason: "Bank declined" })]}
        creditNotes={[]}
        canManage
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      screen.getByText(
        "Razorpay refused the last one: Bank declined. Add a note for the record.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Merchant asked again" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    await waitFor(() =>
      expect(state.retryRefund).toHaveBeenCalledWith(
        "ref-1",
        "Merchant asked again",
      ),
    );
    expect(state.toastSuccess).toHaveBeenCalledWith(
      "Sent. Waiting for Razorpay to confirm it.",
    );
  });
});

describe("Record a refund made outside StoreMink", () => {
  it("prefills the amount and sends the refund it settles", async () => {
    state.recordRefundMadeOutside.mockResolvedValue({
      success: true,
      refundId: "ref-1",
      status: "recorded",
    });
    render(
      <RefundsTable
        tab="needs_person"
        refunds={[refund()]}
        creditNotes={[]}
        canManage
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Record a refund made outside StoreMink",
      }),
    );
    expect(
      (screen.getByLabelText("Amount (₹)") as HTMLInputElement).value,
    ).toBe("2400");
    fireEvent.change(screen.getByLabelText("Reference"), {
      target: { value: "UTR123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record refund" }));
    await waitFor(() =>
      expect(state.recordRefundMadeOutside).toHaveBeenCalledWith({
        refundId: "ref-1",
        invoiceId: "inv-1",
        attemptId: "att-1",
        amountInr: "2400",
        method: "bank_transfer",
        reference: "UTR123456",
        note: "",
      }),
    );
  });

  it("★★ shows the action's refusal word for word", async () => {
    state.recordRefundMadeOutside.mockResolvedValue({
      error: "Add the UTR or Razorpay refund id.",
    });
    render(
      <RecordRefundDialog
        target={{
          storeId: null,
          invoiceId: "inv-1",
          attemptId: "att-1",
          amountPaise: 50_000,
          summary: "₹500 for invoice SM/1",
        }}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Record refund" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Add the UTR or Razorpay refund id.",
    );
    // A deleted store is named as such (null), never left out.
    expect(state.recordRefundMadeOutside).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: null, refundId: null }),
    );
  });
});

describe("the Credit notes tab", () => {
  it("lists each note with a Print link to the console's own page", () => {
    render(
      <RefundsTable
        tab="credit_notes"
        refunds={[]}
        creditNotes={[
          note(),
          note({
            id: "cn-2",
            creditNoteRef: "SMCN/2026-27/000005",
            reason: "invoice_cancelled",
          }),
        ]}
        canManage={false}
      />,
    );
    const print = screen.getByRole("link", {
      name: "Print SMCN/2026-27/000004",
    });
    expect(print.getAttribute("href")).toBe(
      "/dashboard/billing/credit-notes/cn-1",
    );
    expect(screen.getByText("Unpaid invoice cancelled")).toBeTruthy();
  });

  it("says when there are none", () => {
    render(<CreditNotesTable notes={[]} />);
    expect(screen.getByText("No credit notes yet")).toBeTruthy();
  });
});

describe("the words", () => {
  it("has a label for every status and reason", () => {
    expect(Object.keys(REFUND_STATUS_LABEL).sort()).toEqual(
      [
        "cancelled",
        "failed",
        "owed",
        "pending",
        "processed",
        "recorded",
      ].sort(),
    );
    expect(Object.keys(REFUND_REASON_LABEL)).toHaveLength(7);
    expect(reasonLabel("something_new")).toBe("Other");
  });
});
