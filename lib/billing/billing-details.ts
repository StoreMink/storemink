import "server-only";

/**
 * Billing details: who StoreMink's invoices to a store are addressed to, and
 * the state that decides their tax head (GST design 5.7).
 *
 * ★ THE BILLING ACCOUNT IS THE ONLY THING WRITTEN. Taxes & invoices, the
 * default location and the signup answers are read to PREFILL an empty form,
 * never copied anywhere: the merchant checks the figures and saves them, and
 * from then on the account is the record (`placeOfSupplyFor`'s first three
 * rules).
 *
 * ★ `billing_email` IS NEVER WRITTEN HERE. It is the address billing mail goes
 * to, chosen elsewhere; a form about tax details that could change where the
 * merchant's invoices are emailed would be a way to redirect them unnoticed.
 */

import { eq, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { billingAccounts } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { DEFAULT_COUNTRY, countryName, isCountryCode } from "@/lib/countries";
import { ensureBillingAccount } from "./enrol";
import {
  gstStateName,
  gstinStateCode,
  isValidGstinFormat,
  placeOfSupplyFor,
  stateCodeFromAddress,
  stateCodeFromName,
} from "./gst";
import { BILLING_DETAILS, type BillingDetailsPrefill } from "./tax-copy";
import type {
  BillingDetailsInput,
  BillingDetailsView,
  SaveBillingDetailsResult,
} from "./quote-types";

/** The longest text kept per field: a typo, never a paragraph, goes on an invoice. */
const MAX_NAME = 200;
const MAX_LINE = 200;
const MAX_CITY = 80;
const MAX_POSTAL = 20;
const MIN_COUNTRY_NAME = 2;
const MAX_COUNTRY_NAME = 60;

/** An Indian PIN code: six digits, never starting with 0. */
const PIN_PATTERN = /^[1-9][0-9]{5}$/;

function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

function objectOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON: no address
    }
  }
  return {};
}

function upperOf(value: unknown): string | null {
  const t = textOf(value);
  return t ? t.toUpperCase() : null;
}

/** A known state code, from a code ("7", "07") or a name, else null. */
function knownState(value: unknown): string | null {
  return stateCodeFromName(value);
}

/** The PIN code a typed address names, when it names exactly one. */
function pinIn(text: string | null): string | null {
  if (!text) return null;
  const found = text.match(/(?<!\d)[1-9]\d{5}(?!\d)/g);
  return found && found.length === 1 ? found[0] : null;
}

/** Taxes & invoices keeps the address as one text value, a line per row. */
function splitTypedAddress(text: string | null): {
  line1: string | null;
  line2: string | null;
} {
  if (!text) return { line1: null, line2: null };
  const parts = text
    .split(/\s*[\r\n]+\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { line1: null, line2: null };
  return {
    line1: parts[0],
    line2: parts.length > 1 ? parts.slice(1).join(", ") : null,
  };
}

interface DetailsRow {
  accountExists: boolean;
  accountLegalName: string | null;
  accountGstin: string | null;
  accountStateCode: string | null;
  accountAddress: Record<string, unknown>;
  taxLegalName: string | null;
  taxBusinessName: string | null;
  taxIdGstin: string | null;
  storeTaxStateCode: string | null;
  taxAddress: string | null;
  locationGstin: string | null;
  locationStateCode: string | null;
  signup: Record<string, unknown>;
  supplierStateCode: string | null;
}

/** Every record the form reads, in ONE statement, so they agree with each other. */
async function readDetailsRow(storeId: string): Promise<DetailsRow> {
  return withService(async (db) => {
    const res = await db.execute(sql`
      select a.store_id is not null as account_exists,
             a.legal_name as account_legal_name,
             a.gstin as account_gstin,
             a.state_code as account_state_code,
             a.address as account_address,
             b.legal_name as tax_legal_name,
             b.business_name as tax_business_name,
             b.tax_id,
             b.business_state_code,
             b.business_address,
             l.gstin as location_gstin,
             l.state_code as location_state_code,
             s.settings -> 'business' as signup_business,
             p.state_code as supplier_state_code
        from (select 1) one
        left join public.platform_billing_settings p on p.id
        left join public.billing_accounts a on a.store_id = ${storeId}
        left join public.store_billing_settings b on b.store_id = ${storeId}
        left join public.stores s on s.id = ${storeId}
        left join lateral (
          select gstin, state_code
            from public.store_locations
           where store_id = ${storeId} and is_default
           limit 1) l on true`);
    const r = (res.rows?.[0] ?? {}) as Record<string, unknown>;
    return {
      accountExists: r.account_exists === true,
      accountLegalName: textOf(r.account_legal_name),
      accountGstin: upperOf(r.account_gstin),
      accountStateCode: textOf(r.account_state_code),
      accountAddress: objectOf(r.account_address),
      taxLegalName: textOf(r.tax_legal_name),
      taxBusinessName: textOf(r.tax_business_name),
      taxIdGstin: upperOf(r.tax_id),
      storeTaxStateCode: textOf(r.business_state_code),
      taxAddress: textOf(r.business_address),
      locationGstin: upperOf(r.location_gstin),
      locationStateCode: textOf(r.location_state_code),
      signup: objectOf(r.signup_business),
      supplierStateCode: textOf(r.supplier_state_code),
    };
  });
}

/** Saved: the account names a state, a GSTIN or a country outside India. */
function isSaved(row: DetailsRow): boolean {
  const country = upperOf(row.accountAddress.country);
  return Boolean(
    row.accountStateCode ||
    row.accountGstin ||
    (country && country !== DEFAULT_COUNTRY),
  );
}

/**
 * The store's Billing details for the form, prefilled from its other records
 * while nothing is saved. Null when they cannot be read: the screen says so
 * rather than show an empty form that looks like nothing was ever saved.
 */
export async function getBillingDetails(
  storeId: string,
): Promise<BillingDetailsView | null> {
  let row: DetailsRow;
  try {
    row = await readDetailsRow(storeId);
  } catch (err) {
    logError("billing.details_read", err, { storeId });
    return null;
  }

  const address = row.accountAddress;
  const accountCountry = upperOf(address.country);
  const signupCountry = upperOf(row.signup.country);
  const signupState = textOf(row.signup.state);

  const place = placeOfSupplyFor({
    accountGstin: row.accountGstin,
    accountStateCode: row.accountStateCode,
    accountCountry,
    taxIdGstin: row.taxIdGstin,
    storeTaxStateCode: row.storeTaxStateCode,
    locationGstin: row.locationGstin,
    locationStateCode: row.locationStateCode,
    taxAddress: row.taxAddress,
    signupStateName: signupState,
    signupCountry,
    supplierStateCode: row.supplierStateCode,
    taxActive: true,
  });
  const placeOfSupply = {
    code: place.code,
    name: place.basis === "outside_india" ? null : gstStateName(place.code),
    basis: place.basis,
  };

  if (isSaved(row)) {
    const country =
      accountCountry && isCountryCode(accountCountry)
        ? accountCountry
        : DEFAULT_COUNTRY;
    return {
      saved: true,
      legalName: row.accountLegalName ?? "",
      gstin: row.accountGstin ?? "",
      stateCode: row.accountStateCode ?? "",
      country,
      countryName:
        country === DEFAULT_COUNTRY ? "" : (textOf(address.countryName) ?? ""),
      addressLine1: textOf(address.line1) ?? "",
      addressLine2: textOf(address.line2) ?? "",
      city: textOf(address.city) ?? "",
      postalCode: textOf(address.postalCode) ?? "",
      prefilledFrom: null,
      placeOfSupply,
    };
  }

  // ── Not saved yet: fill each field from the first record that has it. ──
  const used = new Set<BillingDetailsPrefill>();
  const take = <T>(value: T | null, source: BillingDetailsPrefill | null) => {
    if (value !== null && source) used.add(source);
    return value;
  };

  const legalName =
    row.accountLegalName ??
    take(row.taxLegalName ?? row.taxBusinessName, "taxes_and_invoices") ??
    "";

  let gstin: string | null = null;
  let stateCode: string | null = null;
  if (gstinStateCode(row.taxIdGstin)) {
    gstin = take(row.taxIdGstin, "taxes_and_invoices");
  } else if (gstinStateCode(row.locationGstin)) {
    gstin = take(row.locationGstin, "location");
  }
  if (gstin) {
    // ★ The GSTIN carries the state: a different state beside it is a typo.
    stateCode = gstinStateCode(gstin);
  } else {
    stateCode =
      take(knownState(row.storeTaxStateCode), "taxes_and_invoices") ??
      take(stateCodeFromAddress(row.taxAddress), "taxes_and_invoices") ??
      take(knownState(row.locationStateCode), "location") ??
      (!signupCountry || signupCountry === DEFAULT_COUNTRY
        ? take(stateCodeFromName(signupState), "signup")
        : null);
  }

  let line1 = textOf(address.line1);
  let line2 = textOf(address.line2);
  let city = textOf(address.city);
  let postalCode = textOf(address.postalCode);
  if (!line1) {
    const typed = splitTypedAddress(row.taxAddress);
    if (typed.line1) {
      line1 = take(typed.line1, "taxes_and_invoices");
      line2 = line2 ?? typed.line2;
      postalCode = postalCode ?? pinIn(row.taxAddress);
    } else {
      line1 = take(textOf(row.signup.addressLine1), "signup");
      line2 = line2 ?? textOf(row.signup.addressLine2);
      city = city ?? textOf(row.signup.city);
      postalCode = postalCode ?? textOf(row.signup.postalCode);
    }
  }

  let country = DEFAULT_COUNTRY;
  if (accountCountry && isCountryCode(accountCountry)) {
    country = accountCountry;
  } else if (
    signupCountry &&
    signupCountry !== DEFAULT_COUNTRY &&
    isCountryCode(signupCountry)
  ) {
    country = take(signupCountry, "signup") ?? DEFAULT_COUNTRY;
  }

  const order: BillingDetailsPrefill[] = [
    "taxes_and_invoices",
    "location",
    "signup",
  ];
  const prefilledFrom = order.find((source) => used.has(source)) ?? null;

  return {
    saved: false,
    legalName,
    gstin: gstin ?? "",
    stateCode: stateCode ?? "",
    country,
    countryName:
      country === DEFAULT_COUNTRY ? "" : (textOf(address.countryName) ?? ""),
    addressLine1: line1 ?? "",
    addressLine2: line2 ?? "",
    city: city ?? "",
    postalCode: postalCode ?? "",
    prefilledFrom,
    placeOfSupply,
  };
}

function clip(value: string | null, max: number): string | null {
  return value ? value.slice(0, max) : null;
}

/**
 * Save Billing details. The country, the GSTIN and the state are always
 * decided by a save (an absent country means India); the business name and
 * the address fields keep their saved values when left out, and a blank one
 * removes it.
 *
 * In India a GSTIN, when given, must be valid and decides the state; without
 * one a state is required. Outside India nothing tax-related is kept, so the
 * invoices name the place of supply as outside India.
 */
export async function saveBillingDetails(
  storeId: string,
  input: BillingDetailsInput,
): Promise<SaveBillingDetailsResult> {
  const errors = BILLING_DETAILS.errors;

  const country = upperOf(input.country) ?? DEFAULT_COUNTRY;
  if (!isCountryCode(country)) {
    return { ok: false, error: errors.failed, field: "country" };
  }

  let existing: { address: Record<string, unknown> } | null = null;
  try {
    existing = await withService(async (db) => {
      const [row] = await db
        .select({ address: billingAccounts.address })
        .from(billingAccounts)
        .where(eq(billingAccounts.storeId, storeId))
        .limit(1);
      return { address: objectOf(row?.address) };
    });
  } catch (err) {
    logError("billing.details_save_read", err, { storeId });
    return { ok: false, error: errors.failed };
  }

  // The address: a field given replaces the saved one (blank removes it), a
  // field left out keeps it, and any other key already there is carried.
  const address: Record<string, unknown> = { ...existing.address };
  const fields: Array<[keyof BillingDetailsInput, string, number]> = [
    ["addressLine1", "line1", MAX_LINE],
    ["addressLine2", "line2", MAX_LINE],
    ["city", "city", MAX_CITY],
    ["postalCode", "postalCode", MAX_POSTAL],
  ];
  for (const [inputKey, key, max] of fields) {
    const raw = input[inputKey];
    if (raw === undefined) continue;
    const value = clip(textOf(raw), max);
    if (value) address[key] = value;
    else delete address[key];
  }

  let gstin: string | null = null;
  let stateCode: string | null = null;

  if (country === DEFAULT_COUNTRY) {
    const typedGstin = (input.gstin ?? "").replace(/\s+/g, "").toUpperCase();
    if (typedGstin) {
      const fromGstin = isValidGstinFormat(typedGstin)
        ? gstinStateCode(typedGstin)
        : null;
      if (!fromGstin) {
        return { ok: false, error: errors.gstin, field: "gstin" };
      }
      gstin = typedGstin;
      stateCode = fromGstin;
    } else {
      stateCode = knownState(input.stateCode);
      if (!stateCode) {
        return { ok: false, error: errors.state, field: "stateCode" };
      }
    }
    const pin = textOf(address.postalCode);
    if (pin && !PIN_PATTERN.test(pin)) {
      return { ok: false, error: errors.pin, field: "postalCode" };
    }
    address.country = DEFAULT_COUNTRY;
    delete address.countryName;
  } else {
    let name: string | null;
    if (country === "OTHER") {
      name =
        input.countryName !== undefined
          ? textOf(input.countryName)
          : textOf(existing.address.countryName);
      if (
        !name ||
        name.length < MIN_COUNTRY_NAME ||
        name.length > MAX_COUNTRY_NAME
      ) {
        return { ok: false, error: errors.countryName, field: "countryName" };
      }
    } else {
      name = countryName(country);
    }
    address.country = country;
    address.countryName = name;
  }

  let legalName: string | null | undefined;
  if (input.legalName !== undefined) {
    legalName = clip(textOf(input.legalName), MAX_NAME);
  }

  // ★ No billingEmail: this form never decides where billing mail goes.
  const saved = await ensureBillingAccount(storeId, {
    ...(legalName !== undefined ? { legalName } : {}),
    gstin,
    stateCode,
    address,
  });
  if (!saved) return { ok: false, error: errors.failed };
  return { ok: true };
}
