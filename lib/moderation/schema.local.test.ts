/** Rollback-only checks, against local Postgres, of the takedown schema
 * (migration 20261030_0269_content_takedown) as assertions: the takedown
 * design's probes P1 to P18 (section 4.4; P11 through EXPLAIN ANALYZE trigger
 * lists, and P12, P13 and P14 from the earlier probe sessions), V1 and V2
 * (the manifest entry's durable verify and applyVerify queries), and two
 * plan checks: A10 (the author's upsert of a review StoreMink removed is
 * refused, as app_user) and A11 (a block moves a product's updated_at, never
 * its content_updated_at). Run with MODERATION_LOCAL_TEST=1 after
 * `npm run db:migrate:local -- apply`; the fixed loopback database keeps it
 * away from Cloud SQL, and everything happens inside one transaction that is
 * rolled back, each case in its own savepoint.
 *
 * Fixtures: the local store `echo` (its first published product and one of
 * its pages) gains, inside the transaction, a store admin, two shoppers, a
 * review, a blog post and a comment; the store
 * `demo-exemplar-classic-and-trusted` is suspended (P16) and deleted (P7),
 * each undone by its case's savepoint.
 *
 * Each case runs as the role it needs: app_service for StoreMink's own
 * writes; app_user with app.current_user_id and app.current_user_email set
 * for a store admin or a shopper, and both empty for an anonymous visitor;
 * the connection's own (superuser) role for fixtures and for what no app
 * role may do.
 *
 * Notes:
 * - Postgres checks CHECK constraints in name order, so a row naming the
 *   removed `legacy` file source is refused by content_blocks_storage_kind_check
 *   first; P9g drops that constraint inside a savepoint to show
 *   content_blocks_target_check refuses it too. That takes an ACCESS
 *   EXCLUSIVE lock on content_blocks, and P7 deletes a whole store: run this
 *   file on its own, not beside a dev server writing to the database.
 * - Identity values (grievance_complaints.ref_no) are never rolled back, so
 *   each run moves that sequence on; nothing else outlives the transaction.
 */
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
  vi,
} from "vitest";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";

const enabled = process.env.MODERATION_LOCAL_TEST === "1";

const MIGRATION = "20261030_0269_content_takedown";
const ECHO_SLUG = "echo";
const DEMO_SLUG = "demo-exemplar-classic-and-trusted";
const OPERATOR = "op@storemink.com";
const SUPERADMIN = "super@storemink.com";
const CASE_MS = 30_000;
const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);

type Row = Record<string, unknown>;
type Identity = { id: string; email: string };
type Refusal = { code: string; constraint: string | null; message: string };
type ManifestQuery = { name: string; sql: string; equals: string };
type ManifestEntry = {
  id: string;
  supersedesVerifyQueries?: { migrationId: string; queryName: string }[];
  verify: {
    tables: string[];
    columns: string[];
    constraints: string[];
    rlsTables: string[];
    functions: string[];
    queries: ManifestQuery[];
  };
  applyVerify: { queries: ManifestQuery[] };
};

/** The people this file adds to the store echo. */
const ADMIN: Identity = {
  id: `t2-${tag}-admin`,
  email: `t2-${tag}-admin@probe.test`,
};
const AUTHOR: Identity = { id: `t2-${tag}-shopper-1`, email: "" };
const OTHER_SHOPPER: Identity = { id: `t2-${tag}-shopper-2`, email: "" };
const ANONYMOUS = null;

/** The six tables only StoreMink's own code may read (P8). */
const MODERATION_TABLES = [
  "grievance_complaints",
  "content_blocks",
  "content_block_messages",
  "content_block_archives",
  "store_legal_holds",
  "moderation_events",
];

/** Every trigger function 0269 adds. Nobody calls them directly, so neither
 *  app role may EXECUTE them; a trigger fires whatever the caller's grant. */
const TRIGGER_FUNCTIONS = [
  "content_blocks_apply()",
  "moderation_flag_guard()",
  "moderation_author_guard()",
  "stores_guard_delete()",
  "stores_guard_moderation_status()",
  "content_blocks_guard_update()",
  "content_block_archives_guard()",
];
const PRUNE_FUNCTION =
  "public.moderation_prune_events(timestamp with time zone,integer)";

/** applyVerify's one data condition: true when 0269 was applied, but not a
 *  fact about the schema, so a block committed locally later must not fail
 *  this file. Every other applyVerify query is asserted (V2). */
const DATA_STATE_QUERY = "no row is blocked yet";

/** The durable query of 0243 that 0269's entry retires: 0269 adds four more
 *  store keys that keep their rows (SET NULL), so "every other key cascades"
 *  is no longer true, and 0269's own two queries say what is. */
const RETIRED_QUERY = {
  migrationId: "20261025_0243_keep_invoices_after_store_deletion",
  queryName: "every other direct store foreign key cascades on deletion",
};

const RECORD = /is a record; block again instead of editing it$/;
const PRESERVED = /is a preserved copy and cannot be changed$/;
const NOT_DUE = /is held or not yet due for purging$/;
const ERASE_BLOCK = `update public.content_blocks
   set item_label = 'Erased', item_url = '', legal_basis = '', lift_note = '',
       store_message = 'Erased', erased_at = now()
 where id = $1`;
const PURGE_ARCHIVE = `update public.content_block_archives
   set snapshot = null, files = '[]', purged_at = now()
 where id = $1`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIXTURE_ID = /^t2-[0-9a-f]{10}-[a-z0-9-]+$/;

/** A quoted literal for the EXPLAIN statements, which this file writes out
 *  in full: only ids read from the database or made by this file. */
function literal(value: string): string {
  if (!UUID.test(value) && !FIXTURE_ID.test(value)) {
    throw new Error(`Not an id this file can quote: ${value}`);
  }
  return `'${value}'`;
}

/** A mobile number for a fixture shopper (unique per store). */
function randomMobile(): string {
  return `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

let manifest: { migrations: ManifestEntry[] } | null = null;
function manifestEntries(): ManifestEntry[] {
  manifest ??= JSON.parse(
    readFileSync("drizzle/migrations/manifest.json", "utf8"),
  ) as { migrations: ManifestEntry[] };
  return manifest.migrations;
}
function entry(): ManifestEntry {
  const found = manifestEntries().find((m) => m.id === MIGRATION);
  if (!found) throw new Error(`${MIGRATION} is not in the manifest.`);
  return found;
}
/** 0269's durable queries a later migration has retired, which the runner
 *  no longer checks either. */
function supersededQueries(): Set<string> {
  return new Set(
    manifestEntries().flatMap((m) =>
      (m.supersedesVerifyQueries ?? [])
        .filter((s) => s.migrationId === MIGRATION)
        .map((s) => s.queryName),
    ),
  );
}

describe.skipIf(!enabled)("the takedown schema (local database)", () => {
  let client: Client;
  let echo: { id: string; slug: string };
  let demo: { id: string; slug: string };
  let productId = "";
  let pageId = "";
  let reviewId = "";
  let blogId = "";
  let commentId = "";

  const rows = async (text: string, params: unknown[] = []) =>
    (await client.query(text, params)).rows as Row[];
  const one = async (text: string, params: unknown[] = []) =>
    (await rows(text, params))[0] ?? null;
  const idOf = (row: Row | null): string => {
    if (!row) throw new Error("The statement returned no row.");
    return String(row.id);
  };

  /** Run one statement that must be refused, inside its own savepoint, and
   *  say how it was refused (null when it went through, and then undo it). */
  async function refused(
    text: string,
    params: unknown[] = [],
  ): Promise<Refusal | null> {
    await client.query("SAVEPOINT t2_refusal");
    try {
      await client.query(text, params);
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT t2_refusal");
      await client.query("RELEASE SAVEPOINT t2_refusal");
      const e = error as {
        code?: string;
        constraint?: string;
        message?: string;
      };
      return {
        code: e.code ?? "",
        constraint: e.constraint ?? null,
        message: e.message ?? String(error),
      };
    }
    await client.query("ROLLBACK TO SAVEPOINT t2_refusal");
    await client.query("RELEASE SAVEPOINT t2_refusal");
    return null;
  }

  /** Back to the connection's own role, no identity. In an aborted
   *  transaction this cannot run, and the case's savepoint undoes both. */
  async function resetIdentity() {
    try {
      await client.query("RESET ROLE");
      await client.query(
        "select set_config('app.current_user_id', '', true), set_config('app.current_user_email', '', true)",
      );
    } catch {
      // The case's own savepoint is rolled back after it.
    }
  }

  /** As app_service, the role withService takes. Never nested. */
  async function asService<T>(fn: () => Promise<T>): Promise<T> {
    await client.query("SET ROLE app_service");
    try {
      return await fn();
    } finally {
      await resetIdentity();
    }
  }

  /** As app_user, signed in as `who`, or anonymous for null. Never nested. */
  async function asUser<T>(
    who: Identity | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    await client.query(
      "select set_config('app.current_user_id', $1, true), set_config('app.current_user_email', $2, true)",
      [who?.id ?? "", who?.email ?? ""],
    );
    await client.query("SET ROLE app_user");
    try {
      return await fn();
    } finally {
      await resetIdentity();
    }
  }

  /** An INSERT of one content_blocks row: the given fields over a plain
   *  block of the store echo; every other column keeps its default. */
  function blockInsert(fields: Row) {
    const all: Row = {
      store_id: echo.id,
      store_label: echo.slug,
      item_label: "Probe item",
      reason_kind: "terms_breach",
      store_message: "We blocked this after a complaint.",
      blocked_by: OPERATOR,
      ...fields,
    };
    const keys = Object.keys(all);
    return {
      text: `insert into public.content_blocks (${keys.join(", ")})
             values (${keys.map((_, i) => `$${i + 1}`).join(", ")})
             returning id`,
      params: keys.map((key) => all[key]),
    };
  }
  async function insertBlock(fields: Row): Promise<string> {
    const { text, params } = blockInsert(fields);
    return idOf(await asService(() => one(text, params)));
  }
  async function refusedBlock(fields: Row): Promise<Refusal | null> {
    const { text, params } = blockInsert(fields);
    return asService(() => refused(text, params));
  }

  const productBlock = (): Row => ({
    item_kind: "product",
    item_id: productId,
    item_label: "A product",
  });
  const reviewBlock = (author = AUTHOR.id): Row => ({
    item_kind: "review",
    item_id: reviewId,
    author_user_id: author,
    parent_item_id: productId,
    item_label: "Review by Priya S",
    reason_kind: "listed_content",
    store_message: "We removed a review.",
  });
  const commentBlock = (): Row => ({
    item_kind: "blog_comment",
    item_id: commentId,
    author_user_id: AUTHOR.id,
    parent_item_id: blogId,
    item_label: "Comment by Priya S",
    reason_kind: "store_request",
    store_message: "We removed this comment because you asked us to.",
  });
  const bucketFile = (name: string, state: string): Row => ({
    item_kind: "file",
    object_path: `stores/${echo.id}/media/t2-${tag}-${name}.webp`,
    file_source: "bucket",
    item_label: `${name}.webp`,
    storage_state: state,
  });
  const outsideFile = (name: string): Row => ({
    item_kind: "file",
    object_path: `https://cdn.example.com/t2-${tag}-${name}.jpg`,
    file_source: "external",
    item_label: `${name}.jpg`,
    storage_state: "not_ours",
  });
  const storeBlock = (statusBefore: string): Row => ({
    store_id: demo.id,
    store_label: demo.slug,
    item_kind: "store",
    item_id: demo.id,
    store_status_before: statusBefore,
    item_label: "Whole store",
    reason_kind: "listed_content",
    store_message: "We suspended your store after a complaint.",
  });

  /** A complaint received now, with its three deadlines from now. */
  function complaintInsert(input: {
    kind: string;
    channel?: string;
    ack: string;
    action: string;
    resolve: string;
    storeId?: string | null;
  }) {
    return {
      text: `insert into public.grievance_complaints
               (received_at, channel, kind, summary, acknowledge_due_at,
                action_due_at, resolve_due_at, created_by, store_id)
             values (now(), $1, $2, 'A probe complaint', now() + $3::interval,
                     now() + $4::interval, now() + $5::interval, $6, $7)
             returning id, ref_no, kind`,
      params: [
        input.channel ?? "email",
        input.kind,
        input.ack,
        input.action,
        input.resolve,
        OPERATOR,
        input.storeId ?? null,
      ],
    };
  }

  const productVisible = async () =>
    Number(
      (
        await one(
          "select count(*)::int as n from public.products where id = $1",
          [productId],
        )
      )?.n,
    );
  const storeStatus = async (storeId: string) =>
    String(
      (await one("select status from public.stores where id = $1", [storeId]))
        ?.status,
    );

  /** The triggers EXPLAIN ANALYZE reports for a statement it runs, by name
   *  with their call counts (foreign key triggers left out). */
  async function triggersFired(statement: string) {
    const plan = await rows(
      `explain (analyze, costs off, timing off, summary off) ${statement}`,
    );
    const fired = new Map<string, number>();
    for (const row of plan) {
      const line = String(row["QUERY PLAN"]).trim();
      const match = /^Trigger (?!for constraint )(\S+): calls=(\d+)$/.exec(
        line,
      );
      if (match) fired.set(match[1], Number(match[2]));
    }
    return fired;
  }
  const named = (fired: Map<string, number>, part: string) =>
    [...fired.entries()].filter(([name]) => name.includes(part));

  async function storeBySlug(slug: string) {
    const row = await one(
      "select id, slug from public.stores where slug = $1",
      [slug],
    );
    if (!row) {
      throw new Error(
        `The local store ${slug} is missing from storemink_local.`,
      );
    }
    return { id: String(row.id), slug: String(row.slug) };
  }

  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("No network in this test.");
      }),
    );
    client = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: process.env.MODERATION_LOCAL_TEST_USER || process.env.USER,
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

    echo = await storeBySlug(ECHO_SLUG);
    demo = await storeBySlug(DEMO_SLUG);
    productId = idOf(
      await one(
        `select id from public.products
          where store_id = $1 and status = 'published'
            and moderation_blocked_at is null
          order by created_at, id limit 1`,
        [echo.id],
      ),
    );
    pageId = idOf(
      await one(
        "select id from public.store_pages where store_id = $1 order by slug, id limit 1",
        [echo.id],
      ),
    );

    await client.query(
      `insert into public.admins (id, email, role, store_id, first_name)
       values ($1, $2, 'member', $3, 'Probe')`,
      [ADMIN.id, ADMIN.email, echo.id],
    );
    await client.query(
      `insert into public.users (id, phone, store_id, first_name)
       values ($1, $2, $3, 'Priya'), ($4, $5, $3, 'Ravi')`,
      [AUTHOR.id, randomMobile(), echo.id, OTHER_SHOPPER.id, randomMobile()],
    );
    reviewId = idOf(
      await one(
        `insert into public.product_reviews
           (product_id, user_id, author_name, rating, comment, store_id)
         values ($1, $2, 'Priya S', 4, 'Probe review', $3)
         returning id`,
        [productId, AUTHOR.id, echo.id],
      ),
    );
    blogId = idOf(
      await one(
        `insert into public.blogs (title, slug, status, store_id, content)
         values ('Probe post', $1, 'published', $2, '<p>x</p>')
         returning id`,
        [`t2-${tag}-probe-post`, echo.id],
      ),
    );
    commentId = idOf(
      await one(
        `insert into public.blog_comments
           (blog_id, user_id, author_name, body, store_id)
         values ($1, $2, 'Priya S', 'Probe comment', $3)
         returning id`,
        [blogId, AUTHOR.id, echo.id],
      ),
    );
  }, CASE_MS);

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!client) return;
    await client.query("ROLLBACK");
    await client.end();
  });

  beforeEach(async () => {
    await client.query("SAVEPOINT t2_case");
  });

  afterEach(async () => {
    await client.query("ROLLBACK TO SAVEPOINT t2_case");
    await client.query("RELEASE SAVEPOINT t2_case");
    await client.query("RESET ROLE");
  });

  // ---- V1, V2: the manifest entry, against the database ------------------

  it(
    "V1: every durable verify check of 0269's manifest entry passes",
    async () => {
      const verify = entry().verify;
      const problems: string[] = [];
      for (const table of verify.tables) {
        const row = await one("select to_regclass($1) is not null as ok", [
          `public.${table}`,
        ]);
        if (!row?.ok) problems.push(`table ${table}`);
      }
      for (const table of verify.rlsTables) {
        const row = await one(
          "select relrowsecurity as ok from pg_class where oid = to_regclass($1)",
          [`public.${table}`],
        );
        if (!row?.ok) problems.push(`row level security on ${table}`);
      }
      for (const value of verify.columns) {
        const [table, column] = value.split(".");
        const row = await one(
          `select 1 as ok from information_schema.columns
            where table_schema = 'public' and table_name = $1 and column_name = $2`,
          [table, column],
        );
        if (!row) problems.push(`column ${value}`);
      }
      for (const name of verify.constraints) {
        const row = await one(
          `select convalidated from pg_constraint
            where connamespace = 'public'::regnamespace and conname = $1`,
          [name],
        );
        if (!row?.convalidated) problems.push(`constraint ${name}`);
      }
      for (const fn of verify.functions) {
        const row = await one("select to_regprocedure($1) is not null as ok", [
          `public.${fn}`,
        ]);
        if (!row?.ok) problems.push(`function ${fn}`);
      }
      expect(problems).toEqual([]);

      const retired = supersededQueries();
      const queries = verify.queries.filter((q) => !retired.has(q.name));
      expect(queries.length).toBeGreaterThanOrEqual(4);
      for (const query of queries) {
        const row = await one(query.sql);
        expect(row ? row[Object.keys(row)[0]] : undefined, query.name).toBe(
          query.equals,
        );
      }
    },
    CASE_MS,
  );

  it(
    "V1b: 0269 retires 0243's store-key query, which no longer holds now that four moderation keys keep their rows",
    async () => {
      const replaced = (entry().supersedesVerifyQueries ?? []).find(
        (s) => s.migrationId === RETIRED_QUERY.migrationId,
      );
      expect(replaced).toEqual(RETIRED_QUERY);
      const old = manifestEntries()
        .find((m) => m.id === RETIRED_QUERY.migrationId)
        ?.verify.queries.find((q) => q.name === RETIRED_QUERY.queryName);
      expect(
        old,
        "0243's retired query is still in the manifest",
      ).toBeDefined();
      if (!old) return;
      const row = await one(old.sql);
      expect(row ? row[Object.keys(row)[0]] : undefined).not.toBe(old.equals);
    },
    CASE_MS,
  );

  it(
    "V2: the applyVerify checks still hold: all six read policies name the flag, and the trigger functions stay closed to both app roles",
    async () => {
      const all = entry().applyVerify.queries;
      expect(all.some((q) => q.name === DATA_STATE_QUERY)).toBe(true);
      const queries = all.filter((q) => q.name !== DATA_STATE_QUERY);
      expect(queries).toHaveLength(2);
      for (const query of queries) {
        const row = await one(query.sql);
        expect(row ? row[Object.keys(row)[0]] : undefined, query.name).toBe(
          query.equals,
        );
      }
    },
    CASE_MS,
  );

  // ---- P1, P2: the complaints log ----------------------------------------

  it(
    "P1: an intimate-image complaint (2 hours to act, 36 to resolve) is accepted from app_service",
    async () => {
      const { text, params } = complaintInsert({
        kind: "intimate_or_impersonation",
        ack: "24 hours",
        action: "2 hours",
        resolve: "36 hours",
        storeId: echo.id,
      });
      const row = await asService(() => one(text, params));
      expect(row?.kind).toBe("intimate_or_impersonation");
      expect(Number(row?.ref_no)).toBeGreaterThan(0);
    },
    CASE_MS,
  );

  it.each([
    {
      name: "P2a: an intimate image given 3 hours to act is refused",
      kind: "intimate_or_impersonation",
      ack: "24 hours",
      action: "3 hours",
      resolve: "36 hours",
      accepted: false,
    },
    {
      name: "P2b: a court order resolved after 4 hours is refused",
      channel: "court",
      kind: "court_order",
      ack: "24 hours",
      action: "3 hours",
      resolve: "4 hours",
      accepted: false,
    },
    {
      name: "P2c: an acknowledgement due after 25 hours is refused",
      kind: "grievance",
      ack: "25 hours",
      action: "7 days",
      resolve: "7 days",
      accepted: false,
    },
    {
      name: "P2d: listed content resolved after 37 hours is refused",
      kind: "listed_content",
      ack: "24 hours",
      action: "36 hours",
      resolve: "37 hours",
      accepted: false,
    },
    {
      name: "P2e: an intimate image resolved after 7 days is refused",
      kind: "intimate_or_impersonation",
      ack: "24 hours",
      action: "2 hours",
      resolve: "7 days",
      accepted: false,
    },
    {
      name: "P2f: an information order at 73 hours is refused",
      channel: "government",
      kind: "information_order",
      ack: "24 hours",
      action: "73 hours",
      resolve: "73 hours",
      accepted: false,
    },
    {
      name: "P2f: an information order at 72 hours is accepted",
      channel: "government",
      kind: "information_order",
      ack: "24 hours",
      action: "72 hours",
      resolve: "72 hours",
      accepted: true,
    },
    {
      name: "P2g: a data request at 16 days is refused",
      kind: "data_request",
      ack: "24 hours",
      action: "16 days",
      resolve: "16 days",
      accepted: false,
    },
    {
      name: "P2g: a data request at 15 days is accepted",
      kind: "data_request",
      ack: "24 hours",
      action: "15 days",
      resolve: "15 days",
      accepted: true,
    },
  ])(
    "$name",
    async (deadline) => {
      const { text, params } = complaintInsert(deadline);
      const outcome = await asService(() => refused(text, params));
      if (deadline.accepted) {
        expect(outcome).toBeNull();
      } else {
        expect(outcome?.constraint).toBe("grievance_complaints_due_check");
      }
    },
    CASE_MS,
  );

  it(
    "P2h: erasing a complaint is all or nothing, and only after it is resolved",
    async () => {
      const id = idOf(
        await asService(() =>
          one(
            `insert into public.grievance_complaints
               (received_at, channel, kind, complainant_name, complainant_contact,
                summary, urls, authority_ref, acknowledge_due_at, action_due_at,
                resolve_due_at, created_by)
             values (now(), 'email', 'grievance', 'Asha', 'asha@example.com',
                     'A probe complaint', '{https://a.example/1}', 'ref 1',
                     now() + interval '24 hours', now() + interval '7 days',
                     now() + interval '7 days', $1)
             returning id`,
            [OPERATOR],
          ),
        ),
      );
      const eraseAll = `update public.grievance_complaints
         set complainant_name = '', complainant_contact = '', acting_for = '',
             authority_ref = '', summary = '', urls = '{}', outcome_note = '',
             erased_at = now()
       where id = $1`;
      await asService(async () => {
        const partial = await refused(
          `update public.grievance_complaints
              set complainant_name = '', complainant_contact = '', acting_for = '',
                  summary = '', erased_at = now()
            where id = $1`,
          [id],
        );
        expect(partial?.constraint).toBe("grievance_complaints_erased_check");
        const early = await refused(eraseAll, [id]);
        expect(early?.constraint).toBe("grievance_complaints_erased_check");
        await client.query(
          `update public.grievance_complaints
              set resolved_at = now(), resolved_by = $2, outcome = 'answered'
            where id = $1`,
          [id, OPERATOR],
        );
        const erased = await one(
          `${eraseAll} returning erased_at is not null as erased`,
          [id],
        );
        expect(erased?.erased).toBe(true);
      });
    },
    CASE_MS,
  );

  // ---- P3, A11: blocking a product ---------------------------------------

  it(
    "P3: blocking a product sets its flag in the same statement and leaves its status alone",
    async () => {
      const blockId = await insertBlock(productBlock());
      const row = await one(
        `select p.status, p.moderation_blocked_at = b.blocked_at as flagged
           from public.products p, public.content_blocks b
          where p.id = $1 and b.id = $2`,
        [productId, blockId],
      );
      expect(row).toEqual({ status: "published", flagged: true });
    },
    CASE_MS,
  );

  it(
    "A11: a product block moves the row's updated_at and not its content_updated_at",
    async () => {
      const before = await one(
        `select updated_at < now() as earlier, content_updated_at
           from public.products where id = $1`,
        [productId],
      );
      expect(before?.earlier).toBe(true);
      await insertBlock(productBlock());
      const after = await one(
        `select updated_at = now() as moved,
                content_updated_at is not distinct from $2::timestamptz as content_kept
           from public.products where id = $1`,
        [productId, before?.content_updated_at ?? null],
      );
      expect(after).toEqual({ moved: true, content_kept: true });
    },
    CASE_MS,
  );

  it(
    "P3a: an anonymous read no longer sees the blocked product, and the store's other published products still show",
    async () => {
      await insertBlock(productBlock());
      await asUser(ANONYMOUS, async () => {
        expect(await productVisible()).toBe(0);
        const others = await one(
          `select count(*)::int as n from public.products
            where store_id = $1 and status = 'published' and id <> $2`,
          [echo.id, productId],
        );
        expect(Number(others?.n)).toBeGreaterThan(0);
      });
    },
    CASE_MS,
  );

  it(
    "P3b: the store's admin (app_user) still reads the blocked product",
    async () => {
      await insertBlock(productBlock());
      expect(await asUser(ADMIN, productVisible)).toBe(1);
    },
    CASE_MS,
  );

  it(
    "P3c: a store admin who republishes and clears the flag saves the status, and the product stays blocked",
    async () => {
      await insertBlock(productBlock());
      const row = await asUser(ADMIN, () =>
        one(
          `update public.products
              set status = 'published', moderation_blocked_at = null, name = name
            where id = $1
            returning status, moderation_blocked_at is not null as still_blocked`,
          [productId],
        ),
      );
      expect(row).toEqual({ status: "published", still_blocked: true });
    },
    CASE_MS,
  );

  it(
    "P3d: app_service cannot clear the flag either, and a row inserted already blocked arrives unblocked",
    async () => {
      await insertBlock(productBlock());
      await asService(async () => {
        const cleared = await one(
          `update public.products set moderation_blocked_at = null where id = $1
            returning moderation_blocked_at is not null as still_blocked`,
          [productId],
        );
        expect(cleared?.still_blocked).toBe(true);
        const inserted = await one(
          `insert into public.products
             (name, slug, store_id, moderation_blocked_at, status, base_price, selling_price)
           values ('Probe copy', $1, $2, now(), 'draft', 1, 1)
           returning moderation_blocked_at is null as arrived_unblocked`,
          [`t2-${tag}-probe-copy`, echo.id],
        );
        expect(inserted?.arrived_unblocked).toBe(true);
      });
    },
    CASE_MS,
  );

  it(
    "P3f: a block naming another store's page, or a post that does not exist, is refused",
    async () => {
      const otherStore = await refusedBlock({
        store_id: demo.id,
        store_label: demo.slug,
        item_kind: "page",
        item_id: pageId,
      });
      expect(otherStore?.message).toBe(
        `content_blocks: no page ${pageId} in store ${demo.id} as recorded`,
      );
      const missingId = crypto.randomUUID();
      const missing = await refusedBlock({
        item_kind: "blog_post",
        item_id: missingId,
      });
      expect(missing?.message).toBe(
        `content_blocks: no blog_post ${missingId} in store ${echo.id} as recorded`,
      );
    },
    CASE_MS,
  );

  it(
    "P3h: one live block per item: a second block of the same product is refused",
    async () => {
      await insertBlock(productBlock());
      const second = await refusedBlock(productBlock());
      expect(second).toMatchObject({
        code: "23505",
        constraint: "content_blocks_active_item_key",
      });
    },
    CASE_MS,
  );

  it(
    "P3i, P3j: a block is a record: who blocked it and the words to the store never change, a complaint is linked once and an MD5 filled in once",
    async () => {
      const blockId = await insertBlock(productBlock());
      const fileId = await insertBlock(bucketFile("md5", "pending"));
      const first = await complaintInsert({
        kind: "grievance",
        ack: "24 hours",
        action: "7 days",
        resolve: "7 days",
      });
      await asService(async () => {
        const complaintA = idOf(await one(first.text, first.params));
        const complaintB = idOf(await one(first.text, first.params));
        const by = await refused(
          "update public.content_blocks set blocked_by = 'someone else' where id = $1",
          [blockId],
        );
        expect(by?.message).toMatch(RECORD);
        const words = await refused(
          "update public.content_blocks set store_message = 'A different message' where id = $1",
          [blockId],
        );
        expect(words?.message).toMatch(RECORD);

        const linked = await client.query(
          "update public.content_blocks set complaint_id = $2 where id = $1",
          [blockId, complaintA],
        );
        expect(linked.rowCount).toBe(1);
        const relinked = await refused(
          "update public.content_blocks set complaint_id = $2 where id = $1",
          [blockId, complaintB],
        );
        expect(relinked?.message).toMatch(RECORD);

        const filled = await client.query(
          "update public.content_blocks set object_md5 = 'bWQ1LW9uZQ==' where id = $1",
          [fileId],
        );
        expect(filled.rowCount).toBe(1);
        const changed = await refused(
          "update public.content_blocks set object_md5 = 'bWQ1LXR3bw==' where id = $1",
          [fileId],
        );
        expect(changed?.message).toMatch(RECORD);
      });
    },
    CASE_MS,
  );

  // ---- P4, P15, P9e: reviews and comments --------------------------------

  it(
    "P4w: a review block naming the wrong author is refused",
    async () => {
      const wrong = await refusedBlock(reviewBlock(OTHER_SHOPPER.id));
      expect(wrong?.message).toBe(
        `content_blocks: no review ${reviewId} in store ${echo.id} as recorded`,
      );
    },
    CASE_MS,
  );

  it(
    "P4: a blocked review and a comment removed at the store's request are hidden from everyone but their author",
    async () => {
      await insertBlock(reviewBlock());
      await insertBlock(commentBlock());
      const both = async () =>
        Number(
          (
            await one(
              `select ((select count(*) from public.product_reviews where id = $1)
                     + (select count(*) from public.blog_comments where id = $2))::int as n`,
              [reviewId, commentId],
            )
          )?.n,
        );
      expect(await asUser(ANONYMOUS, both)).toBe(0);
      expect(await asUser(OTHER_SHOPPER, both)).toBe(0);
      expect(await asUser(AUTHOR, both)).toBe(2);
    },
    CASE_MS,
  );

  it(
    "P4c, A10: the author's upsert of a review StoreMink removed is refused, as app_user",
    async () => {
      await insertBlock(reviewBlock());
      const edit = await asUser(AUTHOR, () =>
        refused(
          `insert into public.product_reviews
             (product_id, user_id, author_name, rating, comment, store_id)
           values ($1, $2, 'Priya S', 5, 'Edited', $3)
           on conflict (product_id, user_id)
           do update set comment = excluded.comment, rating = excluded.rating`,
          [productId, AUTHOR.id, echo.id],
        ),
      );
      expect(edit).toMatchObject({
        code: "P0001",
        message: "moderation: review removed by StoreMink",
      });
    },
    CASE_MS,
  );

  it(
    "P15: an author who deletes a removed review and comment cannot post them again, and another shopper still can",
    async () => {
      await insertBlock(reviewBlock());
      await insertBlock(commentBlock());
      await asUser(AUTHOR, async () => {
        const deletedReview = await client.query(
          "delete from public.product_reviews where id = $1",
          [reviewId],
        );
        expect(deletedReview.rowCount).toBe(1);
        const deletedComment = await client.query(
          "delete from public.blog_comments where id = $1",
          [commentId],
        );
        expect(deletedComment.rowCount).toBe(1);
        const reviewAgain = await refused(
          `insert into public.product_reviews
             (product_id, user_id, author_name, rating, comment, store_id)
           values ($1, $2, 'Priya S', 1, 'Probe review', $3)
           on conflict (product_id, user_id)
           do update set comment = excluded.comment, rating = excluded.rating`,
          [productId, AUTHOR.id, echo.id],
        );
        expect(reviewAgain).toMatchObject({
          code: "P0001",
          message: "moderation: review removed by StoreMink",
        });
        const commentAgain = await refused(
          `insert into public.blog_comments (blog_id, user_id, author_name, body, store_id)
           values ($1, $2, 'Priya S', 'Probe comment', $3)`,
          [blogId, AUTHOR.id, echo.id],
        );
        expect(commentAgain).toMatchObject({
          code: "P0001",
          message: "moderation: comment removed by StoreMink",
        });
      });
      await asUser(OTHER_SHOPPER, async () => {
        const review = await client.query(
          `insert into public.product_reviews
             (product_id, user_id, author_name, rating, comment, store_id)
           values ($1, $2, 'Ravi K', 5, 'Fine', $3)`,
          [productId, OTHER_SHOPPER.id, echo.id],
        );
        expect(review.rowCount).toBe(1);
        const comment = await client.query(
          `insert into public.blog_comments (blog_id, user_id, author_name, body, store_id)
           values ($1, $2, 'Ravi K', 'Nice', $3)`,
          [blogId, OTHER_SHOPPER.id, echo.id],
        );
        expect(comment.rowCount).toBe(1);
      });
    },
    CASE_MS,
  );

  it(
    "P9e: a store's own request may remove a review or comment, never a page",
    async () => {
      const page = await refusedBlock({
        item_kind: "page",
        item_id: pageId,
        reason_kind: "store_request",
      });
      expect(page?.constraint).toBe("content_blocks_store_request_check");
    },
    CASE_MS,
  );

  // ---- P5, P13: lifting --------------------------------------------------

  it(
    "P5, P13: lifting a block as app_service clears the flag, and the product is public again",
    async () => {
      const blockId = await insertBlock(productBlock());
      await asService(() =>
        client.query(
          `update public.content_blocks
              set lifted_at = now(), lifted_by = $2, lift_note = 'Complaint withdrawn'
            where id = $1`,
          [blockId, SUPERADMIN],
        ),
      );
      const flag = await one(
        "select moderation_blocked_at is null as cleared from public.products where id = $1",
        [productId],
      );
      expect(flag?.cleared).toBe(true);
      expect(await asUser(ANONYMOUS, productVisible)).toBe(1);
    },
    CASE_MS,
  );

  it(
    "P5b: a lift is never undone",
    async () => {
      const blockId = await insertBlock(productBlock());
      await asService(async () => {
        await client.query(
          "update public.content_blocks set lifted_at = now(), lifted_by = $2 where id = $1",
          [blockId, SUPERADMIN],
        );
        const undo = await refused(
          "update public.content_blocks set lifted_at = null, lifted_by = null where id = $1",
          [blockId],
        );
        expect(undo?.message).toMatch(RECORD);
      });
    },
    CASE_MS,
  );

  // ---- P6, P6d: the archive ----------------------------------------------

  it(
    "P6: an archive is write-once: bookkeeping may change, its snapshot and copied files may not, it is purged only when due, and it is only ever kept longer",
    async () => {
      const blockId = await insertBlock(bucketFile("archive", "pending"));
      await asService(async () => {
        const archiveId = idOf(
          await one(
            `insert into public.content_block_archives
               (block_id, store_id, snapshot, snapshot_sha256, files_state, keep_until)
             values ($1, $2, '{"kind":"product"}', repeat('a', 64), 'pending',
                     now() + interval '180 days')
             returning id`,
            [blockId, echo.id],
          ),
        );
        const claimed = await client.query(
          `update public.content_block_archives
              set files_claimed_at = now(), files_attempts = files_attempts + 1
            where id = $1`,
          [archiveId],
        );
        expect(claimed.rowCount).toBe(1);
        const copied = await one(
          `update public.content_block_archives
              set files = $2::jsonb, files_state = 'copied', files_claimed_at = null
            where id = $1
            returning files_state`,
          [
            archiveId,
            JSON.stringify([
              { path: `takedown-archive/storemink_local/${blockId}/1.webp` },
            ]),
          ],
        );
        expect(copied?.files_state).toBe("copied");

        const snapshot = await refused(
          `update public.content_block_archives set snapshot = '{"kind":"changed"}'
            where id = $1`,
          [archiveId],
        );
        expect(snapshot?.message).toMatch(PRESERVED);
        const files = await refused(
          "update public.content_block_archives set files = '[]' where id = $1",
          [archiveId],
        );
        expect(files?.message).toMatch(PRESERVED);
        const state = await refused(
          "update public.content_block_archives set files_state = 'pending' where id = $1",
          [archiveId],
        );
        expect(state?.message).toMatch(PRESERVED);
        const early = await refused(PURGE_ARCHIVE, [archiveId]);
        expect(early?.message).toMatch(NOT_DUE);
        const shorter = await refused(
          `update public.content_block_archives
              set keep_until = keep_until - interval '1 day' where id = $1`,
          [archiveId],
        );
        expect(shorter?.message).toMatch(PRESERVED);
        const longer = await one(
          `update public.content_block_archives
              set keep_until = keep_until + interval '365 days' where id = $1
            returning (keep_until - created_at)::text as kept_for`,
          [archiveId],
        );
        expect(longer?.kept_for).toBe("545 days");
      });
    },
    CASE_MS,
  );

  it(
    "P6d: a due archive is purged only while it is not held, keeps its hash, and is never deleted",
    async () => {
      const blockId = await insertBlock(bucketFile("due", "replaced"));
      const archiveId = idOf(
        await asService(() =>
          one(
            `insert into public.content_block_archives
               (block_id, store_id, snapshot, snapshot_sha256, created_at, keep_until)
             values ($1, $2, '{"kind":"file"}', repeat('b', 64),
                     now() - interval '200 days', now() - interval '20 days')
             returning id`,
            [blockId, echo.id],
          ),
        ),
      );
      await asService(async () => {
        await client.query("SAVEPOINT t2_held");
        await client.query(
          `update public.content_block_archives
              set legal_hold = true, legal_hold_set_at = now(), legal_hold_set_by = $2
            where id = $1`,
          [archiveId, SUPERADMIN],
        );
        const held = await refused(PURGE_ARCHIVE, [archiveId]);
        await client.query("ROLLBACK TO SAVEPOINT t2_held");
        await client.query("RELEASE SAVEPOINT t2_held");
        expect(held?.message).toMatch(NOT_DUE);

        const purged = await one(
          `${PURGE_ARCHIVE} returning purged_at is not null as purged, snapshot_sha256`,
          [archiveId],
        );
        expect(purged).toEqual({
          purged: true,
          snapshot_sha256: "b".repeat(64),
        });
        const serviceDelete = await refused(
          "delete from public.content_block_archives where id = $1",
          [archiveId],
        );
        expect(serviceDelete?.code).toBe("42501");
      });
      const ownerDelete = await refused(
        "delete from public.content_block_archives where id = $1",
        [archiveId],
      );
      expect(ownerDelete?.message).toBe(
        `content_block_archives: ${archiveId} is kept; the purge empties it instead`,
      );
    },
    CASE_MS,
  );

  // ---- P17: lifting a file block -----------------------------------------

  it(
    "P17: a lift must cancel a pending replacement or start the restore of a replaced file, in the same statement",
    async () => {
      const pending = await insertBlock({
        ...bucketFile("pending", "pending"),
        storage_next_attempt_at: new Date(Date.now() + 35_000).toISOString(),
      });
      const replaced = await insertBlock(bucketFile("replaced", "replaced"));
      const lift = `update public.content_blocks
         set lifted_at = now(), lifted_by = $2 where id = $1`;
      await asService(async () => {
        const leftPending = await refused(lift, [pending, SUPERADMIN]);
        expect(leftPending?.constraint).toBe(
          "content_blocks_storage_lift_check",
        );
        const cancelled = await one(
          `update public.content_blocks
              set lifted_at = now(), lifted_by = $2, storage_state = 'cancelled'
            where id = $1
            returning storage_state`,
          [pending, SUPERADMIN],
        );
        expect(cancelled?.storage_state).toBe("cancelled");
        const leftReplaced = await refused(lift, [replaced, SUPERADMIN]);
        expect(leftReplaced?.constraint).toBe(
          "content_blocks_storage_lift_check",
        );
        const restoring = await one(
          `update public.content_blocks
              set lifted_at = now(), lifted_by = $2, storage_state = 'restoring'
            where id = $1
            returning storage_state`,
          [replaced, SUPERADMIN],
        );
        expect(restoring?.storage_state).toBe("restoring");
      });
    },
    CASE_MS,
  );

  // ---- P9, P18: the CHECKs -----------------------------------------------

  it(
    "P9a to P9d: the CHECKs refuse a block with no row, a file with no path or no source, a bucket file named by a full address, and an archive kept under 180 days",
    async () => {
      const noRow = await refusedBlock({
        store_id: null,
        store_label: "x",
        item_kind: "product",
      });
      expect(noRow?.constraint).toBe("content_blocks_target_check");
      const noPath = await refusedBlock({
        store_id: null,
        store_label: "x",
        item_kind: "file",
        storage_state: "pending",
      });
      expect(noPath?.constraint).toBe("content_blocks_storage_kind_check");
      const noSource = await refusedBlock({
        store_id: null,
        store_label: "x",
        item_kind: "file",
        object_path: "stores/x/a.webp",
        storage_state: "pending",
      });
      expect(noSource?.constraint).toBe("content_blocks_storage_kind_check");
      const fullAddress = await refusedBlock({
        store_id: null,
        store_label: "x",
        item_kind: "file",
        object_path: "https://storage.googleapis.com/b/stores/x/a.webp",
        file_source: "bucket",
        storage_state: "pending",
      });
      expect(fullAddress?.constraint).toBe("content_blocks_target_check");

      const blockId = await insertBlock(bucketFile("short", "pending"));
      const short = await asService(() =>
        refused(
          `insert into public.content_block_archives
             (block_id, snapshot, snapshot_sha256, keep_until)
           values ($1, '{"kind":"file"}', repeat('c', 64), now() + interval '179 days')`,
          [blockId],
        ),
      );
      expect(short?.constraint).toBe("content_block_archives_keep_check");
    },
    CASE_MS,
  );

  it(
    "P9f, P18: a block is kept from the store only on an order with its reference, may be told later but never untold, and is erased only after its lift, once",
    async () => {
      const quiet = await refusedBlock({
        ...bucketFile("quiet", "pending"),
        tell_store: false,
      });
      expect(quiet?.constraint).toBe("content_blocks_tell_check");
      const secret = await insertBlock({
        ...bucketFile("order", "pending"),
        reason_kind: "court_order",
        legal_basis: "Order 12/2026, Court of the CJM Faridkot",
        tell_store: false,
      });
      const lifted = await insertBlock(outsideFile("lifted"));
      await asService(async () => {
        const told = await one(
          "update public.content_blocks set tell_store = true where id = $1 returning tell_store",
          [secret],
        );
        expect(told?.tell_store).toBe(true);
        const untold = await refused(
          "update public.content_blocks set tell_store = false where id = $1",
          [secret],
        );
        expect(untold?.message).toMatch(RECORD);
        const live = await refused(ERASE_BLOCK, [secret]);
        expect(live?.constraint).toBe("content_blocks_erased_check");

        await client.query(
          "update public.content_blocks set lifted_at = now(), lifted_by = $2 where id = $1",
          [lifted, SUPERADMIN],
        );
        const erased = await one(`${ERASE_BLOCK} returning item_label`, [
          lifted,
        ]);
        expect(erased?.item_label).toBe("Erased");
        const unerased = await refused(
          "update public.content_blocks set erased_at = null where id = $1",
          [lifted],
        );
        expect(unerased?.message).toMatch(RECORD);
      });
    },
    CASE_MS,
  );

  it(
    "P9g, P9h: the removed legacy file source is refused, by the storage CHECK first and by the target CHECK without it; outside and bundled files are accepted, and a bundled path with .. is refused",
    async () => {
      const { text, params } = blockInsert({
        item_kind: "file",
        object_path: `https://cdn.example.com/t2-${tag}-old.jpg`,
        file_source: "legacy",
        item_label: "old.jpg",
        storage_state: "manual",
      });
      const first = await refused(text, params);
      expect(first?.constraint).toBe("content_blocks_storage_kind_check");
      await client.query("SAVEPOINT t2_p9g");
      try {
        await client.query(
          "alter table public.content_blocks drop constraint content_blocks_storage_kind_check",
        );
        const second = await refused(text, params);
        expect(second?.constraint).toBe("content_blocks_target_check");
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT t2_p9g");
        await client.query("RELEASE SAVEPOINT t2_p9g");
      }
      const back = await one(
        `select count(*)::int as n from pg_constraint
          where conrelid = 'public.content_blocks'::regclass
            and conname = 'content_blocks_storage_kind_check'`,
      );
      expect(back?.n).toBe(1);

      const outside = await insertBlock(outsideFile("outside"));
      const bundled = await insertBlock({
        item_kind: "file",
        object_path: `/themes/basket/t2-${tag}-hero.webp`,
        file_source: "bundled",
        item_label: "hero.webp",
        reason_kind: "other_removal",
        storage_state: "manual",
      });
      const accepted = await rows(
        `select file_source, storage_state from public.content_blocks
          where id = any($1::uuid[]) order by file_source`,
        [[outside, bundled]],
      );
      expect(accepted).toEqual([
        { file_source: "bundled", storage_state: "manual" },
        { file_source: "external", storage_state: "not_ours" },
      ]);
      const dotDot = await refusedBlock({
        item_kind: "file",
        object_path: "/themes/../secret.webp",
        file_source: "bundled",
        item_label: "secret.webp",
        storage_state: "manual",
      });
      expect(dotDot?.constraint).toBe("content_blocks_target_check");
    },
    CASE_MS,
  );

  // ---- P16, P7: whole stores ---------------------------------------------

  it(
    "P16: a whole-store block suspends the store, nothing but its lift reactivates it, and the lift restores the status",
    async () => {
      expect(await storeStatus(demo.id)).toBe("active");
      const wrong = await refusedBlock(storeBlock("pending"));
      expect(wrong?.message).toBe(
        `content_blocks: no store ${demo.id} in store ${demo.id} as recorded`,
      );
      const blockId = await insertBlock(storeBlock("active"));
      expect(await storeStatus(demo.id)).toBe("suspended");

      const reactivate =
        "update public.stores set status = 'active' where id = $1";
      const suspended = `stores: ${demo.id} is suspended by a StoreMink block; lift the block instead`;
      const byService = await asService(() => refused(reactivate, [demo.id]));
      expect(byService?.message).toBe(suspended);
      const byOwner = await refused(reactivate, [demo.id]);
      expect(byOwner?.message).toBe(suspended);

      await asService(() =>
        client.query(
          `update public.content_blocks
              set lifted_at = now(), lifted_by = $2, lift_note = 'Store fixed it'
            where id = $1`,
          [blockId, SUPERADMIN],
        ),
      );
      expect(await storeStatus(demo.id)).toBe("active");
    },
    CASE_MS,
  );

  it("P7: a held store, or one whose archive is unfinished, cannot be deleted by any path; then it is, and its complaints, blocks, archives and holds stay with their store cleared", async () => {
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const deleteStore = "delete from public.stores where id = $1";
    const { holdId, complaintId } = await asService(async () => {
      const hold = await one(
        `insert into public.store_legal_holds (store_id, store_label, reason, set_by)
           values ($1, $2, 'Police letter 12/2026', $3)
           returning id`,
        [demo.id, demo.slug, OPERATOR],
      );
      const complaint = complaintInsert({
        kind: "grievance",
        ack: "24 hours",
        action: "7 days",
        resolve: "7 days",
        storeId: demo.id,
      });
      return {
        holdId: idOf(hold),
        complaintId: idOf(await one(complaint.text, complaint.params)),
      };
    });

    const heldByService = await asService(() =>
      refused(deleteStore, [demo.id]),
    );
    expect(heldByService?.message).toBe(
      `stores: ${demo.id} is on hold for an investigation and cannot be deleted`,
    );
    const heldByOwner = await refused(deleteStore, [demo.id]);
    expect(heldByOwner?.message).toBe(heldByService?.message);

    await asService(() =>
      client.query(
        `update public.store_legal_holds set released_at = now(), released_by = $2
            where id = $1`,
        [holdId, OPERATOR],
      ),
    );
    const blockId = await insertBlock({
      store_id: demo.id,
      store_label: demo.slug,
      item_kind: "file",
      object_path: `stores/${demo.id}/media/t2-${tag}-p7.webp`,
      file_source: "bucket",
      item_label: "p7.webp",
      storage_state: "pending",
    });
    const archiveId = idOf(
      await asService(() =>
        one(
          `insert into public.content_block_archives
               (block_id, store_id, snapshot, snapshot_sha256, files_state, keep_until)
             values ($1, $2, '{"kind":"file"}', repeat('d', 64), 'pending',
                     now() + interval '180 days')
             returning id`,
          [blockId, demo.id],
        ),
      ),
    );
    const unfinishedByService = await asService(() =>
      refused(deleteStore, [demo.id]),
    );
    expect(unfinishedByService?.message).toBe(
      `stores: ${demo.id} has a StoreMink archive whose files are not copied yet`,
    );
    const unfinished = await refused(deleteStore, [demo.id]);
    expect(unfinished?.message).toBe(unfinishedByService?.message);

    await asService(() =>
      client.query(
        `update public.content_block_archives
              set files = $2::jsonb, files_state = 'copied'
            where id = $1`,
        [
          archiveId,
          JSON.stringify([
            { path: `takedown-archive/storemink_local/${blockId}/1-p7.webp` },
          ]),
        ],
      ),
    );
    const deleted = await client.query(deleteStore, [demo.id]);
    expect(deleted.rowCount).toBe(1);

    const kept = await one(
      `select
           (select store_id is null from public.store_legal_holds where id = $1) as hold,
           (select store_id is null from public.grievance_complaints where id = $2) as complaint,
           (select store_id is null from public.content_blocks where id = $3) as block,
           (select store_id is null from public.content_block_archives where id = $4) as archive`,
      [holdId, complaintId, blockId, archiveId],
    );
    expect(kept).toEqual({
      hold: true,
      complaint: true,
      block: true,
      archive: true,
    });
  }, 120_000);

  // ---- P8, P10, P12: grants ----------------------------------------------

  it(
    "P8: app_user reads none of the moderation tables, and app_service can never delete or rewrite the record or delete an archive",
    async () => {
      for (const who of [ANONYMOUS, ADMIN]) {
        await asUser(who, async () => {
          for (const table of MODERATION_TABLES) {
            const read = await refused(`select count(*) from public.${table}`);
            expect(read?.code, `${table} as ${who?.id ?? "anonymous"}`).toBe(
              "42501",
            );
          }
        });
      }
      await asService(async () => {
        const eventId = idOf(
          await one(
            `insert into public.moderation_events (actor, action, store_id)
             values ($1, 'block_created', $2) returning id`,
            [OPERATOR, echo.id],
          ),
        );
        const deleted = await refused(
          "delete from public.moderation_events where id = $1",
          [eventId],
        );
        expect(deleted?.code).toBe("42501");
        const rewritten = await refused(
          "update public.moderation_events set actor = actor where id = $1",
          [eventId],
        );
        expect(rewritten?.code).toBe("42501");
        const archive = await refused(
          "delete from public.content_block_archives where id = $1",
          [crypto.randomUUID()],
        );
        expect(archive?.code).toBe("42501");
      });
    },
    CASE_MS,
  );

  it(
    "P10: the prune keeps the record at least a year, never deletes a held store's events, and is closed to app_user",
    async () => {
      const tooRecent = await asService(() =>
        refused(
          "select public.moderation_prune_events(now() - interval '30 days', 100)",
        ),
      );
      expect(tooRecent?.message).toBe(
        "moderation_prune_events: the record is kept at least 1 year",
      );
      const shopper = await asUser(ANONYMOUS, () =>
        refused(
          "select public.moderation_prune_events(now() - interval '3 years', 100)",
        ),
      );
      expect(shopper?.code).toBe("42501");

      await client.query(
        `insert into public.store_legal_holds (store_id, store_label, reason, set_by)
         values ($1, $2, 'Police letter 12/2026', $3)`,
        [demo.id, demo.slug, OPERATOR],
      );
      const inserted = await rows(
        `insert into public.moderation_events (at, actor, action, store_id) values
           (now() - interval '4 years', $1, 'complaint_logged', $2),
           (now() - interval '1 day', $1, 'complaint_logged', $2),
           (now() - interval '4 years', $1, 'complaint_logged', $3)
         returning id`,
        [OPERATOR, echo.id, demo.id],
      );
      const [oldId, recentId, heldId] = inserted.map((row) => String(row.id));
      const due = await one(
        `select count(*)::int as n from public.moderation_events e
          where e.at < now() - interval '3 years'
            and not exists (select 1 from public.store_legal_holds h
                             where h.store_id = e.store_id and h.released_at is null)
            and not exists (select 1 from public.content_block_archives a
                             where a.block_id = e.block_id
                               and (a.legal_hold or a.purged_at is null))`,
      );
      expect(Number(due?.n)).toBeGreaterThanOrEqual(1);
      const pruned = await asService(() =>
        one(
          "select public.moderation_prune_events(now() - interval '3 years', 1000) as pruned",
        ),
      );
      expect(pruned?.pruned).toBe(due?.n);
      const left = await rows(
        "select id from public.moderation_events where id = any($1::uuid[]) order by id",
        [[oldId, recentId, heldId]],
      );
      expect(left.map((row) => String(row.id))).toEqual(
        [recentId, heldId].sort(),
      );
    },
    CASE_MS,
  );

  it(
    "P12: neither app role may run a trigger function, yet the flag guard still keeps a store admin (app_user) from clearing the flag",
    async () => {
      const grants = await rows(
        `select f as fn,
                has_function_privilege('app_user', 'public.' || f, 'EXECUTE') as app_user,
                has_function_privilege('app_service', 'public.' || f, 'EXECUTE') as app_service
           from unnest($1::text[]) f`,
        [TRIGGER_FUNCTIONS],
      );
      expect(grants).toHaveLength(TRIGGER_FUNCTIONS.length);
      expect(grants.filter((g) => g.app_user || g.app_service)).toEqual([]);
      const prune = await one(
        `select has_function_privilege('app_service', $1, 'EXECUTE') as app_service,
                has_function_privilege('app_user', $1, 'EXECUTE') as app_user`,
        [PRUNE_FUNCTION],
      );
      expect(prune).toEqual({ app_service: true, app_user: false });

      await insertBlock(productBlock());
      const kept = await asUser(ADMIN, () =>
        one(
          `update public.products set moderation_blocked_at = null where id = $1
            returning moderation_blocked_at is not null as still_blocked`,
          [productId],
        ),
      );
      expect(kept?.still_blocked).toBe(true);
    },
    CASE_MS,
  );

  // ---- P11, P14: what fires, and what an anonymous read filters on -------

  it(
    "P11: a stock write, a flag write that changes nothing and a store write fire no moderation trigger; a review insert fires the author guard once",
    async () => {
      const product = literal(productId);
      const stock = await triggersFired(
        `update public.products set stock = stock where id = ${product}`,
      );
      expect(named(stock, "moderation")).toEqual([]);
      const sameFlag = await triggersFired(
        `update public.products set moderation_blocked_at = moderation_blocked_at
          where id = ${product}`,
      );
      expect(named(sameFlag, "moderation")).toEqual([]);
      const review = await triggersFired(
        `insert into public.product_reviews
           (product_id, user_id, author_name, rating, comment, store_id)
         values (${product}, ${literal(OTHER_SHOPPER.id)}, 'Ravi K', 5, 'Fine',
                 ${literal(echo.id)})`,
      );
      expect(named(review, "moderation")).toEqual([
        ["product_reviews_moderation_author_guard", 1],
      ]);
      const storeName = await triggersFired(
        `update public.stores set name = name where id = ${literal(echo.id)}`,
      );
      const storeStatusWrite = await triggersFired(
        `update public.stores set status = status where id = ${literal(echo.id)}`,
      );
      expect([
        ...named(storeName, "stores_keep"),
        ...named(storeStatusWrite, "stores_keep"),
      ]).toEqual([]);
    },
    CASE_MS,
  );

  it(
    "P14: an anonymous catalogue read filters on the flag",
    async () => {
      const plan = await asUser(ANONYMOUS, () =>
        rows(
          `explain (costs off) select id from public.products
            where store_id = ${literal(echo.id)} and status = 'published'`,
        ),
      );
      const lines = plan.map((row) => String(row["QUERY PLAN"]));
      expect(
        lines.some((line) => line.includes("moderation_blocked_at IS NULL")),
      ).toBe(true);
    },
    CASE_MS,
  );
});
