import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";

// ★ No network and no real bucket: gcs.ts is replaced by stand-ins that
//   throw, and every purge below is given an in-memory storage instead.
vi.mock("@/lib/storage/gcs", () => {
  const offline = () => {
    throw new Error("No storage in this test.");
  };
  return {
    GCS_BUCKET_NAME: "sm-media",
    GCS_PRIVATE_BUCKET_NAME: "sm-private",
    gcsObjectMetadata: vi.fn(offline),
    gcsCopyObject: vi.fn(offline),
    gcsUploadObject: vi.fn(offline),
    gcsPrivateUploadObject: vi.fn(offline),
    gcsDownloadObject: vi.fn(offline),
    gcsDeleteGeneration: vi.fn(offline),
    gcsDeletePaths: vi.fn(offline),
  };
});
vi.mock("@/lib/db/client", () => ({ withService: vi.fn(), withAnon: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import { logError, logWarn } from "@/lib/observability/logger";
import type { ModerationStorage } from "./storage";
import {
  ARCHIVE_ERRORS,
  ARCHIVE_PURGE_BATCH_MAX,
  archiveDueSql,
  archiveObjectsOf,
  archivePathsIn,
  extendArchive,
  keepUntilFrom,
  keepUntilTooEarly,
  purgeDueArchiveBatch,
  purgeDueArchives,
  recordArchiveView,
  releaseArchiveHold,
} from "./archive";

const BLOCK = "0f8e6a1c-2b3d-4e5f-8a9b-1c2d3e4f5a6b";
const OTHER_BLOCK = "11111111-2222-4333-8444-555555555555";
const STORE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ARCHIVE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const DB = "storemink_test";
const SUPER = { email: "ops@storemink.com", role: "superadmin" as const };
const MEMBER = { email: "member@storemink.com", role: "member" as const };

const here = (name: string, block = BLOCK) =>
  `takedown-archive/${DB}/${block}/${name}`;
const there = (name: string, block = BLOCK) =>
  `takedown-archive/storemink_staging/${block}/${name}`;

function entry(n: number, overrides: Record<string, unknown> = {}) {
  return {
    n,
    source: "bucket",
    path: `stores/${STORE}/media/photo-${n}.webp`,
    state: "copied",
    sourceBucket: "sm-media",
    sourceGeneration: "100",
    archivePath: here(`${n}-photo-${n}.webp`),
    archiveGeneration: String(200 + n),
    size: 10,
    contentType: "image/webp",
    md5: "bWQ1",
    crc32c: "Y3Jj",
    sha256: null,
    cacheControl: null,
    at: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The array values bound as one parameter (`sql.param([...])`). */
function arrayParams(query: unknown): unknown[][] {
  const out: unknown[][] = [];
  const walk = (chunk: unknown) => {
    if (chunk === null || typeof chunk !== "object") return;
    if (Array.isArray(chunk)) {
      chunk.forEach(walk);
      return;
    }
    const node = chunk as { queryChunks?: unknown; value?: unknown };
    if (node.queryChunks) {
      walk(node.queryChunks);
      return;
    }
    if (chunk.constructor?.name === "Param" && Array.isArray(node.value)) {
      out.push(node.value);
    }
  };
  walk(query);
  return out;
}

let mock: ReturnType<typeof makeDbMock>;

function useDb(opts: Parameters<typeof makeDbMock>[0] = {}) {
  mock = makeDbMock(opts);
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
  return mock;
}

/** The events this test inserted, as rows. */
function insertedEvents() {
  return mock.calls.values as Array<{
    action: string;
    actor: string;
    blockId: string | null;
    storeId: string | null;
    detail: Record<string, unknown>;
  }>;
}

class MemoryStorage implements ModerationStorage {
  generationDeletes: Array<{ path: string; generation: string }> = [];
  pathDeletes: string[][] = [];
  failPaths = new Set<string>();
  bucketName() {
    return "sm-private";
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
    this.generationDeletes.push({ path, generation: String(generation) });
    return "deleted";
  }
  async deletePaths(_kind: string, paths: string[]): Promise<string[]> {
    this.pathDeletes.push(paths);
    return paths.filter((path) => this.failPaths.has(path));
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
    return new Date("2026-10-30T06:00:00.000Z");
  }
}

beforeEach(() => {
  vi.stubEnv("DB_NAME", DB);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── keepUntilFrom ───────────────────────────────────────────────────────────

describe("keepUntilFrom", () => {
  it("reads a calendar date as the end of that day in India time", () => {
    expect(keepUntilFrom("2027-04-24")?.toISOString()).toBe(
      "2027-04-24T18:29:59.000Z",
    );
  });

  it("refuses a date that does not exist and anything that is not a time", () => {
    expect(keepUntilFrom("2027-02-30")).toBeNull();
    expect(keepUntilFrom("next year")).toBeNull();
    expect(keepUntilFrom("")).toBeNull();
    expect(keepUntilFrom(null)).toBeNull();
    expect(keepUntilFrom(new Date("nope"))).toBeNull();
  });

  it("takes a full time or a Date as it is", () => {
    expect(keepUntilFrom("2027-04-24T10:00:00.000Z")?.toISOString()).toBe(
      "2027-04-24T10:00:00.000Z",
    );
    const at = new Date("2028-01-01T00:00:00.000Z");
    expect(keepUntilFrom(at)).toBe(at);
  });

  it("names the date the copy is already kept to", () => {
    expect(keepUntilTooEarly("2027-04-24T10:00:00.000Z")).toBe(
      "Pick a date after 24 Apr 2027.",
    );
  });
});

// ── recordArchiveView ───────────────────────────────────────────────────────

describe("recordArchiveView", () => {
  it("opens a copy only for a superadmin, before any read", async () => {
    useDb();
    expect(await recordArchiveView(BLOCK, "Police asked", MEMBER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.viewSuperadminOnly,
    });
    expect(withService).not.toHaveBeenCalled();
  });

  it("asks for the reason, and keeps it short", async () => {
    useDb();
    expect(await recordArchiveView(BLOCK, "  ", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.reasonMissing,
    });
    expect(await recordArchiveView(BLOCK, "x".repeat(501), SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.reasonLong,
    });
    expect(await recordArchiveView("not-a-block", "Why", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.notFound,
    });
    expect(withService).not.toHaveBeenCalled();
  });

  it("answers not found and already deleted from the archive row", async () => {
    useDb({ executeQueue: [[]] });
    expect(await recordArchiveView(BLOCK, "Why", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.notFound,
    });
    useDb({
      executeQueue: [
        [{ id: ARCHIVE, purged_at: "2027-05-01", files: [], store_id: STORE }],
      ],
    });
    expect(await recordArchiveView(BLOCK, "Why", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.purged,
    });
    expect(mock.calls.insert).toHaveLength(0);
  });

  it("records the view with the reason and answers the receipt", async () => {
    useDb({
      executeQueue: [
        [{ id: ARCHIVE, purged_at: null, files: [entry(1)], store_id: STORE }],
      ],
      returning: [{ id: "event-1" }],
    });
    const result = await recordArchiveView(BLOCK, " Police notice 12 ", SUPER);
    expect(result).toEqual({
      ok: true,
      eventId: "event-1",
      file: null,
      thisDatabase: true,
    });
    expect(insertedEvents()).toEqual([
      expect.objectContaining({
        action: "archive_viewed",
        actor: SUPER.email,
        blockId: BLOCK,
        storeId: STORE,
        detail: { reason: "Police notice 12", what: "copy" },
      }),
    ]);
  });

  it("records a download of one copied file by its number", async () => {
    useDb({
      executeQueue: [
        [
          {
            id: ARCHIVE,
            purged_at: null,
            files: [entry(0), entry(1)],
            store_id: STORE,
          },
        ],
      ],
    });
    const result = await recordArchiveView(BLOCK, "Court asked", SUPER, {
      download: true,
      what: { file: 1 },
    });
    expect(result).toMatchObject({ ok: true, thisDatabase: true });
    if (!result.ok) throw new Error("expected a receipt");
    expect(result.file?.n).toBe(1);
    expect(insertedEvents()[0]).toMatchObject({
      action: "archive_downloaded",
      detail: { reason: "Court asked", what: "file", file: 1 },
    });
  });

  it("refuses a file that was never copied, and says when a copy belongs to another database", async () => {
    useDb({
      executeQueue: [
        [
          {
            id: ARCHIVE,
            purged_at: null,
            files: [entry(2, { state: "missing", archivePath: null })],
            store_id: STORE,
          },
        ],
      ],
    });
    expect(
      await recordArchiveView(BLOCK, "Why", SUPER, { what: { file: 2 } }),
    ).toEqual({ ok: false, error: ARCHIVE_ERRORS.fileNotFound });
    expect(mock.calls.insert).toHaveLength(0);

    useDb({
      executeQueue: [
        [
          {
            id: ARCHIVE,
            purged_at: null,
            files: [entry(3, { archivePath: there("3-photo.webp") })],
            store_id: STORE,
          },
        ],
      ],
    });
    expect(
      await recordArchiveView(BLOCK, "Why", SUPER, { what: { file: 3 } }),
    ).toMatchObject({ ok: true, thisDatabase: false });
  });

  it("answers a plain sentence when the record cannot be written", async () => {
    vi.mocked(withService).mockRejectedValue(new Error("db down"));
    expect(await recordArchiveView(BLOCK, "Why", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.saveFailed,
    });
    expect(logError).toHaveBeenCalledWith(
      "moderation.archive: view not recorded",
      expect.anything(),
      { blockId: BLOCK },
    );
  });
});

// ── extendArchive ───────────────────────────────────────────────────────────

describe("extendArchive", () => {
  const NOW = new Date("2026-10-30T06:00:00.000Z");
  const keptTo = "2027-04-28 06:00:00+00";

  it("is a superadmin's, and needs who asked", async () => {
    useDb();
    expect(
      await extendArchive(BLOCK, { hold: true }, "Police", MEMBER),
    ).toEqual({ ok: false, error: ARCHIVE_ERRORS.keepSuperadminOnly });
    expect(await extendArchive(BLOCK, { hold: true }, " ", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.whoAskedMissing,
    });
    expect(
      await extendArchive(BLOCK, { hold: true }, "x".repeat(501), SUPER),
    ).toEqual({ ok: false, error: ARCHIVE_ERRORS.whoAskedLong });
    expect(withService).not.toHaveBeenCalled();
  });

  it("needs a real date within 20 years", async () => {
    useDb();
    expect(
      await extendArchive(BLOCK, { until: "soon" }, "Court", SUPER, {
        now: NOW,
      }),
    ).toEqual({ ok: false, error: ARCHIVE_ERRORS.untilMissing });
    expect(
      await extendArchive(BLOCK, { until: "2047-01-01" }, "Court", SUPER, {
        now: NOW,
      }),
    ).toEqual({ ok: false, error: ARCHIVE_ERRORS.untilTooFar });
    expect(withService).not.toHaveBeenCalled();
  });

  it("only moves the date later (the database compares), naming the current date otherwise", async () => {
    // The update matches nothing: its own `keep_until <` test refused it.
    useDb({
      executeQueue: [
        [
          {
            id: ARCHIVE,
            keep_until: keptTo,
            legal_hold: false,
            purged_at: null,
            store_id: STORE,
          },
        ],
        [],
      ],
    });
    expect(
      await extendArchive(BLOCK, { until: "2027-04-01" }, "Court", SUPER, {
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "Pick a date after 28 Apr 2027." });
    expect(keepUntilTooEarly(keptTo)).toBe("Pick a date after 28 Apr 2027.");
    expect(mock.calls.insert).toHaveLength(0);
    expect(sqlText(mock.calls.execute[0])).toContain("for update of a");
    const update = sqlText(mock.calls.execute[1]).replace(/\s+/g, " ");
    expect(update).toContain("and keep_until < ");
  });

  it("keeps the copy to a later date and records both dates", async () => {
    useDb({
      executeQueue: [
        [
          {
            id: ARCHIVE,
            keep_until: keptTo,
            legal_hold: false,
            purged_at: null,
            store_id: STORE,
          },
        ],
        [{ keep_until: "2028-01-01 18:29:59+00", legal_hold: false }],
      ],
    });
    const result = await extendArchive(
      BLOCK,
      { until: "2028-01-01" },
      "Cyber cell, letter 44",
      SUPER,
      { now: NOW },
    );
    expect(result).toEqual({
      ok: true,
      keepUntil: "2028-01-01 18:29:59+00",
      legalHold: false,
    });
    const update = mock.calls.execute[1];
    expect(sqlText(update)).toContain("set keep_until");
    expect(sqlParamValues(update)).toContain("2028-01-01T18:29:59.000Z");
    expect(insertedEvents()[0]).toMatchObject({
      action: "archive_kept_longer",
      blockId: BLOCK,
      storeId: STORE,
      detail: {
        from: keptTo,
        until: "2028-01-01T18:29:59.000Z",
        whoAsked: "Cyber cell, letter 44",
      },
    });
  });

  it("puts a legal hold on the copy once, with who asked", async () => {
    useDb({
      executeQueue: [
        [
          {
            id: ARCHIVE,
            keep_until: keptTo,
            legal_hold: true,
            purged_at: null,
            store_id: STORE,
          },
        ],
      ],
    });
    expect(await extendArchive(BLOCK, { hold: true }, "Court", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.alreadyHeld,
    });

    useDb({
      executeQueue: [
        [
          {
            id: ARCHIVE,
            keep_until: keptTo,
            legal_hold: false,
            purged_at: null,
            store_id: STORE,
          },
        ],
        [{ keep_until: keptTo }],
      ],
    });
    expect(
      await extendArchive(BLOCK, { hold: true }, "High Court order 7", SUPER),
    ).toEqual({ ok: true, keepUntil: keptTo, legalHold: true });
    const update = mock.calls.execute[1];
    expect(sqlText(update)).toContain("legal_hold = true");
    expect(sqlParamValues(update)).toEqual(
      expect.arrayContaining(["High Court order 7", SUPER.email]),
    );
    expect(insertedEvents()[0]).toMatchObject({
      action: "archive_hold_set",
      detail: { whoAsked: "High Court order 7" },
    });
  });

  it("answers not found and already deleted", async () => {
    useDb({ executeQueue: [[]] });
    expect(await extendArchive(BLOCK, { hold: true }, "Court", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.notFound,
    });
    useDb({
      executeQueue: [
        [
          {
            id: ARCHIVE,
            keep_until: keptTo,
            legal_hold: false,
            purged_at: "2027-05-01",
            store_id: STORE,
          },
        ],
      ],
    });
    expect(await extendArchive(BLOCK, { hold: true }, "Court", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.purged,
    });
  });
});

// ── releaseArchiveHold ──────────────────────────────────────────────────────

describe("releaseArchiveHold", () => {
  it("is a superadmin's and needs a note", async () => {
    useDb();
    expect(await releaseArchiveHold(BLOCK, "Done", MEMBER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.releaseSuperadminOnly,
    });
    expect(await releaseArchiveHold(BLOCK, "", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.noteMissing,
    });
    expect(await releaseArchiveHold(BLOCK, "x".repeat(2001), SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.noteLong,
    });
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses a copy that is not on hold", async () => {
    useDb({
      executeQueue: [
        [
          {
            id: ARCHIVE,
            keep_until: "2027-04-28",
            legal_hold: false,
            purged_at: null,
            store_id: STORE,
          },
        ],
      ],
    });
    expect(await releaseArchiveHold(BLOCK, "Done", SUPER)).toEqual({
      ok: false,
      error: ARCHIVE_ERRORS.notHeld,
    });
    expect(mock.calls.execute).toHaveLength(1);
  });

  it("releases the hold and records the note", async () => {
    useDb({
      executeQueue: [
        [
          {
            id: ARCHIVE,
            keep_until: "2027-04-28",
            legal_hold: true,
            purged_at: null,
            store_id: STORE,
          },
        ],
        [],
      ],
    });
    expect(await releaseArchiveHold(BLOCK, "The case closed.", SUPER)).toEqual({
      ok: true,
      keepUntil: "2027-04-28",
    });
    expect(sqlText(mock.calls.execute[1])).toContain("legal_hold = false");
    expect(insertedEvents()[0]).toMatchObject({
      action: "archive_hold_released",
      detail: { note: "The case closed." },
    });
  });
});

// ── What the purge may take ─────────────────────────────────────────────────

describe("archiveDueSql", () => {
  it("takes only due, unheld, finished archives of stores nothing holds", () => {
    const text = sqlText(archiveDueSql()).replace(/\s+/g, " ");
    expect(text).toContain("a.purged_at is null");
    expect(text).toContain("not a.legal_hold");
    expect(text).toContain("a.keep_until <= now()");
    expect(text).toContain("a.files_state in ('none', 'copied')");
    expect(text).toContain("b.storage_state <> 'restoring'");
    expect(text).toContain("store_legal_holds");
    expect(text).toContain("h.released_at is null");
  });
});

describe("archivePathsIn and archiveObjectsOf", () => {
  it("finds this block's archive paths in any database, never another block's", () => {
    const snapshot = {
      title: "A product",
      nested: [
        { image: here("4-a.webp") },
        there("5-b.webp"),
        here("6-c.webp", OTHER_BLOCK),
        "stores/x/media/a.webp",
        "takedown-archive/bad name/x/y",
        here("4-a.webp"),
      ],
    };
    expect(archivePathsIn(snapshot, BLOCK).sort()).toEqual(
      [here("4-a.webp"), there("5-b.webp")].sort(),
    );
    expect(archivePathsIn(null, BLOCK)).toEqual([]);
  });

  it("lists every object once, pinned to its generation when known", () => {
    const objects = archiveObjectsOf({
      blockId: BLOCK,
      itemKind: "product",
      files: [
        entry(1),
        { archivePath: here("2-raw.webp"), archiveGeneration: "9" },
        { archivePath: 17 },
        "nonsense",
      ],
      snapshot: { files: [here("1-photo-1.webp"), here("3-extra.webp")] },
    });
    expect(objects).toEqual([
      { path: here("1-photo-1.webp"), generation: "201" },
      { path: here("2-raw.webp"), generation: "9" },
      { path: here("3-extra.webp"), generation: null },
    ]);
  });

  it("adds a whole-store block's content file", () => {
    expect(
      archiveObjectsOf({
        blockId: BLOCK,
        itemKind: "store",
        files: [],
        snapshot: {},
      }),
    ).toEqual([{ path: here("store-content.jsonl"), generation: null }]);
  });
});

// ── The nightly purge ───────────────────────────────────────────────────────

describe("purgeDueArchiveBatch", () => {
  const candidate = { id: ARCHIVE, block_id: BLOCK };
  const locked = (files: unknown[], snapshot: unknown = { title: "x" }) => ({
    id: ARCHIVE,
    block_id: BLOCK,
    files,
    snapshot,
    item_kind: "file",
    store_id: STORE,
  });

  it("does nothing for an empty batch or once out of time", async () => {
    useDb();
    expect(await purgeDueArchiveBatch(0)).toEqual([]);
    const run = { deadline: 1_000, clock: () => 999 };
    expect(await purgeDueArchiveBatch(10, { run })).toEqual([]);
    expect(run).toMatchObject({ outOfTime: true });
    expect(withService).not.toHaveBeenCalled();
  });

  it("asks for at most the batch ceiling, oldest first, setting aside what this run skipped", async () => {
    useDb({ executeQueue: [[]] });
    const skip = new Set([OTHER_BLOCK]);
    await purgeDueArchiveBatch(500, { run: { skip } });
    const read = mock.calls.execute[0];
    const text = sqlText(read).replace(/\s+/g, " ");
    expect(text).toContain("not a.legal_hold");
    expect(text).toContain("order by a.keep_until, a.id");
    expect(text).toContain("::uuid[]");
    expect(sqlParamValues(read)).toContain(ARCHIVE_PURGE_BATCH_MAX);
    expect(arrayParams(read)).toEqual([[OTHER_BLOCK]]);
  });

  it("empties the row before deleting the files, then records the purge", async () => {
    const storage = new MemoryStorage();
    useDb({
      executeQueue: [
        [candidate],
        [locked([entry(1), entry(2, { archiveGeneration: null })])],
        [{ id: ARCHIVE }],
      ],
    });
    const timeline: string[] = [];
    const execute = vi.mocked(mock.db.execute);
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (query: unknown) => {
      timeline.push(
        sqlText(query).includes("set snapshot = null") ? "empty row" : "read",
      );
      return original(query);
    });
    const deleteGeneration = storage.deleteGeneration.bind(storage);
    storage.deleteGeneration = async (kind, path, generation) => {
      timeline.push("delete object");
      return deleteGeneration(kind, path, generation);
    };
    const outcomes = await purgeDueArchiveBatch(10, { storage });
    expect(outcomes).toEqual([
      {
        archiveId: ARCHIVE,
        blockId: BLOCK,
        status: "purged",
        objects: 2,
        deleted: 2,
        missing: 0,
      },
    ]);
    // ★ The guard vets the emptying first; an object is deleted only after.
    expect(timeline.indexOf("empty row")).toBeGreaterThan(-1);
    expect(timeline.indexOf("empty row")).toBeLessThan(
      timeline.indexOf("delete object"),
    );
    const emptyText = sqlText(mock.calls.execute[2]);
    expect(emptyText).toContain("set snapshot = null");
    expect(emptyText).toContain("purged_at = now()");
    expect(sqlText(mock.calls.execute[1])).toContain("skip locked");
    expect(storage.generationDeletes).toEqual([
      { path: here("1-photo-1.webp"), generation: "201" },
    ]);
    expect(storage.pathDeletes).toEqual([[here("2-photo-2.webp")]]);
    expect(insertedEvents()).toEqual([
      expect.objectContaining({
        action: "archive_purged",
        actor: "system",
        blockId: BLOCK,
        storeId: STORE,
        detail: { objects: 2, deleted: 2, missing: 0 },
      }),
    ]);
  });

  it("purges a copy with no files without touching storage", async () => {
    const storage = new MemoryStorage();
    useDb({
      executeQueue: [[candidate], [locked([])], [{ id: ARCHIVE }]],
    });
    expect(await purgeDueArchiveBatch(10, { storage })).toEqual([
      expect.objectContaining({ status: "purged", objects: 0, deleted: 0 }),
    ]);
    expect(storage.generationDeletes).toEqual([]);
    expect(storage.pathDeletes).toEqual([]);
  });

  it("answers busy when the archive is locked or no longer due", async () => {
    useDb({ executeQueue: [[candidate], []] });
    const skip = new Set<string>();
    expect(await purgeDueArchiveBatch(10, { run: { skip } })).toEqual([
      { archiveId: ARCHIVE, blockId: BLOCK, status: "busy" },
    ]);
    expect(skip.has(ARCHIVE)).toBe(true);
    expect(mock.calls.insert).toHaveLength(0);
  });

  it("skips another database's archive, deletes nothing and records the skip", async () => {
    const storage = new MemoryStorage();
    useDb({
      executeQueue: [
        [candidate],
        [locked([entry(1, { archivePath: there("1-photo.webp") })])],
        [{ id: ARCHIVE }],
      ],
    });
    const skip = new Set<string>();
    const outcomes = await purgeDueArchiveBatch(10, {
      storage,
      run: { skip },
    });
    expect(outcomes).toEqual([
      {
        archiveId: ARCHIVE,
        blockId: BLOCK,
        status: "skipped",
        databases: ["storemink_staging"],
      },
    ]);
    expect(storage.generationDeletes).toEqual([]);
    expect(storage.pathDeletes).toEqual([]);
    expect(skip.has(ARCHIVE)).toBe(true);
    // The purge's own scope threw (rolled back), and the skip was recorded
    // in a scope of its own.
    expect(withService).toHaveBeenCalledTimes(3);
    expect(insertedEvents()).toEqual([
      expect.objectContaining({
        action: "archive_purge_skipped",
        blockId: BLOCK,
        storeId: STORE,
        detail: { reason: "other_database", databases: ["storemink_staging"] },
      }),
    ]);
    expect(logWarn).toHaveBeenCalledWith(
      "moderation.archive: purge skipped, another database",
      expect.objectContaining({ archiveId: ARCHIVE }),
    );
  });

  it("leaves the row for the next night when a delete fails", async () => {
    const storage = new MemoryStorage();
    storage.failPaths.add(here("1-photo-1.webp"));
    useDb({
      executeQueue: [[candidate], [locked([entry(1)])], [{ id: ARCHIVE }]],
    });
    const outcomes = await purgeDueArchiveBatch(10, { storage });
    expect(outcomes).toEqual([
      {
        archiveId: ARCHIVE,
        blockId: BLOCK,
        status: "failed",
        failedPaths: [here("1-photo-1.webp")],
      },
    ]);
    expect(insertedEvents()).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "moderation.archive: purge left for the next night",
      expect.anything(),
      expect.objectContaining({ archiveId: ARCHIVE, failed: 1 }),
    );
  });

  it("reports a database refusal (a held copy, say) as failed, never as purged", async () => {
    const storage = new MemoryStorage();
    useDb({ executeQueue: [[candidate], [locked([entry(1)])]] });
    vi.mocked(mock.db.execute).mockImplementationOnce(async () => ({
      rows: [candidate],
    }));
    vi.mocked(mock.db.execute).mockImplementationOnce(async () => ({
      rows: [locked([entry(1)])],
    }));
    vi.mocked(mock.db.execute).mockImplementationOnce(async () => {
      throw new Error("content_block_archives: held or not yet due");
    });
    expect(await purgeDueArchiveBatch(10, { storage })).toEqual([
      { archiveId: ARCHIVE, blockId: BLOCK, status: "failed", failedPaths: [] },
    ]);
    expect(storage.generationDeletes).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "moderation.archive: purge failed",
      expect.anything(),
      { archiveId: ARCHIVE, blockId: BLOCK },
    );
  });
});

describe("purgeDueArchives", () => {
  it("answers how many archives the batch handled, purged or not", async () => {
    const storage = new MemoryStorage();
    const second = "cccccccc-dddd-4eee-8fff-000000000000";
    useDb({
      executeQueue: [
        [
          { id: ARCHIVE, block_id: BLOCK },
          { id: second, block_id: OTHER_BLOCK },
        ],
        [
          {
            id: ARCHIVE,
            block_id: BLOCK,
            files: [],
            snapshot: {},
            item_kind: "page",
            store_id: STORE,
          },
        ],
        [{ id: ARCHIVE }],
        [],
      ],
    });
    const run = { skip: new Set<string>() };
    expect(await purgeDueArchives(20, run, { storage })).toBe(2);
    expect([...run.skip]).toEqual([second]);
  });
});
