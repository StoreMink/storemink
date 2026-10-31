import { describe, expect, it } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";
import { moderationEvents } from "@/drizzle/schema";
import {
  ACTOR_MAX,
  DETAIL_MAX_BYTES,
  boundedDetail,
  moderationEventRow,
  recordModerationEvent,
} from "./record";

const BLOCK = "0E7E2A3C-1B2C-4D5E-8F90-123456789ABC";
const STORE = "a0000000-0000-4000-8000-000000000001";

describe("recordModerationEvent", () => {
  it("inserts one row on the caller's connection and answers its id", async () => {
    const mock = makeDbMock({ returning: [{ id: "event-1" }] });
    const id = await recordModerationEvent(mock.db, {
      actor: "  ops@storemink.com ",
      action: "reupload_refused",
      blockId: BLOCK,
      storeId: STORE,
      detail: { via: "upload_route", told: true },
    });
    expect(id).toBe("event-1");
    expect(mock.calls.insert).toEqual([moderationEvents]);
    expect(mock.calls.values).toEqual([
      {
        actor: "ops@storemink.com",
        action: "reupload_refused",
        complaintId: null,
        blockId: BLOCK.toLowerCase(),
        holdId: null,
        storeId: STORE,
        detail: { via: "upload_route", told: true },
      },
    ]);
  });

  it("lets the insert's failure reach the caller's transaction", async () => {
    const mock = makeDbMock({ failInsertFor: [moderationEvents] });
    await expect(
      recordModerationEvent(mock.db, {
        actor: "system",
        action: "block_created",
      }),
    ).rejects.toThrow("db write failed");
  });
});

describe("moderationEventRow", () => {
  it("refuses an action the table does not know", () => {
    expect(() =>
      moderationEventRow({
        actor: "system",
        action: "block_deleted" as never,
      }),
    ).toThrow(/unknown action/);
  });

  it("refuses an empty actor and cuts a long one to the column's limit", () => {
    expect(() =>
      moderationEventRow({ actor: "   ", action: "block_created" }),
    ).toThrow(/actor is required/);
    const row = moderationEventRow({
      actor: "x".repeat(ACTOR_MAX + 40),
      action: "block_created",
    });
    expect(row.actor).toHaveLength(ACTOR_MAX);
  });

  it("refuses an id that is not a UUID, and keeps absent ids null", () => {
    expect(() =>
      moderationEventRow({
        actor: "system",
        action: "block_created",
        blockId: "not-a-uuid",
      }),
    ).toThrow(/blockId must be a UUID/);
    const row = moderationEventRow({
      actor: "system",
      action: "block_created",
    });
    expect(row).toMatchObject({
      complaintId: null,
      blockId: null,
      holdId: null,
      storeId: null,
      detail: {},
    });
  });
});

describe("boundedDetail", () => {
  it("keeps a small object as plain JSON (undefined values dropped)", () => {
    expect(boundedDetail({ a: 1, b: undefined, c: [1, "two"] })).toEqual({
      a: 1,
      c: [1, "two"],
    });
  });

  it("is an empty object for null, an array or a non-object", () => {
    expect(boundedDetail(null)).toEqual({});
    expect(boundedDetail([1, 2] as never)).toEqual({});
    expect(boundedDetail("text" as never)).toEqual({});
  });

  it("replaces a detail too large for the table with a small note", () => {
    const huge = { note: "y".repeat(DETAIL_MAX_BYTES + 10), other: 1 };
    const result = boundedDetail(huge);
    expect(result).toMatchObject({
      detailTooLarge: true,
      keys: ["note", "other"],
    });
    expect(JSON.stringify(result).length).toBeLessThan(400);
    const many = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [`k${i}`, i]),
    );
    expect(boundedDetail(many)).toMatchObject({ detailTooLarge: true });
  });

  it("answers a note for a detail JSON cannot write", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(boundedDetail(loop)).toEqual({ detailUnreadable: true });
  });
});
