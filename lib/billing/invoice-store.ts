import "server-only";

/**
 * The invoice repository — turning a BuiltInvoice into rows, idempotently.
 *
 * Design: docs/billing-architecture.md §5, §6, §7.
 *
 * ★ THE PURE HALF DECIDES THE MONEY; THIS HALF ONLY PERSISTS IT. Every amount
 * comes from `lib/billing/invoice.ts`, so the renewal worker, an upgrade and a
 * merchant-facing preview cannot disagree about what a cycle costs.
 *
 * ⚠ WHAT THESE FUNCTIONS CANNOT GUARANTEE ON THEIR OWN. Exactly-once creation
 * is the `billing_invoices_one_per_cycle` UNIQUE index, immutability is a
 * trigger, and the invoice number comes from another trigger. All three live in
 * Postgres and are verified by `scripts/billing-verify.sql` against a real
 * database — never by the unit tests here, which can only prove that this layer
 * asks for the right thing and reads the answer correctly.
 */

import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  billingAccounts,
  billingCredits,
  billingInvoiceItems,
  billingInvoices,
  billingPaymentAttempts,
  billingReconciliationItems,
  platformBillingSettings,
} from "@/drizzle/schema";
import { loggableError } from "@/lib/db/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import type { DbPlaceOfSupplyBasis } from "./gst";
import {
  INVOICE_BODY_KINDS,
  rebuildForIssue,
  type BuiltInvoice,
  type InvoiceLine,
} from "./invoice";
import {
  resolveTaxSnapshot,
  type InvoiceTaxStamp,
  type SnapshotRow,
  type TaxSnapshot,
} from "./tax-snapshot";

export interface InvoiceRow {
  id: string;
  /** Null only on an issued invoice whose store was deleted (migration 0243):
   *  StoreMink keeps its own invoices, so the row outlives the store. */
  storeId: string | null;
  kind: "subscription" | "ai_credits" | "addon";
  status: string;
  totalPaise: number;
  cycleSeq: number | null;
  invoiceRef: string | null;
  finalizedAt: string | null;
  /**
   * The cycle this invoice covers. Read by enrolment to tell a monthly first
   * cycle from a yearly one when the two happen to cost the same.
   *
   * ⚠ Compare the DURATION, never the instants: a cycle is anchored to the
   * moment it was raised, so two clicks a minute apart legitimately produce
   * different endpoints for the very same plan.
   */
  periodStart: string | null;
  periodEnd: string | null;
  /**
   * The GST on the invoice, in paise; 0 when it charges none. With
   * `taxRateBps` and `taxInclusive` it is what the billing emails print, so
   * the renewal notice's "Price", "GST" and "Amount" rows add up.
   */
  taxPaise: number;
  /** The GST rate snapshotted on the invoice; 0 when it charges none. */
  taxRateBps: number;
  /** StoreMink's GSTIN, stamped only while GST is charged. */
  supplierGstin: string | null;
  /** The merchant's GSTIN under Billing details, when valid. */
  customerGstin: string | null;
  placeOfSupply: string | null;
  /** Where the place of supply came from (0266); null on older invoices. */
  placeOfSupplyBasis: DbPlaceOfSupplyBasis | null;
  /** StoreMink's SAC code, stamped only while GST is charged. */
  sacCode: string | null;
  /** The line amounts include GST. */
  taxInclusive: boolean;
  /**
   * What was sold: the sum of the invoice's `INVOICE_BODY_KINDS` lines, before
   * any discount and GST. Enrolment compares it, not the total, to tell a
   * plan or period change from a change of GST (design 5.2, 5.3).
   */
  bodyTotalPaise: number;
}

const textOf = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
const flagOf = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;
const intOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** A timestamp as text: node-postgres hands raw reads over as strings
 *  (lib/db/pg-types.ts), a test may hand over a Date. */
const instantOf = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : textOf(v);
const countryOf = (address: unknown): string | null =>
  address && typeof address === "object"
    ? textOf((address as Record<string, unknown>).country)
    : null;

/** The settings row's columns as `SnapshotRow` holds them. */
function settingsPart(r: Record<string, unknown> | null | undefined) {
  return {
    taxEnabled: flagOf(r?.taxEnabled) === true,
    taxInclusive: flagOf(r?.taxInclusive) === true,
    taxRateBps: intOf(r?.taxRateBps) ?? 0,
    nextTaxEnabled: flagOf(r?.nextTaxEnabled),
    nextTaxInclusive: flagOf(r?.nextTaxInclusive),
    nextTaxRateBps: intOf(r?.nextTaxRateBps),
    nextTaxStartsAt: instantOf(r?.nextTaxStartsAt),
    supplierGstin: textOf(r?.supplierGstin),
    supplierStateCode: textOf(r?.supplierStateCode),
    sacCode: textOf(r?.sacCode),
  };
}

/** The store's own records that may name its state (no lock needed). */
function storePart(r: Record<string, unknown> | null | undefined) {
  return {
    taxIdGstin: textOf(r?.tax_id),
    storeTaxStateCode: textOf(r?.business_state_code),
    // Taxes & invoices keeps the typed business address as one text value.
    taxAddress: textOf(r?.business_address),
    locationGstin: textOf(r?.location_gstin),
    locationStateCode: textOf(r?.location_state_code),
    signupStateName: textOf(r?.signup_state_name),
    signupCountry: textOf(r?.signup_country),
  };
}

/**
 * Everything one tax reading needs, in ONE statement: StoreMink's settings,
 * the merchant's Billing details, Taxes & invoices, the default location and
 * the signup address. A single statement sees one snapshot, so the GST terms
 * and the merchant's state can never come from two different moments.
 */
async function readSnapshotRow(db: Db, storeId: string): Promise<SnapshotRow> {
  const res = await db.execute(sql`
    select p.tax_enabled as "taxEnabled",
           p.tax_inclusive as "taxInclusive",
           p.tax_rate_bps as "taxRateBps",
           p.next_tax_enabled as "nextTaxEnabled",
           p.next_tax_inclusive as "nextTaxInclusive",
           p.next_tax_rate_bps as "nextTaxRateBps",
           p.next_tax_starts_at as "nextTaxStartsAt",
           p.gstin as "supplierGstin",
           p.state_code as "supplierStateCode",
           p.sac_code as "sacCode",
           a.gstin as account_gstin,
           a.state_code as account_state_code,
           a.address ->> 'country' as account_country,
           b.tax_id,
           b.business_state_code,
           b.business_address,
           l.gstin as location_gstin,
           l.state_code as location_state_code,
           s.settings -> 'business' ->> 'state' as signup_state_name,
           s.settings -> 'business' ->> 'country' as signup_country
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
  const r = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
  return {
    ...settingsPart(r),
    accountGstin: textOf(r?.account_gstin),
    accountStateCode: textOf(r?.account_state_code),
    accountCountry: textOf(r?.account_country),
    ...storePart(r),
  };
}

/**
 * The same reading while an invoice is being issued: the settings row and
 * then the merchant's billing account are read `for share`, so neither can
 * change before the issuing transaction commits and the parties trigger
 * that runs in it records the same GSTINs this reading stamped.
 */
async function readSnapshotRowLocked(
  db: Db,
  storeId: string,
): Promise<SnapshotRow> {
  const [settings] = await db
    .select({
      taxEnabled: platformBillingSettings.taxEnabled,
      taxInclusive: platformBillingSettings.taxInclusive,
      taxRateBps: platformBillingSettings.taxRateBps,
      nextTaxEnabled: platformBillingSettings.nextTaxEnabled,
      nextTaxInclusive: platformBillingSettings.nextTaxInclusive,
      nextTaxRateBps: platformBillingSettings.nextTaxRateBps,
      nextTaxStartsAt: platformBillingSettings.nextTaxStartsAt,
      supplierGstin: platformBillingSettings.gstin,
      supplierStateCode: platformBillingSettings.stateCode,
      sacCode: platformBillingSettings.sacCode,
    })
    .from(platformBillingSettings)
    .where(eq(platformBillingSettings.id, true))
    .for("share")
    .limit(1);
  const [account] = await db
    .select({
      gstin: billingAccounts.gstin,
      stateCode: billingAccounts.stateCode,
      address: billingAccounts.address,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.storeId, storeId))
    .for("share")
    .limit(1);
  const res = await db.execute(sql`
    select b.tax_id,
           b.business_state_code,
           b.business_address,
           l.gstin as location_gstin,
           l.state_code as location_state_code,
           s.settings -> 'business' ->> 'state' as signup_state_name,
           s.settings -> 'business' ->> 'country' as signup_country
      from (select 1) one
      left join public.store_billing_settings b on b.store_id = ${storeId}
      left join public.stores s on s.id = ${storeId}
      left join lateral (
        select gstin, state_code
          from public.store_locations
         where store_id = ${storeId} and is_default
         limit 1) l on true`);
  const store = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
  return {
    ...settingsPart(settings as Record<string, unknown> | undefined),
    accountGstin: textOf(account?.gstin),
    accountStateCode: textOf(account?.stateCode),
    accountCountry: countryOf(account?.address),
    ...storePart(store),
  };
}

/**
 * One tax reading for one store at an instant (GST design 5.2): the terms in
 * force, the builder's tax context and the particulars to stamp.
 *
 * Without `lock`, one statement. With `lock` (issuing), the settings row and
 * the billing account are read `for share` inside the caller's transaction,
 * then the other records. Every read is by primary key or an existing index.
 */
export async function readTaxSnapshot(
  db: Db,
  storeId: string,
  at: Date,
  opts: { lock?: boolean } = {},
): Promise<TaxSnapshot> {
  const row = opts.lock
    ? await readSnapshotRowLocked(db, storeId)
    : await readSnapshotRow(db, storeId);
  return resolveTaxSnapshot(row, at);
}

/**
 * `readTaxSnapshot` in its own service scope, for a caller about to build an
 * invoice.
 *
 * ★ A READ ERROR THROWS. There is no tax-off fallback any more: building an
 * invoice on a guess would charge the wrong GST, so an on-session payment is
 * refused and a renewal retries next hour. One scope, never nested
 * (lib/db/nested-scope-coverage.test.ts).
 */
export async function loadTaxSnapshot(
  storeId: string,
  at: Date,
): Promise<TaxSnapshot> {
  return withService((db) => readTaxSnapshot(db, storeId, at));
}

/** The five stamp columns as `billing_invoices` holds them. */
function stampColumns(stamp: InvoiceTaxStamp) {
  return {
    supplierGstin: stamp.supplierGstin,
    customerGstin: stamp.customerGstin,
    placeOfSupply: stamp.placeOfSupply,
    placeOfSupplyBasis: stamp.placeOfSupplyBasis,
    sacCode: stamp.sacCode,
  };
}

/** Shared shape for writing an invoice + its lines in one transaction. */
interface CreateInput {
  storeId: string;
  kind: "subscription" | "ai_credits" | "addon";
  built: BuiltInvoice;
  cycleSeq?: number | null;
  /** Addon only: the billed-location count this invoice buys. */
  addonTargetCount?: number | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  dueAt?: Date | null;
  /**
   * The tax reading's particulars (`readTaxSnapshot(...).stamp`), read at
   * build time and written whole: the draft keeps them, nothing re-reads
   * them, and the parties trigger copies the GSTINs and place of supply off
   * the row when the invoice is issued.
   */
  stamp: InvoiceTaxStamp;
}

async function insertInvoiceWithLines(
  db: Db,
  input: CreateInput,
): Promise<string | null> {
  const { built } = input;

  // ★ ON CONFLICT DO NOTHING against billing_invoices_one_per_cycle. Two
  // renewal workers racing on the same cycle: one inserts, the other gets zero
  // rows back and reads the winner's invoice instead of creating a second
  // obligation (spec §35). `.returning()` is empty on conflict, which is the
  // signal — not an error to catch.
  const inserted = await db
    .insert(billingInvoices)
    .values({
      storeId: input.storeId,
      kind: input.kind,
      status: "draft",
      subtotalPaise: built.subtotalPaise,
      discountPaise: built.discountPaise,
      taxPaise: built.taxPaise,
      totalPaise: built.totalPaise,
      taxRateBps: built.taxRateBps,
      cycleSeq: input.cycleSeq ?? null,
      addonTargetCount: input.addonTargetCount ?? null,
      periodStart: input.periodStart?.toISOString() ?? null,
      periodEnd: input.periodEnd?.toISOString() ?? null,
      dueAt: input.dueAt?.toISOString() ?? null,
      ...stampColumns(input.stamp),
      taxInclusive: built.inclusive,
    })
    .onConflictDoNothing()
    .returning({ id: billingInvoices.id });

  const id = inserted[0]?.id;
  if (!id) return null; // Someone else won the race.

  // Lines must land BEFORE finalization — the immutability trigger freezes them
  // the moment `finalized_at` is set.
  if (built.lines.length > 0) {
    await db.insert(billingInvoiceItems).values(
      built.lines.map((line, i) => ({
        invoiceId: id,
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unitAmountPaise: line.unitAmountPaise,
        amountPaise: line.amountPaise,
        sortOrder: i,
      })),
    );
  }
  return id;
}

/**
 * The renewal invoice for one cycle — created once, ever.
 *
 * ★ IDEMPOTENT ON (store, kind, cycle_seq), and the guarantee is the database's,
 * not this function's. Returns the EXISTING invoice when another worker got
 * there first, so a caller can always proceed with what it gets back rather
 * than having to distinguish "I made this" from "it was already there".
 *
 * ⚠ Creates it as a DRAFT. Finalization is separate and deliberate: it
 * allocates a gapless document number, so an invoice that is abandoned before
 * being issued must never burn one (§6).
 */
export async function ensureRenewalInvoice(input: {
  storeId: string;
  cycleSeq: number;
  periodStart: Date;
  periodEnd: Date;
  dueAt?: Date;
  built: BuiltInvoice;
  /** The tax reading's particulars, read when `built` was built. */
  stamp: InvoiceTaxStamp;
}): Promise<InvoiceRow | null> {
  try {
    return await withService(async (db) => {
      const id = await insertInvoiceWithLines(db, {
        storeId: input.storeId,
        kind: "subscription",
        built: input.built,
        cycleSeq: input.cycleSeq,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        dueAt: input.dueAt ?? null,
        stamp: input.stamp,
      });

      if (id) return readInvoice(db, id);

      // Lost the race — read the invoice that won.
      const [existing] = await selectInvoice(db).where(
        and(
          eq(billingInvoices.storeId, input.storeId),
          eq(billingInvoices.kind, "subscription"),
          eq(billingInvoices.cycleSeq, input.cycleSeq),
        ),
      );
      return existing ? toInvoiceRow(existing) : null;
    });
  } catch (err) {
    logError("billing.ensure_renewal_invoice", err, {
      storeId: input.storeId,
      cycleSeq: input.cycleSeq,
    });
    return null;
  }
}

/** The subscription invoice for one cycle, if it exists yet. */
export async function getCycleInvoice(
  storeId: string,
  cycleSeq: number,
): Promise<InvoiceRow | null> {
  try {
    return await withService(async (db) => {
      const [row] = await selectInvoice(db).where(
        and(
          eq(billingInvoices.storeId, storeId),
          eq(billingInvoices.kind, "subscription"),
          eq(billingInvoices.cycleSeq, cycleSeq),
        ),
      );
      return row ? toInvoiceRow(row) : null;
    });
  } catch (err) {
    logError("billing.get_cycle_invoice", err, { storeId, cycleSeq });
    return null;
  }
}

/**
 * Re-shape an UNPAID enrolment invoice to the plan and period now being bought.
 *
 * ★★ WHY THIS EXISTS. `ensureRenewalInvoice` is idempotent on
 * (store, kind, cycle_seq), which is exactly right for a RENEWAL — one cycle,
 * one obligation, however many workers race. It is wrong for an ENROLMENT,
 * where cycle 1's invoice is raised the moment a merchant first opens the
 * payment window and they are still free to change their mind. Without this,
 * the first shape they ever picked is the one they are charged: choose Pro
 * monthly, dismiss Checkout, come back and choose Pro YEARLY, and the ₹2,400
 * monthly invoice is silently reused while `billing_subscriptions` records
 * yearly — so paying ₹2,400 grants a full year (measured on production,
 * 2026-09-06: a ₹21,600 shortfall), and the reverse overcharges by ₹21,600.
 *
 * ★ The database already permits this: both immutability guards return early
 * while `finalized_at IS NULL`, because lines are deliberately written before
 * finalize. A draft carries no invoice number and has been sent to nobody, so
 * rewriting one destroys no document and burns nothing in the GST series.
 *
 * ★ REFUSES anything that is not a plain unpaid draft — finalized, paid, void,
 * uncollectible. Those are documents or debts, not a choice still being made.
 * Returns null rather than throwing so the caller can carry on with what it
 * already has instead of failing a sale over a shape mismatch.
 */
export async function reshapeDraftSubscriptionInvoice(input: {
  invoiceId: string;
  storeId: string;
  periodStart: Date;
  periodEnd: Date;
  dueAt?: Date | null;
  built: BuiltInvoice;
  /**
   * The tax reading the new shape was built with: its five particulars
   * replace the draft's, so the figures and the stamp always come from one
   * reading.
   */
  stamp: InvoiceTaxStamp;
}): Promise<InvoiceRow | null> {
  try {
    return await withService(async (db) => {
      // Lock it: a confirm settling this invoice must not interleave with a
      // rewrite of the amount it is settling.
      const [current] = await db
        .select({
          id: billingInvoices.id,
          status: billingInvoices.status,
          finalizedAt: billingInvoices.finalizedAt,
          paidAt: billingInvoices.paidAt,
        })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.id, input.invoiceId),
            // Scoped by store as well: an invoice id alone must never let one
            // merchant rewrite another's document.
            eq(billingInvoices.storeId, input.storeId),
          ),
        )
        .for("update")
        .limit(1);

      if (
        !current ||
        current.status !== "draft" ||
        current.finalizedAt !== null ||
        current.paidAt !== null
      ) {
        return null;
      }

      await db
        .delete(billingInvoiceItems)
        .where(eq(billingInvoiceItems.invoiceId, input.invoiceId));

      const { built } = input;
      if (built.lines.length > 0) {
        await db.insert(billingInvoiceItems).values(
          built.lines.map((line, i) => ({
            invoiceId: input.invoiceId,
            kind: line.kind,
            description: line.description,
            quantity: line.quantity,
            unitAmountPaise: line.unitAmountPaise,
            amountPaise: line.amountPaise,
            sortOrder: i,
          })),
        );
      }

      await db
        .update(billingInvoices)
        .set({
          subtotalPaise: built.subtotalPaise,
          discountPaise: built.discountPaise,
          taxPaise: built.taxPaise,
          totalPaise: built.totalPaise,
          taxRateBps: built.taxRateBps,
          taxInclusive: built.inclusive,
          ...stampColumns(input.stamp),
          periodStart: input.periodStart.toISOString(),
          periodEnd: input.periodEnd.toISOString(),
          dueAt: input.dueAt?.toISOString() ?? null,
        })
        .where(eq(billingInvoices.id, input.invoiceId));

      return readInvoice(db, input.invoiceId);
    });
  } catch (err) {
    logError("billing.reshape_draft_invoice", err, {
      invoiceId: input.invoiceId,
    });
    return null;
  }
}

/**
 * A one-time AI credit purchase invoice.
 *
 * ★ Its own document, always (spec §1). `cycle_seq` stays null, so the
 * one-per-cycle index does not apply and a merchant may buy credits as often as
 * they like — including while their subscription is in grace.
 */
export async function createAiCreditsInvoice(input: {
  storeId: string;
  built: BuiltInvoice;
  /** The tax reading's particulars, read when `built` was built. */
  stamp: InvoiceTaxStamp;
}): Promise<InvoiceRow | null> {
  try {
    return await withService(async (db) => {
      const id = await insertInvoiceWithLines(db, {
        storeId: input.storeId,
        kind: "ai_credits",
        built: input.built,
        cycleSeq: null,
        stamp: input.stamp,
      });
      return id ? readInvoice(db, id) : null;
    });
  } catch (err) {
    logError("billing.create_ai_credits_invoice", err, {
      storeId: input.storeId,
    });
    return null;
  }
}

/**
 * A mid-cycle add-on invoice (extra locations).
 *
 * ★ `targetCount` IS THE GRANT, recorded on the document. `confirm` is a public
 * server action, so reading the count from the client would let a caller be
 * granted more locations than it paid for; reading it from the invoice means it
 * can only ever be what the price was computed for.
 *
 * Deliberately NOT idempotent on anything: two purchases in one cycle are two
 * separate documents, which is why `billing_invoices_one_per_cycle` is partial on
 * `cycle_seq is not null` and an addon carries none.
 */
export async function createAddonInvoice(input: {
  storeId: string;
  built: BuiltInvoice;
  targetCount: number;
  /** The tax reading's particulars, read when `built` was built. */
  stamp: InvoiceTaxStamp;
}): Promise<InvoiceRow | null> {
  try {
    return await withService(async (db) => {
      const id = await insertInvoiceWithLines(db, {
        storeId: input.storeId,
        kind: "addon",
        built: input.built,
        cycleSeq: null,
        addonTargetCount: input.targetCount,
        stamp: input.stamp,
      });
      return id ? readInvoice(db, id) : null;
    });
  } catch (err) {
    logError("billing.create_addon_invoice", err, { storeId: input.storeId });
    return null;
  }
}

/** What `issueInvoice` did (GST design 5.4). */
export interface IssueResult {
  /** The invoice as it stands after the call; null when it does not exist or
   *  the issue failed. */
  invoice: InvoiceRow | null;
  /** This call issued it (the renewal email rides on this). */
  claimed: boolean;
  /**
   * What happened to the draft's tax particulars on the way:
   * `unchanged`: they already matched the reading (or there was nothing to
   * issue); `rebuilt`: the lines, money and stamp were written under the
   * terms in force, or the stamp alone when only a particular moved;
   * `carved`: a frozen total kept, with the GST carved out of it;
   * `kept_draft`: the draft's own figures were issued as built, because no
   * reading reproduces its frozen total or StoreMink's tax identity is
   * incomplete.
   */
  restamp: "unchanged" | "rebuilt" | "carved" | "kept_draft";
}

/**
 * A frozen draft issued with figures no reading at its time of supply
 * reproduces (R1-03): the tax it was built with and the tax in force.
 */
interface KeptDraftTax {
  draftRateBps: number;
  draftInclusive: boolean;
  rateBps: number;
  inclusive: boolean;
  totalPaise: number;
}

/** What `restampDraft` did, and what a person must look at when it kept the
 *  draft's own figures. */
interface RestampOutcome {
  restamp: IssueResult["restamp"];
  keptTax: KeptDraftTax | null;
}

/** The draft, as `issueInvoice` locks and judges it. */
interface DraftForIssue {
  id: string;
  storeId: string | null;
  kind: string;
  status: string;
  finalizedAt: string | null;
  discountPaise: number;
  totalPaise: number;
  taxRateBps: number | null;
  taxInclusive: boolean;
  supplierGstin: string | null;
  customerGstin: string | null;
  placeOfSupply: string | null;
  placeOfSupplyBasis: string | null;
  sacCode: string | null;
}

/** A collection status a paid one-time checkout may still be repaired from. */
const PAYABLE_CREDIT_STATUSES = ["draft", "open", "processing"];

/**
 * Is the invoice's total already fixed? A payment that is not failed or
 * cancelled may still settle it (or already has), and a credit purchase with
 * a gateway order was quoted this amount.
 *
 * ★ Read here, never trusted from a caller, so a manual payment of a draft
 * can never reprice an order already in flight.
 */
async function isFrozen(db: Db, invoiceId: string): Promise<boolean> {
  const res = await db.execute(sql`
    select (
      exists (select 1 from public.billing_payment_attempts a
               where a.invoice_id = ${invoiceId}
                 and a.state not in ('failed', 'cancelled'))
      or exists (select 1 from public.ai_credit_purchases p
                  where p.invoice_id = ${invoiceId}
                    and p.rzp_order_id is not null
                    and p.status <> 'failed')
    ) as frozen`);
  const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
  return row?.frozen === true;
}

function sameStamp(row: DraftForIssue, stamp: InvoiceTaxStamp): boolean {
  return (
    row.supplierGstin === stamp.supplierGstin &&
    row.customerGstin === stamp.customerGstin &&
    row.placeOfSupply === stamp.placeOfSupply &&
    row.placeOfSupplyBasis === stamp.placeOfSupplyBasis &&
    row.sacCode === stamp.sacCode
  );
}

/**
 * Step 5: bring a draft's tax particulars up to the reading taken for its
 * issue (P5). The total of a frozen draft never moves.
 *
 * ★ ONLY A CHANGE OF RATE OR PRICE MODE TOUCHES THE LINES. When the rate and
 * `tax_inclusive` already match, the money is already right and only the
 * five particulars are written; rebuilding then could only restate the same
 * lines. When they differ the lines are rebuilt by `rebuildForIssue`, which
 * re-prices an open draft and carves the GST out of a frozen one; when no
 * reading reproduces a frozen total the draft is issued as it was built
 * (P7: never leave money without an invoice), with a warning.
 */
async function restampDraft(
  db: Db,
  row: DraftForIssue,
  snap: TaxSnapshot,
  frozen: boolean,
  nowIso: string,
): Promise<RestampOutcome> {
  if (!snap.ok) {
    // The draft's stamp was valid when it was built (P7); it is issued as is.
    // Not filed for a person: StoreMink's own settings are what is missing,
    // and this ERROR already names it.
    logError(
      "billing.issue_tax_settings_incomplete",
      new Error("GST is charged but StoreMink's tax identity is incomplete"),
      { invoiceId: row.id },
    );
    return { restamp: "kept_draft", keptTax: null };
  }

  const rateBps = snap.tax.enabled ? snap.tax.rateBps : 0;
  const inclusive = snap.tax.enabled && snap.tax.inclusive;
  const moneyMoved =
    (row.taxRateBps ?? 0) !== rateBps || row.taxInclusive !== inclusive;

  if (!moneyMoved) {
    if (sameStamp(row, snap.stamp)) {
      return { restamp: "unchanged", keptTax: null };
    }
    await db
      .update(billingInvoices)
      .set({ ...stampColumns(snap.stamp), updatedAt: nowIso })
      .where(eq(billingInvoices.id, row.id));
    return { restamp: "rebuilt", keptTax: null };
  }

  const stored = await db
    .select({
      kind: billingInvoiceItems.kind,
      description: billingInvoiceItems.description,
      quantity: billingInvoiceItems.quantity,
      unitAmountPaise: billingInvoiceItems.unitAmountPaise,
      amountPaise: billingInvoiceItems.amountPaise,
    })
    .from(billingInvoiceItems)
    .where(eq(billingInvoiceItems.invoiceId, row.id))
    .orderBy(asc(billingInvoiceItems.sortOrder));
  const lines: InvoiceLine[] = stored.map((l) => ({
    kind: l.kind as InvoiceLine["kind"],
    description: l.description,
    quantity: Number(l.quantity),
    unitAmountPaise: Number(l.unitAmountPaise),
    amountPaise: Number(l.amountPaise),
  }));

  const rebuilt = rebuildForIssue({
    lines,
    discountPaise: Number(row.discountPaise),
    tax: snap.tax,
    frozenTotalPaise: frozen ? Number(row.totalPaise) : null,
  });
  if (!rebuilt) {
    logWarn("billing.issue_kept_draft_tax", {
      invoiceId: row.id,
      draftRateBps: row.taxRateBps ?? 0,
      rateBps,
    });
    // ★ Only a frozen total can make the rebuild refuse, so this is money
    // already quoted or taken at a tax no longer in force: `issueInvoice`
    // files it for a person (R1-03).
    return {
      restamp: "kept_draft",
      keptTax: {
        draftRateBps: row.taxRateBps ?? 0,
        draftInclusive: row.taxInclusive,
        rateBps,
        inclusive,
        totalPaise: Number(row.totalPaise),
      },
    };
  }

  await db
    .delete(billingInvoiceItems)
    .where(eq(billingInvoiceItems.invoiceId, row.id));
  if (rebuilt.lines.length > 0) {
    await db.insert(billingInvoiceItems).values(
      rebuilt.lines.map((line, i) => ({
        invoiceId: row.id,
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unitAmountPaise: line.unitAmountPaise,
        amountPaise: line.amountPaise,
        sortOrder: i,
      })),
    );
  }
  await db
    .update(billingInvoices)
    .set({
      subtotalPaise: rebuilt.subtotalPaise,
      discountPaise: rebuilt.discountPaise,
      taxPaise: rebuilt.taxPaise,
      totalPaise: rebuilt.totalPaise,
      taxRateBps: rebuilt.taxRateBps,
      taxInclusive: rebuilt.inclusive,
      ...stampColumns(snap.stamp),
      updatedAt: nowIso,
    })
    .where(eq(billingInvoices.id, row.id));
  return { restamp: rebuilt.carved ? "carved" : "rebuilt", keptTax: null };
}

/** "18% added", "18% included", or "no GST", for the person reading the note. */
function taxWords(rateBps: number, inclusive: boolean): string {
  if (rateBps <= 0) return "no GST";
  return `${rateBps / 100}% GST ${inclusive ? "included" : "added"}`;
}

/**
 * ★ File a frozen draft issued at a tax no longer in force (R1-03), ONCE: the
 * repair key `kept_draft:<invoice>` is unique in every status
 * (`billing_reconciliation_repair_once`), so a retried issue files nothing new
 * and an item a person closed is never filed again.
 *
 * ★ After the issue commits, in its own scope and best-effort: a failure here
 * must never undo an issued invoice (P7), and the WARN the restamp logged is
 * still there. The payment is named in the order column and the note, never
 * the payment column, because the open key (kind, payment) would drop this
 * item behind another open item about the same payment.
 */
async function fileKeptDraft(input: {
  invoiceId: string;
  storeId: string | null;
  kept: KeptDraftTax;
  now: Date;
}): Promise<void> {
  const { kept } = input;
  try {
    await withService(async (db) => {
      const [attempt] = await db
        .select({
          id: billingPaymentAttempts.id,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          providerPaymentId: billingPaymentAttempts.providerPaymentId,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, input.invoiceId),
            notInArray(billingPaymentAttempts.state, ["failed", "cancelled"]),
          ),
        )
        .orderBy(
          sql`(${billingPaymentAttempts.state} = 'captured') desc`,
          desc(billingPaymentAttempts.createdAt),
        )
        .limit(1);
      const payment = attempt?.providerPaymentId ?? null;
      const note =
        `This invoice was issued with ${taxWords(kept.draftRateBps, kept.draftInclusive)}, ` +
        `the tax it was priced with, because its total was already fixed by a payment. ` +
        `The tax in force when it was issued is ${taxWords(kept.rateBps, kept.inclusive)}. ` +
        `Decide whether to issue a credit note or refund the difference` +
        (payment ? ` (payment ${payment}).` : ".");
      const rows = await db
        .insert(billingReconciliationItems)
        .values({
          storeId: input.storeId,
          kind: "state_conflict",
          status: "open",
          invoiceId: input.invoiceId,
          attemptId: attempt?.id ?? null,
          providerOrderId: attempt?.providerOrderId ?? null,
          expectedPaise: kept.totalPaise,
          detail: {
            repair_key: `kept_draft:${input.invoiceId}`,
            note,
            draft_rate_bps: kept.draftRateBps,
            draft_inclusive: kept.draftInclusive,
            rate_bps: kept.rateBps,
            inclusive: kept.inclusive,
            total_paise: kept.totalPaise,
            provider_payment_id: payment,
          },
          createdAt: input.now.toISOString(),
          updatedAt: input.now.toISOString(),
        })
        .onConflictDoNothing()
        .returning({ id: billingReconciliationItems.id });
      if (rows.length > 0) {
        logWarn("billing.issue_kept_draft_filed", {
          invoiceId: input.invoiceId,
          storeId: input.storeId,
          draftRateBps: kept.draftRateBps,
          rateBps: kept.rateBps,
        });
      }
    });
  } catch (err) {
    logError("billing.issue_kept_draft_file", loggableError(err), {
      invoiceId: input.invoiceId,
    });
  }
}

/**
 * Issue an invoice: bring its draft up to the GST in force, then stamp
 * `finalized_at`, which fires the triggers that allocate the gapless number,
 * record the parties and refuse a taxed invoice missing a particular
 * (GST design 5.4).
 *
 * One transaction:
 * 1. lock the invoice (none: `invoice` null);
 * 2. already issued: a paid one-time credit checkout is repaired to `paid`
 *    (`paid`, kind `ai_credits`, status draft, open or processing); nothing
 *    else changes, `claimed` false;
 * 3. frozen = `paid`, or a payment or credit order already exists for it;
 * 4. the tax reading, at the payment's instant for a frozen invoice paid
 *    before now (time of supply), else now, with the settings row and the
 *    billing account locked `for share`;
 * 5. restamp the draft (`restampDraft`);
 * 6. claim it: only `status = 'draft' and finalized_at is null`, renewal-
 *    cancel's rule, so a draft someone closed by hand (`void`,
 *    `uncollectible`) is never reopened or numbered;
 * 7. read it back.
 *
 * ★ `paid` is honoured only for an `ai_credits` invoice: this shortcut must
 * never mark a subscription paid without a captured billing attempt.
 *
 * Never throws: a failure is logged and reported as `invoice` null, and the
 * hourly repair pass issues a captured draft later.
 */
export async function issueInvoice(input: {
  invoiceId: string;
  now?: Date;
  /** One-time checkout already captured: issue it as paid (AI credits). */
  paid?: boolean;
  /**
   * When the gateway captured the payment this invoice is for, if that was
   * before now (a late confirm, the reconcile sweep, the repair pass). The
   * tax terms of a frozen invoice are read at this instant.
   */
  paidAt?: Date;
}): Promise<IssueResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const paid = input.paid === true;
  const paidIso = (input.paidAt ?? now).toISOString();
  // Set inside the transaction, filed after it commits (R1-03).
  const toFile: {
    value: { storeId: string | null; kept: KeptDraftTax } | null;
  } = { value: null };
  try {
    const result = await withService(async (db): Promise<IssueResult> => {
      const [row] = (await db
        .select({
          id: billingInvoices.id,
          storeId: billingInvoices.storeId,
          kind: billingInvoices.kind,
          status: billingInvoices.status,
          finalizedAt: billingInvoices.finalizedAt,
          discountPaise: billingInvoices.discountPaise,
          totalPaise: billingInvoices.totalPaise,
          taxRateBps: billingInvoices.taxRateBps,
          taxInclusive: billingInvoices.taxInclusive,
          supplierGstin: billingInvoices.supplierGstin,
          customerGstin: billingInvoices.customerGstin,
          placeOfSupply: billingInvoices.placeOfSupply,
          placeOfSupplyBasis: billingInvoices.placeOfSupplyBasis,
          sacCode: billingInvoices.sacCode,
        })
        .from(billingInvoices)
        .where(eq(billingInvoices.id, input.invoiceId))
        .for("update")
        .limit(1)) as DraftForIssue[];
      if (!row) return { invoice: null, claimed: false, restamp: "unchanged" };

      const asItIs = async (): Promise<IssueResult> => ({
        invoice: await readInvoice(db, row.id),
        claimed: false,
        restamp: "unchanged",
      });

      if (paid && row.kind !== "ai_credits") return asItIs();

      if (row.finalizedAt !== null) {
        if (paid && PAYABLE_CREDIT_STATUSES.includes(row.status)) {
          await db
            .update(billingInvoices)
            .set({
              paidAt: sql`coalesce(${billingInvoices.paidAt}, ${paidIso}::timestamptz)`,
              status: "paid",
              updatedAt: nowIso,
            })
            .where(
              and(
                eq(billingInvoices.id, row.id),
                eq(billingInvoices.kind, "ai_credits"),
                inArray(billingInvoices.status, PAYABLE_CREDIT_STATUSES),
              ),
            );
        }
        return asItIs();
      }

      // A closed draft is never issued; nothing about it is touched.
      if (row.status !== "draft") return asItIs();

      const frozen = paid || (await isFrozen(db, row.id));
      const termsInstant =
        frozen && input.paidAt && input.paidAt.getTime() < now.getTime()
          ? input.paidAt
          : now;

      // A draft kept after its store was deleted has no records to read:
      // it is issued with the particulars it was built with.
      const outcome: RestampOutcome = row.storeId
        ? await restampDraft(
            db,
            row,
            await readTaxSnapshot(db, row.storeId, termsInstant, {
              lock: true,
            }),
            frozen,
            nowIso,
          )
        : { restamp: "unchanged", keptTax: null };
      const restamp = outcome.restamp;

      const claimed = await db
        .update(billingInvoices)
        .set({
          finalizedAt: nowIso,
          status: paid ? "paid" : "open",
          ...(paid
            ? {
                paidAt: sql`coalesce(${billingInvoices.paidAt}, ${paidIso}::timestamptz)`,
              }
            : {}),
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(billingInvoices.id, row.id),
            eq(billingInvoices.status, "draft"),
            sql`${billingInvoices.finalizedAt} is null`,
          ),
        )
        .returning({ id: billingInvoices.id });

      if (claimed.length > 0 && outcome.keptTax) {
        toFile.value = { storeId: row.storeId, kept: outcome.keptTax };
      }
      return {
        invoice: await readInvoice(db, row.id),
        claimed: claimed.length > 0,
        restamp,
      };
    });
    if (toFile.value) {
      await fileKeptDraft({
        invoiceId: input.invoiceId,
        storeId: toFile.value.storeId,
        kept: toFile.value.kept,
        now,
      });
    }
    return result;
  } catch (err) {
    logError("billing.issue_invoice", err, { invoiceId: input.invoiceId });
    return { invoice: null, claimed: false, restamp: "unchanged" };
  }
}

/**
 * Issue the invoice and open it for collection (`issueInvoice`), returning
 * it either way: a lost claim is not an error, it means someone else already
 * issued it.
 */
export async function finalizeInvoice(
  invoiceId: string,
  now: Date = new Date(),
  paidAt?: Date,
): Promise<InvoiceRow | null> {
  return (await finalizeInvoiceClaimed(invoiceId, now, paidAt)).invoice;
}

/**
 * Issue, and say whether THIS call was the one that did it.
 *
 * ★ "I issued it" and "I observed it issued" are different facts. The renewal
 * worker mails the merchant here, and `claimDue` deliberately takes no lock,
 * so two overlapping runs would otherwise send the same bill twice. The
 * conditional claim in `issueInvoice` (step 6) is how we hear about it.
 *
 * ★★ ONLY A DRAFT IS ISSUED. The claim requires `status = 'draft'` as well as
 * a null `finalized_at`: issuing allocates the invoice number, so without the
 * status condition a draft someone closed by hand (`void`, `uncollectible`)
 * would be reopened as payable and numbered in the gapless series. A refused
 * claim reads the invoice back as it is and reports `claimed: false`.
 */
export async function finalizeInvoiceClaimed(
  invoiceId: string,
  now: Date = new Date(),
  paidAt?: Date,
): Promise<{ invoice: InvoiceRow | null; claimed: boolean }> {
  const { invoice, claimed } = await issueInvoice({ invoiceId, now, paidAt });
  return { invoice, claimed };
}

/**
 * Issue an AI-credit invoice after its one-time checkout has already settled.
 *
 * ★★ THIS IS NOT A COLLECTIBLE INVOICE. Razorpay captured the purchase before
 * `settlePurchase` calls us, so moving it through the subscription
 * `open`, `processing`, `paid` collection states would present the same money
 * as debt and could charge it a second time. A draft is issued and marked
 * paid in ONE update; an older `open` row is repaired without changing its
 * original issue time. Only an `ai_credits` invoice is ever marked paid here.
 */
export async function finalizePaidAiCreditsInvoice(
  invoiceId: string,
  now: Date = new Date(),
  paidAt?: Date,
): Promise<InvoiceRow | null> {
  return (await issueInvoice({ invoiceId, now, paid: true, paidAt })).invoice;
}

function selectInvoice(db: Db) {
  return db
    .select({
      id: billingInvoices.id,
      storeId: billingInvoices.storeId,
      kind: billingInvoices.kind,
      status: billingInvoices.status,
      totalPaise: billingInvoices.totalPaise,
      cycleSeq: billingInvoices.cycleSeq,
      invoiceRef: billingInvoices.invoiceRef,
      finalizedAt: billingInvoices.finalizedAt,
      periodStart: billingInvoices.periodStart,
      periodEnd: billingInvoices.periodEnd,
      taxPaise: billingInvoices.taxPaise,
      taxRateBps: billingInvoices.taxRateBps,
      supplierGstin: billingInvoices.supplierGstin,
      customerGstin: billingInvoices.customerGstin,
      placeOfSupply: billingInvoices.placeOfSupply,
      placeOfSupplyBasis: billingInvoices.placeOfSupplyBasis,
      sacCode: billingInvoices.sacCode,
      taxInclusive: billingInvoices.taxInclusive,
      // ⚠ The outer table is named BY HAND: Drizzle writes a select list's
      // columns without their table, so `${billingInvoices.id}` would render
      // as a bare "id" and match the line's own id inside the subquery.
      bodyTotalPaise: sql<string | number>`(
        select coalesce(sum(bii.amount_paise), 0)
          from public.billing_invoice_items bii
         where bii.invoice_id = "billing_invoices"."id"
           and bii.kind = any(${sql.param([...INVOICE_BODY_KINDS])}))`,
    })
    .from(billingInvoices);
}

const DB_BASES: ReadonlyArray<DbPlaceOfSupplyBasis> = [
  "recipient",
  "supplier",
  "outside_india",
];

/** The stored basis, or null for an older invoice (or one this code does not know). */
function basisOf(value: unknown): DbPlaceOfSupplyBasis | null {
  return DB_BASES.includes(value as DbPlaceOfSupplyBasis)
    ? (value as DbPlaceOfSupplyBasis)
    : null;
}

/**
 * Narrow the DB's `kind: string` to the union.
 *
 * ★ A real check, not a cast. `kind` is CHECK-constrained in Postgres, so an
 * unexpected value means the constraint was dropped or a new kind was added
 * without updating this file — either way, returning null beats handing a
 * caller a row whose type is a lie.
 */
function toInvoiceRow(row: {
  id: string;
  storeId: string | null;
  kind: string;
  status: string;
  totalPaise: number;
  cycleSeq: number | null;
  invoiceRef: string | null;
  finalizedAt: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  taxPaise?: number | string | null;
  taxRateBps?: number | null;
  supplierGstin?: string | null;
  customerGstin?: string | null;
  placeOfSupply?: string | null;
  placeOfSupplyBasis?: string | null;
  sacCode?: string | null;
  taxInclusive?: boolean | null;
  bodyTotalPaise?: string | number | null;
}): InvoiceRow | null {
  if (
    row.kind !== "subscription" &&
    row.kind !== "ai_credits" &&
    row.kind !== "addon"
  ) {
    return null;
  }
  return {
    id: row.id,
    storeId: row.storeId,
    kind: row.kind,
    status: row.status,
    totalPaise: row.totalPaise,
    cycleSeq: row.cycleSeq,
    invoiceRef: row.invoiceRef,
    finalizedAt: row.finalizedAt,
    periodStart: row.periodStart ?? null,
    periodEnd: row.periodEnd ?? null,
    taxPaise: Number(row.taxPaise ?? 0),
    taxRateBps: Number(row.taxRateBps ?? 0),
    supplierGstin: row.supplierGstin ?? null,
    customerGstin: row.customerGstin ?? null,
    placeOfSupply: row.placeOfSupply ?? null,
    placeOfSupplyBasis: basisOf(row.placeOfSupplyBasis),
    sacCode: row.sacCode ?? null,
    taxInclusive: row.taxInclusive === true,
    // A bigint sum arrives as text from the driver.
    bodyTotalPaise: Number(row.bodyTotalPaise ?? 0),
  };
}

async function readInvoice(db: Db, id: string): Promise<InvoiceRow | null> {
  const [row] = await selectInvoice(db).where(eq(billingInvoices.id, id));
  return row ? toInvoiceRow(row) : null;
}

/** One invoice by id. */
export async function getInvoice(
  invoiceId: string,
): Promise<InvoiceRow | null> {
  try {
    return await withService((db) => readInvoice(db, invoiceId));
  } catch (err) {
    logError("billing.get_invoice", err, { invoiceId });
    return null;
  }
}

/**
 * What must actually be collected: the invoice total less any account credit
 * already applied to it.
 *
 * ★ Credit is a PAYMENT, not a discount (§29), so it is NOT netted into
 * `total_paise` — the invoice keeps the full value of what was sold and this is
 * where the reduction happens. Deriving it on read means there is no
 * "credit_applied" column to forget to clear.
 *
 * ⚠ Returns null on a read failure rather than the full total. Quoting the full
 * amount when credit may already have been applied would double-charge, which
 * is the one outcome worth refusing to guess at (Rule 10).
 */
export async function amountDueForInvoice(
  invoiceId: string,
): Promise<number | null> {
  try {
    return await withService(async (db) => {
      const invoice = await readInvoice(db, invoiceId);
      if (!invoice) return null;

      const [applied] = await db
        .select({
          total: sql<number>`coalesce(sum(${billingCredits.deltaPaise}), 0)::int`,
        })
        .from(billingCredits)
        .where(
          and(
            eq(billingCredits.invoiceId, invoiceId),
            eq(billingCredits.kind, "applied"),
          ),
        );

      // `applied` credits are stored NEGATIVE (they reduce what is owed), so the
      // magnitude is what offsets the total.
      const creditPaise = Math.abs(Number(applied?.total ?? 0));
      return Math.max(
        0,
        invoice.totalPaise - Math.min(creditPaise, invoice.totalPaise),
      );
    });
  } catch (err) {
    logError("billing.amount_due", err, { invoiceId });
    return null;
  }
}
