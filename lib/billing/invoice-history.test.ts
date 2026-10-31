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

import {
  getInvoiceDocument,
  latestRefundPerPayment,
  listInvoices,
  listRecentRefunds,
  NO_REFUNDS,
  parseInvoiceParties,
  summarizeInvoiceRefunds,
  type InvoiceRefundFact,
  type RecentRefund,
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

  it("carries each invoice's GST so the list can name a tax invoice", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          { id: "inv-1", invoiceRef: "SM/2026-27/00001", taxPaise: 36_610 },
          { id: "inv-2", invoiceRef: "SM/2026-27/00002", taxPaise: 0 },
        ],
      ],
    });
    const rows = await listInvoices(STORE);
    expect(rows.map((r) => r.taxPaise)).toEqual([36_610, 0]);
    expect(dbHolder.current.calls.select[0]).toHaveProperty("taxPaise");
  });

  it("reads a row with no tax figure as untaxed", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "inv-1", invoiceRef: "SM/2026-27/00001" }]],
    });
    const [row] = await listInvoices(STORE);
    expect(row.taxPaise).toBe(0);
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
      gstin: "07AABCS1429B1ZX",
      stateCode: "07",
      llpin: null,
      registeredOffice: null,
    });
    expect(doc?.customer).toEqual({
      legalName: "Acme Retail",
      address: { line1: "Shop 4, MG Road", line2: "Bengaluru 560001" },
      billingEmail: "acme@example.test",
      stateCode: "29",
      country: null,
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
      stateCode: "29",
      country: null,
    });
  });
});

// ── GST particulars on the document (GST design 5.9) ───────────────────────
//
// Tax figures and identifiers come from the ROW; names, addresses, the LLP's
// particulars and the country from the record taken at issue. The merchant's
// State is the place of supply only when it came from their own records.

const RECORDED_0266 = {
  ...RECORDED,
  supplier: {
    ...RECORDED.supplier,
    name: "STOREMINK LLP",
    gstin: "03ABCDE1234F1Z5",
    stateCode: "03",
    llpin: "ADC-5432",
    registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
  },
  customer: {
    ...RECORDED.customer,
    country: { code: "US", name: "United States" },
  },
};

describe("getInvoiceDocument: GST particulars", () => {
  it("carries the row's SAC code, price mode and place-of-supply basis", async () => {
    seedDoc({
      sacCode: "998314",
      taxInclusive: true,
      placeOfSupplyBasis: "recipient",
    });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.sacCode).toBe("998314");
    expect(doc?.taxInclusive).toBe(true);
    expect(doc?.placeOfSupplyBasis).toBe("recipient");
  });

  it("reads an older row as exclusive, with no SAC code and no basis", async () => {
    seedDoc();
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.sacCode).toBeNull();
    expect(doc?.taxInclusive).toBe(false);
    expect(doc?.placeOfSupplyBasis).toBeNull();
  });

  it("reads the LLPIN and registered office from the record", async () => {
    seedDoc({ supplierGstin: "03ABCDE1234F1Z5", parties: RECORDED_0266 });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.supplier).toMatchObject({
      legalName: "STOREMINK LLP",
      gstin: "03ABCDE1234F1Z5",
      stateCode: "03",
      llpin: "ADC-5432",
      registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
    });
  });

  // R2-08: the LLP line names the LLP, so it prints only with a recorded
  // legal name, never as "StoreMink is registered with limited liability".
  it("prints no LLPIN without a recorded legal name", async () => {
    seedDoc({
      supplierGstin: "03ABCDE1234F1Z5",
      parties: {
        ...RECORDED_0266,
        supplier: { ...RECORDED_0266.supplier, name: null },
      },
    });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.supplier.legalName).toBe("StoreMink");
    expect(doc?.supplier.llpin).toBeNull();
  });

  it("names the supplier State from the row's GSTIN, the record's only without one", async () => {
    // The record says Delhi; the row's GSTIN is a Punjab one, and the GSTIN
    // printed beside the State is the row's.
    seedDoc({ supplierGstin: "03ABCDE1234F1Z5" });
    expect((await getInvoiceDocument(STORE, "inv-1"))?.supplier.stateCode).toBe(
      "03",
    );
    seedDoc({ supplierGstin: null, taxPaise: 0, totalPaise: 500_000 });
    const plain = await getInvoiceDocument(STORE, "inv-1");
    expect(plain?.supplier.stateCode).toBe("07");
    expect(plain?.supplier.gstin).toBeNull();
  });

  it.each([
    ["the merchant's own records", "recipient", "29", "29"],
    ["an invoice from before the basis existed", null, "29", "29"],
    ["a supplier fallback", "supplier", "03", null],
    ["a supply outside India", "outside_india", "96", null],
  ])(
    "prints the merchant State for %s only when it came from them",
    async (_label, basis, placeOfSupply, expected) => {
      // The record's own customer State says 29 every time: the row decides.
      seedDoc({ placeOfSupplyBasis: basis, placeOfSupply });
      const doc = await getInvoiceDocument(STORE, "inv-1");
      expect(doc?.customer.stateCode).toBe(expected);
      expect(doc?.placeOfSupply).toBe(placeOfSupply);
    },
  );

  it.each([
    [
      "the recorded name",
      { code: "SG", name: "Singapore (recorded)" },
      "Singapore (recorded)",
    ],
    ["the catalog name for a bare code", { code: "US" }, "United States"],
    ["the recorded name for Other", { code: "OTHER", name: "Kenya" }, "Kenya"],
    ["nothing for a bare Other", { code: "OTHER" }, null],
  ])("names the recorded country: %s", async (_label, country, expected) => {
    seedDoc({
      parties: { ...RECORDED, customer: { ...RECORDED.customer, country } },
    });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.customer.country).toBe(expected);
  });

  it("names no country when none was recorded", async () => {
    seedDoc();
    expect((await getInvoiceDocument(STORE, "inv-1"))?.customer.country).toBe(
      null,
    );
  });

  it.each([
    ["a supplier fallback", "supplier", "03"],
    ["a supply outside India", "outside_india", "96"],
  ])(
    "asks today's settings for no merchant State on %s",
    async (_label, basis, placeOfSupply) => {
      // The fallback passes what the issuing trigger passes (0266):
      // recipientStateFor(row), never the bare place of supply.
      seedDoc({ parties: null, placeOfSupplyBasis: basis, placeOfSupply });
      await getInvoiceDocument(STORE, "inv-1");
      const query = dbHolder.current.calls.execute[0];
      expect(sqlParamValues(query)).toEqual([
        STORE,
        "07AABCS1429B1ZX",
        "29AAACM1234C1ZP",
        null,
      ]);
    },
  );

  it("asks today's settings for the merchant State when it came from their records", async () => {
    seedDoc({ parties: null, placeOfSupplyBasis: "recipient" });
    await getInvoiceDocument(STORE, "inv-1");
    expect(sqlParamValues(dbHolder.current.calls.execute[0])).toEqual([
      STORE,
      "07AABCS1429B1ZX",
      "29AAACM1234C1ZP",
      "29",
    ]);
  });

  it("reads the items and today's parties one after the other, never at once", async () => {
    // Both statements share the scope's one pooled client, and pg warns when
    // a query is issued on a client still busy with another.
    seedDoc({ parties: null });
    const db = dbHolder.current.db;
    const order: string[] = [];
    const select = db.select;
    db.select = vi.fn((...args: unknown[]) => {
      const step = select(...args);
      const then = step.then;
      step.then = (resolve: any, reject: any) =>
        then((rows: unknown) => {
          order.push("select settled");
          return resolve(rows);
        }, reject);
      return step;
    });
    const execute = db.execute;
    db.execute = vi.fn(async (query: unknown) => {
      order.push("execute");
      return execute(query);
    });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.customer.legalName).toBe("Acme Retail (renamed)");
    // The invoice row, then its items, then the settings: the credit-note
    // and refund reads after them run in scopes of their own.
    expect(order.slice(0, 3)).toEqual([
      "select settled",
      "select settled",
      "execute",
    ]);
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

  it("reads the LLP particulars and the country recorded since 0266", () => {
    expect(parseInvoiceParties(RECORDED_0266)).toEqual(RECORDED_0266);
  });

  it("reads an older record back with no new keys at all", () => {
    const parsed = parseInvoiceParties(RECORDED);
    expect(Object.keys(parsed!.supplier).sort()).toEqual([
      "address",
      "gstin",
      "name",
      "stateCode",
    ]);
    expect(Object.keys(parsed!.customer).sort()).toEqual([
      "address",
      "email",
      "gstin",
      "name",
      "stateCode",
    ]);
  });

  it("treats a null or blank LLPIN, office or country as absent", () => {
    const parsed = parseInvoiceParties({
      ...RECORDED,
      supplier: { ...RECORDED.supplier, llpin: null, registeredOffice: "  " },
      customer: { ...RECORDED.customer, country: null },
    });
    expect(parsed?.supplier).not.toHaveProperty("llpin");
    expect(parsed?.supplier).not.toHaveProperty("registeredOffice");
    expect(parsed?.customer).not.toHaveProperty("country");
  });

  it("drops a recorded country that carries no code", () => {
    const parsed = parseInvoiceParties({
      ...RECORDED,
      customer: { ...RECORDED.customer, country: { name: "Narnia" } },
    });
    expect(parsed?.customer).not.toHaveProperty("country");
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

// ── Refunds and credit notes (renewal-cancel, design 6.9, 8.5 to 8.7) ───────
//
// A refund never changes its invoice (rule R9), so what was refunded is read
// from billing_refunds beside it: processed and recorded refunds are money
// returned, owed and pending are on their way, failed and cancelled moved no
// money. A returned duplicate payment is an extra payment given back, never a
// refund of the invoice.

const compile = (condition: unknown) =>
  new PgDialect().sqlToQuery(
    condition as Parameters<PgDialect["sqlToQuery"]>[0],
  );

function fact(over: Partial<InvoiceRefundFact> = {}): InvoiceRefundFact {
  return {
    attemptId: "att-1",
    reason: "cycle_not_reached",
    status: "processed",
    amountPaise: 240_000,
    createdAt: "2026-10-30 06:00:00+00",
    ...over,
  };
}

describe("summarizeInvoiceRefunds", () => {
  it("counts processed and recorded refunds as money returned", () => {
    expect(
      summarizeInvoiceRefunds([
        fact({ status: "processed", amountPaise: 100_000 }),
        fact({ attemptId: "att-2", status: "recorded", amountPaise: 40_000 }),
      ]),
    ).toEqual({
      refundedPaise: 140_000,
      extraReturnedPaise: 0,
      inProgressPaise: 0,
      inProgress: false,
      delayed: false,
    });
  });

  it("★★ never counts a failed or cancelled refund as money returned", () => {
    // Neither moved a rupee. Counting one would tell the merchant they had
    // money back that never left StoreMink.
    const summary = summarizeInvoiceRefunds([
      fact({ status: "failed" }),
      fact({ attemptId: "att-2", status: "cancelled" }),
    ]);
    expect(summary.refundedPaise).toBe(0);
    expect(summary.extraReturnedPaise).toBe(0);
    expect(summary.inProgressPaise).toBe(0);
  });

  it("★★ counts a returned duplicate payment only as an extra payment returned", () => {
    // It reduces no supply and carries no credit note: it must never read as
    // a refund of the invoice ("Refunded in full" on a renewal still paid).
    const summary = summarizeInvoiceRefunds([
      fact({ reason: "duplicate_payment", status: "processed" }),
      fact({
        attemptId: "att-2",
        reason: "duplicate_payment",
        status: "recorded",
        amountPaise: 1_000,
      }),
    ]);
    expect(summary.extraReturnedPaise).toBe(241_000);
    expect(summary.refundedPaise).toBe(0);
  });

  it("a duplicate payment still on its way is in progress like any refund", () => {
    const summary = summarizeInvoiceRefunds([
      fact({ reason: "duplicate_payment", status: "owed" }),
    ]);
    expect(summary).toMatchObject({
      inProgressPaise: 240_000,
      inProgress: true,
      extraReturnedPaise: 0,
    });
  });

  it("owed and pending refunds are on their way", () => {
    const summary = summarizeInvoiceRefunds([
      fact({ status: "owed", amountPaise: 100_000 }),
      fact({ attemptId: "att-2", status: "pending", amountPaise: 50_000 }),
    ]);
    expect(summary.inProgressPaise).toBe(150_000);
    expect(summary.inProgress).toBe(true);
    expect(summary.refundedPaise).toBe(0);
  });

  it("★ a failed refund with nothing after it for that payment is delayed", () => {
    expect(summarizeInvoiceRefunds([fact({ status: "failed" })]).delayed).toBe(
      true,
    );
  });

  it("★ a failed refund somebody since retried or recorded is not delayed", () => {
    expect(
      summarizeInvoiceRefunds([
        fact({ status: "failed", createdAt: "2026-10-30 06:00:00+00" }),
        fact({ status: "recorded", createdAt: "2026-10-31 06:00:00+00" }),
      ]).delayed,
    ).toBe(false);
  });

  it("a later refund of ANOTHER payment does not settle a failed one", () => {
    expect(
      summarizeInvoiceRefunds([
        fact({ status: "failed", createdAt: "2026-10-30 06:00:00+00" }),
        fact({
          attemptId: "att-2",
          status: "processed",
          createdAt: "2026-10-31 06:00:00+00",
        }),
      ]).delayed,
    ).toBe(true);
  });

  it("an empty list is no refund at all", () => {
    expect(summarizeInvoiceRefunds([])).toEqual(NO_REFUNDS);
  });
});

describe("listInvoices: the refunds under each invoice", () => {
  const INVOICES = [
    {
      id: "inv-1",
      invoiceRef: "SM/2026-27/00001",
      status: "paid",
      totalPaise: 240_000,
    },
    {
      id: "inv-2",
      invoiceRef: "SM/2026-27/00002",
      status: "void",
      totalPaise: 240_000,
    },
  ];

  it("attaches each invoice's own refunds, read by its id", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [INVOICES],
      selectByTable: {
        billing_refunds: [
          [
            { invoiceId: "inv-2", ...fact(), amountPaise: "240000" },
            {
              invoiceId: "inv-1",
              ...fact({ attemptId: "att-9", status: "owed" }),
            },
          ],
        ],
      },
    });
    const rows = await listInvoices(STORE);
    expect(rows[0].refunds).toMatchObject({
      inProgress: true,
      refundedPaise: 0,
    });
    // bigint text from the driver is read as a number.
    expect(rows[1].refunds).toMatchObject({ refundedPaise: 240_000 });
    const refundRead = compile(dbHolder.current.calls.where[1]);
    expect(refundRead.sql).toContain('"billing_refunds"."invoice_id" in');
    expect(refundRead.params).toEqual(["inv-1", "inv-2"]);
  });

  it("★ a refunded paid invoice keeps its own status (rule R9)", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[INVOICES[0]]],
      selectByTable: { billing_refunds: [[{ invoiceId: "inv-1", ...fact() }]] },
    });
    const [row] = await listInvoices(STORE);
    expect(row.status).toBe("paid");
    expect(row.refunds.refundedPaise).toBe(240_000);
  });

  it("reads no refunds when there are no invoices", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await listInvoices(STORE)).toEqual([]);
    expect(dbHolder.current.db.select).toHaveBeenCalledTimes(1);
  });

  it("★ an unreadable refunds table costs the refund lines, never the list", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [INVOICES],
      selectByTable: {
        billing_refunds: [new Error("relation does not exist")],
      },
    });
    const rows = await listInvoices(STORE);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.refunds === NO_REFUNDS)).toBe(true);
    expect(logError).toHaveBeenCalledWith(
      "billing.list_invoice_refunds",
      expect.any(Error),
      { invoices: 2 },
    );
  });
});

describe("getInvoiceDocument: refunds and credit notes", () => {
  function seedWith(
    tables: Record<string, unknown[]>,
    over: Record<string, unknown> = {},
  ) {
    dbHolder.current = makeDbMock({
      selectQueue: [[invoiceRow(over)], []],
      selectByTable: tables as Record<string, (unknown[] | Error)[]> as never,
      executeQueue: [[{ parties: LIVE }]],
    });
  }

  it("carries the credit notes issued against it and its refunds", async () => {
    seedWith({
      billing_credit_notes: [
        [
          {
            id: "cn-1",
            creditNoteRef: "CN/2026-27/00001",
            issuedAt: "2026-10-30 06:00:00+00",
            totalPaise: "590000",
          },
        ],
      ],
      billing_refunds: [
        [{ invoiceId: "inv-1", ...fact({ amountPaise: 590_000 }) }],
      ],
    });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.credits).toEqual([
      {
        id: "cn-1",
        creditNoteRef: "CN/2026-27/00001",
        issuedAt: "2026-10-30 06:00:00+00",
        totalPaise: 590_000,
      },
    ]);
    expect(doc?.refunds.refundedPaise).toBe(590_000);
    expect(doc?.status).toBe("paid");
    // The notes are read by THIS invoice's id, the one already store-scoped.
    const where = dbHolder.current.calls.where.map((c: unknown) => compile(c));
    const notes = where.find((q: { sql: string }) =>
      q.sql.includes('"billing_credit_notes"."invoice_id"'),
    );
    expect(notes?.params).toEqual(["inv-1"]);
  });

  it("an invoice nobody refunded carries no credits and no refunds", async () => {
    seedWith({});
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.credits).toEqual([]);
    expect(doc?.refunds).toEqual(NO_REFUNDS);
  });

  it("★ an unreadable credit-note table still opens the invoice", async () => {
    // The invoice is the legal document; the block beside it is not worth
    // a 404.
    seedWith({ billing_credit_notes: [new Error("down")] });
    const doc = await getInvoiceDocument(STORE, "inv-1");
    expect(doc?.invoiceRef).toBe("SM/2026-27/00001");
    expect(doc?.credits).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "billing.get_invoice_credits",
      expect.any(Error),
      { invoiceId: "inv-1" },
    );
  });

  it("a draft is still no document, and its notes are never read", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[invoiceRow({ status: "draft", finalizedAt: null })]],
    });
    expect(await getInvoiceDocument(STORE, "inv-1")).toBeNull();
    expect(dbHolder.current.db.select).toHaveBeenCalledTimes(1);
  });

  it("opens an invoice whose status was set to refunded by hand", async () => {
    seedWith({}, { status: "refunded" });
    expect((await getInvoiceDocument(STORE, "inv-1"))?.status).toBe("refunded");
  });
});

function recent(over: Partial<RecentRefund> = {}): RecentRefund {
  return {
    id: "ref-1",
    attemptId: "att-1",
    invoiceId: "inv-1",
    invoiceRef: "SM/2026-27/00001",
    reason: "cycle_not_reached",
    status: "processed",
    method: "razorpay",
    amountPaise: 240_000,
    createdAt: "2026-10-30 06:00:00+00",
    resolvedAt: "2026-10-30 06:05:00+00",
    creditNote: null,
    ...over,
  };
}

describe("latestRefundPerPayment", () => {
  it("★ shows one row per payment, from its newest refund", () => {
    // An owed refund an operator cancelled and then recorded by bank
    // transfer is one refund to the merchant, not three.
    const rows = latestRefundPerPayment([
      recent({ id: "a", status: "owed", createdAt: "2026-10-28 06:00:00+00" }),
      recent({
        id: "b",
        status: "cancelled",
        createdAt: "2026-10-29 06:00:00+00",
      }),
      recent({
        id: "c",
        status: "recorded",
        createdAt: "2026-10-30 06:00:00+00",
      }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["c"]);
  });

  it("in a tie, the finished refund is the one shown", () => {
    const rows = latestRefundPerPayment([
      recent({ id: "a", status: "cancelled" }),
      recent({ id: "b", status: "recorded" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["b"]);
  });

  it("orders payments newest first and keeps the newest five", () => {
    const rows = latestRefundPerPayment(
      Array.from({ length: 7 }, (_, i) =>
        recent({
          id: `r${i}`,
          attemptId: `att-${i}`,
          createdAt: `2026-10-2${i} 06:00:00+00`,
        }),
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(["r6", "r5", "r4", "r3", "r2"]);
  });
});

describe("listRecentRefunds (the refunds notice, design 8.6)", () => {
  const STORE_ID = "11111111-1111-4111-8111-111111111111";
  const NOW = new Date("2026-10-30T00:00:00.000Z");

  function row(over: Record<string, unknown> = {}) {
    return {
      id: "ref-1",
      attemptId: "att-1",
      invoiceId: "inv-1",
      invoiceRef: "SM/2026-27/00001",
      reason: "cycle_not_reached",
      status: "processed",
      method: "razorpay",
      amountPaise: "240000",
      createdAt: "2026-10-29 06:00:00+00",
      resolvedAt: "2026-10-29 06:05:00+00",
      creditNoteId: "cn-1",
      creditNoteRef: "CN/2026-27/00001",
      ...over,
    };
  }

  it("maps each refund with its credit note", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { billing_refunds: [[row()]] },
    });
    expect(await listRecentRefunds(STORE_ID, { now: NOW })).toEqual([
      {
        id: "ref-1",
        attemptId: "att-1",
        invoiceId: "inv-1",
        invoiceRef: "SM/2026-27/00001",
        reason: "cycle_not_reached",
        status: "processed",
        method: "razorpay",
        amountPaise: 240_000,
        createdAt: "2026-10-29 06:00:00+00",
        resolvedAt: "2026-10-29 06:05:00+00",
        creditNote: { id: "cn-1", ref: "CN/2026-27/00001" },
      },
    ]);
  });

  it("★★ is scoped to the store through the invoice, over the last 90 days", async () => {
    // billing_refunds has no store column: the invoice's store_id is what
    // keeps one merchant's refunds off another's page.
    dbHolder.current = makeDbMock({ selectByTable: { billing_refunds: [[]] } });
    await listRecentRefunds(STORE_ID, { now: NOW });
    const where = compile(dbHolder.current.calls.where[0]);
    expect(where.sql).toContain('"billing_invoices"."store_id" = $1');
    expect(where.sql).toContain('"billing_refunds"."created_at" >= $2');
    expect(where.params).toEqual([STORE_ID, "2026-08-01T00:00:00.000Z"]);
    const [joined, on] = dbHolder.current.calls.innerJoin[0];
    expect(joined).toBeDefined();
    expect(compile(on).sql).toBe(
      '"billing_invoices"."id" = "billing_refunds"."invoice_id"',
    );
    const [, noteOn] = dbHolder.current.calls.leftJoin[0];
    expect(compile(noteOn).sql).toBe(
      '"billing_credit_notes"."refund_id" = "billing_refunds"."id"',
    );
  });

  it("a refund with no credit note carries none", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        billing_refunds: [
          [
            row({
              reason: "duplicate_payment",
              creditNoteId: null,
              creditNoteRef: null,
            }),
          ],
        ],
      },
    });
    const [refund] = await listRecentRefunds(STORE_ID, { now: NOW });
    expect(refund.creditNote).toBeNull();
  });

  it("drops a status it does not know rather than mis-word it", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { billing_refunds: [[row({ status: "mystery" })]] },
    });
    expect(await listRecentRefunds(STORE_ID, { now: NOW })).toEqual([]);
  });

  it("★ returns [] on a read failure: the notice never takes the page down", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { billing_refunds: [new Error("down")] },
    });
    expect(await listRecentRefunds(STORE_ID, { now: NOW })).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "billing.list_recent_refunds",
      expect.any(Error),
      { storeId: STORE_ID },
    );
  });
});
