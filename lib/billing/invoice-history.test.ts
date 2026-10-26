/* eslint-disable @typescript-eslint/no-explicit-any */
// A merchant's own invoices.
//
// Three properties carry the weight:
//   • a DRAFT is not a document — it has no number, and enrolment leaves one
//     behind every time a payment window is closed;
//   • every read is scoped by STORE, so an invoice id alone never crosses
//     tenants;
//   • the names and addresses come from what was RECORDED when the invoice was
//     issued (migration 0243), so a rename or a deleted store cannot restate
//     an issued invoice; only a missing record falls back to today's settings.
//
// Everything else is layout.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";
import { logWarn } from "@/lib/observability/logger";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

import {
  getInvoiceDocument,
  listInvoices,
  parseInvoiceParties,
} from "./invoice-history";

const STORE = "store-1";

/** What the issuing trigger records (billing_invoice_parties, 0243). */
const RECORDED = {
  version: 1,
  capturedAt: "2026-09-01T05:30:00+05:30",
  supplier: {
    name: "StoreMink Technologies",
    gstin: "07AABCS1429B1ZX",
    stateCode: "07",
    address: { line1: "12 Barakhamba Road", city: "New Delhi" },
  },
  customer: {
    name: "Acme Retail",
    gstin: "29AAACM1234C1ZP",
    stateCode: "29",
    email: "acme@example.test",
    address: { line1: "Shop 4, MG Road", line2: "Bengaluru 560001" },
  },
};

/** What today's settings say, after the merchant renamed the business. */
const LIVE = {
  ...RECORDED,
  capturedAt: "2026-10-25T12:00:00+05:30",
  customer: {
    ...RECORDED.customer,
    name: "Acme Retail (renamed)",
    email: "new@example.test",
  },
};

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    storeId: STORE,
    kind: "subscription",
    status: "paid",
    subtotalPaise: 500_000,
    discountPaise: 0,
    taxPaise: 90_000,
    totalPaise: 590_000,
    invoiceRef: "SM/2026-27/00001",
    finalizedAt: "2026-09-01T00:00:00.000Z",
    paidAt: "2026-09-01T00:00:00.000Z",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    taxRateBps: 1800,
    supplierGstin: "07AABCS1429B1ZX",
    customerGstin: "29AAACM1234C1ZP",
    placeOfSupply: "29",
    parties: RECORDED,
    ...over,
  };
}

/**
 * The invoice, then its items; `live` is what billing_invoice_parties() answers
 * today, read only when no usable record was taken at issue.
 */
function seedDoc(over: Record<string, unknown> = {}, live: unknown = LIVE) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [invoiceRow(over)],
      [
        {
          kind: "base_plan",
          description: "Pro plan · 1 month",
          quantity: 1,
          unitAmountPaise: 500_000,
          amountPaise: 500_000,
        },
      ],
    ],
    executeQueue: [[{ parties: live }]],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listInvoices", () => {
  it("returns the issued invoices", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "inv-1", invoiceRef: "SM/2026-27/00001" }]],
    });
    const rows = await listInvoices(STORE);
    expect(rows).toHaveLength(1);
  });

  it("★ returns [] on a read failure rather than throwing", async () => {
    // The page also carries the plan and AI usage; a billing hiccup should cost
    // the list, not the page.
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    expect(await listInvoices(STORE)).toEqual([]);
  });
});

describe("getInvoiceDocument", () => {
  it("renders an issued invoice from its own snapshot", async () => {
    seedDoc();
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc).toMatchObject({
      invoiceRef: "SM/2026-27/00001",
      totalPaise: 590_000,
      taxRateBps: 1800,
      supplierGstin: "07AABCS1429B1ZX",
      placeOfSupply: "29",
    });
    expect(doc?.items).toHaveLength(1);
  });

  it("★★ REFUSES a DRAFT — it has no number and is not a document", async () => {
    // Enrolment and add-on purchases both leave drafts behind when the payment
    // window is closed. Showing one would present an unpaid, unnumbered row as a
    // bill.
    seedDoc({ status: "draft", finalizedAt: null, invoiceRef: null });
    expect(await getInvoiceDocument(STORE, "inv-1")).toBeNull();
  });

  it("★ REFUSES a row that is finalized but in an unknown status", async () => {
    seedDoc({ status: "something_new" });
    expect(await getInvoiceDocument(STORE, "inv-1")).toBeNull();
  });

  it("★ shows an UNCOLLECTIBLE invoice — the merchant still owed it", async () => {
    seedDoc({ status: "uncollectible", paidAt: null });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.status).toBe("uncollectible");
  });

  it("★★ scopes the read by STORE, not just by id", async () => {
    // The predicate is what stops one merchant opening another's invoice. The
    // mock cannot evaluate WHERE, so this asserts the call was MADE with both —
    // and `storeId` is threaded from the session by the page, never from a URL.
    seedDoc();
    await getInvoiceDocument(STORE, "inv-1");
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  it("returns null when the invoice does not exist", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getInvoiceDocument(STORE, "nope")).toBeNull();
  });

  it("★ returns null on a read failure rather than a half-rendered document", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    expect(await getInvoiceDocument(STORE, "inv-1")).toBeNull();
  });

  it("★★ names both parties from the RECORD taken when it was issued, not today's settings", async () => {
    // A rename (or the store being deleted, which removes its billing account
    // and business details) must not restate an issued invoice.
    seedDoc();
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.supplier).toEqual({
      legalName: "StoreMink Technologies",
      address: { line1: "12 Barakhamba Road", city: "New Delhi" },
    });
    expect(doc?.customer).toEqual({
      legalName: "Acme Retail",
      address: { line1: "Shop 4, MG Road", line2: "Bengaluru 560001" },
      billingEmail: "acme@example.test",
    });
    // The record was enough: today's settings were never asked.
    expect(dbHolder.current.db.execute).not.toHaveBeenCalled();
  });

  it("★★ with NO record, reads today's settings through the same SQL function", async () => {
    // Every issued invoice has one after 0243; this is the safety net. It
    // calls the function the trigger calls, with the row's own GSTINs and
    // place of supply, so the fallback can never name a different party.
    seedDoc({ parties: null });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.customer.legalName).toBe("Acme Retail (renamed)");
    expect(doc?.customer.billingEmail).toBe("new@example.test");
    expect(dbHolder.current.db.execute).toHaveBeenCalledTimes(1);
    const query = dbHolder.current.calls.execute[0];
    expect(sqlText(query)).toContain("public.billing_invoice_parties(");
    expect(sqlParamValues(query)).toEqual([
      STORE,
      "07AABCS1429B1ZX",
      "29AAACM1234C1ZP",
      "29",
    ]);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("★ an UNREADABLE record is not printed: it is logged and today's settings are read", async () => {
    // Only a hand edit can produce one, since the trigger writes the shape the
    // parser reads. Printing half of it would be worse than reading again.
    seedDoc({ parties: { version: 2, supplier: {}, customer: {} } });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.customer.legalName).toBe("Acme Retail (renamed)");
    expect(logWarn).toHaveBeenCalledWith("billing.invoice_parties_unreadable", {
      invoiceId: "inv-1",
    });
  });

  it("★ the GSTINs and place of supply stay the ROW's, whatever the record says", async () => {
    // One invoice must not name two GSTINs: the row's columns are what the
    // tax was computed under.
    seedDoc({
      parties: {
        ...RECORDED,
        customer: { ...RECORDED.customer, gstin: "27AAAAA0000A1Z5" },
      },
    });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.customerGstin).toBe("29AAACM1234C1ZP");
    expect(doc?.placeOfSupply).toBe("29");
  });

  it("★ falls back to a supplier name when settings are unconfigured", async () => {
    // Today's real state: no platform_billing_settings row, so the record (and
    // the function it came from) holds no supplier name.
    seedDoc({
      parties: {
        version: 1,
        capturedAt: null,
        supplier: { name: null, gstin: null, stateCode: null, address: {} },
        customer: {
          name: null,
          gstin: null,
          stateCode: null,
          email: null,
          address: {},
        },
      },
    });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.supplier.legalName).toBe("StoreMink");
    expect(doc?.customer.legalName).toBeNull();
  });

  it("★ still renders when neither a record nor today's settings can be read", async () => {
    seedDoc({ parties: null }, null);
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.supplier.legalName).toBe("StoreMink");
    expect(doc?.customer).toEqual({
      legalName: null,
      address: {},
      billingEmail: null,
    });
  });
});

describe("parseInvoiceParties", () => {
  it("reads the record the trigger writes", () => {
    expect(parseInvoiceParties(RECORDED)).toEqual(RECORDED);
  });

  it("reads one that arrives as JSON text", () => {
    expect(parseInvoiceParties(JSON.stringify(RECORDED))).toEqual(RECORDED);
  });

  it.each([
    ["null", null],
    ["a number", 7],
    ["an array", [RECORDED]],
    ["unparseable text", "{not json"],
    ["another version", { ...RECORDED, version: 2 }],
    ["no supplier", { ...RECORDED, supplier: undefined }],
    ["a customer that is not an object", { ...RECORDED, customer: "Acme" }],
  ])("★ refuses %s rather than guess at it", (_label, raw) => {
    expect(parseInvoiceParties(raw)).toBeNull();
  });

  it("★ keeps only text address lines and treats blanks as absent", () => {
    const parsed = parseInvoiceParties({
      ...RECORDED,
      customer: {
        name: "  ",
        gstin: 29,
        stateCode: "29",
        email: "",
        address: { line1: "Shop 4", city: 560001, country: "IN", line2: " " },
      },
    });
    expect(parsed?.customer).toEqual({
      name: null,
      gstin: null,
      stateCode: "29",
      email: null,
      address: { line1: "Shop 4" },
    });
  });
});
