import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGAL_CONTENT } from "./content";
import { checksumBody } from "./documents";

// ---------------------------------------------------------------------------
// Migration 0241 publishes Privacy Policy v3 with the release (owner, 24 Oct
// 2026: approved by a lawyer exactly as written). Its body and checksum are
// literals in the SQL, so these pins keep the file honest: the body is the
// approved text and nothing else, the checksum is the one lib/legal computes,
// and the publish follows publishLegalVersion (lib/legal/store.ts) step for
// step. ★ Once a migration is applied its file can never change (the runner
// checksums it), so a mistake caught here is the only cheap one.
// ---------------------------------------------------------------------------

const ID = "20261024_0241_publish_privacy_policy_v3";
const SQL = readFileSync(`drizzle/migrations/sql/${ID}.sql`, "utf8");
const TAG = "$privacy_v3_body$";
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

/** The text between the two dollar-quote tags, exactly as the file has it. */
function quotedBody(): string {
  const open = SQL.indexOf(TAG);
  const close = SQL.indexOf(TAG, open + TAG.length);
  expect(open, "the opening tag").toBeGreaterThan(-1);
  expect(close, "the closing tag").toBeGreaterThan(open);
  expect(SQL.indexOf(TAG, close + TAG.length), "a third tag").toBe(-1);
  return SQL.slice(open + TAG.length, close);
}

/** A `v_name CONSTANT text := '...';` literal of the DO block. */
function constant(name: string): string {
  const match = SQL.match(new RegExp(`${name} CONSTANT text := '([^']*)';`));
  expect(match, name).not.toBeNull();
  return match![1];
}

/** The executable SQL: the body cut out, comments removed, spaces folded. */
function executable(): string {
  const open = SQL.indexOf(TAG);
  const close = SQL.indexOf(TAG, open + TAG.length) + TAG.length;
  return (SQL.slice(0, open) + "BODY" + SQL.slice(close))
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ");
}

function manifestEntry(): {
  requires: string[];
  verify: Record<string, unknown>;
  applyVerify: { queries: { sql: string }[] };
} {
  const manifest = JSON.parse(
    readFileSync("drizzle/migrations/manifest.json", "utf8"),
  ) as { migrations: { id: string }[] };
  const entry = manifest.migrations.find((migration) => migration.id === ID);
  expect(entry, ID).toBeDefined();
  return entry as unknown as ReturnType<typeof manifestEntry>;
}

describe("migration 0241: publish Privacy Policy v3", () => {
  it("quotes a body that equals its own trim", () => {
    const body = quotedBody();
    expect(body.length).toBeGreaterThan(1000);
    expect(body).toBe(body.trim());
  });

  it("carries the checksum lib/legal computes for that body", async () => {
    const checksum = constant("v_checksum");
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(await checksumBody(quotedBody())).toBe(checksum);
  });

  it("checks the same checksum when it is applied", () => {
    const checksum = constant("v_checksum");
    const applied = manifestEntry().applyVerify.queries.map((q) => q.sql);
    expect(applied.some((sql) => sql.includes(`'${checksum}'`))).toBe(true);
  });

  it("has no em or en dash in the published text", () => {
    const body = quotedBody();
    expect(body.includes(EM_DASH)).toBe(false);
    expect(body.includes(EN_DASH)).toBe(false);
  });

  it("uses a dollar-quote tag the body cannot close, inside a block it cannot end", () => {
    // The body holds no dollar sign at all, so neither its own tag nor the
    // DO block's $$ can occur in it.
    expect(quotedBody().includes("$")).toBe(false);
  });

  // ★ Compared only while content.ts is at v3. Once it moves on (a v4 draft),
  //   this file still publishes v3 exactly as approved, and the checksum pin
  //   above still holds it to that text; comparing it with a later draft would
  //   fail for the right reason and say nothing about this migration.
  const privacy = LEGAL_CONTENT.find((content) => content.kind === "privacy");
  it.skipIf(privacy?.version !== 3)(
    "is content.ts's v3, body and title, while content.ts is at v3",
    () => {
      expect(quotedBody()).toBe(privacy!.body.trim());
      expect(constant("v_title")).toBe(privacy!.title);
    },
  );

  it("refuses to write when the body and checksum disagree, before anything else", () => {
    const sql = executable();
    const check = sql.indexOf(
      "IF encode(sha256(convert_to(v_body, 'UTF8')), 'hex') <> v_checksum THEN RAISE EXCEPTION",
    );
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(sql.indexOf("SELECT id, version INTO"));
  });

  it("does nothing where v3 or later is current, and stops on a v3 that is not", () => {
    const sql = executable();
    const done = sql.indexOf("IF v_current_version >= 3 THEN RETURN; END IF;");
    const stop = sql.indexOf(
      "IF EXISTS ( SELECT 1 FROM public.legal_documents WHERE kind = 'privacy' AND version = 3 ) THEN RAISE EXCEPTION",
    );
    const retire = sql.indexOf(
      "UPDATE public.legal_documents SET is_current = false WHERE id = v_current_id;",
    );
    expect(done).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(done);
    expect(retire).toBeGreaterThan(stop);
  });

  it("retires the current row before it inserts v3, as publishLegalVersion does", () => {
    const sql = executable();
    const retire = sql.indexOf(
      "UPDATE public.legal_documents SET is_current = false WHERE id = v_current_id;",
    );
    const insert = sql.indexOf(
      "INSERT INTO public.legal_documents (kind, version, title, body, checksum, is_current, effective_at, published_at, created_by) VALUES ('privacy', 3, v_title, v_body, v_checksum, true, now(), now(), 'script');",
    );
    expect(retire).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(retire);
  });

  it("never names the Terms or the Acceptable Use Policy", () => {
    const sql = executable();
    expect(sql).not.toMatch(/'terms'|'acceptable-use'/);
  });

  it("asserts no published wording, version or checksum in its durable verify", () => {
    const entry = manifestEntry();
    expect(entry.requires).toEqual([
      "20261024_0240_release_indexes_and_grants",
    ]);
    expect(entry.verify).toEqual({});
  });
});
