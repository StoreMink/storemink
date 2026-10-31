import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Migration 0269: operator takedown (the complaints log, blocks, their
// messages and archives, store holds, the moderation record, and the
// moderation_blocked_at flag with its guards and the six read policies).
// Pinned on the file itself because an applied migration can never change
// (the runner checksums it). The behaviour behind each line was probed on
// storemink_local in a rolled-back transaction (the takedown design's
// probe-v3 replayed against this file: every refusal as expected); these
// pins keep the file saying what was probed.
// ---------------------------------------------------------------------------

const ID = "20261030_0269_content_takedown";
const RAW = readFileSync(`drizzle/migrations/sql/${ID}.sql`, "utf8");
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

const TABLES = [
  "grievance_complaints",
  "content_blocks",
  "content_block_messages",
  "content_block_archives",
  "store_legal_holds",
  "moderation_events",
];

/** Least read first, so the busiest tables wait the least for their lock. */
const FLAGGED = [
  "blog_comments",
  "product_reviews",
  "blogs",
  "categories",
  "store_pages",
  "products",
];

/** The four tables whose rows outlive their store (store link cleared). */
const KEPT_PAST_STORE = [
  "grievance_complaints",
  "content_blocks",
  "content_block_archives",
  "store_legal_holds",
];

/** Only these run as their owner: the prune deletes what app_service may
 *  not, and the others read or write tables their callers cannot. */
const SECURITY_DEFINER = [
  "stores_guard_delete",
  "stores_guard_moderation_status",
  "moderation_prune_events",
  "moderation_author_guard",
  "content_blocks_apply",
];

/** pg_policies.qual of each public read policy before 0269, read from
 *  storemink_local on 30 Oct 2026, and the one part of it a block narrows:
 *  the published (or active) arm gains "AND moderation_blocked_at IS NULL".
 *  Reviews and comments were readable by anyone (`true`); they become
 *  readable while unblocked, and always by their own author. */
const POLICIES: Array<{
  table: string;
  name: string;
  before: string;
  after: string;
}> = [
  {
    table: "blog_comments",
    name: "Anyone can read blog comments",
    before: "true",
    after:
      "((moderation_blocked_at IS NULL) OR (user_id = ( SELECT auth.uid() AS uid)))",
  },
  {
    table: "product_reviews",
    name: "Anyone can read reviews",
    before: "true",
    after:
      "((moderation_blocked_at IS NULL) OR (user_id = ( SELECT auth.uid() AS uid)))",
  },
  ...[
    {
      table: "blogs",
      name: "Read blogs",
      before:
        "((status = 'published'::text) OR ((submitted_by = ( SELECT auth.uid() AS uid)) AND (is_customer_submission = true)) OR ( SELECT is_store_admin(blogs.store_id) AS is_store_admin))",
      gated: "(status = 'published'::text)",
    },
    {
      table: "categories",
      name: "Read categories",
      before:
        "((status = 'active'::text) OR ( SELECT is_store_admin(categories.store_id) AS is_store_admin))",
      gated: "(status = 'active'::text)",
    },
    {
      table: "store_pages",
      name: "Public read published store_pages",
      before:
        "((status = 'published'::text) OR ( SELECT is_store_admin(store_pages.store_id) AS is_store_admin))",
      gated: "(status = 'published'::text)",
    },
    {
      table: "products",
      name: "Read products",
      before:
        "((status = 'published'::text) OR ( SELECT is_store_admin(products.store_id) AS is_store_admin))",
      gated: "(status = 'published'::text)",
    },
  ].map(({ gated, ...policy }) => ({
    ...policy,
    after: policy.before.replace(
      gated,
      `(${gated} AND (moderation_blocked_at IS NULL))`,
    ),
  })),
];

type Query = { name: string; sql: string; equals: string };
type ManifestEntry = {
  id: string;
  description: string;
  file: string;
  transaction: boolean;
  requires: string[];
  supersedesVerifyQueries?: Array<{ migrationId: string; queryName: string }>;
  verify: {
    tables?: string[];
    columns?: string[];
    constraints?: string[];
    rlsTables?: string[];
    functions?: string[];
    queries?: Query[];
  };
  applyVerify?: { queries: Query[] };
};

function fold(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function manifestEntry(id: string): ManifestEntry {
  const entry = (
    JSON.parse(readFileSync("drizzle/migrations/manifest.json", "utf8")) as {
      migrations: ManifestEntry[];
    }
  ).migrations.find((m) => m.id === id);
  expect(entry, id).toBeDefined();
  return entry!;
}

/** Every function the file creates, with its header (up to `AS $$`). */
function functions(): Array<{ name: string; args: string; head: string }> {
  return [
    ...SQL.matchAll(
      /CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)(.*?)AS \$\$/g,
    ),
  ].map((m) => ({ name: m[1], args: m[2], head: m[3] }));
}

/** Each REVOKE: what it names and whom it names. */
function revokes(): Array<{ objects: string; from: string }> {
  return [...SQL.matchAll(/REVOKE ALL ON (.*?) FROM (.*?);/g)].map((m) => ({
    objects: m[1],
    from: m[2],
  }));
}

/** Each GRANT, as written. */
function grants(): string[] {
  return [...SQL.matchAll(/GRANT [^;]*;/g)].map((m) => m[0]);
}

/** The body of one CREATE TABLE, up to the next top-level statement. */
function tableBody(table: string): string {
  const start = SQL.indexOf(`CREATE TABLE IF NOT EXISTS public.${table} (`);
  expect(start, table).toBeGreaterThan(-1);
  const end = SQL.indexOf(" CREATE ", start + 1);
  return SQL.slice(start, end);
}

describe("migration 0269: operator takedown", () => {
  it("has no em or en dash and names neither former provider nor the old storage source", () => {
    expect(RAW.includes(EM_DASH)).toBe(false);
    expect(RAW.includes(EN_DASH)).toBe(false);
    expect(RAW).not.toMatch(FORMER_PROVIDERS);
    expect(RAW).not.toMatch(/legacy/i);
  });

  it("names itself and the migration it follows in its header", () => {
    expect(RAW.split("\n")[0]).toBe(
      `-- drizzle/migrations/sql/${ID}.sql (requires 20261029_0268_plans_and_billing_name_help).`,
    );
    expect(RAW).not.toMatch(/DRAFT|YYYYMMDD|next free|Not a repo file/);
  });

  it("lowers its own lock timeout to 1 second as its first statement", () => {
    expect(SQL.startsWith("SET LOCAL lock_timeout = '1s'; ")).toBe(true);
    expect(SQL.match(/lock_timeout/g)).toHaveLength(1);
  });

  it("creates the six tables, each with RLS on and no policy", () => {
    expect(
      [...SQL.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+) \(/g)].map(
        (m) => m[1],
      ),
    ).toEqual(TABLES);
    for (const table of TABLES) {
      expect(SQL, table).toContain(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`,
      );
    }
    expect(SQL).not.toMatch(/CREATE POLICY/i);
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|POLICY|FUNCTION)\b/i);
  });

  it("keeps complaints, blocks, archives and holds past their store, with the store link cleared, and points nothing else at stores", () => {
    for (const table of TABLES) {
      const body = tableBody(table);
      const keys = [...body.matchAll(/(\w+) uuid REFERENCES public\.stores/g)];
      if (KEPT_PAST_STORE.includes(table)) {
        expect(
          keys.map((m) => m[1]),
          table,
        ).toEqual(["store_id"]);
        expect(body, table).toContain(
          "store_id uuid REFERENCES public.stores(id) ON DELETE SET NULL,",
        );
      } else {
        expect(keys, table).toHaveLength(0);
      }
    }
    expect(SQL.match(/REFERENCES public\.stores\(/g)).toHaveLength(
      KEPT_PAST_STORE.length,
    );
  });

  it("adds the flag to the six content tables, nullable with no default, least read first, after the store keys", () => {
    const added = [
      ...SQL.matchAll(
        /ALTER TABLE public\.(\w+) ADD COLUMN IF NOT EXISTS moderation_blocked_at timestamptz;/g,
      ),
    ];
    expect(added.map((m) => m[1])).toEqual(FLAGGED);
    expect(SQL.match(/ADD COLUMN/g)).toHaveLength(FLAGGED.length);
    expect(added[0].index).toBeGreaterThan(
      SQL.lastIndexOf("REFERENCES public.stores("),
    );
  });

  it("knows only three file sources: this environment's bucket, a bundled theme file and an outside address", () => {
    const target = SQL.slice(
      SQL.indexOf("CONSTRAINT content_blocks_target_check"),
      SQL.indexOf("CONSTRAINT content_blocks_storage_kind_check"),
    );
    expect(
      [...target.matchAll(/WHEN '(\w+)' THEN object_path/g)].map((m) => m[1]),
    ).toEqual(["bucket", "bundled", "external"]);
    expect(
      [...SQL.matchAll(/file_source = '(\w+)'/g)].map((m) => m[1]).sort(),
    ).toEqual(["bucket", "bundled", "external"]);
    expect(SQL).not.toMatch(/file_source IN/);
  });

  it("narrows each public read policy by exactly the flag, keeping the rest of the old expression", () => {
    const altered = [
      ...SQL.matchAll(
        /ALTER POLICY "([^"]+)" ON public\.(\w+) USING \((.*?)\);/g,
      ),
    ].map((m) => ({ name: m[1], table: m[2], qual: `(${m[3]})` }));
    expect(altered.map(({ name, table }) => ({ name, table }))).toEqual(
      POLICIES.map(({ name, table }) => ({ name, table })),
    );
    for (const policy of POLICIES) {
      const qual = altered.find((a) => a.name === policy.name)!.qual;
      // The text pg_policies shows once applied (checked on storemink_local).
      expect(qual, policy.name).toBe(policy.after);
      expect(qual, policy.name).toContain("moderation_blocked_at IS NULL");
      if (policy.before !== "true") {
        expect(
          qual.replace(" AND (moderation_blocked_at IS NULL))", "").slice(1),
          policy.name,
        ).toBe(policy.before);
      }
    }
  });

  it("records the same six policies in drizzle/schema.ts", () => {
    const schema = readFileSync("drizzle/schema.ts", "utf8");
    for (const policy of POLICIES) {
      expect(schema, policy.name).toContain(
        `pgPolicy("${policy.name}", {\n      as: "permissive",\n      for: "select",\n      to: ["public"],\n      using: sql\`${policy.after}\`,\n    }),`,
      );
    }
  });

  it("pins every function's search path and runs only the five that must as their owner", () => {
    const created = functions();
    expect(created.map((f) => f.name).sort()).toEqual(
      [
        "content_block_archives_guard",
        "content_blocks_apply",
        "content_blocks_guard_update",
        "moderation_author_guard",
        "moderation_flag_guard",
        "moderation_prune_events",
        "stores_guard_delete",
        "stores_guard_moderation_status",
      ].sort(),
    );
    for (const fn of created) {
      expect(fn.head, fn.name).toContain("SET search_path = ''");
    }
    expect(
      created
        .filter((fn) => fn.head.includes("SECURITY DEFINER"))
        .map((fn) => fn.name)
        .sort(),
    ).toEqual([...SECURITY_DEFINER].sort());
  });

  it("revokes every new table, the sequence and every function from PUBLIC, app_user and app_service", () => {
    const all = revokes();
    expect(all.length).toBeGreaterThan(0);
    for (const revoke of all) {
      expect(revoke.from, revoke.objects).toBe("PUBLIC, app_user, app_service");
    }
    const named = all.map((r) => r.objects).join(", ");
    for (const table of TABLES) {
      expect(named, table).toMatch(new RegExp(`public\\.${table}\\b(?!\\()`));
    }
    expect(named).toContain("SEQUENCE public.grievance_complaints_ref_no_seq");
    for (const fn of functions()) {
      expect(named, fn.name).toContain(`public.${fn.name}(`);
    }
  });

  it("closes every trigger function to everyone, because a trigger fires whatever the caller's grant", () => {
    const triggerFunctions = functions().filter((fn) =>
      fn.head.includes("RETURNS trigger"),
    );
    expect(triggerFunctions).toHaveLength(7);
    for (const fn of triggerFunctions) {
      const revoke = revokes().find((r) =>
        r.objects.includes(`public.${fn.name}()`),
      );
      expect(revoke, fn.name).toBeDefined();
      expect(revoke!.objects, fn.name).toMatch(/^FUNCTION /);
      expect(grants().join(" "), fn.name).not.toContain(fn.name);
    }
  });

  it("grants app_service only what the build needs: no DELETE anywhere, the record append-only, the prune to app_service alone", () => {
    expect(grants()).toEqual([
      "GRANT SELECT, INSERT, UPDATE ON public.grievance_complaints TO app_service;",
      "GRANT SELECT, INSERT, UPDATE ON public.content_blocks TO app_service;",
      "GRANT SELECT, INSERT, UPDATE ON public.content_block_messages TO app_service;",
      "GRANT SELECT, INSERT, UPDATE ON public.content_block_archives TO app_service;",
      "GRANT SELECT, INSERT, UPDATE ON public.store_legal_holds TO app_service;",
      "GRANT SELECT, INSERT ON public.moderation_events TO app_service;",
      "GRANT EXECUTE ON FUNCTION public.moderation_prune_events(timestamptz, integer) TO app_service;",
    ]);
    // Each GRANT follows the REVOKE ALL that clears the default privileges.
    const firstGrant = SQL.indexOf("GRANT ");
    expect(firstGrant).toBeGreaterThan(
      SQL.indexOf("REVOKE ALL ON public.grievance_complaints"),
    );
    expect(
      SQL.indexOf("GRANT EXECUTE ON FUNCTION public.moderation_prune_events"),
    ).toBeGreaterThan(
      SQL.indexOf("REVOKE ALL ON FUNCTION public.moderation_prune_events"),
    );
  });

  it("is enrolled after 0268, retiring 0243's store-key query for one that also names the four kept store keys", () => {
    const entry = manifestEntry(ID);
    expect(entry.file).toBe(`sql/${ID}.sql`);
    expect(entry.transaction).toBe(true);
    expect(entry.requires).toEqual([
      "20261029_0268_plans_and_billing_name_help",
    ]);
    expect(entry.description.endsWith(" Requires 0268.")).toBe(true);
    expect(entry.description).not.toMatch(/legacy|&\w+;/i);
    expect(entry.description.includes(EM_DASH)).toBe(false);
    expect(entry.description.includes(EN_DASH)).toBe(false);

    const retired = {
      migrationId: "20261025_0243_keep_invoices_after_store_deletion",
      queryName: "every other direct store foreign key cascades on deletion",
    };
    expect(entry.supersedesVerifyQueries).toEqual([retired]);
    const old = manifestEntry(retired.migrationId).verify.queries!.find(
      (q) => q.name === retired.queryName,
    )!;
    const exceptions = old.sql.slice(old.sql.indexOf(" and not (") + 10, -1);
    const replacement = entry.verify.queries!.find((q) =>
      q.sql.includes("confdeltype <> 'c'"),
    )!;
    expect(replacement.equals).toBe("0");
    expect(replacement.sql).toContain(exceptions);
    const kept = entry.verify.queries!.find((q) =>
      q.sql.includes("confdeltype = 'n'"),
    )!;
    expect(kept.equals).toBe(String(KEPT_PAST_STORE.length));
    for (const table of KEPT_PAST_STORE) {
      const key = `(conrelid = 'public.${table}'::regclass and conname = '${table}_store_id_fkey')`;
      expect(replacement.sql, table).toContain(key);
      expect(kept.sql, table).toContain(key);
    }
  });

  it("verifies durably only structure the file creates, and the policy wording once", () => {
    const entry = manifestEntry(ID);
    expect(entry.verify.tables).toEqual(TABLES);
    expect(entry.verify.rlsTables).toEqual(TABLES);
    expect([...entry.verify.columns!].sort()).toEqual(
      FLAGGED.map((t) => `${t}.moderation_blocked_at`).sort(),
    );
    for (const constraint of entry.verify.constraints!) {
      expect(SQL, constraint).toContain(`CONSTRAINT ${constraint} CHECK (`);
    }
    expect(entry.verify.constraints).toHaveLength(15);
    expect(entry.verify.functions!.map((f) => f.split("(")[0]).sort()).toEqual(
      functions()
        .map((fn) => fn.name)
        .sort(),
    );
    expect(entry.verify.functions).toContain(
      "moderation_prune_events(timestamp with time zone,integer)",
    );
    for (const query of [
      ...entry.verify.queries!,
      ...entry.applyVerify!.queries,
    ]) {
      expect(query.sql, query.name).toMatch(/^select\b/);
      expect(query.sql, query.name).not.toContain(";");
    }
    expect(entry.verify.queries!.map((q) => q.equals)).toEqual([
      "0",
      "false",
      "19",
      "5",
      "4",
      "0",
    ]);
    // Policy text may be rewritten by a later migration: applyVerify only.
    for (const query of entry.verify.queries!) {
      expect(query.sql, query.name).not.toContain("pg_policies");
    }
    const [policies, nothingBlocked, closed] = entry.applyVerify!.queries;
    for (const policy of POLICIES) {
      expect(policies.sql, policy.name).toContain(`'${policy.name}'`);
    }
    expect(policies.equals).toBe(String(POLICIES.length));
    expect(nothingBlocked.equals).toBe("0");
    expect(closed.sql).toContain(
      "has_function_privilege('app_service', 'public.content_blocks_apply()', 'EXECUTE')",
    );
    expect(closed.sql).toContain(
      "has_function_privilege('app_user', 'public.moderation_author_guard()', 'EXECUTE')",
    );
    expect(closed.equals).toBe("false");
  });
});
