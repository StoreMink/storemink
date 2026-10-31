import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The record of an archived copy, for a superadmin (takedown stage T15;
 * design 5.5, 10): 404 for anyone else with nothing read, the receipt
 * checked, the download recorded and the copy read on that new event.
 */

const BLOCK = "11111111-1111-4111-8111-111111111111";
const STORE = "33333333-3333-4333-8333-333333333333";
const RECEIPT = "55555555-5555-4555-8555-555555555555";
const NEW_EVENT = "66666666-6666-4666-8666-666666666666";

const h = vi.hoisted(() => ({
  viewer: null as null | { email: string; role: "superadmin" | "member" },
  receipt: [] as { reason: unknown }[],
  dbDown: false,
  queries: [] as { text: string; params: unknown[] }[],
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
vi.mock("@/lib/moderation/console-read", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/console-read")>();
  return { ...actual, getArchiveForViewing: vi.fn() };
});

import { GET } from "./route";
import { withService } from "@/lib/db/client";
import { recordArchiveView } from "@/lib/moderation/archive";
import { getArchiveForViewing } from "@/lib/moderation/console-read";

const SUPER = { email: "owner@storemink.com", role: "superadmin" as const };
const MEMBER = { email: "member@storemink.com", role: "member" as const };

const RAW_FILE = { n: 3, path: "stores/s/media/mug.webp", state: "copied" };

function get(query = `?receipt=${RECEIPT}`, blockId = BLOCK) {
  return GET(
    new Request(
      `https://storemink.com/api/platform/takedowns/${blockId}/record${query}`,
    ),
    { params: Promise.resolve({ blockId }) },
  );
}

beforeEach(() => {
  h.viewer = SUPER;
  h.receipt = [{ reason: "Police letter 42" }];
  h.dbDown = false;
  h.queries = [];
  vi.mocked(recordArchiveView).mockResolvedValue({
    ok: true,
    eventId: NEW_EVENT,
    file: null,
    thisDatabase: true,
  });
  vi.mocked(getArchiveForViewing).mockResolvedValue({
    ok: true,
    archive: {
      blockId: BLOCK,
      storeId: STORE,
      createdAt: "2026-10-26T07:01:00.000Z",
      keepUntil: "2027-04-24T18:29:59.000Z",
      legalHold: false,
      snapshot: { item: { name: "Blue mug" } },
      sha256: "a".repeat(64),
      hashMatches: true,
      filesState: "complete",
      files: [{ entry: null, raw: RAW_FILE }],
    },
  });
});

describe("who may read it", () => {
  it.each([
    ["a caller who is not an operator", null],
    ["a member", MEMBER],
  ])("answers 404 to %s, reading nothing", async (_who, viewer) => {
    h.viewer = viewer;
    const response = await get();
    expect(response.status).toBe(404);
    expect(withService).not.toHaveBeenCalled();
    expect(recordArchiveView).not.toHaveBeenCalled();
    expect(getArchiveForViewing).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed block id", async () => {
    expect((await get(undefined, "nope")).status).toBe(404);
    expect(withService).not.toHaveBeenCalled();
  });
});

describe("a superadmin", () => {
  it("downloads the record, recorded first and read on that new event", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="takedown-record-${BLOCK}.json"`,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex");

    const body = JSON.parse(await response.text());
    expect(body).toMatchObject({
      blockId: BLOCK,
      storeId: STORE,
      sha256: "a".repeat(64),
      hashMatches: true,
      downloadedBy: SUPER.email,
      snapshot: { item: { name: "Blue mug" } },
      files: [RAW_FILE],
    });

    expect(recordArchiveView).toHaveBeenCalledWith(
      BLOCK,
      "Police letter 42",
      SUPER,
      { download: true, what: "record" },
    );
    expect(getArchiveForViewing).toHaveBeenCalledWith(
      BLOCK,
      { eventId: NEW_EVENT },
      SUPER,
    );
    expect(
      vi.mocked(recordArchiveView).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(getArchiveForViewing).mock.invocationCallOrder[0]);
    expect(h.queries[0].params).toEqual([RECEIPT, BLOCK, SUPER.email, 10]);
  });
});

describe("no reason, no read", () => {
  it("asks for the reason with no receipt, or a stale one", async () => {
    const none = await get("");
    expect(none.status).toBe(403);
    expect(await none.text()).toBe("Write why you are opening it.");
    h.receipt = [];
    expect((await get()).status).toBe(403);
    expect(recordArchiveView).not.toHaveBeenCalled();
    expect(getArchiveForViewing).not.toHaveBeenCalled();
  });

  it("answers 503 when the receipt cannot be read", async () => {
    h.dbDown = true;
    expect((await get()).status).toBe(503);
    expect(recordArchiveView).not.toHaveBeenCalled();
  });
});

describe("what the archive answers", () => {
  it("410 for a deleted copy, before anything is read", async () => {
    vi.mocked(recordArchiveView).mockResolvedValue({
      ok: false,
      error: "The copy was already deleted.",
    });
    expect((await get()).status).toBe(410);
    expect(getArchiveForViewing).not.toHaveBeenCalled();
  });

  it("404 when the copy is not found on read, 503 when the read throws", async () => {
    vi.mocked(getArchiveForViewing).mockResolvedValue({
      ok: false,
      error: "We could not find that copy.",
    });
    expect((await get()).status).toBe(404);
    vi.mocked(getArchiveForViewing).mockRejectedValue(new Error("down"));
    expect((await get()).status).toBe(503);
  });
});
