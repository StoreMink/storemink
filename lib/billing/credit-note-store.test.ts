/* eslint-disable @typescript-eslint/no-explicit-any */
// StoreMink's own credit notes: issuing one and reading it back
// (renewal-cancel, design 6.7 and 8.8; owner decisions D3 and D9).
//
// The db mock does not evaluate SQL, so the predicates that decide which rows
// a statement touches (the invoice lock, the store scope, the payment states)
// are pinned by rendering each statement with the real Postgres dialect. The
// statements themselves were run against storemink_local in a rolled-back
// transaction (RC5 report).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock, type DbMock } from "@/app/actions/_test-helpers";
import type { RefundCreditNote } from "@/lib/email/billing-emails";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { withService } from "@/lib/db/client";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  creditNoteParticulars,
  getCreditNoteDocument,
  getCreditNoteDocumentForOperator,
  issueCreditNote,
  listCreditNotes,
} from "./credit-note-store";

const STORE = "33333333-3333-4333-8333-333333333333";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const REFUND = "11111111-1111-4111-8111-111111111111";
const OTHER_REFUND = "55555555-5555-4555-8555-555555555555";
const NOTE = "44444444-4444-4444-8444-444444444444";
const GSTIN_07 = "07AABCS1429B1ZX";

function render(query: unknown) {
  const q = new PgDialect().sqlToQuery(query as any);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

function useDb(executeQueue: any[][]): DbMock {
  const mock = makeDbMock({ executeQueue });
  dbHolder.current = mock;
  return mock;
}

function failingDb(): DbMock {
  const mock = makeDbMock();
  mock.db.execute = vi.fn(async () => {
    throw new Error("connection reset");
  });
  dbHolder.current = mock;
  return mock;
}

/** A completed refund of a whole ₹118 invoice (₹100 + 18% GST). */
function refundRow(over: Record<string, unknown> = {}) {
  return {
    id: REFUND,
    status: "processed",
    reason: "cycle_not_reached",
    amount_paise: "11800",
    invoice_id: INVOICE,
    finalized_at: "2026-10-01 10:00:00+05:30",
    total_paise: "11800",
    tax_paise: "1800",
    ...over,
  };
}

/** A closed, unpaid subscription invoice that charged GST. */
function closedInvoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    kind: "subscription",
    status: "void",
    finalized_at: "2026-10-01 10:00:00+05:30",
    total_paise: "11800",
    tax_paise: "1800",
    captured: false,
    in_flight: false,
    ...over,
  };
}

const INSERTED = [{ id: NOTE, credit_note_ref: "CN/2026-27/00001" }];

beforeEach(() => {
  dbHolder.current = makeDbMock();
});

describe("issueCreditNote: a completed refund", () => {
  it("issues a note for a processed refund of the whole invoice", async () => {
    const mock = useDb([[refundRow()], [], INSERTED]);
    const result = await issueCreditNote({
      kind: "refund",
      refundId: REFUND,
      issuedBy: "system",
    });

    expect(result).toEqual({
      outcome: "issued",
      note: {
        id: NOTE,
        creditNoteRef: "CN/2026-27/00001",
        invoiceId: INVOICE,
        refundId: REFUND,
        reason: "cycle_not_reached",
        totalPaise: 11800,
        taxPaise: 1800,
        taxablePaise: 10000,
      },
    });

    const insert = render(mock.calls.execute[2]);
    expect(insert.sql).toBe(
      "insert into public.billing_credit_notes (invoice_id, refund_id, reason, taxable_paise, tax_paise, total_paise, issued_by) values ($1, $2, $3, $4, $5, $6, $7) returning id, credit_note_ref",
    );
    expect(insert.params).toEqual([
      INVOICE,
      REFUND,
      "cycle_not_reached",
      10000,
      1800,
      11800,
      "system",
    ]);
  });

  it("issues a note for a refund recorded by hand, under the refund's own reason", async () => {
    const mock = useDb([
      [refundRow({ status: "recorded", reason: "goodwill" })],
      [],
      INSERTED,
    ]);
    const result = await issueCreditNote({
      kind: "refund",
      refundId: REFUND,
      issuedBy: "operator@storemink.com",
    });
    expect(result.outcome).toBe("issued");
    const insert = render(mock.calls.execute[2]);
    expect(insert.params[2]).toBe("goodwill");
    expect(insert.params[6]).toBe("operator@storemink.com");
  });

  it("★★ locks the invoice row before reading what is already credited", async () => {
    const mock = useDb([[refundRow()], [], INSERTED]);
    await issueCreditNote({
      kind: "refund",
      refundId: REFUND,
      issuedBy: "system",
    });

    const lock = render(mock.calls.execute[0]);
    expect(lock.sql).toContain(
      "from public.billing_refunds r join public.billing_invoices i on i.id = r.invoice_id",
    );
    expect(lock.sql).toContain("where r.id = $1");
    expect(lock.sql.endsWith("for update of i")).toBe(true);
    expect(lock.params).toEqual([REFUND]);

    const notes = render(mock.calls.execute[1]);
    expect(notes.sql).toBe(
      "select n.id, n.credit_note_ref, n.refund_id, n.reason, n.total_paise, n.tax_paise from public.billing_credit_notes n where n.invoice_id = $1",
    );
    expect(notes.params).toEqual([INVOICE]);
  });

  it.each(["owed", "pending", "failed", "cancelled"])(
    "waits while the refund is %s",
    async (status) => {
      const mock = useDb([[refundRow({ status })]]);
      const result = await issueCreditNote({
        kind: "refund",
        refundId: REFUND,
        issuedBy: "system",
      });
      expect(result).toEqual({
        outcome: "not_ready",
        why: "refund_not_finished",
      });
      expect(mock.calls.execute).toHaveLength(1);
    },
  );

  it("★ issues no note for a returned duplicate payment (D3)", async () => {
    const mock = useDb([[refundRow({ reason: "duplicate_payment" })]]);
    const result = await issueCreditNote({
      kind: "refund",
      refundId: REFUND,
      issuedBy: "system",
    });
    expect(result).toEqual({
      outcome: "not_needed",
      why: "duplicate_payment",
    });
    expect(mock.calls.execute).toHaveLength(1);
  });

  it("returns the note a refund already has instead of issuing a second", async () => {
    const mock = useDb([
      [refundRow()],
      [
        {
          id: NOTE,
          credit_note_ref: "CN/2026-27/00001",
          refund_id: REFUND,
          reason: "cycle_not_reached",
          total_paise: "11800",
          tax_paise: "1800",
        },
      ],
    ]);
    const result = await issueCreditNote({
      kind: "refund",
      refundId: REFUND,
      issuedBy: "system",
    });
    expect(result).toEqual({
      outcome: "exists",
      note: { id: NOTE, creditNoteRef: "CN/2026-27/00001" },
    });
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("credits only what is left, with the remaining tax, after an earlier note", async () => {
    // An earlier ₹50 refund took 762 paise of tax; this ₹68 refund finishes
    // the invoice and takes the 1,038 paise left.
    const mock = useDb([
      [refundRow({ amount_paise: "6800" })],
      [
        {
          id: "66666666-6666-4666-8666-666666666666",
          credit_note_ref: "CN/2026-27/00001",
          refund_id: OTHER_REFUND,
          reason: "goodwill",
          total_paise: "5000",
          tax_paise: "762",
        },
      ],
      [{ id: NOTE, credit_note_ref: "CN/2026-27/00002" }],
    ]);
    const result = await issueCreditNote({
      kind: "refund",
      refundId: REFUND,
      issuedBy: "system",
    });
    expect(result).toEqual({
      outcome: "issued",
      note: {
        id: NOTE,
        creditNoteRef: "CN/2026-27/00002",
        invoiceId: INVOICE,
        refundId: REFUND,
        reason: "cycle_not_reached",
        totalPaise: 6800,
        taxPaise: 1038,
        taxablePaise: 5762,
      },
    });
    expect(render(mock.calls.execute[2]).params.slice(3, 6)).toEqual([
      5762, 1038, 6800,
    ]);
  });

  it("★ issues no second note when the invoice is already fully credited (edge case 4)", async () => {
    const mock = useDb([
      [refundRow()],
      [
        {
          id: "66666666-6666-4666-8666-666666666666",
          credit_note_ref: "CN/2026-27/00001",
          refund_id: OTHER_REFUND,
          reason: "cycle_not_reached",
          total_paise: "11800",
          tax_paise: "1800",
        },
      ],
    ]);
    const result = await issueCreditNote({
      kind: "refund",
      refundId: REFUND,
      issuedBy: "system",
    });
    expect(result).toEqual({ outcome: "not_needed", why: "nothing_left" });
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("reports a refund it cannot find, or one on an invoice never issued", async () => {
    useDb([[]]);
    expect(
      await issueCreditNote({
        kind: "refund",
        refundId: REFUND,
        issuedBy: "system",
      }),
    ).toEqual({ outcome: "not_found" });

    useDb([[refundRow({ finalized_at: null })]]);
    expect(
      await issueCreditNote({
        kind: "refund",
        refundId: REFUND,
        issuedBy: "system",
      }),
    ).toEqual({ outcome: "not_found" });
  });

  it("refuses a malformed id without asking the database", async () => {
    const mock = useDb([]);
    expect(
      await issueCreditNote({
        kind: "refund",
        refundId: "not-a-uuid",
        issuedBy: "system",
      }),
    ).toEqual({ outcome: "not_found" });
    expect(mock.calls.execute).toHaveLength(0);
  });

  it("throws when nobody is named as issuing the note", async () => {
    const mock = useDb([]);
    await expect(
      issueCreditNote({ kind: "refund", refundId: REFUND, issuedBy: "  " }),
    ).rejects.toThrow("issueCreditNote needs issuedBy");
    expect(mock.calls.execute).toHaveLength(0);
  });

  it("runs inside the caller's transaction when given one", async () => {
    const mock = makeDbMock({ executeQueue: [[refundRow()], [], INSERTED] });
    const result = await issueCreditNote(
      { kind: "refund", refundId: REFUND, issuedBy: "system" },
      mock.db,
    );
    expect(result.outcome).toBe("issued");
    expect(withService).not.toHaveBeenCalled();
    expect(mock.calls.execute).toHaveLength(3);
  });

  it("opens its own transaction otherwise", async () => {
    useDb([[refundRow()], [], INSERTED]);
    await issueCreditNote({
      kind: "refund",
      refundId: REFUND,
      issuedBy: "system",
    });
    expect(withService).toHaveBeenCalledTimes(1);
  });

  it("★ throws on a database error, with or without the caller's transaction", async () => {
    failingDb();
    await expect(
      issueCreditNote({ kind: "refund", refundId: REFUND, issuedBy: "system" }),
    ).rejects.toThrow("connection reset");

    const passed = failingDb();
    await expect(
      issueCreditNote(
        { kind: "refund", refundId: REFUND, issuedBy: "system" },
        passed.db,
      ),
    ).rejects.toThrow("connection reset");
  });

  it("throws rather than report a note the insert did not return", async () => {
    useDb([[refundRow()], [], []]);
    await expect(
      issueCreditNote({ kind: "refund", refundId: REFUND, issuedBy: "system" }),
    ).rejects.toThrow("billing_credit_notes insert returned no row");
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("logs the issued note by ids and amounts only", async () => {
    useDb([[refundRow()], [], INSERTED]);
    await issueCreditNote({
      kind: "refund",
      refundId: REFUND,
      issuedBy: "system",
    });
    expect(logInfo).toHaveBeenCalledWith("billing.credit_note_issued", {
      creditNoteId: NOTE,
      creditNoteRef: "CN/2026-27/00001",
      invoiceId: INVOICE,
      refundId: REFUND,
      reason: "cycle_not_reached",
      totalPaise: 11800,
      taxPaise: 1800,
    });
  });
});

describe("issueCreditNote: a closed unpaid invoice", () => {
  it("cancels a void invoice that charged GST with a note for the whole invoice", async () => {
    const mock = useDb([[closedInvoiceRow()], [], INSERTED]);
    const result = await issueCreditNote({
      kind: "invoice_cancelled",
      invoiceId: INVOICE,
      issuedBy: "system",
    });
    expect(result).toEqual({
      outcome: "issued",
      note: {
        id: NOTE,
        creditNoteRef: "CN/2026-27/00001",
        invoiceId: INVOICE,
        refundId: null,
        reason: "invoice_cancelled",
        totalPaise: 11800,
        taxPaise: 1800,
        taxablePaise: 10000,
      },
    });
    expect(render(mock.calls.execute[2]).params).toEqual([
      INVOICE,
      null,
      "invoice_cancelled",
      10000,
      1800,
      11800,
      "system",
    ]);
  });

  it("cancels an uncollectible invoice too", async () => {
    useDb([[closedInvoiceRow({ status: "uncollectible" })], [], INSERTED]);
    const result = await issueCreditNote({
      kind: "invoice_cancelled",
      invoiceId: INVOICE,
      issuedBy: "system",
    });
    expect(result.outcome).toBe("issued");
  });

  it("★★ locks the invoice and asks about payments captured and still in flight", async () => {
    const mock = useDb([[closedInvoiceRow()], [], INSERTED]);
    await issueCreditNote({
      kind: "invoice_cancelled",
      invoiceId: INVOICE,
      issuedBy: "system",
    });
    const read = render(mock.calls.execute[0]);
    expect(read.sql).toContain(
      "a.state in ('captured', 'refunded')) as captured",
    );
    expect(read.sql).toContain(
      "a.state in ('created', 'processing', 'authorized', 'unknown')) as in_flight",
    );
    expect(read.sql).toContain(
      "from public.billing_invoices i where i.id = $1",
    );
    expect(read.sql.endsWith("for update of i")).toBe(true);
    expect(read.params).toEqual([INVOICE]);
  });

  it("★ issues no note for a closed invoice that charged no GST (D3)", async () => {
    const mock = useDb([[closedInvoiceRow({ tax_paise: "0" })], []]);
    expect(
      await issueCreditNote({
        kind: "invoice_cancelled",
        invoiceId: INVOICE,
        issuedBy: "system",
      }),
    ).toEqual({ outcome: "not_needed", why: "no_tax" });
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("★ leaves an invoice with a captured payment to its refund's note", async () => {
    const mock = useDb([[closedInvoiceRow({ captured: true })], []]);
    expect(
      await issueCreditNote({
        kind: "invoice_cancelled",
        invoiceId: INVOICE,
        issuedBy: "system",
      }),
    ).toEqual({ outcome: "not_needed", why: "payment_captured" });
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("★ waits while a payment on it may still land", async () => {
    const mock = useDb([[closedInvoiceRow({ in_flight: true })], []]);
    expect(
      await issueCreditNote({
        kind: "invoice_cancelled",
        invoiceId: INVOICE,
        issuedBy: "system",
      }),
    ).toEqual({ outcome: "not_ready", why: "payment_in_flight" });
    expect(mock.calls.execute).toHaveLength(2);
  });

  it.each([
    ["an open invoice", { status: "open" }],
    ["a paid invoice", { status: "paid" }],
    ["a processing invoice", { status: "processing" }],
  ])("waits on %s, which is not closed", async (_, over) => {
    const mock = useDb([[closedInvoiceRow(over)]]);
    expect(
      await issueCreditNote({
        kind: "invoice_cancelled",
        invoiceId: INVOICE,
        issuedBy: "system",
      }),
    ).toEqual({ outcome: "not_ready", why: "invoice_not_closed" });
    expect(mock.calls.execute).toHaveLength(1);
  });

  it("★ issues no note for a void draft, which was never issued", async () => {
    const mock = useDb([[closedInvoiceRow({ finalized_at: null })]]);
    expect(
      await issueCreditNote({
        kind: "invoice_cancelled",
        invoiceId: INVOICE,
        issuedBy: "system",
      }),
    ).toEqual({ outcome: "not_needed", why: "not_issued" });
    expect(mock.calls.execute).toHaveLength(1);
  });

  it.each([
    ["an add-on invoice", "addon"],
    ["a Mink credits invoice", "ai_credits"],
  ])("issues no cancellation note for %s", async (_, kind) => {
    const mock = useDb([[closedInvoiceRow({ kind })]]);
    expect(
      await issueCreditNote({
        kind: "invoice_cancelled",
        invoiceId: INVOICE,
        issuedBy: "system",
      }),
    ).toEqual({ outcome: "not_needed", why: "not_subscription" });
    expect(mock.calls.execute).toHaveLength(1);
  });

  it("returns the cancellation note an invoice already has", async () => {
    const mock = useDb([
      [closedInvoiceRow()],
      [
        {
          id: NOTE,
          credit_note_ref: "CN/2026-27/00004",
          refund_id: null,
          reason: "invoice_cancelled",
          total_paise: "11800",
          tax_paise: "1800",
        },
      ],
    ]);
    expect(
      await issueCreditNote({
        kind: "invoice_cancelled",
        invoiceId: INVOICE,
        issuedBy: "system",
      }),
    ).toEqual({
      outcome: "exists",
      note: { id: NOTE, creditNoteRef: "CN/2026-27/00004" },
    });
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("cancels only what earlier notes left", async () => {
    const mock = useDb([
      [closedInvoiceRow()],
      [
        {
          id: "66666666-6666-4666-8666-666666666666",
          credit_note_ref: "CN/2026-27/00001",
          refund_id: OTHER_REFUND,
          reason: "goodwill",
          total_paise: "5000",
          tax_paise: "762",
        },
      ],
      INSERTED,
    ]);
    const result = await issueCreditNote({
      kind: "invoice_cancelled",
      invoiceId: INVOICE,
      issuedBy: "system",
    });
    expect(result.outcome).toBe("issued");
    expect(render(mock.calls.execute[2]).params.slice(3, 6)).toEqual([
      5762, 1038, 6800,
    ]);
  });

  it("reports an invoice it cannot find", async () => {
    useDb([[]]);
    expect(
      await issueCreditNote({
        kind: "invoice_cancelled",
        invoiceId: INVOICE,
        issuedBy: "system",
      }),
    ).toEqual({ outcome: "not_found" });
  });
});

describe("listCreditNotes", () => {
  it("lists the store's notes newest first, scoped through the invoice", async () => {
    const mock = useDb([
      [
        {
          id: NOTE,
          credit_note_ref: "CN/2026-27/00002",
          issued_at: "2026-10-28 10:00:00+05:30",
          reason: "cycle_not_reached",
          total_paise: "11800",
          invoice_id: INVOICE,
          refund_id: REFUND,
          invoice_ref: "SM/2026-27/00007",
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          credit_note_ref: "CN/2026-27/00001",
          issued_at: "2026-10-20 09:00:00+05:30",
          reason: "invoice_cancelled",
          total_paise: "4720",
          invoice_id: INVOICE,
          refund_id: null,
          invoice_ref: null,
        },
      ],
    ]);

    expect(await listCreditNotes(STORE)).toEqual([
      {
        id: NOTE,
        creditNoteRef: "CN/2026-27/00002",
        issuedAt: "2026-10-28 10:00:00+05:30",
        reason: "cycle_not_reached",
        totalPaise: 11800,
        invoiceId: INVOICE,
        invoiceRef: "SM/2026-27/00007",
        refundId: REFUND,
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        creditNoteRef: "CN/2026-27/00001",
        issuedAt: "2026-10-20 09:00:00+05:30",
        reason: "invoice_cancelled",
        totalPaise: 4720,
        invoiceId: INVOICE,
        invoiceRef: null,
        refundId: null,
      },
    ]);

    const q = render(mock.calls.execute[0]);
    expect(q.sql).toContain(
      "from public.billing_credit_notes n join public.billing_invoices i on i.id = n.invoice_id where i.store_id = $1",
    );
    expect(q.sql).toContain(
      "order by n.issued_at desc, n.fy_label desc, n.credit_note_no desc limit $2",
    );
    expect(q.params).toEqual([STORE, 50]);
  });

  it("bounds the number of notes it reads", async () => {
    const mock = useDb([[], [], []]);
    await listCreditNotes(STORE, 5000);
    await listCreditNotes(STORE, 0);
    await listCreditNotes(STORE, 12.7);
    expect(mock.calls.execute.map((c) => render(c).params[1])).toEqual([
      200, 50, 12,
    ]);
  });

  it("shows no notes, rather than failing the page, when the read fails", async () => {
    failingDb();
    expect(await listCreditNotes(STORE)).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "billing.list_credit_notes",
      expect.any(Error),
      { storeId: STORE },
    );
  });

  it("reads nothing for a malformed store id", async () => {
    const mock = useDb([]);
    expect(await listCreditNotes("store-1")).toEqual([]);
    expect(mock.calls.execute).toHaveLength(0);
  });
});

/** One note as the document read returns it. */
function noteRow(over: Record<string, unknown> = {}) {
  return {
    id: NOTE,
    credit_note_ref: "CN/2026-27/00001",
    issued_at: "2026-10-28 10:00:00+05:30",
    reason: "cycle_not_reached",
    invoice_id: INVOICE,
    refund_id: REFUND,
    taxable_paise: "10000",
    tax_paise: "1800",
    total_paise: "11800",
    tax_rate_bps: 1800,
    supplier_gstin: GSTIN_07,
    customer_gstin: null,
    place_of_supply: "07",
    // An invoice issued before the basis was recorded (GST, A6).
    place_of_supply_basis: null,
    parties: {
      version: 1,
      capturedAt: "2026-10-01T04:30:00.000Z",
      supplier: {
        name: "StoreMink LLP",
        gstin: GSTIN_07,
        stateCode: "07",
        address: { line1: "Bala ji Colony", city: "Faridkot" },
      },
      customer: {
        name: "Echoss",
        gstin: null,
        stateCode: "07",
        address: { line1: "12 Market Road", city: "New Delhi" },
        email: "owner@example.com",
      },
    },
    invoice_ref: "SM/2026-27/00007",
    invoice_issued_at: "2026-10-01 10:00:00+05:30",
    store_id: STORE,
    refund_method: "razorpay",
    refunded_at: "2026-10-28 09:00:00+05:30",
    external_reference: null,
    provider_refund_id: "rfnd_123",
    ...over,
  };
}

describe("getCreditNoteDocument", () => {
  it("returns the note as the sheet prints it", async () => {
    useDb([[noteRow()]]);
    expect(await getCreditNoteDocument(STORE, NOTE)).toEqual({
      id: NOTE,
      creditNoteRef: "CN/2026-27/00001",
      issuedAt: "2026-10-28 10:00:00+05:30",
      reason: "cycle_not_reached",
      invoiceId: INVOICE,
      invoiceRef: "SM/2026-27/00007",
      invoiceIssuedAt: "2026-10-01 10:00:00+05:30",
      taxablePaise: 10000,
      taxPaise: 1800,
      totalPaise: 11800,
      taxRateBps: 1800,
      supplierGstin: GSTIN_07,
      customerGstin: null,
      placeOfSupply: "07",
      placeOfSupplyBasis: null,
      recipientStateCode: "07",
      taxLines: [
        { name: "CGST", rateBps: 900, amountPaise: 900 },
        { name: "SGST", rateBps: 900, amountPaise: 900 },
      ],
      supplier: {
        legalName: "StoreMink LLP",
        address: { line1: "Bala ji Colony", city: "Faridkot" },
        llpin: null,
        registeredOffice: null,
      },
      customer: {
        legalName: "Echoss",
        address: { line1: "12 Market Road", city: "New Delhi" },
        billingEmail: "owner@example.com",
      },
      refund: {
        method: "razorpay",
        refundedAt: "2026-10-28 09:00:00+05:30",
        reference: "rfnd_123",
      },
    });
  });

  it("★★ is scoped to the store through the invoice", async () => {
    const mock = useDb([[noteRow()]]);
    await getCreditNoteDocument(STORE, NOTE);
    const q = render(mock.calls.execute[0]);
    expect(q.sql).toContain(
      "from public.billing_credit_notes n join public.billing_invoices i on i.id = n.invoice_id left join public.billing_refunds r on r.id = n.refund_id",
    );
    expect(q.sql).toContain("where n.id = $1 and i.store_id = $2 limit 1");
    expect(q.params).toEqual([NOTE, STORE]);
  });

  it("★ reads the invoice's place-of-supply basis with the note (GST, A6)", async () => {
    const mock = useDb([[noteRow({ place_of_supply_basis: "recipient" })]]);
    const doc = await getCreditNoteDocument(STORE, NOTE);
    expect(render(mock.calls.execute[0]).sql).toContain(
      "i.place_of_supply_basis",
    );
    expect(doc?.placeOfSupplyBasis).toBe("recipient");
    expect(doc?.recipientStateCode).toBe("07");
  });

  it("★★ a supplier-basis note names no customer State, whatever its parties recorded", async () => {
    useDb([
      [
        noteRow({
          supplier_gstin: "03AABCS1429B1ZX",
          place_of_supply: "03",
          place_of_supply_basis: "supplier",
          parties: {
            ...noteRow().parties,
            customer: { ...noteRow().parties.customer, stateCode: "03" },
          },
        }),
      ],
    ]);
    const doc = await getCreditNoteDocument(STORE, NOTE);
    expect(doc?.recipientStateCode).toBeNull();
    expect(doc?.placeOfSupply).toBe("03");
    // The split is still the supplier's own State, intra-state.
    expect(doc?.taxLines.map((l) => l.name)).toEqual(["CGST", "SGST"]);
  });

  it("★★ a note on a 96 invoice names no customer State and is IGST", async () => {
    useDb([
      [
        noteRow({
          place_of_supply: "96",
          place_of_supply_basis: "outside_india",
        }),
      ],
    ]);
    const doc = await getCreditNoteDocument(STORE, NOTE);
    expect(doc?.recipientStateCode).toBeNull();
    expect(doc?.placeOfSupply).toBe("96");
    expect(doc?.taxLines).toEqual([
      { name: "IGST", rateBps: 1800, amountPaise: 1800 },
    ]);
  });

  it("returns nothing for another store's note or an unknown id", async () => {
    useDb([[]]);
    expect(await getCreditNoteDocument(STORE, NOTE)).toBeNull();
  });

  it("returns nothing for a malformed id without asking the database", async () => {
    const mock = useDb([]);
    expect(await getCreditNoteDocument(STORE, "CN/2026-27/00001")).toBeNull();
    expect(await getCreditNoteDocument("store-1", NOTE)).toBeNull();
    expect(mock.calls.execute).toHaveLength(0);
  });

  it("returns nothing when the read fails, and logs it", async () => {
    failingDb();
    expect(await getCreditNoteDocument(STORE, NOTE)).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "billing.get_credit_note_document",
      expect.any(Error),
      { storeId: STORE, creditNoteId: NOTE },
    );
  });

  it("prints IGST for an inter-state note", async () => {
    useDb([[noteRow({ place_of_supply: "29" })]]);
    const doc = await getCreditNoteDocument(STORE, NOTE);
    expect(doc?.taxLines).toEqual([
      { name: "IGST", rateBps: 1800, amountPaise: 1800 },
    ]);
  });

  it("prints no tax line for a note that credits no tax", async () => {
    useDb([
      [
        noteRow({
          tax_paise: "0",
          taxable_paise: "11800",
          supplier_gstin: null,
        }),
      ],
    ]);
    expect((await getCreditNoteDocument(STORE, NOTE))?.taxLines).toEqual([]);
  });

  it("gives a bank transfer refund its UTR", async () => {
    useDb([
      [
        noteRow({
          refund_method: "bank_transfer",
          external_reference: "UTR123456789",
          provider_refund_id: null,
        }),
      ],
    ]);
    expect((await getCreditNoteDocument(STORE, NOTE))?.refund).toEqual({
      method: "bank_transfer",
      refundedAt: "2026-10-28 09:00:00+05:30",
      reference: "UTR123456789",
    });
  });

  it("falls back to the recorded reference for a Razorpay refund made by hand", async () => {
    useDb([
      [
        noteRow({
          provider_refund_id: null,
          external_reference: "rfnd_manual",
        }),
      ],
    ]);
    expect((await getCreditNoteDocument(STORE, NOTE))?.refund?.reference).toBe(
      "rfnd_manual",
    );
  });

  it("has no refund line for a note cancelling an unpaid invoice", async () => {
    useDb([
      [
        noteRow({
          reason: "invoice_cancelled",
          refund_id: null,
          refund_method: null,
          refunded_at: null,
          provider_refund_id: null,
        }),
      ],
    ]);
    expect((await getCreditNoteDocument(STORE, NOTE))?.refund).toBeNull();
  });

  it("★ reads today's parties only when the note's own record is unreadable", async () => {
    const mock = useDb([
      [noteRow({ parties: { version: 2 } })],
      [
        {
          parties: {
            version: 1,
            capturedAt: null,
            supplier: {
              name: "StoreMink LLP",
              gstin: GSTIN_07,
              stateCode: "07",
              address: { city: "Faridkot" },
            },
            customer: {
              name: "Echoss Retail",
              gstin: null,
              stateCode: "07",
              address: {},
              email: null,
            },
          },
        },
      ],
    ]);
    const doc = await getCreditNoteDocument(STORE, NOTE);
    expect(doc?.customer.legalName).toBe("Echoss Retail");
    expect(logWarn).toHaveBeenCalledWith(
      "billing.credit_note_parties_unreadable",
      { creditNoteId: NOTE },
    );
    const fallback = render(mock.calls.execute[1]);
    expect(fallback.sql).toBe(
      "select public.billing_invoice_parties($1::uuid, $2::text, $3::text, $4::text) as parties",
    );
    expect(fallback.params).toEqual([STORE, GSTIN_07, null, "07"]);
  });

  it("★ a supplier-basis note's fallback parties carry no customer State", async () => {
    const mock = useDb([
      [
        noteRow({
          supplier_gstin: "03AABCS1429B1ZX",
          place_of_supply: "03",
          place_of_supply_basis: "supplier",
          parties: null,
        }),
      ],
      [{ parties: null }],
    ]);
    await getCreditNoteDocument(STORE, NOTE);
    expect(render(mock.calls.execute[1]).params).toEqual([
      STORE,
      "03AABCS1429B1ZX",
      null,
      null,
    ]);
  });

  // R2-09: the note carries the LLP's particulars its parties recorded (the
  // issuing trigger copies them from the invoice since 0266), and, the
  // invoice's rule (R2-08), no LLPIN without a recorded legal name.
  it("carries the LLP's particulars the note recorded", async () => {
    const parties = noteRow().parties;
    useDb([
      [
        noteRow({
          parties: {
            ...parties,
            supplier: {
              ...parties.supplier,
              llpin: "ADC-5432",
              registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
            },
          },
        }),
      ],
    ]);
    const doc = await getCreditNoteDocument(STORE, NOTE);
    expect(doc?.supplier).toMatchObject({
      legalName: "StoreMink LLP",
      llpin: "ADC-5432",
      registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
    });
  });

  it("carries no LLPIN without a recorded legal name", async () => {
    const parties = noteRow().parties;
    useDb([
      [
        noteRow({
          parties: {
            ...parties,
            supplier: { ...parties.supplier, name: null, llpin: "ADC-5432" },
          },
        }),
      ],
    ]);
    const doc = await getCreditNoteDocument(STORE, NOTE);
    expect(doc?.supplier.legalName).toBe("StoreMink");
    expect(doc?.supplier.llpin).toBeNull();
  });

  it("names StoreMink as the supplier when no record can be read at all", async () => {
    useDb([[noteRow({ parties: null })], [{ parties: null }]]);
    const doc = await getCreditNoteDocument(STORE, NOTE);
    expect(doc?.supplier).toEqual({
      legalName: "StoreMink",
      address: {},
      llpin: null,
      registeredOffice: null,
    });
    expect(doc?.customer).toEqual({
      legalName: null,
      address: {},
      billingEmail: null,
    });
  });
});

describe("getCreditNoteDocumentForOperator", () => {
  it("reads a note with no store predicate", async () => {
    const mock = useDb([[noteRow()]]);
    const doc = await getCreditNoteDocumentForOperator(NOTE);
    expect(doc?.creditNoteRef).toBe("CN/2026-27/00001");
    const q = render(mock.calls.execute[0]);
    expect(q.sql).toContain("where n.id = $1 limit 1");
    expect(q.sql).not.toContain("i.store_id =");
    expect(q.params).toEqual([NOTE]);
  });

  it("reads a note on an invoice kept after its store was deleted", async () => {
    useDb([[noteRow({ store_id: null })]]);
    const doc = await getCreditNoteDocumentForOperator(NOTE);
    expect(doc?.customer.legalName).toBe("Echoss");
  });

  it("returns nothing when the read fails, and logs it", async () => {
    failingDb();
    expect(await getCreditNoteDocumentForOperator(NOTE)).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "billing.get_credit_note_document_operator",
      expect.any(Error),
      { creditNoteId: NOTE },
    );
  });

  it("returns nothing for a malformed id", async () => {
    const mock = useDb([]);
    expect(await getCreditNoteDocumentForOperator("nope")).toBeNull();
    expect(mock.calls.execute).toHaveLength(0);
  });
});

describe("creditNoteParticulars", () => {
  it("★★ returns exactly the shape the refund email prints", async () => {
    useDb([[noteRow()]]);
    const particulars: RefundCreditNote | null = await creditNoteParticulars({
      creditNoteId: NOTE,
    });
    expect(particulars).toEqual({
      ref: "CN/2026-27/00001",
      issuedAt: "2026-10-28 10:00:00+05:30",
      invoiceRef: "SM/2026-27/00007",
      invoiceIssuedAt: "2026-10-01 10:00:00+05:30",
      supplier: {
        name: "StoreMink LLP",
        address: { line1: "Bala ji Colony", city: "Faridkot" },
        gstin: GSTIN_07,
        llpin: null,
        registeredOffice: null,
      },
      recipient: {
        name: "Echoss",
        address: { line1: "12 Market Road", city: "New Delhi" },
        gstin: null,
        stateCode: "07",
      },
      placeOfSupply: "07",
      taxablePaise: 10000,
      taxLines: [
        { name: "CGST", rateBps: 900, amountPaise: 900 },
        { name: "SGST", rateBps: 900, amountPaise: 900 },
      ],
      totalPaise: 11800,
    });
  });

  it("★★ prints no customer State for a supplier-basis note (GST, A6)", async () => {
    useDb([
      [
        noteRow({
          supplier_gstin: "03AABCS1429B1ZX",
          place_of_supply: "03",
          place_of_supply_basis: "supplier",
        }),
      ],
    ]);
    const particulars = await creditNoteParticulars({ creditNoteId: NOTE });
    // The place of supply is the supplier's own State: it is never printed
    // as the merchant's, only as the place of supply (R2-02).
    expect(particulars?.recipient.stateCode).toBeNull();
    expect(particulars?.placeOfSupply).toBe("03");
  });

  it("★★ prints no customer State for a note on a 96 invoice (GST, A6)", async () => {
    useDb([
      [
        noteRow({
          place_of_supply: "96",
          place_of_supply_basis: "outside_india",
        }),
      ],
    ]);
    const particulars = await creditNoteParticulars({ creditNoteId: NOTE });
    expect(particulars?.recipient.stateCode).toBeNull();
    // R2-02: the place of supply rides separately, so the email prints 96 on
    // its own row.
    expect(particulars?.placeOfSupply).toBe("96");
    expect(particulars?.taxLines).toEqual([
      { name: "IGST", rateBps: 1800, amountPaise: 1800 },
    ]);
  });

  it("carries the LLP's particulars for the closed-store email (R2-09)", async () => {
    const parties = noteRow().parties;
    useDb([
      [
        noteRow({
          parties: {
            ...parties,
            supplier: {
              ...parties.supplier,
              llpin: "ADC-5432",
              registeredOffice: "Faridkot",
            },
          },
        }),
      ],
    ]);
    const particulars = await creditNoteParticulars({ creditNoteId: NOTE });
    expect(particulars?.supplier).toMatchObject({
      name: "StoreMink LLP",
      llpin: "ADC-5432",
      registeredOffice: "Faridkot",
    });
  });

  it("prints the place of supply as the State for a recipient-basis note", async () => {
    useDb([
      [noteRow({ place_of_supply: "29", place_of_supply_basis: "recipient" })],
    ]);
    const particulars = await creditNoteParticulars({ creditNoteId: NOTE });
    expect(particulars?.recipient.stateCode).toBe("29");
  });

  it("finds a refund's note by the refund", async () => {
    const mock = useDb([[noteRow()]]);
    expect((await creditNoteParticulars({ refundId: REFUND }))?.ref).toBe(
      "CN/2026-27/00001",
    );
    const q = render(mock.calls.execute[0]);
    expect(q.sql).toContain("where n.refund_id = $1 limit 1");
    expect(q.params).toEqual([REFUND]);
  });

  it("takes the GSTINs and place of supply from the record when the note's columns are empty", async () => {
    useDb([
      [
        noteRow({
          supplier_gstin: null,
          place_of_supply: null,
          parties: {
            ...noteRow().parties,
            customer: {
              ...noteRow().parties.customer,
              gstin: "29AABCE1234F1Z5",
              stateCode: "29",
            },
          },
        }),
      ],
    ]);
    const particulars = await creditNoteParticulars({ creditNoteId: NOTE });
    expect(particulars?.supplier.gstin).toBe(GSTIN_07);
    expect(particulars?.recipient.gstin).toBe("29AABCE1234F1Z5");
    expect(particulars?.recipient.stateCode).toBe("29");
    // No supplier GSTIN on the note itself: no tax line is printed for it.
    expect(particulars?.taxLines).toEqual([]);
  });

  it("returns nothing when there is no note (a duplicate payment, or nothing left)", async () => {
    useDb([[]]);
    expect(await creditNoteParticulars({ refundId: REFUND })).toBeNull();
  });

  it("★ throws on a database error rather than mail a note-less email", async () => {
    failingDb();
    await expect(creditNoteParticulars({ refundId: REFUND })).rejects.toThrow(
      "connection reset",
    );
  });

  it("runs inside the caller's transaction when given one", async () => {
    const mock = makeDbMock({ executeQueue: [[noteRow()]] });
    await creditNoteParticulars({ refundId: REFUND }, mock.db);
    expect(withService).not.toHaveBeenCalled();
    expect(mock.calls.execute).toHaveLength(1);
  });

  it("returns nothing for a malformed id without asking the database", async () => {
    const mock = useDb([]);
    expect(await creditNoteParticulars({ refundId: "x" })).toBeNull();
    expect(await creditNoteParticulars({ creditNoteId: "" })).toBeNull();
    expect(mock.calls.execute).toHaveLength(0);
  });
});
