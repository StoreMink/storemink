/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { withService } from "@/lib/db/client";
import { authIdsInUse } from "./identity-usage";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authIdsInUse", () => {
  it("counts every role a login can hold: admin, customer, POS operator and platform operator", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        admins: [[{ id: "admin-uid" }]],
        users: [[{ id: "customer-uid" }]],
        pos_staff: [[{ id: null }, { id: "pos-uid" }]],
        platform_admins: [[{ email: " Op@StoreMink.com " }]],
      },
    });

    const inUse = await authIdsInUse(
      new Map<string, Set<string>>([
        ["admin-uid", new Set(["owner@example.com"])],
        ["customer-uid", new Set()],
        ["pos-uid", new Set(["staff@example.com"])],
        ["operator-uid", new Set(["op@storemink.com"])],
        ["orphan-uid", new Set(["gone@example.com"])],
      ]),
    );

    expect([...inUse].sort()).toEqual(
      ["admin-uid", "customer-uid", "operator-uid", "pos-uid"].sort(),
    );
    expect(inUse.has("orphan-uid")).toBe(false);
  });

  it("asks nothing for an empty candidate list, and skips the operator read without emails", async () => {
    dbHolder.current = makeDbMock();
    expect(await authIdsInUse(new Map())).toEqual(new Set());
    expect(withService).not.toHaveBeenCalled();

    dbHolder.current = makeDbMock();
    await authIdsInUse(new Map([["uid", new Set<string>()]]));
    // admins, users, pos_staff — and no platform_admins read.
    expect(dbHolder.current.calls.select).toHaveLength(3);
  });

  it("throws when the lookup fails, so callers treat unknown as in use", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
    await expect(
      authIdsInUse(new Map([["uid", new Set(["a@example.com"])]])),
    ).rejects.toThrow("db down");
  });
});
