/* eslint-disable @typescript-eslint/no-explicit-any */
/** The automatic renewal, run hour by hour on dummy stores whose subscriptions
 * began months ago, against local Postgres and a simulated Razorpay.
 *
 * Each scenario seeds one store (created a hundred days ago, three paid cycles
 * behind it, its fourth ending in four days), then runs the hourly billing
 * job's own passes in the job's own order (collect, debits, reconcile,
 * evaluate, downgrade) once for every simulated hour, and reads the rows the
 * real code wrote.
 *
 * ★ RUN IT WITH `npm run billing:scenarios:local`. The suite is opt-in
 *   (BILLING_RENEWAL_LOCAL_TEST=1): through plain `vitest` every check is
 *   reported as SKIPPED, which is not a pass.
 *
 * ★ REAL: every billing module, the SQL each one sends, the constraints and
 *   triggers of the local schema, and `lib/billing/gateway.ts` itself.
 * ★ SIMULATED: Razorpay's HTTP API only (`lib/payments/razorpay`), with the
 *   rules it was SEEN to enforce in test mode on 21 and 22 Nov 2026: an order
 *   needs its notification to be debited; a notice is delivered about a
 *   minute after the order; a card may be debited 36 hours after delivery and
 *   UPI 25; an order asking for an earlier debit is refused; a debit answers
 *   with a payment id and nothing else; only a `confirmed` token is debited;
 *   a card token's `expired_at` is the end of the current month.
 * ★ The simulator FAILS THE RUN on what must never happen: a debit before its
 *   notice period, or a second debit on one order.
 * ★ Nothing reaches a network (Razorpay is in memory, email and notifications
 *   are recorded, `fetch` throws), the fixed loopback database keeps it away
 *   from Cloud SQL, and everything happens inside one transaction that is
 *   rolled back: an issued invoice can never be deleted, so dummy invoices
 *   are never committed. */
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
    const name = `renewal_local_${++service.count}`;
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
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
/** Every email the code under test sent. ★ A plain list, not a mock's call
 *  record: the suite clears mocks between tests, and a scenario's steps read
 *  what earlier steps sent. */
const outbox = vi.hoisted(() => [] as { to: string; subject: string }[]);
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: async (input: { to: unknown; subject: unknown }) => {
      outbox.push({ to: String(input.to), subject: String(input.subject) });
      return { sent: true };
    },
  };
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

// ───────────────────────────────────────────────────────────────────────────
// The simulated Razorpay.
// ───────────────────────────────────────────────────────────────────────────

type DebitOutcome =
  /** 200 with a payment id; the payment is captured. */
  | "success"
  /** 200 with a payment id; the payment then fails at the bank. */
  | "failed_later"
  /** 4xx: the debit is refused outright. */
  | "declined"
  /** No answer, and the money moved. */
  | "timeout_captured"
  /** No answer, and nothing happened. */
  | "timeout_nothing";

interface SimPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  /** Set on the payment that registered a mandate. */
  token_id?: string | null;
  customer_id?: string | null;
  method?: string | null;
}
interface SimOrder {
  id: string;
  amount: number;
  receipt: string | null;
  tokenId: string | null;
  createdAt: number;
  notice: { requested: number; deliverAt: number | null } | null;
  /** Set on a mandate's authorisation order (the first payment). */
  auth: {
    method: "card" | "upi";
    customerId: string;
    frequency: string;
    maxAmount: number;
    expireAt: number;
  } | null;
  payments: SimPayment[];
}
interface SimToken {
  method: "card" | "upi";
  status: string;
  /** Unix seconds, as the token read reports it. */
  expiredAt: number | null;
}

const sim = vi.hoisted(() => {
  const HOUR = 3_600_000;
  return {
    HOUR,
    /** The simulated instant, set before every pass. */
    now: 0,
    seq: 0,
    /** Token and order reads fail, as during an outage. */
    silent: false,
    /** The next N notices are never delivered. */
    dropNotices: 0,
    tokens: new Map<string, SimToken>(),
    orders: new Map<string, SimOrder>(),
    /** What each token's next debits answer; `success` when empty. */
    plans: new Map<string, DebitOutcome[]>(),
    /** Every debit call that reached the gateway. */
    debits: [] as { orderId: string; tokenId: string; at: number }[],
    /** What must never happen. */
    earlyDebits: 0,
    doubleDebits: 0,
    noticeHours(method: string | undefined) {
      return method === "upi" ? 25 : 36;
    },
    reset() {
      this.silent = false;
      this.dropNotices = 0;
      this.tokens.clear();
      this.orders.clear();
      this.plans.clear();
      this.debits.length = 0;
      this.earlyDebits = 0;
      this.doubleDebits = 0;
    },
  };
});

vi.mock("@/lib/payments/razorpay", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/payments/razorpay")>();
  const rejected = (error: string) => ({
    ok: false as const,
    error,
    outcome: "rejected" as const,
  });
  const unknown = (error: string) => ({
    ok: false as const,
    error,
    outcome: "unknown" as const,
  });
  const delivered = (order: SimOrder) =>
    !!order.notice &&
    order.notice.deliverAt !== null &&
    sim.now >= order.notice.deliverAt;
  const view = (order: SimOrder) => {
    const paid = order.payments
      .filter((p) => p.status === "captured")
      .reduce((sum, p) => sum + p.amount, 0);
    const token = order.tokenId ? sim.tokens.get(order.tokenId) : undefined;
    const notice = order.notice;
    return {
      id: order.id,
      amount: order.amount,
      currency: "INR",
      receipt: order.receipt,
      status:
        paid > 0 ? "paid" : order.payments.length ? "attempted" : "created",
      method: order.auth?.method ?? null,
      token: order.auth
        ? {
            max_amount: order.auth.maxAmount,
            expire_at: order.auth.expireAt,
            frequency: order.auth.frequency,
          }
        : undefined,
      attempts: order.payments.length,
      amount_paid: paid,
      notification: notice
        ? {
            id: `notif_${order.id}`,
            token_id: order.tokenId ?? undefined,
            // ★ Seen in test mode: for UPI Razorpay rewrites `payment_after`
            // to exactly 25 hours after the notice was delivered.
            payment_after:
              token?.method === "upi" && delivered(order)
                ? Math.floor(notice.deliverAt! / 1000) + 25 * 3600
                : notice.requested,
            status: delivered(order) ? "delivered" : "created",
            delivered_at: delivered(order)
              ? Math.floor(notice.deliverAt! / 1000)
              : null,
          }
        : null,
    };
  };
  return {
    ...actual,
    rzpCreateOrder: vi.fn(async (_creds: unknown, params: any) => {
      const id = `order_sim_${++sim.seq}`;
      let notice: SimOrder["notice"] = null;
      let tokenId: string | null = null;
      if (params.notification) {
        tokenId = params.notification.tokenId;
        const token = sim.tokens.get(tokenId!);
        if (!token) return rejected("The id provided does not exist");
        const hours = sim.noticeHours(token.method);
        // ★ Seen in test mode: exactly the notice period ahead is refused.
        if (
          params.notification.paymentAfterUnix * 1000 <=
          sim.now + hours * sim.HOUR
        ) {
          return rejected(
            `Debit can be attempted ${hours} hours after sending the pre-debit notification`,
          );
        }
        const dropped = sim.dropNotices > 0;
        if (dropped) sim.dropNotices -= 1;
        notice = {
          requested: params.notification.paymentAfterUnix,
          deliverAt: dropped ? null : sim.now + 60_000,
        };
      }
      const order: SimOrder = {
        id,
        amount: params.amountPaise,
        receipt: params.receipt ?? null,
        tokenId,
        createdAt: sim.now,
        notice,
        auth: null,
        payments: [],
      };
      sim.orders.set(id, order);
      return { ok: true as const, data: view(order) };
    }),
    rzpCreateCustomer: vi.fn(async (_creds: unknown, params: any) => {
      if (!params.email && !params.contact) {
        return rejected("A customer needs an email or a phone number.");
      }
      // One customer per contact, as Razorpay returns on a second call.
      const key = String(params.email ?? params.contact);
      const id = `cust_sim_${key.replace(/[^a-z0-9]/gi, "").slice(0, 14)}`;
      return { ok: true as const, data: { id } };
    }),
    rzpCreateAuthorizationOrder: vi.fn(async (_creds: unknown, params: any) => {
      const id = `order_sim_${++sim.seq}`;
      const order: SimOrder = {
        id,
        amount: params.amountPaise,
        receipt: params.receipt ?? null,
        tokenId: null,
        createdAt: sim.now,
        notice: null,
        auth: {
          method: params.method,
          customerId: params.customerId,
          frequency: params.terms.frequency,
          maxAmount: params.terms.maxAmountPaise,
          expireAt: params.terms.expireAtUnix,
        },
        payments: [],
      };
      sim.orders.set(id, order);
      return { ok: true as const, data: view(order) };
    }),
    rzpFetchOrder: vi.fn(async (_creds: unknown, orderId: string) => {
      if (sim.silent) return unknown("timeout");
      const order = sim.orders.get(orderId);
      // An order this run did not create belongs to someone else's data.
      if (!order) return unknown(`${orderId} is not in this test's gateway`);
      return { ok: true as const, data: view(order) };
    }),
    rzpFetchOrderPayments: vi.fn(async (_creds: unknown, orderId: string) => {
      if (sim.silent) return unknown("timeout");
      const order = sim.orders.get(orderId);
      if (!order) return unknown(`${orderId} is not in this test's gateway`);
      return { ok: true as const, data: order.payments };
    }),
    rzpFetchPayment: vi.fn(async (_creds: unknown, paymentId: string) => {
      for (const order of sim.orders.values()) {
        const payment = order.payments.find((p) => p.id === paymentId);
        if (payment) {
          return {
            ok: true as const,
            data: {
              ...payment,
              method: payment.method ?? "upi",
              created_at: Math.floor(sim.now / 1000),
              token_id: payment.token_id ?? null,
              customer_id: payment.customer_id ?? null,
            },
          };
        }
      }
      return unknown(`${paymentId} is not in this test's gateway`);
    }),
    rzpFetchToken: vi.fn(
      async (_creds: unknown, _customerId: string, tokenId: string) => {
        if (sim.silent) return unknown("timeout");
        const token = sim.tokens.get(tokenId);
        // ★ Seen in test mode for a token that does not exist.
        if (!token) return rejected("The id provided does not exist");
        return {
          ok: true as const,
          data: {
            id: tokenId,
            method: token.method,
            recurring: true,
            recurring_details: { status: token.status, failure_reason: null },
            max_amount: 500_000,
            expired_at: token.expiredAt,
          },
        };
      },
    ),
    rzpChargeMandate: vi.fn(async (_creds: unknown, params: any) => {
      const order = sim.orders.get(params.orderId);
      // ★ Seen in test mode for an order created without its notification.
      if (!order || !order.notice) {
        return rejected("The requested URL was not found on the server.");
      }
      sim.debits.push({
        orderId: order.id,
        tokenId: params.tokenId,
        at: sim.now,
      });
      const token = sim.tokens.get(params.tokenId);
      if (!token || order.tokenId !== params.tokenId) {
        return rejected("The id provided does not exist");
      }
      if (!params.email || !params.contact) {
        return rejected("The contact field is required.");
      }
      if (!delivered(order)) return rejected("pre_debit_notification_failed");
      const hours = sim.noticeHours(token.method);
      if (sim.now < order.notice.deliverAt! + hours * sim.HOUR) {
        sim.earlyDebits += 1;
        return rejected(
          `Debit can be attempted ${hours} hours after sending the pre-debit notification`,
        );
      }
      if (order.payments.some((p) => p.status !== "failed")) {
        sim.doubleDebits += 1;
        return rejected("A payment already exists on this order.");
      }
      if (token.status !== "confirmed") {
        return rejected("The token is not in the confirmed state.");
      }
      const outcome = sim.plans.get(params.tokenId)?.shift() ?? "success";
      const payment = (status: string): SimPayment => ({
        id: `pay_sim_${++sim.seq}`,
        order_id: order.id,
        amount: order.amount,
        currency: "INR",
        status,
      });
      if (outcome === "declined") {
        order.payments.push(payment("failed"));
        return rejected("Your payment was declined by the bank.");
      }
      if (outcome === "timeout_nothing") return unknown("timeout");
      if (outcome === "timeout_captured") {
        order.payments.push(payment("captured"));
        return unknown("timeout");
      }
      const made = payment(outcome === "failed_later" ? "failed" : "captured");
      order.payments.push(made);
      // ★ The documented success body: the payment id and nothing else.
      return { ok: true as const, data: { razorpay_payment_id: made.id } };
    }),
    verifyCheckoutSignature: vi.fn(() => true),
    verifyCapturedCheckoutPayment: vi.fn(
      async (
        _creds: unknown,
        input: { paymentId: string; orderId: string },
      ) => {
        const order = sim.orders.get(input.orderId);
        const payment = order?.payments.find((p) => p.id === input.paymentId);
        return payment?.status === "captured"
          ? { ok: true as const, gatewayRead: true as const }
          : { ok: false as const, error: "The payment is not captured." };
      },
    ),
  };
});

import {
  cancelAtPeriodEnd,
  getSubscriptionView,
  resumeSubscription,
} from "./cancel";
import {
  GATEWAY_SILENCE_DEADLINE_HOURS,
  NOTICE_DELIVERY_DEADLINE_HOURS,
  sendDueDebits,
} from "./debit-pass";
import { MANDATE_FREQUENCY, confirmEnrolment, startEnrolment } from "./enrol";
import { razorpayRecurringGateway } from "./gateway";
import {
  ALREADY_CAPTURED_INVOICE_MESSAGE,
  PAYMENT_BEING_CONFIRMED_MESSAGE,
  PAYMENT_IN_PROGRESS_MESSAGE,
  confirmInvoicePayment,
  listPayableInvoices,
  startInvoicePayment,
} from "./manual-pay";
import { reconcileStrandedAttempts } from "./reconcile";
import {
  MANDATE_CHECK_HOLD_HOURS,
  collectDueRenewals,
  downgradeExpired,
  evaluateCycleTurns,
} from "./renewal-worker";

const enabled = process.env.BILLING_RENEWAL_LOCAL_TEST === "1";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The run's clock, on a whole minute: "the present" of every scenario. */
const NOW = new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
const at = (ms: number) => new Date(NOW.getTime() + ms);

/** The current cycle ends in four days less an hour, so collection opened an
 *  hour ago: the next hourly run is the one that issues the renewal. */
const CYCLE_END = at(4 * DAY - HOUR);

const PLAN_PAISE = 240_000;
const YEARLY_PAISE = 2_400_000;
const uuid = () => crypto.randomUUID();
const tag = uuid().slice(0, 8);

const priceFor = async (_plan: string, period: string) => ({
  planPaise: period === "yearly" ? YEARLY_PAISE : PLAN_PAISE,
  locationPaise: 0,
  planLabel: "Pro",
});

interface DummyStore {
  storeId: string;
  mandateId: string;
  tokenId: string;
  customerId: string;
  email: string;
  rail: "card" | "upi";
}

describe.skipIf(!enabled)(
  "the automatic renewal, hour by hour, on subscriptions that began months ago (local database)",
  () => {
    let client: Client;
    /** The simulated hour the scenario has reached. */
    let cursor = NOW;
    /** Errors any pass reported in this scenario. */
    let errors = 0;
    const mine: string[] = [];

    const rows = async (sqlText: string, params: unknown[] = []) =>
      (await client.query(sqlText, params)).rows as Record<string, any>[];
    const one = async (sqlText: string, params: unknown[] = []) =>
      (await rows(sqlText, params))[0] ?? null;

    /** Give a scenario its own savepoint and a clean gateway. */
    function scenario(name: string, setup: () => Promise<void>) {
      beforeAll(async () => {
        await client.query(`SAVEPOINT ${name}`);
        sim.reset();
        sim.now = NOW.getTime();
        outbox.length = 0;
        cursor = NOW;
        errors = 0;
        mine.length = 0;
        await setup();
      });
      afterAll(async () => {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await client.query(`RELEASE SAVEPOINT ${name}`);
      });
    }

    /**
     * A dummy store that has been a paying customer for three months: created
     * a hundred days ago, subscribed ninety-six days ago, three thirty-day
     * cycles paid, the fourth ending in four days.
     */
    async function addStore(
      opts: {
        rail?: "card" | "upi";
        period?: "monthly" | "yearly";
        tokenStatus?: string;
        /** Unix seconds; a card's defaults to the end of this month. */
        tokenExpiredAt?: number | null;
        /** The mandate's ceiling; ₹5,000 unless a scenario needs another. */
        mandateMaxPaise?: number;
      } = {},
    ): Promise<DummyStore> {
      const storeId = uuid();
      const mandateId = uuid();
      const rail = opts.rail ?? "card";
      const period = opts.period ?? "monthly";
      const length = period === "yearly" ? 365 * DAY : 30 * DAY;
      const tokenId = `token_sim_${storeId.slice(0, 8)}`;
      const customerId = `cust_sim_${storeId.slice(0, 8)}`;
      const email = `renewal-${storeId.slice(0, 8)}@probe.test`;
      const periodStart = new Date(CYCLE_END.getTime() - length);
      const subscribedAt = new Date(periodStart.getTime() - 3 * length);
      const createdAt = new Date(subscribedAt.getTime() - 4 * DAY);

      await client.query(
        `insert into public.stores (id, name, slug, plan, plan_source, created_at)
         values ($1, $2, $3, 'pro', 'paid', $4)`,
        [
          storeId,
          `Dummy ${rail} ${storeId.slice(0, 4)}`,
          `renewal-${tag}-${storeId.slice(0, 8)}`,
          createdAt.toISOString(),
        ],
      );
      await client.query(
        `insert into public.store_billing_settings
           (store_id, business_name, contact_email, contact_phone)
         values ($1, 'Dummy Traders', $2, '9876543210')`,
        [storeId, email],
      );
      await client.query(
        `insert into public.admins (id, email, role, phone, store_id, first_name)
         values ($1, $2, 'superadmin', '9876543210', $3, 'Dummy')`,
        [`renewal-${storeId}`, email, storeId],
      );
      await client.query(
        `insert into public.billing_mandates
           (id, store_id, provider_customer_id, provider_token_id, method,
            status, max_amount_paise, authenticated_at, created_at)
         values ($1, $2, $3, $4, $5, 'active', $7, $6, $6)`,
        [
          mandateId,
          storeId,
          customerId,
          tokenId,
          rail,
          subscribedAt.toISOString(),
          opts.mandateMaxPaise ?? 500_000,
        ],
      );
      await client.query(
        `insert into public.billing_subscriptions
           (store_id, plan, period, state, current_cycle_seq,
            current_period_start, current_period_end, mandate_id, plan_source,
            created_at)
         values ($1, 'pro', $2, 'active', 4, $3, $4, $5, 'paid', $6)`,
        [
          storeId,
          period,
          periodStart.toISOString(),
          CYCLE_END.toISOString(),
          mandateId,
          subscribedAt.toISOString(),
        ],
      );

      const monthEnd = new Date(
        Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 1),
      );
      sim.tokens.set(tokenId, {
        method: rail,
        status: opts.tokenStatus ?? "confirmed",
        expiredAt:
          opts.tokenExpiredAt !== undefined
            ? opts.tokenExpiredAt
            : rail === "card"
              ? Math.floor(monthEnd.getTime() / 1000) - 1
              : Math.floor((NOW.getTime() + 5 * 365 * DAY) / 1000),
      });
      mine.push(storeId);
      return { storeId, mandateId, tokenId, customerId, email, rail };
    }

    /**
     * A dummy store on the Free plan, created two months ago, with an owner
     * who has an email and a phone: what a merchant is before they subscribe.
     */
    async function addFreeStore(): Promise<DummyStore> {
      const storeId = uuid();
      const email = `renewal-${storeId.slice(0, 8)}@probe.test`;
      await client.query(
        `insert into public.stores (id, name, slug, plan, created_at)
         values ($1, $2, $3, 'free', $4)`,
        [
          storeId,
          `Dummy signup ${storeId.slice(0, 4)}`,
          `renewal-${tag}-${storeId.slice(0, 8)}`,
          at(-60 * DAY).toISOString(),
        ],
      );
      await client.query(
        `insert into public.store_billing_settings
           (store_id, business_name, contact_email, contact_phone)
         values ($1, 'Dummy Traders', $2, '9876543210')`,
        [storeId, email],
      );
      await client.query(
        `insert into public.admins (id, email, role, phone, store_id, first_name)
         values ($1, $2, 'superadmin', '9876543210', $3, 'Dummy')`,
        [`renewal-${storeId}`, email, storeId],
      );
      mine.push(storeId);
      return {
        storeId,
        mandateId: "",
        tokenId: "",
        customerId: "",
        email,
        rail: "upi",
      };
    }

    /**
     * The merchant approves the first payment in Razorpay's checkout: the
     * payment is captured and the gateway registers the mandate's token.
     */
    function authoriseInCheckout(orderId: string) {
      const order = sim.orders.get(orderId)!;
      if (!order.auth) throw new Error("Not a mandate authorisation order.");
      const tokenId = `token_sim_${++sim.seq}`;
      sim.tokens.set(tokenId, {
        method: order.auth.method,
        status: "confirmed",
        expiredAt: order.auth.expireAt,
      });
      const payment: SimPayment = {
        id: `pay_sim_${++sim.seq}`,
        order_id: orderId,
        amount: order.amount,
        currency: "INR",
        status: "captured",
        token_id: tokenId,
        customer_id: order.auth.customerId,
        method: order.auth.method,
      };
      order.payments.push(payment);
      return { payment, tokenId };
    }

    /** The merchant pays an open invoice by hand, start to finish. */
    async function payByHand(s: DummyStore, cycle: number) {
      const invoiceId = (await invoice(s, cycle))!.id as string;
      const start = await startInvoicePayment({
        storeId: s.storeId,
        invoiceId,
        now: cursor,
      });
      if (!start.ok) throw new Error(start.error);
      await stamp(cursor);
      const payment = payInCheckout(start.data.providerOrderId);
      return confirmInvoicePayment({
        storeId: s.storeId,
        invoiceId,
        providerPaymentId: payment.id,
        signature: "sig",
        now: cursor,
      });
    }

    /**
     * An attempt's `created_at` is the database's own clock, which stands
     * still inside one transaction. Put new attempts on the simulated clock,
     * so "24 hours between tries" and "the newest attempt" mean what they
     * mean in production.
     */
    async function stamp(t: Date) {
      await client.query(
        `update public.billing_payment_attempts
            set created_at = $1
          where store_id = any($2::uuid[])
            and created_at = transaction_timestamp()`,
        [t.toISOString(), mine],
      );
    }

    /** One run of the hourly billing job, in the job's own order. */
    async function tick(t: Date) {
      sim.now = t.getTime();
      const collect = await collectDueRenewals({
        now: t,
        charge: razorpayRecurringGateway,
        priceFor: priceFor as any,
      });
      await stamp(t);
      const debits = await sendDueDebits({
        gateway: razorpayRecurringGateway,
        now: t,
      });
      const reconcile = await reconcileStrandedAttempts({ now: t });
      const evaluate = await evaluateCycleTurns({
        now: t,
        autopayConfigured: true,
      } as any);
      const downgrade = await downgradeExpired({ now: t });
      errors +=
        collect.errors +
        debits.errors +
        reconcile.errors +
        evaluate.errors +
        downgrade.errors;
      cursor = t;
    }

    /** Run the job every hour up to and including `until`. */
    async function runTo(until: Date) {
      // The first run of a scenario happens at "now".
      if (cursor.getTime() === NOW.getTime() && sim.debits.length === 0) {
        const started = await one(
          "select count(*)::int as n from public.billing_invoices where store_id = any($1::uuid[])",
          [mine],
        );
        if (started?.n === 0) await tick(NOW);
      }
      while (cursor.getTime() + HOUR <= until.getTime()) {
        await tick(new Date(cursor.getTime() + HOUR));
      }
    }

    const subscription = (s: DummyStore) =>
      one(
        `select state, current_cycle_seq as cycle, cancel_at_period_end as cancelling,
                (extract(epoch from current_period_start) * 1000)::bigint as period_start,
                (extract(epoch from current_period_end) * 1000)::bigint as period_end,
                (extract(epoch from grace_ends_at) * 1000)::bigint as grace_ends
           from public.billing_subscriptions where store_id = $1`,
        [s.storeId],
      );
    const invoice = (s: DummyStore, cycle = 5) =>
      one(
        `select id, status, total_paise, invoice_ref, finalized_at is not null as issued
           from public.billing_invoices
          where store_id = $1 and kind = 'subscription' and cycle_seq = $2`,
        [s.storeId, cycle],
      );
    const attempts = (s: DummyStore, cycle = 5) =>
      rows(
        `select a.id, a.mode, a.state, a.failure_code, a.provider_order_id,
                a.provider_payment_id,
                (extract(epoch from a.debit_after) * 1000)::bigint as debit_after,
                (extract(epoch from a.debit_sent_at) * 1000)::bigint as debit_sent_at,
                (extract(epoch from a.created_at) * 1000)::bigint as created_at
           from public.billing_payment_attempts a
           join public.billing_invoices i on i.id = a.invoice_id
          where i.store_id = $1 and i.cycle_seq = $2
          order by a.created_at, a.id`,
        [s.storeId, cycle],
      );
    const mandate = async (s: DummyStore) =>
      (
        await one(
          `select status from public.billing_mandates
            where store_id = $1 order by created_at desc limit 1`,
          [s.storeId],
        )
      )?.status as string;
    const storePlan = async (s: DummyStore) =>
      (await one("select plan from public.stores where id = $1", [s.storeId]))
        ?.plan as string;
    /** Subjects of the emails this store has been sent, in order. */
    const emails = (s: DummyStore) =>
      outbox
        .filter((mail) => mail.to.includes(s.email))
        .map((mail) => mail.subject);
    const debitsOf = (s: DummyStore) =>
      sim.debits.filter((d) => d.tokenId === s.tokenId);
    /** The merchant completes a checkout on this order. */
    function payInCheckout(orderId: string, status = "captured") {
      const order = sim.orders.get(orderId)!;
      const payment: SimPayment = {
        id: `pay_sim_${++sim.seq}`,
        order_id: orderId,
        amount: order.amount,
        currency: "INR",
        status,
      };
      order.payments.push(payment);
      return payment;
    }

    /** What every scenario must leave true, whatever else it checks. */
    function invariants() {
      it("★★ no debit was ever sent before its notice period, none twice on one order, and no pass reported an error", () => {
        expect(sim.earlyDebits).toBe(0);
        expect(sim.doubleDebits).toBe(0);
        const perOrder = new Map<string, number>();
        for (const d of sim.debits) {
          perOrder.set(d.orderId, (perOrder.get(d.orderId) ?? 0) + 1);
        }
        expect([...perOrder.values()].every((n) => n === 1)).toBe(true);
        expect(errors).toBe(0);
      });
    }

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.BILLING_RENEWAL_LOCAL_TEST_USER || process.env.USER,
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

    // ─────────────────────────────────────────────────────────────────────
    describe("1. a card renewal that simply works", () => {
      let s: DummyStore;
      scenario("s1", async () => {
        s = await addStore({ rail: "card" });
      });

      it("the first run issues the invoice, sends the bank's notice and takes no money", async () => {
        await runTo(NOW);
        expect(await invoice(s)).toMatchObject({
          status: "processing",
          total_paise: String(PLAN_PAISE),
          issued: true,
        });
        const [attempt] = await attempts(s);
        expect(attempt).toMatchObject({
          mode: "automatic",
          state: "processing",
        });
        expect(attempt.provider_order_id).toMatch(/^order_sim_/);
        // The debit is set for 36 hours 30 minutes after the notice.
        expect(Number(attempt.debit_after) - NOW.getTime()).toBe(
          36 * HOUR + 30 * MINUTE,
        );
        expect(attempt.debit_sent_at).toBeNull();
        expect(debitsOf(s)).toHaveLength(0);
        // The one issue notice says autopay will take it.
        expect(emails(s)).toHaveLength(1);
        expect(emails(s)[0]).toMatch(/^Your Pro plan renews on /);
      });

      it("Plans & Billing shows it as a scheduled renewal, not as a bill or a payment in progress", async () => {
        const [payable] = await listPayableInvoices(s.storeId);
        expect(payable).toMatchObject({
          status: "processing",
          resumable: false,
        });
        expect(Date.parse(payable.autopayAt!)).toBe(
          NOW.getTime() + 36 * HOUR + 30 * MINUTE,
        );
        // And the cancel wording reads it as an invoice that won't be charged.
        const view = await getSubscriptionView(s.storeId);
        expect(view.nextInvoice).toMatchObject({
          status: "open",
          inFlight: false,
        });
      });

      it("★★ thirty-six hourly runs later, still nothing has been debited", async () => {
        await runTo(at(36 * HOUR));
        expect(debitsOf(s)).toHaveLength(0);
        expect((await attempts(s))[0]).toMatchObject({
          state: "processing",
          debit_sent_at: null,
        });
      });

      it("★★ the debit is sent once, after the notice period, and the invoice is paid", async () => {
        await runTo(at(38 * HOUR));
        expect(debitsOf(s)).toHaveLength(1);
        expect(debitsOf(s)[0].at - NOW.getTime()).toBe(37 * HOUR);
        const [attempt] = await attempts(s);
        expect(attempt.state).toBe("captured");
        expect(attempt.provider_payment_id).toMatch(/^pay_sim_/);
        expect((await invoice(s))?.status).toBe("paid");
      });

      it("the plan is not interrupted, and the cycle turns on its own day into a new 30-day cycle", async () => {
        expect(await subscription(s)).toMatchObject({
          state: "active",
          cycle: 4,
        });
        await runTo(new Date(CYCLE_END.getTime() + HOUR));
        const sub = await subscription(s);
        expect(sub).toMatchObject({ state: "active", cycle: 5 });
        expect(Number(sub!.period_start)).toBe(CYCLE_END.getTime());
        expect(Number(sub!.period_end)).toBe(CYCLE_END.getTime() + 30 * DAY);
        expect(await storePlan(s)).toBe("pro");
      });

      it("★★ a further week of hourly runs debits nothing more", async () => {
        await runTo(new Date(CYCLE_END.getTime() + 7 * DAY));
        expect(debitsOf(s)).toHaveLength(1);
        expect(await attempts(s)).toHaveLength(1);
        // No dunning of any kind was sent.
        expect(
          emails(s).filter((subject) => /Action needed|overdue/i.test(subject)),
        ).toEqual([]);
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("2. a UPI Autopay renewal: 25 hours' notice, not 24", () => {
      let s: DummyStore;
      scenario("s2", async () => {
        s = await addStore({ rail: "upi" });
      });

      it("★★ Razorpay accepts the renewal's order: it asks for a debit 25 h 30 min ahead", async () => {
        await runTo(NOW);
        const [attempt] = await attempts(s);
        // A refused order would be a failed attempt with no order.
        expect(attempt).toMatchObject({ state: "processing" });
        expect(Number(attempt.debit_after) - NOW.getTime()).toBe(
          25 * HOUR + 30 * MINUTE,
        );
      });

      it("nothing is debited through the first 25 hours", async () => {
        await runTo(at(25 * HOUR));
        expect(debitsOf(s)).toHaveLength(0);
      });

      it("the debit goes out at the next run, and the invoice is paid", async () => {
        await runTo(at(27 * HOUR));
        expect(debitsOf(s)).toHaveLength(1);
        expect(debitsOf(s)[0].at - NOW.getTime()).toBe(26 * HOUR);
        expect((await invoice(s))?.status).toBe("paid");
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("3. a card that declines every time: three tries, one email, grace, then the Free plan", () => {
      let s: DummyStore;
      scenario("s3", async () => {
        s = await addStore({ rail: "card" });
        sim.plans.set(s.tokenId, ["declined", "declined", "declined"]);
      });

      it("the first try fails at its debit, and the merchant is not told yet", async () => {
        await runTo(at(38 * HOUR));
        expect(debitsOf(s)).toHaveLength(1);
        const list = await attempts(s);
        expect(list[0]).toMatchObject({
          state: "failed",
          failure_code: "gateway_rejected",
        });
        expect(
          emails(s).filter((subject) => /Action needed/.test(subject)),
        ).toEqual([]);
      });

      it("★ each further try gets its own order and its own notice", async () => {
        await runTo(at(80 * HOUR));
        const list = await attempts(s);
        expect(list.length).toBeGreaterThanOrEqual(3);
        expect(new Set(list.map((a) => a.provider_order_id)).size).toBe(
          list.length,
        );
      });

      it("★★ while the third try is still under way the cycle turns, and NO grace starts", async () => {
        await runTo(new Date(CYCLE_END.getTime() + HOUR));
        expect((await invoice(s))?.status).toBe("processing");
        expect(await subscription(s)).toMatchObject({
          state: "active",
          cycle: 4,
          grace_ends: null,
        });
        expect(await storePlan(s)).toBe("pro");
      });

      it("★★ exactly three debits, at least 36 hours apart, and then no more", async () => {
        await runTo(new Date(CYCLE_END.getTime() + 2 * DAY));
        const sent = debitsOf(s);
        expect(sent).toHaveLength(3);
        expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(36 * HOUR);
        expect(sent[2].at - sent[1].at).toBeGreaterThanOrEqual(36 * HOUR);
        const list = await attempts(s);
        expect(list).toHaveLength(3);
        expect(list.every((a) => a.state === "failed")).toBe(true);
        expect((await invoice(s))?.status).toBe("open");
      });

      it("★★ the merchant is asked to pay by hand exactly once", async () => {
        expect(
          emails(s).filter((subject) => /^Action needed: pay /.test(subject)),
        ).toHaveLength(1);
      });

      it("grace is 48 hours from when the failure was known", async () => {
        const sub = await subscription(s);
        expect(["past_due", "grace"]).toContain(sub!.state);
        const lastDebit = debitsOf(s)[2].at;
        // Opened by the run that saw the unpaid invoice after the cycle turned.
        expect(Number(sub!.grace_ends) - lastDebit).toBeGreaterThanOrEqual(
          48 * HOUR,
        );
        expect(Number(sub!.grace_ends) - lastDebit).toBeLessThanOrEqual(
          50 * HOUR,
        );
        expect(await storePlan(s)).toBe("pro");
      });

      it("the invoice can be paid by hand during grace", async () => {
        const [payable] = await listPayableInvoices(s.storeId);
        expect(payable).toMatchObject({
          status: "open",
          autopayAt: null,
          resumable: false,
        });
      });

      it("★★ unpaid when grace ends: the store moves to the Free plan, and nothing more is ever debited", async () => {
        const sub = await subscription(s);
        await runTo(new Date(Number(sub!.grace_ends) + 2 * HOUR));
        expect(await storePlan(s)).toBe("free");
        expect((await subscription(s))?.state).toBe("downgraded");
        expect((await invoice(s))?.status).toBe("uncollectible");
        await runTo(new Date(cursor.getTime() + 3 * DAY));
        expect(debitsOf(s)).toHaveLength(3);
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("4. a debit that fails at the bank, then succeeds on the second try", () => {
      let s: DummyStore;
      scenario("s4", async () => {
        s = await addStore({ rail: "card" });
        sim.plans.set(s.tokenId, ["failed_later", "success"]);
      });

      it("the bank's failure is read back, and a second try with a new notice is started", async () => {
        await runTo(at(40 * HOUR));
        const list = await attempts(s);
        expect(list[0].state).toBe("failed");
        expect(list[1]).toMatchObject({
          state: "processing",
          debit_sent_at: null,
        });
        expect((await invoice(s))?.status).toBe("processing");
      });

      it("★★ the second debit pays the invoice before the cycle turns: two debits in all, no dunning", async () => {
        await runTo(at(80 * HOUR));
        expect(debitsOf(s)).toHaveLength(2);
        expect((await invoice(s))?.status).toBe("paid");
        expect(
          emails(s).filter((subject) => /Action needed/.test(subject)),
        ).toEqual([]);
        await runTo(new Date(CYCLE_END.getTime() + HOUR));
        expect(await subscription(s)).toMatchObject({
          state: "active",
          cycle: 5,
        });
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("5. a debit that timed out although the money moved", () => {
      let s: DummyStore;
      scenario("s5", async () => {
        s = await addStore({ rail: "card" });
        sim.plans.set(s.tokenId, ["timeout_captured"]);
      });

      it("★★ it is never read as a failure: the payment is found on its order and the invoice is paid, with ONE debit", async () => {
        await runTo(at(39 * HOUR));
        expect(debitsOf(s)).toHaveLength(1);
        const list = await attempts(s);
        expect(list).toHaveLength(1);
        expect(list[0].state).toBe("captured");
        expect((await invoice(s))?.status).toBe("paid");
      });

      it("the cycle turns as for any paid renewal", async () => {
        await runTo(new Date(CYCLE_END.getTime() + HOUR));
        expect(await subscription(s)).toMatchObject({
          state: "active",
          cycle: 5,
        });
        expect(debitsOf(s)).toHaveLength(1);
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("6. a debit that timed out and never happened", () => {
      let s: DummyStore;
      scenario("s6", async () => {
        s = await addStore({ rail: "card" });
        sim.plans.set(s.tokenId, ["timeout_nothing", "success"]);
      });

      it("★★ while the outcome is unknown nothing else is started, by the job or by hand", async () => {
        await runTo(at(40 * HOUR));
        const list = await attempts(s);
        expect(list).toHaveLength(1);
        expect(list[0].state).toBe("unknown");
        const start = await startInvoicePayment({
          storeId: s.storeId,
          invoiceId: (await invoice(s))!.id,
          now: cursor,
        });
        expect(start).toEqual({
          ok: false,
          error: PAYMENT_BEING_CONFIRMED_MESSAGE,
        });
      });

      it("six hours after the debit was sent with no payment on its order, the try is failed and the next begins", async () => {
        await runTo(at(46 * HOUR));
        const list = await attempts(s);
        expect(list[0]).toMatchObject({
          state: "failed",
          failure_code: "reconciled_no_payment",
        });
        expect(list[1]).toMatchObject({ state: "processing" });
      });

      it("the second try pays it: two debits, one captured", async () => {
        await runTo(at(90 * HOUR));
        expect(debitsOf(s)).toHaveLength(2);
        expect((await invoice(s))?.status).toBe("paid");
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("7. the merchant cancels the plan while the renewal's debit is scheduled", () => {
      let s: DummyStore;
      scenario("s7", async () => {
        s = await addStore({ rail: "card" });
      });

      it("★★ the scheduled debit is withdrawn at once, and they are told the invoice won't be charged", async () => {
        await runTo(at(10 * HOUR));
        const cancelled = await cancelAtPeriodEnd({
          storeId: s.storeId,
          now: cursor,
          requestedBy: "merchant:dummy",
        });
        expect(cancelled.ok).toBe(true);
        if (!cancelled.ok) return;
        expect(cancelled.data.nextInvoice).toMatchObject({
          status: "open",
          inFlight: false,
        });
        const [attempt] = await attempts(s);
        expect(attempt).toMatchObject({
          state: "cancelled",
          failure_code: "plan_cancelled",
          debit_sent_at: null,
        });
        expect((await invoice(s))?.status).toBe("open");
        expect(await mandate(s)).toBe("revoked");
      });

      it("★★ nothing is ever debited, the plan runs to the end of the cycle, then ends", async () => {
        await runTo(new Date(CYCLE_END.getTime() - HOUR));
        expect(await storePlan(s)).toBe("pro");
        await runTo(new Date(CYCLE_END.getTime() + 2 * HOUR));
        expect(debitsOf(s)).toHaveLength(0);
        expect((await subscription(s))?.state).toBe("cancelled");
        expect(await storePlan(s)).toBe("free");
        // The renewal that was never reached is closed, not chased.
        expect((await invoice(s))?.status).toBe("void");
        expect(await attempts(s)).toHaveLength(1);
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("8. a cancellation whose clean-up did not happen: the debit pass refuses it by itself", () => {
      let s: DummyStore;
      scenario("s8", async () => {
        s = await addStore({ rail: "card" });
      });

      it("★★ the plan is cancelled, but the mandate is still on record and the debit still scheduled: no debit is sent", async () => {
        await runTo(at(10 * HOUR));
        // Only the flag: as if the mandate revoke and the withdrawal both failed.
        await client.query(
          `update public.billing_subscriptions
              set cancel_at_period_end = true, cancel_requested_at = $2,
                  cancel_requested_by = 'merchant:dummy'
            where store_id = $1`,
          [s.storeId, cursor.toISOString()],
        );
        expect(await mandate(s)).toBe("active");
        await runTo(at(40 * HOUR));
        expect(debitsOf(s)).toHaveLength(0);
        expect((await attempts(s))[0]).toMatchObject({
          state: "cancelled",
          failure_code: "plan_cancelled",
        });
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("9. the customer cancelled the mandate at their bank before the renewal", () => {
      let s: DummyStore;
      scenario("s9", async () => {
        s = await addStore({ rail: "upi", tokenStatus: "cancelled" });
      });

      it("★★ the invoice is issued as one to pay by hand: no promise of an automatic debit, no order, no debit", async () => {
        await runTo(at(48 * HOUR));
        expect((await invoice(s))?.status).toBe("open");
        expect(await attempts(s)).toHaveLength(0);
        expect(debitsOf(s)).toHaveLength(0);
        expect(await mandate(s)).toBe("revoked");
        const sent = emails(s);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatch(/ due for your Pro plan$/);
        const [payable] = await listPayableInvoices(s.storeId);
        expect(payable).toMatchObject({ status: "open", autopayAt: null });
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("10. the customer cancels the mandate between the notice and the debit", () => {
      let s: DummyStore;
      scenario("s10", async () => {
        s = await addStore({ rail: "card" });
      });

      it("★★ the debit is not sent, the try ends, and the merchant gets ONE 'pay by hand' email", async () => {
        await runTo(at(10 * HOUR));
        sim.tokens.get(s.tokenId)!.status = "cancelled";
        await runTo(at(40 * HOUR));
        expect(debitsOf(s)).toHaveLength(0);
        expect((await attempts(s))[0]).toMatchObject({
          state: "failed",
          failure_code: "mandate_unusable",
        });
        expect(await mandate(s)).toBe("revoked");
        expect(
          emails(s).filter((subject) => /^Action needed: pay /.test(subject)),
        ).toHaveLength(1);
      });

      it("no further automatic try is made on a mandate that is gone", async () => {
        await runTo(at(90 * HOUR));
        expect(await attempts(s)).toHaveLength(1);
        expect(debitsOf(s)).toHaveLength(0);
        expect((await invoice(s))?.status).toBe("open");
        expect(
          emails(s).filter((subject) => /^Action needed: pay /.test(subject)),
        ).toHaveLength(1);
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("11. a paused mandate is set aside, not ended", () => {
      let s: DummyStore;
      scenario("s11", async () => {
        s = await addStore({ rail: "upi", tokenStatus: "paused" });
      });

      it("the renewal is issued to pay by hand and the mandate waits to be read again", async () => {
        await runTo(at(30 * HOUR));
        expect(await mandate(s)).toBe("unknown");
        expect((await invoice(s))?.status).toBe("open");
        expect(debitsOf(s)).toHaveLength(0);
        expect(emails(s)[0]).toMatch(/ due for your Pro plan$/);
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("12. Razorpay cannot be reached when the renewal falls due", () => {
      let s: DummyStore;
      scenario("s12", async () => {
        s = await addStore({ rail: "card" });
        sim.silent = true;
      });

      it("★★ for a day nothing is issued and nobody is emailed on a guess", async () => {
        // Collection opened an hour before "now".
        await runTo(at((MANDATE_CHECK_HOLD_HOURS - 2) * HOUR));
        expect((await invoice(s))?.issued ?? false).toBe(false);
        expect(emails(s)).toEqual([]);
      });

      it("★★ then the invoice is issued anyway, to pay by hand, and the mandate's record is untouched", async () => {
        await runTo(at(MANDATE_CHECK_HOLD_HOURS * HOUR));
        expect(await invoice(s)).toMatchObject({
          status: "open",
          issued: true,
        });
        expect(emails(s)).toHaveLength(1);
        expect(emails(s)[0]).toMatch(/ due for your Pro plan$/);
        expect(await mandate(s)).toBe("active");
        expect(await attempts(s)).toHaveLength(0);
      });

      it("when Razorpay answers again, autopay collects it after all", async () => {
        sim.silent = false;
        await runTo(at((MANDATE_CHECK_HOLD_HOURS + 40) * HOUR));
        expect(debitsOf(s)).toHaveLength(1);
        expect((await invoice(s))?.status).toBe("paid");
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("13. Razorpay goes silent between the notice and the debit", () => {
      let s: DummyStore;
      scenario("s13", async () => {
        s = await addStore({ rail: "card" });
      });

      it("★★ the attempt waits, sends nothing, and does not hold the invoice for ever", async () => {
        await runTo(at(20 * HOUR));
        sim.silent = true;
        const due = Number((await attempts(s))[0].debit_after);
        await runTo(
          new Date(due + (GATEWAY_SILENCE_DEADLINE_HOURS - 1) * HOUR),
        );
        expect((await attempts(s))[0]).toMatchObject({
          state: "processing",
          debit_sent_at: null,
        });
        await runTo(
          new Date(due + (GATEWAY_SILENCE_DEADLINE_HOURS + 1) * HOUR),
        );
        expect((await attempts(s))[0]).toMatchObject({
          state: "failed",
          failure_code: "gateway_unreachable",
        });
        expect(debitsOf(s)).toHaveLength(0);
        // Silence is not a cancellation.
        expect(await mandate(s)).toBe("active");
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("14. a notice the bank never delivered", () => {
      let s: DummyStore;
      scenario("s14", async () => {
        s = await addStore({ rail: "upi" });
        sim.dropNotices = 1;
      });

      it("★★ no debit is sent on an undelivered notice; the try ends half a day past its time, and the next one is delivered and paid", async () => {
        await runTo(NOW);
        const due = Number((await attempts(s))[0].debit_after);
        await runTo(
          new Date(due + (NOTICE_DELIVERY_DEADLINE_HOURS - 1) * HOUR),
        );
        expect(debitsOf(s)).toHaveLength(0);
        expect((await attempts(s))[0].state).toBe("processing");
        await runTo(
          new Date(due + (NOTICE_DELIVERY_DEADLINE_HOURS + 1) * HOUR),
        );
        expect((await attempts(s))[0]).toMatchObject({
          state: "failed",
          failure_code: "notice_undelivered",
        });
        await runTo(
          new Date(due + (NOTICE_DELIVERY_DEADLINE_HOURS + 30) * HOUR),
        );
        expect(debitsOf(s)).toHaveLength(1);
        expect((await invoice(s))?.status).toBe("paid");
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("15. Pay now instead: the merchant pays a scheduled renewal themselves", () => {
      let s: DummyStore;
      let orderId = "";
      scenario("s15", async () => {
        s = await addStore({ rail: "card" });
      });

      it("★★ the scheduled debit is withdrawn and an ordinary payment opens", async () => {
        await runTo(at(10 * HOUR));
        const start = await startInvoicePayment({
          storeId: s.storeId,
          invoiceId: (await invoice(s))!.id,
          insteadOfAutopay: true,
          now: cursor,
        });
        expect(start.ok).toBe(true);
        if (!start.ok) return;
        orderId = start.data.providerOrderId;
        expect(start.data.amountPaise).toBe(PLAN_PAISE);
        const list = await attempts(s);
        expect(list.find((a) => a.mode === "automatic")).toMatchObject({
          state: "cancelled",
          failure_code: "paid_by_hand",
          debit_sent_at: null,
        });
        expect(list.find((a) => a.mode === "manual")).toMatchObject({
          state: "processing",
          provider_order_id: orderId,
        });
      });

      it("they pay, and the invoice is paid", async () => {
        const payment = payInCheckout(orderId);
        const done = await confirmInvoicePayment({
          storeId: s.storeId,
          invoiceId: (await invoice(s))!.id,
          providerPaymentId: payment.id,
          signature: "sig",
          now: cursor,
        });
        expect(done.ok).toBe(true);
        expect((await invoice(s))?.status).toBe("paid");
      });

      it("★★ the mandate is never debited for it, and the cycle turns", async () => {
        await runTo(new Date(CYCLE_END.getTime() + HOUR));
        expect(debitsOf(s)).toHaveLength(0);
        expect(await subscription(s)).toMatchObject({
          state: "active",
          cycle: 5,
        });
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("16. Pay now instead, the window closed, then Continue payment", () => {
      let s: DummyStore;
      let orderId = "";
      let invoiceId = "";
      scenario("s16", async () => {
        s = await addStore({ rail: "card" });
      });

      it("after closing the window the row offers Continue payment, not autopay and not a dead end", async () => {
        await runTo(at(10 * HOUR));
        invoiceId = (await invoice(s))!.id;
        const start = await startInvoicePayment({
          storeId: s.storeId,
          invoiceId,
          insteadOfAutopay: true,
          now: cursor,
        });
        if (!start.ok) throw new Error(start.error);
        orderId = start.data.providerOrderId;
        const [payable] = await listPayableInvoices(s.storeId);
        expect(payable).toMatchObject({
          status: "processing",
          autopayAt: null,
          resumable: true,
        });
      });

      it("★★ Continue payment reopens the SAME order", async () => {
        const again = await startInvoicePayment({
          storeId: s.storeId,
          invoiceId,
          now: cursor,
        });
        expect(again).toMatchObject({
          ok: true,
          data: { providerOrderId: orderId },
        });
        expect(
          (await attempts(s)).filter((a) => a.mode === "manual"),
        ).toHaveLength(1);
      });

      it("★★ not while a payment on it is waiting for approval", async () => {
        const pending = payInCheckout(orderId, "created");
        expect(
          await startInvoicePayment({
            storeId: s.storeId,
            invoiceId,
            now: cursor,
          }),
        ).toEqual({ ok: false, error: PAYMENT_IN_PROGRESS_MESSAGE });
        // The approval lapses: every try on the order has failed.
        pending.status = "failed";
        expect(
          (
            await startInvoicePayment({
              storeId: s.storeId,
              invoiceId,
              now: cursor,
            })
          ).ok,
        ).toBe(true);
      });

      it("★★ nor once it is paid at the gateway: the hourly run records it, with no second payment", async () => {
        payInCheckout(orderId);
        expect(
          await startInvoicePayment({
            storeId: s.storeId,
            invoiceId,
            now: cursor,
          }),
        ).toEqual({ ok: false, error: ALREADY_CAPTURED_INVOICE_MESSAGE });
        await runTo(new Date(cursor.getTime() + 2 * HOUR));
        expect((await invoice(s))?.status).toBe("paid");
        expect(debitsOf(s)).toHaveLength(0);
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("17. two runs of the job at the same moment", () => {
      let s: DummyStore;
      scenario("s17", async () => {
        s = await addStore({ rail: "card" });
      });

      it("★★ send ONE debit between them", async () => {
        await runTo(at(36 * HOUR));
        const t = at(37 * HOUR);
        sim.now = t.getTime();
        const [a, b] = await Promise.all([
          sendDueDebits({ gateway: razorpayRecurringGateway, now: t }),
          sendDueDebits({ gateway: razorpayRecurringGateway, now: t }),
        ]);
        expect(a.sent + b.sent).toBe(1);
        expect(a.errors + b.errors).toBe(0);
        expect(debitsOf(s)).toHaveLength(1);
        cursor = t;
        await runTo(at(39 * HOUR));
        expect((await invoice(s))?.status).toBe("paid");
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("18. a card token whose `expired_at` has passed while it still reads confirmed", () => {
      let card: DummyStore;
      let upi: DummyStore;
      scenario("s18", async () => {
        // What Razorpay's test mode shows on the 1st of a month for a card
        // mandate registered for five years.
        card = await addStore({
          rail: "card",
          tokenExpiredAt: Math.floor(Date.now() / 1000) - 3600,
        });
        upi = await addStore({
          rail: "upi",
          tokenExpiredAt: Math.floor(Date.now() / 1000) - 3600,
        });
      });

      it("★★ the card mandate is NOT ended: its renewal is notified, debited and paid", async () => {
        await runTo(at(39 * HOUR));
        expect(await mandate(card)).toBe("active");
        expect(debitsOf(card)).toHaveLength(1);
        expect((await invoice(card))?.status).toBe("paid");
      });

      it("a UPI mandate past its real expiry is ended, and its renewal is to pay by hand", async () => {
        expect(await mandate(upi)).toBe("expired");
        expect(debitsOf(upi)).toHaveLength(0);
        expect((await invoice(upi))?.status).toBe("open");
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("19. a yearly plan above the ₹15,000 autopay limit", () => {
      let s: DummyStore;
      scenario("s19", async () => {
        // ★ A mandate whose own ceiling is ABOVE the yearly price, so the only
        // thing that can stop an automatic debit is RBI's ₹15,000 limit.
        s = await addStore({
          rail: "card",
          period: "yearly",
          mandateMaxPaise: 3_000_000,
        });
      });

      it("is invoiced to pay by hand: no order, no notice, no debit", async () => {
        await runTo(at(48 * HOUR));
        expect(await invoice(s)).toMatchObject({
          status: "open",
          total_paise: String(YEARLY_PAISE),
        });
        expect(await attempts(s)).toHaveLength(0);
        expect(debitsOf(s)).toHaveLength(0);
        expect(emails(s)[0]).toMatch(/ due for your Pro plan$/);
        // Nothing asked the gateway about a mandate that cannot carry it.
        expect(await mandate(s)).toBe("active");
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("20. two renewals in a row: two months of hourly runs", () => {
      let card: DummyStore;
      let upi: DummyStore;
      scenario("s20", async () => {
        card = await addStore({ rail: "card" });
        upi = await addStore({ rail: "upi" });
      });

      it("★★ each store is debited exactly twice, once per cycle, thirty days apart", async () => {
        // Stops a day before the THIRD renewal's collection opens (four days
        // before the sixth cycle ends), so exactly two renewals fall inside.
        await runTo(new Date(CYCLE_END.getTime() + 55 * DAY));
        for (const s of [card, upi]) {
          const sent = debitsOf(s);
          expect(sent).toHaveLength(2);
          // Thirty days apart, less the one hour by which this fixture's
          // first run came after its collection opened.
          expect(sent[1].at - sent[0].at).toBe(30 * DAY - HOUR);
          expect((await invoice(s, 5))?.status).toBe("paid");
          expect((await invoice(s, 6))?.status).toBe("paid");
          const sub = await subscription(s);
          expect(sub).toMatchObject({ state: "active", cycle: 6 });
          expect(Number(sub!.period_start)).toBe(
            CYCLE_END.getTime() + 30 * DAY,
          );
          expect(Number(sub!.period_end)).toBe(CYCLE_END.getTime() + 60 * DAY);
          expect(await storePlan(s)).toBe("pro");
        }
      }, 600_000);

      it("each renewal had one issue notice and no dunning", async () => {
        for (const s of [card, upi]) {
          const sent = emails(s);
          expect(
            sent.filter((subject) => /^Your Pro plan renews on /.test(subject))
              .length,
          ).toBeGreaterThanOrEqual(2);
          expect(
            sent.filter((subject) => /Action needed|overdue/i.test(subject)),
          ).toEqual([]);
        }
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("21. the whole life of a subscription: a Free store subscribes, then renews twice", () => {
      let s: DummyStore;
      let orderId = "";
      let invoiceId = "";
      scenario("s21", async () => {
        s = await addFreeStore();
      });

      it("★★ subscribing asks Razorpay for an AS PRESENTED mandate on UPI Autopay, for the first payment", async () => {
        const start = await startEnrolment({
          storeId: s.storeId,
          plan: "pro",
          period: "monthly",
          mandateMethod: "upi",
          priceFor: priceFor as any,
          now: NOW,
        });
        if (!start.ok) throw new Error(start.error);
        orderId = start.data.providerOrderId;
        invoiceId = start.data.invoiceId;
        expect(start.data).toMatchObject({
          autopay: true,
          amountPaise: PLAN_PAISE,
          mandateMethod: "upi",
        });
        const order = sim.orders.get(orderId)!;
        expect(order.auth).toMatchObject({
          method: "upi",
          frequency: MANDATE_FREQUENCY,
        });
        expect(order.auth!.frequency).toBe("as_presented");
        // The ceiling covers this plan's renewal and stays under ₹15,000.
        expect(order.auth!.maxAmount).toBeGreaterThanOrEqual(PLAN_PAISE);
        expect(order.auth!.maxAmount).toBeLessThanOrEqual(1_500_000);
        // Nothing is theirs until they pay.
        expect(await storePlan(s)).toBe("free");
      });

      it("★★ once they approve it in checkout, the plan is on, the mandate is read from the payment, and the first 30-day cycle begins", async () => {
        const { payment, tokenId } = authoriseInCheckout(orderId);
        s.tokenId = tokenId;
        const confirmed = await confirmEnrolment({
          storeId: s.storeId,
          invoiceId,
          providerPaymentId: payment.id,
          signature: "sig",
          now: NOW,
        });
        expect(confirmed.ok).toBe(true);
        expect(await storePlan(s)).toBe("pro");
        expect(await mandate(s)).toBe("active");
        const sub = await subscription(s);
        expect(sub).toMatchObject({ state: "active", cycle: 1 });
        expect(Number(sub!.period_end) - Number(sub!.period_start)).toBe(
          30 * DAY,
        );
        expect((await invoice(s, 1))?.status).toBe("paid");
        const stored = await one(
          `select provider_token_id, method
             from public.billing_mandates where store_id = $1`,
          [s.storeId],
        );
        expect(stored).toMatchObject({
          provider_token_id: tokenId,
          method: "upi",
        });
      });

      it("nothing is debited in the first 25 days", async () => {
        await runTo(at(25 * DAY));
        expect(debitsOf(s)).toHaveLength(0);
        expect(await invoice(s, 2)).toBeNull();
      }, 600_000);

      it("★★ over the next two months the mandate is debited exactly twice, once for each renewal", async () => {
        await runTo(at(65 * DAY));
        const sent = debitsOf(s);
        expect(sent).toHaveLength(2);
        expect(sent[1].at - sent[0].at).toBe(30 * DAY);
        expect((await invoice(s, 2))?.status).toBe("paid");
        expect((await invoice(s, 3))?.status).toBe("paid");
        expect(await subscription(s)).toMatchObject({
          state: "active",
          cycle: 3,
        });
        expect(await storePlan(s)).toBe("pro");
        expect(
          emails(s).filter((subject) => /Action needed|overdue/i.test(subject)),
        ).toEqual([]);
      }, 600_000);

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("22. cancel, then Keep my plan", () => {
      let s: DummyStore;
      scenario("s22", async () => {
        s = await addStore({ rail: "card" });
      });

      it("after Keep my plan the renewal is back, to pay by hand: the mandate was withdrawn and is not restored", async () => {
        await runTo(at(10 * HOUR));
        const cancelled = await cancelAtPeriodEnd({
          storeId: s.storeId,
          now: cursor,
          requestedBy: "merchant:dummy",
        });
        expect(cancelled.ok).toBe(true);
        await runTo(at(20 * HOUR));
        const resumed = await resumeSubscription({
          storeId: s.storeId,
          now: cursor,
          requestedBy: "merchant:dummy",
        });
        expect(resumed.ok).toBe(true);
        if (!resumed.ok) return;
        expect(resumed.data.autopay).toBe(false);
        await runTo(at(60 * HOUR));
        expect(await mandate(s)).toBe("revoked");
        expect(debitsOf(s)).toHaveLength(0);
        const [payable] = await listPayableInvoices(s.storeId);
        expect(payable).toMatchObject({
          status: "open",
          autopayAt: null,
          resumable: false,
        });
      });

      it("they pay it by hand, and the plan carries on into the next cycle", async () => {
        expect((await payByHand(s, 5)).ok).toBe(true);
        await runTo(new Date(CYCLE_END.getTime() + HOUR));
        expect(await subscription(s)).toMatchObject({
          state: "active",
          cycle: 5,
          cancelling: false,
        });
        expect(await storePlan(s)).toBe("pro");
        expect(debitsOf(s)).toHaveLength(0);
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("23. three failed tries, then the merchant pays by hand during grace", () => {
      let s: DummyStore;
      scenario("s23", async () => {
        s = await addStore({ rail: "upi" });
        sim.plans.set(s.tokenId, ["declined", "declined", "declined"]);
      });

      it("the plan is in grace after the third failure", async () => {
        await runTo(new Date(CYCLE_END.getTime() + DAY));
        expect(debitsOf(s)).toHaveLength(3);
        const sub = await subscription(s);
        expect(["past_due", "grace"]).toContain(sub!.state);
        expect(sub!.grace_ends).not.toBeNull();
        expect(await storePlan(s)).toBe("pro");
      });

      it("★★ paying by hand restores the plan at once, and the store is never moved to Free", async () => {
        const graceEnds = Number((await subscription(s))!.grace_ends);
        const paid = await payByHand(s, 5);
        if (!paid.ok) throw new Error(`refused: ${paid.error}`);
        expect(paid.data.planRestored).toBe(true);
        expect(await subscription(s)).toMatchObject({
          state: "active",
          cycle: 5,
          grace_ends: null,
        });
        await runTo(new Date(graceEnds + DAY));
        expect(await storePlan(s)).toBe("pro");
        expect((await subscription(s))?.state).toBe("active");
        expect((await invoice(s))?.status).toBe("paid");
        // The three failed tries were all there ever was.
        expect(debitsOf(s)).toHaveLength(3);
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("24. a paused mandate that the customer resumes before the next renewal", () => {
      let s: DummyStore;
      scenario("s24", async () => {
        s = await addStore({ rail: "upi", tokenStatus: "paused" });
      });

      it("this renewal is paid by hand", async () => {
        await runTo(at(5 * HOUR));
        expect(await mandate(s)).toBe("unknown");
        expect((await payByHand(s, 5)).ok).toBe(true);
      });

      it("★★ the next renewal, thirty days on, is collected automatically again", async () => {
        await runTo(at(10 * DAY));
        sim.tokens.get(s.tokenId)!.status = "confirmed";
        await runTo(new Date(CYCLE_END.getTime() + 29 * DAY));
        expect(await mandate(s)).toBe("active");
        expect(debitsOf(s)).toHaveLength(1);
        expect((await invoice(s, 6))?.status).toBe("paid");
        expect(await subscription(s)).toMatchObject({
          state: "active",
          cycle: 5,
        });
      }, 600_000);

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    describe("25. the billing job was down for three days when the renewal fell due", () => {
      let s: DummyStore;
      scenario("s25", async () => {
        s = await addStore({ rail: "card" });
      });

      it("★★ it catches up: the debit lands after the cycle has turned, with no grace, no lost plan and one debit", async () => {
        // No run until three days in: the cycle ends in 23 hours.
        cursor = at(3 * DAY - HOUR);
        await runTo(at(3 * DAY));
        expect((await invoice(s))?.status).toBe("processing");
        // The cycle turns while the notice period is still running.
        await runTo(new Date(CYCLE_END.getTime() + 2 * HOUR));
        expect(debitsOf(s)).toHaveLength(0);
        expect(await subscription(s)).toMatchObject({
          state: "active",
          cycle: 4,
          grace_ends: null,
        });
        expect(await storePlan(s)).toBe("pro");
        // The debit goes out 37 hours after the late notice.
        await runTo(at(3 * DAY + 39 * HOUR));
        expect(debitsOf(s)).toHaveLength(1);
        expect((await invoice(s))?.status).toBe("paid");
        const sub = await subscription(s);
        expect(sub).toMatchObject({ state: "active", cycle: 5 });
        // The new cycle still starts on its own day, not on the day it was paid.
        expect(Number(sub!.period_start)).toBe(CYCLE_END.getTime());
        expect(
          emails(s).filter((subject) => /Action needed|overdue/i.test(subject)),
        ).toEqual([]);
      });

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    // PR #303 review, 22 Nov 2026. Every automatic attempt used to count as
    // one of the three tries, whatever became of it, so three attempts that
    // ended before any debit was sent ended automatic collection: the
    // merchant was told autopay had stopped, on a mandate nobody had tried.
    describe("26. three notices the bank never delivered, then one that is", () => {
      let s: DummyStore;
      scenario("s26", async () => {
        s = await addStore({ rail: "upi" });
        sim.dropNotices = 3;
      });

      it("★★ no debit was sent, so the three tries are untouched: the fourth attempt is debited and paid, and nobody is told autopay stopped", async () => {
        await runTo(new Date(CYCLE_END.getTime() + 60 * HOUR));
        const all = await attempts(s);
        expect(
          all.filter((a) => a.failure_code === "notice_undelivered"),
        ).toHaveLength(3);
        // One debit ever, and it is the one that paid the invoice.
        expect(debitsOf(s)).toHaveLength(1);
        expect((await invoice(s))?.status).toBe("paid");
        expect(await storePlan(s)).toBe("pro");
        expect(
          emails(s).filter((subject) => /^Action needed: pay /.test(subject)),
        ).toEqual([]);
      }, 600_000);

      invariants();
    });

    // ─────────────────────────────────────────────────────────────────────
    // PR #303 review, 22 Nov 2026. Razorpay does not treat a failed payment
    // as final: the bank can authorise it late, and with automatic capture
    // it is then captured. The second try used to debit the renewal again.
    describe("27. a debit the bank reported failed, then captured late: the second try never debits", () => {
      let s: DummyStore;
      scenario("s27", async () => {
        s = await addStore({ rail: "card" });
        sim.plans.set(s.tokenId, ["failed_later", "success"]);
      });

      it("the first debit fails and a second try is started with its own notice", async () => {
        await runTo(at(40 * HOUR));
        const list = await attempts(s);
        expect(list[0].state).toBe("failed");
        expect(list[1]).toMatchObject({
          state: "processing",
          debit_sent_at: null,
        });
        expect(debitsOf(s)).toHaveLength(1);
      });

      it("★★ the bank then captures the first debit after all: the second try is withdrawn, ONE debit in all, and a person is told", async () => {
        const [first] = await attempts(s);
        const late = sim.orders.get(first.provider_order_id)!.payments[0];
        expect(late.status).toBe("failed");
        late.status = "captured";

        await runTo(at(90 * HOUR));
        expect(debitsOf(s)).toHaveLength(1);
        const list = await attempts(s);
        expect(list[0].state).toBe("failed");
        expect(list[1]).toMatchObject({
          state: "cancelled",
          failure_code: "earlier_debit_paid",
          debit_sent_at: null,
        });
        const filed = await rows(
          `select kind, status, provider_payment_id, detail->>'repair_key' as repair_key,
                  (detail->>'automatic')::boolean as automatic
             from public.billing_reconciliation_items where store_id = $1`,
          [s.storeId],
        );
        expect(filed).toEqual([
          {
            kind: "state_conflict",
            status: "open",
            provider_payment_id: late.id,
            repair_key: `closed_checkout_paid:${late.id}`,
            automatic: true,
          },
        ]);
        // Not applied by itself: whether it settles the invoice is a
        // person's decision, with the invoice in front of them.
        expect((await invoice(s))?.status).toBe("open");
      });

      it("★★ and no later run debits it either, through the cycle turn and beyond", async () => {
        await runTo(new Date(CYCLE_END.getTime() + 48 * HOUR));
        expect(debitsOf(s)).toHaveLength(1);
        expect(
          (await attempts(s)).filter((a) => a.debit_sent_at !== null),
        ).toHaveLength(1);
        expect(
          await rows(
            "select 1 from public.billing_reconciliation_items where store_id = $1",
            [s.storeId],
          ),
        ).toHaveLength(1);
      }, 600_000);

      invariants();
    });
  },
);
