import { Readable } from "node:stream";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchivedFile } from "@/lib/moderation/storage";

/**
 * One archived file, for a superadmin (takedown stage T15; design 5.5, 10):
 * 404 for anyone else with nothing read, the receipt checked, the view or
 * download recorded before a byte is read, and the headers of 5.5. Storage
 * and the database are fakes; nothing reaches a network.
 */

const BLOCK = "11111111-1111-4111-8111-111111111111";
const RECEIPT = "55555555-5555-4555-8555-555555555555";
const NEW_EVENT = "66666666-6666-4666-8666-666666666666";
const PATH = `takedown-archive/storemink_local/${BLOCK}/3-mug.webp`;

const h = vi.hoisted(() => ({
  viewer: null as null | { email: string; role: "superadmin" | "member" },
  receipt: [] as { reason: unknown }[],
  dbDown: false,
  privateBucket: true,
  info: null as null | { size: number; contentType: string | null },
  queries: [] as { text: string; params: unknown[] }[],
  streamFails: false,
}));

vi.mock("@/app/actions/platform", () => ({
  getPlatformViewer: vi.fn(async () => h.viewer),
}));
vi.mock("@/lib/db/client", () => {
  const dialect = new PgDialect();
  const db = {
    execute: async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      h.queries.push({
        text: compiled.sql.replace(/\s+/g, " ").trim(),
        params: compiled.params,
      });
      if (h.dbDown) throw new Error("database down");
      return { rows: h.receipt };
    },
  };
  return {
    withService: vi.fn(async (fn: (value: typeof db) => Promise<unknown>) =>
      fn(db),
    ),
    withUser: vi.fn(async () => {
      throw new Error("not used");
    }),
    withAnon: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
});
vi.mock("@/lib/storage/gcs", () => ({
  get gcsPrivateConfigured() {
    return h.privateBucket;
  },
  gcsObjectInfo: vi.fn(async () => h.info),
  gcsObjectStream: vi.fn(async () => {
    if (h.streamFails) throw new Error("storage down");
    return Readable.from([Buffer.from("RIFF"), Buffer.from("webp!")]);
  }),
}));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/moderation/archive", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/archive")>();
  return { ...actual, recordArchiveView: vi.fn() };
});

import { GET } from "./route";
import { withService } from "@/lib/db/client";
import { gcsObjectInfo, gcsObjectStream } from "@/lib/storage/gcs";
import { logError } from "@/lib/observability/logger";
import { recordArchiveView } from "@/lib/moderation/archive";

const SUPER = { email: "owner@storemink.com", role: "superadmin" as const };
const MEMBER = { email: "member@storemink.com", role: "member" as const };

function file(over: Partial<ArchivedFile> = {}): ArchivedFile {
  return {
    n: 3,
    source: "bucket",
    path: "stores/s/media/mug.webp",
    state: "copied",
    sourceBucket: "media",
    sourceGeneration: "1",
    archivePath: PATH,
    archiveGeneration: "2",
    size: 9,
    contentType: "image/webp",
    md5: null,
    crc32c: null,
    sha256: null,
    cacheControl: null,
    at: "2026-10-26T07:01:00.000Z",
    ...over,
  } as ArchivedFile;
}

function get(
  query = `?receipt=${RECEIPT}`,
  blockId = BLOCK,
  index = "3",
): Promise<Response> {
  return GET(
    new Request(
      `https://storemink.com/api/platform/takedowns/${blockId}/files/${index}${query}`,
    ),
    { params: Promise.resolve({ blockId, index }) },
  );
}

function expectNothingRead() {
  expect(withService).not.toHaveBeenCalled();
  expect(recordArchiveView).not.toHaveBeenCalled();
  expect(gcsObjectInfo).not.toHaveBeenCalled();
  expect(gcsObjectStream).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.viewer = SUPER;
  h.receipt = [{ reason: "SM-000123" }];
  h.dbDown = false;
  h.privateBucket = true;
  h.info = { size: 9, contentType: "image/webp" };
  h.queries = [];
  h.streamFails = false;
  vi.mocked(recordArchiveView).mockResolvedValue({
    ok: true,
    eventId: NEW_EVENT,
    file: file(),
    thisDatabase: true,
  });
});

describe("who may read it", () => {
  it("answers 404 to a caller who is not an operator, reading nothing", async () => {
    h.viewer = null;
    expect((await get()).status).toBe(404);
    expectNothingRead();
  });

  it("answers 404 to a member, reading nothing", async () => {
    h.viewer = MEMBER;
    const response = await get();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expectNothingRead();
  });

  it("answers 404 for a malformed block or file number", async () => {
    expect((await get(undefined, "not-a-uuid")).status).toBe(404);
    expect((await get(undefined, BLOCK, "x1")).status).toBe(404);
    expect((await get(undefined, BLOCK, "-1")).status).toBe(404);
    expectNothingRead();
  });
});

describe("a superadmin", () => {
  it("gets the bytes with the headers of 5.5, recorded before they are read", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "RIFFwebp!",
    );
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("content-length")).toBe("9");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("content-disposition")).toBe(
      `inline; filename="3-mug.webp"; filename*=UTF-8''3-mug.webp`,
    );

    expect(recordArchiveView).toHaveBeenCalledWith(BLOCK, "SM-000123", SUPER, {
      download: false,
      what: { file: 3 },
    });
    const recorded = vi.mocked(recordArchiveView).mock.invocationCallOrder[0];
    expect(recorded).toBeLessThan(
      vi.mocked(gcsObjectInfo).mock.invocationCallOrder[0],
    );
    expect(recorded).toBeLessThan(
      vi.mocked(gcsObjectStream).mock.invocationCallOrder[0],
    );
    expect(gcsObjectStream).toHaveBeenCalledWith("private", PATH);
  });

  it("reads the receipt as the operator's own, for this block, within ten minutes", async () => {
    await get();
    expect(h.queries).toHaveLength(1);
    const [query] = h.queries;
    expect(query.text).toContain("from public.moderation_events e");
    expect(query.text).toContain("e.actor = $");
    expect(query.text).toContain(
      "e.action in ('archive_viewed', 'archive_downloaded')",
    );
    expect(query.text).toContain("make_interval(mins => $");
    expect(query.params).toEqual([RECEIPT, BLOCK, SUPER.email, 10]);
  });

  it("downloads as an attachment, recorded as a download", async () => {
    const response = await get(`?receipt=${RECEIPT}&download=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="3-mug.webp"/,
    );
    expect(vi.mocked(recordArchiveView).mock.calls[0][3]).toEqual({
      download: true,
      what: { file: 3 },
    });
  });

  it("never shows a file that could run as a page inline", async () => {
    vi.mocked(recordArchiveView).mockResolvedValue({
      ok: true,
      eventId: NEW_EVENT,
      file: file({ contentType: "image/svg+xml" }),
      thisDatabase: true,
    });
    const response = await get();
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  });
});

describe("no reason, no read", () => {
  it("asks for the reason when there is no receipt", async () => {
    const response = await get("");
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Write why you are opening it.");
    expectNothingRead();
  });

  it("asks for the reason when the receipt is someone else's or stale", async () => {
    h.receipt = [];
    const response = await get();
    expect(response.status).toBe(403);
    expect(recordArchiveView).not.toHaveBeenCalled();
    expect(gcsObjectStream).not.toHaveBeenCalled();
  });

  it("answers 503 when the receipt cannot be read", async () => {
    h.dbDown = true;
    expect((await get()).status).toBe(503);
    expect(recordArchiveView).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });
});

describe("what the archive answers", () => {
  it.each([
    ["We could not find that file in the copy.", 404],
    ["We could not find that copy.", 404],
    ["The copy was already deleted.", 410],
    ["Could not save it. Please try again.", 503],
  ])("%s is %i, and nothing is read", async (error, status) => {
    vi.mocked(recordArchiveView).mockResolvedValue({ ok: false, error });
    expect((await get()).status).toBe(status);
    expect(gcsObjectStream).not.toHaveBeenCalled();
  });

  it("answers 503 where there is no private bucket", async () => {
    h.privateBucket = false;
    expect((await get()).status).toBe(503);
    expect(recordArchiveView).not.toHaveBeenCalled();
  });

  it("answers 404 when the archived object is gone", async () => {
    h.info = null;
    expect((await get()).status).toBe(404);
    expect(recordArchiveView).toHaveBeenCalledTimes(1);
    expect(gcsObjectStream).not.toHaveBeenCalled();
  });

  it("answers 502 and logs when storage fails", async () => {
    h.streamFails = true;
    expect((await get()).status).toBe(502);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
