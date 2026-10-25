/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";
import {
  notifications,
  notificationEmailQueue,
  themeStudioProjects,
} from "@/drizzle/schema";

// The REAL recorder runs underneath (record.ts), on its own mocked service
// transaction, so these tests prove who is actually told, not only what
// notify() asked for.
const recorderDb = vi.hoisted(() => ({ current: null as any }));
const logs = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(recorderDb.current.db))),
}));
vi.mock("next/server", () => ({ after: vi.fn((fn: any) => fn()) }));
vi.mock("@/lib/email/trigger-worker", () => ({
  triggerEmailWorker: vi.fn(async () => {}),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: logs.error,
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import {
  notifyThemeStudioOperator,
  sendThemeStudioNotice,
  THEME_STUDIO_NOTICE_EVENTS,
} from "./notify";

const PROJECT = "0f9b5c1e-4a7d-4c2b-9e1f-3a2b1c0d9e8f";
const OPERATORS = [
  { email: "Starter@StoreMink.com" },
  { email: "second@storemink.com" },
  { email: "third@storemink.com" },
];

function rows(mock: any, table: unknown) {
  const idx = mock.calls.insert.findIndex((t: any) => t === table);
  if (idx === -1) return [];
  const value = mock.calls.values[idx];
  return Array.isArray(value) ? value : [value];
}

/** The caller's transaction (it reads the project) and the recorder's own. */
function setup(project: Record<string, unknown> | null) {
  const caller = makeDbMock({
    selectQueue: [project ? [project] : []],
  });
  recorderDb.current = makeDbMock({
    returning: [{ id: "event-1" }],
    // A platform event: definitions, platform_admins, preferences.
    selectQueue: [[], OPERATORS, []],
  });
  return { caller, recorder: recorderDb.current };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notifyThemeStudioOperator", () => {
  it("tells only the operator who started the theme: nobody else is told", async () => {
    const { caller, recorder } = setup({
      name: "Monsoon Market",
      createdByEmail: "Starter@StoreMink.com",
      status: "candidate",
    });
    await notifyThemeStudioOperator(caller.db, {
      projectId: PROJECT,
      kind: "ready",
    });
    // It read the project through the caller's handle...
    expect(caller.calls.select).toHaveLength(1);
    expect(caller.calls.insert).toHaveLength(0);
    // ...and the recorder told exactly one of the three operators.
    const bell = rows(recorder, notifications);
    expect(bell.map((r: any) => r.recipientId)).toEqual([
      "starter@storemink.com",
    ]);
    expect(bell[0]).toMatchObject({
      recipientType: "operator",
      storeId: null,
      type: "platform.theme_studio_ready",
      title: "Ready to publish · Monsoon Market",
      url: `/dashboard/themes/studio/${PROJECT}`,
      severity: "success",
    });
    const mail = rows(recorder, notificationEmailQueue);
    expect(mail.map((r: any) => r.email)).toEqual(["starter@storemink.com"]);
    expect(mail[0]).toMatchObject({
      eventKey: "platform.theme_studio_ready",
      digest: "instant",
    });
  });

  it.each([
    ["ready", "platform.theme_studio_ready", "Ready to publish · Crave"],
    ["needs_fix", "platform.theme_studio_needs_fix", "Needs a fix · Crave"],
    ["questions", "platform.theme_studio_questions", "Questions about Crave"],
  ] as const)("sends %s as %s", async (kind, type, title) => {
    const { caller, recorder } = setup({
      name: "Crave",
      createdByEmail: "starter@storemink.com",
      status: "generating",
    });
    await notifyThemeStudioOperator(caller.db, { projectId: PROJECT, kind });
    expect(THEME_STUDIO_NOTICE_EVENTS[kind]).toBe(type);
    expect(rows(recorder, notifications)).toEqual([
      expect.objectContaining({ type, title }),
    ]);
  });

  it("tells nobody about a theme removed from the list", async () => {
    const { caller, recorder } = setup({
      name: "Crave",
      createdByEmail: "starter@storemink.com",
      status: "archived",
    });
    await notifyThemeStudioOperator(caller.db, {
      projectId: PROJECT,
      kind: "needs_fix",
    });
    expect(recorder.calls.insert).toHaveLength(0);
  });

  it("tells nobody when the project is gone or has no starting operator", async () => {
    let { caller, recorder } = setup(null);
    await notifyThemeStudioOperator(caller.db, {
      projectId: PROJECT,
      kind: "ready",
    });
    expect(recorder.calls.insert).toHaveLength(0);
    ({ caller, recorder } = setup({
      name: "Crave",
      createdByEmail: "  ",
      status: "candidate",
    }));
    await notifyThemeStudioOperator(caller.db, {
      projectId: PROJECT,
      kind: "ready",
    });
    expect(recorder.calls.insert).toHaveLength(0);
  });

  it("never throws into the work it reports on, and logs no content", async () => {
    const caller = makeDbMock({
      selectQueue: [new Error("statement timeout")],
    });
    await expect(
      notifyThemeStudioOperator(caller.db, {
        projectId: PROJECT,
        kind: "questions",
      }),
    ).resolves.toBeUndefined();
    expect(logs.error).toHaveBeenCalledWith(
      "theme_studio.operator_notice_failed",
      expect.any(Error),
      { projectId: PROJECT, kind: "questions" },
    );
  });

  it("reads the project by its id", async () => {
    const { caller } = setup({
      name: "Crave",
      createdByEmail: "starter@storemink.com",
      status: "ready",
    });
    await notifyThemeStudioOperator(caller.db, {
      projectId: PROJECT,
      kind: "needs_fix",
    });
    expect(caller.calls.select).toHaveLength(1);
    const where = new PgDialect().sqlToQuery(caller.calls.where[0]);
    expect(where.sql).toBe(`"theme_studio_projects"."id" = $1`);
    expect(where.params).toEqual([PROJECT]);
    expect(themeStudioProjects).toBeDefined();
  });
});

describe("sendThemeStudioNotice (a caller with no transaction open)", () => {
  it("reads the project in one transaction and records in the next, never nested", async () => {
    const reader = makeDbMock({
      selectQueue: [
        [
          {
            name: "Monsoon Market",
            createdByEmail: "starter@storemink.com",
            status: "blocked",
          },
        ],
      ],
    });
    const recorder = makeDbMock({
      returning: [{ id: "event-1" }],
      selectQueue: [[], OPERATORS, []],
    });
    const open: string[] = [];
    let depth = 0;
    let deepest = 0;
    const handles = [reader, recorder];
    vi.mocked(withService).mockImplementation(async (fn: any) => {
      const handle = handles.shift()!;
      open.push(handle === reader ? "read" : "record");
      depth += 1;
      deepest = Math.max(deepest, depth);
      try {
        return await fn(handle.db);
      } finally {
        depth -= 1;
      }
    });
    await sendThemeStudioNotice({ projectId: PROJECT, kind: "questions" });
    expect(open).toEqual(["read", "record"]);
    // A harness that runs one transaction at a time would wait forever on
    // a nested one; the worker's notice never opens one inside another.
    expect(deepest).toBe(1);
    expect(
      rows(recorder, notifications).map((r: any) => r.recipientId),
    ).toEqual(["starter@storemink.com"]);
    expect(rows(recorder, notifications)[0]).toMatchObject({
      type: "platform.theme_studio_questions",
      title: "Questions about Monsoon Market",
    });
  });

  it("never throws when the read fails", async () => {
    vi.mocked(withService).mockImplementation(async () => {
      throw new Error("pool timeout");
    });
    await expect(
      sendThemeStudioNotice({ projectId: PROJECT, kind: "needs_fix" }),
    ).resolves.toBeUndefined();
    expect(logs.error).toHaveBeenCalledWith(
      "theme_studio.operator_notice_failed",
      expect.any(Error),
      { projectId: PROJECT, kind: "needs_fix" },
    );
  });
});
