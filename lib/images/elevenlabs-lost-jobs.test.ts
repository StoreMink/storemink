/* eslint-disable @typescript-eslint/no-explicit-any */
// Finding the job of a submit whose answer was lost, in the provider's own
// list, by the time the job was made. The rule these tests hold: a job is
// taken only when nothing else could have made it; anything less is
// "unsure", and an unsure search takes nothing.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import {
  LOST_JOB_WALK_ROWS,
  decodeListCursor,
  findLostJob,
} from "./elevenlabs-lost-jobs";
import {
  SUBMIT_CLOCK_SLACK_MS,
  noGenerationStore,
  type GenerationStore,
  type LostSubmit,
} from "./elevenlabs-generations";

const T = Date.parse("2026-11-22T10:00:00.000Z");
const SUBMIT: LostSubmit = { id: "submit_1", sentAt: T, lostAt: T + 4_000 };

const cursorOf = (id: string, createdAt: number) =>
  Buffer.from(
    `${new Date(createdAt).toISOString().replace("Z", "000+00:00")}|${id}`,
  ).toString("base64");

/** The provider's list: newest first, one row a page, cursor = that row. */
function list(
  jobs: { id: string; createdAt: number }[],
  over: { cursorFor?: (job: { id: string; createdAt: number }) => string } = {},
) {
  const ordered = [...jobs].sort((a, b) => b.createdAt - a.createdAt);
  const reads: string[] = [];
  const fetchFn = vi.fn(async (url: any) => {
    const href = String(url);
    reads.push(href);
    const query = new URL(href).searchParams;
    expect(query.get("page_size")).toBe("1");
    const cursor = query.get("cursor");
    const from = cursor
      ? ordered.findIndex(
          (job) =>
            job.id ===
            Buffer.from(cursor, "base64").toString("utf8").split("|")[1],
        ) + 1
      : 0;
    const row = ordered[from];
    return new Response(
      JSON.stringify({
        generations: row ? [{ id: row.id, status: "completed" }] : [],
        next_cursor: row
          ? (over.cursorFor?.(row) ?? cursorOf(row.id, row.createdAt))
          : null,
        has_more: from + 1 < ordered.length,
      }),
      { status: 200 },
    );
  });
  return { fetchFn, reads };
}

function store(
  over: Partial<{ known: string[]; rivals: number; unreadable: boolean }> = {},
): GenerationStore {
  return {
    ...noGenerationStore,
    inspectWindow: async (_submit, ids) =>
      over.unreadable
        ? null
        : {
            known: new Set((over.known ?? []).filter((id) => ids.includes(id))),
            rivals: over.rivals ?? 0,
          },
  };
}

const search = (
  fetchFn: any,
  s: GenerationStore,
  signal = new AbortController().signal,
) =>
  findLostJob(SUBMIT, signal, {
    apiKey: "key",
    apiBase: "https://api.test",
    fetch: fetchFn,
    store: s,
    scope: "revamp:r1",
  });

describe("the list cursor", () => {
  it("★ is the page's last row: its creation time and its id (read from the real API on 22 Nov 2026)", () => {
    expect(
      decodeListCursor(
        "MjAyNi0xMS0yMVQyMToyNjo1OC4yNjEwMDArMDA6MDB8dmVtckRyTjFnYkRHMm9XVlJ6NTA=",
      ),
    ).toEqual({
      id: "vemrDrN1gbDG2oWVRz50",
      createdAt: Date.parse("2026-11-21T21:26:58.261Z"),
    });
  });

  it("a stamp with no zone is UTC, and padding may be missing (their documented example)", () => {
    expect(
      decodeListCursor(
        "MjAyNi0wNy0xN1QxMjowMDowMHxLeDJtUDdZNFdWcmc5a0UzTm5SYw",
      ),
    ).toEqual({
      id: "Kx2mP7Y4WVrg9kE3NnRc",
      createdAt: Date.parse("2026-07-17T12:00:00Z"),
    });
  });

  it.each([
    "",
    "not a cursor",
    Buffer.from("2026-11-21T21:26:58").toString("base64"),
    Buffer.from("|vemrDrN1gbDG2oWVRz50").toString("base64"),
    Buffer.from("yesterday|vemrDrN1gbDG2oWVRz50").toString("base64"),
    Buffer.from("2026-11-21T21:26:58|bad id!").toString("base64"),
  ])("anything else is not a time we can use: %s", (cursor) => {
    expect(decodeListCursor(cursor)).toBeNull();
  });
});

describe("★★ a lost submit's job", () => {
  it("is the ONE job made while the submit was out that the record does not hold", async () => {
    const l = list([
      { id: "newer_job", createdAt: T + 60_000 },
      { id: "the_job", createdAt: T + 1_200 },
      { id: "older_job", createdAt: T - 60_000 },
    ]);
    expect(await search(l.fetchFn, store({ known: ["newer_job"] }))).toEqual({
      kind: "found",
      generationId: "the_job",
    });
    // It stops reading at the first job older than the window.
    expect(l.reads).toHaveLength(3);
    expect(l.reads.every((href) => !href.includes("key"))).toBe(true);
  });

  it("★ the window is the time the submit was out, widened by the clock slack and no more", async () => {
    const at = async (createdAt: number) =>
      (await search(list([{ id: "a_job", createdAt }]).fetchFn, store())).kind;
    expect(await at(T - SUBMIT_CLOCK_SLACK_MS)).toBe("found");
    expect(await at(T - SUBMIT_CLOCK_SLACK_MS - 1)).toBe("none");
    expect(await at(SUBMIT.lostAt + SUBMIT_CLOCK_SLACK_MS)).toBe("found");
    expect(await at(SUBMIT.lostAt + SUBMIT_CLOCK_SLACK_MS + 1)).toBe("none");
  });

  it("★★ a job the record holds is someone's answered submit: with only that in the window, there is no job", async () => {
    const l = list([{ id: "held_job", createdAt: T + 1_000 }]);
    expect(await search(l.fetchFn, store({ known: ["held_job"] }))).toEqual({
      kind: "none",
    });
  });

  it("★★ another unanswered submit out at the same time: unsure, even with one job in the window", async () => {
    const l = list([{ id: "a_job", createdAt: T + 1_000 }]);
    expect(await search(l.fetchFn, store({ rivals: 1 }))).toEqual({
      kind: "unsure",
      why: "rival_submit",
    });
  });

  it("★★ two jobs nobody holds: unsure", async () => {
    const l = list([
      { id: "a_job", createdAt: T + 1_000 },
      { id: "b_job", createdAt: T + 2_000 },
    ]);
    expect(await search(l.fetchFn, store())).toEqual({
      kind: "unsure",
      why: "several_jobs",
    });
  });

  it("an empty list is a clear view of nothing", async () => {
    expect(await search(list([]).fetchFn, store())).toEqual({ kind: "none" });
  });
});

describe("★★ a search that cannot be sure takes nothing", () => {
  it("a cursor that names another row is not a time for this row", async () => {
    const l = list([{ id: "a_job", createdAt: T + 1_000 }], {
      cursorFor: () => cursorOf("some_other_job", T + 1_000),
    });
    expect(await search(l.fetchFn, store())).toEqual({
      kind: "unsure",
      why: "list_unreadable",
    });
  });

  it("a cursor that does not parse", async () => {
    const l = list([{ id: "a_job", createdAt: T + 1_000 }], {
      cursorFor: () => "opaque-new-format",
    });
    expect((await search(l.fetchFn, store())).kind).toBe("unsure");
  });

  it.each([
    ["a 500", async () => new Response("{}", { status: 500 })],
    ["a 429", async () => new Response("{}", { status: 429 })],
    ["not JSON", async () => new Response("<html>", { status: 200 })],
    ["no rows field", async () => new Response("{}", { status: 200 })],
    [
      "a dropped connection",
      async () => {
        throw new Error("network");
      },
    ],
  ])("the list answers %s", async (_name, answer) => {
    expect(await search(vi.fn(answer), store())).toEqual({
      kind: "unsure",
      why: "list_unreadable",
    });
  });

  it("more jobs since the submit left than one search reads", async () => {
    const jobs = Array.from({ length: LOST_JOB_WALK_ROWS + 5 }, (_, n) => ({
      id: `job_${String(n).padStart(3, "0")}`,
      createdAt: T + 10_000 + n,
    }));
    const l = list(jobs);
    expect(await search(l.fetchFn, store())).toEqual({
      kind: "unsure",
      why: "list_too_long",
    });
    expect(l.reads).toHaveLength(LOST_JOB_WALK_ROWS);
  });

  it("a record that cannot be read", async () => {
    const l = list([{ id: "a_job", createdAt: T + 1_000 }]);
    expect(await search(l.fetchFn, store({ unreadable: true }))).toEqual({
      kind: "unsure",
      why: "record_unreadable",
    });
  });

  it("a caller that has stopped reads nothing", async () => {
    const l = list([{ id: "a_job", createdAt: T + 1_000 }]);
    const stop = new AbortController();
    stop.abort();
    expect((await search(l.fetchFn, store(), stop.signal)).kind).toBe("unsure");
    expect(l.reads).toEqual([]);
  });
});
