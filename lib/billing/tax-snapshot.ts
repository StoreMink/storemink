/**
 * One tax reading per invoice (GST design 5.2): the terms in force at an
 * instant, the builder's tax context and the particulars stamped on the
 * invoice, all from ONE row read at once.
 *
 * PURE: no database, no clock. The loader that reads `SnapshotRow` (one
 * statement, so the settings and the merchant's records are seen together)
 * lives in `lib/billing/invoice-store.ts`.
 */

import {
  dbBasisFor,
  isValidGstinFormat,
  normalizeStateCode,
  placeOfSupplyFor,
  type DbPlaceOfSupplyBasis,
  type PlaceOfSupply,
  type PlaceOfSupplyInput,
} from "./gst";
import type { TaxContext } from "./invoice";
import {
  taxContextFor,
  termsAt,
  type TaxTerms,
  type TaxTermsSource,
} from "./tax-terms";

/** The tax particulars written on an invoice when it is built or issued. */
export interface InvoiceTaxStamp {
  /** StoreMink's GSTIN; only while GST is charged. */
  supplierGstin: string | null;
  /** The merchant's GSTIN from Billing details, when its format is valid. */
  customerGstin: string | null;
  /** Never null while GST is charged. */
  placeOfSupply: string | null;
  /** `dbBasisFor(basis)` whenever `placeOfSupply` is set. */
  placeOfSupplyBasis: DbPlaceOfSupplyBasis | null;
  /** StoreMink's SAC code; only while GST is charged. */
  sacCode: string | null;
}

/**
 * Everything one reading needs: the settings row's tax columns and
 * StoreMink's identity, plus every record of the merchant that may name their
 * state (`PlaceOfSupplyInput` without the two fields derived here).
 */
export interface SnapshotRow
  extends
    TaxTermsSource,
    Omit<PlaceOfSupplyInput, "supplierStateCode" | "taxActive"> {
  /** platform_billing_settings.gstin */
  supplierGstin: string | null;
  /** platform_billing_settings.state_code */
  supplierStateCode: string | null;
  /** platform_billing_settings.sac_code */
  sacCode: string | null;
}

export type TaxSnapshot =
  | {
      ok: true;
      terms: TaxTerms;
      tax: TaxContext;
      stamp: InvoiceTaxStamp;
      placeOfSupply: PlaceOfSupply;
    }
  | { ok: false; reason: "settings_incomplete" };

/** A SAC code the invoice CHECK accepts: six digits starting with 99. */
const SAC_CODE = /^99[0-9]{4}$/;

function sacCodeOf(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const sac = value.trim();
  return SAC_CODE.test(sac) ? sac : null;
}

function gstinOf(value: string | null): string | null {
  return isValidGstinFormat(value) ? value.trim().toUpperCase() : null;
}

/**
 * The GST an invoice built at `at` carries, and what is stamped on it.
 *
 * ★ INCOMPLETE SETTINGS ARE REFUSED, NEVER TREATED AS GST OFF. When the terms
 * at `at` charge GST but StoreMink's GSTIN, state or SAC code is missing (only
 * possible where the migration left an identity CHECK unvalidated), the
 * answer is `settings_incomplete`: an on-session payment is paused and a
 * renewal retries next hour. Quietly building it untaxed would undercharge
 * every merchant while the operator believes GST is on.
 *
 * Otherwise: StoreMink's GSTIN and SAC code are stamped only while GST is
 * charged (an untaxed invoice naming a GSTIN reads as a tax invoice that
 * forgot its tax); the merchant's GSTIN is the one under Billing details, when
 * valid (a GSTIN typed elsewhere decides the place of supply but is printed
 * only once saved for StoreMink's invoices); the place of supply is
 * `placeOfSupplyFor`'s, with its basis as the invoice row records it.
 */
export function resolveTaxSnapshot(row: SnapshotRow, at: Date): TaxSnapshot {
  const terms = termsAt(row, at);
  const supplierGstin = gstinOf(row.supplierGstin);
  const supplierState = normalizeStateCode(row.supplierStateCode);
  const sacCode = sacCodeOf(row.sacCode);

  if (terms.active && (!supplierGstin || !supplierState || !sacCode)) {
    return { ok: false, reason: "settings_incomplete" };
  }

  const placeOfSupply = placeOfSupplyFor({
    accountGstin: row.accountGstin,
    accountStateCode: row.accountStateCode,
    accountCountry: row.accountCountry,
    taxIdGstin: row.taxIdGstin,
    storeTaxStateCode: row.storeTaxStateCode,
    locationGstin: row.locationGstin,
    locationStateCode: row.locationStateCode,
    taxAddress: row.taxAddress,
    signupStateName: row.signupStateName,
    signupCountry: row.signupCountry,
    supplierStateCode: supplierState,
    taxActive: terms.active,
  });

  return {
    ok: true,
    terms,
    tax: taxContextFor(terms, supplierState, placeOfSupply.code),
    stamp: {
      supplierGstin: terms.active ? supplierGstin : null,
      customerGstin: gstinOf(row.accountGstin),
      placeOfSupply: placeOfSupply.code,
      placeOfSupplyBasis: placeOfSupply.code
        ? dbBasisFor(placeOfSupply.basis)
        : null,
      sacCode: terms.active ? sacCode : null,
    },
    placeOfSupply,
  };
}
