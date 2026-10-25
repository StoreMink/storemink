import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const withService = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/client", () => ({ withService }));

import { stopThemeStudioChecks, THEME_STUDIO_STOP_CODE } from "./stop";
import {
  themeStudioAcceptanceRuns,
  themeStudioCaptures,
  themeStudioEvents,
  themeStudioProjects,
  themeStudioRuns,
  themeStudioVersions,
  themeStudioVisualQaRuns,
} from "@/drizzle/schema";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "op@test.dev",
};
const projectId = "22222222-2222-4222-8222-222222222222";
const visible = "33333333-3333-4333-8333-333333333333";
const hidden = "44444444-4444-4444-8444-444444444444";

interface Work {
  captures?: Record<string, unknown>[];
  reviews?: Record<string, unknown>[];
  runs?: Record<string, unknown>[];
  browserChecks?: Record<string, unknown>[];
}

/** Reads in Stop's order: the project, its captures, reviews, runs and open
 * browser checks, then one read per working version (is it visible now?). */
function stopDb({
  status = "generating",
  revision = 7,
  currentVersionId = null as string | null,
  work = {} as Work,
  visibleAfter = [] as string[],
  lockFails = false,
  /** Rows for the reads after the active work, in order. */
  after = [] as unknown[][],
}) {
  const reads: unknown[] = [
    [{ id: projectId, status, revision, currentVersionId }],
    work.captures ?? [],
    work.reviews ?? [],
    work.runs ?? [],
    work.browserChecks ?? [],
    ...after,
  ];
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const versionFilters: string[] = [];
  const locks: unknown[] = [];
  let versionReads = 0;
  const db = {
    select: () => {
      const result = reads.shift();
      const query = {
        from: (table: unknown) => {
          if (table === themeStudioVersions && result === undefined) {
            versionReads += 1;
          }
          return query;
        },
        where: () => query,
        orderBy: () => query,
        for: (_mode: string, options?: unknown) => {
          locks.push(options);
          if (lockFails && locks.length === 3) {
            const error = Object.assign(new Error("could not obtain lock"), {
              code: "55P03",
            });
            return {
              then: (_: unknown, reject: (reason: unknown) => unknown) =>
                Promise.reject(error).catch(reject),
            };
          }
          return query;
        },
        limit: () => query,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(
            result === undefined
              ? visibleAfter.length >= versionReads
                ? [{ id: visibleAfter[versionReads - 1] }].filter((r) => r.id)
                : []
              : result,
          ).then(resolve),
      };
      return query;
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return {
          where: async (cond: SQL) => {
            if (table === themeStudioVersions) {
              versionFilters.push(new PgDialect().sqlToQuery(cond).sql);
            }
            return [];
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        writes.push({ table, values });
      },
    }),
  };
  withService.mockImplementation(async (work) => work(db));
  return { writes, versionFilters, locks };
}

const projectWrite = (writes: { table: unknown; values: object }[]) =>
  writes.filter((w) => w.table === themeStudioProjects).at(-1)?.values;
const events = (writes: { table: unknown; values: object }[]) =>
  writes
    .filter((w) => w.table === themeStudioEvents)
    .map((w) => w.values as Record<string, unknown>);

describe("stopThemeStudioChecks", () => {
  it("★ ends a capture nobody took, reveals the version it held and gives the theme back", async () => {
    const { writes, versionFilters, locks } = stopDb({
      work: {
        captures: [{ id: "capture-1", versionId: hidden, automatic: true }],
      },
      visibleAfter: [hidden],
    });
    expect(
      await stopThemeStudioChecks(actor, { projectId, expectedRevision: 7 }),
    ).toEqual({
      status: "ready",
      stopped: { captures: 1, reviews: 0, runs: 0, browserChecks: 0 },
      cancelling: false,
    });
    expect(
      writes.find((w) => w.table === themeStudioCaptures)?.values,
    ).toMatchObject({
      status: "failed",
      errorCode: THEME_STUDIO_STOP_CODE,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    // Only the move the 0144 guard allows: hidden and pending to failed.
    expect(writes.find((w) => w.table === themeStudioVersions)?.values).toEqual(
      { visibility: "operator", qaStatus: "failed" },
    );
    expect(versionFilters[0]).toMatch(
      /"visibility" = \$\d+ and "theme_studio_versions"\."qa_status" = \$\d+/,
    );
    expect(projectWrite(writes)).toEqual({
      status: "ready",
      currentVersionId: hidden,
      revision: 8,
    });
    expect(events(writes)).toEqual([
      expect.objectContaining({
        eventType: "capture_failed",
        actorKind: "operator",
        actorEmail: actor.email,
        detail: { captureId: "capture-1", errorCode: "cancelled" },
      }),
    ]);
    // Every row that holds the theme is taken with NOWAIT, never waited on.
    expect(locks.slice(1)).toEqual([
      { noWait: true },
      { noWait: true },
      { noWait: true },
      { noWait: true },
    ]);
  });

  it("★ ends a design review of a version already shown without writing that version", async () => {
    const { writes } = stopDb({
      currentVersionId: visible,
      work: { reviews: [{ id: "qa-1", versionId: visible }] },
      visibleAfter: [visible],
    });
    const result = await stopThemeStudioChecks(actor, {
      projectId,
      expectedRevision: 7,
    });
    expect(result.status).toBe("ready");
    expect(
      writes.find((w) => w.table === themeStudioVisualQaRuns)?.values,
    ).toMatchObject({
      status: "failed",
      errorCode: "cancelled",
      leaseOwner: null,
    });
    expect(projectWrite(writes)).toEqual({
      status: "ready",
      currentVersionId: visible,
      revision: 8,
    });
    expect(events(writes)[0]).toMatchObject({
      eventType: "auto_qa_failed",
      detail: { qaRunId: "qa-1", versionId: visible, errorCode: "cancelled" },
    });
  });

  it.each([
    [visible, "ready"],
    [null, "failed"],
  ])(
    "cancels a queued run at once; with current version %s the theme is %s",
    async (currentVersionId, status) => {
      const { writes } = stopDb({
        currentVersionId,
        work: {
          runs: [
            {
              id: "run-1",
              status: "queued",
              automatic: false,
              baseVersionId: currentVersionId,
              cancelRequestedAt: null,
              lapsed: false,
            },
          ],
        },
      });
      const result = await stopThemeStudioChecks(actor, {
        projectId,
        expectedRevision: 7,
      });
      expect(result).toMatchObject({ status, cancelling: false });
      expect(
        writes.find((w) => w.table === themeStudioRuns)?.values,
      ).toMatchObject({
        status: "cancelled",
        leaseOwner: null,
        retryNotBefore: null,
      });
      // A run the operator queued reveals nothing.
      expect(writes.some((w) => w.table === themeStudioVersions)).toBe(false);
      expect(projectWrite(writes)).toEqual({
        status,
        currentVersionId,
        revision: 8,
      });
      expect(events(writes)[0]).toMatchObject({
        eventType: "run_cancelled",
        runId: "run-1",
      });
    },
  );

  it("cancels a run whose worker is gone, revealing the hidden version it was drawing for", async () => {
    const { writes } = stopDb({
      work: {
        runs: [
          {
            id: "run-2",
            status: "running",
            automatic: true,
            baseVersionId: hidden,
            cancelRequestedAt: null,
            lapsed: true,
          },
        ],
      },
      visibleAfter: [hidden],
    });
    expect(
      await stopThemeStudioChecks(actor, { projectId, expectedRevision: 7 }),
    ).toMatchObject({ status: "ready", cancelling: false });
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({ status: "cancelled", leaseOwner: null });
    expect(projectWrite(writes)).toMatchObject({
      status: "ready",
      currentVersionId: hidden,
    });
  });

  it("★ asks a live worker to cancel and leaves the theme to its settle", async () => {
    const { writes } = stopDb({
      currentVersionId: visible,
      work: {
        runs: [
          {
            id: "run-3",
            status: "running",
            automatic: true,
            baseVersionId: hidden,
            cancelRequestedAt: null,
            lapsed: false,
          },
        ],
      },
    });
    expect(
      await stopThemeStudioChecks(actor, { projectId, expectedRevision: 7 }),
    ).toEqual({
      status: "generating",
      stopped: { captures: 0, reviews: 0, runs: 1, browserChecks: 0 },
      cancelling: true,
    });
    const run = writes.find((w) => w.table === themeStudioRuns)!.values;
    expect(run).toHaveProperty("cancelRequestedAt");
    expect(run).not.toHaveProperty("status");
    expect(run).not.toHaveProperty("leaseOwner");
    expect(writes.some((w) => w.table === themeStudioVersions)).toBe(false);
    expect(projectWrite(writes)).toEqual({
      status: "generating",
      currentVersionId: visible,
      revision: 8,
    });
    expect(events(writes)[0]).toMatchObject({
      eventType: "run_cancel_requested",
    });
  });

  it("does not ask twice for a cancel already asked", async () => {
    const { writes } = stopDb({
      work: {
        runs: [
          {
            id: "run-4",
            status: "running",
            automatic: false,
            baseVersionId: null,
            cancelRequestedAt: "2026-10-24 10:00:00+00",
            lapsed: false,
          },
        ],
      },
    });
    await stopThemeStudioChecks(actor, { projectId, expectedRevision: 7 });
    expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
    expect(events(writes)).toEqual([]);
  });

  it("★ retires an in-browser check left open, so Delete is not refused", async () => {
    const { writes } = stopDb({
      status: "ready",
      currentVersionId: visible,
      work: {
        browserChecks: [
          { id: "acc-1", status: "awaiting_browser" },
          { id: "acc-2", status: "running" },
        ],
      },
    });
    expect(
      await stopThemeStudioChecks(actor, { projectId, expectedRevision: 7 }),
    ).toMatchObject({
      status: "ready",
      stopped: { browserChecks: 2 },
    });
    const retired = writes
      .filter((w) => w.table === themeStudioAcceptanceRuns)
      .map((w) => w.values);
    expect(retired[0]).toMatchObject({
      status: "expired",
      browserNonceHash: null,
      browserExpiresAt: null,
    });
    expect(retired[1]).toMatchObject({ status: "error" });
    // A theme that was not generating keeps its status.
    expect(projectWrite(writes)).toEqual({
      status: "ready",
      currentVersionId: visible,
      revision: 8,
    });
  });

  it("gives back a theme stuck generating with nothing left holding it", async () => {
    const { writes } = stopDb({ currentVersionId: visible });
    expect(
      await stopThemeStudioChecks(actor, { projectId, expectedRevision: 7 }),
    ).toMatchObject({ status: "ready" });
    expect(projectWrite(writes)).toEqual({
      status: "ready",
      currentVersionId: visible,
      revision: 8,
    });
  });

  it("★ shows the newest hidden version of a theme left generating with nothing holding it", async () => {
    // A first build whose design review the queue closed on its own: the
    // theme still says generating and its only version is hidden.
    const { writes, versionFilters } = stopDb({
      currentVersionId: null,
      visibleAfter: [hidden, hidden],
    });
    expect(
      await stopThemeStudioChecks(actor, { projectId, expectedRevision: 7 }),
    ).toEqual({
      status: "ready",
      stopped: { captures: 0, reviews: 0, runs: 0, browserChecks: 0 },
      cancelling: false,
    });
    expect(projectWrite(writes)).toEqual({
      status: "ready",
      currentVersionId: hidden,
      revision: 8,
    });
    // Revealed as a failed check, the only move the 0144 guard allows.
    expect(writes.find((w) => w.table === themeStudioVersions)?.values).toEqual(
      { visibility: "operator", qaStatus: "failed" },
    );
    expect(versionFilters[0]).toContain('"visibility" = $');
    expect(events(writes)).toEqual([
      expect.objectContaining({
        eventType: "auto_qa_failed",
        detail: { versionId: hidden, errorCode: THEME_STUDIO_STOP_CODE },
      }),
    ]);
  });

  it("says a page check still in its server stage ends by itself", async () => {
    const { writes } = stopDb({
      status: "ready",
      currentVersionId: visible,
      after: [[{ id: "acceptance-1" }]],
    });
    await expect(
      stopThemeStudioChecks(actor, { projectId, expectedRevision: 7 }),
    ).rejects.toMatchObject({
      code: "illegal_state",
      message:
        "A check of the pages is still running. It finishes by itself, or Stop can end it once it is 15 minutes old.",
    });
    expect(writes).toEqual([]);
  });

  it("refuses a stale tab without writing", async () => {
    const { writes } = stopDb({
      work: { captures: [{ id: "c", versionId: hidden, automatic: true }] },
    });
    await expect(
      stopThemeStudioChecks(actor, { projectId, expectedRevision: 6 }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(writes).toEqual([]);
  });

  it("says when nothing is running", async () => {
    const { writes } = stopDb({ status: "ready", currentVersionId: visible });
    await expect(
      stopThemeStudioChecks(actor, { projectId, expectedRevision: 7 }),
    ).rejects.toMatchObject({
      code: "illegal_state",
      message: "Nothing is running on this theme. Reload to see where it is.",
    });
    expect(writes).toEqual([]);
  });

  it("★ asks to try again when a worker is saving the same step, instead of waiting on it", async () => {
    stopDb({ lockFails: true });
    await expect(
      stopThemeStudioChecks(actor, { projectId, expectedRevision: 7 }),
    ).rejects.toMatchObject({
      code: "stale",
      message:
        "This theme is saving a step right now. Try Stop again in a few seconds.",
    });
  });

  it.each([
    { projectId: "not-a-uuid", expectedRevision: 1 },
    { projectId, expectedRevision: -1 },
    { projectId, expectedRevision: 1.5 },
  ])("refuses a malformed request %j before the database", async (bad) => {
    await expect(stopThemeStudioChecks(actor, bad)).rejects.toThrow();
    expect(withService).not.toHaveBeenCalled();
  });

  it("never says a dash in a sentence an operator reads", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./stop.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/[\u2013\u2014]/);
  });
});
