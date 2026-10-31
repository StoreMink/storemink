/* eslint-disable @typescript-eslint/no-explicit-any */
// The monthly invoice list for StoreMink's GST returns (GST design 5.13).
//
// What carries the weight:
//   • a month is an INDIAN month: 00:15 IST on 1 December (18:45 UTC on
//     30 November) is December's;
//   • a credit note is a negative line, with its invoice's place-of-supply
//     basis and SAC code;
//   • a supplier-basis invoice says so, and the GST split is the shared
//     `platformInvoiceGst` rule;
//   • it only reads, one statement after another, and a failed read is never
//     an empty file.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";
import { logError, logWarn } from "@/lib/observability/logger";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

import { withService } from "@/lib/db/client";
import { INVOICE_LIST_CSV, invoiceListFileName } from "./tax-copy";
import {
  MAX_INVOICE_LIST_ROWS,
  buildInvoiceList,
  istMonthBounds,
  rupees,
} from "./invoice-list";

const PUNJAB_GSTIN = "03ABCFS1234A1Z5";

const parties = (name: string, gstin: string | null = null) => ({
  version: 1,
  capturedAt: "2026-12-01T00:15:00+05:30",
  supplier: { name: "StoreMink LLP", gstin: PUNJAB_GSTIN, stateCode: "03" },
  customer: { name, gstin, stateCode: null, email: null },
});

/** An invoice row as the raw read returns it (bigints as text). */
function invoice(over: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    invoice_ref: "SM/2026-27/00041",
    finalized_at: "2026-11-30 18:45:00+00",
    status: "paid",
    tax_paise: "22881",
    total_paise: "150000",
    tax_rate_bps: 1800,
    supplier_gstin: PUNJAB_GSTIN,
    customer_gstin: "03AAACR5055K1Z7",
    place_of_supply: "03",
    place_of_supply_basis: "recipient",
    sac_code: "998314",
    parties: parties("Ravi Traders"),
    store_id: "store-1",
    store_slug: "ravi-traders",
    ...over,
  };
}

/** A credit note row joined to its invoice. */
function creditNote(over: Record<string, unknown> = {}) {
  return {
    id: "cn-1",
    credit_note_ref: "CN/2026-27/00007",
    issued_at: "2026-12-14 10:00:00+00",
    taxable_paise: "127119",
    tax_paise: "22881",
    total_paise: "150000",
    tax_rate_bps: 1800,
    supplier_gstin: PUNJAB_GSTIN,
    customer_gstin: null,
    place_of_supply: "07",
    parties: parties("Delhi Wares", "07AAACD1234E1Z2"),
    place_of_supply_basis: "supplier",
    sac_code: "998314",
    store_id: "store-2",
    store_slug: "delhi-wares",
    ...over,
  };
}

function useDb(invoices: any[], notes: any[] = []) {
  dbHolder.current = makeDbMock({ executeQueue: [invoices, notes] });
  return dbHolder.current;
}

/** The CSV's lines without the BOM. */
function csvLines(csv: string): string[] {
  return csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
}

function ok(result: Awaited<ReturnType<typeof buildInvoiceList>>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result;
}

beforeEach(() => {
  dbHolder.current = makeDbMock();
});

describe("istMonthBounds", () => {
  it("covers an Indian calendar month, as UTC instants", () => {
    expect(istMonthBounds("2026-12")).toEqual({
      start: "2026-11-30T18:30:00.000Z",
      end: "2026-12-31T18:30:00.000Z",
    });
    expect(istMonthBounds("2027-01")).toEqual({
      start: "2026-12-31T18:30:00.000Z",
      end: "2027-01-31T18:30:00.000Z",
    });
    expect(istMonthBounds("2028-02")?.end).toBe("2028-02-29T18:30:00.000Z");
  });

  it("refuses anything that is not YYYY-MM", () => {
    for (const bad of [
      "",
      "2026-13",
      "2026-00",
      "2026-1",
      "26-12",
      "1999-12",
      "2026-12-01",
      " 2026-12",
      "abcd-ef",
    ]) {
      expect(istMonthBounds(bad), bad).toBeNull();
    }
  });

  it("agrees with India's own calendar at every boundary", () => {
    const istMonth = (ms: number) => {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
      }).formatToParts(new Date(ms));
      const y = parts.find((p) => p.type === "year")!.value;
      const m = parts.find((p) => p.type === "month")!.value;
      return `${y}-${m}`;
    };
    for (const month of ["2026-03", "2026-04", "2026-11", "2026-12"]) {
      const b = istMonthBounds(month)!;
      const start = Date.parse(b.start);
      const end = Date.parse(b.end);
      expect(istMonth(start)).toBe(month);
      expect(istMonth(start - 1)).not.toBe(month);
      expect(istMonth(end - 1)).toBe(month);
      expect(istMonth(end)).not.toBe(month);
    }
  });
});

describe("rupees", () => {
  it("prints signed paise with two decimals and never -0.00", () => {
    expect(rupees(150000)).toBe("1500.00");
    expect(rupees(-150000)).toBe("-1500.00");
    expect(rupees(11440)).toBe("114.40");
    expect(rupees(5)).toBe("0.05");
    expect(rupees(-5)).toBe("-0.05");
    expect(rupees(0)).toBe("0.00");
    expect(rupees(-0)).toBe("0.00");
  });
});

describe("buildInvoiceList", () => {
  it("an invoice issued at 2026-11-30T18:45:00Z is December's", async () => {
    const instant = Date.parse("2026-11-30T18:45:00Z");
    const dec = istMonthBounds("2026-12")!;
    const nov = istMonthBounds("2026-11")!;
    expect(instant >= Date.parse(dec.start)).toBe(true);
    expect(instant < Date.parse(dec.end)).toBe(true);
    expect(instant >= Date.parse(nov.end)).toBe(true);

    const mock = useDb([invoice()]);
    const result = ok(await buildInvoiceList({ month: "2026-12" }));

    // The read asks for December in India, not December in UTC.
    const params = sqlParamValues(mock.calls.execute[0]);
    expect(params).toContain("2026-11-30T18:30:00.000Z");
    expect(params).toContain("2026-12-31T18:30:00.000Z");
    // And the line is dated the day India saw.
    expect(result.rows[0].date).toBe("2026-12-01");
    expect(csvLines(result.csv)[1].split(",")[1]).toBe("2026-12-01");
  });

  it("writes the header in the agreed order, with a BOM and CRLF lines", async () => {
    useDb([invoice()]);
    const result = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(result.csv.startsWith("﻿")).toBe(true);
    expect(result.csv).toContain("\r\n");
    expect(csvLines(result.csv)[0]).toBe(INVOICE_LIST_CSV.columns.join(","));
    expect(result.fileName).toBe(invoiceListFileName("2026-12"));
    expect(result.fileName).toBe("storemink-invoices-2026-12.csv");
    expect(result.month).toBe("2026-12");
  });

  it("splits intra-state tax into CGST and SGST from the tax amount", async () => {
    useDb([invoice()]);
    const { rows, csv } = ok(await buildInvoiceList({ month: "2026-12" }));
    const row = rows[0];
    expect(row).toMatchObject({
      number: "SM/2026-27/00041",
      type: "Tax invoice",
      customerName: "Ravi Traders",
      customerGstin: "03AAACR5055K1Z7",
      placeOfSupply: "Punjab (03)",
      placeOfSupplyBasis: "recipient",
      sac: "998314",
      taxablePaise: 127119,
      cgstPaise: 11440,
      sgstPaise: 11441,
      igstPaise: 0,
      totalPaise: 150000,
      status: "paid",
      store: "ravi-traders",
    });
    expect(csvLines(csv)[1]).toBe(
      [
        "SM/2026-27/00041",
        "2026-12-01",
        "Tax invoice",
        "Ravi Traders",
        "03AAACR5055K1Z7",
        "Punjab (03)",
        "recipient",
        "998314",
        "1271.19",
        "114.40",
        "114.41",
        "0.00",
        "1500.00",
        "paid",
        "ravi-traders",
      ].join(","),
    );
  });

  it("charges IGST to another state and outside India", async () => {
    useDb([
      invoice({ id: "a", place_of_supply: "07" }),
      invoice({
        id: "b",
        place_of_supply: "96",
        place_of_supply_basis: "outside_india",
      }),
    ]);
    const { rows } = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(rows[0]).toMatchObject({
      placeOfSupply: "Delhi (07)",
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 22881,
    });
    expect(rows[1]).toMatchObject({
      placeOfSupply: "Outside India (96)",
      placeOfSupplyBasis: "outside_india",
      igstPaise: 22881,
    });
  });

  it("a supplier-basis invoice says so", async () => {
    useDb([
      invoice({
        place_of_supply: "03",
        place_of_supply_basis: "supplier",
        customer_gstin: null,
        parties: parties("No State Stores"),
      }),
    ]);
    const { rows, csv } = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(rows[0].placeOfSupplyBasis).toBe("supplier");
    expect(csvLines(csv)[1].split(",")[6]).toBe("supplier");
  });

  it("adds each credit note as a negative line with its invoice's basis", async () => {
    useDb([invoice()], [creditNote()]);
    const { rows, csv } = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(rows).toHaveLength(2);
    // Invoices first, then credit notes.
    expect(rows[0].kind).toBe("invoice");
    expect(rows[1]).toEqual({
      kind: "credit_note",
      number: "CN/2026-27/00007",
      date: "2026-12-14",
      type: "Credit note",
      customerName: "Delhi Wares",
      customerGstin: "07AAACD1234E1Z2",
      placeOfSupply: "Delhi (07)",
      placeOfSupplyBasis: "supplier",
      sac: "998314",
      taxablePaise: -127119,
      cgstPaise: -0,
      sgstPaise: -0,
      igstPaise: -22881,
      totalPaise: -150000,
      status: "",
      store: "delhi-wares",
    });
    expect(csvLines(csv)[2]).toBe(
      [
        "CN/2026-27/00007",
        "2026-12-14",
        "Credit note",
        "Delhi Wares",
        "07AAACD1234E1Z2",
        "Delhi (07)",
        "supplier",
        "998314",
        "-1271.19",
        "0.00",
        "0.00",
        "-228.81",
        "-1500.00",
        "",
        "delhi-wares",
      ].join(","),
    );
  });

  it("reads credit notes issued in the month, with their invoice's basis and SAC", async () => {
    const mock = useDb([], [creditNote()]);
    await buildInvoiceList({ month: "2026-12" });
    expect(mock.calls.execute).toHaveLength(2);
    const text = sqlText(mock.calls.execute[1]).replace(/\s+/g, " ");
    expect(text).toContain("from public.billing_credit_notes n");
    expect(text).toContain(
      "join public.billing_invoices i on i.id = n.invoice_id",
    );
    expect(text).toContain("i.place_of_supply_basis");
    expect(text).toContain("i.sac_code");
    expect(text).toContain("n.issued_at >=");
    const params = sqlParamValues(mock.calls.execute[1]);
    expect(params).toContain("2026-11-30T18:30:00.000Z");
    expect(params).toContain("2026-12-31T18:30:00.000Z");
  });

  it("a credit note without tax prints 0.00, never -0.00", async () => {
    useDb(
      [],
      [
        creditNote({
          taxable_paise: "50000",
          tax_paise: "0",
          total_paise: "50000",
          tax_rate_bps: null,
        }),
      ],
    );
    const { csv } = ok(await buildInvoiceList({ month: "2026-12" }));
    const line = csvLines(csv)[1].split(",");
    expect(line.slice(8, 13)).toEqual([
      "-500.00",
      "0.00",
      "0.00",
      "0.00",
      "-500.00",
    ]);
    expect(csv).not.toContain("-0.00");
  });

  it("names a deleted store, and keeps the customer its invoice recorded", async () => {
    useDb([
      invoice({
        store_id: null,
        store_slug: null,
        parties: parties("Gone Shop"),
        customer_gstin: null,
      }),
    ]);
    const { rows } = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(rows[0].store).toBe("deleted store");
    expect(rows[0].store).toBe(INVOICE_LIST_CSV.deletedStore);
    expect(rows[0].customerName).toBe("Gone Shop");
  });

  it("falls back to the recorded customer GSTIN when the column is empty", async () => {
    useDb([
      invoice({
        customer_gstin: null,
        parties: parties("Ravi Traders", "03AAACR5055K1Z7"),
      }),
    ]);
    const { rows } = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(rows[0].customerGstin).toBe("03AAACR5055K1Z7");
  });

  it("an invoice without GST, or without StoreMink's GSTIN, is an Invoice", async () => {
    useDb([
      invoice({
        id: "a",
        tax_paise: "0",
        total_paise: "150000",
        tax_rate_bps: null,
        supplier_gstin: null,
        place_of_supply: null,
        place_of_supply_basis: null,
        sac_code: null,
      }),
      invoice({ id: "b", supplier_gstin: null }),
    ]);
    const { rows, csv } = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(rows[0]).toMatchObject({
      type: "Invoice",
      placeOfSupply: "",
      placeOfSupplyBasis: "",
      sac: "",
      taxablePaise: 150000,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
    });
    expect(rows[1].type).toBe("Invoice");
    expect(csvLines(csv)[1].split(",").slice(8, 13)).toEqual([
      "1500.00",
      "0.00",
      "0.00",
      "0.00",
      "1500.00",
    ]);
  });

  it("an unreadable parties record leaves the name blank, never a guess", async () => {
    useDb([invoice({ parties: null, customer_gstin: null })]);
    const { rows } = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(rows[0].customerName).toBe("");
    expect(rows[0].customerGstin).toBe("");
  });

  it("keeps a customer's text from running as a spreadsheet formula", async () => {
    useDb([invoice({ parties: parties('=HYPERLINK("http://x")') })]);
    const { csv } = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it("refuses a month that is not YYYY-MM without reading anything", async () => {
    for (const month of ["", "2026-13", "December", "2026-12-01"]) {
      const result = await buildInvoiceList({ month });
      expect(result).toEqual({ ok: false, reason: "invalid_month" });
    }
    expect(withService).not.toHaveBeenCalled();
  });

  it("a failed read is read_failed and logged, never an empty file", async () => {
    dbHolder.current = makeDbMock();
    dbHolder.current.db.execute.mockRejectedValueOnce(new Error("db down"));
    const result = await buildInvoiceList({ month: "2026-12" });
    expect(result).toEqual({ ok: false, reason: "read_failed" });
    expect(logError).toHaveBeenCalledWith(
      "billing.invoice_list",
      expect.any(Error),
      { month: "2026-12" },
    );
  });

  it("an empty month is a header-only file", async () => {
    useDb([], []);
    const result = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(result.rows).toEqual([]);
    expect(csvLines(result.csv)).toHaveLength(1);
  });

  it("only reads, in one scope, one statement after another", async () => {
    let inFlight = 0;
    let most = 0;
    const statements: string[] = [];
    const queue = [[invoice()], [creditNote()]];
    const db = {
      execute: vi.fn(async (q: any) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        statements.push(sqlText(q));
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return { rows: queue.shift() ?? [] };
      }),
    };
    dbHolder.current = { db };
    ok(await buildInvoiceList({ month: "2026-12" }));
    expect(withService).toHaveBeenCalledTimes(1);
    expect(most).toBe(1);
    expect(statements).toHaveLength(2);
    for (const s of statements) {
      expect(s.trim().toLowerCase().startsWith("select")).toBe(true);
      expect(s).not.toMatch(/\b(insert|update|delete|for update)\b/i);
    }
  });

  it("compiles with bound parameters only", async () => {
    const mock = useDb([invoice()], [creditNote()]);
    await buildInvoiceList({ month: "2026-12" });
    const dialect = new PgDialect();
    const [invoices, notes] = mock.calls.execute.map((q: any) =>
      dialect.sqlToQuery(q),
    );
    // The month's bounds, then the row limit: one past the cap for the
    // invoices, and one past what the cap leaves for the notes.
    expect(invoices.params).toEqual([
      "2026-11-30T18:30:00.000Z",
      "2026-12-31T18:30:00.000Z",
      MAX_INVOICE_LIST_ROWS + 1,
    ]);
    expect(notes.params).toEqual([
      "2026-11-30T18:30:00.000Z",
      "2026-12-31T18:30:00.000Z",
      MAX_INVOICE_LIST_ROWS - 1 + 1,
    ]);
    for (const compiled of [invoices, notes]) {
      expect(compiled.sql).toMatch(/\$1::timestamptz/);
      expect(compiled.sql).toMatch(/\$2::timestamptz/);
      expect(compiled.sql).toMatch(/limit \$3/);
    }
  });
});

describe("★★ a month too large for one file (review R3-08)", () => {
  it("is capped at 50,000 lines", () => {
    expect(MAX_INVOICE_LIST_ROWS).toBe(50_000);
  });

  it("★★ more invoices than the cap is too_many, never a cut file, and the notes are not read", async () => {
    const mock = useDb(new Array(MAX_INVOICE_LIST_ROWS + 1).fill(invoice()));
    const result = await buildInvoiceList({ month: "2026-12" });
    expect(result).toEqual({ ok: false, reason: "too_many" });
    expect(mock.calls.execute).toHaveLength(1);
    expect(logWarn).toHaveBeenCalledWith("billing.invoice_list_too_many", {
      month: "2026-12",
      cap: MAX_INVOICE_LIST_ROWS,
    });
  });

  it("★ invoices and credit notes together over the cap is too_many", async () => {
    useDb(new Array(MAX_INVOICE_LIST_ROWS).fill(invoice()), [creditNote()]);
    const result = await buildInvoiceList({ month: "2026-12" });
    expect(result).toEqual({ ok: false, reason: "too_many" });
  });

  it("★ exactly the cap is still one file", async () => {
    useDb(new Array(MAX_INVOICE_LIST_ROWS - 1).fill(invoice()), [creditNote()]);
    const result = ok(await buildInvoiceList({ month: "2026-12" }));
    expect(result.rows).toHaveLength(MAX_INVOICE_LIST_ROWS);
    expect(logWarn).not.toHaveBeenCalled();
  });
});
