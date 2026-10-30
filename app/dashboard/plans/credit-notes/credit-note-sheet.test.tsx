// @vitest-environment jsdom
// The printed StoreMink credit note (renewal-cancel, design 8.8).
//
// Like the invoice sheet's tests, these are about what the document CLAIMS:
// which invoice it reduces, why, how much tax it gives back and how, and how
// the money went back. Every figure comes from the note's own record.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CreditNoteSheet,
  creditNoteReasonText,
  creditNoteRefundLine,
  CREDIT_NOTE_REASON_TEXT,
} from "./credit-note-sheet";
import type { CreditNotePrintDocument } from "@/lib/billing/credit-notes";

function doc(
  over: Partial<CreditNotePrintDocument> = {},
): CreditNotePrintDocument {
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
    placeOfSupplyBasis: null,
    recipientStateCode: null,
    taxLines: [],
    supplier: {
      legalName: "STOREMINK LLP",
      address: { line1: "Bala ji Colony", city: "Faridkot" },
      llpin: null,
      registeredOffice: null,
    },
    customer: {
      legalName: "Kesar Ghani Foods",
      address: { line1: "12 MG Road", city: "Bengaluru", postalCode: "560001" },
      billingEmail: "accounts@kesar.example",
    },
    refund: {
      method: "razorpay",
      refundedAt: "2026-10-31T06:00:00.000Z",
      reference: "rfnd_123",
    },
    ...over,
  };
}

/** The value printed beside a meta label ("Credit note no.", "Date"...). */
function metaValue(label: string): string | null {
  return screen.getByText(label).nextElementSibling?.textContent ?? null;
}

/** The figure printed beside a totals label. */
function totalValue(label: string): string | null {
  return screen.getByText(label).nextElementSibling?.textContent ?? null;
}

describe("CreditNoteSheet: what the document says", () => {
  it("is titled Credit Note and names the invoice it reduces", () => {
    render(<CreditNoteSheet doc={doc()} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Credit Note" }),
    ).toBeInTheDocument();
    expect(metaValue("Credit note no.")).toBe("CN/2026-27/00001");
    expect(metaValue("Against invoice")).toBe("SM/2026-27/00042");
    // R2-12: the GST copy's one date style, no leading zero.
    expect(metaValue("Invoice date")).toBe("1 Oct 2026");
    expect(metaValue("Date")).toBe("30 Oct 2026");
  });

  it("dates the note in India time", () => {
    // 20:00 UTC on 31 Oct is already 1 Nov in Kolkata.
    render(
      <CreditNoteSheet doc={doc({ issuedAt: "2026-10-31T20:00:00.000Z" })} />,
    );
    expect(metaValue("Date")).toBe("1 Nov 2026");
  });

  it("prints a dash when the invoice has no number", () => {
    render(
      <CreditNoteSheet
        doc={doc({ invoiceRef: null, invoiceIssuedAt: null })}
      />,
    );
    expect(metaValue("Against invoice")).toBe("-");
    expect(metaValue("Invoice date")).toBe("-");
  });

  it("names both parties with their addresses", () => {
    render(<CreditNoteSheet doc={doc()} />);
    expect(screen.getByText("STOREMINK LLP")).toBeInTheDocument();
    expect(screen.getByText("Kesar Ghani Foods")).toBeInTheDocument();
    expect(screen.getByText("12 MG Road")).toBeInTheDocument();
    expect(screen.getByText("Bengaluru 560001")).toBeInTheDocument();
    expect(screen.getByText("accounts@kesar.example")).toBeInTheDocument();
  });

  it("states the reason in words, by code", () => {
    render(<CreditNoteSheet doc={doc({ reason: "feature_removed" })} />);
    expect(
      screen.getByText("A main feature of the plan was removed or reduced."),
    ).toBeInTheDocument();
  });

  it("ends with the computer-generated footer", () => {
    render(<CreditNoteSheet doc={doc()} />);
    expect(
      screen.getByText(
        /computer-generated credit note and does not require a signature/,
      ),
    ).toBeInTheDocument();
  });

  it("links nowhere, so the operator console can reuse it", () => {
    const { container } = render(<CreditNoteSheet doc={doc()} />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("CreditNoteSheet: tax", () => {
  it("a note with no tax prints no tax line and no place of supply", () => {
    render(<CreditNoteSheet doc={doc()} />);
    expect(totalValue("Taxable value")).toBe("₹5,000.00");
    expect(totalValue("Total credited")).toBe("₹5,000.00");
    expect(screen.queryByText(/GST/)).toBeNull();
    expect(screen.queryByText(/Place of supply/)).toBeNull();
  });

  it("prints CGST and SGST for an intra-state note, from its tax lines", () => {
    render(
      <CreditNoteSheet
        doc={doc({
          taxablePaise: 500_000,
          taxPaise: 90_000,
          totalPaise: 590_000,
          taxRateBps: 1800,
          supplierGstin: "07AAAAA0000A1Z5",
          customerGstin: "07BBBBB0000B1Z5",
          placeOfSupply: "07",
          placeOfSupplyBasis: "recipient",
          recipientStateCode: "07",
          taxLines: [
            { name: "CGST", rateBps: 900, amountPaise: 45_000 },
            { name: "SGST", rateBps: 900, amountPaise: 45_000 },
          ],
        })}
      />,
    );
    expect(totalValue("CGST 9%")).toBe("₹450.00");
    expect(totalValue("SGST 9%")).toBe("₹450.00");
    expect(screen.queryByText(/IGST/)).toBeNull();
    expect(totalValue("Total credited")).toBe("₹5,900.00");
    expect(screen.getByText("GSTIN: 07AAAAA0000A1Z5")).toBeInTheDocument();
    expect(screen.getByText("GSTIN: 07BBBBB0000B1Z5")).toBeInTheDocument();
    // The supplier's State (from its GSTIN) and the customer's (recipient
    // basis), both Delhi here.
    expect(screen.getAllByText("State: Delhi (07)")).toHaveLength(2);
    expect(screen.getByText("Place of supply: Delhi (07)")).toBeInTheDocument();
  });

  it("prints IGST for an inter-state note", () => {
    render(
      <CreditNoteSheet
        doc={doc({
          taxPaise: 90_000,
          totalPaise: 590_000,
          taxRateBps: 1800,
          supplierGstin: "07AAAAA0000A1Z5",
          placeOfSupply: "29",
          taxLines: [{ name: "IGST", rateBps: 1800, amountPaise: 90_000 }],
        })}
      />,
    );
    expect(totalValue("IGST 18%")).toBe("₹900.00");
    expect(screen.queryByText(/CGST/)).toBeNull();
    expect(
      screen.getByText("Place of supply: Karnataka (29)"),
    ).toBeInTheDocument();
  });
});

describe("CreditNoteSheet: place of supply and the customer's State (GST, A6)", () => {
  const taxed = {
    taxablePaise: 500_000,
    taxPaise: 90_000,
    totalPaise: 590_000,
    taxRateBps: 1800,
  };

  it("prints the customer's State from the recipient basis", () => {
    render(
      <CreditNoteSheet
        doc={doc({
          ...taxed,
          supplierGstin: "03AAAAA0000A1Z5",
          placeOfSupply: "29",
          placeOfSupplyBasis: "recipient",
          recipientStateCode: "29",
          taxLines: [{ name: "IGST", rateBps: 1800, amountPaise: 90_000 }],
        })}
      />,
    );
    expect(screen.getByText("State: Karnataka (29)")).toBeInTheDocument();
    expect(screen.getByText("State: Punjab (03)")).toBeInTheDocument();
    expect(
      screen.getByText("Place of supply: Karnataka (29)"),
    ).toBeInTheDocument();
  });

  it("a supplier-basis note prints the place of supply and no customer State", () => {
    const { container } = render(
      <CreditNoteSheet
        doc={doc({
          ...taxed,
          supplierGstin: "03AAAAA0000A1Z5",
          placeOfSupply: "03",
          placeOfSupplyBasis: "supplier",
          recipientStateCode: null,
          taxLines: [
            { name: "CGST", rateBps: 900, amountPaise: 45_000 },
            { name: "SGST", rateBps: 900, amountPaise: 45_000 },
          ],
        })}
      />,
    );
    expect(
      screen.getByText("Place of supply: Punjab (03)"),
    ).toBeInTheDocument();
    // Only the supplier's own State, under From; nothing under To.
    expect(screen.getAllByText(/^State: /)).toHaveLength(1);
    const to = container.querySelectorAll(".sminv-parties > div")[1];
    expect(to.textContent).not.toMatch(/State:/);
  });

  it("a place of supply outside India prints 'Outside India (96)' and no customer State", () => {
    const { container } = render(
      <CreditNoteSheet
        doc={doc({
          ...taxed,
          supplierGstin: "03AAAAA0000A1Z5",
          placeOfSupply: "96",
          placeOfSupplyBasis: "outside_india",
          recipientStateCode: null,
          taxLines: [{ name: "IGST", rateBps: 1800, amountPaise: 90_000 }],
        })}
      />,
    );
    expect(
      screen.getByText("Place of supply: Outside India (96)"),
    ).toBeInTheDocument();
    const to = container.querySelectorAll(".sminv-parties > div")[1];
    expect(to.textContent).not.toMatch(/State:/);
  });

  it("never prints the place of supply as the customer's State", () => {
    // An older document without the recipient State field: no customer
    // State, even though the place of supply names one.
    const legacy = doc({
      ...taxed,
      supplierGstin: "03AAAAA0000A1Z5",
      placeOfSupply: "29",
      taxLines: [{ name: "IGST", rateBps: 1800, amountPaise: 90_000 }],
    }) as Partial<CreditNotePrintDocument>;
    delete legacy.recipientStateCode;
    const { container } = render(
      <CreditNoteSheet doc={legacy as CreditNotePrintDocument} />,
    );
    const to = container.querySelectorAll(".sminv-parties > div")[1];
    expect(to.textContent).not.toMatch(/State:/);
    expect(
      screen.getByText("Place of supply: Karnataka (29)"),
    ).toBeInTheDocument();
  });
});

// ── R2-09: the invoice sheet's gates, and the LLP line ──────────────────────

describe("CreditNoteSheet: the supplier's particulars (R2-09)", () => {
  const LLP = {
    legalName: "STOREMINK LLP",
    address: { line1: "Bala ji Colony", city: "Faridkot" },
    llpin: "ADC-5432",
    registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
  };

  it("prints no supplier GSTIN or State on a note that credits no tax", () => {
    // An untaxed invoice that recorded a supplier GSTIN: the invoice sheet
    // prints neither, so neither does its note.
    const { container } = render(
      <CreditNoteSheet doc={doc({ supplierGstin: "03AAAAA0000A1Z5" })} />,
    );
    const from = container.querySelectorAll(".sminv-parties > div")[0];
    expect(from.textContent).not.toMatch(/GSTIN/);
    expect(from.textContent).not.toMatch(/State:/);
  });

  it("prints the supplier GSTIN and State on a note that credits tax", () => {
    const { container } = render(
      <CreditNoteSheet
        doc={doc({
          supplierGstin: "03AAAAA0000A1Z5",
          placeOfSupply: "29",
          taxPaise: 90_000,
          taxLines: [{ name: "IGST", rateBps: 1800, amountPaise: 90_000 }],
        })}
      />,
    );
    const from = container.querySelectorAll(".sminv-parties > div")[0];
    expect(from.textContent).toMatch(/GSTIN: 03AAAAA0000A1Z5/);
    expect(from.textContent).toMatch(/State: Punjab \(03\)/);
  });

  it("prints the LLP line in the footer once an LLPIN was recorded", () => {
    const { container } = render(
      <CreditNoteSheet doc={doc({ supplier: LLP })} />,
    );
    const llp = container.querySelector(".sminv-foot .sminv-llp");
    expect(llp?.textContent).toBe(
      "STOREMINK LLP is registered with limited liability. LLPIN ADC-5432. Registered office: Bala ji Colony, Faridkot, Punjab, India.",
    );
  });

  it("prints no LLP line without an LLPIN, or on a document built before it", () => {
    const { container, unmount } = render(<CreditNoteSheet doc={doc()} />);
    expect(container.querySelector(".sminv-llp")).toBeNull();
    unmount();
    const legacy = doc({
      supplier: { legalName: "STOREMINK LLP", address: {} },
    } as unknown as Partial<CreditNotePrintDocument>);
    const again = render(<CreditNoteSheet doc={legacy} />);
    expect(again.container.querySelector(".sminv-llp")).toBeNull();
  });
});

describe("CreditNoteSheet: how the money went back", () => {
  it("a Razorpay refund went back to the original payment method", () => {
    render(<CreditNoteSheet doc={doc()} />);
    expect(
      screen.getByText(
        "Refunded to the original payment method on 31 Oct 2026.",
      ),
    ).toBeInTheDocument();
  });

  it("a bank transfer names its date and UTR", () => {
    render(
      <CreditNoteSheet
        doc={doc({
          refund: {
            method: "bank_transfer",
            refundedAt: "2026-11-02T06:00:00.000Z",
            reference: "UTR998877",
          },
        })}
      />,
    );
    expect(
      screen.getByText(
        "Refunded by bank transfer on 2 Nov 2026, reference UTR998877.",
      ),
    ).toBeInTheDocument();
  });

  it("a note cancelling an unpaid invoice prints no refund line", () => {
    render(
      <CreditNoteSheet
        doc={doc({ reason: "invoice_cancelled", refund: null })}
      />,
    );
    expect(screen.queryByText(/^Refunded/)).toBeNull();
    expect(
      screen.getByText(
        "The invoice was cancelled because the plan ended before the period it covers.",
      ),
    ).toBeInTheDocument();
  });
});

describe("creditNoteReasonText and creditNoteRefundLine", () => {
  it("words every reason the database allows, and an unknown one as an adjustment", () => {
    for (const code of [
      "cycle_not_reached",
      "feature_removed",
      "suspended_by_mistake",
      "declined_terms",
      "goodwill",
      "other",
      "invoice_cancelled",
    ]) {
      expect(creditNoteReasonText(code)).toBe(CREDIT_NOTE_REASON_TEXT[code]);
    }
    expect(creditNoteReasonText("something_new")).toBe("Adjustment.");
  });

  it("leaves the date and reference out when the refund carries none", () => {
    expect(
      creditNoteRefundLine({
        method: "bank_transfer",
        refundedAt: null,
        reference: null,
      }),
    ).toBe("Refunded by bank transfer.");
    expect(
      creditNoteRefundLine({
        method: "razorpay",
        refundedAt: null,
        reference: "rfnd_1",
      }),
    ).toBe("Refunded to the original payment method.");
    expect(creditNoteRefundLine(null)).toBeNull();
  });
});
