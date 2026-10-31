import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Unit checks of blocking and lifting (takedown stage T12): the order design
 * 5.3 asks for (archive before the block, the store's copy before a store is
 * suspended), the lift's order (originals back before the blocked set is
 * forgotten, T7), the claims, and every refusal. The database is a fake that
 * answers by statement; storage, the notices, IndexNow and the record are
 * mocks. The real transaction runs in block.local.test.ts.
 */

const h = vi.hoisted(() => ({
  sequence: [] as string[],
  executed: [] as { text: string; params: unknown[] }[],
  scopes: 0,
  replies: [] as {
    match: RegExp;
    reply: (params: unknown[], text: string) => unknown[] | Promise<unknown[]>;
  }[],
}));

vi.mock("@/lib/db/client", () => {
  const dialect = new PgDialect();
  const db = {
    execute: async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      const text = compiled.sql.replace(/\s+/g, " ").trim();
      h.executed.push({ text, params: compiled.params });
      for (const entry of h.replies) {
        if (entry.match.test(text)) {
          return { rows: await entry.reply(compiled.params, text) };
        }
      }
      return { rows: [] };
    },
  };
  return {
    withService: vi.fn(async (fn: (value: typeof db) => Promise<unknown>) => {
      h.scopes += 1;
      return fn(db);
    }),
    withUser: vi.fn(() => {
      throw new Error("not used");
    }),
    withAnon: vi.fn(() => {
      throw new Error("not used");
    }),
  };
});
vi.mock("@/lib/storage/gcs", () => ({
  GCS_BUCKET_NAME: "mock-media",
  GCS_PRIVATE_BUCKET_NAME: "mock-private",
  gcsObjectMetadata: vi.fn(async () => {
    throw new Error("no storage in tests");
  }),
  gcsCopyObject: vi.fn(async () => {
    throw new Error("no storage in tests");
  }),
  gcsUploadObject: vi.fn(async () => {
    throw new Error("no storage in tests");
  }),
  gcsPrivateUploadObject: vi.fn(async () => {
    throw new Error("no storage in tests");
  }),
  gcsDownloadObject: vi.fn(async () => {
    throw new Error("no storage in tests");
  }),
  gcsDeleteGeneration: vi.fn(async () => {
    throw new Error("no storage in tests");
  }),
  gcsDeletePaths: vi.fn(async () => {
    throw new Error("no storage in tests");
  }),
}));
vi.mock("./storage", async () => {
  const actual = await vi.importActual<typeof import("./storage")>("./storage");
  return {
    ...actual,
    archiveBucketFile: vi.fn(),
    discardArchiveCopy: vi.fn(),
    restoreFromArchive: vi.fn(),
  };
});
vi.mock("./store-content", () => ({ writeStoreContent: vi.fn() }));
vi.mock("./notify", () => ({
  tellStoreOfBlock: vi.fn(),
  tellStoreOfLift: vi.fn(),
  tellStoreOfReply: vi.fn(),
}));
vi.mock("./blocked-objects", () => ({ forgetBlockedObjects: vi.fn() }));
vi.mock("@/lib/seo/search-engines", () => ({ pingIndexNow: vi.fn() }));
vi.mock("./complaints", () => ({
  actionComplaintForBlock: vi.fn(),
  storeLabelFor: vi.fn(
    (store: { name: string; slug: string }) =>
      `${store.name} (${store.slug}.storemink.com)`,
  ),
}));
vi.mock("./record", () => ({ recordModerationEvent: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  BLOCK_ERRORS,
  BLOCK_WARNINGS,
  addStoreEmailedReply,
  blockItem,
  deliverBlockNotice,
  liftBlock,
  markRemovedByHand,
  replyToStore,
  retryStorage,
  tellStoreNow,
  validateBlockInput,
  type BlockInput,
} from "./block";
import {
  archiveBucketFile,
  discardArchiveCopy,
  restoreFromArchive,
  type ArchivedFile,
  type ModerationStorage,
} from "./storage";
import { writeStoreContent } from "./store-content";
import { tellStoreOfBlock, tellStoreOfLift, tellStoreOfReply } from "./notify";
import { forgetBlockedObjects } from "./blocked-objects";
import { pingIndexNow } from "@/lib/seo/search-engines";
import { actionComplaintForBlock, type ModerationOperator } from "./complaints";
import { recordModerationEvent } from "./record";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { snapshotSha256 } from "./snapshot";

const STORE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_STORE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const PRODUCT = "11111111-2222-4333-8444-555555555555";
const REVIEW = "22222222-3333-4444-8555-666666666666";
const BLOCK = "33333333-4444-4555-8666-777777777777";
const CHILD = "44444444-5555-4666-8777-888888888888";
const COMPLAINT = "55555555-6666-4777-8888-999999999999";
const NOW = new Date("2026-10-30T06:00:00.000Z");
const SUPER: ModerationOperator = {
  email: "super@storemink.test",
  role: "superadmin",
};
const MEMBER: ModerationOperator = {
  email: "ops@storemink.test",
  role: "member",
};
const MEDIA = "fake-media";
const IMG_A = `stores/${STORE}/uploads/mug-a.webp`;
const IMG_B = `stores/${STORE}/uploads/mug-b.webp`;
const url = (key: string) => `https://storage.googleapis.com/${MEDIA}/${key}`;

const storage = {
  bucketName: (kind: string) => (kind === "private" ? "fake-private" : MEDIA),
  now: () => NOW,
} as unknown as ModerationStorage;

const storeRow = {
  id: STORE,
  slug: "crumb",
  name: "Crumb & Co",
  status: "active",
  custom_domain: null,
  settings: {},
  plan: "free",
  plan_expires_at: null,
  comp_plan: null,
  comp_expires_at: null,
};

let productRow: Record<string, unknown>;
let lockedProductRow: Record<string, unknown> | null;
let liveBlock: boolean;
let liveImagePaths: string[];
let complaintRow: Record<string, unknown> | null;
let insertError: unknown;
let claimRow: Record<string, unknown> | null;

function copied(blockId: string, n: number, key: string): ArchivedFile {
  return {
    n,
    source: "bucket",
    path: key,
    state: "copied",
    sourceBucket: MEDIA,
    sourceGeneration: "100",
    archivePath: `takedown-archive/default/${blockId}/${n}-${key.split("/").pop()}`,
    archiveGeneration: "200",
    size: 10,
    contentType: "image/webp",
    md5: "MD5A==",
    crc32c: null,
    sha256: null,
    cacheControl: "public, max-age=3600",
    at: NOW.toISOString(),
  };
}

function inserts(table: "content_blocks" | "content_block_archives") {
  return h.executed.filter((q) =>
    q.text.startsWith(`insert into public.${table} `),
  );
}

/** content_blocks insert parameters by name (insertBlockRow's order). */
function blockValues(params: unknown[]) {
  const names = [
    "id",
    "storeId",
    "storeLabel",
    "kind",
    "itemId",
    "objectPath",
    "objectMd5",
    "fileSource",
    "authorUserId",
    "parentItemId",
    "storeStatusBefore",
    "parentBlockId",
    "itemLabel",
    "itemUrl",
    "complaintId",
    "reason",
    "legalBasis",
    "storeMessage",
    "tellStore",
    "storageState",
    "storageStateCase",
    "actor",
  ];
  return Object.fromEntries(names.map((name, i) => [name, params[i]]));
}

function archiveValues(params: unknown[]) {
  return {
    blockId: params[0],
    storeId: params[1],
    json: String(params[2]),
    sha256: params[3],
    files: JSON.parse(String(params[4])) as Record<string, unknown>[],
    filesState: params[5],
  };
}

function productInput(extra: Partial<BlockInput> = {}): BlockInput {
  return {
    kind: "product",
    storeId: STORE,
    itemId: PRODUCT,
    reason: "terms_breach",
    storeMessage: "We removed this product because it breaks our rules.",
    ...extra,
  };
}

beforeEach(() => {
  h.sequence = [];
  h.executed = [];
  h.scopes = 0;
  productRow = {
    id: PRODUCT,
    store_id: STORE,
    name: "Blue mug",
    slug: "blue-mug",
    image_url: url(IMG_A),
    images: [url(IMG_A)],
    category_id: null,
    created_at: "2026-10-01T00:00:00+00:00",
  };
  lockedProductRow = null;
  liveBlock = false;
  liveImagePaths = [];
  complaintRow = null;
  insertError = null;
  claimRow = null;
  h.replies = [
    { match: /^set transaction/, reply: () => [] },
    {
      match: /^select \$1::jsonb as v$/,
      reply: (p) => [{ v: JSON.parse(String(p[0])) }],
    },
    {
      match: /to_jsonb\(s\) as row from public\.stores s/,
      reply: (_p, text) => {
        if (text.includes("for update")) h.sequence.push("lock-store");
        return [{ row: storeRow }];
      },
    },
    {
      match: /from public\.admins a/,
      reply: () => [{ email: "owner@crumb.test" }],
    },
    {
      match: /to_jsonb\(c\) as row from public\.store_chrome c/,
      reply: () => [
        {
          row: {
            store_id: STORE,
            draft: { header: { logo: "draft" } },
            published: { header: { logo: "live" }, footer: { note: "f" } },
          },
        },
      ],
    },
    {
      match: /to_jsonb\(t\) as row from public\.products t/,
      reply: (_p, text) => {
        if (text.includes("for update")) {
          h.sequence.push("lock-item");
          return [{ row: lockedProductRow ?? productRow }];
        }
        return [{ row: productRow }];
      },
    },
    {
      match: /to_jsonb\(t\) as row from public\.product_reviews t/,
      reply: () => [
        {
          row: {
            id: REVIEW,
            store_id: STORE,
            product_id: PRODUCT,
            user_id: "shopper-1",
            comment: "Terrible words",
          },
        },
      ],
    },
    {
      match:
        /jsonb_build_object\('id', p\.id, 'name', p\.name, 'slug', p\.slug\)/,
      reply: () => [
        { row: { id: PRODUCT, name: "Blue mug", slug: "blue-mug" } },
      ],
    },
    {
      match: /^select b\.id from public\.content_blocks b/,
      reply: () => (liveBlock ? [{ id: "live" }] : []),
    },
    {
      match: /^select b\.object_path from public\.content_blocks b/,
      reply: () => liveImagePaths.map((object_path) => ({ object_path })),
    },
    {
      match: /^select c\.id::text as id, c\.ref_no/,
      reply: () => (complaintRow ? [complaintRow] : []),
    },
    {
      match: /^insert into public\.content_blocks /,
      reply: (p) => {
        h.sequence.push(`insert-block:${String(p[0])}`);
        if (insertError) throw insertError;
        return [{ blocked_at: "2026-10-30 06:00:00.123456+00" }];
      },
    },
    {
      match: /^insert into public\.content_block_archives /,
      reply: (p) => {
        h.sequence.push(`insert-archive:${String(p[0])}`);
        return [];
      },
    },
    {
      match: /^update public\.content_blocks b set notice_claimed_at = now\(\)/,
      reply: () => (claimRow ? [claimRow] : []),
    },
  ];
  vi.mocked(archiveBucketFile).mockImplementation(async (input) => {
    h.sequence.push(`archive:${input.path}`);
    return {
      ok: true,
      created: true,
      file: copied(input.blockId, input.n, input.path),
    };
  });
  vi.mocked(discardArchiveCopy).mockImplementation(async (copy) => {
    h.sequence.push(`discard:${copy.path}`);
    return { ok: true, result: "deleted" };
  });
  vi.mocked(recordModerationEvent).mockImplementation(async (_db, input) => {
    h.sequence.push(`event:${input.action}`);
    return "event-id";
  });
  vi.mocked(actionComplaintForBlock).mockImplementation(async () => {
    h.sequence.push("complaint-actioned");
    return true;
  });
  vi.mocked(forgetBlockedObjects).mockImplementation(() => {
    h.sequence.push("forget");
  });
  vi.mocked(pingIndexNow).mockImplementation(async () => {
    h.sequence.push("ping");
  });
  vi.mocked(tellStoreOfBlock).mockImplementation(async () => {
    h.sequence.push("tell-block");
    return {
      bellEventId: "ev-1",
      storeFound: true,
      recipients: 1,
      sent: 1,
      failed: 0,
    };
  });
  vi.mocked(tellStoreOfLift).mockImplementation(async () => {
    h.sequence.push("tell-lift");
    return {
      bellEventId: "ev-2",
      storeFound: true,
      recipients: 1,
      sent: 1,
      failed: 0,
    };
  });
  vi.mocked(tellStoreOfReply).mockImplementation(async () => ({
    bellEventId: "ev-3",
    storeFound: true,
    recipients: 1,
    sent: 1,
    failed: 0,
  }));
});

// ── Validation ───────────────────────────────────────────────────────────────

describe("validateBlockInput", () => {
  const check = (input: Partial<BlockInput>, operator = SUPER) =>
    validateBlockInput(
      { ...productInput(), ...input } as BlockInput,
      operator,
      MEDIA,
    );
  const error = (input: Partial<BlockInput>, operator = SUPER) => {
    const result = check(input, operator);
    return result.ok ? null : result.error;
  };

  it("needs an operator, a kind and a reason", () => {
    expect(error({}, { email: " ", role: "superadmin" })).toBe(
      BLOCK_ERRORS.notOperator,
    );
    expect(error({ kind: "thing" as never })).toBe(BLOCK_ERRORS.chooseKind);
    expect(error({ reason: "because" as never })).toBe(
      BLOCK_ERRORS.chooseReason,
    );
  });

  it("allows a store's own request only for a review or a comment", () => {
    expect(error({ reason: "store_request" })).toBe(
      BLOCK_ERRORS.storeRequestKind,
    );
    expect(
      error({ kind: "review", itemId: REVIEW, reason: "store_request" }),
    ).toBeNull();
  });

  it("lets only a superadmin suspend a store or keep a block from it", () => {
    expect(error({ kind: "store", itemId: STORE }, MEMBER)).toBe(
      BLOCK_ERRORS.storeSuperadmin,
    );
    expect(error({ tellStore: false }, MEMBER)).toBe(
      BLOCK_ERRORS.untoldSuperadmin,
    );
    expect(error({ tellStore: false })).toBe(BLOCK_ERRORS.untoldNeedsOrder);
    expect(error({ tellStore: false, reason: "court_order" })).toBe(
      BLOCK_ERRORS.untoldNeedsOrder,
    );
    expect(
      error({
        tellStore: false,
        reason: "court_order",
        legalBasis: "Order 12/2026",
      }),
    ).toBeNull();
  });

  it("bounds the message and the legal basis", () => {
    expect(error({ storeMessage: "   " })).toBe(BLOCK_ERRORS.messageMissing);
    expect(error({ storeMessage: "x".repeat(2001) })).toBe(
      BLOCK_ERRORS.messageTooLong,
    );
    expect(error({ legalBasis: "x".repeat(1001) })).toBe(
      BLOCK_ERRORS.legalBasisTooLong,
    );
    expect(error({ complaintId: "SM-1" })).toBe(BLOCK_ERRORS.complaintNotFound);
  });

  it("reads a file's store from its path and refuses another store's file", () => {
    const fromPath = check({
      kind: "file",
      storeId: null,
      itemId: null,
      fileAddress: url(IMG_A),
    });
    expect(fromPath.ok && fromPath.value.storeId).toBe(STORE);
    expect(fromPath.ok && fromPath.value.file?.key).toEqual({
      source: "bucket",
      key: IMG_A,
    });
    expect(
      error({
        kind: "file",
        storeId: OTHER_STORE,
        itemId: null,
        fileAddress: url(IMG_A),
      }),
    ).toBe(BLOCK_ERRORS.fileOtherStore);
    expect(
      error({ kind: "file", itemId: null, fileAddress: "not an address" }),
    ).toBe(BLOCK_ERRORS.notStoreMinkFile);
    expect(
      error({
        kind: "file",
        itemId: null,
        fileAddress: `${url("stores")}/../x.webp`,
      }),
    ).toBe(BLOCK_ERRORS.notStoreMinkFile);
  });

  it("keeps ticked images once each, at most 50, and only for items that have them", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      url(`stores/${STORE}/u/${i}.webp`),
    );
    const result = check({
      alsoBlockImages: [url(IMG_A), url(IMG_A), ...many],
    });
    expect(result.ok && result.value.images.length).toBe(50);
    expect(result.ok && result.value.images[0].key.key).toBe(IMG_A);
    const review = check({
      kind: "review",
      itemId: REVIEW,
      alsoBlockImages: [url(IMG_A)],
    });
    expect(review.ok && review.value.images).toEqual([]);
  });
});

// ── Blocking ─────────────────────────────────────────────────────────────────

describe("blockItem", () => {
  it("archives the item's files BEFORE the block row exists, then hides it in one transaction", async () => {
    const result = await blockItem(productInput(), SUPER, { storage });
    expect(result.ok).toBe(true);
    const blockId = result.ok ? result.blockId : "";
    const archived = h.sequence.indexOf(`archive:${IMG_A}`);
    const inserted = h.sequence.indexOf(`insert-block:${blockId}`);
    expect(archived).toBeGreaterThanOrEqual(0);
    expect(inserted).toBeGreaterThan(archived);
    expect(h.sequence.indexOf("lock-item")).toBeLessThan(inserted);
    expect(h.sequence.indexOf(`insert-archive:${blockId}`)).toBeGreaterThan(
      inserted,
    );
    // Two scopes before the notice: the read and the one transaction.
    const [row] = inserts("content_blocks");
    const values = blockValues(row.params);
    expect(values).toMatchObject({
      id: blockId,
      storeId: STORE,
      kind: "product",
      itemId: PRODUCT,
      storageState: "none",
      itemLabel: "Blue mug",
      itemUrl: "https://crumb.storemink.com/shop/blue-mug",
      storeLabel: "Crumb & Co (crumb.storemink.com)",
      actor: SUPER.email,
    });
    const archive = archiveValues(inserts("content_block_archives")[0].params);
    expect(archive.filesState).toBe("copied");
    expect(archive.files).toHaveLength(1);
    expect(archive.files[0]).toMatchObject({
      n: 1,
      state: "copied",
      path: IMG_A,
    });
    // The hash is the one over the jsonb read back.
    expect(archive.sha256).toBe(snapshotSha256(JSON.parse(archive.json)));
    const snapshot = JSON.parse(archive.json);
    expect(snapshot.store.chrome.published).toEqual({
      header: { logo: "live" },
      footer: { note: "f" },
    });
    expect(snapshot.store.owners).toEqual(["owner@crumb.test"]);
    expect(snapshot.addresses).toEqual([
      "https://crumb.storemink.com/shop/blue-mug",
    ]);
  });

  it("forgets the blocked set, tells the store and pings IndexNow only after the commit", async () => {
    claimRow = {
      store_id: STORE,
      item_kind: "product",
      item_label: "Blue mug",
      object_path: null,
      reason_kind: "terms_breach",
      complaint_id: null,
      store_message: "msg",
      blocked_at: "2026-10-30 06:00:00.123456+00",
      claimed_at: "2026-10-30 06:00:01.5+00",
      ref_no: null,
    };
    const result = await blockItem(productInput(), SUPER, { storage });
    expect(result.ok).toBe(true);
    const blockId = result.ok ? result.blockId : "";
    const committed = h.sequence.indexOf(`insert-archive:${blockId}`);
    expect(h.sequence.indexOf("forget")).toBeGreaterThan(committed);
    expect(h.sequence.indexOf("tell-block")).toBeGreaterThan(
      h.sequence.indexOf("forget"),
    );
    expect(pingIndexNow).toHaveBeenCalledWith([
      "https://crumb.storemink.com/shop/blue-mug",
    ]);
    expect(h.sequence).toContain("event:merchant_notified");
    const settle = h.executed.find((q) =>
      q.text.startsWith(
        "update public.content_blocks set merchant_notified_at = now(), notice_claimed_at = null",
      ),
    );
    expect(settle?.params).toEqual([blockId, "2026-10-30 06:00:01.5+00"]);
  });

  it("sends no notice for a block kept from the store", async () => {
    const result = await blockItem(
      productInput({
        tellStore: false,
        reason: "court_order",
        legalBasis: "Order 7",
      }),
      SUPER,
      { storage },
    );
    expect(result.ok).toBe(true);
    expect(tellStoreOfBlock).not.toHaveBeenCalled();
    expect(
      h.executed.some((q) => q.text.includes("notice_claimed_at = now()")),
    ).toBe(false);
  });

  it("records an image the item gained between the copy and the lock as pending", async () => {
    lockedProductRow = {
      ...productRow,
      images: [url(IMG_A), url(IMG_B)],
    };
    const result = await blockItem(productInput(), SUPER, { storage });
    expect(result.ok).toBe(true);
    const archive = archiveValues(inserts("content_block_archives")[0].params);
    expect(archive.filesState).toBe("pending");
    expect(archive.files).toEqual([
      expect.objectContaining({ n: 1, state: "copied", path: IMG_A }),
      expect.objectContaining({
        n: 2,
        state: "pending",
        source: "bucket",
        path: IMG_B,
      }),
    ]);
    expect(archiveBucketFile).toHaveBeenCalledTimes(1);
  });

  it("lists a copy that did not finish for the follow-up and still blocks the file", async () => {
    vi.mocked(archiveBucketFile).mockResolvedValueOnce({
      ok: false,
      failure: { code: "unavailable", retryable: true, message: "down" },
    });
    const result = await blockItem(
      {
        kind: "file",
        fileAddress: url(IMG_A),
        reason: "terms_breach",
        storeMessage: "We removed this image.",
      },
      SUPER,
      { storage },
    );
    expect(result).toMatchObject({
      ok: true,
      warnings: [BLOCK_WARNINGS.archivePending],
    });
    const values = blockValues(inserts("content_blocks")[0].params);
    expect(values).toMatchObject({
      kind: "file",
      storeId: STORE,
      objectPath: IMG_A,
      fileSource: "bucket",
      storageState: "pending",
      objectMd5: null,
      itemLabel: "mug-a.webp",
    });
    const archive = archiveValues(inserts("content_block_archives")[0].params);
    expect(archive.filesState).toBe("pending");
    expect(archive.files[0]).toMatchObject({ state: "pending", path: IMG_A });
    // A file block pings nothing (its pages did not move).
    expect(pingIndexNow).not.toHaveBeenCalled();
  });

  it("starts an outside file as not ours and a theme file as manual", async () => {
    await blockItem(
      {
        kind: "file",
        storeId: STORE,
        fileAddress: "https://cdn.example.com/a/b.webp?x=1",
        reason: "terms_breach",
        storeMessage: "We removed this image.",
      },
      SUPER,
      { storage },
    );
    await blockItem(
      {
        kind: "file",
        fileAddress: "/themes/basket/hero.webp",
        reason: "terms_breach",
        storeMessage: "We removed this image.",
      },
      SUPER,
      { storage },
    );
    const [outside, bundled] = inserts("content_blocks").map((q) =>
      blockValues(q.params),
    );
    expect(outside).toMatchObject({
      fileSource: "external",
      storageState: "not_ours",
      objectPath: "https://cdn.example.com/a/b.webp",
    });
    expect(bundled).toMatchObject({
      fileSource: "bundled",
      storageState: "manual",
      storeId: null,
      objectPath: "/themes/basket/hero.webp",
    });
    expect(archiveBucketFile).not.toHaveBeenCalled();
    // A block with no store tells nobody.
    expect(
      h.executed.filter((q) => q.text.includes("notice_claimed_at = now()")),
    ).toHaveLength(1);
  });

  it("blocks the ticked images as their own file blocks and skips one already blocked", async () => {
    liveImagePaths = [IMG_B];
    const result = await blockItem(
      productInput({ alsoBlockImages: [url(IMG_A), url(IMG_B)] }),
      SUPER,
      { storage },
    );
    expect(result).toMatchObject({
      ok: true,
      warnings: [BLOCK_WARNINGS.imagesAlreadyBlocked],
    });
    const rows = inserts("content_blocks").map((q) => blockValues(q.params));
    expect(rows).toHaveLength(2);
    const child = rows[1];
    expect(child).toMatchObject({
      kind: "file",
      objectPath: IMG_A,
      parentBlockId: result.ok ? result.blockId : "",
      storageState: "pending",
      objectMd5: "MD5A==",
    });
    expect(result.ok && result.childBlockIds).toEqual([child.id]);
  });

  it("actions the complaint in the same transaction and refuses another store's complaint", async () => {
    complaintRow = { id: COMPLAINT, ref_no: 42, store_id: STORE };
    const result = await blockItem(
      productInput({ complaintId: COMPLAINT }),
      MEMBER,
      {
        storage,
      },
    );
    expect(result.ok).toBe(true);
    expect(actionComplaintForBlock).toHaveBeenCalledWith(expect.anything(), {
      complaintId: COMPLAINT,
      actor: MEMBER.email,
      blockId: result.ok ? result.blockId : "",
      storeId: STORE,
    });
    const archive = archiveValues(inserts("content_block_archives")[0].params);
    expect(JSON.parse(archive.json).block.complaint).toEqual({
      id: COMPLAINT,
      ref: "SM-000042",
    });

    complaintRow = { id: COMPLAINT, ref_no: 42, store_id: OTHER_STORE };
    const refused = await blockItem(
      productInput({ complaintId: COMPLAINT }),
      MEMBER,
      {
        storage,
      },
    );
    expect(refused).toEqual({
      ok: false,
      error: BLOCK_ERRORS.complaintOtherStore,
    });
  });

  it("refuses a second block of the same item before copying anything", async () => {
    liveBlock = true;
    const result = await blockItem(productInput(), SUPER, { storage });
    expect(result).toEqual({ ok: false, error: BLOCK_ERRORS.alreadyBlocked });
    expect(archiveBucketFile).not.toHaveBeenCalled();
  });

  it("deletes the copies it made when the transaction fails, and says why", async () => {
    insertError = Object.assign(new Error("dup"), { code: "23505" });
    expect(await blockItem(productInput(), SUPER, { storage })).toEqual({
      ok: false,
      error: BLOCK_ERRORS.alreadyBlocked,
    });
    expect(
      h.sequence.some((s) => s.startsWith("discard:takedown-archive/")),
    ).toBe(true);
    expect(forgetBlockedObjects).not.toHaveBeenCalled();

    insertError = new Error("failed", {
      cause: new Error("content_blocks: no product x in store y as recorded"),
    });
    expect(await blockItem(productInput(), SUPER, { storage })).toEqual({
      ok: false,
      error: BLOCK_ERRORS.changed,
    });

    insertError = new Error("connection reset");
    expect(await blockItem(productInput(), SUPER, { storage })).toEqual({
      ok: false,
      error: BLOCK_ERRORS.failed,
    });
    expect(logError).toHaveBeenCalledWith(
      "moderation: block failed",
      expect.anything(),
      expect.objectContaining({ kind: "product" }),
    );
  });

  it("writes the store's copy before the suspension, and lists the files it names", async () => {
    vi.mocked(writeStoreContent).mockImplementation(async (input) => {
      h.sequence.push("store-content");
      return {
        ok: true,
        created: true,
        content: {
          file: "store-content.jsonl",
          archivePath: `takedown-archive/default/${input.blockId}/store-content.jsonl`,
          generation: "9",
          size: 120,
          md5: "MD5C==",
          sha256: "f".repeat(64),
          rows: { stores: 1, mink_attachments: 1 },
          files: 1,
          skippedAttachments: 0,
        },
        entry: {
          ...copied(input.blockId, 0, "store-content.jsonl"),
          source: "private",
          archivePath: `takedown-archive/default/${input.blockId}/store-content.jsonl`,
        },
        pending: [
          {
            n: 1,
            source: "private",
            path: `stores/${STORE}/mink-attachments/default/x.webp`,
            state: "pending",
            at: NOW.toISOString(),
            expectedMd5: null,
          },
        ],
      };
    });
    const result = await blockItem(
      {
        kind: "store",
        storeId: STORE,
        reason: "terms_breach",
        storeMessage: "We suspended your store.",
      },
      SUPER,
      { storage },
    );
    expect(result.ok).toBe(true);
    const blockId = result.ok ? result.blockId : "";
    expect(h.sequence.indexOf("store-content")).toBeLessThan(
      h.sequence.indexOf(`insert-block:${blockId}`),
    );
    expect(h.sequence.indexOf("lock-store")).toBeLessThan(
      h.sequence.indexOf(`insert-block:${blockId}`),
    );
    const values = blockValues(inserts("content_blocks")[0].params);
    expect(values).toMatchObject({
      kind: "store",
      itemId: STORE,
      storeStatusBefore: "active",
      itemLabel: "Crumb & Co",
      itemUrl: "https://crumb.storemink.com/",
    });
    const archive = archiveValues(inserts("content_block_archives")[0].params);
    expect(archive.filesState).toBe("pending");
    expect(archive.files.map((f) => [f.n, f.state])).toEqual([
      [0, "copied"],
      [1, "pending"],
    ]);
    expect(JSON.parse(archive.json).storeContent.file).toBe(
      "store-content.jsonl",
    );
  });

  it("refuses a whole-store block when storage is unavailable, before any transaction", async () => {
    vi.mocked(writeStoreContent).mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });
    const result = await blockItem(
      {
        kind: "store",
        storeId: STORE,
        reason: "terms_breach",
        storeMessage: "x",
      },
      SUPER,
      { storage },
    );
    expect(result).toEqual({ ok: false, error: BLOCK_ERRORS.storageForStore });
    expect(inserts("content_blocks")).toHaveLength(0);
    expect(withService).toHaveBeenCalledTimes(1); // the read only
    expect(forgetBlockedObjects).not.toHaveBeenCalled();

    vi.mocked(writeStoreContent).mockResolvedValue({
      ok: false,
      reason: "too_large",
    });
    expect(
      await blockItem(
        {
          kind: "store",
          storeId: STORE,
          reason: "terms_breach",
          storeMessage: "x",
        },
        SUPER,
        { storage },
      ),
    ).toEqual({ ok: false, error: BLOCK_ERRORS.storeTooLarge });
  });

  it("records a review with its author and product", async () => {
    const result = await blockItem(
      {
        kind: "review",
        storeId: STORE,
        itemId: REVIEW,
        reason: "store_request",
        storeMessage: "We removed this review at your request.",
      },
      MEMBER,
      { storage },
    );
    expect(result.ok).toBe(true);
    expect(blockValues(inserts("content_blocks")[0].params)).toMatchObject({
      kind: "review",
      authorUserId: "shopper-1",
      parentItemId: PRODUCT,
      itemLabel: "Blue mug: Terrible words",
      itemUrl: "https://crumb.storemink.com/shop/blue-mug",
    });
  });
});

// ── The notice ───────────────────────────────────────────────────────────────

describe("deliverBlockNotice", () => {
  it("skips a block it cannot claim", async () => {
    expect(await deliverBlockNotice(BLOCK, "ops")).toBe("skipped");
    expect(tellStoreOfBlock).not.toHaveBeenCalled();
  });

  it("clears the claim and records the failure, saying whether the bell rang", async () => {
    claimRow = {
      store_id: STORE,
      item_kind: "store",
      item_label: "Crumb & Co",
      object_path: null,
      reason_kind: "court_order",
      complaint_id: COMPLAINT,
      store_message: "msg",
      blocked_at: "2026-10-30 06:00:00+00",
      claimed_at: "2026-10-30 06:00:02+00",
      ref_no: 7,
    };
    vi.mocked(tellStoreOfBlock).mockResolvedValue({
      bellEventId: "ev",
      storeFound: true,
      recipients: 2,
      sent: 0,
      failed: 2,
    });
    expect(await deliverBlockNotice(BLOCK, "ops", { bell: false })).toBe(
      "failed",
    );
    expect(tellStoreOfBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        itemLabel: "",
        complaintRefNo: 7,
        kind: "store",
      }),
      { bell: false },
    );
    expect(recordModerationEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "merchant_notify_failed",
        detail: { bell: true, storeFound: true, recipients: 2, failed: 2 },
      }),
    );
    const cleared = h.executed.find((q) =>
      q.text.startsWith(
        "update public.content_blocks set notice_claimed_at = null",
      ),
    );
    expect(cleared?.params).toEqual([BLOCK, "2026-10-30 06:00:02+00"]);
  });
});

// ── Lifting ──────────────────────────────────────────────────────────────────

describe("liftBlock", () => {
  let main: Record<string, unknown> | null;
  let lifted: Record<string, unknown>[];
  let busy: boolean;

  beforeEach(() => {
    main = {
      id: BLOCK,
      store_id: STORE,
      item_kind: "file",
      item_label: "mug-a.webp",
      item_url: url(IMG_A),
      object_path: IMG_A,
      tell_store: true,
      lifted_at: null,
    };
    lifted = [
      {
        id: BLOCK,
        was: "replaced",
        state: "restoring",
        object_path: IMG_A,
        claimed_at: "2026-10-30 06:10:00.000001+00",
      },
    ];
    busy = false;
    h.replies.unshift(
      {
        match:
          /^select b\.id::text as id, b\.store_id::text as store_id, b\.item_kind/,
        reply: () => (main ? [main] : []),
      },
      {
        match:
          /^select b\.id::text as id from public\.content_blocks b where b\.parent_block_id/,
        reply: () => [],
      },
      {
        match: /^select 1 from public\.content_blocks b where b\.id = any/,
        reply: () => (busy ? [{ "?column?": 1 }] : []),
      },
      { match: /^with old as/, reply: () => lifted },
      {
        match: /^select a\.block_id::text as block_id, a\.files/,
        reply: () => [{ block_id: BLOCK, files: [copied(BLOCK, 1, IMG_A)] }],
      },
      {
        match: /^select a\.snapshot -> 'addresses'/,
        reply: () => [
          { addresses: ["https://crumb.storemink.com/shop/blue-mug"] },
        ],
      },
      {
        match: /^update public\.content_blocks set storage_state = \$1/,
        reply: (p) => [{ id: p[1] }],
      },
    );
    vi.mocked(restoreFromArchive).mockImplementation(async () => {
      h.sequence.push("restore");
      return { status: "restored", alreadyDone: false };
    });
  });

  const lift = (note = "The court order was withdrawn.") =>
    liftBlock({ blockId: BLOCK, note }, SUPER, { storage });

  it("is for a superadmin, with a note", async () => {
    expect(
      await liftBlock({ blockId: BLOCK, note: "x" }, MEMBER, { storage }),
    ).toEqual({
      ok: false,
      error: BLOCK_ERRORS.liftSuperadmin,
    });
    expect(await lift("  ")).toEqual({
      ok: false,
      error: BLOCK_ERRORS.liftNoteMissing,
    });
    expect(await lift("x".repeat(2001))).toEqual({
      ok: false,
      error: BLOCK_ERRORS.liftNoteTooLong,
    });
  });

  it("refuses a missing, lifted or busy block", async () => {
    main = null;
    expect(await lift()).toEqual({
      ok: false,
      error: BLOCK_ERRORS.blockNotFound,
    });
    main = {
      id: BLOCK,
      item_kind: "file",
      lifted_at: "2026-10-29 00:00:00+00",
    };
    expect(await lift()).toEqual({
      ok: false,
      error: BLOCK_ERRORS.alreadyLifted,
    });
    main = { id: BLOCK, item_kind: "file", lifted_at: null, tell_store: true };
    busy = true;
    expect(await lift()).toEqual({
      ok: false,
      error: BLOCK_ERRORS.liftReplacing,
    });
    expect(restoreFromArchive).not.toHaveBeenCalled();
  });

  it("puts the original back BEFORE the blocked set is forgotten (T7), then tells the store", async () => {
    const result = await lift();
    expect(result).toEqual({ ok: true, liftedIds: [BLOCK], warnings: [] });
    const restore = h.sequence.indexOf("restore");
    const forget = h.sequence.indexOf("forget");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(forget).toBeGreaterThan(restore);
    expect(h.sequence.indexOf("tell-lift")).toBeGreaterThan(forget);
    expect(restoreFromArchive).toHaveBeenCalledWith(
      { blockId: BLOCK, path: IMG_A, archived: copied(BLOCK, 1, IMG_A) },
      storage,
    );
    const settle = h.executed.find((q) =>
      q.text.startsWith("update public.content_blocks set storage_state = $1"),
    );
    expect(settle?.params).toEqual([
      "restored",
      BLOCK,
      "2026-10-30 06:10:00.000001+00",
    ]);
    expect(h.sequence).toContain("event:storage_restored");
    expect(h.sequence).toContain("event:block_lifted");
    // A file block pings nothing.
    expect(pingIndexNow).not.toHaveBeenCalled();
  });

  it("cancels a replacement not yet made and pings the item's addresses", async () => {
    main = { ...main, item_kind: "product", object_path: null };
    lifted = [
      {
        id: BLOCK,
        was: "none",
        state: "none",
        object_path: null,
        claimed_at: null,
      },
    ];
    const result = await lift();
    expect(result.ok).toBe(true);
    expect(restoreFromArchive).not.toHaveBeenCalled();
    expect(pingIndexNow).toHaveBeenCalledWith([
      "https://crumb.storemink.com/shop/blue-mug",
    ]);

    h.sequence = [];
    lifted = [
      {
        id: BLOCK,
        was: "pending",
        state: "cancelled",
        object_path: IMG_A,
        claimed_at: null,
      },
    ];
    main = { ...main, item_kind: "file", object_path: IMG_A };
    await lift();
    expect(h.sequence).toContain("event:storage_cancelled");
  });

  it("warns when the original could not be put back, and keeps a failed restore for the follow-up", async () => {
    vi.mocked(restoreFromArchive).mockResolvedValueOnce({
      status: "not_restored",
      reason: "changed",
    });
    expect(await lift()).toMatchObject({
      warnings: [BLOCK_WARNINGS.notRestored],
    });

    vi.mocked(restoreFromArchive).mockResolvedValueOnce({
      status: "failed",
      failure: {
        code: "unavailable",
        retryable: true,
        message: "Storage could not write.",
      },
    });
    expect(await lift()).toMatchObject({
      warnings: [BLOCK_WARNINGS.restoreRetrying],
    });
    const retry = h.executed.find((q) =>
      q.text.startsWith(
        "update public.content_blocks set storage_claimed_at = null, storage_next_attempt_at = now() + interval '1 minute'",
      ),
    );
    expect(retry?.params).toEqual([
      "Storage could not write.",
      BLOCK,
      "2026-10-30 06:10:00.000001+00",
    ]);
  });

  it("tells nobody about a block the store was never told about", async () => {
    main = { ...main, tell_store: false };
    await lift();
    expect(tellStoreOfLift).not.toHaveBeenCalled();
  });
});

// ── The other actions ───────────────────────────────────────────────────────

describe("tellStoreNow, markRemovedByHand, replies and retries", () => {
  let row: Record<string, unknown> | null;

  beforeEach(() => {
    row = {
      id: CHILD,
      parent_block_id: BLOCK,
      store_id: STORE,
      tell_store: false,
      lifted_at: null,
      storage_state: "manual",
      item_kind: "file",
      item_label: "hero.webp",
      object_path: "/themes/basket/hero.webp",
    };
    h.replies.unshift(
      {
        match: /from public\.content_blocks b where b\.id = \$1/,
        reply: () => (row ? [row] : []),
      },
      {
        match: /^insert into public\.content_block_messages/,
        reply: () => [{ id: "66666666-7777-4888-8999-000000000000" }],
      },
    );
  });

  it("tells the store from the item's own block, never undoing the reverse", async () => {
    expect(await tellStoreNow(CHILD, MEMBER)).toEqual({
      ok: false,
      error: BLOCK_ERRORS.tellSuperadmin,
    });
    const result = await tellStoreNow(CHILD, SUPER);
    expect(result).toEqual({ ok: true, notified: false });
    const update = h.executed.find((q) =>
      q.text.startsWith("update public.content_blocks set tell_store = true"),
    );
    expect(update?.params).toEqual([BLOCK, BLOCK]);
    expect(recordModerationEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "store_told", blockId: BLOCK }),
    );
    row = { ...row, tell_store: true };
    expect(await tellStoreNow(CHILD, SUPER)).toEqual({
      ok: false,
      error: BLOCK_ERRORS.alreadyTold,
    });
  });

  it("marks only a theme file as removed by hand, with a note", async () => {
    expect(await markRemovedByHand(CHILD, " ", SUPER)).toEqual({
      ok: false,
      error: BLOCK_ERRORS.removedNoteMissing,
    });
    expect(await markRemovedByHand(CHILD, "Deleted in PR 400", SUPER)).toEqual({
      ok: true,
    });
    expect(recordModerationEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "storage_removed_by_hand",
        detail: { note: "Deleted in PR 400" },
      }),
    );
    row = { ...row, storage_state: "pending" };
    expect(await markRemovedByHand(CHILD, "x", SUPER)).toEqual({
      ok: false,
      error: BLOCK_ERRORS.notManual,
    });
  });

  it("copies a store's emailed reply in, headed by its address", async () => {
    expect(
      await addStoreEmailedReply(
        { blockId: CHILD, fromAddress: "nope", body: "x" },
        MEMBER,
      ),
    ).toEqual({ ok: false, error: BLOCK_ERRORS.emailInvalid });
    expect(
      await addStoreEmailedReply(
        { blockId: CHILD, fromAddress: "a@b.co", body: " " },
        MEMBER,
      ),
    ).toEqual({ ok: false, error: BLOCK_ERRORS.replyEmpty });
    const result = await addStoreEmailedReply(
      {
        blockId: CHILD,
        fromAddress: " owner@crumb.test ",
        body: "We fixed it.",
      },
      MEMBER,
    );
    expect(result).toEqual({
      ok: true,
      messageId: "66666666-7777-4888-8999-000000000000",
    });
    const insert = h.executed.find((q) =>
      q.text.startsWith("insert into public.content_block_messages"),
    );
    expect(insert?.text).toContain("'store'");
    expect(insert?.params).toEqual([
      CHILD,
      "owner@crumb.test, by email",
      "We fixed it.",
    ]);
  });

  it("replies to a store only when it was told, then tells it", async () => {
    expect(
      await replyToStore({ blockId: CHILD, body: "Hello" }, MEMBER),
    ).toEqual({
      ok: false,
      error: BLOCK_ERRORS.replyNotTold,
    });
    row = { ...row, tell_store: true };
    expect(
      await replyToStore({ blockId: CHILD, body: "x".repeat(4001) }, MEMBER),
    ).toEqual({ ok: false, error: BLOCK_ERRORS.replyTooLong });
    const result = await replyToStore(
      { blockId: CHILD, body: "Hello" },
      MEMBER,
    );
    expect(result).toEqual({
      ok: true,
      messageId: "66666666-7777-4888-8999-000000000000",
      notified: true,
    });
    expect(tellStoreOfReply).toHaveBeenCalledWith(
      expect.objectContaining({
        blockId: CHILD,
        reply: "Hello",
        itemLabel: "hero.webp",
      }),
    );
    expect(h.sequence).toEqual(
      expect.arrayContaining([
        "event:storemink_replied",
        "event:merchant_notified",
      ]),
    );
  });

  it("retries only what failed, and never on a lifted block", async () => {
    h.replies.unshift(
      {
        match: /^update public\.content_blocks set storage_state = 'pending'/,
        reply: () => [],
      },
      {
        match:
          /^update public\.content_block_archives set files_state = 'pending'/,
        reply: () => [{ id: "a" }],
      },
    );
    expect(await retryStorage(CHILD, MEMBER)).toEqual({
      ok: true,
      storage: false,
      files: true,
    });
    h.replies.splice(1, 1);
    expect(await retryStorage(CHILD, MEMBER)).toEqual({
      ok: false,
      error: BLOCK_ERRORS.nothingToRetry,
    });
    row = { ...row, lifted_at: "2026-10-30 07:00:00+00" };
    expect(await retryStorage(CHILD, MEMBER)).toEqual({
      ok: false,
      error: BLOCK_ERRORS.retryLifted,
    });
  });
});
