import { describe, it, expect } from "vitest";
import { computeTax } from "./tax";
import {
  splitGst,
  isIntraState,
  normalizeStateCode,
  gstBreakdown,
  isValidGstinFormat,
  stateCodeFromGstin,
  GST_STATES,
  PICKABLE_GST_STATES,
  gstStateOptions,
  OUTSIDE_INDIA_PLACE_OF_SUPPLY,
  dbBasisFor,
  gstinStateCode,
  placeOfSupplyFor,
  placeOfSupplyLabel,
  platformInvoiceGst,
  recipientStateFor,
  stateCodeFromAddress,
  stateCodeFromName,
  type PlaceOfSupplyBasis,
  type PlaceOfSupplyInput,
} from "./gst";

describe("normalizeStateCode", () => {
  it("zero-pads and accepts numbers", () => {
    expect(normalizeStateCode("7")).toBe("07");
    expect(normalizeStateCode("07")).toBe("07");
    expect(normalizeStateCode(7)).toBe("07");
    expect(normalizeStateCode(27)).toBe("27");
    expect(normalizeStateCode(" 09 ")).toBe("09");
  });
  it("rejects junk", () => {
    expect(normalizeStateCode("")).toBeNull();
    expect(normalizeStateCode("abc")).toBeNull();
    expect(normalizeStateCode("123")).toBeNull();
    expect(normalizeStateCode(null)).toBeNull();
  });
});

describe("isIntraState", () => {
  it("compares normalised codes", () => {
    expect(isIntraState("07", "07")).toBe(true);
    expect(isIntraState("7", "07")).toBe(true);
    expect(isIntraState("07", "27")).toBe(false);
  });
  // A walk-in at the counter is the overwhelming case; defaulting to IGST on
  // missing data would mis-tax ordinary local shops.
  it("defaults to intra-state when either side is unknown", () => {
    expect(isIntraState(null, "07")).toBe(true);
    expect(isIntraState("07", undefined)).toBe(true);
    expect(isIntraState(null, null)).toBe(true);
  });
});

describe("splitGst", () => {
  it("halves an intra-state supply into CGST + SGST", () => {
    expect(splitGst(18, true)).toEqual({
      cgst: 9,
      sgst: 9,
      igst: 0,
      intraState: true,
    });
  });

  it("puts the whole amount in IGST inter-state", () => {
    expect(splitGst(18, false)).toEqual({
      cgst: 0,
      sgst: 0,
      igst: 18,
      intraState: false,
    });
  });

  // The halves must re-sum EXACTLY or the invoice won't balance.
  it("splits odd paise without losing or inventing money", () => {
    for (const amount of [0.05, 0.01, 1.23, 7.77, 99.99, 12.345]) {
      const s = splitGst(amount, true);
      expect(s.cgst + s.sgst).toBeCloseTo(
        Math.round((amount + Number.EPSILON) * 100) / 100,
        2,
      );
    }
  });

  it("treats junk and negatives as zero", () => {
    expect(splitGst(-5, true)).toMatchObject({ cgst: 0, sgst: 0 });
    expect(splitGst(NaN, true)).toMatchObject({ cgst: 0, sgst: 0, igst: 0 });
  });
});

// The split must never disagree with the order total computeTax produced.
describe("splitGst reconciles with computeTax", () => {
  const lines = [
    { amount: 500, rate: 18, label: "GST 18%" },
    { amount: 249.5, rate: 5, label: "GST 5%" },
    { amount: 99.99, rate: 12, label: "GST 12%" },
  ];

  it("per-line halves re-sum to the computed total tax (exclusive)", () => {
    const t = computeTax({ lines, discount: 75, pricesIncludeTax: false });
    const summed = t.lines.reduce((s, l) => {
      const g = splitGst(l.tax, true);
      return s + g.cgst + g.sgst + g.igst;
    }, 0);
    expect(Math.round(summed * 100) / 100).toBeCloseTo(t.totalTax, 2);
  });

  it("holds for inclusive pricing and inter-state too", () => {
    const t = computeTax({ lines, discount: 0, pricesIncludeTax: true });
    const summed = t.lines.reduce((s, l) => {
      const g = splitGst(l.tax, false);
      return s + g.igst;
    }, 0);
    expect(Math.round(summed * 100) / 100).toBeCloseTo(t.totalTax, 2);
  });
});

describe("gstBreakdown", () => {
  it("groups by rate and sorts ascending", () => {
    const out = gstBreakdown([
      { rate: 18, taxableValue: 100, cgst: 9, sgst: 9, igst: 0 },
      { rate: 5, taxableValue: 200, cgst: 5, sgst: 5, igst: 0 },
      { rate: 18, taxableValue: 50, cgst: 4.5, sgst: 4.5, igst: 0 },
    ]);
    expect(out.map((b) => b.rate)).toEqual([5, 18]);
    expect(out[1]).toMatchObject({
      rate: 18,
      taxableValue: 150,
      cgst: 13.5,
      sgst: 13.5,
    });
  });

  it("skips zero-rated lines and labels sensibly", () => {
    const out = gstBreakdown([
      { rate: 0, taxableValue: 100, cgst: 0, sgst: 0, igst: 0 },
      { rate: 12, taxableValue: 100, cgst: 6, sgst: 6, igst: 0 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("GST 12%");
  });
});

describe("GSTIN helpers", () => {
  it("accepts a well-formed GSTIN and extracts its state", () => {
    const gstin = "07AABCU9603R1ZM";
    expect(isValidGstinFormat(gstin)).toBe(true);
    expect(stateCodeFromGstin(gstin)).toBe("07");
  });

  it("rejects malformed values", () => {
    expect(isValidGstinFormat("07AABCU9603R1Z")).toBe(false); // 14 chars
    expect(isValidGstinFormat("notagstin")).toBe(false);
    expect(isValidGstinFormat("")).toBe(false);
    expect(isValidGstinFormat(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StoreMink's own invoices: place of supply (GST design 5.1).
// ---------------------------------------------------------------------------

// Well-formed GSTINs for three states (the format check, not a registry).
const DELHI_GSTIN = "07AABCU9603R1ZM";
const PUNJAB_GSTIN = "03ABCDE1234F1Z5";
const KARNATAKA_GSTIN = "29ABCDE1234F1Z5";

describe("stateCodeFromName", () => {
  it("resolves every GST_STATES name to its own code", () => {
    for (const state of GST_STATES) {
      expect(stateCodeFromName(state.name)).toBe(state.code);
    }
  });

  it("resolves the aliases", () => {
    expect(stateCodeFromName("New Delhi")).toBe("07");
    expect(stateCodeFromName("Orissa")).toBe("21");
    expect(stateCodeFromName("Pondicherry")).toBe("34");
    expect(stateCodeFromName("Uttaranchal")).toBe("05");
    expect(stateCodeFromName("Andaman and Nicobar")).toBe("35");
    expect(stateCodeFromName("Dadra and Nagar Haveli")).toBe("26");
    expect(stateCodeFromName("Daman and Diu")).toBe("26");
  });

  it("resolves Google's administrative_area_level_1 long names", () => {
    expect(stateCodeFromName("Jammu and Kashmir")).toBe("01");
    expect(stateCodeFromName("Andaman and Nicobar Islands")).toBe("35");
    expect(stateCodeFromName("Dadra and Nagar Haveli and Daman and Diu")).toBe(
      "26",
    );
    expect(stateCodeFromName("Delhi")).toBe("07");
    expect(stateCodeFromName("Odisha")).toBe("21");
    expect(stateCodeFromName("Orissa")).toBe("21");
    expect(stateCodeFromName("New Delhi")).toBe("07");
  });

  it("ignores case, spacing, punctuation and formal prefixes", () => {
    expect(stateCodeFromName("  KARNATAKA ")).toBe("29");
    expect(stateCodeFromName("tamil-nadu")).toBe("33");
    expect(stateCodeFromName("National Capital Territory of Delhi")).toBe("07");
    expect(stateCodeFromName("NCT of Delhi")).toBe("07");
    expect(stateCodeFromName("State of Punjab")).toBe("03");
    expect(stateCodeFromName("Union Territory of Ladakh")).toBe("38");
    expect(stateCodeFromName("The State of Goa")).toBe("30");
  });

  it("passes a two-digit code through when it is a listed state", () => {
    expect(stateCodeFromName("07")).toBe("07");
    expect(stateCodeFromName("7")).toBe("07");
    expect(stateCodeFromName(" 29 ")).toBe("29");
  });

  it("refuses a code that is not in the list", () => {
    expect(stateCodeFromName("25")).toBeNull(); // retired Daman & Diu
    expect(stateCodeFromName("96")).toBeNull();
    expect(stateCodeFromName("99")).toBeNull();
  });

  it("returns null for junk", () => {
    expect(stateCodeFromName("Atlantis")).toBeNull();
    expect(stateCodeFromName("")).toBeNull();
    expect(stateCodeFromName("   ")).toBeNull();
    expect(stateCodeFromName("123")).toBeNull();
    expect(stateCodeFromName(null)).toBeNull();
    expect(stateCodeFromName(undefined)).toBeNull();
    expect(stateCodeFromName({ state: "Delhi" })).toBeNull();
  });
});

describe("stateCodeFromAddress", () => {
  it("finds the state named in a typed address", () => {
    expect(
      stateCodeFromAddress("12 MG Road, Bengaluru, Karnataka 560001"),
    ).toBe("29");
  });

  it("takes the match that ends last (Punjab National Bank, Delhi)", () => {
    expect(
      stateCodeFromAddress("Punjab National Bank, Karol Bagh, Delhi 110005"),
    ).toBe("07");
  });

  it("finds a union territory written alone", () => {
    expect(stateCodeFromAddress("Shop 4, Sector 17, Chandigarh")).toBe("04");
  });

  it("never guesses from a PIN code when no state is named", () => {
    expect(stateCodeFromAddress("5 Mall Road, Ludhiana 141001")).toBeNull();
  });

  it("prefers the longer name when two end together", () => {
    expect(stateCodeFromAddress("Rajpath, New Delhi")).toBe("07");
    expect(
      stateCodeFromAddress(
        "Plot 3, Silvassa, Dadra and Nagar Haveli and Daman and Diu",
      ),
    ).toBe("26");
  });

  it("matches whole words only", () => {
    // "Goa" inside "Goalpara" is not Goa; Assam is named last.
    expect(stateCodeFromAddress("Goalpara Road, Guwahati, Assam")).toBe("18");
  });

  it("returns null for empty, junk and non-string input", () => {
    expect(stateCodeFromAddress("")).toBeNull();
    expect(stateCodeFromAddress("   ")).toBeNull();
    expect(stateCodeFromAddress("Flat 9, 221B Baker Street")).toBeNull();
    expect(stateCodeFromAddress(null)).toBeNull();
    expect(stateCodeFromAddress(42)).toBeNull();
  });
});

describe("placeOfSupplyLabel", () => {
  it("names a state with its code", () => {
    expect(placeOfSupplyLabel("07")).toBe("Delhi (07)");
    expect(placeOfSupplyLabel("3")).toBe("Punjab (03)");
  });

  it("names place of supply 96 as outside India", () => {
    expect(OUTSIDE_INDIA_PLACE_OF_SUPPLY).toBe("96");
    expect(placeOfSupplyLabel("96")).toBe("Outside India (96)");
  });

  it("falls back to the bare code, and to null for nothing", () => {
    expect(placeOfSupplyLabel("25")).toBe("25");
    expect(placeOfSupplyLabel(null)).toBeNull();
    expect(placeOfSupplyLabel("DL")).toBeNull();
  });
});

describe("dbBasisFor", () => {
  const recipient: PlaceOfSupplyBasis[] = [
    "gstin",
    "billing_state",
    "store_gstin",
    "store_tax_state",
    "location_gstin",
    "location_state",
    "store_address",
    "signup_address",
  ];

  it("records every basis from the merchant's own records as recipient", () => {
    for (const basis of recipient) expect(dbBasisFor(basis)).toBe("recipient");
  });

  it("keeps outside_india, maps supplier_state, and drops unknown", () => {
    expect(dbBasisFor("outside_india")).toBe("outside_india");
    expect(dbBasisFor("supplier_state")).toBe("supplier");
    expect(dbBasisFor("unknown")).toBeNull();
  });
});

describe("gstinStateCode", () => {
  it("reads a well-formed GSTIN's state, trimmed and upper-cased", () => {
    expect(gstinStateCode(DELHI_GSTIN)).toBe("07");
    expect(gstinStateCode(" 29abcde1234f1z5 ")).toBe("29");
  });

  it("refuses a malformed GSTIN and one naming no listed state", () => {
    expect(gstinStateCode("07AABCU9603R1Z")).toBeNull();
    expect(gstinStateCode("96ABCDE1234F1Z5")).toBeNull();
    expect(gstinStateCode(null)).toBeNull();
  });
});

describe("placeOfSupplyFor", () => {
  const none: PlaceOfSupplyInput = {
    accountGstin: null,
    accountStateCode: null,
    accountCountry: null,
    taxIdGstin: null,
    storeTaxStateCode: null,
    locationGstin: null,
    locationStateCode: null,
    taxAddress: null,
    signupStateName: null,
    signupCountry: null,
    supplierStateCode: "03",
    taxActive: true,
  };
  const pos = (over: Partial<PlaceOfSupplyInput>) =>
    placeOfSupplyFor({ ...none, ...over });

  describe("each step on its own", () => {
    it("1. the Billing details GSTIN", () => {
      expect(pos({ accountGstin: DELHI_GSTIN })).toEqual({
        code: "07",
        basis: "gstin",
      });
    });

    it("2. a Billing details country outside India", () => {
      expect(pos({ accountCountry: "US" })).toEqual({
        code: "96",
        basis: "outside_india",
      });
    });

    it("3. the Billing details state", () => {
      expect(pos({ accountStateCode: "29" })).toEqual({
        code: "29",
        basis: "billing_state",
      });
    });

    it("4. the Taxes & invoices GSTIN", () => {
      expect(pos({ taxIdGstin: KARNATAKA_GSTIN })).toEqual({
        code: "29",
        basis: "store_gstin",
      });
    });

    it("5. the Taxes & invoices state", () => {
      expect(pos({ storeTaxStateCode: "27" })).toEqual({
        code: "27",
        basis: "store_tax_state",
      });
    });

    it("6. the default location's GSTIN, then its state", () => {
      expect(pos({ locationGstin: DELHI_GSTIN })).toEqual({
        code: "07",
        basis: "location_gstin",
      });
      expect(pos({ locationStateCode: "33" })).toEqual({
        code: "33",
        basis: "location_state",
      });
      expect(
        pos({ locationGstin: DELHI_GSTIN, locationStateCode: "33" }),
      ).toEqual({ code: "07", basis: "location_gstin" });
    });

    it("7. the state named in the typed business address", () => {
      expect(
        pos({ taxAddress: "12 MG Road, Bengaluru, Karnataka 560001" }),
      ).toEqual({ code: "29", basis: "store_address" });
    });

    it("8. the signup state, with the signup country blank or India", () => {
      expect(pos({ signupStateName: "Maharashtra" })).toEqual({
        code: "27",
        basis: "signup_address",
      });
      expect(
        pos({ signupStateName: "Maharashtra", signupCountry: "IN" }),
      ).toEqual({ code: "27", basis: "signup_address" });
      expect(
        pos({ signupStateName: "Maharashtra", signupCountry: " in " }),
      ).toEqual({ code: "27", basis: "signup_address" });
    });

    it("9. a signup country outside India", () => {
      expect(pos({ signupCountry: "OTHER" })).toEqual({
        code: "96",
        basis: "outside_india",
      });
      expect(pos({ signupCountry: "AE", signupStateName: "Punjab" })).toEqual({
        code: "96",
        basis: "outside_india",
      });
    });

    it("10. StoreMink's own state, only while GST is charged", () => {
      expect(pos({})).toEqual({ code: "03", basis: "supplier_state" });
      expect(pos({ taxActive: false })).toEqual({
        code: null,
        basis: "unknown",
      });
      expect(pos({ supplierStateCode: null })).toEqual({
        code: null,
        basis: "unknown",
      });
    });
  });

  describe("the order", () => {
    it("the Billing details GSTIN beats the Billing details country", () => {
      expect(pos({ accountGstin: DELHI_GSTIN, accountCountry: "US" })).toEqual({
        code: "07",
        basis: "gstin",
      });
    });

    it("a Billing details country outside India beats a Taxes & invoices GSTIN", () => {
      expect(
        pos({ accountCountry: "US", taxIdGstin: KARNATAKA_GSTIN }),
      ).toEqual({ code: "96", basis: "outside_india" });
    });

    it("a Billing details country of India falls through to its state", () => {
      expect(pos({ accountCountry: "IN", accountStateCode: "29" })).toEqual({
        code: "29",
        basis: "billing_state",
      });
    });

    it("the Billing details state beats the Taxes & invoices GSTIN", () => {
      expect(pos({ accountStateCode: "29", taxIdGstin: DELHI_GSTIN })).toEqual({
        code: "29",
        basis: "billing_state",
      });
    });

    it("the Taxes & invoices GSTIN beats the location", () => {
      expect(
        pos({
          taxIdGstin: KARNATAKA_GSTIN,
          locationGstin: DELHI_GSTIN,
          locationStateCode: "33",
        }),
      ).toEqual({ code: "29", basis: "store_gstin" });
    });

    it("the location beats the typed address", () => {
      expect(
        pos({
          locationStateCode: "33",
          taxAddress: "MG Road, Bengaluru, Karnataka",
        }),
      ).toEqual({ code: "33", basis: "location_state" });
    });

    it("the typed address beats the signup state", () => {
      expect(
        pos({
          taxAddress: "MG Road, Bengaluru, Karnataka",
          signupStateName: "Punjab",
        }),
      ).toEqual({ code: "29", basis: "store_address" });
    });

    it("Taxes & invoices beats a signup country outside India", () => {
      expect(
        pos({ taxIdGstin: KARNATAKA_GSTIN, signupCountry: "OTHER" }),
      ).toEqual({ code: "29", basis: "store_gstin" });
      expect(
        pos({
          taxAddress: "MG Road, Bengaluru, Karnataka",
          signupCountry: "OTHER",
        }),
      ).toEqual({ code: "29", basis: "store_address" });
    });

    it("an unreadable signup state falls through to StoreMink's state", () => {
      expect(pos({ signupStateName: "Atlantis" })).toEqual({
        code: "03",
        basis: "supplier_state",
      });
    });
  });

  describe("invalid records are skipped as if absent", () => {
    it("an invalid GSTIN at any step", () => {
      expect(
        pos({
          accountGstin: "07AABCU9603R1Z",
          taxIdGstin: "notagstin",
          locationGstin: "96ABCDE1234F1Z5",
          locationStateCode: "33",
        }),
      ).toEqual({ code: "33", basis: "location_state" });
    });

    it("a state code that is not a listed state", () => {
      expect(pos({ accountStateCode: "96", storeTaxStateCode: "DL" })).toEqual({
        code: "03",
        basis: "supplier_state",
      });
    });

    it("a blank country", () => {
      expect(pos({ accountCountry: "  ", accountStateCode: "29" })).toEqual({
        code: "29",
        basis: "billing_state",
      });
    });
  });
});

describe("recipientStateFor", () => {
  it("gives the place of supply for a recipient basis", () => {
    expect(
      recipientStateFor({
        placeOfSupply: "07",
        placeOfSupplyBasis: "recipient",
      }),
    ).toBe("07");
  });

  it("gives the place of supply for an older invoice with no basis", () => {
    expect(
      recipientStateFor({ placeOfSupply: "29", placeOfSupplyBasis: null }),
    ).toBe("29");
  });

  it("names no State for a supplier fallback or outside India", () => {
    expect(
      recipientStateFor({
        placeOfSupply: "03",
        placeOfSupplyBasis: "supplier",
      }),
    ).toBeNull();
    expect(
      recipientStateFor({
        placeOfSupply: "96",
        placeOfSupplyBasis: "outside_india",
      }),
    ).toBeNull();
  });

  it("names no State when there is none", () => {
    expect(
      recipientStateFor({ placeOfSupply: null, placeOfSupplyBasis: null }),
    ).toBeNull();
    expect(
      recipientStateFor({ placeOfSupply: "96", placeOfSupplyBasis: null }),
    ).toBeNull();
  });
});

describe("platformInvoiceGst", () => {
  const doc = (over: Partial<Parameters<typeof platformInvoiceGst>[0]>) =>
    platformInvoiceGst({
      taxPaise: 27000,
      taxRateBps: 1800,
      supplierGstin: PUNJAB_GSTIN,
      placeOfSupply: "03",
      ...over,
    });

  it("splits a Punjab supply from a Punjab supplier into CGST and SGST", () => {
    expect(doc({})).toEqual({
      cgstPaise: 13500,
      sgstPaise: 13500,
      igstPaise: 0,
      intraState: true,
      ratePct: 18,
    });
  });

  it("gives SGST the odd paise (22881 to 11440 + 11441)", () => {
    expect(doc({ taxPaise: 22881 })).toMatchObject({
      cgstPaise: 11440,
      sgstPaise: 11441,
      igstPaise: 0,
      intraState: true,
    });
  });

  it("charges IGST for a supply to Delhi", () => {
    expect(doc({ placeOfSupply: "07" })).toEqual({
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 27000,
      intraState: false,
      ratePct: 18,
    });
  });

  it("charges IGST for place of supply 96", () => {
    expect(doc({ placeOfSupply: "96" })).toMatchObject({
      igstPaise: 27000,
      intraState: false,
    });
  });

  it("never treats a missing place of supply as intra-state", () => {
    expect(doc({ placeOfSupply: null })).toMatchObject({
      igstPaise: 27000,
      cgstPaise: 0,
      intraState: false,
    });
    expect(doc({ supplierGstin: null })).toMatchObject({
      igstPaise: 27000,
      intraState: false,
    });
  });

  it("gives the same split as the invoice sheet's rule for every recipient case", () => {
    // The rule the sheet and creditNoteTaxLines used before this function:
    // intra-state exactly when both are present and the GSTIN's first two
    // digits equal the place of supply.
    const sheetIntra = (supplier: string | null, place: string | null) =>
      !!place && !!supplier && supplier.slice(0, 2) === place;
    for (const supplier of [PUNJAB_GSTIN, DELHI_GSTIN, null]) {
      for (const place of ["03", "07", "29", null]) {
        expect(
          doc({ supplierGstin: supplier, placeOfSupply: place }).intraState,
        ).toBe(sheetIntra(supplier, place));
      }
    }
  });

  it("reports the rate as a percentage, 0 when none is recorded", () => {
    expect(doc({ taxRateBps: 1200 }).ratePct).toBe(12);
    expect(doc({ taxRateBps: null }).ratePct).toBe(0);
  });

  it("isIntraState keeps its walk-in default for a merchant's own orders", () => {
    // Unchanged on purpose: POS sales rely on it (pos-sale-actions.ts).
    expect(isIntraState(null, "07")).toBe(true);
    expect(isIntraState("03", null)).toBe(true);
    expect(isIntraState("03", "07")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The state picker's list (R2-11): one list for signup, Billing details and
// the state prompt.
// ---------------------------------------------------------------------------

describe("PICKABLE_GST_STATES", () => {
  it("offers every GST state but Other Territory (97)", () => {
    expect(PICKABLE_GST_STATES.map((s) => s.code)).not.toContain("97");
    expect(PICKABLE_GST_STATES).toHaveLength(GST_STATES.length - 1);
  });

  it("runs in name order, not code order", () => {
    const names = PICKABLE_GST_STATES.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    expect(names[0]).toBe("Andaman & Nicobar Islands");
  });

  it("does not reorder GST_STATES itself", () => {
    expect(GST_STATES[0].code).toBe("01");
  });
});

describe("gstStateOptions", () => {
  it("is the pickable list for nothing chosen or a listed state", () => {
    expect(gstStateOptions("")).toBe(PICKABLE_GST_STATES);
    expect(gstStateOptions(null)).toBe(PICKABLE_GST_STATES);
    expect(gstStateOptions("29")).toBe(PICKABLE_GST_STATES);
  });

  it("keeps a state the list leaves out visible when it is the value", () => {
    const withOther = gstStateOptions("97");
    expect(withOther.at(-1)).toEqual({ code: "97", name: "Other Territory" });
    expect(withOther).toHaveLength(PICKABLE_GST_STATES.length + 1);
    // A retired code a merchant may still have stored shows as its code.
    expect(gstStateOptions("25").at(-1)).toEqual({ code: "25", name: "25" });
  });
});
