// StoreMink's own credit notes: the arithmetic (renewal-cancel, design 6.7).
//
// A credit note is a GST document: the notes of one invoice must add up to
// that invoice, never more, and when the invoice is fully reversed they must
// reverse exactly the tax it charged. These tests hold the rules a reviewer
// can check by hand, then walk many sequences of partial refunds to show the
// totals never break.

import { describe, it, expect } from "vitest";
import {
  creditNoteRecipientState,
  creditNoteSplit,
  creditNoteTaxLines,
  unusedPartOfCycle,
} from "./credit-notes";
import { platformInvoiceGst, splitGstPaise } from "./gst";

const DAY = 24 * 60 * 60 * 1000;

function split(
  invoiceTotalPaise: number,
  invoiceTaxPaise: number,
  creditedTotalPaise: number,
  creditedTaxPaise: number,
  amountPaise: number,
) {
  return creditNoteSplit({
    invoiceTotalPaise,
    invoiceTaxPaise,
    creditedTotalPaise,
    creditedTaxPaise,
    amountPaise,
  });
}

describe("creditNoteSplit", () => {
  it("reverses a whole invoice in one note, tax included", () => {
    // ₹100 plan + 18% GST = ₹118, refunded in full.
    expect(split(11800, 1800, 0, 0, 11800)).toEqual({
      totalPaise: 11800,
      taxPaise: 1800,
      taxablePaise: 10000,
    });
  });

  it("takes a partial note's tax in proportion, rounded down", () => {
    // floor(5000 * 1800 / 11800) = floor(762.71) = 762.
    expect(split(11800, 1800, 0, 0, 5000)).toEqual({
      totalPaise: 5000,
      taxPaise: 762,
      taxablePaise: 4238,
    });
  });

  it("gives the last note whatever tax is left, so the notes reverse the invoice's tax exactly", () => {
    // ₹10 invoice charging 153 paise of tax, refunded in three parts.
    const first = split(1000, 153, 0, 0, 333)!;
    expect(first).toEqual({ totalPaise: 333, taxPaise: 50, taxablePaise: 283 });

    const second = split(1000, 153, 333, 50, 333)!;
    expect(second).toEqual({
      totalPaise: 333,
      taxPaise: 50,
      taxablePaise: 283,
    });

    // In proportion this note's tax would be floor(334 * 153 / 1000) = 51 and
    // the three notes would reverse 151 of the 153 paise declared. The last
    // note takes the remainder instead.
    const last = split(1000, 153, 666, 100, 334)!;
    expect(last).toEqual({ totalPaise: 334, taxPaise: 53, taxablePaise: 281 });

    expect(first.totalPaise + second.totalPaise + last.totalPaise).toBe(1000);
    expect(first.taxPaise + second.taxPaise + last.taxPaise).toBe(153);
  });

  it("credits at most what is left of the invoice", () => {
    // ₹8 of a ₹10 invoice is already credited; a ₹5 refund credits ₹2, and
    // because that brings the invoice to its total it is the last note.
    expect(split(1000, 153, 800, 122, 500)).toEqual({
      totalPaise: 200,
      taxPaise: 31,
      taxablePaise: 169,
    });
  });

  it("issues no note when nothing is left to credit", () => {
    expect(split(11800, 1800, 11800, 1800, 5000)).toBeNull();
    // More credited than the invoice (a row edited by hand) is still nothing left.
    expect(split(11800, 1800, 12000, 1800, 5000)).toBeNull();
  });

  it("issues no note for a refund of nothing", () => {
    expect(split(11800, 1800, 0, 0, 0)).toBeNull();
    expect(split(11800, 1800, 0, 0, -500)).toBeNull();
    expect(split(11800, 1800, 0, 0, Number.NaN)).toBeNull();
  });

  it("credits no tax on an invoice that charged none", () => {
    expect(split(15000, 0, 0, 0, 15000)).toEqual({
      totalPaise: 15000,
      taxPaise: 0,
      taxablePaise: 15000,
    });
    expect(split(15000, 0, 0, 0, 4000)).toEqual({
      totalPaise: 4000,
      taxPaise: 0,
      taxablePaise: 4000,
    });
  });

  it("never gives a note more tax than its own total, even after rounded-down partials", () => {
    // ₹1.18 invoice with 18 paise of tax. Two partial notes round their tax
    // down (6 -> 0, 111 -> 16), leaving 2 paise of tax for a 1-paisa last note.
    // A tax above the note's total would be a negative taxable value, which the
    // database refuses, so the note's tax is capped at its total.
    const first = split(118, 18, 0, 0, 6)!;
    expect(first).toEqual({ totalPaise: 6, taxPaise: 0, taxablePaise: 6 });
    const second = split(118, 18, 6, 0, 111)!;
    expect(second).toEqual({ totalPaise: 111, taxPaise: 16, taxablePaise: 95 });
    const last = split(118, 18, 117, 16, 1)!;
    expect(last).toEqual({ totalPaise: 1, taxPaise: 1, taxablePaise: 0 });
  });

  it("never credits more tax than is left", () => {
    // Notes already reversed all the tax (hand-written rows): a partial note
    // must not take any more.
    expect(split(11800, 1800, 2000, 1800, 1000)).toEqual({
      totalPaise: 1000,
      taxPaise: 0,
      taxablePaise: 1000,
    });
  });

  it("reads amounts as whole paise and an invoice's tax as at most its total", () => {
    // 100.6 paise rounds to 101; a tax above the total is held to the total.
    expect(split(100.6, 500, 0, 0, 100.6)).toEqual({
      totalPaise: 101,
      taxPaise: 101,
      taxablePaise: 0,
    });
    // An unreadable credited figure counts as nothing credited.
    expect(split(1000, 180, Number.NaN, Number.NaN, 1000)).toEqual({
      totalPaise: 1000,
      taxPaise: 180,
      taxablePaise: 820,
    });
  });

  it("is exact for amounts where a floating-point product would lose a paisa", () => {
    // A * X = 1999999944 * 1000000007 is beyond 2^53, so A * X / T in floating
    // point gives 999999971.99..., one paisa short.
    const result = split(2000000014, 1000000007, 0, 0, 1999999944)!;
    expect(result.taxPaise).toBe(999999972);
    expect(Math.floor((1999999944 * 1000000007) / 2000000014)).toBe(999999971);
  });

  it("keeps every sequence of partial notes within the invoice, and lands on its tax when fully reversed", () => {
    // A small deterministic generator, so a failure always reproduces.
    let seed = 20261028;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };

    for (let run = 0; run < 400; run++) {
      const invoiceTotal = 1 + next(500000);
      const invoiceTax = next(Math.floor(invoiceTotal * 0.3) + 1);
      let creditedTotal = 0;
      let creditedTax = 0;
      let clamped = false;

      for (let step = 0; step < 12; step++) {
        const left = invoiceTotal - creditedTotal;
        if (left <= 0) break;
        // Mostly small partial refunds, sometimes the whole remainder.
        const amount =
          step === 11 || next(5) === 0 ? left : 1 + next(Math.max(1, left));
        const leftTax = invoiceTax - creditedTax;
        const note = split(
          invoiceTotal,
          invoiceTax,
          creditedTotal,
          creditedTax,
          amount,
        );
        expect(note).not.toBeNull();
        const n = note!;

        expect(n.totalPaise).toBeGreaterThan(0);
        expect(n.totalPaise).toBeLessThanOrEqual(left);
        expect(n.taxPaise).toBeGreaterThanOrEqual(0);
        expect(n.taxPaise).toBeLessThanOrEqual(n.totalPaise);
        expect(n.taxPaise).toBeLessThanOrEqual(leftTax);
        expect(n.taxablePaise).toBe(n.totalPaise - n.taxPaise);

        const isLast = creditedTotal + n.totalPaise === invoiceTotal;
        if (isLast && leftTax > n.totalPaise) clamped = true;
        if (!isLast) {
          // A partial note's tax is never more than its own proportion.
          expect(n.taxPaise).toBeLessThanOrEqual(
            Math.floor((n.totalPaise * invoiceTax) / invoiceTotal),
          );
        }

        creditedTotal += n.totalPaise;
        creditedTax += n.taxPaise;
      }

      expect(creditedTotal).toBe(invoiceTotal);
      expect(creditedTax).toBeLessThanOrEqual(invoiceTax);
      if (!clamped) expect(creditedTax).toBe(invoiceTax);
      // And once the invoice is fully credited, nothing more is issued.
      expect(
        split(invoiceTotal, invoiceTax, creditedTotal, creditedTax, 100),
      ).toBeNull();
    }
  });
});

describe("creditNoteTaxLines", () => {
  const GSTIN_07 = "07AABCS1429B1ZX";

  it("splits an intra-state note into CGST and SGST at half the rate each", () => {
    expect(
      creditNoteTaxLines({
        taxPaise: 1800,
        taxRateBps: 1800,
        supplierGstin: GSTIN_07,
        placeOfSupply: "07",
      }),
    ).toEqual([
      { name: "CGST", rateBps: 900, amountPaise: 900 },
      { name: "SGST", rateBps: 900, amountPaise: 900 },
    ]);
  });

  it("gives an odd paisa to SGST so the halves add up to the note's tax", () => {
    const lines = creditNoteTaxLines({
      taxPaise: 1801,
      taxRateBps: 1800,
      supplierGstin: GSTIN_07,
      placeOfSupply: "07",
    });
    expect(lines).toEqual([
      { name: "CGST", rateBps: 900, amountPaise: 900 },
      { name: "SGST", rateBps: 900, amountPaise: 901 },
    ]);
    expect(lines.reduce((s, l) => s + l.amountPaise, 0)).toBe(1801);
  });

  it("prints IGST for an inter-state note", () => {
    expect(
      creditNoteTaxLines({
        taxPaise: 1800,
        taxRateBps: 1800,
        supplierGstin: GSTIN_07,
        placeOfSupply: "29",
      }),
    ).toEqual([{ name: "IGST", rateBps: 1800, amountPaise: 1800 }]);
  });

  it("prints IGST when the place of supply is not recorded, the invoice sheet's rule", () => {
    expect(
      creditNoteTaxLines({
        taxPaise: 500,
        taxRateBps: 1800,
        supplierGstin: GSTIN_07,
        placeOfSupply: null,
      }),
    ).toEqual([{ name: "IGST", rateBps: 1800, amountPaise: 500 }]);
  });

  it("prints no tax line without a supplier GSTIN or without tax", () => {
    expect(
      creditNoteTaxLines({
        taxPaise: 1800,
        taxRateBps: 1800,
        supplierGstin: null,
        placeOfSupply: "07",
      }),
    ).toEqual([]);
    expect(
      creditNoteTaxLines({
        taxPaise: 0,
        taxRateBps: 1800,
        supplierGstin: GSTIN_07,
        placeOfSupply: "07",
      }),
    ).toEqual([]);
  });

  it("reads a missing rate as zero rather than inventing one", () => {
    expect(
      creditNoteTaxLines({
        taxPaise: 100,
        taxRateBps: null,
        supplierGstin: GSTIN_07,
        placeOfSupply: "29",
      }),
    ).toEqual([{ name: "IGST", rateBps: 0, amountPaise: 100 }]);
  });
});

describe("creditNoteTaxLines delegates to platformInvoiceGst (GST, A6)", () => {
  // The rule creditNoteTaxLines carried before the delegation, word for word:
  // existing notes must print exactly what they printed before.
  function before(input: {
    taxPaise: number;
    taxRateBps: number | null;
    supplierGstin: string | null;
    placeOfSupply: string | null;
  }) {
    const tax = Math.max(0, Math.round(input.taxPaise));
    if (tax <= 0 || !input.supplierGstin) return [];
    const rateBps = Math.max(0, Math.round(input.taxRateBps ?? 0));
    const intra =
      !!input.placeOfSupply &&
      input.supplierGstin.slice(0, 2) === input.placeOfSupply;
    const split = splitGstPaise(tax, intra);
    if (!intra)
      return [{ name: "IGST", rateBps, amountPaise: split.igstPaise }];
    return [
      { name: "CGST", rateBps: rateBps / 2, amountPaise: split.cgstPaise },
      { name: "SGST", rateBps: rateBps / 2, amountPaise: split.sgstPaise },
    ];
  }

  it("every existing note keeps its split", () => {
    const gstins = [
      null,
      "07AABCS1429B1ZX",
      "03AABCS1429B1ZX",
      "29AAACM1234C1ZP",
    ];
    const places = [null, "07", "03", "29", "33", ""];
    const taxes = [0, 1, 99, 1800, 1801, 90_000, 123_457];
    const rates = [null, 0, 500, 1200, 1800, 2800];
    let checked = 0;
    for (const supplierGstin of gstins)
      for (const placeOfSupply of places)
        for (const taxPaise of taxes)
          for (const taxRateBps of rates) {
            const input = {
              taxPaise,
              taxRateBps,
              supplierGstin,
              placeOfSupply,
            };
            expect(creditNoteTaxLines(input)).toEqual(before(input));
            checked += 1;
          }
    expect(checked).toBe(4 * 6 * 7 * 6);
  });

  it("splits exactly as platformInvoiceGst does", () => {
    for (const placeOfSupply of ["07", "29", null, "96"]) {
      const input = {
        taxPaise: 1801,
        taxRateBps: 1800,
        supplierGstin: "07AABCS1429B1ZX",
        placeOfSupply,
      };
      const gst = platformInvoiceGst(input);
      const lines = creditNoteTaxLines(input);
      if (gst.intraState) {
        expect(lines).toEqual([
          { name: "CGST", rateBps: 900, amountPaise: gst.cgstPaise },
          { name: "SGST", rateBps: 900, amountPaise: gst.sgstPaise },
        ]);
      } else {
        expect(lines).toEqual([
          { name: "IGST", rateBps: 1800, amountPaise: gst.igstPaise },
        ]);
      }
    }
  });

  it("a place of supply outside India (96) is always IGST", () => {
    expect(
      creditNoteTaxLines({
        taxPaise: 1800,
        taxRateBps: 1800,
        supplierGstin: "03AABCS1429B1ZX",
        placeOfSupply: "96",
      }),
    ).toEqual([{ name: "IGST", rateBps: 1800, amountPaise: 1800 }]);
  });
});

describe("creditNoteRecipientState (GST, A6)", () => {
  it("a recipient basis prints the place of supply as the customer's State", () => {
    expect(
      creditNoteRecipientState({
        placeOfSupply: "29",
        placeOfSupplyBasis: "recipient",
        recordedStateCode: "07",
      }),
    ).toBe("29");
  });

  it("an invoice from before the basis existed reads like a recipient basis", () => {
    expect(
      creditNoteRecipientState({
        placeOfSupply: "7",
        placeOfSupplyBasis: null,
        recordedStateCode: null,
      }),
    ).toBe("07");
  });

  it("a supplier fallback names no customer State, whatever was recorded", () => {
    expect(
      creditNoteRecipientState({
        placeOfSupply: "03",
        placeOfSupplyBasis: "supplier",
        recordedStateCode: "03",
      }),
    ).toBeNull();
  });

  it("a place of supply outside India names no customer State", () => {
    expect(
      creditNoteRecipientState({
        placeOfSupply: "96",
        placeOfSupplyBasis: "outside_india",
        recordedStateCode: "29",
      }),
    ).toBeNull();
    // 96 without a basis (never written, but never a State either).
    expect(
      creditNoteRecipientState({
        placeOfSupply: "96",
        placeOfSupplyBasis: null,
        recordedStateCode: null,
      }),
    ).toBeNull();
  });

  it("falls back to the recorded State only when the recipient basis gives none", () => {
    expect(
      creditNoteRecipientState({
        placeOfSupply: null,
        placeOfSupplyBasis: null,
        recordedStateCode: "29",
      }),
    ).toBe("29");
    expect(
      creditNoteRecipientState({
        placeOfSupply: null,
        placeOfSupplyBasis: "recipient",
        recordedStateCode: "96",
      }),
    ).toBeNull();
    expect(
      creditNoteRecipientState({
        placeOfSupply: "junk",
        placeOfSupplyBasis: null,
        recordedStateCode: null,
      }),
    ).toBeNull();
  });
});

describe("unusedPartOfCycle", () => {
  const start = new Date("2026-10-01T00:00:00.000Z");
  const end = new Date(start.getTime() + 30 * DAY);

  it("is the whole payment from the start of the period", () => {
    expect(
      unusedPartOfCycle({
        paidPaise: 150000,
        periodStart: start,
        periodEnd: end,
        from: start,
      }),
    ).toEqual({ paise: 150000, daysLeft: 30, daysTotal: 30 });
  });

  it("is the part after the given moment, rounded down", () => {
    // 20 of 30 days left: floor(150000 * 20 / 30) = 100000.
    expect(
      unusedPartOfCycle({
        paidPaise: 150000,
        periodStart: start,
        periodEnd: end,
        from: new Date(start.getTime() + 10 * DAY),
      }),
    ).toEqual({ paise: 100000, daysLeft: 20, daysTotal: 30 });

    // 2 of 3 days left of ₹1: floor(200 / 3) = 66 paise, never 67.
    expect(
      unusedPartOfCycle({
        paidPaise: 100,
        periodStart: start,
        periodEnd: new Date(start.getTime() + 3 * DAY),
        from: new Date(start.getTime() + DAY),
      }),
    ).toEqual({ paise: 66, daysLeft: 2, daysTotal: 3 });
  });

  it("counts a part day as a day left", () => {
    const result = unusedPartOfCycle({
      paidPaise: 150000,
      periodStart: start,
      periodEnd: end,
      from: new Date(start.getTime() + 10 * DAY + 60 * 60 * 1000),
    });
    expect(result.daysLeft).toBe(20);
    expect(result.paise).toBe(
      Math.floor((150000 * (20 * DAY - 60 * 60 * 1000)) / (30 * DAY)),
    );
  });

  it("is nothing at or after the end of the period", () => {
    expect(
      unusedPartOfCycle({
        paidPaise: 150000,
        periodStart: start,
        periodEnd: end,
        from: end,
      }),
    ).toEqual({ paise: 0, daysLeft: 0, daysTotal: 30 });
    expect(
      unusedPartOfCycle({
        paidPaise: 150000,
        periodStart: start,
        periodEnd: end,
        from: new Date(end.getTime() + 5 * DAY),
      }),
    ).toEqual({ paise: 0, daysLeft: 0, daysTotal: 30 });
  });

  it("treats a moment before the period as its start, never more than was paid", () => {
    expect(
      unusedPartOfCycle({
        paidPaise: 150000,
        periodStart: start,
        periodEnd: end,
        from: new Date(start.getTime() - 7 * DAY),
      }),
    ).toEqual({ paise: 150000, daysLeft: 30, daysTotal: 30 });
  });

  it("counts a yearly period's days", () => {
    const yearEnd = new Date(start.getTime() + 365 * DAY);
    expect(
      unusedPartOfCycle({
        paidPaise: 1500000,
        periodStart: start,
        periodEnd: yearEnd,
        from: new Date(start.getTime() + 73 * DAY),
      }),
    ).toEqual({ paise: 1200000, daysLeft: 292, daysTotal: 365 });
  });

  it("has no unused part for an empty, reversed or unreadable period", () => {
    const none = { paise: 0, daysLeft: 0, daysTotal: 0 };
    expect(
      unusedPartOfCycle({
        paidPaise: 150000,
        periodStart: end,
        periodEnd: start,
        from: start,
      }),
    ).toEqual(none);
    expect(
      unusedPartOfCycle({
        paidPaise: 150000,
        periodStart: start,
        periodEnd: start,
        from: start,
      }),
    ).toEqual(none);
    expect(
      unusedPartOfCycle({
        paidPaise: 150000,
        periodStart: new Date("not a date"),
        periodEnd: end,
        from: start,
      }),
    ).toEqual(none);
  });

  it("has no unused part from an unreadable moment", () => {
    expect(
      unusedPartOfCycle({
        paidPaise: 150000,
        periodStart: start,
        periodEnd: end,
        from: new Date("not a date"),
      }),
    ).toEqual({ paise: 0, daysLeft: 0, daysTotal: 30 });
  });

  it("reads an unreadable or negative payment as nothing paid", () => {
    expect(
      unusedPartOfCycle({
        paidPaise: -500,
        periodStart: start,
        periodEnd: end,
        from: start,
      }).paise,
    ).toBe(0);
    expect(
      unusedPartOfCycle({
        paidPaise: Number.NaN,
        periodStart: start,
        periodEnd: end,
        from: start,
      }).paise,
    ).toBe(0);
  });

  it("is exact where a floating-point product would lose a paisa", () => {
    // paid * remaining = 1999999944 * 1000000007 is beyond 2^53.
    const spanStart = new Date(0);
    const spanEnd = new Date(2000000014);
    const result = unusedPartOfCycle({
      paidPaise: 1999999944,
      periodStart: spanStart,
      periodEnd: spanEnd,
      from: new Date(2000000014 - 1000000007),
    });
    expect(result.paise).toBe(999999972);
  });
});
