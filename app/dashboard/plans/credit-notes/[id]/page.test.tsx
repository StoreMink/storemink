// @vitest-environment jsdom
// The merchant's credit note page (renewal-cancel, design 8.8).
//
// ★★ The store comes from the session, never the URL, and the note is read
// through the store-scoped reader. A note on another store must be a plain 404
// that confirms nothing, which is what these tests hold the page to.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CreditNoteDocument } from "@/lib/billing/invoice-types";

const H = vi.hoisted(() => ({ actingStore: "store-1" }));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("@/app/dashboard/lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({ can: () => true })),
  getActingStoreId: vi.fn(async () => H.actingStore),
}));

function note(): CreditNoteDocument {
  return {
    id: "cn-1",
    creditNoteRef: "CN/2026-27/00001",
    issuedAt: "2026-10-30T06:00:00.000Z",
    reason: "cycle_not_reached",
    invoiceId: "inv-1",
    invoiceRef: "SM/2026-27/00042",
    invoiceIssuedAt: "2026-10-01T06:00:00.000Z",
    taxablePaise: 500_000,
    taxPaise: 0,
    totalPaise: 500_000,
    taxRateBps: null,
    supplierGstin: null,
    customerGstin: null,
    placeOfSupply: null,
    taxLines: [],
    supplier: { legalName: "STOREMINK LLP", address: {} },
    customer: {
      legalName: "Kesar Ghani Foods",
      address: {},
      billingEmail: null,
    },
    refund: null,
  };
}

// The note belongs to store-1. The store-scoped reader answers only for that
// store; the operator reader (no store predicate) answers for anyone, so a
// page that used it would serve another store's note.
vi.mock("@/lib/billing/credit-note-store", () => ({
  getCreditNoteDocument: vi.fn(async (storeId: string, id: string) =>
    storeId === "store-1" && id === "cn-1" ? note() : null,
  ),
  getCreditNoteDocumentForOperator: vi.fn(async (id: string) =>
    id === "cn-1" ? note() : null,
  ),
}));

import CreditNotePage from "./page";
import {
  requireSectionAccess,
  getActingStoreId,
} from "@/app/dashboard/lib/access";
import { getCreditNoteDocument } from "@/lib/billing/credit-note-store";

async function renderPage(id: string) {
  render(await CreditNotePage({ params: Promise.resolve({ id }) }));
}

beforeEach(() => {
  H.actingStore = "store-1";
});

describe("CreditNotePage", () => {
  it("opens behind Plans & Billing's own gate", async () => {
    await renderPage("cn-1");
    expect(requireSectionAccess).toHaveBeenCalledWith("ai", "view");
  });

  it("reads the note with the store from the session", async () => {
    await renderPage("cn-1");
    expect(getActingStoreId).toHaveBeenCalled();
    expect(getCreditNoteDocument).toHaveBeenCalledWith("store-1", "cn-1");
    expect(
      screen.getByRole("heading", { level: 1, name: "Credit Note" }),
    ).toBeInTheDocument();
    expect(screen.getByText("CN/2026-27/00001")).toBeInTheDocument();
  });

  it("★★ another store's note is a plain 404", async () => {
    H.actingStore = "store-2";
    await expect(renderPage("cn-1")).rejects.toThrow("notFound");
  });

  it("an unknown note is a plain 404", async () => {
    await expect(renderPage("cn-unknown")).rejects.toThrow("notFound");
  });

  it("links back to the invoices list and offers Print", async () => {
    await renderPage("cn-1");
    expect(screen.getByRole("link", { name: /Invoices/ })).toHaveAttribute(
      "href",
      "/dashboard/plans/invoices",
    );
    expect(screen.getByRole("button", { name: /Print/ })).toBeInTheDocument();
  });
});
