/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues, sqlText } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerAccess: vi.fn(async () => ({ can: () => true })),
  getActingStoreId: vi.fn(async () => "s1"),
}));

import { getWhatsAppLogs } from "./whatsapp-log-actions";
import { getViewerAccess } from "@/app/dashboard/lib/access";

beforeEach(() => {
  dbHolder.current = makeDbMock({});
});

describe("getWhatsAppLogs", () => {
  it("★ escapes the backslash as well as % and _, so typed wildcards match only themselves", async () => {
    await getWhatsAppLogs({ q: "50%_off\\x" });
    const rowsQuery = dbHolder.current.calls.execute[0];
    expect(sqlText(rowsQuery)).toContain("ilike");
    // `\` first, or the backslash added before `%` would itself be escaped.
    expect(sqlParamValues(rowsQuery)).toContain("%50\\%\\_off\\\\x%");
    // The chips' counts read the same filter.
    expect(sqlParamValues(dbHolder.current.calls.execute[1])).toContain(
      "%50\\%\\_off\\\\x%",
    );
  });

  it("an empty search adds no LIKE at all, and the log is store-scoped", async () => {
    await getWhatsAppLogs({ q: "   " });
    const rowsQuery = dbHolder.current.calls.execute[0];
    expect(sqlText(rowsQuery)).not.toContain("ilike");
    expect(sqlParamValues(rowsQuery)).toContain("s1");
  });

  it("someone without the logs permission reads nothing", async () => {
    vi.mocked(getViewerAccess).mockResolvedValueOnce({
      can: () => false,
    } as any);
    const r = await getWhatsAppLogs({ q: "x" });
    expect(r.error).toMatch(/access to logs/);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });
});
