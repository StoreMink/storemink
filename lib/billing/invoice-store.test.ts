/* eslint-disable @typescript-eslint/no-explicit-any */
// The invoice repository.
//
// ── What these tests can and cannot prove ──────────────────────────────────
// The guarantees this module leans on live in POSTGRES, not here: exactly-once
// creation is the billing_invoices_one_per_cycle UNIQUE index, immutability is
// a trigger, and the document number comes from another trigger. None of that
// is verifiable against a mock — it is proved against a real database by
// scripts/billing-verify.sql (26/26 on staging).
//
// So what IS proved here is the layer around them: that a lost race reads the
// winner's invoice instead of creating a second obligation, that lines are
// written BEFORE finalization (the trigger freezes them after), that tax is
// snapshotted rather than referenced, and that nothing throws into a caller who
// is part-way through collecting money.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

import { logError, logWarn } from "@/lib/observability/logger";
import { withService } from "@/lib/db/client";
import { sqlParamValues, sqlText } from "@/app/actions/_test-helpers";
import {
  amountDueForInvoice,
  createAddonInvoice,
  createAiCreditsInvoice,
  ensureRenewalInvoice,
  finalizeInvoice,
  finalizeInvoiceClaimed,
  finalizePaidAiCreditsInvoice,
  getCycleInvoice,
  getInvoice,
  issueInvoice,
  loadTaxSnapshot,
  readTaxSnapshot,
  reshapeDraftSubscriptionInvoice,
} from "./invoice-store";
import { buildSubscriptionInvoice, type TaxContext } from "./invoice";
import { billingReconciliationItems } from "@/drizzle/schema";
import type { InvoiceTaxStamp } from "./tax-snapshot";

const STORE = "store-1";
const INVOICE = "inv-1";

const EXCLUSIVE: TaxContext = {
  enabled: true,
  rateBps: 1800,
  inclusive: false,
  supplierStateCode: "07",
  placeOfSupply: "29",
};

const BUILT = buildSubscriptionInvoice({
  planLabel: "Basic",
  period: "yearly",
  planPaise: 15_000_00,
  tax: EXCLUSIVE,
});

const INVOICE_ROW = {
  id: INVOICE,
  storeId: STORE,
  kind: "subscription",
  status: "draft",
  totalPaise: 17_700_00,
  cycleSeq: 1,
  invoiceRef: null,
  finalizedAt: null,
};

/** A draft as `issueInvoice` locks it: untaxed, stamped for a merchant in
 *  Karnataka (29) while GST was off. */
const DRAFT = {
  id: INVOICE,
  storeId: STORE,
  kind: "subscription",
  status: "draft",
  finalizedAt: null,
  discountPaise: 0,
  totalPaise: 17_700_00,
  taxRateBps: 0,
  taxInclusive: false,
  supplierGstin: null,
  customerGstin: null,
  placeOfSupply: "29",
  placeOfSupplyBasis: "recipient",
  sacCode: null,
};

const NOW = new Date("2026-12-05T00:00:00.000Z");

/** StoreMink's settings row with GST off (the tax columns as the reading
 *  names them). */
const SETTINGS_OFF = {
  taxEnabled: false,
  taxInclusive: false,
  taxRateBps: 1800,
  nextTaxEnabled: null,
  nextTaxInclusive: null,
  nextTaxRateBps: null,
  nextTaxStartsAt: null,
  supplierGstin: null,
  supplierStateCode: null,
  sacCode: null,
};

/** GST on at 18%, added on top, with StoreMink's identity complete (Punjab). */
const SETTINGS_ON = {
  ...SETTINGS_OFF,
  taxEnabled: true,
  supplierGstin: "03ABCDE1234F1Z5",
  supplierStateCode: "03",
  sacCode: "998314",
};

/** GST off now, starting at 00:00 IST on 1 December 2026. */
const SCHEDULED_AT_MIDNIGHT_IST = {
  ...SETTINGS_ON,
  taxEnabled: false,
  nextTaxEnabled: true,
  nextTaxInclusive: false,
  nextTaxRateBps: 1800,
  nextTaxStartsAt: "2026-11-30T18:30:00.000Z",
};

/** The merchant's billing account: Karnataka, no GSTIN. */
const ACCOUNT = { gstin: null, stateCode: "29", address: {} };

/** The store's other records, none of which names a state. */
const STORE_RECORDS = {
  tax_id: null,
  business_state_code: null,
  business_address: null,
  location_gstin: null,
  location_state_code: null,
  signup_state_name: null,
  signup_country: null,
};

/** What SETTINGS_ON and ACCOUNT stamp. */
const STAMP_ON: InvoiceTaxStamp = {
  supplierGstin: "03ABCDE1234F1Z5",
  customerGstin: null,
  placeOfSupply: "29",
  placeOfSupplyBasis: "recipient",
  sacCode: "998314",
};

function seed(
  opts: {
    selects?: any[][];
    returning?: any[];
    byTable?: Record<string, any[][]>;
    execute?: any[][];
  } = {},
) {
  dbHolder.current = makeDbMock({
    selectQueue: opts.selects ?? [],
    selectByTable: opts.byTable,
    executeQueue: opts.execute,
    returning: opts.returning ?? [{ id: INVOICE }],
  });
}

/**
 * The reads one `issueInvoice` call makes, by table: the draft locked, the
 * settings and account `for share`, the stored lines, then the invoice read
 * back. Raw reads in order: whether it is frozen (skipped for a paid
 * checkout), then the store's other records (skipped without a store).
 */
function seedIssue(
  opts: {
    draft?: Record<string, unknown>;
    readBack?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    account?: Record<string, unknown>;
    frozen?: boolean;
    lines?: Record<string, unknown>[];
    paid?: boolean;
    claimed?: boolean;
    /** The invoice's payment attempts, as the kept-draft filing reads them. */
    attempts?: Record<string, unknown>[];
    failInsertFor?: unknown[];
  } = {},
) {
  const draft = { ...DRAFT, ...(opts.draft ?? {}) };
  const execute: any[][] = [];
  if (!opts.paid) execute.push([{ frozen: opts.frozen === true }]);
  if (draft.storeId) execute.push([STORE_RECORDS]);
  dbHolder.current = makeDbMock({
    selectByTable: {
      billing_invoices: [
        [draft],
        [opts.readBack ?? { ...INVOICE_ROW, status: "open" }],
      ],
      platform_billing_settings: [[opts.settings ?? SETTINGS_OFF]],
      billing_accounts: [[opts.account ?? ACCOUNT]],
      billing_invoice_items: [opts.lines ?? []],
      billing_payment_attempts: [opts.attempts ?? []],
    },
    executeQueue: execute,
    returning: opts.claimed === false ? [] : [{ id: INVOICE }],
    failInsertFor: opts.failInsertFor,
  });
}

/** The claim's SET: the one write that stamps `finalizedAt`. */
function claimSet() {
  const sets = dbHolder.current.calls.set.filter(
    (s: Record<string, unknown>) => "finalizedAt" in s && s.finalizedAt,
  );
  expect(sets).toHaveLength(1);
  return sets[0];
}

/** The claim's WHERE, rendered by the real Postgres dialect. */
function claimWhere() {
  const rendered = dbHolder.current.calls.where
    .map((clause: unknown) => new PgDialect().sqlToQuery(clause as never))
    .filter((q: { sql: string }) =>
      q.sql.includes('"billing_invoices"."finalized_at" is null'),
    );
  expect(rendered).toHaveLength(1);
  return rendered[0] as { sql: string; params: unknown[] };
}

function brokenDb() {
  const down = () => {
    throw new Error("db down");
  };
  dbHolder.current = {
    db: {
      select: down,
      insert: down,
      update: down,
      delete: down,
      execute: down,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("ensureRenewalInvoice", () => {
  const args = {
    storeId: STORE,
    cycleSeq: 1,
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    built: BUILT,
    stamp: STAMP_ON,
  };

  it("writes the invoice with the built totals, as a DRAFT", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    const row = await ensureRenewalInvoice(args);
    expect(row?.id).toBe(INVOICE);

    const values = dbHolder.current.calls.values[0];
    expect(values).toMatchObject({
      storeId: STORE,
      kind: "subscription",
      status: "draft",
      cycleSeq: 1,
      subtotalPaise: 15_000_00,
      taxPaise: 2_700_00,
      totalPaise: 17_700_00,
    });
  });

  it("★ snapshots the tax RATE onto the invoice, not a reference to settings", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    await ensureRenewalInvoice(args);
    expect(dbHolder.current.calls.values[0].taxRateBps).toBe(1800);
  });

  it("★ writes the lines BEFORE finalization — the trigger freezes them after", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    await ensureRenewalInvoice(args);
    // Two inserts: the invoice, then its lines. Nothing sets finalized_at here.
    expect(dbHolder.current.calls.values).toHaveLength(2);
    const lines = dbHolder.current.calls.values[1];
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.map((l: any) => l.kind)).toEqual(["base_plan", "tax"]);
    expect(dbHolder.current.calls.values[0].finalizedAt).toBeUndefined();
  });

  it("orders the lines so a printed invoice is stable", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    await ensureRenewalInvoice(args);
    expect(
      dbHolder.current.calls.values[1].map((l: any) => l.sortOrder),
    ).toEqual([0, 1]);
  });

  it("★★ a LOST RACE reads the winner's invoice, never creating a second one", async () => {
    // onConflictDoNothing returned no row: someone else inserted this cycle.
    seed({ returning: [], selects: [[{ ...INVOICE_ROW, id: "inv-winner" }]] });
    const row = await ensureRenewalInvoice(args);
    expect(row?.id).toBe("inv-winner");
    // Only the invoice insert was attempted — no lines for an invoice we did
    // not create, which would attach duplicates to the winner's document.
    expect(dbHolder.current.calls.values).toHaveLength(1);
  });

  it("returns null when the race is lost AND the winner cannot be read", async () => {
    seed({ returning: [], selects: [[]] });
    expect(await ensureRenewalInvoice(args)).toBeNull();
  });

  it("★ never throws into a caller mid-collection; logs and returns null", async () => {
    brokenDb();
    expect(await ensureRenewalInvoice(args)).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});

describe("reshapeDraftSubscriptionInvoice", () => {
  const BUILT = {
    lines: [
      {
        kind: "base_plan" as const,
        description: "Pro plan — yearly",
        quantity: 1,
        unitAmountPaise: 24_000_00,
        amountPaise: 24_000_00,
      },
    ],
    subtotalPaise: 24_000_00,
    discountPaise: 0,
    taxPaise: 0,
    totalPaise: 24_000_00,
    taxRateBps: 0,
    gst: { intraState: true, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 },
    inclusive: false,
  };

  const input = {
    invoiceId: INVOICE,
    storeId: STORE,
    periodStart: new Date("2026-09-06T00:00:00.000Z"),
    periodEnd: new Date("2027-09-06T00:00:00.000Z"),
    built: BUILT,
    stamp: STAMP_ON,
  };

  it("rewrites an unpaid draft to the new shape", async () => {
    seed({
      selects: [
        [{ id: INVOICE, status: "draft", finalizedAt: null, paidAt: null }],
        [{ ...INVOICE_ROW, totalPaise: 24_000_00 }],
      ],
    });
    const row = await reshapeDraftSubscriptionInvoice(input);
    expect(row?.totalPaise).toBe(24_000_00);
    // Old lines go, new lines land — a merged set would double the plan line.
    expect(dbHolder.current.calls.delete.length).toBe(1);
  });

  it("★★ REFUSES a finalized invoice — that is a document, not a choice", async () => {
    // Finalizing allocates a number in the gapless GST series, so the document
    // has been issued. Rewriting one is not a draft edit; the database's own
    // immutability trigger would refuse it too.
    seed({
      selects: [
        [
          {
            id: INVOICE,
            status: "open",
            finalizedAt: "2026-09-06T00:00:00.000Z",
            paidAt: null,
          },
        ],
      ],
    });
    expect(await reshapeDraftSubscriptionInvoice(input)).toBeNull();
    expect(dbHolder.current.calls.delete.length).toBe(0);
  });

  it("★★ REFUSES a paid invoice", async () => {
    // Money has moved against this amount. Changing it afterwards would leave
    // the payment settling an obligation that no longer exists.
    seed({
      selects: [
        [
          {
            id: INVOICE,
            status: "paid",
            finalizedAt: "2026-09-06T00:00:00.000Z",
            paidAt: "2026-09-06T00:10:00.000Z",
          },
        ],
      ],
    });
    expect(await reshapeDraftSubscriptionInvoice(input)).toBeNull();
  });

  it("★★ REFUSES an open (issued) invoice even before it is paid", async () => {
    // Isolates the status guard. `finalizeInvoice` moves draft → open and
    // allocates the number, so an `open` invoice has been issued and may
    // already be sitting on the merchant's Plans page as a payable bill.
    seed({
      selects: [
        [{ id: INVOICE, status: "open", finalizedAt: null, paidAt: null }],
      ],
    });
    expect(await reshapeDraftSubscriptionInvoice(input)).toBeNull();
    expect(dbHolder.current.calls.delete.length).toBe(0);
  });

  it("★★ REFUSES a draft that is already marked paid", async () => {
    // Isolates the `paid_at` guard. Money has moved against this amount, so
    // rewriting it would leave the payment settling an obligation that no
    // longer exists — regardless of what the status column says.
    seed({
      selects: [
        [
          {
            id: INVOICE,
            status: "draft",
            finalizedAt: null,
            paidAt: "2026-09-06T00:10:00.000Z",
          },
        ],
      ],
    });
    expect(await reshapeDraftSubscriptionInvoice(input)).toBeNull();
    expect(dbHolder.current.calls.delete.length).toBe(0);
  });

  it("★★ REFUSES a draft that has already been finalized", async () => {
    // Isolates the `finalized_at` guard from the status one. They are not the
    // same check: finalizing allocates the GST number, and that is what the
    // database's own immutability trigger keys off — so a row that is somehow
    // draft AND finalized must still be refused here.
    seed({
      selects: [
        [
          {
            id: INVOICE,
            status: "draft",
            finalizedAt: "2026-09-06T00:00:00.000Z",
            paidAt: null,
          },
        ],
      ],
    });
    expect(await reshapeDraftSubscriptionInvoice(input)).toBeNull();
    expect(dbHolder.current.calls.delete.length).toBe(0);
  });

  it("finds nothing for an invoice belonging to another store", async () => {
    // ⚠ The store predicate is argued, not pinned: the db mock does not
    // evaluate WHERE clauses, so this proves only that an empty read is handled.
    // The scope itself is read in the source — an invoice id alone must never
    // let one merchant rewrite another's document.
    seed({ selects: [[]] });
    expect(await reshapeDraftSubscriptionInvoice(input)).toBeNull();
  });

  it("returns null rather than throwing when the database is down", async () => {
    brokenDb();
    expect(await reshapeDraftSubscriptionInvoice(input)).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});

describe("createAiCreditsInvoice", () => {
  const built = buildSubscriptionInvoice({
    planLabel: "x",
    period: "monthly",
    planPaise: 129_00,
    tax: EXCLUSIVE,
  });

  it("★ carries NO cycle_seq, so credits never collide with a renewal", async () => {
    seed({
      selects: [[{ ...INVOICE_ROW, kind: "ai_credits", cycleSeq: null }]],
    });
    await createAiCreditsInvoice({ storeId: STORE, built, stamp: STAMP_ON });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      kind: "ai_credits",
      cycleSeq: null,
    });
  });

  it("returns null and logs on failure", async () => {
    brokenDb();
    expect(
      await createAiCreditsInvoice({ storeId: STORE, built, stamp: STAMP_ON }),
    ).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});

describe("finalizeInvoice", () => {
  it("★ claims on finalized_at IS NULL, so two callers cannot both issue it", async () => {
    seedIssue({
      readBack: {
        ...INVOICE_ROW,
        status: "open",
        invoiceRef: "SM/2026-27/00001",
      },
    });
    const row = await finalizeInvoice(
      INVOICE,
      new Date("2026-08-28T00:00:00Z"),
    );
    expect(row?.invoiceRef).toBe("SM/2026-27/00001");

    const set = claimSet();
    expect(set.status).toBe("open");
    expect(set.finalizedAt).toBe("2026-08-28T00:00:00.000Z");
    // The claim predicate must be part of the WHERE, not a prior read.
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  it("★ a lost claim is not an error: it returns the already-issued invoice", async () => {
    seedIssue({
      readBack: {
        ...INVOICE_ROW,
        status: "open",
        invoiceRef: "SM/2026-27/00007",
      },
      claimed: false,
    });
    const row = await finalizeInvoice(INVOICE);
    expect(row?.invoiceRef).toBe("SM/2026-27/00007");
  });

  it("returns null and logs on failure", async () => {
    brokenDb();
    expect(await finalizeInvoice(INVOICE)).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});

describe("finalizeInvoiceClaimed", () => {
  // ⚠ The db mock does not evaluate a WHERE, so the claim's conditions are
  // pinned by RENDERING it with the real dialect. A WHERE without
  // `status = 'draft'` reopened a draft someone had closed by hand as `open`
  // and gave it a number in the gapless series (the reviewer's probe R4).

  it("★★ the claim requires status = 'draft' as well as finalized_at is null", async () => {
    seedIssue({
      readBack: {
        ...INVOICE_ROW,
        status: "open",
        invoiceRef: "SM/2026-27/00003",
      },
    });
    await finalizeInvoiceClaimed(INVOICE, new Date("2026-08-28T00:00:00Z"));

    const where = claimWhere();
    expect(where.sql).toContain('"billing_invoices"."id" = $1');
    expect(where.sql).toContain('"billing_invoices"."status" = $2');
    expect(where.sql).toContain('"billing_invoices"."finalized_at" is null');
    expect(where.params).toEqual([INVOICE, "draft"]);
  });

  it("reports claimed when the draft was finalized by this call", async () => {
    seedIssue({
      readBack: {
        ...INVOICE_ROW,
        status: "open",
        invoiceRef: "SM/2026-27/00003",
      },
    });
    const result = await finalizeInvoiceClaimed(INVOICE);
    expect(result.claimed).toBe(true);
    expect(result.invoice?.invoiceRef).toBe("SM/2026-27/00003");
    expect(claimSet()).toMatchObject({ status: "open" });
  });

  it("★ keeps its return shape: { invoice, claimed } and nothing else", async () => {
    seedIssue({ readBack: { ...INVOICE_ROW, status: "open" } });
    const result = await finalizeInvoiceClaimed(INVOICE);
    expect(Object.keys(result).sort()).toEqual(["claimed", "invoice"]);
  });

  it("★ a closed draft is refused, never reopened: claimed false, the row read back as it is", async () => {
    // The row is `void` with no number: nothing is written, the caller is
    // told it did not finalize and sees the invoice unchanged.
    seed({
      byTable: {
        billing_invoices: [
          [{ ...DRAFT, status: "void" }],
          [{ ...INVOICE_ROW, status: "void", finalizedAt: null }],
        ],
      },
    });
    const result = await finalizeInvoiceClaimed(INVOICE);
    expect(result.claimed).toBe(false);
    expect(result.invoice?.status).toBe("void");
    expect(result.invoice?.invoiceRef).toBeNull();
    expect(dbHolder.current.calls.set).toHaveLength(0);
    expect(logError).not.toHaveBeenCalled();
  });

  it("returns no invoice and claimed false on failure", async () => {
    brokenDb();
    expect(await finalizeInvoiceClaimed(INVOICE)).toEqual({
      invoice: null,
      claimed: false,
    });
    expect(logError).toHaveBeenCalled();
  });
});

describe("finalizePaidAiCreditsInvoice", () => {
  const CREDITS_DRAFT = { ...DRAFT, kind: "ai_credits" };
  const CREDITS_ROW = {
    ...INVOICE_ROW,
    kind: "ai_credits",
    cycleSeq: null,
    status: "paid",
    invoiceRef: "SM/2026-27/00009",
    finalizedAt: "2026-09-01T00:00:00.000Z",
  };

  it("★★ issues a one-time credit receipt directly as paid, in the claim itself", async () => {
    seedIssue({ draft: CREDITS_DRAFT, readBack: CREDITS_ROW, paid: true });

    const row = await finalizePaidAiCreditsInvoice(
      INVOICE,
      new Date("2026-09-01T00:00:00.000Z"),
    );

    expect(row?.status).toBe("paid");
    const set = claimSet();
    expect(set).toMatchObject({
      status: "paid",
      finalizedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    // The payment time is coalesced, so a repaired receipt keeps its date.
    expect(set.paidAt).toBeDefined();
  });

  it("★ a paid checkout is frozen by itself: the attempts are never asked", async () => {
    seedIssue({ draft: CREDITS_DRAFT, readBack: CREDITS_ROW, paid: true });
    await finalizePaidAiCreditsInvoice(INVOICE);
    // One raw read only: the store's records for the tax reading.
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    expect(sqlText(dbHolder.current.calls.execute[0])).not.toContain(
      "billing_payment_attempts",
    );
  });

  it("repairs an issued receipt left open: marked paid, never re-issued", async () => {
    seed({
      byTable: {
        billing_invoices: [
          [
            {
              ...CREDITS_DRAFT,
              status: "open",
              finalizedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          [CREDITS_ROW],
        ],
      },
    });
    const row = await finalizePaidAiCreditsInvoice(INVOICE);
    expect(row?.status).toBe("paid");
    const set = dbHolder.current.calls.set[0];
    expect(set.status).toBe("paid");
    expect(set.finalizedAt).toBeUndefined();
    // No tax reading for an issued invoice: it can never be restated.
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("★★ never marks a SUBSCRIPTION paid: nothing is written", async () => {
    seed({
      byTable: { billing_invoices: [[DRAFT], [INVOICE_ROW]] },
    });
    const row = await finalizePaidAiCreditsInvoice(INVOICE);
    expect(row?.status).toBe("draft");
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("returns null and logs when the paid transition cannot be recorded", async () => {
    brokenDb();
    expect(await finalizePaidAiCreditsInvoice(INVOICE)).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});

describe("readTaxSnapshot", () => {
  const AT = new Date("2026-12-05T00:00:00.000Z");

  it("★ without a lock: ONE statement reads the settings and every record of the merchant", async () => {
    seed({
      execute: [
        [
          {
            ...SETTINGS_ON,
            account_gstin: null,
            account_state_code: "29",
            account_country: null,
            tax_id: null,
            business_state_code: null,
            business_address: null,
            location_gstin: null,
            location_state_code: null,
            signup_state_name: null,
            signup_country: null,
          },
        ],
      ],
    });
    const snap = await readTaxSnapshot(dbHolder.current.db, STORE, AT);

    expect(dbHolder.current.calls.execute).toHaveLength(1);
    expect(dbHolder.current.calls.select).toHaveLength(0);
    const text = sqlText(dbHolder.current.calls.execute[0]);
    for (const part of [
      "left join public.platform_billing_settings p on p.id",
      "left join public.billing_accounts a on a.store_id",
      "left join public.store_billing_settings b on b.store_id",
      "left join public.stores s on s.id",
      "left join lateral",
      "is_default",
      "a.address ->> 'country'",
      "s.settings -> 'business' ->> 'state'",
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("for share");
    expect(sqlParamValues(dbHolder.current.calls.execute[0])).toEqual([
      STORE,
      STORE,
      STORE,
      STORE,
    ]);

    expect(snap).toMatchObject({
      ok: true,
      terms: { active: true, rateBps: 1800 },
      stamp: STAMP_ON,
    });
  });

  it("★ with a lock: the settings row and then the billing account are read `for share`", async () => {
    seed({
      byTable: {
        platform_billing_settings: [[SETTINGS_ON]],
        billing_accounts: [
          [{ gstin: null, stateCode: null, address: { country: "US" } }],
        ],
      },
      execute: [[STORE_RECORDS]],
    });
    const snap = await readTaxSnapshot(dbHolder.current.db, STORE, AT, {
      lock: true,
    });

    expect(dbHolder.current.calls.forUpdate).toEqual(["share", "share"]);
    const [first, second] = dbHolder.current.calls.select;
    expect(Object.keys(first)).toContain("taxEnabled");
    expect(Object.keys(second)).toEqual(["gstin", "stateCode", "address"]);
    // The other records in one statement, without a lock.
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    const text = sqlText(dbHolder.current.calls.execute[0]);
    expect(text).not.toContain("platform_billing_settings");
    expect(text).not.toContain("billing_accounts");
    // The account's country comes out of its address: outside India is 96.
    expect(snap).toMatchObject({
      ok: true,
      stamp: { placeOfSupply: "96", placeOfSupplyBasis: "outside_india" },
    });
  });

  it("★ GST on with StoreMink's identity incomplete is refused, never read as GST off", async () => {
    seed({
      execute: [[{ ...SETTINGS_ON, sacCode: null, account_state_code: "29" }]],
    });
    expect(await readTaxSnapshot(dbHolder.current.db, STORE, AT)).toEqual({
      ok: false,
      reason: "settings_incomplete",
    });
  });
});

describe("loadTaxSnapshot", () => {
  it("reads in one service scope", async () => {
    seed({ execute: [[{ ...SETTINGS_OFF, account_state_code: "29" }]] });
    const snap = await loadTaxSnapshot(STORE, new Date());
    expect(snap).toMatchObject({ ok: true, terms: { active: false } });
    expect(withService).toHaveBeenCalledTimes(1);
  });

  it("★★ THROWS on a read failure: no tax-off fallback any more", async () => {
    brokenDb();
    await expect(loadTaxSnapshot(STORE, new Date())).rejects.toThrow("db down");
  });
});

describe("the tax stamp on new drafts", () => {
  const args = {
    storeId: STORE,
    cycleSeq: 1,
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    built: BUILT,
    stamp: STAMP_ON,
  };

  it("★ writes the reading's stamp whole: SAC, basis and the price mode too", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    await ensureRenewalInvoice(args);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      supplierGstin: STAMP_ON.supplierGstin,
      customerGstin: null,
      placeOfSupply: "29",
      placeOfSupplyBasis: "recipient",
      sacCode: "998314",
      taxInclusive: false,
    });
  });

  it("★ a stamp with no GSTINs is written as it is, nulls included", async () => {
    // GST off: the reading's stamp carries no GSTIN and no SAC. The draft
    // records exactly that rather than anything read a second time.
    seed({ selects: [[INVOICE_ROW]] });
    await ensureRenewalInvoice({
      ...args,
      stamp: {
        supplierGstin: null,
        customerGstin: "29ABCDE1234F1Z5",
        placeOfSupply: "29",
        placeOfSupplyBasis: "recipient",
        sacCode: null,
      },
    });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      supplierGstin: null,
      customerGstin: "29ABCDE1234F1Z5",
      placeOfSupply: "29",
      placeOfSupplyBasis: "recipient",
      sacCode: null,
    });
  });

  it("★ tax_inclusive follows the built invoice", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    const inclusive = buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "yearly",
      planPaise: 15_000_00,
      tax: { ...EXCLUSIVE, inclusive: true },
    });
    await ensureRenewalInvoice({ ...args, built: inclusive });
    expect(dbHolder.current.calls.values[0].taxInclusive).toBe(true);
  });

  it("the add-on and credit-pack drafts take the stamp too", async () => {
    seed({ selects: [[{ ...INVOICE_ROW, kind: "addon", cycleSeq: null }]] });
    await createAddonInvoice({
      storeId: STORE,
      built: BUILT,
      targetCount: 3,
      stamp: STAMP_ON,
    });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      kind: "addon",
      addonTargetCount: 3,
      sacCode: "998314",
      placeOfSupplyBasis: "recipient",
    });

    seed({
      selects: [[{ ...INVOICE_ROW, kind: "ai_credits", cycleSeq: null }]],
    });
    await createAiCreditsInvoice({
      storeId: STORE,
      built: BUILT,
      stamp: STAMP_ON,
    });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      kind: "ai_credits",
      supplierGstin: STAMP_ON.supplierGstin,
      sacCode: "998314",
    });
  });

  it("★ reshaping a draft writes the stamp and the price mode", async () => {
    seed({
      selects: [
        [{ id: INVOICE, status: "draft", finalizedAt: null, paidAt: null }],
        [INVOICE_ROW],
      ],
    });
    await reshapeDraftSubscriptionInvoice({
      invoiceId: INVOICE,
      storeId: STORE,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      built: BUILT,
      stamp: STAMP_ON,
    });
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      taxInclusive: false,
      supplierGstin: STAMP_ON.supplierGstin,
      placeOfSupply: "29",
      placeOfSupplyBasis: "recipient",
      sacCode: "998314",
    });
  });
});

describe("getCycleInvoice", () => {
  it("★ carries the tax particulars and the body total", async () => {
    seed({
      selects: [
        [
          {
            ...INVOICE_ROW,
            // A bigint column arrives as text from some drivers.
            taxPaise: "270000",
            taxRateBps: 1800,
            supplierGstin: "03ABCDE1234F1Z5",
            customerGstin: null,
            placeOfSupply: "29",
            placeOfSupplyBasis: "recipient",
            sacCode: "998314",
            taxInclusive: false,
            // A bigint sum arrives as text.
            bodyTotalPaise: "1500000",
          },
        ],
      ],
    });
    const row = await getCycleInvoice(STORE, 1);
    expect(row).toMatchObject({
      taxPaise: 2_700_00,
      taxRateBps: 1800,
      supplierGstin: "03ABCDE1234F1Z5",
      placeOfSupply: "29",
      placeOfSupplyBasis: "recipient",
      sacCode: "998314",
      taxInclusive: false,
      bodyTotalPaise: 15_000_00,
    });
  });

  it("★ the body total sums only the body lines of THIS invoice", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    await getCycleInvoice(STORE, 1);
    const projection = dbHolder.current.calls.select[0];
    const body = new PgDialect().sqlToQuery(projection.bodyTotalPaise);
    // The outer table is named by hand: a bare "id" would be the line's own.
    expect(body.sql).toContain('bii.invoice_id = "billing_invoices"."id"');
    expect(body.sql).toContain("bii.kind = any($1)");
    expect(body.params).toEqual([
      [
        "base_plan",
        "location",
        "addon",
        "proration",
        "account_credit",
        "ai_credits",
      ],
    ]);
  });

  it("an older row without the new columns reads as untaxed", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    expect(await getCycleInvoice(STORE, 1)).toMatchObject({
      taxPaise: 0,
      taxRateBps: 0,
      placeOfSupplyBasis: null,
      taxInclusive: false,
      bodyTotalPaise: 0,
    });
  });
});

describe("issueInvoice", () => {
  // A Basic monthly draft built while GST was off: ₹1,500, no tax.
  const UNTAXED = { ...DRAFT, totalPaise: 1_500_00 };
  const BASE_LINE = {
    kind: "base_plan",
    description: "Basic plan, monthly",
    quantity: 1,
    unitAmountPaise: 1_500_00,
    amountPaise: 1_500_00,
  };

  it("★★ frozen by a payment in flight, GST since started (exclusive): the GST is CARVED out of the same total", async () => {
    seedIssue({
      draft: UNTAXED,
      settings: SETTINGS_ON,
      frozen: true,
      lines: [BASE_LINE],
    });
    const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });

    expect(result.restamp).toBe("carved");
    expect(result.claimed).toBe(true);
    const money = dbHolder.current.calls.set[0];
    expect(money).toMatchObject({
      totalPaise: 1_500_00,
      taxPaise: 228_81,
      subtotalPaise: 1_271_19,
      taxRateBps: 1800,
      taxInclusive: true,
      ...STAMP_ON,
    });
    // Old lines out, rebuilt lines in: the body and an "(included)" tax line.
    expect(dbHolder.current.calls.delete).toHaveLength(1);
    const lines = dbHolder.current.calls.values[0];
    expect(lines.map((l: any) => l.kind)).toEqual(["base_plan", "tax"]);
    expect(lines[1].description).toContain("(included)");
  });

  it("★★ frozen is decided from the payment attempts AND the credit purchases, here", async () => {
    seedIssue({ draft: UNTAXED, frozen: true });
    await issueInvoice({ invoiceId: INVOICE, now: NOW });
    const text = sqlText(dbHolder.current.calls.execute[0]);
    expect(text).toContain("from public.billing_payment_attempts a");
    expect(text).toContain("a.state not in ('failed', 'cancelled')");
    expect(text).toContain("from public.ai_credit_purchases p");
    expect(text).toContain("p.rzp_order_id is not null");
    expect(text).toContain("p.status <> 'failed'");
    expect(sqlParamValues(dbHolder.current.calls.execute[0])).toEqual([
      INVOICE,
      INVOICE,
    ]);
  });

  it("★ not frozen, GST since started: re-priced at today's terms (₹1,770)", async () => {
    seedIssue({
      draft: UNTAXED,
      settings: SETTINGS_ON,
      frozen: false,
      lines: [BASE_LINE],
    });
    const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
    expect(result.restamp).toBe("rebuilt");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      totalPaise: 1_770_00,
      taxPaise: 270_00,
      subtotalPaise: 1_500_00,
      taxInclusive: false,
      sacCode: "998314",
    });
  });

  it("★★ terms at the payment's instant: paid at 23:00 IST, GST starting 00:00 IST, issued after: no GST", async () => {
    seedIssue({
      draft: UNTAXED,
      settings: SCHEDULED_AT_MIDNIGHT_IST,
      frozen: true,
      lines: [BASE_LINE],
    });
    const result = await issueInvoice({
      invoiceId: INVOICE,
      now: new Date("2026-12-01T05:00:00.000Z"),
      paidAt: new Date("2026-11-30T17:30:00.000Z"),
    });
    expect(result.restamp).toBe("unchanged");
    expect(result.claimed).toBe(true);
    // Only the claim was written: no lines, no money, no tax.
    expect(dbHolder.current.calls.set).toHaveLength(1);
    expect(dbHolder.current.calls.delete).toHaveLength(0);
  });

  it("the payment's instant decides only for a frozen invoice: an open draft takes today's terms", async () => {
    seedIssue({
      draft: UNTAXED,
      settings: SCHEDULED_AT_MIDNIGHT_IST,
      frozen: false,
      lines: [BASE_LINE],
    });
    const result = await issueInvoice({
      invoiceId: INVOICE,
      now: new Date("2026-12-01T05:00:00.000Z"),
      paidAt: new Date("2026-11-30T17:30:00.000Z"),
    });
    expect(result.restamp).toBe("rebuilt");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      totalPaise: 1_770_00,
    });
  });

  it("★ a frozen total no reading reproduces (18% to 28%): the draft is issued as built, with a warning", async () => {
    seedIssue({
      draft: {
        ...DRAFT,
        totalPaise: 1_770_00,
        taxRateBps: 1800,
        ...STAMP_ON,
      },
      settings: { ...SETTINGS_ON, taxRateBps: 2800 },
      frozen: true,
      lines: [
        BASE_LINE,
        {
          kind: "tax",
          description: "GST @ 18%",
          quantity: 1,
          unitAmountPaise: 270_00,
          amountPaise: 270_00,
        },
      ],
    });
    const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
    expect(result.restamp).toBe("kept_draft");
    expect(result.claimed).toBe(true);
    expect(logWarn).toHaveBeenCalledWith("billing.issue_kept_draft_tax", {
      invoiceId: INVOICE,
      draftRateBps: 1800,
      rateBps: 2800,
    });
    expect(dbHolder.current.calls.delete).toHaveLength(0);
    expect(dbHolder.current.calls.set).toHaveLength(1);
  });

  describe("★★ R1-03: a frozen draft kept at a tax no longer in force is filed for a person", () => {
    const FROZEN_18 = {
      draft: {
        ...DRAFT,
        totalPaise: 1_770_00,
        taxRateBps: 1800,
        taxInclusive: false,
        ...STAMP_ON,
      },
      frozen: true,
      lines: [
        BASE_LINE,
        {
          kind: "tax",
          description: "GST @ 18%",
          quantity: 1,
          unitAmountPaise: 270_00,
          amountPaise: 270_00,
        },
      ],
    };
    // Exclusive 18% to GST off: no reading reproduces ₹1,770 (the R1 probe).
    const SWITCHED_OFF = { ...SETTINGS_ON, taxEnabled: false };

    function filed() {
      const i = dbHolder.current.calls.insert.indexOf(
        billingReconciliationItems,
      );
      return i < 0 ? null : dbHolder.current.calls.values[i];
    }

    it("★★ one state_conflict item, keyed kept_draft:<invoice>, after the issue commits, in its own scope", async () => {
      seedIssue({ ...FROZEN_18, settings: SWITCHED_OFF });
      const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
      expect(result.restamp).toBe("kept_draft");
      expect(result.claimed).toBe(true);
      // The issue's own transaction, then the filing's: never nested.
      expect(withService).toHaveBeenCalledTimes(2);
      expect(filed()).toMatchObject({
        storeId: STORE,
        kind: "state_conflict",
        status: "open",
        invoiceId: INVOICE,
        expectedPaise: 1_770_00,
        detail: {
          repair_key: `kept_draft:${INVOICE}`,
          draft_rate_bps: 1800,
          draft_inclusive: false,
          rate_bps: 0,
          inclusive: false,
          total_paise: 1_770_00,
        },
      });
      expect(filed()!.detail.note).toMatch(/18% GST added/);
      expect(filed()!.detail.note).toMatch(/no GST/);
      expect(filed()!.detail.note).not.toMatch(/[\u2013\u2014]/);
      // Filed once per key in every status: a retried issue files nothing new.
      expect(dbHolder.current.calls.onConflict).toHaveLength(1);
      expect(logWarn).toHaveBeenCalledWith("billing.issue_kept_draft_filed", {
        invoiceId: INVOICE,
        storeId: STORE,
        draftRateBps: 1800,
        rateBps: 0,
      });
    });

    it("★ names the payment by its order and in the note, never in the payment column (the open key would drop it)", async () => {
      seedIssue({
        ...FROZEN_18,
        settings: { ...SETTINGS_ON, taxRateBps: 1200 },
        attempts: [
          {
            id: "att-1",
            providerOrderId: "order_1",
            providerPaymentId: "pay_1",
          },
        ],
      });
      await issueInvoice({ invoiceId: INVOICE, now: NOW });
      const row = filed()!;
      expect(row).toMatchObject({
        attemptId: "att-1",
        providerOrderId: "order_1",
        detail: { provider_payment_id: "pay_1", rate_bps: 1200 },
      });
      expect(row).not.toHaveProperty("providerPaymentId");
      expect(row.detail.note).toMatch(/payment pay_1/);
      expect(row.detail.note).toMatch(/12% GST added/);
    });

    it("★ an issue this call did not claim files nothing", async () => {
      seedIssue({ ...FROZEN_18, settings: SWITCHED_OFF, claimed: false });
      const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
      expect(result.claimed).toBe(false);
      expect(filed()).toBeNull();
      expect(withService).toHaveBeenCalledTimes(1);
    });

    it("★ a draft rebuilt under today's terms files nothing", async () => {
      seedIssue({
        draft: UNTAXED,
        settings: SETTINGS_ON,
        frozen: false,
        lines: [BASE_LINE],
      });
      const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
      expect(result.restamp).toBe("rebuilt");
      expect(filed()).toBeNull();
      expect(withService).toHaveBeenCalledTimes(1);
    });

    it("★★ a filing that fails never undoes the issued invoice", async () => {
      seedIssue({
        ...FROZEN_18,
        settings: SWITCHED_OFF,
        failInsertFor: [billingReconciliationItems],
      });
      const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
      expect(result.claimed).toBe(true);
      expect(result.invoice).not.toBeNull();
      expect(result.restamp).toBe("kept_draft");
      expect(logError).toHaveBeenCalledWith(
        "billing.issue_kept_draft_file",
        expect.anything(),
        { invoiceId: INVOICE },
      );
    });
  });

  it("★ StoreMink's identity incomplete while GST is on: the draft keeps the stamp it was built with", async () => {
    seedIssue({
      draft: UNTAXED,
      settings: { ...SETTINGS_ON, sacCode: null },
      frozen: false,
    });
    const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
    expect(result.restamp).toBe("kept_draft");
    expect(logError).toHaveBeenCalledWith(
      "billing.issue_tax_settings_incomplete",
      expect.any(Error),
      { invoiceId: INVOICE },
    );
    expect(dbHolder.current.calls.set).toHaveLength(1);
    expect(result.claimed).toBe(true);
    // Not filed: StoreMink's own settings are what is missing (the ERROR
    // above names it), not a merchant's money.
    expect(dbHolder.current.calls.insert).not.toContain(
      billingReconciliationItems,
    );
  });

  it("★ only a particular moved (a GSTIN saved since): the stamp is written, the lines are left alone", async () => {
    seedIssue({
      draft: UNTAXED,
      account: { gstin: "07ABCDE1234F1Z5", stateCode: "07", address: {} },
    });
    const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
    expect(result.restamp).toBe("rebuilt");
    expect(dbHolder.current.calls.delete).toHaveLength(0);
    expect(dbHolder.current.calls.set[0]).toEqual({
      supplierGstin: null,
      customerGstin: "07ABCDE1234F1Z5",
      placeOfSupply: "07",
      placeOfSupplyBasis: "recipient",
      sacCode: null,
      updatedAt: NOW.toISOString(),
    });
  });

  it("nothing moved: unchanged, and only the claim is written", async () => {
    seedIssue({ draft: UNTAXED });
    const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
    expect(result).toMatchObject({ restamp: "unchanged", claimed: true });
    expect(dbHolder.current.calls.set).toHaveLength(1);
  });

  it("★★ step 6 claims only a draft that is still unissued (renewal-cancel's rule)", async () => {
    // The early return reads the row it locked; the WHERE is what holds when
    // a write between that read and the claim closed the draft.
    seedIssue({ draft: UNTAXED, settings: SETTINGS_ON, lines: [BASE_LINE] });
    await issueInvoice({ invoiceId: INVOICE, now: NOW });
    const where = claimWhere();
    expect(where.sql).toBe(
      '("billing_invoices"."id" = $1 and "billing_invoices"."status" = $2 and "billing_invoices"."finalized_at" is null)',
    );
    expect(where.params).toEqual([INVOICE, "draft"]);
  });

  it("★ the reading is taken under the issuing lock: the invoice for update, the settings and account for share", async () => {
    seedIssue({ draft: UNTAXED });
    await issueInvoice({ invoiceId: INVOICE, now: NOW });
    expect(dbHolder.current.calls.forUpdate).toEqual([
      "update",
      "share",
      "share",
    ]);
  });

  it("an issued invoice is never restated: no reading, claimed false", async () => {
    seed({
      byTable: {
        billing_invoices: [
          [{ ...DRAFT, status: "open", finalizedAt: "2026-09-01T00:00:00Z" }],
          [{ ...INVOICE_ROW, status: "open" }],
        ],
      },
    });
    const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
    expect(result).toMatchObject({ claimed: false, restamp: "unchanged" });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("a draft kept after its store was deleted is issued with what it was built with", async () => {
    seedIssue({ draft: { ...UNTAXED, storeId: null }, frozen: true });
    const result = await issueInvoice({ invoiceId: INVOICE, now: NOW });
    expect(result).toMatchObject({ claimed: true, restamp: "unchanged" });
    // The frozen read only: no store records to read.
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    expect(dbHolder.current.calls.forUpdate).toEqual(["update"]);
  });

  it("an unknown invoice: no invoice, nothing written", async () => {
    seed({ byTable: { billing_invoices: [[]] } });
    expect(await issueInvoice({ invoiceId: INVOICE })).toEqual({
      invoice: null,
      claimed: false,
      restamp: "unchanged",
    });
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("never throws: a failure is logged and reported as no invoice", async () => {
    brokenDb();
    expect(await issueInvoice({ invoiceId: INVOICE })).toEqual({
      invoice: null,
      claimed: false,
      restamp: "unchanged",
    });
    expect(logError).toHaveBeenCalledWith(
      "billing.issue_invoice",
      expect.any(Error),
      { invoiceId: INVOICE },
    );
  });
});

describe("amountDueForInvoice", () => {
  it("is the full total when no credit has been applied", async () => {
    seed({ selects: [[INVOICE_ROW], [{ total: 0 }]] });
    expect(await amountDueForInvoice(INVOICE)).toBe(17_700_00);
  });

  it("★ subtracts applied credit without touching the invoice total", async () => {
    seed({ selects: [[INVOICE_ROW], [{ total: -5_000_00 }]] });
    expect(await amountDueForInvoice(INVOICE)).toBe(12_700_00);
  });

  it("★ never goes negative when credit exceeds the invoice", async () => {
    seed({ selects: [[INVOICE_ROW], [{ total: -99_999_00 }]] });
    expect(await amountDueForInvoice(INVOICE)).toBe(0);
  });

  it("handles credit stored with either sign", async () => {
    seed({ selects: [[INVOICE_ROW], [{ total: 5_000_00 }]] });
    expect(await amountDueForInvoice(INVOICE)).toBe(12_700_00);
  });

  it("returns null for an unknown invoice", async () => {
    seed({ selects: [[]] });
    expect(await amountDueForInvoice(INVOICE)).toBeNull();
  });

  it("★ returns null on a read failure rather than quoting the full total", async () => {
    // Guessing the full amount when credit may already be applied would
    // double-charge — the one outcome worth refusing to guess at (Rule 10).
    brokenDb();
    expect(await amountDueForInvoice(INVOICE)).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});

describe("getInvoice", () => {
  it("returns the row", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    expect((await getInvoice(INVOICE))?.id).toBe(INVOICE);
  });

  it("returns null and logs on failure", async () => {
    brokenDb();
    expect(await getInvoice(INVOICE)).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});
