// ---------------------------------------------------------------------------
// India GST place-of-supply split — a pure layer ON TOP of computeTax().
//
// computeTax() already decides HOW MUCH tax a line carries (inclusive vs
// exclusive, discount allocation). GST then decides how that amount DIVIDES:
//
//   * Intra-state (supplier state == place of supply)
//       → CGST + SGST, half each. Two 9% halves of an 18% rate.
//   * Inter-state (different states, or the place of supply is unknown for an
//     interstate shipment)
//       → IGST, the whole amount.
//
// Never both. The split is snapshotted per order_item so a historical receipt
// keeps printing what was actually charged, even if the store later moves state
// or changes its GST registration.
//
// Place of supply for an in-person sale is the SELLING LOCATION's state (the
// customer walks in), so a POS sale is intra-state unless the goods are shipped
// elsewhere — which is why shipping paths pass the customer's state instead.
//
// Pure module: no imports, fully deterministic, unit-tested.
// ---------------------------------------------------------------------------

/** Round to 2 dp (money). Mirrors lib/billing/tax.ts round2. */
function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface GstSplit {
  cgst: number;
  sgst: number;
  igst: number;
  /** True when this was taxed as CGST+SGST rather than IGST. */
  intraState: boolean;
}

/** Normalise a GST state code: 2 digits, zero-padded ("7" → "07"). */
export function normalizeStateCode(code: unknown): string | null {
  if (typeof code === "number" && Number.isFinite(code)) {
    const s = String(Math.trunc(code));
    return s.length === 1 ? `0${s}` : s.length === 2 ? s : null;
  }
  if (typeof code !== "string") return null;
  const t = code.trim();
  if (!t) return null;
  if (!/^\d{1,2}$/.test(t)) return null;
  return t.length === 1 ? `0${t}` : t;
}

/**
 * Is this an intra-state supply? Unknown/missing place of supply falls back to
 * INTRA-state, because the common case by far is a walk-in at the counter, and
 * CGST+SGST is what a local shop owes. Callers that know the goods are leaving
 * the state must pass the destination explicitly.
 */
export function isIntraState(
  supplierState: string | null | undefined,
  placeOfSupplyState: string | null | undefined,
): boolean {
  const a = normalizeStateCode(supplierState);
  const b = normalizeStateCode(placeOfSupplyState);
  if (!a || !b) return true;
  return a === b;
}

/**
 * Divide one line's already-computed tax into CGST/SGST or IGST.
 *
 * Takes the TAX AMOUNT (not the rate) so it stays consistent with computeTax's
 * rounding: splitting the amount can never disagree with the order total, which
 * re-deriving from the rate could.
 *
 * The halves are rounded so cgst + sgst === the input exactly, even for odd
 * paise (₹0.05 → 0.03 + 0.02): sgst takes the remainder.
 */
export function splitGst(taxAmount: number, intraState: boolean): GstSplit {
  const total = Number.isFinite(taxAmount) ? round2(Math.max(0, taxAmount)) : 0;
  if (!intraState) {
    return { cgst: 0, sgst: 0, igst: total, intraState: false };
  }
  const cgst = round2(total / 2);
  // Remainder, not a second division — guarantees the halves re-sum exactly.
  const sgst = round2(total - cgst);
  return { cgst, sgst, igst: 0, intraState: true };
}

/** CGST/SGST/IGST in integer paise. */
export interface GstSplitPaise {
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  intraState: boolean;
}

/**
 * The paise-exact counterpart of splitGst, for platform → merchant invoices
 * (§34), where every amount is an integer number of paise.
 *
 * ★ A SEPARATE FUNCTION, deliberately — not a wrapper. `splitGst` rounds to two
 * decimals because it works in RUPEES, so routing paise through it would divide
 * by 100 and back and reintroduce exactly the float error integer paise exist to
 * prevent. Same remainder trick, different unit.
 *
 * sgst takes the remainder, so cgst + sgst === the input for odd paise too
 * (₹0.05 = 5p → 3p + 2p).
 */
export function splitGstPaise(
  taxPaise: number,
  intraState: boolean,
): GstSplitPaise {
  const total = Number.isFinite(taxPaise)
    ? Math.max(0, Math.round(taxPaise))
    : 0;
  if (!intraState) {
    return { cgstPaise: 0, sgstPaise: 0, igstPaise: total, intraState: false };
  }
  const cgstPaise = Math.floor(total / 2);
  return {
    cgstPaise,
    sgstPaise: total - cgstPaise,
    igstPaise: 0,
    intraState: true,
  };
}

export interface GstRateBucket {
  /** The full GST rate for this bucket (e.g. 18 for 9% + 9%). */
  rate: number;
  label: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Group per-line GST into the rate buckets a GST invoice must print
 * ("Taxable value / CGST 9% / SGST 9%" per rate).
 */
export function gstBreakdown(
  lines: Array<{
    rate: number;
    label?: string;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
  }>,
): GstRateBucket[] {
  const buckets = new Map<number, GstRateBucket>();
  for (const l of lines) {
    if (!(l.rate > 0)) continue;
    const b = buckets.get(l.rate);
    if (b) {
      b.taxableValue = round2(b.taxableValue + l.taxableValue);
      b.cgst = round2(b.cgst + l.cgst);
      b.sgst = round2(b.sgst + l.sgst);
      b.igst = round2(b.igst + l.igst);
    } else {
      buckets.set(l.rate, {
        rate: l.rate,
        label: l.label || `GST ${l.rate}%`,
        taxableValue: round2(l.taxableValue),
        cgst: round2(l.cgst),
        sgst: round2(l.sgst),
        igst: round2(l.igst),
      });
    }
  }
  return [...buckets.values()].sort((a, b) => a.rate - b.rate);
}

/** Loose GSTIN shape check (15 chars: 2 state + 10 PAN + 3). Format only — it
 *  does not prove the number is registered. */
export function isValidGstinFormat(gstin: unknown): gstin is string {
  return (
    typeof gstin === "string" &&
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(
      gstin.trim().toUpperCase(),
    )
  );
}

/**
 * The GST state codes, for a picker.
 *
 * ★ THE CODE IS THE DATA, the name is the label. Everything downstream compares
 * codes (`isIntraState`, `splitGst`), so a renamed state changes nothing.
 *
 * ⚠ DELIBERATELY OMITS THE RETIRED CODES. `25` (Daman & Diu) merged into `26` in
 * 2020, and `28` (undivided Andhra Pradesh) became `37`. Nobody registering today
 * has one, so offering them in a picker only invites a wrong choice — but a
 * merchant's STORED code may still be one, which is why `normalizeStateCode`
 * accepts any two digits and nothing validates against this list.
 */
export const GST_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "01", name: "Jammu & Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra & Nagar Haveli and Daman & Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman & Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];

/** The display name for a stored code, falling back to the code itself. */
export function gstStateName(code: unknown): string | null {
  const c = normalizeStateCode(code);
  if (!c) return null;
  return GST_STATES.find((s) => s.code === c)?.name ?? c;
}

/**
 * The states a merchant picks from: every GST state but "Other Territory"
 * (97), by name (design 7.2). Shared by signup, Billing details and the
 * state prompt on Plans and Locations, so the three never offer different
 * lists.
 *
 * ★ 97 is left out because choosing it makes every invoice IGST with place
 * of supply 97, which is almost never the merchant's real state (R2-11).
 */
export const PICKABLE_GST_STATES: ReadonlyArray<{
  code: string;
  name: string;
}> = GST_STATES.filter((s) => s.code !== "97").sort((a, b) =>
  a.name.localeCompare(b.name, "en"),
);

/**
 * The picker's options for a select currently showing `current`: the
 * pickable list, plus `current` itself when it is a code the list leaves out
 * (97 read from a GSTIN or saved before this list, or a retired code).
 *
 * ★ A select whose value is not one of its options shows its placeholder,
 * so without this a state the GSTIN names would read as blank in the
 * disabled select, and a saved one as unchosen.
 */
export function gstStateOptions(
  current: unknown,
): ReadonlyArray<{ code: string; name: string }> {
  const c = normalizeStateCode(current);
  if (!c || PICKABLE_GST_STATES.some((s) => s.code === c)) {
    return PICKABLE_GST_STATES;
  }
  return [...PICKABLE_GST_STATES, { code: c, name: gstStateName(c) ?? c }];
}

/** The state code embedded in a GSTIN's first two digits, if parseable. */
export function stateCodeFromGstin(gstin: unknown): string | null {
  if (typeof gstin !== "string") return null;
  const t = gstin.trim();
  if (t.length < 2) return null;
  return normalizeStateCode(t.slice(0, 2));
}

// ---------------------------------------------------------------------------
// StoreMink's own invoices to merchants: place of supply (GST design 5.1).
//
// Everything below is about the platform invoicing its MERCHANTS, never about
// a merchant's own order tax. `isIntraState` above keeps its meaning for that
// (a POS walk-in defaults to intra-state); a platform invoice must not, which
// is why `platformInvoiceGst` has its own rule.
// ---------------------------------------------------------------------------

/** The GST portal's code for a place of supply outside India. */
export const OUTSIDE_INDIA_PLACE_OF_SUPPLY = "96";

/** Names that are not in GST_STATES but mean one of its states. */
const STATE_NAME_ALIASES: ReadonlyArray<{ name: string; code: string }> = [
  { name: "new delhi", code: "07" },
  { name: "orissa", code: "21" },
  { name: "pondicherry", code: "34" },
  { name: "uttaranchal", code: "05" },
  { name: "andaman and nicobar", code: "35" },
  { name: "dadra and nagar haveli", code: "26" },
  { name: "daman and diu", code: "26" },
];

/** Words a state's formal name may start with that are not part of it. */
const STATE_NAME_PREFIXES: ReadonlyArray<string> = [
  "national capital territory of ",
  "union territory of ",
  "state of ",
  "nct of ",
  "the ",
];

/** Lower-cased, `&` as "and", anything that is not a letter as one space. */
function normaliseStateText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

function withoutStatePrefixes(name: string): string {
  let out = name;
  for (let changed = true; changed; ) {
    changed = false;
    for (const prefix of STATE_NAME_PREFIXES) {
      if (out.startsWith(prefix)) {
        out = out.slice(prefix.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

/** Every searchable name (GST_STATES names plus aliases), normalised once. */
const STATE_NAMES: ReadonlyArray<{
  words: string[];
  text: string;
  code: string;
}> = [
  ...GST_STATES.map((s) => ({ name: s.name, code: s.code })),
  ...STATE_NAME_ALIASES,
].map(({ name, code }) => {
  const text = normaliseStateText(name);
  return { text, words: text.split(" "), code };
});

const STATE_CODE_BY_NAME: ReadonlyMap<string, string> = new Map(
  STATE_NAMES.map((s) => [s.text, s.code]),
);

/** A code in GST_STATES, normalised, or null. */
function knownStateCode(code: unknown): string | null {
  const c = normalizeStateCode(code);
  return c && GST_STATES.some((s) => s.code === c) ? c : null;
}

/**
 * The GST state code a state's NAME (or its two-digit code) stands for.
 *
 * A two-digit code passes through `normalizeStateCode` and must be in
 * GST_STATES. A name is lower-cased, `&` read as "and", formal prefixes
 * ("State of", "NCT of", "Union Territory of") dropped, and matched against
 * the GST_STATES names and a few common aliases ("New Delhi", "Orissa",
 * "Pondicherry"). Google's `administrative_area_level_1` long names, which
 * older signups stored, all resolve. Anything else is null.
 */
export function stateCodeFromName(name: unknown): string | null {
  const asCode = normalizeStateCode(name);
  if (asCode) return knownStateCode(asCode);
  if (typeof name !== "string") return null;
  const text = withoutStatePrefixes(normaliseStateText(name));
  if (!text) return null;
  return STATE_CODE_BY_NAME.get(text) ?? null;
}

/**
 * The state named in a typed address ("Street, City, State, PIN").
 *
 * Every state name and alias is searched for as whole words. ★ THE MATCH THAT
 * ENDS LAST WINS, because the state follows the street and the city: "Punjab
 * National Bank, Karol Bagh, Delhi 110005" is in Delhi (07), not Punjab. On a
 * tie the longer name wins. ★ It never guesses from a PIN code: PIN ranges
 * cross state lines (Chandigarh and Mohali share 160), so an address naming
 * no state is null.
 */
export function stateCodeFromAddress(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const normalised = normaliseStateText(text);
  if (!normalised) return null;
  const words = normalised.split(" ");

  let best: { end: number; length: number; code: string } | null = null;
  for (const state of STATE_NAMES) {
    const n = state.words.length;
    for (let start = 0; start + n <= words.length; start++) {
      let matches = true;
      for (let k = 0; k < n; k++) {
        if (words[start + k] !== state.words[k]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const end = start + n;
      if (
        !best ||
        end > best.end ||
        (end === best.end && state.text.length > best.length)
      ) {
        best = { end, length: state.text.length, code: state.code };
      }
    }
  }
  return best?.code ?? null;
}

/** "Delhi (07)", or "Outside India (96)"; the bare code when it names no state. */
export function placeOfSupplyLabel(code: unknown): string | null {
  const c = normalizeStateCode(code);
  if (!c) return null;
  if (c === OUTSIDE_INDIA_PLACE_OF_SUPPLY) return "Outside India (96)";
  const state = GST_STATES.find((s) => s.code === c);
  return state ? `${state.name} (${c})` : c;
}

/** Where a platform invoice's place of supply was read from. */
export type PlaceOfSupplyBasis =
  | "gstin"
  | "billing_state"
  | "store_gstin"
  | "store_tax_state"
  | "location_gstin"
  | "location_state"
  | "store_address"
  | "signup_address"
  | "outside_india"
  | "supplier_state"
  | "unknown";

/** What `billing_invoices.place_of_supply_basis` records. */
export type DbPlaceOfSupplyBasis = "recipient" | "supplier" | "outside_india";

/**
 * The basis the invoice row records: `outside_india` stays, `supplier_state`
 * is `supplier`, every state of the merchant's own is `recipient`, and
 * `unknown` is null (no place of supply, so no basis).
 */
export function dbBasisFor(
  basis: PlaceOfSupplyBasis,
): DbPlaceOfSupplyBasis | null {
  switch (basis) {
    case "outside_india":
      return "outside_india";
    case "supplier_state":
      return "supplier";
    case "unknown":
      return null;
    case "gstin":
    case "billing_state":
    case "store_gstin":
    case "store_tax_state":
    case "location_gstin":
    case "location_state":
    case "store_address":
    case "signup_address":
      return "recipient";
  }
}

/** Every record of the merchant that may name their state, as read. */
export interface PlaceOfSupplyInput {
  /** Billing details: the GSTIN saved for StoreMink's invoices. */
  accountGstin: string | null;
  /** Billing details: the state saved for StoreMink's invoices. */
  accountStateCode: string | null;
  /** Billing details: an ISO country, "IN" or another. */
  accountCountry: string | null;
  /** Taxes & invoices: "Tax registration (GSTIN)". */
  taxIdGstin: string | null;
  /** Taxes & invoices: a business state code (no writer today). */
  storeTaxStateCode: string | null;
  /** The default location's GSTIN. */
  locationGstin: string | null;
  /** The default location's state code. */
  locationStateCode: string | null;
  /** Taxes & invoices: the typed business address. */
  taxAddress: string | null;
  /** Signup: the state's name (`stores.settings.business.state`). */
  signupStateName: string | null;
  /** Signup: the country chosen ("IN", or another such as "OTHER"). */
  signupCountry: string | null;
  /** StoreMink's own state. */
  supplierStateCode: string | null;
  /** GST is charged on the invoice being built. */
  taxActive: boolean;
}

export interface PlaceOfSupply {
  code: string | null;
  basis: PlaceOfSupplyBasis;
}

/**
 * The state code a GSTIN names, when the GSTIN is well formed and its first
 * two digits are a state in GST_STATES; otherwise null, as if absent. A GSTIN
 * naming no known state would print a non-state code (96, 99) as the
 * merchant's State; for 96 the invoice's basis rule refuses the row outright.
 */
export function gstinStateCode(gstin: unknown): string | null {
  if (!isValidGstinFormat(gstin)) return null;
  return knownStateCode(stateCodeFromGstin(gstin.trim().toUpperCase()));
}

/** "IN", another ISO code, or null for a blank country. */
function countryOf(country: string | null): string | null {
  if (typeof country !== "string") return null;
  const c = country.trim().toUpperCase();
  return c || null;
}

/**
 * Where StoreMink's invoice to this merchant is supplied, and what said so.
 *
 * The merchant's own records in a fixed order, the first match winning:
 *  1. the GSTIN under Billing details (IGST s.12(2)(a));
 *  2. a Billing details country outside India: 96 (their own statement beats
 *     every other record);
 *  3. the Billing details state;
 *  4. the Taxes & invoices GSTIN;
 *  5. the Taxes & invoices state;
 *  6. the default location's GSTIN, then its state;
 *  7. the state named in the Taxes & invoices business address;
 *  8. the signup state, when the signup country is blank or India;
 *  9. a signup country outside India: 96;
 * 10. while GST is charged, StoreMink's own state (s.12(2)(b)(ii)); otherwise
 *     nothing.
 * An invalid GSTIN anywhere is skipped as if absent.
 */
export function placeOfSupplyFor(input: PlaceOfSupplyInput): PlaceOfSupply {
  const accountGstinState = gstinStateCode(input.accountGstin);
  if (accountGstinState) return { code: accountGstinState, basis: "gstin" };

  const accountCountry = countryOf(input.accountCountry);
  if (accountCountry && accountCountry !== "IN") {
    return { code: OUTSIDE_INDIA_PLACE_OF_SUPPLY, basis: "outside_india" };
  }

  const accountState = knownStateCode(input.accountStateCode);
  if (accountState) return { code: accountState, basis: "billing_state" };

  const taxIdState = gstinStateCode(input.taxIdGstin);
  if (taxIdState) return { code: taxIdState, basis: "store_gstin" };

  const storeTaxState = knownStateCode(input.storeTaxStateCode);
  if (storeTaxState) return { code: storeTaxState, basis: "store_tax_state" };

  const locationGstinState = gstinStateCode(input.locationGstin);
  if (locationGstinState) {
    return { code: locationGstinState, basis: "location_gstin" };
  }
  const locationState = knownStateCode(input.locationStateCode);
  if (locationState) return { code: locationState, basis: "location_state" };

  const addressState = stateCodeFromAddress(input.taxAddress);
  if (addressState) return { code: addressState, basis: "store_address" };

  const signupCountry = countryOf(input.signupCountry);
  if (!signupCountry || signupCountry === "IN") {
    const signupState = stateCodeFromName(input.signupStateName);
    if (signupState) return { code: signupState, basis: "signup_address" };
  } else {
    return { code: OUTSIDE_INDIA_PLACE_OF_SUPPLY, basis: "outside_india" };
  }

  if (input.taxActive) {
    const supplier = knownStateCode(input.supplierStateCode);
    if (supplier) return { code: supplier, basis: "supplier_state" };
  }
  return { code: null, basis: "unknown" };
}

/**
 * The merchant's State to print on an invoice: its place of supply when that
 * came from the merchant's own records (basis `recipient`, or NULL on an
 * invoice written before the basis existed), otherwise null. A supplier
 * fallback or a place of supply outside India names no State for the
 * merchant, matching the parties snapshot trigger.
 */
export function recipientStateFor(row: {
  placeOfSupply: string | null;
  placeOfSupplyBasis: string | null;
}): string | null {
  const basis = row.placeOfSupplyBasis ?? null;
  if (basis !== null && basis !== "recipient") return null;
  const code = normalizeStateCode(row.placeOfSupply);
  return code && code !== OUTSIDE_INDIA_PLACE_OF_SUPPLY ? code : null;
}

export interface PlatformInvoiceGst extends GstSplitPaise {
  /** The full rate, for "IGST 18%" (CGST and SGST are half each). */
  ratePct: number;
}

/**
 * How a platform invoice's (or credit note's) tax divides.
 *
 * ★ INTRA-STATE EXACTLY WHEN BOTH ARE PRESENT AND MATCH: the supplier GSTIN's
 * first two digits equal the place of supply. A missing place of supply, a
 * missing supplier GSTIN, or place of supply 96 is IGST, never the
 * `isIntraState` walk-in default. Split from the tax AMOUNT
 * (`splitGstPaise`), so the halves always re-sum to what was charged. The
 * invoice sheet, the emails, the invoice register and the credit-note sheet
 * all call this one function.
 */
export function platformInvoiceGst(doc: {
  taxPaise: number;
  taxRateBps: number | null;
  supplierGstin: string | null;
  placeOfSupply: string | null;
}): PlatformInvoiceGst {
  const intra =
    !!doc.supplierGstin &&
    !!doc.placeOfSupply &&
    doc.placeOfSupply !== OUTSIDE_INDIA_PLACE_OF_SUPPLY &&
    doc.supplierGstin.slice(0, 2) === doc.placeOfSupply;
  const ratePct = doc.taxRateBps ? doc.taxRateBps / 100 : 0;
  return { ...splitGstPaise(doc.taxPaise, intra), ratePct };
}
