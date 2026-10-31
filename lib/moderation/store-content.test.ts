import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * A whole store's copy (takedown T12, plan A6): the line format, which files
 * the rows name (this database's chat attachments included, another
 * database's left out), the one REPEATABLE READ read with keyset paging, and
 * the create-only write under the block's folder.
 */

const h = vi.hoisted(() => ({
  executed: [] as { text: string; params: unknown[] }[],
  answer: (() => []) as (text: string, params: unknown[]) => unknown[],
  fail: null as Error | null,
}));

vi.mock("@/lib/db/client", () => {
  const dialect = new PgDialect();
  const db = {
    execute: async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      const text = compiled.sql.replace(/\s+/g, " ").trim();
      h.executed.push({ text, params: compiled.params });
      if (h.fail) throw h.fail;
      return { rows: h.answer(text, compiled.params) };
    },
  };
  return {
    withService: vi.fn(async (fn: (value: typeof db) => Promise<unknown>) =>
      fn(db),
    ),
  };
});
vi.mock("@/lib/storage/gcs", () => ({
  GCS_BUCKET_NAME: "mock-media",
  GCS_PRIVATE_BUCKET_NAME: "mock-private",
}));
vi.mock("./storage", async () => {
  const actual = await vi.importActual<typeof import("./storage")>("./storage");
  return { ...actual, writeArchiveObject: vi.fn() };
});
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  STORE_CONTENT_PAGE_SIZE,
  STORE_CONTENT_TABLES,
  StoreContentFileCollector,
  isThisDatabaseAttachmentPath,
  readStoreContent,
  storeContentLine,
  storeContentPendingFiles,
  writeStoreContent,
} from "./store-content";
import { writeArchiveObject, type ModerationStorage } from "./storage";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";

const STORE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BLOCK = "33333333-4444-4555-8666-777777777777";
const MEDIA = "fake-media";
const NOW = new Date("2026-10-30T06:00:00.000Z");
const media = (key: string) => `https://storage.googleapis.com/${MEDIA}/${key}`;
const thisDbAttachment = `stores/${STORE}/mink-attachments/storemink_local/11111111-2222-4333-8444-555555555555.webp`;
const otherDbAttachment = `stores/${STORE}/mink-attachments/storemink/11111111-2222-4333-8444-666666666666.webp`;

function storage(
  privateBucket: string | null = "fake-private",
): ModerationStorage {
  return {
    bucketName: (kind: string) => (kind === "private" ? privateBucket : MEDIA),
    now: () => NOW,
  } as unknown as ModerationStorage;
}

/** Rows a table returns, as readPage selects them (id + row text). */
function rowsFor(table: string): { id: string; row: string }[] {
  switch (table) {
    case "stores":
      return [{ id: STORE, row: JSON.stringify({ id: STORE, slug: "crumb" }) }];
    case "store_chrome":
      return [
        {
          id: STORE,
          row: JSON.stringify({
            store_id: STORE,
            published: { header: { logo: media(`stores/${STORE}/logo.webp`) } },
          }),
        },
      ];
    case "products":
      return [
        {
          id: "00000000-0000-4000-8000-000000000001",
          row: JSON.stringify({
            id: "p1",
            image_url: media(`stores/${STORE}/mug.webp`),
          }),
        },
      ];
    case "mink_attachments":
      return [
        { id: "a1", row: JSON.stringify({ id: "a1", path: thisDbAttachment }) },
        {
          id: "a2",
          row: JSON.stringify({ id: "a2", path: otherDbAttachment }),
        },
        { id: "a3", row: JSON.stringify({ id: "a3", path: thisDbAttachment }) },
      ];
    default:
      return [];
  }
}

function tableOf(text: string): string | null {
  return /from public\.([a-z_]+) t/.exec(text)?.[1] ?? null;
}

beforeEach(() => {
  h.executed = [];
  h.fail = null;
  h.answer = (text) => {
    const table = tableOf(text);
    return table ? rowsFor(table) : [];
  };
  vi.stubEnv("DB_NAME", "storemink_local");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the file's pieces", () => {
  it("writes one JSON line per row, the row as PostgreSQL gave it", () => {
    const line = storeContentLine("products", '{"id":"p1","n":1}');
    expect(line).toBe('{"table":"products","row":{"id":"p1","n":1}}\n');
    expect(JSON.parse(line)).toEqual({
      table: "products",
      row: { id: "p1", n: 1 },
    });
  });

  it("lists mink_attachments last, so the copy includes the store's chat images", () => {
    expect(STORE_CONTENT_TABLES[STORE_CONTENT_TABLES.length - 1]).toBe(
      "mink_attachments",
    );
    expect(STORE_CONTENT_TABLES[0]).toBe("stores");
  });

  it("accepts only this store's attachments of this database", () => {
    expect(isThisDatabaseAttachmentPath(thisDbAttachment, STORE)).toBe(true);
    expect(isThisDatabaseAttachmentPath(otherDbAttachment, STORE)).toBe(false);
    expect(
      isThisDatabaseAttachmentPath(
        thisDbAttachment.replace(STORE, "other"),
        STORE,
      ),
    ).toBe(false);
    expect(
      isThisDatabaseAttachmentPath(
        `stores/${STORE}/mink-attachments/storemink_local/..`,
        STORE,
      ),
    ).toBe(false);
    expect(
      isThisDatabaseAttachmentPath(
        `stores/${STORE}/uploads/storemink_local/x.webp`,
        STORE,
      ),
    ).toBe(false);
    expect(isThisDatabaseAttachmentPath(42, STORE)).toBe(false);
  });

  it("collects each file once and counts another database's attachments", () => {
    const collector = new StoreContentFileCollector(STORE, MEDIA);
    collector.add("products", { image_url: media(`stores/${STORE}/mug.webp`) });
    collector.add("product_variants", {
      images: [media(`stores/${STORE}/mug.webp`)],
    });
    collector.add("mink_attachments", { path: thisDbAttachment });
    collector.add("mink_attachments", { path: thisDbAttachment });
    collector.add("mink_attachments", { path: otherDbAttachment });
    collector.add("mink_attachments", null);
    expect(collector.result()).toEqual({
      media: [{ source: "bucket", key: `stores/${STORE}/mug.webp` }],
      attachments: [thisDbAttachment],
      skippedAttachments: 2,
    });
  });

  it("numbers pending files from 1, media first, then private attachments", () => {
    const entries = storeContentPendingFiles(
      {
        media: [
          { source: "bucket", key: "a.webp" },
          { source: "external", key: "https://cdn.example.com/b.webp" },
        ],
        attachments: [thisDbAttachment],
        skippedAttachments: 0,
      },
      NOW.toISOString(),
    );
    expect(
      entries.map((entry) => [entry.n, entry.source, entry.state]),
    ).toEqual([
      [1, "bucket", "pending"],
      [2, "external", "pending"],
      [3, "private", "pending"],
    ]);
  });
});

describe("readStoreContent", () => {
  it("reads in one REPEATABLE READ, read-only transaction, before anything else", async () => {
    const read = await readStoreContent(STORE, MEDIA);
    expect(read.ok).toBe(true);
    expect(withService).toHaveBeenCalledTimes(1);
    expect(h.executed[0].text).toBe(
      "set transaction isolation level repeatable read, read only",
    );
    const tables = h.executed.slice(1).map((query) => tableOf(query.text));
    expect(tables).toEqual([...STORE_CONTENT_TABLES]);
  });

  it("counts rows, writes the file and lists what the rows name", async () => {
    const read = await readStoreContent(STORE, MEDIA);
    if (!read.ok) throw new Error("expected a read");
    expect(read.rows).toMatchObject({
      stores: 1,
      store_chrome: 1,
      products: 1,
      mink_attachments: 3,
      blogs: 0,
    });
    const lines = new TextDecoder()
      .decode(read.bytes)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { table: string; row: unknown });
    expect(lines.map((line) => line.table)).toEqual([
      "stores",
      "store_chrome",
      "products",
      "mink_attachments",
      "mink_attachments",
      "mink_attachments",
    ]);
    expect(read.files).toEqual({
      media: [
        { source: "bucket", key: `stores/${STORE}/logo.webp` },
        { source: "bucket", key: `stores/${STORE}/mug.webp` },
      ],
      attachments: [thisDbAttachment],
      skippedAttachments: 1,
    });
  });

  it("pages a large table by id, never by offset", async () => {
    const firstPage = Array.from(
      { length: STORE_CONTENT_PAGE_SIZE },
      (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        row: JSON.stringify({ id: i }),
      }),
    );
    h.answer = (text, params) => {
      if (tableOf(text) !== "products") return [];
      return params.length === 2
        ? firstPage
        : [
            {
              id: "ffffffff-0000-4000-8000-000000000000",
              row: '{"id":"last"}',
            },
          ];
    };
    const read = await readStoreContent(STORE, MEDIA);
    if (!read.ok) throw new Error("expected a read");
    expect(read.rows.products).toBe(STORE_CONTENT_PAGE_SIZE + 1);
    const productReads = h.executed.filter(
      (query) => tableOf(query.text) === "products",
    );
    expect(productReads).toHaveLength(2);
    expect(productReads[1].text).toContain(
      "t.id > $2::uuid order by t.id limit $3",
    );
    expect(productReads[1].params).toEqual([
      STORE,
      firstPage[firstPage.length - 1].id,
      STORE_CONTENT_PAGE_SIZE,
    ]);
  });

  it("refuses a store larger than the limit, without logging it as a failure", async () => {
    expect(await readStoreContent(STORE, MEDIA, 50)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("logs and reports a read that failed", async () => {
    h.fail = new Error("connection reset");
    expect(await readStoreContent(STORE, MEDIA)).toEqual({
      ok: false,
      reason: "read_failed",
    });
    expect(logError).toHaveBeenCalledWith(
      "moderation: store copy read failed",
      expect.anything(),
      { storeId: STORE },
    );
  });
});

describe("writeStoreContent", () => {
  beforeEach(() => {
    vi.mocked(writeArchiveObject).mockResolvedValue({
      ok: true,
      created: true,
      generation: "1700",
      size: 321,
      md5: "MD5C==",
      sha256: "c".repeat(64),
    });
  });

  it("refuses without a private bucket, before reading anything", async () => {
    expect(
      await writeStoreContent(
        { storeId: STORE, blockId: BLOCK },
        storage(null),
      ),
    ).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(withService).not.toHaveBeenCalled();
    expect(writeArchiveObject).not.toHaveBeenCalled();
  });

  it("writes the file create-only under the block's folder and lists what it names", async () => {
    const result = await writeStoreContent(
      { storeId: STORE, blockId: BLOCK },
      storage(),
    );
    if (!result.ok) throw new Error("expected a copy");
    const path = `takedown-archive/storemink_local/${BLOCK}/store-content.jsonl`;
    expect(writeArchiveObject).toHaveBeenCalledWith(
      path,
      expect.any(Uint8Array),
      "application/x-ndjson",
      expect.anything(),
    );
    expect(result.entry).toMatchObject({
      n: 0,
      source: "private",
      path: "store-content.jsonl",
      state: "copied",
      sourceBucket: "fake-private",
      archivePath: path,
      archiveGeneration: "1700",
      md5: "MD5C==",
      at: NOW.toISOString(),
    });
    expect(
      result.pending.map((entry) => [entry.n, entry.source, entry.path]),
    ).toEqual([
      [1, "bucket", `stores/${STORE}/logo.webp`],
      [2, "bucket", `stores/${STORE}/mug.webp`],
      [3, "private", thisDbAttachment],
    ]);
    expect(result.content).toMatchObject({
      file: "store-content.jsonl",
      archivePath: path,
      generation: "1700",
      files: 3,
      skippedAttachments: 1,
    });
    expect(result.created).toBe(true);
  });

  it("reports storage that did not take the file as unavailable", async () => {
    vi.mocked(writeArchiveObject).mockResolvedValue({
      ok: false,
      failure: {
        code: "unavailable",
        retryable: true,
        message: "Storage did not answer.",
      },
    });
    expect(
      await writeStoreContent({ storeId: STORE, blockId: BLOCK }, storage()),
    ).toEqual({
      ok: false,
      reason: "unavailable",
      failure: {
        code: "unavailable",
        retryable: true,
        message: "Storage did not answer.",
      },
    });
  });

  it("refuses a block id that is not a UUID before reading", async () => {
    expect(
      await writeStoreContent(
        { storeId: STORE, blockId: "not-a-uuid" },
        storage(),
      ),
    ).toEqual({ ok: false, reason: "read_failed" });
    expect(withService).not.toHaveBeenCalled();
  });
});
