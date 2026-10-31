import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({
  current: null as ReturnType<
    typeof import("@/app/actions/_test-helpers").makeDbMock
  > | null,
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) =>
    fn(dbHolder.current!.db),
  ),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { getLivePolicies } from "./store-consent";
import { logError } from "@/lib/observability/logger";

const STORE = "a0000000-0000-4000-8000-000000000001";

function page(slug: string, blockedAt: string | null) {
  return {
    slug,
    status: "published",
    publishedSections: [
      {
        id: "policy-body",
        type: "rich_text",
        config: { html: `<p>The ${slug} text.</p>` },
      },
    ],
    moderationBlockedAt: blockedAt,
  };
}

describe("getLivePolicies: a policy page StoreMink has blocked", () => {
  beforeEach(() => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        store_pages: [
          [
            page("terms", null),
            page("refund-policy", "2026-10-14 06:00:00+00"),
          ],
        ],
      },
    });
  });

  it("★★ is treated as unpublished: never named, never agreed to", async () => {
    const live = await getLivePolicies(STORE);
    expect(live.map((p) => p.slug)).toEqual(["terms"]);
    // The flag is SELECTED from the row: a service-scope read never sees the
    // read policy that hides it.
    expect(
      dbHolder.current!.calls.select.some(
        (p: Record<string, unknown> | undefined) =>
          !!p && "moderationBlockedAt" in p,
      ),
    ).toBe(true);
  });

  it("still answers none on a read error, as before", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { store_pages: [new Error("read failed")] },
    });
    await expect(getLivePolicies(STORE)).resolves.toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "legal: live policy read failed",
      expect.any(Error),
      { storeId: STORE },
    );
  });
});
