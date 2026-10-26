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
 */

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { billingInvoiceItems, billingInvoices } from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import type {
  InvoiceAddress,
  InvoiceDocument,
  InvoiceSummary,
  RecordedInvoiceParties,
  RecordedInvoiceParty,
} from "./invoice-types";

/** Statuses that mean "this is a real, issued document". */
const ISSUED = ["open", "processing", "paid", "uncollectible", "void"];

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
  try {
    return await withService(async (db) =>
      db
        .select({
          id: billingInvoices.id,
          invoiceRef: billingInvoices.invoiceRef,
          kind: billingInvoices.kind,
          status: billingInvoices.status,
          totalPaise: billingInvoices.totalPaise,
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

function readParty(value: unknown): RecordedInvoiceParty | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const party = value as Record<string, unknown>;
  return {
    name: plainText(party.name),
    gstin: plainText(party.gstin),
    stateCode: plainText(party.stateCode),
    address: readAddress(party.address),
  };
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
 * own, passed in, exactly as the trigger passes them.
 */
async function currentInvoiceParties(
  db: Db,
  inv: {
    storeId: string | null;
    supplierGstin: string | null;
    customerGstin: string | null;
    placeOfSupply: string | null;
  },
): Promise<RecordedInvoiceParties | null> {
  const res = await db.execute(
    sql`select public.billing_invoice_parties(${inv.storeId}::uuid, ${inv.supplierGstin}::text, ${inv.customerGstin}::text, ${inv.placeOfSupply}::text) as parties`,
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
  try {
    return await withService(async (db) => {
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

      const [items, parties] = await Promise.all([
        db
          .select({
            kind: billingInvoiceItems.kind,
            description: billingInvoiceItems.description,
            quantity: billingInvoiceItems.quantity,
            unitAmountPaise: billingInvoiceItems.unitAmountPaise,
            amountPaise: billingInvoiceItems.amountPaise,
          })
          .from(billingInvoiceItems)
          .where(eq(billingInvoiceItems.invoiceId, inv.id))
          .orderBy(billingInvoiceItems.sortOrder),
        recorded ?? currentInvoiceParties(db, inv),
      ]);

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
        items,
        supplier: {
          legalName: parties?.supplier.name ?? "StoreMink",
          address: parties?.supplier.address ?? {},
        },
        customer: {
          legalName: parties?.customer.name ?? null,
          address: parties?.customer.address ?? {},
          billingEmail: parties?.customer.email ?? null,
        },
      };
    });
  } catch (err) {
    logError("billing.get_invoice_document", err, { storeId, invoiceId });
    return null;
  }
}
