/* eslint-disable @typescript-eslint/no-explicit-any */
// The collection path.
//
// ── What matters here ──────────────────────────────────────────────────────
// This is the only place in billing where money actually moves, so the tests
// are about ORDER and about which failures are allowed to look like which
// answers:
//
//   • the attempt row is written BEFORE the gateway is called, or a killed
//     process loses a payment silently;
//   • an UNKNOWN outcome is never reported as a failure and never retried
//     (Rule 1, Rule 6) — that is what stops a merchant being charged twice;
//   • an amount that needs the merchant to authenticate is routed away from
//     automatic collection rather than attempted and failed, because a failed
//     attempt starts a grace clock and "can't be auto-collected" must not.
//
// ⚠ The one-in-flight guarantee itself is a partial UNIQUE index in Postgres,
// proved by scripts/billing-verify.sql. Here we only prove this layer reads a
// conflict as "already collecting" instead of as an error.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";
import { billingInvoices, billingPaymentAttempts } from "@/drizzle/schema";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
const receipts = vi.hoisted(() => ({ notifyInvoicePaid: vi.fn() }));
vi.mock("./receipts", () => receipts);

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

// The order read is the only gateway call these helpers make on their own;
// the payment matcher stays real.
const rzpOrder = vi.hoisted(() => ({ rzpFetchOrder: vi.fn() }));
vi.mock("@/lib/payments/razorpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payments/razorpay")>()),
  rzpFetchOrder: rzpOrder.rzpFetchOrder,
}));

import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  automaticAttemptsOn,
  hasUnknownAttempt,
  beginAttempt,
  capturedAttemptForInvoice,
  capturedDraftPurchases,
  collectInvoice,
  fileClosedAttemptPayment,
  fileRecoveredPurchase,
  mapGatewayStatus,
  readAddonOrderTarget,
  recordGatewayOrder,
  settleAttempt,
  verifyRecoveredCapture,
  withdrawUnsentDebits,
} from "./collect";
import { AFA_EXEMPT_LIMIT_PAISE } from "./cycle";
import type { PaymentState } from "./payment-state";

const INVOICE = "inv-1";
const STORE = "store-1";
const ATTEMPT = "att-1";

const MANDATE = {
  id: "man-1",
  status: "active" as const,
  maxAmountPaise: 27_000_00,
  providerTokenId: "tok_live_1",
  providerCustomerId: "cust_1" as string | null,
  method: undefined as "card" | "upi" | undefined,
};

function seed(opts: { selects?: any[][]; returning?: any[] } = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: opts.selects ?? [],
    returning: opts.returning ?? [{ id: ATTEMPT }],
  });
}

const NOW_1 = new Date("2026-11-22T06:00:00.000Z");
/** When the gateway says the notified order may be debited. */
const DEBIT_AFTER = new Date("2026-11-23T18:30:00.000Z");

/** A gateway whose notify succeeds, recording how each step was called. */
function gatewayOk() {
  return {
    checkMandate: vi.fn(async () => ({ state: "chargeable" as const })),
    notify: vi.fn<(input: any) => Promise<any>>(async () => ({
      ok: true as const,
      data: { providerOrderId: "order_1", debitAfter: DEBIT_AFTER },
    })),
    readNotice: vi.fn(async () => ({ state: "ready" as const })),
    debit: vi.fn(async () => ({
      ok: true as const,
      data: { providerPaymentId: "pay_1", status: "created" },
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("mapGatewayStatus", () => {
  it.each([
    ["captured", "captured"],
    ["authorized", "authorized"],
    ["failed", "failed"],
    ["refunded", "refunded"],
    ["created", "processing"],
    ["pending", "processing"],
  ])("maps %s -> %s", (given, want) => {
    expect(mapGatewayStatus(given)).toBe(want);
  });

  it("★ maps anything UNRECOGNISED to unknown, never to failed", () => {
    // A status we do not understand is missing information. Calling it a
    // failure would start a grace clock and could trigger a second charge.
    for (const s of ["weird", "", "CAPTURED_LATER", "queued"]) {
      expect(mapGatewayStatus(s)).toBe("unknown");
    }
  });
});

describe("beginAttempt", () => {
  it("writes the row with OUR idempotency key before anything else", async () => {
    const begun = await beginAttempt({
      invoiceId: INVOICE,
      storeId: STORE,
      amountPaise: 17_700_00,
      mode: "automatic",
    });
    expect(begun?.attemptId).toBe(ATTEMPT);
    const values = dbHolder.current.calls.values[0];
    expect(values).toMatchObject({
      invoiceId: INVOICE,
      state: "created",
      amountPaise: 17_700_00,
      mode: "automatic",
    });
    expect(values.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(begun?.idempotencyKey).toBe(values.idempotencyKey);
  });

  it("★★ persists the exact mandate ceiling before authorization checkout", async () => {
    await beginAttempt({
      invoiceId: INVOICE,
      storeId: STORE,
      amountPaise: 5_000_00,
      mode: "manual",
      mandateMaxPaise: 12_000_00,
    });
    expect(dbHolder.current.calls.values[0].mandateMaxPaise).toBe(12_000_00);
  });

  it("★ reads a conflict as 'already collecting', not as an error", async () => {
    seed({ returning: [] });
    expect(
      await beginAttempt({
        invoiceId: INVOICE,
        storeId: STORE,
        amountPaise: 100,
        mode: "manual",
      }),
    ).toBeNull();
  });

  it("mints a DIFFERENT key per attempt", async () => {
    const a = await beginAttempt({
      invoiceId: INVOICE,
      storeId: STORE,
      amountPaise: 100,
      mode: "manual",
    });
    seed();
    const b = await beginAttempt({
      invoiceId: INVOICE,
      storeId: STORE,
      amountPaise: 100,
      mode: "manual",
    });
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);
  });
});

describe("settleAttempt", () => {
  it("advances an in-flight attempt and claims on the PRIOR state", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }],
        [{ state: "captured" }], // syncInvoiceStatus reads attempts
      ],
      returning: [{ state: "captured" }],
    });
    expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");
    expect(dbHolder.current.calls.set[0]).toMatchObject({ state: "captured" });
  });

  describe("★★ the receipt", () => {
    // ONE place an invoice becomes paid, so enrolment, manual payment, a plan
    // change, a location purchase and reconciliation each send exactly one — and
    // none of them has to remember to.

    it("sends when the invoice BECOMES paid", async () => {
      seed({
        selects: [
          [
            {
              id: ATTEMPT,
              state: "processing",
              invoiceId: INVOICE,
              storeId: "store-1",
            },
          ],
          [{ state: "captured" }],
        ],
        returning: [{ state: "captured" }, { id: INVOICE }],
      });
      await settleAttempt(ATTEMPT, "captured");
      expect(receipts.notifyInvoicePaid).toHaveBeenCalledWith(
        "store-1",
        INVOICE,
      );
    });

    it("★★ sends NOTHING when the paid claim found no row — it was already paid", async () => {
      // The invoice UPDATE excludes `paid` when moving TO paid, so a second
      // settle matches nothing. Without that claim every later attempt on the
      // same invoice would re-send the receipt.
      //
      // ⚠ The two UPDATEs have to be told apart: the ATTEMPT claim must succeed
      // (or settleAttempt returns early and this passes for the wrong reason —
      // which it did, until the mutation caught it) while the INVOICE claim must
      // find nothing. The shared `returning` option cannot express that, so the
      // update step is sequenced by hand.
      seed({
        selects: [
          [
            {
              id: ATTEMPT,
              state: "processing",
              invoiceId: INVOICE,
              storeId: "store-1",
            },
          ],
          [{ state: "captured" }],
        ],
      });
      const perCall = [[{ state: "captured" }], []];
      let n = 0;
      dbHolder.current.db.update = vi.fn(() => ({
        set: vi.fn(() => {
          const rows = perCall[n++] ?? [];
          const step: any = {
            where: vi.fn(() => step),
            returning: vi.fn(async () => rows),
            then: (r: any) => r({ rowCount: rows.length }),
          };
          return step;
        }),
      }));

      await settleAttempt(ATTEMPT, "captured");
      expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
    });

    it("★ sends nothing for a FAILED settle", async () => {
      seed({
        selects: [
          [
            {
              id: ATTEMPT,
              state: "processing",
              invoiceId: INVOICE,
              storeId: "store-1",
            },
          ],
          [{ state: "failed" }],
        ],
        returning: [{ state: "failed" }],
      });
      await settleAttempt(ATTEMPT, "failed");
      expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
    });
  });

  it("★ sets resolved_at on a terminal state (the CHECK requires it)", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }],
        [{ state: "failed" }],
      ],
      returning: [{ state: "failed" }],
    });
    await settleAttempt(ATTEMPT, "failed", {
      now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(dbHolder.current.calls.set[0].resolvedAt).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("★ leaves resolved_at NULL for an in-flight state", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "unknown" }],
      ],
      returning: [{ state: "unknown" }],
    });
    await settleAttempt(ATTEMPT, "unknown");
    expect(dbHolder.current.calls.set[0].resolvedAt).toBeNull();
  });

  it("★★ a late `failed` after `captured` writes NOTHING", async () => {
    seed({
      selects: [[{ id: ATTEMPT, state: "captured", invoiceId: INVOICE }]],
    });
    expect(await settleAttempt(ATTEMPT, "failed")).toBe("captured");
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("treats a duplicate in-flight update as a no-op", async () => {
    seed({
      selects: [[{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }]],
    });
    expect(await settleAttempt(ATTEMPT, "processing")).toBe("processing");
    expect(dbHolder.current.calls.set).toHaveLength(0);
    // Only the attempt read: no invoice sync for anything but a capture.
    expect(dbHolder.current.calls.select).toHaveLength(1);
  });

  it("treats a duplicate failure as a no-op", async () => {
    seed({
      selects: [[{ id: ATTEMPT, state: "failed", invoiceId: INVOICE }]],
    });
    expect(await settleAttempt(ATTEMPT, "failed")).toBe("failed");
    expect(dbHolder.current.calls.set).toHaveLength(0);
    expect(dbHolder.current.calls.select).toHaveLength(1);
  });

  it("a duplicate capture writes nothing to the attempt", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: ATTEMPT, state: "captured", invoiceId: INVOICE }],
        [{ state: "captured" }],
      ],
      returningQueue: [[{ id: INVOICE }]],
    });
    expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");
    for (const set of dbHolder.current.calls.set) {
      expect(set).not.toHaveProperty("state");
    }
  });

  it("returns null when a concurrent settle won the claim", async () => {
    seed({
      selects: [[{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }]],
      returning: [], // zero rows: someone else moved it first
    });
    expect(await settleAttempt(ATTEMPT, "captured")).toBeNull();
  });

  it("returns null for an unknown attempt", async () => {
    seed({ selects: [[]] });
    expect(await settleAttempt(ATTEMPT, "captured")).toBeNull();
  });
});

// PR #303 re-review, 22 Nov 2026. The four checkout starts returned the new
// order id to the browser whether or not the attempt had recorded it.
describe("★★ recordGatewayOrder: an order is handed out only once its attempt holds it", () => {
  const input = {
    attemptId: ATTEMPT,
    providerOrderId: "order_1",
    invoiceId: INVOICE,
    storeId: STORE,
    now: NOW_1,
  };

  it("records the order and moves the attempt to processing", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "processing" }],
      ],
      returning: [{ state: "processing" }],
    });
    expect(await recordGatewayOrder(input)).toBe(true);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      state: "processing",
      providerOrderId: "order_1",
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("★★ a write that fails answers FALSE, says so loudly, and tries to close the attempt", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [new Error("pool wait ran out"), new Error("still down")],
    });
    expect(await recordGatewayOrder(input)).toBe(false);
    const events = vi.mocked(logError).mock.calls.map((c) => c[0]);
    expect(events).toContain("billing.checkout_order_unrecorded");
  });

  it("★ a claim another writer won is not a recorded order either, and the attempt is closed", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        // The record: read as `created`, but the claim matched no row.
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        // The close that follows.
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "failed" }],
      ],
      returningQueue: [[], [{ state: "failed" }], []],
    });
    expect(await recordGatewayOrder(input)).toBe(false);
    expect(dbHolder.current.calls.set[1]).toMatchObject({
      state: "failed",
      failureCode: "order_unrecorded",
    });
  });
});

describe("syncInvoiceStatus, through settleAttempt (defect D9)", () => {
  // `syncInvoiceStatus` is private, so it is driven through `settleAttempt`:
  // the attempt read, the attempt claim, the attempt-state read, the invoice
  // claim and, when that claim finds nothing on a move to paid, the re-read.
  //
  // ⚠ The db mock does not evaluate a WHERE, so which statuses the invoice
  // claim admits is pinned by RENDERING it with the real dialect. That is the
  // only assertion that sees a status added to the list, and it is the one the
  // mutations named in the design ("let syncInvoiceStatus claim void", and the
  // D9 regression of admitting `paid` again) turn red.

  const ISSUED_AT = "2026-09-01T00:00:00.000Z";

  function settleScenario(opts: {
    from: PaymentState;
    attemptsAfter: PaymentState[];
    invoiceClaim: unknown[];
    invoiceRow?: { status: string; finalizedAt: string | null };
  }) {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: ATTEMPT, state: opts.from, invoiceId: INVOICE, storeId: STORE }],
        opts.attemptsAfter.map((state) => ({ state })),
        opts.invoiceRow ? [opts.invoiceRow] : [],
      ],
      // The attempt claim wins; the invoice claim returns what the case says.
      returningQueue: [[{ state: "claimed" }], opts.invoiceClaim],
    });
  }

  /** The invoice claim's WHERE, rendered by the real Postgres dialect. */
  function invoiceClaimWhere() {
    const rendered = dbHolder.current.calls.where
      .map((clause: unknown) => new PgDialect().sqlToQuery(clause as never))
      .filter((q: { sql: string }) =>
        q.sql.includes('"billing_invoices"."status" in'),
      );
    expect(rendered).toHaveLength(1);
    return rendered[0] as { sql: string; params: unknown[] };
  }

  function invoiceWrites(): number {
    return dbHolder.current.calls.update.filter(
      (t: unknown) => t === billingInvoices,
    ).length;
  }

  it.each([
    ["failed", "open"],
    ["unknown", "processing"],
    ["captured", "paid"],
  ] as const)(
    "★★ the invoice claim admits only open and processing when a %s attempt derives %s",
    async (incoming, derived) => {
      settleScenario({
        from: "processing",
        attemptsAfter: [incoming],
        invoiceClaim: [{ id: INVOICE }],
      });
      expect(await settleAttempt(ATTEMPT, incoming)).toBe(incoming);
      expect(dbHolder.current.calls.set[1].status).toBe(derived);

      // Never `paid` (a paid invoice is never moved back) and never `void` or
      // `uncollectible` (a closed invoice is never revived), whichever status
      // the attempts derive.
      const where = invoiceClaimWhere();
      expect(where.sql).toContain('"billing_invoices"."id" = $1');
      expect(where.sql).toContain('"billing_invoices"."status" in ($2, $3)');
      expect(where.params).toEqual([INVOICE, "open", "processing"]);
    },
  );

  it("★★ refunded counts as settled: a refund on a paid invoice writes paid, never reopens it", async () => {
    // Before D9 a lone `refunded` attempt derived `open`, and the claim's list
    // still held `paid` for a move to open, so the paid invoice went back to
    // open and could be paid a second time.
    settleScenario({
      from: "captured",
      attemptsAfter: ["refunded"],
      invoiceClaim: [], // a paid invoice is outside the claim, so nothing moves
      invoiceRow: { status: "paid", finalizedAt: ISSUED_AT },
    });

    expect(await settleAttempt(ATTEMPT, "refunded")).toBe("refunded");
    expect(dbHolder.current.calls.set[1].status).toBe("paid");
    for (const set of dbHolder.current.calls.set) {
      expect(set.status).not.toBe("open");
    }
    // Already paid is the benign race: nothing logged, no second receipt.
    expect(logError).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
    expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
  });

  it.each(["void", "uncollectible"])(
    "★ a capture on an ISSUED %s invoice logs info and does not touch the row",
    async (status) => {
      settleScenario({
        from: "processing",
        attemptsAfter: ["captured"],
        invoiceClaim: [],
        invoiceRow: { status, finalizedAt: ISSUED_AT },
      });

      expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");
      expect(logInfo).toHaveBeenCalledWith(
        "billing.payment_on_closed_invoice",
        {
          invoiceId: INVOICE,
          invoiceStatus: status,
        },
      );
      expect(logError).not.toHaveBeenCalled();
      // The conditional claim is the only invoice write, and it matched
      // nothing: no reopen, no second write, no receipt.
      expect(invoiceWrites()).toBe(1);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
      expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a draft", "draft"],
    ["a closed draft (void)", "void"],
    ["a closed draft (uncollectible)", "uncollectible"],
  ])(
    "★★ a capture on an UNISSUED invoice, %s, logs an error",
    async (_label, status) => {
      // The refund guard refuses an unissued invoice, so only a person can
      // return this money: it must reach Error Reporting.
      settleScenario({
        from: "processing",
        attemptsAfter: ["captured"],
        invoiceClaim: [],
        invoiceRow: { status, finalizedAt: null },
      });

      expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");
      expect(logError).toHaveBeenCalledWith(
        "billing.invoice_paid_claim_missed",
        expect.any(Error),
        { invoiceId: INVOICE, invoiceStatus: status, issued: false },
      );
      expect(logInfo).not.toHaveBeenCalled();
      expect(invoiceWrites()).toBe(1);
      expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
    },
  );

  it("an issued invoice in any other unclaimable status still logs an error", async () => {
    settleScenario({
      from: "processing",
      attemptsAfter: ["captured"],
      invoiceClaim: [],
      invoiceRow: { status: "refunded", finalizedAt: ISSUED_AT },
    });

    await settleAttempt(ATTEMPT, "captured");
    expect(logError).toHaveBeenCalledWith(
      "billing.invoice_paid_claim_missed",
      expect.any(Error),
      { invoiceId: INVOICE, invoiceStatus: "refunded", issued: true },
    );
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("re-reads the invoice's status AND finalized_at on a missed paid claim", async () => {
    settleScenario({
      from: "processing",
      attemptsAfter: ["captured"],
      invoiceClaim: [],
      invoiceRow: { status: "void", finalizedAt: ISSUED_AT },
    });

    await settleAttempt(ATTEMPT, "captured");
    const reread = dbHolder.current.calls.select.at(-1);
    expect(Object.keys(reread).sort()).toEqual(["finalizedAt", "status"]);
  });

  it("does not re-read when the paid claim landed", async () => {
    settleScenario({
      from: "processing",
      attemptsAfter: ["captured"],
      invoiceClaim: [{ id: INVOICE }],
    });

    await settleAttempt(ATTEMPT, "captured");
    // attempt read + attempt-state read, and no third select.
    expect(dbHolder.current.calls.select).toHaveLength(2);
    expect(logError).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });
});

describe("a capture seen again re-syncs its invoice (finding F1)", () => {
  // Reconciliation can capture an enrolment, plan-change or location attempt
  // while its invoice is still a draft, so the paid claim matches nothing. The
  // confirm path then finalizes the draft to `open` and settles the same
  // attempt `captured` again. That second settle must bring the invoice in
  // line, or it stays `open` behind captured money and Plans & Billing offers
  // it for payment a second time.
  //
  // The order of statements on this path: the attempt read, the attempt-state
  // read, the invoice claim, and (only when that claim finds nothing) the
  // re-read. There is NO attempt claim: the attempt does not move.

  const ISSUED_AT = "2026-09-01T00:00:00.000Z";

  function duplicateCapture(opts: {
    storeId?: string | null;
    invoiceClaim: unknown[];
    invoiceRow?: { status: string; finalizedAt: string | null };
  }) {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: ATTEMPT,
            state: "captured",
            invoiceId: INVOICE,
            storeId: opts.storeId === undefined ? STORE : opts.storeId,
          },
        ],
        [{ state: "captured" }],
        opts.invoiceRow ? [opts.invoiceRow] : [],
      ],
      returningQueue: [opts.invoiceClaim],
    });
  }

  function writesTo(table: unknown): number {
    return dbHolder.current.calls.update.filter((t: unknown) => t === table)
      .length;
  }

  it("★★ an invoice finalized after the capture becomes paid, and the receipt goes out once", async () => {
    duplicateCapture({ invoiceClaim: [{ id: INVOICE }] });

    expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");

    // The invoice moved to paid; the attempt did not move at all.
    expect(writesTo(billingInvoices)).toBe(1);
    expect(writesTo(billingPaymentAttempts)).toBe(0);
    expect(dbHolder.current.calls.set[0]).toMatchObject({ status: "paid" });
    expect(dbHolder.current.calls.set[0].paidAt).toEqual(expect.any(String));
    expect(receipts.notifyInvoicePaid).toHaveBeenCalledTimes(1);
    expect(receipts.notifyInvoicePaid).toHaveBeenCalledWith(STORE, INVOICE);
    expect(logError).not.toHaveBeenCalled();
  });

  it("★★ R1-04: `notify: false` makes the invoice paid with NO receipt (the repair pass's issue-alone)", async () => {
    duplicateCapture({ invoiceClaim: [{ id: INVOICE }] });

    expect(await settleAttempt(ATTEMPT, "captured", { notify: false })).toBe(
      "captured",
    );

    // The invoice still becomes paid: only the email is withheld.
    expect(writesTo(billingInvoices)).toBe(1);
    expect(dbHolder.current.calls.set[0]).toMatchObject({ status: "paid" });
    expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
  });

  it("★ `notify: true` (or absent) keeps the receipt: only an explicit false withholds it", async () => {
    duplicateCapture({ invoiceClaim: [{ id: INVOICE }] });
    await settleAttempt(ATTEMPT, "captured", { notify: true });
    expect(receipts.notifyInvoicePaid).toHaveBeenCalledTimes(1);
  });

  it("★★ the re-sync claims only an open or processing invoice (defect D9)", async () => {
    duplicateCapture({ invoiceClaim: [{ id: INVOICE }] });
    await settleAttempt(ATTEMPT, "captured");

    // Rendered with the real dialect: the mock does not evaluate a WHERE, and
    // this is the assertion that sees `void`, `uncollectible`, `draft` or
    // `paid` added to the statuses a re-sync may move.
    const rendered = dbHolder.current.calls.where
      .map((clause: unknown) => new PgDialect().sqlToQuery(clause as never))
      .filter((q: { sql: string }) =>
        q.sql.includes('"billing_invoices"."status" in'),
      );
    expect(rendered).toHaveLength(1);
    expect(rendered[0].sql).toContain('"billing_invoices"."id" = $1');
    expect(rendered[0].sql).toContain(
      '"billing_invoices"."status" in ($2, $3)',
    );
    expect(rendered[0].params).toEqual([INVOICE, "open", "processing"]);
  });

  it("★ an invoice already paid (a double-submitted confirm) is left alone, with no second receipt", async () => {
    duplicateCapture({
      invoiceClaim: [],
      invoiceRow: { status: "paid", finalizedAt: ISSUED_AT },
    });

    expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");
    expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it.each(["void", "uncollectible"])(
    "★★ an ISSUED %s invoice is never revived: it logs info and the claim is the only write",
    async (status) => {
      duplicateCapture({
        invoiceClaim: [],
        invoiceRow: { status, finalizedAt: ISSUED_AT },
      });

      expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");
      expect(logInfo).toHaveBeenCalledWith(
        "billing.payment_on_closed_invoice",
        {
          invoiceId: INVOICE,
          invoiceStatus: status,
        },
      );
      expect(logError).not.toHaveBeenCalled();
      expect(writesTo(billingInvoices)).toBe(1);
      expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
    },
  );

  it("★★ a draft is never made paid: no number is spent, and the missed claim is an error", async () => {
    duplicateCapture({
      invoiceClaim: [],
      invoiceRow: { status: "draft", finalizedAt: null },
    });

    expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");
    expect(logError).toHaveBeenCalledWith(
      "billing.invoice_paid_claim_missed",
      expect.any(Error),
      { invoiceId: INVOICE, invoiceStatus: "draft", issued: false },
    );
    // The conditional claim is the only invoice write, and nothing here
    // finalizes: `finalizedAt` is never set on this path.
    expect(writesTo(billingInvoices)).toBe(1);
    for (const set of dbHolder.current.calls.set) {
      expect(set).not.toHaveProperty("finalizedAt");
    }
    expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
  });

  it("a deleted store's invoice can become paid, but there is nobody to send a receipt to", async () => {
    duplicateCapture({ storeId: null, invoiceClaim: [{ id: INVOICE }] });

    expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");
    expect(dbHolder.current.calls.set[0]).toMatchObject({ status: "paid" });
    expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
  });

  it("★ only a capture seen again re-syncs: a late capture on a refunded attempt is ignored, unsynced", async () => {
    seed({
      selects: [[{ id: ATTEMPT, state: "refunded", invoiceId: INVOICE }]],
    });
    expect(await settleAttempt(ATTEMPT, "captured")).toBe("refunded");
    expect(dbHolder.current.calls.select).toHaveLength(1);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });
});

// 21 Nov 2026: `collectInvoice` is STEP 1 of an automatic renewal. It opens
// the attempt and creates the order with its pre-debit notice. It moves no
// money: the debit is sent a day or more later by lib/billing/debit-pass.ts.
describe("collectInvoice — eligibility is checked BEFORE anything is written", () => {
  const base = {
    invoiceId: INVOICE,
    storeId: STORE,
    description: "Pro monthly renewal",
  };

  it("★ refuses over the AFA limit and NEVER calls the gateway", async () => {
    const charge = gatewayOk();
    const res = await collectInvoice({
      ...base,
      amountDuePaise: AFA_EXEMPT_LIMIT_PAISE + 1,
      mandate: { ...MANDATE, maxAmountPaise: 2_00_000_00 },
      charge,
    });
    expect(res).toEqual({
      status: "not_collectable",
      reason: "over_afa_limit",
    });
    expect(charge.notify).not.toHaveBeenCalled();
    // And nothing was written — no orphan attempt row.
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses with no mandate, without notifying", async () => {
    const charge = gatewayOk();
    const res = await collectInvoice({
      ...base,
      amountDuePaise: 5_000_00,
      mandate: null,
      charge,
    });
    expect(res).toEqual({ status: "not_collectable", reason: "no_mandate" });
    expect(charge.notify).not.toHaveBeenCalled();
  });

  it("refuses on a revoked mandate", async () => {
    const charge = gatewayOk();
    const res = await collectInvoice({
      ...base,
      amountDuePaise: 5_000_00,
      mandate: { ...MANDATE, status: "revoked" },
      charge,
    });
    expect(res.status).toBe("not_collectable");
    expect(charge.notify).not.toHaveBeenCalled();
  });

  it("★★ refuses a mandate with no customer: its debit could never be sent, so no notice goes out", async () => {
    const charge = gatewayOk();
    const res = await collectInvoice({
      ...base,
      amountDuePaise: 5_000_00,
      mandate: { ...MANDATE, providerCustomerId: null },
      charge,
    });
    expect(res).toEqual({ status: "not_collectable", reason: "no_mandate" });
    expect(charge.notify).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses when nothing is due, without notifying", async () => {
    const charge = gatewayOk();
    const res = await collectInvoice({
      ...base,
      amountDuePaise: 0,
      mandate: MANDATE,
      charge,
    });
    expect(res.status).toBe("not_collectable");
    expect(charge.notify).not.toHaveBeenCalled();
  });

  it("★ refuses when an attempt is already in flight", async () => {
    const charge = gatewayOk();
    // The partial unique index refused the insert.
    seed({ returning: [] });
    const res = await collectInvoice({
      ...base,
      amountDuePaise: 5_000_00,
      mandate: MANDATE,
      charge,
    });
    expect(res).toEqual({ status: "already_in_flight" });
    expect(charge.notify).not.toHaveBeenCalled();
  });
});

describe("collectInvoice — step 1: the notified order, and no money", () => {
  const base = {
    invoiceId: INVOICE,
    storeId: STORE,
    amountDuePaise: 5_000_00,
    description: "Pro monthly renewal",
    mandate: MANDATE,
    now: NOW_1,
  };
  /** The attempt read by the settle that records the order: still `created`. */
  const created = [
    { id: ATTEMPT, state: "created", invoiceId: INVOICE, storeId: STORE },
  ];

  it("★★ writes the attempt row BEFORE calling the gateway", async () => {
    let attemptsWhenNotified = -1;
    const charge = gatewayOk();
    charge.notify.mockImplementation(async () => {
      attemptsWhenNotified = dbHolder.current.calls.insert.length;
      return {
        ok: true as const,
        data: { providerOrderId: "order_1", debitAfter: DEBIT_AFTER },
      };
    });
    seed({ selects: [created] });
    await collectInvoice({ ...base, charge });
    expect(attemptsWhenNotified).toBe(1);
  });

  it("★ passes OUR idempotency key, the token and the mandate's rail to the gateway", async () => {
    const charge = gatewayOk();
    seed({ selects: [created] });
    await collectInvoice({
      ...base,
      mandate: { ...MANDATE, method: "upi" },
      charge,
    });
    const arg = charge.notify.mock.calls[0][0];
    expect(arg).toMatchObject({
      amountPaise: 5_000_00,
      providerTokenId: "tok_live_1",
      rail: "upi",
      now: NOW_1,
    });
    // A UUID we minted, and the same one stored on the attempt row.
    expect(arg.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(dbHolder.current.calls.values[0].idempotencyKey).toBe(
      arg.idempotencyKey,
    );
    // An unrecorded rail is `unknown`, which the gateway gives the longer notice.
    seed({ selects: [created] });
    await collectInvoice({ ...base, charge });
    expect(charge.notify.mock.calls[1][0].rail).toBe("unknown");
  });

  it("★★ records the order AND when it may be debited in one write, and is `notified`", async () => {
    const charge = gatewayOk();
    seed({ selects: [created], returning: [{ id: ATTEMPT }] });
    dbHolder.current = makeDbMock({
      selectQueue: [created, [{ state: "processing" }]],
      returningQueue: [
        [{ id: ATTEMPT }], // the attempt insert
        [{ state: "processing" }], // the settle's claim
        [{ id: INVOICE }], // the invoice sync
      ],
    });
    const res = await collectInvoice({ ...base, charge });
    expect(res).toEqual({
      status: "notified",
      attemptId: ATTEMPT,
      debitAfter: DEBIT_AFTER,
    });
    const recorded = dbHolder.current.calls.set.find(
      (s: any) => s.providerOrderId === "order_1",
    );
    expect(recorded).toMatchObject({
      state: "processing",
      providerOrderId: "order_1",
      debitAfter: DEBIT_AFTER.toISOString(),
    });
  });

  it("★★ NEVER sends the debit: that is the debit pass's job, a day or more later", async () => {
    const charge = gatewayOk();
    seed({ selects: [created] });
    await collectInvoice({ ...base, charge });
    expect(charge.debit).not.toHaveBeenCalled();
    expect(charge.readNotice).not.toHaveBeenCalled();
  });

  it("★ a 4xx on the order IS a failure: nothing was created, the try is over", async () => {
    const charge = gatewayOk();
    charge.notify.mockResolvedValue({
      ok: false,
      error:
        "Debit can be attempted 36 hours after sending the pre-debit notification",
      outcome: "rejected",
    });
    seed({ selects: [created] });
    const res = await collectInvoice({ ...base, charge });
    expect(res).toMatchObject({ status: "failed", code: "gateway_rejected" });
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      state: "failed",
      failureCode: "gateway_rejected",
    });
  });

  it("★★ an UNKNOWN outcome is NOT a failure: reconcile, never retry", async () => {
    const charge = gatewayOk();
    charge.notify.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    seed({ selects: [created] });
    const res = await collectInvoice({ ...base, charge });
    expect(res).toEqual({ status: "pending_reconcile", attemptId: ATTEMPT });
    expect(dbHolder.current.calls.set[0].state).toBe("unknown");
  });

  it("★★ a THROWN gateway call is also UNKNOWN, not a failure", async () => {
    const charge = gatewayOk();
    charge.notify.mockRejectedValue(new Error("socket hang up"));
    seed({ selects: [created] });
    const res = await collectInvoice({ ...base, charge });
    expect(res.status).toBe("pending_reconcile");
    expect(dbHolder.current.calls.set[0].state).toBe("unknown");
  });

  it("★★ an order that could not be RECORDED is never reported as notified", async () => {
    // The settle found no attempt to move (a failed write reads the same):
    // the order exists at the gateway but nothing here points at it, so the
    // debit pass can never debit it. Reconcile closes the attempt.
    const charge = gatewayOk();
    seed({ selects: [[]] });
    const res = await collectInvoice({ ...base, charge });
    expect(res).toEqual({ status: "pending_reconcile", attemptId: ATTEMPT });
  });
});

describe("★★ recovered purchases (RC-F1b)", () => {
  const CREDS = { keyId: "rzp_1", keySecret: "secret" };
  const render = (clause: unknown) => {
    const q = new PgDialect().sqlToQuery(clause as never);
    return { sql: q.sql.replace(/\s+/g, " "), params: q.params };
  };

  describe("capturedDraftPurchases", () => {
    const row = {
      attemptId: "att-9",
      invoiceId: "inv-9",
      storeId: STORE,
      kind: "addon",
      providerOrderId: "order_9",
      providerPaymentId: "pay_9",
      amountPaise: 50_000,
      currency: "INR",
      createdAt: "2026-09-01T00:00:00.000Z",
    };

    it("★★ finds a CAPTURED attempt on a DRAFT invoice of the same store", async () => {
      seed({ selects: [[row]] });
      const found = await capturedDraftPurchases({ storeId: STORE });
      expect(found).toEqual([row]);
      const where = render(dbHolder.current.calls.where[0]);
      expect(where.sql).toContain('"billing_payment_attempts"."state" = $');
      expect(where.sql).toContain('"billing_invoices"."status" = $');
      expect(where.sql).toContain(
        '"billing_invoices"."store_id" = "billing_payment_attempts"."store_id"',
      );
      expect(where.params).toEqual(
        expect.arrayContaining([
          "captured",
          "draft",
          "subscription",
          "addon",
          STORE,
        ]),
      );
      expect(dbHolder.current.calls.innerJoin).toHaveLength(1);
      expect(dbHolder.current.calls.limit).toEqual([50]);
    });

    it("★ the hourly pass skips what a person already holds, and what is too fresh", async () => {
      seed({ selects: [[]] });
      await capturedDraftPurchases({
        createdBefore: "2026-09-01T00:00:00.000Z",
        excludeHeld: true,
        limit: 7,
      });
      const where = render(dbHolder.current.calls.where[0]);
      expect(where.sql).toContain('"billing_payment_attempts"."created_at" <');
      expect(where.sql).toContain("billing_reconciliation_items");
      expect(where.sql).toContain("'purchase_refused:'");
      expect(where.sql).toContain("'purchase_unapplied:'");
      expect(where.sql).toContain("('open', 'manual_review')");
      expect(dbHolder.current.calls.limit).toEqual([7]);
    });

    it("★ narrows to one kind when asked", async () => {
      seed({ selects: [[]] });
      await capturedDraftPurchases({ storeId: STORE, kind: "subscription" });
      const where = render(dbHolder.current.calls.where[0]);
      expect(where.params).not.toContain("addon");
    });

    it("★★ a read failure is NULL, never an empty list", async () => {
      seed({ selects: [new Error("db down") as any] });
      expect(await capturedDraftPurchases({ storeId: STORE })).toBeNull();
      expect(logError).toHaveBeenCalledWith(
        "billing.recovery.scan",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("capturedAttemptForInvoice", () => {
    it("returns the captured attempt on this store's invoice", async () => {
      seed({ selects: [[{ id: "att-1", providerPaymentId: "pay_1" }]] });
      expect(await capturedAttemptForInvoice("inv-1", STORE)).toEqual({
        id: "att-1",
        providerPaymentId: "pay_1",
      });
      const where = render(dbHolder.current.calls.where[0]);
      expect(where.params).toEqual(["inv-1", STORE, "captured"]);
    });

    it("null when there is none; undefined when it could not be read", async () => {
      seed({ selects: [[]] });
      expect(await capturedAttemptForInvoice("inv-1", STORE)).toBeNull();
      seed({ selects: [new Error("db down") as any] });
      expect(await capturedAttemptForInvoice("inv-1", STORE)).toBeUndefined();
    });
  });

  describe("verifyRecoveredCapture", () => {
    const base = {
      creds: CREDS,
      providerOrderId: "order_1",
      providerPaymentId: "pay_1",
      amountPaise: 50_000,
      currency: "INR",
    };
    const payments = (list: any[]) =>
      vi.fn(async () => ({ ok: true as const, data: list })) as any;

    it("★ ok when the same payment was captured for the same amount and currency", async () => {
      const res = await verifyRecoveredCapture({
        ...base,
        fetchOrderPayments: payments([
          { id: "pay_1", status: "captured", amount: 50_000, currency: "INR" },
        ]),
      });
      expect(res).toEqual({ status: "ok", paymentId: "pay_1" });
    });

    it("★★ a different AMOUNT is a mismatch, with what was seen", async () => {
      const res = await verifyRecoveredCapture({
        ...base,
        fetchOrderPayments: payments([
          { id: "pay_1", status: "captured", amount: 40_000, currency: "INR" },
        ]),
      });
      expect(res).toEqual({
        status: "mismatch",
        reason: "the captured amount or currency differs from the attempt",
        paymentId: "pay_1",
        observedPaise: 40_000,
      });
    });

    it("★★ a different CURRENCY is a mismatch", async () => {
      const res = await verifyRecoveredCapture({
        ...base,
        fetchOrderPayments: payments([
          { id: "pay_1", status: "captured", amount: 50_000, currency: "USD" },
        ]),
      });
      expect(res.status).toBe("mismatch");
    });

    it("★ a different payment than the one recorded is a mismatch", async () => {
      const res = await verifyRecoveredCapture({
        ...base,
        fetchOrderPayments: payments([
          { id: "pay_2", status: "captured", amount: 50_000, currency: "INR" },
        ]),
      });
      expect(res).toMatchObject({
        status: "mismatch",
        reason: "the gateway's captured payment is not the one recorded",
      });
    });

    it("★ no captured payment at all is a mismatch", async () => {
      const res = await verifyRecoveredCapture({
        ...base,
        fetchOrderPayments: payments([
          { id: "pay_1", status: "failed", amount: 50_000, currency: "INR" },
        ]),
      });
      expect(res).toMatchObject({
        status: "mismatch",
        reason: "the gateway shows no captured payment on this order",
      });
    });

    it("★★ an unreadable gateway is not a verdict", async () => {
      expect(
        await verifyRecoveredCapture({
          ...base,
          fetchOrderPayments: vi.fn(async () => ({
            ok: false as const,
            error: "timeout",
            outcome: "unknown" as const,
          })) as any,
        }),
      ).toEqual({ status: "unreadable" });
      expect(
        await verifyRecoveredCapture({
          ...base,
          fetchOrderPayments: vi.fn(async () => {
            throw new Error("network");
          }) as any,
        }),
      ).toEqual({ status: "unreadable" });
    });
  });

  describe("readAddonOrderTarget", () => {
    it("★ a plan change is named by the plan and period WE wrote", async () => {
      rzpOrder.rzpFetchOrder.mockResolvedValue({
        ok: true,
        data: { id: "order_1", notes: { plan: "pro", period: "yearly" } },
      });
      expect(await readAddonOrderTarget(CREDS, "order_1")).toEqual({
        kind: "plan_change",
        plan: "pro",
        period: "yearly",
      });
    });

    it("★ a location purchase is named by its count", async () => {
      rzpOrder.rzpFetchOrder.mockResolvedValue({
        ok: true,
        data: { id: "order_1", notes: { locations: "3" } },
      });
      expect(await readAddonOrderTarget(CREDS, "order_1")).toEqual({
        kind: "locations",
        count: 3,
      });
    });

    it("anything else is unknown; an unreadable order is null", async () => {
      rzpOrder.rzpFetchOrder.mockResolvedValue({
        ok: true,
        data: { id: "order_1", notes: { sm_billing_key: "k" } },
      });
      expect(await readAddonOrderTarget(CREDS, "order_1")).toEqual({
        kind: "unknown",
      });
      rzpOrder.rzpFetchOrder.mockResolvedValue({
        ok: false,
        error: "down",
        outcome: "unknown",
      });
      expect(await readAddonOrderTarget(CREDS, "order_1")).toBeNull();
    });
  });

  // PR #303 re-review, 22 Nov 2026.
  describe("★★ fileClosedAttemptPayment: a payment on a closed checkout is never dropped", () => {
    const input = {
      storeId: STORE,
      invoiceId: "inv-1",
      attemptId: "att-old",
      providerPaymentId: "pay_9",
      providerOrderId: "order_old",
      expectedPaise: 400_000,
      observedPaise: 400_000,
      closedAs: "cancelled",
      closedCode: "amount_changed",
      source: "webhook" as const,
      now: new Date("2026-11-22T00:00:00.000Z"),
    };

    it("files ONE open item per payment, keyed by the payment, and logs an error", async () => {
      seed({ selects: [[]], returning: [{ id: "item-1" }] });
      expect(await fileClosedAttemptPayment(input)).toBe(true);
      expect(dbHolder.current.calls.values[0]).toMatchObject({
        storeId: STORE,
        kind: "state_conflict",
        status: "open",
        invoiceId: "inv-1",
        attemptId: "att-old",
        providerPaymentId: "pay_9",
        providerOrderId: "order_old",
        expectedPaise: 400_000,
        observedPaise: 400_000,
        detail: {
          repair_key: "closed_checkout_paid:pay_9",
          closedAs: "cancelled",
          closedCode: "amount_changed",
          source: "webhook",
        },
      });
      expect(dbHolder.current.calls.onConflict).toHaveLength(1);
      expect(vi.mocked(logError).mock.calls[0][0]).toBe(
        "billing.payment_on_closed_attempt",
      );
    });

    it("★ one filed before (in any status) is not filed or announced again", async () => {
      seed({ selects: [[]], returning: [] });
      expect(await fileClosedAttemptPayment(input)).toBe(false);
      expect(logError).not.toHaveBeenCalled();
    });

    it("★★ a payment a SIBLING attempt recorded on the same order is not a lost payment", async () => {
      seed({ selects: [[{ id: "att-new" }]], returning: [{ id: "item-1" }] });
      expect(await fileClosedAttemptPayment(input)).toBe(false);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("a deleted store's is marked so, and a failed write answers false", async () => {
      seed({ selects: [[]], returning: [{ id: "item-1" }] });
      await fileClosedAttemptPayment({ ...input, storeId: null });
      expect(dbHolder.current.calls.values[0].detail.storeDeleted).toBe(true);

      dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
      expect(await fileClosedAttemptPayment(input)).toBe(false);
    });
  });

  describe("fileRecoveredPurchase", () => {
    const input = {
      storeId: STORE,
      kind: "state_conflict" as const,
      repairKey: "purchase_refused:att-1",
      note: "A note for a person.",
      invoiceId: "inv-1",
      attemptId: "att-1",
      providerPaymentId: "pay_1",
      providerOrderId: "order_1",
      expectedPaise: 50_000,
      purchase: "enrolment" as const,
      now: new Date("2026-09-01T00:00:00.000Z"),
    };

    it("★★ files an OPEN item carrying the repair key, the note and the purchase", async () => {
      seed({ returning: [{ id: "item-1" }] });
      expect(await fileRecoveredPurchase(input)).toBe(true);
      expect(dbHolder.current.calls.values[0]).toMatchObject({
        storeId: STORE,
        kind: "state_conflict",
        status: "open",
        invoiceId: "inv-1",
        attemptId: "att-1",
        providerPaymentId: "pay_1",
        expectedPaise: 50_000,
        observedPaise: null,
        detail: {
          repair_key: "purchase_refused:att-1",
          note: "A note for a person.",
          purchase: "enrolment",
        },
      });
      expect(dbHolder.current.calls.onConflict).toHaveLength(1);
      expect(logWarn).toHaveBeenCalledWith(
        "billing.recovery.filed",
        expect.objectContaining({ repairKey: "purchase_refused:att-1" }),
      );
    });

    it("★ filed once: a second filing of the same key writes nothing new", async () => {
      seed({ returning: [] });
      expect(await fileRecoveredPurchase(input)).toBe(false);
      expect(logWarn).not.toHaveBeenCalled();
    });
  });
});

// 21 Nov 2026. A notified attempt can be ended without a debit (the plan was
// cancelled, the mandate is gone). A terminal state is never left, so that
// write must not land once another worker has sent the debit: its capture
// would be ignored.
describe("★★ settleAttempt onlyIfUnsent: ending an attempt only while no debit was sent", () => {
  const render = (q: unknown) => {
    const out = new PgDialect().sqlToQuery(q as never);
    return { sql: out.sql.replace(/\s+/g, " ").trim(), params: out.params };
  };

  it("the claim also requires `debit_sent_at` to be null", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }],
        [{ state: "cancelled" }],
      ],
      returning: [{ state: "cancelled" }],
    });
    expect(
      await settleAttempt(ATTEMPT, "cancelled", { onlyIfUnsent: true }),
    ).toBe("cancelled");
    const where = render(dbHolder.current.calls.where[1]);
    expect(where.sql).toBe(
      '("billing_payment_attempts"."id" = $1 and "billing_payment_attempts"."state" = $2 and "billing_payment_attempts"."debit_sent_at" is null)',
    );
    expect(where.params).toEqual([ATTEMPT, "processing"]);
  });

  it("★★ a debit already sent: nothing moves, and the caller is told so", async () => {
    seed({
      selects: [[{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }]],
      // The guarded claim matched no row.
      returning: [],
    });
    expect(
      await settleAttempt(ATTEMPT, "cancelled", { onlyIfUnsent: true }),
    ).toBeNull();
    // The invoice was not re-derived from a write that never happened.
    expect(dbHolder.current.calls.update).toHaveLength(1);
  });

  it("without the flag the claim is on the state alone, as before", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }],
        [{ state: "failed" }],
      ],
      returning: [{ state: "failed" }],
    });
    await settleAttempt(ATTEMPT, "failed");
    expect(render(dbHolder.current.calls.where[1]).sql).toBe(
      '("billing_payment_attempts"."id" = $1 and "billing_payment_attempts"."state" = $2)',
    );
  });
});

describe("★★ withdrawUnsentDebits: a cancelled plan's scheduled debit", () => {
  const input = {
    invoiceId: INVOICE,
    code: "plan_cancelled",
    reason: "the plan was cancelled before the debit",
    now: NOW_1,
  };

  it("finds only automatic, notified, unsent attempts on that invoice", async () => {
    seed({ selects: [[]] });
    expect(await withdrawUnsentDebits(input)).toBe(0);
    const where = new PgDialect().sqlToQuery(
      dbHolder.current.calls.where[0] as never,
    );
    expect(where.sql.replace(/\s+/g, " ")).toBe(
      '("billing_payment_attempts"."invoice_id" = $1 and "billing_payment_attempts"."mode" = $2 and "billing_payment_attempts"."state" = $3 and "billing_payment_attempts"."debit_after" is not null and "billing_payment_attempts"."debit_sent_at" is null)',
    );
    expect(where.params).toEqual([INVOICE, "automatic", "processing"]);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★ closes each one as cancelled, with the guarded write, and counts it", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT }],
        [{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }],
        [{ state: "cancelled" }],
      ],
      returning: [{ state: "cancelled" }],
    });
    expect(await withdrawUnsentDebits(input)).toBe(1);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      state: "cancelled",
      failureCode: "plan_cancelled",
      failureReason: "the plan was cancelled before the debit",
    });
    const where = new PgDialect().sqlToQuery(
      dbHolder.current.calls.where[2] as never,
    );
    expect(where.sql).toContain('"debit_sent_at" is null');
    // The invoice is re-derived: it reads as unpaid again, not in progress.
    expect(dbHolder.current.calls.set[1]).toMatchObject({ status: "open" });
  });

  it("★★ one whose debit was sent meanwhile is left in flight, and not counted", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT }],
        [{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }],
      ],
      returning: [],
    });
    expect(await withdrawUnsentDebits(input)).toBe(0);
  });

  it("a failed read is NULL, never zero", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
    expect(await withdrawUnsentDebits(input)).toBeNull();
  });
});

describe("automaticAttemptsOn: what the retry rule counts", () => {
  it("returns the tries, the starts and when the newest automatic attempt was opened", async () => {
    seed({
      selects: [
        [{ count: 2, starts: 4, lastAt: "2026-11-20 10:20:03.123456+00" }],
      ],
    });
    expect(await automaticAttemptsOn(INVOICE)).toEqual({
      count: 2,
      starts: 4,
      lastAt: new Date("2026-11-20T10:20:03.123Z"),
    });
    // Scoped to this invoice's AUTOMATIC attempts: a manual checkout the
    // merchant opened is not one of the three tries.
    const where = new PgDialect().sqlToQuery(
      dbHolder.current.calls.where[0] as never,
    );
    expect(where.sql).toContain('"invoice_id" = $1');
    expect(where.sql).toContain('"mode" = $2');
    expect(where.params).toEqual([INVOICE, "automatic"]);
  });

  it("★★ a TRY is a debit that was sent; an attempt withdrawn before its debit is nothing (PR #303 review)", async () => {
    seed({ selects: [[{ count: 0, starts: 0, lastAt: null }]] });
    await automaticAttemptsOn(INVOICE);
    const projection = dbHolder.current.calls.select[0] as Record<
      string,
      unknown
    >;
    const text = (key: string) =>
      new PgDialect()
        .sqlToQuery(projection[key] as never)
        .sql.replace(/\s+/g, " ");
    // A try: the debit was sent, or a payment exists.
    expect(text("count")).toBe(
      'count(*) filter (where "billing_payment_attempts"."debit_sent_at" is not null or "billing_payment_attempts"."provider_payment_id" is not null)::int',
    );
    // A start: everything except an attempt cancelled before its debit (the
    // plan was cancelled, or "Pay now instead").
    expect(text("starts")).toBe(
      'count(*) filter (where not ("billing_payment_attempts"."state" = \'cancelled\' and "billing_payment_attempts"."debit_sent_at" is null and "billing_payment_attempts"."provider_payment_id" is null))::int',
    );
    // The spacing reads every attempt, whatever became of it.
    expect(text("lastAt")).toBe('max("billing_payment_attempts"."created_at")');
  });

  it("no tries yet is a count of zero with no time", async () => {
    seed({ selects: [[{ count: 0, starts: 0, lastAt: null }]] });
    expect(await automaticAttemptsOn(INVOICE)).toEqual({
      count: 0,
      starts: 0,
      lastAt: null,
    });
  });

  it("★★ a failed read is NULL, never zero: 'could not count' is not 'never tried'", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
    expect(await automaticAttemptsOn(INVOICE)).toBeNull();
  });
});

describe("hasUnknownAttempt: a payment still waiting for its result", () => {
  it("true when the invoice has an attempt in `unknown`, false when it has none", async () => {
    seed({ selects: [[{ id: ATTEMPT }]] });
    expect(await hasUnknownAttempt(INVOICE)).toBe(true);
    const where = new PgDialect().sqlToQuery(
      dbHolder.current.calls.where[0] as never,
    );
    expect(where.params).toEqual([INVOICE, "unknown"]);

    seed({ selects: [[]] });
    expect(await hasUnknownAttempt(INVOICE)).toBe(false);
  });

  it("★★ a failed read is NULL, never false", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
    expect(await hasUnknownAttempt(INVOICE)).toBeNull();
  });
});
