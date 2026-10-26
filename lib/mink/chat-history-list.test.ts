import { describe, expect, it } from "vitest";
import {
  historyInstant,
  mergeHistoryRefresh,
  sortsAfter,
} from "./chat-history-list";

/** Row n is a minute older than row n - 1. */
function row(n: number, id = `id-${String(n).padStart(3, "0")}`) {
  const minute = String(59 - n).padStart(2, "0");
  return { id, lastMessageAt: `2026-10-26 07:${minute}:00.000001+00` };
}
const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("historyInstant", () => {
  it("reads Postgres's own text and ISO alike, microseconds included", () => {
    expect(historyInstant("2026-10-26 07:07:12.123456+00")).toEqual([
      Date.parse("2026-10-26T07:07:12.123Z"),
      456,
    ]);
    expect(historyInstant("2026-10-26 12:37:12.5+05:30")[0]).toBe(
      Date.parse("2026-10-26T07:07:12.500Z"),
    );
    expect(historyInstant("2026-10-26T07:07:12.123Z")).toEqual([
      Date.parse("2026-10-26T07:07:12.123Z"),
      0,
    ]);
  });
});

describe("sortsAfter", () => {
  it("orders newest first, by microseconds when the milliseconds tie, then by id", () => {
    const newer = { id: "a", lastMessageAt: "2026-10-26 07:00:00.000002+00" };
    const older = { id: "b", lastMessageAt: "2026-10-26 07:00:00.000001+00" };
    expect(sortsAfter(older, newer)).toBe(true);
    expect(sortsAfter(newer, older)).toBe(false);
    const tieLow = { id: "a", lastMessageAt: newer.lastMessageAt };
    const tieHigh = { id: "b", lastMessageAt: newer.lastMessageAt };
    expect(sortsAfter(tieLow, tieHigh)).toBe(true);
    expect(sortsAfter(tieHigh, tieLow)).toBe(false);
  });
});

describe("mergeHistoryRefresh", () => {
  it("a page with no next page is the whole list", () => {
    const loaded = { items: [row(1), row(2), row(3)], cursor: "c-old" };
    expect(
      mergeHistoryRefresh(loaded, {
        items: [row(0), row(1)],
        nextCursor: null,
      }),
    ).toEqual({ items: [row(0), row(1)], cursor: null });
  });

  it("★ keeps the rows scrolled in below page 1, with the old cursor", () => {
    const loaded = {
      items: Array.from({ length: 45 }, (_, n) => row(n + 1)),
      cursor: "c-after-45",
    };
    // A new chat at the top: page 1 is it and rows 1 to 29.
    const page = {
      items: [row(0), ...Array.from({ length: 29 }, (_, n) => row(n + 1))],
      nextCursor: "c-after-29",
    };
    const merged = mergeHistoryRefresh(loaded, page);
    expect(merged.items).toHaveLength(46);
    expect(ids(merged.items)).toEqual(ids([row(0), ...loaded.items]));
    expect(merged.cursor).toBe("c-after-45");
  });

  it("a row on both appears once, at its place on the page", () => {
    const loaded = { items: [row(1), row(2), row(3), row(4)], cursor: "c-4" };
    // Row 3 was used again: it is newest now.
    const moved = { ...row(3), lastMessageAt: "2026-10-26 08:00:00+00" };
    const merged = mergeHistoryRefresh(loaded, {
      items: [moved, row(1)],
      nextCursor: "c-1",
    });
    expect(ids(merged.items)).toEqual(["id-003", "id-001", "id-002", "id-004"]);
    expect(merged.items[0]).toBe(moved);
  });

  it("★ drops a loaded row above the page's last row that the page no longer has", () => {
    const loaded = { items: [row(1), row(2), row(3), row(4)], cursor: "c-4" };
    // Row 2 was deleted (or expired) elsewhere.
    const merged = mergeHistoryRefresh(loaded, {
      items: [row(1), row(3)],
      nextCursor: "c-3",
    });
    expect(ids(merged.items)).toEqual(["id-001", "id-003", "id-004"]);
  });

  it("takes the page's cursor when nothing beyond page 1 was loaded", () => {
    const loaded = { items: [row(1), row(2)], cursor: "c-2" };
    const merged = mergeHistoryRefresh(loaded, {
      items: [row(0), row(1), row(2)],
      nextCursor: "c-new",
    });
    expect(ids(merged.items)).toEqual(["id-000", "id-001", "id-002"]);
    expect(merged.cursor).toBe("c-new");
  });

  it("falls back to the id when two rows share their time", () => {
    const at = "2026-10-26 07:00:00+00";
    const loaded = {
      items: [
        { id: "c", lastMessageAt: at },
        { id: "b", lastMessageAt: at },
        { id: "a", lastMessageAt: at },
      ],
      cursor: "c-a",
    };
    const merged = mergeHistoryRefresh(loaded, {
      items: [{ id: "c", lastMessageAt: at }],
      nextCursor: "c-c",
    });
    expect(ids(merged.items)).toEqual(["c", "b", "a"]);
  });
});
