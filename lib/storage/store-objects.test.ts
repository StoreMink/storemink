import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, type DbMock } from "@/app/actions/_test-helpers";
import { moderationEvents } from "@/drizzle/schema";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/storage/gcs", () => ({
  GCS_BUCKET_NAME: "sm-media",
  DEFAULT_PUBLIC_CACHE_CONTROL: "public, max-age=60",
  gcsUploadObject: vi.fn(
    async (path: string) => `https://storage.googleapis.com/sm-media/${path}`,
  ),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import { gcsUploadObject } from "@/lib/storage/gcs";
import type { BlockedObjectRow } from "@/lib/moderation/blocked-objects";
import { BlockedUploadError } from "@/lib/moderation/upload-guard";
import {
  md5Base64Of,
  storeObjectPathProblem,
  writeStoreObject,
} from "./store-objects";

const STATE_KEY = Symbol.for("storemink.moderation.blockedObjects");
const STORE = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const BLOCKED_BYTES = new TextEncoder().encode("blocked picture");
const RELEASE_BYTES = new TextEncoder().encode("blocked theme picture");
const FRESH_BYTES = new TextEncoder().encode("a new picture");

const md5 = (bytes: Uint8Array) =>
  createHash("md5").update(bytes).digest("base64");

let db: DbMock;

function serve(rows: BlockedObjectRow[]) {
  db = makeDbMock({ selectByTable: { content_blocks: [rows] } });
  vi.mocked(withService).mockImplementation(async (fn) => fn(db.db));
}

const ROWS: BlockedObjectRow[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    objectPath: `stores/${STORE}/media/a.webp`,
    fileSource: "bucket",
    storeId: STORE,
    objectMd5: md5(BLOCKED_BYTES),
    tellStore: true,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    objectPath: "theme-releases/luxe/1.0.0/hero-ab.webp",
    fileSource: "bucket",
    storeId: null,
    objectMd5: md5(RELEASE_BYTES),
    tellStore: true,
  },
];

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
  serve(ROWS);
});

describe("writeStoreObject", () => {
  it("refuses a store's own blocked bytes and writes nothing", async () => {
    await expect(
      writeStoreObject(
        `stores/${STORE}/media/again.webp`,
        BLOCKED_BYTES,
        "image/webp",
        {
          storeId: STORE,
          via: "media_library",
        },
      ),
    ).rejects.toBeInstanceOf(BlockedUploadError);
    expect(gcsUploadObject).not.toHaveBeenCalled();
    expect(db.calls.insert).toEqual([moderationEvents]);
    expect(db.calls.values[0]).toMatchObject({
      action: "reupload_refused",
      storeId: STORE,
      detail: {
        via: "media_library",
        path: `stores/${STORE}/media/again.webp`,
      },
    });
  });

  it("refuses a blocked theme release image's bytes on a store path, unnamed", async () => {
    const error = await writeStoreObject(
      `stores/${STORE}/media/hero.webp`,
      RELEASE_BYTES,
      "image/webp",
      { storeId: STORE },
    ).catch((err) => err);
    expect(error).toBeInstanceOf(BlockedUploadError);
    expect(error.told).toBe(false);
    expect(gcsUploadObject).not.toHaveBeenCalled();
  });

  it("refuses any blocked file's bytes for a theme release", async () => {
    await expect(
      writeStoreObject(
        "theme-releases/new/1.0.0/slot.webp",
        BLOCKED_BYTES,
        "image/webp",
        {
          storeId: null,
        },
      ),
    ).rejects.toBeInstanceOf(BlockedUploadError);
    expect(gcsUploadObject).not.toHaveBeenCalled();
  });

  it("writes other bytes with the default cache control, after the check", async () => {
    const url = await writeStoreObject(
      `stores/${STORE}/media/new.webp`,
      FRESH_BYTES,
      "image/webp",
      { storeId: STORE },
    );
    expect(url).toBe(
      `https://storage.googleapis.com/sm-media/stores/${STORE}/media/new.webp`,
    );
    expect(gcsUploadObject).toHaveBeenCalledWith(
      `stores/${STORE}/media/new.webp`,
      FRESH_BYTES,
      "image/webp",
      "public, max-age=60",
      {},
    );
    expect(vi.mocked(withService).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gcsUploadObject).mock.invocationCallOrder[0],
    );
    expect(db.calls.insert).toEqual([]);
  });

  it("passes the cache control and metadata it was given", async () => {
    await writeStoreObject(
      "theme-releases/luxe/1.1.0/slot.webp",
      FRESH_BYTES,
      "image/webp",
      {
        storeId: null,
        cacheControl: "public, max-age=31536000, immutable",
        metadata: { "storemink-slot": "hero" },
      },
    );
    expect(gcsUploadObject).toHaveBeenCalledWith(
      "theme-releases/luxe/1.1.0/slot.webp",
      FRESH_BYTES,
      "image/webp",
      "public, max-age=31536000, immutable",
      { metadata: { "storemink-slot": "hero" } },
    );
  });

  it("lets another store's blocked bytes through to this store", async () => {
    serve([
      {
        ...ROWS[0],
        storeId: OTHER,
        objectPath: `stores/${OTHER}/media/a.webp`,
      },
    ]);
    await writeStoreObject(
      `stores/${STORE}/media/a.webp`,
      BLOCKED_BYTES,
      "image/webp",
      {
        storeId: STORE,
      },
    );
    expect(gcsUploadObject).toHaveBeenCalledTimes(1);
  });

  it("refuses a path it may not write before reading or writing anything", async () => {
    const refused: [string, string | null][] = [
      [`/stores/${STORE}/media/a.webp`, STORE],
      [`stores/${STORE}/media/../a.webp`, STORE],
      [`stores/${STORE}//a.webp`, STORE],
      [`stores\\${STORE}\\a.webp`, STORE],
      [`stores/${OTHER}/media/a.webp`, STORE],
      [`stores/${STORE}/media/a.webp`, null],
      [`stores/${STORE}`, STORE],
      ["platform/uploads/a.webp", null],
      ["theme-releases/luxe/1.0.0/a.webp", STORE],
      ["", STORE],
    ];
    for (const [path, storeId] of refused) {
      await expect(
        writeStoreObject(path, FRESH_BYTES, "image/webp", { storeId }),
        path,
      ).rejects.toThrow(/^writeStoreObject: /);
    }
    expect(withService).not.toHaveBeenCalled();
    expect(gcsUploadObject).not.toHaveBeenCalled();
  });
});

describe("storeObjectPathProblem and md5Base64Of", () => {
  it("accepts a store path in any case of its store id, and a release path", () => {
    expect(
      storeObjectPathProblem(
        `stores/${STORE.toUpperCase()}/media/a.webp`,
        STORE,
      ),
    ).toBeNull();
    expect(
      storeObjectPathProblem("theme-releases/a/1.0.0/b.webp", null),
    ).toBeNull();
  });

  it("hashes the bytes as Google's md5Hash does (base64)", () => {
    expect(md5Base64Of(FRESH_BYTES)).toBe(md5(FRESH_BYTES));
    expect(md5Base64Of(FRESH_BYTES)).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
