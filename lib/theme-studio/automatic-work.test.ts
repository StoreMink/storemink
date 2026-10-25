import { beforeEach, describe, expect, it, vi } from "vitest";

const { service, notice, startAfterCommit, logError } = vi.hoisted(() => ({
  service: vi.fn(),
  notice: vi.fn<(notice: { projectId: string; kind: string }) => Promise<void>>(
    async () => {},
  ),
  startAfterCommit: vi.fn(() => {}),
  logError: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./notify", () => ({ sendThemeStudioNotice: notice }));
vi.mock("./capture-start", () => ({
  startCaptureJobAfterCommit: startAfterCommit,
}));
vi.mock("./repository", () => ({ recordThemeStudioEvent: vi.fn() }));
vi.mock("@/lib/observability/logger", async (original) => ({
  ...(await original<typeof import("@/lib/observability/logger")>()),
  logError,
}));

import {
  noteThemeStudioOperatorNotice,
  queueAutomaticCapture,
  withNoticeScope,
  withServiceAndNotices,
} from "./automatic-work";
import type { Db } from "@/lib/db/client";

/** A transaction that runs the work, then records that it committed. */
function transactions(order: string[]) {
  service.mockImplementation(async (work: (db: unknown) => unknown) => {
    const value = await work({});
    order.push("committed");
    return value;
  });
}

beforeEach(() => {
  notice.mockImplementation(async () => {});
});

describe("★ the operator's notice is sent after the settlement commits (decision 8)", () => {
  it("never from inside the transaction, each project and kind once", async () => {
    const order: string[] = [];
    transactions(order);
    notice.mockImplementation(async (n) => {
      order.push(`told ${n.kind}`);
    });
    expect(
      await withServiceAndNotices(async () => {
        noteThemeStudioOperatorNotice({ projectId: "p1", kind: "needs_fix" });
        noteThemeStudioOperatorNotice({ projectId: "p1", kind: "needs_fix" });
        noteThemeStudioOperatorNotice({ projectId: "p2", kind: "ready" });
        order.push("settled");
        return "value";
      }),
    ).toBe("value");
    expect(order).toEqual([
      "settled",
      "committed",
      "told needs_fix",
      "told ready",
    ]);
    expect(notice).toHaveBeenCalledTimes(2);
  });

  it("sends nothing for a transaction that rolled back", async () => {
    service.mockImplementation(async (work: (db: unknown) => unknown) => {
      await work({});
      throw new Error("commit failed");
    });
    await expect(
      withServiceAndNotices(async () => {
        noteThemeStudioOperatorNotice({ projectId: "p1", kind: "ready" });
      }),
    ).rejects.toThrow("commit failed");
    expect(notice).not.toHaveBeenCalled();
  });

  it("drops the notices of work rolled back to its savepoint, and keeps the rest", async () => {
    transactions([]);
    await withServiceAndNotices(async () => {
      await withNoticeScope(async () => {
        noteThemeStudioOperatorNotice({ projectId: "kept", kind: "ready" });
      });
      await withNoticeScope(async () => {
        noteThemeStudioOperatorNotice({
          projectId: "rolled-back",
          kind: "needs_fix",
        });
        throw new Error("the guard refused it");
      }).catch(() => {});
    });
    expect(notice.mock.calls).toEqual([[{ projectId: "kept", kind: "ready" }]]);
  });

  it("a notice that fails to send never fails the settlement", async () => {
    transactions([]);
    notice.mockRejectedValueOnce(new Error("mail down"));
    expect(
      await withServiceAndNotices(async () => {
        noteThemeStudioOperatorNotice({ projectId: "p1", kind: "ready" });
        noteThemeStudioOperatorNotice({ projectId: "p2", kind: "ready" });
        return 1;
      }),
    ).toBe(1);
    expect(notice).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(
      "theme studio: operator notice not sent",
      expect.any(Error),
      { projectId: "p1", kind: "ready" },
    );
  });

  it("a notice noted outside any settlement is logged, never sent half-way", async () => {
    noteThemeStudioOperatorNotice({ projectId: "p1", kind: "ready" });
    expect(notice).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "theme studio: operator notice noted outside a settlement",
      null,
      { projectId: "p1", kind: "ready" },
    );
  });
});

describe("★ an automatic capture starts the capture job once it is committed (optimisation 2)", () => {
  const run = {
    id: "run",
    projectId: "project",
    provider: "fake",
    modelKey: "gemini-3.8-flash",
    qaIteration: 0,
    createdBy: "operator",
  };
  const db = {
    insert: () => ({
      values: () => ({ returning: async () => [{ id: "capture-1" }] }),
    }),
  } as unknown as Db;

  it("schedules the start after the caller's commit", async () => {
    await queueAutomaticCapture(db, run, { id: "version" }, "d".repeat(64));
    expect(startAfterCommit).toHaveBeenCalledWith("capture-1");
  });

  it("starts nothing for the capture job's own finish: the running job claims it next", async () => {
    await queueAutomaticCapture(
      db,
      run,
      { id: "version" },
      "d".repeat(64),
      "final",
      { startJob: false },
    );
    expect(startAfterCommit).not.toHaveBeenCalled();
  });
});
