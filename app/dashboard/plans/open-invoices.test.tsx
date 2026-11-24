// @vitest-environment jsdom
// The invoice to pay (GST design 7.3, 7.4): every amount in rupees as
// `formatRupees` writes it, the "Including ... GST" line only when the
// invoice carries GST, dates in India time, and the amount guard on Pay: a
// start that asks for a different amount than the row showed never opens
// Razorpay, and an equal one opens it exactly once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  actions: {
    startPayInvoice: vi.fn(),
    confirmPayInvoice: vi.fn(),
  },
  openRazorpayModal: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/app/actions/subscribe-actions", () => h.actions);
vi.mock("@/lib/payments/razorpay-client", () => ({
  openRazorpayModal: h.openRazorpayModal,
}));

import { OpenInvoices } from "./open-invoices";
import type { PayableInvoice } from "@/lib/billing/invoice-types";

function invoice(over: Partial<PayableInvoice> = {}): PayableInvoice {
  return {
    id: "inv-1",
    invoiceRef: "SM/2026-27/00042",
    status: "open",
    totalPaise: 17_700_00,
    // 31 Oct 2026, 23:30 UTC is 1 Nov 2026 in India.
    periodStart: "2026-10-31T23:30:00.000Z",
    // 30 Nov 2026, 20:00 UTC is 1 Dec 2026, 01:30 in India.
    periodEnd: "2026-11-30T20:00:00.000Z",
    dueAt: "2026-11-30T20:00:00.000Z",
    createdAt: "2026-10-27T06:30:00.000Z",
    taxPaise: 2_700_00,
    taxRateBps: 1800,
    taxInclusive: false,
    autopayAt: null,
    resumable: false,
    ...over,
  };
}

function start(amountPaise: number) {
  return {
    ok: true,
    invoiceId: "inv-1",
    providerOrderId: "order_1",
    keyId: "rzp_1",
    amountPaise,
    invoiceRef: "SM/2026-27/00042",
  };
}

beforeEach(() => {
  h.openRazorpayModal.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

describe("the invoice to pay (GST design 7.3)", () => {
  it("shows the total in rupees and the GST it includes", () => {
    render(<OpenInvoices invoices={[invoice()]} canManage />);
    expect(screen.getByText("₹17,700")).toBeTruthy();
    expect(screen.getByText("Including ₹2,700 GST (18%)")).toBeTruthy();
  });

  it("paise are printed when a total has them", () => {
    render(
      <OpenInvoices
        invoices={[invoice({ totalPaise: 152_22, taxPaise: 23_22 })]}
        canManage
      />,
    );
    expect(screen.getByText("₹152.22")).toBeTruthy();
    expect(screen.getByText("Including ₹23.22 GST (18%)")).toBeTruthy();
  });

  it("★ no GST line on an invoice that carries none", () => {
    render(
      <OpenInvoices
        invoices={[invoice({ totalPaise: 15_000_00, taxPaise: 0 })]}
        canManage
      />,
    );
    expect(screen.getByText("₹15,000")).toBeTruthy();
    expect(screen.queryByText(/GST/)).toBeNull();
  });

  it("★ no GST line keyed on the rate alone", () => {
    render(
      <OpenInvoices
        invoices={[invoice({ taxPaise: 0, taxRateBps: 1800 })]}
        canManage
      />,
    );
    expect(screen.queryByText(/Including/)).toBeNull();
  });

  it("the GST line leaves the rate out when the invoice recorded none", () => {
    render(
      <OpenInvoices invoices={[invoice({ taxRateBps: null })]} canManage />,
    );
    expect(screen.getByText("Including ₹2,700 GST")).toBeTruthy();
  });

  it("★ dates are India's, not the server's", () => {
    render(<OpenInvoices invoices={[invoice()]} canManage />);
    expect(
      screen.getByText(
        "Service period 1 Nov 2026 to 1 Dec 2026 · due 1 Dec 2026",
      ),
    ).toBeTruthy();
  });

  it("says nothing when nothing is owed", () => {
    const { container } = render(<OpenInvoices invoices={[]} canManage />);
    expect(container.textContent).toBe("");
  });
});

describe("the amount guard on Pay (GST design 7.4)", () => {
  it("★★ a different start amount never opens Razorpay, and the row shows it", async () => {
    h.actions.startPayInvoice.mockResolvedValue(start(17_000_00));
    render(<OpenInvoices invoices={[invoice()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await vi.waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith(
        "The amount to pay is now ₹17,000. Check it and press Pay now again.",
      ),
    );
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalled();
    expect(
      screen.getByText(
        "The amount to pay is now ₹17,000. Check it and press Pay now again.",
      ),
    ).toBeTruthy();
  });

  it("the next press opens at the amount the row now shows", async () => {
    h.actions.startPayInvoice.mockResolvedValue(start(17_000_00));
    render(<OpenInvoices invoices={[invoice()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalled());
    const pay = screen.getByRole("button", {
      name: "Pay now",
    }) as HTMLButtonElement;
    await vi.waitFor(() => expect(pay.disabled).toBe(false));
    fireEvent.click(pay);
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(1),
    );
    expect(h.openRazorpayModal.mock.calls[0][0].amountPaise).toBe(17_000_00);
  });

  it("an equal amount opens it exactly once", async () => {
    h.actions.startPayInvoice.mockResolvedValue(start(17_700_00));
    render(<OpenInvoices invoices={[invoice()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await vi.waitFor(() =>
      expect(h.openRazorpayModal).toHaveBeenCalledTimes(1),
    );
    expect(h.openRazorpayModal.mock.calls[0][0].amountPaise).toBe(17_700_00);
    expect(h.toast.info).not.toHaveBeenCalled();
  });

  it("a refusal is still the server's sentence, word for word", async () => {
    h.actions.startPayInvoice.mockResolvedValue({
      ok: false,
      error: "That invoice is closed and can't be paid.",
    });
    render(<OpenInvoices invoices={[invoice()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await vi.waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        "That invoice is closed and can't be paid.",
      ),
    );
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
  });
});

// 21 Nov 2026: an automatic renewal waits a day or more between the bank's
// notice and its debit. Its invoice is `processing` all that time, and the
// panel must not ask the merchant to pay it or threaten the Free plan.
describe("★★ a renewal whose automatic debit is scheduled", () => {
  // 23 Nov 2026, 05:53 UTC is 23 Nov in India.
  const scheduled = () =>
    invoice({ status: "processing", autopayAt: "2026-11-23T05:53:31Z" });

  it("says the renewal is scheduled and that nothing is needed", () => {
    render(<OpenInvoices invoices={[scheduled()]} canManage />);
    expect(screen.getByText("Your renewal is scheduled")).toBeTruthy();
    expect(
      screen.getByText(
        "Your saved payment method will be charged automatically. There is nothing you need to do. If you would rather pay it yourself, choose Pay now instead.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Autopay on or after 23 Nov 2026")).toBeTruthy();
  });

  it("★ never asks for a payment or warns of the Free plan", () => {
    render(<OpenInvoices invoices={[scheduled()]} canManage />);
    expect(screen.queryByText(/invoice to pay/)).toBeNull();
    expect(screen.queryByText(/Free plan/)).toBeNull();
    expect(screen.queryByText("Payment in progress…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
  });

  it("★ a debit already SENT is a payment in progress, as before", () => {
    render(
      <OpenInvoices
        invoices={[invoice({ status: "processing", autopayAt: null })]}
        canManage
      />,
    );
    expect(screen.getByText("Payment in progress…")).toBeTruthy();
    expect(screen.getByText("You have an invoice to pay")).toBeTruthy();
  });

  it("beside an invoice that is owed, only the owed one is counted and offered", () => {
    render(
      <OpenInvoices
        invoices={[
          scheduled(),
          invoice({ id: "inv-2", invoiceRef: "SM/2026-27/00041" }),
        ]}
        canManage
      />,
    );
    expect(screen.getByText("You have an invoice to pay")).toBeTruthy();
    expect(screen.getByText("Autopay on or after 23 Nov 2026")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Pay now" })).toHaveLength(1);
  });

  it("an open invoice is never read as scheduled, whatever it carries", () => {
    render(
      <OpenInvoices
        invoices={[invoice({ autopayAt: "2026-11-23T05:53:31Z" })]}
        canManage
      />,
    );
    expect(screen.getByRole("button", { name: "Pay now" })).toBeTruthy();
    expect(screen.queryByText("Your renewal is scheduled")).toBeNull();
  });
});

// The merchant may pay a scheduled renewal themselves. Pressing the button
// cancels the scheduled automatic payment, so it asks first.
describe("★★ Pay now instead", () => {
  const scheduled = () =>
    invoice({ status: "processing", autopayAt: "2026-11-23T05:53:31Z" });
  let confirm: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    h.actions.startPayInvoice.mockResolvedValue(start(17_700_00));
  });
  afterEach(() => {
    confirm.mockRestore();
  });

  it("is offered beside the scheduled date", () => {
    render(<OpenInvoices invoices={[scheduled()]} canManage />);
    expect(
      screen.getByRole("button", { name: "Pay now instead" }),
    ).toBeTruthy();
  });

  it("★★ asks first, naming the amount and what is cancelled", () => {
    confirm.mockReturnValue(false);
    render(<OpenInvoices invoices={[scheduled()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now instead" }));
    expect(confirm).toHaveBeenCalledWith(
      "Pay ₹17,700 now? The automatic payment scheduled for on or after 23 Nov 2026 will be cancelled, so you are not charged twice.",
    );
  });

  it("★★ a merchant who says no changes nothing: the server is never asked", () => {
    confirm.mockReturnValue(false);
    render(<OpenInvoices invoices={[scheduled()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now instead" }));
    expect(h.actions.startPayInvoice).not.toHaveBeenCalled();
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
  });

  it("★ on yes, starts the payment as a replacement and opens the window once", async () => {
    render(<OpenInvoices invoices={[scheduled()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now instead" }));
    await vi.waitFor(() => expect(h.openRazorpayModal).toHaveBeenCalled());
    expect(h.actions.startPayInvoice).toHaveBeenCalledTimes(1);
    expect(h.actions.startPayInvoice).toHaveBeenCalledWith("inv-1", true);
    expect(h.openRazorpayModal).toHaveBeenCalledTimes(1);
    expect(h.openRazorpayModal.mock.calls[0][0]).toMatchObject({
      rzpOrderId: "order_1",
      amountPaise: 17_700_00,
    });
  });

  it("★ a refusal shows the server's own sentence and refreshes the list", async () => {
    h.actions.startPayInvoice.mockResolvedValue({
      ok: false,
      error: "A payment is already being processed. Give it a moment.",
    });
    render(<OpenInvoices invoices={[scheduled()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now instead" }));
    await vi.waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        "A payment is already being processed. Give it a moment.",
      ),
    );
    expect(h.openRazorpayModal).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalled();
  });

  it("★ closing the window refreshes the list, so the row can be continued", async () => {
    render(<OpenInvoices invoices={[scheduled()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now instead" }));
    await vi.waitFor(() => expect(h.openRazorpayModal).toHaveBeenCalled());
    h.refresh.mockClear();
    h.openRazorpayModal.mock.calls[0][0].onDismiss();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("an admin who cannot manage billing sees it disabled", () => {
    render(<OpenInvoices invoices={[scheduled()]} canManage={false} />);
    const button = screen.getByRole("button", {
      name: "Pay now instead",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("an ordinary Pay now never asks to replace anything", async () => {
    render(<OpenInvoices invoices={[invoice()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await vi.waitFor(() => expect(h.openRazorpayModal).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
    expect(h.actions.startPayInvoice).toHaveBeenCalledWith("inv-1");
  });
});

// A payment window that was opened and closed leaves a checkout the merchant
// can go back to. It used to read "Payment in progress" with no way forward.
describe("★★ Continue payment", () => {
  const unfinished = () => invoice({ status: "processing", resumable: true });

  beforeEach(() => {
    h.actions.startPayInvoice.mockResolvedValue(start(17_700_00));
  });

  it("is offered for a checkout that was opened and not finished", () => {
    render(<OpenInvoices invoices={[unfinished()]} canManage />);
    expect(
      screen.getByRole("button", { name: "Continue payment" }),
    ).toBeTruthy();
    expect(screen.queryByText("Payment in progress…")).toBeNull();
  });

  it("★ reopens through the ordinary start, never as a replacement", async () => {
    render(<OpenInvoices invoices={[unfinished()]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue payment" }));
    await vi.waitFor(() => expect(h.openRazorpayModal).toHaveBeenCalled());
    expect(h.actions.startPayInvoice).toHaveBeenCalledWith("inv-1");
  });

  it("★ a payment really moving has no button", () => {
    render(
      <OpenInvoices
        invoices={[invoice({ status: "processing", resumable: false })]}
        canManage
      />,
    );
    expect(screen.getByText("Payment in progress…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
