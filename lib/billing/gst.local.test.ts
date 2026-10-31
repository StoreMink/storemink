/** Rollback-only checks, against local Postgres, of GST on StoreMink's own
 * fees (plan Part E2). Case 1 is migration 0266
 * (20261029_0266_gst_on_storemink_fees) on a real database: it is in the
 * ledger and every check of its manifest entry passes; the functions the
 * database runs are the file's; replaying the file over 0245's guard marks an
 * issued invoice whose GST line says "(included)" and validates every
 * constraint the data meets, while a row that breaks one (GST already on with
 * no SAC code, a 3-character invoice prefix) leaves only that one NOT VALID
 * and still refuses the next write of the row; the settings, billing-account,
 * invoice and credit-purchase CHECKs refuse what they must; an invoice
 * charging GST is issued only as a complete tax invoice once StoreMink has a
 * SAC code, also for `app_service`, which has no EXECUTE on the trigger
 * function; and the parties record carries the LLP's particulars, the
 * merchant's State only when the place of supply came from their own records,
 * their country outside India and their signup address. Run with
 * BILLING_GST_LOCAL_TEST=1 after `npm run db:migrate:local -- apply`; the
 * fixed loopback database keeps it away from Cloud SQL, and everything
 * happens inside one transaction that is rolled back.
 *
 * Cases 6 and 8 buy a credit pack through the real server actions
 * (startCreditPurchase, then confirmCreditPurchase) with GST on: the order,
 * the purchase row and the paid invoice all carry Rs 69.62 for a Rs 59 pack,
 * and a merchant known only by the address given at signup is invoiced at
 * that address. The gateway is a mock that refuses to reach Razorpay.
 *
 * Case 7 runs the renewal worker (no gateway) over merchants created for it,
 * each scenario in its own savepoint: a renewal built before a scheduled
 * start of GST stays untaxed, the first one built after it adds GST and its
 * notice says why, a merchant whose records name no State is charged as if in
 * StoreMink's State (logged once), and one billed outside India renews at
 * place of supply 96 with IGST (logged, never refused).
 *
 * Case 10 schedules a GST change against real platform_announcements rows:
 * a failed send, an SMS-only notice, one to Pro stores only and product news
 * are each refused with their own sentence, while an Operational email notice
 * to every owner, partly delivered, sent 32 days before the start is accepted
 * and kept with the change; the change is withdrawn while its start is ahead,
 * and once it has started it is promoted, never withdrawn. Case 11 (A2) saves
 * the auto-refunds switch with GST off, then puts the row in branch B (GST on,
 * no SAC code, the identity check NOT VALID) and shows the save refused with
 * the sentence that says what to do, the row unchanged.
 *
 * ⚠ The two replays ALTER four billing tables, so for the second or two each
 *   takes they hold ACCESS EXCLUSIVE locks (released at once: each replay runs
 *   in a savepoint that is rolled back). Do not run this file beside the other
 *   billing locals, or with a dev server issuing invoices.
 * ⚠ Issuing takes the financial year's invoice and credit-note counter rows,
 *   which stay locked until the rollback: another session issuing on this
 *   database waits for the few seconds this file runs. */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
// Cases 2 to 12 add the withService mock and the code under test here.
import { vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import type { Db } from "@/lib/db/client";
import { platformInvoiceGst } from "./gst";
import { buildSubscriptionInvoice } from "./invoice";
import {
  ensureRenewalInvoice,
  issueInvoice,
  loadTaxSnapshot,
} from "./invoice-store";
import { sendEmail } from "@/lib/email/send";
import { logWarn } from "@/lib/observability/logger";
import { issueCapturedDrafts } from "./reconcile";
import { collectDueRenewals } from "./renewal-worker";
import {
  rzpCreateOrder,
  verifyCapturedCheckoutPayment,
} from "@/lib/payments/razorpay";
import {
  confirmCreditPurchase,
  startCreditPurchase,
} from "@/app/actions/ai-credit-actions";
// Cases 10 and 11 (Stage 9): StoreMink's own settings writes.
import {
  PROMOTED_BY,
  cancelScheduledTaxChange,
  earliestStartAfterNotice,
  promoteDueTaxChange,
  savePlatformAutoRefunds,
  saveTaxIdentity,
  scheduleTaxChange,
  type TaxChangeInput,
} from "./platform-settings";
import {
  AUTO_REFUNDS_IDENTITY_INCOMPLETE,
  TAX_SETTINGS_REFUSAL,
  noticeRefusal,
  tooSoonAfterNotice,
} from "./tax-copy";

/** The code under test runs on this test's own connection, inside its
 *  transaction, as `app_service` (the role `withService` takes in
 *  production), one scope at a time, each in a savepoint. */
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
    const name = `gst_issue_${++service.count}`;
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
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
// Case 9 (the repair pass) settles payments and sends receipts: the emails
// are recorded here, the platform's gateway keys are a test pair, and no
// Razorpay call leaves the machine (every read the pass makes is injected).
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({
  recordEvent: vi.fn(async () => {}),
  emitEvent: vi.fn(),
}));
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ sent: true })) };
});
vi.mock("@/lib/payments/provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/payments/provider")>();
  return {
    ...actual,
    getPlatformRazorpayCreds: vi.fn(() => ({
      keyId: "rzp_test_gst_local",
      keySecret: "gst_local_secret",
    })),
  };
});
vi.mock("@/lib/payments/razorpay", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/payments/razorpay")>();
  const offline = async () => {
    throw new Error("gst.local never calls Razorpay.");
  };
  return {
    ...actual,
    rzpFetchOrderPayments: vi.fn(offline),
    rzpFetchOrder: vi.fn(offline),
    // Cases 6 and 8 give these a gateway of their own, test by test.
    rzpCreateOrder: vi.fn(offline),
    verifyCapturedCheckoutPayment: vi.fn(offline),
    // An enrolment's completion reads the mandate from the payment: this one
    // registered none (renewals are invoiced).
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
  };
});

// Cases 6 and 8 run the credit-pack actions: the acting store and the
// signed-in admin come from here, and the pack is a fixed Rs 59 one.
const acting = vi.hoisted(() => ({ storeId: "" }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(async () => "gst-local-admin"),
  getActingStoreId: vi.fn(async () => acting.storeId),
}));
vi.mock("@/lib/ai/credit-pricing", () => ({
  getMinkCreditPackLive: vi.fn(async (id: string) =>
    id === "gst-local-pack"
      ? { id, name: "Starter", credits: 25, priceInr: 59 }
      : null,
  ),
  getMinkCreditPacksLive: vi.fn(async () => []),
}));

const enabled = process.env.BILLING_GST_LOCAL_TEST === "1";

const MIGRATION = "20261029_0266_gst_on_storemink_fees";
const FILE = readFileSync(`drizzle/migrations/sql/${MIGRATION}.sql`, "utf8");
const FILE_0245 = readFileSync(
  "drizzle/migrations/sql/20261026_0245_issued_invoice_guards.sql",
  "utf8",
);

const STORE = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const SIGNUP = crypto.randomUUID();
const tag = STORE.slice(0, 8);

const SUPPLIER_GSTIN = "03ABCDE1234F1Z5";
const MERCHANT_GSTIN = "07ABCDE1234F1Z5";
const SAC = "998314";
const LLPIN = "ADC-5432";
const OFFICE = "Bala ji Colony, Faridkot, Punjab, India";
const ADDRESS = JSON.stringify({
  line1: "Bala ji Colony",
  city: "Faridkot",
  postalCode: "151203",
});

/** The constraints 0266 adds NOT VALID and validates when the data allows. */
const NOT_VALID_CHECKS = [
  "platform_billing_sac_code_format",
  "platform_billing_llpin_format",
  "platform_billing_invoice_prefix_length",
  "platform_billing_next_tax_shape",
  "platform_billing_tax_needs_invoice_identity",
  "platform_billing_next_tax_needs_invoice_identity",
  "billing_accounts_gstin_format",
  "billing_accounts_gstin_matches_state",
  "billing_invoices_sac_code_format",
  "billing_invoices_place_of_supply_numeric",
  "billing_invoices_place_of_supply_basis",
];
const ALL_CONSTRAINTS = [
  ...NOT_VALID_CHECKS,
  "platform_billing_settings_next_tax_notice_fkey",
  "ai_credit_purchases_amount_paise_check",
];
const FUNCTIONS = [
  "billing_invoices_guard_tax_invoice",
  "billing_invoices_guard_immutable",
  "billing_invoice_parties",
  "billing_invoices_snapshot_parties",
];
const NOT_ISSUED = "is issued only with";
const FROZEN = "is finalized";

type Query = { name: string; sql: string; equals: string };
type ManifestEntry = {
  id: string;
  verify: {
    columns: string[];
    constraints: string[];
    functions: string[];
    queries: Query[];
  };
  applyVerify: { queries: Query[] };
};

/** The text between a function's `AS $$` and its closing `$$;`: what
 *  pg_proc.prosrc holds once the file has run. */
function functionSource(raw: string, name: string): string {
  const start = raw.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const open = raw.indexOf("AS $$", start);
  const close = raw.indexOf("$$;", open + 5);
  if (start < 0 || open < 0 || close < 0) throw new Error(`no ${name}`);
  return raw.slice(open + 5, close);
}

/** One whole CREATE OR REPLACE FUNCTION statement of a migration file. */
function functionStatement(raw: string, name: string): string {
  const start = raw.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const close = raw.indexOf("$$;", raw.indexOf("AS $$", start) + 5);
  if (start < 0 || close < 0) throw new Error(`no ${name}`);
  return raw.slice(start, close + 3);
}

describe.skipIf(!enabled)(
  "GST on StoreMink's own fees (local database)",
  () => {
    let client: Client;
    let prefix = "";

    const one = async (sqlText: string, params: unknown[] = []) =>
      (await client.query(sqlText, params)).rows[0] ?? null;

    /** Run one statement that must be refused, inside its own savepoint, and
     *  say how it was refused (null when it was not). */
    async function refused(sqlText: string, params: unknown[] = []) {
      await client.query("SAVEPOINT refusal");
      try {
        await client.query(sqlText, params);
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT refusal");
        const e = error as { code?: string; message?: string };
        return { code: e.code ?? "", message: e.message ?? String(error) };
      }
      await client.query("ROLLBACK TO SAVEPOINT refusal");
      return null;
    }

    /** As `app_service`, the role the billing code writes with. */
    async function asService<T>(fn: () => Promise<T>): Promise<T> {
      await client.query("SET ROLE app_service");
      try {
        return await fn();
      } finally {
        await client.query("RESET ROLE");
      }
    }

    async function validated(names: string[]) {
      const rows = (
        await client.query(
          `select conname, convalidated from pg_constraint
            where connamespace = 'public'::regnamespace and conname = any($1::text[])`,
          [names],
        )
      ).rows as { conname: string; convalidated: boolean }[];
      return Object.fromEntries(rows.map((r) => [r.conname, r.convalidated]));
    }

    async function insertInvoice(input: {
      id?: string;
      store?: string;
      kind?: "addon" | "ai_credits";
      subtotal: number;
      tax: number;
      rateBps?: number | null;
      supplierGstin?: string | null;
      customerGstin?: string | null;
      placeOfSupply?: string | null;
      basis?: string | null;
      sac?: string | null;
    }) {
      const id = input.id ?? crypto.randomUUID();
      await client.query(
        `insert into public.billing_invoices
           (id, store_id, kind, status, subtotal_paise, discount_paise, tax_paise,
            total_paise, tax_rate_bps, supplier_gstin, customer_gstin,
            place_of_supply, place_of_supply_basis, sac_code)
         values ($1, $2, $3, 'draft', $4, 0, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          input.store ?? STORE,
          input.kind ?? "addon",
          input.subtotal,
          input.tax,
          input.subtotal + input.tax,
          input.rateBps === undefined
            ? input.tax > 0
              ? 1800
              : 0
            : input.rateBps,
          input.supplierGstin === undefined
            ? input.tax > 0
              ? SUPPLIER_GSTIN
              : null
            : input.supplierGstin,
          input.customerGstin ?? null,
          input.placeOfSupply ?? null,
          input.basis ?? null,
          input.sac ?? null,
        ],
      );
      return id;
    }

    const issue = (id: string) =>
      client.query(
        `update public.billing_invoices set finalized_at = now(), status = 'open'
          where id = $1`,
        [id],
      );
    const issueSql = `update public.billing_invoices set finalized_at = now(), status = 'open'
                       where id = $1`;

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.BILLING_GST_LOCAL_TEST_USER || process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");

      const ledger = await one(
        "select 1 as ok from public.schema_migrations where id = $1",
        [MIGRATION],
      );
      if (!ledger) {
        throw new Error(
          `${MIGRATION} is not applied to storemink_local: run npm run db:migrate:local -- apply first.`,
        );
      }

      // StoreMink's settings row as a fresh environment has it: GST off,
      // nothing scheduled, no SAC code (so the issuing check waits).
      const normalised = await client.query(
        `update public.platform_billing_settings
            set tax_enabled = false, next_tax_enabled = null,
                next_tax_inclusive = null, next_tax_rate_bps = null,
                next_tax_starts_at = null, next_tax_notice_id = null,
                sac_code = null
          where id
          returning invoice_prefix`,
      );
      expect(normalised.rowCount).toBe(1);
      prefix = String(normalised.rows[0].invoice_prefix);

      await client.query(
        `insert into public.stores (id, name, slug, settings) values
           ($1, 'GST Probe', $2, '{}'::jsonb),
           ($3, 'GST Probe Other', $4, '{}'::jsonb),
           ($5, 'GST Probe Signup', $6, $7::jsonb)`,
        [
          STORE,
          `gst-probe-${tag}`,
          OTHER,
          `gst-probe-other-${tag}`,
          SIGNUP,
          `gst-probe-signup-${tag}`,
          JSON.stringify({
            business: {
              country: "IN",
              addressLine1: "5 Mall Road",
              addressLine2: "Shop 2",
              city: "Ludhiana",
              state: "Punjab",
              postalCode: "141001",
            },
          }),
        ],
      );
      await client.query(
        "insert into public.billing_accounts (store_id) values ($1)",
        [STORE],
      );
    });

    afterAll(async () => {
      if (!client) return;
      await client.query("ROLLBACK");
      await client.end();
    });

    it("case 1: 0266 is in the ledger and every check of its manifest entry passes", async () => {
      const entry = (
        JSON.parse(
          readFileSync("drizzle/migrations/manifest.json", "utf8"),
        ) as { migrations: ManifestEntry[] }
      ).migrations.find((m) => m.id === MIGRATION)!;
      expect(entry).toBeDefined();

      const missing: string[] = [];
      for (const value of entry.verify.columns) {
        const [table, column] = value.split(".");
        const row = await one(
          `select 1 as ok from information_schema.columns
            where table_schema = 'public' and table_name = $1 and column_name = $2`,
          [table, column],
        );
        if (!row) missing.push(value);
      }
      const present = await validated(entry.verify.constraints);
      for (const name of entry.verify.constraints) {
        if (!(name in present)) missing.push(name);
      }
      for (const fn of entry.verify.functions) {
        const row = await one("select to_regprocedure($1) as object", [
          `public.${fn}`,
        ]);
        if (!row?.object) missing.push(fn);
      }
      expect(missing).toEqual([]);

      for (const query of [
        ...entry.verify.queries,
        ...entry.applyVerify.queries,
      ]) {
        const row = await one(query.sql);
        const actual = row ? row[Object.keys(row)[0]] : undefined;
        expect(actual, query.name).toBe(query.equals);
      }
    });

    it("case 1: the database runs the file's functions, and every constraint is validated", async () => {
      for (const name of FUNCTIONS) {
        const row = await one(
          `select p.prosrc from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = $1`,
          [name],
        );
        expect(row?.prosrc, name).toBe(functionSource(FILE, name));
      }
      expect(await validated(ALL_CONSTRAINTS)).toEqual(
        Object.fromEntries(ALL_CONSTRAINTS.map((name) => [name, true])),
      );
    });

    it("case 1: replayed over 0245's guard, the file marks an issued invoice whose GST line says (included) and validates every constraint", async () => {
      await client.query("SAVEPOINT replay");
      try {
        // What 0266 found on a real environment: 0245's guard, which does
        // not know tax_inclusive, and invoices issued with each price basis.
        await client.query(
          functionStatement(FILE_0245, "billing_invoices_guard_immutable"),
        );
        const included = await insertInvoice({
          subtotal: 127_119,
          tax: 22_881,
        });
        const excluded = await insertInvoice({
          subtotal: 150_000,
          tax: 27_000,
        });
        await client.query(
          `insert into public.billing_invoice_items
             (invoice_id, kind, description, quantity, unit_amount_paise, amount_paise, sort_order)
           values ($1, 'location', 'Extra location', 1, 150000, 150000, 0),
                  ($1, 'tax', 'GST @ 18% (included)', 1, 22881, 22881, 1),
                  ($2, 'location', 'Extra location', 1, 150000, 150000, 0),
                  ($2, 'tax', 'GST @ 18%', 1, 27000, 27000, 1)`,
          [included, excluded],
        );
        await issue(included);
        await issue(excluded);

        await client.query(FILE);

        const marked = (
          await client.query(
            `select id, tax_inclusive from public.billing_invoices
              where id = any($1::uuid[])`,
            [[included, excluded]],
          )
        ).rows as { id: string; tax_inclusive: boolean }[];
        expect(
          Object.fromEntries(marked.map((r) => [r.id, r.tax_inclusive])),
        ).toEqual({ [included]: true, [excluded]: false });
        expect(await validated(ALL_CONSTRAINTS)).toEqual(
          Object.fromEntries(ALL_CONSTRAINTS.map((name) => [name, true])),
        );
        // The replay put 0266's guard back, so the column is frozen again.
        expect(
          (
            await refused(
              "update public.billing_invoices set tax_inclusive = false where id = $1",
              [included],
            )
          )?.message,
        ).toContain(FROZEN);
      } finally {
        // Rolling the savepoint back also releases the replay's table locks.
        await client.query("ROLLBACK TO SAVEPOINT replay");
        await client.query("RELEASE SAVEPOINT replay");
      }
    });

    it("case 1: a row that breaks a constraint leaves only that one NOT VALID, the issuing check still waits for a SAC code, and the next write must fix the row", async () => {
      await client.query("SAVEPOINT branch_b");
      try {
        // GST switched on before this release (so no SAC code), and a
        // 3-character invoice prefix.
        await client.query(
          `alter table public.platform_billing_settings
             drop constraint platform_billing_tax_needs_invoice_identity,
             drop constraint platform_billing_invoice_prefix_length`,
        );
        await client.query(
          `update public.platform_billing_settings
              set tax_enabled = true, gstin = $1, state_code = '03',
                  legal_name = 'STOREMINK LLP', invoice_prefix = 'SMX'
            where id`,
          [SUPPLIER_GSTIN],
        );

        await client.query(FILE);

        expect(await validated(ALL_CONSTRAINTS)).toEqual(
          Object.fromEntries(
            ALL_CONSTRAINTS.map((name) => [
              name,
              name !== "platform_billing_tax_needs_invoice_identity" &&
                name !== "platform_billing_invoice_prefix_length",
            ]),
          ),
        );

        // The replaced revision keeps issuing taxed invoices during the
        // rollout: no SAC code, no basis, and the trigger lets it through.
        const legacy = await insertInvoice({ subtotal: 100_000, tax: 18_000 });
        await asService(() => issue(legacy));
        const issued = await one(
          "select invoice_ref, sac_code, place_of_supply_basis from public.billing_invoices where id = $1",
          [legacy],
        );
        expect(issued?.invoice_ref).toMatch(/^SMX\/\d{4}-\d{2}\/\d{5}$/);
        expect(issued?.sac_code).toBeNull();
        expect(issued?.place_of_supply_basis).toBeNull();

        // A NOT VALID CHECK still governs every later write of the row.
        const write = await refused(
          "update public.platform_billing_settings set auto_refunds = true where id",
        );
        expect(write?.code).toBe("23514");
        await client.query(
          `update public.platform_billing_settings
              set sac_code = $1, llpin = $2, registered_office = $3,
                  address = $4::jsonb, invoice_prefix = 'SM', auto_refunds = true
            where id`,
          [SAC, LLPIN, OFFICE, ADDRESS],
        );
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT branch_b");
        await client.query("RELEASE SAVEPOINT branch_b");
      }
    });

    it("case 1: before StoreMink has a SAC code a taxed invoice issues with nothing stamped (the rollout exemption)", async () => {
      const id = await insertInvoice({ subtotal: 100_000, tax: 18_000 });
      await asService(() => issue(id));
      const row = await one(
        "select invoice_ref, sac_code, place_of_supply_basis, tax_inclusive from public.billing_invoices where id = $1",
        [id],
      );
      expect(row?.invoice_ref).toMatch(
        new RegExp(`^${prefix}/\\d{4}-\\d{2}/\\d{5}$`),
      );
      expect(row?.sac_code).toBeNull();
      expect(row?.place_of_supply_basis).toBeNull();
      expect(row?.tax_inclusive).toBe(false);
    });

    it("case 1: StoreMink's settings refuse GST on, or scheduled, without a complete tax identity", async () => {
      // The auto-refunds switch saves while GST is off (A2, branch A).
      await client.query(
        "update public.platform_billing_settings set auto_refunds = true where id",
      );
      await client.query(
        "update public.platform_billing_settings set auto_refunds = false where id",
      );

      const cases: [string, string, unknown[], string][] = [
        [
          "GST on with a SAC code but no LLPIN or registered office",
          `update public.platform_billing_settings
              set tax_enabled = true, gstin = $1, state_code = '03',
                  legal_name = 'STOREMINK LLP', sac_code = $2, address = $3::jsonb
            where id`,
          [SUPPLIER_GSTIN, SAC, ADDRESS],
          "platform_billing_tax_needs_invoice_identity",
        ],
        [
          "GST on with the LLP particulars but no PIN",
          `update public.platform_billing_settings
              set tax_enabled = true, gstin = $1, state_code = '03',
                  legal_name = 'STOREMINK LLP', sac_code = $2, llpin = $3,
                  registered_office = $4,
                  address = '{"line1":"Bala ji Colony","city":"Faridkot"}'::jsonb
            where id`,
          [SUPPLIER_GSTIN, SAC, LLPIN, OFFICE],
          "platform_billing_tax_needs_invoice_identity",
        ],
        [
          "GST scheduled on without a SAC code",
          `update public.platform_billing_settings
              set gstin = $1, state_code = '03', legal_name = 'STOREMINK LLP',
                  llpin = $2, registered_office = $3, address = $4::jsonb,
                  next_tax_enabled = true, next_tax_inclusive = false,
                  next_tax_rate_bps = 1800,
                  next_tax_starts_at = now() + interval '31 days'
            where id`,
          [SUPPLIER_GSTIN, LLPIN, OFFICE, ADDRESS],
          "platform_billing_next_tax_needs_invoice_identity",
        ],
        [
          "GST scheduled on with a blank registered office",
          `update public.platform_billing_settings
              set gstin = $1, state_code = '03', legal_name = 'STOREMINK LLP',
                  sac_code = $2, llpin = $3, registered_office = '  ',
                  address = $4::jsonb, next_tax_enabled = true,
                  next_tax_inclusive = false, next_tax_rate_bps = 1800,
                  next_tax_starts_at = now() + interval '31 days'
            where id`,
          [SUPPLIER_GSTIN, SAC, LLPIN, ADDRESS],
          "platform_billing_next_tax_needs_invoice_identity",
        ],
      ];
      for (const [label, sqlText, params, constraint] of cases) {
        const error = await refused(sqlText, params);
        expect(error?.code, label).toBe("23514");
        expect(error?.message, label).toContain(constraint);
      }

      // The identity complete, GST still off, a change scheduled 31 days on.
      await client.query(
        `update public.platform_billing_settings
            set gstin = $1, state_code = '03', legal_name = 'STOREMINK LLP',
                sac_code = $2, llpin = $3, registered_office = $4,
                address = $5::jsonb, next_tax_enabled = true,
                next_tax_inclusive = false, next_tax_rate_bps = 1800,
                next_tax_starts_at = now() + interval '31 days'
          where id`,
        [SUPPLIER_GSTIN, SAC, LLPIN, OFFICE, ADDRESS],
      );

      const later: [string, string, unknown[], string, string][] = [
        [
          "a half-filled scheduled change",
          "update public.platform_billing_settings set next_tax_inclusive = null where id",
          [],
          "23514",
          "platform_billing_next_tax_shape",
        ],
        [
          "a malformed SAC code",
          "update public.platform_billing_settings set sac_code = '12345' where id",
          [],
          "23514",
          "platform_billing_sac_code_format",
        ],
        [
          "a malformed LLPIN",
          "update public.platform_billing_settings set llpin = 'adc5432' where id",
          [],
          "23514",
          "platform_billing_llpin_format",
        ],
        [
          "clearing the LLPIN while GST is scheduled on",
          "update public.platform_billing_settings set llpin = null where id",
          [],
          "23514",
          "platform_billing_next_tax_needs_invoice_identity",
        ],
        [
          "clearing the PIN while GST is scheduled on",
          `update public.platform_billing_settings
              set address = '{"line1":"Bala ji Colony","city":"Faridkot"}'::jsonb where id`,
          [],
          "23514",
          "platform_billing_next_tax_needs_invoice_identity",
        ],
        [
          "a 3-character invoice prefix",
          "update public.platform_billing_settings set invoice_prefix = 'SMX' where id",
          [],
          "23514",
          "platform_billing_invoice_prefix_length",
        ],
        [
          "a scheduled rate above 100%",
          "update public.platform_billing_settings set next_tax_rate_bps = 10001 where id",
          [],
          "23514",
          "platform_billing_next_tax_shape",
        ],
        [
          "a notice that names no announcement",
          "update public.platform_billing_settings set next_tax_notice_id = $1 where id",
          [crypto.randomUUID()],
          "23503",
          "platform_billing_settings_next_tax_notice_fkey",
        ],
      ];
      for (const [label, sqlText, params, code, constraint] of later) {
        const error = await refused(sqlText, params);
        expect(error?.code, label).toBe(code);
        expect(error?.message, label).toContain(constraint);
      }

      // The change starts: the in-force columns take it (what the hourly
      // run does), and the identity can no longer be blanked.
      await client.query(
        `update public.platform_billing_settings
            set tax_enabled = next_tax_enabled, tax_inclusive = next_tax_inclusive,
                tax_rate_bps = next_tax_rate_bps, next_tax_enabled = null,
                next_tax_inclusive = null, next_tax_rate_bps = null,
                next_tax_starts_at = null, next_tax_notice_id = null
          where id`,
      );
      expect(
        await one(
          "select tax_enabled, tax_inclusive, tax_rate_bps from public.platform_billing_settings",
        ),
      ).toEqual({
        tax_enabled: true,
        tax_inclusive: false,
        tax_rate_bps: 1800,
      });
      for (const sqlText of [
        "update public.platform_billing_settings set legal_name = '  ' where id",
        "update public.platform_billing_settings set registered_office = null where id",
      ]) {
        expect((await refused(sqlText))?.message, sqlText).toContain(
          "platform_billing_tax_needs_invoice_identity",
        );
      }
    });

    it("case 1: a merchant's GSTIN must be well formed and agree with the state saved beside it", async () => {
      const cases: [string, string | null, string][] = [
        [MERCHANT_GSTIN, "03", "billing_accounts_gstin_matches_state"],
        ["07ABC", "07", "billing_accounts_gstin_format"],
        [MERCHANT_GSTIN, null, "billing_accounts_gstin_matches_state"],
      ];
      for (const [gstin, state, constraint] of cases) {
        const error = await refused(
          "update public.billing_accounts set gstin = $1, state_code = $2 where store_id = $3",
          [gstin, state, STORE],
        );
        expect(error?.message, `${gstin} ${state}`).toContain(constraint);
      }
      await client.query(
        `update public.billing_accounts
            set gstin = $1, state_code = '07', legal_name = 'GST Probe Foods LLP',
                address = $2::jsonb
          where store_id = $3`,
        [
          MERCHANT_GSTIN,
          JSON.stringify({
            line1: "12 Radial Road",
            city: "New Delhi",
            postalCode: "110001",
            country: "IN",
            countryName: "India",
          }),
          STORE,
        ],
      );
    });

    it("case 1: once StoreMink has a SAC code an invoice charging GST is issued only as a complete tax invoice, also by app_service", async () => {
      const draft = await insertInvoice({
        kind: "ai_credits",
        subtotal: 5_900,
        tax: 1_062,
        customerGstin: MERCHANT_GSTIN,
        placeOfSupply: "07",
      });

      // No SAC code, then no basis for the place of supply: refused, for
      // app_service too (it has no EXECUTE on the trigger function, and a
      // trigger fires whatever the caller's grant).
      const noSac = await asService(() => refused(issueSql, [draft]));
      expect(noSac?.message).toContain(NOT_ISSUED);
      await client.query(
        "update public.billing_invoices set sac_code = $1 where id = $2",
        [SAC, draft],
      );
      const noBasis = await asService(() => refused(issueSql, [draft]));
      expect(noBasis?.message).toContain(NOT_ISSUED);

      await client.query(
        "update public.billing_invoices set place_of_supply_basis = 'recipient' where id = $1",
        [draft],
      );
      await asService(() => issue(draft));
      const row = await one(
        `select invoice_ref, sac_code, tax_inclusive, place_of_supply_basis,
                parties -> 'supplier' ->> 'llpin' as llpin,
                parties -> 'supplier' ->> 'registeredOffice' as office,
                parties -> 'customer' ->> 'stateCode' as customer_state,
                parties -> 'customer' -> 'country' as customer_country,
                parties -> 'customer' -> 'address' as customer_address
           from public.billing_invoices where id = $1`,
        [draft],
      );
      expect(row?.invoice_ref).toMatch(
        new RegExp(`^${prefix}/\\d{4}-\\d{2}/\\d{5}$`),
      );
      expect(String(row?.invoice_ref).length).toBeLessThanOrEqual(16);
      expect(row).toMatchObject({
        sac_code: SAC,
        tax_inclusive: false,
        place_of_supply_basis: "recipient",
        llpin: LLPIN,
        office: OFFICE,
        customer_state: "07",
        customer_country: null,
        customer_address: {
          line1: "12 Radial Road",
          city: "New Delhi",
          postalCode: "110001",
        },
      });

      // Frozen once issued; the status still moves.
      for (const [column, value] of [
        ["sac_code", "997331"],
        ["tax_inclusive", "true"],
        ["place_of_supply_basis", "supplier"],
      ]) {
        const error = await refused(
          `update public.billing_invoices set ${column} = $1 where id = $2`,
          [value, draft],
        );
        expect(error?.message, column).toContain(FROZEN);
      }
      await client.query(
        "update public.billing_invoices set status = 'paid', paid_at = now() where id = $1",
        [draft],
      );

      // A taxed invoice inserted already issued without a place of supply.
      const inserted = await asService(() =>
        refused(
          `insert into public.billing_invoices
             (store_id, kind, status, subtotal_paise, tax_paise, total_paise,
              tax_rate_bps, supplier_gstin, sac_code, finalized_at)
           values ($1, 'addon', 'open', 1000, 180, 1180, 1800, $2, $3, now())`,
          [STORE, SUPPLIER_GSTIN, SAC],
        ),
      );
      expect(inserted?.message).toContain(NOT_ISSUED);

      // An untaxed invoice issues with nothing stamped.
      const untaxed = await insertInvoice({ subtotal: 40_000, tax: 0 });
      await asService(() => issue(untaxed));
      expect(
        await one(
          "select tax_paise::int as tax_paise, sac_code, place_of_supply_basis from public.billing_invoices where id = $1",
          [untaxed],
        ),
      ).toEqual({ tax_paise: 0, sac_code: null, place_of_supply_basis: null });
    });

    it("case 1: the place of supply is two digits, and 96 belongs to a business outside India and nothing else", async () => {
      const cases: [string | null, string | null, string][] = [
        ["DL", null, "billing_invoices_place_of_supply_numeric"],
        ["96", "supplier", "billing_invoices_place_of_supply_basis"],
        ["07", "outside_india", "billing_invoices_place_of_supply_basis"],
        ["96", null, "billing_invoices_place_of_supply_basis"],
        ["07", "guess", "billing_invoices_place_of_supply_basis"],
        [null, "recipient", "billing_invoices_place_of_supply_basis"],
      ];
      for (const [place, basis, constraint] of cases) {
        const error = await refused(
          `insert into public.billing_invoices
             (store_id, kind, status, subtotal_paise, tax_paise, total_paise,
              place_of_supply, place_of_supply_basis)
           values ($1, 'addon', 'draft', 100, 0, 100, $2, $3)`,
          [STORE, place, basis],
        );
        expect(error?.message, `${place} ${basis}`).toContain(constraint);
      }
    });

    it("case 1: the parties record names the merchant's State only from their own records, and their country outside India", async () => {
      // StoreMink's own State as a fallback: no State for the merchant.
      const fallback = await insertInvoice({
        store: OTHER,
        subtotal: 100_000,
        tax: 18_000,
        placeOfSupply: "03",
        basis: "supplier",
        sac: SAC,
      });
      await asService(() => issue(fallback));

      // A business outside India: 96, no State, its country recorded.
      await client.query(
        `update public.billing_accounts
            set gstin = null, state_code = null, address = $1::jsonb
          where store_id = $2`,
        [
          JSON.stringify({
            line1: "500 Market St",
            city: "San Francisco",
            postalCode: "94105",
            country: "US",
            countryName: "United States",
          }),
          STORE,
        ],
      );
      const abroad = await insertInvoice({
        kind: "ai_credits",
        subtotal: 150_000,
        tax: 27_000,
        placeOfSupply: "96",
        basis: "outside_india",
        sac: SAC,
      });
      await asService(() => issue(abroad));

      const rows = (
        await client.query(
          `select id, place_of_supply,
                  parties -> 'customer' ->> 'stateCode' as customer_state,
                  parties -> 'customer' -> 'country' as customer_country,
                  parties -> 'customer' -> 'address' ->> 'city' as customer_city
             from public.billing_invoices where id = any($1::uuid[])`,
          [[fallback, abroad]],
        )
      ).rows;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[fallback]).toMatchObject({
        place_of_supply: "03",
        customer_state: null,
        customer_country: null,
      });
      expect(byId[abroad]).toMatchObject({
        place_of_supply: "96",
        customer_state: null,
        customer_country: { code: "US", name: "United States" },
        customer_city: "San Francisco",
      });

      // Credit notes cancelling both copy the place of supply and record no
      // State for the merchant either.
      await client.query(
        "update public.billing_invoices set status = 'void' where id = any($1::uuid[])",
        [[fallback, abroad]],
      );
      await client.query(
        `insert into public.billing_credit_notes
           (invoice_id, reason, taxable_paise, tax_paise, total_paise, issued_by)
         values ($1, 'invoice_cancelled', 100000, 18000, 118000, 'gst-local'),
                ($2, 'invoice_cancelled', 150000, 27000, 177000, 'gst-local')`,
        [fallback, abroad],
      );
      const notes = (
        await client.query(
          `select invoice_id, place_of_supply,
                  parties -> 'customer' ->> 'stateCode' as customer_state
             from public.billing_credit_notes where invoice_id = any($1::uuid[])`,
          [[fallback, abroad]],
        )
      ).rows;
      expect(
        Object.fromEntries(
          notes.map((n) => [
            n.invoice_id,
            [n.place_of_supply, n.customer_state],
          ]),
        ),
      ).toEqual({ [fallback]: ["03", null], [abroad]: ["96", null] });
    });

    it("case 1: with no billing account and no business address, the customer's address is the one given at signup", async () => {
      const customer = await one(
        "select public.billing_invoice_parties($1::uuid, $2, null, '03') -> 'customer' as c",
        [SIGNUP, SUPPLIER_GSTIN],
      );
      expect(customer?.c).toMatchObject({
        name: "GST Probe Signup",
        stateCode: "03",
        address: {
          line1: "5 Mall Road",
          line2: "Shop 2",
          city: "Ludhiana",
          postalCode: "141001",
        },
      });
      expect(customer?.c.country).toBeNull();

      await client.query(
        `update public.stores
            set settings = jsonb_set(settings, '{business,country}', '"AE"'::jsonb)
          where id = $1`,
        [SIGNUP],
      );
      const abroad = await one(
        "select public.billing_invoice_parties($1::uuid, $2, null, null) -> 'customer' -> 'country' as country",
        [SIGNUP, SUPPLIER_GSTIN],
      );
      expect(abroad?.country).toEqual({ code: "AE" });
    });

    it("case 1: a credit purchase records the exact amount charged, and older inserts without it still work", async () => {
      const zero = await refused(
        `insert into public.ai_credit_purchases (store_id, pack_id, credits, amount_inr, amount_paise)
         values ($1, 'small', 25, 59, 0)`,
        [STORE],
      );
      expect(zero?.message).toContain("ai_credit_purchases_amount_paise_check");
      await client.query(
        `insert into public.ai_credit_purchases (store_id, pack_id, credits, amount_inr, amount_paise)
         values ($1, 'small', 25, 59, 6962), ($1, 'small', 25, 59, null)`,
        [STORE],
      );

      // The replaced revision's own writes, with GST off again.
      await client.query(
        "update public.platform_billing_settings set tax_enabled = false where id",
      );
      const old = crypto.randomUUID();
      await client.query(
        `insert into public.billing_invoices
           (id, store_id, kind, status, subtotal_paise, discount_paise, tax_paise,
            total_paise, tax_rate_bps, supplier_gstin, customer_gstin, place_of_supply)
         values ($1, $2, 'ai_credits', 'draft', 5900, 0, 0, 5900, 0, null, null, null)`,
        [old, STORE],
      );
      await client.query(
        `update public.billing_invoices
            set finalized_at = now(), paid_at = now(), status = 'paid'
          where id = $1`,
        [old],
      );
      expect(
        await one(
          "select status, tax_inclusive, sac_code from public.billing_invoices where id = $1",
          [old],
        ),
      ).toEqual({ status: "paid", tax_inclusive: false, sac_code: null });
    });

    describe("cases 2 to 5: issuing a draft under the GST in force", () => {
      beforeAll(() => {
        service.client = client;
        service.db = drizzle(client, {
          schema: { ...schema, ...relations },
        }) as unknown as Db;
      });

      /** StoreMink's settings with GST on at 18% and the LLP's identity
       *  complete (Punjab, 03). Every column a NOT VALID check reads is set,
       *  because the next write of the row is checked. */
      async function gstOn(inclusive: boolean) {
        await client.query(
          `update public.platform_billing_settings
              set tax_enabled = true, tax_inclusive = $1, tax_rate_bps = 1800,
                  gstin = $2, state_code = '03', legal_name = 'STOREMINK LLP',
                  sac_code = $3, llpin = $4, registered_office = $5,
                  address = $6::jsonb, invoice_prefix = 'SM',
                  next_tax_enabled = null, next_tax_inclusive = null,
                  next_tax_rate_bps = null, next_tax_starts_at = null,
                  next_tax_notice_id = null
            where id`,
          [inclusive, SUPPLIER_GSTIN, SAC, LLPIN, OFFICE, ADDRESS],
        );
      }

      async function gstOff() {
        await gstOn(false);
        await client.query(
          "update public.platform_billing_settings set tax_enabled = false where id",
        );
      }

      /** A merchant whose Billing details name a State and nothing else. */
      async function merchantIn(stateCode: string) {
        const id = crypto.randomUUID();
        await client.query(
          `insert into public.stores (id, name, slug, settings)
           values ($1, $2, $3, '{}'::jsonb)`,
          [id, `GST Issue ${stateCode}`, `gst-issue-${id.slice(0, 8)}`],
        );
        await client.query(
          "insert into public.billing_accounts (store_id, state_code) values ($1, $2)",
          [id, stateCode],
        );
        return id;
      }

      /** A Basic monthly renewal draft (₹1,500), built and stamped by the
       *  real code under the terms in force now. */
      async function draftFor(store: string) {
        const now = new Date();
        const snap = await loadTaxSnapshot(store, now);
        if (!snap.ok) throw new Error("StoreMink's tax identity is incomplete");
        const row = await ensureRenewalInvoice({
          storeId: store,
          cycleSeq: 1,
          periodStart: now,
          periodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          built: buildSubscriptionInvoice({
            planLabel: "Basic",
            period: "monthly",
            planPaise: 1_500_00,
            tax: snap.tax,
          }),
          stamp: snap.stamp,
        });
        if (!row) throw new Error("the draft was not written");
        return row.id;
      }

      const stored = (id: string) =>
        one(
          `select status, invoice_ref, subtotal_paise::int as subtotal,
                  tax_paise::int as tax, total_paise::int as total,
                  tax_rate_bps as rate, tax_inclusive as inclusive,
                  supplier_gstin, customer_gstin, place_of_supply,
                  place_of_supply_basis as basis, sac_code,
                  finalized_at is not null as issued,
                  parties -> 'supplier' ->> 'llpin' as llpin,
                  parties -> 'supplier' ->> 'gstin' as party_supplier_gstin,
                  parties -> 'customer' ->> 'gstin' as party_customer_gstin
             from public.billing_invoices where id = $1`,
          [id],
        );

      const lines = async (id: string) =>
        (
          await client.query(
            `select kind, description, amount_paise::int as amount
               from public.billing_invoice_items
              where invoice_id = $1 order by sort_order`,
            [id],
          )
        ).rows;

      it("case 2: a draft built before GST, with a payment in flight, is issued at the same total with the GST carved out (Delhi, IGST)", async () => {
        await gstOff();
        const store = await merchantIn("07");
        const id = await draftFor(store);
        expect(await stored(id)).toMatchObject({
          total: 1_500_00,
          tax: 0,
          supplier_gstin: null,
          sac_code: null,
          issued: false,
        });
        await client.query(
          `insert into public.billing_payment_attempts
             (invoice_id, store_id, idempotency_key, mode, state, amount_paise)
           values ($1, $2, $3, 'manual', 'processing', 150000)`,
          [id, store, `gst-local-${id}`],
        );

        await gstOn(false);
        const result = await issueInvoice({ invoiceId: id });
        expect(result).toMatchObject({ claimed: true, restamp: "carved" });
        expect(result.invoice?.invoiceRef).toBeTruthy();

        const row = await stored(id);
        expect(row).toMatchObject({
          status: "open",
          issued: true,
          subtotal: 1_271_19,
          tax: 228_81,
          total: 1_500_00,
          rate: 1800,
          inclusive: true,
          supplier_gstin: SUPPLIER_GSTIN,
          customer_gstin: null,
          place_of_supply: "07",
          basis: "recipient",
          sac_code: SAC,
          llpin: LLPIN,
          party_supplier_gstin: SUPPLIER_GSTIN,
        });
        expect(row?.invoice_ref).toBe(result.invoice?.invoiceRef);
        expect(await lines(id)).toEqual([
          {
            kind: "base_plan",
            description: "Basic plan · 1 month",
            amount: 1_500_00,
          },
          { kind: "tax", description: "GST @ 18% (included)", amount: 228_81 },
        ]);
        // Delhi is another State from Punjab: all of it is IGST.
        expect(
          platformInvoiceGst({
            taxPaise: row!.tax,
            taxRateBps: row!.rate,
            supplierGstin: row!.supplier_gstin,
            placeOfSupply: row!.place_of_supply,
          }),
        ).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 228_81 });
      });

      it("case 3: with nothing paid against it, the same draft is re-priced with GST added (Punjab, CGST and SGST)", async () => {
        await gstOff();
        const store = await merchantIn("03");
        const id = await draftFor(store);

        await gstOn(false);
        const result = await issueInvoice({ invoiceId: id });
        expect(result).toMatchObject({ claimed: true, restamp: "rebuilt" });

        const row = await stored(id);
        expect(row).toMatchObject({
          status: "open",
          subtotal: 1_500_00,
          tax: 270_00,
          total: 1_770_00,
          rate: 1800,
          inclusive: false,
          supplier_gstin: SUPPLIER_GSTIN,
          place_of_supply: "03",
          basis: "recipient",
          sac_code: SAC,
          llpin: LLPIN,
        });
        expect(row?.invoice_ref).toBeTruthy();
        expect((await lines(id)).map((l) => [l.kind, l.description])).toEqual([
          ["base_plan", "Basic plan · 1 month"],
          ["tax", "GST @ 18%"],
        ]);
        // Punjab to Punjab: split equally between CGST and SGST.
        expect(
          platformInvoiceGst({
            taxPaise: row!.tax,
            taxRateBps: row!.rate,
            supplierGstin: row!.supplier_gstin,
            placeOfSupply: row!.place_of_supply,
          }),
        ).toMatchObject({ cgstPaise: 135_00, sgstPaise: 135_00, igstPaise: 0 });
      });

      it("case 4: GST starting with prices including it leaves the total alone and puts the GST inside it", async () => {
        await gstOff();
        const store = await merchantIn("07");
        const id = await draftFor(store);

        await gstOn(true);
        const result = await issueInvoice({ invoiceId: id });
        expect(result).toMatchObject({ claimed: true, restamp: "rebuilt" });
        expect(await stored(id)).toMatchObject({
          status: "open",
          subtotal: 1_271_19,
          tax: 228_81,
          total: 1_500_00,
          inclusive: true,
          supplier_gstin: SUPPLIER_GSTIN,
          sac_code: SAC,
          place_of_supply: "07",
        });
        expect((await lines(id)).at(-1)).toEqual({
          kind: "tax",
          description: "GST @ 18% (included)",
          amount: 228_81,
        });
      });

      it("case 5: a GSTIN the merchant saves after the draft was built is stamped at issue, the money unchanged", async () => {
        await gstOn(false);
        const store = await merchantIn("07");
        const id = await draftFor(store);
        expect(await stored(id)).toMatchObject({
          total: 1_770_00,
          customer_gstin: null,
          supplier_gstin: SUPPLIER_GSTIN,
        });

        await client.query(
          "update public.billing_accounts set gstin = $1, state_code = '07' where store_id = $2",
          [MERCHANT_GSTIN, store],
        );
        const result = await issueInvoice({ invoiceId: id });
        expect(result).toMatchObject({ claimed: true, restamp: "rebuilt" });
        expect(await stored(id)).toMatchObject({
          status: "open",
          total: 1_770_00,
          tax: 270_00,
          customer_gstin: MERCHANT_GSTIN,
          place_of_supply: "07",
          basis: "recipient",
          party_customer_gstin: MERCHANT_GSTIN,
        });
        // Only the particulars moved: the lines are the ones it was built with.
        expect((await lines(id)).map((l) => l.kind)).toEqual([
          "base_plan",
          "tax",
        ]);
      });

      it("case 5b (R1-03): a draft frozen under GST added, issued after GST is switched off, keeps its figures and is filed ONCE for a person", async () => {
        await gstOn(false);
        const store = await merchantIn("07");
        const id = await draftFor(store);
        const orderId = `order_kept_${id.slice(0, 8)}`;
        const attempt = await one(
          `insert into public.billing_payment_attempts
             (invoice_id, store_id, idempotency_key, mode, state, amount_paise,
              provider_order_id)
           values ($1, $2, $3, 'manual', 'processing', 177000, $4)
           returning id`,
          [id, store, `gst-local-kept-${id}`, orderId],
        );

        // No reading reproduces ₹1,770 once GST is off (R1's probe).
        await gstOff();
        const result = await issueInvoice({ invoiceId: id });
        expect(result).toMatchObject({ claimed: true, restamp: "kept_draft" });
        expect(await stored(id)).toMatchObject({
          status: "open",
          issued: true,
          total: 1_770_00,
          tax: 270_00,
          rate: 1800,
          inclusive: false,
        });

        const filed = async () =>
          (
            await client.query(
              `select kind, status, invoice_id, attempt_id, provider_order_id,
                      provider_payment_id, expected_paise::int as expected,
                      detail ->> 'repair_key' as repair_key,
                      (detail ->> 'draft_rate_bps')::int as draft_rate,
                      (detail ->> 'rate_bps')::int as rate,
                      detail ->> 'note' as note
                 from public.billing_reconciliation_items
                where invoice_id = $1`,
              [id],
            )
          ).rows;
        const rows = await filed();
        expect(rows).toEqual([
          {
            kind: "state_conflict",
            status: "open",
            invoice_id: id,
            attempt_id: attempt!.id,
            provider_order_id: orderId,
            provider_payment_id: null,
            expected: 1_770_00,
            repair_key: `kept_draft:${id}`,
            draft_rate: 1800,
            rate: 0,
            note: expect.stringMatching(/18% GST added.*no GST/),
          },
        ]);

        // Once per key in every status: a second issue files nothing, and a
        // second filing of the same key is refused by the database.
        await issueInvoice({ invoiceId: id });
        const dup = await client.query(
          `insert into public.billing_reconciliation_items
             (store_id, kind, status, invoice_id, detail)
           values ($1, 'state_conflict', 'open', $2,
                   jsonb_build_object('repair_key', $3::text))
           on conflict do nothing
           returning id`,
          [store, id, `kept_draft:${id}`],
        );
        expect(dup.rows).toHaveLength(0);
        expect(await filed()).toHaveLength(1);
      });
    });

    describe("cases 6 and 8: a credit pack bought through the real actions", () => {
      /** The payments this gateway captured, by order id. */
      const captured = new Map<string, { id: string; amount: number }>();

      beforeAll(async () => {
        service.client = client;
        service.db = drizzle(client, {
          schema: { ...schema, ...relations },
        }) as unknown as Db;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new Error("No network in this test.");
          }),
        );
        // GST on at 18%, prices excluding it, the LLP's identity complete.
        await client.query(
          `update public.platform_billing_settings
              set tax_enabled = true, tax_inclusive = false, tax_rate_bps = 1800,
                  gstin = $1, state_code = '03', legal_name = 'STOREMINK LLP',
                  sac_code = $2, llpin = $3, registered_office = $4,
                  address = $5::jsonb, invoice_prefix = 'SM',
                  next_tax_enabled = null, next_tax_inclusive = null,
                  next_tax_rate_bps = null, next_tax_starts_at = null,
                  next_tax_notice_id = null
            where id`,
          [SUPPLIER_GSTIN, SAC, LLPIN, OFFICE, ADDRESS],
        );
      });

      afterAll(() => {
        vi.unstubAllGlobals();
        acting.storeId = "";
      });

      beforeEach(() => {
        // The order Razorpay would create for the amount asked for.
        vi.mocked(rzpCreateOrder).mockImplementation(async (_creds, input) => ({
          ok: true as const,
          data: {
            id: `order_gst_pack_${crypto.randomUUID().slice(0, 8)}`,
            amount: input.amountPaise,
            currency: "INR",
            receipt: input.receipt ?? null,
            status: "created",
          } as never,
        }));
        // The real check compares the captured payment with what it is told
        // to expect; this one does the same against the payments above.
        vi.mocked(verifyCapturedCheckoutPayment).mockImplementation(
          async (_creds, input) => {
            const payment = captured.get(input.orderId);
            return payment?.id === input.paymentId &&
              payment.amount === input.amountPaise
              ? { ok: true as const, gatewayRead: true as const }
              : {
                  ok: false as const,
                  error: "The captured amount does not match the invoice.",
                };
          },
        );
      });

      /** A store with the given settings and, when given, a billing account. */
      async function merchant(
        name: string,
        settings: Record<string, unknown>,
        accountStateCode: string | null,
      ) {
        const id = crypto.randomUUID();
        await client.query(
          `insert into public.stores (id, name, slug, settings)
           values ($1, $2, $3, $4::jsonb)`,
          [id, name, `gst-pack-${id.slice(0, 8)}`, JSON.stringify(settings)],
        );
        if (accountStateCode) {
          await client.query(
            "insert into public.billing_accounts (store_id, state_code) values ($1, $2)",
            [id, accountStateCode],
          );
        }
        return id;
      }

      /** Start a purchase as the store, have the gateway capture
       *  `capturedPaise` for it, and confirm with a valid signature. */
      async function buy(store: string, capturedPaise?: number) {
        acting.storeId = store;
        const started = await startCreditPurchase("gst-local-pack");
        if (!("success" in started)) throw new Error(started.error);
        const paymentId = `pay_gst_pack_${started.purchaseId.slice(0, 8)}`;
        captured.set(started.rzpOrderId, {
          id: paymentId,
          amount: capturedPaise ?? started.amountPaise,
        });
        const signature = createHmac("sha256", "gst_local_secret")
          .update(`${started.rzpOrderId}|${paymentId}`)
          .digest("hex");
        const confirmed = await confirmCreditPurchase(
          started.purchaseId,
          paymentId,
          signature,
        );
        return { started, paymentId, confirmed };
      }

      const purchaseRow = (id: string) =>
        one(
          `select p.status, p.amount_inr::int as amount_inr,
                  p.amount_paise::int as amount_paise, p.rzp_order_id,
                  p.rzp_payment_id, p.invoice_id
             from public.ai_credit_purchases p where p.id = $1`,
          [id],
        );

      const invoiceRow = (id: string) =>
        one(
          `select kind, status, invoice_ref, subtotal_paise::int as subtotal,
                  tax_paise::int as tax, total_paise::int as total,
                  tax_rate_bps as rate, tax_inclusive as inclusive,
                  supplier_gstin, customer_gstin, place_of_supply,
                  place_of_supply_basis as basis, sac_code,
                  finalized_at is not null as issued, paid_at is not null as paid,
                  parties -> 'supplier' ->> 'llpin' as llpin,
                  parties -> 'customer' as customer
             from public.billing_invoices where id = $1`,
          [id],
        );

      const invoiceLines = async (id: string) =>
        (
          await client.query(
            `select kind, description, amount_paise::int as amount
               from public.billing_invoice_items
              where invoice_id = $1 order by sort_order`,
            [id],
          )
        ).rows;

      it("case 6: a Rs 59 pack is ordered, recorded and invoiced at Rs 69.62 (Delhi, IGST), paid and numbered", async () => {
        const store = await merchant("GST Pack Delhi", {}, "07");
        const { started, paymentId, confirmed } = await buy(store);

        expect(started).toMatchObject({ success: true, amountPaise: 6_962 });
        expect(vi.mocked(rzpCreateOrder).mock.calls[0][1].amountPaise).toBe(
          6_962,
        );
        expect(confirmed).toEqual({ success: true, creditsAdded: 25 });
        // The payment was checked against the amount charged, not the list price.
        expect(
          vi.mocked(verifyCapturedCheckoutPayment).mock.calls[0][1],
        ).toMatchObject({ paymentId, amountPaise: 6_962 });

        const purchase = await purchaseRow(started.purchaseId);
        expect(purchase).toMatchObject({
          status: "paid",
          amount_inr: 59,
          amount_paise: 6_962,
          rzp_order_id: started.rzpOrderId,
          rzp_payment_id: paymentId,
        });
        expect(purchase?.invoice_id).toBeTruthy();

        const row = await invoiceRow(purchase!.invoice_id);
        expect(row).toMatchObject({
          kind: "ai_credits",
          status: "paid",
          issued: true,
          paid: true,
          subtotal: 5_900,
          tax: 1_062,
          total: 6_962,
          rate: 1800,
          inclusive: false,
          supplier_gstin: SUPPLIER_GSTIN,
          customer_gstin: null,
          place_of_supply: "07",
          basis: "recipient",
          sac_code: SAC,
          llpin: LLPIN,
        });
        expect(row?.invoice_ref).toBeTruthy();
        expect(await invoiceLines(purchase!.invoice_id)).toEqual([
          {
            kind: "ai_credits",
            description: "Mink credits · Starter (25 credits)",
            amount: 5_900,
          },
          { kind: "tax", description: "GST @ 18%", amount: 1_062 },
        ]);
        // Delhi is another State from Punjab: all of it is IGST.
        expect(
          platformInvoiceGst({
            taxPaise: row!.tax,
            taxRateBps: row!.rate,
            supplierGstin: row!.supplier_gstin,
            placeOfSupply: row!.place_of_supply,
          }),
        ).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 1_062 });
        // The credits were granted once, against this payment.
        expect(
          await one(
            `select count(*)::int as n, sum(delta)::int as credits
               from public.ai_credit_ledger
              where store_id = $1 and kind = 'purchase' and ref = $2`,
            [store, paymentId],
          ),
        ).toEqual({ n: 1, credits: 25 });
      });

      it("case 6: a payment captured at the list price is refused: no credits, the invoice stays an unnumbered draft", async () => {
        const store = await merchant("GST Pack Short", {}, "07");
        const { started, confirmed } = await buy(store, 5_900);

        expect(confirmed).toEqual({
          error: "The captured amount does not match the invoice.",
        });
        const purchase = await purchaseRow(started.purchaseId);
        expect(purchase).toMatchObject({
          status: "pending",
          amount_paise: 6_962,
        });
        expect(await invoiceRow(purchase!.invoice_id)).toMatchObject({
          status: "draft",
          issued: false,
          invoice_ref: null,
          total: 6_962,
        });
        expect(
          await one(
            "select count(*)::int as n from public.ai_credit_ledger where store_id = $1",
            [store],
          ),
        ).toEqual({ n: 0 });
      });

      it("case 6: GST on for a business outside India refuses the pack before anything is written", async () => {
        const store = await merchant("GST Pack Abroad", {}, null);
        await client.query(
          `insert into public.billing_accounts (store_id, address)
           values ($1, '{"country": "AE"}'::jsonb)`,
          [store],
        );
        acting.storeId = store;
        const started = await startCreditPurchase("gst-local-pack");
        expect(started).toEqual({
          error:
            "We can't take payments from businesses outside India yet. Write to support@storemink.com and we'll help.",
        });
        expect(rzpCreateOrder).not.toHaveBeenCalled();
        expect(
          await one(
            "select count(*)::int as n from public.ai_credit_purchases where store_id = $1",
            [store],
          ),
        ).toEqual({ n: 0 });
      });

      it("case 8: a merchant known only by the address given at signup is invoiced there (Punjab, CGST and SGST)", async () => {
        // No billing account and no Taxes & invoices identity: the signup
        // address is the only record, so it gives both the place of supply
        // and the customer's address on the invoice.
        const store = await merchant(
          "GST Pack Signup",
          {
            business: {
              country: "IN",
              addressLine1: "5 Mall Road",
              addressLine2: "Shop 2",
              city: "Ludhiana",
              state: "Punjab",
              postalCode: "141001",
            },
          },
          null,
        );
        const { started, confirmed } = await buy(store);
        expect(confirmed).toEqual({ success: true, creditsAdded: 25 });

        const purchase = await purchaseRow(started.purchaseId);
        const row = await invoiceRow(purchase!.invoice_id);
        expect(row).toMatchObject({
          status: "paid",
          issued: true,
          total: 6_962,
          tax: 1_062,
          place_of_supply: "03",
          basis: "recipient",
        });
        expect(row?.customer).toMatchObject({
          name: "GST Pack Signup",
          stateCode: "03",
          address: {
            line1: "5 Mall Road",
            line2: "Shop 2",
            city: "Ludhiana",
            postalCode: "141001",
          },
        });
        expect(row?.customer.country).toBeNull();
        // Punjab to Punjab: split equally between CGST and SGST.
        expect(
          platformInvoiceGst({
            taxPaise: row!.tax,
            taxRateBps: row!.rate,
            supplierGstin: row!.supplier_gstin,
            placeOfSupply: row!.place_of_supply,
          }),
        ).toMatchObject({ cgstPaise: 531, sgstPaise: 531, igstPaise: 0 });
      });
    });

    describe("case 7: renewals under the GST in force", () => {
      const MINUTE = 60_000;
      const HOUR = 60 * MINUTE;
      const DAY = 24 * HOUR;
      /** Every case 7 time is measured from here. */
      const NOW = new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
      const at = (ms: number) => new Date(NOW.getTime() + ms);
      /** Basic monthly at ₹1,500, no extra locations. */
      const priceFor = async () => ({
        planPaise: 1_500_00,
        locationPaise: 0,
        planLabel: "Basic",
      });
      /** The hourly pass with no gateway: it issues, it never charges. */
      const renew = (now: Date) =>
        collectDueRenewals({ now, charge: null, priceFor });

      beforeAll(() => {
        service.client = client;
        service.db = drizzle(client, {
          schema: { ...schema, ...relations },
        }) as unknown as Db;
      });

      beforeEach(async () => {
        await client.query("SAVEPOINT gst_case_7");
        // The worker's claim is not scoped to a store, so this case refuses
        // to run beside any other subscription the database would renew.
        const others = await one(
          `select count(*)::int as n from public.billing_subscriptions
            where state in ('active', 'past_due', 'grace')
              and cancel_at_period_end = false
              and current_period_end is not null
              and current_period_end <= $1`,
          [at(10 * DAY).toISOString()],
        );
        if (others?.n !== 0) {
          throw new Error(
            `${others?.n} other subscriptions are due on storemink_local; case 7 would renew them.`,
          );
        }
      });

      afterEach(async () => {
        await client.query("ROLLBACK TO SAVEPOINT gst_case_7");
        await client.query("RELEASE SAVEPOINT gst_case_7");
      });

      /** StoreMink's identity complete (Punjab, 03) and GST at 18% added on
       *  top of prices, in force now, with nothing scheduled. */
      async function gstAddedNow() {
        await client.query(
          `update public.platform_billing_settings
              set tax_enabled = true, tax_inclusive = false, tax_rate_bps = 1800,
                  gstin = $1, state_code = '03', legal_name = 'STOREMINK LLP',
                  sac_code = $2, llpin = $3, registered_office = $4,
                  address = $5::jsonb, invoice_prefix = 'SM',
                  next_tax_enabled = null, next_tax_inclusive = null,
                  next_tax_rate_bps = null, next_tax_starts_at = null,
                  next_tax_notice_id = null
            where id`,
          [SUPPLIER_GSTIN, SAC, LLPIN, OFFICE, ADDRESS],
        );
      }

      /** No GST today; 18% added on top scheduled from `startsAt`. */
      async function gstScheduled(startsAt: Date) {
        await gstAddedNow();
        await client.query(
          `update public.platform_billing_settings
              set tax_enabled = false, next_tax_enabled = true,
                  next_tax_inclusive = false, next_tax_rate_bps = 1800,
                  next_tax_starts_at = $1
            where id`,
          [startsAt.toISOString()],
        );
      }

      /** A merchant on Basic monthly, in cycle 1 until `periodEnd`, with a
       *  billing contact for the renewal notice. `account` is its billing
       *  account (a State, or a country), or none at all. */
      async function subscriber(
        label: string,
        periodEnd: Date,
        account: { stateCode?: string; country?: string } | null,
      ) {
        const id = crypto.randomUUID();
        await client.query(
          `insert into public.stores (id, name, slug, settings)
           values ($1, $2, $3, '{}'::jsonb)`,
          [id, `GST Renewal ${label}`, `gst-renewal-${id.slice(0, 8)}`],
        );
        await client.query(
          `insert into public.store_billing_settings
             (store_id, business_name, contact_email, contact_phone)
           values ($1, $2, $3, '9876543210')`,
          [
            id,
            `GST Renewal ${label} Traders`,
            `renewal-${id.slice(0, 8)}@probe.test`,
          ],
        );
        if (account) {
          await client.query(
            `insert into public.billing_accounts (store_id, state_code, address)
             values ($1, $2, $3::jsonb)`,
            [
              id,
              account.stateCode ?? null,
              JSON.stringify(
                account.country ? { country: account.country } : {},
              ),
            ],
          );
        }
        await client.query(
          `insert into public.billing_subscriptions
             (store_id, plan, period, state, current_cycle_seq,
              current_period_start, current_period_end, plan_source)
           values ($1, 'basic', 'monthly', 'active', 1, $2, $3, 'paid')`,
          [
            id,
            new Date(periodEnd.getTime() - 30 * DAY).toISOString(),
            periodEnd.toISOString(),
          ],
        );
        return id;
      }

      const renewal = (store: string, cycleSeq: number) =>
        one(
          `select status, finalized_at is not null as issued,
                  subtotal_paise::int as subtotal, tax_paise::int as tax,
                  total_paise::int as total, tax_rate_bps as rate,
                  tax_inclusive as inclusive, supplier_gstin, place_of_supply,
                  place_of_supply_basis as basis, sac_code
             from public.billing_invoices
            where store_id = $1 and kind = 'subscription' and cycle_seq = $2`,
          [store, cycleSeq],
        );

      /** The emails sent to one store during this test. */
      const notices = (store: string) =>
        vi
          .mocked(sendEmail)
          .mock.calls.map((call) => call[0])
          .filter((input) => input.storeId === store);

      const warned = (event: string, store: string) =>
        vi
          .mocked(logWarn)
          .mock.calls.some(
            ([name, context]) =>
              name === event &&
              (context as { storeId?: string } | undefined)?.storeId === store,
          );

      const split = (row: Record<string, unknown>) =>
        platformInvoiceGst({
          taxPaise: row.tax as number,
          taxRateBps: row.rate as number,
          supplierGstin: row.supplier_gstin as string | null,
          placeOfSupply: row.place_of_supply as string | null,
        });

      it("case 7: a renewal built before GST starts stays untaxed, and the first one built after it adds GST and says why", async () => {
        const startsAt = at(DAY);
        const later = at(2 * DAY);
        await gstScheduled(startsAt);

        // Built and issued before the start: no GST, though its cycle
        // begins after it.
        const early = await subscriber("Early", at(3 * DAY), {
          stateCode: "07",
        });
        expect(await renew(NOW)).toMatchObject({
          considered: 1,
          manualRequired: 1,
          errors: 0,
        });
        expect(await renewal(early, 2)).toMatchObject({
          status: "open",
          issued: true,
          subtotal: 1_500_00,
          tax: 0,
          total: 1_500_00,
          rate: 0,
          supplier_gstin: null,
          sac_code: null,
        });
        expect(notices(early).map((n) => n.subject)).toEqual([
          "₹1,500 due for your Basic plan",
        ]);

        // A merchant whose first cycle was issued and paid without GST.
        const late = await subscriber("Late", at(5 * DAY), {
          stateCode: "03",
        });
        const before = await loadTaxSnapshot(late, NOW);
        if (!before.ok)
          throw new Error("StoreMink's tax identity is incomplete");
        const cycleOne = await ensureRenewalInvoice({
          storeId: late,
          cycleSeq: 1,
          periodStart: at(-25 * DAY),
          periodEnd: at(5 * DAY),
          dueAt: at(-25 * DAY),
          built: buildSubscriptionInvoice({
            planLabel: "Basic",
            period: "monthly",
            planPaise: 1_500_00,
            tax: before.tax,
          }),
          stamp: before.stamp,
        });
        if (!cycleOne) throw new Error("cycle 1 was not written");
        expect(
          await issueInvoice({ invoiceId: cycleOne.id, now: NOW }),
        ).toMatchObject({ claimed: true });
        await client.query(
          `update public.billing_invoices set status = 'paid', paid_at = $2
            where id = $1`,
          [cycleOne.id, NOW.toISOString()],
        );
        expect(await renewal(late, 1)).toMatchObject({
          status: "paid",
          total: 1_500_00,
          tax: 0,
        });

        // The pass after the start: the early merchant's invoice was issued
        // already and keeps its figures; the late one's is built and issued
        // under the GST now in force (Punjab to Punjab: CGST and SGST).
        expect(await renew(later)).toMatchObject({
          considered: 2,
          manualRequired: 2,
          errors: 0,
        });
        expect(await renewal(early, 2)).toMatchObject({
          total: 1_500_00,
          tax: 0,
        });
        expect(notices(early)).toHaveLength(1);
        const row = await renewal(late, 2);
        expect(row).toMatchObject({
          status: "open",
          issued: true,
          subtotal: 1_500_00,
          tax: 270_00,
          total: 1_770_00,
          rate: 1800,
          inclusive: false,
          supplier_gstin: SUPPLIER_GSTIN,
          place_of_supply: "03",
          basis: "recipient",
          sac_code: SAC,
        });
        expect(split(row!)).toMatchObject({
          cgstPaise: 135_00,
          sgstPaise: 135_00,
          igstPaise: 0,
        });

        // The notice quotes the issued invoice and names GST, not a price
        // change, as the reason it costs more than last time.
        const sent = notices(late);
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toBe("₹1,770 due for your Basic plan");
        expect(sent[0].html).toContain("GST (18%)");
        expect(sent[0].html).toContain("₹1,770");
        expect(sent[0].html).toContain("GST at 18% is now added to our prices");
        expect(warned("billing.renewal_place_of_supply_fallback", late)).toBe(
          false,
        );
      });

      it("case 7: a merchant whose records name no State is charged as if in Punjab (CGST and SGST), logged once", async () => {
        await gstAddedNow();
        const nowhere = await subscriber("Nowhere", at(3 * DAY), null);

        expect(await renew(NOW)).toMatchObject({
          considered: 1,
          manualRequired: 1,
          errors: 0,
        });
        const row = await renewal(nowhere, 2);
        expect(row).toMatchObject({
          status: "open",
          issued: true,
          tax: 270_00,
          total: 1_770_00,
          rate: 1800,
          supplier_gstin: SUPPLIER_GSTIN,
          place_of_supply: "03",
          basis: "supplier",
          sac_code: SAC,
        });
        expect(split(row!)).toMatchObject({
          cgstPaise: 135_00,
          sgstPaise: 135_00,
          igstPaise: 0,
        });
        expect(
          warned("billing.renewal_place_of_supply_fallback", nowhere),
        ).toBe(true);
        expect(notices(nowhere)).toHaveLength(1);

        // The next hourly pass finds the invoice issued: no second notice,
        // no second warning.
        vi.mocked(logWarn).mockClear();
        expect(await renew(at(HOUR))).toMatchObject({
          considered: 1,
          manualRequired: 1,
        });
        expect(
          warned("billing.renewal_place_of_supply_fallback", nowhere),
        ).toBe(false);
        expect(notices(nowhere)).toHaveLength(1);
      });

      it("case 7: a merchant billed outside India renews at place of supply 96 with IGST, logged and never refused", async () => {
        await gstAddedNow();
        const abroad = await subscriber("Abroad", at(3 * DAY), {
          country: "US",
        });

        expect(await renew(NOW)).toMatchObject({
          considered: 1,
          manualRequired: 1,
          errors: 0,
        });
        const row = await renewal(abroad, 2);
        expect(row).toMatchObject({
          status: "open",
          issued: true,
          tax: 270_00,
          total: 1_770_00,
          rate: 1800,
          supplier_gstin: SUPPLIER_GSTIN,
          place_of_supply: "96",
          basis: "outside_india",
          sac_code: SAC,
        });
        expect(split(row!)).toMatchObject({
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise: 270_00,
        });
        expect(warned("billing.renewal_outside_india", abroad)).toBe(true);
        expect(warned("billing.renewal_place_of_supply_fallback", abroad)).toBe(
          false,
        );
        expect(notices(abroad)).toHaveLength(1);
      });
    });

    describe("case 9: the repair pass beside RC-F1b", () => {
      const HOUR = 3_600_000;
      const MINUTE = 60_000;
      /** Every case 9 time is measured from here. */
      const NOW = new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
      const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
      /** Razorpay's created_at for a payment captured `ms` ago (a minute
       *  before the attempt recorded it). */
      const paidSeconds = (ms: number) =>
        Math.floor((NOW.getTime() - ms - MINUTE) / 1000);

      /** The gateway this case talks to: the payments it captured. */
      const gateway = new Map<
        string,
        {
          id: string;
          order_id: string;
          amount: number;
          currency: string;
          status: string;
          created_at: number;
        }
      >();
      const fetchOrderPayments = async (_creds: unknown, orderId: string) => ({
        ok: true as const,
        data: [...gateway.values()].filter((p) => p.order_id === orderId),
      });
      const fetchPayment = async (_creds: unknown, paymentId: string) => {
        const payment = gateway.get(paymentId);
        return payment
          ? { ok: true as const, data: payment }
          : {
              ok: false as const,
              error: `${paymentId} is not in this case's gateway`,
              outcome: "unknown" as const,
            };
      };
      const run = (storeId?: string) =>
        issueCapturedDrafts({
          now: NOW,
          storeId,
          fetchOrderPayments: fetchOrderPayments as never,
          fetchPayment: fetchPayment as never,
        });

      /** A merchant in Punjab whose billing contact gets the receipt. No
       *  subscription on file: an enrolment's completion declines it. */
      async function merchant(label: string) {
        const id = crypto.randomUUID();
        await client.query(
          `insert into public.stores (id, name, slug, settings)
           values ($1, $2, $3, '{}'::jsonb)`,
          [id, `GST Repair ${label}`, `gst-repair-${id.slice(0, 8)}`],
        );
        await client.query(
          `insert into public.store_billing_settings
             (store_id, business_name, contact_email, contact_phone)
           values ($1, $2, $3, '9876543210')`,
          [
            id,
            `GST Repair ${label} Traders`,
            `repair-${id.slice(0, 8)}@probe.test`,
          ],
        );
        await client.query(
          "insert into public.billing_accounts (store_id, state_code) values ($1, '03')",
          [id],
        );
        return id;
      }

      /** A first-cycle Basic monthly draft for ₹1,500 (30 days long), built
       *  before GST, and the attempt the gateway captured for it
       *  `capturedAgo` ago. */
      async function capturedDraft(store: string, capturedAgo: number) {
        const invoiceId = crypto.randomUUID();
        const start = NOW.getTime() - capturedAgo - 5 * MINUTE;
        await client.query(
          `insert into public.billing_invoices
             (id, store_id, kind, status, subtotal_paise, discount_paise,
              tax_paise, total_paise, tax_rate_bps, cycle_seq, period_start,
              period_end, due_at, created_at, updated_at)
           values ($1, $2, 'subscription', 'draft', 150000, 0, 0, 150000, 0,
                   1, $3, $4, $3, $3, $3)`,
          [
            invoiceId,
            store,
            new Date(start).toISOString(),
            new Date(start + 30 * 24 * HOUR).toISOString(),
          ],
        );
        await client.query(
          `insert into public.billing_invoice_items
             (invoice_id, kind, description, quantity, unit_amount_paise, amount_paise)
           values ($1, 'base_plan', 'Basic plan · 1 month', 1, 150000, 150000)`,
          [invoiceId],
        );
        const attemptId = crypto.randomUUID();
        const orderId = `order_gst_repair_${attemptId.slice(0, 8)}`;
        const paymentId = `pay_gst_repair_${attemptId.slice(0, 8)}`;
        await client.query(
          `insert into public.billing_payment_attempts
             (id, invoice_id, store_id, idempotency_key, mode, state,
              amount_paise, provider_order_id, provider_payment_id,
              resolved_at, created_at, updated_at)
           values ($1, $2, $3, $4, 'manual', 'captured', 150000, $5, $6,
                   $7, $7, $7)`,
          [
            attemptId,
            invoiceId,
            store,
            `gst-repair-${attemptId}`,
            orderId,
            paymentId,
            ago(capturedAgo),
          ],
        );
        gateway.set(paymentId, {
          id: paymentId,
          order_id: orderId,
          amount: 150000,
          currency: "INR",
          status: "captured",
          created_at: paidSeconds(capturedAgo),
        });
        return { invoiceId, attemptId, paymentId };
      }

      const invoice = (id: string) =>
        one(
          `select status, invoice_ref, finalized_at is not null as issued,
                  paid_at is not null as paid, total_paise::int as total,
                  tax_paise::int as tax, tax_inclusive as inclusive,
                  supplier_gstin, place_of_supply
             from public.billing_invoices where id = $1`,
          [id],
        );
      const items = async (store: string) =>
        (
          await client.query(
            `select kind, status, attempt_id, invoice_id, provider_payment_id,
                    detail->>'repair_key' as repair_key
               from public.billing_reconciliation_items
              where store_id = $1 order by created_at`,
            [store],
          )
        ).rows as Record<string, unknown>[];
      /** The payment receipts sent to one store during this test. */
      const receipts = (store: string) =>
        vi
          .mocked(sendEmail)
          .mock.calls.map((call) => call[0])
          .filter(
            (input) =>
              input.storeId === store &&
              input.subject.startsWith("Payment received"),
          );

      let declined = "";
      let late: Awaited<ReturnType<typeof capturedDraft>>;
      let enrolling = "";
      let closedTab: Awaited<ReturnType<typeof capturedDraft>>;
      let fresh = "";
      let early: Awaited<ReturnType<typeof capturedDraft>>;

      beforeAll(async () => {
        service.client = client;
        service.db = drizzle(client, {
          schema: { ...schema, ...relations },
        }) as unknown as Db;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new Error("No network in this test.");
          }),
        );
        // GST on at 18%, prices excluding it, the LLP's identity complete.
        await client.query(
          `update public.platform_billing_settings
              set tax_enabled = true, tax_inclusive = false, tax_rate_bps = 1800,
                  gstin = $1, state_code = '03', legal_name = 'STOREMINK LLP',
                  sac_code = $2, llpin = $3, registered_office = $4,
                  address = $5::jsonb, invoice_prefix = 'SM',
                  next_tax_enabled = null, next_tax_inclusive = null,
                  next_tax_rate_bps = null, next_tax_starts_at = null,
                  next_tax_notice_id = null
            where id`,
          [SUPPLIER_GSTIN, SAC, LLPIN, OFFICE, ADDRESS],
        );
        // The pass sweeps the whole database: this case owns every draft
        // behind money on it, or its counts mean nothing.
        const stray = await one(
          `select (select count(*) from public.billing_payment_attempts a
                     join public.billing_invoices i on i.id = a.invoice_id
                    where a.state = 'captured' and i.status = 'draft')::int
                + (select count(*) from public.ai_credit_purchases p
                     join public.billing_invoices i on i.id = p.invoice_id
                    where p.status = 'paid' and i.status = 'draft')::int as n`,
        );
        if (stray?.n !== 0) {
          throw new Error(
            "storemink_local already holds captured drafts; case 9 needs a database without them.",
          );
        }
        declined = await merchant("Declined");
        late = await capturedDraft(declined, 2 * HOUR);
        // An enrolment the merchant paid for and closed the tab on, with its
        // subscription seeded the way startEnrolment leaves it: the
        // completion can finish this one.
        enrolling = await merchant("Enrolling");
        await client.query(
          `insert into public.billing_subscriptions
             (store_id, plan, period, state, current_cycle_seq, plan_source)
           values ($1, 'basic', 'monthly', 'free', 0, 'paid')`,
          [enrolling],
        );
        closedTab = await capturedDraft(enrolling, 3 * HOUR);
        fresh = await merchant("Fresh");
        early = await capturedDraft(fresh, 10 * MINUTE);
      });

      afterAll(() => {
        vi.unstubAllGlobals();
      });

      it("case 9: an hour on, RC-F1b's completion finishes what it can (issued, paid, plan on, one receipt) and a draft it declines is issued, paid and numbered by the pass, with NO receipt and one item for a person", async () => {
        const summary = await run();
        expect(summary).toMatchObject({
          considered: 2,
          completed: 1,
          issued: 1,
          filed: 0,
          deferred: 0,
          unissued: 0,
          errors: 0,
          more: false,
        });

        // The closed tab: finished by the purchase's own completion.
        expect(await invoice(closedTab.invoiceId)).toMatchObject({
          status: "paid",
          issued: true,
          paid: true,
          total: 1_500_00,
          tax: 228_81,
        });
        expect(receipts(enrolling)).toHaveLength(1);
        expect(
          await one(
            `select state, current_cycle_seq from public.billing_subscriptions
              where store_id = $1`,
            [enrolling],
          ),
        ).toEqual({ state: "active", current_cycle_seq: 1 });
        expect(await items(enrolling)).toEqual([]);

        // The declined one (no subscription on file): issued by the pass.
        // Built before GST and paid in full: the total stays, the GST is
        // carved out of it at the terms in force when the merchant paid.
        expect(await invoice(late.invoiceId)).toMatchObject({
          status: "paid",
          issued: true,
          paid: true,
          total: 1_500_00,
          tax: 228_81,
          inclusive: true,
          supplier_gstin: SUPPLIER_GSTIN,
          place_of_supply: "03",
        });
        expect((await invoice(late.invoiceId))?.invoice_ref).toBeTruthy();
        // ★ R1-04: no "Payment received. Your plan is active" for a purchase
        // that was not applied and that a person is now checking.
        expect(receipts(declined)).toHaveLength(0);
        // The completion's own item is the one for a person: it carries the
        // payment (so the refunds repair keeps away) and its key; the pass
        // added none beside it.
        expect(await items(declined)).toEqual([
          {
            kind: "state_conflict",
            status: "open",
            attempt_id: late.attemptId,
            invoice_id: late.invoiceId,
            provider_payment_id: late.paymentId,
            repair_key: `purchase_refused:${late.attemptId}`,
          },
        ]);
      });

      it("case 9: a second run files nothing and sends nothing", async () => {
        const summary = await run();
        expect(summary).toMatchObject({
          considered: 0,
          issued: 0,
          filed: 0,
          errors: 0,
        });
        expect(receipts(declined)).toHaveLength(0);
        expect(receipts(enrolling)).toHaveLength(0);
        expect(await items(declined)).toHaveLength(1);
      });

      it("case 9: a capture ten minutes old is not touched", async () => {
        expect(await invoice(early.invoiceId)).toMatchObject({
          status: "draft",
          issued: false,
          paid: false,
          invoice_ref: null,
        });
        expect(await items(fresh)).toEqual([]);
        expect(receipts(fresh)).toHaveLength(0);
      });

      it("case 9: one store's repair (deleteStore) takes it with no wait: issued only, never completed, one captured_draft item", async () => {
        const summary = await run(fresh);
        expect(summary).toMatchObject({
          considered: 1,
          completed: 0,
          issued: 1,
          filed: 1,
          unissued: 0,
          errors: 0,
        });
        expect(await invoice(early.invoiceId)).toMatchObject({
          status: "paid",
          issued: true,
          paid: true,
          total: 1_500_00,
          tax: 228_81,
        });
        expect((await invoice(early.invoiceId))?.invoice_ref).toBeTruthy();
        // ★ R1-04: issued alone for a person to check, so no receipt.
        expect(receipts(fresh)).toHaveLength(0);
        // No completion ran (it would have filed purchase_refused): only the
        // pass's own item, with the payment and the key.
        expect(await items(fresh)).toEqual([
          {
            kind: "state_conflict",
            status: "open",
            attempt_id: early.attemptId,
            invoice_id: early.invoiceId,
            provider_payment_id: early.paymentId,
            repair_key: `captured_draft:${early.invoiceId}`,
          },
        ]);
        // And again: nothing more.
        expect(await run(fresh)).toMatchObject({ considered: 0, filed: 0 });
        expect(await items(fresh)).toHaveLength(1);
      });

      it("case 9: a credit pack's receipt left a draft is issued straight to paid at the payment's time", async () => {
        const store = await merchant("Credits");
        const invoiceId = await insertInvoice({
          store,
          kind: "ai_credits",
          subtotal: 5_900,
          tax: 0,
          rateBps: 0,
        });
        await client.query(
          `insert into public.billing_invoice_items
             (invoice_id, kind, description, quantity, unit_amount_paise, amount_paise)
           values ($1, 'ai_credits', '25 Mink credits', 1, 5900, 5900)`,
          [invoiceId],
        );
        const paymentId = `pay_gst_credit_${invoiceId.slice(0, 8)}`;
        await client.query(
          `insert into public.ai_credit_purchases
             (store_id, pack_id, credits, amount_inr, amount_paise,
              rzp_order_id, rzp_payment_id, invoice_id, status,
              created_at, updated_at)
           values ($1, 'pack_25', 25, 59, 5900, $2, $3, $4, 'paid', $5, $5)`,
          [
            store,
            `order_gst_credit_${invoiceId.slice(0, 8)}`,
            paymentId,
            invoiceId,
            ago(2 * HOUR),
          ],
        );
        gateway.set(paymentId, {
          id: paymentId,
          order_id: `order_gst_credit_${invoiceId.slice(0, 8)}`,
          amount: 5900,
          currency: "INR",
          status: "captured",
          created_at: paidSeconds(2 * HOUR),
        });

        const summary = await run();
        expect(summary).toMatchObject({
          considered: 1,
          issued: 1,
          filed: 0,
          unissued: 0,
          errors: 0,
        });
        expect(await invoice(invoiceId)).toMatchObject({
          status: "paid",
          issued: true,
          paid: true,
          total: 5_900,
          tax: 900,
          inclusive: true,
        });
        expect(
          await one(
            "select paid_at = $2::timestamptz as at_payment from public.billing_invoices where id = $1",
            [invoiceId, new Date(paidSeconds(2 * HOUR) * 1000).toISOString()],
          ),
        ).toEqual({ at_payment: true });
        // Credits have their own confirmation; nothing for a person.
        expect(receipts(store)).toHaveLength(0);
        expect(await items(store)).toEqual([]);
      });
    });

    /** Point the code under test at this transaction (cases 10 and 11). */
    function useThisTransaction() {
      service.client = client;
      service.db = drizzle(client, {
        schema: { ...schema, ...relations },
      }) as unknown as Db;
    }

    /** The LLP's identity complete, GST off, nothing scheduled, refunds off. */
    async function identityCompleteGstOff() {
      await client.query(
        `update public.platform_billing_settings
            set tax_enabled = false, tax_inclusive = false, tax_rate_bps = 1800,
                gstin = $1, state_code = '03', legal_name = 'STOREMINK LLP',
                sac_code = $2, llpin = $3, registered_office = $4,
                address = $5::jsonb, invoice_prefix = 'SM', auto_refunds = false,
                next_tax_enabled = null, next_tax_inclusive = null,
                next_tax_rate_bps = null, next_tax_starts_at = null,
                next_tax_notice_id = null
          where id`,
        [SUPPLIER_GSTIN, SAC, LLPIN, OFFICE, ADDRESS],
      );
    }

    describe("case 10: scheduling a GST change against real notices", () => {
      const DAY = 24 * 60 * 60_000;
      /** The notice went out two days ago, to the second. */
      const SENT = new Date(Math.floor((Date.now() - 2 * DAY) / 1000) * 1000);
      const sentIso = SENT.toISOString();
      const afterSent = (days: number) =>
        new Date(SENT.getTime() + days * DAY).toISOString();
      const OPERATOR = "op@storemink.com";

      /** Switching GST on with prices excluding it: a rise, so it needs the
       *  notice. */
      const rise = (startsAt: string, noticeId?: string): TaxChangeInput => ({
        enabled: true,
        inclusive: false,
        ratePercent: 18,
        when: "scheduled",
        startsAt,
        noticeId,
      });

      async function notice(input: {
        category?: string;
        status?: string;
        sent?: number;
        failed?: number;
        channels?: Record<string, boolean>;
        audience?: Record<string, unknown>;
      }) {
        const sent = input.sent ?? 12;
        const failed = input.failed ?? 0;
        const row = await one(
          `insert into public.platform_announcements
             (title, category, subject, body, channels, audience, status,
              total, sent, failed, sent_at, created_by)
           values ('GST on our fees', $1, 'GST on our fees',
                   'GST will be added to our prices.', $2::jsonb, $3::jsonb,
                   $4, $5, $6, $7, $8::timestamptz, 'gst-local')
           returning id`,
          [
            input.category ?? "operational",
            JSON.stringify(input.channels ?? { email: true, sms: false }),
            JSON.stringify(input.audience ?? {}),
            input.status ?? "sent",
            sent + failed,
            sent,
            failed,
            sentIso,
          ],
        );
        return String(row!.id);
      }

      const settingsRow = () =>
        one(
          `select tax_enabled, tax_inclusive, tax_rate_bps, next_tax_enabled,
                  next_tax_inclusive, next_tax_rate_bps, next_tax_notice_id,
                  next_tax_starts_at is null as nothing_scheduled, updated_by
             from public.platform_billing_settings where id`,
        );

      beforeAll(useThisTransaction);

      beforeEach(async () => {
        await client.query("SAVEPOINT gst_case_10");
        await identityCompleteGstOff();
      });

      afterEach(async () => {
        await client.query("ROLLBACK TO SAVEPOINT gst_case_10");
        await client.query("RELEASE SAVEPOINT gst_case_10");
      });

      it("case 10: a failed send, an SMS-only notice, one to Pro stores only and product news each refuse the rise with their own sentence, and nothing is scheduled", async () => {
        const refusals: [string, string][] = [
          [
            await notice({ status: "failed", sent: 0, failed: 40 }),
            noticeRefusal("not_sent"),
          ],
          [
            await notice({ channels: { email: false, sms: true } }),
            noticeRefusal("not_email"),
          ],
          [
            await notice({ audience: { plans: ["pro"] } }),
            noticeRefusal("audience"),
          ],
          [
            await notice({ category: "feature" }),
            noticeRefusal("not_operational"),
          ],
        ];
        for (const [id, error] of refusals) {
          expect(
            await scheduleTaxChange(rise(afterSent(40), id), OPERATOR),
          ).toEqual({
            ok: false,
            error,
          });
        }
        expect(await scheduleTaxChange(rise(afterSent(40)), OPERATOR)).toEqual({
          ok: false,
          error: TAX_SETTINGS_REFUSAL.riseWithoutNotice,
        });
        expect(await settingsRow()).toMatchObject({
          tax_enabled: false,
          next_tax_enabled: null,
          next_tax_notice_id: null,
          nothing_scheduled: true,
        });
      });

      it("case 10: an Operational email notice to every owner, partly delivered, sent 32 days before the start, is accepted and kept with the change; a start a millisecond before 1 month after it is refused", async () => {
        const id = await notice({ status: "partial", sent: 10, failed: 2 });
        const earliest = earliestStartAfterNotice(sentIso)!;
        const tooSoon = new Date(Date.parse(earliest) - 1).toISOString();
        expect(await scheduleTaxChange(rise(tooSoon, id), OPERATOR)).toEqual({
          ok: false,
          error: tooSoonAfterNotice(earliest, sentIso),
        });
        expect(await settingsRow()).toMatchObject({ nothing_scheduled: true });

        const start = afterSent(32);
        expect(await scheduleTaxChange(rise(start, id), OPERATOR)).toEqual({
          ok: true,
          applied: "scheduled",
          startsAt: start,
        });
        expect(await settingsRow()).toEqual({
          tax_enabled: false,
          tax_inclusive: false,
          tax_rate_bps: 1800,
          next_tax_enabled: true,
          next_tax_inclusive: false,
          next_tax_rate_bps: 1800,
          next_tax_notice_id: id,
          nothing_scheduled: false,
          updated_by: OPERATOR,
        });
        expect(
          await one(
            "select next_tax_starts_at = $1::timestamptz as same from public.platform_billing_settings where id",
            [start],
          ),
        ).toEqual({ same: true });
      });

      it("case 10: a scheduled change is withdrawn while its start is ahead, and a second withdrawal says it has gone", async () => {
        const id = await notice({ status: "partial", sent: 10, failed: 2 });
        expect(
          (await scheduleTaxChange(rise(afterSent(32), id), OPERATOR)).ok,
        ).toBe(true);

        expect(await cancelScheduledTaxChange(OPERATOR)).toEqual({ ok: true });
        expect(await settingsRow()).toEqual({
          tax_enabled: false,
          tax_inclusive: false,
          tax_rate_bps: 1800,
          next_tax_enabled: null,
          next_tax_inclusive: null,
          next_tax_rate_bps: null,
          next_tax_notice_id: null,
          nothing_scheduled: true,
          updated_by: OPERATOR,
        });

        expect(await cancelScheduledTaxChange(OPERATOR)).toEqual({
          ok: false,
          error: TAX_SETTINGS_REFUSAL.cancelAfterStart,
        });
      });

      it("case 10: switching GST on now with prices including it writes the real row (an update, which the identity checks accept), and switching it off again is allowed", async () => {
        expect(
          await scheduleTaxChange(
            { enabled: true, inclusive: true, ratePercent: 18, when: "now" },
            OPERATOR,
          ),
        ).toEqual({ ok: true, applied: "now", startsAt: null });
        expect(await settingsRow()).toMatchObject({
          tax_enabled: true,
          tax_inclusive: true,
          tax_rate_bps: 1800,
          nothing_scheduled: true,
          updated_by: OPERATOR,
        });
        // Prices excluding GST now would raise what merchants pay.
        expect(
          await scheduleTaxChange(
            { enabled: true, inclusive: false, ratePercent: 18, when: "now" },
            OPERATOR,
          ),
        ).toEqual({ ok: false, error: TAX_SETTINGS_REFUSAL.riseNow });
        expect(
          await scheduleTaxChange(
            { enabled: false, inclusive: false, ratePercent: 18, when: "now" },
            OPERATOR,
          ),
        ).toEqual({ ok: true, applied: "now", startsAt: null });
        expect(await settingsRow()).toMatchObject({ tax_enabled: false });
      });

      it("case 10: with GST on, the identity saves on the real row and clearing the SAC code is refused", async () => {
        await client.query(
          "update public.platform_billing_settings set tax_enabled = true where id",
        );
        const identity = {
          legalName: "STOREMINK LLP",
          gstin: SUPPLIER_GSTIN,
          stateCode: "03",
          addressLine1: "Bala ji Colony",
          addressLine2: "",
          city: "Faridkot",
          postalCode: "151203",
          sacCode: SAC,
          llpin: LLPIN,
          registeredOffice: OFFICE,
          invoicePrefix: "SM",
        };
        expect(
          await saveTaxIdentity({ ...identity, city: "Faridkot " }, OPERATOR),
        ).toEqual({ ok: true });
        expect(
          await one(
            "select tax_enabled, sac_code, address ->> 'city' as city, updated_by from public.platform_billing_settings where id",
          ),
        ).toEqual({
          tax_enabled: true,
          sac_code: SAC,
          city: "Faridkot",
          updated_by: OPERATOR,
        });
        expect(
          await saveTaxIdentity({ ...identity, sacCode: "" }, OPERATOR),
        ).toEqual({
          ok: false,
          error: TAX_SETTINGS_REFUSAL.clearIdentityWhileOn,
        });
        expect(
          await one(
            "select sac_code from public.platform_billing_settings where id",
          ),
        ).toEqual({ sac_code: SAC });
      });

      it("case 10: a change whose start has passed is promoted, by a withdrawal or by the hourly run, and can no longer be withdrawn", async () => {
        const passed = new Date(Date.now() - 60_000).toISOString();
        await client.query(
          `update public.platform_billing_settings
              set next_tax_enabled = true, next_tax_inclusive = true,
                  next_tax_rate_bps = 1800, next_tax_starts_at = $1::timestamptz
            where id`,
          [passed],
        );
        expect(await cancelScheduledTaxChange(OPERATOR)).toEqual({
          ok: false,
          error: TAX_SETTINGS_REFUSAL.cancelAfterStart,
        });
        expect(await settingsRow()).toEqual({
          tax_enabled: true,
          tax_inclusive: true,
          tax_rate_bps: 1800,
          next_tax_enabled: null,
          next_tax_inclusive: null,
          next_tax_rate_bps: null,
          next_tax_notice_id: null,
          nothing_scheduled: true,
          updated_by: PROMOTED_BY,
        });

        // The hourly run: switching off, scheduled for a minute ago.
        await client.query(
          `update public.platform_billing_settings
              set next_tax_enabled = false, next_tax_inclusive = false,
                  next_tax_rate_bps = 1800, next_tax_starts_at = $1::timestamptz
            where id`,
          [passed],
        );
        const promoted = await promoteDueTaxChange(new Date());
        expect(promoted).toMatchObject({
          enabled: false,
          inclusive: false,
          rateBps: 1800,
          noticeId: null,
        });
        expect(Date.parse(String(promoted!.startsAt))).toBe(Date.parse(passed));
        expect(await settingsRow()).toMatchObject({
          tax_enabled: false,
          nothing_scheduled: true,
          updated_by: PROMOTED_BY,
        });
        expect(await promoteDueTaxChange(new Date())).toBeNull();
      });
    });

    describe("case 11: the auto-refunds switch beside an incomplete tax identity (A2)", () => {
      const CHECK = "platform_billing_tax_needs_invoice_identity";
      const OPERATOR = "op@storemink.com";
      const refundsRow = () =>
        one(
          `select tax_enabled, sac_code, auto_refunds,
                  automatic_refunds_from, updated_at, updated_by
             from public.platform_billing_settings where id`,
        );

      beforeAll(useThisTransaction);

      beforeEach(async () => {
        await client.query("SAVEPOINT gst_case_11");
        await identityCompleteGstOff();
      });

      afterEach(async () => {
        await client.query("ROLLBACK TO SAVEPOINT gst_case_11");
        await client.query("RELEASE SAVEPOINT gst_case_11");
      });

      it("case 11: with GST off the switch saves, both ways", async () => {
        expect(await savePlatformAutoRefunds(true, OPERATOR)).toEqual({
          ok: true,
        });
        expect(await refundsRow()).toMatchObject({
          auto_refunds: true,
          updated_by: OPERATOR,
        });
        expect(await savePlatformAutoRefunds(false, null)).toEqual({
          ok: true,
        });
        expect(await refundsRow()).toMatchObject({
          auto_refunds: false,
          updated_by: null,
        });
      });

      it("case 11: with GST on, no SAC code and the identity check NOT VALID (branch B), the save returns the sentence that says what to do and the row is unchanged", async () => {
        const def = await one(
          `select pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = 'public.platform_billing_settings'::regclass
              and conname = $1`,
          [CHECK],
        );
        expect(def?.def).toMatch(/^CHECK /);
        await client.query(
          `alter table public.platform_billing_settings drop constraint ${CHECK}`,
        );
        await client.query(
          `update public.platform_billing_settings
              set tax_enabled = true, sac_code = null
            where id`,
        );
        await client.query(
          `alter table public.platform_billing_settings
             add constraint ${CHECK} ${String(def!.def).replace(/\s+NOT VALID$/, "")} NOT VALID`,
        );
        expect(await validated([CHECK])).toEqual({ [CHECK]: false });

        const before = await refundsRow();
        expect(before).toMatchObject({
          tax_enabled: true,
          sac_code: null,
          auto_refunds: false,
        });
        expect(await savePlatformAutoRefunds(true, OPERATOR)).toEqual({
          ok: false,
          error: AUTO_REFUNDS_IDENTITY_INCOMPLETE,
        });
        expect(await refundsRow()).toEqual(before);
        expect(logWarn).toHaveBeenCalledWith(
          "billing.auto_refunds.identity_incomplete",
          { constraint: CHECK },
        );
      });
    });
  },
);
