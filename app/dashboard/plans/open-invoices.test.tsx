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
