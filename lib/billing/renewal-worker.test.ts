/* eslint-disable @typescript-eslint/no-explicit-any */
// The renewal worker.
//
// ── What these tests are really about ──────────────────────────────────────
// One distinction carries most of the risk: an invoice that FAILED starts a
// 48-hour countdown to losing the merchant's plan, and an invoice that is still
// PROCESSING must not. With the X+3 settlement window, "still processing at the
// cycle boundary" is the ordinary case rather than an edge case — so getting
// this wrong would downgrade paying merchants routinely, not rarely.
//
// ⚠ The exactly-once guarantees are database constraints and
// billing_claim_downgrade, proved by scripts/billing-verify.sql. These tests
// prove the orchestration around them: who is selected, what is skipped, and
// which outcome maps to which consequence.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";
import { billingSubscriptions, planEvents, stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { resolveTaxSnapshot, type SnapshotRow } from "./tax-snapshot";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

// The repository and the collector are proved by their own suites; here they
// are seams, so a test can put the worker in any outcome without a database.
const repo = vi.hoisted(() => ({
  loadTaxSnapshot: vi.fn(),
  ensureRenewalInvoice: vi.fn(),
  finalizeInvoiceClaimed: vi.fn(),
  getCycleInvoice: vi.fn(),
  getInvoice: vi.fn(),
  amountDueForInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => repo);

const collector = vi.hoisted(() => ({
  collectInvoice: vi.fn(),
  automaticAttemptsOn: vi.fn(),
}));
vi.mock("./collect", () => collector);

// Telling the merchant is best-effort and proved by its own suite; here it is a
// seam, so a test can assert WHO was told and WHEN without sending mail.
const dunning = vi.hoisted(() => ({
  notifyAutopayStopped: vi.fn(),
  notifyInvoiceIssued: vi.fn(),
  notifyGraceStarted: vi.fn(),
  notifyDowngraded: vi.fn(),
}));
vi.mock("./dunning", () => dunning);

import {
  advanceAfterPayment,
  announceAutopayStopped,
  classify,
  collectDueRenewals,
  downgradeExpired,
  evaluateCycleTurns,
  MANDATE_CHECK_HOLD_HOURS,
} from "./renewal-worker";
import { GRACE_HOURS } from "./cycle";

/** A Drizzle statement or condition, as Postgres would receive it. */
function render(query: unknown) {
  const q = new PgDialect().sqlToQuery(query as any);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

/** The raw statements a test ran whose text contains `fragment`. */
function executed(fragment: string): unknown[] {
  return dbHolder.current.calls.execute.filter((q: unknown) =>
    sqlText(q).includes(fragment),
  );
}

/** A row closeUnreachedInvoices' statement returns for one closed invoice. */
function closedRow(previousStatus: string) {
  return {
    id: "inv-4",
    previous_status: previousStatus,
    total_paise: "240000",
    invoice_ref: previousStatus === "draft" ? null : "SM/2026-27/00004",
  };
}

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");

const DUE_ROW = {
  storeId: STORE,
  plan: "pro",
  period: "monthly",
  currentCycleSeq: 3,
  currentPeriodEnd: "2026-09-03T00:00:00.000Z",
  billedLocations: 2,
  scheduledPlan: null,
  scheduledPeriod: null,
  scheduledLocations: null,
  cancelAtPeriodEnd: false,
  mandateId: "man-1",
};

const priceFor = vi.fn(async () => ({
  planPaise: 5_000_00,
  locationPaise: 1_000_00,
  planLabel: "Pro",
}));

/**
 * The gateway seam the pass is handed (lib/billing/gateway.ts in production).
 * Here the mandate is chargeable unless a test says otherwise; `notify` and
 * `debit` are never reached, because `./collect` is a seam too.
 */
const charge = {
  checkMandate: vi.fn(async (): Promise<any> => ({ state: "chargeable" })),
  notify: vi.fn(),
  readNotice: vi.fn(),
  debit: vi.fn(),
} as any;

const PUNJAB_GSTIN = "03ABCDE1234F1Z5";

/** GST off, StoreMink's identity complete, a merchant with no records. The
 *  worker's snapshot is the REAL `resolveTaxSnapshot` over this row, so the
 *  build and the stamp are what production would produce. */
const SNAPSHOT_ROW: SnapshotRow = {
  taxEnabled: false,
  taxInclusive: false,
  taxRateBps: 1800,
  nextTaxEnabled: null,
  nextTaxInclusive: null,
  nextTaxRateBps: null,
  nextTaxStartsAt: null,
  supplierGstin: PUNJAB_GSTIN,
  supplierStateCode: "03",
  sacCode: "998314",
  accountGstin: null,
  accountStateCode: null,
  accountCountry: null,
  taxIdGstin: null,
  storeTaxStateCode: null,
  locationGstin: null,
  locationStateCode: null,
  taxAddress: null,
  signupStateName: null,
  signupCountry: null,
};

/** GST charged (exclusive, 18%) for a merchant in Karnataka (29). */
const GST_ON_KARNATAKA: SnapshotRow = {
  ...SNAPSHOT_ROW,
  taxEnabled: true,
  accountStateCode: "29",
};

function readingFor(row: SnapshotRow) {
  repo.loadTaxSnapshot.mockImplementation(async (_store: string, at: Date) =>
    resolveTaxSnapshot(row, at),
  );
}

/** The invoice `finalizeInvoiceClaimed` reports it issued. */
const ISSUED = {
  id: "inv-1",
  status: "open",
  finalizedAt: "2026-09-01T00:00:00.000Z",
  invoiceRef: "SM/2026-27/00004",
  totalPaise: 7_000_00,
  taxPaise: 0,
  taxRateBps: 0,
  taxInclusive: false,
  placeOfSupply: null,
  placeOfSupplyBasis: null,
};

function seed(selects: any[][] = []) {
  dbHolder.current = makeDbMock({ selectQueue: selects });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  readingFor(SNAPSHOT_ROW);
  repo.ensureRenewalInvoice.mockResolvedValue({
    id: "inv-1",
    status: "draft",
    finalizedAt: null,
  });
  repo.finalizeInvoiceClaimed.mockResolvedValue({
    invoice: ISSUED,
    claimed: true,
  });
  repo.amountDueForInvoice.mockResolvedValue(7_000_00);
  // No previous cycle by default, so the reprice line stays out of the notice.
  repo.getCycleInvoice.mockResolvedValue(null);
  // No automatic try made yet, so the retry rule lets the first one through.
  collector.automaticAttemptsOn.mockResolvedValue({
    count: 0,
    starts: 0,
    lastAt: null,
  });
  collector.collectInvoice.mockResolvedValue({
    status: "paid",
    attemptId: "att-1",
  });
});

describe("classify — which outcomes may start a grace clock", () => {
  it("★ 'not collectable' is MANUAL, never a failure", () => {
    // Over the AFA limit or a revoked mandate means the merchant must pay by
    // hand. Counting it as a failure would start a countdown to downgrade for
    // someone who has done nothing wrong.
    expect(
      classify({ status: "not_collectable", reason: "over_afa_limit" }),
    ).toBe("manual");
  });

  it("★ 'already in flight' is PENDING, never a failure", () => {
    expect(classify({ status: "already_in_flight" })).toBe("pending");
  });

  it("★ 'pending reconcile' is PENDING — an unknown outcome is not a decline", () => {
    expect(classify({ status: "pending_reconcile", attemptId: "a" })).toBe(
      "pending",
    );
  });

  it("only a gateway rejection is a failure", () => {
    expect(classify({ status: "failed", attemptId: "a" })).toBe("failed");
    expect(classify({ status: "paid", attemptId: "a" })).toBe("paid");
  });
});

describe("collectDueRenewals", () => {
  it("bills the NEXT cycle, starting where the current one ends", async () => {
    seed([[DUE_ROW]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });

    const arg = repo.ensureRenewalInvoice.mock.calls[0][0];
    expect(arg.cycleSeq).toBe(4); // current 3 + 1
    expect(arg.periodStart.toISOString()).toBe("2026-09-03T00:00:00.000Z");
    // 30 days on from the start, because a cycle is a DURATION.
    expect(arg.periodEnd.toISOString()).toBe("2026-10-03T00:00:00.000Z");
  });

  describe("★★ telling the merchant the invoice exists", () => {
    // With collection gated this notice IS how a merchant learns they must pay.
    // Silently issuing, waiting, then downgrading is not a billing system.

    it("mails once, on the run that issued it", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(dunning.notifyInvoiceIssued).toHaveBeenCalledTimes(1);
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0]).toMatchObject({
        storeId: STORE,
        plan: "pro",
        // ₹5,000 plan + 2 billed locations × ₹1,000.
        amountPaise: 7_000_00,
        invoiceRef: "SM/2026-27/00004",
        // GST off: the email prints no GST rows.
        tax: { taxPaise: 0, taxRateBps: 0, taxInclusive: false },
        // Cycle 1 has no predecessor here (`getCycleInvoice` finds none).
        previousTax: null,
      });
    });

    it("★★ says NOTHING on a later run — the hourly cron re-reads the same row", async () => {
      // Without the finalize claim this would mail the same bill every hour for
      // four days, which is how people learn to ignore an email.
      repo.finalizeInvoiceClaimed.mockResolvedValue({
        invoice: {
          id: "inv-1",
          status: "open",
          finalizedAt: "2026-09-01T00:00:00.000Z",
          invoiceRef: "SM/2026-27/00004",
        },
        claimed: false, // another run got there first
      });
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(dunning.notifyInvoiceIssued).not.toHaveBeenCalled();
    });

    it("★ says nothing about an invoice that was ALREADY issued", async () => {
      repo.ensureRenewalInvoice.mockResolvedValue({
        id: "inv-1",
        status: "open",
        finalizedAt: "2026-08-30T00:00:00.000Z",
        invoiceRef: "SM/2026-27/00004",
      });
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(dunning.notifyInvoiceIssued).not.toHaveBeenCalled();
    });

    it("★★ autopay FALSE with no gateway — it is a bill, not a heads-up", async () => {
      // A merchant told "we'll collect this automatically" does nothing, and is
      // downgraded 48 hours after the cycle turns.
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(false);
    });

    it("★ autopay FALSE with a gateway but NO mandate", async () => {
      seed([[{ ...DUE_ROW, mandateId: null }]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(false);
    });

    it("★★ names a reprice, so it does not arrive as a surprise", async () => {
      // Plan prices are operator-editable and renewals are priced LIVE, so an
      // existing subscriber's amount can change with nothing saying so. The
      // 4-day email already carried the new figure; it did not say it was new.
      repo.getCycleInvoice.mockResolvedValue({
        id: "inv-prev",
        status: "paid",
        totalPaise: 5_000_00,
        cycleSeq: 1,
        invoiceRef: "INV-1",
        finalizedAt: "2026-08-01T00:00:00.000Z",
        periodStart: null,
        periodEnd: null,
      });
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(
        dunning.notifyInvoiceIssued.mock.calls[0][0].previousAmountPaise,
      ).toBe(5_000_00);
    });

    it("★ says nothing when the price did not move", async () => {
      // A "your price changed" line on an unchanged bill is noise, and noise is
      // what teaches people to stop reading billing email.
      repo.getCycleInvoice.mockResolvedValue({
        id: "inv-prev",
        status: "paid",
        totalPaise: 7_000_00,
        cycleSeq: 1,
        invoiceRef: "INV-1",
        finalizedAt: "2026-08-01T00:00:00.000Z",
        periodStart: null,
        periodEnd: null,
      });
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      // Passed through as-is; `notifyInvoiceIssued` drops an equal amount.
      expect(
        dunning.notifyInvoiceIssued.mock.calls[0][0].previousAmountPaise,
      ).toBe(7_000_00);
    });

    const LIVE_MANDATE = {
      id: "mandate-1",
      status: "active",
      maxAmountPaise: 15_000_00,
      providerTokenId: "token_1",
      providerCustomerId: "cust_1",
    };

    it("autopay TRUE only with a gateway AND a mandate that can carry it", async () => {
      seed([[DUE_ROW], [LIVE_MANDATE]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(true);
    });

    it("★★ autopay FALSE when the charge is over the mandate's own ceiling", async () => {
      // "We'll charge your saved payment method — nothing to do" is the single
      // most dangerous thing to say wrongly: the merchant does nothing and is
      // downgraded. A ceiling is fixed at authorisation and cannot be raised,
      // so an operator reprice past it silently ends autopay for that store.
      seed([[DUE_ROW], [{ ...LIVE_MANDATE, maxAmountPaise: 5_000_00 }]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(false);
    });

    it("★★ autopay FALSE when the charge is over the AFA-exempt limit", async () => {
      // ₹15,000 is RBI's line on BOTH cards and UPI. A generous mandate does
      // not move it — the merchant would have to authenticate every debit.
      repo.amountDueForInvoice.mockResolvedValue(24_000_00);
      seed([[DUE_ROW], [{ ...LIVE_MANDATE, maxAmountPaise: 43_000_00 }]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(false);
    });
  });

  describe("★★ one tax reading per renewal (GST Stage 7)", () => {
    // The invoice is built from ONE reading of the tax settings and the
    // merchant's records, and stamped with that reading's particulars. There is
    // no tax-off fallback: a reading that fails leaves the renewal for the next
    // hourly run, because an invoice issued on a guess charges the wrong GST.

    it("★★ a reading that fails issues nothing and waits for the next run", async () => {
      repo.loadTaxSnapshot.mockRejectedValue(new Error("connection reset"));
      seed([[DUE_ROW]]);
      const res = await collectDueRenewals({ now: NOW, charge, priceFor });

      expect(repo.ensureRenewalInvoice).not.toHaveBeenCalled();
      expect(repo.finalizeInvoiceClaimed).not.toHaveBeenCalled();
      expect(collector.collectInvoice).not.toHaveBeenCalled();
      expect(dunning.notifyInvoiceIssued).not.toHaveBeenCalled();
      // Waiting, not an error and never a decline: no grace clock starts.
      expect(res).toMatchObject({ pendingReconcile: 1, failed: 0, errors: 0 });
      expect(logError).toHaveBeenCalledWith(
        "billing.renewal_tax_snapshot",
        expect.any(Error),
        expect.objectContaining({ storeId: STORE, reason: "read_failed" }),
      );
    });

    it("★★ GST on without StoreMink's SAC code: nothing is issued untaxed", async () => {
      readingFor({ ...GST_ON_KARNATAKA, sacCode: null });
      seed([[DUE_ROW]]);
      const res = await collectDueRenewals({ now: NOW, charge, priceFor });

      expect(repo.ensureRenewalInvoice).not.toHaveBeenCalled();
      expect(collector.collectInvoice).not.toHaveBeenCalled();
      expect(res).toMatchObject({ pendingReconcile: 1, failed: 0, errors: 0 });
      expect(logError).toHaveBeenCalledWith(
        "billing.renewal_tax_snapshot",
        expect.any(Error),
        expect.objectContaining({
          storeId: STORE,
          reason: "settings_incomplete",
        }),
      );
    });

    it("reads the terms in force at the run, for this store", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(repo.loadTaxSnapshot).toHaveBeenCalledWith(STORE, NOW);
    });

    it("★ builds with the reading's GST and stamps its particulars", async () => {
      readingFor(GST_ON_KARNATAKA);
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });

      const arg = repo.ensureRenewalInvoice.mock.calls[0][0];
      // ₹7,000 + 18% exclusive, inter-state (Punjab to Karnataka): IGST.
      expect(arg.built).toMatchObject({
        taxPaise: 1_260_00,
        totalPaise: 8_260_00,
        taxRateBps: 1800,
        inclusive: false,
      });
      expect(arg.built.gst).toMatchObject({ igstPaise: 1_260_00 });
      expect(arg.stamp).toEqual({
        supplierGstin: PUNJAB_GSTIN,
        customerGstin: null,
        placeOfSupply: "29",
        placeOfSupplyBasis: "recipient",
        sacCode: "998314",
      });
      // The old loose parties are gone: the stamp is the one source.
      expect(arg).not.toHaveProperty("supplierGstin");
      expect(arg).not.toHaveProperty("placeOfSupply");
    });

    it("★★ the notice quotes the ISSUED invoice and both cycles' GST", async () => {
      // GST started between the two cycles. The email must say so (from the
      // previous invoice's tax columns), and its Price, GST and Amount rows
      // must add up to the document it names.
      readingFor(GST_ON_KARNATAKA);
      repo.getCycleInvoice.mockResolvedValue({
        id: "inv-prev",
        status: "paid",
        totalPaise: 7_000_00,
        taxPaise: 0,
        taxRateBps: 0,
        taxInclusive: false,
        cycleSeq: 3,
        invoiceRef: "SM/2026-27/00003",
        finalizedAt: "2026-08-01T00:00:00.000Z",
        periodStart: null,
        periodEnd: null,
      });
      repo.finalizeInvoiceClaimed.mockResolvedValue({
        invoice: {
          ...ISSUED,
          totalPaise: 8_260_00,
          taxPaise: 1_260_00,
          taxRateBps: 1800,
          placeOfSupply: "29",
          placeOfSupplyBasis: "recipient",
        },
        claimed: true,
      });
      repo.amountDueForInvoice.mockResolvedValue(8_260_00);
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });

      expect(repo.getCycleInvoice).toHaveBeenCalledWith(STORE, 3);
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0]).toMatchObject({
        amountPaise: 8_260_00,
        tax: { taxPaise: 1_260_00, taxRateBps: 1800, taxInclusive: false },
        previousAmountPaise: 7_000_00,
        previousTax: { taxPaise: 0, taxRateBps: 0, taxInclusive: false },
      });
      // An ordinary merchant: nothing to warn about.
      expect(logWarn).not.toHaveBeenCalledWith(
        "billing.renewal_place_of_supply_fallback",
        expect.anything(),
      );
    });

    it("★★ a draft kept at its own figures is collected and announced at them", async () => {
      // The cycle's draft was built at 18%; the reading now says 28%. Issuing
      // could not rebuild it (`kept_draft`) and issued it as built. The worker
      // must charge and quote what was ISSUED, never its own fresh build:
      // otherwise the email names one amount and the debit takes another.
      readingFor({ ...GST_ON_KARNATAKA, taxRateBps: 2800 });
      repo.finalizeInvoiceClaimed.mockResolvedValue({
        invoice: {
          ...ISSUED,
          totalPaise: 8_260_00,
          taxPaise: 1_260_00,
          taxRateBps: 1800,
          placeOfSupply: "29",
          placeOfSupplyBasis: "recipient",
        },
        claimed: true,
      });
      repo.amountDueForInvoice.mockResolvedValue(8_260_00);
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });

      // This run's own build was at 28%...
      expect(repo.ensureRenewalInvoice.mock.calls[0][0].built.totalPaise).toBe(
        8_960_00,
      );
      // ...and the merchant is charged and told the draft's 18% figures.
      expect(collector.collectInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: "inv-1",
          amountDuePaise: 8_260_00,
        }),
      );
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0]).toMatchObject({
        amountPaise: 8_260_00,
        tax: { taxPaise: 1_260_00, taxRateBps: 1800, taxInclusive: false },
      });
    });

    it("★ no state anywhere: billed in StoreMink's state, logged once, never refused", async () => {
      readingFor({ ...SNAPSHOT_ROW, taxEnabled: true });
      repo.finalizeInvoiceClaimed.mockResolvedValue({
        invoice: {
          ...ISSUED,
          totalPaise: 8_260_00,
          taxPaise: 1_260_00,
          taxRateBps: 1800,
          placeOfSupply: "03",
          placeOfSupplyBasis: "supplier",
        },
        claimed: true,
      });
      repo.amountDueForInvoice.mockResolvedValue(8_260_00);
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });

      const arg = repo.ensureRenewalInvoice.mock.calls[0][0];
      expect(arg.stamp).toMatchObject({
        placeOfSupply: "03",
        placeOfSupplyBasis: "supplier",
      });
      // Intra-state: CGST and SGST.
      expect(arg.built.gst).toMatchObject({
        cgstPaise: 630_00,
        sgstPaise: 630_00,
        igstPaise: 0,
      });
      expect(logWarn).toHaveBeenCalledWith(
        "billing.renewal_place_of_supply_fallback",
        expect.objectContaining({ storeId: STORE, invoiceId: "inv-1" }),
      );
      expect(collector.collectInvoice).toHaveBeenCalled();
    });

    it("★ the fallback is not logged again by the hourly re-runs", async () => {
      readingFor({ ...SNAPSHOT_ROW, taxEnabled: true });
      repo.finalizeInvoiceClaimed.mockResolvedValue({
        invoice: { ...ISSUED, placeOfSupplyBasis: "supplier" },
        claimed: false, // another run issued it
      });
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(logWarn).not.toHaveBeenCalledWith(
        "billing.renewal_place_of_supply_fallback",
        expect.anything(),
      );
    });

    it("★ outside India: place 96, IGST, logged, never refused", async () => {
      // New on-session payments from a business outside India are refused
      // while GST is charged; a renewal already running is billed.
      readingFor({ ...SNAPSHOT_ROW, taxEnabled: true, accountCountry: "US" });
      repo.finalizeInvoiceClaimed.mockResolvedValue({
        invoice: {
          ...ISSUED,
          totalPaise: 8_260_00,
          taxPaise: 1_260_00,
          taxRateBps: 1800,
          placeOfSupply: "96",
          placeOfSupplyBasis: "outside_india",
        },
        claimed: true,
      });
      repo.amountDueForInvoice.mockResolvedValue(8_260_00);
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });

      const arg = repo.ensureRenewalInvoice.mock.calls[0][0];
      expect(arg.stamp).toMatchObject({
        placeOfSupply: "96",
        placeOfSupplyBasis: "outside_india",
      });
      expect(arg.built.gst).toMatchObject({ igstPaise: 1_260_00 });
      expect(logWarn).toHaveBeenCalledWith(
        "billing.renewal_outside_india",
        expect.objectContaining({ storeId: STORE, invoiceId: "inv-1" }),
      );
      expect(collector.collectInvoice).toHaveBeenCalled();
    });

    it("an untaxed invoice outside India is not worth a warning", async () => {
      readingFor({ ...SNAPSHOT_ROW, accountCountry: "US" });
      repo.finalizeInvoiceClaimed.mockResolvedValue({
        invoice: {
          ...ISSUED,
          placeOfSupply: "96",
          placeOfSupplyBasis: "outside_india",
        },
        claimed: true,
      });
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(logWarn).not.toHaveBeenCalledWith(
        "billing.renewal_outside_india",
        expect.anything(),
      );
    });
  });

  describe("★★ charge = null — ISSUE the invoice, do not charge", () => {
    // Issuing is not charging. When the pass was skipped wholesale for a missing
    // gateway, no invoice was ever written: pass 2 waited forever, grace never
    // opened, nobody was downgraded, every subscriber got free service past
    // their cycle end, and the manual payment surface had nothing to list.

    it("still writes the invoice", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(repo.ensureRenewalInvoice).toHaveBeenCalled();
    });

    it("★ still FINALIZES it — the merchant pays against a document number", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(repo.finalizeInvoiceClaimed).toHaveBeenCalled();
    });

    it("★★ never calls the gateway", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(collector.collectInvoice).not.toHaveBeenCalled();
    });

    it("★ counts it as manualRequired, not failed", async () => {
      // `failed` starts the grace clock. Nobody declined anything here — the
      // merchant simply has to pay it themselves.
      seed([[DUE_ROW]]);
      const res = await collectDueRenewals({
        now: NOW,
        charge: null,
        priceFor,
      });
      expect(res.manualRequired).toBe(1);
      expect(res.failed).toBe(0);
      expect(res.errors).toBe(0);
    });

    it("★ does not re-issue an invoice already paid", async () => {
      repo.ensureRenewalInvoice.mockResolvedValue({
        id: "inv-1",
        status: "paid",
        finalizedAt: "2026-09-01T00:00:00.000Z",
        invoiceRef: "SM/2026-27/00004",
      });
      seed([[DUE_ROW]]);
      const res = await collectDueRenewals({
        now: NOW,
        charge: null,
        priceFor,
      });
      expect(res.collected).toBe(1);
      expect(repo.finalizeInvoiceClaimed).not.toHaveBeenCalled();
    });
  });

  it("★ finalizes BEFORE charging — the debit is against an issued document", async () => {
    seed([[DUE_ROW]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });
    const finalizeOrder =
      repo.finalizeInvoiceClaimed.mock.invocationCallOrder[0];
    const chargeOrder = collector.collectInvoice.mock.invocationCallOrder[0];
    expect(finalizeOrder).toBeLessThan(chargeOrder);
  });

  it("does not re-finalize an already-issued invoice", async () => {
    repo.ensureRenewalInvoice.mockResolvedValue({
      id: "inv-1",
      status: "open",
      finalizedAt: "2026-08-28T00:00:00.000Z",
    });
    seed([[DUE_ROW]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(repo.finalizeInvoiceClaimed).not.toHaveBeenCalled();
  });

  it("★ skips an invoice that is already paid, without charging again", async () => {
    repo.ensureRenewalInvoice.mockResolvedValue({
      id: "inv-1",
      status: "paid",
      finalizedAt: "2026-08-28T00:00:00.000Z",
    });
    seed([[DUE_ROW]]);
    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(collector.collectInvoice).not.toHaveBeenCalled();
    expect(s.collected).toBe(1);
  });

  it("★★ never charges again while a payment on the invoice is unresolved (an unknown outcome)", async () => {
    // The first debit timed out, so its attempt is `unknown` and the invoice
    // reads `processing`. The one-in-flight index does not cover `unknown`,
    // so this pass is what stops a second debit an hour later.
    repo.ensureRenewalInvoice.mockResolvedValue({
      id: "inv-1",
      status: "processing",
      finalizedAt: "2026-08-28T00:00:00.000Z",
    });
    seed([[DUE_ROW]]);
    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(collector.collectInvoice).not.toHaveBeenCalled();
    // Not even the mandate is asked about: the invoice is not ours to touch
    // while a payment on it is unresolved.
    expect(charge.checkMandate).not.toHaveBeenCalled();
    expect(dunning.notifyInvoiceIssued).not.toHaveBeenCalled();
    expect(s).toMatchObject({ pendingReconcile: 1, collected: 0, failed: 0 });
  });

  // Owner decision, 21 Nov 2026: three automatic tries, 24 hours apart, then
  // the merchant is asked to pay by hand. The rule itself is pinned in
  // cycle.test.ts; this is the pass obeying it.
  describe("★★ the retry rule: three tries, 24 hours apart", () => {
    const LIVE_MANDATE = {
      id: "man-1",
      status: "active",
      maxAmountPaise: 10_000_00,
      providerTokenId: "tok_1",
      providerCustomerId: "cust_1",
    };
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

    /** An issued, unpaid renewal on a mandate that can carry it. */
    function openRenewal() {
      repo.ensureRenewalInvoice.mockResolvedValue({
        id: "inv-1",
        status: "open",
        finalizedAt: "2026-08-28T00:00:00.000Z",
      });
      seed([[DUE_ROW], [LIVE_MANDATE]]);
    }

    it("reads the invoice's automatic tries before it debits", async () => {
      openRenewal();
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(collector.automaticAttemptsOn).toHaveBeenCalledWith("inv-1");
      expect(collector.collectInvoice).toHaveBeenCalledTimes(1);
    });

    it("★★ the hourly run after a declined debit does NOT debit again", async () => {
      openRenewal();
      collector.automaticAttemptsOn.mockResolvedValue({
        count: 1,
        starts: 1,
        lastAt: hoursAgo(1),
      });
      const s = await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(collector.collectInvoice).not.toHaveBeenCalled();
      expect(s).toMatchObject({ pendingReconcile: 1, failed: 0 });
    });

    it("tries again once 24 hours have passed", async () => {
      openRenewal();
      collector.automaticAttemptsOn.mockResolvedValue({
        count: 1,
        starts: 1,
        lastAt: hoursAgo(24),
      });
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(collector.collectInvoice).toHaveBeenCalledTimes(1);
    });

    it("★★ after three tries it never debits again: the invoice is the merchant's to pay", async () => {
      openRenewal();
      collector.automaticAttemptsOn.mockResolvedValue({
        count: 3,
        starts: 3,
        lastAt: hoursAgo(72),
      });
      const s = await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(collector.collectInvoice).not.toHaveBeenCalled();
      expect(s.manualRequired).toBe(1);
      // Said once, when the third try failed; never by the hourly re-runs.
      expect(dunning.notifyAutopayStopped).not.toHaveBeenCalled();
    });

    it("★ a count that cannot be read is 'not this run', never 'no tries yet'", async () => {
      openRenewal();
      collector.automaticAttemptsOn.mockResolvedValue(null);
      const s = await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(collector.collectInvoice).not.toHaveBeenCalled();
      expect(s.pendingReconcile).toBe(1);
    });

    it("★★ the last attempt the backstop allows, failed at its first step, asks the merchant to pay by hand, once", async () => {
      openRenewal();
      // Five attempts before this run, none of which sent a debit; after it,
      // six, the backstop. The announcement re-reads both the invoice and
      // the history.
      collector.automaticAttemptsOn
        .mockResolvedValueOnce({ count: 0, starts: 5, lastAt: hoursAgo(25) })
        .mockResolvedValue({ count: 0, starts: 6, lastAt: NOW });
      collector.collectInvoice.mockResolvedValue({
        status: "failed",
        attemptId: "att-6",
        code: "gateway_rejected",
      });
      repo.getInvoice.mockResolvedValue({
        ...ISSUED,
        storeId: STORE,
        kind: "subscription",
        periodStart: "2026-09-03T00:00:00.000Z",
      });
      dbHolder.current = makeDbMock({
        selectQueue: [
          [DUE_ROW],
          [LIVE_MANDATE],
          [{ plan: "pro", scheduledPlan: null }],
        ],
      });
      const s = await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(s.failed).toBe(1);
      expect(dunning.notifyAutopayStopped).toHaveBeenCalledTimes(1);
      expect(dunning.notifyAutopayStopped).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: STORE,
          plan: "pro",
          amountPaise: 7_000_00,
          invoiceRef: "SM/2026-27/00004",
          // What the email counts: every attempt that was not withdrawn.
          attempts: 6,
          dueAt: new Date("2026-09-03T00:00:00.000Z"),
        }),
      );
    });

    it("★★ an attempt that failed before its debit is NOT one of the three tries: nothing is said and another follows (PR #303 review)", async () => {
      openRenewal();
      // The third attempt on this invoice, and the first two never sent a
      // debit either. The old rule called this the last try.
      collector.automaticAttemptsOn.mockResolvedValue({
        count: 0,
        starts: 2,
        lastAt: hoursAgo(30),
      });
      collector.collectInvoice.mockResolvedValue({
        status: "failed",
        attemptId: "att-3",
        code: "gateway_rejected",
      });
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(collector.collectInvoice).toHaveBeenCalledTimes(1);
      expect(repo.getInvoice).not.toHaveBeenCalled();
      expect(dunning.notifyAutopayStopped).not.toHaveBeenCalled();
    });

    it("★★ three debits SENT is the end: no fourth attempt starts", async () => {
      openRenewal();
      collector.automaticAttemptsOn.mockResolvedValue({
        count: 3,
        starts: 3,
        lastAt: hoursAgo(30),
      });
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(collector.collectInvoice).not.toHaveBeenCalled();
    });

    it("an invoice that cannot be collected automatically is not counted against the rule", async () => {
      // No mandate: `collectInvoice` answers not_collectable, as before.
      repo.ensureRenewalInvoice.mockResolvedValue({
        id: "inv-1",
        status: "open",
        finalizedAt: "2026-08-28T00:00:00.000Z",
      });
      seed([[{ ...DUE_ROW, mandateId: null }]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(collector.automaticAttemptsOn).not.toHaveBeenCalled();
    });
  });

  // 21 Nov 2026: StoreMink's record said `active` from the day a mandate was
  // authorised, but the customer can cancel or pause it at their bank at any
  // time, and only a `confirmed` token may be debited.
  describe("★★ the mandate is checked at the gateway before anything is promised", () => {
    const LIVE_MANDATE = {
      id: "man-1",
      status: "active",
      maxAmountPaise: 10_000_00,
      providerTokenId: "tok_1",
      providerCustomerId: "cust_1",
      method: "card",
    };
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    /** The pass's two reads, then the mandate status write's result. */
    function seedWith(mandate: unknown, moved: unknown[] = [{ id: "man-1" }]) {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [DUE_ROW],
          [mandate],
          [{ plan: "pro", scheduledPlan: null }],
        ],
        returning: moved,
      });
    }

    it("asks about this mandate's customer and token before the invoice is issued", async () => {
      seedWith(LIVE_MANDATE);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(charge.checkMandate).toHaveBeenCalledWith({
        providerCustomerId: "cust_1",
        providerTokenId: "tok_1",
      });
      expect(charge.checkMandate.mock.invocationCallOrder[0]).toBeLessThan(
        repo.finalizeInvoiceClaimed.mock.invocationCallOrder[0],
      );
    });

    it("★★ a mandate the customer CANCELLED: the one notice says pay by hand, and nothing is collected", async () => {
      charge.checkMandate.mockResolvedValueOnce({
        state: "ended",
        detail: "cancelled",
      });
      seedWith(LIVE_MANDATE);
      const s = await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(false);
      expect(collector.collectInvoice).toHaveBeenCalledTimes(1);
      // The mandate handed on is no longer `active`, so step 1 refuses it.
      expect(collector.collectInvoice.mock.calls[0][0].mandate.status).toBe(
        "revoked",
      );
      // StoreMink's own record follows the gateway.
      expect(dbHolder.current.calls.set).toContainEqual(
        expect.objectContaining({ status: "revoked" }),
      );
      expect(s.errors).toBe(0);
    });

    it("★ a PAUSED mandate is not charged now, and is left to be asked about again", async () => {
      charge.checkMandate.mockResolvedValueOnce({
        state: "paused",
        detail: "paused",
      });
      seedWith(LIVE_MANDATE);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(false);
      expect(dbHolder.current.calls.set).toContainEqual(
        expect.objectContaining({ status: "unknown" }),
      );
    });

    /** The pass's reads for a renewal that became due `hours` ago. */
    function seedDueSince(hours: number) {
      // Collection opens four days before the cycle begins.
      const periodEnd = new Date(
        NOW.getTime() + 4 * 24 * 3_600_000 - hours * 3_600_000,
      ).toISOString();
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ ...DUE_ROW, currentPeriodEnd: periodEnd }],
          [LIVE_MANDATE],
          [{ plan: "pro", scheduledPlan: null }],
        ],
      });
    }

    it("★★ a gateway that could not be asked stops the run BEFORE the invoice is issued: no notice on a guess", async () => {
      charge.checkMandate.mockResolvedValueOnce({ state: "unknown" });
      seedDueSince(MANDATE_CHECK_HOLD_HOURS - 1);
      const s = await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(repo.finalizeInvoiceClaimed).not.toHaveBeenCalled();
      expect(dunning.notifyInvoiceIssued).not.toHaveBeenCalled();
      expect(collector.collectInvoice).not.toHaveBeenCalled();
      expect(s.pendingReconcile).toBe(1);
    });

    // With no invoice the cycle turn has nothing unpaid to open grace on, and
    // the store would keep its plan for nothing. And "could not be asked" can
    // be permanent (Razorpay answers a deleted mandate "the id provided does
    // not exist").
    it(`★★ but not for ever: after ${MANDATE_CHECK_HOLD_HOURS}h of no answer the invoice is issued to pay by hand`, async () => {
      charge.checkMandate.mockResolvedValueOnce({ state: "unknown" });
      seedDueSince(MANDATE_CHECK_HOLD_HOURS);
      const s = await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(repo.finalizeInvoiceClaimed).toHaveBeenCalledTimes(1);
      // The one notice asks for payment; it promises no automatic debit.
      expect(dunning.notifyInvoiceIssued).toHaveBeenCalledTimes(1);
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(false);
      // No automatic try on a mandate nobody could vouch for.
      expect(collector.collectInvoice).not.toHaveBeenCalled();
      expect(s).toMatchObject({ manualRequired: 1, errors: 0 });
      // ★ The mandate's record is untouched: silence is not a cancellation.
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("★ once issued that way, a later run asks again, and autopay collects on a clear yes", async () => {
      repo.ensureRenewalInvoice.mockResolvedValue({
        id: "inv-1",
        status: "open",
        finalizedAt: "2026-08-31T00:00:00.000Z",
      });
      collector.automaticAttemptsOn.mockResolvedValue({
        count: 0,
        starts: 0,
        lastAt: null,
      });
      seedWith(LIVE_MANDATE);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(charge.checkMandate).toHaveBeenCalledTimes(1);
      expect(collector.collectInvoice).toHaveBeenCalledTimes(1);
      // Issued on an earlier run: no second issue notice.
      expect(dunning.notifyInvoiceIssued).not.toHaveBeenCalled();
    });

    it("★ a paused mandate the customer RESUMED is live again", async () => {
      seedWith({ ...LIVE_MANDATE, status: "unknown" });
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(dbHolder.current.calls.set).toContainEqual(
        expect.objectContaining({ status: "active" }),
      );
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(true);
    });

    it("nothing is asked with no gateway, no mandate, or a mandate already ended", async () => {
      seedWith(LIVE_MANDATE);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      seed([[{ ...DUE_ROW, mandateId: null }]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      seedWith({ ...LIVE_MANDATE, status: "revoked" });
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(charge.checkMandate).not.toHaveBeenCalled();
    });

    describe("a RETRY asks again, days after the invoice was issued", () => {
      function issuedAndOwed() {
        repo.ensureRenewalInvoice.mockResolvedValue({
          id: "inv-1",
          status: "open",
          finalizedAt: "2026-08-28T00:00:00.000Z",
        });
        collector.automaticAttemptsOn.mockResolvedValue({
          count: 1,
          starts: 1,
          lastAt: hoursAgo(40),
        });
        repo.getInvoice.mockResolvedValue({
          ...ISSUED,
          storeId: STORE,
          kind: "subscription",
          periodStart: "2026-09-03T00:00:00.000Z",
        });
      }

      it("a mandate still confirmed goes on to the next try", async () => {
        issuedAndOwed();
        seedWith(LIVE_MANDATE);
        const s = await collectDueRenewals({ now: NOW, charge, priceFor });
        expect(charge.checkMandate).toHaveBeenCalledTimes(1);
        expect(collector.collectInvoice).toHaveBeenCalledTimes(1);
        expect(s.errors).toBe(0);
      });

      it("★★ a mandate cancelled since: no try, and the merchant is asked to pay ONCE", async () => {
        issuedAndOwed();
        charge.checkMandate.mockResolvedValueOnce({
          state: "ended",
          detail: "cancelled",
        });
        seedWith(LIVE_MANDATE);
        const s = await collectDueRenewals({ now: NOW, charge, priceFor });
        expect(collector.collectInvoice).not.toHaveBeenCalled();
        expect(s.manualRequired).toBe(1);
        expect(dunning.notifyAutopayStopped).toHaveBeenCalledTimes(1);
        expect(dunning.notifyAutopayStopped.mock.calls[0][0]).toMatchObject({
          cause: "mandate",
          storeId: STORE,
        });
      });

      it("★ a status write another pass already made announces nothing a second time", async () => {
        issuedAndOwed();
        charge.checkMandate.mockResolvedValueOnce({
          state: "ended",
          detail: "cancelled",
        });
        // The conditional status write moved no row: someone got there first.
        seedWith(LIVE_MANDATE, []);
        await collectDueRenewals({ now: NOW, charge, priceFor });
        expect(collector.collectInvoice).not.toHaveBeenCalled();
        expect(dunning.notifyAutopayStopped).not.toHaveBeenCalled();
      });

      it("a gateway that could not be asked leaves the retry for the next run", async () => {
        issuedAndOwed();
        charge.checkMandate.mockResolvedValueOnce({ state: "unknown" });
        seedWith(LIVE_MANDATE);
        const s = await collectDueRenewals({ now: NOW, charge, priceFor });
        expect(collector.collectInvoice).not.toHaveBeenCalled();
        expect(s.pendingReconcile).toBe(1);
      });

      it("while it is still waiting its 24 hours, the gateway is not asked at all", async () => {
        issuedAndOwed();
        collector.automaticAttemptsOn.mockResolvedValue({
          count: 1,
          starts: 1,
          lastAt: hoursAgo(2),
        });
        seedWith(LIVE_MANDATE);
        await collectDueRenewals({ now: NOW, charge, priceFor });
        expect(charge.checkMandate).not.toHaveBeenCalled();
      });
    });
  });

  it("★ a renewal whose order and notice were created counts as notified", async () => {
    repo.ensureRenewalInvoice.mockResolvedValue({
      id: "inv-1",
      status: "open",
      finalizedAt: "2026-08-28T00:00:00.000Z",
    });
    collector.collectInvoice.mockResolvedValue({
      status: "notified",
      attemptId: "att-1",
      debitAfter: new Date("2026-09-02T14:00:00.000Z"),
    });
    seed([
      [DUE_ROW],
      [
        {
          id: "man-1",
          status: "active",
          maxAmountPaise: 10_000_00,
          providerTokenId: "tok_1",
          providerCustomerId: "cust_1",
          method: "upi",
        },
      ],
    ]);
    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(s).toMatchObject({ notified: 1, collected: 0, failed: 0 });
    // The mandate's rail goes with it: it decides the notice period.
    expect(collector.collectInvoice.mock.calls[0][0].mandate.method).toBe(
      "upi",
    );
  });

  describe("announceAutopayStopped: said only when it is true", () => {
    const openInvoice = {
      ...ISSUED,
      storeId: STORE,
      kind: "subscription",
      periodStart: "2026-09-03T00:00:00.000Z",
    };

    function facts(invoice: unknown, count: number) {
      repo.getInvoice.mockResolvedValue(invoice);
      collector.automaticAttemptsOn.mockResolvedValue({ count, lastAt: NOW });
      seed([[{ plan: "basic", scheduledPlan: "pro" }]]);
    }
    const run = () =>
      announceAutopayStopped({ storeId: STORE, invoiceId: "inv-1", now: NOW });

    it("names the plan the unpaid cycle was priced as (a booked change)", async () => {
      facts(openInvoice, 3);
      expect(await run()).toBe(true);
      expect(dunning.notifyAutopayStopped).toHaveBeenCalledWith(
        expect.objectContaining({ plan: "pro" }),
      );
    });

    it.each(["paid", "processing", "void", "uncollectible", "draft"])(
      "★ says nothing for an invoice that is %s",
      async (status) => {
        facts({ ...openInvoice, status }, 3);
        expect(await run()).toBe(false);
        expect(dunning.notifyAutopayStopped).not.toHaveBeenCalled();
      },
    );

    it("★ says nothing while a try is still left", async () => {
      facts(openInvoice, 2);
      expect(await run()).toBe(false);
      expect(dunning.notifyAutopayStopped).not.toHaveBeenCalled();
    });

    it("says nothing for another store's invoice, a pack invoice or a missing one", async () => {
      for (const invoice of [
        { ...openInvoice, storeId: "store-2" },
        { ...openInvoice, kind: "ai_credits" },
        null,
      ]) {
        facts(invoice, 3);
        expect(await run()).toBe(false);
      }
      expect(dunning.notifyAutopayStopped).not.toHaveBeenCalled();
    });

    it("never throws", async () => {
      repo.getInvoice.mockRejectedValue(new Error("db down"));
      expect(await run()).toBe(false);
    });
  });

  it("★ never guesses an amount — a null due figure stops the charge", async () => {
    repo.amountDueForInvoice.mockResolvedValue(null);
    seed([[DUE_ROW]]);
    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(collector.collectInvoice).not.toHaveBeenCalled();
    expect(s.pendingReconcile).toBe(1);
  });

  describe("★★ an invoice with no issue date is never collected", () => {
    // Finalize claims only a draft, so an invoice that is not a draft yet has no
    // `finalized_at` (a draft closed by hand) comes back unissued. Charging it
    // would take money with no document behind it.
    beforeEach(() => {
      repo.finalizeInvoiceClaimed.mockResolvedValue({
        invoice: {
          id: "inv-1",
          status: "void",
          finalizedAt: null,
          invoiceRef: null,
        },
        claimed: false,
      });
    });

    it("★★ does not charge it, does not announce it, and leaves it as it is", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(collector.collectInvoice).not.toHaveBeenCalled();
      expect(dunning.notifyInvoiceIssued).not.toHaveBeenCalled();
      expect(repo.amountDueForInvoice).not.toHaveBeenCalled();
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("★ logs it, naming the invoice and its status", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(logError).toHaveBeenCalledWith(
        "billing.renewal_unissued_invoice",
        expect.any(Error),
        { storeId: STORE, invoiceId: "inv-1", status: "void" },
      );
    });

    it("★ counts it with the other skips, never as collected, failed or manual", async () => {
      seed([[DUE_ROW]]);
      const s = await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(s).toMatchObject({
        considered: 1,
        collected: 0,
        failed: 0,
        manualRequired: 0,
        pendingReconcile: 1,
        errors: 0,
      });
    });

    it("★ the same with collection gated (charge = null): not a manual bill either", async () => {
      seed([[DUE_ROW]]);
      const s = await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(s.manualRequired).toBe(0);
      expect(s.pendingReconcile).toBe(1);
      expect(dunning.notifyInvoiceIssued).not.toHaveBeenCalled();
    });
  });

  it("bills locations on a POS plan", async () => {
    seed([[DUE_ROW]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });
    const built = repo.ensureRenewalInvoice.mock.calls[0][0].built;
    expect(built.lines.some((l: any) => l.kind === "location")).toBe(true);
    expect(built.totalPaise).toBe(7_000_00); // 5,000 + 2 × 1,000
  });

  it("★ never bills locations on a plan that cannot have POS", async () => {
    // Charging for POS on a plan that cannot use it is indefensible, and a
    // stale billed_locations count is exactly how that happens.
    seed([[{ ...DUE_ROW, plan: "basic" }]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });
    const built = repo.ensureRenewalInvoice.mock.calls[0][0].built;
    expect(built.lines.some((l: any) => l.kind === "location")).toBe(false);
    expect(built.totalPaise).toBe(5_000_00);
  });

  it("counts each outcome separately", async () => {
    seed([
      [DUE_ROW, { ...DUE_ROW, storeId: "s2" }, { ...DUE_ROW, storeId: "s3" }],
    ]);
    collector.collectInvoice
      .mockResolvedValueOnce({ status: "paid", attemptId: "a" })
      .mockResolvedValueOnce({ status: "failed", attemptId: "b" })
      .mockResolvedValueOnce({
        status: "not_collectable",
        reason: "over_afa_limit",
      });

    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(s).toMatchObject({
      considered: 3,
      collected: 1,
      failed: 1,
      manualRequired: 1,
    });
  });

  it("★ one store's failure does not abort the batch", async () => {
    seed([[DUE_ROW, { ...DUE_ROW, storeId: "s2" }]]);
    collector.collectInvoice
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "paid", attemptId: "b" });

    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(s.errors).toBe(1);
    expect(s.collected).toBe(1);
  });

  it("returns an empty summary when the claim query fails", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("db down");
        },
      },
    };
    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(s.errors).toBe(1);
    expect(s.considered).toBe(0);
  });
});

describe("evaluateCycleTurns — the boundary", () => {
  const TURNED = {
    storeId: STORE,
    plan: "pro",
    period: "monthly",
    billedLocations: 0,
    scheduledPlan: null,
    scheduledPeriod: null,
    scheduledLocations: null,
    cancelAtPeriodEnd: false,
    currentCycleSeq: 3,
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
  };

  it("advances a paid subscription into its new cycle", async () => {
    seed([[TURNED], [{ status: "paid" }]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.advanced).toBe(1);

    const set = dbHolder.current.calls.set[0];
    expect(set.currentCycleSeq).toBe(4);
    expect(set.currentPeriodStart).toBe("2026-09-01T00:00:00.000Z");
    expect(set.currentPeriodEnd).toBe("2026-10-01T00:00:00.000Z");
    expect(set.state).toBe("active");
    // Any previous grace is cleared — they paid.
    expect(set.graceStartedAt).toBeNull();
    expect(set.graceEndsAt).toBeNull();
  });

  it("★★ APPLIES a booked plan change at the turn", async () => {
    // The other half of the invariant: pass 1 priced the next cycle with this
    // change, so pass 2 must write it. If they disagree the merchant is billed
    // for one plan and given another.
    seed([[{ ...TURNED, scheduledPlan: "basic" }], [{ status: "paid" }]]);
    await evaluateCycleTurns({ now: NOW });
    const set = dbHolder.current.calls.set[0];
    expect(set.plan).toBe("basic");
    expect(set.scheduledPlan).toBeNull();
  });

  it("★★ APPLIES a booked period change, and the new cycle takes its LENGTH", async () => {
    // A monthly→yearly switch that ignored the period would give the merchant a
    // 30-day year.
    seed([[{ ...TURNED, scheduledPeriod: "yearly" }], [{ status: "paid" }]]);
    await evaluateCycleTurns({ now: NOW });
    const set = dbHolder.current.calls.set[0];
    expect(set.period).toBe("yearly");
    expect(set.currentPeriodEnd).toBe("2027-09-01T00:00:00.000Z");
    expect(set.scheduledPeriod).toBeNull();
  });

  it("★ applies a booked location release at the turn", async () => {
    seed([
      [{ ...TURNED, billedLocations: 3, scheduledLocations: 1 }],
      [{ status: "paid" }],
    ]);
    await evaluateCycleTurns({ now: NOW });
    const set = dbHolder.current.calls.set[0];
    expect(set.billedLocations).toBe(1);
    expect(set.scheduledLocations).toBeNull();
  });

  describe("★★ the store row moves with the cycle", () => {
    // Every gate reads `stores.plan`. Advancing only billing_subscriptions let a
    // PAID renewal lapse to Free (the first cycle's end sat in plan_expires_at,
    // never moved) and left a booked downgrade billed but never applied.
    it("keeps the paid plan and clears any expiry when the renewal was paid", async () => {
      seed([
        [TURNED],
        [{ status: "paid" }],
        [{ plan: "pro", planSource: "paid" }],
      ]);
      await evaluateCycleTurns({ now: NOW });
      expect(dbHolder.current.calls.update[1]).toBe(stores);
      expect(dbHolder.current.calls.set[1]).toEqual({
        plan: "pro",
        planSource: "paid",
        planExpiresAt: null,
      });
    });

    it("★★ applies a booked downgrade to the STORE, not only to the bill", async () => {
      seed([
        [{ ...TURNED, scheduledPlan: "basic" }],
        [{ status: "paid" }],
        [{ plan: "pro", planSource: "paid" }],
      ]);
      await evaluateCycleTurns({ now: NOW });
      expect(dbHolder.current.calls.set[1]).toMatchObject({ plan: "basic" });
    });

    // ★★ The booked plan has no Point of Sale, so the till stops at the turn:
    // the open shift is closed with it, as at a downgrade, and the change is
    // in the plan history.
    it("★★ closes the till and records the change when a booked downgrade drops POS", async () => {
      seed([
        [{ ...TURNED, scheduledPlan: "basic" }],
        [{ status: "paid" }],
        [
          {
            plan: "pro",
            planSource: "paid",
            planExpiresAt: null,
            compPlan: null,
            compExpiresAt: null,
          },
        ],
      ]);
      await evaluateCycleTurns({ now: NOW });
      const shift = dbHolder.current.calls.set.find(
        (x: any) => x.status === "closed",
      );
      expect(shift.note).toMatch(/as booked/i);
      expect(shift.variance).toBe(0);
      expect(dbHolder.current.calls.insert).toContain(planEvents);
      expect(dbHolder.current.calls.values.at(-1)).toEqual([
        expect.objectContaining({
          fromPlan: "pro",
          toPlan: "basic",
          source: "billing",
        }),
      ]);
    });

    it("★ leaves the till alone when the renewed plan keeps POS", async () => {
      seed([
        [TURNED],
        [{ status: "paid" }],
        [
          {
            plan: "pro",
            planSource: "paid",
            planExpiresAt: null,
            compPlan: null,
            compExpiresAt: null,
          },
        ],
      ]);
      await evaluateCycleTurns({ now: NOW });
      expect(
        dbHolder.current.calls.set.some((x: any) => x.status === "closed"),
      ).toBe(false);
      // Same plan: nothing to record.
      expect(dbHolder.current.calls.insert).not.toContain(planEvents);
    });

    it("★ never lowers an operator's comp", async () => {
      seed([
        [{ ...TURNED, scheduledPlan: "basic" }],
        [{ status: "paid" }],
        [{ plan: "pro", planSource: "comp" }],
      ]);
      await evaluateCycleTurns({ now: NOW });
      expect(dbHolder.current.calls.update).toEqual([
        expect.anything(), // the subscription
      ]);
    });

    it("★ touches the store only when the advance claim was WON", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [TURNED],
          [{ status: "paid" }],
          [{ plan: "pro", planSource: "paid" }],
        ],
        returning: [],
      });
      await evaluateCycleTurns({ now: NOW });
      expect(dbHolder.current.calls.update).not.toContain(stores);
    });
  });

  it("★ starts grace on an OPEN (attempted, unpaid) invoice", async () => {
    seed([[TURNED], [{ status: "open" }]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.graced).toBe(1);

    const set = dbHolder.current.calls.set[0];
    expect(set.state).toBe("past_due");
    expect(set.graceStartedAt).toBe(NOW.toISOString());
    expect(set.graceEndsAt).toBe(
      new Date(NOW.getTime() + GRACE_HOURS * 3600_000).toISOString(),
    );
  });

  it("★★ does NOTHING while the payment is still PROCESSING", async () => {
    // With the X+3 window this is the ORDINARY state at the boundary. Starting a
    // downgrade clock here is Rule 6 — punishing a merchant for money that is
    // still in flight.
    seed([[TURNED], [{ status: "processing" }]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.waiting).toBe(1);
    expect(s.graced).toBe(0);
    expect(s.advanced).toBe(0);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("★ does nothing when the invoice does not exist yet", async () => {
    seed([[TURNED], []]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.waiting).toBe(1);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("★ does nothing for a DRAFT invoice — it was never issued or attempted", async () => {
    seed([[TURNED], [{ status: "draft" }]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.waiting).toBe(1);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("★ claims the advance on the cycle it read, so it cannot double-advance", async () => {
    seed([[TURNED], [{ status: "paid" }]]);
    await evaluateCycleTurns({ now: NOW });
    // The WHERE carries both the store and the prior cycle_seq.
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  describe("★★ the 48-hour warning", () => {
    it("warns when grace starts, naming the deadline", async () => {
      seed([[TURNED], [{ status: "open" }]]);
      await evaluateCycleTurns({ now: NOW });
      expect(dunning.notifyGraceStarted).toHaveBeenCalledTimes(1);
      const arg = dunning.notifyGraceStarted.mock.calls[0][0];
      expect(arg).toMatchObject({ storeId: STORE, plan: "pro" });
      expect(arg.graceEndsAt.getTime() - NOW.getTime()).toBe(
        GRACE_HOURS * 3_600_000,
      );
    });

    it("★★ says nothing when the grace claim was already won", async () => {
      // The row is re-read every hour for two days; without the conditional claim
      // the merchant is warned 48 times about one missed payment.
      dbHolder.current = makeDbMock({
        selectQueue: [[TURNED], [{ status: "open" }]],
        returning: [],
      });
      await evaluateCycleTurns({ now: NOW });
      expect(dunning.notifyGraceStarted).not.toHaveBeenCalled();
    });

    it("★★ does NOT claim an attempt that never happened", async () => {
      // "We couldn't take payment" sends the merchant to check a card nobody
      // charged. Defaults to false, which is the truth while collection is gated.
      seed([[TURNED], [{ status: "open" }]]);
      await evaluateCycleTurns({ now: NOW });
      expect(dunning.notifyGraceStarted.mock.calls[0][0].autopayAttempted).toBe(
        false,
      );
    });

    it("reports an attempt when autopay really is running", async () => {
      seed([[TURNED], [{ status: "open" }]]);
      await evaluateCycleTurns({ now: NOW, autopayConfigured: true });
      expect(dunning.notifyGraceStarted.mock.calls[0][0].autopayAttempted).toBe(
        true,
      );
    });

    it("★ says nothing when the invoice was PAID", async () => {
      seed([[TURNED], [{ status: "paid" }]]);
      await evaluateCycleTurns({ now: NOW });
      expect(dunning.notifyGraceStarted).not.toHaveBeenCalled();
    });

    it("★ says nothing while the payment is still processing", async () => {
      seed([[TURNED], [{ status: "processing" }]]);
      await evaluateCycleTurns({ now: NOW });
      expect(dunning.notifyGraceStarted).not.toHaveBeenCalled();
    });
  });
});

describe("★★ a cancelled subscription ends at its period end", () => {
  const CANCELLING = {
    storeId: STORE,
    plan: "pro",
    period: "monthly",
    billedLocations: 0,
    scheduledPlan: null,
    scheduledPeriod: null,
    scheduledLocations: null,
    cancelAtPeriodEnd: true,
    currentCycleSeq: 3,
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
  };

  it("★★ ENDS it without waiting for an invoice", async () => {
    // claimDue never raised one, so without this branch the merchant sits in
    // `waiting` forever: still active, still entitled to a plan they stopped
    // paying for, and never actually cancelled.
    seed([[CANCELLING]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.ended).toBe(1);
    expect(s.waiting).toBe(0);
    const set = dbHolder.current.calls.set[0];
    expect(set.state).toBe("cancelled");
    expect(set.cancelAtPeriodEnd).toBe(false);
  });

  it("★★ DROPS THE PLAN TO FREE — that is what every gate reads", async () => {
    seed([[CANCELLING]]);
    await evaluateCycleTurns({ now: NOW });
    expect(dbHolder.current.calls.set.some((x: any) => x.plan === "free")).toBe(
      true,
    );
  });

  it("★ clears the cycle, so the cycle_present CHECK stays satisfied", async () => {
    seed([[CANCELLING]]);
    await evaluateCycleTurns({ now: NOW });
    const set = dbHolder.current.calls.set[0];
    expect(set.currentPeriodStart).toBeNull();
    expect(set.currentPeriodEnd).toBeNull();
  });

  it("★ tells the merchant, naming the plan they had", async () => {
    seed([[CANCELLING]]);
    await evaluateCycleTurns({ now: NOW });
    expect(dunning.notifyDowngraded).toHaveBeenCalledWith({
      storeId: STORE,
      fromPlan: "pro",
    });
  });

  it("★★ says nothing and counts nothing when the claim was LOST", async () => {
    // A resume racing the turn: the conditional claim is what decides.
    dbHolder.current = makeDbMock({
      selectQueue: [[CANCELLING]],
      returning: [],
    });
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.ended).toBe(0);
    expect(dunning.notifyDowngraded).not.toHaveBeenCalled();
  });

  it("★ never starts a grace clock on it", async () => {
    seed([[CANCELLING]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.graced).toBe(0);
    expect(dunning.notifyGraceStarted).not.toHaveBeenCalled();
  });

  describe("★★ every invoice for a cycle it does not reach is closed (R3)", () => {
    // The next cycle's invoice can be in any state when the plan ends: a draft
    // finalize left behind, open, still processing, or already paid. Each
    // becomes `void` in the same transaction that ends the plan, so an open one
    // is never chased and a paid one is refunded by the refund pass.
    it.each(["draft", "open", "processing", "paid"])(
      "★★ the next invoice, %s, is closed in the SAME transaction that ends the plan",
      async (status) => {
        dbHolder.current = makeDbMock({
          selectQueue: [[CANCELLING]],
          executeQueue: [[closedRow(status)]],
        });
        const s = await evaluateCycleTurns({ now: NOW });
        expect(s.ended).toBe(1);

        const closes = executed("update public.billing_invoices i");
        expect(closes).toHaveLength(1);
        const { sql, params } = render(closes[0]);
        expect(sql).toContain(
          "and i.status in ('draft', 'open', 'processing', 'paid')",
        );
        expect(sql).toContain("and i.cycle_seq > $2");
        // Above the cycle the plan reached: the one it was in (3).
        expect(params).toEqual([STORE, 3, NOW.toISOString()]);

        // ★ One transaction: the evaluate pass's own. Nothing else opened one
        // (the store row has no plan change to audit here).
        expect(vi.mocked(withService)).toHaveBeenCalledTimes(1);
        // ★ After the claim, before the plan moves: subscription row first,
        // invoices second, the store last.
        const db = dbHolder.current.db;
        const claimAt = db.update.mock.invocationCallOrder[0];
        const closeAt = db.execute.mock.invocationCallOrder[0];
        const storeAt =
          db.update.mock.invocationCallOrder[
            dbHolder.current.calls.update.indexOf(stores)
          ];
        expect(dbHolder.current.calls.update[0]).toBe(billingSubscriptions);
        expect(claimAt).toBeLessThan(closeAt);
        expect(closeAt).toBeLessThan(storeAt);

        expect(logInfo).toHaveBeenCalledWith(
          "billing.renewal.closed_unreached",
          {
            storeId: STORE,
            lastReachedSeq: 3,
            invoices: [{ id: "inv-4", previousStatus: status }],
          },
        );
      },
    );

    it("★★ a LOST end claim closes nothing", async () => {
      // A resume racing the turn: the cycle carries on, and so does its invoice.
      dbHolder.current = makeDbMock({
        selectQueue: [[CANCELLING]],
        returning: [],
      });
      await evaluateCycleTurns({ now: NOW });
      expect(executed("billing_invoices")).toHaveLength(0);
    });

    it("★ a failed close rolls the plan end back with it, and nobody is told", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[CANCELLING]] });
      dbHolder.current.db.execute = vi.fn(async () => {
        throw new Error("db down");
      });
      const s = await evaluateCycleTurns({ now: NOW });
      expect(s.errors).toBe(1);
      expect(dunning.notifyDowngraded).not.toHaveBeenCalled();
    });
  });
});

/** A subscription whose cycle has ended, as `advanceAfterPayment` reads it. */
const ENDED_CYCLE = {
  storeId: STORE,
  plan: "pro",
  period: "monthly",
  billedLocations: 0,
  scheduledPlan: null,
  scheduledPeriod: null,
  scheduledLocations: null,
  currentCycleSeq: 3,
  currentPeriodEnd: "2026-08-31T00:00:00.000Z",
  state: "past_due",
};

describe("★★ advanceAfterPayment never renews a cancelling subscription (R2)", () => {
  // A renewal payment that lands while the cancellation stands (an autopay
  // debit under way, a checkout opened before cancelling) must not restore or
  // extend the plan. It is refunded when the plan ends; Keep my plan clears the
  // flag first, and then this advances it.
  it("★★ returns false for a cancelling subscription even with a PAID next invoice", async () => {
    seed([[{ ...ENDED_CYCLE, cancelAtPeriodEnd: true }], [{ status: "paid" }]]);
    expect(await advanceAfterPayment(STORE, NOW)).toBe(false);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★ the same subscription, not cancelling, IS advanced (the control)", async () => {
    seed([
      [{ ...ENDED_CYCLE, cancelAtPeriodEnd: false }],
      [{ status: "paid" }],
    ]);
    expect(await advanceAfterPayment(STORE, NOW)).toBe(true);
    expect(dbHolder.current.calls.set[0].state).toBe("active");
    expect(dbHolder.current.calls.set[0].currentCycleSeq).toBe(4);
  });
});

describe("★★ pass 1 skips a cancelled subscription", () => {
  it("does not invoice a cycle that will not happen", async () => {
    // Raising a document would bill a merchant who explicitly stopped — and,
    // because grace follows an unpaid invoice, would then chase them for it.
    seed([[{ ...DUE_ROW, cancelAtPeriodEnd: true }]]);
    await collectDueRenewals({ now: NOW, charge: null, priceFor });
    expect(repo.ensureRenewalInvoice).not.toHaveBeenCalled();
  });
});

describe("★★ the next cycle is priced with what will APPLY then", () => {
  it("uses a booked plan change, not today's plan", async () => {
    seed([[{ ...DUE_ROW, scheduledPlan: "basic" }]]);
    await collectDueRenewals({ now: NOW, charge: null, priceFor });
    expect(priceFor).toHaveBeenCalledWith("basic", "monthly");
  });

  it("★ uses a booked PERIOD change — it decides the amount AND the cycle length", async () => {
    seed([[{ ...DUE_ROW, scheduledPeriod: "yearly" }]]);
    await collectDueRenewals({ now: NOW, charge: null, priceFor });
    expect(priceFor).toHaveBeenCalledWith("pro", "yearly");
    // 365 days on from the boundary, because a yearly cycle is a DURATION.
    const arg = repo.ensureRenewalInvoice.mock.calls[0][0];
    expect(arg.periodEnd.toISOString()).toBe("2027-09-03T00:00:00.000Z");
  });

  it("★★ drops locations when the booked plan has no POS", async () => {
    seed([[{ ...DUE_ROW, billedLocations: 3, scheduledPlan: "basic" }]]);
    await collectDueRenewals({ now: NOW, charge: null, priceFor });
    const built = repo.ensureRenewalInvoice.mock.calls[0][0].built;
    expect(built.lines.some((l: any) => l.kind === "location")).toBe(false);
  });
});

describe("downgradeExpired", () => {
  it("★ downgrades and closes the till in ONE transaction", async () => {
    seed([[{ storeId: STORE }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({ rows: [{ ok: true }] }));

    const s = await downgradeExpired({ now: NOW });
    expect(s.downgraded).toBe(1);
    expect(s.shiftsClosed).toBe(1);

    const set = dbHolder.current.calls.set.find(
      (x: any) => x.status === "closed",
    );
    expect(set.closedByName).toBe("System");
  });

  it("★★ takes the plan off the STORE — the claim alone moves only the bill", async () => {
    // It used to be plan_expires_at that removed the plan, from payers and
    // non-payers alike. Paid plans carry no expiry now, so this is the
    // downgrade. An operator's comp is not the subscription's to take.
    seed([[{ storeId: STORE, plan: "pro" }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({ rows: [{ ok: true }] }));
    await downgradeExpired({ now: NOW });
    const i = dbHolder.current.calls.update.indexOf(stores);
    expect(i).toBeGreaterThan(-1);
    expect(dbHolder.current.calls.set[i]).toEqual({
      plan: "free",
      planExpiresAt: null,
    });
    // The stores write keeps the comp guard.
    expect(
      dbHolder.current.calls.where.some((w: any) => {
        const v = sqlParamValues(w);
        return v.includes(STORE) && v.includes("comp");
      }),
    ).toBe(true);
  });

  it("★★ tells the merchant, naming the plan they LOST", async () => {
    // The claim sets plan to free, so the name has to be read before it — and
    // "your Pro plan has ended" is a different message from "your plan ended".
    seed([[{ storeId: STORE, plan: "pro" }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({ rows: [{ ok: true }] }));
    await downgradeExpired({ now: NOW });
    expect(dunning.notifyDowngraded).toHaveBeenCalledWith({
      storeId: STORE,
      fromPlan: "pro",
    });
  });

  it("★★ says NOTHING when the claim was lost — no downgrade, no notice", async () => {
    seed([[{ storeId: STORE, plan: "pro" }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({
      rows: [{ ok: false }],
    }));
    await downgradeExpired({ now: NOW });
    expect(dunning.notifyDowngraded).not.toHaveBeenCalled();
  });

  it("★★ closes the shift at ZERO variance — billing must not invent a discrepancy", async () => {
    // A variance reads as a cashier being short, and nobody counted this drawer.
    seed([[{ storeId: STORE }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({ rows: [{ ok: true }] }));
    await downgradeExpired({ now: NOW });
    const shift = dbHolder.current.calls.set.find(
      (x: any) => x.status === "closed",
    );
    expect(shift.variance).toBe(0);
    expect(shift.note).toMatch(/no variance/i);
  });

  // ★★ An operator's comp is not the subscription's to take away, so the store
  // keeps its plan and its till. Closing the drawer and telling the merchant
  // they are on Free were both false.
  it("★★ leaves a comped store's till open and says nothing about Free", async () => {
    seed([
      [{ storeId: STORE, plan: "basic" }],
      [
        {
          plan: "pro",
          planSource: "comp",
          planExpiresAt: null,
          compPlan: null,
          compExpiresAt: null,
        },
      ],
    ]);
    dbHolder.current.db.execute = vi.fn(async () => ({ rows: [{ ok: true }] }));
    const s = await downgradeExpired({ now: NOW });
    expect(s.downgraded).toBe(1);
    expect(s.shiftsClosed).toBe(0);
    expect(
      dbHolder.current.calls.set.some((x: any) => x.status === "closed"),
    ).toBe(false);
    expect(dunning.notifyDowngraded).not.toHaveBeenCalled();
  });

  it("★ treats a live comp overlay the same way", async () => {
    seed([
      [{ storeId: STORE, plan: "basic" }],
      [
        {
          plan: "basic",
          planSource: "paid",
          planExpiresAt: null,
          compPlan: "pro",
          compExpiresAt: "2026-12-01T00:00:00.000Z",
        },
      ],
    ]);
    dbHolder.current.db.execute = vi.fn(async () => ({ rows: [{ ok: true }] }));
    await downgradeExpired({ now: NOW });
    expect(
      dbHolder.current.calls.set.some((x: any) => x.status === "closed"),
    ).toBe(false);
    expect(dunning.notifyDowngraded).not.toHaveBeenCalled();
  });

  it("★ records the downgrade in the plan history", async () => {
    seed([
      [{ storeId: STORE, plan: "pro" }],
      [
        {
          plan: "pro",
          planSource: "paid",
          planExpiresAt: null,
          compPlan: null,
          compExpiresAt: null,
        },
      ],
    ]);
    dbHolder.current.db.execute = vi.fn(async () => ({ rows: [{ ok: true }] }));
    await downgradeExpired({ now: NOW });
    expect(dbHolder.current.calls.insert).toContain(planEvents);
    expect(dbHolder.current.calls.values.at(-1)).toEqual([
      expect.objectContaining({
        storeId: STORE,
        fromPlan: "pro",
        toPlan: "free",
        source: "billing",
      }),
    ]);
  });

  it("★ a REFUSED claim closes no shift — the store keeps trading", async () => {
    // billing_claim_downgrade says no when they paid or when it already ran.
    // (It used to refuse a comped subscription too; migration 0078 removed that
    // — a comp is an overlay, not a billing state.) Closing the till anyway
    // would stop a shop that is still entitled to sell.
    seed([[{ storeId: STORE }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({
      rows: [{ ok: false }],
    }));

    const s = await downgradeExpired({ now: NOW });
    expect(s.downgraded).toBe(0);
    expect(s.shiftsClosed).toBe(0);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("one store's failure does not abort the batch", async () => {
    seed([[{ storeId: STORE }, { storeId: "s2" }]]);
    let n = 0;
    dbHolder.current.db.execute = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("boom");
      return { rows: [{ ok: true }] };
    });

    const s = await downgradeExpired({ now: NOW });
    expect(s.errors).toBe(1);
    expect(s.downgraded).toBe(1);
  });

  it("returns an empty summary when the scan fails", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("db down");
        },
      },
    };
    const s = await downgradeExpired({ now: NOW });
    expect(s.errors).toBe(1);
    expect(s.downgraded).toBe(0);
  });

  describe("★★ a cancelling subscription in grace is ENDED, never downgraded", () => {
    // Cancelled while past_due or in grace: the plan stops at the grace end as
    // a cancellation (state `cancelled`, the flag cleared, the next invoice
    // closed `void`), never through `billing_claim_downgrade`, which would mark
    // the next invoice `uncollectible` and leave a payment there unrefunded.
    const CANCELLING_IN_GRACE = {
      storeId: STORE,
      plan: "pro",
      cancelAtPeriodEnd: true,
      currentCycleSeq: 3,
    };

    it.each(["open", "processing", "paid"])(
      "★★ next invoice %s: ended by endSubscription, the invoice closed void",
      async (status) => {
        dbHolder.current = makeDbMock({
          selectQueue: [[CANCELLING_IN_GRACE]],
          executeQueue: [[closedRow(status)]],
        });
        const s = await downgradeExpired({ now: NOW });

        expect(s).toEqual({
          downgraded: 0,
          shiftsClosed: 0,
          ended: 1,
          advancedAfterGrace: 0,
          errors: 0,
          next: null,
        });
        // ★★ The downgrade claim is never asked.
        expect(executed("billing_claim_downgrade")).toHaveLength(0);

        // The end: state cancelled, flag cleared, grace fields cleared.
        expect(dbHolder.current.calls.update[0]).toBe(billingSubscriptions);
        expect(dbHolder.current.calls.set[0]).toEqual(
          expect.objectContaining({
            state: "cancelled",
            cancelAtPeriodEnd: false,
            graceStartedAt: null,
            graceEndsAt: null,
            currentPeriodStart: null,
            currentPeriodEnd: null,
          }),
        );
        // ★ The claim has NO state condition: the scan already chose past_due
        // or grace, and the flag plus the cycle are what make it exactly-once.
        const claim = render(dbHolder.current.calls.where[1]);
        expect(claim.sql).toContain('"billing_subscriptions"."store_id" = $1');
        expect(claim.sql).toContain(
          '"billing_subscriptions"."current_cycle_seq" = $2',
        );
        expect(claim.sql).toContain(
          '"billing_subscriptions"."cancel_at_period_end" = $3',
        );
        expect(claim.sql).not.toContain('"billing_subscriptions"."state"');
        expect(claim.params).toEqual([STORE, 3, true]);

        // ★★ Every invoice above the cycle, whatever its status, goes void.
        const closes = executed("update public.billing_invoices i");
        expect(closes).toHaveLength(1);
        const { sql, params } = render(closes[0]);
        expect(sql).toContain(
          "and i.status in ('draft', 'open', 'processing', 'paid')",
        );
        expect(sql).toContain("set status = 'void'");
        expect(params).toEqual([STORE, 3, NOW.toISOString()]);

        expect(logInfo).toHaveBeenCalledWith(
          "billing.renewal.cancelled_at_grace_end",
          { storeId: STORE },
        );
        expect(dunning.notifyDowngraded).toHaveBeenCalledWith({
          storeId: STORE,
          fromPlan: "pro",
        });
      },
    );

    it("★ a LOST end claim (a resume won) ends nothing, closes nothing and says nothing", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[CANCELLING_IN_GRACE]],
        returning: [],
      });
      const s = await downgradeExpired({ now: NOW });
      expect(s.ended).toBe(0);
      expect(s.downgraded).toBe(0);
      expect(dbHolder.current.calls.execute).toHaveLength(0);
      expect(dunning.notifyDowngraded).not.toHaveBeenCalled();
      // Not the safety net either: that is for a subscription the claim refused.
      expect(dbHolder.current.calls.select).toHaveLength(1);
    });

    it("★ a failure ending it is counted, and the batch goes on", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [CANCELLING_IN_GRACE, { ...CANCELLING_IN_GRACE, storeId: "s2" }],
        ],
      });
      let n = 0;
      dbHolder.current.db.execute = vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return { rows: [] };
      });
      const s = await downgradeExpired({ now: NOW });
      expect(s.errors).toBe(1);
      expect(s.ended).toBe(1);
      expect(logError).toHaveBeenCalledWith(
        "billing.renewal.end_cancelled",
        expect.any(Error),
        { storeId: STORE },
      );
    });

    it("★★ a NON-cancelling subscription still goes through the claim, unchanged", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ ...CANCELLING_IN_GRACE, cancelAtPeriodEnd: false }]],
        executeQueue: [[{ ok: true }]],
      });
      const s = await downgradeExpired({ now: NOW });
      expect(s.downgraded).toBe(1);
      expect(s.ended).toBe(0);
      expect(executed("billing_claim_downgrade")).toHaveLength(1);
      // The claim marks the next invoice uncollectible itself; nothing is
      // closed void on this path.
      expect(executed("update public.billing_invoices i")).toHaveLength(0);
    });
  });

  describe("★★ the safety net: a refused claim whose next invoice is PAID advances", () => {
    // `billing_claim_downgrade` refuses when the next invoice was paid, and the
    // cycle may still not have turned (a payment the reconcile pass recorded
    // without advancing, a manual payment whose advance failed). Left alone
    // that subscription sits in grace for ever; `advanceAfterPayment` re-reads
    // everything and advances only a paid next invoice.
    const IN_GRACE = {
      storeId: STORE,
      plan: "pro",
      cancelAtPeriodEnd: false,
      currentCycleSeq: 3,
    };

    it("★★ advances it and counts it", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [IN_GRACE],
          [{ ...ENDED_CYCLE, cancelAtPeriodEnd: false }],
          [{ status: "paid" }],
        ],
        executeQueue: [[{ ok: false }]],
      });
      const s = await downgradeExpired({ now: NOW });

      expect(s.advancedAfterGrace).toBe(1);
      expect(s.downgraded).toBe(0);
      expect(s.ended).toBe(0);
      expect(s.errors).toBe(0);
      expect(logInfo).toHaveBeenCalledWith(
        "billing.renewal.advanced_after_grace",
        { storeId: STORE },
      );
      const advance = dbHolder.current.calls.set.find(
        (x: any) => x.state === "active",
      );
      expect(advance.currentCycleSeq).toBe(4);
      expect(dunning.notifyDowngraded).not.toHaveBeenCalled();
    });

    it("★ runs AFTER the claim's transaction, in its own", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [IN_GRACE],
          [{ ...ENDED_CYCLE, cancelAtPeriodEnd: false }],
          [{ status: "paid" }],
        ],
        executeQueue: [[{ ok: false }]],
      });
      await downgradeExpired({ now: NOW });
      // The scan, the claim and the advance: three transactions.
      expect(vi.mocked(withService)).toHaveBeenCalledTimes(3);
      const db = dbHolder.current.db;
      const claimAt = db.execute.mock.invocationCallOrder[0];
      const advanceReadAt = db.select.mock.invocationCallOrder[1];
      expect(claimAt).toBeLessThan(advanceReadAt);
    });

    it("★★ a refused claim whose next invoice is still PROCESSING is NOT advanced", async () => {
      // The money may yet land; until it does, the claim keeps refusing and the
      // subscription waits. Advancing on a payment in flight gives a cycle away.
      dbHolder.current = makeDbMock({
        selectQueue: [
          [IN_GRACE],
          [{ ...ENDED_CYCLE, cancelAtPeriodEnd: false }],
          [{ status: "processing" }],
        ],
        executeQueue: [[{ ok: false }]],
      });
      const s = await downgradeExpired({ now: NOW });
      expect(s.advancedAfterGrace).toBe(0);
      expect(dbHolder.current.calls.set).toHaveLength(0);
      expect(logInfo).not.toHaveBeenCalledWith(
        "billing.renewal.advanced_after_grace",
        expect.anything(),
      );
    });
  });
});

// 21 Nov 2026: every pass took "the first 50 rows" with no ORDER BY, and most
// of those rows are still there on the next run, so past a few hundred
// subscribers the same 50 could come back every hour and the rest never be
// reached. Each pass now pages in a fixed order.
describe("★★ the passes page through every subscription", () => {
  const CURSOR = {
    at: "2026-09-03 00:00:00.123456+00",
    storeId: "a0000000-0000-4000-8000-000000000009",
  };
  /** Every WHERE the pass ran, as Postgres would receive it. */
  const wheres = () =>
    dbHolder.current.calls.where.map((w: unknown) => render(w));
  const page = (n: number, make: (i: number) => Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => make(i));
  const storeId = (i: number) =>
    `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

  describe("collectDueRenewals", () => {
    const due = (i: number) => ({
      ...DUE_ROW,
      storeId: storeId(i),
      mandateId: null,
      currentPeriodEnd: `2026-09-03 00:00:0${i % 10}+00`,
    });

    it("a FULL page hands back where it stopped; a short page does not", async () => {
      seed([page(3, due)]);
      const full = await collectDueRenewals({
        now: NOW,
        limit: 3,
        charge: null,
        priceFor,
      });
      expect(full.next).toEqual({
        at: "2026-09-03 00:00:02+00",
        storeId: storeId(2),
      });

      seed([page(2, due)]);
      const short = await collectDueRenewals({
        now: NOW,
        limit: 3,
        charge: null,
        priceFor,
      });
      expect(short.next).toBeNull();
    });

    it("★★ the next page starts strictly AFTER the cursor, by (cycle end, store)", async () => {
      seed([[]]);
      await collectDueRenewals({
        now: NOW,
        charge: null,
        priceFor,
        after: CURSOR,
      });
      const claim = wheres()[0];
      expect(claim.sql).toContain(
        '("billing_subscriptions"."current_period_end", "billing_subscriptions"."store_id") > (',
      );
      // The cursor's own time string goes back unchanged, so no precision is
      // lost between pages.
      expect(claim.params).toContain(CURSOR.at);
      expect(claim.params).toContain(CURSOR.storeId);
    });

    it("the first page has no cursor at all", async () => {
      seed([[]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(wheres()[0].sql).not.toContain(") > (");
    });

    it("★★ a renewal already PAID is not read again every hour until its cycle turns", async () => {
      seed([[]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      const claim = wheres()[0].sql;
      expect(claim).toContain("not exists");
      expect(claim).toContain("paid_next.status = 'paid'");
      expect(claim).toContain(
        'paid_next.cycle_seq = "billing_subscriptions"."current_cycle_seq" + 1',
      );
    });

    it("a failed read leads nowhere", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
      const s = await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(s).toMatchObject({ errors: 1, next: null });
    });
  });

  describe("evaluateCycleTurns", () => {
    const turned = (i: number) => ({
      storeId: storeId(i),
      plan: "pro",
      period: "monthly",
      billedLocations: 0,
      scheduledPlan: null,
      scheduledPeriod: null,
      scheduledLocations: null,
      cancelAtPeriodEnd: false,
      currentCycleSeq: 3,
      currentPeriodEnd: `2026-08-30 00:00:0${i}+00`,
    });

    it("★ a full page of cycles still WAITING on a payment does not hide the ones behind it", async () => {
      // No invoice rows are seeded, so every row is "waiting": exactly the
      // rows that stay in the set and used to fill every page.
      seed([page(2, turned)]);
      const s = await evaluateCycleTurns({ now: NOW, limit: 2 });
      expect(s.waiting).toBe(2);
      expect(s.next).toEqual({
        at: "2026-08-30 00:00:01+00",
        storeId: storeId(1),
      });
    });

    it("the next page starts after the cursor; a short page ends the pass", async () => {
      seed([page(1, turned)]);
      const s = await evaluateCycleTurns({ now: NOW, limit: 2, after: CURSOR });
      expect(s.next).toBeNull();
      expect(wheres()[0].sql).toContain(
        '("billing_subscriptions"."current_period_end", "billing_subscriptions"."store_id") > (',
      );
      expect(wheres()[0].params).toContain(CURSOR.at);
    });

    it("a page that failed leads nowhere", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
      const s = await evaluateCycleTurns({ now: NOW, limit: 1 });
      expect(s).toMatchObject({ errors: 1, next: null });
    });
  });

  describe("downgradeExpired", () => {
    const lapsed = (i: number) => ({
      storeId: storeId(i),
      plan: "pro",
      cancelAtPeriodEnd: false,
      currentCycleSeq: 3,
      graceEndsAt: `2026-08-29 00:00:0${i}+00`,
    });

    it("a full page hands back where it stopped, by (grace end, store)", async () => {
      seed([page(2, lapsed)]);
      // The claim refuses both (a payment is in flight): they stay in the set.
      dbHolder.current.db.execute = vi.fn(async () => ({ rows: [] }));
      const s = await downgradeExpired({ now: NOW, limit: 2 });
      expect(s.next).toEqual({
        at: "2026-08-29 00:00:01+00",
        storeId: storeId(1),
      });
    });

    it("the next page starts after the cursor; a short page ends the pass", async () => {
      seed([[]]);
      const s = await downgradeExpired({ now: NOW, limit: 2, after: CURSOR });
      expect(s.next).toBeNull();
      expect(wheres()[0].sql).toContain(
        '("billing_subscriptions"."grace_ends_at", "billing_subscriptions"."store_id") > (',
      );
      expect(wheres()[0].params).toContain(CURSOR.storeId);
    });
  });
});
