/** Rollback-only checks, against local Postgres, of the legacy move's review
 * fixes (lib/mink/attachments-legacy.ts, storage review fix pass F2): the
 * private copy kept while a private row holds the id (R1), a chat with a
 * reply running (R6, at the chats read and under the chat's lock), a
 * proposal made while the copy ran (S7), the store usage read by path over
 * product descriptions and notification templates (S13), a copy an earlier
 * night left behind (R8) and the start record before the copy, the set-aside
 * clause of the candidates (R11) and the deadline (R2). Run with
 * MINK_ATTACHMENTS_LOCAL_TEST=1; the fixed loopback database keeps it away
 * from Cloud SQL, and everything happens inside one transaction that is
 * rolled back. Built like lib/mink/attachments.local.test.ts.
 *
 * ★ `withService` is mocked onto this file's one client (a savepoint per
 *   scope, as app_service, scopes one at a time) and both buckets are a
 *   recorder, so nothing reaches storage. The job runs only against the two
 *   real database names, so DB_NAME is stubbed to storemink_staging while
 *   the connection stays storemink_local; the private paths it writes carry
 *   that name, and everything rolls back.
 * ★ The recorder's `onCopy` hook runs between the copy and the link, outside
 *   any scope, which is how a reply or a proposal that starts while the copy
 *   runs is put in front of the re-read under the chat's lock.
 * ★ The legal hold (takedown stage T6c, decision D10, migration 0269
 *   applied): a held store's pictures are left where they are and the batch
 *   line counts them as `held`. */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
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
import type { Db } from "@/lib/db/client";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import { logInfo } from "@/lib/observability/logger";
import {
  legacyCandidatesSql,
  legacyStoreUsageSql,
  moveLegacyMinkAttachments,
  type MinkLegacyBatch,
} from "./attachments-legacy";

/** `withService` onto this file's one client, as attachments.local.test.ts does. */
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
    const name = `legacy_scope_${++service.count}`;
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

/** The real logger, with `logInfo` watched for the batch line. */
vi.mock("@/lib/observability/logger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/observability/logger")>();
  return { ...actual, logInfo: vi.fn(actual.logInfo) };
});

/**
 * Both buckets as a recorder, with the shared helper's shape
 * (`gcsObjectMetadata` answers `md5`). `onCopy` runs once the copy landed;
 * `copyThrowsAfterLanding` makes the copy land and then throw, an answer lost
 * after the bytes were written.
 */
const storage = vi.hoisted(() => ({
  deletes: [] as { kind: string; path: string }[],
  objects: new Map<
    string,
    { size: number; contentType: string; md5: string | null }
  >(),
  copies: [] as string[],
  copyThrowsAfterLanding: false,
  onCopy: null as null | (() => Promise<void>),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsPrivateConfigured: true,
  gcsPrivateUploadObject: vi.fn(async () => undefined),
  gcsDeletePaths: vi.fn(async (paths: string[], kind = "public") => {
    for (const path of paths) {
      storage.deletes.push({ kind, path });
      storage.objects.delete(`${kind}:${path}`);
    }
    return [];
  }),
  gcsObjectMetadata: vi.fn(
    async (kind: string, path: string) =>
      storage.objects.get(`${kind}:${path}`) ?? null,
  ),
  gcsCopyObject: vi.fn(
    async (
      fromKind: string,
      fromPath: string,
      toKind: string,
      toPath: string,
    ) => {
      const source = storage.objects.get(`${fromKind}:${fromPath}`);
      if (!source) throw new Error("source missing");
      storage.copies.push(toPath);
      storage.objects.set(`${toKind}:${toPath}`, { ...source });
      if (storage.onCopy) await storage.onCopy();
      if (storage.copyThrowsAfterLanding) throw new Error("answer lost");
    },
  ),
}));

const MIGRATION = "20261028_0262_mink_attachments_private";
const LEGACY_DATABASE = "storemink_staging";
const ADMIN = "legacy-fixes-owner";
const MD5 = "legacy-md5==";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const enabled = process.env.MINK_ATTACHMENTS_LOCAL_TEST === "1";
describe.skipIf(!enabled)(
  "the legacy move's review fixes on local Postgres",
  () => {
    let client: Client;
    let storeId: string;
    let otherStoreId: string;

    beforeAll(async () => {
      vi.stubEnv("DB_NAME", LEGACY_DATABASE);
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
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
      await client.query("SAVEPOINT legacy_fixture");
      storeId = crypto.randomUUID();
      otherStoreId = crypto.randomUUID();
      for (const id of [storeId, otherStoreId]) {
        await client.query(
          "insert into stores(id,slug,name,status,plan,settings) values($1,$2,'Lumen','active','pro',$3)",
          [id, `legacy-fixes-${id}`, { brand: { name: "Lumen" } }],
        );
      }
      // The rows this database already holds stay out of every case.
      await client.query(
        "update media_assets set source = 'upload' where source = 'mink_attachment'",
      );
      storage.deletes.length = 0;
      storage.copies.length = 0;
      storage.objects.clear();
      storage.copyThrowsAfterLanding = false;
      storage.onCopy = null;
    });

    afterEach(async () => {
      await client.query("ROLLBACK TO SAVEPOINT legacy_fixture");
      await client.query("RELEASE SAVEPOINT legacy_fixture");
      await client.query("RESET ROLE");
    });

    // -------------------------------------------------------------------------
    // Fixtures and probes.
    // -------------------------------------------------------------------------

    const daysAgo = (days: number) =>
      new Date(Date.now() - days * DAY_MS).toISOString();
    /** The sweep's floor, as `sweepPolicy` passes it: 2 days ago. */
    const floor = () => daysAgo(2);
    const mediaUrl = (path: string) =>
      `https://storage.googleapis.com/storemink-media/${path}`;
    const privatePathOf = (id: string) =>
      `stores/${storeId}/mink-attachments/${LEGACY_DATABASE}/${id}.webp`;

    /** A public attachment row of the old shape, 3 days old. */
    async function legacyRow(): Promise<{
      id: string;
      path: string;
      url: string;
    }> {
      const id = crypto.randomUUID();
      const path = `stores/${storeId}/media/${id}.webp`;
      const url = mediaUrl(path);
      await client.query(
        `insert into media_assets(id,store_id,url,path,filename,content_type,size_bytes,source,created_at)
         values($1,$2,$3,$4,'old.webp','image/webp',5242,'mink_attachment',$5)`,
        [id, storeId, url, path, daysAgo(3)],
      );
      return { id, path, url };
    }

    function seedObject(kind: "public" | "private", path: string): void {
      storage.objects.set(`${kind}:${path}`, {
        size: 5242,
        contentType: "image/webp",
        md5: MD5,
      });
    }

    async function chat(): Promise<string> {
      const { rows } = await client.query(
        "insert into mink_conversations(store_id,admin_id,title) values($1,$2,'Chat') returning id",
        [storeId, ADMIN],
      );
      return rows[0].id as string;
    }

    async function run(
      conversationId: string,
      status: "succeeded" | "running" = "succeeded",
    ): Promise<string> {
      const { rows } = await client.query(
        `insert into mink_runs(store_id,conversation_id,requested_by,request_id,model,status,completed_at)
         values($1,$2,$3,gen_random_uuid(),'fixture',$4,case when $4 = 'running' then null else now() end)
         returning id`,
        [storeId, conversationId, ADMIN, status],
      );
      return rows[0].id as string;
    }

    /** A live chat of this store whose one message names `url`. */
    async function liveMessage(url: string): Promise<string> {
      const conversationId = await chat();
      const runId = await run(conversationId);
      await client.query(
        `insert into mink_messages(store_id,conversation_id,run_id,role,content_json)
         values($1,$2,$3,'user',$4)`,
        [
          storeId,
          conversationId,
          runId,
          { text: `Look at this ${url} please` },
        ],
      );
      return conversationId;
    }

    /** A proposal that can still be approved, naming `text`, in a live chat. */
    async function proposal(text: string): Promise<void> {
      const runId = await run(await chat());
      await client.query(
        `insert into mink_drafts(store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits)
         values($1,$2,$3,'coupon_create','coupon','Coupons','/dashboard/coupons','Proposal',$4::jsonb,1)`,
        [storeId, ADMIN, runId, JSON.stringify({ image: text })],
      );
    }

    /** A private row holding `id`, linked to a chat when one is given. */
    async function privateRow(id: string, conversationId?: string) {
      await client.query("SET ROLE app_service");
      try {
        await client.query(
          `insert into mink_attachments(id,store_id,admin_id,conversation_id,linked_at,path,filename,content_type,size_bytes)
           values($1,$2,$3,$4,$5,$6,'old.webp','image/webp',5242)`,
          [
            id,
            storeId,
            ADMIN,
            conversationId ?? null,
            conversationId ? new Date().toISOString() : null,
            privatePathOf(id),
          ],
        );
      } finally {
        await client.query("RESET ROLE");
      }
    }

    async function logRow(
      mediaId: string,
      publicPath: string,
      attempts: number,
    ): Promise<void> {
      await client.query(
        `insert into mink_attachment_legacy_log(media_asset_id,store_id,public_path,outcome,reason,attempts,last_attempt_at)
         values($1,$2,$3,'failing','copy_failed',$4,$5)`,
        [
          mediaId,
          storeId,
          publicPath,
          attempts,
          new Date(Date.now() - 30 * HOUR_MS).toISOString(),
        ],
      );
    }

    async function logOf(mediaId: string) {
      const { rows } = await client.query(
        "select outcome, reason, attempts, decided_at from mink_attachment_legacy_log where media_asset_id = $1",
        [mediaId],
      );
      return rows[0] as
        | {
            outcome: string;
            reason: string;
            attempts: number;
            decided_at: string | null;
          }
        | undefined;
    }

    async function mediaOf(id: string) {
      const { rows } = await client.query(
        "select source from media_assets where id = $1",
        [id],
      );
      return rows[0] as { source: string } | undefined;
    }

    async function count(text: string, values: unknown[]): Promise<number> {
      const { rows } = await client.query(text, values);
      return Number(rows[0].count);
    }

    const privateRows = (id: string) =>
      count("select count(*) from mink_attachments where id = $1", [id]);
    const messagesNaming = (conversationId: string, text: string) =>
      count(
        "select count(*) from mink_messages where conversation_id = $1 and strpos(content_json->>'text', $2) > 0",
        [conversationId, text],
      );
    const privateDeletes = () =>
      storage.deletes.filter((entry) => entry.kind === "private");

    async function execute(query: Parameters<Db["execute"]>[0]) {
      await client.query("SET ROLE app_service");
      try {
        return await service.db!.execute(query);
      } finally {
        await client.query("RESET ROLE");
      }
    }

    // -------------------------------------------------------------------------

    it("★ R1: a chat another session holds, with a private row already holding the id: the copy is kept, the picture waits", async () => {
      const { id, path, url } = await legacyRow();
      seedObject("public", path);
      const conversationId = await liveMessage(url);
      await privateRow(id, conversationId);
      const other = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.USER,
      });
      await other.connect();
      try {
        await other.query("select pg_advisory_lock(hashtextextended($1, 0))", [
          `mink-conversation:${conversationId}`,
        ]);
        await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
      } finally {
        await other.query("select pg_advisory_unlock_all()");
        await other.end();
      }
      expect(privateDeletes()).toEqual([]);
      expect(storage.objects.has(`private:${privatePathOf(id)}`)).toBe(true);
      expect(await privateRows(id)).toBe(1);
      expect(await logOf(id)).toMatchObject({
        outcome: "failing",
        reason: "chat_busy",
        attempts: 1,
        decided_at: null,
      });
      expect(await mediaOf(id)).toMatchObject({ source: "mink_attachment" });
    });

    it("★ R6: a reply running in the chat: the picture waits a night with nothing copied and no attempt counted, then moves once the reply ends", async () => {
      const { id, path, url } = await legacyRow();
      seedObject("public", path);
      const conversationId = await liveMessage(url);
      const replyId = await run(conversationId, "running");

      await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
      expect(await logOf(id)).toMatchObject({
        outcome: "failing",
        reason: "chat_busy",
        attempts: 0,
        decided_at: null,
      });
      expect(storage.copies).toEqual([]);
      expect(storage.deletes).toEqual([]);
      expect(await messagesNaming(conversationId, url)).toBe(1);
      expect(await mediaOf(id)).toMatchObject({ source: "mink_attachment" });

      // Waiting its 20 hours, the picture is no candidate.
      await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(0);

      // The reply ended and the backoff passed: the move counts one attempt.
      await client.query(
        "update mink_runs set status = 'succeeded', completed_at = now() where id = $1",
        [replyId],
      );
      await client.query(
        "update mink_attachment_legacy_log set last_attempt_at = now() - interval '21 hours' where media_asset_id = $1",
        [id],
      );
      await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
      expect(await logOf(id)).toMatchObject({
        outcome: "moved",
        reason: "moved_with_chat",
        attempts: 1,
      });
      expect(await privateRows(id)).toBe(1);
      expect(
        await messagesNaming(conversationId, `/api/mink/attachments/${id}`),
      ).toBe(1);
    });

    it("★ R6: a reply that starts while the copy runs is seen under the chat's lock: the copy is discarded, nothing linked, no attempt counted", async () => {
      const { id, path, url } = await legacyRow();
      seedObject("public", path);
      const conversationId = await liveMessage(url);
      storage.onCopy = async () => {
        await run(conversationId, "running");
      };
      await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
      expect(await logOf(id)).toMatchObject({
        outcome: "failing",
        reason: "chat_busy",
        attempts: 0,
      });
      expect(privateDeletes()).toEqual([
        { kind: "private", path: privatePathOf(id) },
      ]);
      expect(await privateRows(id)).toBe(0);
      expect(await messagesNaming(conversationId, url)).toBe(1);
      expect(storage.objects.has(`public:${path}`)).toBe(true);
    });

    it("★ S7: a proposal made while the copy ran keeps the picture as an upload; the copy is discarded", async () => {
      const { id, path, url } = await legacyRow();
      seedObject("public", path);
      const conversationId = await liveMessage(url);
      storage.onCopy = async () => {
        await proposal(url);
      };
      await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
      expect(await logOf(id)).toMatchObject({
        outcome: "kept",
        reason: "live_proposal",
        decided_at: expect.any(String),
      });
      expect(await mediaOf(id)).toMatchObject({ source: "upload" });
      expect(privateDeletes()).toEqual([
        { kind: "private", path: privatePathOf(id) },
      ]);
      expect(await privateRows(id)).toBe(0);
      expect(await messagesNaming(conversationId, url)).toBe(1);
      expect(storage.objects.has(`public:${path}`)).toBe(true);
    });

    it("★ S13: a product description or a notification template naming the picture by path, in another host form, keeps it", async () => {
      const described = await legacyRow();
      seedObject("public", described.path);
      await client.query(
        "insert into products(store_id,name,slug,description) values($1,'Shake','shake',$2)",
        [
          storeId,
          `<p><img src="https://cdn.example.com/${described.path}?w=400"></p>`,
        ],
      );
      const templated = await legacyRow();
      seedObject("public", templated.path);
      await client.query(
        "insert into notification_settings(store_id,event_key,templates) values($1,'order.placed',$2::jsonb)",
        [
          storeId,
          JSON.stringify({
            customer: {
              body: `<img src="https://storage.cloud.google.com/storemink-media/${templated.path}">`,
            },
          }),
        ],
      );
      // Each surface alone, by path; another store's use says nothing.
      expect(
        (await execute(legacyStoreUsageSql(storeId, described.path))).rows[0]
          ?.used,
      ).toBe(true);
      expect(
        (await execute(legacyStoreUsageSql(storeId, templated.path))).rows[0]
          ?.used,
      ).toBe(true);
      expect(
        (await execute(legacyStoreUsageSql(otherStoreId, described.path)))
          .rows[0]?.used,
      ).toBe(false);

      await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(2);
      for (const row of [described, templated]) {
        expect(await logOf(row.id)).toMatchObject({
          outcome: "kept",
          reason: "in_use",
        });
        expect(await mediaOf(row.id)).toMatchObject({ source: "upload" });
      }
      expect(storage.copies).toEqual([]);
      expect(storage.deletes).toEqual([]);
    });

    it("★ R8: a failing record and a private object no row holds: the object goes before the keep; one a row holds stays", async () => {
      const loose = await legacyRow();
      seedObject("public", loose.path);
      seedObject("private", privatePathOf(loose.id));
      await logRow(loose.id, loose.path, 3);
      const held = await legacyRow();
      seedObject("public", held.path);
      seedObject("private", privatePathOf(held.id));
      await logRow(held.id, held.path, 3);
      await privateRow(held.id);

      await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(2);
      expect(privateDeletes()).toEqual([
        { kind: "private", path: privatePathOf(loose.id) },
      ]);
      expect(storage.objects.has(`private:${privatePathOf(held.id)}`)).toBe(
        true,
      );
      for (const row of [loose, held]) {
        expect(await logOf(row.id)).toMatchObject({
          outcome: "kept",
          reason: "gave_up",
          attempts: 4,
        });
      }
    });

    it("★ R8 and C8: a copy that lands and then throws leaves a counted record and no copy behind", async () => {
      const { id, path, url } = await legacyRow();
      seedObject("public", path);
      await liveMessage(url);
      storage.copyThrowsAfterLanding = true;
      await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
      expect(await logOf(id)).toMatchObject({
        outcome: "failing",
        reason: "copy_failed",
        attempts: 1,
        decided_at: null,
      });
      expect(privateDeletes()).toEqual([
        { kind: "private", path: privatePathOf(id) },
      ]);
      expect(storage.objects.has(`private:${privatePathOf(id)}`)).toBe(false);
      expect(await mediaOf(id)).toMatchObject({ source: "mink_attachment" });
    });

    it("★★ D10: a held store's picture is left where it is and the batch line counts it (held: 1); once released it is handled", async () => {
      const { id, path } = await legacyRow();
      seedObject("public", path);
      // As app_service, the role the takedown code writes holds with.
      await client.query("SET ROLE app_service");
      let holdId: string;
      try {
        const { rows } = await client.query(
          `insert into store_legal_holds(store_id,store_label,reason,set_by)
           values($1,'Lumen','A court order keeps this store as it is.','operator@storemink.com')
           returning id`,
          [storeId],
        );
        holdId = rows[0].id as string;
      } finally {
        await client.query("RESET ROLE");
      }

      await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(0);
      expect(storage.deletes).toEqual([]);
      expect(storage.copies).toEqual([]);
      expect(await logOf(id)).toBeUndefined();
      expect(await mediaOf(id)).toMatchObject({ source: "mink_attachment" });
      expect(logInfo).toHaveBeenCalledWith("mink.attachments: legacy batch", {
        kept: 0,
        moved: 0,
        deleted: 0,
        missing: 0,
        failed: 0,
        left: 1,
        givenUp: 0,
        held: 1,
      });

      await client.query(
        "update store_legal_holds set released_at = now(), released_by = 'operator@storemink.com' where id = $1",
        [holdId],
      );
      vi.mocked(logInfo).mockClear();
      await expect(moveLegacyMinkAttachments(floor(), 25)).resolves.toBe(1);
      // No live chat names it: the public file and the row go (a private
      // leftover at its id is cleared first, the job's own rule).
      expect(storage.deletes).toContainEqual({ kind: "public", path });
      expect(await mediaOf(id)).toBeUndefined();
      expect(logInfo).toHaveBeenCalledWith(
        "mink.attachments: legacy batch",
        expect.objectContaining({ deleted: 1, left: 0, held: 0 }),
      );
    });

    it("★ R11: the candidates leave out what the run set aside, as one uuid[] parameter", async () => {
      const aside = await legacyRow();
      const next = await legacyRow();
      const ids = async (skip: string[]) =>
        (await execute(legacyCandidatesSql(floor(), 25, skip))).rows
          .map((row) => (row as { id: string }).id)
          .sort();
      expect(await ids([])).toEqual([aside.id, next.id].sort());
      expect(await ids([aside.id])).toEqual([next.id]);
      expect(await ids([aside.id, next.id])).toEqual([]);
    });

    it("★ R2: a run inside the reserve of its deadline touches nothing and says it is out of time", async () => {
      const { id, path } = await legacyRow();
      seedObject("public", path);
      const batch: MinkLegacyBatch = { deadline: Date.now() + 5_000 };
      await expect(moveLegacyMinkAttachments(floor(), 25, batch)).resolves.toBe(
        0,
      );
      expect(batch.outOfTime).toBe(true);
      expect(await logOf(id)).toBeUndefined();
      expect(await mediaOf(id)).toMatchObject({ source: "mink_attachment" });
      expect(storage.deletes).toEqual([]);
    });
  },
);
