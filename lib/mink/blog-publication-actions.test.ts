/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const holder = vi.hoisted(() => ({ db: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => fn(holder.db)),
}));

import {
  minkActionApprovals,
  minkActionToolAccess,
  minkDrafts,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { minkBlockedSentence } from "@/lib/moderation/copy";
import {
  executeMinkBlogPublication,
  previewMinkBlogPublication,
} from "./blog-publication-actions";
import type { MinkActorContext } from "./types";

const STORE = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const APPROVAL = "33333333-3333-4333-8333-333333333333";

function actor(overrides: Partial<MinkActorContext> = {}): MinkActorContext {
  return {
    storeId: STORE,
    adminId: "admin-1",
    email: "owner@example.com",
    roleSlug: "superadmin",
    permissions: {},
    isSuperadmin: true,
    effectivePlan: "pro",
    locationIds: null,
    analyticsTimeZone: "Asia/Kolkata",
    currency: "INR",
    defaultLowStockThreshold: 5,
    draftingEnabled: true,
    requestId: "req-1",
    ...overrides,
  };
}

const content = {
  title: "Winter oils for dry skin",
  excerpt: "Three oils we press for the cold months.",
  content: "Mustard, sesame and almond oil, pressed in small batches.",
  cover_image_url: "",
  seo_title: "",
  seo_description: "",
};

/**
 * A database that answers the publication's own reads: the draft, the tool
 * switch, the locks, and the blocked-post lookup (`blocked`, the rows the
 * takedown join returns). Every raw query is kept, compiled.
 */
function fakeDb(blocked: Array<{ title: string }>) {
  const dialect = new PgDialect();
  const executed: string[] = [];
  const params: unknown[][] = [];
  const inserted: Array<{ table: unknown; values: any }> = [];
  const selectRows = (table: unknown): any[] => {
    if (table === minkDrafts) {
      return [
        {
          id: DRAFT,
          kind: "blog",
          status: "draft",
          content,
          currentVersion: 2,
        },
      ];
    }
    if (table === minkActionToolAccess) return [{ enabled: true }];
    if (table === minkActionApprovals) {
      return [
        {
          id: APPROVAL,
          storeId: STORE,
          adminId: "admin-1",
          draftId: DRAFT,
          draftVersion: 2,
          toolName: "publish_blog",
          operation: "apply",
          status: "pending",
          resourceType: "blog",
          resourceId: null,
          productId: null,
          locationId: null,
          variantId: null,
          sourceApprovalId: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          beforeJson: {},
          afterJson: {},
          requestHash: "hash",
        },
      ];
    }
    return [];
  };
  const select = () => {
    let rows: any[] = [];
    const chain: any = {
      from: (table: unknown) => {
        rows = selectRows(table);
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      limit: async () => rows,
    };
    return chain;
  };
  return {
    executed,
    params,
    inserted,
    db: {
      execute: vi.fn(async (query: any) => {
        const compiled = dialect.sqlToQuery(query);
        executed.push(compiled.sql);
        params.push(compiled.params);
        if (compiled.sql.includes("content_blocks")) return { rows: blocked };
        if (compiled.sql.includes("mink_action_tool_access")) {
          return { rows: [{ enabled: true }] };
        }
        return { rows: [] };
      }),
      select: vi.fn(select),
      insert: vi.fn((table: unknown) => ({
        values: (values: any) => {
          inserted.push({ table, values });
          return {
            onConflictDoNothing: () => ({
              returning: async () => [
                {
                  ...values,
                  status: "pending",
                  approvedAt: null,
                  executedAt: null,
                  resultId: null,
                  resultVersion: null,
                },
              ],
            }),
          };
        },
      })),
      update: vi.fn(),
    },
  };
}

function preview() {
  return previewMinkBlogPublication({
    actor: actor(),
    draftId: DRAFT,
    expectedDraftVersion: 2,
    idempotencyKey: "key-1",
    mode: "publish_now",
  });
}

beforeEach(() => {
  holder.db = null;
});

describe("takedown: publish_blog and a post StoreMink blocked", () => {
  it("★★ refuses a post StoreMink blocked and told the store about, with the sentence the read tools carry", async () => {
    const fake = fakeDb([{ title: "Winter Oils For Dry Skin" }]);
    holder.db = fake.db;
    await expect(preview()).rejects.toMatchObject({
      code: "mink_blog_blocked",
      status: 409,
      message: minkBlockedSentence("Winter Oils For Dry Skin"),
    });
    // Refused before any approval is written.
    expect(fake.inserted).toHaveLength(0);
  });

  it("★★ asks only for a live, told block on a blocked post with this title or address, on the publication's own connection", async () => {
    const fake = fakeDb([]);
    holder.db = fake.db;
    await preview();
    const index = fake.executed.findIndex((text) =>
      text.includes("content_blocks"),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const text = fake.executed[index];
    expect(text).toContain("block.item_kind = 'blog_post'");
    expect(text).toContain("block.tell_store");
    expect(text).toContain("block.lifted_at is null");
    expect(text).toContain("block.erased_at is null");
    expect(text).toContain("blog.moderation_blocked_at is not null");
    expect(fake.params[index]).toEqual([
      STORE,
      "winter-oils-for-dry-skin",
      content.title,
    ]);
    // ★ No scope of its own: one service scope for the whole preview.
    expect(vi.mocked(withService)).toHaveBeenCalledTimes(1);
  });

  it("★ a post with no told block (none, or one kept from the store) proposes as before, saying nothing", async () => {
    const fake = fakeDb([]);
    holder.db = fake.db;
    const approval = await preview();
    expect(approval.toolName).toBe("publish_blog");
    expect(fake.inserted).toHaveLength(1);
    expect(fake.inserted[0].table).toBe(minkActionApprovals);
    expect(JSON.stringify(approval)).not.toMatch(/block/i);
  });

  it("★★ a block that lands after the preview stops the write too", async () => {
    const fake = fakeDb([{ title: "Winter oils for dry skin" }]);
    holder.db = fake.db;
    await expect(
      executeMinkBlogPublication({
        actor: actor(),
        draftId: DRAFT,
        approvalId: APPROVAL,
      }),
    ).rejects.toMatchObject({
      code: "mink_blog_blocked",
      message: minkBlockedSentence("Winter oils for dry skin"),
    });
    // No blog, publication or audit row is written.
    expect(fake.inserted).toHaveLength(0);
  });
});
