import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Migration 0240: the seven indexes the release's statements were measured
// to need, and the two grants the failed-run record's holder run needs as
// app_service (robustness audit B4). Pinned on the file itself because an
// applied migration can never change: a wrong column list or a grant wider
// than intended would otherwise be permanent everywhere.
// ---------------------------------------------------------------------------

const ID = "20261024_0240_release_indexes_and_grants";
const RAW = readFileSync(`drizzle/migrations/sql/${ID}.sql`, "utf8");
/** The executable SQL: comments removed, whitespace folded. */
const SQL = RAW.replace(/--[^\n]*/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/** In file order: the least written table first, the busiest last. */
const INDEXES = [
  "whatsapp_mink_answers_message_idx ON public.whatsapp_mink_answers (message_id)",
  "whatsapp_mink_answers_sent_message_idx ON public.whatsapp_mink_answers (sent_message_id) WHERE sent_message_id IS NOT NULL",
  "whatsapp_mink_answers_conversation_id_idx ON public.whatsapp_mink_answers (conversation_id)",
  "notification_whatsapp_queue_event_idx ON public.notification_whatsapp_queue (event_id)",
  "notification_sms_queue_event_idx ON public.notification_sms_queue (event_id)",
  "mink_runs_running_idx ON public.mink_runs (started_at, id) WHERE status = 'running'",
  "storefront_events_order_idx ON public.storefront_events (order_id) WHERE order_id IS NOT NULL",
];

const GRANTS = [
  "GRANT DELETE ON TABLE public.mink_runs TO app_service",
  "GRANT UPDATE (run_id) ON TABLE public.mink_draft_credit_usage TO app_service",
];

function statements(): string[] {
  return SQL.split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : [];
  });
}

describe("migration 0240: release indexes and grants", () => {
  it("creates each index exactly as the measured plans use it", () => {
    for (const index of INDEXES) {
      expect(statements()).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
    }
  });

  it("creates nothing else, and never CONCURRENTLY (the runner's transaction refuses it)", () => {
    const creates = statements().filter((s) => /^CREATE\b/i.test(s));
    expect([...creates].sort()).toEqual(
      INDEXES.map((index) => `CREATE INDEX IF NOT EXISTS ${index}`).sort(),
    );
    expect(SQL).not.toMatch(/CONCURRENTLY|UNIQUE/i);
  });

  it("takes each SHARE lock in order, so the busiest tables wait the least", () => {
    const order = statements()
      .filter((s) => s.startsWith("CREATE INDEX"))
      .map((s) => s.replace("CREATE INDEX IF NOT EXISTS ", ""));
    expect(order).toEqual(INDEXES);
  });

  it("grants app_service the two privileges the holder run lacked, and nothing else", () => {
    const grants = statements().filter((s) => /^(GRANT|REVOKE)\b/i.test(s));
    expect(grants).toEqual(GRANTS);
    expect(statements()).toHaveLength(INDEXES.length + GRANTS.length);
  });

  // ★★ app_service holds UPDATE on mink_draft_credit_usage only for run_id
  //   wherever no default privileges reach it (0040 grants SELECT, INSERT;
  //   this migration adds run_id alone, so a charge cannot be rewritten). A
  //   writer that sets another column would be refused there and nowhere
  //   else, so every UPDATE of the table in the app is held to run_id here.
  it("keeps every UPDATE of mink_draft_credit_usage to the run_id column", () => {
    const writers: string[] = [];
    for (const file of [...sourceFiles("lib"), ...sourceFiles("app")]) {
      const source = readFileSync(file, "utf8");
      expect(
        source,
        `${file}: a raw UPDATE of mink_draft_credit_usage must be checked against migration 0240's grant`,
      ).not.toMatch(/update\s+(public\.)?mink_draft_credit_usage\b/i);
      for (const match of source.matchAll(
        /\.update\(minkDraftCreditUsage\)\s*\.set\(\{([^}]*)\}\)/g,
      )) {
        const keys = match[1]
          .split(",")
          .map((pair) => pair.split(":")[0].trim())
          .filter(Boolean);
        expect(keys, file).toEqual(["runId"]);
        writers.push(file);
      }
      expect(
        source.split(".update(minkDraftCreditUsage)").length - 1,
        `${file}: every .update(minkDraftCreditUsage) is followed by its .set`,
      ).toBe(writers.filter((writer) => writer === file).length);
    }
    expect(writers).toEqual(["lib/mink/persistence.ts"]);
  });

  it("verifies every index and grant durably, naming no wording", () => {
    const manifest = JSON.parse(
      readFileSync("drizzle/migrations/manifest.json", "utf8"),
    ) as {
      migrations: {
        id: string;
        requires: string[];
        verify: { queries: { sql: string }[] };
      }[];
    };
    const entry = manifest.migrations.find((m) => m.id === ID);
    expect(entry, ID).toBeDefined();
    expect(entry!.requires).toEqual([
      "20261024_0239_mink_storefront_revamp_robustness_help",
    ]);
    const durable = entry!.verify.queries.map((q) => q.sql).join("\n");
    for (const index of INDEXES) {
      expect(durable).toContain(`'${index.split(" ")[0]}'`);
    }
    expect(durable).toContain(
      "has_table_privilege('app_service', 'public.mink_runs', 'DELETE')",
    );
    expect(durable).toContain(
      "has_column_privilege('app_service', 'public.mink_draft_credit_usage', 'run_id', 'UPDATE')",
    );
    expect(durable).not.toMatch(/help_articles|legal_documents|body like/i);
  });
});
