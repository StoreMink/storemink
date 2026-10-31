import { describe, expect, it } from "vitest";
import { resolveTaxSnapshot, type SnapshotRow } from "./tax-snapshot";

const PUNJAB_GSTIN = "03ABCDE1234F1Z5";
const DELHI_GSTIN = "07AABCU9603R1ZM";
const AT = new Date("2026-12-15T06:00:00.000Z");

/** GST off, StoreMink's identity complete, a merchant with no records. */
const BASE: SnapshotRow = {
  taxEnabled: false,
  taxInclusive: false,
  taxRateBps: 1800,
  nextTaxEnabled: null,
  nextTaxInclusive: null,
  nextTaxRateBps: null,
  nextTaxStartsAt: null,
  supplierGstin: PUNJAB_GSTIN,
  supplierStateCode: "03",
  sacCode: "998314",
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
};

const ON: SnapshotRow = { ...BASE, taxEnabled: true };

describe("resolveTaxSnapshot", () => {
  describe("settings_incomplete only when the terms are active", () => {
    it.each([
      ["GSTIN", { supplierGstin: null }],
      ["state", { supplierStateCode: null }],
      ["SAC code", { sacCode: null }],
    ])("refuses while GST is on and StoreMink's %s is missing", (_, gap) => {
      expect(resolveTaxSnapshot({ ...ON, ...gap }, AT)).toEqual({
        ok: false,
        reason: "settings_incomplete",
      });
    });

    it("treats a malformed GSTIN or SAC code as missing", () => {
      expect(
        resolveTaxSnapshot({ ...ON, supplierGstin: "03-NOT-A-GSTIN" }, AT),
      ).toEqual({ ok: false, reason: "settings_incomplete" });
      expect(resolveTaxSnapshot({ ...ON, sacCode: "12345" }, AT)).toEqual({
        ok: false,
        reason: "settings_incomplete",
      });
    });

    it("never refuses while GST is off, whatever is missing", () => {
      const snap = resolveTaxSnapshot(
        {
          ...BASE,
          supplierGstin: null,
          supplierStateCode: null,
          sacCode: null,
        },
        AT,
      );
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      expect(snap.tax.enabled).toBe(false);
    });

    it("refuses only once a scheduled start has arrived", () => {
      const scheduled: SnapshotRow = {
        ...BASE,
        sacCode: null,
        nextTaxEnabled: true,
        nextTaxInclusive: false,
        nextTaxRateBps: 1800,
        nextTaxStartsAt: AT.toISOString(),
      };
      expect(resolveTaxSnapshot(scheduled, new Date(AT.getTime() - 1)).ok).toBe(
        true,
      );
      expect(resolveTaxSnapshot(scheduled, AT)).toEqual({
        ok: false,
        reason: "settings_incomplete",
      });
    });
  });

  it("stamps StoreMink's GSTIN and SAC code only while GST is charged", () => {
    const off = resolveTaxSnapshot({ ...BASE, accountStateCode: "07" }, AT);
    const on = resolveTaxSnapshot({ ...ON, accountStateCode: "07" }, AT);
    expect(off.ok && on.ok).toBe(true);
    if (!off.ok || !on.ok) return;
    expect(off.stamp.supplierGstin).toBeNull();
    expect(off.stamp.sacCode).toBeNull();
    expect(on.stamp.supplierGstin).toBe(PUNJAB_GSTIN);
    expect(on.stamp.sacCode).toBe("998314");
  });

  it("stamps a valid merchant GSTIN, upper-cased, and ignores an invalid one", () => {
    const valid = resolveTaxSnapshot(
      { ...ON, accountGstin: ` ${DELHI_GSTIN.toLowerCase()} ` },
      AT,
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.stamp.customerGstin).toBe(DELHI_GSTIN);
    expect(valid.stamp.placeOfSupply).toBe("07");

    const invalid = resolveTaxSnapshot(
      { ...ON, accountGstin: "07ABC", accountStateCode: "29" },
      AT,
    );
    expect(invalid.ok).toBe(true);
    if (!invalid.ok) return;
    expect(invalid.stamp.customerGstin).toBeNull();
    // The invalid GSTIN is skipped as if absent; the billing state decides.
    expect(invalid.placeOfSupply).toEqual({
      code: "29",
      basis: "billing_state",
    });
  });

  it("records the chain's basis as the invoice row does", () => {
    const fromGstin = resolveTaxSnapshot(
      { ...ON, accountGstin: DELHI_GSTIN },
      AT,
    );
    const fromAddress = resolveTaxSnapshot(
      { ...ON, taxAddress: "12 MG Road, Bengaluru, Karnataka 560001" },
      AT,
    );
    expect(fromGstin.ok && fromAddress.ok).toBe(true);
    if (!fromGstin.ok || !fromAddress.ok) return;
    expect(fromGstin.placeOfSupply.basis).toBe("gstin");
    expect(fromGstin.stamp.placeOfSupplyBasis).toBe("recipient");
    expect(fromAddress.placeOfSupply).toEqual({
      code: "29",
      basis: "store_address",
    });
    expect(fromAddress.stamp.placeOfSupplyBasis).toBe("recipient");
  });

  it("a merchant outside India: 96 with outside_india, IGST", () => {
    const snap = resolveTaxSnapshot({ ...ON, accountCountry: "SG" }, AT);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.stamp.placeOfSupply).toBe("96");
    expect(snap.stamp.placeOfSupplyBasis).toBe("outside_india");
    expect(snap.tax.placeOfSupply).toBe("96");
  });

  it("falls back to StoreMink's state with basis supplier only while GST is charged", () => {
    const on = resolveTaxSnapshot(ON, AT);
    const off = resolveTaxSnapshot(BASE, AT);
    expect(on.ok && off.ok).toBe(true);
    if (!on.ok || !off.ok) return;
    expect(on.placeOfSupply).toEqual({ code: "03", basis: "supplier_state" });
    expect(on.stamp.placeOfSupply).toBe("03");
    expect(on.stamp.placeOfSupplyBasis).toBe("supplier");
    expect(off.placeOfSupply).toEqual({ code: null, basis: "unknown" });
    expect(off.stamp.placeOfSupply).toBeNull();
    expect(off.stamp.placeOfSupplyBasis).toBeNull();
  });

  it("builds the tax context from the same reading", () => {
    const snap = resolveTaxSnapshot(
      { ...ON, taxInclusive: true, accountStateCode: "07" },
      AT,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.tax).toEqual({
      enabled: true,
      rateBps: 1800,
      inclusive: true,
      supplierStateCode: "03",
      placeOfSupply: "07",
    });
    expect(snap.terms).toEqual({
      active: true,
      inclusive: true,
      rateBps: 1800,
      upcoming: null,
    });
  });

  it("while off: rate 0, no supplier identity, the merchant's own state still recorded", () => {
    const snap = resolveTaxSnapshot(
      { ...BASE, signupStateName: "Maharashtra", signupCountry: "IN" },
      AT,
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.tax).toMatchObject({ enabled: false, rateBps: 0 });
    expect(snap.stamp).toEqual({
      supplierGstin: null,
      customerGstin: null,
      placeOfSupply: "27",
      placeOfSupplyBasis: "recipient",
      sacCode: null,
    });
  });
});
