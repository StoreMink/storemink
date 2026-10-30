import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Migration 0264: billing_refunds, billing_credit_notes and their counters,
// the automatic-refunds switch, who asked to cancel, and two indexes on
// existing tables. Pinned on the file itself because an applied migration can
// never change (the runner checksums it): a grant wider than intended, an
// index keyed on the wrong column or a store foreign key would otherwise be
// permanent everywhere. The behaviour behind each line (the cap, the one
// automatic refund, the minimum, the 16 characters) was probed on
// storemink_local; these pins keep the file saying what was probed.
// ---------------------------------------------------------------------------

const ID = "20261028_0264_billing_refunds_and_credit_notes";
const RAW = readFileSync(`drizzle/migrations/sql/${ID}.sql`, "utf8");
/** The executable SQL: comments removed, whitespace folded. */
const SQL = RAW.replace(/--[^\n]*/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const TABLES = [
  "billing_refunds",
  "billing_credit_notes",
  "billing_credit_note_counters",
];

const FUNCTIONS = [
  "billing_next_credit_note_no(text)",
  "billing_credit_notes_issue()",
  "billing_credit_notes_guard()",
  "billing_refunds_guard()",
  "billing_refunds_keep()",
];

type ManifestEntry = {
  id: string;
  file: string;
  transaction: boolean;
  requires: string[];
  verify: {
    tables: string[];
    columns: string[];
    constraints: string[];
    rlsTables: string[];
    functions: string[];
    queries: { name: string; sql: string; equals: string }[];
  };
  applyVerify: { queries: { name: string; sql: string; equals: string }[] };
};

function manifestEntry(): ManifestEntry {
  const manifest = JSON.parse(
    readFileSync("drizzle/migrations/manifest.json", "utf8"),
  ) as { migrations: ManifestEntry[] };
  const index = manifest.migrations.findIndex((m) => m.id === ID);
  expect(index, ID).toBeGreaterThan(-1);
  return manifest.migrations[index];
}

/** The body of one CREATE TABLE statement, up to its closing ");". */
function createTable(name: string): string {
  const start = SQL.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  expect(start, name).toBeGreaterThan(-1);
  return SQL.slice(start, SQL.indexOf(");", start) + 2);
}

describe("migration 0264: billing refunds and credit notes", () => {
  it("revokes everything from app_service, app_user and PUBLIC on the three tables", () => {
    for (const table of TABLES) {
      expect(SQL).toContain(
        `REVOKE ALL ON public.${table} FROM PUBLIC, app_user, app_service;`,
      );
    }
  });

  it("revokes everything from app_service, app_user and PUBLIC on the five functions", () => {
    for (const fn of FUNCTIONS) {
      expect(SQL).toContain(
        `REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, app_user, app_service;`,
      );
    }
  });

  it("grants app_service back only reading, writing and moving refunds, and reading and issuing notes", () => {
    const grants = SQL.split(";")
      .map((statement) => statement.trim())
      .filter((statement) => /^GRANT\b/i.test(statement));
    expect(grants).toEqual([
      "GRANT SELECT, INSERT, UPDATE ON public.billing_refunds TO app_service",
      "GRANT SELECT, INSERT ON public.billing_credit_notes TO app_service",
    ]);
    expect(SQL).not.toMatch(/\bTO app_user\b/);
    expect(SQL).not.toMatch(/GRANT[^;]*\bDELETE\b/i);
  });

  it("turns row level security on for all three tables", () => {
    for (const table of TABLES) {
      expect(SQL).toContain(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`,
      );
    }
  });

  it("keys the one automatic refund on the payment and on requested_by = 'system', never on the reason", () => {
    expect(SQL).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS billing_refunds_one_automatic ON public.billing_refunds (attempt_id) WHERE requested_by = 'system';",
    );
    // Keyed on the reason it would refuse an operator's retry of a failed
    // automatic refund, which keeps the same reason.
    const index = SQL.slice(
      SQL.indexOf("billing_refunds_one_automatic"),
      SQL.indexOf(";", SQL.indexOf("billing_refunds_one_automatic")),
    );
    expect(index).not.toContain("reason");
  });

  it("holds a credit note's number to 16 characters", () => {
    expect(createTable("billing_credit_notes")).toContain(
      "CONSTRAINT billing_credit_notes_ref_length CHECK (char_length(credit_note_ref) <= 16)",
    );
    // CN/2026-27/00001 is exactly the limit.
    expect("CN/2026-27/00001").toHaveLength(16);
    expect(SQL).toContain(
      "new.credit_note_ref := 'CN/' || v_fy || '/' || public.sm_pad(v_seq, 5);",
    );
  });

  it("never writes a gateway refund below 1 rupee, but may record one", () => {
    expect(createTable("billing_refunds")).toContain(
      "CONSTRAINT billing_refunds_gateway_minimum CHECK ( method <> 'razorpay' OR status = 'recorded' OR amount_paise >= 100)",
    );
  });

  it("gives neither new table a store column or a store foreign key", () => {
    expect(SQL).not.toMatch(/REFERENCES public\.stores\b/i);
    expect(SQL).not.toMatch(/\bstores\s*\(/i);
    // Each slice runs to the table's last line, so the search covers it all.
    const last: Record<string, string> = {
      billing_refunds: "billing_refunds_notified_shape",
      billing_credit_notes: "billing_credit_notes_issued_by_check",
      billing_credit_note_counters: "next_seq >= 1",
    };
    for (const table of TABLES) {
      expect(createTable(table)).toContain(last[table]);
      expect(createTable(table)).not.toMatch(/\bstore_id\b/);
    }
  });

  it("refuses a delete of either kind of record in a trigger, not only by grant", () => {
    expect(SQL).toContain(
      "CREATE TRIGGER billing_refunds_keep BEFORE DELETE ON public.billing_refunds FOR EACH ROW EXECUTE FUNCTION public.billing_refunds_keep();",
    );
    expect(SQL).toContain(
      "CREATE TRIGGER billing_credit_notes_guard BEFORE UPDATE OR DELETE ON public.billing_credit_notes FOR EACH ROW EXECUTE FUNCTION public.billing_credit_notes_guard();",
    );
  });

  it("adds its columns to existing tables with defaults or as nullable, so the old revision keeps working", () => {
    expect(SQL).toContain(
      "ALTER TABLE public.platform_billing_settings ADD COLUMN IF NOT EXISTS auto_refunds boolean NOT NULL DEFAULT false;",
    );
    expect(SQL).toContain(
      "ALTER TABLE public.platform_billing_settings ADD COLUMN IF NOT EXISTS automatic_refunds_from timestamptz NOT NULL DEFAULT now();",
    );
    expect(SQL).toContain(
      "ALTER TABLE public.billing_subscriptions ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;",
    );
    expect(SQL).toContain(
      "ALTER TABLE public.billing_subscriptions ADD COLUMN IF NOT EXISTS cancel_requested_by text;",
    );
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(SQL).not.toMatch(/\bCONCURRENTLY\b/i);
  });

  it("has no em or en dash anywhere in the file", () => {
    expect(RAW.includes(EM_DASH)).toBe(false);
    expect(RAW.includes(EN_DASH)).toBe(false);
  });

  it("is enrolled right after the storage Help edit, in one transaction", () => {
    const manifest = JSON.parse(
      readFileSync("drizzle/migrations/manifest.json", "utf8"),
    ) as { migrations: { id: string }[] };
    const ids = manifest.migrations.map((m) => m.id);
    const at = ids.indexOf(ID);
    expect(ids[at - 1]).toBe("20261028_0263_mink_attachments_private_help");
    const entry = manifestEntry();
    expect(entry.file).toBe(`sql/${ID}.sql`);
    expect(entry.transaction).toBe(true);
    expect(entry.requires).toEqual([
      "20261028_0263_mink_attachments_private_help",
    ]);
  });

  it("verifies durable facts only: every function with its argument types, indexes through pg_indexes, no wording", () => {
    const { verify, applyVerify } = manifestEntry();
    expect(verify.tables).toEqual(TABLES);
    expect(verify.rlsTables).toEqual(TABLES);
    expect([...verify.functions].sort()).toEqual([...FUNCTIONS].sort());
    for (const fn of verify.functions) expect(fn).toMatch(/\(.*\)$/);
    const durable = verify.queries.map((q) => q.sql).join("\n");
    for (const index of [
      "billing_refunds_one_automatic",
      "billing_refunds_provider_refund_key",
      "billing_invoices_closed_idx",
      "billing_reconciliation_repair_once",
    ]) {
      expect(durable).toContain(`indexname = '${index}'`);
    }
    expect(durable).toContain("confrelid = 'public.stores'::regclass");
    expect(durable).not.toMatch(/help_articles|legal_documents|body like/i);
    expect(verify).not.toHaveProperty("indexes");
    // Privileges are checked one at a time, and only once, at apply time.
    const applied = applyVerify.queries.map((q) => q.sql).join("\n");
    expect(applied).not.toMatch(/'[A-Z]+,[A-Z]+/);
    expect(durable).not.toContain("has_table_privilege");
  });
});
