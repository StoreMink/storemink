/** Rollback-only checks, against local Postgres, that deleting a store keeps
 * StoreMink's own invoices to that merchant (migration
 * 20261025_0243_keep_invoices_after_store_deletion): the real finalize paths
 * record both parties, the real deleteStore removes the store's drafts and
 * leaves every issued invoice, its lines and its payment attempts with
 * store_id NULL and the parties intact, a draft with a payment that may have
 * reached the gateway is kept, and the invoice guard still refuses money,
 * number, kind, parties and store changes afterwards. Since 0245 an issued
 * invoice cannot be deleted at all, its parties are recorded at issue whatever
 * a draft carried, and its issue date, financial year, GSTINs and place of
 * supply are frozen too. deleteStore also keeps the store's open
 * reconciliation items and files a paid AI credit purchase whose receipt never
 * issued, and every close outcome passes the reconciliation CHECK. Run with
 * BILLING_INVOICE_RETENTION_LOCAL_TEST=1; the fixed loopback database keeps it
 * away from Cloud SQL, and everything happens inside one transaction that is
 * rolled back.
 *
 * ★ The code under test runs as `app_service`, the role `withService` takes in
 *   production, so a write that role may not make fails here too.
 * ★ deleteStore defers its foreign-key checks to COMMIT, and this transaction
 *   never commits, so the test sets them IMMEDIATE after the delete: that is
 *   when they fire, and a cascade the commit would refuse fails here.
 * ⚠ Finalizing takes the financial year's invoice counter row, which stays
 *   locked until the rollback: another session issuing an invoice on this
 *   database waits for the few seconds this file runs. */
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
    const name = `invoice_retention_${++service.count}`;
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
  email: `retention-${Math.random().toString(36).slice(2, 10)}@probe.test`,
}));
vi.mock("@/lib/auth/server-user", () => ({
  getServerUser: vi.fn(async () => ({
    id: "retention-operator",
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

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { deleteStore } from "@/app/actions/platform";
import { getInvoiceDocument } from "./invoice-history";
import { resolveReconciliationItem } from "./reconcile";
import {
  finalizeInvoiceClaimed,
  finalizePaidAiCreditsInvoice,
} from "./invoice-store";

const enabled = process.env.BILLING_INVOICE_RETENTION_LOCAL_TEST === "1";

const STORE = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const ISSUED = crypto.randomUUID();
const ISSUED_UNPAID = crypto.randomUUID();
const CREDITS = crypto.randomUUID();
const DRAFT = crypto.randomUUID();
const FAILED_DRAFT = crypto.randomUUID();
const EVIDENCE = crypto.randomUUID();
const AI_DRAFT = crypto.randomUUID();
const AI_PENDING_DRAFT = crypto.randomUUID();
const tag = STORE.slice(0, 8);

describe.skipIf(!enabled)(
  "deleting a store keeps StoreMink's own invoices (local database)",
  () => {
    let client: Client;
    let recorded: Record<string, unknown> | null = null;
    let issuedRef: string | null = null;
    let unpaidParties: unknown = null;
    let creditsParties: unknown = null;

    const one = async (sqlText: string, params: unknown[] = []) =>
      (await client.query(sqlText, params)).rows[0] ?? null;
    const count = async (sqlText: string, params: unknown[] = []) =>
      Number((await one(sqlText, params))?.n ?? 0);

    /** Run one statement the guard must refuse, inside its own savepoint. */
    async function refused(sqlText: string, params: unknown[]) {
      await client.query("SAVEPOINT refusal");
      try {
        await client.query(sqlText, params);
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT refusal");
        return error instanceof Error ? error.message : String(error);
      }
      await client.query("ROLLBACK TO SAVEPOINT refusal");
      return null;
    }

    async function insertDraft(input: {
      id: string;
      kind: "subscription" | "ai_credits" | "addon";
      cycleSeq?: number | null;
      subtotal: number;
      tax: number;
    }) {
      await client.query(
        `insert into public.billing_invoices
           (id, store_id, kind, status, subtotal_paise, discount_paise, tax_paise,
            total_paise, cycle_seq, addon_target_count, tax_rate_bps,
            supplier_gstin, customer_gstin, place_of_supply)
         values ($1, $2, $3, 'draft', $4, 0, $5, $6, $7, $8, 1800,
                 '07AABCS1429B1ZX', '29AAACM1234C1ZP', '29')`,
        [
          input.id,
          STORE,
          input.kind,
          input.subtotal,
          input.tax,
          input.subtotal + input.tax,
          input.cycleSeq ?? null,
          input.kind === "addon" ? 1 : null,
        ],
      );
      await client.query(
        `insert into public.billing_invoice_items
           (invoice_id, kind, description, quantity, unit_amount_paise, amount_paise)
         values ($1, $2, 'Retention probe line', 1, $3, $3)`,
        [
          input.id,
          input.kind === "subscription"
            ? "base_plan"
            : input.kind === "addon"
              ? "location"
              : "ai_credits",
          input.subtotal,
        ],
      );
    }

    async function insertAttempt(input: {
      invoiceId: string;
      state: string;
      orderId: string | null;
      paymentId?: string | null;
      amount: number;
    }) {
      const resolved = ["captured", "failed", "cancelled", "refunded"].includes(
        input.state,
      );
      await client.query(
        `insert into public.billing_payment_attempts
           (invoice_id, store_id, idempotency_key, mode, state, amount_paise,
            provider_order_id, provider_payment_id, resolved_at)
         values ($1, $2, $3, 'manual', $4, $5, $6, $7,
                 case when $8::boolean then now() end)`,
        [
          input.invoiceId,
          STORE,
          `retention-${crypto.randomUUID()}`,
          input.state,
          input.amount,
          input.orderId,
          input.paymentId ?? null,
          resolved,
        ],
      );
    }

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user:
          process.env.BILLING_INVOICE_RETENTION_LOCAL_TEST_USER ||
          process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      service.client = client;
      service.db = drizzle(client, { schema: { ...schema, ...relations } });

      await client.query(
        "insert into public.platform_admins (email, role) values ($1, 'superadmin')",
        [operator.email],
      );
      await client.query(
        `insert into public.stores (id, name, slug) values
           ($1, 'Retention Probe', $2), ($3, 'Retention Other', $4)`,
        [STORE, `retention-${tag}`, OTHER, `retention-other-${tag}`],
      );
      await client.query(
        `insert into public.store_billing_settings
           (store_id, business_name, business_address, contact_email)
         values ($1, 'Probe Traders', E'Shop 4, MG Road\\n\\n  Bengaluru 560001  ',
                 'owner@probe.test')`,
        [STORE],
      );
      // The billing account is written with no name or address today, which
      // is why the customer falls back to the store's own business details.
      await client.query(
        "insert into public.billing_accounts (store_id) values ($1)",
        [STORE],
      );

      // An issued subscription invoice, paid, with a captured attempt.
      await insertDraft({
        id: ISSUED,
        kind: "subscription",
        cycleSeq: 1,
        subtotal: 100_000,
        tax: 18_000,
      });
      await insertAttempt({
        invoiceId: ISSUED,
        state: "captured",
        orderId: `order_ret_${tag}_1`,
        paymentId: `pay_ret_${tag}_1`,
        amount: 118_000,
      });
      // An issued invoice nobody has paid yet, with no payment attempt: the
      // routine state between issue and collection (finalizeInvoiceClaimed
      // opens it with paid_at NULL). It is a GST document all the same.
      await insertDraft({
        id: ISSUED_UNPAID,
        kind: "addon",
        subtotal: 20_000,
        tax: 3_600,
      });
      // An AI-credit receipt, issued as paid in one step.
      await insertDraft({
        id: CREDITS,
        kind: "ai_credits",
        subtotal: 5_000,
        tax: 900,
      });
      // A draft nobody paid: no order ever reached the gateway.
      await insertDraft({
        id: DRAFT,
        kind: "addon",
        subtotal: 20_000,
        tax: 3_600,
      });
      await insertAttempt({
        invoiceId: DRAFT,
        state: "created",
        orderId: null,
        amount: 23_600,
      });
      // A draft whose payment failed at the gateway: not evidence of money.
      await insertDraft({
        id: FAILED_DRAFT,
        kind: "addon",
        subtotal: 20_000,
        tax: 3_600,
      });
      await insertAttempt({
        invoiceId: FAILED_DRAFT,
        state: "failed",
        orderId: `order_ret_${tag}_2`,
        amount: 23_600,
      });
      // A draft with a payment still in flight at the gateway: evidence.
      await insertDraft({
        id: EVIDENCE,
        kind: "subscription",
        cycleSeq: 2,
        subtotal: 100_000,
        tax: 18_000,
      });
      await insertAttempt({
        invoiceId: EVIDENCE,
        state: "processing",
        orderId: `order_ret_${tag}_3`,
        amount: 118_000,
      });

      // Open money questions about this store, and one already closed.
      await client.query(
        `insert into public.billing_reconciliation_items
           (store_id, kind, status, invoice_id, provider_payment_id,
            expected_paise, observed_paise, detail, resolved_by, resolved_at)
         values
           ($1, 'amount_mismatch', 'open', $2, $3, 118000, 128000,
            '{"note": "captured amount differs from the attempt"}'::jsonb,
            null, null),
           ($1, 'unknown_payment', 'manual_review', null, $4, null, null,
            '{}'::jsonb, 'op@probe.test', null),
           ($1, 'unknown_payment', 'resolved', null, $5, null, null,
            '{}'::jsonb, 'op@probe.test', now())`,
        [
          STORE,
          ISSUED,
          `pay_ret_${tag}_mismatch`,
          `pay_ret_${tag}_chasing`,
          `pay_ret_${tag}_closed`,
        ],
      );

      // AI credit purchases: one paid whose receipt never issued (a draft,
      // no attempt), one paid behind the issued receipt CREDITS, and one
      // still pending (an abandoned checkout).
      await insertDraft({
        id: AI_DRAFT,
        kind: "ai_credits",
        subtotal: 5_000,
        tax: 900,
      });
      await insertDraft({
        id: AI_PENDING_DRAFT,
        kind: "ai_credits",
        subtotal: 5_000,
        tax: 900,
      });
      await client.query(
        `insert into public.ai_credit_purchases
           (store_id, pack_id, credits, amount_inr, rzp_order_id,
            rzp_payment_id, invoice_id, status)
         values
           ($1, 'probe-pack', 100, 59, $2, $3, $4, 'paid'),
           ($1, 'probe-pack', 100, 59, $5, $6, $7, 'paid'),
           ($1, 'probe-pack', 100, 59, $8, null, $9, 'pending')`,
        [
          STORE,
          `order_ret_${tag}_ai1`,
          `pay_ret_${tag}_ai1`,
          AI_DRAFT,
          `order_ret_${tag}_ai2`,
          `pay_ret_${tag}_ai2`,
          CREDITS,
          `order_ret_${tag}_ai3`,
          AI_PENDING_DRAFT,
        ],
      );
    });

    afterAll(async () => {
      if (!client) return;
      await client.query("ROLLBACK");
      await client.end();
    });

    it("records both parties when the real finalize paths issue an invoice", async () => {
      const now = new Date();
      const issued = await finalizeInvoiceClaimed(ISSUED, now);
      expect(issued.claimed).toBe(true);
      expect(issued.invoice?.invoiceRef).toMatch(/\d/);
      issuedRef = issued.invoice!.invoiceRef;
      await client.query(
        "update public.billing_invoices set status = 'paid', paid_at = now() where id = $1",
        [ISSUED],
      );

      // ★ A parties value written while it was a draft (the guard ignores
      //   drafts) is replaced when it is issued, never carried in (0245).
      await client.query(
        `update public.billing_invoices
            set parties = '{"version": 1, "forged": "draft-time"}'::jsonb
          where id = $1`,
        [ISSUED_UNPAID],
      );
      const unpaid = await finalizeInvoiceClaimed(ISSUED_UNPAID, now);
      expect(unpaid.claimed).toBe(true);
      expect(unpaid.invoice?.status).toBe("open");
      const unpaidRow = await one(
        "select paid_at, parties from public.billing_invoices where id = $1",
        [ISSUED_UNPAID],
      );
      expect(unpaidRow?.paid_at).toBeNull();
      unpaidParties = unpaidRow?.parties;
      expect(unpaidParties).toMatchObject({
        version: 1,
        customer: { name: "Probe Traders", gstin: "29AAACM1234C1ZP" },
      });
      expect(unpaidParties).not.toHaveProperty("forged");

      const credits = await finalizePaidAiCreditsInvoice(CREDITS, now);
      expect(credits?.status).toBe("paid");
      expect(credits?.invoiceRef).toMatch(/\d/);

      const supplier = await one(
        "select legal_name from public.platform_billing_settings limit 1",
      );
      const row = await one(
        "select parties from public.billing_invoices where id = $1",
        [ISSUED],
      );
      recorded = row?.parties as Record<string, unknown>;
      expect(recorded).toMatchObject({
        version: 1,
        supplier: {
          name: supplier?.legal_name ?? null,
          gstin: "07AABCS1429B1ZX",
        },
        customer: {
          // No account name, no legal name: the business name the merchant
          // gave under Taxes & invoices.
          name: "Probe Traders",
          gstin: "29AAACM1234C1ZP",
          stateCode: "29",
          email: "owner@probe.test",
          // The free-text address: its first line, then the rest, blanks gone.
          address: { line1: "Shop 4, MG Road", line2: "Bengaluru 560001" },
        },
      });
      expect(typeof recorded?.capturedAt).toBe("string");

      creditsParties = (
        await one("select parties from public.billing_invoices where id = $1", [
          CREDITS,
        ])
      )?.parties;
      expect(creditsParties).toMatchObject({
        version: 1,
        customer: { name: "Probe Traders" },
      });
    });

    it("the document keeps the recorded name after the merchant renames the business", async () => {
      await client.query(
        "update public.store_billing_settings set business_name = 'Renamed Traders' where store_id = $1",
        [STORE],
      );
      const doc = await getInvoiceDocument(STORE, ISSUED);
      expect(doc?.customer.legalName).toBe("Probe Traders");
      expect(doc?.customer.billingEmail).toBe("owner@probe.test");
      expect(doc?.invoiceRef).toBe(issuedRef);

      // The document's fallback (no record) calls the same function as
      // app_service, and it reads TODAY's settings: the rename shows there,
      // which is exactly why an issued invoice reads its record instead.
      const live = await withService(async (db) => {
        const res = await db.execute(
          sql`select public.billing_invoice_parties(${STORE}::uuid, null::text, '29AAACM1234C1ZP'::text, '29'::text) as parties`,
        );
        return (res.rows[0] as { parties: { customer: { name: string } } })
          .parties;
      });
      expect(live.customer.name).toBe("Renamed Traders");
    });

    it("the guard refuses blanking the store of a live store's issued invoice, or deleting it", async () => {
      expect(
        await refused(
          "update public.billing_invoices set store_id = null where id = $1",
          [ISSUED],
        ),
      ).toMatch(/is finalized/);
      expect(
        await refused(
          "update public.billing_invoices set parties = null where id = $1",
          [ISSUED],
        ),
      ).toMatch(/is finalized/);
      // ★ Nothing but deleteStore's draft predicate kept an issued invoice
      //   before 0245; the delete guard refuses it whoever asks.
      for (const id of [ISSUED, ISSUED_UNPAID]) {
        expect(
          await refused("delete from public.billing_invoices where id = $1", [
            id,
          ]),
        ).toMatch(/is finalized; an issued invoice is kept, never deleted/);
      }
    });

    it("deleteStore keeps every issued invoice, its lines and its payments, and removes the drafts", async () => {
      expect(await deleteStore(STORE)).toEqual({
        success: true,
        warning:
          "1 paid AI credit purchase has no issued receipt. It is now in Billing & tax > Reconciliation, so the payment is not lost.",
      });
      // The checks deleteStore deferred to COMMIT run now; a cascade the
      // commit would refuse throws here.
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");

      expect(
        await count("select count(*) as n from public.stores where id = $1", [
          STORE,
        ]),
      ).toBe(0);
      expect(
        await count(
          "select count(*) as n from public.store_billing_settings where store_id = $1",
          [STORE],
        ),
      ).toBe(0);

      const kept = await one(
        `select store_id, status, invoice_ref, total_paise, parties
           from public.billing_invoices where id = $1`,
        [ISSUED],
      );
      expect(kept).toMatchObject({
        store_id: null,
        status: "paid",
        invoice_ref: issuedRef,
        total_paise: "118000",
      });
      expect(kept?.parties).toEqual(recorded);
      expect(
        await count(
          "select count(*) as n from public.billing_invoice_items where invoice_id = $1",
          [ISSUED],
        ),
      ).toBe(1);
      expect(
        await one(
          "select store_id, state from public.billing_payment_attempts where invoice_id = $1",
          [ISSUED],
        ),
      ).toEqual({ store_id: null, state: "captured" });

      // ★ Issued but not yet paid is kept too: the draft rule keys on
      //   finalized_at, never on paid_at.
      const unpaid = await one(
        "select store_id, status, paid_at, parties from public.billing_invoices where id = $1",
        [ISSUED_UNPAID],
      );
      expect(unpaid).toMatchObject({
        store_id: null,
        status: "open",
        paid_at: null,
      });
      expect(unpaid?.parties).toEqual(unpaidParties);
      expect(
        await count(
          "select count(*) as n from public.billing_invoice_items where invoice_id = $1",
          [ISSUED_UNPAID],
        ),
      ).toBe(1);

      const credits = await one(
        "select store_id, status, parties from public.billing_invoices where id = $1",
        [CREDITS],
      );
      expect(credits).toMatchObject({ store_id: null, status: "paid" });
      expect(credits?.parties).toEqual(creditsParties);

      // The draft with a payment possibly at the gateway is kept, detached.
      expect(
        await one(
          "select store_id, status from public.billing_invoices where id = $1",
          [EVIDENCE],
        ),
      ).toEqual({ store_id: null, status: "draft" });
      expect(
        await one(
          "select store_id, state from public.billing_payment_attempts where invoice_id = $1",
          [EVIDENCE],
        ),
      ).toEqual({ store_id: null, state: "processing" });

      // The two other drafts, their lines and their attempts are gone.
      for (const id of [DRAFT, FAILED_DRAFT]) {
        expect(
          await count(
            "select count(*) as n from public.billing_invoices where id = $1",
            [id],
          ),
        ).toBe(0);
        expect(
          await count(
            "select count(*) as n from public.billing_invoice_items where invoice_id = $1",
            [id],
          ),
        ).toBe(0);
        expect(
          await count(
            "select count(*) as n from public.billing_payment_attempts where invoice_id = $1",
            [id],
          ),
        ).toBe(0);
      }

      // Nobody reaches a deleted store's invoice through the merchant
      // document: it is kept for StoreMink's own records.
      expect(await getInvoiceDocument(STORE, ISSUED)).toBeNull();
    });

    it("deleteStore keeps the store's open money questions and files a paid AI credit purchase with no receipt", async () => {
      const item = (payment: string) =>
        one(
          `select store_id, kind, status, expected_paise, observed_paise,
                  provider_order_id, detail
             from public.billing_reconciliation_items
            where provider_payment_id = $1`,
          [payment],
        );

      // Open and "needs chasing" items are detached, marked, and keep what
      // they recorded (the observed amount lives nowhere else).
      expect(await item(`pay_ret_${tag}_mismatch`)).toEqual({
        store_id: null,
        kind: "amount_mismatch",
        status: "open",
        expected_paise: "118000",
        observed_paise: "128000",
        provider_order_id: null,
        detail: {
          note: "captured amount differs from the attempt",
          storeDeleted: true,
          storeName: "Retention Probe",
        },
      });
      expect(await item(`pay_ret_${tag}_chasing`)).toMatchObject({
        store_id: null,
        status: "manual_review",
        detail: { storeDeleted: true, storeName: "Retention Probe" },
      });
      // A closed item is history and goes with the store.
      expect(await item(`pay_ret_${tag}_closed`)).toBeNull();

      // The paid purchase whose receipt never issued: its ids and amount
      // survive the purchase row, as an open question for a human.
      expect(await item(`pay_ret_${tag}_ai1`)).toEqual({
        store_id: null,
        kind: "orphan_payment",
        status: "open",
        expected_paise: "5900",
        observed_paise: null,
        provider_order_id: `order_ret_${tag}_ai1`,
        detail: {
          note: "AI credit purchase paid, receipt never issued",
          storeDeleted: true,
          storeName: "Retention Probe",
          credits: 100,
        },
      });
      // Not filed: one behind an issued (kept) receipt, and a pending one.
      expect(await item(`pay_ret_${tag}_ai2`)).toBeNull();
      expect(
        await count(
          "select count(*) as n from public.billing_reconciliation_items where provider_order_id = $1",
          [`order_ret_${tag}_ai3`],
        ),
      ).toBe(0);

      // The purchase rows cascade with the store; the two AI drafts go too.
      expect(
        await count(
          "select count(*) as n from public.ai_credit_purchases where store_id = $1 or rzp_order_id like $2",
          [STORE, `order_ret_${tag}_ai%`],
        ),
      ).toBe(0);
      expect(
        await count(
          "select count(*) as n from public.billing_invoices where id in ($1, $2)",
          [AI_DRAFT, AI_PENDING_DRAFT],
        ),
      ).toBe(0);
    });

    it("an operator can close a deleted store's payment question with each outcome", async () => {
      // ★★ billing_reconciliation_resolved_shape: (status = 'resolved') =
      //   (resolved_at is not null). resolveReconciliationItem stamped
      //   resolved_at on every outcome, so "Needs chasing" and "Doesn't
      //   matter" always failed here, the very outcomes a refund still in
      //   progress needs.
      const outcomes = ["resolved", "manual_review", "ignored"] as const;
      const ids: string[] = [];
      for (const outcome of outcomes) {
        const row = await one(
          `insert into public.billing_reconciliation_items
             (store_id, kind, status, invoice_id, provider_payment_id, detail)
           values (null, 'orphan_payment', 'open', $1, $2,
                   '{"note": "payment captured for a deleted store"}'::jsonb)
           returning id`,
          [ISSUED, `pay_ret_${tag}_${outcome}`],
        );
        ids.push(String(row?.id));
      }
      for (const [i, outcome] of outcomes.entries()) {
        expect(
          await resolveReconciliationItem({
            id: ids[i]!,
            status: outcome,
            note: `Closed as ${outcome}`,
            actor: operator.email,
          }),
          outcome,
        ).toEqual({ ok: true });
        expect(
          await one(
            `select status, resolved_by, resolved_at is not null as stamped
               from public.billing_reconciliation_items where id = $1`,
            [ids[i]],
          ),
          outcome,
        ).toEqual({
          status: outcome,
          resolved_by: operator.email,
          stamped: outcome === "resolved",
        });
      }
    });

    it("the guard still freezes a kept invoice's money, number, kind, parties, store and printed identifiers, and refuses deleting it", async () => {
      const attempts: [string, string, unknown[]][] = [
        [
          "money",
          "update public.billing_invoices set subtotal_paise = subtotal_paise + 100, total_paise = total_paise + 100 where id = $1",
          [ISSUED],
        ],
        [
          "tax",
          "update public.billing_invoices set tax_paise = tax_paise + 100, total_paise = total_paise + 100 where id = $1",
          [ISSUED],
        ],
        [
          "number",
          "update public.billing_invoices set invoice_no = invoice_no + 100000 where id = $1",
          [ISSUED],
        ],
        [
          "reference",
          "update public.billing_invoices set invoice_ref = invoice_ref || '-X' where id = $1",
          [ISSUED],
        ],
        [
          "kind",
          "update public.billing_invoices set kind = 'addon', cycle_seq = null, addon_target_count = 1 where id = $1",
          [ISSUED],
        ],
        [
          "move to another store",
          "update public.billing_invoices set store_id = $2 where id = $1",
          [ISSUED, OTHER],
        ],
        [
          "rewrite the parties",
          "update public.billing_invoices set parties = '{}'::jsonb where id = $1",
          [ISSUED],
        ],
        [
          "erase the parties",
          "update public.billing_invoices set parties = null where id = $1",
          [ISSUED],
        ],
        // ★ What the document prints from the row (0245): the issue date,
        //   the financial year, both GSTINs and the place of supply.
        [
          "move the issue date",
          "update public.billing_invoices set finalized_at = finalized_at - interval '400 days' where id = $1",
          [ISSUED],
        ],
        [
          "financial year",
          "update public.billing_invoices set fy_label = '1999-00' where id = $1",
          [ISSUED],
        ],
        [
          "supplier GSTIN",
          "update public.billing_invoices set supplier_gstin = '27AABCS1429B1ZX' where id = $1",
          [ISSUED],
        ],
        [
          "customer GSTIN",
          "update public.billing_invoices set customer_gstin = null where id = $1",
          [ISSUED],
        ],
        [
          "place of supply",
          "update public.billing_invoices set place_of_supply = '07' where id = $1",
          [ISSUED],
        ],
        // ★ Kept means kept: the store is gone and the invoice still is not
        //   deletable, issued unpaid or paid.
        [
          "delete",
          "delete from public.billing_invoices where id = $1",
          [ISSUED],
        ],
        [
          "delete an unpaid one",
          "delete from public.billing_invoices where id = $1",
          [ISSUED_UNPAID],
        ],
        [
          "delete its lines",
          "delete from public.billing_invoice_items where invoice_id = $1",
          [ISSUED],
        ],
      ];
      for (const [label, statement, params] of attempts) {
        expect(
          { label, error: await refused(statement, params) },
          label,
        ).toMatchObject({ error: expect.stringMatching(/is finalized/) });
      }
      // A status change is not one of them: refunds still record against it.
      expect(
        await refused(
          "update public.billing_invoices set status = 'refunded' where id = $1",
          [ISSUED],
        ),
      ).toBeNull();
    });
  },
);
