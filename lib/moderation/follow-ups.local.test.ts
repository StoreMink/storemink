/** Rollback-only checks, against local Postgres, of the every-minute
 * follow-ups and the block erasure (takedown stage T14a, design 8.1 and 8.2;
 * plan Part E2 row 6, the block half; E3 rows 21 and 22), through the real
 * SQL, the real triggers and the real CHECKs:
 *
 * - a pending file block is copied into its archive (claim, fenced settle,
 *   MD5 filled once, `archive_files_copied`), replaced in the same run
 *   (`storage_replaced`), and, once lifted, restored on the next run
 *   (`storage_restored`, the original bytes back); every claim the module
 *   makes carries `for update skip locked`, and the lift CHECK refuses a
 *   lifted row that is still pending;
 * - a block due in 30 seconds is copied but not replaced, and a lifted,
 *   cancelled block is never claimed (the claim's text carries
 *   `x.lifted_at is null`);
 * - the complaint-alert claim selects exactly the complaints `dueAlert` says
 *   are due, records each stage once with `complaint_alerted`, and a second
 *   run alerts nothing;
 * - a notice is retried with the bell only when no earlier failure rang it,
 *   waits out its backoff, and is not retried 24 hours after the block;
 * - `eraseLiftedBlocks` erases a block lifted over three years ago with no
 *   archive or a purged one (words blanked, facts kept, its messages
 *   "Erased", `block_erased {messages}` by `system`), and keeps an unpurged
 *   archive's, a held archive's, a held store's, a block whose complaint a
 *   hold names, and a block lifted two years ago; a second pass erases
 *   nothing more;
 * - the record's prune and the complaint erasure run as `app_service`.
 *
 * Run with MODERATION_LOCAL_TEST=1 after `npm run db:migrate:local -- apply`
 * (migration 20261030_0269_content_takedown). The fixed loopback database
 * keeps it away from Cloud SQL; everything happens inside one transaction
 * that is rolled back, each case in its own savepoint. The code under test
 * runs as `app_service`, the role `withService` takes in production; fixtures
 * with past times are written as the connecting user. Nothing reaches a
 * network or a bucket: `fetch` and every storage client throw, and the
 * follow-ups are given an in-memory storage. The operator notices
 * (`notifyComplaintDue`, `deliverBlockNotice`) are mocked. `DB_NAME` is pinned
 * to `storemink_local`, so that is "this database's" archive folder.
 */
import { createHash } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
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
import type {
  GcsBucketKind,
  GcsCopyPreconditions,
  GcsObjectMetadata,
  GcsUploadOptions,
} from "@/lib/storage/gcs";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  pending: Promise.resolve(),
  captured: [] as { text: string; rows: unknown[] }[],
}));
vi.mock("@/lib/db/client", () => {
  async function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const previous = service.pending;
    let release!: () => void;
    service.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `t14a_scope_${++service.count}`;
    await service.client!.query(`SAVEPOINT ${name}`);
    try {
      await service.client!.query("SET ROLE app_service");
      const real = service.db!;
      const dialect = new PgDialect();
      const db = new Proxy(real as object, {
        get(target, prop, receiver) {
          if (prop === "execute") {
            return async (query: SQL) => {
              const result = await (
                real as unknown as {
                  execute: (q: SQL) => Promise<{ rows: unknown[] }>;
                }
              ).execute(query);
              service.captured.push({
                text: dialect.sqlToQuery(query).sql.replace(/\s+/g, " ").trim(),
                rows: result.rows,
              });
              return result;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as Db;
      const value = await fn(db);
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
vi.mock("@/lib/moderation/notify", () => ({
  notifyComplaintDue: vi.fn(async () => globalThis.crypto.randomUUID()),
}));
vi.mock("@/lib/moderation/block", () => ({
  deliverBlockNotice: vi.fn(async () => "sent"),
}));
vi.mock("@/lib/moderation/blocked-objects", () => ({
  forgetBlockedObjects: vi.fn(),
}));

import { runModerationFollowUps } from "@/lib/moderation/follow-ups";
import {
  eraseLiftedBlocks,
  pruneModerationEvents,
  eraseTakedownComplaints,
} from "@/lib/moderation/retention";
import { dueAlert } from "@/lib/moderation/deadlines";
import { notifyComplaintDue } from "@/lib/moderation/notify";
import { deliverBlockNotice } from "@/lib/moderation/block";
import { logError } from "@/lib/observability/logger";
import { retentionFloor } from "@/lib/retention/prune";
import { canonicalJson } from "@/lib/themes/canonical-json";
import {
  TAKEDOWN_METADATA_KEY,
  type ModerationStorage,
} from "@/lib/moderation/storage";

const md5 = (bytes: Uint8Array) =>
  createHash("md5").update(bytes).digest("base64");
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text));
const statusError = (code: number) =>
  Object.assign(new Error(`status ${code}`), { code });
const pause = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The fake storage ────────────────────────────────────────────────────────

type Stored = {
  bytes: Uint8Array;
  generation: string;
  contentType: string | null;
  cacheControl: string | null;
  metadata: Record<string, string>;
};

class FakeStorage implements ModerationStorage {
  objects = new Map<string, Stored>();
  copies: string[] = [];
  publicUploads: string[] = [];
  deletes: string[] = [];
  beforeCopy: ((fromPath: string) => void) | null = null;
  brokenPaths = new Set<string>();
  failUploads = false;
  private nextGeneration = 1830000000000001;

  key(kind: GcsBucketKind, path: string) {
    return `${kind}:${path}`;
  }

  put(
    kind: GcsBucketKind,
    path: string,
    bytes: Uint8Array,
    extra: Partial<Omit<Stored, "bytes" | "generation">> = {},
  ): Stored {
    const stored: Stored = {
      bytes,
      generation: String(this.nextGeneration++),
      contentType: extra.contentType ?? "image/webp",
      cacheControl: extra.cacheControl ?? "public, max-age=3600",
      metadata: extra.metadata ?? {},
    };
    this.objects.set(this.key(kind, path), stored);
    return stored;
  }

  get(kind: GcsBucketKind, path: string) {
    return this.objects.get(this.key(kind, path));
  }

  private precondition(
    existing: Stored | undefined,
    match: string | number | undefined,
  ) {
    if (match === undefined) return;
    if (
      String(match) === "0" ? existing : existing?.generation !== String(match)
    ) {
      throw statusError(412);
    }
  }

  bucketName(kind: GcsBucketKind) {
    return kind === "private" ? "fake-private" : "fake-media";
  }

  async objectMetadata(
    kind: GcsBucketKind,
    path: string,
  ): Promise<GcsObjectMetadata | null> {
    await pause();
    if (this.brokenPaths.has(path)) throw new Error("storage is down");
    const stored = this.get(kind, path);
    if (!stored) return null;
    return {
      size: stored.bytes.length,
      contentType: stored.contentType,
      md5: md5(stored.bytes),
      crc32c: null,
      generation: stored.generation,
      cacheControl: stored.cacheControl,
      metadata: { ...stored.metadata },
    };
  }

  async copyObject(
    fromKind: GcsBucketKind,
    fromPath: string,
    toKind: GcsBucketKind,
    toPath: string,
    preconditions: GcsCopyPreconditions,
  ) {
    await pause();
    this.copies.push(fromPath);
    this.beforeCopy?.(fromPath);
    const source = this.get(fromKind, fromPath);
    if (
      !source ||
      (preconditions.ifSourceGenerationMatch !== undefined &&
        source.generation !== String(preconditions.ifSourceGenerationMatch))
    ) {
      throw statusError(404);
    }
    this.precondition(
      this.get(toKind, toPath),
      preconditions.ifGenerationMatch,
    );
    this.put(toKind, toPath, source.bytes, source);
  }

  async uploadPublic(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    cacheControl: string,
    options: GcsUploadOptions,
  ) {
    await pause();
    if (this.failUploads) throw new Error("storage is down");
    this.publicUploads.push(path);
    this.precondition(this.get("public", path), options.ifGenerationMatch);
    this.put("public", path, bytes, {
      contentType,
      cacheControl,
      metadata: options.metadata ?? {},
    });
  }

  async uploadPrivate(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    options: GcsUploadOptions,
  ) {
    await pause();
    this.precondition(this.get("private", path), options.ifGenerationMatch);
    this.put("private", path, bytes, { contentType });
  }

  async downloadObject(kind: GcsBucketKind, path: string, maxBytes: number) {
    await pause();
    const stored = this.get(kind, path);
    if (!stored) throw statusError(404);
    if (stored.bytes.length > maxBytes) throw new Error("too large");
    return new Uint8Array(stored.bytes);
  }

  async deleteGeneration(
    kind: GcsBucketKind,
    path: string,
    generation: string | number,
  ) {
    await pause();
    this.deletes.push(`${kind}:${path}`);
    const stored = this.get(kind, path);
    if (stored && stored.generation === String(generation)) {
      this.objects.delete(this.key(kind, path));
      return "deleted" as const;
    }
    return "missing" as const;
  }

  async deletePaths(kind: GcsBucketKind, paths: string[]) {
    for (const path of paths) this.deletes.push(`${kind}:${path}`);
    return [];
  }

  fetch(): Promise<Response> {
    return Promise.reject(new Error("No network in this test."));
  }

  async readBundledFile(): Promise<Uint8Array> {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
  }

  async placeholder() {
    return bytesOf("PLACEHOLDER");
  }

  now() {
    return new Date();
  }
}

type Row = Record<string, unknown>;
const enabled = process.env.MODERATION_LOCAL_TEST === "1";
const MIGRATION = "20261030_0269_content_takedown";
const tag = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const OPERATOR = `t14a-${tag}@follow-ups.test`;

describe.skipIf(!enabled)(
  "follow-ups and block erasure (local database)",
  () => {
    let client: Client;
    let echoId = "";
    let dbNow = new Date();
    let files = 0;

    const one = async (text: string, params: unknown[] = []) =>
      ((await client.query(text, params)).rows[0] ?? null) as Row | null;
    const all = async (text: string, params: unknown[] = []) =>
      (await client.query(text, params)).rows as Row[];

    async function refused(text: string, params: unknown[] = []) {
      await client.query("SAVEPOINT t14a_refusal");
      try {
        await client.query(text, params);
        return null;
      } catch (error) {
        return (error as Error).message;
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT t14a_refusal");
        await client.query("RELEASE SAVEPOINT t14a_refusal");
      }
    }

    async function fileBlock(options: {
      storeId?: string | null;
      state: string;
      next?: string;
      lifted?: string | null;
      blocked?: string;
      notified?: boolean;
      complaintId?: string | null;
      path?: string;
    }): Promise<{ id: string; path: string }> {
      files += 1;
      const path =
        options.path ?? `stores/${echoId}/media/t14a-${tag}-${files}.webp`;
      const row = await one(
        `insert into public.content_blocks
         (store_id, store_label, item_kind, object_path, file_source, item_label,
          item_url, reason_kind, legal_basis, store_message, blocked_by,
          storage_state, storage_next_attempt_at, blocked_at, lifted_at,
          lifted_by, lift_note, merchant_notified_at, complaint_id)
       values ($1, 'echo', 'file', $2, 'bucket', 'A photo', '/shop/x', 'terms_breach',
               'Rule 3', 'We blocked this.', $3, $4, ${options.next ?? "null"},
               ${options.blocked ?? "now()"}, ${options.lifted ?? "null"},
               ${options.lifted ? "$3" : "null"}, ${options.lifted ? "'Lifted on review'" : "''"},
               ${options.notified === false ? "null" : "now()"}, $5)
       returning id`,
        [
          options.storeId === undefined ? echoId : options.storeId,
          path,
          OPERATOR,
          options.state,
          options.complaintId ?? null,
        ],
      );
      return { id: String(row?.id), path };
    }

    async function archive(
      blockId: string,
      options: {
        files?: unknown[];
        state?: string;
        next?: string;
        purged?: boolean;
        held?: boolean;
      } = {},
    ): Promise<string> {
      const snapshot = { kind: "file", block: blockId };
      const sha = createHash("sha256")
        .update(canonicalJson(snapshot))
        .digest("hex");
      const row = await one(
        `insert into public.content_block_archives
         (block_id, store_id, snapshot, snapshot_sha256, files, files_state,
          files_next_attempt_at, keep_until, purged_at, legal_hold,
          legal_hold_set_at, legal_hold_set_by, legal_hold_note)
       values ($1, null, $2::jsonb, $3, $4::jsonb, $5, ${options.next ?? "null"},
               now() + interval '200 days',
               ${options.purged ? "now()" : "null"}, $6::boolean,
               case when $6::boolean then now() end,
               case when $6::boolean then $7::text end,
               case when $6::boolean then 'Police notice' else '' end)
       returning id`,
        [
          blockId,
          options.purged ? null : JSON.stringify(snapshot),
          sha,
          JSON.stringify(options.files ?? []),
          options.state ?? "copied",
          options.held ?? false,
          OPERATOR,
        ],
      );
      return String(row?.id);
    }

    async function complaint(values: {
      kind: string;
      received: string;
      ack: string;
      action: string;
      resolve: string;
      acknowledged?: boolean;
      resolved?: boolean;
      alerts?: Record<string, string>;
    }): Promise<string> {
      const row = await one(
        `insert into public.grievance_complaints
         (received_at, channel, kind, complainant_name, store_id, store_label, summary,
          acknowledge_due_at, action_due_at, resolve_due_at,
          acknowledged_at, acknowledged_by, resolved_at, resolved_by, outcome,
          alerts, created_by)
       values (${values.received}, 'email', $1, 'A person', $2, 'echo', 'Please remove it.',
               ${values.ack}, ${values.action}, ${values.resolve},
               ${values.acknowledged ? "now()" : "null"}, ${values.acknowledged ? "$3" : "null"},
               ${values.resolved ? "now()" : "null"}, ${values.resolved ? "$3" : "null"},
               ${values.resolved ? "'answered'" : "null"},
               $4::jsonb, $3)
       returning id`,
        [values.kind, echoId, OPERATOR, JSON.stringify(values.alerts ?? {})],
      );
      return String(row?.id);
    }

    const run = (storage: ModerationStorage) =>
      runModerationFollowUps({ storage, now: () => dbNow });

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
      service.db = drizzle(client, {
        schema: { ...schema, ...relations },
      }) as unknown as Db;
      vi.stubEnv("DB_NAME", "storemink_local");
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
      if (!ledger)
        throw new Error(`${MIGRATION} is not applied to storemink_local.`);
      const echo = await one(
        "select id from public.stores where slug = 'echo'",
      );
      if (!echo) throw new Error("The local store echo is missing.");
      echoId = String(echo.id);
      dbNow = new Date(String((await one("select now()::text as now"))?.now));
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      if (!client) return;
      await client.query("ROLLBACK");
      await client.end();
    });

    beforeEach(async () => {
      service.captured = [];
      await client.query("SAVEPOINT t14a_case");
    });
    afterEach(async () => {
      await client.query("ROLLBACK TO SAVEPOINT t14a_case");
      await client.query("RELEASE SAVEPOINT t14a_case");
    });

    it("copies, replaces, then restores a file through the real claims and settles", async () => {
      const storage = new FakeStorage();
      const { id: blockId, path } = await fileBlock({
        state: "pending",
        next: "now() - interval '1 minute'",
      });
      const bytes = bytesOf(`photo ${tag}`);
      storage.put("public", path, bytes, { contentType: "image/webp" });
      const archiveId = await archive(blockId, {
        state: "pending",
        next: "now() - interval '1 minute'",
        files: [
          {
            n: 1,
            source: "bucket",
            path,
            state: "pending",
            at: dbNow.toISOString(),
            expectedMd5: null,
          },
        ],
      });

      const first = await run(storage);
      expect(first.failedSteps).toEqual([]);
      expect(vi.mocked(logError)).not.toHaveBeenCalled();

      const arch = await one(
        `select files_state, files_claimed_at, files_attempts, files from public.content_block_archives where id = $1`,
        [archiveId],
      );
      expect(arch?.files_state).toBe("copied");
      expect(arch?.files_claimed_at).toBeNull();
      const entry = (arch?.files as Row[])[0];
      expect(entry.state).toBe("copied");
      expect(String(entry.archivePath)).toContain(
        `takedown-archive/storemink_local/${blockId}/`,
      );
      const block = await one(
        `select storage_state, storage_claimed_at, object_md5, storage_error from public.content_blocks where id = $1`,
        [blockId],
      );
      expect(block?.object_md5).toBe(md5(bytes));
      expect(block?.storage_state).toBe("replaced");
      expect(block?.storage_claimed_at).toBeNull();
      expect(storage.get("public", path)?.metadata[TAKEDOWN_METADATA_KEY]).toBe(
        blockId,
      );
      const actions = (
        await all(
          `select action, actor from public.moderation_events where block_id = $1 order by action`,
          [blockId],
        )
      ).map((r) => `${r.action}:${r.actor}`);
      expect(actions).toEqual([
        "archive_files_copied:system",
        "storage_replaced:system",
      ]);

      // Every claim the module made carried skip locked and its claim time.
      const claims = service.captured.filter((c) =>
        / set (storage|files|alert)_claimed_at = now\(\)/.test(c.text),
      );
      expect(claims.length).toBeGreaterThanOrEqual(4);
      for (const c of claims)
        expect(c.text).toContain("for update skip locked");

      // A lifted block can never be pending (the CHECK the claim's clause backs).
      expect(
        await refused(
          `update public.content_blocks set lifted_at = now(), lifted_by = 'x' where id = $1`,
          [blockId],
        ),
      ).toMatch(/content_blocks_storage_lift_check/);

      // The lift (as block.ts writes it), then the restore on the next run.
      await client.query(
        `update public.content_blocks
          set lifted_at = now(), lifted_by = $2, storage_state = 'restoring',
              storage_claimed_at = null, storage_next_attempt_at = null
        where id = $1`,
        [blockId, OPERATOR],
      );
      const second = await run(storage);
      expect(second.failedSteps).toEqual([]);
      const restored = await one(
        `select storage_state, storage_claimed_at from public.content_blocks where id = $1`,
        [blockId],
      );
      expect(restored?.storage_state).toBe("restored");
      expect(restored?.storage_claimed_at).toBeNull();
      expect(Buffer.from(storage.get("public", path)!.bytes).toString()).toBe(
        `photo ${tag}`,
      );
      expect(
        (
          await all(
            `select action from public.moderation_events where block_id = $1 and action = 'storage_restored'`,
            [blockId],
          )
        ).length,
      ).toBe(1);
    });

    it("never claims a lifted block for a replacement, and waits for the 35 seconds", async () => {
      const storage = new FakeStorage();
      // Due in 30 seconds: the copy goes, the replacement waits.
      const waiting = await fileBlock({
        state: "pending",
        next: "now() + interval '30 seconds'",
      });
      storage.put("public", waiting.path, bytesOf("waiting"), {
        contentType: "image/webp",
      });
      await archive(waiting.id, {
        state: "pending",
        next: "now() - interval '1 minute'",
        files: [
          {
            n: 1,
            source: "bucket",
            path: waiting.path,
            state: "pending",
            at: dbNow.toISOString(),
            expectedMd5: null,
          },
        ],
      });
      // Lifted while pending: cancelled, with a copied archive.
      const lifted = await fileBlock({
        state: "cancelled",
        lifted: "now()",
        next: "now() - interval '1 minute'",
      });
      storage.put("public", lifted.path, bytesOf("lifted"), {
        contentType: "image/webp",
      });
      await archive(lifted.id, {
        files: [
          {
            n: 1,
            source: "bucket",
            path: lifted.path,
            state: "copied",
            sourceBucket: "fake-media",
            sourceGeneration: "1",
            archivePath: `takedown-archive/storemink_local/${lifted.id}/1-x.webp`,
            archiveGeneration: "2",
            size: 6,
            contentType: "image/webp",
            md5: md5(bytesOf("lifted")),
            crc32c: null,
            sha256: null,
            cacheControl: null,
            at: dbNow.toISOString(),
          },
        ],
      });

      await run(storage);
      const states = await all(
        `select id, storage_state, storage_claimed_at from public.content_blocks where id = any($1::uuid[])`,
        [[waiting.id, lifted.id]],
      );
      const byId = new Map(states.map((r) => [String(r.id), r]));
      expect(byId.get(waiting.id)?.storage_state).toBe("pending");
      expect(byId.get(lifted.id)?.storage_state).toBe("cancelled");
      expect(storage.publicUploads).toEqual([]);
      const replaceClaim = service.captured.find((c) =>
        c.text.includes("x.storage_state = 'pending'"),
      );
      expect(replaceClaim?.text).toContain("x.lifted_at is null");
      expect(
        (replaceClaim?.rows ?? []).map((r) => String((r as Row).id)),
      ).not.toContain(lifted.id);
      expect(
        (replaceClaim?.rows ?? []).map((r) => String((r as Row).id)),
      ).not.toContain(waiting.id);
    });

    it("alerts the stages dueAlert says are due, once, and no other", async () => {
      const ids = {
        ackOverdue: await complaint({
          kind: "court_order",
          received: "now() - interval '2 hours'",
          ack: "now() - interval '1 hour'",
          action: "now() + interval '50 minutes'",
          resolve: "now() + interval '55 minutes'",
        }),
        notYet: await complaint({
          kind: "grievance",
          received: "now() - interval '1 hour'",
          ack: "now() + interval '23 hours'",
          action: "now() + interval '6 days'",
          resolve: "now() + interval '6 days'",
        }),
        resolveSoon: await complaint({
          kind: "grievance",
          received: "now() - interval '30 hours'",
          ack: "now() - interval '7 hours'",
          action: "now() + interval '1 hour'",
          resolve: "now() + interval '1 hour'",
          acknowledged: true,
        }),
        resolved: await complaint({
          kind: "grievance",
          received: "now() - interval '30 hours'",
          ack: "now() - interval '7 hours'",
          action: "now() - interval '1 hour'",
          resolve: "now() - interval '1 hour'",
          acknowledged: true,
          resolved: true,
        }),
        actSoon: await complaint({
          kind: "information_order",
          received: "now() - interval '10 hours'",
          ack: "now() - interval '1 hour'",
          action: "now() + interval '30 minutes'",
          resolve: "now() + interval '40 hours'",
          acknowledged: true,
        }),
        alreadySent: await complaint({
          kind: "grievance",
          received: "now() - interval '30 hours'",
          ack: "now() - interval '7 hours'",
          action: "now() + interval '5 days'",
          resolve: "now() + interval '5 days'",
          alerts: { acknowledge_overdue: dbNow.toISOString() },
        }),
      };
      const before = await all(
        `select id, kind, received_at::text, acknowledge_due_at::text, action_due_at::text,
              resolve_due_at::text, acknowledged_at::text, actioned_at::text,
              resolved_at::text, alerts
         from public.grievance_complaints where id = any($1::uuid[])`,
        [Object.values(ids)],
      );
      const expected = new Map(
        before.map((c) => [
          String(c.id),
          dueAlert(
            {
              kind: c.kind as never,
              receivedAt: String(c.received_at),
              acknowledgeDueAt: String(c.acknowledge_due_at),
              actionDueAt: String(c.action_due_at),
              resolveDueAt: String(c.resolve_due_at),
              acknowledgedAt: (c.acknowledged_at as string | null) ?? null,
              actionedAt: (c.actioned_at as string | null) ?? null,
              resolvedAt: (c.resolved_at as string | null) ?? null,
              alerts: c.alerts as Record<string, unknown>,
            },
            dbNow,
          )?.key ?? null,
        ]),
      );
      expect(expected.get(ids.ackOverdue)).toBe("acknowledge_overdue");
      expect(expected.get(ids.resolveSoon)).toBe("resolve_soon");
      expect(expected.get(ids.actSoon)).toBe("act_soon");
      expect(expected.get(ids.notYet)).toBeNull();
      expect(expected.get(ids.resolved)).toBeNull();
      expect(expected.get(ids.alreadySent)).toBeNull();

      await run(new FakeStorage());
      // The SQL claimed exactly the complaints the JS rule alerts (of ours).
      const claim = service.captured.find((c) =>
        c.text.startsWith("update public.grievance_complaints g"),
      );
      const ours = new Set(Object.values(ids));
      const claimed = (claim?.rows ?? [])
        .map((r) => String((r as Row).id))
        .filter((id) => ours.has(id));
      expect(new Set(claimed)).toEqual(
        new Set(
          [...expected].filter(([, key]) => key !== null).map(([id]) => id),
        ),
      );
      const after = await all(
        `select id, alerts, alert_claimed_at from public.grievance_complaints where id = any($1::uuid[])`,
        [Object.values(ids)],
      );
      for (const row of after) {
        const key = expected.get(String(row.id));
        expect(row.alert_claimed_at).toBeNull();
        if (key) expect(Object.keys(row.alerts as object)).toContain(key);
      }
      const events = await all(
        `select complaint_id, detail from public.moderation_events
        where action = 'complaint_alerted' and complaint_id = any($1::uuid[])`,
        [Object.values(ids)],
      );
      expect(events).toHaveLength(3);
      const ourNotices = vi
        .mocked(notifyComplaintDue)
        .mock.calls.filter(([c]) => ours.has(c.id));
      expect(ourNotices).toHaveLength(3);

      // Run again: nothing more until the next stage comes.
      vi.mocked(notifyComplaintDue).mockClear();
      await run(new FakeStorage());
      expect(
        vi
          .mocked(notifyComplaintDue)
          .mock.calls.filter(([c]) => ours.has(c.id)),
      ).toHaveLength(0);
    });

    it("retries a notice with the bell only when it never rang, and backs off", async () => {
      const due = await fileBlock({
        state: "replaced",
        notified: false,
        blocked: "now() - interval '10 minutes'",
      });
      const rang = await fileBlock({
        state: "replaced",
        notified: false,
        blocked: "now() - interval '10 minutes'",
      });
      const waiting = await fileBlock({
        state: "replaced",
        notified: false,
        blocked: "now() - interval '10 minutes'",
      });
      const old = await fileBlock({
        state: "replaced",
        notified: false,
        blocked: "now() - interval '25 hours'",
      });
      await client.query(
        `insert into public.moderation_events (at, actor, action, block_id, store_id, detail) values
         (now() - interval '2 minutes', 'system', 'merchant_notify_failed', $1, $4, '{"bell": true}'),
         (now() - interval '1 minute', 'system', 'merchant_notify_failed', $2, $4, '{"bell": false}'),
         (now() - interval '1 minute', 'system', 'merchant_notify_failed', $2, $4, '{"bell": false}'),
         (now() - interval '3 hours', 'system', 'merchant_notify_failed', $3, $4, '{"bell": false}')`,
        [rang.id, waiting.id, old.id, echoId],
      );
      await run(new FakeStorage());
      const calls = new Map(
        vi
          .mocked(deliverBlockNotice)
          .mock.calls.map(([blockId, , options]) => [blockId, options]),
      );
      expect(calls.get(due.id)).toEqual({ bell: true });
      expect(calls.get(rang.id)).toEqual({ bell: false });
      expect(calls.has(waiting.id)).toBe(false);
      expect(calls.has(old.id)).toBe(false);
    });

    it("erases a lifted block three years on, never a held or kept one", async () => {
      const holdComplaint = await complaint({
        kind: "grievance",
        received: "now() - interval '1 hour'",
        ack: "now() + interval '23 hours'",
        action: "now() + interval '6 days'",
        resolve: "now() + interval '6 days'",
      });
      const lifted4y = "now() - interval '35064 hours'";
      const blocked5y = "now() - interval '43830 hours'";
      const plain = await fileBlock({
        storeId: null,
        state: "restored",
        lifted: lifted4y,
        blocked: blocked5y,
      });
      const purged = await fileBlock({
        storeId: null,
        state: "restored",
        lifted: lifted4y,
        blocked: blocked5y,
      });
      const kept = await fileBlock({
        storeId: null,
        state: "restored",
        lifted: lifted4y,
        blocked: blocked5y,
      });
      const heldArchive = await fileBlock({
        storeId: null,
        state: "restored",
        lifted: lifted4y,
        blocked: blocked5y,
      });
      const heldStore = await fileBlock({
        state: "restored",
        lifted: lifted4y,
        blocked: blocked5y,
      });
      const heldComplaint = await fileBlock({
        storeId: null,
        state: "restored",
        lifted: lifted4y,
        blocked: blocked5y,
        complaintId: holdComplaint,
      });
      const recent = await fileBlock({
        storeId: null,
        state: "restored",
        lifted: "now() - interval '17520 hours'",
        blocked: blocked5y,
      });
      await archive(purged.id, { purged: true });
      await archive(kept.id);
      await archive(heldArchive.id, { held: true });
      await client.query(
        `insert into public.store_legal_holds (store_id, store_label, reason, complaint_id, set_by)
       values ($1, 'echo', 'Police notice', $2, $3)`,
        [echoId, holdComplaint, OPERATOR],
      );
      for (const body of ["Why was this blocked?", "We checked it."]) {
        await client.query(
          `insert into public.content_block_messages (block_id, from_side, author, body)
         values ($1, 'store', 'owner@echo.test', $2)`,
          [plain.id, body],
        );
      }

      const erased = await eraseLiftedBlocks(retentionFloor(1095), 200);
      expect(erased).toBeGreaterThanOrEqual(2);
      const rows = new Map(
        (
          await all(
            `select id, item_label, item_url, legal_basis, lift_note, store_message, erased_at,
                object_path, reason_kind, blocked_by, blocked_at, lifted_at
           from public.content_blocks where id = any($1::uuid[])`,
            [
              [
                plain.id,
                purged.id,
                kept.id,
                heldArchive.id,
                heldStore.id,
                heldComplaint.id,
                recent.id,
              ],
            ],
          )
        ).map((r) => [String(r.id), r]),
      );
      for (const id of [plain.id, purged.id]) {
        const row = rows.get(id)!;
        expect(row.erased_at).not.toBeNull();
        expect([
          row.item_label,
          row.item_url,
          row.legal_basis,
          row.lift_note,
          row.store_message,
        ]).toEqual(["Erased", "", "", "", "Erased"]);
        expect(row.object_path).toBeTruthy();
        expect(row.reason_kind).toBe("terms_breach");
        expect(row.blocked_by).toBe(OPERATOR);
        expect(row.lifted_at).not.toBeNull();
      }
      for (const id of [
        kept.id,
        heldArchive.id,
        heldStore.id,
        heldComplaint.id,
        recent.id,
      ]) {
        expect(rows.get(id)!.erased_at).toBeNull();
        expect(rows.get(id)!.item_label).toBe("A photo");
      }
      const messages = await all(
        `select body, author, from_side from public.content_block_messages where block_id = $1`,
        [plain.id],
      );
      expect(messages.map((m) => [m.body, m.author, m.from_side])).toEqual([
        ["Erased", "erased", "store"],
        ["Erased", "erased", "store"],
      ]);
      const events = await all(
        `select block_id, actor, detail from public.moderation_events
        where action = 'block_erased' and block_id = any($1::uuid[]) order by block_id`,
        [[plain.id, purged.id]],
      );
      expect(events).toHaveLength(2);
      const plainEvent = events.find((e) => String(e.block_id) === plain.id);
      expect(plainEvent?.actor).toBe("system");
      expect(plainEvent?.detail).toEqual({ messages: 2 });

      // A second pass erases nothing more of ours.
      await eraseLiftedBlocks(retentionFloor(1095), 200);
      expect(
        (
          await all(
            `select 1 from public.moderation_events where action = 'block_erased' and block_id = any($1::uuid[])`,
            [[plain.id, purged.id]],
          )
        ).length,
      ).toBe(2);
    });

    it("runs the record's prune and the complaint erasure as app_service", async () => {
      const floor = retentionFloor(1095);
      expect(await pruneModerationEvents(floor, 5)).toBeGreaterThanOrEqual(0);
      expect(await eraseTakedownComplaints(floor, 5)).toBeGreaterThanOrEqual(0);
    });
  },
);
