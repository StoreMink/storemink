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
  amountDueForInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => repo);

const collector = vi.hoisted(() => ({ collectInvoice: vi.fn() }));
vi.mock("./collect", () => collector);

// Telling the merchant is best-effort and proved by its own suite; here it is a
// seam, so a test can assert WHO was told and WHEN without sending mail.
const dunning = vi.hoisted(() => ({
  notifyInvoiceIssued: vi.fn(),
  notifyGraceStarted: vi.fn(),
  notifyDowngraded: vi.fn(),
}));
vi.mock("./dunning", () => dunning);

import {
  advanceAfterPayment,
  classify,
  collectDueRenewals,
  downgradeExpired,
  evaluateCycleTurns,
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

const charge = vi.fn() as any;

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
