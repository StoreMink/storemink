/* eslint-disable @typescript-eslint/no-explicit-any */
// The refund pass and the console helpers it shares (renewal-cancel, design
// 6.6 and 11.1).
//
// The db mock does not evaluate SQL. Each statement is rendered with the real
// Postgres dialect and answered by the first handler whose pattern matches,
// so a test both chooses what the database says and reads back exactly what
// was asked: the predicates, the parameters and the order. The statements
// themselves run against storemink_local in refunds.local.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

type Rendered = { sql: string; params: unknown[]; tx: number };
type Reply = Record<string, unknown>[] | ((q: Rendered) => any) | Error;

const st = vi.hoisted(() => ({
  handlers: [] as { test: RegExp; reply: any; once?: boolean }[],
  log: [] as { sql: string; params: unknown[]; tx: number }[],
  events: [] as string[],
  tx: 0,
  depth: 0,
  maxDepth: 0,
  dispatch: null as null | ((q: unknown, tx: number) => Promise<any>),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: any) => any) => {
    st.tx += 1;
    const id = st.tx;
    st.depth += 1;
    st.maxDepth = Math.max(st.maxDepth, st.depth);
    try {
      const db = { execute: vi.fn((q: unknown) => st.dispatch!(q, id)) };
      const out = await fn(db);
      st.events.push(`commit:${id}`);
      return out;
    } finally {
      st.depth -= 1;
    }
  }),
}));

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/lib/payments/provider", () => ({
  getPlatformRazorpayCreds: vi.fn(() => null),
}));

vi.mock("@/lib/payments/razorpay", () => ({
  RZP_REFUND_PAGE_SIZE: 100,
  rzpRefund: vi.fn(),
  rzpFetchPaymentRefunds: vi.fn(),
}));

vi.mock("./platform-settings", () => ({ getRefundSettings: vi.fn() }));

vi.mock("./credit-note-store", () => ({
  issueCreditNote: vi.fn(),
  creditNoteParticulars: vi.fn(),
}));

vi.mock("./receipts", () => ({
  notifyRefundSent: vi.fn(async () => {
    st.events.push("notify:sent");
  }),
  notifyRefundRecorded: vi.fn(async () => {
    st.events.push("notify:recorded");
  }),
}));

import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import { rzpFetchPaymentRefunds, rzpRefund } from "@/lib/payments/razorpay";
import { getRefundSettings } from "./platform-settings";
import { creditNoteParticulars, issueCreditNote } from "./credit-note-store";
import { notifyRefundRecorded, notifyRefundSent } from "./receipts";
import {
  BELOW_MINIMUM_MESSAGE,
  MOVED_ON_MESSAGE,
  NOTE_REQUIRED_MESSAGE,
  cancelOwedRefund,
  countRefundsNeedingAction,
  createOperatorRefund,
  detectOwedRefund,
  istHour,
  listRefunds,
  overCapMessage,
  platformFetchRefundsFn,
  platformRefundFn,
  processBillingRefunds,
  recordRefundMadeOutside,
  refundableForInvoice,
  retryRefund,
  sendOwedRefund,
  sendRefundNow,
  tellMerchantRefund,
  type FetchRefundsFn,
  type RefundFn,
} from "./refunds";

const dialect = new PgDialect();

st.dispatch = async (q: unknown, tx: number) => {
  const r = dialect.sqlToQuery(q as any);
  const rendered: Rendered = {
    sql: r.sql.replace(/\s+/g, " ").trim(),
    params: r.params,
    tx,
  };
  st.log.push(rendered);
  st.events.push(`sql:${tx}:${rendered.sql.slice(0, 60)}`);
  const i = st.handlers.findIndex((h) => h.test.test(rendered.sql));
  if (i < 0) return { rows: [] };
  const h = st.handlers[i];
  if (h.once) st.handlers.splice(i, 1);
  const reply = h.reply;
  if (reply instanceof Error) throw reply;
  const rows = typeof reply === "function" ? reply(rendered) : reply;
  if (rows instanceof Error) throw rows;
  return { rows };
};

/** Answer statements matching `test` with `reply` (first match wins). */
function on(test: RegExp, reply: Reply, opts: { once?: boolean } = {}) {
  st.handlers.push({ test, reply, once: opts.once });
}

function statements(test: RegExp) {
  return st.log.filter((s) => test.test(s.sql));
}

function pgError(code: string, message = "refused") {
  return Object.assign(new Error(message), { code });
}

// 11:00 IST, outside the 09:00 waiting check.
const NOW = new Date("2026-10-29T05:30:00.000Z");
// 09:00 IST.
const NINE_IST = new Date("2026-10-29T03:30:00.000Z");
const FROM = "2026-10-01T00:00:00.000Z";

const STORE = "33333333-3333-4333-8333-333333333333";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";
const REFUND = "11111111-1111-4111-8111-111111111111";
const REFUND_2 = "55555555-5555-4555-8555-555555555555";
const KEY = "8b1c0b9e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";

// Statement patterns, one per step.
const P = {
  repairClose: /^with closing as/,
  repairPaid: /'paid_unreached:'/,
  repairKept: /'kept_before_refunds:'/,
  detectScan:
    /^select a\.id, a\.invoice_id, a\.amount_paise, a\.provider_payment_id, i\.invoice_ref/,
  detectLock:
    /^select 1 from public\.billing_payment_attempts where id = \$1 for update$/,
  detectRecheck: /^select a\.amount_paise, a\.provider_payment_id from/,
  detectInsert: /^insert into public\.billing_refunds .* 'system',/,
  refusedRead:
    /^select 1 from public\.billing_refunds where attempt_id = \$1 and requested_by = 'system'/,
  refusedFile:
    /^insert into public\.billing_reconciliation_items .*'refund_refused:'/,
  sendScan: /^select r\.id, r\.requested_by from public\.billing_refunds r/,
  claim: /^update public\.billing_refunds r set status = 'pending'/,
  toProcessed: /set status = 'processed'/,
  toFailed: /set status = 'failed'/,
  keepRefundId:
    /^update public\.billing_refunds set provider_refund_id = \$1, updated_at/,
  reconcileScan:
    /^select r\.id, r\.idempotency_key, r\.provider_payment_id, \(r\.sent_at </,
  noteScan:
    /^select r\.id from public\.billing_refunds r join public\.billing_invoices i/,
  cancelNoteScan: /^select i\.id from public\.billing_invoices i/,
  notifyScan: /^select r\.id, r\.reason, exists/,
  notifyClaim: /^update public\.billing_refunds set notified_at = \$1/,
  waiting: /^with flagged as/,
};

const gateway = {
  refund: vi.fn<RefundFn>(),
  fetch: vi.fn<FetchRefundsFn>(),
};

function pass(over: Record<string, unknown> = {}) {
  return processBillingRefunds({
    now: NOW,
    refund: gateway.refund,
    fetchRefunds: gateway.fetch,
    ...over,
  });
}

function settings(autoRefunds: boolean, from: string | null = FROM) {
  vi.mocked(getRefundSettings).mockResolvedValue({
    autoRefunds,
    automaticRefundsFrom: from,
  });
}

function claimedRow(over: Record<string, unknown> = {}) {
  return {
    id: REFUND,
    idempotency_key: KEY,
    provider_payment_id: "pay_1",
    amount_paise: "11800",
    reason: "cycle_not_reached",
    invoice_id: INVOICE,
    invoice_ref: "SM/2026-27/00004",
    ...over,
  };
}

function rzRefund(over: Record<string, unknown> = {}) {
  return {
    id: "rfnd_1",
    payment_id: "pay_1",
    amount: 11800,
    status: "processed",
    notes: { sm_refund_key: KEY },
    ...over,
  } as any;
}

beforeEach(() => {
  st.handlers = [];
  st.log = [];
  st.events = [];
  st.tx = 0;
  st.depth = 0;
  st.maxDepth = 0;
  settings(true);
  gateway.refund.mockImplementation(async () => {
    st.events.push("gateway");
    return { ok: true, data: rzRefund() };
  });
  gateway.fetch.mockResolvedValue({ ok: true, data: [] });
  vi.mocked(issueCreditNote).mockResolvedValue({
    outcome: "not_needed",
    why: "no_tax",
  });
  vi.mocked(creditNoteParticulars).mockResolvedValue(null);
});

describe("the pass", () => {
  it("★ fails closed when the settings cannot be read: one error, nothing done", async () => {
    vi.mocked(getRefundSettings).mockRejectedValue(new Error("db down"));
    const summary = await pass();
    expect(summary.errors).toBe(1);
    expect(st.log).toHaveLength(0);
    expect(gateway.refund).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "billing.refunds.settings",
      expect.any(Error),
    );
  });

  it("an empty store does nothing and reports nothing", async () => {
    const summary = await pass();
    expect(summary).toEqual({
      repairedInvoices: 0,
      flaggedForPerson: 0,
      detected: 0,
      sent: 0,
      processed: 0,
      failed: 0,
      stillPending: 0,
      creditNotes: 0,
      notified: 0,
      waiting: 0,
      errors: 0,
      more: false,
    });
  });

  it("★ never opens a scope inside another (one pooled connection at a time)", async () => {
    on(P.sendScan, [{ id: REFUND, requested_by: "system" }]);
    on(P.claim, [claimedRow()]);
    on(P.toProcessed, [{ id: REFUND }]);
    on(P.notifyScan, [
      { id: REFUND, reason: "cycle_not_reached", has_note: true },
    ]);
    on(P.notifyClaim, [{ id: REFUND, status: "processed" }]);
    await pass();
    expect(st.maxDepth).toBe(1);
  });

  it("★ one bad step does not stop the rest", async () => {
    on(P.detectScan, pgError("57P01", "terminating"));
    on(P.sendScan, [{ id: REFUND, requested_by: "system" }]);
    on(P.claim, [claimedRow()]);
    on(P.toProcessed, [{ id: REFUND }]);
    const summary = await pass();
    expect(summary.errors).toBe(1);
    expect(summary.processed).toBe(1);
  });

  it("★ one bad row does not stop the rest", async () => {
    on(P.sendScan, [
      { id: REFUND, requested_by: "system" },
      { id: REFUND_2, requested_by: "system" },
    ]);
    on(P.claim, new Error("connection reset"), { once: true });
    on(P.claim, [claimedRow({ id: REFUND_2 })]);
    on(P.toProcessed, [{ id: REFUND_2 }]);
    const summary = await pass();
    expect(summary.errors).toBe(1);
    expect(summary.processed).toBe(1);
    expect(gateway.refund).toHaveBeenCalledTimes(1);
  });

  it("★★ never writes an invoice's or a payment's status (rule R9)", async () => {
    // Every step with work: a closed leftover, an owed refund sent and
    // processed, a pending refund reconciled, a note and an email.
    on(P.repairClose, [{ id: INVOICE, store_id: STORE, invoice_ref: "x" }]);
    on(P.sendScan, [{ id: REFUND, requested_by: "system" }]);
    on(P.claim, [claimedRow()]);
    on(P.toProcessed, [{ id: REFUND }]);
    on(P.reconcileScan, [
      {
        id: REFUND_2,
        idempotency_key: "k".repeat(12),
        provider_payment_id: "pay_2",
        overdue: false,
      },
    ]);
    gateway.fetch.mockResolvedValue({
      ok: true,
      data: [
        rzRefund({ id: "rfnd_2", notes: { sm_refund_key: "k".repeat(12) } }),
      ],
    });
    on(P.noteScan, [{ id: REFUND }]);
    on(P.notifyScan, [
      { id: REFUND, reason: "cycle_not_reached", has_note: true },
    ]);
    on(P.notifyClaim, [{ id: REFUND, status: "processed" }]);
    await pass();

    const invoiceWrites = statements(/update public\.billing_invoices/);
    // The repair's close of an unpaid leftover is the only one.
    expect(invoiceWrites).toHaveLength(1);
    expect(invoiceWrites[0].sql).toMatch(P.repairClose);
    expect(statements(/update public\.billing_payment_attempts/)).toEqual([]);
    expect(
      statements(/(status|state) = '(refunded|partially_refunded)'/),
    ).toEqual([]);
  });
});

describe("step 1: repair", () => {
  it("★★ closes only an open, issued, hour-old leftover with no money on it", async () => {
    on(P.repairClose, [{ id: INVOICE, store_id: STORE, invoice_ref: "R1" }]);
    const summary = await pass();
    expect(summary.repairedInvoices).toBe(1);
    const [close] = statements(P.repairClose);
    // Never a draft, never one issued under an hour ago.
    expect(close.sql).toContain("c.status = 'open'");
    expect(close.sql).toContain("c.finalized_at is not null");
    expect(close.sql).toMatch(/c\.finalized_at < \$\d+/);
    expect(close.params).toContain(
      new Date(NOW.getTime() - 3_600_000).toISOString(),
    );
    // Never one with a payment in flight or captured.
    expect(close.sql).toContain(
      "not exists ( select 1 from public.billing_payment_attempts a where a.invoice_id = c.id and a.state in ('created', 'processing', 'authorized', 'unknown', 'captured'))",
    );
    // Above an ended plan's cycle, or below a live plan's.
    expect(close.sql).toContain(
      "(s.state in ('cancelled', 'downgraded') and c.cycle_seq > s.current_cycle_seq)",
    );
    expect(close.sql).toContain(
      "(s.state in ('active', 'past_due', 'grace') and c.cycle_seq < s.current_cycle_seq)",
    );
    expect(close.sql).toContain("for update of c skip locked");
    expect(close.sql).toContain("set status = 'void'");
    expect(logInfo).toHaveBeenCalledWith(
      "billing.refunds.repair_closed",
      expect.objectContaining({
        invoices: [{ id: INVOICE, invoiceRef: "R1" }],
      }),
    );
  });

  it("★ files a paid renewal of an ended plan once, by its repair_key", async () => {
    on(P.repairPaid, [{ id: "item-1", invoice_id: INVOICE }]);
    const summary = await pass();
    expect(summary.flaggedForPerson).toBe(1);
    const [file] = statements(P.repairPaid);
    expect(file.sql).toMatch(
      /^insert into public\.billing_reconciliation_items/,
    );
    expect(file.sql).toContain("'repair_key', 'paid_unreached:' || i.id");
    expect(file.sql).toContain(
      "x.detail ->> 'repair_key' = 'paid_unreached:' || i.id::text",
    );
    expect(file.sql).toContain("i.status = 'paid'");
    expect(file.sql).toContain("s.state in ('cancelled', 'downgraded')");
    expect(file.sql).toContain("i.cycle_seq > s.current_cycle_seq");
    expect(file.sql).toContain("coalesce(i.paid_at, i.updated_at) < $");
    expect(file.sql).toMatch(/on conflict do nothing returning id/);
  });

  it("★★ files history (an uncollectible capture before the line), never owes it", async () => {
    on(P.repairKept, [{ id: "item-2", attempt_id: ATTEMPT }]);
    const summary = await pass();
    expect(summary.flaggedForPerson).toBe(1);
    const [file] = statements(P.repairKept);
    expect(file.sql).toContain("'repair_key', 'kept_before_refunds:' || a.id");
    expect(file.sql).toContain("i.status = 'uncollectible'");
    expect(file.sql).toMatch(
      /coalesce\(a\.resolved_at, a\.updated_at\) < coalesce\(\$\d+::timestamptz, 'infinity'::timestamptz\)/,
    );
    expect(file.params).toContain(FROM);
    // A payment with any refund row, in any status, is not history.
    expect(file.sql).toContain(
      "not exists ( select 1 from public.billing_refunds r where r.attempt_id = a.id)",
    );
    // The same line, the other way round, in detection.
    const [scan] = statements(P.detectScan);
    expect(scan.sql).toMatch(
      /i\.status = 'uncollectible' and coalesce\(a\.resolved_at, a\.updated_at\) >= coalesce\(\$\d+::timestamptz, 'infinity'::timestamptz\)/,
    );
    expect(scan.params).toContain(FROM);
  });

  it("with no line at all, every uncollectible capture is history (infinity)", async () => {
    settings(true, null);
    await pass();
    const [file] = statements(P.repairKept);
    const [scan] = statements(P.detectScan);
    expect(file.params).toContain(null);
    expect(scan.params).toContain(null);
    expect(scan.params).not.toContain(FROM);
  });

  it("★★ every repair item carries a repair_key and is inserted on-conflict-do-nothing", async () => {
    on(P.detectScan, [
      {
        id: ATTEMPT,
        invoice_id: INVOICE,
        amount_paise: "11800",
        provider_payment_id: "pay_1",
        invoice_ref: "R1",
      },
    ]);
    on(P.detectRecheck, [
      { amount_paise: "11800", provider_payment_id: "pay_1" },
    ]);
    on(P.detectInsert, pgError("P0001"));
    await pass();
    const inserts = statements(
      /^insert into public\.billing_reconciliation_items/,
    );
    expect(inserts.length).toBe(3);
    for (const s of inserts) {
      expect(s.sql).toContain("'repair_key'");
      expect(s.sql).toMatch(/on conflict do nothing/);
    }
  });

  it("skips a payment that already has an open state_conflict item", async () => {
    await pass();
    for (const p of [P.repairPaid, P.repairKept]) {
      const [s] = statements(p);
      expect(s.sql).toContain(
        "y.kind = 'state_conflict' and y.status = 'open' and y.provider_payment_id = a.provider_payment_id",
      );
    }
  });

  it("a failed repair statement is an error, and the pass goes on", async () => {
    on(P.repairClose, new Error("connection reset"));
    on(P.repairPaid, [{ id: "x", invoice_id: INVOICE }]);
    const summary = await pass();
    expect(summary.errors).toBe(1);
    expect(summary.flaggedForPerson).toBe(1);
  });

  it("reports `more` when a repair statement filled its limit", async () => {
    on(P.repairClose, [{ id: "a" }, { id: "b" }]);
    const summary = await pass({ limit: 2 });
    expect(summary.more).toBe(true);
  });
});

describe("step 2: detect", () => {
  const candidate = {
    attemptId: ATTEMPT,
    invoiceId: INVOICE,
    amountPaise: 11800,
    providerPaymentId: "pay_1",
    invoiceRef: "R1",
  };

  it("★ selects captures on a void invoice whatever their date, and live uncollectible ones", async () => {
    await pass();
    const [scan] = statements(P.detectScan);
    expect(scan.sql).toContain("a.state = 'captured'");
    expect(scan.sql).toContain("i.kind = 'subscription'");
    expect(scan.sql).toContain(
      "(i.status = 'void' or (i.status = 'uncollectible'",
    );
    // One automatic refund per payment, ever; a payment someone is refunding
    // is theirs.
    expect(scan.sql).toContain(
      "(r.requested_by = 'system' or r.status not in ('failed', 'cancelled'))",
    );
    // A refused payment is not re-tried every hour.
    expect(scan.sql).toContain("'refund_refused:' || a.id::text");
  });

  it("★★ locks the payment, re-checks in a NEW statement, then inserts, in one transaction", async () => {
    on(P.detectRecheck, [
      { amount_paise: "11800", provider_payment_id: "pay_1" },
    ]);
    on(P.detectInsert, [{ id: REFUND }]);
    const out = await detectOwedRefund(candidate, {
      now: NOW,
      automaticRefundsFrom: FROM,
    });
    expect(out).toBe("owed");
    const [lock, recheck, insert] = st.log;
    expect(lock.sql).toMatch(P.detectLock);
    expect(lock.params).toEqual([ATTEMPT]);
    expect(recheck.sql).toMatch(P.detectRecheck);
    expect(recheck.sql).toContain("a.id = $1");
    expect(recheck.sql).toContain("r.requested_by = 'system'");
    expect(insert.sql).toMatch(P.detectInsert);
    expect(new Set([lock.tx, recheck.tx, insert.tx]).size).toBe(1);
    expect(insert.sql).toContain("'cycle_not_reached', 'owed', 'razorpay'");
    // amount, key, payment id, timestamps
    expect(insert.params).toContain(11800);
    expect(insert.params).toContain("pay_1");
    const key = insert.params.find(
      (p) => typeof p === "string" && /^[0-9a-f-]{36}$/.test(p),
    );
    expect(key).toMatch(/^[A-Za-z0-9_-]{10,}$/);
    expect(logInfo).toHaveBeenCalledWith(
      "billing.refund_owed",
      expect.objectContaining({ refundId: REFUND, attemptId: ATTEMPT }),
    );
  });

  it("★ a payment another run already owed is skipped, not an error", async () => {
    // The re-check (after the lock) finds the other run's refund.
    const out = await detectOwedRefund(candidate, {
      now: NOW,
      automaticRefundsFrom: FROM,
    });
    expect(out).toBe("skipped");
    expect(statements(P.detectInsert)).toEqual([]);
  });

  it("★★ a cap refusal when a system refund exists is a no-op, not an error", async () => {
    on(P.detectRecheck, [
      { amount_paise: "11800", provider_payment_id: "pay_1" },
    ]);
    on(P.detectInsert, pgError("P0001", "refund exceeds the payment"));
    on(P.refusedRead, [{ "?column?": 1 }]);
    const out = await detectOwedRefund(candidate, {
      now: NOW,
      automaticRefundsFrom: FROM,
    });
    expect(out).toBe("noop");
    expect(statements(P.refusedFile)).toEqual([]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("★ any other refusal is filed for a person (refund_refused)", async () => {
    on(P.detectRecheck, [{ amount_paise: "11800", provider_payment_id: null }]);
    on(
      P.detectInsert,
      pgError("23514", "violates check gateway_needs_payment"),
    );
    const out = await detectOwedRefund(candidate, {
      now: NOW,
      automaticRefundsFrom: FROM,
    });
    expect(out).toBe("filed");
    const [file] = statements(P.refusedFile);
    expect(file.sql).toContain("'repair_key', 'refund_refused:' || a.id");
    expect(file.sql).toContain("on conflict do nothing");
    expect(file.params).toContain("violates check gateway_needs_payment");
    expect(logError).toHaveBeenCalledWith(
      "billing.refund_detect_refused",
      expect.any(Error),
      expect.objectContaining({ attemptId: ATTEMPT }),
    );
  });

  it("a database error (not a refusal) is an error", async () => {
    on(P.detectLock, pgError("57P01", "terminating connection"));
    const out = await detectOwedRefund(candidate, {
      now: NOW,
      automaticRefundsFrom: FROM,
    });
    expect(out).toBe("error");
  });

  it("the pass counts what it detected, filed and failed", async () => {
    on(P.detectScan, [
      {
        id: "a1",
        invoice_id: INVOICE,
        amount_paise: "100",
        provider_payment_id: "p1",
      },
      {
        id: "a2",
        invoice_id: INVOICE,
        amount_paise: "100",
        provider_payment_id: "p2",
      },
      {
        id: "a3",
        invoice_id: INVOICE,
        amount_paise: "100",
        provider_payment_id: "p3",
      },
    ]);
    on(P.detectRecheck, [{ amount_paise: "100", provider_payment_id: "p" }]);
    on(P.detectInsert, [{ id: REFUND }], { once: true });
    on(P.detectInsert, pgError("23514"), { once: true });
    on(P.detectInsert, pgError("08006"), { once: true });
    const summary = await pass();
    expect(summary.detected).toBe(1);
    expect(summary.flaggedForPerson).toBe(1);
    expect(summary.errors).toBe(1);
  });
});

describe("step 3: send", () => {
  it("★★ claims the row BEFORE calling Razorpay, and calls it once with the row's key", async () => {
    on(P.claim, [claimedRow()]);
    on(P.toProcessed, [{ id: REFUND }]);
    const out = await sendOwedRefund(REFUND, {
      refund: gateway.refund,
      now: NOW,
    });
    expect(out).toEqual({ status: "processed", providerRefundId: "rfnd_1" });
    const claimAt = st.events.findIndex((e) =>
      e.includes("set status = 'pending'"),
    );
    const commitAt = st.events.indexOf("commit:1");
    const gatewayAt = st.events.indexOf("gateway");
    expect(claimAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(claimAt);
    expect(gatewayAt).toBeGreaterThan(commitAt);
    expect(gateway.refund).toHaveBeenCalledTimes(1);
    expect(gateway.refund).toHaveBeenCalledWith({
      paymentId: "pay_1",
      amountPaise: 11800,
      idempotencyKey: KEY,
      notes: {
        sm_refund_key: KEY,
        sm_invoice: "SM/2026-27/00004",
        sm_reason: "cycle_not_reached",
      },
    });
    const [claim] = statements(P.claim);
    expect(claim.sql).toContain("r.status = 'owed'");
    expect(claim.sql).toContain("sent_at = $");
  });

  it("★ a row someone else claimed is not sent", async () => {
    const out = await sendOwedRefund(REFUND, {
      refund: gateway.refund,
      now: NOW,
    });
    expect(out).toEqual({ status: "not_claimed" });
    expect(gateway.refund).not.toHaveBeenCalled();
  });

  it("processed: settled processed with the refund id", async () => {
    on(P.claim, [claimedRow()]);
    on(P.toProcessed, [{ id: REFUND }]);
    await sendOwedRefund(REFUND, { refund: gateway.refund, now: NOW });
    const [done] = statements(P.toProcessed);
    expect(done.sql).toContain(
      "provider_refund_id = coalesce(provider_refund_id, $",
    );
    expect(done.sql).toContain("status = 'pending'");
    expect(done.params).toContain("rfnd_1");
  });

  it("pending at Razorpay: stays pending and keeps the refund id", async () => {
    on(P.claim, [claimedRow()]);
    gateway.refund.mockResolvedValue({
      ok: true,
      data: rzRefund({ status: "pending", id: "rfnd_9" }),
    });
    const out = await sendOwedRefund(REFUND, {
      refund: gateway.refund,
      now: NOW,
    });
    expect(out).toEqual({ status: "pending" });
    const [keep] = statements(P.keepRefundId);
    expect(keep.params[0]).toBe("rfnd_9");
    expect(keep.sql).toContain("provider_refund_id is null");
    expect(statements(P.toFailed)).toEqual([]);
  });

  it("★ rejected: failed, with Razorpay's reason, and the alert line", async () => {
    on(P.claim, [claimedRow()]);
    on(P.toFailed, [
      {
        id: REFUND,
        invoice_id: INVOICE,
        attempt_id: ATTEMPT,
        amount_paise: "11800",
        requested_by: "system",
      },
    ]);
    gateway.refund.mockResolvedValue({
      ok: false,
      error: "The payment has been fully refunded already",
      outcome: "rejected",
    });
    const out = await sendOwedRefund(REFUND, {
      refund: gateway.refund,
      now: NOW,
    });
    expect(out).toEqual({
      status: "failed",
      failureReason: "The payment has been fully refunded already",
    });
    const [failed] = statements(P.toFailed);
    expect(failed.params).toContain(
      "The payment has been fully refunded already",
    );
    expect(logError).toHaveBeenCalledWith(
      "billing.refund_failed",
      expect.any(Error),
      expect.objectContaining({ refundId: REFUND, automatic: true }),
    );
  });

  it("★★ UNKNOWN is never a failure: the row stays pending", async () => {
    on(P.claim, [claimedRow()]);
    gateway.refund.mockResolvedValue({
      ok: false,
      error: "Razorpay 503",
      outcome: "unknown",
    });
    const out = await sendOwedRefund(REFUND, {
      refund: gateway.refund,
      now: NOW,
    });
    expect(out).toEqual({ status: "pending" });
    expect(statements(P.toFailed)).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(
      "billing.refund_send_unknown",
      expect.objectContaining({ refundId: REFUND }),
    );
  });

  it("★ a THROW from the gateway is unknown too", async () => {
    on(P.claim, [claimedRow()]);
    gateway.refund.mockRejectedValue(new Error("socket hang up"));
    const out = await sendOwedRefund(REFUND, {
      refund: gateway.refund,
      now: NOW,
    });
    expect(out).toEqual({ status: "pending" });
    expect(statements(P.toFailed)).toEqual([]);
  });

  it("failed at Razorpay straight away: failed", async () => {
    on(P.claim, [claimedRow()]);
    on(P.toFailed, [{ id: REFUND, requested_by: "system" }]);
    gateway.refund.mockResolvedValue({
      ok: true,
      data: rzRefund({ status: "failed" }),
    });
    const out = await sendOwedRefund(REFUND, {
      refund: gateway.refund,
      now: NOW,
    });
    expect(out.status).toBe("failed");
  });

  it("★★ with automatic sending OFF, only operator rows are selected", async () => {
    settings(false);
    await pass();
    const [scan] = statements(P.sendScan);
    expect(scan.sql).toContain("and r.requested_by <> 'system'");
  });

  it("with automatic sending ON, system rows are selected too", async () => {
    await pass();
    const [scan] = statements(P.sendScan);
    expect(scan.sql).not.toContain("requested_by <>");
  });

  it("★★ with automatic sending OFF, a system row that reaches the loop is still not sent", async () => {
    settings(false);
    on(P.sendScan, [
      { id: REFUND, requested_by: "system" },
      { id: REFUND_2, requested_by: "ops@storemink.com" },
    ]);
    on(P.claim, [claimedRow({ id: REFUND_2 })]);
    on(P.toProcessed, [{ id: REFUND_2 }]);
    const summary = await pass();
    expect(gateway.refund).toHaveBeenCalledTimes(1);
    const [claim] = statements(P.claim);
    expect(claim.params).toContain(REFUND_2);
    expect(claim.params).not.toContain(REFUND);
    expect(summary.sent).toBe(1);
  });

  it("no platform credentials: nothing is selected and nothing sent", async () => {
    await pass({ refund: null });
    expect(statements(P.sendScan)).toEqual([]);
  });

  it("the pass counts sent, processed, failed and still pending", async () => {
    on(P.sendScan, [
      { id: "r1", requested_by: "system" },
      { id: "r2", requested_by: "system" },
      { id: "r3", requested_by: "system" },
    ]);
    on(P.claim, (q) => [claimedRow({ id: q.params.at(-1) })]);
    on(P.toProcessed, [{ id: "r1" }]);
    on(P.toFailed, [{ id: "r2", requested_by: "system" }]);
    gateway.refund
      .mockResolvedValueOnce({ ok: true, data: rzRefund() })
      .mockResolvedValueOnce({ ok: false, error: "no", outcome: "rejected" })
      .mockResolvedValueOnce({ ok: false, error: "?", outcome: "unknown" });
    const summary = await pass();
    expect(summary).toMatchObject({
      sent: 3,
      processed: 1,
      failed: 1,
      stillPending: 1,
    });
  });
});

describe("step 4: reconcile", () => {
  function pending(over: Record<string, unknown> = {}) {
    return {
      id: REFUND,
      idempotency_key: KEY,
      provider_payment_id: "pay_1",
      overdue: false,
      ...over,
    };
  }

  it("asks only about rows sent over 2 minutes ago, and flags those over 30", async () => {
    await pass();
    const [scan] = statements(P.reconcileScan);
    expect(scan.sql).toContain("r.status = 'pending'");
    expect(scan.params).toContain(
      new Date(NOW.getTime() - 2 * 60_000).toISOString(),
    );
    expect(scan.params).toContain(
      new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    );
  });

  it("★★ found BY KEY: settled processed, never another refund of the same amount", async () => {
    on(P.reconcileScan, [pending()]);
    on(P.toProcessed, [{ id: REFUND }]);
    gateway.fetch.mockResolvedValue({
      ok: true,
      data: [
        rzRefund({
          id: "rfnd_other",
          notes: { sm_refund_key: "other-key-123" },
        }),
        rzRefund({ id: "rfnd_ours" }),
      ],
    });
    const summary = await pass();
    expect(summary.processed).toBe(1);
    const [done] = statements(P.toProcessed);
    expect(done.params).toContain("rfnd_ours");
    expect(done.params).not.toContain("rfnd_other");
    expect(gateway.fetch).toHaveBeenCalledWith("pay_1", {
      count: 100,
      skip: 0,
    });
  });

  it("absent under 30 minutes: left pending", async () => {
    on(P.reconcileScan, [pending({ overdue: false })]);
    const summary = await pass();
    expect(summary.stillPending).toBe(1);
    expect(statements(P.toFailed)).toEqual([]);
  });

  it("★ absent after 30 minutes: failed, 'no record'", async () => {
    on(P.reconcileScan, [pending({ overdue: true })]);
    on(P.toFailed, [{ id: REFUND, requested_by: "system" }]);
    const summary = await pass();
    expect(summary.failed).toBe(1);
    const [failed] = statements(P.toFailed);
    expect(failed.params).toContain("Razorpay has no record of this refund.");
  });

  it("★ a list it could not read is not a verdict", async () => {
    on(P.reconcileScan, [pending({ overdue: true })]);
    gateway.fetch.mockResolvedValue({
      ok: false,
      error: "500",
      outcome: "unknown",
    });
    const summary = await pass();
    expect(summary.stillPending).toBe(1);
    expect(statements(P.toFailed)).toEqual([]);
  });

  it("★ pages a full list, and an unread tail is not 'absent'", async () => {
    on(P.reconcileScan, [pending({ overdue: true })]);
    const full = Array.from({ length: 100 }, (_, i) =>
      rzRefund({ id: `r${i}`, notes: { sm_refund_key: `other-${i}-key` } }),
    );
    gateway.fetch.mockResolvedValue({ ok: true, data: full });
    const summary = await pass();
    expect(gateway.fetch).toHaveBeenCalledTimes(10);
    expect(gateway.fetch).toHaveBeenLastCalledWith("pay_1", {
      count: 100,
      skip: 900,
    });
    expect(summary.stillPending).toBe(1);
    expect(statements(P.toFailed)).toEqual([]);
  });

  it("found on the second page", async () => {
    on(P.reconcileScan, [pending()]);
    on(P.toProcessed, [{ id: REFUND }]);
    const full = Array.from({ length: 100 }, (_, i) =>
      rzRefund({ id: `r${i}`, notes: { sm_refund_key: `other-${i}-key` } }),
    );
    gateway.fetch
      .mockResolvedValueOnce({ ok: true, data: full })
      .mockResolvedValueOnce({ ok: true, data: [rzRefund()] });
    const summary = await pass();
    expect(summary.processed).toBe(1);
  });

  it("found failed at Razorpay: failed", async () => {
    on(P.reconcileScan, [pending()]);
    on(P.toFailed, [{ id: REFUND, requested_by: "system" }]);
    gateway.fetch.mockResolvedValue({
      ok: true,
      data: [rzRefund({ status: "failed" })],
    });
    const summary = await pass();
    expect(summary.failed).toBe(1);
  });

  it("no list reader (no credentials): the step is skipped", async () => {
    await pass({ fetchRefunds: null });
    expect(statements(P.reconcileScan)).toEqual([]);
  });
});

describe("step 5: credit notes", () => {
  it("★ one note per finished refund, not for a duplicate payment, not past a fully credited invoice", async () => {
    on(P.noteScan, [{ id: REFUND }, { id: REFUND_2 }]);
    vi.mocked(issueCreditNote)
      .mockResolvedValueOnce({ outcome: "issued", note: {} as any })
      .mockResolvedValueOnce({ outcome: "exists", note: {} as any });
    const summary = await pass();
    expect(summary.creditNotes).toBe(1);
    expect(issueCreditNote).toHaveBeenCalledWith({
      kind: "refund",
      refundId: REFUND,
      issuedBy: "system",
    });
    const [scan] = statements(P.noteScan);
    expect(scan.sql).toContain("r.status in ('processed', 'recorded')");
    expect(scan.sql).toContain("r.reason <> 'duplicate_payment'");
    expect(scan.sql).toContain("n.refund_id = r.id");
    expect(scan.sql).toContain("i.total_paise > coalesce((");
  });

  it("★ D3: a closed, unpaid invoice that charged GST is cancelled by a note", async () => {
    on(P.cancelNoteScan, [{ id: INVOICE }]);
    vi.mocked(issueCreditNote).mockResolvedValue({
      outcome: "issued",
      note: {} as any,
    });
    const summary = await pass();
    expect(summary.creditNotes).toBe(1);
    expect(issueCreditNote).toHaveBeenCalledWith({
      kind: "invoice_cancelled",
      invoiceId: INVOICE,
      issuedBy: "system",
    });
    const [scan] = statements(P.cancelNoteScan);
    expect(scan.sql).toContain("i.status in ('void', 'uncollectible')");
    expect(scan.sql).toContain("i.tax_paise > 0");
    expect(scan.sql).toContain(
      "a.state in ('created', 'processing', 'authorized', 'unknown', 'captured', 'refunded')",
    );
  });

  it("not_ready (a payment in flight) is a retry next run, not an error", async () => {
    on(P.cancelNoteScan, [{ id: INVOICE }]);
    vi.mocked(issueCreditNote).mockResolvedValue({
      outcome: "not_ready",
      why: "payment_in_flight",
    });
    const summary = await pass();
    expect(summary.errors).toBe(0);
    expect(summary.creditNotes).toBe(0);
  });

  it("a note that throws is an error, and the next one is still tried", async () => {
    on(P.noteScan, [{ id: REFUND }, { id: REFUND_2 }]);
    vi.mocked(issueCreditNote)
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce({ outcome: "issued", note: {} as any });
    const summary = await pass();
    expect(summary.errors).toBe(1);
    expect(summary.creditNotes).toBe(1);
  });
});

describe("step 7: tell the merchant", () => {
  const NOTE = { ref: "CN/2026-27/00001" } as any;

  it("★★ claims notified_at FIRST, reads the note in the same transaction, emails after commit", async () => {
    on(P.notifyClaim, [{ id: REFUND, status: "processed" }]);
    vi.mocked(creditNoteParticulars).mockImplementation(async (_ref, db) => {
      st.events.push(`particulars:${db ? "tx" : "own"}`);
      return NOTE;
    });
    const sent = await tellMerchantRefund(REFUND, NOW);
    expect(sent).toBe(true);
    const claimAt = st.events.findIndex((e) => e.includes("set notified_at"));
    const readAt = st.events.indexOf("particulars:tx");
    const commitAt = st.events.indexOf("commit:1");
    const mailAt = st.events.indexOf("notify:sent");
    expect(claimAt).toBeLessThan(readAt);
    expect(readAt).toBeLessThan(commitAt);
    expect(commitAt).toBeLessThan(mailAt);
    expect(notifyRefundSent).toHaveBeenCalledWith(REFUND, { creditNote: NOTE });
    const [claim] = statements(P.notifyClaim);
    expect(claim.sql).toContain("notified_at is null");
    expect(claim.sql).toContain("status in ('processed', 'recorded')");
  });

  it("★★ a refund someone already told about gets no second email", async () => {
    const sent = await tellMerchantRefund(REFUND, NOW);
    expect(sent).toBe(false);
    expect(notifyRefundSent).not.toHaveBeenCalled();
    expect(notifyRefundRecorded).not.toHaveBeenCalled();
    expect(creditNoteParticulars).not.toHaveBeenCalled();
  });

  it("a recorded refund gets the 'recorded' email", async () => {
    on(P.notifyClaim, [{ id: REFUND, status: "recorded" }]);
    await tellMerchantRefund(REFUND, NOW);
    expect(notifyRefundRecorded).toHaveBeenCalledWith(REFUND, {
      creditNote: null,
    });
    expect(notifyRefundSent).not.toHaveBeenCalled();
  });

  it("★ a failed note read undoes the claim (throws, nothing mailed)", async () => {
    on(P.notifyClaim, [{ id: REFUND, status: "processed" }]);
    vi.mocked(creditNoteParticulars).mockRejectedValue(new Error("db"));
    await expect(tellMerchantRefund(REFUND, NOW)).rejects.toThrow("db");
    expect(notifyRefundSent).not.toHaveBeenCalled();
    expect(st.events).not.toContain("commit:1");
  });

  it("selects only refunds whose note exists, needs none, or is over an hour late", async () => {
    await pass();
    const [scan] = statements(P.notifyScan);
    expect(scan.sql).toContain("r.notified_at is null");
    expect(scan.sql).toContain("r.reason = 'duplicate_payment'");
    expect(scan.sql).toMatch(/r\.resolved_at < \$\d+/);
    expect(scan.params).toContain(
      new Date(NOW.getTime() - 3_600_000).toISOString(),
    );
  });

  it("the pass counts the emails and logs a notice sent without its note", async () => {
    on(P.notifyScan, [
      { id: REFUND, reason: "cycle_not_reached", has_note: true },
      {
        id: REFUND_2,
        reason: "cycle_not_reached",
        has_note: false,
        fully_credited: false,
      },
    ]);
    on(P.notifyClaim, [{ id: "x", status: "processed" }]);
    const summary = await pass();
    expect(summary.notified).toBe(2);
    expect(logWarn).toHaveBeenCalledWith("billing.refund_notice_without_note", {
      refundId: REFUND_2,
    });
    expect(logWarn).not.toHaveBeenCalledWith(
      "billing.refund_notice_without_note",
      { refundId: REFUND },
    );
  });
});

describe("step 8: the daily waiting check", () => {
  it("09:00 IST is hour 9; 10:30 IST is not", () => {
    expect(istHour(NINE_IST)).toBe(9);
    expect(istHour(NOW)).toBe(11);
    expect(istHour(new Date("2026-10-29T04:29:59Z"))).toBe(9);
    expect(istHour(new Date("2026-10-29T04:30:00Z"))).toBe(10);
  });

  it("★ runs only in the 09:00 IST hour", async () => {
    await pass();
    expect(statements(P.waiting)).toEqual([]);
    await pass({ now: NINE_IST });
    expect(statements(P.waiting)).toHaveLength(1);
  });

  it("★★ logs the alert line only when something waits", async () => {
    on(P.waiting, [
      {
        failed: "0",
        owed: "0",
        pending: "0",
        held: "0",
        total: "0",
        oldest_at: null,
      },
    ]);
    const quiet = await pass({ now: NINE_IST });
    expect(quiet.waiting).toBe(0);
    expect(logWarn).not.toHaveBeenCalledWith(
      "billing.refund_waiting",
      expect.anything(),
    );

    st.handlers = [];
    on(P.waiting, [
      {
        failed: "1",
        owed: "2",
        pending: "0",
        held: "2",
        total: "3",
        oldest_at: "2026-10-27 10:00:00+05:30",
      },
    ]);
    const busy = await pass({ now: NINE_IST });
    expect(busy.waiting).toBe(3);
    expect(busy.errors).toBe(0);
    expect(logWarn).toHaveBeenCalledWith("billing.refund_waiting", {
      owed: 2,
      pending: 0,
      failed: 1,
      oldestAt: "2026-10-27 10:00:00+05:30",
    });
  });

  it("counts a day-old owed or sent row, a failed row nobody followed up, and held rows", async () => {
    await countRefundsNeedingAction({ now: NOW, autoRefunds: false });
    const [q] = statements(P.waiting);
    expect(q.sql).toContain(
      "r.status = 'failed' and not exists ( select 1 from public.billing_refunds l where l.attempt_id = r.attempt_id and l.created_at > r.created_at)",
    );
    expect(q.sql).toMatch(/r\.status = 'owed' and r\.created_at < \$\d+/);
    expect(q.sql).toMatch(/r\.status = 'pending' and r\.sent_at < \$\d+/);
    expect(q.params).toContain(
      new Date(NOW.getTime() - 24 * 3_600_000).toISOString(),
    );
    // Held only while automatic sending is off.
    expect(q.params).toContain(true);
  });
});

describe("the gateway seam", () => {
  it("no platform credentials: no refund and no list reader", () => {
    expect(platformRefundFn()).toBeNull();
    expect(platformFetchRefundsFn()).toBeNull();
  });

  it("binds StoreMink's own account (never a store's)", async () => {
    const creds = { keyId: "rzp_live_x", keySecret: "s" } as any;
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(creds);
    vi.mocked(rzpRefund).mockResolvedValue({ ok: true, data: rzRefund() });
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({ ok: true, data: [] });
    const refund = platformRefundFn()!;
    const input = {
      paymentId: "pay_1",
      amountPaise: 100,
      idempotencyKey: KEY,
      notes: { sm_refund_key: KEY },
    };
    await refund(input);
    expect(rzpRefund).toHaveBeenCalledWith(creds, input);
    await platformFetchRefundsFn()!("pay_1", { count: 100, skip: 0 });
    expect(rzpFetchPaymentRefunds).toHaveBeenCalledWith(creds, "pay_1", {
      count: 100,
      skip: 0,
    });
  });

  it("the pass uses the platform account by default", async () => {
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null);
    await processBillingRefunds({ now: NOW });
    expect(statements(P.sendScan)).toEqual([]);
    expect(statements(P.reconcileScan)).toEqual([]);
  });
});

// ── The console's helpers ──────────────────────────────────────────────────

const LOCK = /^select a\.id, a\.invoice_id, a\.state, a\.amount_paise/;
const USED = /^select coalesce\(sum\(amount_paise\), 0\) as used/;
const OP_INSERT = /^insert into public\.billing_refunds .* 'owed', 'razorpay'/;
const RECORD_INSERT = /^insert into public\.billing_refunds .* 'recorded'/;

function payment(over: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT,
    invoice_id: INVOICE,
    state: "captured",
    amount_paise: "11800",
    provider_payment_id: "pay_1",
    store_id: STORE,
    kind: "subscription",
    status: "void",
    issued: true,
    cycle_seq: "3",
    current_cycle_seq: "2",
    ...over,
  };
}

const OPERATOR = "ops@storemink.com";

function operatorRefund(over: Record<string, unknown> = {}) {
  return createOperatorRefund({
    storeId: STORE,
    invoiceId: INVOICE,
    attemptId: ATTEMPT,
    amountPaise: 11800,
    reason: "cycle_not_reached",
    note: "Plan ended",
    operator: OPERATOR,
    now: NOW,
    refund: gateway.refund,
    ...over,
  } as any);
}

describe("createOperatorRefund", () => {
  it("★ writes an owed row under the payment's lock, then sends it at once", async () => {
    on(LOCK, [payment()]);
    on(USED, [{ used: "0" }]);
    on(OP_INSERT, [{ id: REFUND }]);
    on(P.claim, [claimedRow()]);
    on(P.toProcessed, [{ id: REFUND }]);
    vi.mocked(issueCreditNote).mockResolvedValue({
      outcome: "issued",
      note: { creditNoteRef: "CN/2026-27/00001" } as any,
    });
    on(P.notifyClaim, [{ id: REFUND, status: "processed" }]);
    const out = await operatorRefund();
    expect(out).toEqual({ ok: true, refundId: REFUND, status: "processed" });
    const [lock] = statements(LOCK);
    expect(lock.sql).toContain("for update of a");
    const [insert] = statements(OP_INSERT);
    expect(insert.tx).toBe(lock.tx);
    expect(insert.params).toEqual(
      expect.arrayContaining([OPERATOR, "Plan ended", 11800, "pay_1"]),
    );
    expect(gateway.refund).toHaveBeenCalledTimes(1);
    expect(issueCreditNote).toHaveBeenCalledWith({
      kind: "refund",
      refundId: REFUND,
      issuedBy: OPERATOR,
    });
    expect(notifyRefundSent).toHaveBeenCalled();
  });

  it("refuses without a note, below ₹1, and a reason it does not know", async () => {
    expect(await operatorRefund({ note: "  " })).toEqual({
      ok: false,
      error: NOTE_REQUIRED_MESSAGE,
    });
    expect(await operatorRefund({ amountPaise: 99 })).toEqual({
      ok: false,
      error: BELOW_MINIMUM_MESSAGE,
    });
    expect((await operatorRefund({ reason: "whim" })).ok).toBe(false);
    expect(st.log).toEqual([]);
  });

  it("★ refuses more than is left on the payment, naming what is left", async () => {
    on(LOCK, [payment()]);
    on(USED, [{ used: "11000" }]);
    const out = await operatorRefund();
    expect(out).toEqual({ ok: false, error: overCapMessage(800) });
    expect(overCapMessage(800)).toBe(
      "That's more than is left to refund on this payment (₹8).",
    );
    expect(statements(OP_INSERT)).toEqual([]);
  });

  it("refuses another store's invoice, an unissued one and an uncaptured payment", async () => {
    on(LOCK, [payment({ store_id: "99999999-9999-4999-8999-999999999999" })], {
      once: true,
    });
    expect((await operatorRefund()).ok).toBe(false);
    on(LOCK, [payment({ issued: false })], { once: true });
    expect((await operatorRefund()).ok).toBe(false);
    on(LOCK, [payment({ state: "failed" })], { once: true });
    expect((await operatorRefund()).ok).toBe(false);
    expect(statements(OP_INSERT)).toEqual([]);
  });

  it("★ 'Plan ended before this cycle' fits only a cycle the plan did not reach", async () => {
    on(LOCK, [
      payment({ status: "paid", cycle_seq: "2", current_cycle_seq: "2" }),
    ]);
    on(USED, [{ used: "0" }]);
    const out = await operatorRefund();
    expect(out.ok).toBe(false);
    // Another reason fits the same payment.
    on(OP_INSERT, [{ id: REFUND }]);
    expect(
      (await operatorRefund({ reason: "goodwill", refund: null })).ok,
    ).toBe(true);
  });

  it("with no gateway the refund stays owed for the page", async () => {
    on(LOCK, [payment()]);
    on(USED, [{ used: "0" }]);
    on(OP_INSERT, [{ id: REFUND }]);
    const out = await operatorRefund({ refund: null });
    expect(out).toEqual({ ok: true, refundId: REFUND, status: "owed" });
    expect(statements(P.claim)).toEqual([]);
  });

  it("Razorpay's refusal is shown in its words", async () => {
    on(LOCK, [payment()]);
    on(USED, [{ used: "0" }]);
    on(OP_INSERT, [{ id: REFUND }]);
    on(P.claim, [claimedRow()]);
    on(P.toFailed, [{ id: REFUND, requested_by: OPERATOR }]);
    gateway.refund.mockResolvedValue({
      ok: false,
      error: "Payment is not captured",
      outcome: "rejected",
    });
    const out = await operatorRefund();
    expect(out).toEqual({
      ok: false,
      error: "Razorpay refused the refund: Payment is not captured",
      refundId: REFUND,
    });
  });

  it("the database guard refusing in a race reads as 'moved on'", async () => {
    on(LOCK, [payment()]);
    on(USED, [{ used: "0" }]);
    on(OP_INSERT, pgError("P0001", "refund exceeds the payment"));
    expect(await operatorRefund()).toEqual({
      ok: false,
      error: MOVED_ON_MESSAGE,
    });
  });
});

describe("sendRefundNow / retryRefund / cancelOwedRefund", () => {
  it("send with no gateway says so", async () => {
    const out = await sendRefundNow({
      refundId: REFUND,
      operator: OPERATOR,
      refund: null,
    });
    expect(out.ok).toBe(false);
  });

  it("send of a row already moved on says so", async () => {
    const out = await sendRefundNow({
      refundId: REFUND,
      operator: OPERATOR,
      refund: gateway.refund,
    });
    expect(out).toEqual({
      ok: false,
      error: MOVED_ON_MESSAGE,
      refundId: REFUND,
    });
  });

  it("★ retry writes a NEW owed row (never the failed one) and sends it", async () => {
    on(/^select id, invoice_id, attempt_id, amount_paise, reason, status/, [
      {
        id: REFUND,
        invoice_id: INVOICE,
        attempt_id: ATTEMPT,
        amount_paise: "11800",
        reason: "cycle_not_reached",
        status: "failed",
        provider_payment_id: "pay_1",
      },
    ]);
    on(LOCK, [payment()]);
    on(USED, [{ used: "0" }]);
    on(OP_INSERT, [{ id: REFUND_2 }]);
    on(P.claim, [claimedRow({ id: REFUND_2 })]);
    gateway.refund.mockResolvedValue({
      ok: true,
      data: rzRefund({ status: "pending" }),
    });
    const out = await retryRefund({
      refundId: REFUND,
      note: "Card reissued",
      operator: OPERATOR,
      now: NOW,
      refund: gateway.refund,
    });
    expect(out).toEqual({ ok: true, refundId: REFUND_2, status: "pending" });
    expect(statements(/^update public\.billing_refunds set status/)).toEqual(
      [],
    );
  });

  it("retry of a row that is not failed is refused", async () => {
    on(/^select id, invoice_id, attempt_id, amount_paise, reason, status/, [
      { id: REFUND, status: "owed", attempt_id: ATTEMPT, invoice_id: INVOICE },
    ]);
    const out = await retryRefund({
      refundId: REFUND,
      note: "x",
      operator: OPERATOR,
      refund: gateway.refund,
    });
    expect(out).toEqual({ ok: false, error: MOVED_ON_MESSAGE });
    expect(statements(OP_INSERT)).toEqual([]);
  });

  it("cancel needs a reason and only moves an owed row", async () => {
    expect(
      await cancelOwedRefund({
        refundId: REFUND,
        note: "",
        operator: OPERATOR,
      }),
    ).toEqual({ ok: false, error: NOTE_REQUIRED_MESSAGE });
    expect(
      await cancelOwedRefund({
        refundId: REFUND,
        note: "No",
        operator: OPERATOR,
      }),
    ).toEqual({ ok: false, error: MOVED_ON_MESSAGE });
    on(/set status = 'cancelled'/, [{ id: REFUND }]);
    expect(
      await cancelOwedRefund({
        refundId: REFUND,
        note: "No",
        operator: OPERATOR,
      }),
    ).toEqual({ ok: true, refundId: REFUND, status: "cancelled" });
    const [cancel] = statements(/set status = 'cancelled'/).slice(-1);
    expect(cancel.sql).toContain("status = 'owed'");
    expect(cancel.params).toContain("No");
  });
});

describe("recordRefundMadeOutside", () => {
  const SETTLED =
    /^select id, status, reason, attempt_id, amount_paise from public\.billing_refunds/;

  function record(over: Record<string, unknown> = {}) {
    return recordRefundMadeOutside({
      storeId: STORE,
      invoiceId: INVOICE,
      attemptId: ATTEMPT,
      amountPaise: 11800,
      method: "bank_transfer",
      reference: "UTR123",
      note: "Paid by NEFT",
      operator: OPERATOR,
      now: NOW,
      ...over,
    } as any);
  }

  it("★ a bank transfer is recorded final with its UTR, then noted and emailed", async () => {
    on(LOCK, [payment()]);
    on(USED, [{ used: "0" }]);
    on(RECORD_INSERT, [{ id: REFUND }]);
    on(P.notifyClaim, [{ id: REFUND, status: "recorded" }]);
    const out = await record();
    expect(out).toEqual({ ok: true, refundId: REFUND, status: "recorded" });
    const [insert] = statements(RECORD_INSERT);
    expect(insert.params).toContain("UTR123");
    expect(insert.params).toContain("bank_transfer");
    expect(issueCreditNote).toHaveBeenCalledWith({
      kind: "refund",
      refundId: REFUND,
      issuedBy: OPERATOR,
    });
    expect(notifyRefundRecorded).toHaveBeenCalled();
  });

  it("★★ settling an owed row cancels it in the same transaction, AFTER every check", async () => {
    on(LOCK, [payment()]);
    on(SETTLED, [
      {
        id: REFUND,
        status: "owed",
        reason: "cycle_not_reached",
        attempt_id: ATTEMPT,
        amount_paise: "11800",
      },
    ]);
    // The owed row itself counts as used until it is cancelled.
    on(USED, [{ used: "11800" }]);
    on(/set status = 'cancelled'/, []);
    on(RECORD_INSERT, [{ id: REFUND_2 }]);
    const out = await record({ refundId: REFUND });
    expect(out.ok).toBe(true);
    const [cancel] = statements(/set status = 'cancelled'/);
    const [insert] = statements(RECORD_INSERT);
    expect(cancel.tx).toBe(insert.tx);
    expect(st.log.indexOf(cancel)).toBeLessThan(st.log.indexOf(insert));
  });

  it("★★ a refusal after reading the owed row writes nothing", async () => {
    on(LOCK, [payment({ store_id: "99999999-9999-4999-8999-999999999999" })]);
    on(SETTLED, [
      {
        id: REFUND,
        status: "owed",
        reason: "cycle_not_reached",
        attempt_id: ATTEMPT,
        amount_paise: "11800",
      },
    ]);
    const out = await record({ refundId: REFUND });
    expect(out.ok).toBe(false);
    expect(statements(/^update public\.billing_refunds/)).toEqual([]);
    expect(statements(RECORD_INSERT)).toEqual([]);
  });

  it("a Razorpay refund id already recorded is refused plainly", async () => {
    on(LOCK, [payment()]);
    on(USED, [{ used: "0" }]);
    on(RECORD_INSERT, pgError("23505"));
    const out = await record({ method: "razorpay", reference: "rfnd_dup" });
    expect(out).toEqual({
      ok: false,
      error: "That Razorpay refund is already recorded.",
    });
  });

  it("needs a reference and a note", async () => {
    expect((await record({ reference: " " })).ok).toBe(false);
    expect((await record({ note: "" })).ok).toBe(false);
    expect(st.log).toEqual([]);
  });
});

describe("reads for the console", () => {
  it("refundableForInvoice: amount less live and finished refunds", async () => {
    on(/^select a\.id, a\.provider_payment_id, a\.amount_paise/, [
      {
        id: ATTEMPT,
        provider_payment_id: "pay_1",
        amount_paise: "11800",
        refunded: "5000",
        in_progress: "1800",
      },
    ]);
    const out = await refundableForInvoice(INVOICE);
    expect(out).toEqual({
      payments: [
        {
          attemptId: ATTEMPT,
          providerPaymentId: "pay_1",
          amountPaise: 11800,
          refundedPaise: 5000,
          inProgressPaise: 1800,
          leftPaise: 5000,
        },
      ],
      leftPaise: 5000,
    });
  });

  it("countRefundsNeedingAction maps the counts", async () => {
    on(P.waiting, [
      {
        failed: "1",
        owed: "2",
        pending: "3",
        held: "4",
        total: "6",
        oldest_at: null,
      },
    ]);
    expect(
      await countRefundsNeedingAction({ now: NOW, autoRefunds: true }),
    ).toEqual({
      failed: 1,
      owed: 2,
      pending: 3,
      held: 4,
      total: 6,
      oldestAt: null,
    });
  });

  it("listRefunds: the 'needs a person' tab uses the waiting rule", async () => {
    await listRefunds({ tab: "needs_person", now: NOW, autoRefunds: false });
    const [q] = statements(/^with f as/);
    expect(q.sql).toContain(
      "and (f.failed_alone or f.owed_late or f.pending_late or f.held)",
    );
  });

  it("listRefunds by store scopes to the invoice's store", async () => {
    await listRefunds({ storeId: STORE, autoRefunds: true });
    const [q] = statements(/^with f as/);
    expect(q.sql).toMatch(/and i\.store_id = \$\d+/);
    expect(q.params).toContain(STORE);
  });
});
