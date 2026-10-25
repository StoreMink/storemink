import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const inserted: Array<Record<string, unknown>> = [];
  // What an earlier call left in the table, for the fixed-id repeat path.
  const existing: { rows: Array<Record<string, unknown>> } = { rows: [] };
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        onConflictDoNothing: vi.fn(() => ({
          // ★ ON CONFLICT DO NOTHING: a row whose id is already there is not
          //   written, and RETURNING gives nothing back.
          returning: vi.fn(async () => {
            const clash =
              existing.rows.some((r) => r.id === row.id) ||
              inserted.some((r) => r.id === row.id);
            if (clash) return [];
            inserted.push(row);
            return [{ id: row.id }];
          }),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => existing.rows),
        })),
      })),
    })),
    execute: vi.fn(async () => ({ rows: [{ source: "plan" }] })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
  };
  return {
    inserted,
    existing,
    db,
    withService: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    getMinkCreditCycle: vi.fn(async () => ({ period: "2026-10" })),
    getPlanAllowancesLive: vi.fn(async () => ({})),
  };
});

vi.mock("@/lib/db/client", () => ({ withService: mocks.withService }));
vi.mock("@/lib/ai/quota", () => ({
  getMinkCreditCycle: mocks.getMinkCreditCycle,
}));
vi.mock("@/lib/plans/allowances", () => ({
  getPlanAllowancesLive: mocks.getPlanAllowancesLive,
}));
vi.mock("@/lib/plans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plans")>()),
  aiAllowanceFor: vi.fn(() => 100),
}));
vi.mock("@/lib/mink/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mink/config")>()),
  getMinkConfig: vi.fn(() => ({ chargeCredits: true })),
}));
// The latest-action readers drafts.ts re-exports reach far into the app; a
// proposal never calls them.
vi.mock("./domain-actions", () => ({ getLatestMinkDomainAction: vi.fn() }));
vi.mock("./inventory-actions", () => ({
  getLatestMinkInventoryAction: vi.fn(),
}));
vi.mock("./bulk-inventory-actions", () => ({
  getLatestMinkBulkInventoryAction: vi.fn(),
}));
vi.mock("./bulk-price-actions", () => ({
  getLatestMinkBulkPriceAction: vi.fn(),
}));
vi.mock("./order-status-actions", () => ({
  getLatestMinkOrderStatusAction: vi.fn(),
}));
vi.mock("./blog-publication-actions", () => ({
  getLatestMinkBlogPublication: vi.fn(),
}));
vi.mock("./campaign-actions", () => ({ getLatestMinkCampaign: vi.fn() }));
vi.mock("./product-actions", () => ({ getLatestMinkProductAction: vi.fn() }));

import { createMinkDraftProposal } from "./drafts";
import type { MinkActorContext } from "./types";

const actor = {
  storeId: "33333333-3333-4333-8333-333333333333",
  adminId: "admin-uid",
  runId: "44444444-4444-4444-8444-444444444444",
  draftingEnabled: true,
  permissions: { builder: ["view", "manage"] },
  isSuperadmin: false,
  effectivePlan: "pro",
} as unknown as MinkActorContext;

const personalization = (extra: Record<string, unknown> = {}) => ({
  actor,
  kind: "storefront_personalization" as const,
  title: "Your redesigned storefront",
  destinationType: "storefront",
  destinationId: actor.storeId,
  destinationLabel: "Whole storefront",
  destinationPath: "/dashboard/builder",
  content: {
    plan_json: '{"schemaVersion":2}',
    plan_digest: "a".repeat(64),
    explanation: "A calmer, warmer shop.",
  },
  ...extra,
});

beforeEach(() => {
  mocks.inserted.length = 0;
  mocks.existing.rows = [];
});

describe("createMinkDraftProposal: free storefront personalisation", () => {
  it("writes a settled free draft and never charges", async () => {
    const artifact = await createMinkDraftProposal(
      personalization({ free: true }),
    );
    expect(mocks.inserted).toHaveLength(1);
    expect(mocks.inserted[0]).toMatchObject({
      kind: "storefront_personalization",
      expectedCredits: 0,
      chargedCredits: 0,
      creditSource: "free",
    });
    expect(mocks.db.execute).not.toHaveBeenCalled();
    expect(mocks.db.update).not.toHaveBeenCalled();
    expect(mocks.getMinkCreditCycle).not.toHaveBeenCalled();
    expect(artifact).toMatchObject({
      type: "proposal",
      draftKind: "storefront_personalization",
      expectedCredits: 0,
      chargedCredits: 0,
      creditSource: "free",
      status: "proposed",
    });
  });

  it("refuses a free draft of any other kind", async () => {
    await expect(
      createMinkDraftProposal({
        ...personalization({ free: true }),
        kind: "blog",
      }),
    ).rejects.toThrow(/storefront personalisation/);
    expect(mocks.withService).not.toHaveBeenCalled();
  });

  it("refuses a free draft that also names a price", async () => {
    await expect(
      createMinkDraftProposal(
        personalization({ free: true, expectedCredits: 40 }),
      ),
    ).rejects.toThrow(/cannot also carry a price/);
    expect(mocks.inserted).toHaveLength(0);
  });

  it("still charges a paid personalisation through the charge function", async () => {
    const artifact = await createMinkDraftProposal(
      personalization({ expectedCredits: 40 }),
    );
    expect(mocks.inserted[0]).toMatchObject({ expectedCredits: 40 });
    expect(mocks.inserted[0]).not.toHaveProperty("creditSource");
    expect(mocks.db.execute).toHaveBeenCalledTimes(1);
    expect(artifact).toMatchObject({
      expectedCredits: 40,
      chargedCredits: 40,
      creditSource: "plan",
    });
  });

  it("never accepts 'free' back from the charge function for a paid draft", async () => {
    mocks.db.execute.mockResolvedValueOnce({ rows: [{ source: "free" }] });
    await expect(
      createMinkDraftProposal(personalization({ expectedCredits: 40 })),
    ).rejects.toThrow(/valid source/);
  });
});

describe("createMinkDraftProposal: a fixed draft id", () => {
  const FIXED = "55555555-5555-4555-8555-555555555555";

  it("uses the fixed id as the draft's own id", async () => {
    const artifact = await createMinkDraftProposal(
      personalization({ expectedCredits: 40, draftId: FIXED }),
    );
    expect(mocks.inserted[0]).toMatchObject({ id: FIXED });
    expect(artifact).toMatchObject({ draftId: FIXED });
  });

  it("returns the first draft on a repeat and charges nothing again", async () => {
    const first = await createMinkDraftProposal(
      personalization({ expectedCredits: 40, draftId: FIXED }),
    );
    expect(mocks.db.execute).toHaveBeenCalledTimes(1);
    // The first call's row as the database now holds it, settled.
    mocks.existing.rows = [
      {
        id: FIXED,
        storeId: actor.storeId,
        adminId: actor.adminId,
        kind: "storefront_personalization",
        chargedCredits: 40,
        creditSource: "plan",
      },
    ];
    mocks.inserted.length = 0;
    const repeat = await createMinkDraftProposal(
      personalization({ expectedCredits: 40, draftId: FIXED }),
    );
    expect(mocks.inserted).toHaveLength(0);
    expect(mocks.db.execute).toHaveBeenCalledTimes(1);
    expect(mocks.db.update).toHaveBeenCalledTimes(1);
    expect(repeat).toMatchObject({
      draftId: FIXED,
      chargedCredits: 40,
      creditSource: "plan",
    });
    expect(repeat).toEqual(first);
  });

  it("returns a free draft on a repeat as it was written", async () => {
    mocks.existing.rows = [
      {
        id: FIXED,
        storeId: actor.storeId,
        adminId: actor.adminId,
        kind: "storefront_personalization",
        chargedCredits: 0,
        creditSource: "free",
      },
    ];
    const repeat = await createMinkDraftProposal(
      personalization({ free: true, draftId: FIXED }),
    );
    expect(mocks.inserted).toHaveLength(0);
    expect(repeat).toMatchObject({ chargedCredits: 0, creditSource: "free" });
  });

  it("refuses to hand back another store's, admin's or kind's draft", async () => {
    for (const clash of [
      { storeId: "66666666-6666-4666-8666-666666666666" },
      { adminId: "someone-else" },
      { kind: "blog" },
    ]) {
      mocks.existing.rows = [
        {
          id: FIXED,
          storeId: actor.storeId,
          adminId: actor.adminId,
          kind: "storefront_personalization",
          chargedCredits: 40,
          creditSource: "plan",
          ...clash,
        },
      ];
      await expect(
        createMinkDraftProposal(
          personalization({ expectedCredits: 40, draftId: FIXED }),
        ),
      ).rejects.toThrow(/belongs to something else/);
    }
  });

  it("refuses a fixed id that is not a UUID before touching the database", async () => {
    await expect(
      createMinkDraftProposal(
        personalization({ expectedCredits: 40, draftId: "revamp-1" }),
      ),
    ).rejects.toThrow(/must be a UUID/);
    expect(mocks.withService).not.toHaveBeenCalled();
  });
});
