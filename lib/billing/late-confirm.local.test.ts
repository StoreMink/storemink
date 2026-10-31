/** Rollback-only checks, against local Postgres, of finding F1: a payment
 * that reconciliation captures before the merchant's own confirm arrives.
 * The confirm finalizes the draft and settles the attempt again; that second
 * settle must bring the invoice to paid, so no invoice is left `open` behind
 * captured money (a bill Plans & Billing would offer to pay a second time).
 * Driven through the real start, reconcile and confirm paths for an
 * enrolment, a plan change and a location purchase, then the defect D9 limits
 * on the re-sync: a capture never revives a `void` or `uncollectible` invoice
 * and never makes a draft paid without finalizing it.
 *
 * And of RC-F1b, the closed tab: the merchant pays and never returns, so the
 * hourly reconcile finishes the purchase itself (invoice issued and paid, one
 * receipt, the plan or locations applied), a late confirm then changes
 * nothing, buying again finishes the earlier payment instead of charging a
 * second time, a failed guard or a differing amount is filed for a person,
 * and manual pay refuses an invoice that already holds a captured payment.
 *
 * Run with BILLING_LATE_CONFIRM_LOCAL_TEST=1; the fixed loopback database
 * keeps it away from Cloud SQL, and everything happens inside one transaction
 * that is rolled back.
 *
 * ★ The code under test runs as `app_service`, the role `withService` takes in
 *   production, so a write that role may not make fails here too.
 * ★ Each case runs inside its own savepoint, rolled back when the case ends.
 * ★ Nothing reaches a network: Razorpay is a small in-memory gateway, email
 *   and notifications are recorded, and `fetch` throws. An order this test did
 *   not create is unknown to the gateway, so a stale attempt committed on this
 *   database before the test is never settled by the reconcile runs here. */
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  pending: Promise.resolve(),
}));
vi.mock("@/lib/db/client", () => {
  async function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const previous = service.pending;
    let release!: () => void;
    service.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `late_confirm_${++service.count}`;
    await service.client!.query(`SAVEPOINT ${name}`);
    try {
      await service.client!.query("SET ROLE app_service");
      const value = await fn(service.db!);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await service.client!.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally {
      await service.client!.query("RESET ROLE");
      release();
    }
  }
  const notUsed = () => {
    throw new Error("Only withService is used by the code under test.");
  };
  return { withService, withUser: notUsed, withAnon: notUsed };
});
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ sent: true })) };
});
vi.mock("@/lib/notifications/record", () => ({
  recordEvent: vi.fn(async () => {}),
  emitEvent: vi.fn(),
}));
vi.mock("@/lib/payments/provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/payments/provider")>();
  return {
    ...actual,
    getPlatformRazorpayCreds: vi.fn(() => ({
      keyId: "rzp_test_local",
      keySecret: "local_secret",
    })),
  };
});

/** The gateway this test talks to: orders it created, payments it was told
 *  were captured. Anything else is unknown. */
const gateway = vi.hoisted(() => ({
  seq: 0,
  orders: new Map<
    string,
    {
      amount: number;
      method: string | null;
      notes: Record<string, string> | null;
    }
  >(),
  /** Reads of an order's payments left before the gateway "blinks" (answers
   *  unknown); an order not listed always answers. */
  paymentReadsLeft: new Map<string, number>(),
  payments: new Map<
    string,
    {
      id: string;
      order_id: string;
      amount: number;
      currency: string;
      status: string;
    }[]
  >(),
}));
vi.mock("@/lib/payments/razorpay", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/payments/razorpay")>();
  type OrderParams = {
    amountPaise: number;
    receipt?: string | null;
    method?: string | null;
    notes?: Record<string, string> | null;
  };
  const created = (params: OrderParams) => {
    const id = `order_late_${++gateway.seq}`;
    gateway.orders.set(id, {
      amount: params.amountPaise,
      method: params.method ?? null,
      notes: params.notes ?? null,
    });
    return {
      ok: true as const,
      data: {
        id,
        amount: params.amountPaise,
        currency: "INR",
        receipt: params.receipt ?? null,
        status: "created",
        method: params.method ?? null,
        attempts: 0,
        amount_paid: 0,
      },
    };
  };
  const unknown = (what: string) => ({
    ok: false as const,
    error: `${what} is not in this test's gateway`,
    outcome: "unknown" as const,
  });
  const noNetwork = async () => {
    throw new Error("This test never calls Razorpay for that.");
  };
  return {
    ...actual,
    rzpCreateCustomer: vi.fn(async () => ({
      ok: true as const,
      data: { id: "cust_local_late" },
    })),
    rzpCreateOrder: vi.fn(async (_creds: unknown, params: OrderParams) =>
      created(params),
    ),
    rzpCreateAuthorizationOrder: vi.fn(
      async (_creds: unknown, params: OrderParams) => created(params),
    ),
    rzpFetchOrder: vi.fn(async (_creds: unknown, orderId: string) => {
      const order = gateway.orders.get(orderId);
      if (!order) return unknown(orderId);
      return {
        ok: true as const,
        data: {
          id: orderId,
          amount: order.amount,
          currency: "INR",
          receipt: null,
          status: "created",
          method: order.method,
          attempts: 0,
          amount_paid: 0,
          notes: order.notes,
        },
      };
    }),
    rzpFetchOrderPayments: vi.fn(async (_creds: unknown, orderId: string) => {
      const left = gateway.paymentReadsLeft.get(orderId);
      if (left !== undefined) {
        if (left <= 0) return unknown(orderId);
        gateway.paymentReadsLeft.set(orderId, left - 1);
      }
      const payments = gateway.payments.get(orderId);
      return payments
        ? { ok: true as const, data: payments }
        : unknown(orderId);
    }),
    rzpFetchPayment: vi.fn(async (_creds: unknown, paymentId: string) => ({
      ok: true as const,
      data: {
        id: paymentId,
        token_id: null,
        customer_id: null,
        method: "upi",
        status: "captured",
        currency: "INR",
      },
    })),
    verifyCheckoutSignature: vi.fn(() => true),
    verifyCapturedCheckoutPayment: vi.fn(async () => ({
      ok: true as const,
      gatewayRead: true as const,
    })),
    rzpRefund: vi.fn(noNetwork),
    rzpFetchPaymentRefunds: vi.fn(noNetwork),
  };
});

import { sendEmail } from "@/lib/email/send";
import { logError, logInfo } from "@/lib/observability/logger";
import { settleAttempt } from "./collect";
import {
  ENROLMENT_RECOVERED_MESSAGE,
  confirmEnrolment,
  startEnrolment,
} from "./enrol";
import {
  LOCATIONS_RECOVERED_MESSAGE,
  confirmLocationPurchase,
  startLocationPurchase,
} from "./locations";
import { listPayableInvoices, startInvoicePayment } from "./manual-pay";
import { confirmPlanChange, startPlanChange } from "./plan-change";
import { reconcileStrandedAttempts } from "./reconcile";

const enabled = process.env.BILLING_LATE_CONFIRM_LOCAL_TEST === "1";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
const at = (ms: number) => new Date(NOW.getTime() + ms);

const PRO_PAISE = 240_000;
const BASIC_PAISE = 99_900;
const LOCATION_PRICE = { monthlyInr: 1_000, yearlyInr: 10_000 };
const tag = crypto.randomUUID().slice(0, 8);
const uuid = () => crypto.randomUUID();
const pay = (label: string) => `pay_late_${tag}_${label}`;

const priceFor = async (plan: string) => ({
  planPaise: plan === "pro" ? PRO_PAISE : BASIC_PAISE,
  locationPaise: 0,
});

/** The emails to one store so far whose subject starts so. */
function emailsFor(storeId: string, subjectStart: string) {
  return vi
    .mocked(sendEmail)
    .mock.calls.map((call) => call[0])
    .filter(
      (input) =>
        input.storeId === storeId && input.subject.startsWith(subjectStart),
    );
}

/** The payment receipts sent to one store so far. */
function receiptsFor(storeId: string) {
  return emailsFor(storeId, "Payment received");
}

/** The "You're on the … plan" welcomes sent to one store so far. */
function welcomesFor(storeId: string) {
  return emailsFor(storeId, "You're on the");
}

const PRO_STORE = {
  plan: "pro",
  plan_expires_at: null,
  comp_plan: null,
  comp_expires_at: null,
};

describe.skipIf(!enabled)(
  "a payment reconciliation captures before the confirm arrives (finding F1, local database)",
  () => {
    let client: Client;

    const one = async (sqlText: string, params: unknown[] = []) =>
      ((await client.query(sqlText, params)).rows[0] ?? null) as Record<
        string,
        unknown
      > | null;

    /** Give a case its own savepoint, rolled back when the case ends. */
    function isolated(name: string, setup: () => Promise<void>) {
      beforeAll(async () => {
        await client.query(`SAVEPOINT ${name}`);
        await setup();
      });
      afterAll(async () => {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await client.query(`RELEASE SAVEPOINT ${name}`);
      });
    }

    async function addStore(id: string, name: string, plan = "free") {
      await client.query(
        `insert into public.stores (id, name, slug, plan, plan_source)
         values ($1, $2, $3, $4, 'paid')`,
        [id, name, `late-${id.slice(0, 8)}`, plan],
      );
      await client.query(
        `insert into public.store_billing_settings
           (store_id, business_name, contact_email, contact_phone)
         values ($1, $2, $3, '9876543210')`,
        [id, `${name} Traders`, `billing-${id.slice(0, 8)}@probe.test`],
      );
    }

    /** A live subscription in the middle of its first cycle. */
    async function addActiveSubscription(storeId: string, plan: string) {
      await client.query(
        `insert into public.billing_subscriptions
           (store_id, plan, period, state, current_cycle_seq,
            current_period_start, current_period_end, plan_source)
         values ($1, $2, 'monthly', 'active', 1, $3, $4, 'paid')`,
        [storeId, plan, at(-DAY).toISOString(), at(29 * DAY).toISOString()],
      );
    }

    /** A subscription invoice, written as a draft and, unless it stays one,
     *  issued the way finalize issues one (the triggers number it). */
    async function addInvoice(input: {
      storeId: string;
      status: "draft" | "open" | "void" | "uncollectible";
    }): Promise<string> {
      const id = uuid();
      await client.query(
        `insert into public.billing_invoices
           (id, store_id, kind, status, subtotal_paise, discount_paise, tax_paise,
            total_paise, cycle_seq, period_start, period_end, due_at,
            created_at, updated_at)
         values ($1, $2, 'subscription', 'draft', $3, 0, 0, $3, 1, $4, $5, $4,
                 $4, $4)`,
        [
          id,
          input.storeId,
          PRO_PAISE,
          at(-DAY).toISOString(),
          at(29 * DAY).toISOString(),
        ],
      );
      await client.query(
        `insert into public.billing_invoice_items
           (invoice_id, kind, description, quantity, unit_amount_paise, amount_paise)
         values ($1, 'base_plan', 'Pro plan · 1 month', 1, $2, $2)`,
        [id, PRO_PAISE],
      );
      if (input.status !== "draft") {
        await client.query(
          `update public.billing_invoices
              set finalized_at = $2, status = $3, updated_at = $2
            where id = $1`,
          [id, at(-DAY).toISOString(), input.status],
        );
      }
      return id;
    }

    /** An attempt the gateway already captured. */
    async function addCapturedAttempt(
      invoiceId: string,
      storeId: string,
    ): Promise<string> {
      const id = uuid();
      await client.query(
        `insert into public.billing_payment_attempts
           (id, invoice_id, store_id, idempotency_key, mode, state, amount_paise,
            provider_order_id, provider_payment_id, resolved_at, created_at, updated_at)
         values ($1, $2, $3, $4, 'manual', 'captured', $5, $6, $7, $8, $8, $8)`,
        [
          id,
          invoiceId,
          storeId,
          `late-${crypto.randomUUID()}`,
          PRO_PAISE,
          `order_late_${tag}_${id.slice(0, 8)}`,
          pay(id.slice(0, 8)),
          at(-DAY).toISOString(),
        ],
      );
      return id;
    }

    const invoiceRow = (id: string) =>
      one(
        `select status, finalized_at, paid_at, invoice_ref
           from public.billing_invoices where id = $1`,
        [id],
      );
    const attemptRow = (invoiceId: string) =>
      one(
        `select state, provider_payment_id
           from public.billing_payment_attempts where invoice_id = $1`,
        [invoiceId],
      );

    /** Reconcile finds the order captured while the invoice is a draft.
     *
     * ★ The gateway blinks after that first read, so the pass cannot check the
     * money again to finish the purchase itself (RC-F1b) and the draft is
     * left for the confirm, which is the F1 case under test here. */
    async function captureByReconcile(
      invoiceId: string,
      orderId: string,
      amount: number,
      label: string,
    ) {
      gateway.payments.set(orderId, [
        {
          id: pay(label),
          order_id: orderId,
          amount,
          currency: "INR",
          status: "captured",
        },
      ]);
      gateway.paymentReadsLeft.set(orderId, 1);
      vi.mocked(logError).mockClear();
      const summary = await reconcileStrandedAttempts({ now: at(30 * MINUTE) });
      gateway.paymentReadsLeft.delete(orderId);
      expect(summary.errors).toBe(0);
      expect(summary.completed).toBe(0);
      expect(await attemptRow(invoiceId)).toMatchObject({
        state: "captured",
        provider_payment_id: pay(label),
      });
      // The draft is untouched: the paid claim admits only open and
      // processing, so the capture is recorded and the invoice is not paid,
      // and that miss is reported.
      expect(await invoiceRow(invoiceId)).toMatchObject({
        status: "draft",
        finalized_at: null,
        paid_at: null,
        invoice_ref: null,
      });
      expect(logError).toHaveBeenCalledWith(
        "billing.invoice_paid_claim_missed",
        expect.any(Error),
        { invoiceId, invoiceStatus: "draft", issued: false },
      );
    }

    /** The merchant closed the tab: reconcile finds the payment captured and
     *  finishes the purchase in the same pass (RC-F1b). */
    async function finishByReconcile(
      orderId: string,
      amount: number,
      label: string,
    ) {
      gateway.payments.set(orderId, [
        {
          id: pay(label),
          order_id: orderId,
          amount,
          currency: "INR",
          status: "captured",
        },
      ]);
      const summary = await reconcileStrandedAttempts({ now: at(30 * MINUTE) });
      expect(summary.errors).toBe(0);
      expect(summary.recovered).toBeGreaterThanOrEqual(1);
      expect(summary.completed).toBe(1);
      return summary;
    }

    /** A capture an earlier pass recorded: the attempt is captured and the
     *  gateway knows the payment, but nothing finished the purchase. */
    async function captureOnly(
      invoiceId: string,
      orderId: string,
      amount: number,
      label: string,
      gatewayAmount = amount,
    ): Promise<string> {
      gateway.payments.set(orderId, [
        {
          id: pay(label),
          order_id: orderId,
          amount: gatewayAmount,
          currency: "INR",
          status: "captured",
        },
      ]);
      const attempt = await one(
        "select id from public.billing_payment_attempts where invoice_id = $1",
        [invoiceId],
      );
      const attemptId = attempt?.id as string;
      expect(
        await settleAttempt(attemptId, "captured", {
          providerPaymentId: pay(label),
          now: at(5 * MINUTE),
        }),
      ).toBe("captured");
      expect(await invoiceRow(invoiceId)).toMatchObject({ status: "draft" });
      return attemptId;
    }

    const subscriptionRow = (storeId: string) =>
      one(
        `select state, plan, period, current_cycle_seq, billed_locations
           from public.billing_subscriptions where store_id = $1`,
        [storeId],
      );
    const storePlanRow = (storeId: string) =>
      one("select plan, plan_source from public.stores where id = $1", [
        storeId,
      ]);
    const queueItems = async (storeId: string) =>
      (
        await client.query(
          `select kind, status, detail, expected_paise, observed_paise, attempt_id
             from public.billing_reconciliation_items
            where store_id = $1 order by created_at`,
          [storeId],
        )
      ).rows as Record<string, unknown>[];
    const enrolmentAudits = async (storeId: string) =>
      (
        await client.query(
          `select note from public.plan_events
            where store_id = $1 and actor = 'billing-enrolment'`,
          [storeId],
        )
      ).rows as { note: string }[];

    /** Issued, paid, and the receipts sent during this test (mocks are reset
     *  before every test, so a count is per test). */
    async function expectPaid(
      invoiceId: string,
      storeId: string,
      receiptsThisTest: number,
    ) {
      const invoice = await invoiceRow(invoiceId);
      expect(invoice?.status).toBe("paid");
      expect(invoice?.finalized_at).not.toBeNull();
      expect(invoice?.paid_at).not.toBeNull();
      expect(invoice?.invoice_ref).not.toBeNull();
      expect(receiptsFor(storeId)).toHaveLength(receiptsThisTest);
    }

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user:
          process.env.BILLING_LATE_CONFIRM_LOCAL_TEST_USER || process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      service.client = client;
      service.db = drizzle(client, { schema: { ...schema, ...relations } });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("No network in this test.");
        }),
      );
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      if (!client) return;
      await client.query("ROLLBACK");
      await client.end();
    });

    describe("1. an enrolment", () => {
      const store = uuid();
      let invoiceId = "";
      let orderId = "";
      let amount = 0;

      isolated("case_1", async () => {
        await addStore(store, "Late Enrolment");
      });

      it("startEnrolment writes a draft and a payment in flight", async () => {
        const started = await startEnrolment({
          storeId: store,
          plan: "pro",
          period: "monthly",
          priceFor,
          now: NOW,
        });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        invoiceId = started.data.invoiceId;
        orderId = started.data.providerOrderId;
        amount = started.data.amountPaise;
        expect(await invoiceRow(invoiceId)).toMatchObject({ status: "draft" });
        expect((await attemptRow(invoiceId))?.state).toBe("processing");
      }, 30_000);

      it("reconcile captures the payment while the invoice is still a draft", async () => {
        await captureByReconcile(invoiceId, orderId, amount, "enrol");
        expect(receiptsFor(store)).toHaveLength(0);
      }, 30_000);

      it("★★ confirmEnrolment then leaves the invoice paid, not open, and sends one receipt", async () => {
        const confirmed = await confirmEnrolment({
          storeId: store,
          invoiceId,
          providerPaymentId: pay("enrol"),
          signature: "signature-checked-by-the-mock",
          now: at(31 * MINUTE),
        });
        expect(confirmed.ok).toBe(true);
        await expectPaid(invoiceId, store, 1);
        expect(
          await one(
            "select state, current_cycle_seq from public.billing_subscriptions where store_id = $1",
            [store],
          ),
        ).toMatchObject({ state: "active", current_cycle_seq: 1 });
      }, 30_000);

      it("★★ Plans & Billing offers no second payment for it, and manual pay refuses one", async () => {
        expect(await listPayableInvoices(store)).toEqual([]);
        const ordersBefore = gateway.seq;
        const second = await startInvoicePayment({
          storeId: store,
          invoiceId,
          now: at(32 * MINUTE),
        });
        expect(second).toEqual({
          ok: false,
          error: "That invoice is already paid.",
        });
        expect(gateway.seq).toBe(ordersBefore);
      }, 30_000);

      it("a double-submitted confirm changes nothing and sends no second receipt", async () => {
        const again = await confirmEnrolment({
          storeId: store,
          invoiceId,
          providerPaymentId: pay("enrol"),
          signature: "signature-checked-by-the-mock",
          now: at(33 * MINUTE),
        });
        expect(again.ok).toBe(true);
        await expectPaid(invoiceId, store, 0);
      }, 30_000);
    });

    describe("2. a plan change", () => {
      const store = uuid();
      let invoiceId = "";
      let orderId = "";
      let amount = 0;

      isolated("case_2", async () => {
        await addStore(store, "Late Upgrade", "basic");
        await addActiveSubscription(store, "basic");
      });

      it("startPlanChange writes a draft add-on invoice and a payment in flight", async () => {
        const started = await startPlanChange({
          storeId: store,
          targetPlan: "pro",
          targetPeriod: "monthly",
          priceFor,
          locationPrice: LOCATION_PRICE,
          now: NOW,
        });
        expect(started.ok).toBe(true);
        if (!started.ok || !started.data.payment) {
          throw new Error("expected a payment to open");
        }
        invoiceId = started.data.payment.invoiceId;
        orderId = started.data.payment.providerOrderId;
        amount = started.data.payment.amountPaise;
        expect(await invoiceRow(invoiceId)).toMatchObject({ status: "draft" });
      }, 30_000);

      it("reconcile captures it while the invoice is still a draft", async () => {
        await captureByReconcile(invoiceId, orderId, amount, "upgrade");
      }, 30_000);

      it("★★ confirmPlanChange then leaves the invoice paid and sends one receipt", async () => {
        const confirmed = await confirmPlanChange({
          storeId: store,
          invoiceId,
          targetPlan: "pro",
          targetPeriod: "monthly",
          providerPaymentId: pay("upgrade"),
          signature: "signature-checked-by-the-mock",
          now: at(31 * MINUTE),
        });
        expect(confirmed.ok).toBe(true);
        await expectPaid(invoiceId, store, 1);
        expect(
          await one(
            "select plan from public.billing_subscriptions where store_id = $1",
            [store],
          ),
        ).toMatchObject({ plan: "pro" });
      }, 30_000);
    });

    describe("3. a location purchase", () => {
      const store = uuid();
      let invoiceId = "";
      let orderId = "";
      let amount = 0;

      isolated("case_3", async () => {
        await addStore(store, "Late Location", "pro");
        await addActiveSubscription(store, "pro");
      });

      it("startLocationPurchase writes a draft add-on invoice and a payment in flight", async () => {
        const started = await startLocationPurchase({
          storeId: store,
          store: {
            plan: "pro",
            plan_expires_at: null,
            comp_plan: null,
            comp_expires_at: null,
          },
          requested: 1,
          locationPrice: LOCATION_PRICE,
          now: NOW,
        });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        invoiceId = started.data.invoiceId;
        orderId = started.data.providerOrderId;
        amount = started.data.amountPaise;
        expect(await invoiceRow(invoiceId)).toMatchObject({ status: "draft" });
      }, 30_000);

      it("reconcile captures it while the invoice is still a draft", async () => {
        await captureByReconcile(invoiceId, orderId, amount, "location");
      }, 30_000);

      it("★★ confirmLocationPurchase then leaves the invoice paid and sends one receipt", async () => {
        const confirmed = await confirmLocationPurchase({
          storeId: store,
          invoiceId,
          providerPaymentId: pay("location"),
          signature: "signature-checked-by-the-mock",
          now: at(31 * MINUTE),
        });
        expect(confirmed).toEqual({ ok: true, data: { billedLocations: 1 } });
        await expectPaid(invoiceId, store, 1);
      }, 30_000);
    });

    describe("4. the re-sync keeps the defect D9 limits", () => {
      const statuses = ["void", "uncollectible", "draft", "open"] as const;
      // One store holds one invoice per cycle, so each status gets its own.
      const stores = {
        void: uuid(),
        uncollectible: uuid(),
        draft: uuid(),
        open: uuid(),
      };
      const ids = { void: "", uncollectible: "", draft: "", open: "" };
      const attempts = { ...ids };

      isolated("case_4", async () => {
        for (const status of statuses) {
          await addStore(stores[status], `Settled ${status}`, "pro");
          ids[status] = await addInvoice({ storeId: stores[status], status });
          attempts[status] = await addCapturedAttempt(
            ids[status],
            stores[status],
          );
        }
      });

      it.each(["void", "uncollectible"] as const)(
        "★★ a capture settled again on an ISSUED %s invoice never revives it",
        async (status) => {
          vi.mocked(logInfo).mockClear();
          const before = await invoiceRow(ids[status]);
          expect(await settleAttempt(attempts[status], "captured")).toBe(
            "captured",
          );
          expect(await invoiceRow(ids[status])).toEqual(before);
          expect(before?.status).toBe(status);
          expect(logInfo).toHaveBeenCalledWith(
            "billing.payment_on_closed_invoice",
            { invoiceId: ids[status], invoiceStatus: status },
          );
          expect(receiptsFor(stores[status])).toHaveLength(0);
        },
        30_000,
      );

      it("★★ a capture settled again on a DRAFT never makes it paid and spends no number", async () => {
        vi.mocked(logError).mockClear();
        expect(await settleAttempt(attempts.draft, "captured")).toBe(
          "captured",
        );
        expect(await invoiceRow(ids.draft)).toMatchObject({
          status: "draft",
          finalized_at: null,
          paid_at: null,
          invoice_ref: null,
        });
        expect(logError).toHaveBeenCalledWith(
          "billing.invoice_paid_claim_missed",
          expect.any(Error),
          { invoiceId: ids.draft, invoiceStatus: "draft", issued: false },
        );
        expect(receiptsFor(stores.draft)).toHaveLength(0);
      }, 30_000);

      it("an invoice an older confirm left open behind captured money is repaired by settling the attempt again, once", async () => {
        expect(await settleAttempt(attempts.open, "captured")).toBe("captured");
        await expectPaid(ids.open, stores.open, 1);
        expect(await settleAttempt(attempts.open, "captured")).toBe("captured");
        await expectPaid(ids.open, stores.open, 1);
      }, 30_000);
    });

    describe("5. RC-F1b: a closed-tab enrolment the hourly check finishes", () => {
      const store = uuid();
      let invoiceId = "";
      let orderId = "";
      let amount = 0;

      isolated("case_5", async () => {
        await addStore(store, "Closed Tab Enrolment");
      });

      it("startEnrolment writes a draft and a payment in flight", async () => {
        const started = await startEnrolment({
          storeId: store,
          plan: "pro",
          period: "monthly",
          priceFor,
          now: NOW,
        });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        invoiceId = started.data.invoiceId;
        orderId = started.data.providerOrderId;
        amount = started.data.amountPaise;
      }, 30_000);

      it("★★ reconcile finishes it: invoice issued and paid, one receipt, the plan switched on", async () => {
        await finishByReconcile(orderId, amount, "closed-enrol");
        await expectPaid(invoiceId, store, 1);
        expect(welcomesFor(store)).toHaveLength(1);
        expect(await subscriptionRow(store)).toMatchObject({
          state: "active",
          plan: "pro",
          period: "monthly",
          current_cycle_seq: 1,
        });
        expect(await storePlanRow(store)).toMatchObject({
          plan: "pro",
          plan_source: "paid",
        });
        const audits = await enrolmentAudits(store);
        expect(audits).toHaveLength(1);
        expect(audits[0].note).toMatch(/hourly check/);
        expect(await queueItems(store)).toEqual([]);
      }, 30_000);

      it("★★ a late browser confirm then changes nothing and sends nothing", async () => {
        const before = await invoiceRow(invoiceId);
        const confirmed = await confirmEnrolment({
          storeId: store,
          invoiceId,
          providerPaymentId: pay("closed-enrol"),
          signature: "signature-checked-by-the-mock",
          now: at(40 * MINUTE),
        });
        expect(confirmed).toMatchObject({ ok: true, data: { plan: "pro" } });
        expect(await invoiceRow(invoiceId)).toEqual(before);
        expect(receiptsFor(store)).toHaveLength(0);
        expect(welcomesFor(store)).toHaveLength(0);
        expect(await enrolmentAudits(store)).toHaveLength(1);
      }, 30_000);

      it("the next hourly pass finds nothing left to finish", async () => {
        const summary = await reconcileStrandedAttempts({
          now: at(90 * MINUTE),
        });
        expect(summary.errors).toBe(0);
        expect(summary.completed).toBe(0);
        expect(receiptsFor(store)).toHaveLength(0);
      }, 30_000);

      it("★ Plans & Billing offers no second payment, and manual pay refuses one", async () => {
        expect(await listPayableInvoices(store)).toEqual([]);
        const ordersBefore = gateway.seq;
        expect(
          await startInvoicePayment({
            storeId: store,
            invoiceId,
            now: at(91 * MINUTE),
          }),
        ).toEqual({ ok: false, error: "That invoice is already paid." });
        expect(gateway.seq).toBe(ordersBefore);
      }, 30_000);
    });

    describe("6. RC-F1b: a closed-tab plan change the hourly check finishes", () => {
      const store = uuid();
      let invoiceId = "";
      let orderId = "";
      let amount = 0;

      isolated("case_6", async () => {
        await addStore(store, "Closed Tab Upgrade", "basic");
        await addActiveSubscription(store, "basic");
      });

      it("startPlanChange writes a draft add-on invoice and a payment in flight", async () => {
        const started = await startPlanChange({
          storeId: store,
          targetPlan: "pro",
          targetPeriod: "monthly",
          priceFor,
          locationPrice: LOCATION_PRICE,
          now: NOW,
        });
        if (!started.ok || !started.data.payment) {
          throw new Error("expected a payment to open");
        }
        invoiceId = started.data.payment.invoiceId;
        orderId = started.data.payment.providerOrderId;
        amount = started.data.payment.amountPaise;
      }, 30_000);

      it("★★ reconcile finishes it with the plan the ORDER names, and one receipt", async () => {
        await finishByReconcile(orderId, amount, "closed-upgrade");
        await expectPaid(invoiceId, store, 1);
        expect(await subscriptionRow(store)).toMatchObject({
          state: "active",
          plan: "pro",
          period: "monthly",
          current_cycle_seq: 1,
        });
        expect(await storePlanRow(store)).toMatchObject({ plan: "pro" });
        expect(await queueItems(store)).toEqual([]);
      }, 30_000);

      it("★★ a late browser confirm then changes nothing and sends nothing", async () => {
        const before = await invoiceRow(invoiceId);
        const confirmed = await confirmPlanChange({
          storeId: store,
          invoiceId,
          targetPlan: "pro",
          targetPeriod: "monthly",
          providerPaymentId: pay("closed-upgrade"),
          signature: "signature-checked-by-the-mock",
          now: at(40 * MINUTE),
        });
        expect(confirmed).toEqual({
          ok: true,
          data: { plan: "pro", period: "monthly" },
        });
        expect(await invoiceRow(invoiceId)).toEqual(before);
        expect(receiptsFor(store)).toHaveLength(0);
      }, 30_000);
    });

    describe("7. RC-F1b: a closed-tab location purchase the hourly check finishes", () => {
      const store = uuid();
      let invoiceId = "";
      let orderId = "";
      let amount = 0;

      isolated("case_7", async () => {
        await addStore(store, "Closed Tab Location", "pro");
        await addActiveSubscription(store, "pro");
      });

      it("startLocationPurchase writes a draft add-on invoice and a payment in flight", async () => {
        const started = await startLocationPurchase({
          storeId: store,
          store: PRO_STORE,
          requested: 1,
          locationPrice: LOCATION_PRICE,
          now: NOW,
        });
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        invoiceId = started.data.invoiceId;
        orderId = started.data.providerOrderId;
        amount = started.data.amountPaise;
      }, 30_000);

      it("★★ reconcile finishes it: the count the INVOICE carries, and one receipt", async () => {
        await finishByReconcile(orderId, amount, "closed-location");
        await expectPaid(invoiceId, store, 1);
        expect(await subscriptionRow(store)).toMatchObject({
          billed_locations: 1,
        });
      }, 30_000);

      it("★★ a late browser confirm then changes nothing and sends nothing", async () => {
        const before = await invoiceRow(invoiceId);
        const confirmed = await confirmLocationPurchase({
          storeId: store,
          invoiceId,
          providerPaymentId: pay("closed-location"),
          signature: "signature-checked-by-the-mock",
          now: at(40 * MINUTE),
        });
        expect(confirmed).toEqual({ ok: true, data: { billedLocations: 1 } });
        expect(await invoiceRow(invoiceId)).toEqual(before);
        expect(receiptsFor(store)).toHaveLength(0);
      }, 30_000);
    });

    describe("8. RC-F1b: buying again finishes the earlier payment instead of charging twice", () => {
      const enrolStore = uuid();
      const upgradeStore = uuid();
      const locationStore = uuid();

      isolated("case_8", async () => {
        await addStore(enrolStore, "Again Enrolment");
        await addStore(upgradeStore, "Again Upgrade", "basic");
        await addActiveSubscription(upgradeStore, "basic");
        await addStore(locationStore, "Again Location", "pro");
        await addActiveSubscription(locationStore, "pro");
      });

      it("★★ subscribing again (even to another period) completes the paid enrolment and opens no order", async () => {
        const started = await startEnrolment({
          storeId: enrolStore,
          plan: "pro",
          period: "monthly",
          priceFor,
          now: NOW,
        });
        if (!started.ok) throw new Error(started.error);
        await captureOnly(
          started.data.invoiceId,
          started.data.providerOrderId,
          started.data.amountPaise,
          "again-enrol",
        );

        const ordersBefore = gateway.seq;
        const again = await startEnrolment({
          storeId: enrolStore,
          plan: "pro",
          period: "yearly",
          priceFor,
          now: at(10 * MINUTE),
        });
        expect(again).toEqual({
          ok: false,
          error: ENROLMENT_RECOVERED_MESSAGE,
          recovered: "completed",
        });
        expect(gateway.seq).toBe(ordersBefore);
        await expectPaid(started.data.invoiceId, enrolStore, 1);
        expect(welcomesFor(enrolStore)).toHaveLength(1);
        // ★ Never reshaped to the period picked the second time: the money
        // paid for a month, so a month is what was issued and switched on.
        expect(
          await one(
            `select total_paise,
                    round(extract(epoch from (period_end - period_start)) / 86400) as days
               from public.billing_invoices where id = $1`,
            [started.data.invoiceId],
          ),
        ).toMatchObject({ total_paise: String(PRO_PAISE), days: "30" });
        expect(await subscriptionRow(enrolStore)).toMatchObject({
          state: "active",
          period: "monthly",
          current_cycle_seq: 1,
        });
        expect((await enrolmentAudits(enrolStore))[0].note).toMatch(
          /tried to subscribe again/,
        );
      }, 30_000);

      it("★★ changing plan again completes the paid change and opens no order", async () => {
        const started = await startPlanChange({
          storeId: upgradeStore,
          targetPlan: "pro",
          targetPeriod: "monthly",
          priceFor,
          locationPrice: LOCATION_PRICE,
          now: NOW,
        });
        if (!started.ok || !started.data.payment) {
          throw new Error("expected a payment to open");
        }
        await captureOnly(
          started.data.payment.invoiceId,
          started.data.payment.providerOrderId,
          started.data.payment.amountPaise,
          "again-upgrade",
        );
        const ordersBefore = gateway.seq;
        const again = await startPlanChange({
          storeId: upgradeStore,
          targetPlan: "pro",
          targetPeriod: "yearly",
          priceFor,
          locationPrice: LOCATION_PRICE,
          now: at(10 * MINUTE),
        });
        expect(again).toEqual({
          ok: true,
          data: {
            scheduled: false,
            effectiveAt: null,
            plan: "pro",
            period: "monthly",
            recovered: true,
          },
        });
        expect(gateway.seq).toBe(ordersBefore);
        await expectPaid(started.data.payment.invoiceId, upgradeStore, 1);
        expect(await subscriptionRow(upgradeStore)).toMatchObject({
          plan: "pro",
          period: "monthly",
        });
      }, 30_000);

      it("★★ buying locations again completes the paid purchase and opens no order", async () => {
        const started = await startLocationPurchase({
          storeId: locationStore,
          store: PRO_STORE,
          requested: 1,
          locationPrice: LOCATION_PRICE,
          now: NOW,
        });
        if (!started.ok) throw new Error(started.error);
        await captureOnly(
          started.data.invoiceId,
          started.data.providerOrderId,
          started.data.amountPaise,
          "again-location",
        );
        const ordersBefore = gateway.seq;
        const again = await startLocationPurchase({
          storeId: locationStore,
          store: PRO_STORE,
          requested: 2,
          locationPrice: LOCATION_PRICE,
          now: at(10 * MINUTE),
        });
        expect(again).toEqual({
          ok: false,
          error: LOCATIONS_RECOVERED_MESSAGE,
        });
        expect(gateway.seq).toBe(ordersBefore);
        await expectPaid(started.data.invoiceId, locationStore, 1);
        expect(await subscriptionRow(locationStore)).toMatchObject({
          billed_locations: 1,
        });
      }, 30_000);
    });

    describe("9. RC-F1b: a failed guard is filed for a person, once, and nothing is applied", () => {
      const store = uuid();
      let invoiceId = "";
      let orderId = "";
      let amount = 0;
      let attemptId = "";

      isolated("case_9", async () => {
        await addStore(store, "Guarded Enrolment");
      });

      it("the subscription goes live on a later cycle while the payment is out", async () => {
        const started = await startEnrolment({
          storeId: store,
          plan: "pro",
          period: "monthly",
          priceFor,
          now: NOW,
        });
        if (!started.ok) throw new Error(started.error);
        invoiceId = started.data.invoiceId;
        orderId = started.data.providerOrderId;
        amount = started.data.amountPaise;
        attemptId = started.data.attemptId;
        await client.query(
          `update public.billing_subscriptions
              set state = 'active', current_cycle_seq = 2,
                  current_period_start = $2, current_period_end = $3
            where store_id = $1`,
          [store, at(-DAY).toISOString(), at(29 * DAY).toISOString()],
        );
      }, 30_000);

      it("★★ reconcile records the money, files the purchase with a clear note, applies nothing", async () => {
        gateway.payments.set(orderId, [
          {
            id: pay("guarded"),
            order_id: orderId,
            amount,
            currency: "INR",
            status: "captured",
          },
        ]);
        const summary = await reconcileStrandedAttempts({
          now: at(30 * MINUTE),
        });
        expect(summary.errors).toBe(0);
        expect(summary.completed).toBe(0);
        expect(summary.flagged).toBeGreaterThanOrEqual(1);
        const items = await queueItems(store);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          kind: "state_conflict",
          status: "open",
          attempt_id: attemptId,
          expected_paise: String(amount),
        });
        expect(items[0].detail).toMatchObject({
          repair_key: `purchase_refused:${attemptId}`,
          purchase: "enrolment",
          note: expect.stringMatching(/already live on cycle 2/),
        });
        expect(await invoiceRow(invoiceId)).toMatchObject({
          status: "draft",
          invoice_ref: null,
        });
        expect(await subscriptionRow(store)).toMatchObject({
          current_cycle_seq: 2,
        });
        expect(receiptsFor(store)).toHaveLength(0);
        expect(welcomesFor(store)).toHaveLength(0);
      }, 30_000);

      it("★ the next pass files nothing new", async () => {
        const summary = await reconcileStrandedAttempts({
          now: at(90 * MINUTE),
        });
        expect(summary.errors).toBe(0);
        expect(await queueItems(store)).toHaveLength(1);
      }, 30_000);
    });

    describe("10. RC-F1b: a captured amount that differs is filed, never applied", () => {
      const store = uuid();

      isolated("case_10", async () => {
        await addStore(store, "Differing Amount");
      });

      it("★★ recovery refuses it and files an amount mismatch for a person", async () => {
        const started = await startEnrolment({
          storeId: store,
          plan: "pro",
          period: "monthly",
          priceFor,
          now: NOW,
        });
        if (!started.ok) throw new Error(started.error);
        const attemptId = await captureOnly(
          started.data.invoiceId,
          started.data.providerOrderId,
          started.data.amountPaise,
          "differs",
          started.data.amountPaise - 100,
        );
        const summary = await reconcileStrandedAttempts({
          now: at(30 * MINUTE),
        });
        expect(summary.errors).toBe(0);
        expect(summary.completed).toBe(0);
        const items = await queueItems(store);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          kind: "amount_mismatch",
          status: "open",
          observed_paise: String(started.data.amountPaise - 100),
        });
        expect(items[0].detail).toMatchObject({
          repair_key: `purchase_refused:${attemptId}`,
          purchase: "enrolment",
        });
        expect(await invoiceRow(started.data.invoiceId)).toMatchObject({
          status: "draft",
        });
        expect((await subscriptionRow(store))?.state).not.toBe("active");
        expect(receiptsFor(store)).toHaveLength(0);
        expect(welcomesFor(store)).toHaveLength(0);
      }, 30_000);
    });

    describe("11. RC-F1b: manual pay re-syncs an invoice that already holds a captured payment", () => {
      const store = uuid();
      let invoiceId = "";

      isolated("case_11", async () => {
        await addStore(store, "Captured Open", "pro");
        invoiceId = await addInvoice({ storeId: store, status: "open" });
        await addCapturedAttempt(invoiceId, store);
      });

      it("★★ it says the invoice is paid, makes it so, and opens no order", async () => {
        const ordersBefore = gateway.seq;
        expect(
          await startInvoicePayment({ storeId: store, invoiceId, now: NOW }),
        ).toEqual({ ok: false, error: "That invoice is already paid." });
        expect(gateway.seq).toBe(ordersBefore);
        await expectPaid(invoiceId, store, 1);
      }, 30_000);
    });
  },
);
