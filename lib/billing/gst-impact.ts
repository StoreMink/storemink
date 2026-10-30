import "server-only";

/**
 * What a GST change would do to the merchants with a plan: the console's
 * impact panel (GST design 5.8 and 6.4, "What this changes for merchants with
 * a plan"). For every subscription that renews, its next renewal priced under
 * the values in force and under the proposed values, how each would be
 * collected, and which state its invoices would name.
 *
 * ★★ THE RENEWAL WORKER'S OWN ARITHMETIC, so the preview cannot promise what
 * the renewal then does differently: the next cycle's shape from
 * `resolveNextCycle`, the live prices the hourly billing run charges
 * (`getPlanPricingLive`, `getExtraLocationPricingLive`), the invoice from
 * `buildSubscriptionInvoice`, the route from `collectionRoute` against the
 * subscription's own mandate, and the place of supply from `placeOfSupplyFor`
 * over the same records `readTaxSnapshot` reads (Billing details, Taxes &
 * invoices, the default location, the signup address).
 *
 * ★ TWO SETS OF VALUES, ONE SHAPE. Both totals are for the same renewal; the
 * preview compares the values in force now (`termsAt`, so a scheduled change
 * that has already started counts as in force, and one still pending is
 * ignored, because a new schedule replaces it) with the proposed ones. It does
 * not ask whether a given renewal is invoiced before or after the change would
 * start, nor whether its invoice is already issued: with a month's notice no
 * monthly renewal would ever show a change otherwise. "How it is paid" is the
 * mandate rule alone (`collectionRoute`), as the panel's lines word it.
 *
 * ★ READ ONLY, IN BATCHES OF 200. The live prices are read first, each in its
 * own scope; then, inside ONE service scope, the settings row and every
 * renewing subscription 200 at a time by store id, one statement after
 * another (never two queries at once on one client). Every renewal is
 * counted; the table keeps at most 200 rows, those that need a person's
 * attention first.
 */

import { sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { countryName } from "@/lib/countries";
import { PLAN_META, normalizePlan, type Plan } from "@/lib/plans";
import {
  getExtraLocationPricingLive,
  getPlanPricingLive,
  type ExtraLocationPricing,
  type PlanPricing,
} from "@/lib/plans/pricing";
import {
  collectionRoute,
  type CollectionRoute,
  type MandateStatus,
} from "./cycle";
import {
  normalizeStateCode,
  placeOfSupplyFor,
  type PlaceOfSupply,
  type PlaceOfSupplyInput,
} from "./gst";
import { buildSubscriptionInvoice } from "./invoice";
import { resolveNextCycle, type BillingPeriod } from "./next-cycle";
import type { ImpactCounts } from "./tax-copy";
import {
  taxContextFor,
  termsAt,
  type TaxTerms,
  type TaxTermsSource,
  type TaxValues,
} from "./tax-terms";

/** Subscriptions read per statement. */
export const IMPACT_BATCH = 200;

/** Rows the impact table keeps. */
export const IMPACT_ROWS = 200;

/** Below every real store id, so the first batch starts at the beginning. */
const FIRST_CURSOR = "00000000-0000-0000-0000-000000000000";

/** The values the operator is about to save (design 5.8, Card 3). */
export type GstChangeProposal = TaxValues;

/** One renewal in the impact table. */
export interface GstImpactRow {
  storeId: string;
  storeName: string;
  storeSlug: string;
  /** The next cycle's plan, period and billed locations (`resolveNextCycle`). */
  plan: Plan;
  period: BillingPeriod;
  billedLocations: number;
  /** When the next cycle starts: the current period's end. */
  renewsOn: string;
  /** The renewal's total under the values in force. */
  todayPaise: number;
  /** The renewal's total under the proposed values. */
  afterPaise: number;
  routeToday: CollectionRoute;
  routeAfter: CollectionRoute;
  /** Where its invoices would be supplied under the proposed values. */
  placeOfSupply: PlaceOfSupply;
  /**
   * The country a business outside India named ("United States"), for
   * `impactStateOnInvoices`; null in India, or when it only chose "Other".
   */
  countryName: string | null;
}

export interface GstChangeImpact {
  /** The values in force now, as they charge (rate 0 while GST is off). */
  before: TaxValues;
  /** The proposed values, as they would charge. */
  after: TaxValues;
  /** Renewals read: every live subscription that does not end at its period end. */
  renewals: number;
  /** The panel's lines (`impactLines`) and the warning (`impactWarning`). */
  counts: ImpactCounts;
  /** At most IMPACT_ROWS, those needing attention first, then by renewal date. */
  rows: GstImpactRow[];
  /** More renewals than the table keeps. */
  truncated: boolean;
}

export type GstImpactResult =
  | { ok: true; impact: GstChangeImpact }
  | { ok: false; reason: "read_failed" };

const textOf = (v: unknown): string | null =>
  typeof v === "string" ? v : null;

const intOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const flagOf = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

/** A timestamp as ISO text: raw reads hand it over as Postgres text. */
const instantOf = (v: unknown): string | null => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : v;
};

/** No settings row means what the database default means: GST off. */
const NO_SETTINGS: TaxTermsSource = {
  taxEnabled: false,
  taxInclusive: false,
  taxRateBps: 0,
  nextTaxEnabled: null,
  nextTaxInclusive: null,
  nextTaxRateBps: null,
  nextTaxStartsAt: null,
};

/** The values a set of terms charges, without what is still to come. */
function valuesOf(terms: TaxTerms): TaxValues {
  return {
    enabled: terms.active,
    inclusive: terms.inclusive,
    rateBps: terms.rateBps,
  };
}

/** The proposal as terms with nothing scheduled, normalised as `termsAt` does. */
function proposedTerms(p: GstChangeProposal, now: Date): TaxTerms {
  return termsAt(
    {
      ...NO_SETTINGS,
      taxEnabled: p.enabled === true,
      taxInclusive: p.inclusive === true,
      taxRateBps: Number(p.rateBps),
    },
    now,
  );
}

async function readSettings(
  db: Db,
): Promise<{ source: TaxTermsSource; supplierStateCode: string | null }> {
  const res = await db.execute(sql`
    select tax_enabled, tax_inclusive, tax_rate_bps,
           next_tax_enabled, next_tax_inclusive, next_tax_rate_bps,
           next_tax_starts_at, state_code
      from public.platform_billing_settings
     where id
     limit 1`);
  const r = res.rows?.[0] as Record<string, unknown> | undefined;
  if (!r) return { source: NO_SETTINGS, supplierStateCode: null };
  return {
    source: {
      taxEnabled: flagOf(r.tax_enabled) === true,
      taxInclusive: flagOf(r.tax_inclusive) === true,
      taxRateBps: intOf(r.tax_rate_bps) ?? 0,
      nextTaxEnabled: flagOf(r.next_tax_enabled),
      nextTaxInclusive: flagOf(r.next_tax_inclusive),
      nextTaxRateBps: intOf(r.next_tax_rate_bps),
      nextTaxStartsAt: instantOf(r.next_tax_starts_at),
    },
    supplierStateCode: normalizeStateCode(r.state_code),
  };
}

/**
 * One batch of renewing subscriptions after `cursor`, with their mandate and
 * every record that may name the merchant's state (`readTaxSnapshot`'s
 * columns). The renewal worker's own filter: a live state, a period end, and
 * not cancelled at it.
 */
function batchQuery(cursor: string) {
  return sql`
    select s.store_id, s.plan, s.period, s.current_period_end,
           s.billed_locations, s.scheduled_plan, s.scheduled_period,
           s.scheduled_locations, s.cancel_at_period_end,
           st.name as store_name, st.slug as store_slug,
           m.status as mandate_status,
           m.max_amount_paise as mandate_max_paise,
           a.gstin as account_gstin,
           a.state_code as account_state_code,
           a.address ->> 'country' as account_country,
           b.tax_id,
           b.business_state_code,
           b.business_address,
           l.gstin as location_gstin,
           l.state_code as location_state_code,
           st.settings -> 'business' ->> 'state' as signup_state_name,
           st.settings -> 'business' ->> 'country' as signup_country
      from public.billing_subscriptions s
      join public.stores st on st.id = s.store_id
      left join public.billing_mandates m on m.id = s.mandate_id
      left join public.billing_accounts a on a.store_id = s.store_id
      left join public.store_billing_settings b on b.store_id = s.store_id
      left join lateral (
        select gstin, state_code
          from public.store_locations
         where store_id = s.store_id and is_default
         limit 1) l on true
     where s.state in ('active', 'past_due', 'grace')
       and s.cancel_at_period_end = false
       and s.current_period_end is not null
       and s.store_id > ${cursor}::uuid
     order by s.store_id
     limit ${IMPACT_BATCH}`;
}

/** The merchant's records as `placeOfSupplyFor` takes them. */
function placeInputOf(
  r: Record<string, unknown>,
): Omit<PlaceOfSupplyInput, "supplierStateCode" | "taxActive"> {
  return {
    accountGstin: textOf(r.account_gstin),
    accountStateCode: textOf(r.account_state_code),
    accountCountry: textOf(r.account_country),
    taxIdGstin: textOf(r.tax_id),
    storeTaxStateCode: textOf(r.business_state_code),
    taxAddress: textOf(r.business_address),
    locationGstin: textOf(r.location_gstin),
    locationStateCode: textOf(r.location_state_code),
    signupStateName: textOf(r.signup_state_name),
    signupCountry: textOf(r.signup_country),
  };
}

/** A country code other than India, upper-cased, or null. */
function foreignCode(code: string | null): string | null {
  const c = code?.trim().toUpperCase();
  return c && c !== "IN" ? c : null;
}

/**
 * The country a business outside India named, in `placeOfSupplyFor`'s order
 * (Billing details first, then signup); null for signup's "Other", which
 * names none.
 */
function countryOutsideIndia(
  input: Omit<PlaceOfSupplyInput, "supplierStateCode" | "taxActive">,
): string | null {
  const code =
    foreignCode(input.accountCountry) ?? foreignCode(input.signupCountry);
  if (!code || code === "OTHER") return null;
  return countryName(code);
}

type PriceFor = (
  plan: Plan,
  period: BillingPeriod,
) => { planPaise: number; locationPaise: number };

/** The hourly billing run's `priceFor`, over prices read once. */
function priceBook(
  plans: PlanPricing,
  location: ExtraLocationPricing,
): PriceFor {
  return (plan, period) => {
    const row = plans[plan];
    const inr = period === "yearly" ? row.yearlyInr : row.monthlyInr;
    const locInr =
      period === "yearly" ? location.yearlyInr : location.monthlyInr;
    return {
      planPaise: Math.round(inr * 100),
      locationPaise: Math.round(locInr * 100),
    };
  };
}

type StateConcern = "no_state" | "outside_india" | "from_address";

/**
 * What the panel says about a store's state once GST is charged: no state of
 * its own (StoreMink's is used, or none is set), outside India, or a state
 * read from the address it typed. Nothing while the proposed values charge no
 * GST, since an invoice without GST names no place of supply that matters.
 */
function stateConcern(
  place: PlaceOfSupply,
  after: TaxTerms,
): StateConcern | null {
  if (!after.active) return null;
  switch (place.basis) {
    case "supplier_state":
    case "unknown":
      return "no_state";
    case "outside_india":
      return "outside_india";
    case "store_address":
      return "from_address";
    default:
      return null;
  }
}

/**
 * How much a row needs a person, lowest first: moving to payment by hand,
 * then no state of their own or outside India, then a state read from a
 * typed address, then a rise only, then nothing.
 */
function attention(row: GstImpactRow, after: TaxTerms): number {
  if (row.routeToday.auto && !row.routeAfter.auto) return 0;
  const concern = stateConcern(row.placeOfSupply, after);
  if (concern === "no_state" || concern === "outside_india") return 1;
  if (concern === "from_address") return 2;
  if (row.afterPaise > row.todayPaise) return 3;
  return 4;
}

/** One renewing subscription under both sets of values; null if it ends. */
function renewalImpact(
  r: Record<string, unknown>,
  ctx: {
    priceFor: PriceFor;
    supplierStateCode: string | null;
    today: TaxTerms;
    after: TaxTerms;
  },
): GstImpactRow | null {
  const next = resolveNextCycle({
    plan: textOf(r.plan) ?? "free",
    period: textOf(r.period) ?? "monthly",
    billedLocations: intOf(r.billed_locations) ?? 0,
    scheduledPlan: textOf(r.scheduled_plan),
    scheduledPeriod: textOf(r.scheduled_period),
    scheduledLocations: intOf(r.scheduled_locations),
    cancelAtPeriodEnd: flagOf(r.cancel_at_period_end) === true,
  });
  // The query leaves cancelled subscriptions out; this is the belt to it.
  if (next.ending) return null;

  const plan = normalizePlan(next.plan);
  const price = ctx.priceFor(plan, next.period);
  const records = placeInputOf(r);
  const mandate = {
    mandateStatus: (textOf(r.mandate_status) as MandateStatus | null) ?? null,
    mandateMaxPaise: intOf(r.mandate_max_paise),
  };

  const priced = (terms: TaxTerms) => {
    const place = placeOfSupplyFor({
      ...records,
      supplierStateCode: ctx.supplierStateCode,
      taxActive: terms.active,
    });
    const built = buildSubscriptionInvoice({
      planLabel: PLAN_META[plan].name,
      period: next.period,
      planPaise: price.planPaise,
      locations:
        next.billedLocations > 0
          ? { count: next.billedLocations, unitPaise: price.locationPaise }
          : undefined,
      tax: taxContextFor(terms, ctx.supplierStateCode, place.code),
    });
    const route = collectionRoute({ ...mandate, totalPaise: built.totalPaise });
    return { place, totalPaise: built.totalPaise, route };
  };

  const today = priced(ctx.today);
  const after = priced(ctx.after);
  return {
    storeId: String(r.store_id),
    storeName: textOf(r.store_name) ?? "",
    storeSlug: textOf(r.store_slug) ?? "",
    plan,
    period: next.period,
    billedLocations: next.billedLocations,
    renewsOn: instantOf(r.current_period_end) ?? "",
    todayPaise: today.totalPaise,
    afterPaise: after.totalPaise,
    routeToday: today.route,
    routeAfter: after.route,
    placeOfSupply: after.place,
    countryName:
      after.place.basis === "outside_india"
        ? countryOutsideIndia(records)
        : null,
  };
}

/** Adds one renewal to the panel's counts. */
function count(counts: ImpactCounts, row: GstImpactRow, after: TaxTerms): void {
  if (row.afterPaise > row.todayPaise) counts.rise += 1;
  if (row.routeToday.auto && !row.routeAfter.auto) {
    counts.byHand += 1;
    if (row.routeAfter.reason === "over_mandate") counts.aboveMandate += 1;
    if (row.routeAfter.reason === "over_afa_limit") counts.aboveAfaLimit += 1;
  }
  const concern = stateConcern(row.placeOfSupply, after);
  if (concern === "no_state") counts.noState += 1;
  if (concern === "from_address") counts.fromAddress += 1;
  if (concern === "outside_india") counts.outsideIndia += 1;
}

/**
 * The impact of saving `proposed` (design 5.8): counts over every renewal and
 * up to 200 rows. Read only. A failed read is `read_failed` (logged), never a
 * partial answer: a preview that undercounts would be read as good news.
 */
export async function getGstChangeImpact(
  proposed: GstChangeProposal,
  opts: { now?: Date } = {},
): Promise<GstImpactResult> {
  const now = opts.now ?? new Date();
  const after = proposedTerms(proposed, now);
  try {
    // Each opens its own scope, so neither runs inside the one below.
    const plans = await getPlanPricingLive();
    const location = await getExtraLocationPricingLive();
    const priceFor = priceBook(plans, location);

    const impact = await withService(async (db) => {
      const settings = await readSettings(db);
      const today = termsAt(settings.source, now);
      const ctx = {
        priceFor,
        supplierStateCode: settings.supplierStateCode,
        today,
        after,
      };
      const counts: ImpactCounts = {
        rise: 0,
        byHand: 0,
        aboveMandate: 0,
        aboveAfaLimit: 0,
        noState: 0,
        fromAddress: 0,
        outsideIndia: 0,
        supplierStateCode: settings.supplierStateCode,
      };
      let ranked: { rank: number; row: GstImpactRow }[] = [];
      let renewals = 0;

      for (let cursor = FIRST_CURSOR; ; ) {
        const res = await db.execute(batchQuery(cursor));
        const batch = (res.rows ?? []) as Record<string, unknown>[];
        for (const r of batch) {
          const row = renewalImpact(r, ctx);
          if (!row) continue;
          renewals += 1;
          count(counts, row, after);
          ranked.push({ rank: attention(row, after), row });
        }
        // Keep only the rows the table can show, so memory stays bounded.
        ranked = keepFirst(ranked);
        if (batch.length < IMPACT_BATCH) break;
        const last = String(batch[batch.length - 1].store_id);
        if (last === cursor) break;
        cursor = last;
      }

      return {
        before: valuesOf(today),
        after: valuesOf(after),
        renewals,
        counts,
        rows: ranked.map((r) => r.row),
        truncated: renewals > ranked.length,
      };
    });
    return { ok: true, impact };
  } catch (err) {
    logError("billing.gst_impact", err, { proposed });
    return { ok: false, reason: "read_failed" };
  }
}

/** The IMPACT_ROWS most needing attention, soonest renewal first within each. */
function keepFirst(
  ranked: { rank: number; row: GstImpactRow }[],
): { rank: number; row: GstImpactRow }[] {
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.row.renewsOn.localeCompare(b.row.renewsOn) ||
        a.row.storeId.localeCompare(b.row.storeId),
    )
    .slice(0, IMPACT_ROWS);
}
