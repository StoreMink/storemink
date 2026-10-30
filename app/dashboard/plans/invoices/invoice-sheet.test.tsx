// @vitest-environment jsdom
// The printed subscription invoice.
//
// This is the document a merchant hands to an accountant, so the tests are about
// what it CLAIMS: a tax invoice must name a GSTIN and split the tax correctly, and
// a no-tax invoice must say plainly that no GST was charged rather than showing a
// zero that looks like an omission — or worse, a claim.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { render, screen, within } from "@testing-library/react";
import { InvoiceSheet } from "./invoice-sheet";
import type { InvoiceDocument } from "@/lib/billing/invoice-types";

function doc(over: Partial<InvoiceDocument> = {}): InvoiceDocument {
  return {
    id: "inv-1",
    invoiceRef: "SM/2026-27/00001",
    kind: "subscription",
    status: "paid",
    issuedAt: "2026-09-01T00:00:00.000Z",
    paidAt: "2026-09-01T00:00:00.000Z",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    subtotalPaise: 500_000,
    discountPaise: 0,
    taxPaise: 0,
    totalPaise: 500_000,
    taxRateBps: 0,
    supplierGstin: null,
    customerGstin: null,
    placeOfSupply: null,
    sacCode: null,
    taxInclusive: false,
    placeOfSupplyBasis: null,
    items: [
      {
        kind: "base_plan",
        description: "Pro plan · 1 month",
        quantity: 1,
        unitAmountPaise: 500_000,
        amountPaise: 500_000,
      },
    ],
    supplier: {
      legalName: "StoreMink Technologies",
      address: { city: "New Delhi", postalCode: "110001" },
      gstin: null,
      stateCode: null,
      llpin: null,
      registeredOffice: null,
    },
    customer: {
      legalName: "Acme Retail",
      address: { city: "Bengaluru" },
      billingEmail: "acme@example.test",
      stateCode: null,
      country: null,
    },
    credits: [],
    refunds: {
      refundedPaise: 0,
      extraReturnedPaise: 0,
      inProgressPaise: 0,
      inProgress: false,
      delayed: false,
    },
    ...over,
  };
}

/** Tax ON, supplier in Delhi (07). */
const TAXED = {
  taxPaise: 90_000,
  totalPaise: 590_000,
  taxRateBps: 1800,
  supplierGstin: "07AABCS1429B1ZX",
  customerGstin: "29AAACM1234C1ZP",
};

describe("InvoiceSheet — no tax (today's state)", () => {
  it("★★ is titled 'Invoice', NOT 'Tax Invoice'", () => {
    // Calling it a tax invoice while charging no tax and naming no GSTIN is a
    // claim the document cannot support.
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.getByText("Invoice")).toBeInTheDocument();
    expect(screen.queryByText("Tax Invoice")).not.toBeInTheDocument();
  });

  it("★★ shows NO GST line at all — not a zero", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.queryByText(/CGST|SGST|IGST/)).not.toBeInTheDocument();
  });

  it("★ says WHY there is no GST, so the gap is not read as an omission", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.getByText(/No GST has been charged/i)).toBeInTheDocument();
  });

  it("★ omits the place of supply, which decides nothing here", () => {
    render(<InvoiceSheet doc={doc({ placeOfSupply: "29" })} />);
    expect(screen.queryByText(/Place of supply/i)).not.toBeInTheDocument();
  });

  it("still totals correctly", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.getAllByText("₹5,000.00").length).toBeGreaterThan(0);
  });
});

describe("InvoiceSheet — tax ON", () => {
  it("★★ INTER-state supply shows IGST only", () => {
    // Supplier 07 (Delhi), merchant 29 (Karnataka) — different states.
    render(<InvoiceSheet doc={doc({ ...TAXED, placeOfSupply: "29" })} />);
    expect(screen.getByText("IGST 18%")).toBeInTheDocument();
    expect(screen.queryByText(/CGST/)).not.toBeInTheDocument();
  });

  it("★★ INTRA-state supply splits into CGST + SGST at half the rate each", () => {
    render(<InvoiceSheet doc={doc({ ...TAXED, placeOfSupply: "07" })} />);
    expect(screen.getByText("CGST 9%")).toBeInTheDocument();
    expect(screen.getByText("SGST 9%")).toBeInTheDocument();
    expect(screen.queryByText(/IGST/)).not.toBeInTheDocument();
  });

  it("★★ the halves ADD UP to the tax charged", () => {
    // Split from the tax AMOUNT, never recomputed from the rate — so it can
    // never disagree with the total's rounding.
    render(<InvoiceSheet doc={doc({ ...TAXED, placeOfSupply: "07" })} />);
    // ₹900 total tax → ₹450 + ₹450.
    expect(screen.getAllByText("₹450.00")).toHaveLength(2);
  });

  it("is titled 'Tax Invoice' and names both GSTINs", () => {
    render(<InvoiceSheet doc={doc({ ...TAXED, placeOfSupply: "29" })} />);
    expect(screen.getByText("Tax Invoice")).toBeInTheDocument();
    expect(screen.getByText(/07AABCS1429B1ZX/)).toBeInTheDocument();
    expect(screen.getByText(/29AAACM1234C1ZP/)).toBeInTheDocument();
  });

  it("★ names the place of supply, which is what decides the split", () => {
    render(<InvoiceSheet doc={doc({ ...TAXED, placeOfSupply: "29" })} />);
    expect(screen.getByText(/Karnataka/)).toBeInTheDocument();
  });

  it("★★ a tax AMOUNT with no supplier GSTIN is NOT rendered as a tax invoice", () => {
    // Data that should not exist — but if it does, the document must not claim a
    // registration it cannot name.
    render(
      <InvoiceSheet
        doc={doc({ taxPaise: 90_000, totalPaise: 590_000, taxRateBps: 1800 })}
      />,
    );
    expect(screen.queryByText("Tax Invoice")).not.toBeInTheDocument();
    expect(screen.queryByText(/CGST|SGST|IGST/)).not.toBeInTheDocument();
  });
});

describe("InvoiceSheet — the rest", () => {
  it("★ shows a discount NEGATIVE, so the ladder adds up", () => {
    render(
      <InvoiceSheet
        doc={doc({ discountPaise: 50_000, totalPaise: 450_000 })}
      />,
    );
    expect(screen.getByText("−₹500.00")).toBeInTheDocument();
  });

  it("omits the discount line entirely when there is none", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.queryByText(/Discount/)).not.toBeInTheDocument();
  });

  it("★ translates our status vocabulary into the merchant's", () => {
    render(<InvoiceSheet doc={doc({ status: "uncollectible" })} />);
    expect(screen.getByText("Unpaid - plan ended")).toBeInTheDocument();
    expect(screen.queryByText("uncollectible")).not.toBeInTheDocument();
  });

  it("renders every line item", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.getByText("Pro plan · 1 month")).toBeInTheDocument();
  });

  it("★ survives a customer with no legal name — a store may never have set one", () => {
    render(
      <InvoiceSheet
        doc={doc({
          customer: {
            legalName: null,
            address: {},
            billingEmail: null,
            stateCode: null,
            country: null,
          },
        })}
      />,
    );
    expect(screen.getByText("Billed to")).toBeInTheDocument();
  });
});

describe("InvoiceSheet: refunds and credit notes (renewal-cancel, design 8.7)", () => {
  const NONE = doc().refunds;

  it("labels the two refund statuses nothing writes, in words", () => {
    // Rule R9: a refund never changes its invoice, so these are labels for a
    // status somebody set by hand. The code word must never print.
    const { unmount } = render(
      <InvoiceSheet doc={doc({ status: "refunded" })} />,
    );
    expect(screen.getByText("Refunded")).toBeInTheDocument();
    unmount();
    render(<InvoiceSheet doc={doc({ status: "partially_refunded" })} />);
    expect(screen.getByText("Partly refunded")).toBeInTheDocument();
    expect(screen.queryByText("partially_refunded")).not.toBeInTheDocument();
  });

  it("shows no block on an invoice nobody refunded", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(
      screen.queryByText("Refunds and credit notes"),
    ).not.toBeInTheDocument();
  });

  it("lists each credit note with its date and amount, linked to the note", () => {
    render(
      <InvoiceSheet
        doc={doc({
          credits: [
            {
              id: "cn-1",
              creditNoteRef: "CN/2026-27/00001",
              issuedAt: "2026-10-30 06:00:00+00",
              totalPaise: 240_000,
            },
          ],
          refunds: { ...NONE, refundedPaise: 240_000 },
        })}
      />,
    );
    expect(screen.getByText("Refunds and credit notes")).toBeInTheDocument();
    const line = screen.getByText(
      "Credit note CN/2026-27/00001, 30 Oct 2026: ₹2,400.00",
    );
    expect(line.closest("a")).toHaveAttribute(
      "href",
      "/dashboard/plans/credit-notes/cn-1",
    );
  });

  it("prints the credit note as text where there is no credit-note page", () => {
    render(
      <InvoiceSheet
        creditNotePath={null}
        doc={doc({
          credits: [
            {
              id: "cn-1",
              creditNoteRef: "CN/2026-27/00001",
              issuedAt: "2026-10-30 06:00:00+00",
              totalPaise: 240_000,
            },
          ],
        })}
      />,
    );
    const line = screen.getByText(
      "Credit note CN/2026-27/00001, 30 Oct 2026: ₹2,400.00",
    );
    expect(line.closest("a")).toBeNull();
  });

  it("says a refund is on its way while one is owed or pending", () => {
    render(
      <InvoiceSheet
        doc={doc({
          refunds: { ...NONE, inProgressPaise: 240_000, inProgress: true },
        })}
      />,
    );
    expect(
      screen.getByText("Refund of ₹2,400.00: on its way"),
    ).toBeInTheDocument();
  });

  it("★ names a returned duplicate payment as such, never as a credit note", () => {
    // A duplicate payment reduces no supply, so it has no credit note: the
    // block says an extra payment went back.
    render(
      <InvoiceSheet
        doc={doc({ refunds: { ...NONE, extraReturnedPaise: 240_000 } })}
      />,
    );
    expect(
      screen.getByText("Extra payment of ₹2,400.00 returned"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Credit note/)).not.toBeInTheDocument();
  });

  it("keeps the invoice's own status beside its refunds (rule R9)", () => {
    render(
      <InvoiceSheet
        doc={doc({
          status: "paid",
          credits: [
            {
              id: "cn-1",
              creditNoteRef: "CN/2026-27/00001",
              issuedAt: "2026-10-30 06:00:00+00",
              totalPaise: 500_000,
            },
          ],
          refunds: { ...NONE, refundedPaise: 500_000 },
        })}
      />,
    );
    // The Status row, not the "Paid" date row above it.
    expect(screen.getByText("Status").nextElementSibling).toHaveTextContent(
      /^Paid$/,
    );
  });
});

describe("InvoiceSheet: GST on StoreMink's own invoices (design 7.6)", () => {
  const LLP = {
    legalName: "STOREMINK LLP",
    address: { line1: "Bala ji Colony", city: "Faridkot" },
    gstin: "03ABCDE1234F1Z5",
    stateCode: "03",
    llpin: "ADC-5432",
    registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
  };
  const LLP_LINE =
    "STOREMINK LLP is registered with limited liability. LLPIN ADC-5432. Registered office: Bala ji Colony, Faridkot, Punjab, India.";
  const PLAN_LINE = {
    kind: "base_plan",
    description: "Pro plan · 1 month",
    quantity: 1,
    unitAmountPaise: 500_000,
    amountPaise: 500_000,
  };
  const TAX_LINE = {
    kind: "tax",
    description: "GST @ 18%",
    quantity: 1,
    unitAmountPaise: 90_000,
    amountPaise: 90_000,
  };

  /** A tax invoice from a Punjab supplier to a merchant in Delhi. */
  function taxDoc(over: Partial<InvoiceDocument> = {}): InvoiceDocument {
    return doc({
      taxPaise: 90_000,
      totalPaise: 590_000,
      taxRateBps: 1800,
      supplierGstin: "03ABCDE1234F1Z5",
      customerGstin: "07AAACM1234C1ZP",
      placeOfSupply: "07",
      placeOfSupplyBasis: "recipient",
      sacCode: "998314",
      items: [PLAN_LINE, TAX_LINE],
      supplier: LLP,
      customer: {
        legalName: "Acme Retail",
        address: { city: "New Delhi" },
        billingEmail: "acme@example.test",
        stateCode: "07",
        country: null,
      },
      ...over,
    });
  }

  const section = (heading: string) =>
    screen.getByText(heading).parentElement as HTMLElement;
  const totalsLabels = () =>
    Array.from(
      document.querySelectorAll(".sminv-totals p > span:first-child"),
    ).map((el) => el.textContent);
  const metaValue = (label: string) =>
    screen.getByText(label).nextElementSibling?.textContent;

  it("titles a tax invoice and marks it the original for the recipient", () => {
    render(<InvoiceSheet doc={taxDoc()} />);
    expect(screen.getByText("Tax Invoice")).toBeInTheDocument();
    expect(screen.getByText("Original for recipient")).toBeInTheDocument();
  });

  it("prints the place of supply and the reverse charge rows on a tax invoice", () => {
    render(<InvoiceSheet doc={taxDoc()} />);
    expect(metaValue("Place of supply")).toBe("Delhi (07)");
    expect(metaValue("Tax payable on reverse charge")).toBe("No");
  });

  it("names the supplier's GSTIN and State in the From block", () => {
    render(<InvoiceSheet doc={taxDoc()} />);
    const from = within(section("From"));
    expect(from.getByText("GSTIN: 03ABCDE1234F1Z5")).toBeInTheDocument();
    expect(from.getByText("State: Punjab (03)")).toBeInTheDocument();
  });

  it("names the merchant's GSTIN and State when the State came from their records", () => {
    render(<InvoiceSheet doc={taxDoc()} />);
    const billed = within(section("Billed to"));
    expect(billed.getByText("GSTIN: 07AAACM1234C1ZP")).toBeInTheDocument();
    expect(billed.getByText("State: Delhi (07)")).toBeInTheDocument();
  });

  it("prints no State for the merchant on a supplier fallback", () => {
    // The place of supply is the supplier's own State (basis `supplier`):
    // it says nothing about where the merchant is.
    render(
      <InvoiceSheet
        doc={taxDoc({
          placeOfSupply: "03",
          placeOfSupplyBasis: "supplier",
          customerGstin: null,
          customer: {
            legalName: "Acme Retail",
            address: { city: "New Delhi" },
            billingEmail: "acme@example.test",
            stateCode: null,
            country: null,
          },
        })}
      />,
    );
    const billed = within(section("Billed to"));
    expect(billed.queryByText(/^State:/)).not.toBeInTheDocument();
    expect(metaValue("Place of supply")).toBe("Punjab (03)");
    // The supplier keeps its own State, and the split is intra-state.
    expect(
      within(section("From")).getByText("State: Punjab (03)"),
    ).toBeInTheDocument();
    expect(screen.getByText("CGST 9%")).toBeInTheDocument();
    expect(screen.getByText("SGST 9%")).toBeInTheDocument();
  });

  it("prints Outside India (96) and the recorded country for a supply outside India", () => {
    render(
      <InvoiceSheet
        doc={taxDoc({
          placeOfSupply: "96",
          placeOfSupplyBasis: "outside_india",
          customerGstin: null,
          customer: {
            legalName: "Acme Inc",
            address: { line1: "1 Market Street", city: "San Francisco" },
            billingEmail: "acme@example.test",
            stateCode: null,
            country: "United States",
          },
        })}
      />,
    );
    expect(metaValue("Place of supply")).toBe("Outside India (96)");
    const billed = within(section("Billed to"));
    expect(billed.getByText("Acme Inc")).toBeInTheDocument();
    expect(billed.getByText("1 Market Street")).toBeInTheDocument();
    expect(billed.getByText("Country: United States")).toBeInTheDocument();
    expect(billed.queryByText(/^State:/)).not.toBeInTheDocument();
    expect(screen.getByText("IGST 18%")).toBeInTheDocument();
    expect(screen.queryByText(/CGST/)).not.toBeInTheDocument();
  });

  it("heads the amount column Amount (GST included) on an inclusive invoice", () => {
    const { unmount } = render(
      <InvoiceSheet doc={taxDoc({ taxInclusive: true })} />,
    );
    expect(
      screen.getByRole("columnheader", { name: "Amount (GST included)" }),
    ).toBeInTheDocument();
    unmount();
    render(<InvoiceSheet doc={taxDoc()} />);
    expect(
      screen.getByRole("columnheader", { name: "Amount" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Amount (GST included)" }),
    ).not.toBeInTheDocument();
  });

  it("prints the SAC code on each body line of a tax invoice", () => {
    render(<InvoiceSheet doc={taxDoc()} />);
    const table = within(screen.getByRole("table"));
    expect(
      table.getByRole("columnheader", { name: "SAC" }),
    ).toBeInTheDocument();
    expect(table.getByText("998314")).toBeInTheDocument();
  });

  it("keeps the tax and discount lines out of the items table of a tax invoice", () => {
    render(
      <InvoiceSheet
        doc={taxDoc({
          discountPaise: 50_000,
          taxPaise: 81_000,
          totalPaise: 531_000,
          items: [
            PLAN_LINE,
            {
              kind: "discount",
              description: "Discount",
              quantity: 1,
              unitAmountPaise: -50_000,
              amountPaise: -50_000,
            },
            { ...TAX_LINE, unitAmountPaise: 81_000, amountPaise: 81_000 },
          ],
          placeOfSupply: "07",
        })}
      />,
    );
    const table = within(screen.getByRole("table"));
    expect(table.getAllByRole("row")).toHaveLength(2);
    expect(table.getByText("Pro plan · 1 month")).toBeInTheDocument();
    expect(table.queryByText("GST @ 18%")).not.toBeInTheDocument();
    expect(table.queryByText("Discount")).not.toBeInTheDocument();
    // Printed once, in the totals.
    expect(totalsLabels()).toEqual([
      "Subtotal",
      "Discount",
      "Taxable value",
      "IGST 18%",
      "Total",
    ]);
    expect(screen.getByText("−₹500.00")).toBeInTheDocument();
    expect(screen.getByText("₹4,500.00")).toBeInTheDocument();
    expect(screen.getByText("₹810.00")).toBeInTheDocument();
    expect(screen.getByText("₹5,310.00")).toBeInTheDocument();
  });

  it("totals a tax invoice as the taxable value and the GST split", () => {
    render(<InvoiceSheet doc={taxDoc({ placeOfSupply: "03" })} />);
    expect(totalsLabels()).toEqual([
      "Taxable value",
      "CGST 9%",
      "SGST 9%",
      "Total",
    ]);
    expect(screen.getAllByText("₹450.00")).toHaveLength(2);
    expect(screen.getByText("₹5,900.00")).toBeInTheDocument();
  });

  it("keeps the tax and discount lines out of the items table of an invoice with no GST", () => {
    render(
      <InvoiceSheet
        doc={doc({
          discountPaise: 50_000,
          totalPaise: 450_000,
          items: [
            PLAN_LINE,
            {
              kind: "discount",
              description: "Discount",
              quantity: 1,
              unitAmountPaise: -50_000,
              amountPaise: -50_000,
            },
          ],
        })}
      />,
    );
    const table = within(screen.getByRole("table"));
    expect(table.getAllByRole("row")).toHaveLength(2);
    expect(table.queryByText("Discount")).not.toBeInTheDocument();
    expect(totalsLabels()).toEqual(["Subtotal", "Discount", "Total"]);
  });

  it("prints no GSTIN, State, SAC column, place of supply or reverse charge with no GST", () => {
    render(
      <InvoiceSheet
        doc={doc({
          placeOfSupply: "07",
          placeOfSupplyBasis: "recipient",
          sacCode: "998314",
          supplier: { ...LLP },
          customer: {
            legalName: "Acme Retail",
            address: {},
            billingEmail: null,
            stateCode: "07",
            country: null,
          },
        })}
      />,
    );
    expect(screen.getByText("Invoice")).toBeInTheDocument();
    expect(
      screen.queryByText("Original for recipient"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/GSTIN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^State:/)).not.toBeInTheDocument();
    expect(screen.queryByText("SAC")).not.toBeInTheDocument();
    expect(screen.queryByText("998314")).not.toBeInTheDocument();
    expect(screen.queryByText("Place of supply")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Tax payable on reverse charge"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Amount" }),
    ).toBeInTheDocument();
  });

  it("prints the recorded country on an invoice with no GST", () => {
    render(
      <InvoiceSheet
        doc={doc({
          customer: {
            legalName: "Acme Pte Ltd",
            address: {},
            billingEmail: null,
            stateCode: null,
            country: "Singapore",
          },
        })}
      />,
    );
    expect(screen.getByText("Country: Singapore")).toBeInTheDocument();
  });

  it("prints the LLP line on a tax invoice", () => {
    render(<InvoiceSheet doc={taxDoc()} />);
    expect(screen.getByText(LLP_LINE)).toBeInTheDocument();
  });

  it("prints the LLP line on an invoice with no GST", () => {
    render(<InvoiceSheet doc={doc({ supplier: { ...LLP } })} />);
    expect(screen.getByText(LLP_LINE)).toBeInTheDocument();
    expect(screen.getByText(/No GST has been charged/)).toBeInTheDocument();
  });

  it("prints no LLP line when no LLPIN was recorded", () => {
    render(
      <InvoiceSheet doc={taxDoc({ supplier: { ...LLP, llpin: null } })} />,
    );
    expect(
      screen.queryByText(/registered with limited liability/),
    ).not.toBeInTheDocument();
  });

  it("still adds up when a tax amount sits on a row naming no supplier GSTIN", () => {
    // Data that should not exist: no tax invoice, no split, but the ladder
    // still reaches the total, from the row's own tax line.
    render(
      <InvoiceSheet
        doc={doc({
          taxPaise: 90_000,
          totalPaise: 590_000,
          taxRateBps: 1800,
          items: [PLAN_LINE, TAX_LINE],
        })}
      />,
    );
    expect(totalsLabels()).toEqual(["Subtotal", "GST @ 18%", "Total"]);
    expect(
      within(screen.getByRole("table")).queryByText("GST @ 18%"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Tax Invoice")).not.toBeInTheDocument();
  });
});

// ── R2-12: one date style, India time ───────────────────────────────────────

describe("InvoiceSheet: dates (R2-12)", () => {
  it("prints every date as the GST copy does, with no leading zero", () => {
    render(<InvoiceSheet doc={doc()} />);
    // Issued and Paid: 05:30 IST on 1 September ("Sept" in newer ICU data).
    expect(screen.getAllByText(/^1 Sept? 2026$/)).toHaveLength(2);
    expect(screen.getByText(/^1 Sept? 2026 to 1 Oct 2026$/)).toBeTruthy();
    expect(screen.queryByText(/01 Sept? 2026/)).toBeNull();
  });

  it("dates 00:00 IST as that day, not the day before", () => {
    /** 00:00 IST on 1 December 2026. */
    const midnight = "2026-11-30T18:30:00.000Z";
    render(
      <InvoiceSheet
        doc={doc({ issuedAt: midnight, paidAt: null, periodStart: null })}
      />,
    );
    expect(screen.getByText("1 Dec 2026")).toBeTruthy();
    expect(screen.queryByText(/30 Nov 2026/)).toBeNull();
  });
});

// ── R2-07: the items table scrolls in its own box on a phone ───────────────

describe("InvoiceSheet: the items table on a phone (R2-07)", () => {
  const css = readFileSync(join(__dirname, "invoice-sheet.css"), "utf8");
  /** The body of the first `@media` block whose query matches, or "". */
  function mediaBlock(query: string): string {
    const at = css.indexOf(`@media ${query} {`);
    if (at < 0) return "";
    let depth = 0;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
    }
    return "";
  }
  const rule = (block: string, selector: string): string => {
    const start = block.indexOf(`${selector} {`);
    return start < 0 ? "" : block.slice(start, block.indexOf("}", start));
  };

  it("wraps the table in the box that scrolls", () => {
    render(<InvoiceSheet doc={doc(TAXED)} />);
    expect(screen.getByRole("table").parentElement?.className).toBe(
      "sminv-items-scroll",
    );
  });

  it("scrolls that box on a phone screen, and only on a screen", () => {
    const phone = mediaBlock("screen and (max-width: 640px)");
    expect(phone).not.toBe("");
    expect(rule(phone, ".sminv-items-scroll")).toMatch(/overflow-x:\s*auto/);
    // The long headers may wrap; the figures in the cells stay on one line.
    expect(phone).toMatch(
      /\.sminv-items th\.num,\s*\.sminv-items th\.sac \{\s*white-space:\s*normal/,
    );
    // ★ The table keeps width: 100%: `display: block` would let a table that
    // fits shrink to its content and pull its figures off the totals' edge.
    expect(css).not.toMatch(/\.sminv-items\s*\{[^}]*display:\s*block/);
    // Print lays the sheet flat: no scroll box there.
    expect(mediaBlock("print")).not.toMatch(/sminv-items-scroll/);
  });
});
