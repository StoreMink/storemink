/** Rollback-only checks, against local Postgres, of migration 0262 (private
 * Mink AI chat attachments, lib/mink/attachments.ts): the CHECKs and foreign
 * keys of mink_attachments and mink_attachment_legacy_log, their service-only
 * posture, the replaced History search function (the same text as 0249's
 * body for every stored message, the new marker stripped) and the plans of
 * the four queries the attachments code runs. Run with
 * MINK_ATTACHMENTS_LOCAL_TEST=1; the fixed loopback database keeps it away
 * from Cloud SQL, and everything happens inside one transaction that is
 * rolled back. Built like conversation-retention.local.test.ts.
 *
 * ★ The schema half (build stage S1), the code half for the link at send,
 *   the viewer read and the purge (stage S3), and the legacy move (stage S6,
 *   lib/mink/attachments-legacy.ts, run with DB_NAME stubbed to
 *   storemink_staging so its database guard passes while the connection
 *   stays this one). The code half runs the real functions of
 *   lib/mink/attachments.ts over this one transaction: `withService` is
 *   mocked onto this client (a savepoint per scope, as app_service, the
 *   shape of conversation-retention.local.test.ts) and the private bucket
 *   is a recorder, so nothing reaches storage.
 * ★ Every probe of a table runs as `app_service`, the role `withService`
 *   takes in production, so a write that role may not make fails here too.
 * ★ Inside one transaction `now()` is frozen at its start: the fixtures set
 *   every timestamp by hand.
 * ★ The takedown half (stage T6c, migration 0269 applied): a store under a
 *   legal hold keeps its marked pictures until the hold is released, and
 *   blocked bytes are refused at the save, the Library copy and the inline
 *   read through the real re-upload guard (lib/moderation/upload-guard.ts,
 *   blocked-objects.ts and lib/storage/store-objects.ts over this
 *   transaction), each recording one `reupload_refused`. */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import sharp from "sharp";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
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
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { withService, type Db } from "@/lib/db/client";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import { forgetBlockedObjects } from "@/lib/moderation/blocked-objects";
import { attachmentRefusal as attachmentSentence } from "@/lib/moderation/copy";
import { gcsPrivateUploadObject, gcsUploadObject } from "@/lib/storage/gcs";
import { processImageUpload } from "@/lib/storage/process-image";
import {
  linkMinkAttachmentsSql,
  markUnsentMinkAttachmentsSql,
  md5Base64,
  minkAttachmentCopyPathPrefix,
  minkAttachmentsForUseSql,
  promoteMinkAttachmentRefs,
  purgeCandidatesSql,
  purgeMinkAttachments,
  purgeStoreMinkAttachments,
  readMinkAttachmentForViewer,
  readMinkAttachmentReferences,
  saveMinkAttachment,
} from "./attachments";
import { MinkToolInputError } from "./errors";
import type { MinkActorContext } from "./types";
import {
  legacyCandidatesSql,
  legacyLiveProposalSql,
  legacyLogSql,
  legacyProgressSql,
  legacyStoreUsageSql,
  moveLegacyMinkAttachments,
} from "./attachments-legacy";
import { retireMinkConversation } from "./conversation-retire";
import { MINK_CSV_MARKER } from "./csv-input";
import { REVIEWED_DOCUMENT_MARKER } from "./document-input";
import { MINK_ATTACHMENT_MARKER, SAVED_MEDIA_MARKER } from "./media-attachment";

/**
 * `withService` onto this file's one client: a savepoint per scope, run as
 * `app_service`, scopes one at a time. The code under test opens its scopes
 * one after another, so a nested scope would deadlock on `service.pending`,
 * which is the point (lib/db/nested-scope-coverage.test.ts).
 */
const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  pending: Promise.resolve(),
}));
vi.mock("@/lib/db/client", () => ({
  async withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const previous = service.pending;
    let release!: () => void;
    service.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `attachments_scope_${++service.count}`;
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
  },
}));

/**
 * Both buckets as a recorder: every path asked for (`deleted`, and
 * `deletes` with the bucket), those that refuse (`fail`), the objects that
 * exist (`objects`, by `kind:path`), and the copies made. The three switches
 * make a copy fail, come back changed, or a read throw.
 */
const storage = vi.hoisted(() => ({
  deleted: [] as string[],
  deletes: [] as { kind: string; path: string }[],
  fail: new Set<string>(),
  objects: new Map<
    string,
    { size: number; contentType: string; md5: string | null }
  >(),
  copies: [] as string[],
  copyFail: false,
  corruptCopy: false,
  readFail: false,
  /** The bytes a download answers, by `kind:path` (the takedown cases). */
  bytes: new Map<string, Uint8Array>(),
  /** The public writes made, by path. */
  uploads: [] as string[],
}));
vi.mock("@/lib/storage/gcs", () => ({
  // The bucket the blocked-object set reads public addresses against.
  GCS_BUCKET_NAME: "storemink-local-test",
  DEFAULT_PUBLIC_CACHE_CONTROL: "public, max-age=60",
  gcsPublicUrl: vi.fn(
    (path: string) =>
      `https://storage.googleapis.com/storemink-local-test/${path}`,
  ),
  gcsUploadObject: vi.fn(async (path: string) => {
    storage.uploads.push(path);
    return `https://storage.googleapis.com/storemink-local-test/${path}`;
  }),
  gcsDownloadObject: vi.fn(
    async (path: string, _max: number, kind = "public") => {
      const found = storage.bytes.get(`${kind}:${path}`);
      if (!found) {
        throw Object.assign(new Error("No such object"), { code: 404 });
      }
      return found;
    },
  ),
  gcsPrivateConfigured: true,
  gcsPrivateUploadObject: vi.fn(async () => undefined),
  gcsDeletePaths: vi.fn(async (paths: string[], kind = "public") => {
    storage.deleted.push(...paths);
    for (const path of paths) {
      storage.deletes.push({ kind, path });
      if (!storage.fail.has(path)) storage.objects.delete(`${kind}:${path}`);
    }
    return paths.filter((path) => storage.fail.has(path));
  }),
  gcsObjectMetadata: vi.fn(async (kind: string, path: string) => {
    if (storage.readFail) throw new Error("metadata unavailable");
    return storage.objects.get(`${kind}:${path}`) ?? null;
  }),
  gcsCopyObject: vi.fn(
    async (
      fromKind: string,
      fromPath: string,
      toKind: string,
      toPath: string,
    ) => {
      if (storage.copyFail) throw new Error("copy refused");
      const source = storage.objects.get(`${fromKind}:${fromPath}`);
      if (!source) throw new Error("source missing");
      storage.copies.push(toPath);
      storage.objects.set(
        `${toKind}:${toPath}`,
        storage.corruptCopy
          ? { ...source, size: source.size + 1 }
          : { ...source },
      );
    },
  ),
}));

const MIGRATION = "20261028_0262_mink_attachments_private";
const SEARCH_MIGRATION_FILE =
  "drizzle/migrations/sql/20261026_0249_mink_chat_history_search_index.sql";
/** The composer's marker (design 3.3, lib/mink/media-attachment.ts), which 0262 strips. */
const ATTACHMENT_MARKER = MINK_ATTACHMENT_MARKER;
const ADMIN = "attachments-owner";
const OTHER_ADMIN = "attachments-staff";
const HASH = "c".repeat(64);
const DAY_MS = 86_400_000;
/**
 * What lib/mink/attachments.ts attachmentDatabase() answers here: DB_NAME is
 * pinned to it in beforeAll (vitest loads no .env), so the fixtures' paths are
 * this database's own and the purge asks the bucket for them.
 */
const DATABASE = "storemink_local";
const FIVE_MB = 5 * 1024 * 1024;

const enabled = process.env.MINK_ATTACHMENTS_LOCAL_TEST === "1";
describe.skipIf(!enabled)(
  "Mink AI chat attachments, migration 0262 on local Postgres",
  () => {
    let client: Client;
    let storeId: string;
    let otherStoreId: string;

    beforeAll(async () => {
      vi.stubEnv("DB_NAME", DATABASE);
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
      // ★ The migration's DDL may run inside this transaction: a lock another
      //   session holds fails it within 5 s instead of hanging every case.
      await client.query("SET LOCAL lock_timeout = '5s'");
      service.client = client;
      service.db = drizzle(client, { schema: { ...schema, ...relations } });
      const manifest = JSON.parse(
        readFileSync("drizzle/migrations/manifest.json", "utf8"),
      );
      const applied = new Set(
        (
          await client.query("select id from public.schema_migrations")
        ).rows.map((row) => row.id),
      );
      if (!applied.has(MIGRATION)) {
        const migration = manifest.migrations.find(
          (entry: { id: string }) => entry.id === MIGRATION,
        );
        await client.query(
          readFileSync(`drizzle/migrations/${migration.file}`, "utf8"),
        );
      }
    }, 30_000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      if (client) {
        await client.query("ROLLBACK");
        await client.end();
      }
    });

    beforeEach(async () => {
      await client.query("SAVEPOINT attachments_fixture");
      storeId = crypto.randomUUID();
      otherStoreId = crypto.randomUUID();
      for (const id of [storeId, otherStoreId]) {
        await client.query(
          "insert into stores(id,slug,name,status,plan,settings) values($1,$2,'Lumen','active','pro',$3)",
          [id, `attachments-${id}`, { brand: { name: "Lumen" } }],
        );
      }
    });

    afterEach(async () => {
      // The rollback first: it also clears a transaction a failed probe left
      // aborted, and reverts a role set after the savepoint.
      await client.query("ROLLBACK TO SAVEPOINT attachments_fixture");
      await client.query("RELEASE SAVEPOINT attachments_fixture");
      await client.query("RESET ROLE");
    });

    // -------------------------------------------------------------------------
    // Fixtures and probes.
    // -------------------------------------------------------------------------

    /** Runs `fn` as the service role, the one every attachments write uses. */
    async function asService<T>(fn: () => Promise<T>): Promise<T> {
      await client.query("SET ROLE app_service");
      try {
        return await fn();
      } finally {
        await client.query("RESET ROLE");
      }
    }

    /**
     * Runs one statement in its own savepoint and answers the database's
     * refusal, or "" when it went through. A refused statement would
     * otherwise abort the whole transaction.
     */
    async function refusal(text: string, values: unknown[]): Promise<string> {
      await client.query("SAVEPOINT probe");
      try {
        await client.query(text, values);
        return "";
      } catch (error) {
        return (error as Error).message;
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT probe");
        await client.query("RELEASE SAVEPOINT probe");
      }
    }

    function attachmentPath(
      store: string,
      id: string,
      ext = "webp",
      database = DATABASE,
    ): string {
      return `stores/${store}/mink-attachments/${database}/${id}.${ext}`;
    }

    interface AttachmentRow {
      id?: string;
      storeId?: string;
      adminId?: string;
      conversationId?: string | null;
      linkedAt?: string | null;
      path?: string;
      filename?: string;
      contentType?: string | null;
      sizeBytes?: number;
      discardRequestedAt?: string | null;
    }

    const INSERT_ATTACHMENT = `insert into mink_attachments(id,store_id,admin_id,conversation_id,linked_at,path,filename,content_type,size_bytes,discard_requested_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;

    function attachmentValues(row: AttachmentRow): unknown[] {
      const id = row.id ?? crypto.randomUUID();
      const store = row.storeId ?? storeId;
      return [
        id,
        store,
        row.adminId ?? ADMIN,
        row.conversationId ?? null,
        row.linkedAt ?? null,
        row.path ?? attachmentPath(store, id),
        row.filename ?? "photo.png",
        row.contentType === undefined ? "image/webp" : row.contentType,
        row.sizeBytes ?? 120_000,
        row.discardRequestedAt ?? null,
      ];
    }

    /** Inserts a row as app_service and returns its id. */
    async function insertAttachment(row: AttachmentRow = {}): Promise<string> {
      const values = attachmentValues(row);
      await asService(() => client.query(INSERT_ATTACHMENT, values));
      return values[0] as string;
    }

    /** The refusal an insert as app_service gets, "" when it went through. */
    async function attachmentRefusal(row: AttachmentRow): Promise<string> {
      return asService(() => refusal(INSERT_ATTACHMENT, attachmentValues(row)));
    }

    async function chat(store = storeId, admin = ADMIN): Promise<string> {
      const { rows } = await client.query(
        "insert into mink_conversations(store_id,admin_id,title) values($1,$2,'Chat') returning id",
        [store, admin],
      );
      return rows[0].id as string;
    }

    async function run(conversationId: string): Promise<string> {
      const { rows } = await client.query(
        `insert into mink_runs(store_id,conversation_id,requested_by,request_id,model,status,completed_at)
         values($1,$2,$3,gen_random_uuid(),'fixture','succeeded',now()) returning id`,
        [storeId, conversationId, ADMIN],
      );
      return rows[0].id as string;
    }

    async function message(
      conversationId: string,
      runId: string,
      role: "user" | "assistant",
      text: string,
    ): Promise<string> {
      const { rows } = await client.query(
        `insert into mink_messages(store_id,conversation_id,run_id,role,content_json)
         values($1,$2,$3,$4,$5) returning id`,
        [storeId, conversationId, runId, role, { text }],
      );
      return rows[0].id as string;
    }

    async function count(
      text: string,
      values: unknown[] = [],
    ): Promise<number> {
      const { rows } = await client.query(text, values);
      return Number(rows[0].count);
    }

    async function plan(text: string): Promise<string> {
      const { rows } = await client.query(`explain (costs off) ${text}`);
      return rows.map((row) => row["QUERY PLAN"] as string).join("\n");
    }

    /**
     * The plan of a statement the code really sends (review C4: the plans
     * are pinned on the builders' own SQL, so a predicate the code adds or
     * drops changes what is planned here too). EXPLAIN takes the bound
     * parameters through the extended protocol.
     */
    async function planOf(query: SQL): Promise<string> {
      const compiled = new PgDialect().sqlToQuery(query);
      const { rows } = await client.query({
        text: `explain (costs off) ${compiled.sql}`,
        values: compiled.params as unknown[],
      });
      return rows.map((row) => row["QUERY PLAN"] as string).join("\n");
    }

    // -------------------------------------------------------------------------
    // mink_attachments
    // -------------------------------------------------------------------------

    describe("mink_attachments: the CHECKs and foreign keys, as app_service", () => {
      it("a valid row inserts before its object, in each of the five processed types", async () => {
        const types: [string, string][] = [
          ["image/webp", "webp"],
          ["image/png", "png"],
          ["image/jpeg", "jpg"],
          ["image/gif", "gif"],
          ["image/avif", "avif"],
        ];
        for (const [contentType, ext] of types) {
          const id = crypto.randomUUID();
          await insertAttachment({
            id,
            contentType,
            path: attachmentPath(storeId, id, ext),
          });
        }
        expect(
          await count(
            "select count(*) from mink_attachments where store_id = $1 and conversation_id is null and discard_requested_at is null",
            [storeId],
          ),
        ).toBe(5);
      });

      it("refuses a path that names another store", async () => {
        const id = crypto.randomUUID();
        expect(
          await attachmentRefusal({
            id,
            path: attachmentPath(otherStoreId, id),
          }),
        ).toContain("mink_attachments_path_check");
      });

      it("refuses a path whose file is not the row's own id", async () => {
        expect(
          await attachmentRefusal({
            path: attachmentPath(storeId, crypto.randomUUID()),
          }),
        ).toContain("mink_attachments_path_check");
      });

      it("refuses traversal, another folder and a database segment outside the pattern", async () => {
        const id = crypto.randomUUID();
        expect(
          await attachmentRefusal({
            id,
            path: `stores/${storeId}/mink-attachments/../${id}.webp`,
          }),
        ).toContain("mink_attachments_path_check");
        expect(
          await attachmentRefusal({
            id,
            path: `stores/${storeId}/media/${id}.webp`,
          }),
        ).toContain("mink_attachments_path_check");
        expect(
          await attachmentRefusal({
            id,
            path: attachmentPath(storeId, id, "webp", "store.mink"),
          }),
        ).toContain("mink_attachments_path_check");
      });

      it("refuses image/svg+xml, and a NULL content type by NOT NULL rather than letting it through", async () => {
        expect(
          await attachmentRefusal({ contentType: "image/svg+xml" }),
        ).toContain("mink_attachments_type_check");
        expect(await attachmentRefusal({ contentType: null })).toContain(
          'null value in column "content_type"',
        );
      });

      it("refuses a size of 0 and of 6 MB, and takes exactly 5 MB", async () => {
        expect(await attachmentRefusal({ sizeBytes: 0 })).toContain(
          "mink_attachments_size_check",
        );
        expect(
          await attachmentRefusal({ sizeBytes: 6 * 1024 * 1024 }),
        ).toContain("mink_attachments_size_check");
        await insertAttachment({ sizeBytes: FIVE_MB });
      });

      it("refuses a blank admin", async () => {
        expect(await attachmentRefusal({ adminId: " " })).toContain(
          "mink_attachments_admin_check",
        );
      });

      it("refuses a file name over 160 characters and takes one of 160", async () => {
        expect(
          await attachmentRefusal({ filename: "x".repeat(161) }),
        ).toContain("mink_attachments_filename_check");
        await insertAttachment({ filename: "x".repeat(160) });
      });

      it("refuses a chat with no linked_at", async () => {
        const chatId = await chat();
        expect(await attachmentRefusal({ conversationId: chatId })).toContain(
          "mink_attachments_linked_check",
        );
      });

      it("refuses a chat of another store (the composite foreign key)", async () => {
        const chatId = await chat(storeId);
        const id = crypto.randomUUID();
        expect(
          await attachmentRefusal({
            id,
            storeId: otherStoreId,
            path: attachmentPath(otherStoreId, id),
            conversationId: chatId,
            linkedAt: "2026-10-28T00:00:00Z",
          }),
        ).toContain("mink_attachments_conversation_fkey");
      });

      it("refuses purge_failed_at on a row that was never marked, and takes it once marked", async () => {
        const id = await insertAttachment();
        expect(
          await asService(() =>
            refusal(
              "update mink_attachments set purge_failed_at = now() where id = $1",
              [id],
            ),
          ),
        ).toContain("mink_attachments_purge_check");
        await asService(() =>
          client.query(
            "update mink_attachments set discard_requested_at = now(), purge_failed_at = now() where id = $1",
            [id],
          ),
        );
        expect(
          await count(
            "select count(*) from mink_attachments where id = $1 and purge_failed_at is not null",
            [id],
          ),
        ).toBe(1);
      });

      it("deleting the chat keeps the row, its store and its path: ON DELETE SET NULL on conversation_id only", async () => {
        const chatId = await chat();
        const id = await insertAttachment({
          conversationId: chatId,
          linkedAt: "2026-10-28T00:00:00Z",
          discardRequestedAt: "2026-10-28T00:00:01Z",
        });
        await client.query(
          "delete from mink_conversations where id = $1 and store_id = $2",
          [chatId, storeId],
        );
        const { rows } = await client.query(
          "select store_id, conversation_id, linked_at, path, discard_requested_at from mink_attachments where id = $1",
          [id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].conversation_id).toBeNull();
        expect(rows[0].store_id).toBe(storeId);
        expect(rows[0].path).toBe(attachmentPath(storeId, id));
        expect(rows[0].linked_at).not.toBeNull();
        expect(rows[0].discard_requested_at).not.toBeNull();
      });

      it("deleting the store cascades its rows in both tables", async () => {
        const chatId = await chat(otherStoreId);
        const id = crypto.randomUUID();
        await insertAttachment({
          id,
          storeId: otherStoreId,
          path: attachmentPath(otherStoreId, id),
          conversationId: chatId,
          linkedAt: "2026-10-28T00:00:00Z",
        });
        await asService(() =>
          client.query(
            `insert into mink_attachment_legacy_log(media_asset_id,store_id,public_path,outcome,reason)
             values($1,$2,$3,'failing','read_failed')`,
            [
              crypto.randomUUID(),
              otherStoreId,
              `stores/${otherStoreId}/media/old.webp`,
            ],
          ),
        );
        await client.query("delete from stores where id = $1", [otherStoreId]);
        expect(
          await count(
            "select count(*) from mink_attachments where store_id = $1",
            [otherStoreId],
          ),
        ).toBe(0);
        expect(
          await count(
            "select count(*) from mink_attachment_legacy_log where store_id = $1",
            [otherStoreId],
          ),
        ).toBe(0);
      });

      it("both tables are service-only: app_service may read, write and delete, app_user holds nothing, RLS on with no policy", async () => {
        for (const table of [
          "public.mink_attachments",
          "public.mink_attachment_legacy_log",
        ]) {
          const { rows } = await client.query(
            `select (has_table_privilege('app_service', $1, 'SELECT')
                 and has_table_privilege('app_service', $1, 'INSERT')
                 and has_table_privilege('app_service', $1, 'UPDATE')
                 and has_table_privilege('app_service', $1, 'DELETE')) as service,
               has_table_privilege('app_user', $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as app_user,
               (select c.relrowsecurity from pg_class c where c.oid = $1::regclass) as rls,
               (select count(*) from pg_policy p where p.polrelid = $1::regclass) as policies`,
            [table],
          );
          expect(rows[0], table).toEqual({
            service: true,
            app_user: false,
            rls: true,
            policies: "0",
          });
        }
      });
    });

    // -------------------------------------------------------------------------
    // mink_attachment_legacy_log
    // -------------------------------------------------------------------------

    describe("mink_attachment_legacy_log: the CHECKs, as app_service", () => {
      const INSERT_LOG = `insert into mink_attachment_legacy_log(media_asset_id,store_id,public_path,outcome,reason,attempts,decided_at)
         values($1,$2,$3,$4,$5,$6,$7)`;

      function logValues(row: {
        storeId?: string;
        publicPath?: string;
        outcome: string;
        reason: string | null;
        attempts?: number;
        decidedAt?: string | null;
      }): unknown[] {
        const store = row.storeId ?? storeId;
        return [
          crypto.randomUUID(),
          store,
          row.publicPath ?? `stores/${store}/media/old.webp`,
          row.outcome,
          row.reason,
          row.attempts ?? 1,
          row.decidedAt ?? null,
        ];
      }

      async function logRefusal(
        row: Parameters<typeof logValues>[0],
      ): Promise<string> {
        return asService(() => refusal(INSERT_LOG, logValues(row)));
      }

      it("a failing row and a decided row insert", async () => {
        await asService(async () => {
          await client.query(
            INSERT_LOG,
            logValues({ outcome: "failing", reason: "copy_failed" }),
          );
          await client.query(
            INSERT_LOG,
            logValues({
              outcome: "deleted",
              reason: "no_live_use",
              decidedAt: "2026-10-28T00:00:00Z",
            }),
          );
        });
        expect(
          await count(
            "select count(*) from mink_attachment_legacy_log where store_id = $1",
            [storeId],
          ),
        ).toBe(2);
      });

      it("decided_at is set exactly when the outcome is final", async () => {
        expect(
          await logRefusal({
            outcome: "failing",
            reason: "read_failed",
            decidedAt: "2026-10-28T00:00:00Z",
          }),
        ).toContain("mink_attachment_legacy_log_decided_check");
        expect(
          await logRefusal({ outcome: "kept", reason: "in_use" }),
        ).toContain("mink_attachment_legacy_log_decided_check");
      });

      it("refuses a reason that belongs to another outcome", async () => {
        expect(
          await logRefusal({
            outcome: "kept",
            reason: "moved_with_chat",
            decidedAt: "2026-10-28T00:00:00Z",
          }),
        ).toContain("mink_attachment_legacy_log_outcome_check");
      });

      it("refuses another store's path and traversal", async () => {
        expect(
          await logRefusal({
            outcome: "failing",
            reason: "read_failed",
            publicPath: `stores/${otherStoreId}/media/x.webp`,
          }),
        ).toContain("mink_attachment_legacy_log_path_check");
        expect(
          await logRefusal({
            outcome: "failing",
            reason: "read_failed",
            publicPath: `stores/${storeId}/../x.webp`,
          }),
        ).toContain("mink_attachment_legacy_log_path_check");
      });

      it("refuses attempts outside 0 to 100", async () => {
        expect(
          await logRefusal({
            outcome: "failing",
            reason: "read_failed",
            attempts: -1,
          }),
        ).toContain("mink_attachment_legacy_log_attempts_check");
        expect(
          await logRefusal({
            outcome: "failing",
            reason: "read_failed",
            attempts: 101,
          }),
        ).toContain("mink_attachment_legacy_log_attempts_check");
      });

      it("a NULL reason is refused by NOT NULL", async () => {
        expect(
          await logRefusal({ outcome: "failing", reason: null }),
        ).toContain('null value in column "reason"');
      });
    });

    // -------------------------------------------------------------------------
    // History search: public.mink_message_search_text
    // -------------------------------------------------------------------------

    describe("History search: public.mink_message_search_text", () => {
      /** 0249's own body, created as a temporary function to compare against. */
      async function createSearchText0249(): Promise<void> {
        const migration = readFileSync(SEARCH_MIGRATION_FILE, "utf8");
        const body = migration.match(
          /CREATE OR REPLACE FUNCTION public\.mink_message_search_text\(role text, content jsonb\)[\s\S]*?\$\$;/,
        )?.[0];
        expect(
          body,
          "0249 defines public.mink_message_search_text",
        ).toBeTruthy();
        await client.query(
          body!.replace(
            "public.mink_message_search_text",
            "pg_temp.mink_message_search_text_0249",
          ),
        );
      }

      it("returns what 0249's body returned for every stored message, and no stored message carries the new marker", async () => {
        await createSearchText0249();
        // Messages of every shape the thread stores, beside what the local
        // database already holds.
        const chatId = await chat();
        const runId = await run(chatId);
        await message(
          chatId,
          runId,
          "user",
          `Kaju katli box${SAVED_MEDIA_MARKER}{"filename":"zebra.png","url":"https://example.test/zebra.png"}`,
        );
        await message(
          chatId,
          runId,
          "user",
          `Read this${REVIEWED_DOCUMENT_MARKER}{"text":"zebra recipe"}`,
        );
        await message(
          chatId,
          runId,
          "user",
          `Import these${MINK_CSV_MARKER}{"fileId":"abc","filename":"zebra.csv"}`,
        );
        await message(chatId, runId, "user", "आज के ऑर्डर कितने हैं");
        await message(
          chatId,
          runId,
          "assistant",
          "Two orders today. ".repeat(300),
        );
        expect(
          await count(
            "select count(*) from mink_messages where strpos(content_json ->> 'text', $1) > 0",
            [ATTACHMENT_MARKER.trim()],
          ),
        ).toBe(0);
        const compared = await count("select count(*) from mink_messages");
        expect(compared).toBeGreaterThanOrEqual(5);
        expect(
          await count(
            `select count(*) from mink_messages m
              where public.mink_message_search_text(m.role, m.content_json)
                 is distinct from pg_temp.mink_message_search_text_0249(m.role, m.content_json)`,
          ),
        ).toBe(0);
        // The one message 0262 reads differently is one that carries the new
        // marker, which none of the stored messages does.
        const withMarker = await message(
          chatId,
          runId,
          "user",
          `Kaju katli box${ATTACHMENT_MARKER}{"filename":"zebra.png","url":"/api/mink/attachments/00000000-0000-4000-8000-000000000009"}`,
        );
        const { rows } = await client.query(
          `select m.id, public.mink_message_search_text(m.role, m.content_json) as now,
                  pg_temp.mink_message_search_text_0249(m.role, m.content_json) as before
             from mink_messages m
            where public.mink_message_search_text(m.role, m.content_json)
               is distinct from pg_temp.mink_message_search_text_0249(m.role, m.content_json)`,
        );
        expect(rows.map((row) => row.id)).toEqual([withMarker]);
        // Up to the marker's words, as 0249 reads the three older markers (the
        // marker's opening blank line stays, as it does for those).
        expect(rows[0].now).toBe("Kaju katli box\n\n");
        expect(rows[0].before).toContain("zebra.png");
      });

      it("strips the new marker: its JSON is not searchable, the words before it are, and an answer is read whole", async () => {
        const store = "00000000-0000-4000-8000-000000000001";
        const text = `Kaju katli box${ATTACHMENT_MARKER}{"filename":"zebra.png","url":"/api/mink/attachments/00000000-0000-4000-8000-000000000009"}`;
        const { rows } = await client.query(
          `select public.mink_message_search_vector($1, 'user', jsonb_build_object('text', $2::text))
                    @@ ('kaju:*'::tsquery && public.mink_message_search_store($1)) as words_before,
                  public.mink_message_search_vector($1, 'user', jsonb_build_object('text', $2::text))
                    @@ ('zebra:*'::tsquery || 'privately:*'::tsquery || 'attachments:*'::tsquery) as marker_or_json,
                  public.mink_message_search_vector($1, 'user', jsonb_build_object('text', $3::text))
                    @@ 'zebra:*'::tsquery as old_marker_json,
                  public.mink_message_search_vector($1, 'assistant', jsonb_build_object('text', $4::text))
                    @@ 'zebra:*'::tsquery as answer_whole`,
          [
            store,
            text,
            `Kaju katli box${SAVED_MEDIA_MARKER}{"filename":"zebra.png"}`,
            `${ATTACHMENT_MARKER.trim()} zebra`,
          ],
        );
        expect(rows[0]).toEqual({
          words_before: true,
          marker_or_json: false,
          old_marker_json: false,
          answer_whole: true,
        });
      });

      it("keeps its signature, IMMUTABLE, PARALLEL SAFE, the empty search_path and PUBLIC's EXECUTE", async () => {
        const { rows } = await client.query(
          `select pg_get_function_identity_arguments(p.oid) as arguments,
                  p.prorettype::regtype::text as returns,
                  p.provolatile, p.proparallel, p.proconfig,
                  has_function_privilege('app_user', p.oid, 'EXECUTE') as app_user_exec,
                  has_function_privilege('app_service', p.oid, 'EXECUTE') as app_service_exec
             from pg_proc p
            where p.oid = 'public.mink_message_search_text(text,jsonb)'::regprocedure`,
        );
        expect(rows[0]).toEqual({
          arguments: "role text, content jsonb",
          returns: "text",
          provolatile: "i",
          proparallel: "s",
          proconfig: ['search_path=""'],
          app_user_exec: true,
          app_service_exec: true,
        });
      });

      it("History search still plans a bitmap scan on mink_messages_search_idx", async () => {
        // The search's own transaction turns sequential scans off
        // (lib/mink/conversation-history.ts), so the plan is read the same way;
        // the setting is rolled back with the savepoint.
        await client.query("SAVEPOINT search_plan");
        try {
          await client.query("SET LOCAL enable_seqscan = off");
          const text = await plan(
            `select m.id from mink_messages m
              where public.mink_message_search_vector(m.store_id, m.role, m.content_json)
                    @@ ('kaju:*'::tsquery && public.mink_message_search_store('${storeId}'))`,
          );
          expect(text).toContain(
            "Bitmap Index Scan on mink_messages_search_idx",
          );
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT search_plan");
          await client.query("RELEASE SAVEPOINT search_plan");
        }
      });
    });

    // -------------------------------------------------------------------------
    // The four queries and their indexes
    // -------------------------------------------------------------------------

    describe("the four queries read their own indexes (20,015 rows)", () => {
      const CHATS = 200;
      const PER_CHAT = 100;

      /**
       * 20,000 sent pictures across 200 chats (300 of them retired) and 15
       * pictures waiting to be sent, the shape design 4.3 planned against.
       * Answers the ids of the chats.
       */
      async function seed(): Promise<string[]> {
        const { rows } = await client.query(
          `insert into mink_conversations(store_id,admin_id,title)
           select $1, 'admin-' || (n % 40), 'Chat ' || n from generate_series(1, $2::int) n
           returning id`,
          [storeId, CHATS],
        );
        const chats = rows.map((row) => row.id as string);
        await client.query(
          `insert into mink_attachments(id,store_id,admin_id,conversation_id,linked_at,path,content_type,size_bytes,created_at,discard_requested_at)
           select g.id, $1::uuid, 'admin-' || (g.n % 40), g.chat, now(),
                  'stores/' || $1::text || '/mink-attachments/${DATABASE}/' || g.id || '.webp',
                  'image/webp', 1000, now() - (g.n || ' minutes')::interval,
                  case when g.n % 67 = 0 then now() else null end
             from (select gen_random_uuid() as id, n, c.id as chat
                     from generate_series(1, $2::int) n
                     join unnest($3::uuid[]) with ordinality as c(id, ord)
                       on c.ord = ((n - 1) / $4::int) + 1) g`,
          [storeId, CHATS * PER_CHAT, chats, PER_CHAT],
        );
        await client.query(
          `insert into mink_attachments(id,store_id,admin_id,path,content_type,size_bytes,created_at)
           select g.id, $1::uuid, $2::text,
                  'stores/' || $1::text || '/mink-attachments/${DATABASE}/' || g.id || '.webp',
                  'image/webp', 1000, now() - (n * 7 || ' hours')::interval
             from (select gen_random_uuid() as id, n from generate_series(1, 15) n) g`,
          [storeId, ADMIN],
        );
        await client.query("analyze mink_attachments");
        expect(
          await count(
            "select count(*) from mink_attachments where store_id = $1",
            [storeId],
          ),
        ).toBe(CHATS * PER_CHAT + 15);
        return chats;
      }

      it("the per-admin cap on pictures waiting to be sent reads mink_attachments_unlinked_idx", async () => {
        await seed();
        const text = await plan(
          `select count(*) from mink_attachments
            where store_id = '${storeId}' and admin_id = '${ADMIN}'
              and conversation_id is null and linked_at is null
              and discard_requested_at is null
              and created_at > now() - interval '2 days'`,
        );
        expect(text).toMatch(
          /Index (Only )?Scan using mink_attachments_unlinked_idx/,
        );
      });

      it("the purge's claim of retired candidates reads mink_attachments_discard_idx, oldest first", async () => {
        await seed();
        // The real claim (review R12): an UPDATE over the candidates the
        // inner select locks.
        const text = await planOf(purgeCandidatesSql({ limit: 50 }));
        expect(text).toMatch(/Index Scan using mink_attachments_discard_idx/);
        expect(text).not.toContain("Sort");
      });

      it("the purge's marking of pictures never sent (or whose chat is gone) reads mink_attachments_unlinked_idx", async () => {
        await seed();
        const text = await planOf(
          markUnsentMinkAttachmentsSql({
            floorIso: new Date(Date.now() - 2 * DAY_MS).toISOString(),
            limit: 50,
          }),
        );
        expect(text).toMatch(
          /Index (Only )?Scan using mink_attachments_unlinked_idx/,
        );
      });

      it("retire's marking of one chat's pictures reads mink_attachments_conversation_idx", async () => {
        const [chatId] = await seed();
        const text = await plan(
          `update mink_attachments set discard_requested_at = now()
            where store_id = '${storeId}' and conversation_id = '${chatId}'
              and discard_requested_at is null`,
        );
        // A plain or a bitmap index scan, as the planner sees fit for the
        // chat's hundred rows; never a scan of the table.
        expect(text).toMatch(
          /(Index Scan using|Bitmap Index Scan on) mink_attachments_conversation_idx/,
        );
        expect(text).not.toContain("Seq Scan");
      });

      it("deleting a chat sets its 100 pictures to no chat in one statement and keeps every row", async () => {
        const [chatId] = await seed();
        await client.query(
          "delete from mink_conversations where id = $1 and store_id = $2",
          [chatId, storeId],
        );
        expect(
          await count(
            "select count(*) from mink_attachments where store_id = $1 and conversation_id is null and linked_at is not null",
            [storeId],
          ),
        ).toBe(PER_CHAT);
        expect(
          await count(
            "select count(*) from mink_attachments where store_id = $1",
            [storeId],
          ),
        ).toBe(CHATS * PER_CHAT + 15);
      });
    });

    // -------------------------------------------------------------------------
    // The halves later stages fill in.
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // The code half (stage S3): lib/mink/attachments.ts over this transaction.
    // -------------------------------------------------------------------------

    const nowIso = () => new Date().toISOString();
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * DAY_MS).toISOString();
    /** The sweep's floor, as `sweepPolicy` passes it: 2 days ago. */
    const floor = () => daysAgo(2);

    interface StoredAttachment {
      conversation_id: string | null;
      linked_at: string | null;
      discard_requested_at: string | null;
      purge_failed_at: string | null;
    }

    async function rowOf(id: string): Promise<StoredAttachment | undefined> {
      const { rows } = await client.query(
        "select conversation_id, linked_at, discard_requested_at, purge_failed_at from mink_attachments where id = $1",
        [id],
      );
      return rows[0] as StoredAttachment | undefined;
    }

    /**
     * An active legal hold on a store (migration 0269), as app_service, the
     * role the takedown code writes it with. Answers the hold's id.
     */
    async function holdStore(store: string): Promise<string> {
      const { rows } = await asService(() =>
        client.query(
          `insert into store_legal_holds(store_id,store_label,reason,set_by)
           values($1,'Lumen','A court order keeps this store as it is.','operator@storemink.com')
           returning id`,
          [store],
        ),
      );
      return rows[0].id as string;
    }

    async function releaseHold(holdId: string): Promise<void> {
      await asService(() =>
        client.query(
          "update store_legal_holds set released_at = now(), released_by = 'operator@storemink.com' where id = $1",
          [holdId],
        ),
      );
    }

    /** Moves a row's upload time back `days` (the fixtures set every timestamp by hand). */
    async function uploadedDaysAgo(id: string, days: number): Promise<void> {
      await client.query(
        "update mink_attachments set created_at = $2 where id = $1",
        [id, daysAgo(days)],
      );
    }

    async function failedDaysAgo(id: string, days: number): Promise<void> {
      await client.query(
        "update mink_attachments set purge_failed_at = $2 where id = $1",
        [id, daysAgo(days)],
      );
    }

    /** A picture sent in `conversationId`: linked when the message went. */
    async function sentPicture(conversationId: string): Promise<string> {
      return insertAttachment({ conversationId, linkedAt: nowIso() });
    }

    /**
     * An executed, audited approval in the chat (the retention test's coupon
     * fixture): the record that makes retireMinkConversation REDUCE the chat
     * rather than delete it.
     */
    async function approvedRecord(conversationId: string): Promise<void> {
      const runId = await run(conversationId);
      const { rows: drafts } = await client.query(
        `insert into mink_drafts(store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits)
         values($1,$2,$3,'coupon_create','coupon','Coupons','/dashboard/coupons','Proposal','{}'::jsonb,1)
         returning id`,
        [storeId, ADMIN, runId],
      );
      const { rows: approvals } = await client.query(
        `insert into mink_action_approvals(store_id,admin_id,draft_id,resource_type,resource_id,result_id,product_id,product_version,tool_name,operation,status,draft_version,before_json,after_json,request_hash,idempotency_key,expires_at,approved_at,executed_at)
         values($1,$2,$3,'coupon',null,null,null,null,'create_coupon','apply','executed',1,'{}'::jsonb,'{}'::jsonb,$4,gen_random_uuid(),now() + interval '10 minutes',now(),now())
         returning id`,
        [storeId, ADMIN, drafts[0].id, HASH],
      );
      await client.query(
        `insert into mink_action_audit(approval_id,store_id,admin_id,draft_id,resource_type,resource_id,result_id,product_id,tool_name,operation,outcome,before_json,after_json,request_hash)
         select id,store_id,admin_id,draft_id,resource_type,resource_id,result_id,product_id,tool_name,operation,'executed',before_json,after_json,request_hash
           from mink_action_approvals where id = $1`,
        [approvals[0].id],
      );
    }

    /** Retires through the real function, as app_service. */
    async function retire(conversationId: string): Promise<string> {
      return asService(() =>
        retireMinkConversation(service.db!, { storeId, conversationId }),
      );
    }

    const read = (id: string, adminId = ADMIN, store = storeId) =>
      readMinkAttachmentForViewer({ storeId: store, adminId, id });

    describe("the link at send and the viewer read", () => {
      it("★ links only the sender's own unlinked, unmarked rows; another admin's row, a linked row, a marked row and a forged id link nothing", async () => {
        const chatId = await chat();
        const otherChat = await chat();
        const mine = await insertAttachment();
        const mineToo = await insertAttachment();
        const leftOut = await insertAttachment();
        const theirs = await insertAttachment({ adminId: OTHER_ADMIN });
        const linked = await sentPicture(otherChat);
        const marked = await insertAttachment({ discardRequestedAt: nowIso() });
        const forged = crypto.randomUUID();

        const statement = linkMinkAttachmentsSql({
          storeId,
          adminId: ADMIN,
          conversationId: chatId,
          ids: [mine, mineToo, theirs, linked, marked, forged],
        });
        expect(statement).not.toBeNull();
        const rows = await withService(
          async (db) => (await db.execute(statement!)).rows,
        );
        expect(rows.map((row) => row.id).sort()).toEqual(
          [mine, mineToo].sort(),
        );

        for (const id of [mine, mineToo]) {
          expect(await rowOf(id)).toMatchObject({
            conversation_id: chatId,
            linked_at: expect.any(String),
          });
        }
        expect(await rowOf(leftOut)).toMatchObject({
          conversation_id: null,
          linked_at: null,
        });
        expect(await rowOf(theirs)).toMatchObject({
          conversation_id: null,
          linked_at: null,
        });
        expect(await rowOf(linked)).toMatchObject({
          conversation_id: otherChat,
        });
        expect(await rowOf(marked)).toMatchObject({
          conversation_id: null,
          linked_at: null,
          discard_requested_at: expect.any(String),
        });
        expect(
          linkMinkAttachmentsSql({
            storeId,
            adminId: ADMIN,
            conversationId: chatId,
            ids: [],
          }),
        ).toBeNull();
      });

      it("★ the viewer read serves the attacher an unsent picture and a live chat's, and nobody else", async () => {
        const chatId = await chat();
        const unsent = await insertAttachment({
          filename: "shelf.png",
          sizeBytes: 4321,
        });
        const sent = await sentPicture(chatId);
        expect(await read(unsent)).toEqual({
          path: attachmentPath(storeId, unsent),
          contentType: "image/webp",
          sizeBytes: 4321,
          filename: "shelf.png",
        });
        expect(await read(sent)).toMatchObject({
          path: attachmentPath(storeId, sent),
        });
        // ★ Another admin's id reads no row (mutation check 1), and neither
        //   does another store's.
        expect(await read(unsent, OTHER_ADMIN)).toBeNull();
        expect(await read(sent, OTHER_ADMIN)).toBeNull();
        expect(await read(sent, ADMIN, otherStoreId)).toBeNull();
        // A marked picture is gone from the viewer before the purge reaches it.
        const marked = await insertAttachment({ discardRequestedAt: nowIso() });
        expect(await read(marked)).toBeNull();
        // A chat past its 90 days that the sweep has not reached serves
        // nothing (mink_conversations_expiry_check keeps the expiry after
        // the chat's creation, so the chat is aged with it).
        await client.query(
          `update mink_conversations
              set created_at = now() - interval '100 days',
                  last_message_at = now() - interval '91 days',
                  expires_at = now() - interval '1 day'
            where id = $1`,
          [chatId],
        );
        expect(await read(sent)).toBeNull();
      });

      it("★ nothing after retire: a reduced chat's picture no longer serves, while its row waits for the purge", async () => {
        const chatId = await chat();
        await approvedRecord(chatId);
        const sent = await sentPicture(chatId);
        expect(await read(sent)).not.toBeNull();
        await expect(retire(chatId)).resolves.toBe("reduced");
        expect(await read(sent)).toBeNull();
        // The row stays, still naming the reduced chat, for the purge's
        // "chat no longer active" mark (and retire's own mark, stage S4).
        expect(await rowOf(sent)).toMatchObject({ conversation_id: chatId });
      });

      it("★ C3: retire's DELETE path marks the pictures before the chat goes, and the purge then takes objects and rows", async () => {
        storage.deleted.length = 0;
        storage.fail.clear();
        const chatId = await chat();
        const sent = await sentPicture(chatId);
        const sentToo = await sentPicture(chatId);
        expect(await read(sent)).not.toBeNull();

        // A chat with no record: the real retire deletes it (step 2b marks
        // first, then ON DELETE SET NULL (conversation_id) clears the link).
        await expect(retire(chatId)).resolves.toBe("deleted");
        expect(
          await count("select count(*) from mink_conversations where id = $1", [
            chatId,
          ]),
        ).toBe(0);
        for (const id of [sent, sentToo]) {
          expect(await rowOf(id)).toMatchObject({
            conversation_id: null,
            linked_at: expect.any(String),
            discard_requested_at: expect.any(String),
          });
          const { rows } = await client.query(
            "select store_id, path from mink_attachments where id = $1",
            [id],
          );
          expect(rows[0]).toEqual({
            store_id: storeId,
            path: attachmentPath(storeId, id),
          });
          expect(await read(id)).toBeNull();
        }

        await expect(purgeMinkAttachments(floor(), 50)).resolves.toBe(2);
        expect([...storage.deleted].sort()).toEqual(
          [
            attachmentPath(storeId, sent),
            attachmentPath(storeId, sentToo),
          ].sort(),
        );
        expect(await rowOf(sent)).toBeUndefined();
        expect(await rowOf(sentToo)).toBeUndefined();
      });

      it("★ S5: the use read (promotion, inline references) takes an unsent picture or one of the run's own live chat, never another chat's, a dead one or an expired one", async () => {
        const chatId = await chat();
        const otherChat = await chat();
        const unsent = await insertAttachment();
        const here = await sentPicture(chatId);
        const elsewhere = await sentPicture(otherChat);
        const runHere = await run(chatId);
        const use = async (ids: string[], runId: string | null) =>
          (
            await withService(
              async (db) =>
                (
                  await db.execute(
                    minkAttachmentsForUseSql({
                      storeId,
                      adminId: ADMIN,
                      ids,
                      runId,
                    }),
                  )
                ).rows,
            )
          )
            .map((row) => String(row.id))
            .sort();
        const all = [unsent, here, elsewhere];

        // No run (a caller outside a chat): the chat state alone decides.
        expect(await use(all, null)).toEqual([unsent, here, elsewhere].sort());
        // In the run's chat: its own pictures and unsent ones, never another
        // chat's (review S5).
        expect(await use(all, runHere)).toEqual([unsent, here].sort());
        // An unreadable run id reads as no chat at all: only unsent ones.
        expect(await use(all, "not-a-uuid")).toEqual([unsent]);
        // Another admin's ids read nothing.
        expect(
          (
            await withService(
              async (db) =>
                (
                  await db.execute(
                    minkAttachmentsForUseSql({
                      storeId,
                      adminId: OTHER_ADMIN,
                      ids: all,
                    }),
                  )
                ).rows,
            )
          ).length,
        ).toBe(0);
        // A chat past its 90 days the sweep has not reached: nothing of it.
        await client.query(
          `update mink_conversations
              set created_at = now() - interval '100 days',
                  last_message_at = now() - interval '91 days',
                  expires_at = now() - interval '1 day'
            where id = $1`,
          [otherChat],
        );
        expect(await use(all, null)).toEqual([unsent, here].sort());
        // A chat deleted without the retire's mark (review R4): dead at once.
        await client.query(
          "delete from mink_conversations where id = $1 and store_id = $2",
          [chatId, storeId],
        );
        expect(await use(all, null)).toEqual([unsent]);
      });
    });

    describe("the purge selection", () => {
      beforeEach(() => {
        storage.deleted.length = 0;
        storage.fail.clear();
      });

      it("★ marks never-sent rows past the 2-day floor and deletes them, objects first; a newer unsent row and a live chat's picture stay", async () => {
        const stale = await insertAttachment();
        await uploadedDaysAgo(stale, 3);
        const staleToo = await insertAttachment({ adminId: OTHER_ADMIN });
        await uploadedDaysAgo(staleToo, 3);
        const fresh = await insertAttachment();
        await uploadedDaysAgo(fresh, 1);
        const chatId = await chat();
        const sent = await sentPicture(chatId);
        await uploadedDaysAgo(sent, 3);

        await expect(purgeMinkAttachments(floor(), 50)).resolves.toBe(2);
        expect([...storage.deleted].sort()).toEqual(
          [
            attachmentPath(storeId, stale),
            attachmentPath(storeId, staleToo),
          ].sort(),
        );
        expect(await rowOf(stale)).toBeUndefined();
        expect(await rowOf(staleToo)).toBeUndefined();
        expect(await rowOf(fresh)).toMatchObject({
          discard_requested_at: null,
        });
        expect(await rowOf(sent)).toMatchObject({
          conversation_id: chatId,
          discard_requested_at: null,
        });
      });

      it("★ a reduced chat's pictures are marked and purged, while a live chat's stay", async () => {
        const reduced = await chat();
        await approvedRecord(reduced);
        const gone = await sentPicture(reduced);
        const goneToo = await sentPicture(reduced);
        const live = await chat();
        const kept = await sentPicture(live);
        await expect(retire(reduced)).resolves.toBe("reduced");

        await expect(purgeMinkAttachments(floor(), 50)).resolves.toBe(2);
        expect([...storage.deleted].sort()).toEqual(
          [
            attachmentPath(storeId, gone),
            attachmentPath(storeId, goneToo),
          ].sort(),
        );
        expect(await rowOf(gone)).toBeUndefined();
        expect(await rowOf(goneToo)).toBeUndefined();
        expect(await rowOf(kept)).toMatchObject({
          conversation_id: live,
          discard_requested_at: null,
        });
      });

      it("★ R4: a chat deleted without the retire mark: its picture is dead at once (no viewer read, no re-link) and the purge takes it without the 2-day wait", async () => {
        const chatId = await chat();
        // Attached and sent just now: only the dead-row arm can mark it.
        const sent = await sentPicture(chatId);
        expect(await read(sent)).not.toBeNull();
        // A delete that skips retireMinkConversation (the replaced revision,
        // or any path that deletes the chat row directly).
        await client.query(
          "delete from mink_conversations where id = $1 and store_id = $2",
          [chatId, storeId],
        );
        expect(await rowOf(sent)).toMatchObject({
          conversation_id: null,
          linked_at: expect.any(String),
          discard_requested_at: null,
        });
        expect(await read(sent)).toBeNull();
        const newChat = await chat();
        const relinked = await withService(
          async (db) =>
            (
              await db.execute(
                linkMinkAttachmentsSql({
                  storeId,
                  adminId: ADMIN,
                  conversationId: newChat,
                  ids: [sent],
                })!,
              )
            ).rows,
        );
        expect(relinked).toEqual([]);
        expect(await rowOf(sent)).toMatchObject({ conversation_id: null });

        const { rows: before } = await client.query(
          "select created_at from mink_attachments where id = $1",
          [sent],
        );
        expect(Date.parse(String(before[0].created_at))).toBeGreaterThan(
          Date.parse(floor()),
        );
        await expect(purgeMinkAttachments(floor(), 50)).resolves.toBe(1);
        expect(storage.deleted).toEqual([attachmentPath(storeId, sent)]);
        expect(await rowOf(sent)).toBeUndefined();
      });

      it("★ R5 / C4 (S10): a chat reduced without the mark (the replaced revision) still loses its pictures, while a live chat's stay", async () => {
        const reduced = await chat();
        const gone = await sentPicture(reduced);
        const goneToo = await sentPicture(reduced);
        const live = await chat();
        const kept = await sentPicture(live);
        // The old revision's reduce: the status only, no step 2b.
        await client.query(
          "update mink_conversations set status = 'deleted' where id = $1",
          [reduced],
        );
        expect(await rowOf(gone)).toMatchObject({
          discard_requested_at: null,
        });
        expect(await rowOf(goneToo)).toMatchObject({
          discard_requested_at: null,
        });

        await expect(purgeMinkAttachments(floor(), 50)).resolves.toBe(2);
        expect([...storage.deleted].sort()).toEqual(
          [
            attachmentPath(storeId, gone),
            attachmentPath(storeId, goneToo),
          ].sort(),
        );
        expect(await rowOf(gone)).toBeUndefined();
        expect(await rowOf(goneToo)).toBeUndefined();
        expect(await rowOf(kept)).toMatchObject({
          conversation_id: live,
          discard_requested_at: null,
        });
      });

      it("★ R12: a claimed row is out of every other purge for 15 minutes, and a crashed claim comes back after it", async () => {
        const marked = await insertAttachment({
          discardRequestedAt: daysAgo(1),
        });
        // Claim it as a purge would, then "crash" (no delete, no failure).
        const claimed = await withService(
          async (db) =>
            (await db.execute(purgeCandidatesSql({ limit: 50 }))).rows,
        );
        expect(claimed.map((row) => String(row.id))).toEqual([marked]);
        const { rows } = await client.query(
          "select purge_failed_at > now() - interval '7 days' as held, purge_failed_at <= now() - interval '7 days' + interval '15 minutes' as within from mink_attachments where id = $1",
          [marked],
        );
        expect(rows[0]).toEqual({ held: true, within: true });
        // A second purge (another run, or a store's batch) takes nothing.
        await expect(purgeMinkAttachments(floor(), 50)).resolves.toBe(0);
        expect(storage.deleted).toEqual([]);
        expect(await rowOf(marked)).toBeDefined();
        // Past the 15 minutes the row is a candidate again.
        await client.query(
          "update mink_attachments set purge_failed_at = now() - interval '7 days' - interval '1 minute' where id = $1",
          [marked],
        );
        await expect(purgeMinkAttachments(floor(), 50)).resolves.toBe(1);
        expect(storage.deleted).toEqual([attachmentPath(storeId, marked)]);
        expect(await rowOf(marked)).toBeUndefined();
      });

      it("★ candidates come oldest mark first within the limit, a failed delete waits 7 days, and purge_failed_at lands only on a marked row", async () => {
        const oldest = await insertAttachment({
          discardRequestedAt: daysAgo(12),
        });
        const retry = await insertAttachment({
          discardRequestedAt: daysAgo(10),
        });
        await failedDaysAgo(retry, 8);
        const waiting = await insertAttachment({
          discardRequestedAt: daysAgo(10),
        });
        await failedDaysAgo(waiting, 1);
        const newer = await insertAttachment({
          discardRequestedAt: daysAgo(5),
        });
        const unmarked = await insertAttachment();

        await expect(purgeMinkAttachments(floor(), 1)).resolves.toBe(1);
        expect(storage.deleted).toEqual([attachmentPath(storeId, oldest)]);
        expect(await rowOf(oldest)).toBeUndefined();
        expect(await rowOf(retry)).toBeDefined();

        storage.deleted.length = 0;
        storage.fail.add(attachmentPath(storeId, newer));
        await expect(purgeMinkAttachments(floor(), 10)).resolves.toBe(2);
        expect([...storage.deleted].sort()).toEqual(
          [
            attachmentPath(storeId, retry),
            attachmentPath(storeId, newer),
          ].sort(),
        );
        expect(await rowOf(retry)).toBeUndefined();
        // The failed delete keeps its row, marked failed now, and counted.
        expect(await rowOf(newer)).toMatchObject({
          discard_requested_at: expect.any(String),
          purge_failed_at: expect.any(String),
        });
        // A delete that failed within 7 days was not asked for again.
        expect(await rowOf(waiting)).toMatchObject({
          purge_failed_at: expect.any(String),
        });
        expect(storage.deleted).not.toContain(attachmentPath(storeId, waiting));
        expect(await rowOf(unmarked)).toMatchObject({
          discard_requested_at: null,
          purge_failed_at: null,
        });
      });

      it("★ a path of another database: the row goes and the object is never asked for", async () => {
        const id = crypto.randomUUID();
        await insertAttachment({
          id,
          path: attachmentPath(storeId, id, "webp", "storemink_staging"),
          discardRequestedAt: daysAgo(1),
        });
        await expect(purgeMinkAttachments(floor(), 50)).resolves.toBe(1);
        expect(storage.deleted).toEqual([]);
        expect(await rowOf(id)).toBeUndefined();
      });

      it("★★ D10: a held store's marked picture is not purged while the hold is active, and is purged the first night after it is released", async () => {
        const heldId = await insertAttachment({
          discardRequestedAt: daysAgo(1),
        });
        const theirsId = crypto.randomUUID();
        await insertAttachment({
          id: theirsId,
          storeId: otherStoreId,
          path: attachmentPath(otherStoreId, theirsId),
          discardRequestedAt: daysAgo(1),
        });
        const holdId = await holdStore(storeId);

        // Only the other store's picture goes; the held one is not claimed.
        await expect(purgeMinkAttachments(floor(), 50)).resolves.toBe(1);
        expect(storage.deleted).toEqual([
          attachmentPath(otherStoreId, theirsId),
        ]);
        expect(await rowOf(theirsId)).toBeUndefined();
        expect(await rowOf(heldId)).toMatchObject({ purge_failed_at: null });
        expect((await rowOf(heldId))?.discard_requested_at).not.toBeNull();
        // The store's own purge (after a chat is deleted) waits too.
        await expect(purgeStoreMinkAttachments(storeId)).resolves.toBe(0);
        expect(await rowOf(heldId)).toBeDefined();

        await releaseHold(holdId);
        await expect(purgeMinkAttachments(floor(), 50)).resolves.toBe(1);
        expect(storage.deleted).toEqual([
          attachmentPath(otherStoreId, theirsId),
          attachmentPath(storeId, heldId),
        ]);
        expect(await rowOf(heldId)).toBeUndefined();
      });

      it("the store-scoped batch touches only its own store", async () => {
        const ours = await insertAttachment({ discardRequestedAt: daysAgo(1) });
        const theirsId = crypto.randomUUID();
        await insertAttachment({
          id: theirsId,
          storeId: otherStoreId,
          path: attachmentPath(otherStoreId, theirsId),
          discardRequestedAt: daysAgo(1),
        });
        const staleUnsent = await insertAttachment({ storeId: otherStoreId });
        await uploadedDaysAgo(staleUnsent, 3);

        await expect(purgeStoreMinkAttachments(storeId)).resolves.toBe(1);
        expect(storage.deleted).toEqual([attachmentPath(storeId, ours)]);
        expect(await rowOf(ours)).toBeUndefined();
        expect(await rowOf(theirsId)).toBeDefined();
        expect(await rowOf(staleUnsent)).toMatchObject({
          discard_requested_at: null,
        });
      });
    });

    // -------------------------------------------------------------------------
    // Blocked bytes (takedown stage T6c, design 14.1 point 1): the real
    // re-upload guard over this transaction. Each case blocks bytes with a
    // live file block of the store (migration 0269), marks the blocked-object
    // set stale so it reloads, and checks the one `reupload_refused` event.
    // -------------------------------------------------------------------------

    describe("★★ blocked bytes are refused at the save, the Library copy and the inline read", () => {
      beforeEach(() => {
        storage.bytes.clear();
        storage.uploads.length = 0;
        forgetBlockedObjects();
      });
      afterEach(() => {
        // The fixture rollback removes the blocks; the cached set must not
        // outlive them.
        forgetBlockedObjects();
      });

      const actor = (): MinkActorContext =>
        ({
          storeId,
          adminId: ADMIN,
          permissions: { media: ["view", "manage"] },
          isSuperadmin: false,
        }) as unknown as MinkActorContext;

      /**
       * A live file block of the store with these bytes' MD5 (base64), told
       * to the store, or kept from it on a court order (decision D21). Marks
       * the blocked-object set stale. Answers the block's id.
       */
      async function blockBytes(
        md5: string | null,
        options: { told?: boolean; objectPath?: string } = {},
      ): Promise<string> {
        const told = options.told ?? true;
        const objectPath =
          options.objectPath ??
          `stores/${storeId}/media/blocked-${crypto.randomUUID()}.webp`;
        const { rows } = await asService(() =>
          client.query(
            `insert into content_blocks(store_id,store_label,item_kind,object_path,object_md5,file_source,item_label,reason_kind,legal_basis,store_message,tell_store,storage_state,blocked_by)
             values($1,'Lumen','file',$2,$3,'bucket','blocked.webp',$4,$5,'We blocked this image after a complaint.',$6,'pending','operator@storemink.com')
             returning id`,
            [
              storeId,
              objectPath,
              md5,
              told ? "terms_breach" : "court_order",
              told ? "" : "Court order 12/2026",
              told,
            ],
          ),
        );
        forgetBlockedObjects();
        return rows[0].id as string;
      }

      async function refusals(blockId: string) {
        const { rows } = await client.query(
          "select actor, store_id, detail from moderation_events where action = 'reupload_refused' and block_id = $1",
          [blockId],
        );
        return rows as {
          actor: string;
          store_id: string;
          detail: Record<string, unknown>;
        }[];
      }

      async function pngFile(): Promise<File> {
        const png = await sharp({
          create: {
            width: 12,
            height: 9,
            channels: 3,
            background: { r: 190, g: 40, b: 70 },
          },
        })
          .png()
          .toBuffer();
        return new File([new Uint8Array(png)], "blocked shelf.png", {
          type: "image/png",
        });
      }

      it("★ at the save: the attachment sentence, nothing counted or stored, one event", async () => {
        const file = await pngFile();
        // The bytes the save stores are the processed ones.
        const processed = await processImageUpload(file, { strict: true });
        if (!processed.ok) throw new Error(processed.error);
        const md5 = md5Base64(processed.data.bytes);
        const blockId = await blockBytes(md5);

        await expect(
          saveMinkAttachment({ storeId, adminId: ADMIN, file }),
        ).resolves.toEqual({ error: attachmentSentence(true) });
        expect(
          await count(
            "select count(*) from mink_attachments where store_id = $1",
            [storeId],
          ),
        ).toBe(0);
        expect(gcsPrivateUploadObject).not.toHaveBeenCalled();
        const events = await refusals(blockId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actor: ADMIN,
          store_id: storeId,
          detail: { via: "mink_attachment_save", md5, told: true },
        });
      });

      it("★ at the Library copy: unblocked bytes are written through the guard; blocked bytes are refused with no copy and no row, one event", async () => {
        const fine = await insertAttachment();
        storage.bytes.set(
          `private:${attachmentPath(storeId, fine)}`,
          new Uint8Array([1, 2, 3, 4]),
        );
        const blocked = await insertAttachment();
        const bytes = new Uint8Array([9, 9, 8, 8]);
        storage.bytes.set(`private:${attachmentPath(storeId, blocked)}`, bytes);
        const blockId = await blockBytes(md5Base64(bytes));

        const promoted = await promoteMinkAttachmentRefs(
          actor(),
          { image_url: `/api/mink/attachments/${fine}` },
          ["image_url"],
        );
        expect(storage.uploads).toHaveLength(1);
        expect(
          storage.uploads[0].startsWith(
            minkAttachmentCopyPathPrefix(storeId, fine),
          ),
        ).toBe(true);
        expect(promoted.image_url).toBe(
          `https://storage.googleapis.com/storemink-local-test/${storage.uploads[0]}`,
        );

        const promise = promoteMinkAttachmentRefs(
          actor(),
          { image_url: `/api/mink/attachments/${blocked}` },
          ["image_url"],
        );
        await expect(promise).rejects.toBeInstanceOf(MinkToolInputError);
        await expect(promise).rejects.toThrow(attachmentSentence(true));
        expect(gcsUploadObject).toHaveBeenCalledTimes(1);
        expect(
          await count(
            "select count(*) from media_assets where store_id = $1 and starts_with(path, $2)",
            [storeId, minkAttachmentCopyPathPrefix(storeId, blocked)],
          ),
        ).toBe(0);
        const events = await refusals(blockId);
        // The promise was awaited twice; the promotion ran once.
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actor: ADMIN,
          store_id: storeId,
          detail: { via: "mink_attachment_copy", told: true },
        });
      });

      it("★ an earlier copy blocked since by its own address is never reused (D21: a block with no MD5 gives the nameless sentence)", async () => {
        const id = await insertAttachment();
        storage.bytes.set(
          `private:${attachmentPath(storeId, id)}`,
          new Uint8Array([5, 5, 5]),
        );
        const copyPath = `${minkAttachmentCopyPathPrefix(storeId, id)}0123456789abcdef.webp`;
        await asService(() =>
          client.query(
            `insert into media_assets(store_id,url,path,filename,content_type,size_bytes,source)
             values($1,$2,$3,'copy.webp','image/webp',3,'upload')`,
            [
              storeId,
              `https://storage.googleapis.com/storemink-local-test/${copyPath}`,
              copyPath,
            ],
          ),
        );
        await blockBytes(null, { objectPath: copyPath });

        await expect(
          promoteMinkAttachmentRefs(
            actor(),
            { image_url: `/api/mink/attachments/${id}` },
            ["image_url"],
          ),
        ).rejects.toThrow(attachmentSentence(false));
        expect(gcsUploadObject).not.toHaveBeenCalled();
      });

      it("★ at the inline read: refused as a reference, nameless when the block is kept from the store, one event", async () => {
        const id = await insertAttachment();
        const bytes = new Uint8Array([7, 1, 7, 1]);
        storage.bytes.set(`private:${attachmentPath(storeId, id)}`, bytes);
        const blockId = await blockBytes(md5Base64(bytes), { told: false });

        const promise = readMinkAttachmentReferences(actor(), [
          `/api/mink/attachments/${id}`,
        ]);
        await expect(promise).rejects.toBeInstanceOf(MinkToolInputError);
        await expect(promise).rejects.toThrow(attachmentSentence(false));
        const events = await refusals(blockId);
        // The promise was awaited twice; the read ran once.
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actor: ADMIN,
          store_id: storeId,
          detail: { via: "mink_attachment_reference", told: false },
        });
      });
    });

    // -------------------------------------------------------------------------
    // The legacy move (stage S6): lib/mink/attachments-legacy.ts over this
    // transaction. The job runs only against the two real database names, so
    // DB_NAME is stubbed to storemink_staging for these cases while the
    // connection stays storemink_local; the private paths it writes carry that
    // name, and everything rolls back with the fixture savepoint. Storage is
    // the recorder at the top of the file.
    // -------------------------------------------------------------------------

    describe("the legacy move (stage S6)", () => {
      const LEGACY_DATABASE = "storemink_staging";
      /** The one legacy row this database holds, for the end-to-end case. */
      const LEGACY_ID = "1dadeb5c-9025-4ab8-bc7a-b1b81966cee5";
      const LEGACY_STORE = "48baf654-8e5e-40dc-a2a8-2d3e287ecb33";
      const LEGACY_CHAT = "5fec6cf8-43a4-4fb8-b5d7-8c8b5c1f123d";
      const LEGACY_ADMIN = "fgHU7yC1ZBg6oIBlxpb6AmYeoG92";
      const MD5 = "legacy-md5==";
      const HOUR_MS = 3_600_000;

      beforeEach(async () => {
        vi.stubEnv("DB_NAME", LEGACY_DATABASE);
        storage.deleted.length = 0;
        storage.deletes.length = 0;
        storage.copies.length = 0;
        storage.fail.clear();
        storage.objects.clear();
        storage.copyFail = false;
        storage.corruptCopy = false;
        storage.readFail = false;
        // The rows this database already holds stay out of every case but the
        // end-to-end one, which puts the real row back.
        await client.query(
          "update media_assets set source = 'upload' where source = 'mink_attachment'",
        );
      });

      afterEach(() => {
        vi.stubEnv("DB_NAME", DATABASE);
      });

      const mediaUrl = (path: string) =>
        `https://storage.googleapis.com/storemink-media/${path}`;

      interface MediaRow {
        id?: string;
        storeId?: string;
        path?: string;
        contentType?: string;
        sizeBytes?: number;
        createdDaysAgo?: number;
        source?: string;
      }

      /** A public attachment row of the old shape, 3 days old unless said. */
      async function legacyRow(
        row: MediaRow = {},
      ): Promise<{ id: string; path: string; url: string }> {
        const id = row.id ?? crypto.randomUUID();
        const store = row.storeId ?? storeId;
        const path = row.path ?? `stores/${store}/media/${id}.webp`;
        const url = mediaUrl(path);
        await client.query(
          `insert into media_assets(id,store_id,url,path,filename,content_type,size_bytes,source,created_at)
           values($1,$2,$3,$4,'old.webp',$5,$6,$7,$8)`,
          [
            id,
            store,
            url,
            path,
            row.contentType ?? "image/webp",
            row.sizeBytes ?? 5242,
            row.source ?? "mink_attachment",
            daysAgo(row.createdDaysAgo ?? 3),
          ],
        );
        return { id, path, url };
      }

      function seedObject(
        path: string,
        over: Partial<{ size: number; md5: string | null }> = {},
      ): void {
        storage.objects.set(`public:${path}`, {
          size: 5242,
          contentType: "image/webp",
          md5: MD5,
          ...over,
        });
      }

      async function logRow(
        mediaId: string,
        publicPath: string,
        over: {
          outcome?: string;
          reason?: string;
          attempts?: number;
          lastAttemptHoursAgo?: number;
          decided?: boolean;
        } = {},
      ): Promise<void> {
        await client.query(
          `insert into mink_attachment_legacy_log(media_asset_id,store_id,public_path,outcome,reason,attempts,last_attempt_at,decided_at)
           values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            mediaId,
            storeId,
            publicPath,
            over.outcome ?? "failing",
            over.reason ?? "copy_failed",
            over.attempts ?? 1,
            new Date(
              Date.now() - (over.lastAttemptHoursAgo ?? 30) * HOUR_MS,
            ).toISOString(),
            over.decided ? nowIso() : null,
          ],
        );
      }

      interface LogRecord {
        outcome: string;
        reason: string;
        attempts: number;
        public_path: string;
        decided_at: string | null;
      }

      async function logOf(mediaId: string): Promise<LogRecord | undefined> {
        const { rows } = await client.query(
          "select outcome, reason, attempts, public_path, decided_at from mink_attachment_legacy_log where media_asset_id = $1",
          [mediaId],
        );
        return rows[0] as LogRecord | undefined;
      }

      async function mediaOf(
        id: string,
      ): Promise<{ source: string } | undefined> {
        const { rows } = await client.query(
          "select source from media_assets where id = $1",
          [id],
        );
        return rows[0] as { source: string } | undefined;
      }

      /** A live chat of this store whose one message names `url`. */
      async function liveMessage(url: string): Promise<string> {
        const conversationId = await chat();
        const runId = await run(conversationId);
        await message(
          conversationId,
          runId,
          "user",
          `Look at this ${url} please`,
        );
        return conversationId;
      }

      const privatePathOf = (store: string, id: string) =>
        attachmentPath(store, id, "webp", LEGACY_DATABASE);

      /** A chat whose 90 days have passed (its CHECK keeps expiry after creation). */
      async function expireChat(conversationId: string): Promise<void> {
        await client.query(
          `update mink_conversations
              set created_at = now() - interval '100 days',
                  last_message_at = now() - interval '95 days',
                  expires_at = now() - interval '5 days'
            where id = $1`,
          [conversationId],
        );
      }

      const messagesNaming = (conversationId: string, text: string) =>
        count(
          "select count(*) from mink_messages where conversation_id = $1 and strpos(content_json->>'text', $2) > 0",
          [conversationId, text],
        );

      const execute = (query: Parameters<Db["execute"]>[0]) =>
        asService(() => service.db!.execute(query));

      it("★ the guard: the local database name does nothing", async () => {
        vi.stubEnv("DB_NAME", DATABASE);
        const { id, path } = await legacyRow();
        seedObject(path);
        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(0);
        expect(await mediaOf(id)).toMatchObject({ source: "mink_attachment" });
        expect(await logOf(id)).toBeUndefined();
        expect(storage.deleted).toEqual([]);
        expect(storage.copies).toEqual([]);
      });

      it("★ the record upsert counts attempts and never reopens a decided row", async () => {
        const { id, path } = await legacyRow();
        const record = (
          outcome: "failing" | "kept",
          reason: "copy_failed" | "in_use",
        ) =>
          execute(
            legacyLogSql({
              mediaAssetId: id,
              storeId,
              publicPath: path,
              outcome,
              reason,
            } as Parameters<typeof legacyLogSql>[0]),
          );
        await record("failing", "copy_failed");
        await record("failing", "copy_failed");
        expect(await logOf(id)).toMatchObject({
          outcome: "failing",
          reason: "copy_failed",
          attempts: 2,
          decided_at: null,
        });
        await record("kept", "in_use");
        expect(await logOf(id)).toMatchObject({
          outcome: "kept",
          reason: "in_use",
          attempts: 3,
          decided_at: expect.any(String),
        });
        // A later failure cannot reopen it.
        await record("failing", "copy_failed");
        expect(await logOf(id)).toMatchObject({
          outcome: "kept",
          reason: "in_use",
          attempts: 3,
        });
      });

      it("★ the candidates: before the floor, with no record or a failing one past its 20-hour backoff under four attempts, oldest first", async () => {
        const fresh = await legacyRow({ createdDaysAgo: 3 });
        await legacyRow({ createdDaysAgo: 1 }); // after the floor
        const retry = await legacyRow({ createdDaysAgo: 5 });
        await logRow(retry.id, retry.path, {
          attempts: 1,
          lastAttemptHoursAgo: 25,
        });
        const waiting = await legacyRow({ createdDaysAgo: 4 });
        await logRow(waiting.id, waiting.path, {
          attempts: 1,
          lastAttemptHoursAgo: 1,
        });
        const givenUp = await legacyRow({ createdDaysAgo: 6 });
        await logRow(givenUp.id, givenUp.path, {
          attempts: 4,
          lastAttemptHoursAgo: 30,
        });
        const decided = await legacyRow({ createdDaysAgo: 7 });
        await logRow(decided.id, decided.path, {
          outcome: "kept",
          reason: "in_use",
          decided: true,
        });
        await legacyRow({ createdDaysAgo: 8, source: "upload" });

        const candidates = async (limit: number) =>
          (await execute(legacyCandidatesSql(floor(), limit))).rows;
        expect((await candidates(25)).map((row) => row.id)).toEqual([
          retry.id,
          fresh.id,
        ]);
        expect((await candidates(25)).map((row) => row.attempts)).toEqual([
          1, 0,
        ]);
        expect((await candidates(1)).map((row) => row.id)).toEqual([retry.id]);
      });

      it("★ a proposal that can still be approved keeps a picture; one acted on, expired or in a dead chat does not", async () => {
        const { url } = await legacyRow();
        const conversationId = await chat();
        const runId = await run(conversationId);
        const { rows: drafts } = await client.query(
          `insert into mink_drafts(store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits)
           values($1,$2,$3,'coupon_create','coupon','Coupons','/dashboard/coupons','Proposal',$4::jsonb,1)
           returning id`,
          [storeId, ADMIN, runId, JSON.stringify({ image: url })],
        );
        const draftId = drafts[0].id as string;
        const live = async () =>
          (await execute(legacyLiveProposalSql(storeId, url))).rows[0]
            ?.live_proposal;
        const approval = (status: string, expiresIn: string) =>
          client.query(
            `insert into mink_action_approvals(store_id,admin_id,draft_id,resource_type,tool_name,operation,status,draft_version,before_json,after_json,request_hash,idempotency_key,expires_at,approved_at,executed_at)
             values($1,$2,$3,'coupon','create_coupon','apply',$4,1,'{}'::jsonb,'{}'::jsonb,$5,gen_random_uuid(),now() + $6::interval,
                    case when $4 = 'executed' then now() end, case when $4 = 'executed' then now() end)`,
            [storeId, ADMIN, draftId, status, HASH, expiresIn],
          );
        const withApproval = async (status: string, expiresIn: string) => {
          await client.query("SAVEPOINT proposal");
          await approval(status, expiresIn);
          const answer = await live();
          await client.query("ROLLBACK TO SAVEPOINT proposal");
          await client.query("RELEASE SAVEPOINT proposal");
          return answer;
        };

        expect(await live()).toBe(true);
        expect(await withApproval("pending", "10 minutes")).toBe(true);
        expect(await withApproval("executed", "10 minutes")).toBe(false);
        expect(await withApproval("pending", "-10 minutes")).toBe(false);
        await expireChat(conversationId);
        expect(await live()).toBe(false);
        // A proposal naming another picture says nothing about this one.
        expect(
          (await execute(legacyLiveProposalSql(storeId, mediaUrl("other"))))
            .rows[0]?.live_proposal,
        ).toBe(false);
      });

      it("★ the store-wide usage read sees a menu image, the store's settings, the invoice logo, a blog cover or body, and a campaign body", async () => {
        const { url } = await legacyRow();
        const used = async () =>
          (await execute(legacyStoreUsageSql(storeId, url))).rows[0]?.used;
        expect(await used()).toBe(false);
        const probe = async (write: () => Promise<unknown>) => {
          await client.query("SAVEPOINT usage");
          await write();
          const answer = await used();
          await client.query("ROLLBACK TO SAVEPOINT usage");
          await client.query("RELEASE SAVEPOINT usage");
          return answer;
        };
        expect(
          await probe(() =>
            client.query(
              "insert into store_menus(store_id,header) values($1,$2::jsonb)",
              [
                storeId,
                JSON.stringify([
                  { label: "Shop", href: "/shop", image_url: url },
                ]),
              ],
            ),
          ),
        ).toBe(true);
        expect(
          await probe(() =>
            client.query(
              "update stores set settings = settings || $2::jsonb where id = $1",
              [storeId, JSON.stringify({ brand: { logo: url } })],
            ),
          ),
        ).toBe(true);
        expect(
          await probe(() =>
            client.query(
              "insert into store_billing_settings(store_id,logo_url) values($1,$2)",
              [storeId, ` ${url} `],
            ),
          ),
        ).toBe(true);
        expect(
          await probe(() =>
            client.query(
              "insert into blogs(store_id,title,slug,cover_image_url) values($1,'Post','post',$2)",
              [storeId, url],
            ),
          ),
        ).toBe(true);
        expect(
          await probe(() =>
            client.query(
              "insert into blogs(store_id,title,slug,content) values($1,'Post','post',$2)",
              [storeId, `<p><img src="${url}"></p>`],
            ),
          ),
        ).toBe(true);
        expect(
          await probe(() =>
            client.query(
              "insert into email_campaigns(store_id,subject,body,code,discount_label) values($1,'Hello',$2,'SAVE10','10% off')",
              [storeId, `<img src="${url}">`],
            ),
          ),
        ).toBe(true);
        // Another store's use of the same address is not this store's.
        expect(
          await probe(() =>
            client.query(
              "update stores set settings = settings || $2::jsonb where id = $1",
              [otherStoreId, JSON.stringify({ brand: { logo: url } })],
            ),
          ),
        ).toBe(false);
      });

      it("★ after three failed nights a picture is kept as an upload without touching storage", async () => {
        const { id, path } = await legacyRow();
        seedObject(path);
        await logRow(id, path, { attempts: 3, lastAttemptHoursAgo: 30 });
        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
        expect(await mediaOf(id)).toMatchObject({ source: "upload" });
        expect(await logOf(id)).toMatchObject({
          outcome: "kept",
          reason: "gave_up",
          attempts: 4,
          decided_at: expect.any(String),
        });
        expect(storage.deleted).toEqual([]);
        expect(storage.copies).toEqual([]);
      });

      it("★ a public object that is gone: the row goes, recorded missing", async () => {
        const { id, path } = await legacyRow();
        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
        expect(await mediaOf(id)).toBeUndefined();
        expect(await logOf(id)).toMatchObject({
          outcome: "missing",
          reason: "object_missing",
          public_path: path,
          decided_at: expect.any(String),
        });
        expect(storage.deleted).toEqual([]);
      });

      it("★ a storage read that fails is recorded failing, counted, and out of the candidates for 20 hours", async () => {
        const { id, path } = await legacyRow();
        seedObject(path);
        storage.readFail = true;
        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
        expect(await mediaOf(id)).toMatchObject({ source: "mink_attachment" });
        expect(await logOf(id)).toMatchObject({
          outcome: "failing",
          reason: "read_failed",
          attempts: 1,
          decided_at: null,
        });
        storage.readFail = false;
        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(0);
        expect(await logOf(id)).toMatchObject({ attempts: 1 });
      });

      it("★ a picture the store still shows is kept as an upload: in its settings, or on a product", async () => {
        const settings = await legacyRow();
        seedObject(settings.path);
        await client.query(
          "update stores set settings = settings || $2::jsonb where id = $1",
          [storeId, JSON.stringify({ brand: { logo: settings.url } })],
        );
        const product = await legacyRow();
        seedObject(product.path);
        await client.query(
          "insert into products(store_id,name,slug,image_url) values($1,'Shake','shake',$2)",
          [storeId, product.url],
        );
        const proposal = await legacyRow();
        seedObject(proposal.path);
        const runId = await run(await chat());
        await client.query(
          `insert into mink_drafts(store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits)
           values($1,$2,$3,'coupon_create','coupon','Coupons','/dashboard/coupons','Proposal',$4::jsonb,1)`,
          [storeId, ADMIN, runId, JSON.stringify({ image: proposal.url })],
        );

        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(3);
        for (const [row, reason] of [
          [settings, "in_use"],
          [product, "in_use"],
          [proposal, "live_proposal"],
        ] as const) {
          expect(await mediaOf(row.id)).toMatchObject({ source: "upload" });
          expect(await logOf(row.id)).toMatchObject({
            outcome: "kept",
            reason,
            public_path: row.path,
            decided_at: expect.any(String),
          });
        }
        expect(storage.copies).toEqual([]);
        expect(storage.deleted).toEqual([]);
      });

      it("★ a picture two live chats name is kept as an upload", async () => {
        const { id, path, url } = await legacyRow();
        seedObject(path);
        await liveMessage(url);
        await liveMessage(url);
        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
        expect(await logOf(id)).toMatchObject({
          outcome: "kept",
          reason: "several_chats",
        });
        expect(await mediaOf(id)).toMatchObject({ source: "upload" });
        expect(storage.copies).toEqual([]);
      });

      it("★ a type the private store does not take, or a size outside 1 to 5 MB, is kept rather than moved", async () => {
        const pdf = await legacyRow({ contentType: "application/pdf" });
        seedObject(pdf.path);
        await liveMessage(pdf.url);
        const big = await legacyRow();
        seedObject(big.path, { size: FIVE_MB + 1 });
        await liveMessage(big.url);
        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(2);
        for (const row of [pdf, big]) {
          expect(await logOf(row.id)).toMatchObject({
            outcome: "kept",
            reason: "not_movable",
          });
          expect(await mediaOf(row.id)).toMatchObject({ source: "upload" });
        }
        expect(storage.copies).toEqual([]);
      });

      it("★ a copy whose size differs keeps the public file, discards the copy and waits", async () => {
        const { id, path, url } = await legacyRow();
        seedObject(path);
        await liveMessage(url);
        storage.corruptCopy = true;
        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
        expect(await logOf(id)).toMatchObject({
          outcome: "failing",
          reason: "copy_mismatch",
          attempts: 1,
          decided_at: null,
        });
        expect(await mediaOf(id)).toMatchObject({ source: "mink_attachment" });
        const privatePath = privatePathOf(storeId, id);
        expect(storage.copies).toEqual([privatePath]);
        expect(storage.deletes).toEqual([
          { kind: "private", path: privatePath },
        ]);
        expect(storage.objects.has(`public:${path}`)).toBe(true);
        expect(
          await count("select count(*) from mink_attachments where id = $1", [
            id,
          ]),
        ).toBe(0);
      });

      it("★ a chat another session holds: the copy is discarded and the picture waits (chat_busy)", async () => {
        const { id, path, url } = await legacyRow();
        seedObject(path);
        const conversationId = await liveMessage(url);
        // Advisory locks are reentrant within a session, so contention needs
        // a second connection holding the chat's key.
        const other = new Client({
          host: "127.0.0.1",
          port: 5544,
          database: "storemink_local",
          user: process.env.USER,
        });
        await other.connect();
        try {
          await other.query(
            "select pg_advisory_lock(hashtextextended($1, 0))",
            [`mink-conversation:${conversationId}`],
          );
          await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
        } finally {
          await other.query("select pg_advisory_unlock_all()");
          await other.end();
        }
        expect(await logOf(id)).toMatchObject({
          outcome: "failing",
          reason: "chat_busy",
          attempts: 1,
          decided_at: null,
        });
        expect(await mediaOf(id)).toMatchObject({ source: "mink_attachment" });
        expect(storage.deletes).toEqual([
          { kind: "private", path: privatePathOf(storeId, id) },
        ]);
        expect(
          await count("select count(*) from mink_attachments where id = $1", [
            id,
          ]),
        ).toBe(0);
        expect(await messagesNaming(conversationId, url)).toBe(1);
      });

      it("★ a public delete that fails after the link: the move stays committed, recorded delete_failed", async () => {
        const { id, path, url } = await legacyRow();
        seedObject(path);
        const conversationId = await liveMessage(url);
        storage.fail.add(path);
        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
        expect(await logOf(id)).toMatchObject({
          outcome: "failing",
          reason: "delete_failed",
          attempts: 1,
        });
        // The move landed: the private row, the rewritten chat, the row kept.
        expect(await rowOf(id)).toMatchObject({
          conversation_id: conversationId,
          linked_at: expect.any(String),
        });
        expect(
          await messagesNaming(conversationId, `/api/mink/attachments/${id}`),
        ).toBe(1);
        expect(await messagesNaming(conversationId, url)).toBe(0);
        expect(await mediaOf(id)).toMatchObject({ source: "mink_attachment" });
      });

      it("★ no live chat: the public file and the row go; a private leftover goes only when no private row holds the id", async () => {
        const gone = await legacyRow({ createdDaysAgo: 4 });
        seedObject(gone.path);
        const dead = await liveMessage(gone.url);
        await expireChat(dead);
        const held = await legacyRow({ createdDaysAgo: 3 });
        seedObject(held.path);
        await insertAttachment({
          id: held.id,
          path: privatePathOf(storeId, held.id),
        });

        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(2);
        for (const row of [gone, held]) {
          expect(await mediaOf(row.id)).toBeUndefined();
          expect(await logOf(row.id)).toMatchObject({
            outcome: "deleted",
            reason: "no_live_use",
            public_path: row.path,
            decided_at: expect.any(String),
          });
        }
        expect(storage.deletes).toEqual([
          { kind: "public", path: gone.path },
          { kind: "private", path: privatePathOf(storeId, gone.id) },
          { kind: "public", path: held.path },
        ]);
        expect(await rowOf(held.id)).toBeDefined();
      });

      it("★★ end to end on this database's one legacy row: copied, linked under the chat's lock, the chat rewritten, the public file deleted, recorded moved", async () => {
        await client.query(
          "update media_assets set source = 'mink_attachment' where id = $1",
          [LEGACY_ID],
        );
        const { rows } = await client.query(
          "select store_id, url, path, filename, content_type, size_bytes from media_assets where id = $1",
          [LEGACY_ID],
        );
        const row = rows[0] as {
          store_id: string;
          url: string;
          path: string;
          filename: string;
          content_type: string;
          size_bytes: number;
        };
        expect(row).toMatchObject({
          store_id: LEGACY_STORE,
          content_type: "image/webp",
        });
        expect(await messagesNaming(LEGACY_CHAT, row.url)).toBe(1);
        seedObject(row.path, { size: Number(row.size_bytes) });

        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);

        const privatePath = privatePathOf(LEGACY_STORE, LEGACY_ID);
        const { rows: linked } = await client.query(
          "select store_id, admin_id, conversation_id, linked_at, path, filename, content_type, size_bytes from mink_attachments where id = $1",
          [LEGACY_ID],
        );
        expect(linked[0]).toMatchObject({
          store_id: LEGACY_STORE,
          admin_id: LEGACY_ADMIN,
          conversation_id: LEGACY_CHAT,
          linked_at: expect.any(String),
          path: privatePath,
          filename: row.filename,
          content_type: "image/webp",
          size_bytes: Number(row.size_bytes),
        });
        expect(
          await messagesNaming(
            LEGACY_CHAT,
            `/api/mink/attachments/${LEGACY_ID}`,
          ),
        ).toBe(1);
        expect(
          await count(
            "select count(*) from mink_messages where store_id = $1 and strpos(content_json->>'text', $2) > 0",
            [LEGACY_STORE, row.url],
          ),
        ).toBe(0);
        expect(await mediaOf(LEGACY_ID)).toBeUndefined();
        const { rows: records } = await client.query(
          "select outcome, reason, public_path, store_id, attempts, decided_at from mink_attachment_legacy_log where media_asset_id = $1",
          [LEGACY_ID],
        );
        expect(records[0]).toMatchObject({
          outcome: "moved",
          reason: "moved_with_chat",
          public_path: row.path,
          store_id: LEGACY_STORE,
          attempts: 1,
          decided_at: expect.any(String),
        });
        expect(storage.copies).toEqual([privatePath]);
        expect(storage.deletes).toEqual([{ kind: "public", path: row.path }]);
        expect(storage.objects.has(`private:${privatePath}`)).toBe(true);
        expect(storage.objects.has(`public:${row.path}`)).toBe(false);
        // The owner's progress signal: nothing left, nothing given up.
        expect((await execute(legacyProgressSql())).rows[0]).toMatchObject({
          left: 0,
          given_up: 0,
        });
      });
    });
  },
);
