/** Rollback-only checks, against local Postgres, of the archive and the
 * console reads (takedown stage T13, design 3.6, 5.2, 5.4, 6.1 to 6.7, 8.2;
 * plan Part E2 row 6), through the real functions and the real triggers:
 *
 * - the nightly purge empties a due archive, deletes its objects by
 *   generation and records it; it never takes an archive whose `keep_until`
 *   has not come, one on legal hold, one of a store under an investigation
 *   hold, one whose block is restoring a file, or one whose files are still
 *   being copied;
 * - an archive naming another database's folder is skipped, nothing is
 *   deleted, the row is left as it was and the skip is recorded
 *   (`archive_purge_skipped`); a storage failure leaves the row for the next
 *   night;
 * - `moderation_prune_events` removes an old record only once its archive is
 *   purged, and never a held archive's or a held store's;
 * - complaint erasure (T10's `eraseResolvedComplaints`) skips a complaint
 *   whose block's archive is on legal hold until the hold is released.
 *   (Block erasure, `eraseLiftedBlocks`, is built in stage T14a and covered by
 *   `follow-ups.local.test.ts`.)
 * - keeping a copy longer, a legal hold and its release go through the
 *   archive guard; opening a copy needs the receipt `recordArchiveView`
 *   writes;
 * - the console reads run against the real schema: the next-deadline SQL
 *   agrees with `nextDeadline` for each kind, the block views and the store
 *   card read what they say, and `resolveTarget` resolves a suspended
 *   store's address, warns about the homepage and refuses a Theme Studio
 *   preview store.
 *
 * Run with MODERATION_LOCAL_TEST=1 after `npm run db:migrate:local -- apply`
 * (migration 20261030_0269_content_takedown). The fixed loopback database
 * keeps it away from Cloud SQL; everything happens inside one transaction
 * that is rolled back, each case in its own savepoint. The code under test
 * runs as `app_service`, the role `withService` takes in production; fixtures
 * with past times are written as the connecting user. Nothing reaches a
 * network or a bucket: `fetch` and every storage client throw, and the purge
 * is given an in-memory storage. `DB_NAME` is pinned to `storemink_local`, so
 * that is "this database's" archive folder.
 *
 * Every time written here is the same `now()` (one transaction).
 */
import { createHash } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
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
    const name = `t13_scope_${++service.count}`;
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
vi.mock("@/lib/storage/gcs", () => {
  const offline = () => {
    throw new Error("No storage in this test.");
  };
  return {
    GCS_BUCKET_NAME: "sm-local-media",
    GCS_PRIVATE_BUCKET_NAME: "sm-local-private",
    gcsPublicUrl: (path: string) =>
      `https://storage.googleapis.com/sm-local-media/${path}`,
    gcsObjectMetadata: vi.fn(offline),
    gcsCopyObject: vi.fn(offline),
    gcsUploadObject: vi.fn(offline),
    gcsPrivateUploadObject: vi.fn(offline),
    gcsDownloadObject: vi.fn(offline),
    gcsDeleteGeneration: vi.fn(offline),
    gcsDeletePaths: vi.fn(offline),
  };
});
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { ROOT_DOMAIN } from "@/lib/store/host";
import { canonicalJson } from "@/lib/themes/canonical-json";
import type { ModerationStorage } from "./storage";
import {
  ARCHIVE_ERRORS,
  extendArchive,
  keepUntilTooEarly,
  purgeDueArchives,
  recordArchiveView,
  releaseArchiveHold,
  type ArchivePurgeRun,
} from "./archive";
import {
  TARGET_ERRORS,
  complaintNextDueSql,
  consoleCounts,
  getArchiveForViewing,
  getBlock,
  listBlocks,
  listComplaints,
  moderationQueueSql,
  resolveTarget,
  storeModerationSummary,
} from "./console-read";
import { eraseResolvedComplaints } from "./complaints";
import { STORE_DELETE_REFUSALS } from "./holds";
import { nextDeadline } from "./deadlines";
import { COMPLAINT_KINDS, type ComplaintKind } from "./kinds";

const enabled = process.env.MODERATION_LOCAL_TEST === "1";

const MIGRATION = "20261030_0269_content_takedown";
const DB = "storemink_local";
const OTHER_DB = "storemink_staging";
const ECHO_SLUG = "echo";
const PREVIEW_SLUG = "studio-preview-67bd33696c6b";
const CASE_MS = 30_000;
const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const SUPER = {
  email: `t13-${tag}-super@probe.test`,
  role: "superadmin" as const,
};
const OTHER_SUPER = {
  email: `t13-${tag}-other@probe.test`,
  role: "superadmin" as const,
};

type Row = Record<string, unknown>;

/** An in-memory private bucket: records every delete, fails the paths asked. */
class MemoryStorage implements ModerationStorage {
  deleted: Array<{ path: string; generation: string | null }> = [];
  failPaths = new Set<string>();
  bucketName() {
    return "sm-local-private";
  }
  async objectMetadata(): Promise<never> {
    throw new Error("not used");
  }
  async copyObject(): Promise<never> {
    throw new Error("not used");
  }
  async uploadPublic(): Promise<never> {
    throw new Error("not used");
  }
  async uploadPrivate(): Promise<never> {
    throw new Error("not used");
  }
  async downloadObject(): Promise<never> {
    throw new Error("not used");
  }
  async deleteGeneration(
    _kind: string,
    path: string,
    generation: string | number,
  ): Promise<"deleted" | "missing"> {
    if (this.failPaths.has(path)) throw new Error("delete refused");
    this.deleted.push({ path, generation: String(generation) });
    return "deleted";
  }
  async deletePaths(_kind: string, paths: string[]): Promise<string[]> {
    const failed = paths.filter((path) => this.failPaths.has(path));
    for (const path of paths) {
      if (!this.failPaths.has(path)) {
        this.deleted.push({ path, generation: null });
      }
    }
    return failed;
  }
  async fetch(): Promise<never> {
    throw new Error("No network in this test.");
  }
  async readBundledFile(): Promise<never> {
    throw new Error("not used");
  }
  async placeholder(): Promise<never> {
    throw new Error("not used");
  }
  now() {
    return new Date();
  }
}

describe.skipIf(!enabled)(
  "the archive and the console reads (local database)",
  () => {
    let client: Client;
    let echoId = "";
    let productId = "";
    let productSlug = "";
    let previewExists = false;

    const one = async (text: string, params: unknown[] = []) =>
      ((await client.query(text, params)).rows[0] ?? null) as Row | null;
    const all = async (text: string, params: unknown[] = []) =>
      (await client.query(text, params)).rows as Row[];

    /** One statement that must be refused, in its own savepoint. */
    async function refused(
      text: string,
      params: unknown[] = [],
    ): Promise<{ code: string; message: string } | null> {
      await client.query("SAVEPOINT t13_refusal");
      try {
        await client.query(text, params);
        return null;
      } catch (error) {
        const e = error as { code?: string; message: string };
        return { code: e.code ?? "", message: e.message };
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT t13_refusal");
        await client.query("RELEASE SAVEPOINT t13_refusal");
      }
    }

    const archivePath = (database: string, blockId: string, name: string) =>
      `takedown-archive/${database}/${blockId}/${name}`;

    function fileEntry(n: number, path: string, generation: string | null) {
      return {
        n,
        source: "bucket",
        path: `stores/${echoId}/media/t13-${tag}-${n}.webp`,
        state: "copied",
        sourceBucket: "sm-local-media",
        sourceGeneration: "100",
        archivePath: path,
        archiveGeneration: generation,
        size: 10,
        contentType: "image/webp",
        md5: "bWQ1",
        crc32c: "Y3Jj",
        sha256: null,
        cacheControl: null,
        at: "2026-04-01T00:00:00.000Z",
      };
    }

    let fileCount = 0;

    /** A live file block (and its archive) with the shape asked. */
    async function fileBlock(
      options: {
        storeId?: string | null;
        lifted?: boolean;
        storageState?: string;
        complaintId?: string | null;
      } = {},
    ): Promise<string> {
      fileCount += 1;
      const lifted = options.lifted ?? false;
      const row = await one(
        `insert into public.content_blocks
           (store_id, store_label, item_kind, object_path, file_source,
            item_label, reason_kind, store_message, blocked_by,
            storage_state, lifted_at, lifted_by, complaint_id)
         values ($1, 'echo', 'file', $2, 'bucket', 'A photo', 'terms_breach',
                 'We blocked this.', $3, $4,
                 ${lifted ? "now()" : "null"}, ${lifted ? "$3" : "null"}, $5)
         returning id`,
        [
          options.storeId ?? null,
          `stores/t13-${tag}/media/photo-${fileCount}.webp`,
          SUPER.email,
          options.storageState ?? (lifted ? "restored" : "replaced"),
          options.complaintId ?? null,
        ],
      );
      return String(row?.id);
    }

    /** An archive created 200 days ago, due 20 days ago unless told otherwise. */
    async function archive(
      blockId: string,
      options: {
        storeId?: string | null;
        files?: unknown[];
        filesState?: string;
        keepFuture?: boolean;
        held?: boolean;
        snapshot?: unknown;
      } = {},
    ): Promise<string> {
      const snapshot = options.snapshot ?? { kind: "file", block: blockId };
      const sha = createHash("sha256")
        .update(canonicalJson(snapshot))
        .digest("hex");
      const row = await one(
        `insert into public.content_block_archives
           (block_id, store_id, snapshot, snapshot_sha256, files, files_state,
            created_at, keep_until, legal_hold, legal_hold_set_at,
            legal_hold_set_by, legal_hold_note)
         values ($1, $2, $3::jsonb, $4, $5::jsonb, $6,
                 now() - interval '4900 hours',
                 case when $7::boolean then now() + interval '720 hours'
                      else now() - interval '480 hours' end,
                 $8::boolean,
                 case when $8::boolean then now() end,
                 case when $8::boolean then $9::text end,
                 case when $8::boolean then 'Police notice' else '' end)
         returning id`,
        [
          blockId,
          options.storeId ?? null,
          JSON.stringify(snapshot),
          sha,
          JSON.stringify(options.files ?? []),
          options.filesState ?? "copied",
          options.keepFuture ?? false,
          options.held ?? false,
          SUPER.email,
        ],
      );
      return String(row?.id);
    }

    async function archiveRow(id: string) {
      return one(
        `select purged_at, snapshot, files, legal_hold, keep_until
           from public.content_block_archives where id = $1`,
        [id],
      );
    }

    async function events(blockId: string) {
      return all(
        `select action, actor, detail from public.moderation_events
          where block_id = $1 order by action`,
        [blockId],
      );
    }

    async function purge(
      storage: ModerationStorage,
      run: ArchivePurgeRun = {},
    ) {
      run.skip ??= new Set<string>();
      const handled = await purgeDueArchives(50, run, { storage });
      return { handled, run };
    }

    beforeAll(async () => {
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
      service.client = client;
      service.db = drizzle(client, { schema: { ...schema, ...relations } });
      vi.stubEnv("DB_NAME", DB);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("No network in this test.");
        }),
      );
      const ledger = await one(
        "select 1 as ok from public.schema_migrations where id = $1",
        [MIGRATION],
      );
      if (!ledger) {
        throw new Error(
          `${MIGRATION} is not applied to storemink_local: run npm run db:migrate:local -- apply first.`,
        );
      }
      const echo = await one("select id from public.stores where slug = $1", [
        ECHO_SLUG,
      ]);
      if (!echo) throw new Error("The local store echo is missing.");
      echoId = String(echo.id);
      const product = await one(
        `select id, slug from public.products
          where store_id = $1 and status = 'published'
            and moderation_blocked_at is null
          order by created_at, id limit 1`,
        [echoId],
      );
      if (!product) throw new Error("echo has no published product.");
      productId = String(product.id);
      productSlug = String(product.slug);
      previewExists = Boolean(
        await one(
          "select 1 from public.stores where slug = $1 and settings ? 'studioPreview'",
          [PREVIEW_SLUG],
        ),
      );
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      if (!client) return;
      await client.query("ROLLBACK");
      await client.end();
    });

    beforeEach(async () => {
      await client.query("SAVEPOINT t13_case");
    });
    afterEach(async () => {
      await client.query("ROLLBACK TO SAVEPOINT t13_case");
      await client.query("RELEASE SAVEPOINT t13_case");
    });

    // ── The nightly purge ─────────────────────────────────────────────────

    it(
      "purges a due archive: the row is emptied (its hash kept), its objects deleted by generation, and the purge recorded",
      async () => {
        const blockId = await fileBlock();
        const pinned = archivePath(DB, blockId, "0-photo.webp");
        const unpinned = archivePath(DB, blockId, "1-other.webp");
        const id = await archive(blockId, {
          files: [
            fileEntry(0, pinned, "1700000000000001"),
            fileEntry(1, unpinned, null),
          ],
        });
        const before = await one(
          "select snapshot_sha256 from public.content_block_archives where id = $1",
          [id],
        );
        const storage = new MemoryStorage();
        const { handled, run } = await purge(storage);
        expect(handled).toBeGreaterThanOrEqual(1);
        expect(run.skip?.has(id)).toBe(false);

        const row = await one(
          `select purged_at, snapshot, files, snapshot_sha256
             from public.content_block_archives where id = $1`,
          [id],
        );
        expect(row?.purged_at).not.toBeNull();
        expect(row?.snapshot).toBeNull();
        expect(row?.files).toEqual([]);
        expect(row?.snapshot_sha256).toBe(before?.snapshot_sha256);
        expect(storage.deleted).toEqual(
          expect.arrayContaining([
            { path: pinned, generation: "1700000000000001" },
            { path: unpinned, generation: null },
          ]),
        );
        expect(await events(blockId)).toEqual([
          {
            action: "archive_purged",
            actor: "system",
            detail: { objects: 2, deleted: 2, missing: 0 },
          },
        ]);
        // Purged once is purged for good: the guard refuses a change back.
        expect(
          await refused(
            `update public.content_block_archives
                set purged_at = null, snapshot = '{}'::jsonb where id = $1`,
            [id],
          ),
        ).toMatchObject({ code: "P0001" });
      },
      CASE_MS,
    );

    it(
      "never takes an archive whose keep_until has not come, one on legal hold, one of a held store, one restoring, or one still being copied",
      async () => {
        const notDue = await archive(await fileBlock(), { keepFuture: true });
        const held = await archive(await fileBlock(), { held: true });
        const heldStoreBlock = await fileBlock({ storeId: echoId });
        const heldStore = await archive(heldStoreBlock, { storeId: echoId });
        await one(
          `insert into public.store_legal_holds
             (store_id, store_label, reason, set_by)
           values ($1, 'echo', 'Police notice', $2) returning id`,
          [echoId, SUPER.email],
        );
        const restoring = await archive(
          await fileBlock({ lifted: true, storageState: "restoring" }),
        );
        const copying = await archive(await fileBlock(), {
          filesState: "pending",
        });
        const due = await archive(await fileBlock());

        const storage = new MemoryStorage();
        const { run } = await purge(storage);
        for (const id of [notDue, held, heldStore, restoring, copying]) {
          expect((await archiveRow(id))?.purged_at).toBeNull();
          // ★ Not taken at all: not handled, not set aside, nothing recorded.
          expect(run.skip?.has(id)).toBe(false);
        }
        expect((await archiveRow(due))?.purged_at).not.toBeNull();
        expect(
          await all(
            `select a.id from public.content_block_archives a
               join public.moderation_events e on e.block_id = a.block_id
              where a.id = any($1::uuid[])`,
            [[notDue, held, heldStore, restoring, copying]],
          ),
        ).toEqual([]);
        expect(storage.deleted).toEqual([]);

        // The guard refuses a purge of the held copy and of the early one
        // whatever wrote it.
        for (const id of [held, notDue]) {
          expect(
            await refused(
              `update public.content_block_archives
                  set snapshot = null, files = '[]'::jsonb, purged_at = now()
                where id = $1`,
              [id],
            ),
          ).toMatchObject({ code: "P0001" });
        }
      },
      CASE_MS,
    );

    it(
      "skips an archive naming another database's folder: nothing deleted, the row as it was, the skip recorded",
      async () => {
        const blockId = await fileBlock();
        const mine = archivePath(DB, blockId, "0-photo.webp");
        const theirs = archivePath(OTHER_DB, blockId, "1-photo.webp");
        const id = await archive(blockId, {
          files: [fileEntry(0, mine, "11"), fileEntry(1, theirs, "12")],
        });
        const storage = new MemoryStorage();
        const { run } = await purge(storage);
        expect(run.skip?.has(id)).toBe(true);
        const row = await archiveRow(id);
        expect(row?.purged_at).toBeNull();
        expect(row?.snapshot).not.toBeNull();
        expect((row?.files as unknown[]).length).toBe(2);
        expect(storage.deleted).toEqual([]);
        expect(await events(blockId)).toEqual([
          {
            action: "archive_purge_skipped",
            actor: "system",
            detail: { reason: "other_database", databases: [OTHER_DB] },
          },
        ]);
        // The next batch of the same run does not take it again.
        const again = await purge(storage, run);
        expect(again.handled).toBe(0);
      },
      CASE_MS,
    );

    it(
      "leaves the row for the next night when a delete fails",
      async () => {
        const blockId = await fileBlock();
        const path = archivePath(DB, blockId, "0-photo.webp");
        const id = await archive(blockId, {
          files: [fileEntry(0, path, "21")],
        });
        const storage = new MemoryStorage();
        storage.failPaths.add(path);
        const { run } = await purge(storage);
        expect(run.skip?.has(id)).toBe(true);
        const row = await archiveRow(id);
        expect(row?.purged_at).toBeNull();
        expect(row?.snapshot).not.toBeNull();
        expect(await events(blockId)).toEqual([]);
      },
      CASE_MS,
    );

    // ── The record and the erasures ───────────────────────────────────────

    it(
      "moderation_prune_events removes an old record only once its archive is purged, never a held one's",
      async () => {
        const purgedBlock = await fileBlock();
        await archive(purgedBlock);
        const heldBlock = await fileBlock();
        await archive(heldBlock, { held: true });
        const keptBlock = await fileBlock();
        await archive(keptBlock, { keepFuture: true });
        for (const blockId of [purgedBlock, heldBlock, keptBlock]) {
          await one(
            `insert into public.moderation_events (at, actor, action, block_id, detail)
             values (now() - interval '400 days', $1, 'block_created', $2, '{}')
             returning id`,
            [SUPER.email, blockId],
          );
        }
        await purge(new MemoryStorage());

        await client.query("SET ROLE app_service");
        try {
          const pruned = await one(
            "select public.moderation_prune_events(now() - interval '1 year', 1000) as n",
          );
          expect(Number(pruned?.n)).toBeGreaterThanOrEqual(1);
          expect(
            await refused(
              "select public.moderation_prune_events(now() - interval '6 months', 10)",
            ),
          ).toMatchObject({ code: "P0001" });
        } finally {
          await client.query("RESET ROLE");
        }
        const left = async (blockId: string) =>
          (await events(blockId)).map((e) => e.action);
        // The purged archive's old event went; its fresh purge record stays.
        expect(await left(purgedBlock)).toEqual(["archive_purged"]);
        expect(await left(heldBlock)).toEqual(["block_created"]);
        expect(await left(keptBlock)).toEqual(["block_created"]);
      },
      CASE_MS,
    );

    it(
      "complaint erasure waits while the block's archive is on legal hold, and erases once it is released",
      async () => {
        // Received 1,200 days ago and resolved six days later, so it is
        // older than a three-year floor. Hours, never days: a day in a time
        // zone with a clock change is not 24 hours.
        const complaint = await one(
          `insert into public.grievance_complaints
             (received_at, channel, kind, complainant_name, complainant_contact,
              store_label, summary, acknowledge_due_at, action_due_at,
              resolve_due_at, resolved_at, resolved_by, outcome, created_by,
              created_at, updated_at)
           values (now() - interval '28800 hours', 'email', 'grievance',
                   'Asha Rao', 'asha@example.com', '', 'Probe',
                   now() - interval '28780 hours',
                   now() - interval '28700 hours',
                   now() - interval '28700 hours',
                   now() - interval '28656 hours', $1, 'answered', $1,
                   now() - interval '28800 hours',
                   now() - interval '28656 hours')
           returning id`,
          [SUPER.email],
        );
        const complaintId = String(complaint?.id);
        const blockId = await fileBlock({ complaintId });
        await archive(blockId, { keepFuture: true });
        expect(
          await extendArchive(
            blockId,
            { hold: true },
            "High Court order 7",
            SUPER,
          ),
        ).toMatchObject({ ok: true, legalHold: true });

        const floor = new Date(Date.now() - 1095 * 24 * 60 * 60 * 1000);
        await eraseResolvedComplaints(floor, 500);
        let row = await one(
          "select erased_at, complainant_name from public.grievance_complaints where id = $1",
          [complaintId],
        );
        expect(row?.erased_at).toBeNull();
        expect(row?.complainant_name).toBe("Asha Rao");

        expect(
          await releaseArchiveHold(blockId, "The order was set aside.", SUPER),
        ).toMatchObject({ ok: true });
        await eraseResolvedComplaints(floor, 500);
        row = await one(
          "select erased_at, complainant_name from public.grievance_complaints where id = $1",
          [complaintId],
        );
        expect(row?.erased_at).not.toBeNull();
        expect(row?.complainant_name).toBe("");
      },
      CASE_MS,
    );

    // ── Keeping a copy, and opening it ────────────────────────────────────

    it(
      "keeps a copy longer only to a later date, holds it, and releases the hold, each recorded",
      async () => {
        const blockId = await fileBlock();
        const id = await archive(blockId, { keepFuture: true });
        const current = String((await archiveRow(id))?.keep_until);

        expect(
          await extendArchive(blockId, { until: "2020-01-01" }, "Court", SUPER),
        ).toEqual({ ok: false, error: keepUntilTooEarly(current) });

        const later = await extendArchive(
          blockId,
          { until: "2031-03-31" },
          "Cyber cell, letter 44",
          SUPER,
        );
        expect(later).toMatchObject({ ok: true, legalHold: false });
        const kept = await one(
          "select keep_until = '2031-03-31 23:59:59+05:30'::timestamptz as same from public.content_block_archives where id = $1",
          [id],
        );
        expect(kept?.same).toBe(true);

        expect(
          await extendArchive(blockId, { hold: true }, "Police", SUPER),
        ).toMatchObject({ ok: true, legalHold: true });
        expect(
          await extendArchive(blockId, { hold: true }, "Police", SUPER),
        ).toEqual({ ok: false, error: ARCHIVE_ERRORS.alreadyHeld });
        expect(
          await releaseArchiveHold(blockId, "Closed.", SUPER),
        ).toMatchObject({ ok: true });
        expect(await releaseArchiveHold(blockId, "Again.", SUPER)).toEqual({
          ok: false,
          error: ARCHIVE_ERRORS.notHeld,
        });
        const row = await one(
          `select legal_hold, legal_hold_note, legal_hold_set_by
             from public.content_block_archives where id = $1`,
          [id],
        );
        expect(row).toMatchObject({
          legal_hold: false,
          legal_hold_note: "Police",
          legal_hold_set_by: SUPER.email,
        });
        expect((await events(blockId)).map((e) => e.action)).toEqual([
          "archive_hold_released",
          "archive_hold_set",
          "archive_kept_longer",
        ]);
      },
      CASE_MS,
    );

    it(
      "opens a copy only against the receipt of the operator who recorded why",
      async () => {
        const blockId = await fileBlock({ storeId: echoId });
        const snapshot = { kind: "file", note: "evidence", n: 1 };
        const path = archivePath(DB, blockId, "0-photo.webp");
        await archive(blockId, {
          storeId: echoId,
          keepFuture: true,
          snapshot,
          files: [fileEntry(0, path, "31")],
        });
        const receipt = await recordArchiveView(blockId, "Court asked", SUPER, {
          download: true,
          what: { file: 0 },
        });
        expect(receipt).toMatchObject({ ok: true, thisDatabase: true });
        if (!receipt.ok) throw new Error("expected a receipt");

        const opened = await getArchiveForViewing(
          blockId,
          { eventId: receipt.eventId },
          SUPER,
        );
        expect(opened).toMatchObject({
          ok: true,
          archive: { snapshot, hashMatches: true, storeId: echoId },
        });
        expect(
          await getArchiveForViewing(
            blockId,
            { eventId: receipt.eventId },
            OTHER_SUPER,
          ),
        ).toEqual({ ok: false, error: ARCHIVE_ERRORS.reasonMissing });

        const stale = await one(
          `insert into public.moderation_events (at, actor, action, block_id, detail)
           values (now() - interval '11 minutes', $1, 'archive_viewed', $2, '{}')
           returning id`,
          [SUPER.email, blockId],
        );
        expect(
          await getArchiveForViewing(
            blockId,
            { eventId: String(stale?.id) },
            SUPER,
          ),
        ).toEqual({ ok: false, error: ARCHIVE_ERRORS.reasonMissing });
        expect((await events(blockId)).map((e) => e.action)).toEqual([
          "archive_downloaded",
          "archive_viewed",
        ]);
      },
      CASE_MS,
    );

    // ── The console reads against the real schema ─────────────────────────

    it(
      "the next-deadline SQL agrees with nextDeadline for every kind, and the queues and counts run",
      async () => {
        // Acknowledged, not actioned: "act" passed an hour ago and "resolve"
        // is half an hour ahead, inside every kind's legal limit. The kinds
        // whose stages differ (a grievance has no "act"; an information order
        // and a data request no "resolve") then land on different sides of
        // now, so the SQL and nextDeadline must agree on each.
        const ids: Record<string, ComplaintKind> = {};
        for (const kind of COMPLAINT_KINDS) {
          const row = await one(
            `insert into public.grievance_complaints
               (received_at, channel, kind, complainant_name, complainant_contact,
                store_label, summary, acknowledge_due_at, action_due_at,
                resolve_due_at, acknowledged_at, acknowledged_by, created_by)
             values (now() - interval '2 hours', 'email', $1, 'A', 'a@example.com',
                     '', 'Probe', now() + interval '20 hours',
                     now() - interval '1 hour', now() + interval '30 minutes',
                     now() - interval '1 hour', $2, $2)
             returning id`,
            [kind, SUPER.email],
          );
          ids[String(row?.id)] = kind;
        }
        const ms = (column: string) =>
          sql.raw(`floor(extract(epoch from ${column}) * 1000)::bigint`);
        const rows = (
          await service.db!.execute(sql`
            select c.id, c.kind,
                   ${ms("c.received_at")} as received,
                   ${ms("c.acknowledge_due_at")} as ack_due,
                   ${ms("c.action_due_at")} as act_due,
                   ${ms("c.resolve_due_at")} as resolve_due,
                   ${ms("c.acknowledged_at")} as acknowledged,
                   floor(extract(epoch from ${complaintNextDueSql()}) * 1000)::bigint
                     as next_due
              from public.grievance_complaints c
             where c.id = any(${sql.param(Object.keys(ids))}::uuid[])
          `)
        ).rows as Row[];
        expect(rows).toHaveLength(COMPLAINT_KINDS.length);
        const now = new Date();
        const overdueIds = new Set<string>();
        for (const row of rows) {
          const at = (value: unknown) => new Date(Number(value));
          const expected = nextDeadline(
            {
              kind: row.kind as ComplaintKind,
              receivedAt: at(row.received),
              acknowledgeDueAt: at(row.ack_due),
              actionDueAt: at(row.act_due),
              resolveDueAt: at(row.resolve_due),
              acknowledgedAt: at(row.acknowledged),
              actionedAt: null,
              resolvedAt: null,
            },
            now,
          );
          expect(expected).not.toBeNull();
          expect(Number(row.next_due)).toBe(expected?.dueAt.getTime());
          if (expected?.overdue) overdueIds.add(String(row.id));
        }
        // A grievance's next deadline is "resolve", still ahead; the rest
        // are overdue on "act".
        expect(overdueIds.size).toBe(COMPLAINT_KINDS.length - 1);

        const overdue = await listComplaints({ view: "overdue", limit: 200 });
        const listed = new Set(overdue.rows.map((row) => row.id));
        for (const id of Object.keys(ids)) {
          expect(listed.has(id)).toBe(overdueIds.has(id));
        }

        const queues = moderationQueueSql();
        const counted = (
          await service.db!.execute(sql`
            select ${queues.complaintsDue} as due, ${queues.storeReplies} as replies,
                   ${queues.filesToFinish} as files, ${queues.holdsToReview} as holds
          `)
        ).rows[0] as Row;
        expect(Number(counted.due)).toBeGreaterThanOrEqual(
          COMPLAINT_KINDS.length - 1,
        );
        const counts = await consoleCounts();
        expect(counts.overdue).toBeGreaterThanOrEqual(
          COMPLAINT_KINDS.length - 1,
        );
      },
      CASE_MS,
    );

    it(
      "lists blocks by view, reads one block without its snapshot, and the store card says why Delete waits",
      async () => {
        const replying = await fileBlock({ storeId: echoId });
        await one(
          `insert into public.content_block_messages (block_id, from_side, author, body, asks_review)
           values ($1, 'store', 'owner@echo.test', 'Please look again.', true)
           returning id`,
          [replying],
        );
        const copying = await fileBlock({
          storeId: echoId,
          storageState: "pending",
        });
        await archive(copying, {
          storeId: echoId,
          keepFuture: true,
          filesState: "pending",
        });
        const lifted = await fileBlock({ storeId: echoId, lifted: true });

        const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));
        const replies = await listBlocks({ view: "replies", storeId: echoId });
        expect(ids(replies.rows).has(replying)).toBe(true);
        expect(ids(replies.rows).has(copying)).toBe(false);
        const files = await listBlocks({ view: "files", storeId: echoId });
        expect(files.rows.find((r) => r.id === copying)).toMatchObject({
          fileStage: "copying",
          archive: { filesState: "pending", total: 0 },
        });
        const liftedRows = await listBlocks({
          view: "lifted",
          storeId: echoId,
        });
        expect(ids(liftedRows.rows).has(lifted)).toBe(true);
        expect(liftedRows.total).toBeGreaterThanOrEqual(1);

        const page = await getBlock(copying);
        expect(page?.block).toMatchObject({
          id: copying,
          status: "blocked",
          store: { id: echoId, slug: ECHO_SLUG },
        });
        expect(page?.archive?.snapshotBytes).toBeGreaterThan(0);
        expect(page?.archive).not.toHaveProperty("snapshot");
        const replyPage = await getBlock(replying);
        expect(replyPage?.messages).toEqual([
          expect.objectContaining({ fromSide: "store", asksReview: true }),
        ]);

        expect(await storeModerationSummary(echoId)).toMatchObject({
          unfinishedArchives: 1,
          deleteRefusal: {
            reason: "archive",
            message: STORE_DELETE_REFUSALS.archive,
          },
        });
        await one(
          `insert into public.store_legal_holds (store_id, store_label, reason, set_by, review_on)
           values ($1, 'echo', 'Police notice', $2, current_date) returning id`,
          [echoId, SUPER.email],
        );
        expect(await storeModerationSummary(echoId)).toMatchObject({
          hold: { reason: "Police notice" },
          deleteRefusal: { reason: "hold" },
        });
      },
      CASE_MS,
    );

    it(
      "resolveTarget resolves a suspended store's address, warns about the homepage and refuses a preview store",
      async () => {
        await client.query(
          "update public.stores set status = 'suspended' where id = $1",
          [echoId],
        );
        const host = `${ECHO_SLUG}.${ROOT_DOMAIN}`;
        const product = await resolveTarget({
          address: `https://${host}/shop/${productSlug}`,
        });
        expect(product).toMatchObject({
          ok: true,
          found: "target",
          target: {
            kind: "product",
            itemId: productId,
            store: { id: echoId, status: "suspended" },
          },
        });

        const home = await resolveTarget({ address: `https://${host}/` });
        expect(home).toMatchObject({
          ok: true,
          target: { kind: "page", homepage: true, warnings: ["homepage"] },
        });

        const file = await resolveTarget({
          address: `https://storage.googleapis.com/sm-local-media/stores/${echoId}/media/missing.webp`,
        });
        expect(file).toMatchObject({
          ok: true,
          target: {
            kind: "file",
            store: { id: echoId },
            file: { source: "bucket", mediaAsset: null },
          },
        });

        const search = await resolveTarget({
          storeId: echoId,
          kind: "page",
          search: "faq",
        });
        expect(search).toMatchObject({ ok: true, found: "matches" });

        expect(
          await resolveTarget({ address: `https://${ROOT_DOMAIN}/pricing` }),
        ).toEqual({ ok: false, error: TARGET_ERRORS.notStore });

        if (previewExists) {
          expect(
            await resolveTarget({
              address: `https://${PREVIEW_SLUG}.${ROOT_DOMAIN}/`,
            }),
          ).toEqual({ ok: false, error: TARGET_ERRORS.preview });
        }
      },
      CASE_MS,
    );
  },
);
