/** Rollback-only checks, against local Postgres, of the refund pass and the
 * plan ends that feed it (renewal-cancel, design 11.2): a cancelling plan ends
 * with its unreached invoices closed in the same transaction, the real
 * processBillingRefunds owes, holds, sends, settles, notes and announces a
 * refund once, a refused one is never retried by the pass, deleting a store
 * keeps what the refund needs, two detections of one payment write one row, a
 * returning merchant's enrolment draft is never touched, a cancelling plan in
 * grace is advanced only by Keep my plan or the safety net, a duplicate
 * payment is refunded without changing its invoice, and the probe v2 cases
 * run through the real helpers. Run with BILLING_REFUNDS_LOCAL_TEST=1; the
 * fixed loopback database keeps it away from Cloud SQL, and everything happens
 * inside one transaction that is rolled back.
 *
 * ★ The code under test runs as `app_service`, the role `withService` takes in
 *   production, so a write that role may not make fails here too.
 * ★ Each numbered case runs inside its own savepoint, rolled back when the case
 *   ends, so one case's rows never reach another's pass.
 * ★ Nothing reaches a network: Razorpay is a small in-memory gateway, the
 *   refund call is injected, email and notifications are recorded, and
 *   `fetch` throws.
 * ⚠ One transaction cannot hold two connections' views of uncommitted rows, so
 *   case 6 runs the two detections through the serialized service scope: the
 *   second waits for the first, then re-checks under the payment's lock and
 *   finds its row. A real second connection would need committed fixtures, and
 *   a committed refund or issued invoice can never be deleted afterwards. */
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
    const name = `refunds_local_${++service.count}`;
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
vi.mock("@/lib/store/resolve", () => ({
  STORE_TAG: "stores",
  FALLBACK_STORE_ID: "a0000000-0000-4000-8000-000000000001",
}));
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveThemeDefinition: vi.fn(),
}));
vi.mock("@/lib/themes/apply", () => ({ applyTheme: vi.fn() }));
vi.mock("@/lib/storage/cleanup", () => ({
  deleteStorageUrls: vi.fn(async () => ({
    attempted: 0,
    failed: 0,
    unmanaged: 0,
  })),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsDeletePrefix: vi.fn(async () => ({ deleted: 0, failed: 0 })),
  gcsPrivateConfigured: false,
}));
vi.mock("@/lib/domains/cleanup", () => ({
  cleanupDetachedDomain: vi.fn(async () => ({ failures: [] })),
}));
vi.mock("@/lib/auth/firebase-users", () => ({
  deleteAuthUser: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/firebase-admin", () => ({
  isFirebaseAdminConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/auth/authorized-domains", () => ({
  removeAuthorizedHosts: vi.fn(async () => ({ removed: [] })),
}));
const operator = vi.hoisted(() => ({
  email: `refunds-${Math.random().toString(36).slice(2, 10)}@probe.test`,
}));
vi.mock("@/lib/auth/server-user", () => ({
  getServerUser: vi.fn(async () => ({
    id: "refunds-operator",
    email: operator.email,
    phone: null,
    phoneConfirmed: true,
    metadata: {},
  })),
}));
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
 *  were captured. Anything else is unknown, so an attempt committed on this
 *  database before the test is never settled by it. */
const gateway = vi.hoisted(() => ({
  seq: 0,
  orders: new Map<string, { amount: number; method: string | null }>(),
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
  };
  const created = (params: OrderParams) => {
    const id = `order_local_${++gateway.seq}`;
    gateway.orders.set(id, {
      amount: params.amountPaise,
      method: params.method ?? null,
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
    throw new Error("This test never calls Razorpay's refund API.");
  };
  return {
    ...actual,
    rzpCreateCustomer: vi.fn(async () => ({
      ok: true as const,
      data: { id: "cust_local_refunds" },
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
        },
      };
    }),
    rzpFetchOrderPayments: vi.fn(async (_creds: unknown, orderId: string) => {
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

/** The real advance, wrapped so case 8 can make one call of it fail. Internal
 *  calls inside renewal-worker.ts (the downgrade safety net) keep the real
 *  binding; cancel.ts and reconcile.ts import this one. */
vi.mock("./renewal-worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./renewal-worker")>();
  return {
    ...actual,
    advanceAfterPayment: vi.fn((storeId: string, now?: Date) =>
      actual.advanceAfterPayment(storeId, now),
    ),
  };
});

import { deleteStore } from "@/app/actions/platform";
import { sendEmail } from "@/lib/email/send";
import { logError } from "@/lib/observability/logger";
import type { ChargeFn } from "./collect";
import { issueCreditNote } from "./credit-note-store";
import { confirmEnrolment, startEnrolment } from "./enrol";
import { finalizeInvoiceClaimed } from "./invoice-store";
import { reconcileStrandedAttempts } from "./reconcile";
import { resumeSubscription } from "./cancel";
import {
  BELOW_MINIMUM_MESSAGE,
  NOTE_REQUIRED_MESSAGE,
  WAITING_CHECK_IST_HOUR,
  createOperatorRefund,
  detectOwedRefund,
  istHour,
  overCapMessage,
  processBillingRefunds,
  recordRefundMadeOutside,
  retryRefund,
  sendOwedRefund,
  tellMerchantRefund,
  type RefundFn,
} from "./refunds";
import {
  advanceAfterPayment,
  collectDueRenewals,
  downgradeExpired,
  evaluateCycleTurns,
} from "./renewal-worker";

const enabled = process.env.BILLING_REFUNDS_LOCAL_TEST === "1";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The run's clock, on a whole minute. ★ Moved off the 09:00 IST hour, when
 *  the pass also counts what has waited a day: that check is the unit test's,
 *  and here it would add a count no case asks about. */
const NOW = (() => {
  const base = new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
  return istHour(base) === WAITING_CHECK_IST_HOUR
    ? new Date(base.getTime() + 90 * MINUTE)
    : base;
})();
const at = (ms: number) => new Date(NOW.getTime() + ms);

/** Where automatic refunds begin: a payment on an uncollectible invoice
 *  resolved before this is history (D7). */
const FROM = at(-7 * DAY);

const PLAN_PAISE = 240_000;
const GST_TAX = 43_200;
const GST_TOTAL = PLAN_PAISE + GST_TAX;
const SUPPLIER_GSTIN = "03ABCDE1234F1Z5";
const OPERATOR = "ops@storemink.com";
const tag = crypto.randomUUID().slice(0, 8);
const uuid = () => crypto.randomUUID();
const emailFor = (storeId: string) =>
  `billing-${storeId.slice(0, 8)}@probe.test`;

type InvoiceStatus =
  | "draft"
  | "open"
  | "processing"
  | "paid"
  | "void"
  | "uncollectible";

/** A Razorpay that processes every refund at once. */
function processedRefund() {
  return vi.fn<RefundFn>(async (input) => ({
    ok: true as const,
    data: {
      id: `rfnd_${input.idempotencyKey.replace(/-/g, "").slice(0, 14)}`,
      payment_id: input.paymentId,
      amount: input.amountPaise,
      status: "processed",
      notes: input.notes,
    },
  }));
}

/** The refund emails sent so far in this test. */
function refundEmails() {
  return vi
    .mocked(sendEmail)
    .mock.calls.map((call) => call[0])
    .filter((input) => input.subject.startsWith("Your refund of"));
}

const priceFor = async () => ({
  planPaise: PLAN_PAISE,
  locationPaise: 0,
  planLabel: "Pro",
});

describe.skipIf(!enabled)(
  "the refund pass and the plan ends that feed it (local database)",
  () => {
    let client: Client;

    const one = async (sqlText: string, params: unknown[] = []) =>
      ((await client.query(sqlText, params)).rows[0] ?? null) as Record<
        string,
        unknown
      > | null;
    const count = async (sqlText: string, params: unknown[] = []) =>
      Number((await one(sqlText, params))?.n ?? 0);

    /** Run one statement that must be refused, inside its own savepoint,
     *  optionally as app_service. Returns the error's code and message, or
     *  null when the statement went through (and was undone). */
    async function refused(
      sqlText: string,
      params: unknown[] = [],
      role?: "app_service",
    ): Promise<{ code: string | null; message: string } | null> {
      await client.query("SAVEPOINT refusal");
      let outcome: { code: string | null; message: string } | null = null;
      try {
        if (role) await client.query(`SET ROLE ${role}`);
        await client.query(sqlText, params);
      } catch (error) {
        outcome = {
          code: (error as { code?: string }).code ?? null,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      await client.query("ROLLBACK TO SAVEPOINT refusal");
      await client.query("RELEASE SAVEPOINT refusal");
      await client.query("RESET ROLE");
      return outcome;
    }

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

    async function setAutoRefunds(on: boolean) {
      await client.query(
        "update public.platform_billing_settings set auto_refunds = $1 where id = true",
        [on],
      );
    }

    async function addStore(id: string, name: string) {
      await client.query(
        `insert into public.stores (id, name, slug, plan, plan_source)
         values ($1, $2, $3, 'pro', 'paid')`,
        [id, name, `refunds-${id.slice(0, 8)}`],
      );
      await client.query(
        `insert into public.store_billing_settings
           (store_id, business_name, contact_email, contact_phone)
         values ($1, $2, $3, '9876543210')`,
        [id, `${name} Traders`, emailFor(id)],
      );
    }

    async function addSubscription(
      storeId: string,
      input: {
        state: "active" | "past_due" | "cancelled" | "downgraded";
        cycle: number;
        periodStart?: Date;
        periodEnd?: Date;
        cancel?: boolean;
        graceStart?: Date;
        graceEnd?: Date;
      },
    ) {
      await client.query(
        `insert into public.billing_subscriptions
           (store_id, plan, period, state, current_cycle_seq,
            current_period_start, current_period_end, cancel_at_period_end,
            cancel_requested_at, cancel_requested_by,
            grace_started_at, grace_ends_at, plan_source)
         values ($1, 'pro', 'monthly', $2, $3, $4, $5, $6,
                 case when $6 then $7::timestamptz end,
                 case when $6 then 'merchant:refunds-probe' end,
                 $8, $9, 'paid')`,
        [
          storeId,
          input.state,
          input.cycle,
          input.periodStart?.toISOString() ?? null,
          input.periodEnd?.toISOString() ?? null,
          input.cancel ?? false,
          at(-3 * DAY).toISOString(),
          input.graceStart?.toISOString() ?? null,
          input.graceEnd?.toISOString() ?? null,
        ],
      );
    }

    /** A subscription invoice with its base plan line, written as a draft and
     *  then issued the way finalize issues one (the triggers number it and
     *  record its parties). */
    async function addInvoice(input: {
      storeId: string;
      cycle: number;
      status: InvoiceStatus;
      finalizedAt?: Date;
      paidAt?: Date;
      gst?: boolean;
    }): Promise<string> {
      const id = uuid();
      const tax = input.gst ? GST_TAX : 0;
      await client.query(
        `insert into public.billing_invoices
           (id, store_id, kind, status, subtotal_paise, discount_paise, tax_paise,
            total_paise, cycle_seq, period_start, period_end, due_at,
            tax_rate_bps, supplier_gstin, place_of_supply, created_at, updated_at)
         values ($1, $2, 'subscription', 'draft', $3, 0, $4, $5, $6, $7, $8, $7,
                 $9, $10, $11, $12, $12)`,
        [
          id,
          input.storeId,
          PLAN_PAISE,
          tax,
          PLAN_PAISE + tax,
          input.cycle,
          at(-DAY).toISOString(),
          at(29 * DAY).toISOString(),
          input.gst ? 1800 : null,
          input.gst ? SUPPLIER_GSTIN : null,
          input.gst ? "29" : null,
          at(-5 * DAY).toISOString(),
        ],
      );
      await client.query(
        `insert into public.billing_invoice_items
           (invoice_id, kind, description, quantity, unit_amount_paise, amount_paise)
         values ($1, 'base_plan', 'Pro plan · 1 month', 1, $2, $2)`,
        [id, PLAN_PAISE],
      );
      if (input.status !== "draft") {
        const finalizedAt = input.finalizedAt ?? at(-4 * DAY);
        await client.query(
          `update public.billing_invoices
              set finalized_at = $2, status = $3, paid_at = $4, updated_at = $2
            where id = $1`,
          [
            id,
            finalizedAt.toISOString(),
            input.status,
            input.status === "paid"
              ? (input.paidAt ?? at(-3 * DAY)).toISOString()
              : null,
          ],
        );
      }
      return id;
    }

    async function addAttempt(input: {
      invoiceId: string;
      storeId: string;
      state: "captured" | "processing" | "failed";
      amount?: number;
      orderId?: string | null;
      paymentId?: string | null;
      resolvedAt?: Date;
    }): Promise<string> {
      const id = uuid();
      const resolved = input.state !== "processing";
      await client.query(
        `insert into public.billing_payment_attempts
           (id, invoice_id, store_id, idempotency_key, mode, state, amount_paise,
            provider_order_id, provider_payment_id, resolved_at, created_at, updated_at)
         values ($1, $2, $3, $4, 'manual', $5, $6, $7, $8, $9, $10, $10)`,
        [
          id,
          input.invoiceId,
          input.storeId,
          `refunds-${crypto.randomUUID()}`,
          input.state,
          input.amount ?? PLAN_PAISE,
          input.orderId === undefined
            ? `order_${tag}_${id.slice(0, 8)}`
            : input.orderId,
          input.paymentId ?? null,
          resolved ? (input.resolvedAt ?? at(-DAY)).toISOString() : null,
          at(-2 * DAY).toISOString(),
        ],
      );
      return id;
    }

    const pay = (label: string) => `pay_${tag}_${label}`;

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.BILLING_REFUNDS_LOCAL_TEST_USER || process.env.USER,
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

      await client.query(
        "insert into public.platform_admins (email, role) values ($1, 'superadmin')",
        [operator.email],
      );
      const updated = await client.query(
        `update public.platform_billing_settings
            set auto_refunds = true, automatic_refunds_from = $1
          where id = true`,
        [FROM.toISOString()],
      );
      if (updated.rowCount === 0) {
        await client.query(
          `insert into public.platform_billing_settings
             (id, auto_refunds, automatic_refunds_from)
           values (true, true, $1)`,
          [FROM.toISOString()],
        );
      }
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      if (!client) return;
      await client.query("ROLLBACK");
      await client.end();
    });

    describe("1. a cancelling plan ends with its unreached invoices closed in the same transaction", () => {
      const stores = {
        none: uuid(),
        draft: uuid(),
        open: uuid(),
        processing: uuid(),
        paid: uuid(),
      };
      const invoices = new Map<string, string>();
      const grace = uuid();
      let graceInvoice = "";

      isolated("case_1", async () => {
        for (const [kind, storeId] of Object.entries(stores)) {
          await addStore(storeId, `Ending ${kind}`);
          await addSubscription(storeId, {
            state: "active",
            cycle: 1,
            periodStart: at(-30 * DAY),
            periodEnd: at(-HOUR),
            cancel: true,
          });
          if (kind === "none") continue;
          const invoiceId = await addInvoice({
            storeId,
            cycle: 2,
            status: kind as InvoiceStatus,
          });
          invoices.set(storeId, invoiceId);
          if (kind === "processing") {
            await addAttempt({ invoiceId, storeId, state: "processing" });
          }
          if (kind === "paid") {
            await addAttempt({
              invoiceId,
              storeId,
              state: "captured",
              paymentId: pay("c1_paid"),
            });
          }
        }

        await addStore(grace, "Ending in grace");
        await addSubscription(grace, {
          state: "past_due",
          cycle: 1,
          periodStart: at(-32 * DAY),
          periodEnd: at(-2 * DAY),
          cancel: true,
          graceStart: at(-2 * DAY),
          graceEnd: at(-HOUR),
        });
        graceInvoice = await addInvoice({
          storeId: grace,
          cycle: 2,
          status: "paid",
        });
        await addAttempt({
          invoiceId: graceInvoice,
          storeId: grace,
          state: "captured",
          paymentId: pay("c1_grace"),
        });
      });

      it("evaluateCycleTurns ends every one and voids its next invoice in the same transaction, whatever its state", async () => {
        const summary = await evaluateCycleTurns({ now: NOW });
        expect(summary).toMatchObject({ ended: 5, advanced: 0, errors: 0 });

        for (const storeId of Object.values(stores)) {
          const sub = await one(
            "select state, cancel_at_period_end, xmin::text as x from public.billing_subscriptions where store_id = $1",
            [storeId],
          );
          expect(sub).toMatchObject({
            state: "cancelled",
            cancel_at_period_end: false,
          });
          const store = await one(
            "select plan from public.stores where id = $1",
            [storeId],
          );
          expect(store?.plan).toBe("free");
          const invoiceId = invoices.get(storeId);
          if (!invoiceId) continue;
          const invoice = await one(
            "select status, xmin::text as x from public.billing_invoices where id = $1",
            [invoiceId],
          );
          expect(invoice?.status).toBe("void");
          // Written by the same subtransaction as the plan end.
          expect(invoice?.x).toBe(sub?.x);
        }
      }, 30_000);

      it("downgradeExpired ends a cancelling grace plan with a paid renewal instead of leaving it past_due", async () => {
        const summary = await downgradeExpired({ now: NOW });
        expect(summary).toMatchObject({
          ended: 1,
          downgraded: 0,
          advancedAfterGrace: 0,
          errors: 0,
        });
        const sub = await one(
          "select state, grace_ends_at, xmin::text as x from public.billing_subscriptions where store_id = $1",
          [grace],
        );
        expect(sub).toMatchObject({ state: "cancelled", grace_ends_at: null });
        const invoice = await one(
          "select status, xmin::text as x from public.billing_invoices where id = $1",
          [graceInvoice],
        );
        expect(invoice?.status).toBe("void");
        expect(invoice?.x).toBe(sub?.x);
      }, 30_000);
    });

    describe("2 and 3. the pass returns money on a closed invoice once, and only once", () => {
      const store = uuid();
      let invoiceId = "";
      let attemptId = "";

      isolated("case_2", async () => {
        await addStore(store, "Refund Probe E");
        await addSubscription(store, { state: "cancelled", cycle: 1 });
        invoiceId = await addInvoice({
          storeId: store,
          cycle: 2,
          status: "void",
          gst: true,
        });
        attemptId = await addAttempt({
          invoiceId,
          storeId: store,
          state: "captured",
          amount: GST_TOTAL,
          paymentId: pay("e"),
        });
      });

      it("owes the refund but holds it while automatic sending is off", async () => {
        await setAutoRefunds(false);
        const refund = processedRefund();
        const summary = await processBillingRefunds({
          now: NOW,
          refund,
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({
          detected: 1,
          sent: 0,
          processed: 0,
          creditNotes: 0,
          notified: 0,
          errors: 0,
        });
        expect(refund).not.toHaveBeenCalled();
        const row = await one(
          "select status, requested_by, reason, amount_paise from public.billing_refunds where attempt_id = $1",
          [attemptId],
        );
        expect(row).toMatchObject({
          status: "owed",
          requested_by: "system",
          reason: "cycle_not_reached",
        });
        expect(Number(row?.amount_paise)).toBe(GST_TOTAL);
      }, 30_000);

      it("sends it once sending is on, then issues its credit note and tells the merchant once", async () => {
        await setAutoRefunds(true);
        const refund = processedRefund();
        const summary = await processBillingRefunds({
          now: NOW,
          refund,
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({
          detected: 0,
          sent: 1,
          processed: 1,
          failed: 0,
          creditNotes: 1,
          notified: 1,
          errors: 0,
        });
        expect(refund).toHaveBeenCalledTimes(1);
        expect(refund.mock.calls[0][0]).toMatchObject({
          paymentId: pay("e"),
          amountPaise: GST_TOTAL,
        });

        const row = await one(
          "select id, status, notified_at, provider_refund_id from public.billing_refunds where attempt_id = $1",
          [attemptId],
        );
        expect(row?.status).toBe("processed");
        expect(row?.notified_at).not.toBeNull();
        expect(row?.provider_refund_id).toMatch(/^rfnd_/);
        const note = await one(
          "select credit_note_ref, refund_id from public.billing_credit_notes where invoice_id = $1",
          [invoiceId],
        );
        expect(note?.refund_id).toBe(row?.id);
        expect(note?.credit_note_ref).toMatch(/^CN\/\d{4}-\d{2}\/00001$/);

        // ★ A refund never writes its invoice (R9), nor its payment.
        const invoice = await one(
          "select status from public.billing_invoices where id = $1",
          [invoiceId],
        );
        expect(invoice?.status).toBe("void");
        const attempt = await one(
          "select state from public.billing_payment_attempts where id = $1",
          [attemptId],
        );
        expect(attempt?.state).toBe("captured");

        const emails = refundEmails();
        expect(emails).toHaveLength(1);
        expect(emails[0].to).toBe(emailFor(store));
      }, 30_000);

      it("3. a second run changes nothing and sends nothing", async () => {
        const refund = processedRefund();
        const summary = await processBillingRefunds({
          now: NOW,
          refund,
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({
          repairedInvoices: 0,
          flaggedForPerson: 0,
          detected: 0,
          sent: 0,
          processed: 0,
          failed: 0,
          creditNotes: 0,
          notified: 0,
          errors: 0,
        });
        expect(refund).not.toHaveBeenCalled();
        expect(refundEmails()).toHaveLength(0);
        expect(
          await count(
            "select count(*) as n from public.billing_refunds where attempt_id = $1",
            [attemptId],
          ),
        ).toBe(1);
      }, 30_000);
    });

    describe("4. a refused refund fails once, the pass never retries it, and a person can", () => {
      const store = uuid();
      let attemptId = "";

      isolated("case_4", async () => {
        await addStore(store, "Refund Probe F");
        await addSubscription(store, { state: "cancelled", cycle: 1 });
        const invoiceId = await addInvoice({
          storeId: store,
          cycle: 2,
          status: "void",
        });
        attemptId = await addAttempt({
          invoiceId,
          storeId: store,
          state: "captured",
          paymentId: pay("f"),
        });
      });

      it("fails the row and logs the alert line when Razorpay refuses", async () => {
        const refund = vi.fn<RefundFn>(async () => ({
          ok: false as const,
          error: "The bank account is closed.",
          outcome: "rejected" as const,
        }));
        const summary = await processBillingRefunds({
          now: NOW,
          refund,
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({
          detected: 1,
          sent: 1,
          processed: 0,
          failed: 1,
          creditNotes: 0,
          notified: 0,
          errors: 0,
        });
        const row = await one(
          "select status, failure_reason from public.billing_refunds where attempt_id = $1",
          [attemptId],
        );
        expect(row).toMatchObject({
          status: "failed",
          failure_reason: "The bank account is closed.",
        });
        expect(
          vi
            .mocked(logError)
            .mock.calls.some((call) => call[0] === "billing.refund_failed"),
        ).toBe(true);
      }, 30_000);

      it("the next run writes nothing new and sends nothing", async () => {
        const refund = processedRefund();
        const summary = await processBillingRefunds({
          now: NOW,
          refund,
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({
          detected: 0,
          sent: 0,
          failed: 0,
          flaggedForPerson: 0,
          errors: 0,
        });
        expect(refund).not.toHaveBeenCalled();
        expect(
          await count(
            "select count(*) as n from public.billing_refunds where attempt_id = $1",
            [attemptId],
          ),
        ).toBe(1);
      }, 30_000);

      it("an operator's retry goes out as a new row with the same reason (T5c)", async () => {
        const failed = await one(
          "select id from public.billing_refunds where attempt_id = $1",
          [attemptId],
        );
        const refund = processedRefund();
        const result = await retryRefund({
          refundId: String(failed?.id),
          note: "Retried after the merchant fixed the bank account.",
          operator: OPERATOR,
          now: NOW,
          refund,
        });
        expect(result).toMatchObject({ ok: true, status: "processed" });
        expect(refund).toHaveBeenCalledTimes(1);
        const rows = (
          await client.query(
            `select status, reason, requested_by from public.billing_refunds
              where attempt_id = $1 order by created_at, status`,
            [attemptId],
          )
        ).rows;
        expect(rows).toHaveLength(2);
        expect(rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: "failed",
              requested_by: "system",
            }),
            expect.objectContaining({
              status: "processed",
              reason: "cycle_not_reached",
              requested_by: OPERATOR,
            }),
          ]),
        );
      }, 30_000);
    });

    describe("5. a deleted store's refund still goes out, to the billing email on its invoice", () => {
      const live = uuid();
      const ended = uuid();
      let liveInvoice = "";
      let liveAttempt = "";
      let endedInvoice = "";
      let endedAttempt = "";

      isolated("case_5", async () => {
        await addStore(live, "Deleted While Live");
        await addSubscription(live, {
          state: "active",
          cycle: 1,
          periodStart: at(-28 * DAY),
          periodEnd: at(2 * DAY),
        });
        liveInvoice = await addInvoice({
          storeId: live,
          cycle: 2,
          status: "paid",
          finalizedAt: at(-2 * DAY),
          paidAt: at(-DAY),
        });
        liveAttempt = await addAttempt({
          invoiceId: liveInvoice,
          storeId: live,
          state: "captured",
          paymentId: pay("live"),
        });

        await addStore(ended, "Deleted After Ending");
        await addSubscription(ended, { state: "cancelled", cycle: 2 });
        endedInvoice = await addInvoice({
          storeId: ended,
          cycle: 3,
          status: "paid",
        });
        endedAttempt = await addAttempt({
          invoiceId: endedInvoice,
          storeId: ended,
          state: "captured",
          paymentId: pay("ended"),
        });
      });

      it("deleteStore closes the live plan's paid renewal and files the ended plan's for a person", async () => {
        expect(await deleteStore(live)).toMatchObject({ success: true });
        // The checks deleteStore deferred to COMMIT run now.
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        expect(await deleteStore(ended)).toMatchObject({ success: true });
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");

        const invoice = await one(
          "select status, store_id from public.billing_invoices where id = $1",
          [liveInvoice],
        );
        expect(invoice).toMatchObject({ status: "void", store_id: null });

        const item = await one(
          `select store_id, status, detail from public.billing_reconciliation_items
            where detail ->> 'repair_key' = $1`,
          [`paid_unreached:${endedInvoice}`],
        );
        expect(item).toMatchObject({ store_id: null, status: "open" });
        expect(item?.detail).toMatchObject({
          storeDeleted: true,
          storeName: "Deleted After Ending",
        });
      }, 30_000);

      it("the pass refunds the deleted store's payment, mails the invoice's billing email and leaves the filed one alone", async () => {
        const refund = processedRefund();
        const summary = await processBillingRefunds({
          now: NOW,
          refund,
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({
          detected: 1,
          sent: 1,
          processed: 1,
          notified: 1,
          errors: 0,
        });
        expect(refund).toHaveBeenCalledTimes(1);
        expect(refund.mock.calls[0][0].paymentId).toBe(pay("live"));
        const row = await one(
          "select status, notified_at from public.billing_refunds where attempt_id = $1",
          [liveAttempt],
        );
        expect(row?.status).toBe("processed");
        expect(row?.notified_at).not.toBeNull();
        expect(
          await count(
            "select count(*) as n from public.billing_refunds where attempt_id = $1",
            [endedAttempt],
          ),
        ).toBe(0);

        const emails = refundEmails();
        expect(emails).toHaveLength(1);
        expect(emails[0].to).toBe(emailFor(live));
      }, 30_000);
    });

    describe("6. two detections of one payment write one refund and file nothing", () => {
      const store = uuid();
      let invoiceId = "";
      let attemptId = "";

      isolated("case_6", async () => {
        await addStore(store, "Refund Probe K");
        await addSubscription(store, { state: "cancelled", cycle: 1 });
        invoiceId = await addInvoice({
          storeId: store,
          cycle: 2,
          status: "void",
        });
        attemptId = await addAttempt({
          invoiceId,
          storeId: store,
          state: "captured",
          paymentId: pay("k"),
        });
      });

      it("the second waits for the payment's lock, finds the first's row and skips", async () => {
        const invoice = await one(
          "select invoice_ref from public.billing_invoices where id = $1",
          [invoiceId],
        );
        const candidate = {
          attemptId,
          invoiceId,
          amountPaise: PLAN_PAISE,
          providerPaymentId: pay("k"),
          invoiceRef: String(invoice?.invoice_ref),
        };
        const opts = {
          now: NOW,
          automaticRefundsFrom: FROM.toISOString(),
        };
        const outcomes = await Promise.all([
          detectOwedRefund(candidate, opts),
          detectOwedRefund(candidate, opts),
        ]);
        expect(outcomes).toEqual(["owed", "skipped"]);
        expect(
          await count(
            "select count(*) as n from public.billing_refunds where attempt_id = $1",
            [attemptId],
          ),
        ).toBe(1);
        expect(
          await count(
            "select count(*) as n from public.billing_reconciliation_items where attempt_id = $1",
            [attemptId],
          ),
        ).toBe(0);

        // A second automatic refund written by hand is refused outright.
        const second = await refused(
          `insert into public.billing_refunds
             (invoice_id, attempt_id, reason, status, amount_paise,
              idempotency_key, provider_payment_id, requested_by)
           values ($1, $2, 'cycle_not_reached', 'owed', 100, $3, $4, 'system')`,
          [invoiceId, attemptId, `refunds-second-${tag}`, pay("k")],
          "app_service",
        );
        expect(second?.code).toMatch(/^(P0001|23505)$/);
      }, 30_000);
    });

    describe("7. a returning merchant's enrolment is never touched by the pass", () => {
      const store = uuid();
      let invoiceId = "";
      let orderId = "";

      isolated("case_7", async () => {
        await addStore(store, "Returning Merchant");
        await addSubscription(store, { state: "cancelled", cycle: 4 });
      });

      it("startEnrolment writes a draft at cycle 5, and resuming hands back the same order", async () => {
        const first = await startEnrolment({
          storeId: store,
          plan: "pro",
          period: "monthly",
          priceFor,
          now: NOW,
        });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        invoiceId = first.data.invoiceId;
        orderId = first.data.providerOrderId;
        const invoice = await one(
          "select status, cycle_seq from public.billing_invoices where id = $1",
          [invoiceId],
        );
        expect(invoice).toMatchObject({ status: "draft", cycle_seq: 5 });

        const resumed = await startEnrolment({
          storeId: store,
          plan: "pro",
          period: "monthly",
          priceFor,
          now: NOW,
        });
        expect(resumed.ok).toBe(true);
        if (!resumed.ok) return;
        expect(resumed.data.invoiceId).toBe(invoiceId);
        expect(resumed.data.providerOrderId).toBe(orderId);
        expect(resumed.data.attemptId).toBe(first.data.attemptId);
      }, 30_000);

      it("the refund pass leaves the draft and its payment in flight alone", async () => {
        const refund = processedRefund();
        const summary = await processBillingRefunds({
          now: at(5 * MINUTE),
          refund,
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({
          repairedInvoices: 0,
          detected: 0,
          errors: 0,
        });
        expect(refund).not.toHaveBeenCalled();
        const invoice = await one(
          "select status, finalized_at from public.billing_invoices where id = $1",
          [invoiceId],
        );
        expect(invoice).toMatchObject({ status: "draft", finalized_at: null });
        const attempt = await one(
          "select state from public.billing_payment_attempts where invoice_id = $1",
          [invoiceId],
        );
        expect(attempt?.state).toBe("processing");
      }, 30_000);

      it("a reconcile capture then confirmEnrolment activates cycle 5 on the same order, with no invoice void", async () => {
        gateway.payments.set(orderId, [
          {
            id: pay("m"),
            order_id: orderId,
            amount: PLAN_PAISE,
            currency: "INR",
            status: "captured",
          },
        ]);
        await reconcileStrandedAttempts({ now: at(30 * MINUTE) });
        const captured = await one(
          "select state, provider_payment_id from public.billing_payment_attempts where invoice_id = $1",
          [invoiceId],
        );
        expect(captured).toMatchObject({
          state: "captured",
          provider_payment_id: pay("m"),
        });

        const confirmed = await confirmEnrolment({
          storeId: store,
          invoiceId,
          providerPaymentId: pay("m"),
          signature: "signature-checked-by-the-mock",
          now: at(31 * MINUTE),
        });
        expect(confirmed.ok).toBe(true);
        const sub = await one(
          "select state, current_cycle_seq from public.billing_subscriptions where store_id = $1",
          [store],
        );
        expect(sub).toMatchObject({ state: "active", current_cycle_seq: 5 });
        const orders = (
          await client.query(
            "select distinct provider_order_id from public.billing_payment_attempts where invoice_id = $1",
            [invoiceId],
          )
        ).rows;
        expect(orders).toEqual([{ provider_order_id: orderId }]);
        expect(
          await count(
            "select count(*) as n from public.billing_invoices where store_id = $1 and status = 'void'",
            [store],
          ),
        ).toBe(0);
      }, 30_000);
    });

    describe("8. a cancelling plan in grace with a captured renewal advances only once the cancellation is lifted", () => {
      const kept = uuid();
      const netted = uuid();

      isolated("case_8", async () => {
        for (const [storeId, name] of [
          [kept, "Grace Kept"],
          [netted, "Grace Safety Net"],
        ] as const) {
          await addStore(storeId, name);
          await addSubscription(storeId, {
            state: "past_due",
            cycle: 2,
            periodStart: at(-31 * DAY),
            periodEnd: at(-DAY),
            cancel: true,
            graceStart: at(-DAY),
            graceEnd: at(DAY),
          });
          const invoiceId = await addInvoice({
            storeId,
            cycle: 3,
            status: "paid",
            finalizedAt: at(-5 * DAY),
            paidAt: at(-2 * HOUR),
          });
          await addAttempt({
            invoiceId,
            storeId,
            state: "captured",
            paymentId: pay(`grace_${storeId.slice(0, 6)}`),
          });
        }
      });

      it("advanceAfterPayment refuses while the cancellation stands, and Keep my plan advances it", async () => {
        expect(await advanceAfterPayment(kept, NOW)).toBe(false);
        const resumed = await resumeSubscription({
          storeId: kept,
          now: NOW,
          requestedBy: "merchant:refunds-probe",
        });
        expect(resumed).toMatchObject({ ok: true, data: { advanced: true } });
        const sub = await one(
          "select state, current_cycle_seq, cancel_at_period_end from public.billing_subscriptions where store_id = $1",
          [kept],
        );
        expect(sub).toMatchObject({
          state: "active",
          current_cycle_seq: 3,
          cancel_at_period_end: false,
        });
      }, 30_000);

      it("with the advance made to fail, the next downgrade run advances it instead of downgrading", async () => {
        vi.mocked(advanceAfterPayment).mockImplementationOnce(
          async () => false,
        );
        const resumed = await resumeSubscription({
          storeId: netted,
          now: NOW,
          requestedBy: "merchant:refunds-probe",
        });
        expect(resumed).toMatchObject({ ok: true, data: { advanced: false } });
        expect(
          await one(
            "select state, current_cycle_seq from public.billing_subscriptions where store_id = $1",
            [netted],
          ),
        ).toMatchObject({ state: "past_due", current_cycle_seq: 2 });

        const summary = await downgradeExpired({ now: at(2 * DAY) });
        expect(summary).toMatchObject({
          advancedAfterGrace: 1,
          downgraded: 0,
          ended: 0,
          errors: 0,
        });
        expect(
          await one(
            "select state, current_cycle_seq from public.billing_subscriptions where store_id = $1",
            [netted],
          ),
        ).toMatchObject({ state: "active", current_cycle_seq: 3 });
      }, 30_000);
    });

    describe("9. a renewal paid twice inside the collection window", () => {
      const store = uuid();
      let invoiceId = "";
      let secondAttempt = "";

      isolated("case_9", async () => {
        await addStore(store, "Paid Twice");
        await addSubscription(store, {
          state: "active",
          cycle: 1,
          periodStart: at(-28 * DAY),
          periodEnd: at(2 * DAY),
        });
        invoiceId = await addInvoice({
          storeId: store,
          cycle: 2,
          status: "paid",
          finalizedAt: at(-2 * DAY),
          paidAt: at(-DAY),
        });
        await addAttempt({
          invoiceId,
          storeId: store,
          state: "captured",
          paymentId: pay("twice_1"),
          resolvedAt: at(-DAY),
        });
        secondAttempt = await addAttempt({
          invoiceId,
          storeId: store,
          state: "captured",
          paymentId: pay("twice_2"),
          resolvedAt: at(-DAY + HOUR),
        });
      });

      it("an operator refunds the duplicate; the invoice stays paid and gets no credit note", async () => {
        const refund = processedRefund();
        const result = await createOperatorRefund({
          storeId: store,
          invoiceId,
          attemptId: secondAttempt,
          amountPaise: PLAN_PAISE,
          reason: "duplicate_payment",
          note: "The merchant paid the renewal twice.",
          operator: OPERATOR,
          now: NOW,
          refund,
        });
        expect(result).toMatchObject({ ok: true, status: "processed" });
        expect(refund).toHaveBeenCalledTimes(1);
        expect(
          (
            await one(
              "select status from public.billing_invoices where id = $1",
              [invoiceId],
            )
          )?.status,
        ).toBe("paid");
        expect(
          await count(
            "select count(*) as n from public.billing_credit_notes where invoice_id = $1",
            [invoiceId],
          ),
        ).toBe(0);
      }, 30_000);

      it("collection starts no new attempt, and the cycle turn advances", async () => {
        const charge = vi.fn<ChargeFn>(async () => {
          throw new Error("A paid renewal must not be charged again.");
        });
        const collect = await collectDueRenewals({
          now: NOW,
          charge,
          priceFor,
        });
        expect(collect.errors).toBe(0);
        expect(charge).not.toHaveBeenCalled();
        expect(
          await count(
            "select count(*) as n from public.billing_payment_attempts where invoice_id = $1",
            [invoiceId],
          ),
        ).toBe(2);

        const evaluate = await evaluateCycleTurns({ now: at(3 * DAY) });
        expect(evaluate).toMatchObject({ advanced: 1, errors: 0 });
        expect(
          await one(
            "select state, current_cycle_seq from public.billing_subscriptions where store_id = $1",
            [store],
          ),
        ).toMatchObject({ state: "active", current_cycle_seq: 2 });
        expect(
          (
            await one(
              "select status from public.billing_invoices where id = $1",
              [invoiceId],
            )
          )?.status,
        ).toBe("paid");
      }, 30_000);
    });

    describe("10a. the probe v2 cases through the real helpers", () => {
      const store = uuid();
      let closed = ""; // INV_A: void, its payment captured
      let closedAttempt = "";
      let gst = ""; // INV_B: paid, GST at 18 per cent
      let gstAttempt = "";
      let gstInFlight = "";
      let draft = ""; // INV_C: a draft with a captured payment
      let draftAttempt = "";
      let refundId = "";
      let noteId = "";

      isolated("case_10a", async () => {
        await addStore(store, "Refund Probe P");
        await addSubscription(store, { state: "cancelled", cycle: 1 });
        closed = await addInvoice({ storeId: store, cycle: 2, status: "void" });
        closedAttempt = await addAttempt({
          invoiceId: closed,
          storeId: store,
          state: "captured",
          paymentId: pay("p_a"),
        });
        gst = await addInvoice({
          storeId: store,
          cycle: 1,
          status: "paid",
          finalizedAt: at(-29 * DAY),
          paidAt: at(-29 * DAY),
          gst: true,
        });
        gstAttempt = await addAttempt({
          invoiceId: gst,
          storeId: store,
          state: "captured",
          amount: GST_TOTAL,
          paymentId: pay("p_b"),
        });
        gstInFlight = await addAttempt({
          invoiceId: gst,
          storeId: store,
          state: "processing",
          amount: GST_TOTAL,
        });
        draft = await addInvoice({ storeId: store, cycle: 3, status: "draft" });
        draftAttempt = await addAttempt({
          invoiceId: draft,
          storeId: store,
          state: "captured",
          paymentId: pay("p_c"),
        });
      });

      it("T4, T7, T11, T27, T12: owed, sent, noted once and announced once", async () => {
        const invoice = await one(
          "select invoice_ref from public.billing_invoices where id = $1",
          [closed],
        );
        const outcome = await detectOwedRefund(
          {
            attemptId: closedAttempt,
            invoiceId: closed,
            amountPaise: PLAN_PAISE,
            providerPaymentId: pay("p_a"),
            invoiceRef: String(invoice?.invoice_ref),
          },
          { now: NOW, automaticRefundsFrom: FROM.toISOString() },
        );
        expect(outcome).toBe("owed");
        const owed = await one(
          "select id from public.billing_refunds where attempt_id = $1",
          [closedAttempt],
        );
        refundId = String(owed?.id);

        const sent = await sendOwedRefund(refundId, {
          refund: processedRefund(),
          now: NOW,
        });
        expect(sent.status).toBe("processed");

        const note = await issueCreditNote({
          kind: "refund",
          refundId,
          issuedBy: "system",
        });
        expect(note.outcome).toBe("issued");
        if (note.outcome !== "issued") return;
        noteId = note.note.id;
        expect(note.note.creditNoteRef).toMatch(/^CN\/\d{4}-\d{2}\/\d{5}$/);
        expect(note.note.creditNoteRef.length).toBeLessThanOrEqual(16);
        const parties = await one(
          "select parties ->> 'version' as v from public.billing_credit_notes where id = $1",
          [noteId],
        );
        expect(parties?.v).toBe("1");

        expect(await tellMerchantRefund(refundId, NOW)).toBe(true);
        expect(await tellMerchantRefund(refundId, NOW)).toBe(false);
        expect(refundEmails()).toHaveLength(1);

        const again = await issueCreditNote({
          kind: "refund",
          refundId,
          issuedBy: "system",
        });
        expect(again.outcome).toBe("exists");
      }, 30_000);

      it("T8, T9, T10b, T14c: a finished refund and its note stay as they are", async () => {
        const refund = processedRefund();
        expect(await sendOwedRefund(refundId, { refund, now: NOW })).toEqual({
          status: "not_claimed",
        });
        expect(refund).not.toHaveBeenCalled();

        const moved = await refused(
          "update public.billing_refunds set status = 'failed', failure_reason = 'x' where id = $1",
          [refundId],
          "app_service",
        );
        expect(moved?.code).toBe("P0001");
        const rewritten = await refused(
          "update public.billing_refunds set provider_refund_id = 'rfnd_other' where id = $1",
          [refundId],
          "app_service",
        );
        expect(rewritten?.code).toBe("P0001");
        const deleted = await refused(
          "delete from public.billing_refunds where id = $1",
          [refundId],
          "app_service",
        );
        expect(deleted?.code).toBe("42501");
        const edited = await refused(
          "update public.billing_credit_notes set issued_by = 'x' where id = $1",
          [noteId],
          "app_service",
        );
        expect(edited?.code).toBe("42501");
      }, 30_000);

      it("T6, T15a, T15b, T16, T28: the console's refusals, before anything is written", async () => {
        const refund = processedRefund();
        const base = {
          storeId: store,
          reason: "goodwill" as const,
          note: "probe",
          operator: OPERATOR,
          now: NOW,
          refund,
        };
        expect(
          await createOperatorRefund({
            ...base,
            invoiceId: closed,
            attemptId: closedAttempt,
            amountPaise: 100,
          }),
        ).toEqual({ ok: false, error: overCapMessage(0) });
        const inFlight = await createOperatorRefund({
          ...base,
          invoiceId: gst,
          attemptId: gstInFlight,
          amountPaise: 100,
        });
        expect(inFlight.ok).toBe(false);
        expect(!inFlight.ok && inFlight.error).toMatch(/went through/);
        const onDraft = await createOperatorRefund({
          ...base,
          invoiceId: draft,
          attemptId: draftAttempt,
          amountPaise: 100,
        });
        expect(onDraft.ok).toBe(false);
        expect(!onDraft.ok && onDraft.error).toMatch(/hasn't been issued/);
        expect(
          await createOperatorRefund({
            ...base,
            invoiceId: gst,
            attemptId: gstAttempt,
            amountPaise: 100,
            note: "   ",
          }),
        ).toEqual({ ok: false, error: NOTE_REQUIRED_MESSAGE });
        expect(
          await createOperatorRefund({
            ...base,
            invoiceId: gst,
            attemptId: gstAttempt,
            amountPaise: 99,
          }),
        ).toEqual({ ok: false, error: BELOW_MINIMUM_MESSAGE });
        expect(refund).not.toHaveBeenCalled();
        expect(
          await count(
            "select count(*) as n from public.billing_refunds where attempt_id = any($1::uuid[])",
            [[gstAttempt, gstInFlight, draftAttempt]],
          ),
        ).toBe(0);
      }, 30_000);

      it("T17: the system writes only the automatic reason", async () => {
        const wrote = await refused(
          `insert into public.billing_refunds
             (invoice_id, attempt_id, reason, status, amount_paise,
              idempotency_key, provider_payment_id, requested_by)
           values ($1, $2, 'goodwill', 'owed', 100, $3, $4, 'system')`,
          [gst, gstAttempt, `refunds-goodwill-${tag}`, pay("p_b")],
          "app_service",
        );
        expect(wrote?.code).toBe("23514");
      }, 30_000);

      it("T18 and T28: a bank transfer is recorded, under a rupee too, each with its GST note", async () => {
        const transfer = await recordRefundMadeOutside({
          storeId: store,
          invoiceId: gst,
          attemptId: gstAttempt,
          amountPaise: 100_000,
          method: "bank_transfer",
          reference: "UTR-PROBE-1",
          note: "Main feature cut; the merchant left.",
          operator: OPERATOR,
          reason: "feature_removed",
          now: NOW,
        });
        expect(transfer).toMatchObject({ ok: true, status: "recorded" });
        if (!transfer.ok) return;
        const note = await one(
          `select tax_rate_bps, supplier_gstin, credit_note_ref
             from public.billing_credit_notes where refund_id = $1`,
          [transfer.refundId],
        );
        expect(note).toMatchObject({
          tax_rate_bps: 1800,
          supplier_gstin: SUPPLIER_GSTIN,
        });

        const small = await recordRefundMadeOutside({
          storeId: store,
          invoiceId: gst,
          attemptId: gstAttempt,
          amountPaise: 99,
          method: "bank_transfer",
          reference: "UTR-PROBE-2",
          note: "Rounding difference returned.",
          operator: OPERATOR,
          reason: "goodwill",
          now: NOW,
        });
        expect(small).toMatchObject({ ok: true, status: "recorded" });
      }, 30_000);
    });

    describe("10b. T29: a repair item is filed once, ever", () => {
      const store = uuid();
      let invoiceId = "";

      isolated("case_10b_t29", async () => {
        await addStore(store, "Repair Once");
        await addSubscription(store, { state: "cancelled", cycle: 1 });
        invoiceId = await addInvoice({
          storeId: store,
          cycle: 2,
          status: "paid",
          finalizedAt: at(-3 * DAY),
          paidAt: at(-2 * HOUR),
        });
        await addAttempt({
          invoiceId,
          storeId: store,
          state: "captured",
          paymentId: pay("q"),
        });
      });

      const items = () =>
        count(
          `select count(*) as n from public.billing_reconciliation_items
            where invoice_id = $1 and kind = 'state_conflict'`,
          [invoiceId],
        );

      it("files the paid renewal of an ended plan for a person, and never refunds it", async () => {
        const refund = processedRefund();
        const summary = await processBillingRefunds({
          now: NOW,
          refund,
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({
          flaggedForPerson: 1,
          detected: 0,
          errors: 0,
        });
        expect(refund).not.toHaveBeenCalled();
        expect(await items()).toBe(1);
        const item = await one(
          "select detail ->> 'repair_key' as key from public.billing_reconciliation_items where invoice_id = $1",
          [invoiceId],
        );
        expect(item?.key).toBe(`paid_unreached:${invoiceId}`);
      }, 30_000);

      it("does not file it again once a person resolved it", async () => {
        await client.query(
          `update public.billing_reconciliation_items
              set status = 'resolved', resolved_at = now(), resolved_by = $2,
                  resolution_note = 'Kept: the merchant asked to keep the cycle.'
            where invoice_id = $1`,
          [invoiceId, OPERATOR],
        );
        const summary = await processBillingRefunds({
          now: at(HOUR),
          refund: processedRefund(),
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({ flaggedForPerson: 0, errors: 0 });
        expect(await items()).toBe(1);
      }, 30_000);
    });

    describe("10b. T30 and T31: the repair closes only an unpaid leftover, and finalize never reopens one", () => {
      const store = uuid();
      let draft = "";
      let inFlight = "";
      let leftover = "";
      let abandoned = "";

      isolated("case_10b_t30", async () => {
        await addStore(store, "Repair Probe R");
        await addSubscription(store, { state: "cancelled", cycle: 4 });
        draft = await addInvoice({ storeId: store, cycle: 5, status: "draft" });
        await addAttempt({
          invoiceId: draft,
          storeId: store,
          state: "processing",
        });
        inFlight = await addInvoice({
          storeId: store,
          cycle: 6,
          status: "open",
          finalizedAt: at(-2 * HOUR),
        });
        await addAttempt({
          invoiceId: inFlight,
          storeId: store,
          state: "processing",
        });
        leftover = await addInvoice({
          storeId: store,
          cycle: 7,
          status: "open",
          finalizedAt: at(-2 * HOUR),
        });
        await addAttempt({
          invoiceId: leftover,
          storeId: store,
          state: "failed",
        });
        // An enrolment the merchant gave up on: a five-day-old draft whose only
        // payment failed. Nothing is in flight, so only "never a draft" keeps
        // the repair off it.
        abandoned = await addInvoice({
          storeId: store,
          cycle: 8,
          status: "draft",
        });
        await addAttempt({
          invoiceId: abandoned,
          storeId: store,
          state: "failed",
        });
      });

      it("T30: voids only the issued, unpaid invoice with nothing in flight", async () => {
        const summary = await processBillingRefunds({
          now: NOW,
          refund: processedRefund(),
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({ repairedInvoices: 1, errors: 0 });
        const statuses = (
          await client.query(
            "select id, status from public.billing_invoices where store_id = $1",
            [store],
          )
        ).rows as { id: string; status: string }[];
        const byId = new Map(statuses.map((r) => [r.id, r.status]));
        expect(byId.get(draft)).toBe("draft");
        expect(byId.get(abandoned)).toBe("draft");
        expect(byId.get(inFlight)).toBe("open");
        expect(byId.get(leftover)).toBe("void");
      }, 30_000);

      it("T31: finalizing a draft someone voided by hand claims nothing and leaves it void", async () => {
        await client.query(
          "update public.billing_invoices set status = 'void' where id = $1",
          [draft],
        );
        const result = await finalizeInvoiceClaimed(draft, NOW);
        expect(result.claimed).toBe(false);
        expect(
          await one(
            "select status, finalized_at, invoice_ref from public.billing_invoices where id = $1",
            [draft],
          ),
        ).toMatchObject({
          status: "void",
          finalized_at: null,
          invoice_ref: null,
        });
      }, 30_000);
    });

    describe("10b. history: a payment kept before automatic refunds goes to a person, new money goes back", () => {
      const store = uuid();
      let historyAttempt = "";
      let newAttempt = "";

      isolated("case_10b_history", async () => {
        await addStore(store, "History Probe H");
        await addSubscription(store, { state: "downgraded", cycle: 1 });
        const old = await addInvoice({
          storeId: store,
          cycle: 2,
          status: "uncollectible",
          finalizedAt: at(-12 * DAY),
        });
        historyAttempt = await addAttempt({
          invoiceId: old,
          storeId: store,
          state: "captured",
          paymentId: pay("h_old"),
          resolvedAt: new Date(FROM.getTime() - DAY),
        });
        const recent = await addInvoice({
          storeId: store,
          cycle: 3,
          status: "uncollectible",
          finalizedAt: at(-9 * DAY),
        });
        newAttempt = await addAttempt({
          invoiceId: recent,
          storeId: store,
          state: "captured",
          paymentId: pay("h_new"),
          resolvedAt: new Date(FROM.getTime() + HOUR),
        });
      });

      it("files the one before the line and refunds the one after it", async () => {
        const refund = processedRefund();
        const summary = await processBillingRefunds({
          now: NOW,
          refund,
          fetchRefunds: null,
        });
        expect(summary).toMatchObject({
          flaggedForPerson: 1,
          detected: 1,
          processed: 1,
          errors: 0,
        });
        expect(refund).toHaveBeenCalledTimes(1);
        expect(refund.mock.calls[0][0].paymentId).toBe(pay("h_new"));
        expect(
          await count(
            "select count(*) as n from public.billing_reconciliation_items where detail ->> 'repair_key' = $1",
            [`kept_before_refunds:${historyAttempt}`],
          ),
        ).toBe(1);
        expect(
          await count(
            "select count(*) as n from public.billing_refunds where attempt_id = $1",
            [historyAttempt],
          ),
        ).toBe(0);
        expect(
          await one(
            "select requested_by, status from public.billing_refunds where attempt_id = $1",
            [newAttempt],
          ),
        ).toMatchObject({ requested_by: "system", status: "processed" });
      }, 30_000);
    });
  },
);
