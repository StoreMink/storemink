// @vitest-environment jsdom
// The merchant's invoices list on Plans & Billing (renewal-cancel, design 8.5).
//
// A refund never changes its invoice (rule R9), so this page says what
// happened to the money in one line under the status pill, and lists the
// credit notes StoreMink issued in their own table.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type {
  CreditNoteSummary,
  InvoiceSummary,
} from "@/lib/billing/invoice-types";

const H = vi.hoisted(() => ({
  invoices: [] as unknown[],
  notes: [] as unknown[],
}));

vi.mock("../../lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({ can: () => true })),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/billing/invoice-history", () => ({
  listInvoices: vi.fn(async () => H.invoices),
}));
vi.mock("@/lib/billing/credit-note-store", () => ({
  listCreditNotes: vi.fn(async () => H.notes),
}));

import InvoicesPage from "./page";
import { requireSectionAccess } from "../../lib/access";
import { listInvoices } from "@/lib/billing/invoice-history";
import { listCreditNotes } from "@/lib/billing/credit-note-store";

const NO_REFUNDS: InvoiceSummary["refunds"] = {
  refundedPaise: 0,
  extraReturnedPaise: 0,
  inProgressPaise: 0,
  inProgress: false,
  delayed: false,
};

function invoice(over: Partial<InvoiceSummary> = {}): InvoiceSummary {
  return {
    id: "inv-1",
    invoiceRef: "SM/2026-27/00042",
    kind: "subscription",
    status: "paid",
    totalPaise: 240_000,
    taxPaise: 0,
    finalizedAt: "2026-10-01T06:00:00.000Z",
    paidAt: "2026-10-01T06:00:00.000Z",
    periodStart: "2026-10-01T06:00:00.000Z",
    periodEnd: "2026-10-31T06:00:00.000Z",
    refunds: NO_REFUNDS,
    ...over,
  };
}

function note(over: Partial<CreditNoteSummary> = {}): CreditNoteSummary {
  return {
    id: "cn-1",
    creditNoteRef: "CN/2026-27/00001",
    issuedAt: "2026-10-30T06:00:00.000Z",
    reason: "cycle_not_reached",
    totalPaise: 240_000,
    invoiceId: "inv-1",
    invoiceRef: "SM/2026-27/00042",
    refundId: "ref-1",
    ...over,
  };
}

/** The status cell of the row for one invoice reference. */
function statusCell(ref: string): HTMLElement {
  const row = screen.getByRole("link", { name: ref }).closest("tr");
  if (!row) throw new Error(`no row for ${ref}`);
  const cells = within(row).getAllByRole("cell");
  return cells[cells.length - 1];
}

async function renderPage() {
  render(await InvoicesPage());
}

beforeEach(() => {
  H.invoices = [];
  H.notes = [];
});

describe("InvoicesPage", () => {
  it("opens behind Plans & Billing's gate and reads the store's own records", async () => {
    await renderPage();
    expect(requireSectionAccess).toHaveBeenCalledWith("ai", "view");
    expect(listInvoices).toHaveBeenCalledWith("store-1");
    expect(listCreditNotes).toHaveBeenCalledWith("store-1");
  });

  it("says it lists invoices and credit notes", async () => {
    await renderPage();
    expect(
      screen.getByText(/Your StoreMink invoices and credit notes/),
    ).toBeInTheDocument();
  });

  it("explains an empty list and shows no credit notes table", async () => {
    await renderPage();
    expect(screen.getByText("No invoices yet")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Credit notes" })).toBeNull();
  });

  it("★ a refunded invoice keeps its own status and says what was refunded", async () => {
    H.invoices = [
      invoice({ refunds: { ...NO_REFUNDS, refundedPaise: 240_000 } }),
      invoice({
        id: "inv-2",
        invoiceRef: "SM/2026-27/00043",
        refunds: { ...NO_REFUNDS, refundedPaise: 100_000 },
      }),
    ];
    await renderPage();
    const full = statusCell("SM/2026-27/00042");
    expect(within(full).getByText("Paid")).toBeInTheDocument();
    expect(within(full).getByText("Refunded in full")).toBeInTheDocument();
    expect(
      within(statusCell("SM/2026-27/00043")).getByText("Refunded ₹1,000"),
    ).toBeInTheDocument();
  });

  it("a refund still moving outranks one that finished", async () => {
    H.invoices = [
      invoice({
        refunds: {
          ...NO_REFUNDS,
          refundedPaise: 100_000,
          inProgressPaise: 50_000,
          inProgress: true,
        },
      }),
    ];
    await renderPage();
    expect(
      within(statusCell("SM/2026-27/00042")).getByText("Refund on its way"),
    ).toBeInTheDocument();
  });

  it("a failed refund nobody has retried reads as delayed", async () => {
    H.invoices = [invoice({ refunds: { ...NO_REFUNDS, delayed: true } })];
    await renderPage();
    expect(
      within(statusCell("SM/2026-27/00042")).getByText("Refund delayed"),
    ).toBeInTheDocument();
  });

  it("★ a returned duplicate payment is not a refund of the invoice", async () => {
    H.invoices = [
      invoice({ refunds: { ...NO_REFUNDS, extraReturnedPaise: 240_000 } }),
    ];
    await renderPage();
    const cell = statusCell("SM/2026-27/00042");
    expect(
      within(cell).getByText("Extra payment of ₹2,400 returned"),
    ).toBeInTheDocument();
    expect(within(cell).queryByText(/^Refunded/)).toBeNull();
  });

  it("an invoice nobody refunded has no line under its pill", async () => {
    H.invoices = [invoice()];
    await renderPage();
    const cell = statusCell("SM/2026-27/00042");
    expect(cell.querySelectorAll("p")).toHaveLength(0);
  });

  it("words the two refund statuses a hand edit could leave", async () => {
    H.invoices = [
      invoice({ status: "refunded" }),
      invoice({
        id: "inv-2",
        invoiceRef: "SM/2026-27/00043",
        status: "partially_refunded",
      }),
    ];
    await renderPage();
    expect(
      within(statusCell("SM/2026-27/00042")).getByText("Refunded"),
    ).toBeInTheDocument();
    expect(
      within(statusCell("SM/2026-27/00043")).getByText("Partly refunded"),
    ).toBeInTheDocument();
  });

  it("lists the credit notes, each linking to its note and its invoice", async () => {
    H.invoices = [invoice()];
    H.notes = [
      note(),
      note({
        id: "cn-2",
        creditNoteRef: "CN/2026-27/00002",
        invoiceId: "inv-9",
        invoiceRef: null,
        totalPaise: 50_050,
      }),
    ];
    await renderPage();
    expect(
      screen.getByRole("heading", { name: "Credit notes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "CN/2026-27/00001" }),
    ).toHaveAttribute("href", "/dashboard/plans/credit-notes/cn-1");
    const row = screen
      .getByRole("link", { name: "CN/2026-27/00001" })
      .closest("tr")!;
    expect(
      within(row).getByRole("link", { name: "SM/2026-27/00042" }),
    ).toHaveAttribute("href", "/dashboard/plans/invoices/inv-1");
    expect(within(row).getByText("30 Oct 2026")).toBeInTheDocument();
    const second = screen
      .getByRole("link", { name: "CN/2026-27/00002" })
      .closest("tr")!;
    expect(within(second).getByText("-")).toBeInTheDocument();
    expect(within(second).getByText("₹500.50")).toBeInTheDocument();
  });

  it("names a document that charged GST a tax invoice and any other an invoice", async () => {
    H.invoices = [
      invoice({ taxPaise: 36_610, totalPaise: 240_000 }),
      invoice({ id: "inv-2", invoiceRef: "SM/2026-27/00043", taxPaise: 0 }),
    ];
    await renderPage();
    const taxed = screen
      .getByRole("link", { name: "SM/2026-27/00042" })
      .closest("td")!;
    expect(taxed).toHaveTextContent(/^Tax invoice SM\/2026-27\/00042$/);
    const plain = screen
      .getByRole("link", { name: "SM/2026-27/00043" })
      .closest("td")!;
    expect(plain).toHaveTextContent(/^Invoice SM\/2026-27\/00043$/);
    // The number alone stays the link, so it reads as the number quoted.
    expect(
      screen.getByRole("link", { name: "SM/2026-27/00042" }),
    ).toHaveAttribute("href", "/dashboard/plans/invoices/inv-1");
  });

  it("names the page Plans & Billing in its back link", async () => {
    await renderPage();
    expect(
      screen.getByRole("link", { name: /Plans & Billing/ }),
    ).toHaveAttribute("href", "/dashboard/plans");
  });
});
