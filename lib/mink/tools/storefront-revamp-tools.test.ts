import { getTableName, type Table } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MinkToolInputError, MinkToolTimeoutError } from "../errors";
import { MINK_MAX_RUN_CREDITS } from "../metering";
import { REVAMP_PRICES } from "../revamp/contract";
import { readRevampRequest } from "../revamp/request";
import type { MinkActorContext } from "../types";

const h = vi.hoisted(() => ({
  createRevampJob: vi.fn(),
  cancelRevamp: vi.fn(),
  listConversationRevamps: vi.fn(),
  countRefinements: vi.fn(),
  readRevampForActor: vi.fn(),
  readRevampJob: vi.fn(),
  kick: vi.fn(),
  context: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  headroom: vi.fn(),
  capacity: vi.fn(),
  owned: vi.fn(),
  rows: {} as Record<string, unknown[]>,
  reads: [] as string[],
}));

vi.mock("../revamp/jobs", async (importOriginal) => {
  // ★ The real status list, so the tools are tested against the job's rule,
  //   and the real start limit, the one a failed redesign gives back (B5).
  const { FREE_HOLDING_STATUSES, revampStartLimit } =
    await importOriginal<typeof import("../revamp/jobs")>();
  return {
    FREE_HOLDING_STATUSES,
    revampStartLimit,
    createRevampJob: h.createRevampJob,
    cancelRevamp: h.cancelRevamp,
    listConversationRevamps: h.listConversationRevamps,
    countRefinements: h.countRefinements,
    readRevampForActor: h.readRevampForActor,
    readRevampJob: h.readRevampJob,
  };
});
vi.mock("../revamp/trigger", () => ({ kickRevampRunner: h.kick }));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../revamp/snapshot", () => ({ readRevampContextForActor: h.context }));
vi.mock("../spend-limits", () => ({
  claimSpendLimits: h.claim,
  releaseSpendLimits: h.release,
}));
vi.mock("../image-credits", () => ({ imageCreditHeadroom: h.headroom }));
vi.mock("../config", () => ({
  getMinkConfig: () => ({ chargeCredits: true }),
}));
vi.mock("@/lib/plans/entitlements", () => ({
  getProductCreateCapacity: h.capacity,
}));
vi.mock("../storefront-media-read", () => ({
  selectOwnedStorefrontImageUrls: h.owned,
}));
vi.mock("@/lib/db/client", () => {
  // A select resolves to the rows the test set for its table.
  const db = {
    select: () => ({
      from: (table: Table) => {
        const name = getTableName(table);
        h.reads.push(name);
        const rows = h.rows[name] ?? [];
        const chain = {
          where: () => chain,
          limit: () => Promise.resolve(rows),
        };
        return chain;
      },
    }),
  };
  return { withService: vi.fn(async (fn: (db: unknown) => unknown) => fn(db)) };
});

import { logError } from "@/lib/observability/logger";
import {
  MinkToolRegistry,
  TOOL_COMMIT_GRACE_MS,
  type MinkToolContext,
} from "./registry";
import { minkStorefrontRevampTools } from "./storefront-revamp-tools";

const [contextTool, startTool, refineTool] = minkStorefrontRevampTools;

const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const JOB = "11111111-1111-4111-8111-111111111111";
const PARENT = "33333333-3333-4333-8333-333333333333";
const PHOTO = "https://storage.googleapis.com/bucket/stores/s/media/jar.webp";

const actor = (overrides: Partial<MinkActorContext> = {}) =>
  ({
    storeId: "store",
    adminId: "admin",
    email: null,
    roleSlug: "superadmin",
    permissions: {},
    isSuperadmin: true,
    effectivePlan: "pro",
    locationIds: null,
    analyticsTimeZone: "Asia/Kolkata",
    currency: "INR",
    defaultLowStockThreshold: 5,
    requestId: "request",
    runId: "run-1",
    draftingEnabled: true,
    ...overrides,
  }) as MinkActorContext;

const staff = (permissions: Record<string, Array<"view" | "manage">>) =>
  actor({ isSuperadmin: false, roleSlug: "admin", permissions });

const product = (overrides: Record<string, unknown> = {}) => ({
  name: "Lavender jar",
  sizes: [{ label: "", price: 499 }],
  photo_url: PHOTO,
  ...overrides,
});

const startArgs = (overrides: Record<string, unknown> = {}) => ({
  brief: { business: "Handmade soy candles for gifting", look: "warm" },
  products: [product()],
  ...overrides,
});

function parentRow(overrides: Record<string, unknown> = {}) {
  const read = readRevampRequest(startArgs(), "full");
  if (!read.ok) throw new Error("fixture");
  return {
    id: PARENT,
    status: "ready",
    appliedAt: null,
    undoneAt: null,
    request: read.value,
    ...overrides,
  };
}

/** A finished redesign's compiled plan: a carousel opening and an About gallery. */
function compiledPlan() {
  return {
    stage: "compiled",
    productPhotoKeys: [],
    plan: {
      pages: [
        {
          slug: "",
          title: "Home",
          sections: [
            { id: "n-carousel", type: "hero_carousel", enabled: true },
            { id: "n-story", type: "rich_text", enabled: true },
          ],
        },
        {
          slug: "about",
          title: "About",
          sections: [{ id: "n-gallery", type: "gallery", enabled: true }],
        },
      ],
      bindings: [
        {
          shotId: "hero-slide-1",
          pageSlug: "",
          sectionId: "n-carousel",
          path: ["slides", 0, "image_url"],
        },
        {
          shotId: "hero-slide-2",
          pageSlug: "",
          sectionId: "n-carousel",
          path: ["slides", 1, "image_url"],
        },
        {
          shotId: "studio-bench",
          pageSlug: "about",
          sectionId: "n-gallery",
          path: ["items", 0, "image_url"],
        },
        {
          shotId: "category-gift-boxes",
          pageSlug: "@category",
          sectionId: "gift-boxes",
          path: ["image_url"],
        },
      ],
      shots: [
        { id: "hero-slide-1", subject: "Candles glowing on a windowsill" },
        { id: "hero-slide-2", subject: "Hands pouring wax into a jar" },
        { id: "studio-bench", subject: "The workbench in the Pune studio" },
        { id: "category-gift-boxes", subject: "A gift box of three candles" },
        { id: "unused", subject: "Never placed on a page" },
      ],
      basis: { categoryChanges: [] },
    },
  };
}

beforeEach(() => {
  h.rows = {
    stores: [{ settings: {} }],
    mink_runs: [{ conversationId: CONVERSATION }],
    mink_revamps: [],
  };
  h.reads = [];
  h.createRevampJob.mockResolvedValue({
    ok: true,
    job: { id: JOB, status: "queued" },
  });
  h.cancelRevamp.mockResolvedValue({ id: JOB, status: "cancelled" });
  h.listConversationRevamps.mockResolvedValue([]);
  h.countRefinements.mockResolvedValue(0);
  h.readRevampForActor.mockResolvedValue(parentRow());
  h.readRevampJob.mockResolvedValue(null);
  h.kick.mockResolvedValue(undefined);
  h.context.mockResolvedValue({ store: { name: "Lumen" }, blocker: null });
  h.claim.mockResolvedValue({ ok: true });
  h.release.mockResolvedValue(undefined);
  h.headroom.mockResolvedValue({ period: "p", planCap: 300, remaining: 50 });
  h.capacity.mockImplementation(
    async (_db: unknown, _store: string, requested: number) => ({
      allowed: requested,
      error: "Basic includes up to 50 products.",
    }),
  );
  h.owned.mockImplementation(
    async (_db: unknown, _store: string, urls: string[]) => new Set(urls),
  );
});

describe("the revamp tool declarations", () => {
  it("registers three tools, each small enough for every model step", () => {
    expect(
      minkStorefrontRevampTools.map((tool) => tool.declaration.name),
    ).toEqual([
      "get_storefront_revamp_context",
      "start_storefront_revamp",
      "refine_storefront_revamp",
    ]);
    for (const tool of minkStorefrontRevampTools) {
      expect(JSON.stringify(tool.declaration).length).toBeLessThan(6_000);
      expect(JSON.stringify(tool.declaration)).not.toMatch(/[–—]/);
    }
  });

  it("★★ tells the model to raise the theme's categories before it starts (chat-6)", () => {
    const text = startTool.declaration.description.toLowerCase();
    expect(text).toContain("categories that came with the theme");
    expect(text).toContain("ask in the same message");
  });

  it("gates them on Builder and drafting, and only the read is repeat safe", () => {
    expect(contextTool.permission).toEqual({
      section: "builder",
      action: "view",
    });
    expect(startTool.permission).toEqual({
      section: "builder",
      action: "manage",
    });
    expect(refineTool.permission).toEqual({
      section: "builder",
      action: "manage",
    });
    expect(contextTool.repeatSafe).toBe(true);
    expect(startTool.repeatSafe).toBeFalsy();
    expect(refineTool.repeatSafe).toBeFalsy();
    expect(contextTool.timeoutMs).toBe(15_000);
    expect(startTool.timeoutMs).toBe(30_000);
    for (const tool of minkStorefrontRevampTools) {
      expect(tool.available?.(actor())).toBe(true);
      expect(tool.available?.(actor({ draftingEnabled: false }))).toBe(false);
    }
  });
});

describe("get_storefront_revamp_context", () => {
  it("returns the store context and this chat's redesigns", async () => {
    h.listConversationRevamps.mockResolvedValue([
      {
        id: JOB,
        kind: "full",
        status: "ready",
        draftId: "draft",
        summary: "Warm and calm",
        appliedAt: null,
        publishedAt: null,
        undoneAt: null,
        createdAt: "2026-10-21T00:00:00.000Z",
      },
    ]);
    const output = await contextTool.execute(actor(), {});
    expect(output.context).toEqual({ store: { name: "Lumen" }, blocker: null });
    expect(output.revamps).toEqual([
      {
        id: JOB,
        kind: "full",
        status: "ready",
        summary: "Warm and calm",
        appliedAt: null,
        publishedAt: null,
        undoneAt: null,
        createdAt: "2026-10-21T00:00:00.000Z",
      },
    ]);
    expect(h.listConversationRevamps).toHaveBeenCalledWith({
      storeId: "store",
      adminId: "admin",
      conversationId: CONVERSATION,
    });
  });

  it("★★ lists the photos a refinement can redraw, for the newest finished redesign (chat-2)", async () => {
    h.listConversationRevamps.mockResolvedValue([
      {
        id: JOB,
        kind: "refine",
        status: "queued",
        summary: null,
        appliedAt: null,
        publishedAt: null,
        undoneAt: null,
        createdAt: "2026-10-22T00:00:00.000Z",
      },
      {
        id: PARENT,
        kind: "full",
        status: "ready",
        summary: "Warm and calm",
        appliedAt: null,
        publishedAt: null,
        undoneAt: null,
        createdAt: "2026-10-21T00:00:00.000Z",
      },
    ]);
    h.readRevampForActor.mockResolvedValue(parentRow({ plan: compiledPlan() }));
    const output = await contextTool.execute(actor(), {});
    const revamps = output.revamps as Array<Record<string, unknown>>;
    expect(h.readRevampForActor).toHaveBeenCalledWith(actor(), PARENT);
    expect(revamps[0].photos).toBeUndefined();
    expect(revamps[1].photos).toEqual([
      {
        id: "hero-slide-1",
        where: "Home page, opening photo",
        shows: "Candles glowing on a windowsill",
      },
      {
        id: "hero-slide-2",
        where: "Home page, opening photo",
        shows: "Hands pouring wax into a jar",
      },
      {
        id: "studio-bench",
        where: "About page, gallery / Lookbook",
        shows: "The workbench in the Pune studio",
      },
      {
        id: "category-gift-boxes",
        where: "gift-boxes category",
        shows: "A gift box of three candles",
      },
    ]);
  });

  it("lists nothing without a run, and still answers when the list fails", async () => {
    const noRun = await contextTool.execute(actor({ runId: undefined }), {});
    expect(noRun.revamps).toEqual([]);
    expect(h.listConversationRevamps).not.toHaveBeenCalled();
    h.listConversationRevamps.mockRejectedValue(new Error("db"));
    const failed = await contextTool.execute(actor(), {});
    expect(failed.revamps).toEqual([]);
    expect(failed.context).toEqual({ store: { name: "Lumen" }, blocker: null });
  });
});

describe("start_storefront_revamp", () => {
  it("queues the job, kicks the runner and tells the model only that it started", async () => {
    const output = await startTool.execute(actor(), startArgs());
    expect(h.createRevampJob).toHaveBeenCalledWith({
      actor: actor(),
      conversationId: CONVERSATION,
      kind: "full",
      request: expect.objectContaining({
        kind: "full",
        brief: expect.objectContaining({
          business: "Handmade soy candles for gifting",
        }),
        products: [expect.objectContaining({ key: "p1", photoUrl: PHOTO })],
        instruction: null,
        refineScope: null,
      }),
      parentId: null,
      // What the starting run itself may cost is kept back (money-4).
      budgetCredits: 50 - MINK_MAX_RUN_CREDITS,
    });
    expect(h.kick).toHaveBeenCalledWith(JOB);
    expect(h.claim).toHaveBeenCalledWith([
      { key: "mink-revamp-starts:store", max: 6, windowSeconds: 86_400 },
    ]);
    expect(h.release).not.toHaveBeenCalled();
    expect(startTool.artifact?.(output)).toEqual({
      type: "storefront_revamp",
      revampId: JOB,
      kind: "full",
      status: "queued",
    });
    const forModel = startTool.modelOutput?.(output);
    expect(forModel).toEqual({
      status: "started",
      revampId: JOB,
      instruction:
        "Tell the merchant in one short sentence that the redesign has started and the card shows its progress. Do not describe the design.",
    });
    expect(JSON.stringify(forModel)).not.toMatch(/credit|budget/i);
  });

  it("returns every argument problem at once as a tool input error", async () => {
    const error = await startTool
      .execute(actor(), { brief: {}, products: [product({ sizes: [] })] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MinkToolInputError);
    expect((error as Error).message).toContain(
      "Fix these and call start_storefront_revamp again:",
    );
    expect((error as Error).message).toContain("brief.business");
    expect((error as Error).message).toContain("products[0].sizes");
    expect(h.createRevampJob).not.toHaveBeenCalled();
  });

  it("refuses a store with no theme yet, before anything else", async () => {
    h.rows.stores = [{ settings: { themePending: true } }];
    const output = await startTool.execute(actor(), startArgs());
    expect(output).toEqual({
      status: "not_started",
      reason:
        "Choose a theme for your store first, under Online store, Storefront.",
      instruction:
        "Tell the merchant this in one short sentence, in plain words.",
    });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.createRevampJob).not.toHaveBeenCalled();
  });

  it("needs category and product rights for the changes it carries", async () => {
    const categories = [
      { action: "create", name: "Gift sets", merchant_confirmed: true },
    ];
    const builderOnly = staff({ builder: ["view", "manage"] });
    const withCategories = await startTool.execute(
      builderOnly,
      startArgs({ products: null, categories }),
    );
    expect(withCategories.reason).toMatch(/cannot change categories/);
    const withProducts = await startTool.execute(builderOnly, startArgs());
    expect(withProducts.reason).toMatch(/cannot add products/);
    expect(h.createRevampJob).not.toHaveBeenCalled();

    const allowed = staff({
      builder: ["view", "manage"],
      categories: ["view", "manage"],
      products: ["view", "manage"],
    });
    const output = await startTool.execute(allowed, startArgs({ categories }));
    expect(output.status).toBe("started");
  });

  it("uses only photos the store owns", async () => {
    h.owned.mockResolvedValue(new Set());
    const error = await startTool
      .execute(actor(), startArgs())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MinkToolInputError);
    expect((error as Error).message).toMatch(
      /^products\[0\]\.photo_url: not a photo this store owns/,
    );
    expect(h.createRevampJob).not.toHaveBeenCalled();
  });

  it("keeps new products within the plan's product cap", async () => {
    h.capacity.mockResolvedValue({
      allowed: 1,
      error:
        "Free includes up to 5 products. Upgrade to add another product; your existing products remain safe.",
    });
    const output = await startTool.execute(
      actor(),
      startArgs({ products: [product(), product({ name: "Rose jar" })] }),
    );
    expect(h.capacity).toHaveBeenCalledWith(expect.anything(), "store", 2);
    expect(output.reason).toBe(
      "Free includes up to 5 products. Upgrade to add another product; your existing products remain safe.",
    );
    expect(h.createRevampJob).not.toHaveBeenCalled();
  });

  it("points at a ready redesign this chat has not applied, unless asked to replace it", async () => {
    h.listConversationRevamps.mockResolvedValue([
      { id: JOB, kind: "full", status: "ready", appliedAt: null },
    ]);
    const blocked = await startTool.execute(actor(), startArgs());
    expect(blocked.status).toBe("not_started");
    expect(blocked.existingRevampId).toBe(JOB);
    expect(blocked.instruction).toMatch(
      /Point the merchant at the redesign card/,
    );
    expect(h.claim).not.toHaveBeenCalled();

    const replaced = await startTool.execute(
      actor(),
      startArgs({ replace_earlier: true }),
    );
    expect(replaced.status).toBe("started");

    h.listConversationRevamps.mockResolvedValue([
      {
        id: JOB,
        kind: "full",
        status: "ready",
        appliedAt: "2026-10-21T00:00:00Z",
      },
    ]);
    const applied = await startTool.execute(actor(), startArgs());
    expect(applied.status).toBe("started");
  });

  it("refuses past the day's start limit", async () => {
    h.claim.mockResolvedValue({
      ok: false,
      refusedKey: "mink-revamp-starts:store",
    });
    const output = await startTool.execute(actor(), startArgs());
    expect(output.reason).toBe(
      "This store has started as many redesigns as it can today. Try again tomorrow.",
    );
    expect(h.createRevampJob).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("passes the budget even for a free redesign, and refuses a paid one short of credits", async () => {
    h.headroom.mockResolvedValue({ period: "p", planCap: 20, remaining: 3 });
    const free = await startTool.execute(actor(), startArgs());
    expect(free.status).toBe("started");
    // Never below nothing: the job's reader refuses a negative budget.
    expect(h.createRevampJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ budgetCredits: 0 }),
    );

    h.rows.mink_revamps = [{ id: PARENT }];
    h.headroom.mockResolvedValue({ period: "p", planCap: 20, remaining: 9 });
    h.createRevampJob.mockClear();
    const paid = await startTool.execute(actor(), startArgs());
    expect(paid.reason).toBe(
      "This store doesn't have enough Mink credits left for a redesign. Buy Mink credits or upgrade under Plans & Billing.",
    );
    expect(JSON.stringify(startTool.modelOutput?.(paid))).not.toMatch(/\d/);
    expect(h.createRevampJob).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledWith([
      expect.objectContaining({ key: "mink-revamp-starts:store" }),
    ]);

    // ★ With the database's claim time, only to the window that counted it,
    //   the same give-back a failed redesign makes (B5).
    h.release.mockClear();
    h.claim.mockResolvedValue({
      ok: true,
      claimedAt: "2026-10-21 05:00:00.123456+00",
    });
    await startTool.execute(actor(), startArgs());
    expect(h.release).toHaveBeenCalledWith(
      [{ key: "mink-revamp-starts:store", max: 6, windowSeconds: 86_400 }],
      { claimedAt: "2026-10-21 05:00:00.123456+00" },
    );
    h.claim.mockResolvedValue({ ok: true });

    h.headroom.mockResolvedValue({
      period: "p",
      planCap: null,
      remaining: null,
    });
    const unmetered = await startTool.execute(actor(), startArgs());
    expect(unmetered.status).toBe("started");
    expect(h.createRevampJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ budgetCredits: null }),
    );
  });

  describe("a paid redesign's budget (money-4)", () => {
    // The fixed part of every paid card: the homepage's words, the header and
    // footer, the opening photograph and each confirmed category change, which
    // assemble.ts reserves before anything else.
    const floor = (categories: number) =>
      REVAMP_PRICES.page +
      REVAMP_PRICES.chrome +
      REVAMP_PRICES.photo +
      categories * REVAMP_PRICES.category;
    const threeCategories = [
      { action: "create", name: "Gift sets", merchant_confirmed: true },
      { action: "create", name: "Pillars", merchant_confirmed: true },
      { action: "create", name: "Tealights", merchant_confirmed: true },
    ];

    beforeEach(() => {
      // The store's free revamp went earlier.
      h.rows.mink_revamps = [{ id: PARENT }];
    });

    it("★ keeps back what the starting run may cost, from the same balance", async () => {
      const remaining = floor(0) + MINK_MAX_RUN_CREDITS;
      h.headroom.mockResolvedValue({ period: "p", planCap: 20, remaining });
      const output = await startTool.execute(
        actor(),
        startArgs({ products: null }),
      );
      expect(output.status).toBe("started");
      expect(h.createRevampJob).toHaveBeenLastCalledWith(
        expect.objectContaining({ budgetCredits: floor(0) }),
      );
    });

    it("★ refuses a start whose budget cannot cover the card's fixed part", async () => {
      // Enough for the old flat minimum, not for three categories' floor
      // once the run's own charge is kept back.
      const remaining = floor(3) - 1 + MINK_MAX_RUN_CREDITS;
      h.headroom.mockResolvedValue({ period: "p", planCap: 20, remaining });
      const output = await startTool.execute(
        actor(),
        startArgs({ products: null, categories: threeCategories }),
      );
      expect(output.reason).toMatch(/enough Mink credits/);
      expect(h.createRevampJob).not.toHaveBeenCalled();
      expect(h.release).toHaveBeenCalled();

      h.headroom.mockResolvedValue({
        period: "p",
        planCap: 20,
        remaining: remaining + 1,
      });
      const enough = await startTool.execute(
        actor(),
        startArgs({ products: null, categories: threeCategories }),
      );
      expect(enough.status).toBe("started");
      expect(h.createRevampJob).toHaveBeenLastCalledWith(
        expect.objectContaining({ budgetCredits: floor(3) }),
      );
    });
  });

  it("gives the start back when a redesign is already being made", async () => {
    h.createRevampJob.mockResolvedValue({
      ok: false,
      reason: "active_exists",
      activeId: PARENT,
    });
    const output = await startTool.execute(actor(), startArgs());
    expect(output.reason).toBe(
      "A redesign is already being made for this store; its card shows the progress.",
    );
    expect(output.existingRevampId).toBe(PARENT);
    expect(h.release).toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
    expect(startTool.artifact?.(output)).toBeUndefined();
  });

  it("says an earlier redesign is still stopping, rather than pointing at its card", async () => {
    h.createRevampJob.mockResolvedValue({
      ok: false,
      reason: "active_exists",
      activeId: PARENT,
    });
    h.readRevampJob.mockResolvedValue({
      id: PARENT,
      storeId: "store",
      cancelRequestedAt: "2026-10-22T00:00:00Z",
    });
    const output = await startTool.execute(actor(), startArgs());
    expect(output).toEqual({
      status: "not_started",
      reason: "The earlier redesign is still stopping. Try again in a minute.",
      instruction:
        "Tell the merchant this in one short sentence, in plain words.",
    });
    expect(h.readRevampJob).toHaveBeenCalledWith(PARENT);
    expect(h.release).toHaveBeenCalled();

    // Another store's row says nothing about this store's active revamp.
    h.readRevampJob.mockResolvedValue({
      id: PARENT,
      storeId: "other-store",
      cancelRequestedAt: "2026-10-22T00:00:00Z",
    });
    const other = await startTool.execute(actor(), startArgs());
    expect(other.reason).toMatch(/already being made/);
    h.readRevampJob.mockRejectedValue(new Error("db"));
    const unreadable = await startTool.execute(actor(), startArgs());
    expect(unreadable.reason).toMatch(/already being made/);
  });

  it("gives the start back when the job cannot be created", async () => {
    h.createRevampJob.mockRejectedValue(new Error("db down"));
    await expect(startTool.execute(actor(), startArgs())).rejects.toThrow(
      "db down",
    );
    expect(h.release).toHaveBeenCalled();
  });
});

// ★★ B6: a redesign never starts after the chat said the tool took too long.
//    The real registry runs the tool, so its deadline, the run's stop and the
//    commit grace are the ones the chat uses.
describe("★★ a stopped run never starts a redesign (B6)", () => {
  const call = () => ({
    name: "start_storefront_revamp",
    args: startArgs(),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(logError).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("★ claims nothing for a run that had already stopped", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const context: MinkToolContext = {
      signal: stopped.signal,
      deadlineAt: Date.now(),
      commit: vi.fn(),
    };
    await expect(
      startTool.execute(actor(), startArgs(), context),
    ).rejects.toBeInstanceOf(MinkToolTimeoutError);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.createRevampJob).not.toHaveBeenCalled();
    expect(context.commit).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it("★★ a stop before the insert creates nothing and gives the start back", async () => {
    const run = new AbortController();
    const headroom = deferred<unknown>();
    h.headroom.mockImplementation(() => headroom.promise);
    const registry = new MinkToolRegistry([startTool]);
    const pending = registry.execute(actor(), call(), { signal: run.signal });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.headroom).toHaveBeenCalled();

    run.abort();
    await expect(pending).resolves.toMatchObject({
      response: { error: { code: "tool_timeout" } },
    });
    // The budget read finishes after the chat was told: the insert is refused.
    headroom.resolve({ period: "p", planCap: 300, remaining: 50 });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.createRevampJob).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.kick).not.toHaveBeenCalled();
  });

  it("★ the tool's own deadline refuses the insert the same way", async () => {
    const headroom = deferred<unknown>();
    h.headroom.mockImplementation(() => headroom.promise);
    const registry = new MinkToolRegistry([startTool]);
    const pending = registry.execute(actor(), call());
    await vi.advanceTimersByTimeAsync(startTool.timeoutMs + 10);
    await expect(pending).resolves.toMatchObject({
      response: { error: { code: "tool_timeout" } },
    });
    headroom.resolve({ period: "p", planCap: 300, remaining: 50 });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.createRevampJob).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("★★ an insert under way when the run stops still starts the redesign, and the chat shows it", async () => {
    const run = new AbortController();
    const insert = deferred<unknown>();
    h.createRevampJob.mockImplementation(() => insert.promise);
    const registry = new MinkToolRegistry([startTool]);
    const pending = registry.execute(actor(), call(), { signal: run.signal });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.createRevampJob).toHaveBeenCalledTimes(1);

    run.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    insert.resolve({ ok: true, job: { id: JOB, status: "queued" } });
    await expect(pending).resolves.toMatchObject({
      response: { output: { status: "started", revampId: JOB } },
      artifact: { type: "storefront_revamp", revampId: JOB },
    });
    expect(h.kick).toHaveBeenCalledWith(JOB);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.cancelRevamp).not.toHaveBeenCalled();
  });

  it("★★ an insert that outlives the grace is withdrawn: cancelled, the start given back, never kicked", async () => {
    const run = new AbortController();
    const insert = deferred<unknown>();
    h.createRevampJob.mockImplementation(() => insert.promise);
    const registry = new MinkToolRegistry([startTool]);
    const pending = registry.execute(actor(), call(), { signal: run.signal });
    await vi.advanceTimersByTimeAsync(10);
    run.abort();
    await vi.advanceTimersByTimeAsync(TOOL_COMMIT_GRACE_MS + 100);
    await expect(pending).resolves.toMatchObject({
      response: { error: { code: "tool_timeout" } },
    });

    insert.resolve({ ok: true, job: { id: JOB, status: "queued" } });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.cancelRevamp).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store", adminId: "admin" }),
      JOB,
    );
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.kick).not.toHaveBeenCalled();
  });

  it("keeps the start spent, and names the job, when a late insert cannot be withdrawn", async () => {
    const run = new AbortController();
    const insert = deferred<unknown>();
    h.createRevampJob.mockImplementation(() => insert.promise);
    h.cancelRevamp.mockRejectedValue(new Error("db"));
    const registry = new MinkToolRegistry([startTool]);
    const pending = registry.execute(actor(), call(), { signal: run.signal });
    await vi.advanceTimersByTimeAsync(10);
    run.abort();
    await vi.advanceTimersByTimeAsync(TOOL_COMMIT_GRACE_MS + 100);
    await pending;
    insert.resolve({ ok: true, job: { id: JOB, status: "queued" } });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "mink.revamp: late start not withdrawn",
      expect.any(Error),
      { revampId: JOB, storeId: "store" },
    );
  });

  it("★★ a late insert that had already failed is not given back twice: its failure did that (B5)", async () => {
    const run = new AbortController();
    const insert = deferred<unknown>();
    h.createRevampJob.mockImplementation(() => insert.promise);
    h.cancelRevamp.mockResolvedValue({ id: JOB, status: "failed" });
    const registry = new MinkToolRegistry([startTool]);
    const pending = registry.execute(actor(), call(), { signal: run.signal });
    await vi.advanceTimersByTimeAsync(10);
    run.abort();
    await vi.advanceTimersByTimeAsync(TOOL_COMMIT_GRACE_MS + 100);
    await pending;
    insert.resolve({ ok: true, job: { id: JOB, status: "queued" } });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.cancelRevamp).toHaveBeenCalledTimes(1);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it("★ a late insert a runner holds is asked to stop, and its start given back", async () => {
    const run = new AbortController();
    const insert = deferred<unknown>();
    h.createRevampJob.mockImplementation(() => insert.promise);
    h.cancelRevamp.mockResolvedValue({
      id: JOB,
      status: "running",
      cancelRequested: true,
    });
    const registry = new MinkToolRegistry([startTool]);
    const pending = registry.execute(actor(), call(), { signal: run.signal });
    await vi.advanceTimersByTimeAsync(10);
    run.abort();
    await vi.advanceTimersByTimeAsync(TOOL_COMMIT_GRACE_MS + 100);
    await pending;
    insert.resolve({ ok: true, job: { id: JOB, status: "queued" } });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("refine is held to the same rule", async () => {
    const stopped = new AbortController();
    stopped.abort();
    h.listConversationRevamps.mockResolvedValue([
      { id: PARENT, kind: "full", status: "ready", undoneAt: null },
    ]);
    h.readRevampJob.mockResolvedValue({
      id: PARENT,
      status: "ready",
      result: compiledPlan(),
    });
    const context: MinkToolContext = {
      signal: stopped.signal,
      deadlineAt: Date.now(),
      commit: vi.fn(),
    };
    await expect(
      refineTool.execute(
        actor(),
        { instruction: "Make it warmer", scope: { design: true } },
        context,
      ),
    ).rejects.toBeInstanceOf(MinkToolTimeoutError);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.createRevampJob).not.toHaveBeenCalled();
  });
});

describe("refine_storefront_revamp", () => {
  const refineArgs = (overrides: Record<string, unknown> = {}) => ({
    instruction: "Make it warmer",
    scope: { design: true },
    ...overrides,
  });

  it("builds on the newest finished redesign of the chat", async () => {
    h.listConversationRevamps.mockResolvedValue([
      { id: JOB, kind: "refine", status: "queued", undoneAt: null },
      {
        id: "44444444-4444-4444-8444-444444444444",
        kind: "full",
        status: "ready",
        undoneAt: "2026-10-20T00:00:00Z",
      },
      { id: PARENT, kind: "full", status: "ready", undoneAt: null },
    ]);
    const output = await refineTool.execute(
      actor(),
      refineArgs({
        products: [product({ name: "Rose jar", photo_url: null })],
      }),
    );
    expect(h.readRevampForActor).toHaveBeenCalledWith(actor(), PARENT);
    expect(h.createRevampJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "refine",
        parentId: PARENT,
        conversationId: CONVERSATION,
        request: expect.objectContaining({
          kind: "refine",
          instruction: "Make it warmer",
          brief: expect.objectContaining({
            business: "Handmade soy candles for gifting",
          }),
          products: [
            expect.objectContaining({ key: "p1", name: "Lavender jar" }),
            expect.objectContaining({ key: "p2", name: "Rose jar" }),
          ],
          refineScope: expect.objectContaining({ design: true, copy: false }),
        }),
      }),
    );
    expect(h.kick).toHaveBeenCalledWith(JOB);
    expect(refineTool.artifact?.(output)).toEqual({
      type: "storefront_revamp",
      revampId: JOB,
      kind: "refine",
      status: "queued",
    });
    expect(Object.keys(refineTool.modelOutput?.(output) ?? {}).sort()).toEqual([
      "instruction",
      "revampId",
      "status",
    ]);
  });

  it("takes a named redesign only when it is the requester's and finished", async () => {
    h.readRevampForActor.mockResolvedValue(parentRow({ status: "running" }));
    const running = await refineTool.execute(
      actor(),
      refineArgs({ revamp_id: PARENT }),
    );
    expect(running.reason).toMatch(/no finished redesign/);
    h.readRevampForActor.mockResolvedValue(null);
    const foreign = await refineTool.execute(
      actor(),
      refineArgs({ revamp_id: PARENT }),
    );
    expect(foreign.reason).toMatch(/no finished redesign/);
    const none = await refineTool.execute(actor(), refineArgs());
    expect(none.reason).toMatch(/no finished redesign/);
    expect(h.createRevampJob).not.toHaveBeenCalled();
  });

  describe("★★ which photos a refinement redraws (chat-2)", () => {
    beforeEach(() => {
      h.listConversationRevamps.mockResolvedValue([
        { id: PARENT, kind: "full", status: "ready", undoneAt: null },
      ]);
      h.readRevampForActor.mockResolvedValue(
        parentRow({ plan: compiledPlan() }),
      );
    });
    const photosOf = () =>
      h.createRevampJob.mock.calls.at(-1)![0].request.refineScope.photos;

    it('★★ redraws every photograph of the opening for "opening"', async () => {
      const output = await refineTool.execute(
        actor(),
        refineArgs({ scope: { photos: ["opening"] } }),
      );
      expect(output.status).toBe("started");
      expect(photosOf()).toEqual(["hero-slide-1", "hero-slide-2"]);
    });

    it("★★ refuses a photo the redesign does not have, naming the ones it has", async () => {
      const error = await refineTool
        .execute(actor(), refineArgs({ scope: { photos: ["hero"] } }))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MinkToolInputError);
      const message = (error as Error).message;
      expect(message).toContain('"hero"');
      expect(message).toContain("hero-slide-1 (Home page, opening photo)");
      expect(message).toContain(
        "studio-bench (About page, gallery / Lookbook)",
      );
      expect(message).toContain('"opening"');
      expect(h.createRevampJob).not.toHaveBeenCalled();
      expect(h.claim).not.toHaveBeenCalled();
    });

    it("passes a photo the redesign has, and every photo, as they are", async () => {
      await refineTool.execute(
        actor(),
        refineArgs({ scope: { photos: ["Studio-Bench"] } }),
      );
      expect(photosOf()).toEqual(["studio-bench"]);
      await refineTool.execute(
        actor(),
        refineArgs({ scope: { photos: ["all"] } }),
      );
      expect(photosOf()).toBe("all");
    });

    it("tells the model where the photo ids come from", () => {
      const text = JSON.stringify(refineTool.declaration);
      expect(text).toContain("get_storefront_revamp_context");
      expect(text).toContain('\\"opening\\"');
    });
  });

  it("★★ builds on an applied version a newer one replaced, once that newer one was undone (chat-4)", async () => {
    // Apply A, refine it into B (A is superseded), apply B, undo B: the store
    // is A again, and "try a cooler palette instead" refines A. The route
    // offers only the refinement here, so refusing it left the chat stuck.
    const B = "66666666-6666-4666-8666-666666666666";
    h.listConversationRevamps.mockResolvedValue([
      {
        id: B,
        kind: "refine",
        status: "ready",
        appliedAt: "2026-10-22T09:00:00Z",
        undoneAt: "2026-10-22T10:00:00Z",
      },
      {
        id: PARENT,
        kind: "full",
        status: "superseded",
        appliedAt: "2026-10-21T00:00:00Z",
        undoneAt: null,
      },
    ]);
    h.readRevampForActor.mockResolvedValue(
      parentRow({ status: "superseded", appliedAt: "2026-10-21T00:00:00Z" }),
    );
    const output = await refineTool.execute(
      actor(),
      refineArgs({ instruction: "Try a cooler palette instead" }),
    );
    expect(output.status).toBe("started");
    expect(h.readRevampForActor).toHaveBeenCalledWith(actor(), PARENT);
    expect(h.createRevampJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ parentId: PARENT }),
    );
    // Named, the same version is accepted; a replaced one never applied is not.
    const named = await refineTool.execute(
      actor(),
      refineArgs({ revamp_id: PARENT }),
    );
    expect(named.status).toBe("started");
    h.readRevampForActor.mockResolvedValue(
      parentRow({ status: "superseded", appliedAt: null }),
    );
    const replaced = await refineTool.execute(
      actor(),
      refineArgs({ revamp_id: PARENT }),
    );
    expect(replaced.reason).toMatch(/no finished redesign/);
  });

  it("stops at the refinement limit", async () => {
    h.listConversationRevamps.mockResolvedValue([
      { id: PARENT, kind: "full", status: "ready", undoneAt: null },
    ]);
    h.countRefinements.mockResolvedValue(10);
    const output = await refineTool.execute(actor(), refineArgs());
    expect(output.reason).toMatch(/changed as many times as it can be/);
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("names problems in the model's own arguments", async () => {
    h.listConversationRevamps.mockResolvedValue([
      { id: PARENT, kind: "full", status: "ready", undoneAt: null },
    ]);
    const error = await refineTool
      .execute(
        actor(),
        refineArgs({
          scope: {},
          products: [
            product({ name: "Rose jar", sizes: [{ label: "", price: 0 }] }),
          ],
        }),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MinkToolInputError);
    const message = (error as Error).message;
    expect(message).toContain(
      "products[0].sizes[0].price must be more than 0.",
    );
    expect(message).toContain("scope must change something");
    expect(message).not.toContain("refine_scope");
  });

  it("counts the parent's products against the cap only until they exist", async () => {
    h.listConversationRevamps.mockResolvedValue([
      { id: PARENT, kind: "full", status: "ready", undoneAt: null },
    ]);
    const added = refineArgs({ products: [product({ name: "Rose jar" })] });
    await refineTool.execute(actor(), added);
    expect(h.capacity).toHaveBeenLastCalledWith(expect.anything(), "store", 2);
    h.readRevampForActor.mockResolvedValue(
      parentRow({ appliedAt: "2026-10-21T00:00:00Z" }),
    );
    await refineTool.execute(actor(), added);
    expect(h.capacity).toHaveBeenLastCalledWith(expect.anything(), "store", 1);
  });

  describe("a refinement of a redesign that is on the store (known-1a)", () => {
    const giftSets = {
      action: "create",
      name: "Gift sets",
      merchant_confirmed: true,
    };
    const appliedParent = (overrides: Record<string, unknown> = {}) => {
      const read = readRevampRequest(
        startArgs({
          products: [product(), product({ name: "Amber jar" })],
          categories: [giftSets],
        }),
        "full",
      );
      if (!read.ok) throw new Error("fixture");
      return parentRow({
        request: read.value,
        appliedAt: "2026-10-21T00:00:00Z",
        ...overrides,
      });
    };

    beforeEach(() => {
      h.listConversationRevamps.mockResolvedValue([
        { id: PARENT, kind: "full", status: "ready", undoneAt: null },
      ]);
    });

    it("★ carries only what the merchant adds now: the parent's products and categories already exist", async () => {
      h.readRevampForActor.mockResolvedValue(appliedParent());
      const output = await refineTool.execute(
        actor(),
        refineArgs({ products: [product({ name: "Rose jar" })] }),
      );
      expect(output.status).toBe("started");
      const { request } = h.createRevampJob.mock.calls.at(-1)![0];
      expect(request.products.map((p: { name: string }) => p.name)).toEqual([
        "Rose jar",
      ]);
      expect(request.categories).toEqual([]);
      // The business is still described the way the merchant described it.
      expect(request.brief.business).toBe("Handmade soy candles for gifting");
      // ★ A new key: the parent plan's product copy is keyed p1 and p2, and
      //   a refinement copies it by key.
      expect(request.products[0].key).toBe("p3");
      expect(h.capacity).toHaveBeenLastCalledWith(
        expect.anything(),
        "store",
        1,
      );
    });

    it("needs no category rights for categories it no longer carries", async () => {
      h.readRevampForActor.mockResolvedValue(appliedParent());
      const output = await refineTool.execute(
        staff({ builder: ["view", "manage"], products: ["view", "manage"] }),
        refineArgs(),
      );
      expect(output.status).toBe("started");
      const { request } = h.createRevampJob.mock.calls.at(-1)![0];
      expect(request.products).toEqual([]);
    });

    it("carries the parent's products and categories again once it was undone", async () => {
      h.readRevampForActor.mockResolvedValue(
        appliedParent({ undoneAt: "2026-10-22T00:00:00Z" }),
      );
      await refineTool.execute(
        actor(),
        refineArgs({ products: [product({ name: "Rose jar" })] }),
      );
      const { request } = h.createRevampJob.mock.calls.at(-1)![0];
      expect(
        request.products.map((p: { key: string; name: string }) => [
          p.key,
          p.name,
        ]),
      ).toEqual([
        ["p1", "Lavender jar"],
        ["p2", "Amber jar"],
        ["p3", "Rose jar"],
      ]);
      expect(request.categories).toHaveLength(1);
      expect(h.capacity).toHaveBeenLastCalledWith(
        expect.anything(),
        "store",
        3,
      );
    });
  });

  describe("★★ a refinement carries what the whole redesign asked for and is not on the store yet (chat-1)", () => {
    const GRAND = "55555555-5555-4555-8555-555555555555";
    const giftBoxes = {
      action: "create",
      name: "Gift boxes",
      merchant_confirmed: true,
    };
    /** A: the full redesign, with two of the merchant's products and a new category. */
    const fullRequest = () => {
      const read = readRevampRequest(
        startArgs({
          products: [product(), product({ name: "Amber jar" })],
          categories: [giftBoxes],
        }),
        "full",
      );
      if (!read.ok) throw new Error("fixture");
      return read.value;
    };
    /** B, a refinement of A: `carriedFromA` when A was not on the store when B was asked for. */
    const refinementRequest = (carriedFromA: boolean) => {
      const read = readRevampRequest(
        {
          brief: { business: "Handmade soy candles for gifting" },
          products: [
            ...(carriedFromA
              ? [product(), product({ name: "Amber jar" })]
              : []),
            product({ name: "Rose jar", photo_url: null }),
          ],
          categories: carriedFromA ? [giftBoxes] : [],
          instruction: "Make it warmer",
          refine_scope: { design: true },
        },
        "refine",
      );
      if (!read.ok) throw new Error("fixture");
      // Rose jar was keyed after A's two products, as the tool keys it.
      return {
        ...read.value,
        products: read.value.products.map((item) =>
          item.name === "Rose jar" ? { ...item, key: "p3" } : item,
        ),
      };
    };
    const rows: Record<string, unknown> = {};
    const chain = (input: {
      parentCarried: boolean;
      grandApplied: boolean;
      grandUndone: boolean;
    }) => {
      rows[PARENT] = parentRow({
        parentId: GRAND,
        kind: "refine",
        request: refinementRequest(input.parentCarried),
      });
      rows[GRAND] = parentRow({
        id: GRAND,
        status: "superseded",
        parentId: null,
        request: fullRequest(),
        appliedAt: input.grandApplied ? "2026-10-21T00:00:00Z" : null,
        undoneAt: input.grandUndone ? "2026-10-22T00:00:00Z" : null,
      });
    };
    const lastRequest = () => h.createRevampJob.mock.calls.at(-1)![0].request;

    beforeEach(() => {
      h.listConversationRevamps.mockResolvedValue([
        { id: PARENT, kind: "refine", status: "ready", undoneAt: null },
      ]);
      h.readRevampForActor.mockImplementation(
        async (_actor: unknown, id: string) => rows[id] ?? null,
      );
    });

    it("★★ leaves out what an earlier version put on the store after this one was asked for", async () => {
      // B carried A's products and its category because A was not applied
      // then; A was applied while B was being made. Carrying them again
      // would make Apply create them a second time, so it refuses for ever.
      chain({ parentCarried: true, grandApplied: true, grandUndone: false });
      const output = await refineTool.execute(actor(), refineArgs());
      expect(output.status).toBe("started");
      const request = lastRequest();
      expect(
        request.products.map((p: { key: string; name: string }) => [
          p.key,
          p.name,
        ]),
      ).toEqual([["p3", "Rose jar"]]);
      expect(request.categories).toEqual([]);
      expect(h.readRevampForActor).toHaveBeenCalledWith(actor(), GRAND);
      expect(h.capacity).toHaveBeenLastCalledWith(
        expect.anything(),
        "store",
        1,
      );
    });

    it("★★ carries an earlier version's products and category again once it was undone after this one was asked for", async () => {
      // A was on the store when B was asked for, so B carries none of it;
      // A was undone since, so its products and its category are gone again
      // and the next version must create them.
      chain({ parentCarried: false, grandApplied: true, grandUndone: true });
      await refineTool.execute(actor(), refineArgs());
      const request = lastRequest();
      expect(
        request.products.map((p: { key: string; name: string }) => [
          p.key,
          p.name,
        ]),
      ).toEqual([
        ["p1", "Lavender jar"],
        ["p2", "Amber jar"],
        ["p3", "Rose jar"],
      ]);
      expect(request.categories).toEqual([
        expect.objectContaining({ action: "create", name: "Gift boxes" }),
      ]);
    });

    it("★ never gives a new product a key an earlier version of the redesign used", async () => {
      // B carried nothing (A was on the store) and added nothing, so its own
      // list is empty: a new product keyed from B alone would be p1, A's key.
      chain({ parentCarried: false, grandApplied: true, grandUndone: false });
      rows[PARENT] = parentRow({
        parentId: GRAND,
        kind: "refine",
        request: { ...refinementRequest(false), products: [] },
      });
      await refineTool.execute(
        actor(),
        refineArgs({
          products: [product({ name: "Fig jar", photo_url: null })],
        }),
      );
      expect(
        lastRequest().products.map((p: { key: string; name: string }) => [
          p.key,
          p.name,
        ]),
      ).toEqual([["p3", "Fig jar"]]);
    });
  });

  describe("a refinement's budget pays only what it does not carry (f-6)", () => {
    /** The parent's compiled plan: a homepage that opens on a photograph. */
    const compiledParent = () =>
      parentRow({
        plan: {
          stage: "compiled",
          productPhotoKeys: [],
          plan: {
            pages: [
              {
                slug: "",
                sections: [{ id: "n-hero", type: "hero", enabled: true }],
              },
            ],
            bindings: [
              {
                shotId: "hero",
                pageSlug: "",
                sectionId: "n-hero",
                path: ["image_url"],
              },
            ],
            shots: [{ id: "hero" }],
            basis: { categoryChanges: [] },
          },
        },
      });

    beforeEach(() => {
      h.listConversationRevamps.mockResolvedValue([
        { id: PARENT, kind: "full", status: "ready", undoneAt: null },
      ]);
      h.readRevampForActor.mockResolvedValue(compiledParent());
    });

    it("★★ starts a look-only change the full floor refused", async () => {
      // "Make it warmer" rewrites only the header and footer's look: no page,
      // no photograph and no category change, so that is all it must afford.
      const remaining = MINK_MAX_RUN_CREDITS + REVAMP_PRICES.chrome;
      expect(remaining - MINK_MAX_RUN_CREDITS).toBeLessThan(
        REVAMP_PRICES.page + REVAMP_PRICES.chrome + REVAMP_PRICES.photo,
      );
      h.headroom.mockResolvedValue({ period: "p", planCap: 20, remaining });
      const output = await refineTool.execute(actor(), refineArgs());
      expect(output.status).toBe("started");
      expect(h.createRevampJob).toHaveBeenLastCalledWith(
        expect.objectContaining({ budgetCredits: REVAMP_PRICES.chrome }),
      );

      h.createRevampJob.mockClear();
      h.headroom.mockResolvedValue({
        period: "p",
        planCap: 20,
        remaining: remaining - 1,
      });
      const short = await refineTool.execute(actor(), refineArgs());
      expect(short.reason).toMatch(/enough Mink credits/);
      expect(h.createRevampJob).not.toHaveBeenCalled();
    });

    it("holds a refinement that writes the homepage again to the whole fixed part", async () => {
      const fixed =
        REVAMP_PRICES.page + REVAMP_PRICES.chrome + REVAMP_PRICES.photo;
      h.headroom.mockResolvedValue({
        period: "p",
        planCap: 20,
        remaining: MINK_MAX_RUN_CREDITS + fixed - 1,
      });
      const copy = refineArgs({ scope: { copy: true } });
      expect((await refineTool.execute(actor(), copy)).reason).toMatch(
        /enough Mink credits/,
      );
      h.headroom.mockResolvedValue({
        period: "p",
        planCap: 20,
        remaining: MINK_MAX_RUN_CREDITS + fixed,
      });
      expect((await refineTool.execute(actor(), copy)).status).toBe("started");
    });
  });

  it("is never free: a refinement short of credits is refused", async () => {
    h.listConversationRevamps.mockResolvedValue([
      { id: PARENT, kind: "full", status: "ready", undoneAt: null },
    ]);
    h.headroom.mockResolvedValue({ period: "p", planCap: 20, remaining: 9 });
    const output = await refineTool.execute(actor(), refineArgs());
    expect(output.reason).toMatch(/enough Mink credits/);
    expect(h.reads).not.toContain("mink_revamps");
    expect(h.release).toHaveBeenCalled();
  });
});
