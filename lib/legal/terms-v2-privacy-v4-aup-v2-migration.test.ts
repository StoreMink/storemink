import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGAL_CONTENT } from "./content";
import { checksumBody } from "./documents";

// ---------------------------------------------------------------------------
// Migration 0255 publishes Terms of Service v2, Privacy Policy v4 and the
// Acceptable Use Policy v2 together with the release (owner, 26 Oct 2026:
// reviewed by a lawyer and approved exactly as written). Their bodies and
// checksums are literals in the SQL, so these pins keep the file honest: each
// body is the approved text and nothing else, each checksum is the one
// lib/legal computes, and the publish follows publishLegalVersion
// (lib/legal/store.ts) step for step, for all three or none. ★ Once a
// migration is applied its file can never change (the runner checksums it),
// so a mistake caught here is the only cheap one.
// ---------------------------------------------------------------------------

const ID = "20261026_0255_publish_legal_terms_v2_privacy_v4_aup_v2";
const SQL = readFileSync(`drizzle/migrations/sql/${ID}.sql`, "utf8");
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

/** What the migration publishes, in the order it publishes it. */
const DOCS = [
  {
    kind: "terms",
    version: 2,
    title: "Terms of Service",
    name: "terms",
    tag: "$terms_v2_body$",
  },
  {
    kind: "privacy",
    version: 4,
    title: "Privacy Policy",
    name: "privacy",
    tag: "$privacy_v4_body$",
  },
  {
    kind: "acceptable-use",
    version: 2,
    title: "Acceptable Use Policy",
    name: "aup",
    tag: "$aup_v2_body$",
  },
] as const;

/** The text between a body's two dollar-quote tags, exactly as the file has it. */
function quotedBody(tag: string): string {
  const open = SQL.indexOf(tag);
  const close = SQL.indexOf(tag, open + tag.length);
  expect(open, `the opening ${tag}`).toBeGreaterThan(-1);
  expect(close, `the closing ${tag}`).toBeGreaterThan(open);
  expect(SQL.indexOf(tag, close + tag.length), `a third ${tag}`).toBe(-1);
  return SQL.slice(open + tag.length, close);
}

/** A `v_name CONSTANT text := '...';` literal of the DO block. */
function constant(name: string): string {
  const match = SQL.match(new RegExp(`${name} CONSTANT text := '([^']*)';`));
  expect(match, name).not.toBeNull();
  return match![1];
}

/** The executable SQL: the bodies cut out, comments removed, spaces folded. */
function executable(): string {
  let sql = SQL;
  for (const doc of DOCS) {
    const open = sql.indexOf(doc.tag);
    const close = sql.indexOf(doc.tag, open + doc.tag.length) + doc.tag.length;
    sql = sql.slice(0, open) + "BODY" + sql.slice(close);
  }
  return sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
}

function manifestEntry(): {
  requires: string[];
  verify: Record<string, unknown>;
  applyVerify: { queries: { name: string; sql: string; equals: string }[] };
} {
  const manifest = JSON.parse(
    readFileSync("drizzle/migrations/manifest.json", "utf8"),
  ) as { migrations: { id: string }[] };
  const entry = manifest.migrations.find((migration) => migration.id === ID);
  expect(entry, ID).toBeDefined();
  return entry as unknown as ReturnType<typeof manifestEntry>;
}

describe("migration 0255: publish Terms v2, Privacy v4 and Acceptable Use v2", () => {
  it("quotes each body once, equal to its own trim, with Version only on its first line", () => {
    for (const doc of DOCS) {
      const body = quotedBody(doc.tag);
      expect(body.length, doc.kind).toBeGreaterThan(1000);
      expect(body, doc.kind).toBe(body.trim());
      expect(
        body.startsWith(`<p><em>Version ${doc.version}</em></p>`),
        doc.kind,
      ).toBe(true);
      // legal.test.ts reads the first "Version N" in a body as the version a
      // reader sees, so the body says "Version" there and nowhere else.
      expect(body.split("Version").length - 1, doc.kind).toBe(1);
    }
  });

  it("carries the checksum lib/legal computes for each body", async () => {
    for (const doc of DOCS) {
      const checksum = constant(`v_${doc.name}_checksum`);
      expect(checksum, doc.kind).toMatch(/^[0-9a-f]{64}$/);
      expect(await checksumBody(quotedBody(doc.tag)), doc.kind).toBe(checksum);
    }
  });

  it("checks the same checksums when it is applied", () => {
    const applied = manifestEntry().applyVerify.queries.map((q) => q.sql);
    for (const doc of DOCS) {
      const checksum = constant(`v_${doc.name}_checksum`);
      expect(
        applied.filter((sql) => sql.includes(`'${checksum}'`)).length,
        doc.kind,
      ).toBe(2);
    }
  });

  it("has no em or en dash in the published text", () => {
    for (const doc of DOCS) {
      const body = quotedBody(doc.tag);
      expect(body.includes(EM_DASH), doc.kind).toBe(false);
      expect(body.includes(EN_DASH), doc.kind).toBe(false);
    }
  });

  it("uses dollar-quote tags the bodies cannot close, inside a block they cannot end", () => {
    // The bodies hold no dollar sign at all, so neither their own tags nor
    // the DO block's $$ can occur in them.
    for (const doc of DOCS)
      expect(quotedBody(doc.tag).includes("$"), doc.kind).toBe(false);
  });

  // ★ Each document is compared with content.ts in a test of its own, and
  //   only while content.ts is at that document's version. Once one moves on
  //   (a later draft), this file still publishes this version exactly as
  //   approved, and the checksum pins above still hold it to that text;
  //   comparing it with a later draft would fail for the right reason and say
  //   nothing about this migration. The other two are still compared.
  for (const doc of DOCS) {
    const current = LEGAL_CONTENT.find((content) => content.kind === doc.kind);
    it.skipIf(current?.version !== doc.version)(
      `is content.ts's ${doc.kind} v${doc.version}, body and title, while content.ts is at that version`,
      () => {
        expect(quotedBody(doc.tag), doc.kind).toBe(current!.body.trim());
        expect(current!.title, doc.kind).toBe(doc.title);
      },
    );
  }

  it("publishes exactly these kinds, versions, titles, bodies and checksums, in this order", () => {
    const sql = executable();
    const list = (values: string[]) => values.join(", ");
    expect(sql).toContain(
      `v_kinds CONSTANT text[] := ARRAY[${list(DOCS.map((d) => `'${d.kind}'`))}];`,
    );
    expect(sql).toContain(
      `v_versions CONSTANT integer[] := ARRAY[${list(DOCS.map((d) => String(d.version)))}];`,
    );
    expect(sql).toContain(
      `v_titles CONSTANT text[] := ARRAY[${list(DOCS.map((d) => `'${d.title}'`))}];`,
    );
    expect(sql).toContain(
      `v_bodies CONSTANT text[] := ARRAY[${list(DOCS.map((d) => `v_${d.name}_body`))}];`,
    );
    expect(sql).toContain(
      `v_checksums CONSTANT text[] := ARRAY[${list(DOCS.map((d) => `v_${d.name}_checksum`))}];`,
    );
  });

  it("checks every body against its checksum before it reads or writes a row", () => {
    const sql = executable();
    const check = sql.indexOf(
      "IF encode(sha256(convert_to(v_bodies[i], 'UTF8')), 'hex') IS DISTINCT FROM v_checksums[i] THEN RAISE EXCEPTION",
    );
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(sql.indexOf("FROM public.legal_documents"));
  });

  it("refuses a version stored with another text, or stored but not current, before it writes anything", () => {
    const sql = executable();
    const differs = sql.indexOf(
      "IF v_existing_checksum IS DISTINCT FROM v_checksums[i] OR v_existing_body IS DISTINCT FROM v_bodies[i] THEN RAISE EXCEPTION",
    );
    const stale = sql.indexOf(
      "IF v_current_version IS NULL OR v_current_version < v_versions[i] THEN RAISE EXCEPTION",
    );
    const retire = sql.indexOf("UPDATE public.legal_documents");
    const insert = sql.indexOf("INSERT INTO public.legal_documents");
    expect(differs).toBeGreaterThan(-1);
    expect(stale).toBeGreaterThan(differs);
    expect(retire).toBeGreaterThan(stale);
    expect(insert).toBeGreaterThan(stale);
  });

  it("leaves alone a document whose new version or a later one is current", () => {
    const sql = executable();
    const skip = sql.indexOf(
      "IF v_current_version >= v_versions[i] THEN CONTINUE; END IF;",
    );
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(sql.indexOf("UPDATE public.legal_documents"));
  });

  it("retires the current row before it inserts the new version, as publishLegalVersion does", () => {
    const sql = executable();
    const retire = sql.indexOf(
      "UPDATE public.legal_documents SET is_current = false WHERE id = v_current_id;",
    );
    const insert = sql.indexOf(
      "INSERT INTO public.legal_documents (kind, version, title, body, checksum, is_current, effective_at, published_at, created_by) VALUES (v_kinds[i], v_versions[i], v_titles[i], v_bodies[i], v_checksums[i], true, now(), now(), 'script');",
    );
    expect(retire).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(retire);
  });

  it("is one DO block with no exception handler, so the apply-time witnesses see every row it writes", () => {
    const sql = executable();
    expect(sql.match(/\bDO \$\$/g)?.length).toBe(1);
    expect(sql).not.toMatch(/\bEXCEPTION\s+WHEN\b/i);
    expect(sql).not.toMatch(/\b(DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
  });

  it("witnesses the publish at apply time and asserts nothing durable", () => {
    const entry = manifestEntry();
    expect(entry.requires).toEqual([
      "20261026_0254_help_pos_and_dash_followups",
    ]);
    expect(entry.verify).toEqual({});
    const queries = entry.applyVerify.queries;
    for (const doc of DOCS) {
      expect(
        queries.some(
          (q) =>
            q.equals === "1" &&
            q.sql.endsWith(`where kind = '${doc.kind}' and is_current`),
        ),
        doc.kind,
      ).toBe(true);
    }
    const witnesses = queries.filter(
      (q) => q.sql.includes("xmin") && q.equals === "0",
    );
    expect(witnesses).toHaveLength(3);
  });
});
