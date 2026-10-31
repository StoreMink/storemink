import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, type DbMock } from "@/app/actions/_test-helpers";
import { moderationEvents } from "@/drizzle/schema";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/storage/gcs", () => ({ GCS_BUCKET_NAME: "sm-media" }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import type { BlockedObjectRow } from "./blocked-objects";
import {
  BlockedUploadError,
  assertUploadAllowed,
  isBlockedUploadError,
} from "./upload-guard";

const STATE_KEY = Symbol.for("storemink.moderation.blockedObjects");
const STORE = "a0000000-0000-4000-8000-000000000001";
const BLOCK = "11111111-1111-4111-8111-111111111111";
const md5 = (text: string) => createHash("md5").update(text).digest("base64");

let db: DbMock;

function blockRows(tellStore = true): BlockedObjectRow[] {
  return [
    {
      id: BLOCK,
      objectPath: `stores/${STORE}/media/a.webp`,
      fileSource: "bucket",
      storeId: STORE,
      objectMd5: md5("blocked"),
      tellStore,
    },
  ];
}

function useDb(options: Parameters<typeof makeDbMock>[0]) {
  db = makeDbMock(options);
  vi.mocked(withService).mockImplementation(async (fn) => fn(db.db));
}

const check = (bytes: string) => ({
  storeId: STORE,
  md5Base64: md5(bytes),
  path: `stores/${STORE}/media/new.webp`,
  via: "upload_route",
  contentType: "image/webp",
});

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
});

describe("assertUploadAllowed", () => {
  it("lets bytes nobody blocked through and records nothing", async () => {
    useDb({ selectByTable: { content_blocks: [blockRows()] } });
    await expect(assertUploadAllowed(check("fresh"))).resolves.toBeUndefined();
    expect(db.calls.insert).toEqual([]);
  });

  it("refuses blocked bytes with the named sentence and records reupload_refused once", async () => {
    useDb({
      selectByTable: { content_blocks: [blockRows()] },
      returning: [{ id: "event-1" }],
    });
    const error = await assertUploadAllowed({
      ...check("blocked"),
      actor: "owner@shop.example.com",
    }).catch((err) => err);
    expect(error).toBeInstanceOf(BlockedUploadError);
    expect(error.message).toBe(
      "StoreMink has blocked this image, so it can't be uploaded again. See Settings, Notices from StoreMink.",
    );
    expect(error).toMatchObject({
      told: true,
      kindWord: "image",
      blockId: BLOCK,
    });
    expect(db.calls.insert).toEqual([moderationEvents]);
    expect(db.calls.values).toEqual([
      {
        actor: "owner@shop.example.com",
        action: "reupload_refused",
        complaintId: null,
        blockId: BLOCK,
        holdId: null,
        storeId: STORE,
        detail: {
          via: "upload_route",
          path: `stores/${STORE}/media/new.webp`,
          md5: md5("blocked"),
          told: true,
        },
      },
    ]);
  });

  it("names nothing for a block kept from the store, and records it as 'system'", async () => {
    useDb({ selectByTable: { content_blocks: [blockRows(false)] } });
    const error = await assertUploadAllowed({
      ...check("blocked"),
      contentType: "application/pdf",
    }).catch((err) => err);
    expect(error.message).toBe(
      "This file can't be uploaded. If you need help, write to support@storemink.com.",
    );
    expect(error).toMatchObject({ told: false, kindWord: "file" });
    expect(db.calls.values).toHaveLength(1);
    expect(db.calls.values[0]).toMatchObject({
      actor: "system",
      detail: { told: false },
    });
  });

  it("still refuses when the record cannot be written", async () => {
    useDb({
      selectByTable: { content_blocks: [blockRows()] },
      failInsertFor: [moderationEvents],
    });
    await expect(assertUploadAllowed(check("blocked"))).rejects.toBeInstanceOf(
      BlockedUploadError,
    );
    expect(logError).toHaveBeenCalledWith(
      "moderation.upload_guard: refused upload not recorded",
      expect.anything(),
      expect.objectContaining({ blockId: BLOCK, via: "upload_route" }),
    );
  });

  it("records one event per refused upload, never more", async () => {
    useDb({ selectByTable: { content_blocks: [blockRows()] } });
    await assertUploadAllowed(check("blocked")).catch(() => undefined);
    await assertUploadAllowed(check("blocked")).catch(() => undefined);
    expect(db.calls.values).toHaveLength(2);
    // The set was read once; the second check used it from memory.
    expect(db.calls.select).toHaveLength(1);
  });
});

describe("isBlockedUploadError", () => {
  it("knows the error, also across a second copy of the module", () => {
    expect(
      isBlockedUploadError(
        new BlockedUploadError({
          told: true,
          kindWord: "image",
          blockId: BLOCK,
        }),
      ),
    ).toBe(true);
    const copy = Object.assign(new Error("x"), {
      name: "BlockedUploadError",
      told: false,
    });
    expect(isBlockedUploadError(copy)).toBe(true);
    expect(isBlockedUploadError(new Error("x"))).toBe(false);
    expect(
      isBlockedUploadError({ name: "BlockedUploadError", told: true }),
    ).toBe(false);
  });
});
