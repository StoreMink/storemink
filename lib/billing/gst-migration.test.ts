import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Migration 0266: GST on StoreMink's own fees. The scheduled change, the SAC
// code and the LLP particulars on platform_billing_settings, the merchant
// GSTIN CHECKs, ai_credit_purchases.amount_paise, the three printed invoice
// columns, the issue-time trigger, and the guard, parties and snapshot
// functions replaced. Pinned on the file itself because an applied migration
// can never change (the runner checksums it). The behaviour behind each line
// was probed on storemink_local in a rolled-back transaction, and
// lib/billing/gst.local.test.ts case 1 replays the file; these pins keep the
// file saying what was probed, and keep the replaced functions supersets of
// the applied ones they replace (0243's parties, 0245's guard and snapshot).
// ---------------------------------------------------------------------------

const ID = "20261029_0266_gst_on_storemink_fees";
const RAW = readFileSync(`drizzle/migrations/sql/${ID}.sql`, "utf8");
const RAW_0243 = readFileSync(
  "drizzle/migrations/sql/20261025_0243_keep_invoices_after_store_deletion.sql",
  "utf8",
);
const RAW_0245 = readFileSync(
  "drizzle/migrations/sql/20261026_0245_issued_invoice_guards.sql",
  "utf8",
);
/** The executable SQL: comments removed, whitespace folded. */
const SQL = fold(RAW.replace(/--[^\n]*/g, " "));
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
/** Assembled from fragments, as former-providers-coverage.test.ts does, so
 *  this file never names either former provider itself. */
const FORMER_PROVIDERS = new RegExp(
  [
    ["supa", "base"],
    ["ver", "cel"],
  ]
    .map((parts) => parts.join(""))
    .join("|"),
  "i",
);

/** Every CHECK added NOT VALID, each validated by step 5 when the data allows. */
const NOT_VALID_CHECKS: Record<string, string> = {
  platform_billing_sac_code_format: "platform_billing_settings",
  platform_billing_llpin_format: "platform_billing_settings",
  platform_billing_invoice_prefix_length: "platform_billing_settings",
  platform_billing_next_tax_shape: "platform_billing_settings",
  platform_billing_tax_needs_invoice_identity: "platform_billing_settings",
  platform_billing_next_tax_needs_invoice_identity: "platform_billing_settings",
  billing_accounts_gstin_format: "billing_accounts",
  billing_accounts_gstin_matches_state: "billing_accounts",
  billing_invoices_sac_code_format: "billing_invoices",
  billing_invoices_place_of_supply_numeric: "billing_invoices",
  billing_invoices_place_of_supply_basis: "billing_invoices",
};

const COLUMNS = [
  "platform_billing_settings.next_tax_enabled",
  "platform_billing_settings.next_tax_inclusive",
  "platform_billing_settings.next_tax_rate_bps",
  "platform_billing_settings.next_tax_starts_at",
  "platform_billing_settings.next_tax_notice_id",
  "platform_billing_settings.sac_code",
  "platform_billing_settings.llpin",
  "platform_billing_settings.registered_office",
  "ai_credit_purchases.amount_paise",
  "billing_invoices.sac_code",
  "billing_invoices.tax_inclusive",
  "billing_invoices.place_of_supply_basis",
];

const CONSTRAINTS = [
  "platform_billing_settings_next_tax_notice_fkey",
  ...Object.keys(NOT_VALID_CHECKS).slice(0, 8),
  "ai_credit_purchases_amount_paise_check",
  ...Object.keys(NOT_VALID_CHECKS).slice(8),
];

const FUNCTIONS = [
  "billing_invoices_guard_tax_invoice()",
  "billing_invoices_guard_immutable()",
  "billing_invoice_parties(uuid,text,text,text)",
  "billing_invoices_snapshot_parties()",
];

/** The three arms 0266 adds to 0245's guard, as the file writes them. */
const NEW_GUARD_ARMS = [
  "new.sac_code is distinct from old.sac_code",
  "new.tax_inclusive is distinct from old.tax_inclusive",
  "new.place_of_supply_basis is distinct from old.place_of_supply_basis",
];

type Query = { name: string; sql: string; equals: string };
type ManifestEntry = {
  id: string;
  description: string;
  file: string;
  transaction: boolean;
  requires: string[];
  verify: {
    tables?: string[];
    columns: string[];
    constraints: string[];
    functions: string[];
    queries: Query[];
  };
  applyVerify: { queries: Query[] };
};

function fold(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function manifest(): ManifestEntry[] {
  return (
    JSON.parse(readFileSync("drizzle/migrations/manifest.json", "utf8")) as {
      migrations: ManifestEntry[];
    }
  ).migrations;
}

function manifestEntry(id = ID): ManifestEntry {
  const entry = manifest().find((m) => m.id === id);
  expect(entry, id).toBeDefined();
  return entry!;
}

/** The body of one function, between its `AS $$` and the closing `$$;`
 *  (exactly what pg_proc.prosrc holds once applied), whitespace folded. */
function functionBody(raw: string, name: string): string {
  const start = raw.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const open = raw.indexOf("AS $$", start);
  const close = raw.indexOf("$$;", open + 5);
  expect(open, name).toBeGreaterThan(start);
  return fold(raw.slice(open + 5, close));
}

/** The arms of the guard's `if ... then raise` condition, split on `or` only
 *  outside parentheses, so a parenthesised arm stays one arm. */
function guardArms(body: string): string[] {
  const start = body.indexOf("if new.") + 3;
  const end = body.indexOf(" then raise exception", start);
  const condition = body.slice(start, end);
  const arms: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < condition.length; i++) {
    if (condition[i] === "(") depth++;
    else if (condition[i] === ")") depth--;
    else if (depth === 0 && condition.startsWith(" or ", i)) {
      arms.push(condition.slice(from, i).trim());
      from = i + 4;
    }
  }
  arms.push(condition.slice(from).trim());
  return arms;
}

/** One ALTER TABLE ... ADD CONSTRAINT clause, up to the next clause or `;`. */
function constraintClause(name: string): string {
  const start = SQL.indexOf(`ADD CONSTRAINT ${name} `);
  expect(start, name).toBeGreaterThan(-1);
  const rest = SQL.slice(start + 1);
  const next = rest.search(/ ADD CONSTRAINT |;/);
  return SQL.slice(start, start + 1 + next).replace(/,$/, "");
}

describe("migration 0266: GST on StoreMink's fees", () => {
  it("has no em or en dash and names neither former provider", () => {
    expect(RAW.includes(EM_DASH)).toBe(false);
    expect(RAW.includes(EN_DASH)).toBe(false);
    expect(RAW).not.toMatch(FORMER_PROVIDERS);
    expect(RAW).not.toMatch(/Plans? &(amp;)? billing/);
  });

  it("names itself and the migration it follows in its header", () => {
    expect(RAW.split("\n")[0]).toBe(
      `-- drizzle/migrations/sql/${ID}.sql (requires`,
    );
    expect(RAW.slice(0, 300)).toContain("20261028_0265_cancel_and_refund_help");
    expect(RAW).not.toMatch(/DRAFT|2026MMDD|NNNN/);
  });

  it("adds every column nullable or with a default, and drops nothing", () => {
    for (const column of COLUMNS) {
      const [table, name] = column.split(".");
      const added = new RegExp(
        `ALTER TABLE public\\.${table} [^;]*ADD COLUMN IF NOT EXISTS ${name} `,
      );
      expect(SQL, column).toMatch(added);
    }
    const added = [
      ...SQL.matchAll(/ADD COLUMN IF NOT EXISTS (\w+) ([^,;]+)[,;]/g),
    ];
    expect(added).toHaveLength(COLUMNS.length);
    for (const [, name, definition] of added) {
      if (/\bNOT NULL\b/.test(definition)) {
        expect(definition, name).toMatch(/\bDEFAULT\b/);
      }
    }
    expect(SQL).toContain(
      "ADD COLUMN IF NOT EXISTS tax_inclusive boolean NOT NULL DEFAULT false",
    );
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(SQL).not.toMatch(/\bCONCURRENTLY\b/i);
  });

  it("adds every CHECK on an existing table NOT VALID, and only the new column's CHECK at once", () => {
    for (const name of Object.keys(NOT_VALID_CHECKS)) {
      expect(constraintClause(name), name).toMatch(/\) NOT VALID$/);
    }
    expect(
      constraintClause("ai_credit_purchases_amount_paise_check"),
    ).not.toContain("NOT VALID");
    expect(SQL.match(/\) NOT VALID[,;]/g)).toHaveLength(
      Object.keys(NOT_VALID_CHECKS).length,
    );
  });

  it("validates each NOT VALID CHECK in step 5, leaving it with a NOTICE (never an error) when a row breaks it", () => {
    const start = SQL.indexOf("DO $$");
    const block = SQL.slice(start, SQL.indexOf("END $$;", start));
    const validated = Object.fromEntries(
      [...block.matchAll(/\('public\.(\w+)', '(\w+)'\)/g)].map((m) => [
        m[2],
        m[1],
      ]),
    );
    expect(validated).toEqual(NOT_VALID_CHECKS);
    expect(block).toContain(
      "EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.tbl, c.con);",
    );
    expect(block).toContain("EXCEPTION WHEN check_violation THEN RAISE NOTICE");
    expect(block).not.toMatch(/RAISE (EXCEPTION|WARNING)/);
  });

  it("marks invoices already written with an included GST line before the guard freezes tax_inclusive", () => {
    const backfill = SQL.indexOf(
      "UPDATE public.billing_invoices i SET tax_inclusive = true",
    );
    expect(backfill).toBeGreaterThan(-1);
    expect(SQL.slice(backfill)).toMatch(
      /^UPDATE public\.billing_invoices i SET tax_inclusive = true WHERE i\.tax_paise > 0 AND i\.tax_inclusive = false AND EXISTS \( SELECT 1 FROM public\.billing_invoice_items it WHERE it\.invoice_id = i\.id AND it\.kind = 'tax' AND it\.description LIKE '%\(included\)' \);/,
    );
    expect(backfill).toBeLessThan(
      SQL.indexOf(
        "CREATE OR REPLACE FUNCTION public.billing_invoices_guard_immutable()",
      ),
    );
  });

  it("checks an invoice charging GST only on the transition to issued, and only once StoreMink's SAC code is set", () => {
    expect(SQL).toContain(
      "CREATE TRIGGER billing_invoices_tax_invoice_complete BEFORE INSERT OR UPDATE OF finalized_at ON public.billing_invoices FOR EACH ROW EXECUTE FUNCTION public.billing_invoices_guard_tax_invoice();",
    );
    const head = SQL.slice(
      SQL.indexOf(
        "CREATE OR REPLACE FUNCTION public.billing_invoices_guard_tax_invoice()",
      ),
      SQL.indexOf("AS $$", SQL.indexOf("billing_invoices_guard_tax_invoice()")),
    );
    expect(head).toContain("SECURITY DEFINER SET search_path = ''");
    const body = functionBody(RAW, "billing_invoices_guard_tax_invoice");
    expect(body).toContain(
      "if new.finalized_at is not null and (tg_op = 'INSERT' or old.finalized_at is null) and new.tax_paise > 0 and exists (select 1 from public.platform_billing_settings p where p.id and p.sac_code is not null)",
    );
    for (const field of [
      "new.supplier_gstin is null",
      "new.place_of_supply is null",
      "new.place_of_supply_basis is null",
      "new.sac_code is null",
      "new.tax_rate_bps is null",
      "new.tax_rate_bps <= 0",
    ]) {
      expect(body, field).toContain(field);
    }
  });

  it("revokes the issue check from PUBLIC, app_user and app_service", () => {
    for (const role of ["PUBLIC", "app_user", "app_service"]) {
      expect(SQL).toContain(
        `REVOKE ALL ON FUNCTION public.billing_invoices_guard_tax_invoice() FROM ${role};`,
      );
    }
    expect(SQL).not.toMatch(
      /GRANT [^;]* ON FUNCTION public\.billing_invoices_guard_tax_invoice/,
    );
  });

  it("keeps every arm of 0245's guard and adds exactly the SAC code, the price basis and the basis of the place of supply", () => {
    const before = functionBody(RAW_0245, "billing_invoices_guard_immutable");
    const after = functionBody(RAW, "billing_invoices_guard_immutable");
    const beforeArms = guardArms(before);
    const afterArms = guardArms(after);
    expect(beforeArms).toHaveLength(17);
    for (const arm of beforeArms) expect(afterArms, arm).toContain(arm);
    expect(afterArms.filter((arm) => !beforeArms.includes(arm))).toEqual(
      NEW_GUARD_ARMS,
    );
    // Everything around the condition is 0245's, word for word.
    let rebuilt = after;
    for (const arm of NEW_GUARD_ARMS)
      rebuilt = rebuilt.replace(` or ${arm}`, "");
    expect(rebuilt).toBe(before);
  });

  it("passes the place of supply to the parties record only for basis recipient or none, and is otherwise 0245's snapshot", () => {
    const before = functionBody(RAW_0245, "billing_invoices_snapshot_parties");
    const after = functionBody(RAW, "billing_invoices_snapshot_parties");
    const fourth =
      "case when new.place_of_supply_basis is null or new.place_of_supply_basis = 'recipient' then new.place_of_supply end";
    expect(after).toContain(
      `new.store_id, new.supplier_gstin, new.customer_gstin, ${fourth});`,
    );
    expect(after.replace(fourth, "new.place_of_supply")).toBe(before);
    expect(SQL).toContain(
      "REVOKE ALL ON FUNCTION public.billing_invoices_snapshot_parties() FROM PUBLIC; REVOKE ALL ON FUNCTION public.billing_invoices_snapshot_parties() FROM app_user;",
    );
  });

  it("keeps 0243's parties record and adds the LLPIN, the registered office, the country and the signup address", () => {
    const before = functionBody(RAW_0243, "billing_invoice_parties");
    const after = functionBody(RAW, "billing_invoice_parties");
    // The two lines 0266 rewrites: the customer address gains a third source,
    // and an empty Taxes & invoices address becomes an empty array, not NULL.
    const rewritten = [
      "ELSE jsonb_strip_nulls(jsonb_build_object(",
      "SELECT array_remove(",
    ];
    const lines = RAW_0243.slice(
      RAW_0243.indexOf("AS $$", RAW_0243.indexOf("billing_invoice_parties(")) +
        5,
      RAW_0243.indexOf("$$;", RAW_0243.indexOf("billing_invoice_parties(")),
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !rewritten.includes(line));
    expect(fold(lines.join(" ")).length).toBeGreaterThan(before.length / 2);
    for (const line of lines) expect(after, line).toContain(line);
    for (const added of [
      "'llpin', nullif(btrim(p.llpin), '')",
      "'registeredOffice', nullif(btrim(p.registered_office), '')",
      "'country', ctry.country",
      "WHEN cardinality(biz.lines) > 0 THEN jsonb_strip_nulls(jsonb_build_object(",
      "ELSE addr.signup END",
      "nullif(btrim(s.settings -> 'business' ->> 'addressLine1'), '')",
    ]) {
      expect(after, added).toContain(added);
    }
    expect(SQL).toContain(
      "REVOKE ALL ON FUNCTION public.billing_invoice_parties(uuid, text, text, text) FROM PUBLIC; REVOKE ALL ON FUNCTION public.billing_invoice_parties(uuid, text, text, text) FROM app_user; GRANT EXECUTE ON FUNCTION public.billing_invoice_parties(uuid, text, text, text) TO app_service;",
    );
  });

  it("allows place of supply 96 only for a business outside India, through a CASE whose ELSE is false", () => {
    expect(constraintClause("billing_invoices_place_of_supply_basis")).toBe(
      "ADD CONSTRAINT billing_invoices_place_of_supply_basis CHECK ( CASE WHEN place_of_supply_basis IS NULL THEN place_of_supply IS NULL OR place_of_supply <> '96' WHEN place_of_supply_basis = 'outside_india' THEN place_of_supply IS NOT NULL AND place_of_supply = '96' WHEN place_of_supply_basis IN ('recipient', 'supplier') THEN place_of_supply IS NOT NULL AND place_of_supply <> '96' ELSE false END ) NOT VALID",
    );
  });

  it("is enrolled right after the cancel and refund Help edit, in one transaction", () => {
    const ids = manifest().map((m) => m.id);
    const at = ids.indexOf(ID);
    expect(ids[at - 1]).toBe("20261028_0265_cancel_and_refund_help");
    const entry = manifestEntry();
    expect(entry.file).toBe(`sql/${ID}.sql`);
    expect(entry.transaction).toBe(true);
    expect(entry.requires).toEqual(["20261028_0265_cancel_and_refund_help"]);
    expect(entry.description).toMatch(/Requires 0265\.$/);
    expect(entry.description.includes(EM_DASH)).toBe(false);
    expect(entry.description.includes(EN_DASH)).toBe(false);
    expect(entry.description).not.toMatch(/&\w+;/);
  });

  it("verifies durable structure only: the columns, the constraints, every function with its argument types, and the trigger", () => {
    const { verify } = manifestEntry();
    expect(verify).not.toHaveProperty("tables");
    expect(verify.columns).toEqual(COLUMNS);
    expect(verify.constraints).toEqual(CONSTRAINTS);
    expect(verify.functions).toEqual(FUNCTIONS);
    for (const fn of verify.functions) expect(fn).toMatch(/\(.*\)$/);
    expect(verify.queries).toHaveLength(1);
    const [trigger] = verify.queries;
    expect(trigger.equals).toBe("1");
    expect(trigger.sql).toContain(
      "tgname = 'billing_invoices_tax_invoice_complete'",
    );
    expect(trigger.sql).not.toMatch(
      /prosrc|has_function_privilege|help_articles/,
    );
  });

  it("checks at apply time that the guard keeps all fourteen conditions 0245's own check asserted", () => {
    const applied = manifestEntry("20261026_0245_issued_invoice_guards")
      .applyVerify.queries.map((q) => q.sql)
      .find((sql) => sql.includes("billing_invoices_guard_immutable()"))!;
    const conditions =
      applied.match(
        /p\.prosrc ~ '(?:[^']|'')*'|position\('(?:[^']|'')*' in p\.prosrc\) > 0/g,
      ) ?? [];
    expect(conditions).toHaveLength(14);
    const guard = manifestEntry()
      .applyVerify.queries.map((q) => q.sql)
      .find((sql) => sql.includes("billing_invoices_guard_immutable()"))!;
    for (const condition of conditions) {
      expect(guard, condition).toContain(condition);
    }
    for (const arm of ["sac_code", "tax_inclusive", "place_of_supply_basis"]) {
      expect(guard).toContain(
        `p.prosrc ~ 'new\\.${arm}\\s+is distinct from old\\.${arm}'`,
      );
    }
  });

  it("checks at apply time what the file defines, so every applyVerify query can pass", () => {
    const { applyVerify } = manifestEntry();
    expect(applyVerify.queries).toHaveLength(6);
    for (const query of applyVerify.queries) {
      expect(query.sql, query.name).toMatch(/^select\b/);
      expect(query.sql, query.name).not.toContain(";");
    }
    const bodies: Record<string, string> = {
      "billing_invoices_guard_tax_invoice()": functionBody(
        RAW,
        "billing_invoices_guard_tax_invoice",
      ),
      "billing_invoices_guard_immutable()": functionBody(
        RAW,
        "billing_invoices_guard_immutable",
      ),
      "billing_invoice_parties(uuid,text,text,text)": functionBody(
        RAW,
        "billing_invoice_parties",
      ),
      "billing_invoices_snapshot_parties()": functionBody(
        RAW,
        "billing_invoices_snapshot_parties",
      ),
    };
    let probed = 0;
    for (const query of applyVerify.queries) {
      const target = Object.keys(bodies).find((fn) =>
        query.sql.includes(`p.oid = 'public.${fn}'::regprocedure`),
      );
      if (!target) continue;
      // prosrc keeps the file's line breaks; the folded body keeps one space
      // between words, which every `position(...)` literal here also uses.
      const body = bodies[target];
      for (const [, literal] of query.sql.matchAll(
        /position\('((?:[^']|'')*)' in p\.prosrc\)/g,
      )) {
        expect(body, `${query.name}: ${literal}`).toContain(
          literal.replace(/''/g, "'"),
        );
        probed++;
      }
      for (const [, pattern] of query.sql.matchAll(
        /p\.prosrc ~ '((?:[^']|'')*)'/g,
      )) {
        expect(body, `${query.name}: ${pattern}`).toMatch(new RegExp(pattern));
        probed++;
      }
    }
    expect(probed).toBeGreaterThanOrEqual(25);
    const appService = applyVerify.queries.find((q) =>
      q.sql.includes("has_function_privilege('app_service'"),
    )!;
    expect(appService.sql).toBe(
      "select has_function_privilege('app_service', 'public.billing_invoices_guard_tax_invoice()', 'EXECUTE')::text",
    );
    expect(appService.equals).toBe("false");
  });
});
