import { createHash } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, type DbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/storage/gcs", () => ({ GCS_BUCKET_NAME: "sm-media" }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import { logError, logWarn } from "@/lib/observability/logger";
import {
  BLOCKED_SET_MAX_AGE_MS,
  type BlockedObjectRow,
  blockedMedia,
  buildBlockedMediaSet,
  canonicalMd5,
  findBlockedUpload,
  forgetBlockedObjects,
  isBlockedAddressIn,
  isBlockedMediaUrl,
  isBlockedUploadBytes,
} from "./blocked-objects";

const STATE_KEY = Symbol.for("storemink.moderation.blockedObjects");
const STORE = "a0000000-0000-4000-8000-000000000001";
const OTHER_STORE = "b0000000-0000-4000-8000-000000000002";
const BUCKET_URL = "https://storage.googleapis.com/sm-media";

const md5 = (text: string) => createHash("md5").update(text).digest("base64");

function row(overrides: Partial<BlockedObjectRow>): BlockedObjectRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    objectPath: `stores/${STORE}/media/a.webp`,
    fileSource: "bucket",
    storeId: STORE,
    objectMd5: null,
    tellStore: true,
    ...overrides,
  };
}

const ROWS_A = [row({ objectPath: `stores/${STORE}/media/a.webp` })];
const ROWS_B = [row({ objectPath: `stores/${STORE}/media/b.webp` })];

/** Each load of the set answers the next entry; a function decides late. */
function serveLoads(
  ...loads: (BlockedObjectRow[] | Error | Promise<unknown>)[]
) {
  const mocks: DbMock[] = [];
  vi.mocked(withService).mockImplementation(async (fn) => {
    const next = loads.length ? loads.shift()! : [];
    if (next instanceof Promise) {
      const rows = await next;
      if (rows instanceof Error) throw rows;
      const mock = makeDbMock({
        selectByTable: { content_blocks: [rows as BlockedObjectRow[]] },
      });
      mocks.push(mock);
      return fn(mock.db);
    }
    if (next instanceof Error) throw next;
    const mock = makeDbMock({ selectByTable: { content_blocks: [next] } });
    mocks.push(mock);
    return fn(mock.db);
  });
  return mocks;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
  vi.useFakeTimers({ now: new Date("2026-10-30T10:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("blockedMedia", () => {
  it("loads live file blocks with one query, through the service scope", async () => {
    const mocks = serveLoads(ROWS_A);
    const set = await blockedMedia();
    expect(set.keys.has(`stores/${STORE}/media/a.webp`)).toBe(true);
    expect(withService).toHaveBeenCalledTimes(1);
    expect(Object.keys(mocks[0].calls.select[0]).sort()).toEqual([
      "fileSource",
      "id",
      "objectMd5",
      "objectPath",
      "storeId",
      "tellStore",
    ]);
    const where = new PgDialect().sqlToQuery(mocks[0].calls.where[0]).sql;
    expect(where).toContain('"content_blocks"."lifted_at" is null');
    expect(where).toContain('"content_blocks"."object_path" is not null');
  });

  it("uses a fresh set without asking the database again", async () => {
    serveLoads(ROWS_A, ROWS_B);
    await blockedMedia();
    vi.advanceTimersByTime(BLOCKED_SET_MAX_AGE_MS - 1);
    const set = await blockedMedia();
    expect(set.keys.has(`stores/${STORE}/media/a.webp`)).toBe(true);
    expect(withService).toHaveBeenCalledTimes(1);
  });

  it("reloads a stale set before it is used", async () => {
    serveLoads(ROWS_A, ROWS_B);
    await blockedMedia();
    vi.advanceTimersByTime(BLOCKED_SET_MAX_AGE_MS + 1);
    const set = await blockedMedia();
    expect(withService).toHaveBeenCalledTimes(2);
    expect(set.keys.has(`stores/${STORE}/media/b.webp`)).toBe(true);
    expect(set.keys.has(`stores/${STORE}/media/a.webp`)).toBe(false);
  });

  it("runs one reload at a time under concurrent calls", async () => {
    const slow = deferred<BlockedObjectRow[]>();
    serveLoads(slow.promise);
    const calls = [blockedMedia(), blockedMedia(), blockedMedia()];
    await vi.advanceTimersByTimeAsync(10);
    expect(withService).toHaveBeenCalledTimes(1);
    slow.resolve(ROWS_A);
    const sets = await Promise.all(calls);
    expect(new Set(sets).size).toBe(1);
    expect(sets[0].keys.has(`stores/${STORE}/media/a.webp`)).toBe(true);
  });

  it("falls back to the last good set when a reload is slower than 2 seconds", async () => {
    const slow = deferred<BlockedObjectRow[]>();
    serveLoads(ROWS_A, slow.promise);
    await blockedMedia();
    vi.advanceTimersByTime(BLOCKED_SET_MAX_AGE_MS + 1);
    const waiting = blockedMedia();
    await vi.advanceTimersByTimeAsync(2_000);
    const set = await waiting;
    expect(set.keys.has(`stores/${STORE}/media/a.webp`)).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(
      "moderation.blocked_objects: reload slower than 2 s",
      expect.objectContaining({ usingLastGood: true }),
    );
    // The slow reload still lands and is used from then on.
    slow.resolve(ROWS_B);
    await vi.advanceTimersByTimeAsync(0);
    const after = await blockedMedia();
    expect(after.keys.has(`stores/${STORE}/media/b.webp`)).toBe(true);
    expect(withService).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good set when a reload fails, and logs at most once a minute", async () => {
    serveLoads(ROWS_A, new Error("down"), new Error("down"), new Error("down"));
    await blockedMedia();

    vi.advanceTimersByTime(BLOCKED_SET_MAX_AGE_MS + 1);
    let set = await blockedMedia();
    expect(set.keys.has(`stores/${STORE}/media/a.webp`)).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      "moderation.blocked_objects: reload failed",
      expect.any(Error),
      expect.objectContaining({ usingLastGood: true }),
    );

    // Within the back-off nobody asks the database again.
    vi.advanceTimersByTime(1_000);
    set = await blockedMedia();
    expect(withService).toHaveBeenCalledTimes(2);
    expect(set.keys.has(`stores/${STORE}/media/a.webp`)).toBe(true);

    // After it, the next caller tries again; the failure is not logged twice
    // inside a minute.
    vi.advanceTimersByTime(5_000);
    await blockedMedia();
    expect(withService).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await blockedMedia();
    expect(withService).toHaveBeenCalledTimes(4);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it("answers an empty set when the first load fails", async () => {
    serveLoads(new Error("down"));
    const set = await blockedMedia();
    expect(set.size).toBe(0);
    expect(set.keys.size).toBe(0);
  });

  it("forgetBlockedObjects forces a reload of a fresh set", async () => {
    serveLoads(ROWS_A, ROWS_B);
    await blockedMedia();
    forgetBlockedObjects();
    const set = await blockedMedia();
    expect(withService).toHaveBeenCalledTimes(2);
    expect(set.keys.has(`stores/${STORE}/media/b.webp`)).toBe(true);
  });

  it("a forget during a reload runs a second reload after the first, never beside it", async () => {
    const first = deferred<BlockedObjectRow[]>();
    serveLoads(first.promise, ROWS_B);
    const early = blockedMedia();
    await vi.advanceTimersByTimeAsync(0);
    forgetBlockedObjects();
    const late = blockedMedia();
    await vi.advanceTimersByTimeAsync(0);
    expect(withService).toHaveBeenCalledTimes(1);
    first.resolve(ROWS_A);
    const [earlySet, lateSet] = await Promise.all([early, late]);
    expect(withService).toHaveBeenCalledTimes(2);
    expect(earlySet.keys.has(`stores/${STORE}/media/a.webp`)).toBe(true);
    expect(lateSet.keys.has(`stores/${STORE}/media/b.webp`)).toBe(true);
  });

  it("reads a missing table as nothing blocked, with a warning", async () => {
    serveLoads(
      Object.assign(new Error("relation does not exist"), { code: "42P01" }),
    );
    const set = await blockedMedia();
    expect(set.size).toBe(0);
    expect(logWarn).toHaveBeenCalledWith(
      "moderation.blocked_objects: table not ready, nothing blocked",
    );
    expect(logError).not.toHaveBeenCalled();
    // The empty set counts as a good load: nobody asks again for 30 seconds.
    await blockedMedia();
    expect(withService).toHaveBeenCalledTimes(1);
  });
});

describe("buildBlockedMediaSet", () => {
  it("indexes every source's key, the outside hosts and the MD5s", () => {
    const set = buildBlockedMediaSet(
      [
        row({ id: "b1", objectMd5: md5("one") }),
        row({
          id: "b2",
          objectPath: "https://CDN.example.com:443/x/bag.jpg",
          fileSource: "external",
          storeId: STORE,
        }),
        row({
          id: "b3",
          objectPath: "/themes/vitrine/hero.webp",
          fileSource: "bundled",
          storeId: null,
        }),
        row({
          id: "b4",
          objectPath: "theme-releases/luxe/1.0.0/hero-ab.webp",
          storeId: null,
          objectMd5: md5("theme"),
        }),
      ],
      { bucket: "sm-media", loadedAt: 1 },
    );
    expect(set.size).toBe(4);
    expect(set.sourceCounts).toEqual({ bucket: 2, external: 1, bundled: 1 });
    expect(set.keys.has("https://cdn.example.com/x/bag.jpg")).toBe(true);
    expect(set.keys.has("/themes/vitrine/hero.webp")).toBe(true);
    expect([...set.externalHosts]).toEqual(["cdn.example.com"]);
    expect(set.md5ByStore.get(STORE)?.get(md5("one"))?.blockId).toBe("b1");
    expect(set.themeReleaseMd5.get(md5("theme"))?.blockId).toBe("b4");
    expect(set.anyMd5.size).toBe(2);
  });

  it("infers the source of a row written without one", () => {
    const set = buildBlockedMediaSet(
      [
        row({ objectPath: "/themes/a/b.webp", fileSource: null }),
        row({ objectPath: "https://cdn.example.com/c.png", fileSource: "?" }),
      ],
      { bucket: "sm-media", loadedAt: 1 },
    );
    expect(set.sourceCounts).toEqual({ bucket: 0, external: 1, bundled: 1 });
  });

  it("names the told block when a told and an untold block share bytes", () => {
    const set = buildBlockedMediaSet(
      [
        row({ id: "untold", objectMd5: md5("x"), tellStore: false }),
        row({
          id: "told",
          objectPath: `stores/${STORE}/media/copy.webp`,
          objectMd5: md5("x"),
        }),
      ],
      { bucket: "sm-media", loadedAt: 1 },
    );
    expect(set.md5ByStore.get(STORE)?.get(md5("x"))).toMatchObject({
      blockId: "told",
      told: true,
    });
  });

  it("reads a hex MD5 as its base64 form", () => {
    const hex = createHash("md5").update("one").digest("hex");
    expect(canonicalMd5(hex)).toBe(md5("one"));
    expect(canonicalMd5(md5("one"))).toBe(md5("one"));
    expect(canonicalMd5("not an md5")).toBeNull();
    expect(canonicalMd5(null)).toBeNull();
  });
});

describe("findBlockedUpload", () => {
  const set = buildBlockedMediaSet(
    [
      row({ id: "told", objectMd5: md5("told") }),
      row({
        id: "kept",
        objectPath: `stores/${STORE}/media/order.pdf`,
        objectMd5: md5("kept"),
        tellStore: false,
      }),
      row({
        id: "other",
        objectPath: `stores/${OTHER_STORE}/media/x.webp`,
        storeId: OTHER_STORE,
        objectMd5: md5("other"),
      }),
      row({
        id: "release",
        objectPath: "theme-releases/luxe/1.0.0/hero-ab.webp",
        storeId: null,
        objectMd5: md5("release"),
      }),
    ],
    { bucket: "sm-media", loadedAt: 1 },
  );

  it("refuses the same store's blocked bytes, named as the block says", () => {
    expect(
      findBlockedUpload(set, {
        storeId: STORE,
        md5Base64: md5("told"),
        path: `stores/${STORE}/media/new.webp`,
      }),
    ).toEqual({ blockId: "told", told: true, kindWord: "image" });
    expect(
      findBlockedUpload(set, {
        storeId: STORE.toUpperCase(),
        md5Base64: md5("kept"),
        path: `stores/${STORE}/media/new.pdf`,
      }),
    ).toEqual({ blockId: "kept", told: false, kindWord: "file" });
  });

  it("uses the uploaded file's type for the word when it is given", () => {
    expect(
      findBlockedUpload(set, {
        storeId: STORE,
        md5Base64: md5("told"),
        path: `stores/${STORE}/media/new.bin`,
        contentType: "application/pdf",
      }),
    ).toMatchObject({ kindWord: "file" });
  });

  it("lets another store's blocked bytes through to a store path", () => {
    expect(
      findBlockedUpload(set, {
        storeId: STORE,
        md5Base64: md5("other"),
        path: `stores/${STORE}/media/new.webp`,
      }),
    ).toBeNull();
  });

  it("refuses a blocked theme release image's bytes on a store path, unnamed", () => {
    expect(
      findBlockedUpload(set, {
        storeId: STORE,
        md5Base64: md5("release"),
        path: `stores/${STORE}/media/new.webp`,
      }),
    ).toEqual({ blockId: "release", told: false, kindWord: "image" });
  });

  it("refuses any blocked file's bytes on a theme-releases path, unnamed", () => {
    for (const bytes of ["told", "other", "release"]) {
      expect(
        findBlockedUpload(set, {
          storeId: null,
          md5Base64: md5(bytes),
          path: "theme-releases/new/1.0.0/slot.webp",
        }),
      ).toMatchObject({ told: false });
    }
  });

  it("answers null for unknown bytes or an unreadable MD5", () => {
    expect(
      findBlockedUpload(set, { storeId: STORE, md5Base64: md5("fresh") }),
    ).toBeNull();
    expect(
      findBlockedUpload(set, { storeId: STORE, md5Base64: "" }),
    ).toBeNull();
  });
});

describe("isBlockedMediaUrl and isBlockedUploadBytes", () => {
  it("look the address and the bytes up in the process-wide set", async () => {
    serveLoads([row({ objectMd5: md5("bytes") })]);
    expect(
      await isBlockedMediaUrl(`${BUCKET_URL}/stores/${STORE}/media/a.webp`),
    ).toBe(true);
    expect(
      await isBlockedMediaUrl(
        `https://sm-media.storage.googleapis.com/stores/${STORE}/media/a%2Ewebp?x=1`,
      ),
    ).toBe(true);
    expect(
      await isBlockedMediaUrl(`${BUCKET_URL}/stores/${STORE}/media/ok.webp`),
    ).toBe(false);
    expect(await isBlockedMediaUrl("")).toBe(false);
    expect(await isBlockedUploadBytes(STORE, md5("bytes"))).toMatchObject({
      told: true,
    });
    expect(await isBlockedUploadBytes(STORE, md5("else"))).toBeNull();
    expect(withService).toHaveBeenCalledTimes(1);
  });

  it("isBlockedAddressIn answers false at once on an empty set", () => {
    const empty = buildBlockedMediaSet([], { bucket: "sm-media", loadedAt: 1 });
    expect(isBlockedAddressIn(empty, `${BUCKET_URL}/stores/x/a.webp`)).toBe(
      false,
    );
  });
});
