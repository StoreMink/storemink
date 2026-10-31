/** Rollback-only checks, against local Postgres, of blocking and lifting
 * (takedown stage T12, design 5.3, 3.5, 8.1 and 10; plan A6), through the real
 * `blockItem` and `liftBlock` with an in-memory storage adapter:
 *
 * - a product block end to end: the archive row's hash is
 *   `sha256(canonicalJson(snapshot read back from jsonb))`, the store's header
 *   and footer are in the snapshot, the events are written, the complaint is
 *   actioned, the product is hidden and the copy sits in the archive;
 * - a whole-store block: the content file is written BEFORE the suspension,
 *   it holds `mink_attachments` rows, this database's attachment is listed
 *   for the follow-up and another database's is not, Reactivate is refused,
 *   the lift restores the status, and deletion is refused until the files are
 *   copied;
 * - lifts reaching `cancelled` (a replacement not yet made) and `restoring`,
 *   whose restore puts the original back before the blocked set is
 *   forgotten (T7);
 * - two follow-up claims (design 8.1's statement) take different rows;
 * - the item-changed race: an image added between the copy and the lock is
 *   recorded pending.
 *
 * Run with MODERATION_LOCAL_TEST=1 after `npm run db:migrate:local -- apply`
 * (migration 20261030_0269_content_takedown). The fixed loopback database
 * keeps it away from Cloud SQL; everything happens inside one transaction that
 * is rolled back, each case in its own savepoint. The code under test runs as
 * `app_service`. `readStoreContent`'s `SET TRANSACTION` cannot run inside a
 * savepoint, so the harness answers it (the rest of that read runs for real).
 * Nothing reaches a network or a bucket: `fetch` throws, gcs.ts throws, and
 * the storage adapter is in memory.
 *
 * Identity and sequence values (grievance_complaints.ref_no, stores.store_no)
 * are never rolled back; nothing else outlives the transaction. A store
 * DELETE is attempted (on a store this file creates), so run this file on its
 * own, not beside a dev server writing to the database.
 */
import { createHash } from "node:crypto";
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
  setTransaction: 0,
  order: [] as string[],
}));
vi.mock("@/lib/db/client", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  // `readStoreContent` opens with SET TRANSACTION, which PostgreSQL refuses
  // inside a savepoint; the harness answers it and forwards everything else.
  const scoped = (db: Db): Db =>
    new Proxy(db as object, {
      get(target, prop) {
        if (prop === "execute") {
          return async (query: Parameters<Db["execute"]>[0]) => {
            const text = dialect
              .sqlToQuery(query as never)
              .sql.trim()
              .toLowerCase();
            if (text.startsWith("set transaction isolation level")) {
              service.setTransaction += 1;
              return { rows: [] };
            }
            return (target as Db).execute(query);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as Db;
  async function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const previous = service.pending;
    let release!: () => void;
    service.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `t12_scope_${++service.count}`;
    await service.client!.query(`SAVEPOINT ${name}`);
    try {
      await service.client!.query("SET ROLE app_service");
      const value = await fn(scoped(service.db!));
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
  const refuse = async () => {
    throw new Error("No real bucket in this test.");
  };
  return {
    GCS_BUCKET_NAME: "fake-media",
    GCS_PRIVATE_BUCKET_NAME: "fake-private",
    gcsObjectMetadata: vi.fn(refuse),
    gcsCopyObject: vi.fn(refuse),
    gcsUploadObject: vi.fn(refuse),
    gcsPrivateUploadObject: vi.fn(refuse),
    gcsDownloadObject: vi.fn(refuse),
    gcsDeleteGeneration: vi.fn(refuse),
    gcsDeletePaths: vi.fn(refuse),
  };
});
vi.mock("./notify", () => {
  const told = async () => ({
    bellEventId: "ev-local",
    storeFound: true,
    recipients: 1,
    sent: 1,
    failed: 0,
  });
  return {
    tellStoreOfBlock: vi.fn(told),
    tellStoreOfLift: vi.fn(told),
    tellStoreOfReply: vi.fn(told),
  };
});
vi.mock("./blocked-objects", () => ({
  forgetBlockedObjects: vi.fn(() => {
    service.order.push("forget");
  }),
}));
vi.mock("@/lib/seo/search-engines", () => ({
  pingIndexNow: vi.fn(async () => undefined),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { blockItem, liftBlock } from "./block";
import { logComplaint, storeLabelFor } from "./complaints";
import { snapshotSha256 } from "./snapshot";
import {
  parseArchivedFile,
  replaceWithPlaceholder,
  type ModerationStorage,
} from "./storage";
import { forgetBlockedObjects } from "./blocked-objects";
import { pingIndexNow } from "@/lib/seo/search-engines";

const enabled = process.env.MODERATION_LOCAL_TEST === "1";

const MIGRATION = "20261030_0269_content_takedown";
const DATABASE = "storemink_local";
const ECHO_SLUG = "echo";
const CASE_MS = 60_000;
const NOW = new Date("2026-10-30T06:00:00.000Z");
const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const SUPER = {
  email: `t12-${tag}-super@probe.test`,
  role: "superadmin" as const,
};
const OPS = { email: `t12-${tag}-ops@probe.test`, role: "member" as const };
const MESSAGE = "We removed this because it breaks StoreMink's rules.";

type Row = Record<string, unknown>;

const md5 = (bytes: Uint8Array) =>
  createHash("md5").update(bytes).digest("base64");
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text));
const statusError = (code: number) =>
  Object.assign(new Error(`status ${code}`), { code });

type Stored = {
  bytes: Uint8Array;
  generation: string;
  contentType: string | null;
  cacheControl: string | null;
  metadata: Record<string, string>;
};

/**
 * An in-memory bucket pair with Google's generation rules (storage.test.ts's
 * FakeStorage, with hooks that may wait on the database).
 */
class FakeStorage implements ModerationStorage {
  objects = new Map<string, Stored>();
  beforeCopy: ((fromPath: string) => Promise<void>) | null = null;
  beforePrivateUpload: ((path: string) => Promise<void>) | null = null;
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
    await this.beforeCopy?.(fromPath);
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
    service.order.push(`upload public ${path}`);
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
    await this.beforePrivateUpload?.(path);
    this.precondition(this.get("private", path), options.ifGenerationMatch);
    this.put("private", path, bytes, {
      contentType,
      cacheControl: "private, max-age=0",
    });
  }

  async downloadObject(kind: GcsBucketKind, path: string, maxBytes: number) {
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
    const stored = this.get(kind, path);
    if (stored && stored.generation === String(generation)) {
      this.objects.delete(this.key(kind, path));
      return "deleted" as const;
    }
    return "missing" as const;
  }

  async deletePaths(kind: GcsBucketKind, paths: string[]) {
    for (const path of paths) this.objects.delete(this.key(kind, path));
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
    return NOW;
  }
}

describe.skipIf(!enabled)("blocking and lifting (local database)", () => {
  let client: Client;
  let storage: FakeStorage;
  let echoId = "";
  let echoLabel = "";
  let productId = "";
  let productSlug = "";
  let raceProductId = "";

  const media = (key: string) =>
    `https://storage.googleapis.com/fake-media/${key}`;
  const echoKey = (name: string) =>
    `stores/${echoId}/uploads/t12-${tag}-${name}.webp`;

  const one = async (text: string, params: unknown[] = []) =>
    ((await client.query(text, params)).rows[0] ?? null) as Row | null;
  const all = async (text: string, params: unknown[] = []) =>
    (await client.query(text, params)).rows as Row[];

  async function asService<T>(fn: () => Promise<T>): Promise<T> {
    await client.query("SET ROLE app_service");
    try {
      return await fn();
    } finally {
      await client.query("RESET ROLE");
    }
  }

  /** One statement that must be refused, in its own savepoint. */
  async function refused(
    text: string,
    params: unknown[] = [],
    deferred = false,
  ): Promise<{ code: string; message: string } | null> {
    await client.query("SAVEPOINT t12_refusal");
    try {
      if (deferred) await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(text, params);
      return null;
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { code: e.code ?? "", message: e.message };
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT t12_refusal");
      await client.query("RELEASE SAVEPOINT t12_refusal");
      if (deferred) await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    }
  }

  async function archiveOf(blockId: string) {
    return one(
      `select snapshot, snapshot_sha256, files, files_state
         from public.content_block_archives where block_id = $1`,
      [blockId],
    );
  }

  async function blockRow(blockId: string) {
    return one(`select * from public.content_blocks where id = $1`, [blockId]);
  }

  async function actions(blockId: string) {
    return (
      await all(
        `select action from public.moderation_events where block_id = $1`,
        [blockId],
      )
    )
      .map((row) => String(row.action))
      .sort();
  }

  async function blockFile(name: string) {
    const key = echoKey(name);
    storage.put("public", key, bytesOf(`original ${name}`));
    const result = await blockItem(
      {
        kind: "file",
        fileAddress: media(key),
        reason: "terms_breach",
        storeMessage: MESSAGE,
      },
      SUPER,
      { storage },
    );
    if (!result.ok) throw new Error(`blockItem refused: ${result.error}`);
    return { key, blockId: result.blockId };
  }

  beforeAll(async () => {
    vi.stubEnv("DB_NAME", DATABASE);
    client = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: DATABASE,
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
        `${MIGRATION} is not applied to ${DATABASE}: run npm run db:migrate:local -- apply first.`,
      );
    }
    const echo = await one(
      "select id, name, slug from public.stores where slug = $1",
      [ECHO_SLUG],
    );
    if (!echo) throw new Error("The local store echo is missing.");
    echoId = String(echo.id);
    echoLabel = storeLabelFor({
      name: String(echo.name),
      slug: String(echo.slug),
    });
    const products = await all(
      `select p.id, p.slug from public.products p
        where p.store_id = $1 and p.status = 'published'
          and p.moderation_blocked_at is null
          and not exists (select 1 from public.product_variants v where v.product_id = p.id)
        order by p.created_at, p.id limit 2`,
      [echoId],
    );
    if (products.length < 2) {
      throw new Error("echo needs two published products without variants.");
    }
    productId = String(products[0].id);
    productSlug = String(products[0].slug);
    raceProductId = String(products[1].id);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (!client) return;
    await client.query("ROLLBACK");
    await client.end();
  });

  beforeEach(async () => {
    await client.query("SAVEPOINT t12_case");
    storage = new FakeStorage();
    service.order.length = 0;
    service.setTransaction = 0;
  });
  afterEach(async () => {
    await client.query("ROLLBACK TO SAVEPOINT t12_case");
    await client.query("RELEASE SAVEPOINT t12_case");
  });

  it(
    "blocks a product end to end: hash over the jsonb read back, header and footer kept, events written, complaint actioned",
    async () => {
      const key = echoKey("mug");
      await client.query(
        `update public.products
            set image_url = $2, images = array[$2]::text[], description = 'Probe mug.'
          where id = $1`,
        [productId, media(key)],
      );
      storage.put("public", key, bytesOf("the mug photo"));
      const complaint = await logComplaint(
        {
          receivedAt: new Date(Date.now() - 60 * 60 * 1000),
          channel: "email",
          kind: "intimate_or_impersonation",
          complainantName: "Asha Rao",
          complainantContact: "asha@example.com",
          storeId: echoId,
          urls: [`https://echo.storemink.com/shop/${productSlug}`],
          summary: "Please remove the photo of me.",
        },
        OPS,
      );
      if (!complaint.ok)
        throw new Error(`logComplaint refused: ${complaint.error}`);

      const result = await blockItem(
        {
          kind: "product",
          storeId: echoId,
          itemId: productId,
          reason: "terms_breach",
          complaintId: complaint.complaint.id,
          storeMessage: MESSAGE,
        },
        SUPER,
        { storage },
      );
      expect(result).toMatchObject({ ok: true, warnings: [] });
      if (!result.ok) return;

      const block = await blockRow(result.blockId);
      expect(block).toMatchObject({
        store_id: echoId,
        store_label: echoLabel,
        item_kind: "product",
        item_id: productId,
        storage_state: "none",
        tell_store: true,
        blocked_by: SUPER.email,
        complaint_id: complaint.complaint.id,
      });
      expect(block?.merchant_notified_at).not.toBeNull();
      const product = await one(
        "select moderation_blocked_at from public.products where id = $1",
        [productId],
      );
      expect(product?.moderation_blocked_at).not.toBeNull();

      // ★ The hash is sha256(canonicalJson(snapshot read back from jsonb)).
      const archive = await archiveOf(result.blockId);
      expect(archive?.snapshot_sha256).toBe(snapshotSha256(archive?.snapshot));
      const snapshot = archive?.snapshot as Row;
      const chrome = await one(
        "select to_jsonb(c) as row from public.store_chrome c where c.store_id = $1",
        [echoId],
      );
      expect((snapshot.store as Row).chrome).toEqual(chrome?.row ?? null);
      expect(((snapshot.store as Row).row as Row).id).toBe(echoId);
      expect(snapshot.database).toBe(DATABASE);
      expect((snapshot.item as Row).row).toMatchObject({ id: productId });

      const files = archive?.files as Row[];
      const entry = files.find((file) => file.path === key);
      expect(entry).toMatchObject({ n: 1, source: "bucket", state: "copied" });
      expect(archive?.files_state).toBe(
        files.some((file) => file.state === "pending") ? "pending" : "copied",
      );
      expect(storage.get("private", String(entry?.archivePath))?.bytes).toEqual(
        bytesOf("the mug photo"),
      );

      expect(await actions(result.blockId)).toEqual(
        expect.arrayContaining([
          "archive_written",
          "block_created",
          "complaint_actioned",
          "merchant_notified",
        ]),
      );
      const actioned = await one(
        "select actioned_at, actioned_by from public.grievance_complaints where id = $1",
        [complaint.complaint.id],
      );
      expect(actioned?.actioned_at).not.toBeNull();
      expect(actioned?.actioned_by).toBe(SUPER.email);
      expect(forgetBlockedObjects).toHaveBeenCalled();
      expect(pingIndexNow).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(`/shop/${productSlug}$`)),
        ]),
      );
    },
    CASE_MS,
  );

  it(
    "suspends a whole store only after its copy is written, with its chat attachments, and lifts it",
    async () => {
      const store = await one(
        `insert into public.stores (slug, name) values ($1, 'T12 Probe') returning id`,
        [`t12-${tag}-probe`],
      );
      const storeId = String(store?.id);
      const ours = crypto.randomUUID();
      const theirs = crypto.randomUUID();
      const oursPath = `stores/${storeId}/mink-attachments/${DATABASE}/${ours}.webp`;
      const theirsPath = `stores/${storeId}/mink-attachments/storemink/${theirs}.webp`;
      await client.query(
        `insert into public.mink_attachments
           (id, store_id, admin_id, path, filename, content_type, size_bytes)
         values ($1, $3, 'probe-admin', $2, 'ours.webp', 'image/webp', 10),
                ($4, $3, 'probe-admin', $5, 'theirs.webp', 'image/webp', 10)`,
        [ours, oursPath, storeId, theirs, theirsPath],
      );
      let atUpload: Row | null = null;
      storage.beforePrivateUpload = async (path) => {
        if (!path.endsWith("/store-content.jsonl")) return;
        atUpload = await one(
          `select s.status,
                  (select count(*)::int from public.content_blocks b
                    where b.store_id = s.id and b.lifted_at is null) as live_blocks
             from public.stores s where s.id = $1`,
          [storeId],
        );
      };

      const result = await blockItem(
        {
          kind: "store",
          storeId,
          reason: "terms_breach",
          storeMessage: MESSAGE,
        },
        SUPER,
        { storage },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(service.setTransaction).toBe(1);
      // ★ The content file was written before the store was suspended.
      expect(atUpload).toEqual({ status: "active", live_blocks: 0 });
      expect(
        (await one("select status from public.stores where id = $1", [storeId]))
          ?.status,
      ).toBe("suspended");
      expect(await blockRow(result.blockId)).toMatchObject({
        item_kind: "store",
        item_id: storeId,
        store_status_before: "active",
      });

      const archive = await archiveOf(result.blockId);
      const files = archive?.files as Row[];
      expect(files[0]).toMatchObject({
        n: 0,
        source: "private",
        path: "store-content.jsonl",
        state: "copied",
      });
      expect(files).toContainEqual(
        expect.objectContaining({
          source: "private",
          path: oursPath,
          state: "pending",
        }),
      );
      expect(files.some((file) => file.path === theirsPath)).toBe(false);
      expect(archive?.files_state).toBe("pending");
      const snapshot = archive?.snapshot as Row;
      expect(snapshot.storeContent).toMatchObject({
        file: "store-content.jsonl",
        skippedAttachments: 1,
        rows: expect.objectContaining({ stores: 1, mink_attachments: 2 }),
      });
      const contentFile = storage.get("private", String(files[0].archivePath));
      const lines = new TextDecoder()
        .decode(contentFile?.bytes)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { table: string; row: Row });
      expect(
        lines
          .filter((line) => line.table === "mink_attachments")
          .map((line) => line.row.id)
          .sort(),
      ).toEqual([ours, theirs].sort());

      // Reactivate is refused while the block is live.
      expect(
        (
          await refused(
            "update public.stores set status = 'active' where id = $1",
            [storeId],
          )
        )?.message,
      ).toMatch(/suspended by a StoreMink block/);
      // Deletion is refused while the archive's files are not copied.
      expect(
        (
          await refused(
            "delete from public.stores where id = $1",
            [storeId],
            true,
          )
        )?.message,
      ).toMatch(/archive whose files are not copied yet/);

      const lifted = await liftBlock(
        { blockId: result.blockId, note: "Lifted after review." },
        SUPER,
        { storage },
      );
      expect(lifted).toMatchObject({ ok: true, liftedIds: [result.blockId] });
      expect(
        (await one("select status from public.stores where id = $1", [storeId]))
          ?.status,
      ).toBe("active");
      expect(
        (
          await refused(
            "delete from public.stores where id = $1",
            [storeId],
            true,
          )
        )?.message,
      ).toMatch(/archive whose files are not copied yet/);

      await client.query(
        "update public.content_block_archives set files_state = 'copied' where block_id = $1",
        [result.blockId],
      );
      expect(
        await refused(
          "delete from public.stores where id = $1",
          [storeId],
          true,
        ),
      ).toBeNull();
    },
    CASE_MS,
  );

  it(
    "cancels a replacement not yet made when the block is lifted",
    async () => {
      const { blockId } = await blockFile("cancel");
      expect(await blockRow(blockId)).toMatchObject({
        storage_state: "pending",
      });
      const lifted = await liftBlock(
        { blockId, note: "Blocked by mistake." },
        SUPER,
        { storage },
      );
      expect(lifted).toMatchObject({ ok: true, warnings: [] });
      expect(await blockRow(blockId)).toMatchObject({
        storage_state: "cancelled",
        storage_claimed_at: null,
        storage_next_attempt_at: null,
        lifted_by: SUPER.email,
      });
      expect(await actions(blockId)).toEqual(
        expect.arrayContaining(["block_lifted", "storage_cancelled"]),
      );
    },
    CASE_MS,
  );

  it(
    "restores a replaced file on a lift, before the blocked set is forgotten (T7)",
    async () => {
      const { key, blockId } = await blockFile("restore");
      const archive = await archiveOf(blockId);
      const entry = parseArchivedFile((archive?.files as Row[])[0]);
      if (!entry) throw new Error("expected a copied archive entry");
      const replaced = await replaceWithPlaceholder(
        { blockId, path: key, archived: entry },
        storage,
      );
      expect(replaced.status).toBe("replaced");
      expect(storage.get("public", key)?.bytes).toEqual(bytesOf("PLACEHOLDER"));
      await client.query(
        `update public.content_blocks
            set storage_state = 'replaced', storage_claimed_at = null,
                storage_next_attempt_at = null
          where id = $1`,
        [blockId],
      );
      service.order.length = 0;

      const lifted = await liftBlock(
        { blockId, note: "Restored after review." },
        SUPER,
        {
          storage,
        },
      );
      expect(lifted).toMatchObject({ ok: true, warnings: [] });
      expect(await blockRow(blockId)).toMatchObject({
        storage_state: "restored",
        storage_claimed_at: null,
      });
      expect(storage.get("public", key)?.bytes).toEqual(
        bytesOf("original restore"),
      );
      expect(await actions(blockId)).toEqual(
        expect.arrayContaining(["block_lifted", "storage_restored"]),
      );
      const restoredAt = service.order.indexOf(`upload public ${key}`);
      expect(restoredAt).toBeGreaterThanOrEqual(0);
      expect(service.order.indexOf("forget")).toBeGreaterThan(restoredAt);
    },
    CASE_MS,
  );

  it(
    "gives two follow-up claims different rows (design 8.1)",
    async () => {
      const first = await blockFile("claim-a");
      const second = await blockFile("claim-b");
      await client.query(
        `update public.content_blocks
            set storage_next_attempt_at = now() - interval '1 minute'
          where id = any($1::uuid[])`,
        [[first.blockId, second.blockId]],
      );
      const claim = () =>
        asService(async () =>
          (
            await client.query(
              `update public.content_blocks b
                  set storage_claimed_at = now(), storage_attempts = b.storage_attempts + 1
                where b.id in (select id from public.content_blocks
                                where storage_state = 'pending' and lifted_at is null
                                  and storage_next_attempt_at <= now()
                                  and (storage_claimed_at is null
                                       or storage_claimed_at < now() - interval '2 minutes')
                                order by storage_next_attempt_at limit 1
                                for update skip locked)
               returning b.id`,
            )
          ).rows.map((row) => String((row as Row).id)),
        );
      const a = await claim();
      const b = await claim();
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect([...a, ...b].sort()).toEqual(
        [first.blockId, second.blockId].sort(),
      );
      expect(await claim()).toEqual([]);
      const attempts = await all(
        "select storage_attempts from public.content_blocks where id = any($1::uuid[])",
        [[first.blockId, second.blockId]],
      );
      expect(attempts.map((row) => Number(row.storage_attempts))).toEqual([
        1, 1,
      ]);
    },
    CASE_MS,
  );

  it(
    "records an image added between the copy and the lock as pending",
    async () => {
      const first = echoKey("race-a");
      const added = echoKey("race-b");
      await client.query(
        `update public.products
            set image_url = $2, images = array[$2]::text[], description = 'Probe race.'
          where id = $1`,
        [raceProductId, media(first)],
      );
      storage.put("public", first, bytesOf("race a"));
      storage.beforeCopy = async () => {
        storage.beforeCopy = null;
        await client.query(
          "update public.products set images = array_append(images, $2) where id = $1",
          [raceProductId, media(added)],
        );
      };
      const result = await blockItem(
        {
          kind: "product",
          storeId: echoId,
          itemId: raceProductId,
          reason: "terms_breach",
          storeMessage: MESSAGE,
        },
        SUPER,
        { storage },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const archive = await archiveOf(result.blockId);
      const files = archive?.files as Row[];
      const copied = files.find((file) => file.path === first);
      const pending = files.find((file) => file.path === added);
      expect(copied).toMatchObject({ state: "copied", source: "bucket" });
      expect(pending).toMatchObject({ state: "pending", source: "bucket" });
      expect(Number(pending?.n)).toBeGreaterThan(Number(copied?.n));
      expect(archive?.files_state).toBe("pending");
    },
    CASE_MS,
  );
});
