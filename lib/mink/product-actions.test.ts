import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";
import { withService } from "@/lib/db/client";
import { getLatestMinkProductAction } from "./product-actions";
import type { MinkActorContext } from "./types";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

const actor = {
  storeId: "store-a",
  adminId: "admin-a",
  draftingEnabled: true,
  isSuperadmin: false,
  permissions: { products: ["manage"] },
} as unknown as MinkActorContext;

const executed = {
  id: "approval-1",
  storeId: "store-a",
  adminId: "admin-a",
  draftId: "draft-1",
  draftVersion: 1,
  sourceApprovalId: null,
  productId: "product-1",
  productVersion: "2026-10-26 07:00:00.123456+00",
  toolName: "apply_product_description",
  operation: "apply",
  status: "executed",
  beforeJson: { description: "Old words" },
  afterJson: { description: "New words" },
  expiresAt: "2026-10-26 07:10:00+00",
  executedAt: "2026-10-26 07:01:00+00",
};

let mock: ReturnType<typeof makeDbMock>;

beforeEach(() => {
  vi.mocked(withService).mockReset();
});

function useDb(options: Parameters<typeof makeDbMock>[0]) {
  mock = makeDbMock(options);
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
}

describe("getLatestMinkProductAction", () => {
  it("★ D6: answers no change yet, not a 404, when the changed product was deleted", async () => {
    // Migration 0250 keeps the approval (and its audit row) when the product
    // goes; the card's read must not fail the whole draft for it.
    useDb({
      selectByTable: {
        mink_action_approvals: [[executed]],
        products: [[]],
        mink_action_audit: [[{ id: "audit-1", productVersionAfter: "v2" }]],
      },
    });
    await expect(
      getLatestMinkProductAction(actor, "draft-1"),
    ).resolves.toBeNull();
  });

  it("returns the last change with its product while the product exists", async () => {
    useDb({
      selectByTable: {
        mink_action_approvals: [[executed]],
        products: [[{ id: "product-1", name: "Almond shake", slug: "almond" }]],
        mink_action_audit: [[{ id: "audit-1", productVersionAfter: "v2" }]],
      },
    });
    const result = await getLatestMinkProductAction(actor, "draft-1");
    expect(result).toMatchObject({
      auditId: "audit-1",
      repeated: true,
      approval: {
        id: "approval-1",
        product: { id: "product-1", name: "Almond shake" },
        after: { description: "New words" },
      },
    });
  });

  it("is null without an executed approval, reading no product", async () => {
    useDb({ selectByTable: { mink_action_approvals: [[]] } });
    await expect(
      getLatestMinkProductAction(actor, "draft-1"),
    ).resolves.toBeNull();
    expect(mock.calls.select).toHaveLength(1);
  });
});
