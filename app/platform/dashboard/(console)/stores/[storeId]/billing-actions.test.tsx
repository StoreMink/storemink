// @vitest-environment jsdom
// The store page's billing tools (renewal-cancel, design 7.3).
//
// A member reads and a superadmin acts; every dialog calls the action it
// names with this store, and shows the action's own refusal (the merchant-
// voice ones of the cancellation code put in the operator's words).

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EndNowPreview,
  StoreBilling,
  StoreBillingInvoice,
} from "@/app/actions/platform-billing";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  cancelPlanAtCycleEnd: vi.fn(),
  undoPlanCancellation: vi.fn(),
  endPlanNow: vi.fn(),
  issueRefund: vi.fn(),
  listStoreBilling: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: state.refresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: state.toastSuccess, error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/platform-billing", () => ({
  cancelPlanAtCycleEnd: state.cancelPlanAtCycleEnd,
  undoPlanCancellation: state.undoPlanCancellation,
  endPlanNow: state.endPlanNow,
  issueRefund: state.issueRefund,
  listStoreBilling: state.listStoreBilling,
  // refunds-table.tsx imports these; nothing here calls them.
  sendRefund: vi.fn(),
  retryRefund: vi.fn(),
  cancelRefund: vi.fn(),
  recordRefundMadeOutside: vi.fn(),
}));

import {
  StoreBillingTools,
  StoreRefundsList,
  cancellingLine,
  frameMerchantError,
  issueTargetFromInvoice,
} from "./billing-actions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function invoice(over: Partial<StoreBillingInvoice> = {}): StoreBillingInvoice {
  return {
    id: "inv-1",
    invoiceRef: "SM/2026-27/000123",
    kind: "subscription",
    status: "paid",
    cycleSeq: 2,
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-10-31T00:00:00.000Z",
    totalPaise: 300_000,
    issuedAt: "2026-09-27T00:00:00.000Z",
    refundedPaise: 0,
    inProgressPaise: 0,
    leftPaise: 300_000,
    payments: [
      {
        attemptId: "att-1",
        providerPaymentId: "pay_1",
        amountPaise: 300_000,
        refundedPaise: 0,
        inProgressPaise: 0,
        leftPaise: 300_000,
      },
    ],
    cycleNotReachedFits: false,
    ...over,
  };
}

function preview(over: Partial<EndNowPreview> = {}): EndNowPreview {
  return {
    from: "2026-10-29T06:00:00.000Z",
    lines: [
      {
        invoiceId: "inv-1",
        invoiceRef: "SM/2026-27/000123",
        kind: "subscription",
        amountPaise: 20_000,
        daysLeft: 2,
        daysTotal: 30,
        skippedWhy: null,
      },
      {
        invoiceId: "inv-2",
        invoiceRef: "SM/2026-27/000130",
        kind: "addon",
        amountPaise: 0,
        daysLeft: 2,
        daysTotal: 30,
        skippedWhy:
          "SM/2026-27/000130: less than ₹1 is left, so nothing is refunded.",
      },
    ],
    totalPaise: 20_000,
    error: null,
    ...over,
  };
}

function billing(over: Partial<StoreBilling> = {}): StoreBilling {
  return {
    storeId: "store-1",
    storeName: "Acme Retail",
    storeSlug: "acme",
    storeStatus: "active",
    subscription: {
      plan: "pro",
      period: "monthly",
      state: "active",
      live: true,
      currentCycleSeq: 2,
      currentPeriodStart: "2026-10-01T00:00:00.000Z",
      currentPeriodEnd: "2026-10-31T00:00:00.000Z",
      graceEndsAt: null,
      cancelAtPeriodEnd: false,
      cancelRequestedAt: null,
      cancelRequestedBy: null,
    },
    invoices: [invoice()],
    endNow: preview(),
    refunds: [],
    creditNotes: [],
    ...over,
  };
}

function cancelling(): StoreBilling {
  const b = billing();
  return {
    ...b,
    subscription: {
      ...b.subscription!,
      cancelAtPeriodEnd: true,
      cancelRequestedAt: "2026-10-28T06:30:00.000Z",
      cancelRequestedBy: { kind: "merchant" },
    },
  };
}

function renderTools(
  b: StoreBilling,
  canManage = true,
  openRefundFor: string | null = null,
) {
  return render(
    <StoreBillingTools
      billing={b}
      planName="Pro"
      canManage={canManage}
      openRefundFor={openRefundFor}
    />,
  );
}

describe("who sees what", () => {
  it("★★ a member reads the cancelling line and gets no button", () => {
    renderTools(cancelling(), false);
    expect(
      screen.getByText(
        "Cancelling at the end of the cycle, asked by the merchant on 28 Oct 2026.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a superadmin on a live plan gets cancel, end and refund", () => {
    renderTools(billing());
    expect(
      screen.getByRole("button", { name: "Cancel at the end of the cycle" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "End the plan now" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Issue a refund" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Undo cancellation" }),
    ).toBeNull();
  });

  it("a cancelling plan offers Undo instead of Cancel", () => {
    renderTools(cancelling());
    expect(
      screen.getByRole("button", { name: "Undo cancellation" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Cancel at the end of the cycle" }),
    ).toBeNull();
  });

  it("no live plan: no plan buttons, and Issue a refund says why it waits", () => {
    renderTools(
      billing({
        subscription: null,
        invoices: [invoice({ leftPaise: 0 })],
        endNow: null,
      }),
    );
    expect(
      screen.queryByRole("button", { name: "End the plan now" }),
    ).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Issue a refund",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText("No paid invoice has money left to refund."),
    ).toBeTruthy();
  });
});

describe("the cancelling line", () => {
  it("names an operator by email, or as an operator", () => {
    const sub = cancelling().subscription!;
    expect(
      cancellingLine({
        ...sub,
        cancelRequestedBy: { kind: "operator", email: "ops@storemink.com" },
      }),
    ).toBe(
      "Cancelling at the end of the cycle, asked by ops@storemink.com on 28 Oct 2026.",
    );
    expect(
      cancellingLine({
        ...sub,
        cancelRequestedAt: null,
        cancelRequestedBy: { kind: "operator", email: null },
      }),
    ).toBe("Cancelling at the end of the cycle, asked by an operator.");
  });
});

describe("Cancel at the end of the cycle", () => {
  it("says what it does and sends where the merchant asked", async () => {
    state.cancelPlanAtCycleEnd.mockResolvedValue({
      success: true,
      accessUntil: "2026-10-31T00:00:00.000Z",
      mandateRevoked: true,
    });
    renderTools(billing());
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel at the end of the cycle" }),
    );
    expect(
      screen.getByText(
        "Cancel Acme Retail's Pro plan at the end of its cycle on 31 Oct 2026? Do this only on the merchant's written request. They keep the plan until then, autopay stops at once, and any renewal payment for the next cycle is refunded when the plan ends.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Where did they ask?"), {
      target: { value: "Email of 26 Oct from owner@acme.in" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel plan" }));
    await waitFor(() =>
      expect(state.cancelPlanAtCycleEnd).toHaveBeenCalledWith(
        "store-1",
        "Email of 26 Oct from owner@acme.in",
      ),
    );
    await waitFor(() => expect(state.refresh).toHaveBeenCalled());
  });

  it("★ puts the merchant-voice refusal in the operator's words", async () => {
    state.cancelPlanAtCycleEnd.mockResolvedValue({
      error: "You don't have an active subscription.",
    });
    renderTools(billing());
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel at the end of the cycle" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel plan" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This store has no active subscription.",
    );
  });

  it("★★ shows any other refusal word for word", async () => {
    state.cancelPlanAtCycleEnd.mockResolvedValue({
      error: "Say why, for the record.",
    });
    renderTools(billing());
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel at the end of the cycle" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel plan" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Say why, for the record.",
    );
  });
});

describe("Undo cancellation", () => {
  it("undoes on the merchant's request", async () => {
    state.undoPlanCancellation.mockResolvedValue({
      success: true,
      advanced: false,
      autopay: false,
    });
    renderTools(cancelling());
    fireEvent.click(screen.getByRole("button", { name: "Undo cancellation" }));
    expect(
      screen.getByText(
        "Do this only on the merchant's request. Autopay stays off; they pay each renewal themselves.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Owner phoned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(state.undoPlanCancellation).toHaveBeenCalledWith(
        "store-1",
        "Owner phoned",
      ),
    );
  });
});

describe("Issue a refund", () => {
  it("waits for a reason, then sends the chosen payment", async () => {
    state.issueRefund.mockResolvedValue({
      success: true,
      refundId: "ref-1",
      status: "pending",
    });
    renderTools(billing());
    fireEvent.click(screen.getByRole("button", { name: "Issue a refund" }));
    const send = screen.getByRole("button", {
      name: "Send refund",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText("Choose a reason first.")).toBeTruthy();
    expect(screen.getByText("This cycle costs ₹100 a day.")).toBeTruthy();
    expect(
      (screen.getByLabelText("Amount (₹)") as HTMLInputElement).value,
    ).toBe("3000");
    // Not offered: this invoice was reached.
    expect(
      screen.queryByRole("option", { name: "Plan ended before this cycle" }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "goodwill" },
    });
    fireEvent.change(screen.getByLabelText("Amount (₹)"), {
      target: { value: "500" },
    });
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Outage on 20 Oct" },
    });
    fireEvent.click(send);
    await waitFor(() =>
      expect(state.issueRefund).toHaveBeenCalledWith({
        storeId: "store-1",
        invoiceId: "inv-1",
        attemptId: "att-1",
        amountInr: "500",
        reason: "goodwill",
        note: "Outage on 20 Oct",
      }),
    );
    expect(state.toastSuccess).toHaveBeenCalledWith(
      "Sent. Waiting for Razorpay to confirm it.",
    );
  });

  it("★★ shows the action's refusal word for word", async () => {
    state.issueRefund.mockResolvedValue({
      error: "That's more than is left to refund on this payment (₹3,000).",
    });
    renderTools(billing());
    fireEvent.click(screen.getByRole("button", { name: "Issue a refund" }));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send refund" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That's more than is left to refund on this payment (₹3,000).",
    );
  });

  it("explains Paid twice", () => {
    renderTools(billing());
    fireEvent.click(screen.getByRole("button", { name: "Issue a refund" }));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "duplicate_payment" },
    });
    expect(
      screen.getByText(
        "No credit note is issued: this returns an extra payment, not part of the invoice. The invoice stays Paid.",
      ),
    ).toBeTruthy();
  });

  it("★ opens on the invoice a reconciliation item names, reason chosen", () => {
    renderTools(
      billing({
        invoices: [
          invoice(),
          invoice({
            id: "inv-9",
            invoiceRef: "SM/2026-27/000200",
            status: "paid",
            cycleSeq: 3,
            cycleNotReachedFits: true,
          }),
        ],
      }),
      true,
      "inv-9",
    );
    expect((screen.getByLabelText("Invoice") as HTMLSelectElement).value).toBe(
      "inv-9",
    );
    expect((screen.getByLabelText("Reason") as HTMLSelectElement).value).toBe(
      "cycle_not_reached",
    );
  });

  it("a member never gets the dialog, even with ?refund=", () => {
    renderTools(
      billing({ invoices: [invoice({ cycleNotReachedFits: true })] }),
      false,
      "inv-1",
    );
    expect(screen.queryByText("Send refund")).toBeNull();
  });

  it("labels each invoice with its period, amount and what was refunded", () => {
    const target = issueTargetFromInvoice(
      invoice({ refundedPaise: 50_000, inProgressPaise: 10_000 }),
    );
    expect(target.label).toBe(
      "SM/2026-27/000123 · 01 Oct 2026 to 31 Oct 2026 · ₹3,000 · ₹500 refunded so far, ₹100 in progress",
    );
    expect(target.perDayPaise).toBe(10_000);
  });
});

describe("End the plan now", () => {
  it("shows the server's count of the unused part, line by line", () => {
    renderTools(billing());
    fireEvent.click(screen.getByRole("button", { name: "End the plan now" }));
    expect(screen.getByText("End Acme Retail's Pro plan now?")).toBeTruthy();
    expect(screen.getByText(/any open POS shift is closed/)).toBeTruthy();
    expect(
      screen.getByText(
        "Refund the unused part of this cycle: ₹200 (2 of 30 days)",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "SM/2026-27/000130: less than ₹1 is left, so nothing is refunded.",
      ),
    ).toBeTruthy();
  });

  it("waits for a reason, and with Main feature removed explains the date", () => {
    renderTools(billing());
    fireEvent.click(screen.getByRole("button", { name: "End the plan now" }));
    expect(
      (
        screen.getByRole("button", {
          name: "End plan now",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "feature_removed" },
    });
    expect(
      screen.getByText(
        "The date the feature was removed or reduced. The Terms promise a refund for the part of the cycle after the change.",
      ),
    ).toBeTruthy();
  });

  it("asks the server again when the date moves, and writes its refusal under the button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.listStoreBilling.mockResolvedValue(
      billing({
        endNow: preview({
          lines: [],
          totalPaise: 0,
          error: "That date is before this cycle began.",
        }),
      }),
    );
    renderTools(billing());
    fireEvent.click(screen.getByRole("button", { name: "End the plan now" }));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "other" },
    });
    fireEvent.change(screen.getByLabelText("Refund the unused part from"), {
      target: { value: "2026-09-01" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await waitFor(() =>
      expect(state.listStoreBilling).toHaveBeenCalledWith("store-1", {
        refundFrom: "2026-09-01",
        reason: "other",
      }),
    );
    expect(
      await screen.findByText("That date is before this cycle began."),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "End plan now",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("ends the plan and lists what was refunded and skipped", async () => {
    state.listStoreBilling.mockResolvedValue(billing());
    state.endPlanNow.mockResolvedValue({
      success: true,
      refunds: [
        {
          invoiceRef: "SM/2026-27/000123",
          amountPaise: 20_000,
          status: "pending",
          error: null,
        },
      ],
      skipped: [
        {
          invoiceRef: "SM/2026-27/000130",
          why: "SM/2026-27/000130: less than ₹1 is left, so nothing is refunded.",
        },
      ],
    });
    renderTools(billing());
    fireEvent.click(screen.getByRole("button", { name: "End the plan now" }));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "declined_terms" },
    });
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Declined Terms v3 by email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "End plan now" }));
    await waitFor(() =>
      expect(state.endPlanNow).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "store-1",
          reason: "declined_terms",
          refundUnused: true,
          note: "Declined Terms v3 by email",
        }),
      ),
    );
    expect(await screen.findByText("The plan has ended.")).toBeTruthy();
    expect(
      screen.getByText(/SM\/2026-27\/000123: ₹200, Sent, waiting for Razorpay/),
    ).toBeTruthy();
    expect(state.refresh).toHaveBeenCalled();
  });

  it("★★ shows the action's refusal word for word", async () => {
    state.listStoreBilling.mockResolvedValue(billing());
    state.endPlanNow.mockResolvedValue({
      error: "This store has no plan to end.",
    });
    renderTools(billing());
    fireEvent.click(screen.getByRole("button", { name: "End the plan now" }));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "End plan now" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This store has no plan to end.",
    );
  });
});

describe("the refunds list", () => {
  it("lists the store's refunds and prints its credit notes", () => {
    render(
      <StoreRefundsList
        billing={billing({
          refunds: [
            {
              id: "ref-1",
              invoiceId: "inv-1",
              invoiceRef: "SM/2026-27/000123",
              storeId: "store-1",
              storeName: "Acme Retail",
              storeSlug: "acme",
              attemptId: "att-1",
              providerPaymentId: "pay_1",
              reason: "goodwill",
              status: "processed",
              method: "razorpay",
              amountPaise: 50_000,
              providerRefundId: "rfnd_1",
              externalReference: null,
              failureReason: null,
              requestedBy: "ops@storemink.com",
              note: null,
              resolutionNote: null,
              createdAt: "2026-10-28T06:30:00.000Z",
              sentAt: null,
              resolvedAt: null,
              notifiedAt: null,
              needsPerson: false,
            },
          ],
          creditNotes: [
            {
              id: "cn-1",
              creditNoteRef: "CN/2026-27/00001",
              issuedAt: "2026-10-28T06:30:00.000Z",
              reason: "goodwill",
              totalPaise: 50_000,
              invoiceId: "inv-1",
              invoiceRef: "SM/2026-27/000123",
              refundId: "ref-1",
            },
          ],
        })}
      />,
    );
    expect(screen.getAllByText(/Goodwill/)).toHaveLength(2);
    expect(screen.getByText(/Refunded,/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Print CN/2026-27/00001" })
        .getAttribute("href"),
    ).toBe("/dashboard/billing/credit-notes/cn-1");
  });

  it("says when there is nothing yet", () => {
    render(<StoreRefundsList billing={billing()} />);
    expect(
      screen.getByText("No refunds or credit notes for this store yet."),
    ).toBeTruthy();
  });
});

describe("frameMerchantError", () => {
  it("leaves anything it does not know alone", () => {
    expect(frameMerchantError("Razorpay refused the refund: too old")).toBe(
      "Razorpay refused the refund: too old",
    );
    expect(frameMerchantError("Your subscription is already cancelling.")).toBe(
      "This store's plan is already cancelling.",
    );
  });
});
