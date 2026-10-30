/* eslint-disable @typescript-eslint/no-explicit-any */
// Billing details (GST design 5.7).
//
// ── The risks this covers ──────────────────────────────────────────────────
//   • A saved form shows what was saved, never a prefill over it.
//   • An unsaved form is prefilled from the store's other records, in the
//     order `placeOfSupplyFor` reads them, and says where from.
//   • A GSTIN decides the state: a different state beside it is a typo.
//   • The save never touches `billing_email`: a tax form must not be a way
//     to change where the merchant's invoices are emailed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BILLING_DETAILS } from "./tax-copy";

const S = vi.hoisted(() => ({
  /** The one row the form's read returns. */
  detailsRow: {} as Record<string, unknown>,
  detailsFail: false,
  /** The billing account the save reads first. */
  accountRows: [] as any[],
  accountFail: false,
}));

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => {
    const select = () => {
      const s: any = {
        from: () => s,
        where: () => s,
        limit: () => s,
        then: (resolve: any, reject: any) =>
          S.accountFail
            ? Promise.reject(new Error("read failed")).then(resolve, reject)
            : Promise.resolve(S.accountRows).then(resolve, reject),
      };
      return s;
    };
    return fn({
      select,
      execute: async () => {
        if (S.detailsFail) throw new Error("read failed");
        return { rows: [S.detailsRow] };
      },
    });
  }),
}));

const enrol = vi.hoisted(() => ({
  ensureBillingAccount: vi.fn<(...args: any[]) => Promise<boolean>>(
    async () => true,
  ),
}));
vi.mock("./enrol", () => enrol);

import { getBillingDetails, saveBillingDetails } from "./billing-details";

const STORE = "store-1";
const KA_GSTIN = "29ABCDE1234F1Z5";
const DL_GSTIN = "07ABCDE1234F1Z5";

/** Nothing anywhere, StoreMink in Punjab (03). */
function row(over: Record<string, unknown> = {}) {
  return {
    account_exists: false,
    account_legal_name: null,
    account_gstin: null,
    account_state_code: null,
    account_address: null,
    tax_legal_name: null,
    tax_business_name: null,
    tax_id: null,
    business_state_code: null,
    business_address: null,
    location_gstin: null,
    location_state_code: null,
    signup_business: null,
    supplier_state_code: "03",
    ...over,
  };
}

beforeEach(() => {
  S.detailsRow = row();
  S.detailsFail = false;
  S.accountRows = [];
  S.accountFail = false;
});

// ── Reading ────────────────────────────────────────────────────────────────

describe("getBillingDetails", () => {
  it("is null when the records cannot be read", async () => {
    S.detailsFail = true;
    expect(await getBillingDetails(STORE)).toBeNull();
  });

  it("★ a saved account shows what was saved, never a prefill over it", async () => {
    S.detailsRow = row({
      account_exists: true,
      account_legal_name: "Acme Foods Pvt Ltd",
      account_gstin: KA_GSTIN,
      account_state_code: "29",
      account_address: {
        line1: "12 MG Road",
        city: "Bengaluru",
        postalCode: "560001",
        country: "IN",
      },
      tax_legal_name: "Something Else",
      tax_id: DL_GSTIN,
    });
    expect(await getBillingDetails(STORE)).toEqual({
      saved: true,
      legalName: "Acme Foods Pvt Ltd",
      gstin: KA_GSTIN,
      stateCode: "29",
      country: "IN",
      countryName: "",
      addressLine1: "12 MG Road",
      addressLine2: "",
      city: "Bengaluru",
      postalCode: "560001",
      prefilledFrom: null,
      placeOfSupply: { code: "29", name: "Karnataka", basis: "gstin" },
    });
  });

  it("a saved country outside India is saved, with no state", async () => {
    S.detailsRow = row({
      account_exists: true,
      account_address: { country: "OTHER", countryName: "Bhutan" },
    });
    const view = await getBillingDetails(STORE);
    expect(view).toMatchObject({
      saved: true,
      country: "OTHER",
      countryName: "Bhutan",
      stateCode: "",
      placeOfSupply: { code: "96", name: null, basis: "outside_india" },
    });
  });

  it("★ prefills from Taxes & invoices, the GSTIN deciding the state", async () => {
    S.detailsRow = row({
      tax_legal_name: "Acme Foods Pvt Ltd",
      tax_business_name: "Acme",
      tax_id: KA_GSTIN,
      business_state_code: "07",
      business_address: "12 MG Road\nIndiranagar\nBengaluru, Karnataka 560038",
    });
    expect(await getBillingDetails(STORE)).toEqual({
      saved: false,
      legalName: "Acme Foods Pvt Ltd",
      gstin: KA_GSTIN,
      stateCode: "29",
      country: "IN",
      countryName: "",
      addressLine1: "12 MG Road",
      addressLine2: "Indiranagar, Bengaluru, Karnataka 560038",
      city: "",
      postalCode: "560038",
      prefilledFrom: "taxes_and_invoices",
      placeOfSupply: { code: "29", name: "Karnataka", basis: "store_gstin" },
    });
  });

  it("the business name stands in for a missing legal name", async () => {
    S.detailsRow = row({ tax_business_name: "Acme" });
    expect((await getBillingDetails(STORE))?.legalName).toBe("Acme");
  });

  it("a state from the Taxes & invoices address when no code is saved", async () => {
    S.detailsRow = row({ business_address: "Karol Bagh, Delhi 110005" });
    const view = await getBillingDetails(STORE);
    expect(view?.stateCode).toBe("07");
    expect(view?.prefilledFrom).toBe("taxes_and_invoices");
  });

  it("prefills from the main location", async () => {
    S.detailsRow = row({ location_gstin: DL_GSTIN, location_state_code: "29" });
    const view = await getBillingDetails(STORE);
    expect(view).toMatchObject({
      gstin: DL_GSTIN,
      stateCode: "07",
      prefilledFrom: "location",
    });
  });

  it("prefills from the signup answers", async () => {
    S.detailsRow = row({
      signup_business: {
        country: "IN",
        state: "Karnataka",
        addressLine1: "5 Church Street",
        addressLine2: "Floor 2",
        city: "Bengaluru",
        postalCode: "560001",
      },
    });
    expect(await getBillingDetails(STORE)).toMatchObject({
      saved: false,
      stateCode: "29",
      addressLine1: "5 Church Street",
      addressLine2: "Floor 2",
      city: "Bengaluru",
      postalCode: "560001",
      prefilledFrom: "signup",
      placeOfSupply: { code: "29", basis: "signup_address" },
    });
  });

  it("a signup country outside India is prefilled, and no state guessed", async () => {
    S.detailsRow = row({
      signup_business: { country: "SG", state: "Karnataka" },
    });
    expect(await getBillingDetails(STORE)).toMatchObject({
      country: "SG",
      stateCode: "",
      prefilledFrom: "signup",
    });
  });

  it("nothing anywhere: an empty form, StoreMink's state shown as the fallback", async () => {
    expect(await getBillingDetails(STORE)).toMatchObject({
      saved: false,
      legalName: "",
      gstin: "",
      stateCode: "",
      country: "IN",
      prefilledFrom: null,
      placeOfSupply: { code: "03", name: "Punjab", basis: "supplier_state" },
    });
  });

  it("an invalid GSTIN anywhere is skipped as if absent", async () => {
    S.detailsRow = row({ tax_id: "NOT-A-GSTIN", location_state_code: "27" });
    expect(await getBillingDetails(STORE)).toMatchObject({
      gstin: "",
      stateCode: "27",
      prefilledFrom: "location",
    });
  });
});

// ── Saving ─────────────────────────────────────────────────────────────────

function lastSave(): Record<string, unknown> {
  const calls = enrol.ensureBillingAccount.mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe("saveBillingDetails", () => {
  it("★ a GSTIN decides the state; a different typed state is ignored", async () => {
    const res = await saveBillingDetails(STORE, {
      gstin: " 29abcde1234f1z5 ",
      stateCode: "07",
      legalName: "Acme Foods",
      addressLine1: "12 MG Road",
      postalCode: "560001",
    });
    expect(res).toEqual({ ok: true });
    expect(enrol.ensureBillingAccount).toHaveBeenCalledWith(STORE, {
      legalName: "Acme Foods",
      gstin: KA_GSTIN,
      stateCode: "29",
      address: { line1: "12 MG Road", postalCode: "560001", country: "IN" },
    });
  });

  it("★★ never writes the billing email", async () => {
    await saveBillingDetails(STORE, {
      stateCode: "29",
      ...({ billingEmail: "attacker@example.com" } as any),
    });
    await saveBillingDetails(STORE, { country: "US" });
    for (const call of enrol.ensureBillingAccount.mock.calls) {
      expect(call[1]).not.toHaveProperty("billingEmail");
    }
  });

  it("refuses an invalid GSTIN, and one naming no known state", async () => {
    expect(await saveBillingDetails(STORE, { gstin: "29ABC" })).toEqual({
      ok: false,
      error: BILLING_DETAILS.errors.gstin,
      field: "gstin",
    });
    expect(
      await saveBillingDetails(STORE, { gstin: "99ABCDE1234F1Z5" }),
    ).toEqual({
      ok: false,
      error: BILLING_DETAILS.errors.gstin,
      field: "gstin",
    });
    expect(enrol.ensureBillingAccount).not.toHaveBeenCalled();
  });

  it("in India, a state is required without a GSTIN", async () => {
    expect(await saveBillingDetails(STORE, {})).toEqual({
      ok: false,
      error: BILLING_DETAILS.errors.state,
      field: "stateCode",
    });
    expect(await saveBillingDetails(STORE, { stateCode: "99" })).toEqual({
      ok: false,
      error: BILLING_DETAILS.errors.state,
      field: "stateCode",
    });
  });

  it("takes a state by code or by name, with no GSTIN kept", async () => {
    await saveBillingDetails(STORE, { stateCode: "7" });
    expect(lastSave()).toMatchObject({ gstin: null, stateCode: "07" });
    await saveBillingDetails(STORE, { stateCode: "Karnataka" });
    expect(lastSave()).toMatchObject({ gstin: null, stateCode: "29" });
  });

  it("an Indian PIN code has six digits", async () => {
    expect(
      await saveBillingDetails(STORE, { stateCode: "29", postalCode: "5600" }),
    ).toEqual({
      ok: false,
      error: BILLING_DETAILS.errors.pin,
      field: "postalCode",
    });
  });

  it("★ outside India nothing tax-related is kept", async () => {
    S.accountRows = [
      { address: { country: "IN", line1: "12 MG Road", postalCode: "560001" } },
    ];
    const res = await saveBillingDetails(STORE, {
      country: "us",
      gstin: KA_GSTIN,
      stateCode: "29",
      postalCode: "94105-1234",
    });
    expect(res).toEqual({ ok: true });
    expect(lastSave()).toEqual({
      gstin: null,
      stateCode: null,
      address: {
        country: "US",
        countryName: "United States",
        line1: "12 MG Road",
        postalCode: "94105-1234",
      },
    });
  });

  it("another country needs its name", async () => {
    expect(await saveBillingDetails(STORE, { country: "OTHER" })).toEqual({
      ok: false,
      error: BILLING_DETAILS.errors.countryName,
      field: "countryName",
    });
    await saveBillingDetails(STORE, {
      country: "OTHER",
      countryName: "Bhutan",
    });
    expect(lastSave().address).toMatchObject({
      country: "OTHER",
      countryName: "Bhutan",
    });
  });

  it("refuses a country we do not offer", async () => {
    expect(await saveBillingDetails(STORE, { country: "XX" })).toEqual({
      ok: false,
      error: BILLING_DETAILS.errors.failed,
      field: "country",
    });
  });

  it("★ fields left out keep their saved values; a blank one removes it", async () => {
    S.accountRows = [
      {
        address: {
          country: "IN",
          line1: "12 MG Road",
          city: "Bengaluru",
          landmark: "kept as it was",
        },
      },
    ];
    await saveBillingDetails(STORE, { stateCode: "29", city: "  " });
    const saved = lastSave();
    expect(saved).not.toHaveProperty("legalName");
    expect(saved.address).toEqual({
      country: "IN",
      line1: "12 MG Road",
      landmark: "kept as it was",
    });

    await saveBillingDetails(STORE, { stateCode: "29", legalName: "" });
    expect(lastSave()).toMatchObject({ legalName: null });
  });

  it("clips long text to what an invoice holds", async () => {
    await saveBillingDetails(STORE, {
      stateCode: "29",
      legalName: "A".repeat(500),
      addressLine1: "B".repeat(500),
      city: "C".repeat(500),
    });
    const saved = lastSave();
    expect((saved.legalName as string).length).toBe(200);
    expect(((saved.address as any).line1 as string).length).toBe(200);
    expect(((saved.address as any).city as string).length).toBe(80);
  });

  it("a failed read or write is reported, never a success", async () => {
    S.accountFail = true;
    expect(await saveBillingDetails(STORE, { stateCode: "29" })).toEqual({
      ok: false,
      error: BILLING_DETAILS.errors.failed,
    });
    expect(enrol.ensureBillingAccount).not.toHaveBeenCalled();

    S.accountFail = false;
    enrol.ensureBillingAccount.mockResolvedValueOnce(false);
    expect(await saveBillingDetails(STORE, { stateCode: "29" })).toEqual({
      ok: false,
      error: BILLING_DETAILS.errors.failed,
    });
  });
});
