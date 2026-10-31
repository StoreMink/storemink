import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";
import { mediaAssets, minkAttachments } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { isBlockedMediaUrl } from "@/lib/moderation/blocked-objects";
import { attachmentRefusal } from "@/lib/moderation/copy";
import {
  BlockedUploadError,
  assertUploadAllowed,
} from "@/lib/moderation/upload-guard";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  gcsDeletePaths,
  gcsDownloadObject,
  gcsPrivateUploadObject,
  gcsPublicUrl,
} from "@/lib/storage/gcs";
import { processImageUpload } from "@/lib/storage/process-image";
import { writeStoreObject } from "@/lib/storage/store-objects";
import {
  MINK_ATTACHMENT_EXTENSIONS,
  MINK_ATTACHMENT_INLINE_MAX_BYTES,
  MINK_ATTACHMENT_NO_LONGER_AVAILABLE,
  MINK_ATTACHMENT_NO_MEDIA_PERMISSION,
  MINK_ATTACHMENT_ONLY_AS_A_PICTURE,
  MINK_ATTACHMENT_PROMOTE_LIMIT,
  MINK_ATTACHMENT_PURGE_CLAIM_MINUTES,
  MINK_ATTACHMENT_REFERENCE_TYPE_REFUSAL,
  MINK_ATTACHMENT_RETRY_FAILED_AFTER_DAYS,
  MINK_ATTACHMENT_STORE_PURGE_LIMIT,
  MINK_ATTACHMENT_STORE_PURGE_ROUNDS,
  MINK_ATTACHMENT_TOO_MANY,
  MINK_ATTACHMENT_UNSENT_DAYS,
  MINK_ATTACHMENT_UPLOAD_FAILED,
  MINK_ATTACHMENT_WAITING_LIMIT,
  MINK_ATTACHMENT_WAITING_REFUSAL,
  attachmentDatabase,
  discardUnsentMinkAttachment,
  linkMinkAttachmentsSql,
  markRetiredMinkAttachmentsSql,
  markUnsentMinkAttachmentsSql,
  md5Base64,
  minkAttachmentCopyPath,
  minkAttachmentCopyPathPrefix,
  minkAttachmentForViewerSql,
  minkAttachmentPath,
  minkAttachmentsForUseSql,
  promoteMinkAttachmentRefs,
  purgeCandidatesSql,
  purgeMinkAttachments,
  purgeStoreMinkAttachments,
  readMinkAttachmentForViewer,
  readMinkAttachmentReferences,
  saveMinkAttachment,
} from "./attachments";
import { MinkToolInputError } from "./errors";
import type { MinkActorContext } from "./types";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsPrivateUploadObject: vi.fn(async () => undefined),
  gcsDeletePaths: vi.fn(async () => []),
  gcsDownloadObject: vi.fn(async () => new Uint8Array([1, 2, 3])),
  gcsPublicUrl: vi.fn((path: string) => `https://media.test/${path}`),
}));
// ★ The Library copy is written through writeStoreObject (takedown plan A4,
//   A8), so the public write is asserted there, with the store it is for.
vi.mock("@/lib/storage/store-objects", () => ({
  writeStoreObject: vi.fn(async (path: string) => `https://media.test/${path}`),
}));
// The guard's real error class and type check; only the database-reading
// check is replaced. The blocked-copy lookup answers "not blocked".
vi.mock("@/lib/moderation/upload-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/upload-guard")>()),
  assertUploadAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/moderation/blocked-objects", () => ({
  isBlockedMediaUrl: vi.fn(async () => false),
}));
vi.mock("@/lib/storage/process-image", () => ({
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  processImageUpload: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ---------------------------------------------------------------------------
// ★★ The db is a recorder: a mock never parses SQL, so every statement that
// decides who may read, link or purge a picture is asserted on its COMPILED
// text and bound values (the rule of conversation-retire.test.ts). The local
// database test (attachments.local.test.ts) runs the same statements for
// real.
// ---------------------------------------------------------------------------

const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ID_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADMIN = "owner";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function compile(fragment: unknown): { text: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(fragment as SQL);
  return { text: query.sql.replace(/\s+/g, " ").trim(), params: query.params };
}

let mock: ReturnType<typeof makeDbMock>;

function mockDb(options: Parameters<typeof makeDbMock>[0] = {}) {
  mock = makeDbMock(options);
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
}

/** The compiled statements `db.execute` ran, in order. */
function executed(): { text: string; params: unknown[] }[] {
  return mock.calls.execute.map(compile);
}

function pictureFile(name = "shelf photo.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function processedAs(contentType: string, bytes = new Uint8Array([9, 8, 7])) {
  vi.mocked(processImageUpload).mockResolvedValue({
    ok: true,
    data: { bytes, contentType, ext: contentType.split("/")[1] },
  });
}

beforeEach(() => {
  vi.mocked(withService).mockReset();
  vi.mocked(gcsPrivateUploadObject).mockResolvedValue(undefined);
  vi.mocked(gcsDeletePaths).mockResolvedValue([]);
  vi.mocked(gcsDownloadObject).mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.mocked(writeStoreObject).mockImplementation(
    async (path: string) => `https://media.test/${path}`,
  );
  vi.mocked(assertUploadAllowed).mockResolvedValue(undefined);
  vi.mocked(isBlockedMediaUrl).mockResolvedValue(false);
  vi.mocked(gcsPublicUrl).mockImplementation(
    (path: string) => `https://media.test/${path}`,
  );
  vi.stubEnv("DB_NAME", "storemink_local");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the private path and the digest", () => {
  it("names the store, this database and the row's own id with its extension", () => {
    expect(minkAttachmentPath(STORE, ID, "webp")).toBe(
      `stores/${STORE}/mink-attachments/storemink_local/${ID}.webp`,
    );
  });

  it("uses DB_NAME when it is a plain name, and default for a strange one or none", () => {
    expect(attachmentDatabase()).toBe("storemink_local");
    vi.stubEnv("DB_NAME", "storemink_staging");
    expect(attachmentDatabase()).toBe("storemink_staging");
    vi.stubEnv("DB_NAME", "bad name!");
    expect(attachmentDatabase()).toBe("default");
    vi.stubEnv("DB_NAME", "");
    expect(attachmentDatabase()).toBe("default");
  });

  it("md5Base64 is Google's base64 md5Hash", () => {
    expect(md5Base64(new TextEncoder().encode("hello"))).toBe(
      "XUFAKrxLKna5cZ2REBfFkg==",
    );
  });

  it("maps the five processed types to their extensions and nothing else", () => {
    expect(MINK_ATTACHMENT_EXTENSIONS).toEqual({
      "image/webp": "webp",
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/avif": "avif",
    });
  });
});

describe("saveMinkAttachment", () => {
  it("★ writes the row before the private object, both at the private path, and answers the address", async () => {
    mockDb({ executeQueue: [[{ waiting: 3 }]] });
    const bytes = new Uint8Array([9, 8, 7, 6]);
    processedAs("image/webp", bytes);
    const saved = await saveMinkAttachment({
      storeId: STORE,
      adminId: ADMIN,
      file: pictureFile(),
    });
    expect(saved).toMatchObject({ filename: "shelf photo.png" });
    const { id, url } = saved as { id: string; url: string };
    expect(id).toMatch(UUID);
    expect(url).toBe(`/api/mink/attachments/${id}`);

    const path = `stores/${STORE}/mink-attachments/storemink_local/${id}.webp`;
    expect(mock.calls.insert).toEqual([minkAttachments]);
    expect(mock.calls.values[0]).toEqual({
      id,
      storeId: STORE,
      adminId: ADMIN,
      path,
      filename: "shelf photo.png",
      contentType: "image/webp",
      sizeBytes: 4,
    });
    expect(gcsPrivateUploadObject).toHaveBeenCalledWith(
      path,
      bytes,
      "image/webp",
    );
    // ★ Row before object (mutation check 10).
    expect(mock.db.insert.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gcsPrivateUploadObject).mock.invocationCallOrder[0],
    );
    expect(mock.calls.delete).toEqual([]);
    // ★ Strict processing (review S3): bytes checked against the type, an
    //   undecodable picture refused, a GIF or AVIF re-encoded.
    expect(processImageUpload).toHaveBeenCalledWith(expect.any(File), {
      strict: true,
    });
    expect(logInfo).toHaveBeenCalledWith(
      "mink.attachments: saved",
      expect.objectContaining({
        storeId: STORE,
        adminId: ADMIN,
        attachmentId: id,
        sizeBytes: 4,
        md5: md5Base64(bytes),
      }),
    );
  });

  it("★★ the re-upload guard is asked with the processed bytes' digest, the private path and the admin, before anything is counted or stored", async () => {
    mockDb({ executeQueue: [[{ waiting: 0 }]] });
    const bytes = new Uint8Array([4, 5, 6]);
    processedAs("image/png", bytes);
    const saved = await saveMinkAttachment({
      storeId: STORE,
      adminId: ADMIN,
      file: pictureFile(),
    });
    const { id } = saved as { id: string };
    expect(assertUploadAllowed).toHaveBeenCalledTimes(1);
    expect(assertUploadAllowed).toHaveBeenCalledWith({
      storeId: STORE,
      md5Base64: md5Base64(bytes),
      path: `stores/${STORE}/mink-attachments/storemink_local/${id}.png`,
      via: "mink_attachment_save",
      contentType: "image/png",
      actor: ADMIN,
    });
    // ★ Asked outside every scope, before the waiting count (mutation 28).
    expect(
      vi.mocked(assertUploadAllowed).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(withService).mock.invocationCallOrder[0]);
  });

  it("★★ blocked bytes are refused with the attachment sentence, named or nameless, and nothing is counted or stored", async () => {
    for (const told of [true, false]) {
      vi.mocked(withService).mockClear();
      vi.mocked(gcsPrivateUploadObject).mockClear();
      mockDb({ executeQueue: [[{ waiting: 0 }]] });
      processedAs("image/webp");
      vi.mocked(assertUploadAllowed).mockRejectedValueOnce(
        new BlockedUploadError({ told, kindWord: "image", blockId: "b1" }),
      );
      const saved = await saveMinkAttachment({
        storeId: STORE,
        adminId: ADMIN,
        file: pictureFile(),
      });
      expect(saved).toEqual({ error: attachmentRefusal(told) });
      expect(withService).not.toHaveBeenCalled();
      expect(gcsPrivateUploadObject).not.toHaveBeenCalled();
    }
    // The nameless sentence names nothing (decision D21).
    expect(attachmentRefusal(false)).not.toContain("blocked");
  });

  it("a guard failure that is not a refusal is thrown as it is (the action's catch answers it)", async () => {
    mockDb({ executeQueue: [[{ waiting: 0 }]] });
    processedAs("image/webp");
    vi.mocked(assertUploadAllowed).mockRejectedValueOnce(new Error("boom"));
    await expect(
      saveMinkAttachment({
        storeId: STORE,
        adminId: ADMIN,
        file: pictureFile(),
      }),
    ).rejects.toThrow("boom");
    expect(withService).not.toHaveBeenCalled();
  });

  it("★ R3: an upload that throws discards the row the ordinary way (marked, the object deleted, then the row) and answers the Media Library's sentence", async () => {
    const landed = `stores/${STORE}/mink-attachments/storemink_local/${ID}.png`;
    mockDb({ executeQueue: [[{ waiting: 0 }], [{ path: landed }], []] });
    processedAs("image/png");
    vi.mocked(gcsPrivateUploadObject).mockRejectedValue(new Error("gcs down"));
    const saved = await saveMinkAttachment({
      storeId: STORE,
      adminId: ADMIN,
      file: pictureFile(),
    });
    expect(saved).toEqual({ error: MINK_ATTACHMENT_UPLOAD_FAILED });
    expect(mock.calls.insert).toEqual([minkAttachments]);
    const id = (mock.calls.values[0] as { id: string }).id;
    // ★ Never a bare delete of the row: the bytes may have landed with the
    //   answer lost, and an object without its row is never found again.
    expect(mock.calls.delete).toEqual([]);
    const [, claim, remove] = executed();
    expect(claim.text).toContain(
      "update public.mink_attachments a set discard_requested_at = now() where a.id = $1 and a.store_id = $2 and a.admin_id = $3",
    );
    expect(claim.params).toEqual([id, STORE, ADMIN]);
    expect(gcsDeletePaths).toHaveBeenCalledWith([landed], "private");
    expect(remove.text).toContain(
      "delete from public.mink_attachments where id = $1 and store_id = $2 and discard_requested_at is not null",
    );
    // Mark, then the object, then the row.
    const executes = mock.db.execute.mock.invocationCallOrder;
    const objectDelete = vi.mocked(gcsDeletePaths).mock.invocationCallOrder[0];
    expect(executes[1]).toBeLessThan(objectDelete);
    expect(objectDelete).toBeLessThan(executes[2]);
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: upload failed",
      expect.any(Error),
      { storeId: STORE, adminId: ADMIN, attachmentId: id },
    );
  });

  it("R3: a discard that itself fails is logged and the row is left for the purge", async () => {
    mockDb({ executeQueue: [[{ waiting: 0 }]] });
    // The count and the insert work; the discard's first scope fails.
    let scopes = 0;
    vi.mocked(withService).mockImplementation(async (fn) => {
      scopes += 1;
      if (scopes >= 3) throw new Error("pool busy");
      return fn(mock.db);
    });
    processedAs("image/png");
    vi.mocked(gcsPrivateUploadObject).mockRejectedValue(new Error("gcs down"));
    await expect(
      saveMinkAttachment({
        storeId: STORE,
        adminId: ADMIN,
        file: pictureFile(),
      }),
    ).resolves.toEqual({ error: MINK_ATTACHMENT_UPLOAD_FAILED });
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: row of a failed upload kept for the purge",
      expect.any(Error),
      expect.objectContaining({ storeId: STORE, adminId: ADMIN }),
    );
  });

  it("a row that cannot be written uploads nothing", async () => {
    mockDb({
      executeQueue: [[{ waiting: 0 }]],
      failInsertFor: [minkAttachments],
    });
    processedAs("image/png");
    await expect(
      saveMinkAttachment({
        storeId: STORE,
        adminId: ADMIN,
        file: pictureFile(),
      }),
    ).resolves.toEqual({ error: MINK_ATTACHMENT_UPLOAD_FAILED });
    expect(gcsPrivateUploadObject).not.toHaveBeenCalled();
    expect(mock.calls.delete).toEqual([]);
  });

  it("★ refuses at the waiting cap, before any row or object", async () => {
    mockDb({ executeQueue: [[{ waiting: MINK_ATTACHMENT_WAITING_LIMIT }]] });
    processedAs("image/png");
    await expect(
      saveMinkAttachment({
        storeId: STORE,
        adminId: ADMIN,
        file: pictureFile(),
      }),
    ).resolves.toEqual({ error: MINK_ATTACHMENT_WAITING_REFUSAL });
    expect(mock.calls.insert).toEqual([]);
    expect(gcsPrivateUploadObject).not.toHaveBeenCalled();
    // The cap counts this admin's unsent, unmarked rows of this store within
    // the unsent window, nothing older and nothing linked, a dead row (its
    // chat deleted without the mark, review R4) included.
    const [count] = executed();
    expect(count.text).toContain(
      "where store_id = $1 and admin_id = $2 and conversation_id is null and linked_at is null and discard_requested_at is null and created_at > now() - make_interval(days => 2)",
    );
    expect(count.params).toEqual([STORE, ADMIN]);
    expect(MINK_ATTACHMENT_UNSENT_DAYS).toBe(2);
  });

  it("the path's database segment follows DB_NAME, default for a strange one", async () => {
    vi.stubEnv("DB_NAME", "storemink_staging");
    mockDb({ executeQueue: [[{ waiting: 0 }]] });
    processedAs("image/webp");
    await saveMinkAttachment({
      storeId: STORE,
      adminId: ADMIN,
      file: pictureFile(),
    });
    expect((mock.calls.values[0] as { path: string }).path).toMatch(
      new RegExp(
        `^stores/${STORE}/mink-attachments/storemink_staging/[0-9a-f-]{36}\\.webp$`,
      ),
    );

    vi.stubEnv("DB_NAME", "not a name");
    mockDb({ executeQueue: [[{ waiting: 0 }]] });
    await saveMinkAttachment({
      storeId: STORE,
      adminId: ADMIN,
      file: pictureFile(),
    });
    expect((mock.calls.values[0] as { path: string }).path).toContain(
      "/mink-attachments/default/",
    );
  });

  it("the extension comes from the processed content type, never the file name", async () => {
    for (const [contentType, ext] of [
      ["image/jpeg", "jpg"],
      ["image/gif", "gif"],
      ["image/avif", "avif"],
      ["image/png", "png"],
    ] as const) {
      mockDb({ executeQueue: [[{ waiting: 0 }]] });
      processedAs(contentType);
      await saveMinkAttachment({
        storeId: STORE,
        adminId: ADMIN,
        file: pictureFile("whatever.heic"),
      });
      const values = mock.calls.values[0] as {
        path: string;
        contentType: string;
      };
      expect(values.path.endsWith(`.${ext}`)).toBe(true);
      expect(values.contentType).toBe(contentType);
    }
  });

  it("a processing refusal is returned as it is, storing nothing", async () => {
    mockDb();
    vi.mocked(processImageUpload).mockResolvedValue({
      ok: false,
      error: "File too large (7.0 MB). Maximum is 5 MB.",
      status: 400,
    });
    await expect(
      saveMinkAttachment({
        storeId: STORE,
        adminId: ADMIN,
        file: pictureFile(),
      }),
    ).resolves.toEqual({ error: "File too large (7.0 MB). Maximum is 5 MB." });
    expect(withService).not.toHaveBeenCalled();
    expect(gcsPrivateUploadObject).not.toHaveBeenCalled();
  });

  it("a type outside the five, or empty bytes, is refused as a failed upload (a guard)", async () => {
    mockDb();
    processedAs("image/svg+xml");
    await expect(
      saveMinkAttachment({
        storeId: STORE,
        adminId: ADMIN,
        file: pictureFile(),
      }),
    ).resolves.toEqual({ error: MINK_ATTACHMENT_UPLOAD_FAILED });
    processedAs("image/png", new Uint8Array());
    await expect(
      saveMinkAttachment({
        storeId: STORE,
        adminId: ADMIN,
        file: pictureFile(),
      }),
    ).resolves.toEqual({ error: MINK_ATTACHMENT_UPLOAD_FAILED });
    expect(withService).not.toHaveBeenCalled();
  });

  it("cuts the file name to 160 characters", async () => {
    mockDb({ executeQueue: [[{ waiting: 0 }]] });
    processedAs("image/png");
    const saved = await saveMinkAttachment({
      storeId: STORE,
      adminId: ADMIN,
      file: pictureFile(`${"n".repeat(200)}.png`),
    });
    expect((saved as { filename: string }).filename).toBe("n".repeat(160));
    expect((mock.calls.values[0] as { filename: string }).filename).toBe(
      "n".repeat(160),
    );
  });
});

describe("discardUnsentMinkAttachment", () => {
  const path = `stores/${STORE}/mink-attachments/storemink_local/${ID}.webp`;

  it("★ claims only an own, unlinked, unmarked row, deletes the object, then the row", async () => {
    mockDb({ executeQueue: [[{ path }], []] });
    await expect(
      discardUnsentMinkAttachment({ storeId: STORE, adminId: ADMIN, id: ID }),
    ).resolves.toBe(true);
    const [claim, remove] = executed();
    expect(claim.text).toContain(
      "update public.mink_attachments a set discard_requested_at = now() where a.id = $1 and a.store_id = $2 and a.admin_id = $3 and a.conversation_id is null and a.discard_requested_at is null returning a.path",
    );
    expect(claim.params).toEqual([ID, STORE, ADMIN]);
    expect(gcsDeletePaths).toHaveBeenCalledWith([path], "private");
    expect(remove.text).toContain(
      "delete from public.mink_attachments where id = $1 and store_id = $2 and discard_requested_at is not null",
    );
    expect(remove.params).toEqual([ID, STORE]);
    // ★ Object before row.
    expect(vi.mocked(gcsDeletePaths).mock.invocationCallOrder[0]).toBeLessThan(
      mock.db.execute.mock.invocationCallOrder[1],
    );
    expect(withService).toHaveBeenCalledTimes(2);
  });

  it("answers false and touches no object when no row is claimed", async () => {
    mockDb({ executeQueue: [[]] });
    await expect(
      discardUnsentMinkAttachment({ storeId: STORE, adminId: ADMIN, id: ID }),
    ).resolves.toBe(false);
    expect(gcsDeletePaths).not.toHaveBeenCalled();
    expect(executed()).toHaveLength(1);
  });

  it("an object that could not be deleted leaves the marked row to the purge", async () => {
    mockDb({ executeQueue: [[{ path }]] });
    vi.mocked(gcsDeletePaths).mockResolvedValue([path]);
    await expect(
      discardUnsentMinkAttachment({ storeId: STORE, adminId: ADMIN, id: ID }),
    ).resolves.toBe(true);
    expect(executed()).toHaveLength(1);
    expect(logWarn).toHaveBeenCalledWith(
      "mink.attachments: discard left for the purge",
      { storeId: STORE, adminId: ADMIN, attachmentId: ID },
    );
  });

  it("another database's path: the row goes and the object is kept", async () => {
    mockDb({
      executeQueue: [
        [
          {
            path: `stores/${STORE}/mink-attachments/storemink_staging/${ID}.webp`,
          },
        ],
        [],
      ],
    });
    await expect(
      discardUnsentMinkAttachment({ storeId: STORE, adminId: ADMIN, id: ID }),
    ).resolves.toBe(true);
    expect(gcsDeletePaths).not.toHaveBeenCalled();
    expect(executed()[1].text).toContain("delete from public.mink_attachments");
  });
});

describe("the viewer read", () => {
  it("★ viewer read SQL: store, admin, unmarked, chat active and not expired or never sent (a dead row refused, review R4), with a.admin_id bound to the viewer", () => {
    const { text, params } = compile(
      minkAttachmentForViewerSql({
        storeId: STORE,
        adminId: "staff-1",
        id: ID,
      }),
    );
    expect(text).toBe(
      "select a.path, a.content_type, a.size_bytes, a.filename from public.mink_attachments a left join public.mink_conversations c on c.id = a.conversation_id and c.store_id = a.store_id where a.id = $1 and a.store_id = $2 and a.admin_id = $3 and a.discard_requested_at is null and ((a.conversation_id is null and a.linked_at is null) or (c.status = 'active' and c.expires_at > now()))",
    );
    expect(params).toEqual([ID, STORE, "staff-1"]);
  });

  it("maps the row, and answers null for no row", async () => {
    mockDb({
      executeQueue: [
        [
          {
            path: "stores/x/mink-attachments/storemink_local/y.png",
            content_type: "image/png",
            size_bytes: "1234",
            filename: "shelf.png",
          },
        ],
        [],
      ],
    });
    await expect(
      readMinkAttachmentForViewer({ storeId: STORE, adminId: ADMIN, id: ID }),
    ).resolves.toEqual({
      path: "stores/x/mink-attachments/storemink_local/y.png",
      contentType: "image/png",
      sizeBytes: 1234,
      filename: "shelf.png",
    });
    await expect(
      readMinkAttachmentForViewer({ storeId: STORE, adminId: ADMIN, id: ID }),
    ).resolves.toBeNull();
    for (const statement of executed()) {
      expect(statement.params).toEqual([ID, STORE, ADMIN]);
    }
  });
});

describe("the link at send", () => {
  it("★ link SQL: store, admin, the ids as one array parameter, never linked (a dead row stays dead, review R4), unmarked", () => {
    const statement = linkMinkAttachmentsSql({
      storeId: STORE,
      adminId: ADMIN,
      conversationId: CHAT,
      ids: [ID, ID_2],
    });
    const { text, params } = compile(statement);
    expect(text).toBe(
      "update public.mink_attachments a set conversation_id = $1, linked_at = now() where a.store_id = $2 and a.admin_id = $3 and a.id = any($4::uuid[]) and a.conversation_id is null and a.linked_at is null and a.discard_requested_at is null returning a.id",
    );
    expect(params).toEqual([CHAT, STORE, ADMIN, [ID, ID_2]]);
  });

  it("null for no ids", () => {
    expect(
      linkMinkAttachmentsSql({
        storeId: STORE,
        adminId: ADMIN,
        conversationId: CHAT,
        ids: [],
      }),
    ).toBeNull();
  });
});

describe("the purge", () => {
  const floorIso = "2026-10-26T03:00:00.000Z";
  const own = (id: string) =>
    `stores/${STORE}/mink-attachments/storemink_local/${id}.webp`;

  it("★ marks never-sent rows past the floor, and dead rows at once (review R4), locked skip locked, oldest first, within the limit", () => {
    const { text, params } = compile(
      markUnsentMinkAttachmentsSql({ floorIso, limit: 50 }),
    );
    expect(text).toBe(
      "update public.mink_attachments a set discard_requested_at = now() where a.id in ( select u.id from public.mink_attachments u where u.conversation_id is null and u.discard_requested_at is null and (u.created_at < $1::timestamptz or u.linked_at is not null) order by u.created_at, u.id limit $2 for update skip locked ) and a.conversation_id is null and a.discard_requested_at is null returning a.id",
    );
    expect(params).toEqual([floorIso, 50]);
  });

  it("★ marks the pictures of a chat that is no longer active, through the chat's own join", () => {
    const { text, params } = compile(
      markRetiredMinkAttachmentsSql({ limit: 50 }),
    );
    expect(text).toBe(
      "update public.mink_attachments a set discard_requested_at = now() where a.id in ( select a2.id from public.mink_conversations c join public.mink_attachments a2 on a2.conversation_id = c.id and a2.store_id = c.store_id where c.status <> 'active' and a2.discard_requested_at is null limit $1 for update of a2 skip locked ) and a.discard_requested_at is null returning a.id",
    );
    expect(params).toEqual([50]);
  });

  it("★ R12: candidates are CLAIMED (skip locked, a 15-minute claim written where the 7-day retry waits), oldest mark first, within the limit", () => {
    const { text, params } = compile(purgeCandidatesSql({ limit: 50 }));
    expect(text).toBe(
      "update public.mink_attachments a set purge_failed_at = now() - make_interval(days => 7) + make_interval(mins => 15) where a.id in ( select p.id from public.mink_attachments p where p.discard_requested_at is not null and (p.purge_failed_at is null or p.purge_failed_at < now() - make_interval(days => 7)) and not exists (select 1 from public.store_legal_holds h where h.store_id = p.store_id and h.released_at is null) order by p.discard_requested_at, p.id limit $1 for update skip locked ) and a.discard_requested_at is not null and (a.purge_failed_at is null or a.purge_failed_at < now() - make_interval(days => 7)) returning a.id, a.store_id, a.path",
    );
    expect(params).toEqual([50]);
    expect(MINK_ATTACHMENT_RETRY_FAILED_AFTER_DAYS).toBe(7);
    expect(MINK_ATTACHMENT_PURGE_CLAIM_MINUTES).toBe(15);
  });

  it("★★ D10: a store under an active legal hold is left out of the candidates, after the retry arm and before the store's own clause", () => {
    const clause =
      "and not exists (select 1 from public.store_legal_holds h where h.store_id = p.store_id and h.released_at is null)";
    for (const storeId of [null, STORE]) {
      const { text } = compile(purgeCandidatesSql({ limit: 20, storeId }));
      expect(text.split(clause)).toHaveLength(2);
      const at = text.indexOf(clause);
      expect(
        text.indexOf("p.purge_failed_at < now() - make_interval(days => 7))"),
      ).toBeLessThan(at);
      expect(at).toBeLessThan(text.indexOf("order by p.discard_requested_at"));
      if (storeId) {
        expect(text).toContain(`${clause} and p.store_id = $1`);
      }
    }
  });

  it("★ deletes the object before the row, in separate scopes, and counts the rows deleted", async () => {
    mockDb({
      executeQueue: [
        [{ id: "m1" }, { id: "m2" }],
        [{ id: "m3" }],
        [
          { id: ID, store_id: STORE, path: own(ID) },
          { id: ID_2, store_id: STORE, path: own(ID_2) },
        ],
        [{ id: ID }, { id: ID_2 }],
      ],
    });
    await expect(purgeMinkAttachments(floorIso, 50)).resolves.toBe(2);
    expect(gcsDeletePaths).toHaveBeenCalledTimes(1);
    expect(gcsDeletePaths).toHaveBeenCalledWith(
      [own(ID), own(ID_2)],
      "private",
    );
    const statements = executed();
    expect(statements).toHaveLength(4);
    // ★ C4 / R5: the batch runs exactly the two marks, then the claim, by
    //   their compiled text, so a purge that stops calling the retired-chat
    //   mark (mutation 15) fails here too.
    expect(statements[0]).toEqual(
      compile(markUnsentMinkAttachmentsSql({ floorIso, limit: 50 })),
    );
    expect(statements[1]).toEqual(
      compile(markRetiredMinkAttachmentsSql({ limit: 50 })),
    );
    expect(statements[2]).toEqual(compile(purgeCandidatesSql({ limit: 50 })));
    expect(statements[3].text).toBe(
      "delete from public.mink_attachments where id = any($1::uuid[]) and discard_requested_at is not null returning id",
    );
    expect(statements[3].params).toEqual([[ID, ID_2]]);
    // ★ The objects go before the rows, and the storage call sits between
    //   two scopes rather than inside one.
    const scopes = vi.mocked(withService).mock.invocationCallOrder;
    const storage = vi.mocked(gcsDeletePaths).mock.invocationCallOrder[0];
    expect(scopes).toHaveLength(4);
    expect(scopes[2]).toBeLessThan(storage);
    expect(storage).toBeLessThan(scopes[3]);
    expect(logInfo).toHaveBeenCalledWith("mink.attachments: purge batch", {
      marked: 3,
      claimed: 2,
      deleted: 2,
      failed: 0,
      foreign: 0,
    });
  });

  it("★ a path of another database: the row is deleted and the object kept", async () => {
    mockDb({
      executeQueue: [
        [],
        [],
        [
          {
            id: ID,
            store_id: STORE,
            path: `stores/${STORE}/mink-attachments/storemink_staging/${ID}.webp`,
          },
        ],
        [{ id: ID }],
      ],
    });
    await expect(purgeMinkAttachments(floorIso, 50)).resolves.toBe(1);
    expect(gcsDeletePaths).not.toHaveBeenCalled();
    expect(executed()[3].params).toEqual([[ID]]);
    expect(logInfo).toHaveBeenCalledWith("mink.attachments: purge batch", {
      marked: 0,
      claimed: 1,
      deleted: 1,
      failed: 0,
      foreign: 1,
    });
  });

  it("★ a failed object delete sets purge_failed_at (the 7-day wait), keeps the row and still counts toward the batch", async () => {
    mockDb({
      executeQueue: [
        [],
        [],
        [
          { id: ID, store_id: STORE, path: own(ID) },
          { id: ID_2, store_id: STORE, path: own(ID_2) },
        ],
        [{ id: ID_2 }],
        [{ id: ID }],
      ],
    });
    vi.mocked(gcsDeletePaths).mockResolvedValue([own(ID)]);
    await expect(purgeMinkAttachments(floorIso, 2)).resolves.toBe(2);
    const statements = executed();
    expect(statements).toHaveLength(5);
    expect(statements[3].text).toContain("delete from public.mink_attachments");
    expect(statements[3].params).toEqual([[ID_2]]);
    expect(statements[4].text).toBe(
      "update public.mink_attachments set purge_failed_at = now() where id = any($1::uuid[]) and discard_requested_at is not null returning id",
    );
    expect(statements[4].params).toEqual([[ID]]);
    expect(logInfo).toHaveBeenCalledWith("mink.attachments: purge batch", {
      marked: 0,
      claimed: 2,
      deleted: 1,
      failed: 1,
      foreign: 0,
    });
  });

  it("a batch with nothing marked and nothing to claim runs the three statements only", async () => {
    mockDb({ executeQueue: [[], [], []] });
    await expect(purgeMinkAttachments(floorIso, 50)).resolves.toBe(0);
    expect(executed()).toHaveLength(3);
    expect(gcsDeletePaths).not.toHaveBeenCalled();
  });

  it("★ the store-scoped variant filters every statement by store and takes 20 at a time", async () => {
    mockDb({
      executeQueue: [
        [],
        [],
        [{ id: ID, store_id: STORE, path: own(ID) }],
        [{ id: ID }],
      ],
    });
    const before = Date.now();
    await expect(purgeStoreMinkAttachments(STORE)).resolves.toBe(1);
    const [unsent, retired, candidates] = executed();
    expect(unsent.text).toContain("and u.store_id = $2 order by");
    expect(retired.text).toContain("and c.store_id = $1 limit");
    expect(candidates.text).toContain("and p.store_id = $1 order by");
    expect(unsent.params[1]).toBe(STORE);
    expect(unsent.params[2]).toBe(MINK_ATTACHMENT_STORE_PURGE_LIMIT);
    expect(retired.params).toEqual([STORE, 20]);
    expect(candidates.params).toEqual([STORE, 20]);
    // The floor is 2 days before now.
    const floor = Date.parse(String(unsent.params[0]));
    expect(before - floor).toBeGreaterThanOrEqual(2 * 86_400_000 - 1);
    expect(before - floor).toBeLessThan(2 * 86_400_000 + 5_000);
    expect(logInfo).toHaveBeenCalledWith("mink.attachments: purge batch", {
      marked: 0,
      claimed: 1,
      deleted: 1,
      failed: 0,
      foreign: 0,
      storeId: STORE,
    });
    // A short batch: nothing left, no second round.
    expect(executed()).toHaveLength(4);
  });

  it("★ R12: the batch counts the rows it CLAIMED, so rows another purge already deleted still make a full batch", async () => {
    mockDb({
      executeQueue: [
        [],
        [],
        [
          { id: ID, store_id: STORE, path: own(ID) },
          { id: ID_2, store_id: STORE, path: own(ID_2) },
        ],
        // Another run removed one row in the meantime: only one is deleted.
        [{ id: ID }],
      ],
    });
    await expect(purgeMinkAttachments(floorIso, 2)).resolves.toBe(2);
  });

  it("★ R10: the store's purge runs full batches until one comes back short", async () => {
    const full = (a: string, b: string) => [
      [],
      [],
      [
        { id: a, store_id: STORE, path: own(a) },
        { id: b, store_id: STORE, path: own(b) },
      ],
      [{ id: a }, { id: b }],
    ];
    mockDb({
      executeQueue: [
        ...full(ID, ID_2),
        [],
        [],
        [{ id: ID, store_id: STORE, path: own(ID) }],
        [{ id: ID }],
      ],
    });
    await expect(purgeStoreMinkAttachments(STORE, 2)).resolves.toBe(3);
    expect(executed()).toHaveLength(8);
    expect(gcsDeletePaths).toHaveBeenCalledTimes(2);
  });

  it("★ R10: the store's purge stops after its round cap even while every batch is full", async () => {
    const batch = [
      [],
      [],
      [{ id: ID, store_id: STORE, path: own(ID) }],
      [{ id: ID }],
    ];
    mockDb({
      executeQueue: Array.from(
        { length: MINK_ATTACHMENT_STORE_PURGE_ROUNDS + 2 },
        () => batch,
      ).flat(),
    });
    await expect(purgeStoreMinkAttachments(STORE, 1)).resolves.toBe(
      MINK_ATTACHMENT_STORE_PURGE_ROUNDS,
    );
    expect(executed()).toHaveLength(4 * MINK_ATTACHMENT_STORE_PURGE_ROUNDS);
    expect(MINK_ATTACHMENT_STORE_PURGE_ROUNDS).toBe(5);
  });

  it("R10: the store's purge starts no round after its 10-second budget", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const batch = [
      [],
      [],
      [{ id: ID, store_id: STORE, path: own(ID) }],
      [{ id: ID }],
    ];
    mockDb({ executeQueue: [...batch, ...batch, ...batch] });
    vi.mocked(gcsDeletePaths).mockImplementation(async () => {
      now += 6_000;
      return [];
    });
    try {
      // Round 1 ends at +6 s, round 2 starts and ends at +12 s, round 3 waits.
      await expect(purgeStoreMinkAttachments(STORE, 1)).resolves.toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("the store-scoped variant never throws: a failed batch is logged and counts nothing", async () => {
    vi.mocked(withService).mockRejectedValue(new Error("pool busy"));
    await expect(purgeStoreMinkAttachments(STORE, 5)).resolves.toBe(0);
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: store purge failed",
      expect.any(Error),
      { storeId: STORE },
    );
  });

  it("the retention entry's purge throws like every other deleter, so the sweep records it", async () => {
    vi.mocked(withService).mockRejectedValue(new Error("pool busy"));
    await expect(purgeMinkAttachments(floorIso, 50)).rejects.toThrow(
      "pool busy",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. The promotion to a Media Library copy (design 5.3 item 5, 9.1)
// ---------------------------------------------------------------------------

const ADDRESS = `/api/mink/attachments/${ID}`;
const ADDRESS_2 = `https://echoss.storemink.com/api/mink/attachments/${ID_2}`;
/** Every copy of ID starts with this; the rest is 16 random hex and the extension. */
const COPY_PREFIX = `stores/${STORE}/media/mink-attachment-storemink_local-${ID}-`;
const COPY_PATH_PATTERN = new RegExp(
  `^${COPY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{16}\\.webp$`,
);
const COPY_URL = `https://media.test/${COPY_PREFIX}0123456789abcdef.webp`;
const RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function actor(overrides: Partial<MinkActorContext> = {}): MinkActorContext {
  return {
    storeId: STORE,
    adminId: ADMIN,
    email: null,
    roleSlug: "member",
    permissions: { media: ["manage"] },
    isSuperadmin: false,
    effectivePlan: "pro",
    locationIds: null,
    analyticsTimeZone: "Asia/Kolkata",
    currency: "INR",
    defaultLowStockThreshold: 5,
    requestId: "request-1",
    ...overrides,
  };
}

/** One row as the rows query returns it. */
function attachmentRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    path: `stores/${STORE}/mink-attachments/storemink_local/${id}.webp`,
    filename: "shelf photo.png",
    content_type: "image/webp",
    size_bytes: 4,
    ...overrides,
  };
}

describe("the promotion to a Media Library copy", () => {
  it("★ S1: the public path names the store, this database and the attachment's own id, then 16 random hex and the extension", () => {
    expect(minkAttachmentCopyPath(STORE, ID, "jpg", "0123456789abcdef")).toBe(
      `stores/${STORE}/media/mink-attachment-storemink_local-${ID}-0123456789abcdef.jpg`,
    );
    expect(minkAttachmentCopyPathPrefix(STORE, ID)).toBe(COPY_PREFIX);
    // ★ Unguessable: two copies of one attachment never share a path.
    const first = minkAttachmentCopyPath(STORE, ID, "webp");
    const second = minkAttachmentCopyPath(STORE, ID, "webp");
    expect(first).toMatch(COPY_PATH_PATTERN);
    expect(second).toMatch(COPY_PATH_PATTERN);
    expect(first).not.toBe(second);
    vi.stubEnv("DB_NAME", "storemink_staging");
    expect(minkAttachmentCopyPath(STORE, ID, "webp")).toContain(
      "/media/mink-attachment-storemink_staging-",
    );
    vi.stubEnv("DB_NAME", "bad name!");
    expect(minkAttachmentCopyPath(STORE, ID, "webp")).toContain(
      "/media/mink-attachment-default-",
    );
  });

  it("★ S5: rows for use: store, the actor's own admin id, the ids as one array parameter, unmarked, and only what the viewer read would show", () => {
    const { text, params } = compile(
      minkAttachmentsForUseSql({
        storeId: STORE,
        adminId: "staff-1",
        ids: [ID, ID_2],
      }),
    );
    expect(text).toBe(
      "select a.id, a.path, a.filename, a.content_type, a.size_bytes from public.mink_attachments a left join public.mink_conversations c on c.id = a.conversation_id and c.store_id = a.store_id where a.store_id = $1 and a.admin_id = $2 and a.id = any($3::uuid[]) and a.discard_requested_at is null and ((a.conversation_id is null and a.linked_at is null) or (c.status = 'active' and c.expires_at > now()))",
    );
    expect(params).toEqual([STORE, "staff-1", [ID, ID_2]]);
  });

  it("★ S5: with a run, a sent picture must be in the run's own chat (its run row, of this store, requested by this admin)", () => {
    const { text, params } = compile(
      minkAttachmentsForUseSql({
        storeId: STORE,
        adminId: "staff-1",
        ids: [ID],
        runId: RUN,
      }),
    );
    expect(text).toBe(
      "select a.id, a.path, a.filename, a.content_type, a.size_bytes from public.mink_attachments a left join public.mink_conversations c on c.id = a.conversation_id and c.store_id = a.store_id where a.store_id = $1 and a.admin_id = $2 and a.id = any($3::uuid[]) and a.discard_requested_at is null and ((a.conversation_id is null and a.linked_at is null) or (c.status = 'active' and c.expires_at > now() and a.conversation_id = ( select r.conversation_id from public.mink_runs r where r.id = $4::uuid and r.store_id = a.store_id and r.requested_by = a.admin_id)))",
    );
    expect(params).toEqual([STORE, "staff-1", [ID], RUN]);
    // An unreadable run id matches no run, never every chat.
    expect(
      compile(
        minkAttachmentsForUseSql({
          storeId: STORE,
          adminId: "staff-1",
          ids: [ID],
          runId: "not-a-run",
        }),
      ).params,
    ).toEqual([STORE, "staff-1", [ID], "00000000-0000-0000-0000-000000000000"]);
  });

  it("★ S5: the promotion passes the actor's run to the rows query", async () => {
    mockDb({ executeQueue: [[]] });
    await expect(
      promoteMinkAttachmentRefs(actor({ runId: RUN }), { image_url: ADDRESS }, [
        "image_url",
      ]),
    ).rejects.toThrow(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
    const [rows] = executed();
    expect(rows.text).toContain(
      "from public.mink_runs r where r.id = $4::uuid",
    );
    expect(rows.params).toEqual([STORE, ADMIN, [ID], RUN]);
  });

  it("no ids in the allowed arguments returns the same object and reads nothing", async () => {
    mockDb();
    const args = {
      image_url: "https://media.test/stores/x/media/own.webp",
      name: "Almond shake",
    };
    await expect(
      promoteMinkAttachmentRefs(actor(), args, ["image_url"]),
    ).resolves.toBe(args);
    expect(withService).not.toHaveBeenCalled();
    expect(gcsDownloadObject).not.toHaveBeenCalled();
  });

  it("★★ refused outside its picture arguments, before anything is read or copied", async () => {
    mockDb();
    const args = {
      image_url: ADDRESS,
      description: `A photo is at ${ADDRESS_2}`,
    };
    const promise = promoteMinkAttachmentRefs(actor(), args, ["image_url"]);
    await expect(promise).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(promise).rejects.toThrow(MINK_ATTACHMENT_ONLY_AS_A_PICTURE);
    expect(withService).not.toHaveBeenCalled();
    expect(gcsDownloadObject).not.toHaveBeenCalled();
    expect(writeStoreObject).not.toHaveBeenCalled();
    // A tool with no picture arguments at all refuses every address.
    await expect(
      promoteMinkAttachmentRefs(actor(), { message: ADDRESS }, []),
    ).rejects.toThrow(MINK_ATTACHMENT_ONLY_AS_A_PICTURE);
    expect(withService).not.toHaveBeenCalled();
  });

  it("★ Media manage is required, and the refusal comes before any read", async () => {
    mockDb();
    await expect(
      promoteMinkAttachmentRefs(
        actor({ permissions: { media: ["view"], products: ["manage"] } }),
        { image_url: ADDRESS },
        ["image_url"],
      ),
    ).rejects.toThrow(MINK_ATTACHMENT_NO_MEDIA_PERMISSION);
    expect(withService).not.toHaveBeenCalled();
    // A superadmin needs no map.
    mockDb({ executeQueue: [[]] });
    await expect(
      promoteMinkAttachmentRefs(
        actor({ permissions: {}, isSuperadmin: true }),
        { image_url: ADDRESS },
        ["image_url"],
      ),
    ).rejects.toThrow(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
    expect(withService).toHaveBeenCalledTimes(1);
  });

  it("★ a missing, marked or another admin's id is no longer available: the rows query binds the actor, and nothing is copied", async () => {
    mockDb({ executeQueue: [[attachmentRow(ID)]] });
    await expect(
      promoteMinkAttachmentRefs(actor(), { image_urls: [ADDRESS, ADDRESS_2] }, [
        "image_urls",
      ]),
    ).rejects.toThrow(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
    const [rows] = executed();
    expect(rows.text).toContain(
      "where a.store_id = $1 and a.admin_id = $2 and a.id = any($3::uuid[]) and a.discard_requested_at is null and ((a.conversation_id is null and a.linked_at is null)",
    );
    expect(rows.params).toEqual([STORE, ADMIN, [ID, ID_2]]);
    expect(gcsDownloadObject).not.toHaveBeenCalled();
    expect(writeStoreObject).not.toHaveBeenCalled();
    expect(mock.calls.insert).toEqual([]);
  });

  it("★★ copy, then row: the private bytes go to a new public path with a random part, the row is claimed under the copy's lock as an upload by the actor, only the named argument is rewritten and the originals are unchanged", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    vi.mocked(gcsDownloadObject).mockResolvedValue(bytes);
    mockDb({
      executeQueue: [[attachmentRow(ID)], []],
      selectByTable: { media_assets: [[], []] },
      returning: [{ url: COPY_URL }],
    });
    const own = "https://media.test/stores/x/media/own.webp";
    const args = {
      product_id: "p1",
      image_urls: [ADDRESS, own],
      mode: "add",
      note: { nested: ["no address here"] },
    };
    const before = structuredClone(args);

    const promoted = await promoteMinkAttachmentRefs(actor(), args, [
      "image_urls",
    ]);

    // ★ A new object; the model's own arguments untouched (mutation check 12).
    expect(args).toEqual(before);
    expect(promoted).not.toBe(args);
    expect(promoted).toEqual({ ...before, image_urls: [COPY_URL, own] });
    expect(promoted.note).toBe(args.note);

    expect(gcsDownloadObject).toHaveBeenCalledWith(
      attachmentRow(ID).path,
      5 * 1024 * 1024,
      "private",
    );
    expect(writeStoreObject).toHaveBeenCalledWith(
      expect.stringMatching(COPY_PATH_PATTERN),
      bytes,
      "image/webp",
      { storeId: STORE, via: "mink_attachment_copy", actor: ADMIN },
    );
    const uploadedPath = vi.mocked(writeStoreObject).mock.calls[0][0];
    expect(mock.calls.insert).toEqual([mediaAssets]);
    expect(mock.calls.values[0]).toEqual({
      storeId: STORE,
      url: `https://media.test/${uploadedPath}`,
      path: uploadedPath,
      filename: "shelf photo.png",
      contentType: "image/webp",
      sizeBytes: 4,
      createdBy: ADMIN,
      source: "upload",
    });
    // ★ S1: an earlier copy is found by the path PREFIX (the path has a random
    //   part), with starts_with because the database name may hold `_`.
    for (const where of mock.calls.where.slice(0, 2)) {
      const lookup = compile(where);
      expect(lookup.text).toContain('starts_with("media_assets"."path", $2)');
      expect(lookup.params).toEqual([STORE, COPY_PREFIX]);
    }
    // The winner's own object is kept.
    expect(gcsDeletePaths).not.toHaveBeenCalled();
    const [, lock] = executed();
    expect(lock.text).toBe(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    );
    expect(lock.params).toEqual([`mink-attachment-copy:${ID}`]);

    // ★ Copy before row: download, upload, then the lock and the insert;
    //   the storage calls sit between scopes, never inside one.
    const download = vi.mocked(gcsDownloadObject).mock.invocationCallOrder[0];
    const upload = vi.mocked(writeStoreObject).mock.invocationCallOrder[0];
    const lockCall = mock.db.execute.mock.invocationCallOrder[1];
    const insert = mock.db.insert.mock.invocationCallOrder[0];
    expect(download).toBeLessThan(upload);
    expect(upload).toBeLessThan(lockCall);
    expect(lockCall).toBeLessThan(insert);
    const scopes = vi.mocked(withService).mock.invocationCallOrder;
    expect(scopes).toHaveLength(3);
    expect(scopes[1]).toBeLessThan(download);
    expect(upload).toBeLessThan(scopes[2]);

    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/media");
    expect(logInfo).toHaveBeenCalledWith(
      "mink.attachments: copied to the Media Library",
      expect.objectContaining({
        storeId: STORE,
        adminId: ADMIN,
        attachmentId: ID,
        sizeBytes: 4,
        md5: md5Base64(bytes),
        created: true,
      }),
    );
    expect(logInfo).toHaveBeenCalledWith("mink.attachments: promoted", {
      storeId: STORE,
      adminId: ADMIN,
      attachments: 1,
      copied: 1,
      reused: 0,
    });
  });

  it("★ an existing copy's row is reused: no download, no upload, no second row, no refresh", async () => {
    mockDb({
      executeQueue: [[attachmentRow(ID)]],
      selectByTable: { media_assets: [[{ url: COPY_URL }]] },
    });
    const promoted = await promoteMinkAttachmentRefs(
      actor(),
      { image_url: ADDRESS },
      ["image_url"],
    );
    expect(promoted.image_url).toBe(COPY_URL);
    expect(gcsDownloadObject).not.toHaveBeenCalled();
    expect(writeStoreObject).not.toHaveBeenCalled();
    expect(mock.calls.insert).toEqual([]);
    expect(executed()).toHaveLength(1);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith("mink.attachments: promoted", {
      storeId: STORE,
      adminId: ADMIN,
      attachments: 1,
      copied: 1 - 1,
      reused: 1,
    });
  });

  it("★ exactly once under the lock: a row that landed while the bytes were uploading is reused, not duplicated, and this run's own object is deleted", async () => {
    mockDb({
      executeQueue: [[attachmentRow(ID)], []],
      selectByTable: {
        media_assets: [[], [{ url: "https://media.test/winner.webp" }]],
      },
    });
    const promoted = await promoteMinkAttachmentRefs(
      actor(),
      { image_url: ADDRESS },
      ["image_url"],
    );
    expect(promoted.image_url).toBe("https://media.test/winner.webp");
    expect(writeStoreObject).toHaveBeenCalledTimes(1);
    expect(mock.calls.insert).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
    // ★ S1: the paths differ now, so the loser's object would have no row.
    const uploadedPath = vi.mocked(writeStoreObject).mock.calls[0][0];
    expect(gcsDeletePaths).toHaveBeenCalledWith([uploadedPath], "public");
    // The copy the lock found was checked before it was reused.
    expect(isBlockedMediaUrl).toHaveBeenCalledWith(
      "https://media.test/winner.webp",
    );
  });

  it("★★ blocked bytes are refused at the write with the attachment sentence: no row, no delete, no refresh", async () => {
    for (const told of [true, false]) {
      mockDb({
        executeQueue: [[attachmentRow(ID)]],
        selectByTable: { media_assets: [[]] },
      });
      vi.mocked(gcsDeletePaths).mockClear();
      vi.mocked(writeStoreObject).mockRejectedValueOnce(
        new BlockedUploadError({ told, kindWord: "image", blockId: "b1" }),
      );
      const promise = promoteMinkAttachmentRefs(
        actor(),
        { image_url: ADDRESS },
        ["image_url"],
      );
      await expect(promise).rejects.toBeInstanceOf(MinkToolInputError);
      await expect(promise).rejects.toThrow(attachmentRefusal(told));
      expect(mock.calls.insert).toEqual([]);
      expect(gcsDeletePaths).not.toHaveBeenCalled();
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("★★ an earlier copy blocked since is never reused: the guard is asked with the private bytes and its sentence is the refusal", async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    vi.mocked(gcsDownloadObject).mockResolvedValue(bytes);
    vi.mocked(isBlockedMediaUrl).mockResolvedValue(true);
    vi.mocked(assertUploadAllowed).mockRejectedValueOnce(
      new BlockedUploadError({ told: true, kindWord: "image", blockId: "b2" }),
    );
    mockDb({
      executeQueue: [[attachmentRow(ID)]],
      selectByTable: { media_assets: [[{ url: COPY_URL }]] },
    });
    await expect(
      promoteMinkAttachmentRefs(actor(), { image_url: ADDRESS }, ["image_url"]),
    ).rejects.toThrow(attachmentRefusal(true));
    // ★ The copy's own address is checked, never the fresh random path.
    expect(isBlockedMediaUrl).toHaveBeenCalledWith(COPY_URL);
    expect(assertUploadAllowed).toHaveBeenCalledWith({
      storeId: STORE,
      md5Base64: md5Base64(bytes),
      path: attachmentRow(ID).path,
      via: "mink_attachment_copy",
      contentType: "image/webp",
      actor: ADMIN,
    });
    expect(writeStoreObject).not.toHaveBeenCalled();
    expect(mock.calls.insert).toEqual([]);
  });

  it("★ D21: a blocked earlier copy whose bytes the guard does not match, or cannot be read, is refused with the nameless sentence", async () => {
    vi.mocked(isBlockedMediaUrl).mockResolvedValue(true);
    mockDb({
      executeQueue: [[attachmentRow(ID)]],
      selectByTable: { media_assets: [[{ url: COPY_URL }]] },
    });
    await expect(
      promoteMinkAttachmentRefs(actor(), { image_url: ADDRESS }, ["image_url"]),
    ).rejects.toThrow(attachmentRefusal(false));
    mockDb({
      executeQueue: [[attachmentRow(ID)]],
      selectByTable: { media_assets: [[{ url: COPY_URL }]] },
    });
    vi.mocked(gcsDownloadObject).mockRejectedValueOnce(new Error("gone"));
    await expect(
      promoteMinkAttachmentRefs(actor(), { image_url: ADDRESS }, ["image_url"]),
    ).rejects.toThrow(attachmentRefusal(false));
    expect(writeStoreObject).not.toHaveBeenCalled();
  });

  it("★★ a copy found under the lock after a race gets the first lookup's blocked check: refused with the guard's sentence, this run's object deleted, the bytes read once", async () => {
    const bytes = new Uint8Array([4, 4, 4, 4]);
    vi.mocked(gcsDownloadObject).mockResolvedValue(bytes);
    const winner = "https://media.test/winner.webp";
    vi.mocked(isBlockedMediaUrl).mockImplementation(
      async (url) => url === winner,
    );
    vi.mocked(assertUploadAllowed).mockRejectedValueOnce(
      new BlockedUploadError({ told: true, kindWord: "image", blockId: "b3" }),
    );
    mockDb({
      executeQueue: [[attachmentRow(ID)], []],
      selectByTable: { media_assets: [[], [{ url: winner }]] },
    });
    const promise = promoteMinkAttachmentRefs(actor(), { image_url: ADDRESS }, [
      "image_url",
    ]);
    await expect(promise).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(promise).rejects.toThrow(attachmentRefusal(true));
    // ★ The copy the lock found is checked by its own address.
    expect(isBlockedMediaUrl).toHaveBeenCalledWith(winner);
    // The guard is asked with the bytes this run already read, never a
    // second download.
    expect(gcsDownloadObject).toHaveBeenCalledTimes(1);
    expect(assertUploadAllowed).toHaveBeenCalledWith({
      storeId: STORE,
      md5Base64: md5Base64(bytes),
      path: attachmentRow(ID).path,
      via: "mink_attachment_copy",
      contentType: "image/webp",
      actor: ADMIN,
    });
    // This run's own object at its random path still goes.
    const uploadedPath = vi.mocked(writeStoreObject).mock.calls[0][0];
    expect(gcsDeletePaths).toHaveBeenCalledWith([uploadedPath], "public");
    expect(mock.calls.insert).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalledWith(
      "mink.attachments: copied to the Media Library",
      expect.anything(),
    );
  });

  it("★ D21: a raced copy blocked by its address whose bytes the guard does not match is refused with the nameless sentence", async () => {
    const winner = "https://media.test/winner.webp";
    vi.mocked(isBlockedMediaUrl).mockImplementation(
      async (url) => url === winner,
    );
    mockDb({
      executeQueue: [[attachmentRow(ID)], []],
      selectByTable: { media_assets: [[], [{ url: winner }]] },
    });
    await expect(
      promoteMinkAttachmentRefs(actor(), { image_url: ADDRESS }, ["image_url"]),
    ).rejects.toThrow(attachmentRefusal(false));
  });

  it("the same picture in two picture fields is copied once and rewritten in both", async () => {
    mockDb({
      executeQueue: [[attachmentRow(ID)], []],
      selectByTable: { media_assets: [[], []] },
      returning: [{ url: COPY_URL }],
    });
    const promoted = await promoteMinkAttachmentRefs(
      actor(),
      {
        sections: [
          { id: "s1", type: "hero", config: { image_url: ADDRESS } },
          {
            id: "s2",
            type: "media_text",
            config: { image_url: `https://echoss.storemink.com${ADDRESS}` },
          },
        ],
      },
      ["sections"],
    );
    expect(promoted).toEqual({
      sections: [
        { id: "s1", type: "hero", config: { image_url: COPY_URL } },
        { id: "s2", type: "media_text", config: { image_url: COPY_URL } },
      ],
    });
    expect(gcsDownloadObject).toHaveBeenCalledTimes(1);
    expect(executed()[0].params).toEqual([STORE, ADMIN, [ID]]);
  });

  it("★ S2: an address in a blog body is refused, now that the body is not a picture argument (F3 left `content` out of propose_blog_draft)", async () => {
    mockDb();
    await expect(
      promoteMinkAttachmentRefs(
        actor(),
        {
          title: "Shelf",
          cover_image_url: ADDRESS,
          content: `Our shelf: ![shelf](${ADDRESS}).`,
        },
        ["cover_image_url"],
      ),
    ).rejects.toThrow(MINK_ATTACHMENT_ONLY_AS_A_PICTURE);
    expect(withService).not.toHaveBeenCalled();
    expect(gcsDownloadObject).not.toHaveBeenCalled();
  });

  it("★ an aborted signal stops before anything is read, and a stop between the rows and the copy stops before any write", async () => {
    const stopped = new AbortController();
    stopped.abort(new Error("stopped"));
    mockDb();
    await expect(
      promoteMinkAttachmentRefs(
        actor(),
        { image_url: ADDRESS },
        ["image_url"],
        {
          signal: stopped.signal,
        },
      ),
    ).rejects.toThrow("stopped");
    expect(withService).not.toHaveBeenCalled();

    // The stop lands while the rows are being read.
    const late = new AbortController();
    mock = makeDbMock({ executeQueue: [[attachmentRow(ID)]] });
    vi.mocked(withService).mockImplementation(async (fn) => {
      late.abort(new Error("timed out"));
      return fn(mock.db);
    });
    await expect(
      promoteMinkAttachmentRefs(
        actor(),
        { image_url: ADDRESS },
        ["image_url"],
        {
          signal: late.signal,
        },
      ),
    ).rejects.toThrow("timed out");
    expect(withService).toHaveBeenCalledTimes(1);
    expect(gcsDownloadObject).not.toHaveBeenCalled();
    expect(writeStoreObject).not.toHaveBeenCalled();
  });

  it("a picture whose private object is gone is no longer available; any other storage failure is reported as it is", async () => {
    mockDb({
      executeQueue: [[attachmentRow(ID)]],
      selectByTable: { media_assets: [[]] },
    });
    vi.mocked(gcsDownloadObject).mockRejectedValue(
      Object.assign(new Error("No such object"), { code: 404 }),
    );
    await expect(
      promoteMinkAttachmentRefs(actor(), { image_url: ADDRESS }, ["image_url"]),
    ).rejects.toThrow(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);

    mockDb({
      executeQueue: [[attachmentRow(ID)]],
      selectByTable: { media_assets: [[]] },
    });
    vi.mocked(gcsDownloadObject).mockRejectedValue(new Error("gcs down"));
    await expect(
      promoteMinkAttachmentRefs(actor(), { image_url: ADDRESS }, ["image_url"]),
    ).rejects.toThrow("gcs down");
    expect(writeStoreObject).not.toHaveBeenCalled();
    expect(mock.calls.insert).toEqual([]);
  });

  it("★ R7: more than 20 attachments in one call are refused before anything is read, never cut to 20", async () => {
    const ids = Array.from(
      { length: MINK_ATTACHMENT_PROMOTE_LIMIT + 1 },
      (_, n) =>
        `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    mockDb({ executeQueue: [[]] });
    const promise = promoteMinkAttachmentRefs(
      actor(),
      { image_urls: ids.map((id) => `/api/mink/attachments/${id}`) },
      ["image_urls"],
    );
    await expect(promise).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(promise).rejects.toThrow(MINK_ATTACHMENT_TOO_MANY);
    expect(MINK_ATTACHMENT_TOO_MANY).toBe(
      "At most 20 attached images can be used in one change.",
    );
    expect(withService).not.toHaveBeenCalled();
    expect(MINK_ATTACHMENT_PROMOTE_LIMIT).toBe(20);

    // Exactly 20 is still allowed (looked up, then refused here only because
    // the mock holds no rows).
    mockDb({ executeQueue: [[]] });
    await expect(
      promoteMinkAttachmentRefs(
        actor(),
        {
          image_urls: ids
            .slice(0, MINK_ATTACHMENT_PROMOTE_LIMIT)
            .map((id) => `/api/mink/attachments/${id}`),
        },
        ["image_urls"],
      ),
    ).rejects.toThrow(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
    expect(executed()[0].params[2]).toHaveLength(MINK_ATTACHMENT_PROMOTE_LIMIT);
  });

  it("★ R7 / S6: an address the scan cannot vouch for refuses the call before anything is read: disguised, as a key, past the walk's limits", async () => {
    let deep: unknown = ADDRESS;
    for (let n = 0; n < 9; n += 1) deep = [deep];
    const cases: [string, Record<string, unknown>, string[]][] = [
      [
        "percent-encoded",
        { image_url: encodeURIComponent(ADDRESS) },
        ["image_url"],
      ],
      [
        "JSON-escaped",
        { image_url: ADDRESS.replaceAll("/", "\\/") },
        ["image_url"],
      ],
      [
        "double slash",
        { image_url: `/api//mink/attachments/${ID}` },
        ["image_url"],
      ],
      [
        "an object key",
        { sections: [{ config: { [ADDRESS]: "x" } }] },
        ["sections"],
      ],
      [
        "depth 9, not a picture argument",
        { note: deep, image_url: "" },
        ["image_url"],
      ],
      [
        "after the 2,000th string",
        {
          note: Array.from({ length: 2_001 }, (_, n) =>
            n === 2_000 ? ADDRESS : "x",
          ),
        },
        [],
      ],
    ];
    for (const [label, args, allowed] of cases) {
      mockDb();
      await expect(
        promoteMinkAttachmentRefs(actor(), args, allowed),
        label,
      ).rejects.toThrow(MINK_ATTACHMENT_ONLY_AS_A_PICTURE);
      expect(withService, label).not.toHaveBeenCalled();
    }
  });

  it("a Library refresh that fails outside a request is swallowed", async () => {
    vi.mocked(revalidatePath).mockImplementation(() => {
      throw new Error("Invariant: static generation store missing");
    });
    mockDb({
      executeQueue: [[attachmentRow(ID)], []],
      selectByTable: { media_assets: [[], []] },
      returning: [{ url: COPY_URL }],
    });
    await expect(
      promoteMinkAttachmentRefs(actor(), { image_url: ADDRESS }, ["image_url"]),
    ).resolves.toEqual({ image_url: COPY_URL });
  });
});

// ---------------------------------------------------------------------------
// Review S2: only a picture field takes an attachment, in every tool's shape
// ---------------------------------------------------------------------------

/** A promotion of ID that succeeds: one row, no earlier copy, a new one. */
async function promoteOne(
  args: Record<string, unknown>,
  allowed: string[],
): Promise<Record<string, unknown>> {
  mockDb({
    executeQueue: [[attachmentRow(ID)], []],
    selectByTable: { media_assets: [[], []] },
    returning: [{ url: COPY_URL }],
  });
  return promoteMinkAttachmentRefs(actor(), args, allowed);
}

/** A promotion refused before any read, permission answer or copy. */
async function expectRefusedBeforeAnyRead(
  args: Record<string, unknown>,
  allowed: string[],
): Promise<void> {
  mockDb();
  vi.mocked(withService).mockClear();
  vi.mocked(gcsDownloadObject).mockClear();
  vi.mocked(writeStoreObject).mockClear();
  await expect(
    promoteMinkAttachmentRefs(actor(), args, allowed),
  ).rejects.toThrow(MINK_ATTACHMENT_ONLY_AS_A_PICTURE);
  expect(withService).not.toHaveBeenCalled();
  expect(gcsDownloadObject).not.toHaveBeenCalled();
  expect(writeStoreObject).not.toHaveBeenCalled();
}

describe("★★ S2: only a picture field takes an attachment, in each tool's argument shape", () => {
  it("image_urls (propose_product_images): each item that is an address becomes the copy; an item with more than an address refuses", async () => {
    await expect(
      promoteOne(
        {
          product_id: "p1",
          image_urls: [ADDRESS, "https://media.test/own.webp"],
          mode: "add",
        },
        ["image_urls"],
      ),
    ).resolves.toEqual({
      product_id: "p1",
      image_urls: [COPY_URL, "https://media.test/own.webp"],
      mode: "add",
    });
    await expectRefusedBeforeAnyRead(
      { product_id: "p1", image_urls: [`see ${ADDRESS}`] },
      ["image_urls"],
    );
  });

  it("cover_image_url (propose_blog_draft): the cover becomes the copy; a cover written as Markdown refuses", async () => {
    await expect(
      promoteOne(
        { title: "Shelf", content: "Our shelf.", cover_image_url: ADDRESS },
        ["cover_image_url"],
      ),
    ).resolves.toEqual({
      title: "Shelf",
      content: "Our shelf.",
      cover_image_url: COPY_URL,
    });
    await expectRefusedBeforeAnyRead(
      { title: "Shelf", cover_image_url: `![shelf](${ADDRESS})` },
      ["cover_image_url"],
    );
  });

  it("image_url (propose_product_create, propose_category_create and _update): the picture becomes the copy, with or without a host; a list where one picture goes refuses", async () => {
    await expect(
      promoteOne(
        {
          name: "Almond shake",
          image_url: `https://echoss.storemink.com${ADDRESS}`,
        },
        ["image_url"],
      ),
    ).resolves.toEqual({ name: "Almond shake", image_url: COPY_URL });
    await expectRefusedBeforeAnyRead(
      { name: "Almond shake", image_url: [ADDRESS] },
      ["image_url"],
    );
  });

  it("sections (propose_storefront_layout): every *_url media field, nested in items too, becomes the copy", async () => {
    const promoted = await promoteOne(
      {
        page_slug: "home",
        sections: [
          {
            id: "s1",
            type: "hero",
            config: {
              heading: "Fresh today",
              cta_href: "/shop",
              image_url: ADDRESS,
              mobile_image_url: ADDRESS,
            },
          },
          {
            id: "s2",
            type: "gallery",
            config: { items: [{ image_url: ADDRESS, caption: "Shelf" }] },
          },
          { id: "s3", keep: true },
        ],
      },
      ["sections"],
    );
    expect(promoted.sections).toEqual([
      {
        id: "s1",
        type: "hero",
        config: {
          heading: "Fresh today",
          cta_href: "/shop",
          image_url: COPY_URL,
          mobile_image_url: COPY_URL,
        },
      },
      {
        id: "s2",
        type: "gallery",
        config: { items: [{ image_url: COPY_URL, caption: "Shelf" }] },
      },
      { id: "s3", keep: true },
    ]);
    expect(gcsDownloadObject).toHaveBeenCalledTimes(1);
  });

  it("sections: an address in a heading, a link, a caption or a rich-text body refuses the whole call", async () => {
    for (const config of [
      { heading: ADDRESS, image_url: ADDRESS },
      { cta_href: ADDRESS },
      { items: [{ image_url: "https://media.test/own.webp", href: ADDRESS }] },
      { items: [{ caption: `Photo: ${ADDRESS}` }] },
      { html: `<p><img src="${ADDRESS}"></p>` },
    ]) {
      await expectRefusedBeforeAnyRead(
        { page_slug: "home", sections: [{ id: "s1", type: "hero", config }] },
        ["sections"],
      );
    }
  });

  it("changes_json (propose_website_builder_change): parsed, a section image, a chrome image field and the brand logo become the copy, written back as JSON", async () => {
    const page = await promoteOne(
      {
        operation: "page_update",
        changes_json: JSON.stringify({
          sections: [
            {
              id: "s1",
              type: "hero",
              config: { image_url: ADDRESS, heading: "Hi" },
            },
          ],
        }),
      },
      ["changes_json"],
    );
    expect(page.operation).toBe("page_update");
    expect(JSON.parse(page.changes_json as string)).toEqual({
      sections: [
        {
          id: "s1",
          type: "hero",
          config: { image_url: COPY_URL, heading: "Hi" },
        },
      ],
    });

    const chrome = await promoteOne(
      {
        operation: "chrome_update",
        changes_json: JSON.stringify({
          fields: [
            { path: "header.links.0.image_url", value: ADDRESS },
            { path: "header.links.0.label", value: "Shop" },
          ],
        }),
      },
      ["changes_json"],
    );
    expect(JSON.parse(chrome.changes_json as string)).toEqual({
      fields: [
        { path: "header.links.0.image_url", value: COPY_URL },
        { path: "header.links.0.label", value: "Shop" },
      ],
    });

    // The model wrote its JSON with escaped slashes: JSON reads them as one.
    const brand = await promoteOne(
      {
        operation: "brand_update",
        changes_json: `{"logoUrl":"${ADDRESS.replaceAll("/", "\\/")}"}`,
      },
      ["changes_json"],
    );
    expect(JSON.parse(brand.changes_json as string)).toEqual({
      logoUrl: COPY_URL,
    });
  });

  it("changes_json: an address in a link, a title or unreadable JSON refuses the whole call; JSON with no address is passed through as written", async () => {
    for (const changes of [
      JSON.stringify({
        fields: [{ path: "header.links.0.href", value: ADDRESS }],
      }),
      JSON.stringify({ title: ADDRESS }),
      JSON.stringify({
        sections: [{ id: "s1", config: { heading: ADDRESS } }],
      }),
      `{"logoUrl": "${ADDRESS}"`,
    ]) {
      await expectRefusedBeforeAnyRead(
        { operation: "chrome_update", changes_json: changes },
        ["changes_json"],
      );
    }
    mockDb();
    const args = {
      operation: "settings_update",
      changes_json: ' {"pages.customCode": true} ',
    };
    await expect(
      promoteMinkAttachmentRefs(actor(), args, ["changes_json"]),
    ).resolves.toBe(args);
  });

  it("products (start_storefront_revamp, refine_storefront_revamp): a product's photo_url becomes the copy; an address in a name or description refuses", async () => {
    await expect(
      promoteOne(
        {
          brief: "A bakery",
          products: [
            {
              name: "Sourdough",
              description: "Slow bread",
              photo_url: ADDRESS,
            },
            {
              name: "Bun",
              description: "Soft",
              photo_url: "https://media.test/own.webp",
            },
          ],
        },
        ["products"],
      ),
    ).resolves.toEqual({
      brief: "A bakery",
      products: [
        { name: "Sourdough", description: "Slow bread", photo_url: COPY_URL },
        {
          name: "Bun",
          description: "Soft",
          photo_url: "https://media.test/own.webp",
        },
      ],
    });
    for (const product of [
      { name: ADDRESS, photo_url: ADDRESS },
      { name: "Sourdough", description: `See ${ADDRESS}` },
    ]) {
      await expectRefusedBeforeAnyRead({ products: [product] }, ["products"]);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The inline read for image generation (design 5.3 item 6, 9.1)
// ---------------------------------------------------------------------------

describe("the inline read for image generation", () => {
  it("★★ reads the attacher's private bytes within the inline cap, as inlineData, never a public URL", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    vi.mocked(gcsDownloadObject).mockResolvedValue(bytes);
    mockDb({
      executeQueue: [[attachmentRow(ID, { content_type: "image/png" })]],
    });
    const refs = await readMinkAttachmentReferences(actor(), [ADDRESS]);
    expect(refs).toEqual([
      {
        url: ADDRESS,
        mimeType: "image/png",
        inlineData: {
          mimeType: "image/png",
          data: Buffer.from(bytes).toString("base64"),
        },
      },
    ]);
    expect(gcsDownloadObject).toHaveBeenCalledWith(
      attachmentRow(ID).path,
      MINK_ATTACHMENT_INLINE_MAX_BYTES,
      "private",
    );
    expect(MINK_ATTACHMENT_INLINE_MAX_BYTES).toBe(7 * 1024 * 1024);
    expect(writeStoreObject).not.toHaveBeenCalled();
    expect(gcsPublicUrl).not.toHaveBeenCalled();
    expect(mock.calls.insert).toEqual([]);
    expect(JSON.stringify(refs)).not.toContain("https://");
    const [rows] = executed();
    expect(rows.params).toEqual([STORE, ADMIN, [ID]]);
    expect(logInfo).toHaveBeenCalledWith(
      "mink.attachments: read inline",
      expect.objectContaining({ attachmentId: ID, md5: md5Base64(bytes) }),
    );
  });

  it("★★ each picture's bytes are asked of the re-upload guard; blocked bytes are refused as a reference with the attachment sentence", async () => {
    const bytes = new Uint8Array([3, 1, 4]);
    vi.mocked(gcsDownloadObject).mockResolvedValue(bytes);
    mockDb({ executeQueue: [[attachmentRow(ID)]] });
    await readMinkAttachmentReferences(actor(), [ADDRESS]);
    expect(assertUploadAllowed).toHaveBeenCalledWith({
      storeId: STORE,
      md5Base64: md5Base64(bytes),
      path: attachmentRow(ID).path,
      via: "mink_attachment_reference",
      contentType: "image/webp",
      actor: ADMIN,
    });
    for (const told of [true, false]) {
      mockDb({ executeQueue: [[attachmentRow(ID)]] });
      vi.mocked(assertUploadAllowed).mockRejectedValueOnce(
        new BlockedUploadError({ told, kindWord: "image", blockId: "b3" }),
      );
      const promise = readMinkAttachmentReferences(actor(), [ADDRESS]);
      await expect(promise).rejects.toBeInstanceOf(MinkToolInputError);
      await expect(promise).rejects.toThrow(attachmentRefusal(told));
    }
  });

  it("★ a gif or avif attachment is refused as a reference before any bytes are read", async () => {
    mockDb({
      executeQueue: [[attachmentRow(ID, { content_type: "image/gif" })]],
    });
    await expect(
      readMinkAttachmentReferences(actor(), [ADDRESS]),
    ).rejects.toThrow(MINK_ATTACHMENT_REFERENCE_TYPE_REFUSAL);
    expect(gcsDownloadObject).not.toHaveBeenCalled();
  });

  it("★ another admin's, a marked or a missing picture is no longer available", async () => {
    mockDb({ executeQueue: [[]] });
    await expect(
      readMinkAttachmentReferences(actor({ adminId: "staff-2" }), [ADDRESS]),
    ).rejects.toThrow(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
    expect(executed()[0].params).toEqual([STORE, "staff-2", [ID]]);
    expect(gcsDownloadObject).not.toHaveBeenCalled();
  });

  it("keeps the caller's order and reads a repeated address once", async () => {
    vi.mocked(gcsDownloadObject).mockImplementation(async (path: string) =>
      path.includes(ID_2) ? new Uint8Array([2]) : new Uint8Array([1]),
    );
    mockDb({
      executeQueue: [
        [
          attachmentRow(ID, { content_type: "image/jpeg" }),
          attachmentRow(ID_2, {
            path: `stores/${STORE}/mink-attachments/storemink_local/${ID_2}.webp`,
          }),
        ],
      ],
    });
    const refs = await readMinkAttachmentReferences(actor(), [
      ADDRESS_2,
      ADDRESS,
      ADDRESS_2,
    ]);
    expect(
      refs.map((ref) => [ref.url, ref.mimeType, ref.inlineData.data]),
    ).toEqual([
      [ADDRESS_2, "image/webp", Buffer.from([2]).toString("base64")],
      [ADDRESS, "image/jpeg", Buffer.from([1]).toString("base64")],
      [ADDRESS_2, "image/webp", Buffer.from([2]).toString("base64")],
    ]);
    expect(gcsDownloadObject).toHaveBeenCalledTimes(2);
    expect(executed()[0].params).toEqual([STORE, ADMIN, [ID_2, ID]]);
  });

  it("anything that is not an attachment address is refused, and nothing is read", async () => {
    mockDb();
    await expect(
      readMinkAttachmentReferences(actor(), [
        "https://media.test/stores/x/media/own.webp",
      ]),
    ).rejects.toThrow(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
    expect(withService).not.toHaveBeenCalled();
    await expect(readMinkAttachmentReferences(actor(), [])).resolves.toEqual(
      [],
    );
    expect(withService).not.toHaveBeenCalled();
  });

  it("a gone object is no longer available; any other storage failure is reported as it is", async () => {
    mockDb({ executeQueue: [[attachmentRow(ID)]] });
    vi.mocked(gcsDownloadObject).mockRejectedValue(
      Object.assign(new Error("No such object"), { code: 404 }),
    );
    await expect(
      readMinkAttachmentReferences(actor(), [ADDRESS]),
    ).rejects.toThrow(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
    mockDb({ executeQueue: [[attachmentRow(ID)]] });
    vi.mocked(gcsDownloadObject).mockRejectedValue(new Error("gcs down"));
    await expect(
      readMinkAttachmentReferences(actor(), [ADDRESS]),
    ).rejects.toThrow("gcs down");
  });
});
