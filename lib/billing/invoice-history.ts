import "server-only";

/**
 * A merchant's own subscription invoices — the list, and one document (§34).
 *
 * ★★ WHY THIS HAD TO EXIST. The gapless per-FY invoice series, the immutability
 * triggers and the tax snapshot all exist to produce a document a merchant can
 * put in front of their accountant. Until now nothing could retrieve one: the
 * only reader was `listPayableInvoices`, which shows what is OWED. A merchant who
 * had paid ₹50,000 for a year had no receipt.
 *
 * ★ ONLY FINALIZED INVOICES ARE DOCUMENTS. A `draft` has no number — the trigger
 * allocates one on finalize precisely so an abandoned checkout does not burn one
 * — so a draft is not a thing a merchant can be shown or asked about. Enrolment
 * and add-on purchases both leave drafts behind when the payment window is
 * closed, and those must stay invisible.
 *
 * ★ EVERY READ IS SCOPED BY STORE as well as by id. An invoice id alone must
 * never reach across tenants — not to view, not to learn an amount. (So an
 * invoice kept after its store was deleted, `store_id` NULL since 0243, is
 * reachable by nobody here; it is kept for StoreMink's own records.)
 *
 * ★ A REFUND NEVER CHANGES ITS INVOICE (renewal-cancel rule R9). A refunded
 * paid invoice stays `paid` and a refunded void one stays `void`; what was
 * refunded is read from `billing_refunds` beside it (`refunds` on each row
 * and document, and the refunds notice), and the credit notes issued against
 * it from `billing_credit_notes` (`credits` on the document).
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  billingCreditNotes,
  billingInvoiceItems,
  billingInvoices,
  billingRefunds,
} from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import { countryName } from "@/lib/countries";
import { recipientStateFor, stateCodeFromGstin } from "./gst";
import type {
  InvoiceAddress,
  InvoiceDocument,
  InvoiceSummary,
  RecordedInvoiceParties,
  RecordedInvoiceParty,
} from "./invoice-types";

/**
 * Statuses that mean "this is a real, issued document".
 *
 * `refunded` and `partially_refunded` are labels only (renewal-cancel rule
 * R9): nothing writes them, because a refund never changes its invoice's
 * status. They are listed so an invoice somebody moved by hand still opens.
 */
const ISSUED = [
  "open",
  "processing",
  "paid",
  "uncollectible",
  "void",
  "refunded",
  "partially_refunded",
];

// ── Refunds against an invoice (renewal-cancel, design 6.9 and 8.5) ─────────

/** What has been refunded against one invoice, as the list and the sheet
 *  show it. */
export type InvoiceRefundSummary = InvoiceSummary["refunds"];

/** No refund at all: the summary of an invoice nobody has refunded. */
export const NO_REFUNDS: InvoiceRefundSummary = {
  refundedPaise: 0,
  extraReturnedPaise: 0,
  inProgressPaise: 0,
  inProgress: false,
  delayed: false,
};

/** One `billing_refunds` row, as the summary reads it. */
export interface InvoiceRefundFact {
  attemptId: string;
  reason: string;
  status: string;
  amountPaise: number;
  /** The database's own timestamp text. */
  createdAt: string;
}

/** The money went back: Razorpay processed it, or a person recorded a refund
 *  made outside StoreMink. */
const MONEY_RETURNED = new Set(["processed", "recorded"]);
/** On its way: written and not yet answered. */
const ON_ITS_WAY = new Set(["owed", "pending"]);
/** A returned duplicate payment reduces no supply: it is an extra payment
 *  given back, never a refund of the invoice (and it carries no credit note). */
const DUPLICATE_PAYMENT = "duplicate_payment";

function instant(text: string): number {
  const at = Date.parse(text);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/**
 * Sum one invoice's refunds into what the merchant is shown.
 *
 * ★ Only processed and recorded refunds are money returned. An owed or
 * pending refund is on its way, and a failed or cancelled one moved nothing,
 * so counting either as returned would tell a merchant they had money back
 * that never left (refunds.ts's own rule, RC7 report section 5).
 *
 * ★ `delayed` is the console's "Needs a person" rule for a failed refund: it
 * failed, and no refund of the same payment was written after it. A failed
 * refund someone has since retried, recorded or cancelled is settled, not
 * delayed.
 */
export function summarizeInvoiceRefunds(
  rows: readonly InvoiceRefundFact[],
): InvoiceRefundSummary {
  let refundedPaise = 0;
  let extraReturnedPaise = 0;
  let inProgressPaise = 0;
  let delayed = false;
  for (const row of rows) {
    const amount = Number.isFinite(row.amountPaise) ? row.amountPaise : 0;
    if (MONEY_RETURNED.has(row.status)) {
      if (row.reason === DUPLICATE_PAYMENT) extraReturnedPaise += amount;
      else refundedPaise += amount;
    } else if (ON_ITS_WAY.has(row.status)) {
      inProgressPaise += amount;
    } else if (row.status === "failed" && !delayed) {
      const failedAt = instant(row.createdAt);
      const retried = rows.some(
        (other) =>
          other !== row &&
          other.attemptId === row.attemptId &&
          instant(other.createdAt) > failedAt,
      );
      if (!retried) delayed = true;
    }
  }
  return {
    refundedPaise,
    extraReturnedPaise,
    inProgressPaise,
    inProgress: inProgressPaise > 0,
    delayed,
  };
}

const REFUND_FACT_COLUMNS = {
  invoiceId: billingRefunds.invoiceId,
  attemptId: billingRefunds.attemptId,
  reason: billingRefunds.reason,
  status: billingRefunds.status,
  amountPaise: billingRefunds.amountPaise,
  createdAt: billingRefunds.createdAt,
};

/**
 * The refunds of the given invoices, grouped by invoice and summed.
 *
 * ★ ITS OWN SCOPE, AND IT NEVER THROWS. The invoice is the legal document and
 * must open even when its refunds cannot be read, so a failure here is logged
 * and every invoice reads as unrefunded: wrong but harmless, the
 * `listInvoices` rule. A read inside the invoice's own transaction would take
 * the invoice down with it.
 *
 * ★ Scoped through the invoices: `billing_refunds` has no store column, and
 * the ids come from a read that was already store-scoped.
 */
async function readRefundSummaries(
  invoiceIds: string[],
): Promise<Map<string, InvoiceRefundSummary>> {
  const summaries = new Map<string, InvoiceRefundSummary>();
  if (invoiceIds.length === 0) return summaries;
  try {
    const rows = await withService(async (db) =>
      db
        .select(REFUND_FACT_COLUMNS)
        .from(billingRefunds)
        .where(inArray(billingRefunds.invoiceId, invoiceIds)),
    );
    const byInvoice = new Map<string, InvoiceRefundFact[]>();
    for (const row of rows) {
      const list = byInvoice.get(row.invoiceId) ?? [];
      list.push({
        attemptId: row.attemptId,
        reason: row.reason,
        status: row.status,
        amountPaise: Number(row.amountPaise),
        createdAt: row.createdAt,
      });
      byInvoice.set(row.invoiceId, list);
    }
    for (const [invoiceId, list] of byInvoice) {
      summaries.set(invoiceId, summarizeInvoiceRefunds(list));
    }
  } catch (err) {
    logError("billing.list_invoice_refunds", err, {
      invoices: invoiceIds.length,
    });
  }
  return summaries;
}

/**
 * The merchant's issued invoices, newest first.
 *
 * Returns [] on a read failure — the page shows "no invoices yet", which is
 * wrong but harmless, where throwing would take down a page that also carries
 * their plan and their AI usage.
 */
export async function listInvoices(
  storeId: string,
  limit = 50,
): Promise<InvoiceSummary[]> {
  let invoices: Omit<InvoiceSummary, "refunds">[];
  try {
    invoices = await withService(async (db) =>
      db
        .select({
          id: billingInvoices.id,
          invoiceRef: billingInvoices.invoiceRef,
          kind: billingInvoices.kind,
          status: billingInvoices.status,
          totalPaise: billingInvoices.totalPaise,
          taxPaise: billingInvoices.taxPaise,
          periodStart: billingInvoices.periodStart,
          periodEnd: billingInvoices.periodEnd,
          finalizedAt: billingInvoices.finalizedAt,
          paidAt: billingInvoices.paidAt,
        })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.storeId, storeId),
            // ★ A finalized invoice always has a ref (the trigger allocates one),
            // so this is belt and braces on the status filter — and it is what
            // guarantees every row in the list can be linked to.
            isNotNull(billingInvoices.finalizedAt),
          ),
        )
        .orderBy(desc(billingInvoices.finalizedAt))
        .limit(limit),
    );
  } catch (err) {
    logError("billing.list_invoices", err, { storeId });
    return [];
  }
  const refunds = await readRefundSummaries(invoices.map((inv) => inv.id));
  return invoices.map((inv) => ({
    ...inv,
    // A row read without the column (an older caller's mock) is untaxed.
    taxPaise: Number(inv.taxPaise) || 0,
    refunds: refunds.get(inv.id) ?? NO_REFUNDS,
  }));
}

const ADDRESS_FIELDS = ["line1", "line2", "city", "postalCode"] as const;

function plainText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readAddress(value: unknown): InvoiceAddress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const fields = value as Record<string, unknown>;
  const out: InvoiceAddress = {};
  for (const key of ADDRESS_FIELDS) {
    const line = plainText(fields[key]);
    if (line) out[key] = line;
  }
  return out;
}

/** A recorded country (migration 0266): an ISO code, and a name when given. */
function readCountry(value: unknown): { code: string; name?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const code = plainText(fields.code);
  if (!code) return null;
  const name = plainText(fields.name);
  return name ? { code, name } : { code };
}

function readParty(value: unknown): RecordedInvoiceParty | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const party = value as Record<string, unknown>;
  const out: RecordedInvoiceParty = {
    name: plainText(party.name),
    gstin: plainText(party.gstin),
    stateCode: plainText(party.stateCode),
    address: readAddress(party.address),
  };
  // Recorded since migration 0266, and only present when they hold a value,
  // so a record written before it reads back exactly as it was written.
  const llpin = plainText(party.llpin);
  if (llpin) out.llpin = llpin;
  const registeredOffice = plainText(party.registeredOffice);
  if (registeredOffice) out.registeredOffice = registeredOffice;
  const country = readCountry(party.country);
  if (country) out.country = country;
  return out;
}

/**
 * The country line's name: the recorded name, else the catalog's name for the
 * code. "Other" names no country, so it prints nothing without a recorded name.
 */
function recordedCountryName(
  country: RecordedInvoiceParty["country"],
): string | null {
  if (!country) return null;
  if (country.name) return country.name;
  if (country.code.toUpperCase() === "OTHER") return null;
  return countryName(country.code);
}

/**
 * Read a recorded `billing_invoices.parties` value (migration 0243).
 *
 * ★ STRICT ON SHAPE, LENIENT ON CONTENT. Anything that is not a version-1
 * object with both parties returns null, and the document then reads today's
 * settings rather than print a half-understood record. A missing or blank
 * field inside a party is simply absent: the record keeps what the settings
 * held, and an unconfigured legal name was NULL then as well.
 */
export function parseInvoiceParties(
  raw: unknown,
): RecordedInvoiceParties | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  const supplier = readParty(record.supplier);
  const customer = readParty(record.customer);
  if (!supplier || !customer) return null;
  return {
    version: 1,
    capturedAt: plainText(record.capturedAt),
    supplier,
    customer: {
      ...customer,
      email: plainText((record.customer as Record<string, unknown>).email),
    },
  };
}

/**
 * The parties as TODAY's settings would record them.
 *
 * ★ THE SAME SQL FUNCTION THE ISSUING TRIGGER CALLS, so the fallback can never
 * name a party the record would not have: one definition of who an invoice is
 * from and to, in one place. The GSTINs and the place of supply are the row's
 * own, passed in, exactly as the trigger passes them: the merchant's State
 * is the place of supply only when it came from the merchant's own records
 * (`recipientStateFor`), so a supplier fallback or 96 records none (0266).
 */
async function currentInvoiceParties(
  db: Db,
  inv: {
    storeId: string | null;
    supplierGstin: string | null;
    customerGstin: string | null;
    placeOfSupply: string | null;
    placeOfSupplyBasis: string | null;
  },
): Promise<RecordedInvoiceParties | null> {
  const customerState = recipientStateFor(inv);
  const res = await db.execute(
    sql`select public.billing_invoice_parties(${inv.storeId}::uuid, ${inv.supplierGstin}::text, ${inv.customerGstin}::text, ${customerState}::text) as parties`,
  );
  return parseInvoiceParties(
    (res.rows?.[0] as { parties?: unknown } | undefined)?.parties,
  );
}

/**
 * One invoice, rendered from its OWN snapshot.
 *
 * ★★ THE TAX FIGURES AND IDENTIFIERS COME FROM THE INVOICE ROW, never from live
 * settings. That is the whole point of stamping them: an operator turning GST on,
 * changing the rate or correcting a GSTIN in September must not rewrite what
 * April's invoice says it charged.
 *
 * ★★ THE NAMES AND ADDRESSES COME FROM `parties`, recorded when the invoice was
 * issued (migration 0243). Before it they were read live, so a rename restated
 * the label on every old invoice, and a deleted store's invoice could no longer
 * say who it was issued to. Every issued invoice has a record (a trigger writes
 * it, and 0243 backfilled older ones from the settings as they stood then);
 * only a missing or unreadable one falls back to today's settings, through the
 * same SQL function.
 */
export async function getInvoiceDocument(
  storeId: string,
  invoiceId: string,
): Promise<InvoiceDocument | null> {
  let doc: Omit<InvoiceDocument, "credits" | "refunds"> | null;
  try {
    doc = await withService(async (db) => {
      const [inv] = await db
        .select()
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.id, invoiceId),
            // Scoped by store: an id alone must never cross tenants.
            eq(billingInvoices.storeId, storeId),
          ),
        )
        .limit(1);
      // A draft is not a document — no number, and it may never become one.
      if (!inv || !inv.finalizedAt || !ISSUED.includes(inv.status)) return null;

      const recorded = parseInvoiceParties(inv.parties);
      if (inv.parties != null && !recorded) {
        // The trigger only ever writes the shape the parser reads, so this is
        // a record somebody edited by hand: say so rather than print it.
        logWarn("billing.invoice_parties_unreadable", { invoiceId: inv.id });
      }

      // ★ ONE AFTER THE OTHER, never Promise.all: both statements run on this
      // scope's one pooled client, and pg warns when a second query is issued
      // on a client still busy with the first (it queues them anyway).
      const items = await db
        .select({
          kind: billingInvoiceItems.kind,
          description: billingInvoiceItems.description,
          quantity: billingInvoiceItems.quantity,
          unitAmountPaise: billingInvoiceItems.unitAmountPaise,
          amountPaise: billingInvoiceItems.amountPaise,
        })
        .from(billingInvoiceItems)
        .where(eq(billingInvoiceItems.invoiceId, inv.id))
        .orderBy(billingInvoiceItems.sortOrder);
      const parties = recorded ?? (await currentInvoiceParties(db, inv));

      return {
        id: inv.id,
        invoiceRef: inv.invoiceRef,
        kind: inv.kind,
        status: inv.status,
        issuedAt: inv.finalizedAt,
        paidAt: inv.paidAt,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        subtotalPaise: inv.subtotalPaise,
        discountPaise: inv.discountPaise,
        taxPaise: inv.taxPaise,
        totalPaise: inv.totalPaise,
        // ★ From the ROW. See the note above.
        taxRateBps: inv.taxRateBps,
        supplierGstin: inv.supplierGstin,
        customerGstin: inv.customerGstin,
        placeOfSupply: inv.placeOfSupply,
        sacCode: inv.sacCode ?? null,
        taxInclusive: inv.taxInclusive === true,
        placeOfSupplyBasis: inv.placeOfSupplyBasis ?? null,
        items,
        supplier: {
          legalName: parties?.supplier.name ?? "StoreMink",
          address: parties?.supplier.address ?? {},
          gstin: inv.supplierGstin,
          // The State printed beside the GSTIN is the GSTIN's own; the
          // recorded state is the fallback for a row with no GSTIN.
          stateCode:
            stateCodeFromGstin(inv.supplierGstin) ??
            parties?.supplier.stateCode ??
            null,
          // ★ No LLP line without a recorded legal name (R2-08): the line
          // names the LLP, and "StoreMink is registered with limited
          // liability" would misname it on a line printed for LLP Act
          // section 21.
          llpin: parties?.supplier.name
            ? (parties.supplier.llpin ?? null)
            : null,
          registeredOffice: parties?.supplier.registeredOffice ?? null,
        },
        customer: {
          legalName: parties?.customer.name ?? null,
          address: parties?.customer.address ?? {},
          billingEmail: parties?.customer.email ?? null,
          // ★ From the ROW, like every tax identifier: never the State of a
          // supplier fallback or of a supply outside India.
          stateCode: recipientStateFor(inv),
          country: recordedCountryName(parties?.customer.country),
        },
      };
    });
  } catch (err) {
    logError("billing.get_invoice_document", err, { storeId, invoiceId });
    return null;
  }
  if (!doc) return null;
  const [credits, refunds] = await Promise.all([
    readInvoiceCredits(doc.id),
    readRefundSummaries([doc.id]),
  ]);
  return {
    ...doc,
    credits,
    refunds: refunds.get(doc.id) ?? NO_REFUNDS,
  };
}

/**
 * The credit notes issued against one invoice, oldest first (design 8.7).
 *
 * Scoped through the invoice, which the caller has already read for its
 * store; `billing_credit_notes` has no store column. Its own scope, and it
 * never throws: the invoice opens without the block rather than not at all.
 */
async function readInvoiceCredits(
  invoiceId: string,
): Promise<InvoiceDocument["credits"]> {
  try {
    const rows = await withService(async (db) =>
      db
        .select({
          id: billingCreditNotes.id,
          creditNoteRef: billingCreditNotes.creditNoteRef,
          issuedAt: billingCreditNotes.issuedAt,
          totalPaise: billingCreditNotes.totalPaise,
        })
        .from(billingCreditNotes)
        .where(eq(billingCreditNotes.invoiceId, invoiceId))
        .orderBy(
          asc(billingCreditNotes.issuedAt),
          asc(billingCreditNotes.creditNoteNo),
        ),
    );
    // The issuing trigger always writes a reference; a row without one is
    // not a document anyone can be shown.
    return rows.flatMap((row) =>
      row.creditNoteRef
        ? [
            {
              id: row.id,
              creditNoteRef: row.creditNoteRef,
              issuedAt: row.issuedAt,
              totalPaise: Number(row.totalPaise),
            },
          ]
        : [],
    );
  } catch (err) {
    logError("billing.get_invoice_credits", err, { invoiceId });
    return [];
  }
}

// ── The refunds notice on Plans & Billing (design 8.6) ──────────────────────

/** A refund's state, as the notice words it. */
export type RecentRefundStatus =
  | "owed"
  | "pending"
  | "processed"
  | "recorded"
  | "failed"
  | "cancelled";

const RECENT_REFUND_STATUSES = new Set<string>([
  "owed",
  "pending",
  "processed",
  "recorded",
  "failed",
  "cancelled",
]);

/** One payment's newest refund, for the notice. */
export interface RecentRefund {
  id: string;
  attemptId: string;
  invoiceId: string;
  invoiceRef: string | null;
  reason: string;
  status: RecentRefundStatus;
  method: "razorpay" | "bank_transfer";
  amountPaise: number;
  /** The database's own timestamp text. */
  createdAt: string;
  /** When the refund completed (processed or recorded). */
  resolvedAt: string | null;
  /** The credit note documenting it; null for a returned duplicate payment,
   *  one with nothing left to credit, or one not issued yet. */
  creditNote: { id: string; ref: string } | null;
}

/** How far back the notice looks, and how many rows it shows. */
export const RECENT_REFUND_DAYS = 90;
export const RECENT_REFUND_LIMIT = 5;
/** The most refund rows read for one store's notice. */
const RECENT_REFUND_READ_CAP = 200;

/** Finished first, so a refund recorded in the same instant an owed one was
 *  cancelled is the one shown. */
const STATUS_RANK: Record<RecentRefundStatus, number> = {
  recorded: 4,
  processed: 4,
  pending: 3,
  owed: 2,
  failed: 1,
  cancelled: 0,
};

function newerRefund(a: RecentRefund, b: RecentRefund): number {
  const byTime = instant(b.createdAt) - instant(a.createdAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  const byRank = STATUS_RANK[b.status] - STATUS_RANK[a.status];
  if (byRank !== 0) return byRank;
  return b.id.localeCompare(a.id);
}

/**
 * One row per payment refunded, from its newest refund, newest first.
 *
 * ★ PER PAYMENT, NOT PER REFUND. A payment can carry several rows (an owed
 * refund cancelled and then recorded by bank transfer, a failed one retried),
 * and listing each would tell the merchant one payment was refunded twice.
 * The newest is the answer; the rest is history the console keeps.
 */
export function latestRefundPerPayment(
  rows: readonly RecentRefund[],
  limit = RECENT_REFUND_LIMIT,
): RecentRefund[] {
  const newest = new Map<string, RecentRefund>();
  for (const row of rows) {
    const held = newest.get(row.attemptId);
    if (!held || newerRefund(row, held) < 0) newest.set(row.attemptId, row);
  }
  return [...newest.values()].sort(newerRefund).slice(0, Math.max(0, limit));
}

/**
 * The store's refunds of the last 90 days, one per payment, newest five
 * (Plans & Billing's refunds notice, design 8.6).
 *
 * ★★ SCOPED BY STORE THROUGH THE INVOICE: `billing_refunds` has no store
 * column, so the join to `billing_invoices` and its `store_id` predicate are
 * what keep one merchant's refunds off another's page. A refund of an invoice
 * kept after its store was deleted (store_id NULL) is nobody's here.
 *
 * Returns [] on a read failure: the notice is a courtesy beside the plan and
 * the invoices, and must never take the page down.
 */
export async function listRecentRefunds(
  storeId: string,
  options: { now?: Date; days?: number; limit?: number } = {},
): Promise<RecentRefund[]> {
  const now = options.now ?? new Date();
  const days = options.days ?? RECENT_REFUND_DAYS;
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  try {
    const rows = await withService(async (db) =>
      db
        .select({
          id: billingRefunds.id,
          attemptId: billingRefunds.attemptId,
          invoiceId: billingRefunds.invoiceId,
          invoiceRef: billingInvoices.invoiceRef,
          reason: billingRefunds.reason,
          status: billingRefunds.status,
          method: billingRefunds.method,
          amountPaise: billingRefunds.amountPaise,
          createdAt: billingRefunds.createdAt,
          resolvedAt: billingRefunds.resolvedAt,
          creditNoteId: billingCreditNotes.id,
          creditNoteRef: billingCreditNotes.creditNoteRef,
        })
        .from(billingRefunds)
        .innerJoin(
          billingInvoices,
          eq(billingInvoices.id, billingRefunds.invoiceId),
        )
        .leftJoin(
          billingCreditNotes,
          eq(billingCreditNotes.refundId, billingRefunds.id),
        )
        .where(
          and(
            eq(billingInvoices.storeId, storeId),
            gte(billingRefunds.createdAt, since),
          ),
        )
        .orderBy(desc(billingRefunds.createdAt), desc(billingRefunds.id))
        .limit(RECENT_REFUND_READ_CAP),
    );
    const refunds = rows.flatMap((row): RecentRefund[] =>
      RECENT_REFUND_STATUSES.has(row.status)
        ? [
            {
              id: row.id,
              attemptId: row.attemptId,
              invoiceId: row.invoiceId,
              invoiceRef: row.invoiceRef ?? null,
              reason: row.reason,
              status: row.status as RecentRefundStatus,
              method:
                row.method === "bank_transfer" ? "bank_transfer" : "razorpay",
              amountPaise: Number(row.amountPaise),
              createdAt: row.createdAt,
              resolvedAt: row.resolvedAt ?? null,
              creditNote:
                row.creditNoteId && row.creditNoteRef
                  ? { id: row.creditNoteId, ref: row.creditNoteRef }
                  : null,
            },
          ]
        : [],
    );
    return latestRefundPerPayment(refunds, options.limit);
  } catch (err) {
    logError("billing.list_recent_refunds", err, { storeId });
    return [];
  }
}
