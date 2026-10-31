import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";
import {
  contentBlockArchives,
  moderationEvents,
  storeLegalHolds,
} from "@/drizzle/schema";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import {
  HOLD_ERRORS,
  STORE_DELETE_REFUSALS,
  activeStoreHold,
  deleteRefusalForError,
  releaseStoreHold,
  reviewDateOf,
  setStoreHold,
  storeDeleteRefusal,
} from "./holds";

const STORE = "a0000000-0000-4000-8000-000000000001";
const HOLD = "11111111-2222-4333-8444-555555555555";
const COMPLAINT = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const SUPER = { email: "boss@storemink.com", role: "superadmin" as const };
const MEMBER = { email: "ops@storemink.com", role: "member" as const };

function useDb(mock: ReturnType<typeof makeDbMock>) {
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
  return mock;
}

function holdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: HOLD,
    storeId: STORE,
    storeLabel: "Crumb & Co (crumb.storemink.com)",
    reason: "Police notice 12/2026",
    authorityRef: "",
    complaintId: null,
    setAt: "2026-10-30 10:00:00+00",
    setBy: SUPER.email,
    reviewOn: null,
    releasedAt: null,
    releasedBy: null,
    releaseNote: "",
    ...overrides,
  };
}

function eventValues(mock: ReturnType<typeof makeDbMock>) {
  const index = mock.calls.insert.indexOf(moderationEvents);
  return index >= 0 ? mock.calls.values[index] : undefined;
}

const STORE_ROW = { name: "Crumb & Co", slug: "crumb" };

describe("setStoreHold", () => {
  beforeEach(() => {
    useDb(makeDbMock());
  });

  it("is a superadmin's alone", async () => {
    const result = await setStoreHold(
      { storeId: STORE, reason: "Police notice" },
      MEMBER,
    );
    expect(result).toEqual({ ok: false, error: HOLD_ERRORS.setSuperadminOnly });
    expect(withService).not.toHaveBeenCalled();
  });

  it("needs a reason, and keeps the limits", async () => {
    expect(
      await setStoreHold({ storeId: STORE, reason: "   " }, SUPER),
    ).toEqual({ ok: false, error: HOLD_ERRORS.reasonMissing });
    expect(
      await setStoreHold({ storeId: STORE, reason: "x".repeat(2001) }, SUPER),
    ).toEqual({ ok: false, error: HOLD_ERRORS.reasonLong });
    expect(
      await setStoreHold(
        { storeId: STORE, reason: "r", authorityRef: "x".repeat(501) },
        SUPER,
      ),
    ).toEqual({ ok: false, error: HOLD_ERRORS.authorityRefLong });
    expect(
      await setStoreHold(
        { storeId: STORE, reason: "r", reviewOn: "2026-02-30" },
        SUPER,
      ),
    ).toEqual({ ok: false, error: HOLD_ERRORS.reviewOn });
    expect(
      await setStoreHold({ storeId: "crumb", reason: "r" }, SUPER),
    ).toEqual({ ok: false, error: HOLD_ERRORS.storeNotFound });
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses a store that does not exist", async () => {
    const mock = useDb(makeDbMock({ selectQueue: [[]] }));
    const result = await setStoreHold({ storeId: STORE, reason: "r" }, SUPER);
    expect(result).toEqual({ ok: false, error: HOLD_ERRORS.storeNotFound });
    expect(mock.calls.insert).toHaveLength(0);
  });

  it("refuses a second active hold", async () => {
    const mock = useDb(
      makeDbMock({ selectQueue: [[STORE_ROW], [{ id: HOLD }]] }),
    );
    const result = await setStoreHold({ storeId: STORE, reason: "r" }, SUPER);
    expect(result).toEqual({ ok: false, error: HOLD_ERRORS.alreadyHeld });
    expect(mock.calls.insert).toHaveLength(0);
  });

  it("refuses a complaint reference that names nothing", async () => {
    const mock = useDb(makeDbMock({ selectQueue: [[STORE_ROW], []] }));
    const result = await setStoreHold(
      { storeId: STORE, reason: "r", complaint: "SM-000123" },
      SUPER,
    );
    expect(result).toEqual({ ok: false, error: HOLD_ERRORS.complaintNotFound });
    expect(mock.calls.insert).toHaveLength(0);
  });

  it("holds the store, linked to its complaint by reference, and records it", async () => {
    const hold = holdRow({ complaintId: COMPLAINT, reviewOn: "2026-12-01" });
    const mock = useDb(
      makeDbMock({
        selectQueue: [[STORE_ROW], [{ id: COMPLAINT }], []],
        returningQueue: [[hold], [{ id: "event-1" }]],
      }),
    );
    const result = await setStoreHold(
      {
        storeId: STORE,
        reason: "  Police notice 12/2026 ",
        authorityRef: " Cyber cell, Faridkot ",
        complaint: "sm-000123",
        reviewOn: "2026-12-01",
      },
      SUPER,
    );
    expect(result).toEqual({ ok: true, hold });
    // The complaint was found by its reference number.
    const complaintWhere = new PgDialect().sqlToQuery(mock.calls.where[1]);
    expect(complaintWhere.params).toEqual([123]);
    expect(mock.calls.insert[0]).toBe(storeLegalHolds);
    expect(mock.calls.values[0]).toEqual({
      storeId: STORE,
      storeLabel: "Crumb & Co (crumb.storemink.com)",
      reason: "Police notice 12/2026",
      authorityRef: "Cyber cell, Faridkot",
      complaintId: COMPLAINT,
      setBy: SUPER.email,
      reviewOn: "2026-12-01",
    });
    expect(eventValues(mock)).toMatchObject({
      actor: SUPER.email,
      action: "store_hold_set",
      holdId: HOLD,
      storeId: STORE,
      complaintId: COMPLAINT,
      detail: { reviewOn: "2026-12-01" },
    });
  });

  it("reads a second hold landing together as already held", async () => {
    const mock = makeDbMock({ selectQueue: [[STORE_ROW], []] });
    mock.db.insert = vi.fn(() => ({
      values: () => ({
        returning: () =>
          Promise.reject(
            Object.assign(new Error("Failed query"), {
              cause: { code: "23505" },
            }),
          ),
      }),
    }));
    useDb(mock);
    const result = await setStoreHold({ storeId: STORE, reason: "r" }, SUPER);
    expect(result).toEqual({ ok: false, error: HOLD_ERRORS.alreadyHeld });
  });

  it("says it could not save on any other failure, and logs it", async () => {
    useDb(makeDbMock({ selectQueue: [new Error("connection reset")] }));
    const result = await setStoreHold({ storeId: STORE, reason: "r" }, SUPER);
    expect(result).toEqual({ ok: false, error: HOLD_ERRORS.saveFailed });
    expect(logError).toHaveBeenCalled();
  });
});

describe("releaseStoreHold", () => {
  beforeEach(() => {
    useDb(makeDbMock());
  });

  it("is a superadmin's alone, and needs a note", async () => {
    expect(await releaseStoreHold(HOLD, "done", MEMBER)).toEqual({
      ok: false,
      error: HOLD_ERRORS.releaseSuperadminOnly,
    });
    expect(await releaseStoreHold(HOLD, "  ", SUPER)).toEqual({
      ok: false,
      error: HOLD_ERRORS.noteMissing,
    });
    expect(await releaseStoreHold("nope", "done", SUPER)).toEqual({
      ok: false,
      error: HOLD_ERRORS.holdNotFound,
    });
    expect(withService).not.toHaveBeenCalled();
  });

  it("releases an active hold with its note, and records it", async () => {
    const released = holdRow({
      releasedAt: "2026-11-01 10:00:00+00",
      releasedBy: SUPER.email,
      releaseNote: "Investigation closed",
    });
    const mock = useDb(
      makeDbMock({ returningQueue: [[released], [{ id: "event-1" }]] }),
    );
    const result = await releaseStoreHold(
      HOLD,
      " Investigation closed ",
      SUPER,
    );
    expect(result).toEqual({ ok: true, hold: released });
    expect(mock.calls.set[0]).toMatchObject({
      releasedBy: SUPER.email,
      releaseNote: "Investigation closed",
    });
    const where = new PgDialect().sqlToQuery(mock.calls.where[0]);
    expect(where.sql).toContain('"store_legal_holds"."released_at" is null');
    expect(eventValues(mock)).toMatchObject({
      action: "store_hold_released",
      holdId: HOLD,
      storeId: STORE,
    });
  });

  it("tells a released hold from a missing one", async () => {
    useDb(makeDbMock({ returningQueue: [[]], selectQueue: [[{ id: HOLD }]] }));
    expect(await releaseStoreHold(HOLD, "done", SUPER)).toEqual({
      ok: false,
      error: HOLD_ERRORS.alreadyReleased,
    });
    useDb(makeDbMock({ returningQueue: [[]], selectQueue: [[]] }));
    expect(await releaseStoreHold(HOLD, "done", SUPER)).toEqual({
      ok: false,
      error: HOLD_ERRORS.holdNotFound,
    });
  });
});

describe("activeStoreHold", () => {
  it("answers the store's active hold", async () => {
    const hold = holdRow();
    const mock = useDb(makeDbMock({ selectQueue: [[hold]] }));
    expect(await activeStoreHold(STORE)).toEqual(hold);
    const where = new PgDialect().sqlToQuery(mock.calls.where[0]);
    expect(where.sql).toContain('"store_legal_holds"."released_at" is null');
    expect(where.params).toEqual([STORE]);
  });

  it("answers null for no hold, a malformed id, or no table yet", async () => {
    useDb(makeDbMock({ selectQueue: [[]] }));
    expect(await activeStoreHold(STORE)).toBeNull();
    expect(await activeStoreHold("crumb")).toBeNull();
    useDb(
      makeDbMock({
        selectQueue: [Object.assign(new Error("no table"), { code: "42P01" })],
      }),
    );
    expect(await activeStoreHold(STORE)).toBeNull();
  });

  it("throws on any other failure", async () => {
    useDb(makeDbMock({ selectQueue: [new Error("connection reset")] }));
    await expect(activeStoreHold(STORE)).rejects.toThrow("connection reset");
  });
});

describe("storeDeleteRefusal", () => {
  it("refuses a held store, without reading the archives", async () => {
    const mock = useDb(makeDbMock({ selectQueue: [[{ id: HOLD }]] }));
    expect(await storeDeleteRefusal(STORE)).toEqual({
      reason: "hold",
      message: STORE_DELETE_REFUSALS.hold,
      holdId: HOLD,
    });
    expect(mock.calls.select).toHaveLength(1);
    expect(mock.calls.insert).toHaveLength(0);
  });

  it("refuses a store with an archive still being copied", async () => {
    const mock = useDb(
      makeDbMock({ selectQueue: [[], [{ id: "archive-1" }]] }),
    );
    expect(await storeDeleteRefusal(STORE)).toEqual({
      reason: "archive",
      message: STORE_DELETE_REFUSALS.archive,
      holdId: null,
    });
    const archiveWhere = new PgDialect().sqlToQuery(mock.calls.where[1]);
    expect(archiveWhere.sql).toContain(
      '"content_block_archives"."files_state" in ($2, $3)',
    );
    expect(archiveWhere.params).toEqual([STORE, "pending", "failed"]);
    expect(mock.calls.insert).not.toContain(contentBlockArchives);
  });

  it("answers null when nothing keeps the store", async () => {
    const mock = useDb(makeDbMock({ selectQueue: [[], []] }));
    expect(await storeDeleteRefusal(STORE, { actor: SUPER.email })).toBeNull();
    expect(mock.calls.insert).toHaveLength(0);
  });

  it("records the refusal when given the actor, in the same scope", async () => {
    const mock = useDb(makeDbMock({ selectQueue: [[{ id: HOLD }]] }));
    await storeDeleteRefusal(STORE, { actor: SUPER.email });
    expect(withService).toHaveBeenCalledTimes(1);
    expect(eventValues(mock)).toMatchObject({
      actor: SUPER.email,
      action: "store_delete_refused",
      storeId: STORE,
      holdId: HOLD,
      detail: { reason: "hold" },
    });
  });

  it("answers null before the takedown tables exist", async () => {
    useDb(
      makeDbMock({
        selectQueue: [Object.assign(new Error("no table"), { code: "42P01" })],
      }),
    );
    expect(await storeDeleteRefusal(STORE)).toBeNull();
  });

  it("throws on any other failure, so a delete never goes ahead blind", async () => {
    useDb(makeDbMock({ selectQueue: [new Error("connection reset")] }));
    await expect(storeDeleteRefusal(STORE)).rejects.toThrow("connection reset");
  });
});

describe("deleteRefusalForError", () => {
  function triggerError(message: string) {
    return Object.assign(new Error("Failed query: delete from stores"), {
      cause: Object.assign(new Error(message), { code: "P0001" }),
    });
  }

  it("reads the trigger's two refusals, wrapped or not", () => {
    expect(
      deleteRefusalForError(
        triggerError(
          `stores: ${STORE} is on hold for an investigation and cannot be deleted`,
        ),
      ),
    ).toEqual({ reason: "hold", message: STORE_DELETE_REFUSALS.hold });
    expect(
      deleteRefusalForError(
        new Error(
          `stores: ${STORE} has a StoreMink archive whose files are not copied yet`,
        ),
      ),
    ).toEqual({ reason: "archive", message: STORE_DELETE_REFUSALS.archive });
  });

  it("leaves every other error alone", () => {
    expect(deleteRefusalForError(triggerError("something else"))).toBeNull();
    expect(deleteRefusalForError("boom")).toBeNull();
    expect(deleteRefusalForError(null)).toBeNull();
  });

  it("matches what migration 0269 raises", () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        "drizzle/migrations/sql/20261030_0269_content_takedown.sql",
      ),
      "utf8",
    );
    expect(migration).toContain(
      "'stores: % is on hold for an investigation and cannot be deleted'",
    );
    expect(migration).toContain(
      "'stores: % has a StoreMink archive whose files are not copied yet'",
    );
  });
});

describe("reviewDateOf", () => {
  it("keeps a calendar date that exists", () => {
    expect(reviewDateOf(" 2026-12-01 ")).toBe("2026-12-01");
    expect(reviewDateOf("2028-02-29")).toBe("2028-02-29");
  });

  it("refuses anything else", () => {
    expect(reviewDateOf("2026-02-30")).toBeNull();
    expect(reviewDateOf("01/12/2026")).toBeNull();
    expect(reviewDateOf("")).toBeNull();
    expect(reviewDateOf(null)).toBeNull();
  });
});
