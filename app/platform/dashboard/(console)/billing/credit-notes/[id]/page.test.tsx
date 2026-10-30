// @vitest-environment jsdom
// The operator console's credit note page (renewal-cancel, design 7.2).
//
// ★★ The reader behind it has NO store predicate, so the operator gate is the
// whole of the access control: it must run first, and a refusal must stop the
// read from happening at all.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CreditNoteDocument } from "@/lib/billing/invoice-types";

const H = vi.hoisted(() => ({
  calls: [] as string[],
  operator: true,
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("../../../require-operator", () => ({
  requireOperator: vi.fn(async () => {
    H.calls.push("requireOperator");
    if (!H.operator) throw new Error("redirect:/dashboard");
    return { email: "ops@storemink.com", role: "member" };
  }),
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

vi.mock("@/lib/billing/credit-note-store", () => ({
  getCreditNoteDocumentForOperator: vi.fn(async (id: string) => {
    H.calls.push("read");
    return id === "cn-1" ? note() : null;
  }),
}));

import ConsoleCreditNotePage from "./page";
import { getCreditNoteDocumentForOperator } from "@/lib/billing/credit-note-store";

async function renderPage(id: string) {
  render(await ConsoleCreditNotePage({ params: Promise.resolve({ id }) }));
}

beforeEach(() => {
  H.calls = [];
  H.operator = true;
});

describe("ConsoleCreditNotePage", () => {
  it("★★ checks the operator BEFORE reading the note", async () => {
    await renderPage("cn-1");
    expect(H.calls).toEqual(["requireOperator", "read"]);
  });

  it("★★ reads nothing when the viewer is not an operator", async () => {
    H.operator = false;
    await expect(renderPage("cn-1")).rejects.toThrow("redirect:/dashboard");
    expect(getCreditNoteDocumentForOperator).not.toHaveBeenCalled();
  });

  it("prints the note with a way back to the Credit notes tab", async () => {
    await renderPage("cn-1");
    expect(screen.getAllByText("CN/2026-27/00001").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: /Refunds/ }).getAttribute("href"),
    ).toBe("/dashboard/billing/refunds?tab=credit_notes");
    expect(screen.getByRole("button", { name: /Print/ })).toBeTruthy();
  });

  it("is a plain 404 for an unknown note", async () => {
    await expect(renderPage("cn-404")).rejects.toThrow("notFound");
  });
});
