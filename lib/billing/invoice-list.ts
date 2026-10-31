import "server-only";

/**
 * The monthly invoice list for StoreMink's GST returns (GST design 5.13 and
 * 6.6): every invoice StoreMink issued in one calendar month in India time,
 * and every credit note it issued in that month, as rows and as a CSV.
 *
 * ★ A MONTH IS AN INDIAN MONTH. An invoice issued at 00:15 IST on 1 December
 * is 18:45 UTC on 30 November, and it belongs to December's return. The
 * bounds are computed with India's fixed offset (+05:30; India keeps no
 * daylight saving), so "2026-12" covers [2026-11-30T18:30Z, 2026-12-31T18:30Z).
 *
 * ★ EVERY FACT COMES FROM THE DOCUMENT ITSELF, never from today's settings:
 * the customer's name from the invoice's recorded parties, the GSTINs, the
 * place of supply, the SAC code and the amounts from its own columns, and the
 * GST split from `platformInvoiceGst`, the one rule the invoice sheet, the
 * emails and the credit-note sheet share. An operator correcting a GSTIN in
 * March never changes what a December line says.
 *
 * ★ A CREDIT NOTE IS A NEGATIVE LINE. It carries its own number, date, place
 * of supply, GSTINs and parties (copied from the invoice when it was issued),
 * its invoice's place-of-supply basis and SAC code, and every amount below
 * zero, so a column total nets the month's credits off its invoices.
 *
 * ★ READ ONLY, ONE SCOPE, TWO STATEMENTS ONE AFTER THE OTHER: the invoices,
 * then the credit notes. A failed read is `read_failed`, never an empty file:
 * an empty list would read as a month with nothing to declare.
 *
 * ★★ AT MOST `MAX_INVOICE_LIST_ROWS` LINES, AND NEVER A CUT FILE (review
 * R3-08). The whole month is held in memory and returned as one server-action
 * answer, twice over (rows and CSV), on an instance that also serves shoppers.
 * Each statement asks for one row more than the room left, so a month past the
 * cap is `too_many` without reading the rest, and the console says to export
 * it in parts. A truncated list would be a GST return missing invoices that
 * looks complete. The cap is a guard against memory, not a GST rule; the
 * streamed `/api/dashboard/export` pattern (§31) is the next step when a month
 * nears it.
 */

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { serializeCsv } from "@/lib/csv/serialize";
import { logError, logWarn } from "@/lib/observability/logger";
import { placeOfSupplyLabel, platformInvoiceGst } from "./gst";
import { parseInvoiceParties } from "./invoice-history";
import { INVOICE_LIST_CSV, invoiceListFileName } from "./tax-copy";

/** India's offset from UTC: +05:30 all year. */
const IST_OFFSET_MS = 330 * 60 * 1000;

/** "2026-12": a four-digit year from 2000 and a two-digit month. */
const MONTH_RE = /^(2\d{3})-(0[1-9]|1[0-2])$/;

/** The most lines (invoices and credit notes together) one download holds. */
export const MAX_INVOICE_LIST_ROWS = 50_000;

/** One line of the list. Amounts are signed paise. */
export interface InvoiceListRow {
  kind: "invoice" | "credit_note";
  /** The invoice's or credit note's own number, as printed. */
  number: string;
  /** The issue date in India, "2026-12-01". */
  date: string;
  /** "Tax invoice", "Invoice" or "Credit note". */
  type: string;
  customerName: string;
  customerGstin: string;
  /** "Punjab (03)", "Outside India (96)", or blank. */
  placeOfSupply: string;
  /** As recorded: "recipient", "supplier", "outside_india", or blank. */
  placeOfSupplyBasis: string;
  sac: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  /** The invoice's status as recorded; blank for a credit note. */
  status: string;
  /** The store's address name, or "deleted store". */
  store: string;
}

export type InvoiceListResult =
  | {
      ok: true;
      month: string;
      fileName: string;
      rows: InvoiceListRow[];
      csv: string;
    }
  | { ok: false; reason: "invalid_month" | "read_failed" | "too_many" };

/**
 * The instants an Indian calendar month starts and ends at, as ISO text; null
 * for anything that is not "YYYY-MM".
 */
export function istMonthBounds(
  month: string,
): { start: string; end: string } | null {
  const m = MONTH_RE.exec(typeof month === "string" ? month : "");
  if (!m) return null;
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  return {
    start: new Date(Date.UTC(year, index, 1) - IST_OFFSET_MS).toISOString(),
    end: new Date(Date.UTC(year, index + 1, 1) - IST_OFFSET_MS).toISOString(),
  };
}

/** A timestamp as milliseconds: raw reads hand it over as Postgres text. */
function instantMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** The date in India, "2026-12-01"; blank when the instant is unreadable. */
function istDate(v: unknown): string {
  const ms = instantMs(v);
  if (ms === null) return "";
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const textOf = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A bigint arrives as text from a raw read. */
const paiseOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const rateOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Signed paise as rupees with two decimals: "1500.00", "-114.41", never "-0.00". */
export function rupees(paise: number): string {
  const whole = Math.round(paise);
  const abs = Math.abs(whole);
  const sign = whole < 0 ? "-" : "";
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** The store column: the store's address name, or "deleted store". */
function storeOf(storeId: unknown, slug: unknown): string {
  if (storeId === null || storeId === undefined) {
    return INVOICE_LIST_CSV.deletedStore;
  }
  return textOf(slug);
}

function invoiceRow(r: Record<string, unknown>): InvoiceListRow {
  const parties = parseInvoiceParties(r.parties);
  const taxPaise = paiseOf(r.tax_paise);
  const totalPaise = paiseOf(r.total_paise);
  const supplierGstin = textOf(r.supplier_gstin) || null;
  const placeOfSupply = textOf(r.place_of_supply) || null;
  const split = platformInvoiceGst({
    taxPaise,
    taxRateBps: rateOf(r.tax_rate_bps),
    supplierGstin,
    placeOfSupply,
  });
  return {
    kind: "invoice",
    number: textOf(r.invoice_ref),
    date: istDate(r.finalized_at),
    // The invoice sheet's own rule: GST charged and StoreMink's GSTIN on it.
    type:
      taxPaise > 0 && !!supplierGstin
        ? INVOICE_LIST_CSV.taxInvoice
        : INVOICE_LIST_CSV.invoice,
    customerName: parties?.customer.name ?? "",
    customerGstin: textOf(r.customer_gstin) || (parties?.customer.gstin ?? ""),
    placeOfSupply: placeOfSupplyLabel(placeOfSupply) ?? "",
    placeOfSupplyBasis: textOf(r.place_of_supply_basis),
    sac: textOf(r.sac_code),
    taxablePaise: totalPaise - taxPaise,
    cgstPaise: split.cgstPaise,
    sgstPaise: split.sgstPaise,
    igstPaise: split.igstPaise,
    totalPaise,
    status: textOf(r.status),
    store: storeOf(r.store_id, r.store_slug),
  };
}

function creditNoteRow(r: Record<string, unknown>): InvoiceListRow {
  const parties = parseInvoiceParties(r.parties);
  const taxPaise = paiseOf(r.tax_paise);
  const placeOfSupply = textOf(r.place_of_supply) || null;
  const split = platformInvoiceGst({
    taxPaise,
    taxRateBps: rateOf(r.tax_rate_bps),
    supplierGstin: textOf(r.supplier_gstin) || null,
    placeOfSupply,
  });
  // Negating a zero gives -0, which rupees() prints as "0.00", never "-0.00".
  return {
    kind: "credit_note",
    number: textOf(r.credit_note_ref),
    date: istDate(r.issued_at),
    type: INVOICE_LIST_CSV.creditNote,
    customerName: parties?.customer.name ?? "",
    customerGstin: textOf(r.customer_gstin) || (parties?.customer.gstin ?? ""),
    placeOfSupply: placeOfSupplyLabel(placeOfSupply) ?? "",
    // A6: the basis of the invoice it reverses (a note records none of its own).
    placeOfSupplyBasis: textOf(r.place_of_supply_basis),
    sac: textOf(r.sac_code),
    taxablePaise: -paiseOf(r.taxable_paise),
    cgstPaise: -split.cgstPaise,
    sgstPaise: -split.sgstPaise,
    igstPaise: -split.igstPaise,
    totalPaise: -paiseOf(r.total_paise),
    status: "",
    store: storeOf(r.store_id, r.store_slug),
  };
}

/** One row's cells, in INVOICE_LIST_CSV.columns order. */
function cells(row: InvoiceListRow): string[] {
  return [
    row.number,
    row.date,
    row.type,
    row.customerName,
    row.customerGstin,
    row.placeOfSupply,
    row.placeOfSupplyBasis,
    row.sac,
    rupees(row.taxablePaise),
    rupees(row.cgstPaise),
    rupees(row.sgstPaise),
    rupees(row.igstPaise),
    rupees(row.totalPaise),
    row.status,
    row.store,
  ];
}

/**
 * The list for one month ("2026-12"). Read only. Invoices first, by number,
 * then credit notes, by number.
 */
export async function buildInvoiceList(input: {
  month: string;
}): Promise<InvoiceListResult> {
  const month = typeof input?.month === "string" ? input.month.trim() : "";
  const bounds = istMonthBounds(month);
  if (!bounds) return { ok: false, reason: "invalid_month" };

  try {
    const read = await withService(async (db) => {
      const inv = await db.execute(sql`
        select i.id, i.invoice_ref, i.finalized_at, i.status,
               i.tax_paise, i.total_paise, i.tax_rate_bps,
               i.supplier_gstin, i.customer_gstin,
               i.place_of_supply, i.place_of_supply_basis, i.sac_code,
               i.parties, i.store_id, s.slug as store_slug
          from public.billing_invoices i
          left join public.stores s on s.id = i.store_id
         where i.finalized_at >= ${bounds.start}::timestamptz
           and i.finalized_at < ${bounds.end}::timestamptz
         order by i.fy_label, i.invoice_no, i.finalized_at, i.id
         limit ${MAX_INVOICE_LIST_ROWS + 1}`);
      const invoices = (inv.rows ?? []) as Record<string, unknown>[];
      // Past the cap already: the credit notes are not read at all.
      if (invoices.length > MAX_INVOICE_LIST_ROWS) return null;
      const cn = await db.execute(sql`
        select n.id, n.credit_note_ref, n.issued_at,
               n.taxable_paise, n.tax_paise, n.total_paise, n.tax_rate_bps,
               n.supplier_gstin, n.customer_gstin, n.place_of_supply,
               n.parties, i.place_of_supply_basis, i.sac_code,
               i.store_id, s.slug as store_slug
          from public.billing_credit_notes n
          join public.billing_invoices i on i.id = n.invoice_id
          left join public.stores s on s.id = i.store_id
         where n.issued_at >= ${bounds.start}::timestamptz
           and n.issued_at < ${bounds.end}::timestamptz
         order by n.fy_label, n.credit_note_no, n.issued_at, n.id
         limit ${MAX_INVOICE_LIST_ROWS - invoices.length + 1}`);
      const notes = (cn.rows ?? []) as Record<string, unknown>[];
      if (invoices.length + notes.length > MAX_INVOICE_LIST_ROWS) return null;
      return { invoices, notes };
    });
    if (!read) {
      logWarn("billing.invoice_list_too_many", {
        month,
        cap: MAX_INVOICE_LIST_ROWS,
      });
      return { ok: false, reason: "too_many" };
    }

    const { invoices, notes } = read;
    const rows = [...invoices.map(invoiceRow), ...notes.map(creditNoteRow)];
    return {
      ok: true,
      month,
      fileName: invoiceListFileName(month),
      rows,
      csv: serializeCsv(INVOICE_LIST_CSV.columns, rows.map(cells)),
    };
  } catch (err) {
    logError("billing.invoice_list", err, { month });
    return { ok: false, reason: "read_failed" };
  }
}
